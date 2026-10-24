import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BidAskBar } from '../../shared/types';
import { buildApp } from '../app';
import { DemoMarketData } from '../brokers/demo';
import { PaperExecution } from '../brokers/paper';
import { HistoryStore } from '../history/store';
import { ReplaySession, aggregate, partialBar } from './session';

const MON = Date.UTC(2025, 2, 3) / 1000; // Monday 2025-03-03 00:00 UTC

/** Mid price walks up 1 pip a minute; spread 1 pip. */
function bars(from: number, minutes: number, start = 1.1): BidAskBar[] {
  return Array.from({ length: minutes }, (_, i) => {
    const o = start + i * 0.0001;
    const c = o + 0.0001;
    const side = (s: number) => ({ o: o + s, h: c + s + 0.00002, l: o + s - 0.00002, c: c + s });
    return { time: from + i * 60, bid: side(-0.00005), ask: side(0.00005), volume: 10 };
  });
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function setup(data: BidAskBar[]) {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  dirs.push(dir);
  const store = new HistoryStore(dir);
  store.write('EURUSD', data, { digits: 5 });
  return new ReplaySession(store);
}

describe('ReplaySession', () => {
  it('never shows bars after the simulated clock', async () => {
    const replay = setup(bars(MON, 600));
    replay.seek(MON + 120 * 60 + 30); // 30 seconds into minute 120
    const candles = await replay.getCandles('EURUSD', 'M1', 1000);
    expect(candles).toHaveLength(121);
    expect(candles.at(-1)!.time).toBe(MON + 120 * 60);
    // The current minute is partly formed: its close is not the bar's final close.
    expect(candles.at(-1)!.close).toBeLessThan(1.1 + 121 * 0.0001);

    const m5 = await replay.getCandles('EURUSD', 'M5', 1000);
    expect(m5.at(-1)!.time).toBe(MON + 120 * 60);
    expect(m5).toHaveLength(25);
  });

  it('fills and closes orders as the clock advances', async () => {
    const replay = setup(bars(MON, 600));
    replay.seek(MON + 60 * 60);
    const quote = await replay.getQuote('EURUSD');
    await replay.placePendingOrder({
      symbol: 'EURUSD', side: 'buy', kind: 'stop', lots: 1,
      entry: quote.ask + 0.0005, takeProfit: quote.ask + 0.0015, stopLoss: quote.ask - 0.0005,
    });
    replay.advance(3 * 60);
    expect(await replay.listPositions('EURUSD')).toHaveLength(0);
    replay.advance(10 * 60);
    expect(await replay.listPositions('EURUSD')).toHaveLength(1);
    replay.advance(15 * 60);
    expect(replay.trades()).toHaveLength(1);
    expect(replay.trades()[0].reason).toBe('takeProfit');
    expect(replay.state().stats.totalR).toBeCloseTo(1);
  });

  it('skips market-closed gaps in the charted symbol while advancing', async () => {
    const friday = MON + 4 * 86_400;
    const replay = setup([...bars(friday + 21 * 3600, 60), ...bars(friday + 2 * 86_400 + 22 * 3600, 60, 1.2)]);
    replay.seek(friday + 21 * 3600 + 59 * 60);
    await replay.getCandles('EURUSD', 'M1', 10); // makes EURUSD the charted symbol
    replay.advance(120);
    expect(replay.time).toBe(friday + 2 * 86_400 + 22 * 3600);
  });

  it('pauses at the end of the data', async () => {
    const replay = setup(bars(MON, 10));
    replay.seek(MON + 5 * 60);
    await replay.getCandles('EURUSD', 'M1', 10);
    replay.play();
    replay.advance(3600);
    expect(replay.playing).toBe(false);
    expect(replay.time).toBe(MON + 600);
  });

  it('is served under /api/replay alongside the live routes', async () => {
    const replay = setup(bars(MON, 600));
    const live = new DemoMarketData();
    const app = buildApp({ data: live, execution: new PaperExecution(live), replay });
    await app.inject({ method: 'POST', url: '/api/replay/control', payload: { action: 'seek', time: MON + 3600 } });
    const candles = (await app.inject({ url: '/api/replay/candles?symbol=EURUSD&timeframe=M1&count=5' })).json();
    expect(candles.at(-1).time).toBe(MON + 3600);
    const state = (await app.inject({ method: 'POST', url: '/api/replay/control', payload: { action: 'step', seconds: 600 } })).json();
    expect(state.time).toBe(MON + 4200);
    expect(state.symbols[0]).toMatchObject({ symbol: 'EURUSD', from: MON, to: MON + 36_000 });
    const missing = await app.inject({ url: '/api/replay/candles?symbol=GBPUSD&timeframe=M1' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatch(/npm run download/);
  });
});

describe('partialBar / aggregate', () => {
  const bar = bars(MON, 1)[0];
  it('builds the minute along open, low, high, close for an up bar', () => {
    expect(partialBar(bar, 0).bid.c).toBeCloseTo(bar.bid.o);
    expect(partialBar(bar, 1 / 3).bid.c).toBeCloseTo(bar.bid.l);
    expect(partialBar(bar, 1).bid).toEqual(bar.bid);
  });

  it('aggregates minute bars into mid-price candles', () => {
    const [c] = aggregate(bars(MON, 5), 300);
    expect(c.time).toBe(MON);
    expect(c.open).toBeCloseTo(1.1);
    expect(c.close).toBeCloseTo(1.1005);
    expect(c.volume).toBe(50);
  });
});
