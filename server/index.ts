import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app';
import { DemoMarketData } from './brokers/demo';
import { MetaApiBroker } from './brokers/metaapi';
import { OandaBroker } from './brokers/oanda';
import { PaperExecution } from './brokers/paper';
import type { Execution, MarketData } from './brokers/types';
import { loadConfig, type Config } from './config';

const config = loadConfig();

// One instance per provider, so using e.g. MetaApi for both data and execution shares a connection.
const instances = new Map<string, MarketData | Execution>();
function provider(name: 'oanda' | 'metaapi', cfg: Config) {
  if (!instances.has(name)) {
    instances.set(
      name,
      name === 'oanda'
        ? new OandaBroker({
            token: cfg.OANDA_TOKEN!,
            accountId: cfg.OANDA_ACCOUNT_ID!,
            env: cfg.OANDA_ENV,
            unitsPerLot: cfg.OANDA_UNITS_PER_LOT,
          })
        : new MetaApiBroker({
            token: cfg.METAAPI_TOKEN!,
            accountId: cfg.METAAPI_ACCOUNT_ID!,
            symbolSuffix: cfg.METAAPI_SYMBOL_SUFFIX,
            live: cfg.METAAPI_LIVE,
          }),
    );
  }
  return instances.get(name) as OandaBroker | MetaApiBroker;
}

const data: MarketData = config.MARKET_DATA === 'demo' ? new DemoMarketData() : provider(config.MARKET_DATA, config);
const execution: Execution = config.EXECUTION === 'paper' ? new PaperExecution(data) : provider(config.EXECUTION, config);

const app = buildApp(data, execution, { logger: true });

// In production the server also serves the built client, so it's one process on one port.
const clientDir = fileURLToPath(new URL('../dist/client', import.meta.url));
if (process.env.NODE_ENV === 'production' && existsSync(clientDir)) {
  await app.register(fastifyStatic, { root: clientDir });
}

if (config.HOST !== '127.0.0.1' && config.HOST !== 'localhost') {
  app.log.warn(`Listening on ${config.HOST}: anyone who can reach this port can place trades. There is no login.`);
}
if (execution.live) app.log.warn('EXECUTION is a LIVE account: orders use real money.');

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(`market data: ${data.name}, execution: ${execution.name}`);
