import { describe, expect, it } from 'vitest';

import { GT } from '../sim/constants';
import { followLines, spectatorLines } from './hud-spectator';
import { GIANT_HEIGHT, GIANT_WIDTH } from './hud-text';

/** What the screen says to somebody who is not playing: `CG_DrawSpectator` and `CG_DrawFollow`. */

describe('the spectator lines', () => {
  it('says SPECTATOR along the bottom, hand-centred as Q3 centres it', () => {
    const [spectator] = spectatorLines(GT.FFA);

    expect(spectator).toEqual({
      text: 'SPECTATOR',
      // `320 - 9 * 8`, which is the line centred a character at a time.
      x: 248,
      y: 440,
      charWidth: 16,
      charHeight: 16,
      color: [1, 1, 1, 1],
      shadow: true,
      anchor: 'centre'
    });
  });

  it('says nothing else in a free-for-all, where there is nothing to wait for', () => {
    expect(spectatorLines(GT.FFA)).toHaveLength(1);
  });

  it('says a tournament is waiting to play, because the queue gives the place', () => {
    const lines = spectatorLines(GT.TOURNAMENT);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ text: 'waiting to play', x: 200, y: 460 });
  });

  it('sends a team game to the menu, where a side is picked', () => {
    for (const gametype of [GT.TEAM, GT.CTF]) {
      const lines = spectatorLines(gametype);
      expect(lines[1]).toMatchObject({
        text: 'press ESC and use the JOIN menu to play',
        x: 8,
        y: 460
      });
    }
  });
});

describe('the follow lines', () => {
  it('says following, and under it the name in giant characters', () => {
    const [label, name] = followLines('Sarge');

    expect(label).toMatchObject({ text: 'following', x: 248, y: 24, charWidth: 16 });
    expect(name).toEqual({
      text: 'Sarge',
      // `0.5 * (640 - GIANT_WIDTH * 5)`.
      x: 240,
      y: 40,
      charWidth: GIANT_WIDTH,
      charHeight: GIANT_HEIGHT,
      color: [1, 1, 1, 1],
      shadow: true,
      anchor: 'centre'
    });
  });

  it('drops the name\'s colours, which `forceColor` is what Q3 draws it with', () => {
    const [, name] = followLines('^1Sarge');

    expect(name.text).toBe('Sarge');
    // And the codes were never part of its width either.
    expect(name.x).toBe(240);
  });

  it('centres a longer name on the same line', () => {
    const [, name] = followLines('Bitterman');

    expect(name.x).toBe(0.5 * (640 - GIANT_WIDTH * 9));
    expect(name.y).toBe(40);
  });
});
