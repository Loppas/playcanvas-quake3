import { describe, expect, it } from 'vitest';

import { createEntityState, createPlayerState } from '../net/protocol';
import {
  CONTENTS,
  CROUCH_VIEWHEIGHT,
  DEFAULT_VIEWHEIGHT,
  EF_DEAD,
  PERS,
  TEAM
} from '../sim/constants';
import { packSolid } from '../sim/entity-solid';
import { playerBounds } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { playerHitBoxes } from './hit-boxes';

/** Excessive Plus's colours. */
const RED = [0.91, 0, 0];
const BLUE = [0.18, 0.38, 0.78];
const FREE = [0, 1, 0.16];

/** A player in a slot, standing or crouched, as a snapshot carries them, drawn at `x`. */
function drawn(clientNum: number, x: number, crouched = false, eFlags = 0) {
  const { mins, maxs } = playerBounds(crouched);
  const solid = packSolid({ bmodel: false, contents: CONTENTS.BODY, mins, maxs });
  const state = { ...createEntityState(), number: clientNum, clientNum, solid, eFlags };
  return { state, origin: vec3(x, 0, 24) };
}

/** Slot 1 is red, 2 blue, and anyone else in no team. */
function team(clientNum: number): number {
  return clientNum === 1 ? TEAM.RED : clientNum === 2 ? TEAM.BLUE : TEAM.FREE;
}

/** The player's own body, drawn at the origin, in their stance and team. */
function own(viewheight: number, eFlags = 0) {
  const ps = createPlayerState();
  ps.viewheight = viewheight;
  ps.eFlags = eFlags;
  ps.persistant[PERS.TEAM] = TEAM.BLUE;
  return { origin: vec3(0, 0, 24), ps };
}

describe('playerHitBoxes', () => {
  it("boxes each player where drawn, by their entity's box, in their team's colour", () => {
    const others = [drawn(1, 100), drawn(2, 200, true), drawn(3, 300)];
    const standing = playerBounds(false);
    expect(playerHitBoxes(others, team, null)).toEqual([
      { origin: vec3(100, 0, 24), ...standing, color: RED },
      { origin: vec3(200, 0, 24), ...playerBounds(true), color: BLUE },
      { origin: vec3(300, 0, 24), ...standing, color: FREE }
    ]);
  });

  it('passes over the dead, and the corpses, which pack no box', () => {
    const corpse = drawn(4, 100, false, EF_DEAD);
    corpse.state.number = 70;
    corpse.state.solid = 0;
    expect(playerHitBoxes([drawn(1, 100, false, EF_DEAD), corpse], team, null)).toEqual([]);
  });

  it('passes over a living player whose entity packs no box', () => {
    const unboxed = drawn(3, 100);
    unboxed.state.solid = 0;
    expect(playerHitBoxes([unboxed], team, null)).toEqual([]);
  });

  it("boxes the player's own body while it is drawn, crouched by the view height", () => {
    const [standing] = playerHitBoxes([], team, own(DEFAULT_VIEWHEIGHT));
    expect(standing).toEqual({ origin: vec3(0, 0, 24), ...playerBounds(false), color: BLUE });
    const [crouched] = playerHitBoxes([], team, own(CROUCH_VIEWHEIGHT));
    expect(crouched.maxs.z).toBe(16);

    expect(playerHitBoxes([], team, own(DEFAULT_VIEWHEIGHT, EF_DEAD))).toEqual([]);
  });
});
