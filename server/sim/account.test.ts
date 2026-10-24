import { describe, expect, it } from 'vitest';
import type { BidAskBar } from '../../shared/types';
import { SimAccount } from './account';

const SPREAD = 0.0001;
/** Bar from mid OHLC with a fixed spread. */
function bar(minute: number, o: number, h: number, l: number, c: number): BidAskBar {
  const half = SPREAD / 2;
  return {
    time: minute * 60,
    bid: { o: o - half, h: h - half, l: l - half, c: c - half },
    ask: { o: o + half, h: h + half, l: l + half, c: c + half },
    volume: 1,
  };
}

const buyLimit = { symbol: 'EURUSD', side: 'buy', kind: 'limit', lots: 1, entry: 1.099, takeProfit: 1.102, stopLoss: 1.098 } as const;

describe('SimAccount', () => {
  it('ignores the bar the order was placed in', () => {
    const acc = new SimAccount();
    acc.place(buyLimit, 5, 30); // placed mid-way through minute 0
    acc.onBar('EURUSD', bar(0, 1.1, 1.1, 1.095, 1.1));
    expect(acc.listOrders()).toHaveLength(1);
  });

  it('fills a buy limit on the ask and takes profit on a later bar', () => {
    const acc = new SimAccount();
    acc.place(buyLimit, 5, 0);
    acc.onBar('EURUSD', bar(0, 1.1, 1.1, 1.0985, 1.0995));
    expect(acc.listPositions()[0].openPrice).toBe(1.099);
    acc.onBar('EURUSD', bar(1, 1.0995, 1.103, 1.0993, 1.1025));
    expect(acc.trades[0]).toMatchObject({ reason: 'takeProfit', closePrice: 1.102 });
    expect(acc.trades[0].r).toBeCloseTo(3);
    expect(acc.trades[0].pips).toBeCloseTo(30);
  });

  it('a bar touching both TP and SL counts as a stop loss', () => {
    const acc = new SimAccount();
    acc.place(buyLimit, 5, 0);
    acc.onBar('EURUSD', bar(0, 1.1, 1.1, 1.0988, 1.0995));
    acc.onBar('EURUSD', bar(1, 1.0995, 1.103, 1.097, 1.1));
    expect(acc.trades[0]).toMatchObject({ reason: 'stopLoss', closePrice: 1.098 });
    expect(acc.trades[0].r).toBeCloseTo(-1);
  });

  it('only checks the stop loss on the fill bar', () => {
    const acc = new SimAccount();
    acc.place(buyLimit, 5, 0);
    acc.onBar('EURUSD', bar(0, 1.1, 1.103, 1.0985, 1.1)); // fills, and TP range touched: ignored
    expect(acc.listPositions()).toHaveLength(1);
    const acc2 = new SimAccount();
    acc2.place(buyLimit, 5, 0);
    acc2.onBar('EURUSD', bar(0, 1.1, 1.1, 1.0975, 1.1)); // fills and hits SL in the same bar
    expect(acc2.trades[0]).toMatchObject({ reason: 'stopLoss', closePrice: 1.098 });
  });

  it('fills at the open when the bar gaps through the entry', () => {
    const acc = new SimAccount();
    acc.place(buyLimit, 5, 0);
    acc.onBar('EURUSD', bar(0, 1.0985, 1.0987, 1.0982, 1.0985)); // gap below the limit: better price
    expect(acc.listPositions()[0].openPrice).toBeCloseTo(1.0985 + SPREAD / 2);

    const stop = new SimAccount();
    stop.place({ symbol: 'EURUSD', side: 'buy', kind: 'stop', lots: 1, entry: 1.101, takeProfit: 1.105, stopLoss: 1.099 }, 5, 0);
    stop.onBar('EURUSD', bar(0, 1.1020, 1.103, 1.1015, 1.102)); // gap up above the stop: worse price
    expect(stop.listPositions()[0].openPrice).toBeCloseTo(1.102 + SPREAD / 2);
  });

  it('a gap through both entry and stop loss loses only the spread, not a fake profit', () => {
    const acc = new SimAccount();
    acc.place(buyLimit, 5, 0);
    acc.onBar('EURUSD', bar(0, 1.095, 1.0955, 1.094, 1.095));
    expect(acc.trades[0]).toMatchObject({ reason: 'stopLoss' });
    expect(acc.trades[0].closePrice).toBeCloseTo(1.095 - SPREAD / 2);
    expect(acc.trades[0].pips).toBeCloseTo(-1);
  });

  it('a gap through the stop loss exits at the open', () => {
    const acc = new SimAccount();
    acc.place(buyLimit, 5, 0);
    acc.onBar('EURUSD', bar(0, 1.1, 1.1, 1.0988, 1.0995));
    acc.onBar('EURUSD', bar(1, 1.0960, 1.0965, 1.0955, 1.096));
    expect(acc.trades[0].closePrice).toBeCloseTo(1.096 - SPREAD / 2);
    expect(acc.trades[0].r).toBeLessThan(-1);
  });

  it('sells fill on the bid and exit on the ask', () => {
    const acc = new SimAccount();
    acc.place({ symbol: 'EURUSD', side: 'sell', kind: 'limit', lots: 0.5, entry: 1.101, takeProfit: 1.098, stopLoss: 1.102 }, 5, 0);
    acc.onBar('EURUSD', bar(0, 1.1, 1.1015, 1.0995, 1.1005));
    expect(acc.listPositions()[0]).toMatchObject({ side: 'sell', openPrice: 1.101 });
    acc.onBar('EURUSD', bar(1, 1.1005, 1.1006, 1.0975, 1.098));
    expect(acc.trades[0]).toMatchObject({ reason: 'takeProfit', closePrice: 1.098 });
    expect(acc.trades[0].profit).toBeCloseTo(0.003 * 0.5 * 100_000);
  });

  it('closes at market and reports stats', () => {
    const acc = new SimAccount();
    acc.place(buyLimit, 5, 0);
    acc.onBar('EURUSD', bar(0, 1.1, 1.1, 1.0985, 1.0995));
    expect(acc.closeAtMarket('EURUSD', { bid: 1.0995, ask: 1.0996, time: 0 }, 120)).toBe(1);
    expect(acc.stats()).toMatchObject({ trades: 1, wins: 1 });
    expect(acc.stats().totalR).toBeCloseTo(0.5);
  });
});
