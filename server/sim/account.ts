import { pipSize } from '../../shared/orderPlan';
import type {
  BidAskBar,
  ClosedTrade,
  ExitReason,
  PendingOrder,
  PendingOrderRequest,
  Position,
  Quote,
  ReplayStats,
} from '../../shared/types';

export const UNITS_PER_LOT = 100_000;

interface SimOrder extends PendingOrder {
  takeProfit: number;
  stopLoss: number;
  /** First bar (UNIX seconds) the order may fill on: the minute after it was placed. */
  activeFrom: number;
}

interface SimPosition extends Position {
  takeProfit: number;
  stopLoss: number;
  openedAt: number;
  /** Bars from this time on happened entirely after the fill. */
  fullBarsFrom: number;
  digits: number;
}

/**
 * A simulated account driven one-minute bar at a time. The fill rules are documented in
 * docs/simulation.md; the Python training environment must implement the same rules.
 */
export class SimAccount {
  private nextId = 1;
  private orders: SimOrder[] = [];
  private positions: SimPosition[] = [];
  private digitsBySymbol = new Map<string, number>();
  readonly trades: ClosedTrade[] = [];

  place(order: PendingOrderRequest, digits: number, now: number): string {
    const id = String(this.nextId++);
    this.digitsBySymbol.set(order.symbol, digits);
    this.orders.push({ ...order, id, activeFrom: Math.ceil(now / 60) * 60 });
    return id;
  }

  listOrders(symbol?: string): PendingOrder[] {
    return this.orders
      .filter((o) => !symbol || o.symbol === symbol)
      .map(({ activeFrom: _, ...o }) => o);
  }

  listPositions(symbol?: string): Position[] {
    return this.positions
      .filter((p) => !symbol || p.symbol === symbol)
      .map(({ openedAt: _o, fullBarsFrom: _f, digits: _d, ...p }) => p);
  }

  /** Symbols that need bars fed to `onBar`. */
  activeSymbols(): Set<string> {
    return new Set([...this.orders, ...this.positions].map((x) => x.symbol));
  }

  cancel(symbol: string): number {
    const before = this.orders.length;
    this.orders = this.orders.filter((o) => o.symbol !== symbol);
    return before - this.orders.length;
  }

  /** Closes at the current quote: buys exit on the bid, sells on the ask. */
  closeAtMarket(symbol: string, quote: Quote, now: number): number {
    const closing = this.positions.filter((p) => p.symbol === symbol);
    for (const p of closing) this.close(p, p.side === 'buy' ? quote.bid : quote.ask, now, 'manual');
    return closing.length;
  }

  /** Updates unrealised profit of open positions for one symbol. */
  markToMarket(symbol: string, quote: Quote) {
    for (const p of this.positions) {
      if (p.symbol !== symbol) continue;
      const exit = p.side === 'buy' ? quote.bid : quote.ask;
      p.profit = profitOf(p.side, p.openPrice, exit, p.lots);
    }
  }

  /** Processes one completed one-minute bar for `symbol`. Bars must arrive in time order. */
  onBar(symbol: string, bar: BidAskBar) {
    const barEnd = bar.time + 60;

    this.orders = this.orders.filter((o) => {
      if (o.symbol !== symbol || bar.time < o.activeFrom) return true;
      const fill = fillPrice(o, bar);
      if (fill === null) return true;
      this.positions.push({
        id: o.id,
        symbol,
        side: o.side,
        lots: o.lots,
        openPrice: fill,
        takeProfit: o.takeProfit,
        stopLoss: o.stopLoss,
        profit: 0,
        openedAt: bar.time,
        // A fill at the open (a gap) means the whole bar came after it; otherwise only part did.
        fullBarsFrom: fill === (o.side === 'buy' ? bar.ask.o : bar.bid.o) ? bar.time : barEnd,
        digits: this.digitsBySymbol.get(symbol) ?? 5,
      });
      return false;
    });

    for (const p of [...this.positions]) {
      if (p.symbol !== symbol) continue;
      const exit = exitPrice(p, bar, bar.time < p.fullBarsFrom);
      if (exit) this.close(p, exit.price, barEnd, exit.reason);
    }
  }

  stats(): ReplayStats {
    return {
      trades: this.trades.length,
      wins: this.trades.filter((t) => t.profit > 0).length,
      totalR: this.trades.reduce((sum, t) => sum + t.r, 0),
      totalPips: this.trades.reduce((sum, t) => sum + t.pips, 0),
    };
  }

  private close(p: SimPosition, price: number, now: number, reason: ExitReason) {
    this.positions = this.positions.filter((x) => x !== p);
    const dir = p.side === 'buy' ? 1 : -1;
    const risk = Math.abs(p.openPrice - p.stopLoss);
    this.trades.push({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      lots: p.lots,
      openPrice: p.openPrice,
      closePrice: price,
      openedAt: p.openedAt,
      closedAt: now,
      reason,
      profit: profitOf(p.side, p.openPrice, price, p.lots),
      pips: ((price - p.openPrice) * dir) / pipSize(p.digits),
      r: risk > 0 ? ((price - p.openPrice) * dir) / risk : 0,
    });
  }
}

function profitOf(side: 'buy' | 'sell', open: number, exit: number, lots: number) {
  return (exit - open) * (side === 'buy' ? 1 : -1) * lots * UNITS_PER_LOT;
}

/**
 * Buys fill on the ask, sells on the bid. If the bar opens already past the entry (a gap), a limit
 * fills at the better open price and a stop at the worse open price.
 */
export function fillPrice(o: Pick<PendingOrder, 'side' | 'kind' | 'entry'>, bar: BidAskBar): number | null {
  const { bid, ask } = bar;
  if (o.side === 'buy' && o.kind === 'limit') return ask.l <= o.entry ? Math.min(o.entry, ask.o) : null;
  if (o.side === 'buy' && o.kind === 'stop') return ask.h >= o.entry ? Math.max(o.entry, ask.o) : null;
  if (o.side === 'sell' && o.kind === 'limit') return bid.h >= o.entry ? Math.max(o.entry, bid.o) : null;
  return bid.l <= o.entry ? Math.min(o.entry, bid.o) : null;
}

/**
 * Buys exit on the bid, sells on the ask. One-minute bars don't say whether the high or the low
 * came first, so the rules are pessimistic:
 * - a bar that touches both stop loss and take profit is a stop loss;
 * - on the bar a position opened (unless it filled at that bar's open), only the stop loss is
 *   checked, and it exits at the stop price: the bar's open came before the fill.
 * Gaps through a level fill at the bar's open.
 */
export function exitPrice(
  p: Pick<Position, 'side'> & { takeProfit: number; stopLoss: number },
  bar: BidAskBar,
  partialBar: boolean,
): { price: number; reason: ExitReason } | null {
  if (p.side === 'buy') {
    const { o, h, l } = bar.bid;
    if (l <= p.stopLoss) return { price: partialBar ? p.stopLoss : Math.min(p.stopLoss, o), reason: 'stopLoss' };
    if (!partialBar && h >= p.takeProfit) return { price: Math.max(p.takeProfit, o), reason: 'takeProfit' };
  } else {
    const { o, h, l } = bar.ask;
    if (h >= p.stopLoss) return { price: partialBar ? p.stopLoss : Math.max(p.stopLoss, o), reason: 'stopLoss' };
    if (!partialBar && l <= p.takeProfit) return { price: Math.min(p.takeProfit, o), reason: 'takeProfit' };
  }
  return null;
}
