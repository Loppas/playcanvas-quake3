import { atof, atoi } from '../formats/c-scan';
import { parseVector, spawnFloat, spawnVar, type SpawnVars } from '../formats/entity-text';
import type { BspModel } from '../formats/bsp';
import { GT } from '../sim/constants';
import { inGametype } from '../sim/spawn';
import { anglesToAxis } from './hand-pose';

/**
 * A map's brush models as its entity text has them: the MD3s its movers draw with them, and where
 * they stand before anything has moved them, what a preview shows of the doors, platforms and
 * spinning machinery with no game running.
 *
 * Each mover's spawn function in `g_mover.c` puts it at its rest: a door or a button at `pos1`, a
 * platform at the bottom, a train at its first corner, and the rest at their trajectory's start.
 * cgame draws each as its inline model at that place (`CG_Mover`, `cg_ents.c:571-605`), and its
 * `model2` MD3 with it.
 *
 * Engine-free, like the rest of `src/view/`.
 */

type Vec = [number, number, number];

/** One brush model as it is drawn, as `CG_Mover` hands it to the renderer. */
export interface BrushModelPose {
  /** The inline model: the `N` of `*N`. */
  model: number;
  /** Its mover's entity number, which orders it in a scene; none where no game sent it. */
  number?: number;
  /** Where its origin stands, in Q3 units. */
  origin: Vec;
  /** Pitch, yaw and roll, in degrees. */
  angles: Vec;
  /** `model2`: an MD3 drawn with it, at the same place. */
  model2?: string;
  /** Its entity's `constantLight`, which cgame adds a light for at its origin; none for 0. */
  constantLight?: number;
}

/** The classnames `InitMover` makes movers of (`g_mover.c`), each drawn by `CG_Mover`. */
const MOVERS = new Set([
  'func_door',
  'func_button',
  'func_plat',
  'func_train',
  'func_static',
  'func_rotating',
  'func_bobbing',
  'func_pendulum'
]);

/**
 * A field as `G_ParseField` leaves it (`g_spawn.c:336-387`): each pair is copied on in order, so a
 * key given twice keeps its last value. `angle` is a yaw alone (`F_ANGLEHACK`).
 */
export function placement(vars: SpawnVars): { origin: Vec; angles: Vec } {
  let origin: Vec = [0, 0, 0];
  let angles: Vec = [0, 0, 0];
  const vector = (value: string): Vec => {
    const { x, y, z } = parseVector(value);
    return [x, y, z];
  };
  for (const [key, value] of vars) {
    const name = key.toLowerCase();
    if (name === 'origin') origin = vector(value);
    else if (name === 'angles') angles = vector(value);
    else if (name === 'angle') angles = [0, atof(value), 0];
  }
  return { origin, angles };
}

/**
 * `G_SetMovedir` (`g_utils.c:328-342`): the way a door or a button opens, from its angles, where
 * yaw −1 is up and −2 is down.
 */
function moveDir(angles: Vec): Vec {
  if (angles[0] === 0 && angles[1] === -1 && angles[2] === 0) return [0, 0, 1];
  if (angles[0] === 0 && angles[1] === -2 && angles[2] === 0) return [0, 0, -1];
  return anglesToAxis(angles[0], angles[1], angles[2])[0];
}

/**
 * Every brush model the map's movers draw in a free-for-all, at rest, in the order the game numbers
 * their entities.
 *
 * @param entities - The map's entities, worldspawn first, as `readEntities` reads them.
 * @param models - The BSP's inline models, whose bounds a door that rests open and a platform
 *   move by.
 * @throws in Q3's words for a mover with no model, one that is not an inline model, and one that
 *   names a model the map hasn't got (`SV_SetBrushModel`, `sv_game.c:111-130`; `CM_InlineModel`)
 */
export function brushModelsAtRest(
  entities: readonly SpawnVars[],
  models: readonly Pick<BspModel, 'mins' | 'maxs'>[]
): BrushModelPose[] {
  // The first block is the world's, spawned apart from the rest.
  const spawned = entities.slice(1).filter((vars) => inGametype(vars, GT.FFA));
  const classname = (vars: SpawnVars) => spawnVar(vars, 'classname') ?? '';
  /** `G_Find` by `targetname`, which compares without regard to case. */
  const find = (targetname: string, from = 0): number =>
    spawned.findIndex(
      (vars, i) =>
        i >= from && spawnVar(vars, 'targetname')?.toLowerCase() === targetname.toLowerCase()
    );

  const poses: BrushModelPose[] = [];
  for (const vars of spawned) {
    const kind = classname(vars);
    if (!MOVERS.has(kind)) continue;
    // A train with no target is freed before it takes its model (`g_mover.c:1436-1440`).
    if (kind === 'func_train' && spawnVar(vars, 'target') === undefined) continue;

    const name = spawnVar(vars, 'model');
    if (name === undefined) throw new Error('SV_SetBrushModel: NULL');
    if (!name.startsWith('*')) throw new Error(`SV_SetBrushModel: ${name} isn't a brush model`);
    const model = atoi(name.slice(1));
    if (model < 0 || model >= models.length) throw new Error('CM_InlineModel: bad number');
    // Collision spreads a model's bounds by a unit each way (`cm_load.c:146-149`).
    const size = [0, 1, 2].map((j) => models[model].maxs[j] + 1 - (models[model].mins[j] - 1));

    const { origin, angles } = placement(vars);
    let restOrigin: Vec = origin;
    let restAngles: Vec = [0, 0, 0];
    switch (kind) {
      case 'func_door':
        // `SP_func_door` (`g_mover.c:950-994`): one that starts open rests at its far end.
        if (atoi(spawnVar(vars, 'spawnflags') ?? '0') & 1) {
          const dir = moveDir(angles);
          const lip = spawnFloat(vars, 'lip', '8');
          const distance =
            Math.abs(dir[0]) * size[0] +
            Math.abs(dir[1]) * size[1] +
            Math.abs(dir[2]) * size[2] -
            lip;
          restOrigin = [0, 1, 2].map((j) => origin[j] + distance * dir[j]) as Vec;
        }
        break;
      case 'func_plat': {
        // `SP_func_plat` (`:1118-1143`): it rests at the bottom.
        const height =
          spawnVar(vars, 'height') !== undefined
            ? spawnFloat(vars, 'height', '0')
            : size[2] - spawnFloat(vars, 'lip', '8');
        restOrigin = [origin[0], origin[1], origin[2] - height];
        break;
      }
      case 'func_train':
        restOrigin = trainStart(spawned, vars, find) ?? [0, 0, 0];
        break;
      case 'func_pendulum':
        // `SP_func_pendulum` (`:1600-1633`): it swings about the angles it was given.
        restAngles = angles;
        break;
    }
    const model2 = spawnVar(vars, 'model2');
    poses.push({ model, origin: restOrigin, angles: restAngles, ...(model2 ? { model2 } : {}) });
  }
  return poses;
}

/**
 * Each mover's `model2` by its inline model, whatever gametype keeps the mover: the MD3 `InitMover`
 * registers as its `s.modelindex2` (`g_mover.c:721-725`), which the world loads before any snapshot
 * says what is drawn. A mover that names no inline model the map has is left out, as the server
 * refuses it; a model two movers name keeps the first one's.
 *
 * @param entities - The map's entities, worldspawn first, as `readEntities` reads them.
 * @param numModels - How many inline models the map has, the world's among them.
 */
export function moverModel2s(
  entities: readonly SpawnVars[],
  numModels: number
): Map<number, string> {
  const model2s = new Map<number, string>();
  for (const vars of entities.slice(1)) {
    if (!MOVERS.has(spawnVar(vars, 'classname') ?? '')) continue;
    const name = spawnVar(vars, 'model');
    const model2 = spawnVar(vars, 'model2');
    if (name === undefined || !name.startsWith('*') || !model2) continue;
    const model = atoi(name.slice(1));
    if (model > 0 && model < numModels && !model2s.has(model)) model2s.set(model, model2);
  }
  return model2s;
}

/**
 * Where a train starts: its first corner, once `Think_SetupTrainTargets` has linked every corner
 * in a ring (`g_mover.c:1349-1394`), and `Reached_Train` has found a corner after it. Short of
 * that the train never leaves where `InitMover` put it, the origin, and nothing is returned.
 */
function trainStart(
  spawned: readonly SpawnVars[],
  train: SpawnVars,
  find: (targetname: string, from?: number) => number
): Vec | undefined {
  const first = find(spawnVar(train, 'target')!);
  if (first < 0) return undefined;
  const nextCorner = new Map<number, number>();
  for (let path = first; !nextCorner.has(path); ) {
    const target = spawnVar(spawned[path], 'target');
    if (target === undefined) return undefined;
    // The first `path_corner` among the corner's targets, matched exactly as `strcmp` matches.
    let next = find(target);
    while (next >= 0 && spawnVar(spawned[next], 'classname') !== 'path_corner') {
      next = find(target, next + 1);
    }
    if (next < 0) return undefined;
    nextCorner.set(path, next);
    path = next;
  }
  return placement(spawned[first]).origin;
}
