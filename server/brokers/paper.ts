import type {
  OrderResult,
  PendingOrder,
  PendingOrderRequest,
  Position,
  Quote,
  SymbolInfo,
} from '../../shared/types';
import type { Execution, MarketData } from './types';

const UNITS_PER_LOT = 100_000;

/**
 * Simulated account kept in memory. Uses the configured market data for prices; pending orders
 * fill and positions hit TP/SL when checked against the latest quote.
 */
export class PaperExecution implements Execution {
  readonly name = 'paper';
  readonly live = false;
  private nextId = 1;
  private orders: PendingOrder[] = [];
  private positions: Position[] = [];

  constructor(private readonly data: MarketData) {}

  getQuote(symbol: string): Promise<Quote> {
    return this.data.getQuote(symbol);
  }

  getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    return this.data.getSymbolInfo(symbol);
  }

  async placePendingOrder(order: PendingOrderRequest): Promise<OrderResult> {
    const id = String(this.nextId++);
    const { side, kind, symbol, lots, entry, takeProfit, stopLoss } = order;
    this.orders.push({ id, side, kind, symbol, lots, entry, takeProfit, stopLoss });
    return { id, message: `Paper order ${id} created` };
  }

  async listPendingOrders(symbol?: string): Promise<PendingOrder[]> {
    await this.sync();
    return this.orders.filter((o) => !symbol || o.symbol === symbol);
  }

  async listPositions(symbol?: string): Promise<Position[]> {
    await this.sync();
    return this.positions.filter((p) => !symbol || p.symbol === symbol);
  }

  async cancelPendingOrders(symbol: string): Promise<number> {
    const before = this.orders.length;
    this.orders = this.orders.filter((o) => o.symbol !== symbol);
    return before - this.orders.length;
  }

  async closePositions(symbol: string): Promise<number> {
    const before = this.positions.length;
    this.positions = this.positions.filter((p) => p.symbol !== symbol);
    return before - this.positions.length;
  }

  /** Fills triggered orders, closes positions at TP/SL and marks the rest to market. */
  private async sync() {
    const symbols = new Set([...this.orders, ...this.positions].map((x) => x.symbol));
    for (const symbol of symbols) {
      const q = await this.data.getQuote(symbol);
      this.orders = this.orders.filter((o) => {
        if (o.symbol !== symbol) return true;
        const price = o.side === 'buy' ? q.ask : q.bid;
        const triggered =
          (o.side === 'buy') === (o.kind === 'limit') ? price <= o.entry : price >= o.entry;
        if (!triggered) return true;
        const { id, side, lots, entry, takeProfit, stopLoss } = o;
        this.positions.push({ id, symbol, side, lots, openPrice: entry, takeProfit, stopLoss, profit: 0 });
        return false;
      });
      this.positions = this.positions.filter((p) => {
        if (p.symbol !== symbol) return true;
        const exit = p.side === 'buy' ? q.bid : q.ask;
        const dir = p.side === 'buy' ? 1 : -1;
        p.profit = (exit - p.openPrice) * dir * p.lots * UNITS_PER_LOT;
        const hitTp = p.takeProfit !== undefined && (exit - p.takeProfit) * dir >= 0;
        const hitSl = p.stopLoss !== undefined && (exit - p.stopLoss) * dir <= 0;
        return !hitTp && !hitSl;
      });
    }
  }
}
