import { describe, expect, it } from 'vitest';

import { PMOVE_MSEC } from '../sim/constants';
import { ET } from '../sim/game-entity';
import type { UserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { ViewWorld } from './view-test-fixtures';

/** The lasers as a client sees them: what `CG_AddPacketEntities` hands `CG_Beam`. */

/** A command with nothing held and nothing pressed. */
const IDLE: Omit<UserCmd, 'serverTime'> = {
  forwardmove: 0,
  rightmove: 0,
  upmove: 0,
  angles: vec3(),
  buttons: 0,
  weapon: 0
};

/** Enough ticks for the client to read a fresh snapshot. */
function ticks(world: ViewWorld, count = 30): void {
  for (let i = 0; i < count; i++) world.view.advance(PMOVE_MSEC, IDLE);
}

describe('a laser as a client sees it', () => {
  it('collects each beam the snapshot carried, from where it stands to where it stopped', () => {
    const world = new ViewWorld();
    const laser = world.level.spawnEntity();
    laser.classname = 'target_laser';
    laser.s.eType = ET.BEAM;
    laser.s.pos.trBase = vec3(10, 20, 30);
    laser.s.origin2 = vec3(300, 20, 30);
    world.level.linkEntity(laser);
    ticks(world);

    expect(world.view.lasers()).toEqual([
      { key: laser.s.number, start: vec3(10, 20, 30), end: vec3(300, 20, 30) }
    ]);

    // Turned off, it is out of the world and so out of the snapshot.
    world.level.unlinkEntity(laser);
    ticks(world);
    expect(world.view.lasers()).toEqual([]);
  });
});
