import './styles.css';
import { createChart, CrosshairMode } from 'lightweight-charts';

let granularity = 'M5';
let instrument = 'EUR_USD';
const accountId = '101-001-25168705-001';
const apiToken =
  '9743fe92a73ee8830980a39705187452-bf1959507d126880600ad7a6f8cde2b6';
const baseUrl = 'https://api-fxpractice.oanda.com/v3';

// Variables for take-profit, stop-loss and order type
let takeProfit;
let stopLoss;
let orderType;
let inProgress = false;

const clicks = [];
// Counter for clicks
let clickCount = 0;

// Create and append elements
const controlBox = document.createElement('div');
document.body.appendChild(controlBox);

const granularityInput = createAndAppendElement('input', controlBox, {
  id: 'granularity-input',
  type: 'text',
  value: 'M5',
});
const updateGranularityButton = createAndAppendElement('button', controlBox, {
  id: 'update-granularity-button',
  textContent: 'Update Granularity',
});

const instrumentInput = createAndAppendElement('input', controlBox, {
  id: 'instrument-input',
  type: 'text',
  value: 'EUR_USD',
});
const updateButton = createAndAppendElement('button', controlBox, {
  id: 'update-button',
  textContent: 'Update',
});

const volumeInput = createAndAppendElement('input', controlBox, {
  id: 'volume-input',
  type: 'number',
  value: '1',
});
const buyOrderButton = createAndAppendElement('button', controlBox, {
  id: 'buy-order-button',
  textContent: 'Market Buy Order',
});
const sellOrderButton = createAndAppendElement('button', controlBox, {
  id: 'sell-order-button',
  textContent: 'Market Sell Order',
});
const cancelOrderButton = createAndAppendElement('button', controlBox, {
  id: 'cancel-order-button',
  textContent: 'Cancel Order',
});
const closeOrderButton = createAndAppendElement('button', controlBox, {
  id: 'close-order-button',
  textContent: 'Close Order',
});

const chartContainer = document.createElement('div');
document.body.appendChild(chartContainer);

// Create chart and series
const chart = createChart(
  chartContainer,
  getChartOptions(instrumentInput.value)
);
const candleSeries = chart.addCandlestickSeries(getCandlestickSeriesOptions());
const volumeSeries = chart.addHistogramSeries(getHistogramSeriesOptions());

// Add click event listeners
updateGranularityButton.addEventListener('click', updateGranularity);
updateButton.addEventListener('click', updateInstrument);
buyOrderButton.addEventListener('click', startBuyOrder);
sellOrderButton.addEventListener('click', startSellOrder);
cancelOrderButton.addEventListener('click', cancelOrder);
closeOrderButton.addEventListener('click', closeOrder);

window.addEventListener('resize', resize, false);

// Fetch candles on load
fetchCandles();

// Function to create and append an element to the parent
function createAndAppendElement(type, parent, props) {
  const element = document.createElement(type);
  Object.assign(element, props);
  parent.appendChild(element);
  return element;
}

// Function to update granularity
function updateGranularity() {
  granularity = granularityInput.value;
  fetchCandles();
  updateTitle();
}

// Function to update instrument
function updateInstrument() {
  instrument = instrumentInput.value;
  chart.applyOptions(getChartOptions(instrument.replace('_', '')));
  fetchCandles();
  updateTitle();
}

// Function to start buy order
function startBuyOrder() {
  if (inProgress) {
    console.log('Order already in progress');
    return;
  }
  takeProfit = undefined;
  stopLoss = undefined;
  const orderType = 'buy';

  const initSpot = clicks.length;
  let currentSpot = clicks.length;

  const id = setInterval(() => {
    console.log('yo');
    console.log(clicks.length);
    if (!!takeProfit && !!stopLoss) {
      console.log(orderType);
      console.log(takeProfit);
      console.log(stopLoss);
      console.log(
        JSON.stringify({
          symbol: instrumentInput.value,
          volume: volumeInput.value,
          stop_loss: stopLoss,
          take_profit: takeProfit,
        })
      );
      // Sending request to the server
      fetch('http://localhost:3002/create_market_buy_order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          symbol: instrumentInput.value.replace('_', ''),
          volume: volumeInput.value,
          stop_loss: stopLoss,
          take_profit: takeProfit,
        }),
      })
        .then((response) => response.json())
        .then((data) => console.log(data))
        .catch((error) => {
          console.error('Error:', error);
        });

      clearInterval(id);
      console.log('done');
      return;
    }
    if (clicks.length > initSpot) {
      takeProfit = clicks[initSpot];
      console.log(takeProfit);
      if (clicks.length > initSpot + 1) {
        stopLoss = clicks[initSpot + 1];
        console.log(stopLoss);
      }
    }
  }, 300);
}

// Function to start sell order
function startSellOrder() {
  if (inProgress) {
    console.log('Order already in progress');
    return;
  }
  takeProfit = undefined;
  stopLoss = undefined;
  const orderType = 'buy';

  const initSpot = clicks.length;
  let currentSpot = clicks.length;

  const id = setInterval(() => {
    console.log('yo');
    console.log(clicks.length);
    if (!!takeProfit && !!stopLoss) {
      console.log(orderType);
      console.log(takeProfit);
      console.log(stopLoss);
      console.log(
        JSON.stringify({
          symbol: instrumentInput.value,
          volume: volumeInput.value,
          stop_loss: stopLoss,
          take_profit: takeProfit,
        })
      );
      // Sending request to the server
      fetch('http://localhost:3002/create_market_sell_order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          symbol: instrumentInput.value.replace('_', ''),
          volume: volumeInput.value,
          stop_loss: stopLoss,
          take_profit: takeProfit,
        }),
      })
        .then((response) => response.json())
        .then((data) => console.log(data))
        .catch((error) => {
          console.error('Error:', error);
        });

      clearInterval(id);
      console.log('done');
      return;
    }
    if (clicks.length > initSpot) {
      takeProfit = clicks[initSpot];
      console.log(takeProfit);
      if (clicks.length > initSpot + 1) {
        stopLoss = clicks[initSpot + 1];
        console.log(stopLoss);
      }
    }
  }, 300);
}

// Function to cancel order
function closeOrder() {
  fetch('http://localhost:3002/close_positions_by_symbol', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      symbol: instrumentInput.value.replace('_', ''),
    }),
  })
    .then((response) => response.json())
    .then((data) => console.log(data))
    .catch((error) => {
      console.error('Error:', error);
    });
  console.log('Current order has been closed.');
}

// Function to cancel order
function cancelOrder() {
  resetOrder();
  console.log('Current order has been cancelled.');
}

// Function to reset order
function resetOrder() {
  clickCount = 0;
  takeProfit = undefined;
  stopLoss = undefined;
  orderType = undefined;
}

// Function to resize the chart
function resize() {
  chart.applyOptions({ width: window.innerWidth, height: window.innerHeight });
  setTimeout(() => chart.timeScale().fitContent(), 0);
}

// Function to fetch candles
function fetchCandles() {
  const url = `${baseUrl}/accounts/${accountId}/instruments/${instrument}/candles?granularity=${granularity}`;

  fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  })
    .then((response) => response.json())
    .then((data) => {
      const bars = data.candles.map((candle) => getBarData(candle));
      candleSeries.setData(bars);
      volumeSeries.setData(bars);
      setTimeout(fetchCandles, 300);
    })
    .catch(console.error);
}

// Function to get bar data
function getBarData(candle) {
  return {
    time: Math.floor(new Date(candle.time).getTime() / 1000),
    open: parseFloat(candle.mid.o),
    high: parseFloat(candle.mid.h),
    low: parseFloat(candle.mid.l),
    close: parseFloat(candle.mid.c),
    volume: parseFloat(candle.volume),
  };
}

// Function to update the document title
function updateTitle() {
  document.title = `${instrument.replace('_', '')} - ${granularity}`;
}

// Function to get chart options
function getChartOptions(text) {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    layout: { backgroundColor: '#253248' },
    grid: {
      vertLines: { color: '#334158' },
      horzLines: { color: '#334158' },
    },
    crosshair: { mode: CrosshairMode.Normal },
    priceScale: { borderColor: '#485c7b' },
    timeScale: { borderColor: '#485158' },
    watermark: {
      text: text,
      fontSize: 256,
      color: 'rgba(256, 256, 256, 0.1)',
      visible: true,
    },
  };
}

// Function to get candlestick series options
function getCandlestickSeriesOptions() {
  return {
    upColor: '#4bffb5',
    downColor: '#ff4976',
    borderDownColor: '#ff4976',
    borderUpColor: '#4bffb5',
    wickDownColor: '#838ca1',
    wickUpColor: '#838ca1',

    priceFormat: {
      type: 'price',
      precision: 6,
      minMove: 0.000001,
    },
  };
}

// Function to get histogram series options
function getHistogramSeriesOptions() {
  return {
    color: '#385263',
    lineWidth: 2,
    priceFormat: { type: 'volume' },
    overlay: true,
    scaleMargins: { top: 0.9, bottom: 0 },
  };
}

// Subscribe to click events on the chart
chart.subscribeClick((param) => {
  clicks.push(candleSeries.coordinateToPrice(param.point.y));
  console.log(clicks);
});

// Initialize data fetching
fetchCandles();

// Event listeners
window.addEventListener('resize', resize, false);
updateGranularityButton.addEventListener('click', updateGranularity);
updateButton.addEventListener('click', updateInstrument);
buyOrderButton.addEventListener('click', startBuyOrder);
sellOrderButton.addEventListener('click', startSellOrder);
cancelOrderButton.addEventListener('click', cancelOrder);
