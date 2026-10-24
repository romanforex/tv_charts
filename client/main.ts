import './styles.css';
import { TIMEFRAMES, TIMEFRAME_SECONDS, type Quote, type ReplayState, type Timeframe } from '../shared/types';
import { createApi, info, replayApi, type ReplayCommand } from './api';
import { PriceChart } from './chart';
import { OrderTool } from './orderTool';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  mode: $<HTMLSelectElement>('mode'),
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
  replayBar: $('replay-bar'),
  replayPlay: $<HTMLButtonElement>('replay-play'),
  replayStep: $<HTMLButtonElement>('replay-step'),
  replaySpeed: $<HTMLSelectElement>('replay-speed'),
  replayClock: $('replay-clock'),
  replaySeek: $<HTMLFormElement>('replay-seek'),
  replayDate: $<HTMLInputElement>('replay-date'),
  replayStats: $('replay-stats'),
};

// Prices arrive on the stream and move the newest candle; these refreshes pick up exact OHLC and
// volume from the source, and in replay the many bars that pass between ticks at high speed.
const LIVE_CANDLE_REFRESH_MS = 5000;
const REPLAY_CANDLE_REFRESH_MS = 250;
const PAUSED_REPLAY_CANDLE_REFRESH_MS = 2000;
const ACCOUNT_POLL_MS = 3000;
const REPLAY_ACCOUNT_POLL_MS = 1000;

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
  mode: (prefs.get('mode') === 'replay' ? 'replay' : 'live') as 'live' | 'replay',
  replay: undefined as ReplayState | undefined,
  symbol: prefs.get('symbol') ?? 'EURUSD',
  timeframe: (prefs.get('timeframe') as Timeframe | null) ?? 'M5',
  digits: 5,
  quote: undefined as Quote | undefined,
  /** Bumped on every symbol/timeframe change so responses for the old chart are dropped. */
  generation: 0,
  ready: false,
};
let stream: EventSource | undefined;
if (!TIMEFRAMES.includes(state.timeframe)) state.timeframe = 'M5';
let api = createApi(state.mode === 'replay' ? '/api/replay' : '/api');
const replaying = () => state.mode === 'replay' && !!state.replay?.playing;

for (const tf of TIMEFRAMES) els.timeframe.add(new Option(tf, tf));
els.symbol.value = state.symbol;
els.timeframe.value = state.timeframe;
els.lots.value = prefs.get('lots') ?? els.lots.value;
els.confirm.checked = prefs.get('confirm') !== 'false';
els.mode.value = state.mode;
els.replayBar.hidden = state.mode !== 'replay';

function setStatus(message: string, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
}

const chart = new PriceChart($('chart'));
// Clicking the chart takes focus off toolbar buttons, so Enter confirms the order instead of
// pressing whichever button was clicked last.
$('chart').addEventListener('pointerdown', () => (document.activeElement as HTMLElement | null)?.blur?.());
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
  stream?.close();
  stream = undefined;
  tool.cancel('Order cancelled: chart changed');
  document.title = `${symbol} ${timeframe}${state.mode === 'replay' ? ' (replay)' : ''}`;
  try {
    const [info, candles] = await Promise.all([api.symbol(symbol), api.candles(symbol, timeframe, 500)]);
    if (generation !== state.generation) return;
    state.digits = info.digits;
    chart.setSymbol(symbol, info.digits);
    chart.setData(candles);
    state.ready = true;
    openStream(generation);
    void refreshAccount();
  } catch (err) {
    if (generation === state.generation) setStatus(`Could not load ${symbol}: ${(err as Error).message}`, true);
  }
}

/** Live prices for the charted symbol. EventSource reconnects by itself if the connection drops. */
function openStream(generation: number) {
  const source = new EventSource(api.streamUrl(state.symbol));
  stream = source;
  source.onmessage = (e) => {
    if (generation !== state.generation) return;
    const event = JSON.parse(e.data) as { quote: Quote } | { error: string };
    if ('error' in event) {
      if (!tool.active) setStatus(`Price feed: ${event.error}`, true);
      return;
    }
    const { quote } = event;
    state.quote = quote;
    els.bid.textContent = quote.bid.toFixed(state.digits);
    els.ask.textContent = quote.ask.toFixed(state.digits);
    chart.applyPrice((quote.bid + quote.ask) / 2, quote.time / 1000, TIMEFRAME_SECONDS[state.timeframe]);
  };
}

/** One refresh loop for the whole page: the next request starts only after the last one finished. */
async function pollCandles() {
  const generation = state.generation;
  if (state.ready) {
    try {
      // In replay several bars can pass between refreshes; the chart skips the ones it already has.
      const candles = await api.candles(state.symbol, state.timeframe, state.mode === 'replay' ? 50 : 3);
      if (generation === state.generation && state.ready) chart.update(candles);
    } catch (err) {
      if (!tool.active) setStatus(`Chart update failed: ${(err as Error).message}`, true);
    }
  }
  const delay =
    state.mode === 'live'
      ? LIVE_CANDLE_REFRESH_MS
      : replaying()
        ? REPLAY_CANDLE_REFRESH_MS
        : PAUSED_REPLAY_CANDLE_REFRESH_MS;
  setTimeout(pollCandles, delay);
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
  setTimeout(pollAccount, replaying() ? REPLAY_ACCOUNT_POLL_MS : ACCOUNT_POLL_MS);
}

// --- Replay mode ---

function renderReplay(replay: ReplayState) {
  const previous = state.replay;
  state.replay = replay;
  els.replayPlay.textContent = replay.playing ? 'Pause' : 'Play';
  els.replaySpeed.value = String(replay.speed);
  els.replayClock.textContent = replay.time ? formatLocal(replay.time).replace('T', ' ') : 'No data';
  const { trades, wins, totalR, totalPips } = replay.stats;
  els.replayStats.textContent = trades
    ? `${trades} trades · ${Math.round((wins / trades) * 100)}% wins · ${signed(totalR)}R · ${signed(totalPips)} pips`
    : 'No closed trades yet';
  if (!replay.symbols.length) {
    setStatus('No replay data yet. Run: npm run download -- EURUSD --from 2025-01-01 (add --demo for synthetic data)', true);
  }
  // The clock went backwards (a jump): redraw the chart from scratch.
  if (previous && replay.time < previous.time) void loadChart();
}

async function replayCommand(cmd: ReplayCommand) {
  try {
    renderReplay(await replayApi.control(cmd));
  } catch (err) {
    setStatus((err as Error).message, true);
  }
}

async function pollReplay() {
  if (state.mode === 'replay') {
    try {
      renderReplay(await replayApi.state());
    } catch (err) {
      console.warn('replay state failed', err);
    }
  }
  setTimeout(pollReplay, 500);
}

async function setMode(mode: 'live' | 'replay') {
  if (mode === 'live' && state.replay?.playing) await replayCommand({ action: 'pause' });
  state.mode = mode;
  prefs.set('mode', mode);
  api = createApi(mode === 'replay' ? '/api/replay' : '/api');
  els.replayBar.hidden = mode !== 'replay';
  els.bid.textContent = els.ask.textContent = '-';
  if (mode === 'replay') {
    renderReplay(await replayApi.state());
    if (state.replay?.time) els.replayDate.value = formatLocal(state.replay.time);
  }
  void loadChart();
}

/** UNIX seconds to the `YYYY-MM-DDTHH:mm` local format used by datetime-local inputs. */
function formatLocal(time: number) {
  const d = new Date(time * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function signed(n: number) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
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

els.mode.addEventListener('change', () => void setMode(els.mode.value as 'live' | 'replay'));
els.replayPlay.addEventListener('click', () => replayCommand({ action: state.replay?.playing ? 'pause' : 'play' }));
els.replayStep.addEventListener('click', () =>
  replayCommand({ action: 'step', seconds: TIMEFRAME_SECONDS[state.timeframe] }),
);
els.replaySpeed.addEventListener('change', () => replayCommand({ action: 'speed', speed: Number(els.replaySpeed.value) }));
els.replaySeek.addEventListener('submit', async (e) => {
  e.preventDefault();
  const time = Math.floor(new Date(els.replayDate.value).getTime() / 1000);
  if (!time) return setStatus('Pick a date and time to jump to', true);
  const { stats } = state.replay ?? { stats: { trades: 0 } };
  if (stats.trades && !confirm('Jumping starts a fresh replay account. Continue?')) return;
  await replayCommand({ action: 'seek', time });
  setStatus(`Jumped to ${els.replayDate.value.replace('T', ' ')}; replay account reset`);
  void loadChart();
});

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
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
  // Space and Enter on a focused button press that button.
  if (t instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.key === ' ' && state.mode === 'replay') {
    e.preventDefault();
    els.replayPlay.click();
  } else if (e.key === 'Escape') tool.cancel();
  else if (e.key === 'Enter') void tool.confirm();
  else if (e.key.toLowerCase() === 'n' && !tool.active) els.newOrder.click();
});

info()
  .then((info) => {
    els.venue.textContent = `live data: ${info.marketData} · live orders: ${info.execution}`;
    if (info.live) {
      const badge = document.createElement('span');
      badge.className = 'live';
      badge.textContent = 'LIVE';
      els.venue.append(' ', badge);
    }
  })
  .catch(() => setStatus('Cannot reach the server. Is `npm run dev` running?', true));

void setMode(state.mode);
void pollCandles();
void pollAccount();
void pollReplay();
