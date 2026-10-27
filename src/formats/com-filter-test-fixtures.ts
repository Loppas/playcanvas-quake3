import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { comFilter } from './com-filter';

/**
 * `comFilter`'s corpus: seeded filters and names, matched as the twin of ioquake3's own
 * `Com_Filter` matches them, each answer digested as the twin digests it. The twin reads the pairs
 * this writes ({@link filterInputs}).
 */

/** A filter and a name. */
export type FilterPair = readonly [filter: string, name: string];

/** A hand case: a filter, a name, and whether the twin matched them. */
export type FilterCase = readonly [filter: string, name: string, matches: boolean];

/** What a corpus came to: how many pairs matched, and the digest of every answer in order. */
export interface FilterRun {
  matches: number;
  digest: string;
}

/**
 * Hand cases, each with the twin's answer: the wildcards, a filter that runs out, sets and their
 * ranges, `[[` and `]]`, a set that never closes, and a `?` past the name's end.
 */
export const FILTER_CASES: readonly FilterCase[] = [
  ['', 'sensitivity', true],
  ['sens', 'sensitivity', true],
  ['SENS', 'sensitivity', true],
  ['sensitivity', 'sens', false],
  ['zz_*', 'zz_a', true],
  ['zz_?', 'zz_b', true],
  ['zz_[a-a]', 'zz_a', true],
  ['zz_[a-a]', 'zz_b', false],
  ['*fov', 'cg_fov', true],
  ['*FOV', 'cg_fov', true],
  ['*fov', 'cg_fovx', true],
  ['*fov*', 'cg_fov', true],
  ['cg_*_', 'cg_fov', false],
  ['*_*_*', 'r_ext_multitexture', true],
  ['r_[a-f]*', 'r_drawentities', true],
  ['r_[A-F]*', 'r_drawentities', true],
  ['r_[g-z]*', 'r_drawentities', false],
  ['[cr]_*', 'cg_fov', false],
  ['[cr]*', 'cg_fov', true],
  ['[c-]*', '-x', true],
  ['[-c]*', '-x', true],
  ['[a-]]x', ']x', true],
  ['[a-]]x', 'ax', true],
  ['[]]]x', ']x', true],
  ['[[x', '[x', false],
  ['[[x', 'x', true],
  ['[ab', 'b', true],
  ['[ab', 'c', false],
  ['a??', 'a', true],
  ['a??b', 'a', false],
  ['?', '', true],
  ['*', '', true],
  ['**a', 'ba', true],
  ['*?a', 'ba', true],
  ['*a?', 'ba', true],
  ['*[a]', 'ba', false],
  ['a*a', 'aa', true],
  ['a*a', 'a', false]
];

/** The characters a corpus is made of: names' letters, both cases, and the wildcards. */
const NAME_CHARS = 'abcAB_1';
const SET_CHARS = 'abcAB_1-]';

/** A filter: literals, `*`, `?`, sets with ranges, `[[`, and now and then a set left open. */
function filterText(pick: (n: number) => number): string {
  let text = '';
  const tokens = pick(7);
  for (let t = 0; t < tokens; t++) {
    const r = pick(100);
    if (r < 45) text += NAME_CHARS[pick(NAME_CHARS.length)];
    else if (r < 62) text += '*';
    else if (r < 74) text += '?';
    else if (r < 78) text += '[[';
    else {
      text += '[';
      const members = pick(4);
      for (let m = 0; m < members; m++) {
        text += SET_CHARS[pick(SET_CHARS.length)];
        if (pick(3) === 0) text += `-${SET_CHARS[pick(SET_CHARS.length)]}`;
      }
      if (pick(8) !== 0) text += ']';
    }
  }
  return text;
}

/** A name: 0 to 8 of {@link NAME_CHARS}. */
function nameText(pick: (n: number) => number): string {
  let text = '';
  const length = pick(9);
  for (let i = 0; i < length; i++) text += NAME_CHARS[pick(NAME_CHARS.length)];
  return text;
}

/** A corpus of `count` pairs from `seed`. */
export function filterCorpus(seed: number, count: number): FilterPair[] {
  const random = new Seeded(seed);
  // The high bits: the low ones cycle in a few draws.
  const pick = (n: number) => (random.next() >>> 8) % n;
  const pairs: FilterPair[] = [];
  for (let i = 0; i < count; i++) pairs.push([filterText(pick), nameText(pick)]);
  return pairs;
}

/**
 * The pairs as the twin reads them: their count, then each string's length as an int and its
 * bytes.
 */
export function filterInputs(pairs: readonly FilterPair[]): Uint8Array {
  const size = pairs.reduce((sum, [filter, name]) => sum + 8 + filter.length + name.length, 4);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, pairs.length, true);
  let at = 4;
  for (const text of pairs.flat()) {
    view.setInt32(at, text.length, true);
    at += 4;
    for (let i = 0; i < text.length; i++) bytes[at++] = text.charCodeAt(i);
  }
  return bytes;
}

/** The corpus through {@link comFilter}: each answer digested as an int, 1 or 0. */
export function runFilter(pairs: readonly FilterPair[]): FilterRun {
  const digest = new Digest();
  let matches = 0;
  for (const [filter, name] of pairs) {
    const matched = comFilter(filter, name);
    if (matched) matches++;
    digest.int(matched ? 1 : 0);
  }
  return { matches, digest: digest.hex() };
}
