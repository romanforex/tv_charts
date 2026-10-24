import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { DemoMarketData } from './brokers/demo';
import { PaperExecution } from './brokers/paper';
import type { PendingOrder, Quote } from '../shared/types';

function setup() {
  const data = new DemoMarketData();
  const app = buildApp({ data, execution: new PaperExecution(data) });
  const quote = async (): Promise<Quote> => (await app.inject({ url: '/api/quote?symbol=EURUSD' })).json();
  return { app, quote };
}

describe('API', () => {
  it('serves candles in ascending time order', async () => {
    const { app } = setup();
    const res = await app.inject({ url: '/api/candles?symbol=eur_usd&timeframe=M5&count=50' });
    expect(res.statusCode).toBe(200);
    const candles = res.json();
    expect(candles).toHaveLength(50);
    expect(candles[1].time - candles[0].time).toBe(300);
    expect(candles[0].high).toBeGreaterThanOrEqual(candles[0].low);
  });

  it('places a buy limit, lists it, then cancels it', async () => {
    const { app, quote } = setup();
    const { ask } = await quote();
    const order = { symbol: 'EURUSD', side: 'buy', kind: 'limit', lots: 0.1, entry: ask - 0.005, takeProfit: ask + 0.005, stopLoss: ask - 0.01 };
    const placed = await app.inject({ method: 'POST', url: '/api/orders', payload: order });
    expect(placed.statusCode).toBe(200);

    const orders: PendingOrder[] = (await app.inject({ url: '/api/orders?symbol=EURUSD' })).json();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ side: 'buy', kind: 'limit', lots: 0.1 });

    const cancelled = await app.inject({ method: 'POST', url: '/api/orders/cancel', payload: { symbol: 'EURUSD' } });
    expect(cancelled.json()).toEqual({ cancelled: 1 });
  });

  it('refuses an order whose kind no longer matches the market', async () => {
    const { app, quote } = setup();
    const { ask } = await quote();
    // Entry above the ask is a buy stop, but the client claims limit.
    const order = { symbol: 'EURUSD', side: 'buy', kind: 'limit', lots: 0.1, entry: ask + 0.005, takeProfit: ask + 0.01, stopLoss: ask };
    const res = await app.inject({ method: 'POST', url: '/api/orders', payload: order });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a stop loss on the wrong side', async () => {
    const { app, quote } = setup();
    const { ask } = await quote();
    const order = { symbol: 'EURUSD', side: 'buy', kind: 'limit', lots: 0.1, entry: ask - 0.005, takeProfit: ask + 0.005, stopLoss: ask };
    const res = await app.inject({ method: 'POST', url: '/api/orders', payload: order });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/below entry/);
  });

  it('validates input', async () => {
    const { app } = setup();
    const res = await app.inject({ url: '/api/candles?symbol=EURUSD&timeframe=M7' });
    expect(res.statusCode).toBe(400);
  });
});
