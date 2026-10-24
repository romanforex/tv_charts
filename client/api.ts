import type {
  Candle,
  OrderResult,
  PendingOrder,
  PendingOrderRequest,
  Position,
  Quote,
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

export const api = {
  info: () => request<ServerInfo>('/api/info'),
  candles: (symbol: string, timeframe: Timeframe, count: number) =>
    request<Candle[]>(`/api/candles?${q({ symbol, timeframe, count })}`),
  quote: (symbol: string) => request<Quote>(`/api/quote?${q({ symbol })}`),
  symbol: (symbol: string) => request<SymbolInfo>(`/api/symbol?${q({ symbol })}`),
  orders: (symbol: string) => request<PendingOrder[]>(`/api/orders?${q({ symbol })}`),
  positions: (symbol: string) => request<Position[]>(`/api/positions?${q({ symbol })}`),
  placeOrder: (order: PendingOrderRequest) => request<OrderResult>('/api/orders', order),
  cancelOrders: (symbol: string) => request<{ cancelled: number }>('/api/orders/cancel', { symbol }),
  closePositions: (symbol: string) => request<{ closed: number }>('/api/positions/close', { symbol }),
};
