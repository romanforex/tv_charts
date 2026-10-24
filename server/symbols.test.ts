import { describe, expect, it } from 'vitest';
import { fromOandaInstrument, normalizeSymbol, toOandaInstrument } from './symbols';

describe('symbols', () => {
  it('normalises user input', () => {
    expect(normalizeSymbol('eur/usd')).toBe('EURUSD');
    expect(normalizeSymbol('EUR_USD')).toBe('EURUSD');
    expect(normalizeSymbol(' gbpjpy ')).toBe('GBPJPY');
  });

  it('maps to and from OANDA instruments', () => {
    expect(toOandaInstrument('EURUSD')).toBe('EUR_USD');
    expect(toOandaInstrument('XAU_USD')).toBe('XAU_USD');
    expect(toOandaInstrument('BCOUSD')).toBe('BCO_USD');
    expect(toOandaInstrument('SPX500USD')).toBe('SPX500_USD');
    expect(fromOandaInstrument('USD_JPY')).toBe('USDJPY');
  });
});
