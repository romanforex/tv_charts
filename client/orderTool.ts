import { LineStyle, type IPriceLine } from 'lightweight-charts';
import { pipSize, planOrder, roundToDigits, sideFromTakeProfit, stopLossError } from '../shared/orderPlan';
import type { PendingOrderRequest, Quote, Side } from '../shared/types';
import { COLORS, type PriceChart } from './chart';

type Step = 'idle' | 'entry' | 'takeProfit' | 'stopLoss' | 'confirm' | 'sending';

export interface OrderToolDeps {
  chart: PriceChart;
  /** Current symbol, its price precision and the lot size to trade. */
  context(): { symbol: string; digits: number; lots: number };
  quote(): Quote | undefined;
  confirmFirst(): boolean;
  send(order: PendingOrderRequest): Promise<string>;
  status(message: string, isError?: boolean): void;
  /** Called whenever the tool's step changes, so the UI can show buttons. */
  onStep(step: Step): void;
}

const PROMPTS: Partial<Record<Step, string>> = {
  entry: 'Click 1/3: entry price (Esc to cancel)',
  takeProfit: 'Click 2/3: take profit (above entry = buy, below = sell)',
  stopLoss: 'Click 3/3: stop loss',
};

/** Three clicks on the chart: entry, take profit, stop loss. Then confirm (optional) and send. */
export class OrderTool {
  private step: Step = 'idle';
  private entry?: number;
  private takeProfit?: number;
  private stopLoss?: number;
  private pending?: PendingOrderRequest;
  private lines: Partial<Record<'entry' | 'takeProfit' | 'stopLoss' | 'preview', IPriceLine>> = {};

  constructor(private readonly deps: OrderToolDeps) {
    const { chart } = deps;
    chart.onPriceClick((price) => this.click(price));
    chart.chart.subscribeCrosshairMove((param) => {
      const price = param.point ? chart.priceAtY(param.point.y) : null;
      this.hover(price);
    });
  }

  get active() {
    return this.step !== 'idle';
  }

  start() {
    if (this.step === 'sending') return;
    this.clear();
    this.setStep('entry');
  }

  cancel(message = 'Order cancelled') {
    if (this.step === 'idle' || this.step === 'sending') return;
    this.clear();
    this.setStep('idle');
    this.deps.status(message);
  }

  async confirm() {
    if (this.step !== 'confirm' || !this.pending) return;
    const order = this.pending;
    this.setStep('sending', `Sending ${describe(order)}...`);
    try {
      const message = await this.deps.send(order);
      this.clear();
      this.setStep('idle');
      this.deps.status(`${message}: ${describe(order)}`);
    } catch (err) {
      this.setStep('confirm');
      this.deps.status(`Order failed: ${(err as Error).message}`, true);
    }
  }

  private click(rawPrice: number) {
    const { digits } = this.deps.context();
    const price = roundToDigits(rawPrice, digits);
    const { chart } = this.deps;

    if (this.step === 'entry') {
      this.entry = price;
      this.lines.entry = chart.line({ price, color: COLORS.entry, lineWidth: 2, title: 'ENTRY' });
      this.setStep('takeProfit');
    } else if (this.step === 'takeProfit') {
      const side = sideFromTakeProfit(this.entry!, price);
      if (!side) return this.deps.status('Take profit cannot equal entry', true);
      this.takeProfit = price;
      this.lines.takeProfit = chart.line({ price, color: COLORS.takeProfit, lineWidth: 2, title: this.label('TP', price) });
      this.setStep('stopLoss', `Click 3/3: stop loss (${side === 'buy' ? 'below' : 'above'} entry)`);
    } else if (this.step === 'stopLoss') {
      const error = stopLossError(this.side!, this.entry!, price);
      if (error) return this.deps.status(error, true);
      this.stopLoss = price;
      this.lines.stopLoss = chart.line({ price, color: COLORS.stopLoss, lineWidth: 2, title: this.label('SL', price) });
      this.finish();
    }
  }

  private finish() {
    const quote = this.deps.quote();
    if (!quote) return this.cancel('No live quote yet; try again in a moment');
    const plan = planOrder(this.entry!, this.takeProfit!, this.stopLoss!, quote);
    if (!plan.ok) return this.cancel(plan.error);

    const { symbol, lots } = this.deps.context();
    this.pending = {
      symbol,
      lots,
      side: plan.side,
      kind: plan.kind,
      entry: this.entry!,
      takeProfit: this.takeProfit!,
      stopLoss: this.stopLoss!,
    };
    this.lines.entry?.applyOptions({ title: `${plan.side} ${plan.kind}`.toUpperCase() });
    this.removePreview();

    if (this.deps.confirmFirst()) {
      this.setStep('confirm', `${describe(this.pending)}, R:R ${plan.rewardRisk.toFixed(2)}. Send?`);
    } else {
      this.step = 'confirm';
      void this.confirm();
    }
  }

  private hover(price: number | null) {
    const prompt = this.step === 'entry' || this.step === 'takeProfit' || this.step === 'stopLoss';
    if (!prompt || price === null) return this.removePreview();
    const { digits } = this.deps.context();
    const rounded = roundToDigits(price, digits);
    const title = this.step === 'entry' ? 'ENTRY?' : this.label(this.step === 'takeProfit' ? 'TP?' : 'SL?', rounded);
    if (this.lines.preview) {
      this.lines.preview.applyOptions({ price: rounded, title });
    } else {
      this.lines.preview = this.deps.chart.line({ price: rounded, color: COLORS.preview, lineStyle: LineStyle.Dashed, title });
    }
  }

  private get side(): Side | null {
    return this.entry !== undefined && this.takeProfit !== undefined
      ? sideFromTakeProfit(this.entry, this.takeProfit)
      : null;
  }

  /** "TP +23.5 pips" style label relative to the entry. */
  private label(name: string, price: number) {
    if (this.entry === undefined) return name;
    const { digits } = this.deps.context();
    const pips = (price - this.entry) / pipSize(digits);
    return `${name} ${pips >= 0 ? '+' : ''}${pips.toFixed(1)}p`;
  }

  private removePreview() {
    this.deps.chart.removeLine(this.lines.preview);
    this.lines.preview = undefined;
  }

  private clear() {
    for (const line of Object.values(this.lines)) this.deps.chart.removeLine(line);
    this.lines = {};
    this.entry = this.takeProfit = this.stopLoss = undefined;
    this.pending = undefined;
  }

  private setStep(step: Step, message = PROMPTS[step]) {
    this.step = step;
    this.deps.onStep(step);
    if (message) this.deps.status(message);
  }
}

function describe(o: PendingOrderRequest) {
  return `${o.side} ${o.kind}`.toUpperCase() + ` ${o.lots} ${o.symbol} @ ${o.entry}, TP ${o.takeProfit}, SL ${o.stopLoss}`;
}
