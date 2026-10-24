import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { planOrder, roundToDigits } from '../shared/orderPlan';
import { TIMEFRAMES, type ServerInfo } from '../shared/types';
import { BrokerError, type Execution, type MarketData } from './brokers/types';
import { normalizeSymbol } from './symbols';

const symbolField = z.string().min(3).max(20).transform(normalizeSymbol);
const price = z.number().positive().finite();

const candlesQuery = z.object({
  symbol: symbolField,
  timeframe: z.enum(TIMEFRAMES),
  count: z.coerce.number().int().min(1).max(1000).default(500),
});
const symbolQuery = z.object({ symbol: symbolField });
const optionalSymbolQuery = z.object({ symbol: symbolField.optional() });
const orderBody = z.object({
  symbol: symbolField,
  side: z.enum(['buy', 'sell']),
  kind: z.enum(['limit', 'stop']),
  lots: z.number().positive().max(100),
  entry: price,
  takeProfit: price,
  stopLoss: price,
});

export function buildApp(data: MarketData, execution: Execution, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    if (err instanceof BrokerError) {
      req.log.warn(err.message);
      return reply.status(err.status).send({ error: err.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'Internal server error' });
  });

  app.get('/api/info', async (): Promise<ServerInfo> => ({
    marketData: data.name,
    execution: execution.name,
    live: execution.live,
  }));

  app.get('/api/candles', async (req) => {
    const q = candlesQuery.parse(req.query);
    return data.getCandles(q.symbol, q.timeframe, q.count);
  });

  // Quotes and symbol info come from the execution venue: that's the price orders are judged against.
  app.get('/api/quote', async (req) => execution.getQuote(symbolQuery.parse(req.query).symbol));
  app.get('/api/symbol', async (req) => execution.getSymbolInfo(symbolQuery.parse(req.query).symbol));

  app.get('/api/orders', async (req) => execution.listPendingOrders(optionalSymbolQuery.parse(req.query).symbol));
  app.get('/api/positions', async (req) => execution.listPositions(optionalSymbolQuery.parse(req.query).symbol));

  app.post('/api/orders', async (req) => {
    const body = orderBody.parse(req.body);
    const { digits } = await execution.getSymbolInfo(body.symbol);
    const order = {
      ...body,
      entry: roundToDigits(body.entry, digits),
      takeProfit: roundToDigits(body.takeProfit, digits),
      stopLoss: roundToDigits(body.stopLoss, digits),
    };
    // Re-check against a fresh quote: price may have crossed the entry since the user clicked,
    // which would turn a limit into a stop (or vice versa). Refuse rather than place something else.
    const plan = planOrder(order.entry, order.takeProfit, order.stopLoss, await execution.getQuote(order.symbol));
    if (!plan.ok) throw new BrokerError(plan.error, 400);
    if (plan.side !== order.side || plan.kind !== order.kind) {
      throw new BrokerError(
        `Price moved: this would now be a ${plan.side} ${plan.kind}, not a ${order.side} ${order.kind}. Re-place the order.`,
        409,
      );
    }
    req.log.info({ order }, 'placing pending order');
    return execution.placePendingOrder(order);
  });

  app.post('/api/orders/cancel', async (req) => ({
    cancelled: await execution.cancelPendingOrders(symbolQuery.parse(req.body).symbol),
  }));

  app.post('/api/positions/close', async (req) => ({
    closed: await execution.closePositions(symbolQuery.parse(req.body).symbol),
  }));

  return app;
}
