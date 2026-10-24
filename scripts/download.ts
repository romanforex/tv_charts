/**
 * Downloads one-minute bid/ask candles into the history store used by replay mode and training.
 *
 *   npm run download -- EURUSD,BCOUSD --from 2025-01-01 [--to 2025-06-30]
 *   npm run download -- EURUSD --from 2025-01-01 --demo     # synthetic data, no account needed
 *
 * Re-running resumes after the last stored bar, so it can be used to top up recent data.
 */
import { parseArgs } from 'node:util';
import { demoMinuteBars, digitsFor } from '../server/brokers/demo';
import { OandaBroker } from '../server/brokers/oanda';
import { loadConfig } from '../server/config';
import { HistoryStore } from '../server/history/store';
import { normalizeSymbol } from '../server/symbols';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    demo: { type: 'boolean', default: false },
  },
});

const symbols = positionals.flatMap((p) => p.split(',')).map(normalizeSymbol).filter(Boolean);
if (!symbols.length || !values.from) {
  console.error('Usage: npm run download -- EURUSD,GBPUSD --from 2025-01-01 [--to 2025-06-30] [--demo]');
  process.exit(1);
}
const from = parseDate(values.from);
const to = values.to ? parseDate(values.to) : Math.floor(Date.now() / 1000);

const config = loadConfig();
const store = new HistoryStore(config.HISTORY_DIR);

let oanda: OandaBroker | undefined;
if (!values.demo) {
  if (!config.OANDA_TOKEN || !config.OANDA_ACCOUNT_ID) {
    console.error('Set OANDA_TOKEN and OANDA_ACCOUNT_ID in .env (or pass --demo for synthetic data).');
    process.exit(1);
  }
  oanda = new OandaBroker({
    token: config.OANDA_TOKEN,
    accountId: config.OANDA_ACCOUNT_ID,
    env: config.OANDA_ENV,
    unitsPerLot: config.OANDA_UNITS_PER_LOT,
  });
}

for (const symbol of symbols) {
  if (!oanda) {
    store.write(symbol, demoMinuteBars(symbol, from, to), { digits: digitsFor(symbol) });
    console.log(`${symbol}: wrote synthetic bars ${fmt(from)} to ${fmt(to)}`);
    continue;
  }

  const { digits } = await oanda.getSymbolInfo(symbol);
  // Resume after the last stored bar if it falls inside the requested range.
  const last = store.lastBarBefore(symbol, to, 1_000);
  let cursor = last && last.time >= from ? last.time + 60 : from;
  let total = 0;
  while (cursor < to) {
    const bars = (await oanda.getMinuteBars(symbol, cursor)).filter((b) => b.time >= cursor && b.time < to);
    if (!bars.length) break;
    store.write(symbol, bars, { digits });
    total += bars.length;
    cursor = bars.at(-1)!.time + 60;
    process.stdout.write(`\r${symbol}: ${total} bars, up to ${fmt(cursor)}   `);
  }
  console.log(`\r${symbol}: ${total} new bars, stored range ${describeRange(symbol)}   `);
}

function describeRange(symbol: string) {
  const r = store.range(symbol);
  return r ? `${fmt(r.from)} to ${fmt(r.to)}` : 'empty';
}

function parseDate(s: string) {
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(t)) throw new Error(`Bad date: ${s}`);
  return Math.floor(t / 1000);
}

function fmt(t: number) {
  return new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

