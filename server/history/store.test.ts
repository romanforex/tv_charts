import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BidAskBar } from '../../shared/types';
import { HistoryStore } from './store';

const bar = (time: number, p = 1.1): BidAskBar => ({
  time,
  bid: { o: p, h: p + 0.001, l: p - 0.001, c: p },
  ask: { o: p + 0.0001, h: p + 0.0011, l: p - 0.0009, c: p + 0.0001 },
  volume: 3,
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'history-'));
  dirs.push(dir);
  return new HistoryStore(dir);
}

describe('HistoryStore', () => {
  // 2025-01-31 23:58 UTC, spanning into February
  const t0 = Date.UTC(2025, 0, 31, 23, 58) / 1000;

  it('round-trips bars across month files and merges re-downloads', () => {
    const s = store();
    s.write('EURUSD', [bar(t0), bar(t0 + 60), bar(t0 + 120)], { digits: 5 });
    s.write('EURUSD', [bar(t0 + 120, 1.2), bar(t0 + 180)]);

    const fresh = new HistoryStore(s.dir); // no cache
    expect(fresh.symbols()).toEqual(['EURUSD']);
    expect(fresh.monthKeys('EURUSD')).toEqual(['2025-01', '2025-02']);
    expect(fresh.meta('EURUSD')).toEqual({ digits: 5 });
    const bars = fresh.bars('EURUSD', t0, t0 + 240);
    expect(bars.map((b) => b.time)).toEqual([t0, t0 + 60, t0 + 120, t0 + 180]);
    expect(bars[2].bid.o).toBe(1.2);
    expect(fresh.range('EURUSD')).toEqual({ from: t0, to: t0 + 240 });
  });

  it('finds bars around gaps', () => {
    const s = store();
    s.write('EURUSD', [bar(t0), bar(t0 + 3600)]);
    expect(s.barAt('EURUSD', t0 + 60)).toBeUndefined();
    expect(s.nextBarAt('EURUSD', t0 + 60)?.time).toBe(t0 + 3600);
    expect(s.lastBarBefore('EURUSD', t0 + 1800)?.time).toBe(t0);
  });
});
