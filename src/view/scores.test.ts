import { describe, expect, it } from 'vitest';

import { MAX_CLIENTS } from '../net/protocol';
import { parseScores } from './scores';

/** A `scores` command, as `Cmd_TokenizeString` splits one. */
function command(count: number, red: number, blue: number, rows: number[][]): string[] {
  return ['scores', String(count), String(red), String(blue), ...rows.flat().map(String)];
}

/** A row of fifteen numbers, with `over` spread over Q3's field order and the port's damage. */
function row(over: Partial<Record<number, number>> = {}): number[] {
  return Array.from({ length: 15 }, (_unused, i) => over[i] ?? 0);
}

describe('CG_ParseScores', () => {
  it("reads each row's fourteen numbers in Q3's order, and the damage given after them", () => {
    const fields = [3, 12, 87, 4, 0, 6, 45, 1, 2, 3, 4, 5, 1, 7, 640];
    const { numScores, scores } = parseScores(command(1, 0, 0, [fields]));

    expect(numScores).toBe(1);
    expect(scores[0]).toEqual({
      client: 3,
      score: 12,
      ping: 87,
      time: 4,
      scoreFlags: 0,
      powerups: 6,
      accuracy: 45,
      impressiveCount: 1,
      excellentCount: 2,
      gauntletCount: 3,
      defendCount: 4,
      assistCount: 5,
      perfect: 1,
      captures: 7,
      damage: 640
    });
  });

  it('keeps the two team scores above the rows', () => {
    const { teamScores } = parseScores(command(0, 7, 3, []));
    expect(teamScores).toEqual([7, 3]);
  });

  it('reads the second row at the second stride', () => {
    const { scores } = parseScores(
      command(2, 0, 0, [row({ 0: 1, 1: 5 }), row({ 0: 2, 1: 6 })])
    );

    // Q3's rows are fourteen numbers apart (`CG_Argv( i * 14 + … )`, `cg_servercmds.c:70–83`),
    // and the port's fifteen.
    expect(scores[1]).toMatchObject({ client: 2, score: 6 });
  });

  it('clears the rows the server left out', () => {
    const { scores } = parseScores(command(1, 0, 0, [row({ 1: 5 })]));

    // `memset( cg.scores, 0, sizeof( cg.scores ) )` (`cg_servercmds.c:66`): the list is as long as
    // the slots there are, and a row the server did not send reads as nothing.
    expect(scores).toHaveLength(MAX_CLIENTS);
    expect(scores[1].score).toBe(0);
    expect(scores[MAX_CLIENTS - 1].score).toBe(0);
  });

  it('reads no more rows than there are slots', () => {
    const rows = Array.from({ length: MAX_CLIENTS + 1 }, () => row());
    const { numScores } = parseScores(command(rows.length, 0, 0, rows));

    expect(numScores).toBe(MAX_CLIENTS);
  });

  it('reads a slot that is not one as the first', () => {
    const { scores } = parseScores(command(1, 0, 0, [row({ 0: 999, 1: 1 })]));

    expect(scores[0].client).toBe(0);
    expect(scores[0].score).toBe(1);
  });

  it('reads a bare command as no rows and no team scores', () => {
    const { numScores, teamScores, scores } = parseScores(['scores']);

    expect(numScores).toBe(0);
    expect(teamScores).toEqual([0, 0]);
    expect(scores).toHaveLength(MAX_CLIENTS);
  });
});
