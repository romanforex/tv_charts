import {
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  createTextWatermark,
  type CreatePriceLineOptions,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, PendingOrder, Position } from '../shared/types';

export const COLORS = {
  entry: '#2962ff',
  takeProfit: '#26a69a',
  stopLoss: '#ef5350',
  preview: '#787b86',
};

// lightweight-charts always renders UTC; shift timestamps so the axis shows local time.
const toChartTime = (t: number) => (t - new Date(t * 1000).getTimezoneOffset() * 60) as UTCTimestamp;

/** Candles + volume, plus price lines for the account's working orders and open positions. */
export class PriceChart {
  readonly chart: IChartApi;
  readonly candles: ISeriesApi<'Candlestick'>;
  private readonly volume: ISeriesApi<'Histogram'>;
  private readonly watermark;
  private lastTime = 0;
  private accountLines: IPriceLine[] = [];

  constructor(private readonly container: HTMLElement) {
    this.chart = createChart(container, {
      autoSize: true,
      layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1f2433' }, horzLines: { color: '#1f2433' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '', // overlay on its own hidden scale
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    this.watermark = createTextWatermark(this.chart.panes()[0], {
      horzAlign: 'center',
      vertAlign: 'center',
      lines: [],
    });
  }

  setSymbol(symbol: string, digits: number) {
    this.candles.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits } });
    this.watermark.applyOptions({ lines: [{ text: symbol, color: 'rgba(255, 255, 255, 0.05)', fontSize: 96 }] });
  }

  setData(candles: Candle[]) {
    this.candles.setData(candles.map((c) => ({ ...c, time: toChartTime(c.time) })));
    this.volume.setData(candles.map(volumeBar));
    this.lastTime = candles.at(-1)?.time ?? 0;
    this.chart.timeScale().scrollToRealTime();
  }

  /** Applies the latest bars. Bars older than the last one drawn are skipped (the chart can't update them). */
  update(candles: Candle[]) {
    for (const c of candles) {
      if (c.time < this.lastTime) continue;
      this.candles.update({ ...c, time: toChartTime(c.time) });
      this.volume.update(volumeBar(c));
      this.lastTime = c.time;
    }
  }

  /**
   * Calls `handler` with the price under each click in the plot area. Pans (drags) and clicks on
   * the axes are ignored. This uses DOM events rather than `chart.subscribeClick`, which drops a
   * second click made within 500ms of the first, and placing TP then SL quickly does exactly that.
   */
  onPriceClick(handler: (price: number) => void) {
    let down: { x: number; y: number } | undefined;
    this.container.addEventListener(
      'pointerdown',
      (e) => {
        down = e.button === 0 ? { x: e.clientX, y: e.clientY } : undefined;
      },
      true,
    );
    this.container.addEventListener(
      'pointerup',
      (e) => {
        if (!down || e.button !== 0) return;
        const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
        down = undefined;
        if (moved > 5) return;
        const rect = this.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const pane = this.chart.paneSize();
        if (x < 0 || y < 0 || x > pane.width || y > pane.height) return;
        const price = this.priceAtY(y);
        if (price !== null) handler(price);
      },
      true,
    );
  }

  priceAtY(y: number): number | null {
    return this.candles.coordinateToPrice(y);
  }

  line(options: CreatePriceLineOptions): IPriceLine {
    return this.candles.createPriceLine({ lineWidth: 1, axisLabelVisible: true, ...options });
  }

  removeLine(line: IPriceLine | undefined) {
    if (line) this.candles.removePriceLine(line);
  }

  showAccount(orders: PendingOrder[], positions: Position[]) {
    for (const l of this.accountLines) this.candles.removePriceLine(l);
    const dim = { lineStyle: LineStyle.Dotted, axisLabelVisible: false };
    this.accountLines = [
      ...orders.flatMap((o) => [
        this.line({
          price: o.entry,
          color: COLORS.entry,
          lineStyle: LineStyle.Dashed,
          title: `${o.side} ${o.kind} ${o.lots}`.toUpperCase(),
        }),
        ...(o.takeProfit ? [this.line({ ...dim, price: o.takeProfit, color: COLORS.takeProfit, title: 'TP' })] : []),
        ...(o.stopLoss ? [this.line({ ...dim, price: o.stopLoss, color: COLORS.stopLoss, title: 'SL' })] : []),
      ]),
      ...positions.flatMap((p) => [
        this.line({
          price: p.openPrice,
          color: p.profit >= 0 ? COLORS.takeProfit : COLORS.stopLoss,
          lineWidth: 2,
          title: `${p.side} ${p.lots} ${p.profit >= 0 ? '+' : ''}${p.profit.toFixed(2)}`.toUpperCase(),
        }),
        ...(p.takeProfit ? [this.line({ ...dim, price: p.takeProfit, color: COLORS.takeProfit, title: 'TP' })] : []),
        ...(p.stopLoss ? [this.line({ ...dim, price: p.stopLoss, color: COLORS.stopLoss, title: 'SL' })] : []),
      ]),
    ];
  }
}

function volumeBar(c: Candle) {
  return {
    time: toChartTime(c.time),
    value: c.volume,
    color: c.close >= c.open ? 'rgba(38, 166, 154, 0.4)' : 'rgba(239, 83, 80, 0.4)',
  };
}
