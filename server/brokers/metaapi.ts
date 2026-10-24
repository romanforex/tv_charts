import MetaApi, { type MetatraderAccount, type RpcMetaApiConnectionInstance } from 'metaapi.cloud-sdk/esm-node';
import type {
  Candle,
  OrderResult,
  PendingKind,
  PendingOrder,
  PendingOrderRequest,
  Position,
  Quote,
  Side,
  SymbolInfo,
  Timeframe,
} from '../../shared/types';
import { BrokerError, type Execution, type MarketData } from './types';

const TIMEFRAME: Record<Timeframe, string> = {
  M1: '1m',
  M5: '5m',
  M15: '15m',
  M30: '30m',
  H1: '1h',
  H4: '4h',
  D1: '1d',
};

const PENDING_TYPES: Record<string, { side: Side; kind: PendingKind }> = {
  ORDER_TYPE_BUY_LIMIT: { side: 'buy', kind: 'limit' },
  ORDER_TYPE_SELL_LIMIT: { side: 'sell', kind: 'limit' },
  ORDER_TYPE_BUY_STOP: { side: 'buy', kind: 'stop' },
  ORDER_TYPE_SELL_STOP: { side: 'sell', kind: 'stop' },
};

export interface MetaApiOptions {
  token: string;
  accountId: string;
  symbolSuffix: string;
  live: boolean;
}

/**
 * MetaTrader 4/5 through MetaApi (https://metaapi.cloud). MetaApi runs the terminal in its cloud,
 * so this works from any OS without a local MetaTrader install.
 */
export class MetaApiBroker implements MarketData, Execution {
  readonly name = 'metaapi';
  readonly live: boolean;
  private readonly api: MetaApi;
  private session?: Promise<{ account: MetatraderAccount; connection: RpcMetaApiConnectionInstance }>;
  private readonly digitsCache = new Map<string, number>();

  constructor(private readonly opts: MetaApiOptions) {
    this.live = opts.live;
    this.api = new MetaApi(opts.token);
  }

  async getCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const { account } = await this.connect();
    // Historical market data is not available on every MetaApi account type; see the README.
    const candles = await this.call(() =>
      account.getHistoricalCandles(this.toBroker(symbol), TIMEFRAME[timeframe], undefined, Math.min(count, 1000)),
    );
    return candles
      .map((c) => ({
        time: Math.floor(new Date(c.time).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.tickVolume,
      }))
      .sort((a, b) => a.time - b.time);
  }

  async getQuote(symbol: string): Promise<Quote> {
    const { connection } = await this.connect();
    const price = await this.call(() => connection.getSymbolPrice(this.toBroker(symbol), true));
    return { bid: price.bid, ask: price.ask, time: new Date(price.time).getTime() };
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    let digits = this.digitsCache.get(symbol);
    if (digits === undefined) {
      const { connection } = await this.connect();
      const spec = await this.call(() => connection.getSymbolSpecification(this.toBroker(symbol)));
      digits = spec.digits;
      this.digitsCache.set(symbol, digits);
    }
    return { symbol, digits };
  }

  async placePendingOrder(order: PendingOrderRequest): Promise<OrderResult> {
    const { connection } = await this.connect();
    const symbol = this.toBroker(order.symbol);
    const args = [symbol, order.lots, order.entry, order.stopLoss, order.takeProfit, { comment: 'tv_charts' }] as const;
    const result = await this.call(() => {
      if (order.side === 'buy') {
        return order.kind === 'limit' ? connection.createLimitBuyOrder(...args) : connection.createStopBuyOrder(...args);
      }
      return order.kind === 'limit' ? connection.createLimitSellOrder(...args) : connection.createStopSellOrder(...args);
    });
    return { id: result.orderId, message: `MetaTrader order ${result.orderId} created (${result.stringCode})` };
  }

  async listPendingOrders(symbol?: string): Promise<PendingOrder[]> {
    const { connection } = await this.connect();
    const orders = await this.call(() => connection.getOrders());
    return orders.flatMap((o) => {
      const type = PENDING_TYPES[o.type];
      const plain = this.fromBroker(o.symbol);
      if (!type || (symbol && plain !== symbol)) return [];
      return [
        {
          id: String(o.id),
          symbol: plain,
          ...type,
          lots: o.currentVolume,
          entry: o.openPrice,
          takeProfit: o.takeProfit,
          stopLoss: o.stopLoss,
        },
      ];
    });
  }

  async listPositions(symbol?: string): Promise<Position[]> {
    const { connection } = await this.connect();
    const positions = await this.call(() => connection.getPositions());
    return positions
      .filter((p) => !symbol || this.fromBroker(p.symbol) === symbol)
      .map((p) => ({
        id: String(p.id),
        symbol: this.fromBroker(p.symbol),
        side: p.type === 'POSITION_TYPE_BUY' ? 'buy' : 'sell',
        lots: p.volume,
        openPrice: p.openPrice,
        takeProfit: p.takeProfit,
        stopLoss: p.stopLoss,
        profit: p.profit,
      }));
  }

  async cancelPendingOrders(symbol: string): Promise<number> {
    const { connection } = await this.connect();
    const orders = await this.listPendingOrders(symbol);
    for (const o of orders) await this.call(() => connection.cancelOrder(o.id));
    return orders.length;
  }

  async closePositions(symbol: string): Promise<number> {
    const { connection } = await this.connect();
    const positions = await this.listPositions(symbol);
    if (positions.length) await this.call(() => connection.closePositionsBySymbol(this.toBroker(symbol), {}));
    return positions.length;
  }

  /** Deploys the account if needed and opens one shared RPC connection. */
  private connect() {
    this.session ??= (async () => {
      const account = await this.api.metatraderAccountApi.getAccount(this.opts.accountId);
      if (account.state !== 'DEPLOYED') await account.deploy();
      await account.waitConnected();
      const connection = account.getRPCConnection();
      await connection.connect();
      await connection.waitSynchronized();
      return { account, connection };
    })().catch((err) => {
      this.session = undefined; // retry on the next request
      throw new BrokerError(`MetaApi connection failed: ${errorMessage(err)}`);
    });
    return this.session;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new BrokerError(`MetaApi: ${errorMessage(err)}`, 400);
    }
  }

  private toBroker(symbol: string) {
    return symbol + this.opts.symbolSuffix;
  }

  private fromBroker(symbol: string) {
    const suffix = this.opts.symbolSuffix;
    return suffix && symbol.endsWith(suffix) ? symbol.slice(0, -suffix.length) : symbol;
  }
}

function errorMessage(err: unknown): string {
  const e = err as { message?: string; stringCode?: string };
  return [e.stringCode, e.message].filter(Boolean).join(' ') || String(err);
}
