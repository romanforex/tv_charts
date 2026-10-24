import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { BidAskBar } from '../../shared/types';

/**
 * Downloaded one-minute bid/ask bars on disk:
 *
 *   <dir>/<SYMBOL>/meta.json         {"digits": 5}
 *   <dir>/<SYMBOL>/<YYYY-MM>.csv.gz  time,bid_o,bid_h,bid_l,bid_c,ask_o,ask_h,ask_l,ask_c,volume
 *
 * `time` is the bar's open in UNIX seconds (UTC). Plain gzipped CSV so Python (pandas) can read it
 * directly for model training.
 */
export const CSV_HEADER = 'time,bid_o,bid_h,bid_l,bid_c,ask_o,ask_h,ask_l,ask_c,volume';

export interface SymbolMeta {
  digits: number;
}

export class HistoryStore {
  private months = new Map<string, BidAskBar[]>();

  constructor(readonly dir: string) {}

  symbols(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && this.monthKeys(d.name).length > 0)
      .map((d) => d.name)
      .sort();
  }

  has(symbol: string) {
    return this.monthKeys(symbol).length > 0;
  }

  meta(symbol: string): SymbolMeta {
    const file = join(this.dir, symbol, 'meta.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { digits: 5 };
  }

  /** First bar open and last bar close (UNIX seconds), or null with no data. */
  range(symbol: string): { from: number; to: number } | null {
    const keys = this.monthKeys(symbol);
    if (!keys.length) return null;
    const first = this.month(symbol, keys[0]);
    const last = this.month(symbol, keys.at(-1)!);
    if (!first.length || !last.length) return null;
    return { from: first[0].time, to: last.at(-1)!.time + 60 };
  }

  /** Bars with `from <= time < to`, in time order. */
  bars(symbol: string, from: number, to: number): BidAskBar[] {
    const out: BidAskBar[] = [];
    for (const key of this.monthKeys(symbol)) {
      const [start, end] = monthBounds(key);
      if (end <= from || start >= to) continue;
      const bars = this.month(symbol, key);
      for (let i = lowerBound(bars, from); i < bars.length && bars[i].time < to; i++) out.push(bars[i]);
    }
    return out;
  }

  /** The bar that opens at `minute`, if any. */
  barAt(symbol: string, minute: number): BidAskBar | undefined {
    const bars = this.monthBars(symbol, minute);
    const bar = bars[lowerBound(bars, minute)];
    return bar?.time === minute ? bar : undefined;
  }

  /** The last bar opening before `time`, searching back up to `maxMonths` month files. */
  lastBarBefore(symbol: string, time: number, maxMonths = 2): BidAskBar | undefined {
    const keys = this.monthKeys(symbol).filter((k) => monthBounds(k)[0] < time).slice(-maxMonths).reverse();
    for (const key of keys) {
      const bars = this.month(symbol, key);
      const i = lowerBound(bars, time) - 1;
      if (i >= 0) return bars[i];
    }
    return undefined;
  }

  /** The first bar opening at or after `time`. */
  nextBarAt(symbol: string, time: number): BidAskBar | undefined {
    for (const key of this.monthKeys(symbol)) {
      if (monthBounds(key)[1] <= time) continue;
      const bars = this.month(symbol, key);
      const bar = bars[lowerBound(bars, time)];
      if (bar) return bar;
    }
    return undefined;
  }

  /** Every stored month of bars, for callers that cache derived data per month. */
  monthKeys(symbol: string): string[] {
    const dir = join(this.dir, symbol);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}\.csv\.gz$/.test(f))
      .map((f) => f.slice(0, 7))
      .sort();
  }

  month(symbol: string, key: string): BidAskBar[] {
    const cacheKey = `${symbol}/${key}`;
    let bars = this.months.get(cacheKey);
    if (!bars) {
      const file = join(this.dir, symbol, `${key}.csv.gz`);
      bars = existsSync(file) ? parseCsv(gunzipSync(readFileSync(file)).toString('utf8')) : [];
      this.months.set(cacheKey, bars);
    }
    return bars;
  }

  /** Merges bars into the month files (later downloads replace bars with the same time). */
  write(symbol: string, bars: BidAskBar[], meta?: SymbolMeta) {
    const dir = join(this.dir, symbol);
    mkdirSync(dir, { recursive: true });
    if (meta) writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    const byMonth = new Map<string, BidAskBar[]>();
    for (const bar of bars) {
      const key = monthKey(bar.time);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key)!.push(bar);
    }
    for (const [key, incoming] of byMonth) {
      const merged = new Map(this.month(symbol, key).map((b) => [b.time, b]));
      for (const b of incoming) merged.set(b.time, b);
      const sorted = [...merged.values()].sort((a, b) => a.time - b.time);
      writeFileSync(join(dir, `${key}.csv.gz`), gzipSync(toCsv(sorted)));
      this.months.set(`${symbol}/${key}`, sorted);
    }
  }

  private monthBars(symbol: string, time: number) {
    return this.month(symbol, monthKey(time));
  }
}

export function monthKey(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 7);
}

function monthBounds(key: string): [number, number] {
  const [y, m] = key.split('-').map(Number);
  return [Date.UTC(y, m - 1, 1) / 1000, Date.UTC(y, m, 1) / 1000];
}

/** Index of the first bar with `time >= t`. */
function lowerBound(bars: BidAskBar[], t: number) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function toCsv(bars: BidAskBar[]) {
  const rows = bars.map((b) =>
    [b.time, b.bid.o, b.bid.h, b.bid.l, b.bid.c, b.ask.o, b.ask.h, b.ask.l, b.ask.c, b.volume].join(','),
  );
  return [CSV_HEADER, ...rows].join('\n') + '\n';
}

function parseCsv(text: string): BidAskBar[] {
  const lines = text.split('\n');
  const bars: BidAskBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const v = lines[i].split(',').map(Number);
    bars.push({
      time: v[0],
      bid: { o: v[1], h: v[2], l: v[3], c: v[4] },
      ask: { o: v[5], h: v[6], l: v[7], c: v[8] },
      volume: v[9],
    });
  }
  return bars;
}
