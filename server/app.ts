import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { planOrder, roundToDigits } from '../shared/orderPlan';
import { TIMEFRAMES, type ServerInfo } from '../shared/types';
import { BrokerError, type Execution, type MarketData } from './brokers/types';
import type { ReplaySession } from './replay/session';
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
const replayControl = z.discriminatedUnion('action', [
  z.object({ action: z.literal('play') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('speed'), speed: z.number().positive().max(100_000) }),
  z.object({ action: z.literal('step'), seconds: z.number().positive().max(31 * 86_400) }),
  z.object({ action: z.literal('seek'), time: z.number().int().positive() }),
]);

export interface AppOptions {
  data: MarketData;
  execution: Execution;
  /** Replay mode, served under /api/replay with the same routes as live. */
  replay?: ReplaySession;
  logger?: boolean;
}

export function buildApp({ data, execution, replay, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({ logger });

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

  app.register(tradingRoutes(data, execution), { prefix: '/api' });

  if (replay) {
    app.register(tradingRoutes(replay, replay), { prefix: '/api/replay' });
    app.get('/api/replay/state', async () => replay.state());
    app.get('/api/replay/trades', async () => replay.trades());
    app.post('/api/replay/control', async (req) => {
      const cmd = replayControl.parse(req.body);
      if (cmd.action === 'play') replay.play();
      else if (cmd.action === 'pause') replay.pause();
      else if (cmd.action === 'speed') replay.setSpeed(cmd.speed);
      else if (cmd.action === 'step') replay.advance(cmd.seconds);
      else replay.seek(cmd.time);
      return replay.state();
    });
  }

  return app;
}

/** Chart and order routes, mounted once for live trading and once for replay. */
function tradingRoutes(data: MarketData, execution: Execution): FastifyPluginAsync {
  return async (app) => {
    app.get('/candles', async (req) => {
      const q = candlesQuery.parse(req.query);
      return data.getCandles(q.symbol, q.timeframe, q.count);
    });

    // Quotes and symbol info come from the execution venue: that's the price orders are judged against.
    app.get('/quote', async (req) => execution.getQuote(symbolQuery.parse(req.query).symbol));
    app.get('/symbol', async (req) => execution.getSymbolInfo(symbolQuery.parse(req.query).symbol));

    app.get('/orders', async (req) => execution.listPendingOrders(optionalSymbolQuery.parse(req.query).symbol));
    app.get('/positions', async (req) => execution.listPositions(optionalSymbolQuery.parse(req.query).symbol));

    app.post('/orders', async (req) => {
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

    app.post('/orders/cancel', async (req) => ({
      cancelled: await execution.cancelPendingOrders(symbolQuery.parse(req.body).symbol),
    }));

    app.post('/positions/close', async (req) => ({
      closed: await execution.closePositions(symbolQuery.parse(req.body).symbol),
    }));
  };
}
