import type { Quote } from '../shared/types';
import type { Execution, MarketData } from './brokers/types';

export type FeedEvent = { quote: Quote } | { error: string };
type Listener = (event: FeedEvent) => void;
type QuoteSource = Pick<MarketData | Execution, 'getQuote' | 'streamQuotes'>;

const MAX_BACKOFF_MS = 30_000;

/**
 * Shares one price feed per symbol between all connected browsers. Uses the broker's push stream
 * when it has one (OANDA), otherwise polls `getQuote` once per interval no matter how many
 * listeners there are. Listeners only hear about prices that changed.
 */
export class QuoteHub {
  private listeners = new Map<string, Set<Listener>>();
  private latest = new Map<string, { quote: Quote; receivedAt: number }>();
  private polling = false;
  private stream?: AbortController;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private backoffMs = 1000;
  private closed = false;

  constructor(
    private readonly source: QuoteSource,
    private readonly opts: { pollMs: number; now?: () => number },
  ) {}

  /** Starts sending prices for `symbol` to `listener`. Returns an unsubscribe function. */
  subscribe(symbol: string, listener: Listener): () => void {
    let set = this.listeners.get(symbol);
    const isNew = !set;
    if (!set) this.listeners.set(symbol, (set = new Set()));
    set.add(listener);

    const cached = this.latest.get(symbol);
    if (cached) listener({ quote: cached.quote });
    else void this.fetchOnce(symbol);
    if (isNew) this.symbolsChanged();

    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(symbol) === set) {
        this.listeners.delete(symbol);
        this.latest.delete(symbol);
        this.symbolsChanged();
      }
    };
  }

  /** The last price received for `symbol`, if it is at most `maxAgeMs` old. */
  latestQuote(symbol: string, maxAgeMs: number): Quote | undefined {
    const entry = this.latest.get(symbol);
    return entry && this.now() - entry.receivedAt <= maxAgeMs ? entry.quote : undefined;
  }

  close() {
    this.closed = true;
    this.listeners.clear();
    this.stream?.abort();
    clearTimeout(this.restartTimer);
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private emit(symbol: string, quote: Quote) {
    const previous = this.latest.get(symbol)?.quote;
    this.latest.set(symbol, { quote, receivedAt: this.now() });
    if (previous && previous.bid === quote.bid && previous.ask === quote.ask) return;
    for (const listener of this.listeners.get(symbol) ?? []) listener({ quote });
  }

  private emitError(symbol: string, message: string) {
    for (const listener of this.listeners.get(symbol) ?? []) listener({ error: message });
  }

  private async fetchOnce(symbol: string) {
    try {
      this.emit(symbol, await this.source.getQuote(symbol));
    } catch (err) {
      this.emitError(symbol, (err as Error).message);
    }
  }

  private symbolsChanged() {
    if (this.closed) return;
    if (this.source.streamQuotes) {
      // Debounced: switching symbols unsubscribes and subscribes in quick succession.
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.restartStream(), 100);
    } else if (!this.polling && this.listeners.size) {
      void this.pollLoop();
    }
  }

  private async pollLoop() {
    this.polling = true;
    while (!this.closed && this.listeners.size) {
      await Promise.all([...this.listeners.keys()].map((s) => this.fetchOnce(s)));
      await new Promise((resolve) => setTimeout(resolve, this.opts.pollMs));
    }
    this.polling = false;
  }

  private restartStream() {
    this.stream?.abort();
    this.stream = undefined;
    const symbols = [...this.listeners.keys()];
    if (this.closed || !symbols.length) return;

    const controller = new AbortController();
    this.stream = controller;
    const onQuote = (symbol: string, quote: Quote) => {
      this.backoffMs = 1000;
      if (this.listeners.has(symbol)) this.emit(symbol, quote);
    };
    this.source.streamQuotes!(symbols, onQuote, controller.signal)
      .catch((err: Error) => {
        if (controller.signal.aborted) return;
        for (const s of symbols) this.emitError(s, `${err.message}; reconnecting`);
      })
      .finally(() => {
        // Ended on its own (not replaced or closed): reconnect with exponential backoff.
        if (controller.signal.aborted || this.stream !== controller) return;
        this.restartTimer = setTimeout(() => this.restartStream(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      });
  }
}
