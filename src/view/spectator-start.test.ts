import { describe, expect, it } from 'vitest';

import { readEntities } from '../formats/entity-text';
import { spectatorStart } from './spectator-start';

/** A map's entities from blocks of pairs, worldspawn first. */
function entities(...blocks: Record<string, string>[]) {
  const text = [{ classname: 'worldspawn' }, ...blocks]
    .map((pairs) => `{\n${Object.entries(pairs).map(([k, v]) => `"${k}" "${v}"`).join('\n')}\n}`)
    .join('\n');
  return readEntities(text);
}

/** A view's numbers, to two places. */
function view({ origin, angles }: ReturnType<typeof spectatorStart>) {
  const round = (x: number) => Math.round(x * 100) / 100 + 0;
  return {
    origin: [origin.x, origin.y, origin.z].map(round),
    angles: [angles.x, angles.y, angles.z].map(round)
  };
}

describe('spectatorStart', () => {
  it('stands at the first intermission point, its eye 26 up, looking at its target', () => {
    const start = spectatorStart(
      entities(
        { classname: 'info_player_intermission', origin: '0 0 0', target: 'T', angle: '45' },
        { classname: 'info_player_intermission', origin: '500 500 500' },
        { classname: 'target_position', targetname: 't', origin: '0 -100 -100' }
      )
    );
    // Down 45 and round to 270, held as a client holds them: pitch and yaw within ±180.
    expect(view(start)).toEqual({ origin: [0, 0, 26], angles: [45, -90, 0] });
  });

  it("keeps the point's own angles with no target, or one Q3 frees as it spawns", () => {
    const own = spectatorStart(
      entities({ classname: 'info_player_intermission', angles: '-10 120 0' })
    );
    expect(view(own).angles).toEqual([-10, 120, 0]);
    const freed = spectatorStart(
      entities(
        { classname: 'info_player_intermission', angle: '30', target: 'n' },
        { classname: 'info_null', targetname: 'n', origin: '0 0 -64' }
      )
    );
    expect(view(freed).angles).toEqual([0, 30, 0]);
  });

  it('passes over a point a free-for-all does not keep', () => {
    const start = spectatorStart(
      entities(
        { classname: 'info_player_intermission', origin: '1 1 1', notfree: '1' },
        { classname: 'info_player_intermission', origin: '2 2 2' }
      )
    );
    expect(view(start).origin).toEqual([2, 2, 28]);
  });

  it('with no intermission point, spawns at one of the furthest half of the spots', () => {
    const spots = entities(
      { classname: 'info_player_deathmatch', origin: '10 0 0', angle: '1' },
      { classname: 'info_player_start', origin: '40 0 0', angle: '4' },
      { classname: 'info_player_deathmatch', origin: '90 0 0', angle: '9', nohumans: '1' },
      { classname: 'info_player_deathmatch', origin: '30 0 0', angle: '3' },
      { classname: 'info_player_deathmatch', origin: '20 0 0', angle: '2' }
    );
    // Furthest first: 40, 30, 20, 10. The furthest half is the first two.
    expect(view(spectatorStart(spots, () => 0))).toEqual({
      origin: [40, 0, 35],
      angles: [0, 4, 0]
    });
    expect(view(spectatorStart(spots, () => 0.99)).angles).toEqual([0, 3, 0]);
  });

  it("stops in Q3's words on a map with nowhere to start", () => {
    expect(() => spectatorStart(entities({ classname: 'light' }))).toThrow(
      new Error("Couldn't find a spawn point")
    );
  });
});
