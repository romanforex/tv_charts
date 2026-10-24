import type {
  BidAskBar,
  Candle,
  OrderResult,
  PendingOrder,
  PendingOrderRequest,
  Position,
  Quote,
  SymbolInfo,
  Timeframe,
} from '../../shared/types';
import { fromOandaInstrument, toOandaInstrument } from '../symbols';
import { BrokerError, type Execution, type MarketData, type QuoteCallback } from './types';

const REQUEST_TIMEOUT_MS = 10_000;
/** OANDA sends a heartbeat every 5 seconds; this long with no data means the stream is dead. */
const STREAM_IDLE_MS = 20_000;

const GRANULARITY: Record<Timeframe, string> = {
  M1: 'M1',
  M5: 'M5',
  M15: 'M15',
  M30: 'M30',
  H1: 'H1',
  H4: 'H4',
  D1: 'D',
};

export interface OandaOptions {
  token: string;
  accountId: string;
  env: 'practice' | 'live';
  unitsPerLot: number;
}

// Subsets of the OANDA v20 REST responses that we read.
interface OandaCandle {
  time: string;
  volume: number;
  mid: { o: string; h: string; l: string; c: string };
}
interface OandaBidAskCandle {
  time: string;
  volume: number;
  complete: boolean;
  bid: { o: string; h: string; l: string; c: string };
  ask: { o: string; h: string; l: string; c: string };
}
interface OandaStreamMessage {
  type: 'PRICE' | 'HEARTBEAT';
  instrument: string;
  time: string;
  bids?: { price: string }[];
  asks?: { price: string }[];
}
interface OandaOrder {
  id: string;
  type: string;
  instrument: string;
  units: string;
  price: string;
  takeProfitOnFill?: { price: string };
  stopLossOnFill?: { price: string };
}
interface OandaTrade {
  id: string;
  instrument: string;
  currentUnits: string;
  price: string;
  unrealizedPL: string;
  takeProfitOrder?: { price: string };
  stopLossOrder?: { price: string };
}

/** OANDA v20 REST API: https://developer.oanda.com/rest-live-v20/introduction/ */
export class OandaBroker implements MarketData, Execution {
  readonly name = 'oanda';
  readonly live: boolean;
  private readonly baseUrl: string;
  private readonly streamUrl: string;
  private readonly digitsCache = new Map<string, number>();

  constructor(private readonly opts: OandaOptions) {
    this.live = opts.env === 'live';
    this.baseUrl = this.live ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3';
    this.streamUrl = this.live ? 'https://stream-fxtrade.oanda.com/v3' : 'https://stream-fxpractice.oanda.com/v3';
  }

  /** Pushes every price change for `symbols` from OANDA's pricing stream until `signal` aborts. */
  async streamQuotes(symbols: string[], onQuote: QuoteCallback, signal: AbortSignal): Promise<void> {
    // Aborts if nothing arrives (connecting included) for STREAM_IDLE_MS; reset on every chunk.
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(), STREAM_IDLE_MS);
    const instruments = symbols.map(toOandaInstrument).join(',');
    let res: Response;
    try {
      res = await fetch(`${this.streamUrl}${this.account}/pricing/stream?instruments=${instruments}`, {
        headers: { Authorization: `Bearer ${this.opts.token}`, 'Accept-Datetime-Format': 'RFC3339' },
        signal: AbortSignal.any([signal, idle.signal]),
      });
    } catch (err) {
      clearTimeout(timer);
      if (signal.aborted) return;
      throw new BrokerError(`Could not reach the OANDA price stream: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const data = (await res.json().catch(() => ({}))) as { errorMessage?: string };
      throw new BrokerError(`OANDA price stream: ${data.errorMessage ?? res.statusText}`, res.status >= 500 ? 502 : 400);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), STREAM_IDLE_MS);
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as OandaStreamMessage;
          if (msg.type === 'PRICE' && msg.bids?.length && msg.asks?.length) {
            onQuote(fromOandaInstrument(msg.instrument), {
              bid: Number(msg.bids[0].price),
              ask: Number(msg.asks[0].price),
              time: Date.parse(msg.time),
            });
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      if (idle.signal.aborted) throw new BrokerError('OANDA price stream went quiet');
      throw new BrokerError(`OANDA price stream failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    }
    if (!signal.aborted) throw new BrokerError('OANDA price stream closed');
  }

  async getCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const params = new URLSearchParams({ granularity: GRANULARITY[timeframe], count: String(count), price: 'M' });
    const data = await this.request<{ candles: OandaCandle[] }>(
      'GET',
      `/instruments/${toOandaInstrument(symbol)}/candles?${params}`,
    );
    return data.candles.map((c) => ({
      time: Math.floor(Date.parse(c.time) / 1000),
      open: Number(c.mid.o),
      high: Number(c.mid.h),
      low: Number(c.mid.l),
      close: Number(c.mid.c),
      volume: c.volume,
    }));
  }

  /** Completed one-minute bid/ask bars starting at `from` (UNIX seconds); OANDA allows up to 5000 per call. */
  async getMinuteBars(symbol: string, from: number, count = 5000): Promise<BidAskBar[]> {
    const params = new URLSearchParams({
      granularity: 'M1',
      price: 'BA',
      from: new Date(from * 1000).toISOString(),
      count: String(count),
    });
    const data = await this.request<{ candles: OandaBidAskCandle[] }>(
      'GET',
      `/instruments/${toOandaInstrument(symbol)}/candles?${params}`,
    );
    const ohlc = (p: OandaBidAskCandle['bid']) => ({ o: Number(p.o), h: Number(p.h), l: Number(p.l), c: Number(p.c) });
    return data.candles
      .filter((c) => c.complete)
      .map((c) => ({ time: Math.floor(Date.parse(c.time) / 1000), bid: ohlc(c.bid), ask: ohlc(c.ask), volume: c.volume }));
  }

  async getQuote(symbol: string): Promise<Quote> {
    const data = await this.request<{ prices: { time: string; bids: { price: string }[]; asks: { price: string }[] }[] }>(
      'GET',
      `${this.account}/pricing?instruments=${toOandaInstrument(symbol)}`,
    );
    const price = data.prices[0];
    if (!price?.bids.length || !price.asks.length) throw new BrokerError(`No price for ${symbol}`);
    return { bid: Number(price.bids[0].price), ask: Number(price.asks[0].price), time: Date.parse(price.time) };
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    let digits = this.digitsCache.get(symbol);
    if (digits === undefined) {
      const data = await this.request<{ instruments: { displayPrecision: number }[] }>(
        'GET',
        `${this.account}/instruments?instruments=${toOandaInstrument(symbol)}`,
      );
      if (!data.instruments.length) throw new BrokerError(`Unknown instrument ${symbol}`, 404);
      digits = data.instruments[0].displayPrecision;
      this.digitsCache.set(symbol, digits);
    }
    return { symbol, digits };
  }

  async placePendingOrder(order: PendingOrderRequest): Promise<OrderResult> {
    const { digits } = await this.getSymbolInfo(order.symbol);
    const units = Math.round(order.lots * this.opts.unitsPerLot) * (order.side === 'buy' ? 1 : -1);
    if (units === 0) throw new BrokerError('Lot size is too small', 400);
    const data = await this.request<{ orderCreateTransaction: { id: string } }>('POST', `${this.account}/orders`, {
      order: {
        type: order.kind === 'limit' ? 'LIMIT' : 'STOP',
        instrument: toOandaInstrument(order.symbol),
        units: String(units),
        price: order.entry.toFixed(digits),
        timeInForce: 'GTC',
        positionFill: 'DEFAULT',
        takeProfitOnFill: { price: order.takeProfit.toFixed(digits) },
        stopLossOnFill: { price: order.stopLoss.toFixed(digits) },
      },
    });
    const id = data.orderCreateTransaction.id;
    return { id, message: `OANDA order ${id} created` };
  }

  async listPendingOrders(symbol?: string): Promise<PendingOrder[]> {
    const data = await this.request<{ orders: OandaOrder[] }>('GET', `${this.account}/pendingOrders`);
    return data.orders
      // TP/SL orders attached to open trades are also "pending"; only entry orders are wanted here.
      .filter((o) => (o.type === 'LIMIT' || o.type === 'STOP') && this.matches(o.instrument, symbol))
      .map((o) => ({
        id: o.id,
        symbol: fromOandaInstrument(o.instrument),
        side: Number(o.units) > 0 ? 'buy' : 'sell',
        kind: o.type === 'LIMIT' ? 'limit' : 'stop',
        lots: Math.abs(Number(o.units)) / this.opts.unitsPerLot,
        entry: Number(o.price),
        takeProfit: optionalNumber(o.takeProfitOnFill?.price),
        stopLoss: optionalNumber(o.stopLossOnFill?.price),
      }));
  }

  async listPositions(symbol?: string): Promise<Position[]> {
    const data = await this.request<{ trades: OandaTrade[] }>('GET', `${this.account}/openTrades`);
    return data.trades
      .filter((t) => this.matches(t.instrument, symbol))
      .map((t) => ({
        id: t.id,
        symbol: fromOandaInstrument(t.instrument),
        side: Number(t.currentUnits) > 0 ? 'buy' : 'sell',
        lots: Math.abs(Number(t.currentUnits)) / this.opts.unitsPerLot,
        openPrice: Number(t.price),
        takeProfit: optionalNumber(t.takeProfitOrder?.price),
        stopLoss: optionalNumber(t.stopLossOrder?.price),
        profit: Number(t.unrealizedPL),
      }));
  }

  async cancelPendingOrders(symbol: string): Promise<number> {
    const orders = await this.listPendingOrders(symbol);
    for (const o of orders) await this.request('PUT', `${this.account}/orders/${o.id}/cancel`);
    return orders.length;
  }

  async closePositions(symbol: string): Promise<number> {
    const positions = await this.listPositions(symbol);
    for (const p of positions) await this.request('PUT', `${this.account}/trades/${p.id}/close`);
    return positions.length;
  }

  private get account() {
    return `/accounts/${this.opts.accountId}`;
  }

  private matches(instrument: string, symbol?: string) {
    return !symbol || fromOandaInstrument(instrument) === symbol;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          'Content-Type': 'application/json',
          'Accept-Datetime-Format': 'RFC3339',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new BrokerError(`Could not reach OANDA: ${(err as Error).message}`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const reject = data.orderRejectTransaction as { rejectReason?: string } | undefined;
      const reason = reject?.rejectReason ?? data.errorMessage ?? res.statusText;
      throw new BrokerError(`OANDA: ${reason}`, res.status >= 500 ? 502 : 400);
    }
    // A 201 can still carry a cancel transaction, e.g. when OANDA rejects the TP/SL after accepting the order.
    const cancel = data.orderCancelTransaction as { reason?: string } | undefined;
    if (method === 'POST' && cancel) throw new BrokerError(`OANDA cancelled the order: ${cancel.reason}`, 400);
    return data as T;
  }
}

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}
