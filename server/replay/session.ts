import {
  TIMEFRAME_SECONDS,
  type BidAskBar,
  type Candle,
  type ClosedTrade,
  type OrderResult,
  type PendingOrder,
  type PendingOrderRequest,
  type Position,
  type Quote,
  type ReplayState,
  type SymbolInfo,
  type Timeframe,
} from '../../shared/types';
import { BrokerError, type Execution, type MarketData } from '../brokers/types';
import type { HistoryStore } from '../history/store';
import { SimAccount } from '../sim/account';

const TICK_MS = 250;

/**
 * Plays downloaded history as if it were live. Acts as both the market data source (candles are
 * cut off at the simulated clock, with the current minute partly formed) and the execution venue
 * (a SimAccount fed each completed one-minute bar).
 */
export class ReplaySession implements MarketData, Execution {
  readonly name = 'replay';
  readonly live = false;
  time = 0;
  speed = 60;
  playing = false;
  private account = new SimAccount();
  /** Per symbol: bars before this time have been fed to the account. */
  private processedUntil = new Map<string, number>();
  /** The charted symbol. Its market-closed gaps (weekends) are skipped while playing. */
  private focus?: string;
  private timer?: ReturnType<typeof setInterval>;
  private monthCandles = new Map<string, Candle[]>();

  constructor(private readonly store: HistoryStore) {}

  state(): ReplayState {
    this.ensureStarted();
    const symbols = this.store.symbols().flatMap((symbol) => {
      const range = this.store.range(symbol);
      return range ? [{ symbol, ...range }] : [];
    });
    return { time: this.time, speed: this.speed, playing: this.playing, symbols, stats: this.account.stats() };
  }

  trades(): ClosedTrade[] {
    return this.account.trades;
  }

  play() {
    this.ensureStarted();
    if (this.playing) return;
    this.playing = true;
    this.timer = setInterval(() => this.advance((this.speed * TICK_MS) / 1000), TICK_MS);
    this.timer.unref?.();
  }

  pause() {
    this.playing = false;
    clearInterval(this.timer);
  }

  setSpeed(speed: number) {
    this.speed = speed;
  }

  /** Jumps to `time` with a fresh account: orders can't be carried across a jump. */
  seek(time: number) {
    this.time = time;
    this.account = new SimAccount();
    this.processedUntil.clear();
  }

  /** Moves the clock forward, skipping market-closed gaps in the charted symbol. */
  advance(seconds: number) {
    this.ensureStarted();
    let target = this.time + seconds;
    if (this.focus) {
      const minute = Math.floor(target / 60) * 60;
      if (!this.store.barAt(this.focus, minute)) {
        const next = this.store.nextBarAt(this.focus, minute);
        if (!next) {
          // End of the downloaded data.
          const range = this.store.range(this.focus);
          target = Math.max(this.time, range?.to ?? this.time);
          this.pause();
        } else if (next.time > target) {
          target = next.time;
        }
      }
    }
    this.advanceTo(target);
  }

  advanceTo(time: number) {
    const completeUntil = Math.floor(time / 60) * 60;
    for (const symbol of this.account.activeSymbols()) {
      const from = this.processedUntil.get(symbol) ?? completeUntil;
      for (const bar of this.store.bars(symbol, from, completeUntil)) this.account.onBar(symbol, bar);
      this.processedUntil.set(symbol, completeUntil);
    }
    this.time = Math.max(this.time, time);
  }

  // --- MarketData ---

  async getCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    this.requireData(symbol);
    this.ensureStarted();
    this.focus = symbol;
    const tf = TIMEFRAME_SECONDS[timeframe];
    const minute = Math.floor(this.time / 60) * 60;
    const currentMonth = new Date(minute * 1000).toISOString().slice(0, 7);

    // Walk back month by month until there are enough candles. Past months are cached.
    const chunks: Candle[][] = [];
    let total = 0;
    for (const key of this.store.monthKeys(symbol).filter((k) => k <= currentMonth).reverse()) {
      let candles: Candle[];
      if (key === currentMonth) {
        const bars = this.store.month(symbol, key).filter((b) => b.time < minute);
        const current = this.store.barAt(symbol, minute);
        if (current) bars.push(partialBar(current, (this.time - minute) / 60));
        candles = aggregate(bars, tf);
      } else {
        const cacheKey = `${symbol}|${tf}|${key}`;
        candles = this.monthCandles.get(cacheKey) ?? aggregate(this.store.month(symbol, key), tf);
        this.monthCandles.set(cacheKey, candles);
      }
      chunks.unshift(candles);
      total += candles.length;
      if (total >= count) break;
    }
    return mergeBoundary(chunks.flat()).slice(-count);
  }

  async getQuote(symbol: string): Promise<Quote> {
    this.requireData(symbol);
    const minute = Math.floor(this.time / 60) * 60;
    const current = this.store.barAt(symbol, minute);
    const bar = current ? partialBar(current, (this.time - minute) / 60) : this.store.lastBarBefore(symbol, minute);
    if (!bar) throw new BrokerError(`No ${symbol} data at this replay time`, 404);
    return { bid: bar.bid.c, ask: bar.ask.c, time: this.time * 1000 };
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    this.requireData(symbol);
    return { symbol, digits: this.store.meta(symbol).digits };
  }

  // --- Execution ---

  async placePendingOrder(order: PendingOrderRequest): Promise<OrderResult> {
    const { digits } = await this.getSymbolInfo(order.symbol);
    if (!this.account.activeSymbols().has(order.symbol)) {
      this.processedUntil.set(order.symbol, Math.ceil(this.time / 60) * 60);
    }
    const id = this.account.place(order, digits, this.time);
    return { id, message: `Replay order ${id} created` };
  }

  async listPendingOrders(symbol?: string): Promise<PendingOrder[]> {
    return this.account.listOrders(symbol);
  }

  async listPositions(symbol?: string): Promise<Position[]> {
    for (const s of this.account.activeSymbols()) {
      if (!symbol || s === symbol) this.account.markToMarket(s, await this.getQuote(s));
    }
    return this.account.listPositions(symbol);
  }

  async cancelPendingOrders(symbol: string): Promise<number> {
    return this.account.cancel(symbol);
  }

  async closePositions(symbol: string): Promise<number> {
    return this.account.closeAtMarket(symbol, await this.getQuote(symbol), this.time);
  }

  private requireData(symbol: string) {
    if (!this.store.has(symbol)) {
      throw new BrokerError(
        `No downloaded data for ${symbol}. Run: npm run download -- ${symbol} --from YYYY-MM-DD`,
        404,
      );
    }
  }

  /** Starts two weeks before the end of the first symbol's data, so there's history to look at. */
  private ensureStarted() {
    if (this.time) return;
    const first = this.store.symbols()[0];
    const range = first ? this.store.range(first) : null;
    if (range) this.time = Math.max(range.from + 86_400, range.to - 14 * 86_400);
  }
}

/**
 * The first `fraction` of a one-minute bar. The path within the minute is assumed to be
 * open -> low -> high -> close for up bars and open -> high -> low -> close for down bars.
 * Display only: fills are decided on completed bars by SimAccount.
 */
export function partialBar(bar: BidAskBar, fraction: number): BidAskBar {
  const side = (p: BidAskBar['bid']) => {
    const path = p.c >= p.o ? [p.o, p.l, p.h, p.c] : [p.o, p.h, p.l, p.c];
    const pos = Math.min(Math.max(fraction, 0), 1) * 3;
    const i = Math.min(Math.floor(pos), 2);
    const now = path[i] + (path[i + 1] - path[i]) * (pos - i);
    const seen = [...path.slice(0, i + 1), now];
    return { o: p.o, h: Math.max(...seen), l: Math.min(...seen), c: now };
  };
  return { time: bar.time, bid: side(bar.bid), ask: side(bar.ask), volume: Math.round(bar.volume * fraction) };
}

/** Mid-price candles of `tf` seconds from one-minute bid/ask bars. */
export function aggregate(bars: BidAskBar[], tf: number): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const time = Math.floor(b.time / tf) * tf;
    const o = (b.bid.o + b.ask.o) / 2;
    const h = (b.bid.h + b.ask.h) / 2;
    const l = (b.bid.l + b.ask.l) / 2;
    const c = (b.bid.c + b.ask.c) / 2;
    const last = out.at(-1);
    if (last?.time === time) {
      last.high = Math.max(last.high, h);
      last.low = Math.min(last.low, l);
      last.close = c;
      last.volume += b.volume;
    } else {
      out.push({ time, open: o, high: h, low: l, close: c, volume: b.volume });
    }
  }
  return out;
}

/** Joins candles that straddle a month boundary (only possible for timeframes over a day). */
function mergeBoundary(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const last = out.at(-1);
    if (last?.time === c.time) {
      out[out.length - 1] = {
        time: c.time,
        open: last.open,
        high: Math.max(last.high, c.high),
        low: Math.min(last.low, c.low),
        close: c.close,
        volume: last.volume + c.volume,
      };
    } else {
      out.push({ ...c });
    }
  }
  return out;
}
