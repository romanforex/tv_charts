import type { PendingKind, Quote, Side } from './types';

export type OrderPlan =
  | {
      ok: true;
      side: Side;
      kind: PendingKind;
      /** Reward-to-risk ratio, e.g. 2 means the TP is twice as far as the SL. */
      rewardRisk: number;
    }
  | { ok: false; error: string };

/** Works out which side a TP click implies relative to the entry click. */
export function sideFromTakeProfit(entry: number, takeProfit: number): Side | null {
  if (takeProfit > entry) return 'buy';
  if (takeProfit < entry) return 'sell';
  return null;
}

/** Checks that a stop loss sits on the losing side of the entry for this side. */
export function stopLossError(side: Side, entry: number, stopLoss: number): string | null {
  if (side === 'buy' && stopLoss >= entry) return 'Stop loss must be below entry for a buy';
  if (side === 'sell' && stopLoss <= entry) return 'Stop loss must be above entry for a sell';
  return null;
}

/**
 * Turns three chart clicks into an order.
 *
 * - TP above entry is a buy, TP below entry is a sell.
 * - A buy below the ask (or sell above the bid) is a limit order; the other way round is a stop order.
 */
export function planOrder(entry: number, takeProfit: number, stopLoss: number, quote: Quote): OrderPlan {
  if (![entry, takeProfit, stopLoss].every((p) => Number.isFinite(p) && p > 0)) {
    return { ok: false, error: 'Prices must be positive numbers' };
  }
  const side = sideFromTakeProfit(entry, takeProfit);
  if (!side) return { ok: false, error: 'Take profit cannot equal entry' };

  const slError = stopLossError(side, entry, stopLoss);
  if (slError) return { ok: false, error: slError };

  const market = side === 'buy' ? quote.ask : quote.bid;
  if (entry === market) return { ok: false, error: 'Entry is at the current price; use a market order' };
  const kind: PendingKind = (side === 'buy') === entry < market ? 'limit' : 'stop';

  return { ok: true, side, kind, rewardRisk: Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss) };
}

export function roundToDigits(price: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(price * factor) / factor;
}
