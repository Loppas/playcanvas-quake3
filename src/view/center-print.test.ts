import { describe, expect, it } from 'vitest';

import {
  createCenterPrint,
  centerPrint,
  centerPrintLines,
  USE_ITEM_CHAR_WIDTH,
  USE_ITEM_Y
} from './center-print';
import { BIGCHAR_WIDTH } from './hud-text';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from './hud-layout';

/**
 * `CG_CenterPrint` and `CG_DrawCenterString`: where the message in the middle of the screen sits,
 * and how it fades.
 */

/** A message raised at 1000 ms, as `CG_UseItem` raises one. */
function raised(text: string, time = 1000) {
  const state = createCenterPrint();
  centerPrint(state, text, USE_ITEM_Y, USE_ITEM_CHAR_WIDTH, time);
  return state;
}

describe('centerPrint', () => {
  it('keeps the message, its place and its clock', () => {
    const state = raised('Use Medkit');
    expect(state).toEqual({
      text: 'Use Medkit',
      time: 1000,
      y: SCREEN_HEIGHT * 0.3,
      charWidth: BIGCHAR_WIDTH,
      lines: 1
    });
  });

  it('counts the message’s lines as it is raised', () => {
    expect(raised('one\ntwo\nthree').lines).toBe(3);
  });

  it('replaces whatever was showing, as a later message does', () => {
    const state = raised('Use Medkit');
    centerPrint(state, 'No item to use', USE_ITEM_Y, BIGCHAR_WIDTH, 2000);
    expect(state).toMatchObject({ text: 'No item to use', time: 2000 });
  });
});

describe('centerPrintLines', () => {
  it('draws nothing before anything was raised, or once the duration has passed', () => {
    expect(centerPrintLines(createCenterPrint(), 1000, 3000)).toEqual([]);
    // `CG_FadeColor` refuses a start of 0 outright, and is null at the duration exactly.
    expect(centerPrintLines(raised('Use Medkit'), 4000, 3000)).toEqual([]);
  });

  it('centres the line, half the block above the y its raiser asked for', () => {
    const [line] = centerPrintLines(raised('Use Medkit'), 1000, 3000);
    // 10 characters of 16: 160 wide, centred at 240; y = 144 − 16/2 = 136, and 24 tall.
    expect(line).toEqual({
      text: 'Use Medkit',
      x: 240,
      y: 136,
      charWidth: BIGCHAR_WIDTH,
      charHeight: 24,
      alpha: 1
    });
  });

  it('fades over the last 200 ms, then goes', () => {
    const state = raised('Use Medkit');
    expect(centerPrintLines(state, 3900, 3000)[0].alpha).toBeCloseTo(0.5, 6);
    expect(centerPrintLines(state, 3999, 3000)[0].alpha).toBeGreaterThan(0);
  });

  it('stacks the lines a character and a half apart, centred on their own widths', () => {
    const lines = centerPrintLines(raised('one\ntwo'), 1000, 3000);
    // Two lines: the top is 144 − 2 × 16 / 2 = 128, and each steps 24 down.
    expect(lines.map(({ y }) => y)).toEqual([128, 152]);
    // Each line of three characters is 48 wide, centred at 296.
    expect(lines.map(({ x }) => x)).toEqual([
      (SCREEN_WIDTH - 3 * BIGCHAR_WIDTH) / 2,
      (SCREEN_WIDTH - 3 * BIGCHAR_WIDTH) / 2
    ]);
  });

  it('cuts a line at the 50 characters its buffer carries', () => {
    // `CG_DrawCenterString`'s `linebuffer` takes 50 and skips the rest of the line
    // (`cg_draw.c:1810–1817`).
    const [line] = centerPrintLines(raised('x'.repeat(60)), 1000, 3000);
    expect(line.text).toHaveLength(50);
    // Fifty characters of 16: 800 wide, so the arithmetic runs past the left edge as Q3's does.
    expect(line.x).toBe((SCREEN_WIDTH - 50 * BIGCHAR_WIDTH) / 2);
  });

  it('draws nothing for the empty message an empty state holds', () => {
    // The port's HUD asks the same question of a state nothing has raised; Q3 never draws one
    // because its time is 0.
    expect(centerPrintLines(createCenterPrint(), 1000, 3000)).toEqual([]);
  });
});
