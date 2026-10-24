import './styles.css';
import { TIMEFRAMES, type Quote, type Timeframe } from '../shared/types';
import { api } from './api';
import { PriceChart } from './chart';
import { OrderTool } from './orderTool';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  symbolForm: $<HTMLFormElement>('symbol-form'),
  symbol: $<HTMLInputElement>('symbol'),
  timeframe: $<HTMLSelectElement>('timeframe'),
  lots: $<HTMLInputElement>('lots'),
  confirm: $<HTMLInputElement>('confirm'),
  newOrder: $<HTMLButtonElement>('new-order'),
  cancelOrders: $<HTMLButtonElement>('cancel-orders'),
  closePositions: $<HTMLButtonElement>('close-positions'),
  bid: $('bid'),
  ask: $('ask'),
  venue: $('venue'),
  status: $('status'),
  confirmActions: $('confirm-actions'),
  send: $<HTMLButtonElement>('send'),
  discard: $<HTMLButtonElement>('discard'),
};

const CANDLE_POLL_MS = 1000;
const ACCOUNT_POLL_MS = 3000;

// Remembered per browser; storage can be unavailable (private mode), so failures are ignored.
const prefs = {
  get: (key: string) => {
    try {
      return localStorage.getItem(`tv_charts.${key}`);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(`tv_charts.${key}`, value);
    } catch {
      /* ignore */
    }
  },
};

const state = {
  symbol: prefs.get('symbol') ?? 'EURUSD',
  timeframe: (prefs.get('timeframe') as Timeframe | null) ?? 'M5',
  digits: 5,
  quote: undefined as Quote | undefined,
  /** Bumped on every symbol/timeframe change so responses for the old chart are dropped. */
  generation: 0,
  ready: false,
};
if (!TIMEFRAMES.includes(state.timeframe)) state.timeframe = 'M5';

for (const tf of TIMEFRAMES) els.timeframe.add(new Option(tf, tf));
els.symbol.value = state.symbol;
els.timeframe.value = state.timeframe;
els.lots.value = prefs.get('lots') ?? els.lots.value;
els.confirm.checked = prefs.get('confirm') !== 'false';

function setStatus(message: string, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
}

const chart = new PriceChart($('chart'));
const tool = new OrderTool({
  chart,
  context: () => ({ symbol: state.symbol, digits: state.digits, lots: Number(els.lots.value) }),
  quote: () => state.quote,
  confirmFirst: () => els.confirm.checked,
  send: async (order) => {
    const result = await api.placeOrder(order);
    void refreshAccount();
    return result.message;
  },
  status: setStatus,
  onStep: (step) => {
    els.newOrder.classList.toggle('active', step !== 'idle');
    els.confirmActions.hidden = step !== 'confirm';
  },
});

async function loadChart() {
  const generation = ++state.generation;
  const { symbol, timeframe } = state;
  state.ready = false;
  state.quote = undefined;
  tool.cancel('Order cancelled: chart changed');
  document.title = `${symbol} ${timeframe}`;
  try {
    const [info, candles] = await Promise.all([api.symbol(symbol), api.candles(symbol, timeframe, 500)]);
    if (generation !== state.generation) return;
    state.digits = info.digits;
    chart.setSymbol(symbol, info.digits);
    chart.setData(candles);
    state.ready = true;
    void refreshAccount();
  } catch (err) {
    if (generation === state.generation) setStatus(`Could not load ${symbol}: ${(err as Error).message}`, true);
  }
}

/** One polling loop for the whole page: the next request starts only after the last one finished. */
async function pollCandles() {
  const generation = state.generation;
  if (state.ready) {
    try {
      const [candles, quote] = await Promise.all([
        api.candles(state.symbol, state.timeframe, 2),
        api.quote(state.symbol),
      ]);
      if (generation === state.generation && state.ready) {
        chart.update(candles);
        state.quote = quote;
        els.bid.textContent = quote.bid.toFixed(state.digits);
        els.ask.textContent = quote.ask.toFixed(state.digits);
      }
    } catch (err) {
      if (!tool.active) setStatus(`Price update failed: ${(err as Error).message}`, true);
    }
  }
  setTimeout(pollCandles, CANDLE_POLL_MS);
}

async function refreshAccount() {
  const generation = state.generation;
  try {
    const [orders, positions] = await Promise.all([api.orders(state.symbol), api.positions(state.symbol)]);
    if (generation === state.generation) chart.showAccount(orders, positions);
  } catch (err) {
    console.warn('account refresh failed', err);
  }
}

async function pollAccount() {
  if (state.ready) await refreshAccount();
  setTimeout(pollAccount, ACCOUNT_POLL_MS);
}

function changeChart() {
  const symbol = els.symbol.value.toUpperCase().replace(/[^A-Z0-9.]/g, '');
  if (!symbol) return;
  els.symbol.value = symbol;
  state.symbol = symbol;
  state.timeframe = els.timeframe.value as Timeframe;
  prefs.set('symbol', symbol);
  prefs.set('timeframe', state.timeframe);
  void loadChart();
}

async function accountAction(button: HTMLButtonElement, question: string, action: () => Promise<string>) {
  if (!confirm(question)) return;
  button.disabled = true;
  try {
    setStatus(await action());
    await refreshAccount();
  } catch (err) {
    setStatus((err as Error).message, true);
  } finally {
    button.disabled = false;
  }
}

els.symbolForm.addEventListener('submit', (e) => {
  e.preventDefault();
  changeChart();
});
els.symbol.addEventListener('change', changeChart);
els.timeframe.addEventListener('change', changeChart);
els.lots.addEventListener('change', () => prefs.set('lots', els.lots.value));
els.confirm.addEventListener('change', () => prefs.set('confirm', String(els.confirm.checked)));

els.newOrder.addEventListener('click', () => {
  if (!(Number(els.lots.value) > 0)) return setStatus('Enter a lot size first', true);
  if (tool.active) tool.cancel();
  else tool.start();
});
els.send.addEventListener('click', () => void tool.confirm());
els.discard.addEventListener('click', () => tool.cancel());

els.cancelOrders.addEventListener('click', () =>
  accountAction(els.cancelOrders, `Cancel all pending ${state.symbol} orders?`, async () => {
    const { cancelled } = await api.cancelOrders(state.symbol);
    return `Cancelled ${cancelled} pending ${state.symbol} order(s)`;
  }),
);
els.closePositions.addEventListener('click', () =>
  accountAction(els.closePositions, `Close all open ${state.symbol} positions at market?`, async () => {
    const { closed } = await api.closePositions(state.symbol);
    return `Closed ${closed} ${state.symbol} position(s)`;
  }),
);

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'Escape') tool.cancel();
  else if (e.key === 'Enter') void tool.confirm();
  else if (e.key.toLowerCase() === 'n' && !tool.active) els.newOrder.click();
});

api
  .info()
  .then((info) => {
    els.venue.textContent = `data: ${info.marketData} · orders: ${info.execution}`;
    if (info.live) {
      const badge = document.createElement('span');
      badge.className = 'live';
      badge.textContent = 'LIVE';
      els.venue.append(' ', badge);
    }
  })
  .catch(() => setStatus('Cannot reach the server. Is `npm run dev` running?', true));

void loadChart();
void pollCandles();
void pollAccount();
