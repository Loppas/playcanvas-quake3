import { createClipTrace } from '../clip-trace';
import { loadMap } from '../cm/cm-load';
import { cubeBsp } from '../cm/collision-test-fixtures';
import { CONTENTS, PMF_DUCKED, PM_DEAD } from '../constants';
import { setEntityOrigin, type GameEntity } from '../game-entity';
import { Level } from '../level';
import { spawnClient } from '../life-test-fixtures';
import type { PlayerLife } from '../player-life';
import type { Rules } from '../rules';
import { clearTrace, playerBounds, type TraceFn } from '../types';
import { copy } from '../vec3';
import { Grapple, type GrappleMode } from './grapple';
import { truncVector } from './hitscan';
import { runMissile } from './missile';
import { WeaponSystem, type WeaponRandomness } from './weapon-system';

/**
 * A world with one client in it and a weapon system firing into it, for the tests that drive one
 * without a game module.
 *
 * `Game` is what builds this on the real path: the level, the client in slot 0, and the handler
 * that runs `G_RunMissile` for whatever flies. The tests below it want none of the rest of a
 * match, only somewhere for a rocket to be and someone for it to reach.
 */

/** A client, the world it fires into, and the system that fires. */
export interface WeaponWorld {
  level: Level;
  /** The client's entity, in slot 0: a missile's owner, and who its blast belongs to. */
  owner: GameEntity;
  weapons: WeaponSystem;
  /**
   * The life `ClientEvents` runs on, when one was asked for.
   *
   * A test that calls {@link WeaponSystem.fire} itself needs none — that is what `ClientEvents`
   * would have done. One that drives the whole loop does, because the move only raises an event
   * and it is the life that turns it into a shot.
   */
  life: PlayerLife | null;
  /** The off-hand hook for that client, in the style asked for — `null` for no hook at all. */
  grapple: Grapple;
}

/**
 * Put a client in a world with a weapon system.
 *
 * The client can be hurt either way. Without a life it is a bare entity in slot 0 that a hit
 * reaches as it reaches any player, and that has nothing to do about dying.
 *
 * @param options - The world to trace against, the randomness to pin, and whether to live a life.
 */
export function weaponWorld(
  options: {
    trace?: TraceFn;
    randomness?: Partial<WeaponRandomness>;
    /** Put a life on the client, so that a fire event the move raises becomes a shot. */
    client?: boolean;
    /** CorkScrew's `g_allowGrapple`: which style the hook throws in, if any. */
    grapple?: GrappleMode | null;
    /** The rules of play, read at each shot and by each missile. id's defaults without them. */
    rules?: Readonly<Rules>;
    /** `xp_unlagged`, read at each shot. Nothing rewinds without it. */
    unlagged?: () => number;
  } = {}
): WeaponWorld {
  const trace = options.trace ?? ((_start, _mins, _maxs, end) => clearTrace(end));
  let weapons: WeaponSystem;
  let grapple: Grapple;

  const level = new Level({
    rules: options.rules,
    handlers: {
      runMissile: (missile) => runMissile(level, missile, trace, options.rules)
    }
  });

  let life: PlayerLife | null = null;
  let owner: GameEntity;
  if (options.client) {
    const spawned = spawnClient({
      level,
      fireWeapon: (state) => weapons.fire(state),
      freeHook: () => grapple.release()
    });
    owner = spawned.entity;
    life = spawned.life;
  } else {
    owner = level.gentities[0];
    owner.client = level.clients[0];
    owner.inuse = true;
    owner.classname = 'player';
    owner.takedamage = true;
    owner.r.contents = CONTENTS.BODY;
  }

  weapons = new WeaponSystem({
    level,
    owner,
    trace,
    randomness: options.randomness,
    rules: options.rules,
    unlagged: options.unlagged
  });
  grapple = new Grapple({ level, owner, mode: options.grapple ?? null });
  linkPlayer(level, owner);

  return { level, owner, weapons, life, grapple };
}

/**
 * A BSP's world for a shot to meet, through collision: the collision tests' cube, 128 units on a
 * side about the line down +X, and every side's surface flags these.
 *
 * @param surfaceFlags - `SURF_*` of the cube's sides.
 * @param near - How far its near face is from the origin.
 */
export function brushAhead(surfaceFlags = 0, near = 256): TraceFn {
  const cube = cubeBsp();
  // The −x face and the +x face, in q3map's order.
  const dists = [-near, near + 128];
  const planes = cube.planes.map((plane, i) => (i < 2 ? { ...plane, dist: dists[i] } : plane));
  const shaders = cube.shaders.map((shader, i) => (i === 1 ? { ...shader, surfaceFlags } : shader));
  return createClipTrace(loadMap(cubeBsp({ planes, shaders }), 'maps/test.bsp'));
}

/**
 * The end of `ClientThink_real`'s move (`g_active.c:960–979`): the world links the player by the
 * box the move ended in, round their origin snapped to whole units, and then holds them at their
 * exact one. What a blast measures to, and pushes from, is this.
 *
 * @param level - The world to link them in.
 * @param entity - The client's entity, whose player state says where they are.
 */
export function linkPlayer(level: Level, entity: GameEntity): void {
  const ps = entity.client!.ps;
  const box = playerBounds((ps.pmFlags & PMF_DUCKED) !== 0, ps.pmType === PM_DEAD);
  entity.r.mins = box.mins;
  entity.r.maxs = box.maxs;
  setEntityOrigin(entity, truncVector(ps.origin));
  level.linkEntity(entity);
  entity.r.currentOrigin = copy(ps.origin);
}
