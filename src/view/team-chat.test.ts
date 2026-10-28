import { describe, expect, it } from 'vitest';

import { TEAM } from '../sim/constants';
import {
  TEAMCHAT_HEIGHT,
  addToTeamChat,
  createTeamChat,
  drawTeamChat,
  type TeamChatSettings,
  type TeamChatState
} from './team-chat';

/** The box shown four lines high, each for `cg_teamChatTime`'s default. */
const FOUR: TeamChatSettings = { teamChatHeight: 4, teamChatTime: 3000 };

/** A box with these lines said, in turn, at `time`. */
function said(lines: readonly string[], settings = FOUR, time = 100): TeamChatState {
  const state = createTeamChat();
  for (const line of lines) addToTeamChat(state, line, settings, time);
  return state;
}

/** The lines showing, oldest first. */
function showing(state: TeamChatState, height = FOUR.teamChatHeight): string[] {
  const lines: string[] = [];
  for (let i = state.lastPos; i < state.pos; i++) lines.push(state.msgs[i % height]);
  return lines;
}

describe('addToTeamChat', () => {
  it('keeps a line of 80 characters whole, its colour codes not counted', () => {
    const line = `(^1Alpha^7): ^5${'x'.repeat(71)}`;
    expect(showing(said([line]))).toEqual([line]);
  });

  it('wraps at the last space, which it drops, and starts the next line in the last colour', () => {
    const line =
      '(Charlie^7) (^1Red Base^7): ^5have their flag, coming back by the lower tunnel, ' +
      'cover the ramp';
    expect(showing(said([line]))).toEqual([
      '(Charlie^7) (^1Red Base^7): ^5have their flag, coming back by the lower tunnel, cover',
      '^5the ramp'
    ]);
  });

  it('cuts a line with no space where it is, starting the next in white', () => {
    expect(showing(said(['z'.repeat(170)]))).toEqual([
      'z'.repeat(80),
      `^7${'z'.repeat(80)}`,
      `^7${'z'.repeat(10)}`
    ]);
  });

  it("carries the last code read, though the wrap backs up past it, as the C's does", () => {
    const line = `${'a'.repeat(70)} bbbbb^3${'c'.repeat(10)}`;
    expect(showing(said([line]))).toEqual(['a'.repeat(70), `^3bbbbb^3${'c'.repeat(10)}`]);
  });

  it('keeps the last cg_teamChatHeight lines, and never more than 8', () => {
    const two = said(['one', 'two', 'three'], { teamChatHeight: 2, teamChatTime: 3000 });
    expect(two).toMatchObject({ pos: 3, lastPos: 1 });
    expect(showing(two, 2)).toEqual(['two', 'three']);

    const many = { teamChatHeight: 20, teamChatTime: 3000 };
    const nine = said(['1', '2', '3', '4', '5', '6', '7', '8', '9'], many);
    expect(nine).toMatchObject({ pos: 9, lastPos: 1 });
    expect(showing(nine, TEAMCHAT_HEIGHT)).toEqual(['2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('keeps nothing, and lets go of what it had, with its height or its time at 0', () => {
    const state = said(['one', 'two']);
    addToTeamChat(state, 'three', { teamChatHeight: 0, teamChatTime: 3000 }, 200);
    expect(state).toMatchObject({ pos: 0, lastPos: 0 });

    addToTeamChat(state, 'four', FOUR, 300);
    addToTeamChat(state, 'five', { teamChatHeight: 4, teamChatTime: 0 }, 400);
    expect(state).toMatchObject({ pos: 0, lastPos: 0 });
  });

  it("stamps each line with cgame's time, to the millisecond below", () => {
    const state = said(['z'.repeat(90)], FOUR, 108.75);
    expect(state.times.slice(0, 2)).toEqual([108, 108]);
  });
});

describe('drawTeamChat', () => {
  it('draws nothing with the box off, or with nothing in it', () => {
    expect(drawTeamChat(createTeamChat(), FOUR, 200, TEAM.RED)).toBeNull();
    const off = { teamChatHeight: 0, teamChatTime: 3000 };
    expect(drawTeamChat(said(['one']), off, 200, TEAM.RED)).toBeNull();
  });

  it('draws the lines newest at the bottom, from x 8, over a band 8 a line up from y 420', () => {
    const frame = drawTeamChat(said(['one', 'two']), FOUR, 200, TEAM.RED);
    expect(frame?.band).toEqual({ x: 0, y: 404, w: 640, h: 16 });
    expect(frame?.lines).toEqual(
      [
        ['two', 412],
        ['one', 404]
      ].map(([text, y]) => ({
        text,
        x: 8,
        y,
        charWidth: 8,
        charHeight: 8,
        color: [1, 1, 1, 1],
        shadow: false,
        anchor: 'left'
      }))
    );
  });

  it("tints the band by the player's own team: red, blue, or else green", () => {
    const color = (team: number) => drawTeamChat(said(['one']), FOUR, 200, team)?.color;
    expect(color(TEAM.RED)).toEqual([1, 0, 0, 0.33]);
    expect(color(TEAM.BLUE)).toEqual([0, 0, 1, 0.33]);
    expect(color(TEAM.SPECTATOR)).toEqual([0, 1, 0, 0.33]);
    expect(color(TEAM.FREE)).toEqual([0, 1, 0, 0.33]);
  });

  it('lets the oldest go once it is older than cg_teamChatTime, one a frame', () => {
    const state = said(['z'.repeat(90)]);
    addToTeamChat(state, 'later', FOUR, 1000);
    const lines = (time: number) =>
      drawTeamChat(state, FOUR, time, TEAM.RED)?.lines.map(({ text }) => text) ?? null;

    expect(lines(3100)).toEqual(['later', '^7zzzzzzzzzz', 'z'.repeat(80)]);
    expect(lines(3101)).toEqual(['later', '^7zzzzzzzzzz']);
    expect(lines(3101)).toEqual(['later']);
    expect(lines(3101)).toEqual(['later']);
    expect(lines(4001)).toBeNull();
    expect(state).toMatchObject({ pos: 3, lastPos: 3 });
  });
});
