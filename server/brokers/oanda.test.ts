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
