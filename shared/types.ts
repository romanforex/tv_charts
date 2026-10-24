// Types shared by the browser client and the server API.

export const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
};

/** A bar with `time` in UNIX seconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  bid: number;
  ask: number;
  /** UNIX milliseconds. */
  time: number;
}

export interface SymbolInfo {
  symbol: string;
  /** Number of decimals prices are quoted with (5 for EURUSD, 3 for USDJPY). */
  digits: number;
}

export type Side = 'buy' | 'sell';
/** Limit: entry is a better price than market. Stop: entry is a worse price (breakout). */
export type PendingKind = 'limit' | 'stop';

export interface PendingOrderRequest {
  symbol: string;
  side: Side;
  kind: PendingKind;
  lots: number;
  entry: number;
  takeProfit: number;
  stopLoss: number;
}

export interface PendingOrder {
  id: string;
  symbol: string;
  side: Side;
  kind: PendingKind;
  lots: number;
  entry: number;
  takeProfit?: number;
  stopLoss?: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  lots: number;
  openPrice: number;
  takeProfit?: number;
  stopLoss?: number;
  profit: number;
}

export interface OrderResult {
  id: string;
  message: string;
}

export interface ServerInfo {
  marketData: string;
  execution: string;
  /** True when orders go to a real (live-money) account. */
  live: boolean;
}

export interface ApiError {
  error: string;
}
