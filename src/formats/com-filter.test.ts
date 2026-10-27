import { describe, expect, it } from 'vitest';

import { comFilter } from './com-filter';
import { FILTER_CASES, filterCorpus, runFilter, type FilterRun } from './com-filter-test-fixtures';

/**
 * The corpus over three seeds, 20000 pairs each, as ioquake3's own `Com_Filter`, compiled from its
 * C, matched it.
 */
const TWIN: Record<number, FilterRun> = {
  1: { matches: 5409, digest: '272bc1c4' },
  2: { matches: 5338, digest: '6e1593a5' },
  3: { matches: 5384, digest: '6be57df5' }
};

describe('comFilter', () => {
  it.each(FILTER_CASES)('matches %j against %j as ioquake3 does', (filter, name, matches) => {
    expect(comFilter(filter, name)).toBe(matches);
  });

  it.each([1, 2, 3])('runs seed %i as ioquake3 does', (seed) => {
    expect(runFilter(filterCorpus(seed, 20000))).toEqual(TWIN[seed]);
  });
});
