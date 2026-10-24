# TV Charts

Forex charts with three-click pending orders. One TypeScript repo: a [Vite](https://vite.dev) front end using
[lightweight-charts](https://github.com/tradingview/lightweight-charts) and a [Fastify](https://fastify.dev)
back end that talks to the broker. API tokens live only on the server.

## Quick start

```sh
npm install
npm run dev          # http://localhost:5173
```

With no `.env` it runs on **demo** prices and a **paper** (simulated) account, so you can try the whole flow
without any broker credentials.

## Placing an order

1. Press **N** (or click **New order**).
2. Click the **entry** price.
3. Click the **take profit**. Above the entry means a buy, below it means a sell.
4. Click the **stop loss**. It must be on the other side of the entry.
5. Review the summary and press **Enter** to send (or **Esc** to cancel). Untick *Confirm before sending* to
   send right after the third click.

The order type is chosen from the current price:

|          | entry below market | entry above market |
| -------- | ------------------ | ------------------ |
| **buy**  | buy limit          | buy stop           |
| **sell** | sell stop          | sell limit         |

The server re-checks the order against a fresh quote. If price has crossed your entry since you clicked
(so a limit would now be a stop), it refuses the order instead of placing a different type.

Working orders and open positions for the charted symbol are drawn on the chart. **Cancel pending** and
**Close positions** act on the charted symbol only.

## Replay: paper trading on past data

Switch the **Live / Replay** selector to *Replay* to trade on downloaded history as if it were live.
The chart only ever shows data up to the replay clock.

1. Download one-minute history (needs the OANDA settings below; resumes where it left off):

   ```sh
   npm run download -- EURUSD,GBPUSD --from 2025-01-01
   npm run download -- EURUSD --from 2025-01-01 --demo   # synthetic data, no account needed
   ```

2. Pick a date and **Jump**, then **Play** (Space), **Step** one candle at a time, or change the
   speed (1x to 1800x). Market-closed gaps such as weekends are skipped.
3. Place orders with the same three clicks. A simulated account fills them bar by bar using bid/ask
   prices, and the bar above the chart shows trades, win rate, total R and pips.

Jumping to a new date starts a fresh replay account. The exact fill rules (spread, gaps, and what
happens when a bar touches both TP and SL) are in [docs/simulation.md](docs/simulation.md). They are
also the spec for a training environment.

## Connecting a broker

Copy `.env.example` to `.env`. Chart data and order execution are set separately:

| Setup                                    | `MARKET_DATA` | `EXECUTION` |
| ---------------------------------------- | ------------- | ----------- |
| Try it out                               | `demo`        | `paper`     |
| OANDA account                            | `oanda`       | `oanda`     |
| MetaTrader broker via MetaApi            | `metaapi`     | `metaapi`   |
| OANDA charts, simulated orders           | `oanda`       | `paper`     |
| OANDA charts, MetaTrader orders          | `oanda`       | `metaapi`   |

Prefer taking chart data from the same place orders go. Different brokers quote slightly different prices,
so a level picked on an OANDA chart can be a few pips off on a MetaTrader broker.

### MetaApi (MetaTrader 4/5)

MetaApi runs the MetaTrader terminal in its cloud, so this works on any OS with no local MetaTrader install.

1. Add your MT account at [app.metaapi.cloud](https://app.metaapi.cloud) and copy its **account id**.
2. Create an API token and put both in `.env`.
3. If your broker suffixes symbols (`EURUSD.m`), set `METAAPI_SYMBOL_SUFFIX`.

The first request deploys and connects the account, which can take a minute or two.

MetaApi's historical candles API is not available on every account type. If the chart fails to load with
`MARKET_DATA=metaapi`, use `MARKET_DATA=oanda` for charts and keep `EXECUTION=metaapi`.

Lot sizes are MetaTrader lots. For OANDA they are converted to units with `OANDA_UNITS_PER_LOT` (100,000).

## Scripts

| Command             | What it does                                                      |
| ------------------- | ----------------------------------------------------------------- |
| `npm run dev`       | Server (port 3001, auto-restart) + Vite dev server (port 5173)   |
| `npm run build`     | Typecheck and build the client to `dist/client`                  |
| `npm start`         | Production: one process serving the API and the built client     |
| `npm test`          | Unit and API tests                                                |
| `npm run download`  | Download one-minute bid/ask history for replay and training       |
| `npm run typecheck` | TypeScript only                                                   |

## Layout

```
client/   browser: chart, three-click order tool, toolbar, replay controls
server/   Fastify API; brokers/ has one adapter per provider (oanda, metaapi, demo, paper)
  history/  on-disk one-minute bid/ask store
  replay/   replay clock and data (served under /api/replay)
  sim/      bar-by-bar simulated account used by replay
scripts/  download.ts
shared/   types and order rules used by both sides
docs/     simulation.md: data format and fill rules
```

## Safety

- The server binds to `127.0.0.1` and has no login. Don't expose it to a network without adding auth.
- A **LIVE** badge shows when orders go to a real-money account (`OANDA_ENV=live` or `METAAPI_LIVE=true`).
