import { describe, expect, it } from 'vitest';
import { mapConcurrent } from './concurrency';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapConcurrent', () => {
  it('keeps input order whatever order the calls finish in', async () => {
    const out = await mapConcurrent([30, 10, 20], 3, async (ms, i) => {
      await sleep(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:10', '2:20']);
  });

  it('never has more than the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      peak = Math.max(peak, ++inFlight);
      await sleep(1);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it('maps an empty list to an empty list', async () => {
    expect(await mapConcurrent([], 8, async () => 1)).toEqual([]);
  });

  it('rejects with the first rejection', async () => {
    await expect(
      mapConcurrent([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('two');
        return n;
      })
    ).rejects.toThrow('two');
  });
});
