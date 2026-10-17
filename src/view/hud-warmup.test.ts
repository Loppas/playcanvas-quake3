import { describe, expect, it } from 'vitest';

import { GT, TEAM } from '../sim/constants';
import type { ClientInfo } from './client-info';
import type { HudText } from './hud';
import { createWarmupState, hudWarmup, type WarmupInput } from './hud-warmup';

/** A client info with only what the warmup reads. */
function info(name: string, team: number): ClientInfo {
  return { name, team } as ClientInfo;
}

/** The warmup block's lines, with a free-for-all's countdown unless a test says otherwise. */
function warmup(over: Partial<WarmupInput> = {}): HudText[] {
  return hudWarmup(createWarmupState(), {
    warmup: 12_000,
    time: 2_500,
    gametype: GT.FFA,
    clientInfo: () => null,
    ...over
  }).lines;
}

/** A free-for-all's warmup at `time`, counting down to `warmupAt`. */
function counting(warmupAt: number, time: number): WarmupInput {
  return { warmup: warmupAt, time, gametype: GT.FFA, clientInfo: () => null };
}

describe('CG_DrawWarmup', () => {
  it('says "Waiting for players" while a match waits for one', () => {
    const lines = warmup({ warmup: -1 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      text: 'Waiting for players',
      x: 168,
      y: 24,
      charWidth: 16,
      charHeight: 16,
      anchor: 'centre',
      shadow: true
    });
  });

  it('names the mode and counts the seconds down', () => {
    const lines = warmup();

    // "Free For All", centred, in giant chars: 32 wide and 1.1 times as tall.
    expect(lines[0]).toMatchObject({
      text: 'Free For All',
      x: 128,
      y: 25,
      charWidth: 32,
      charHeight: 35
    });
    // `(12000 - 2500) / 1000` is 9, and the text shows the second it is in.
    expect(lines[1]).toMatchObject({
      text: 'Starts in: 10',
      x: 216,
      y: 70,
      charWidth: 16,
      charHeight: 24
    });
  });

  it('grows the countdown over its last three seconds', () => {
    const at = (warmupAt: number) => warmup({ warmup: warmupAt, time: 5000 })[1];

    expect(at(5000)).toMatchObject({ text: 'Starts in: 1', charWidth: 28, charHeight: 42 });
    expect(at(6000)).toMatchObject({ text: 'Starts in: 2', charWidth: 24, charHeight: 36 });
    expect(at(7000)).toMatchObject({ text: 'Starts in: 3', charWidth: 20, charHeight: 30 });
    expect(at(8000)).toMatchObject({ text: 'Starts in: 4', charWidth: 16, charHeight: 24 });
  });

  it("names the two players a tournament is between, at 1.5 times the giant width", () => {
    const lines = warmup({
      gametype: GT.TOURNAMENT,
      warmup: 9000,
      time: 5000,
      clientInfo: (n) =>
        n === 0 ? info('Sarge', TEAM.FREE) : n === 2 ? info('Grunt', TEAM.FREE) : null
    });

    expect(lines[0]).toMatchObject({
      text: 'Sarge vs Grunt',
      x: 96,
      y: 20,
      charWidth: 32,
      charHeight: 48
    });
    expect(lines[1].text).toBe('Starts in: 5');
  });

  it('shrinks a tournament line that would run off the screen', () => {
    const name = 'A'.repeat(20);
    const lines = warmup({
      gametype: GT.TOURNAMENT,
      clientInfo: (n) => (n < 2 ? info(name, TEAM.FREE) : null)
    });

    // 44 characters: `cw = 640 / 44` (`cg_draw.c:2394–2398`), and the line still centres.
    expect(lines[0].charWidth).toBe(14);
    expect(lines[0].charHeight).toBe(21);
  });

  it('draws only the countdown when a tournament has no two players yet', () => {
    const lines = warmup({ gametype: GT.TOURNAMENT, clientInfo: () => null });

    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Starts in: 10');
  });

  it('does not seat a player who is on a team in a tournament line', () => {
    const lines = warmup({
      gametype: GT.TOURNAMENT,
      clientInfo: (n) =>
        n === 0 ? info('Sarge', TEAM.FREE) : n === 1 ? info('Grunt', TEAM.RED) : null
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Starts in: 10');
  });

  it('names team deathmatch, capture the flag and clan arena', () => {
    expect(warmup({ gametype: GT.TEAM })[0].text).toBe('Team Deathmatch');
    expect(warmup({ gametype: GT.CTF })[0].text).toBe('Capture the Flag');
    expect(warmup({ gametype: GT.CA })[0].text).toBe('Clan Arena');
  });

  it('draws nothing once the match is being played', () => {
    expect(warmup({ warmup: 0 })).toEqual([]);
  });

  it('says three, two and one as the countdown reaches each, and each once', () => {
    const state = createWarmupState();
    const said = (time: number) => hudWarmup(state, counting(10_000, time)).voice;

    expect(said(6_500)).toBeNull();
    expect(said(7_500)).toBe('count3');
    expect(said(7_900)).toBeNull();
    expect(said(8_500)).toBe('count2');
    expect(said(9_500)).toBe('count1');
    // Past its end the countdown stays on its last second, which has been said.
    expect(said(10_500)).toBeNull();
  });

  it('draws the countdown no more a second past its end, until the warmup changes', () => {
    const state = createWarmupState();
    const drawn = (warmupAt: number, time: number) =>
      hudWarmup(state, counting(warmupAt, time)).lines.map((line) => line.text);
    const counted = ['Free For All', 'Starts in: 1'];

    expect(drawn(10_000, 10_999)).toEqual(counted);
    // `cg.warmup` is zeroed a second past its end, by a frame that still draws it.
    expect(drawn(10_000, 11_000)).toEqual(counted);
    expect(drawn(10_000, 11_008)).toEqual([]);
    expect(drawn(10_000, 60_000)).toEqual([]);
    // `CG_ParseWarmup` sets it again from a new warmup.
    expect(drawn(70_000, 61_000)).toEqual(['Free For All', 'Starts in: 10']);
  });

  it('starts the count again when the warmup changes, as `CG_ParseWarmup` does', () => {
    const state = createWarmupState();
    hudWarmup(state, counting(-1, 1_000));
    expect(state.count).toBe(0);

    // A countdown that begins on its last second: the second is 0, as waiting left it, and only
    // the count starting again lets it be said.
    expect(hudWarmup(state, counting(1_500, 1_000)).voice).toBe('count1');
  });

  it('takes the first warmup it sees as it stands', () => {
    // `cg.warmupCount` starts at 0 and `CG_ParseWarmup` is not run at the start, so a client that
    // comes in on a countdown's last second has nothing to say about it.
    expect(hudWarmup(createWarmupState(), counting(1_500, 1_000)).voice).toBeNull();
  });

  it('says nothing while waiting, or while the match is played', () => {
    const state = createWarmupState();
    expect(hudWarmup(state, counting(-1, 1_000)).voice).toBeNull();
    expect(hudWarmup(state, counting(0, 1_000)).voice).toBeNull();
  });

  it('keeps the countdown second on the state', () => {
    const state = createWarmupState();
    hudWarmup(state, { warmup: 12_000, time: 2_500, gametype: GT.FFA, clientInfo: () => null });
    expect(state.count).toBe(9);

    hudWarmup(state, { warmup: 5_000, time: 5_000, gametype: GT.FFA, clientInfo: () => null });
    expect(state.count).toBe(0);
  });
});
