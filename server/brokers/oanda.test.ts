import { afterEach, describe, expect, it, vi } from 'vitest';
import { OandaBroker } from './oanda';

afterEach(() => vi.unstubAllGlobals());

describe('OandaBroker.getMinuteBars', () => {
  it('requests M1 bid/ask candles and drops the incomplete one', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({
        candles: [
          {
            time: '2025-03-03T00:00:00.000000000Z',
            volume: 12,
            complete: true,
            bid: { o: '1.04000', h: '1.04010', l: '1.03990', c: '1.04005' },
            ask: { o: '1.04012', h: '1.04022', l: '1.04002', c: '1.04017' },
          },
          {
            time: '2025-03-03T00:01:00.000000000Z',
            volume: 3,
            complete: false,
            bid: { o: '1.04005', h: '1.04005', l: '1.04005', c: '1.04005' },
            ask: { o: '1.04017', h: '1.04017', l: '1.04017', c: '1.04017' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const oanda = new OandaBroker({ token: 't', accountId: 'a', env: 'practice', unitsPerLot: 100_000 });

    const bars = await oanda.getMinuteBars('BCOUSD', Date.UTC(2025, 2, 3) / 1000);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/v3/instruments/BCO_USD/candles');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ granularity: 'M1', price: 'BA', count: '5000' });
    expect(url.searchParams.get('from')).toBe('2025-03-03T00:00:00.000Z');
    expect(bars).toEqual([
      {
        time: Date.UTC(2025, 2, 3) / 1000,
        bid: { o: 1.04, h: 1.0401, l: 1.0399, c: 1.04005 },
        ask: { o: 1.04012, h: 1.04022, l: 1.04002, c: 1.04017 },
        volume: 12,
      },
    ]);
  });
});

describe('OandaBroker.streamQuotes', () => {
  it('parses the price stream across chunk boundaries and ignores heartbeats', async () => {
    const lines = [
      '{"type":"HEARTBEAT","time":"2025-03-03T00:00:00.000Z"}\n{"type":"PRICE","instrument":"EUR_USD","time":"2025-03-03T00:00:01.000Z",',
      '"bids":[{"price":"1.04000"}],"asks":[{"price":"1.04012"}]}\n',
      '{"type":"PRICE","instrument":"USD_JPY","time":"2025-03-03T00:00:02.000Z","bids":[{"price":"150.100"}],"asks":[{"price":"150.112"}]}\n',
    ];
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      const body = new ReadableStream({
        start(c) {
          for (const l of lines) c.enqueue(new TextEncoder().encode(l));
          // Stays open like the real stream until the caller aborts.
          controller.signal.addEventListener('abort', () => c.error(new Error('aborted')));
        },
      });
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const oanda = new OandaBroker({ token: 't', accountId: 'acc', env: 'practice', unitsPerLot: 100_000 });

    const quotes: [string, number, number][] = [];
    const done = oanda.streamQuotes(['EURUSD', 'USDJPY'], (s, quote) => {
      quotes.push([s, quote.bid, quote.ask]);
      if (quotes.length === 2) controller.abort();
    }, controller.signal);
    await expect(done).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://stream-fxpractice.oanda.com/v3/accounts/acc/pricing/stream?instruments=EUR_USD,USD_JPY',
    );
    expect(quotes).toEqual([
      ['EURUSD', 1.04, 1.04012],
      ['USDJPY', 150.1, 150.112],
    ]);
  });
});
