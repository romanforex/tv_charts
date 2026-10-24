import type {
  Candle,
  OrderResult,
  PendingOrder,
  PendingOrderRequest,
  Position,
  Quote,
  SymbolInfo,
  Timeframe,
} from '../../shared/types';

/** Called with each new price; `symbol` is the plain form. */
export type QuoteCallback = (symbol: string, quote: Quote) => void;

/** Optional push feed of prices, for brokers that offer one. Polling `getQuote` is the fallback. */
export interface QuoteStreaming {
  /** Streams prices for `symbols` until `signal` aborts. Rejects (or resolves) when the stream ends. */
  streamQuotes?(symbols: string[], onQuote: QuoteCallback, signal: AbortSignal): Promise<void>;
}

/** Symbols are always the plain form (EURUSD); each adapter maps them to its broker's naming. */
export interface MarketData extends QuoteStreaming {
  readonly name: string;
  getCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]>;
  getQuote(symbol: string): Promise<Quote>;
  getSymbolInfo(symbol: string): Promise<SymbolInfo>;
}

export interface Execution extends QuoteStreaming {
  readonly name: string;
  readonly live: boolean;
  /** Quote the order is validated against: the execution venue's own price. */
  getQuote(symbol: string): Promise<Quote>;
  getSymbolInfo(symbol: string): Promise<SymbolInfo>;
  placePendingOrder(order: PendingOrderRequest): Promise<OrderResult>;
  listPendingOrders(symbol?: string): Promise<PendingOrder[]>;
  listPositions(symbol?: string): Promise<Position[]>;
  /** Returns the number of orders cancelled. */
  cancelPendingOrders(symbol: string): Promise<number>;
  /** Returns the number of positions closed. */
  closePositions(symbol: string): Promise<number>;
}

/** An error whose message is safe and useful to show in the UI. */
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
