import { describe, expect, it } from 'vitest';

import { autoComplete } from './field-complete';
import {
  CASE_COMMANDS,
  CASE_CVARS,
  COMPLETE_CASES,
  completeCorpus,
  completeLines,
  runComplete,
  type CompleteLine,
  type CompleteRun
} from './field-complete-test-fixtures';

/**
 * The corpus over three seeds, 300 lines each, as ioquake3's own `Field_AutoComplete`, compiled
 * from its C, completed it: how many lines it changed and listed matches for, and the digest of
 * every line, cursor and print. The twin's cursor stepped past a full line twice in each, and was
 * digested at the line's end, where the port keeps it.
 */
const TWIN: Record<number, CompleteRun> = {
  1: { lines: 300, changed: 160, listed: 34, digest: '38f99b63' },
  2: { lines: 300, changed: 148, listed: 29, digest: '4e73d3a7' },
  3: { lines: 300, changed: 152, listed: 29, digest: 'b6b9bae6' }
};

/** A hand case's line, short enough to name its test. */
function named({ text, cursor, autochat }: CompleteLine): string {
  const word = text.trimStart();
  const lead = text.length - word.length;
  const shown = lead > 3 ? `${lead} spaces and ${JSON.stringify(word)}` : JSON.stringify(text);
  return `${shown} at ${cursor}, con_autochat ${autochat ? 'on' : 'off'}`;
}

describe('autoComplete', () => {
  it.each(COMPLETE_CASES.map(([line, ...answer]) => ({ name: named(line), line, answer })))(
    'completes $name as ioquake3 does',
    ({ line, answer }) => {
      const corpus = { commands: CASE_COMMANDS, cvars: CASE_CVARS, lines: [line] };
      expect(completeLines(corpus)).toEqual([answer]);
    }
  );

  it.each([1, 2, 3])('runs seed %i as ioquake3 does', (seed) => {
    expect(runComplete(completeCorpus(seed, 300))).toEqual(TWIN[seed]);
  });

  it("leaves the line's scroll as it was, and the line handed to it", () => {
    const line = { text: 'cmdl', cursor: 4, scroll: -3 };
    const names = { commands: ['cmdlist'], cvars: [] };
    expect(autoComplete(line, names, true, () => {})).toEqual({
      text: '\\cmdlist ',
      cursor: 9,
      scroll: -3
    });
    expect(line).toEqual({ text: 'cmdl', cursor: 4, scroll: -3 });
  });
});
