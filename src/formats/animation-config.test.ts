import { describe, expect, it } from 'vitest';
import { havePak, havePak0, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { ANIM } from '../sim/animations';
import { parseAnimationConfig, type Animation, type AnimationConfig } from './animation-config';
import { listPlayerModels } from './asset-manifest';
import { parseMd3 } from './md3';

/**
 * A made-up table in the retail layout: deaths, then the torso, then the legs, numbered as one
 * sequence. The legs start at 73 in the file and the gesture at 30, so the skip is 43. `LEGS_BACK`
 * plays backwards, and `LEGS_TURN` names 0 fps.
 */
const ROWS: readonly (readonly [number, number, number, number])[] = [
  [0, 10, 0, 20],
  [9, 1, 0, 20],
  [10, 10, 0, 20],
  [19, 1, 0, 20],
  [20, 10, 0, 20],
  [29, 1, 0, 20],
  [30, 20, 0, 18], // TORSO_GESTURE
  [50, 6, 0, 15],
  [56, 6, 0, 15],
  [62, 5, 0, 20],
  [67, 4, 0, 20],
  [71, 1, 0, 15],
  [72, 1, 0, 15], // TORSO_STAND2
  [73, 8, 8, 20], // LEGS_WALKCR
  [81, 12, 12, 20],
  [93, 11, 11, 21],
  [104, -10, 10, 20], // LEGS_BACK
  [114, 10, 10, 15],
  [124, 10, 0, 18],
  [134, 6, 0, 20],
  [140, 8, 0, 15],
  [148, 1, 0, 15],
  [149, 10, 10, 15],
  [159, 8, 8, 15],
  [167, 7, 7, 0] // LEGS_TURN
];

/** The file's text: a header, then the rows, each with the comment the retail files carry. */
function config(header = 'sex m', rows: readonly (readonly number[])[] = ROWS): string {
  const lines = rows.map((row, i) => `${row.join('\t')}\t\t// row ${i}`);
  return `// animation config file\n\n${header}\n\n${lines.join('\n')}\n`;
}

/** Parse, failing the test on a refusal. */
function parsed(text: string, warnings: string[] = []): AnimationConfig {
  const result = parseAnimationConfig(text, 'test.cfg', (message) => warnings.push(message));
  if (!result) throw new Error(`refused: ${warnings.join('; ')}`);
  return result;
}

function row(
  firstFrame: number,
  numFrames: number,
  loopFrames: number,
  frameLerp: number,
  reversed = false
): Animation {
  return { firstFrame, numFrames, loopFrames, frameLerp, initialLerp: frameLerp, reversed, flipflop: false };
}

describe('parseAnimationConfig: the table', () => {
  it('takes the skip off every legs row, and only those', () => {
    const { animations } = parsed(config());
    expect(animations[ANIM.BOTH_DEATH1]).toEqual(row(0, 10, 0, 50));
    expect(animations[ANIM.TORSO_GESTURE].firstFrame).toBe(30);
    expect(animations[ANIM.TORSO_STAND2].firstFrame).toBe(72);
    // 73 − 43, and so on down to the turn: the legs sit straight after the deaths in lower.md3.
    expect(animations[ANIM.LEGS_WALKCR].firstFrame).toBe(30);
    expect(animations[ANIM.LEGS_IDLE].firstFrame).toBe(106);
    expect(animations[ANIM.LEGS_TURN].firstFrame).toBe(124);
  });

  it("keeps Q3's whole milliseconds: 1000 / fps truncated, and 0 fps taken as 1", () => {
    const { animations } = parsed(config());
    expect(animations[ANIM.TORSO_GESTURE].frameLerp).toBe(55); // 18 fps
    expect(animations[ANIM.LEGS_RUN].frameLerp).toBe(47); // 21 fps
    expect(animations[ANIM.TORSO_ATTACK]).toEqual(row(50, 6, 0, 66));
    expect(animations[ANIM.LEGS_TURN].frameLerp).toBe(1000);
  });

  it('plays a negative frame count backwards', () => {
    expect(parsed(config()).animations[ANIM.LEGS_BACK]).toEqual(row(61, 10, 10, 50, true));
  });

  it('fills the six Team Arena rows a file leaves out with the gesture, played forwards', () => {
    const rows = ROWS.map((r, i) => (i === ANIM.TORSO_GESTURE ? [30, -20, 0, 18] : r));
    const { animations } = parsed(config('sex m', rows));
    expect(animations[ANIM.TORSO_GESTURE].reversed).toBe(true);
    for (let i = ANIM.TORSO_GETFLAG; i <= ANIM.TORSO_NEGATIVE; i++) {
      expect(animations[i], String(i)).toEqual(row(30, 20, 0, 55));
    }
  });

  it('reads Team Arena rows a file has, without the skip', () => {
    const extra = Array.from({ length: 6 }, (_, i) => [200 + 10 * i, 5, 0, 10]);
    const { animations } = parsed(config('sex m', [...ROWS, ...extra]));
    expect(animations[ANIM.TORSO_GETFLAG]).toEqual(row(200, 5, 0, 100));
    expect(animations[ANIM.TORSO_NEGATIVE]).toEqual(row(250, 5, 0, 100));
  });

  it('derives walking and crouching backwards, and hard-codes the flag rows', () => {
    const { animations } = parsed(config());
    expect(animations[ANIM.LEGS_BACKCR]).toEqual({ ...animations[ANIM.LEGS_WALKCR], reversed: true });
    expect(animations[ANIM.LEGS_BACKWALK]).toEqual({ ...animations[ANIM.LEGS_WALK], reversed: true });
    expect(animations[ANIM.FLAG_RUN]).toEqual(row(0, 16, 16, 66));
    expect(animations[ANIM.FLAG_STAND]).toEqual(row(16, 5, 0, 50));
    expect(animations[ANIM.FLAG_STAND2RUN]).toEqual(row(16, 5, 1, 66, true));
    expect(animations).toHaveLength(ANIM.MAX_TOTALANIMATIONS);
  });

  it('refuses a table cut short, which fails the model in Q3', () => {
    const warnings: string[] = [];
    const short = parseAnimationConfig(config('sex m', ROWS.slice(0, ANIM.LEGS_IDLE)), 'test.cfg', (m) =>
      warnings.push(m)
    );
    expect(short).toBeNull();
    expect(warnings).toEqual(['Error parsing animation file: test.cfg']);
    // A last row with no rate is as bad as a missing one.
    const cut = ROWS.map((r, i) => (i === ANIM.LEGS_TURN ? r.slice(0, 3) : r));
    expect(parseAnimationConfig(config('sex m', cut))).toBeNull();
  });
});

describe('parseAnimationConfig: the keywords', () => {
  it("has Q3's defaults where the file names none", () => {
    const { footsteps, headOffset, gender, fixedLegs, fixedTorso } = parsed(config(''));
    expect({ footsteps, headOffset, gender, fixedLegs, fixedTorso }).toEqual({
      footsteps: 'normal',
      headOffset: [0, 0, 0],
      gender: 'male',
      fixedLegs: false,
      fixedTorso: false
    });
  });

  it('reads them in any order and any case', () => {
    const header = 'FIXEDTORSO\nheadoffset -22 0 -3\nFootsteps BOOT\nsex F\nfixedlegs';
    const { footsteps, headOffset, gender, fixedLegs, fixedTorso } = parsed(config(header));
    expect({ footsteps, headOffset, gender, fixedLegs, fixedTorso }).toEqual({
      footsteps: 'boot',
      headOffset: [-22, 0, -3],
      gender: 'female',
      fixedLegs: true,
      fixedTorso: true
    });
  });

  it('takes the sex from its first letter, male for any other', () => {
    expect(parsed(config('sex neuter')).gender).toBe('neuter');
    expect(parsed(config('sex female')).gender).toBe('female');
    expect(parsed(config('sex x')).gender).toBe('male');
  });

  it('takes `default` for the normal footsteps', () => {
    expect(parsed(config('footsteps flesh\nfootsteps default')).footsteps).toBe('normal');
  });

  it('warns of an unknown word or footstep set, and reads on', () => {
    const warnings: string[] = [];
    const result = parsed(config('gender m\nfootsteps metal\nfootsteps mech'), warnings);
    // Each unknown word is its own warning: `m` is not a keyword either.
    expect(warnings).toEqual([
      "unknown token 'gender' in test.cfg",
      "unknown token 'm' in test.cfg",
      'Bad footsteps parm in test.cfg: metal'
    ]);
    expect(result.footsteps).toBe('mech');
  });
});

describe("parseAnimationConfig: COM_Parse's rules", () => {
  it('skips both kinds of comment and reads a quoted token', () => {
    const header = '/* a block\n that spans lines */ footsteps "energy" // a line\n';
    expect(parsed(config(header)).footsteps).toBe('energy');
  });

  it("runs a word through a comment's slashes", () => {
    // With no space before it the comment is part of the rate, which atof reads as 20.
    const rows = ROWS.map((r, i) => (i === 0 ? `${r.join('\t')}//x` : r.join('\t')));
    const text = `sex m\n${rows.join('\n')}\n`;
    expect(parsed(text).animations[ANIM.BOTH_DEATH1].frameLerp).toBe(50);
  });

  it('reads up to the first NUL, as the C string ends there', () => {
    expect(parsed(`${config()}\0garbage`).animations[ANIM.LEGS_TURN].firstFrame).toBe(124);
    expect(parseAnimationConfig(`sex m\0${config()}`)).toBeNull();
  });

  it("refuses a file too long for Q3's 20,000-byte buffer", () => {
    const warnings: string[] = [];
    const text = config() + ' '.repeat(19999 - config().length);
    expect(parseAnimationConfig(text, 'big.cfg', (m) => warnings.push(m))).toBeNull();
    expect(warnings).toEqual(['File big.cfg too long']);
    expect(parseAnimationConfig(text.slice(1))).not.toBeNull();
  });
});

describe.skipIf(!havePak0)("sarge's animation.cfg (pak0)", () => {
  it('parses to the golden values: skip 63, and the legs ending at lower.md3\'s 191 frames', async () => {
    const pak0 = await openPak('pak0.pk3');
    const text = new TextDecoder().decode(await pak0.read('models/players/sarge/animation.cfg'));
    const warnings: string[] = [];
    const { animations, footsteps, gender, headOffset } = parsed(text, warnings);
    expect(warnings).toEqual([]);
    expect({ footsteps, gender, headOffset }).toEqual({
      footsteps: 'normal',
      gender: 'male',
      headOffset: [0, 0, 0]
    });
    // 153 in the file, less the skip: 153 − 90 = 63.
    expect(animations[ANIM.LEGS_WALKCR]).toEqual(row(90, 8, 8, 50));
    expect(animations[ANIM.LEGS_IDLE]).toEqual(row(166, 10, 10, 66));
    expect(animations[ANIM.LEGS_TURN]).toEqual(row(184, 7, 7, 66));
    expect(animations[ANIM.TORSO_STAND]).toEqual(row(151, 1, 0, 66));
    expect(animations[ANIM.TORSO_GESTURE]).toEqual(row(90, 40, 0, 55));

    const lower = parseMd3((await pak0.read('models/players/sarge/lower.md3'))!);
    const upper = parseMd3((await pak0.read('models/players/sarge/upper.md3'))!);
    const turn = animations[ANIM.LEGS_TURN];
    expect(turn.firstFrame + turn.numFrames).toBe(lower.numFrames);
    const stand2 = animations[ANIM.TORSO_STAND2];
    expect(stand2.firstFrame + stand2.numFrames).toBe(upper.numFrames);
  });
});

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('every retail animation.cfg', () => {
  it('parses without a warning, and names only frames its parts have', async () => {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    const models = new Set(listPlayerModels(fs.listInSearchOrder('models/players/')).map((m) => m.model));
    expect(models.size).toBe(29);

    const parts = (row: number): readonly ('lower' | 'upper')[] => {
      if (row <= ANIM.BOTH_DEAD3) return ['lower', 'upper'];
      if (row >= ANIM.LEGS_WALKCR && row <= ANIM.LEGS_TURN) return ['lower'];
      if (row === ANIM.LEGS_BACKCR || row === ANIM.LEGS_BACKWALK) return ['lower'];
      return row < ANIM.MAX_ANIMATIONS ? ['upper'] : [];
    };
    for (const model of models) {
      const dir = `models/players/${model}/`;
      const warnings: string[] = [];
      const text = new TextDecoder().decode(await fs.read(`${dir}animation.cfg`));
      const { animations } = parsed(text, warnings);
      expect(warnings, model).toEqual([]);
      const frames = {
        lower: parseMd3((await fs.read(`${dir}lower.md3`))!).numFrames,
        upper: parseMd3((await fs.read(`${dir}upper.md3`))!).numFrames
      };
      animations.forEach(({ firstFrame, numFrames }, index) => {
        for (const part of parts(index)) {
          expect(firstFrame, `${model} row ${index}`).toBeGreaterThanOrEqual(0);
          expect(firstFrame + numFrames, `${model} row ${index} in ${part}`).toBeLessThanOrEqual(
            frames[part]
          );
        }
      });
    }
  }, 60000);
});
