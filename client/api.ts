import type {
  Candle,
  ClosedTrade,
  OrderResult,
  PendingOrder,
  PendingOrderRequest,
  Position,
  Quote,
  ReplayState,
  ServerInfo,
  SymbolInfo,
  Timeframe,
} from '../shared/types';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

const q = (params: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

/** Chart and order calls. `base` is `/api` for live trading or `/api/replay` for replay mode. */
export function createApi(base: string) {
  return {
    candles: (symbol: string, timeframe: Timeframe, count: number) =>
      request<Candle[]>(`${base}/candles?${q({ symbol, timeframe, count })}`),
    quote: (symbol: string) => request<Quote>(`${base}/quote?${q({ symbol })}`),
    symbol: (symbol: string) => request<SymbolInfo>(`${base}/symbol?${q({ symbol })}`),
    orders: (symbol: string) => request<PendingOrder[]>(`${base}/orders?${q({ symbol })}`),
    positions: (symbol: string) => request<Position[]>(`${base}/positions?${q({ symbol })}`),
    placeOrder: (order: PendingOrderRequest) => request<OrderResult>(`${base}/orders`, order),
    cancelOrders: (symbol: string) => request<{ cancelled: number }>(`${base}/orders/cancel`, { symbol }),
    closePositions: (symbol: string) => request<{ closed: number }>(`${base}/positions/close`, { symbol }),
  };
}

export type Api = ReturnType<typeof createApi>;

export const info = () => request<ServerInfo>('/api/info');

export type ReplayCommand =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'speed'; speed: number }
  | { action: 'step'; seconds: number }
  | { action: 'seek'; time: number };

export const replayApi = {
  state: () => request<ReplayState>('/api/replay/state'),
  control: (cmd: ReplayCommand) => request<ReplayState>('/api/replay/control', cmd),
  trades: () => request<ClosedTrade[]>('/api/replay/trades'),
};
