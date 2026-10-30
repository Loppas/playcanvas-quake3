import { describe, expect, it } from 'vitest';

import { autoComplete } from './field-complete';
import {
  ARGUMENT_CASES,
  ARGUMENT_NAMES,
  CASE_NAMES,
  COMPLETE_CASES,
  ONE_PLAYER_CASES,
  ONE_PLAYER_NAMES,
  argumentCorpus,
  completeCorpus,
  completeLines,
  runComplete,
  type CompleteCase,
  type CompleteLine,
  type CompleteNames,
  type CompleteRun
} from './field-complete-test-fixtures';

/**
 * The command corpus over three seeds, 300 lines each, as ioquake3's own `Field_AutoComplete`,
 * compiled from its C, completed it: how many lines it changed and listed matches for, and the
 * digest of every line, cursor and print. The twin's cursor stepped past a full line twice in
 * each, and was digested at the line's end, where the port keeps it.
 */
const TWIN: Record<number, CompleteRun> = {
  1: { lines: 300, changed: 160, listed: 34, digest: '38f99b63' },
  2: { lines: 300, changed: 148, listed: 29, digest: '4e73d3a7' },
  3: { lines: 300, changed: 152, listed: 29, digest: 'b6b9bae6' }
};

/**
 * The argument corpus over five seeds, 300 lines each, as the twin, with ioquake3's completers,
 * completed it. Its cursor stepped past a full line twice in the second seed and once in the
 * fourth and fifth.
 */
const ARGUMENT_TWIN: Record<number, CompleteRun> = {
  1: { lines: 300, changed: 148, listed: 25, digest: '56cbb7ad' },
  2: { lines: 300, changed: 140, listed: 27, digest: 'd6e04e4d' },
  3: { lines: 300, changed: 139, listed: 20, digest: '225915a4' },
  4: { lines: 300, changed: 150, listed: 20, digest: '5b4e8f0d' },
  5: { lines: 300, changed: 143, listed: 21, digest: 'abedc196' }
};

/** A hand case's line, short enough to name its test. */
function named({ text, cursor, autochat }: CompleteLine): string {
  const word = text.trimStart();
  const lead = text.length - word.length;
  const shown = lead > 3 ? `${lead} spaces and ${JSON.stringify(word)}` : JSON.stringify(text);
  return `${shown} at ${cursor}, con_autochat ${autochat ? 'on' : 'off'}`;
}

/** Hand cases as `it.each` takes them, over their names. */
const each = (cases: readonly CompleteCase[], names: CompleteNames) =>
  cases.map(([line, ...answer]) => ({ name: named(line), line, answer, names }));

describe('autoComplete', () => {
  it.each(each(COMPLETE_CASES, CASE_NAMES))(
    'completes $name as ioquake3 does',
    async ({ line, answer, names }) => {
      expect(await completeLines({ ...names, lines: [line] })).toEqual([answer]);
    }
  );

  const argumentCases = [
    ...each(ARGUMENT_CASES, ARGUMENT_NAMES),
    ...each(ONE_PLAYER_CASES, ONE_PLAYER_NAMES)
  ];
  it.each(argumentCases)(
    "completes $name's argument as ioquake3 does",
    async ({ line, answer, names }) => {
      expect(await completeLines({ ...names, lines: [line] })).toEqual([answer]);
    }
  );

  it.each([1, 2, 3])('runs command seed %i as ioquake3 does', async (seed) => {
    expect(await runComplete(completeCorpus(seed, 300))).toEqual(TWIN[seed]);
  });

  it.each([1, 2, 3, 4, 5])('runs argument seed %i as ioquake3 does', async (seed) => {
    expect(await runComplete(argumentCorpus(seed, 300))).toEqual(ARGUMENT_TWIN[seed]);
  });

  it("leaves the line's scroll as it was, and the line handed to it", async () => {
    const line = { text: 'cmdl', cursor: 4, scroll: -3 };
    const names = { commands: ['cmdlist'], cvars: [], completer: () => undefined };
    expect(await autoComplete(line, names, true, () => {})).toEqual({
      text: '\\cmdlist ',
      cursor: 9,
      scroll: -3
    });
    expect(line).toEqual({ text: 'cmdl', cursor: 4, scroll: -3 });
  });
});
