import { TIMEFRAME_SECONDS, type Candle, type Quote, type SymbolInfo, type Timeframe } from '../../shared/types';
import type { MarketData } from './types';

/**
 * Synthetic prices so the app runs with no broker account. Prices are a deterministic function of
 * symbol and time, so reloading the chart shows the same history.
 */
export class DemoMarketData implements MarketData {
  readonly name = 'demo';

  constructor(private readonly now: () => number = Date.now) {}

  async getCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const tf = TIMEFRAME_SECONDS[timeframe];
    const nowSec = this.now() / 1000;
    const lastOpen = Math.floor(nowSec / tf) * tf;
    const step = Math.max(tf / 20, 15);
    const candles: Candle[] = [];
    for (let open = lastOpen - (count - 1) * tf; open <= lastOpen; open += tf) {
      const end = Math.min(open + tf, nowSec);
      let high = -Infinity;
      let low = Infinity;
      for (let t = open; t <= end; t += step) {
        const p = demoPrice(symbol, t);
        high = Math.max(high, p);
        low = Math.min(low, p);
      }
      const close = demoPrice(symbol, end);
      candles.push({
        time: open,
        open: demoPrice(symbol, open),
        high: Math.max(high, close),
        low: Math.min(low, close),
        close,
        volume: Math.round(200 + 800 * Math.abs(noise(hash(symbol), Math.floor(open / tf)))),
      });
    }
    return candles;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const now = this.now();
    const mid = demoPrice(symbol, now / 1000);
    const half = (pipSize(symbol) * 0.8) / 2;
    return { bid: mid - half, ask: mid + half, time: now };
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    return { symbol, digits: digitsFor(symbol) };
  }
}

export function digitsFor(symbol: string) {
  if (symbol.startsWith('XAU')) return 2;
  return symbol.endsWith('JPY') ? 3 : 5;
}

function pipSize(symbol: string) {
  if (symbol.startsWith('XAU')) return 0.1;
  return symbol.endsWith('JPY') ? 0.01 : 0.0001;
}

function basePrice(symbol: string) {
  if (symbol.startsWith('XAU')) return 2400;
  if (symbol.endsWith('JPY')) return 150;
  return 0.8 + (hash(symbol) % 600) / 1000;
}

function demoPrice(symbol: string, t: number) {
  const s = hash(symbol);
  const phase = (s % 1000) / 100;
  // A few slow waves for trend plus interpolated per-minute noise for texture.
  const minute = t / 60;
  const i = Math.floor(minute);
  const frac = minute - i;
  const jitter = noise(s, i) * (1 - frac) + noise(s, i + 1) * frac;
  const drift =
    0.004 * Math.sin(t / 86_400 + phase) +
    0.002 * Math.sin(t / 9_000 + 2 * phase) +
    0.0008 * Math.sin(t / 1_300 + 3 * phase) +
    0.0002 * jitter;
  return basePrice(symbol) * (1 + drift);
}

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic value in [-1, 1] for (seed, index). */
function noise(seed: number, index: number) {
  let x = Math.imul(seed ^ index, 2654435761) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 2246822519) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return (x / 0xffffffff) * 2 - 1;
}
