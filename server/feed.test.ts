import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Quote } from '../shared/types';
import type { QuoteCallback } from './brokers/types';
import { QuoteHub, type FeedEvent } from './feed';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (bid: number): Quote => ({ bid, ask: bid + 0.0001, time: 0 });

const hubs: QuoteHub[] = [];
afterEach(() => hubs.splice(0).forEach((h) => h.close()));
function hub(source: ConstructorParameters<typeof QuoteHub>[0], pollMs = 20) {
  const h = new QuoteHub(source, { pollMs });
  hubs.push(h);
  return h;
}

describe('QuoteHub (polling)', () => {
  it('polls once per interval however many listeners there are, and only sends changes', async () => {
    let price = 1.1;
    const getQuote = vi.fn(async () => q(price));
    const h = hub({ getQuote });
    const a: FeedEvent[] = [];
    const b: FeedEvent[] = [];
    const offA = h.subscribe('EURUSD', (e) => a.push(e));
    const offB = h.subscribe('EURUSD', (e) => b.push(e));
    await wait(110);
    expect(getQuote.mock.calls.length).toBeLessThanOrEqual(8); // ~one call per 20ms tick, not per listener
    expect(a).toHaveLength(1); // unchanged price is not re-sent
    price = 1.2;
    await wait(50);
    expect(a.at(-1)).toEqual({ quote: q(1.2) });
    expect(b.at(-1)).toEqual({ quote: q(1.2) });

    offA();
    offB();
    await wait(30);
    const calls = getQuote.mock.calls.length;
    await wait(60);
    expect(getQuote.mock.calls.length).toBe(calls); // stopped when nobody listens
  });

  it('reports broker errors to listeners and remembers fresh quotes', async () => {
    let fail = true;
    const h = hub({ getQuote: async () => (fail ? Promise.reject(new Error('down')) : q(1.1)) });
    const events: FeedEvent[] = [];
    h.subscribe('EURUSD', (e) => events.push(e));
    await wait(10);
    expect(events[0]).toEqual({ error: 'down' });
    expect(h.latestQuote('EURUSD', 1000)).toBeUndefined();
    fail = false;
    await wait(40);
    expect(h.latestQuote('EURUSD', 1000)).toEqual(q(1.1));
  });
});

describe('QuoteHub (streaming)', () => {
  it('runs one stream for all subscribed symbols and restarts it when the set changes', async () => {
    const streams: { symbols: string[]; push: QuoteCallback; signal: AbortSignal }[] = [];
    const h = hub({
      getQuote: async () => q(1),
      streamQuotes: (symbols, push, signal) =>
        new Promise<void>((resolve) => {
          streams.push({ symbols, push, signal });
          signal.addEventListener('abort', () => resolve());
        }),
    });
    const eur: FeedEvent[] = [];
    h.subscribe('EURUSD', (e) => eur.push(e));
    const offJpy = h.subscribe('USDJPY', () => {});
    await wait(150);
    expect(streams).toHaveLength(1); // debounced into one stream
    expect(streams[0].symbols).toEqual(['EURUSD', 'USDJPY']);

    streams[0].push('EURUSD', q(1.5));
    expect(eur.at(-1)).toEqual({ quote: q(1.5) });

    offJpy();
    await wait(150);
    expect(streams[0].signal.aborted).toBe(true);
    expect(streams[1].symbols).toEqual(['EURUSD']);
  });

  it('reports a dropped stream and reconnects', async () => {
    let attempts = 0;
    const h = hub({
      getQuote: async () => q(1),
      streamQuotes: async () => {
        attempts++;
        if (attempts === 1) throw new Error('stream closed');
        await new Promise(() => {}); // second attempt stays open
      },
    });
    const events: FeedEvent[] = [];
    h.subscribe('EURUSD', (e) => events.push(e));
    await wait(1300); // 100ms debounce + 1s backoff
    expect(events).toContainEqual({ error: 'stream closed; reconnecting' });
    expect(attempts).toBe(2);
  });
});
