import { spawnInt, spawnVar, type SpawnVars } from '../formats/entity-text';
import { DEFAULT_VIEWHEIGHT, GT } from '../sim/constants';
import { MAX_SPAWN_POINTS, SPAWN_LIFT } from '../sim/game';
import { angleNormalize180, vectorToAngles } from '../sim/pmove-math';
import { inGametype } from '../sim/spawn';
import { vec3 } from '../sim/vec3';
import { placement } from './brush-models';
import type { FirstPersonView } from './camera-feel';

/**
 * Where a spectator first looks out from, read from a map's entities with no game running: what a
 * player who joins a free-for-all as a spectator sees first (`SelectSpectatorSpawnPoint`,
 * `g_client.c:341-348`).
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** What Q3's game frees as it spawns it, so nothing finds it after (`g_spawn.c`, `g_misc.c`). */
const FREED = new Set(['info_null', 'func_group', 'light', 'misc_model']);

type Vec = [number, number, number];

/**
 * `FindIntermissionPoint` (`g_main.c:963-984`): the first intermission point, looking at its target
 * where it has one, or with none an ordinary spawn as `SelectSpawnPoint` picks one from the world's
 * origin (`g_client.c:183-259`). The eye is `DEFAULT_VIEWHEIGHT` above, and the angles come as a
 * client's view holds them, the pitch within ±180.
 *
 * @param entities - The map's entities, worldspawn first, as `readEntities` reads them.
 * @param random - `random()`, for which of several targets, or of the furthest spawn spots.
 * @throws with Q3's `G_Error` for a map with neither an intermission point nor a spawn spot
 */
export function spectatorStart(
  entities: readonly SpawnVars[],
  random: () => number = Math.random
): FirstPersonView {
  // The first block is the world's; the rest stand only where a free-for-all keeps them.
  const spawned = entities
    .slice(1)
    .filter((vars) => inGametype(vars, GT.FFA) && !FREED.has(classname(vars)));
  const intermission = spawned.find((vars) => classname(vars) === 'info_player_intermission');
  let origin: Vec;
  let angles: Vec;
  if (intermission) {
    ({ origin, angles } = placement(intermission));
    const target = spawnVar(intermission, 'target');
    // `G_PickTarget`: one of every entity of that name, at random.
    const choices = target === undefined ? [] : spawned.filter((vars) => named(vars, target));
    if (choices.length > 0) {
      const at = placement(choices[Math.floor(random() * choices.length) % choices.length]).origin;
      const dir = vec3(at[0] - origin[0], at[1] - origin[1], at[2] - origin[2]);
      const { x, y, z } = vectorToAngles(dir);
      angles = [x, y, z];
    }
  } else {
    ({ origin, angles } = furthestSpawn(spawned, random));
  }
  return {
    origin: vec3(origin[0], origin[1], origin[2] + DEFAULT_VIEWHEIGHT),
    angles: vec3(
      angleNormalize180(angles[0]),
      angleNormalize180(angles[1]),
      angleNormalize180(angles[2])
    )
  };
}

/** An entity's classname as its spawn reads it, where `info_player_start` is a deathmatch spot. */
function classname(vars: SpawnVars): string {
  const name = spawnVar(vars, 'classname') ?? '';
  return name === 'info_player_start' ? 'info_player_deathmatch' : name;
}

/** Whether `G_Find` finds an entity by this `targetname`, which it compares without case. */
function named(vars: SpawnVars, targetname: string): boolean {
  return spawnVar(vars, 'targetname')?.toLowerCase() === targetname.toLowerCase();
}

/**
 * `SelectRandomFurthestSpawnPoint` from the world's origin, for a human (`g_client.c:183-259`): one
 * of the furthest half of the spots open to humans, at random, the player lifted above it.
 */
function furthestSpawn(
  spawned: readonly SpawnVars[],
  random: () => number
): { origin: Vec; angles: Vec } {
  const all = spawned.filter((vars) => classname(vars) === 'info_player_deathmatch');
  const spots: SpawnVars[] = [];
  const dists: number[] = [];
  for (const spot of all) {
    if (spawnInt(spot, 'nohumans', '0')) continue;
    const dist = Math.hypot(...placement(spot).origin);
    let i = 0;
    for (; i < spots.length; i++) {
      if (dist > dists[i]) {
        if (spots.length >= MAX_SPAWN_POINTS) {
          spots.length = MAX_SPAWN_POINTS - 1;
          dists.length = MAX_SPAWN_POINTS - 1;
        }
        spots.splice(i, 0, spot);
        dists.splice(i, 0, dist);
        break;
      }
    }
    if (i >= spots.length && spots.length < MAX_SPAWN_POINTS) {
      spots.push(spot);
      dists.push(dist);
    }
  }
  const chosen =
    spots.length > 0 ? spots[Math.floor(random() * Math.floor(spots.length / 2))] : all[0];
  if (!chosen) throw new Error("Couldn't find a spawn point");
  const { origin, angles } = placement(chosen);
  return { origin: [origin[0], origin[1], origin[2] + SPAWN_LIFT], angles };
}
