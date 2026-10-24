/** Normalises user input like "eur/usd", "EUR_USD" or "eurusd" to "EURUSD". */
export function normalizeSymbol(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9.]/g, '');
}

/** EURUSD -> EUR_USD. Six-letter symbols are split 3/3; others need an explicit underscore. */
export function toOandaInstrument(symbol: string): string {
  if (symbol.includes('_')) return symbol;
  if (/^[A-Z]{6}$/.test(symbol)) return `${symbol.slice(0, 3)}_${symbol.slice(3)}`;
  return symbol;
}

export function fromOandaInstrument(instrument: string): string {
  return instrument.replace('_', '');
}
