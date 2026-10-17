import { describe, expect, it } from 'vitest';

import { GT, SCORE_NOT_PRESENT, TEAM } from '../sim/constants';
import { hudScores, SCORE_BOX_HEIGHT, SCORE_BOX_TOP, SCORES_Y, type ScoresInput } from './hud-scores';

/** The score area with nothing on it, unless a test says otherwise. */
function scores(over: Partial<ScoresInput> = {}): ReturnType<typeof hudScores> {
  return hudScores({
    gametype: GT.FFA,
    scores1: SCORE_NOT_PRESENT,
    scores2: SCORE_NOT_PRESENT,
    score: 0,
    team: TEAM.FREE,
    fraglimit: 0,
    capturelimit: 0,
    roundlimit: 0,
    redflag: -1,
    blueflag: -1,
    ...over
  });
}

/** The box and limit positions Q3's `CG_DrawScores` works out from the right edge. */
const row = { y: SCORE_BOX_TOP, h: SCORE_BOX_HEIGHT };

describe('CG_DrawScores', () => {
  it('puts the player in the right box when they are not first, red and framed', () => {
    const { boxes, limit } = scores({ scores1: 12, score: 9, fraglimit: 20 });

    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({
      rect: { x: 600, ...row, w: 40 },
      color: [1, 0, 0, 0.33],
      framed: true
    });
    expect(boxes[0].text).toMatchObject({ text: ' 9', x: 604, y: SCORES_Y, shadow: true });
    // The first place is grey, and not framed: it is not the player's box.
    expect(boxes[1]).toMatchObject({
      rect: { x: 560, ...row, w: 40 },
      color: [0.5, 0.5, 0.5, 0.33],
      framed: false
    });
    expect(boxes[1].text.text).toBe('12');
    // The frag limit, unboxed, to the left.
    expect(limit).toMatchObject({ text: '20', x: 524, y: SCORES_Y });
  });

  it('puts the player in the left box when they lead, blue and framed', () => {
    const { boxes } = scores({ scores1: 12, scores2: 5, score: 12 });

    // The right box is the second place, since the player's own is already the first.
    expect(boxes[0]).toMatchObject({ color: [0.5, 0.5, 0.5, 0.33], framed: false });
    expect(boxes[0].text.text).toBe(' 5');
    expect(boxes[1]).toMatchObject({ color: [0, 0, 1, 0.33], framed: true });
    expect(boxes[1].text.text).toBe('12');
  });

  it('shows a spectator the two scores, neither box their own', () => {
    const { boxes } = scores({ scores1: 12, score: 0, team: TEAM.SPECTATOR });

    expect(boxes.map((box) => box.framed)).toEqual([false, false]);
    expect(boxes.map((box) => box.text.text)).toEqual([' 0', '12']);
  });

  it('draws the player their own zero when the match has ranked nobody yet', () => {
    // "Always show your score in the second box if not in first place" (`cg_draw.c:1119–1122`):
    // with no first score at all, the player's own is the second box, red and framed.
    const { boxes, limit } = scores();

    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ color: [1, 0, 0, 0.33], framed: true });
    expect(boxes[0].text.text).toBe(' 0');
    expect(limit).toBeNull();
  });

  it('draws no box at all for a score that is not there', () => {
    const { boxes, limit } = scores({ score: SCORE_NOT_PRESENT });

    expect(boxes).toEqual([]);
    expect(limit).toBeNull();
  });

  it('reads the team half: blue rightmost, red next, the player’s team framed', () => {
    const { boxes, limit } = scores({
      gametype: GT.TEAM,
      scores1: 7,
      scores2: 3,
      team: TEAM.BLUE,
      fraglimit: 20
    });

    expect(boxes[0]).toMatchObject({ color: [0, 0, 1, 0.33], framed: true });
    expect(boxes[0].text.text).toBe(' 3');
    expect(boxes[1]).toMatchObject({ color: [1, 0, 0, 0.33], framed: false });
    expect(boxes[1].text.text).toBe(' 7');
    expect(limit?.text).toBe('20');
  });

  it('shows the capture limit in CTF and the frag limit in TDM', () => {
    const ctf = scores({ gametype: GT.CTF, scores1: 1, scores2: 2, capturelimit: 8, fraglimit: 20 });
    expect(ctf.limit?.text).toBe(' 8');

    const tdm = scores({ gametype: GT.TEAM, scores1: 1, scores2: 2, capturelimit: 8, fraglimit: 20 });
    expect(tdm.limit?.text).toBe('20');
  });

  it('shows the round limit in Clan Arena', () => {
    const ca = scores({ gametype: GT.CA, capturelimit: 8, fraglimit: 20, roundlimit: 5 });
    expect(ca.boxes).toHaveLength(2);
    expect(ca.limit?.text).toBe(' 5');
  });

  it('stands each flag over its own score box, a box-height up', () => {
    const { boxes } = scores({
      gametype: GT.CTF,
      scores1: 1,
      scores2: 2,
      redflag: 0,
      blueflag: 0
    });

    // Blue's box is the rightmost, and carries the blue flag.
    expect(boxes[0].flag).toEqual({
      rect: { x: boxes[0].rect.x, y: SCORE_BOX_TOP - SCORE_BOX_HEIGHT, w: boxes[0].rect.w, h: SCORE_BOX_HEIGHT },
      icon: 'icons/iconf_blu1'
    });
    expect(boxes[1].flag?.icon).toBe('icons/iconf_red1');
    expect(boxes[1].flag?.rect.x).toBe(boxes[1].rect.x);
  });

  it('draws the icon for where each flag is: at its base, taken, dropped', () => {
    const shown = (redflag: number, blueflag: number) =>
      scores({ gametype: GT.CTF, scores1: 1, scores2: 2, redflag, blueflag }).boxes.map(
        (box) => box.flag?.icon ?? null
      );

    expect(shown(0, 1)).toEqual(['icons/iconf_blu2', 'icons/iconf_red1']);
    expect(shown(2, 0)).toEqual(['icons/iconf_blu1', 'icons/iconf_red3']);
  });

  it('draws no flag for a status the match has not sent, nor one Q3 has no icon for', () => {
    // `cgs.redflag = cgs.blueflag = -1` until a string arrives, and the draw asks for `0..2`.
    const unset = scores({ gametype: GT.CTF, scores1: 1, scores2: 2 });
    expect(unset.boxes.map((box) => box.flag)).toEqual([null, null]);

    // One Flag CTF's `FLAG_TAKEN_RED` never reaches a CTF string, and would have no icon if it did.
    const odd = scores({ gametype: GT.CTF, scores1: 1, scores2: 2, redflag: 3, blueflag: 4 });
    expect(odd.boxes.map((box) => box.flag)).toEqual([null, null]);
  });

  it('draws no flag outside CTF, however the flags stand', () => {
    const tdm = scores({ gametype: GT.TEAM, scores1: 1, scores2: 2, redflag: 0, blueflag: 1 });
    expect(tdm.boxes.map((box) => box.flag)).toEqual([null, null]);

    const ffa = scores({ scores1: 5, score: 5, redflag: 0, blueflag: 0 });
    expect(ffa.boxes.every((box) => box.flag === null)).toBe(true);
  });

  it('measures a box by its digits, two places wide at least', () => {
    // `%2i` (`cg_draw.c:1061`): a one-digit score is padded, and a wider one takes more box.
    expect(scores({ scores1: 5, score: 5 }).boxes[0].text.text).toBe(' 5');
    expect(scores({ scores1: -1, score: -1 }).boxes[0].text.text).toBe('-1');
    expect(scores({ scores1: 100, score: 100 }).boxes[0].rect.w).toBe(56);
  });
});
