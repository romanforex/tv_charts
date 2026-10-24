/** Normalises user input like "eur/usd", "EUR_USD" or "eurusd" to "EURUSD". */
export function normalizeSymbol(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9.]/g, '');
}

/**
 * EURUSD -> EUR_USD, BCOUSD -> BCO_USD, SPX500USD -> SPX500_USD: OANDA instruments end in a
 * three-letter currency, so the underscore goes before the last three letters.
 */
export function toOandaInstrument(symbol: string): string {
  if (symbol.includes('_')) return symbol;
  if (/^[A-Z0-9]+[A-Z]{3}$/.test(symbol)) return `${symbol.slice(0, -3)}_${symbol.slice(-3)}`;
  return symbol;
}

export function fromOandaInstrument(instrument: string): string {
  return instrument.replace('_', '');
}
