# Replay data and simulation rules

Replay mode and any training environment (for example a Python Gymnasium env) must read the same
data and apply the same fill rules, or results won't be comparable. The reference implementation is
`server/sim/account.ts`; its tests (`server/sim/account.test.ts`) are the worked examples. Port them
when porting the rules.

## Data

`npm run download` writes one-minute **bid and ask** bars:

```
data/history/<SYMBOL>/meta.json          {"digits": 5}
data/history/<SYMBOL>/<YYYY-MM>.csv.gz   time,bid_o,bid_h,bid_l,bid_c,ask_o,ask_h,ask_l,ask_c,volume
```

- `time` is the bar's **open**, UNIX seconds, UTC. A bar covers `[time, time + 60)`.
- Only completed bars are stored. Minutes with no trading have no row (weekends, daily breaks).
- `volume` is OANDA's tick volume (number of price updates), not traded size.

Reading it in Python:

```python
import glob, pandas as pd
files = sorted(glob.glob("data/history/EURUSD/*.csv.gz"))
df = pd.concat(pd.read_csv(f) for f in files)
df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
df = df.set_index("time")
```

## Time

- Orders placed during a minute can only fill from the **next** minute's bar.
- A bar is only used once it has fully closed. The chart shows the current minute partly formed
  (along open, low, high, close for an up bar; open, high, low, close for a down bar), but that
  path is a guess and is never used for fills.

## Fills

Buys fill on the **ask**, sells on the **bid**.

| Order      | Triggers when      | Fill price          |
| ---------- | ------------------ | ------------------- |
| buy limit  | `ask_l <= entry`   | `min(entry, ask_o)` |
| buy stop   | `ask_h >= entry`   | `max(entry, ask_o)` |
| sell limit | `bid_h >= entry`   | `max(entry, bid_o)` |
| sell stop  | `bid_l <= entry`   | `min(entry, bid_o)` |

The `min`/`max` with the open handles gaps: if the bar opens already past the entry, a limit fills
at the (better) open and a stop at the (worse) open.

## Exits

Buys exit on the **bid**, sells on the **ask**. Checked on every bar after the fill:

| Position | Stop loss hit       | Exit                   | Take profit hit     | Exit                   |
| -------- | ------------------- | ---------------------- | ------------------- | ---------------------- |
| buy      | `bid_l <= SL`       | `min(SL, bid_o)`       | `bid_h >= TP`       | `max(TP, bid_o)`       |
| sell     | `ask_h >= SL`       | `max(SL, ask_o)`       | `ask_l <= TP`       | `min(TP, ask_o)`       |

One-minute bars don't show whether the high or the low came first, so the rules are pessimistic:

1. If a bar touches **both** SL and TP, it's a **stop loss**.
2. On the bar a position opened (unless it filled at that bar's open), only the **stop loss** is
   checked, and it exits at exactly the SL price. Part of that bar happened before the fill.
3. If a position filled at the bar's open (a gap), the whole bar came after the fill, so the normal
   rules above apply to that bar.

Closing manually exits at the current bid (buys) or ask (sells).

## Results

For each closed trade:

- `profit = (close - open) * direction * lots * 100,000`, in the quote currency
- `pips = (close - open) * direction / pip`, where `pip` is 0.0001 for 5-digit and 0.01 for
  3-digit quotes
- `r = (close - open) * direction / |open - stop_loss|`: the result in multiples of the risk taken

Spread is paid through the bid/ask prices. Commission and extra slippage are not modelled yet; add
them here and in `account.ts` together.
