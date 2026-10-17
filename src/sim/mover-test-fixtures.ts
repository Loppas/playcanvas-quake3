import { entityTokens } from '../formats/entity-text';
import { createClipTrace } from './clip-trace';
import { boxesBsp } from './cm/collision-test-fixtures';
import { loadMap } from './cm/cm-load';
import type { ClipMap } from './cm/cm-local';
import type { Vec3f } from './cm/q-math';
import { GT } from './constants';
import { DEFAULT_ITEM_MATCH } from './item-touch';
import { Level, type LevelHandlers } from './level';
import { mapOf, type TestEntity } from './map-test-fixtures';
import { runMover } from './mover-push';
import { spawnEntitiesFromString, spawnEntityFromVars } from './spawn';
import { findTeams } from './targets';

/**
 * Levels for the movers' tests: a solid floor with its top at z 0 and boxes for the map's brush
 * models (`boxesBsp`), linked into the level's own world, with the frame running its movers and
 * the game module's calls recorded.
 */

/** What a level's game module was asked to do, in order. */
export interface MoverRecord {
  prints: string[];
  /** Each sound registered, its index one more than its place here. */
  sounds: string[];
  /** Each model registered, its index one more than its place here. */
  models: string[];
  /** Each `trap_AdjustAreaPortalState`, by the entity's number. */
  portals: { number: number; open: boolean }[];
}

/** A record with nothing in it yet. */
export function newMoverRecord(): MoverRecord {
  return { prints: [], sounds: [], models: [], portals: [] };
}

/** A name's index in a list it is put on once, from 1. */
function indexIn(list: string[], name: string): number {
  if (!list.includes(name)) list.push(name);
  return list.indexOf(name) + 1;
}

/**
 * A level on a floor with these boxes for its brush models, with these entities spawned and their
 * teams chained, as `G_InitGame` leaves a map, at time 0. Its portal calls are recorded.
 *
 * @param boxes - Model `i + 1`'s brush, by its mins and maxs.
 * @param handlers - Handlers to add or replace.
 */
export function moverLevel(
  boxes: readonly (readonly [Vec3f, Vec3f])[],
  entities: readonly TestEntity[],
  record: MoverRecord = newMoverRecord(),
  handlers: LevelHandlers = {}
): Level {
  return moverLevelOn(loadMap(boxesBsp(boxes), 'maps/test.bsp'), entities, record, {
    adjustAreaPortalState: (entity, open) => {
      record.portals.push({ number: entity.s.number, open });
    },
    ...handlers
  });
}

/**
 * {@link moverLevel} over a clip map of the test's own, whose portals the level's own world opens
 * and closes.
 */
export function moverLevelOn(
  cm: ClipMap,
  entities: readonly TestEntity[],
  record: MoverRecord = newMoverRecord(),
  handlers: LevelHandlers = {}
): Level {
  const level: Level = new Level({
    handlers: {
      trace: createClipTrace(cm),
      runMover: (mover) => runMover(level, mover),
      ...handlers
    },
    clipMap: cm
  });
  level.itemMatch = {
    ...DEFAULT_ITEM_MATCH,
    print: (text) => record.prints.push(text),
    soundIndex: (name) => indexIn(record.sounds, name),
    modelIndex: (name) => indexIn(record.models, name)
  };
  const print = (text: string) => record.prints.push(text);
  spawnEntitiesFromString(
    entityTokens(mapOf(...entities)),
    () => {},
    (vars) => spawnEntityFromVars(level, vars, GT.FFA, print)
  );
  findTeams(level, print);
  return level;
}
