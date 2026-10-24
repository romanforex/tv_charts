import { describe, expect, it } from 'vitest';
import { planOrder, roundToDigits } from './orderPlan';

const quote = { bid: 1.1, ask: 1.1002, time: 0 };

describe('planOrder', () => {
  it('buy limit: entry below ask, TP above, SL below', () => {
    expect(planOrder(1.095, 1.105, 1.09, quote)).toMatchObject({ ok: true, side: 'buy', kind: 'limit' });
  });

  it('buy stop: entry above ask', () => {
    expect(planOrder(1.102, 1.11, 1.099, quote)).toMatchObject({ ok: true, side: 'buy', kind: 'stop' });
  });

  it('sell limit: entry above bid, TP below', () => {
    expect(planOrder(1.105, 1.095, 1.11, quote)).toMatchObject({ ok: true, side: 'sell', kind: 'limit' });
  });

  it('sell stop: entry below bid', () => {
    expect(planOrder(1.098, 1.09, 1.1, quote)).toMatchObject({ ok: true, side: 'sell', kind: 'stop' });
  });

  it('computes reward to risk', () => {
    const plan = planOrder(1.095, 1.105, 1.09, quote);
    expect(plan.ok && plan.rewardRisk).toBeCloseTo(2);
  });

  it('rejects a stop loss on the wrong side', () => {
    expect(planOrder(1.095, 1.105, 1.096, quote)).toMatchObject({ ok: false });
    expect(planOrder(1.105, 1.095, 1.104, quote)).toMatchObject({ ok: false });
  });

  it('rejects TP equal to entry and entry at market', () => {
    expect(planOrder(1.095, 1.095, 1.09, quote)).toMatchObject({ ok: false });
    expect(planOrder(1.1002, 1.11, 1.09, quote)).toMatchObject({ ok: false });
  });
});

describe('roundToDigits', () => {
  it('rounds to the instrument precision', () => {
    expect(roundToDigits(1.0851234, 5)).toBe(1.08512);
    expect(roundToDigits(151.23456, 3)).toBe(151.235);
  });
});
