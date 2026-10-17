import { entityTokens } from '../formats/entity-text';
import type { PlayerState } from '../net/protocol';
import { CON } from './client';
import { triggerBsp } from './cm/collision-test-fixtures';
import { loadMap } from './cm/cm-load';
import { CONTENTS, GT } from './constants';
import type { GameEntity } from './game-entity';
import { DEFAULT_ITEM_MATCH } from './item-touch';
import { Level, type LevelHandlers } from './level';
import { mapOf, type TestEntity } from './map-test-fixtures';
import { spawnEntitiesFromString, spawnEntityFromVars } from './spawn';
import { createIdlePlayerState } from './types';
import { copy, vec3, type Vec3 } from './vec3';

/**
 * Levels for the tests of what a map's triggers and targets do: the trigger map's world, whose
 * inline model 1 is a brush from (0 0 0) to (64 64 16) with a corner cut off, a game module's
 * calls recorded, and clients to set them off.
 */

/** What a level's game module was asked to do, in order. */
export interface LevelRecord {
  prints: string[];
  /** Each sound registered, its index one more than its place here. */
  sounds: string[];
  /** Each `trap_SendServerCommand`, to a client or to everyone (null). */
  commands: [number | null, string][];
  configstrings: Map<number, string>;
  /** Each `AddScore`: the entity's number and the points. */
  scores: [number, number][];
}

/** A record with nothing in it yet. */
export function newRecord(): LevelRecord {
  return { prints: [], sounds: [], commands: [], configstrings: new Map(), scores: [] };
}

/**
 * A level on the trigger map, with the links a level with no host has, recording into `record`.
 *
 * @param record - Where the level's prints, sounds, commands, configstrings and scores go.
 * @param random - The game's `random()`, 0.5 by default, which `crandom()` makes 0.
 * @param handlers - Handlers to add or replace: a trace, for one.
 */
export function recordingLevel(
  record: LevelRecord = newRecord(),
  random: () => number = () => 0.5,
  handlers: LevelHandlers = {}
): Level {
  const world = new Level({
    handlers: {
      setConfigstring: (index, value) => record.configstrings.set(index, value),
      sendServerCommand: (clientNum, text) => record.commands.push([clientNum, text]),
      ...handlers
    },
    clipMap: loadMap(triggerBsp(), 'maps/test.bsp')
  });
  world.itemMatch = {
    ...DEFAULT_ITEM_MATCH,
    random,
    print: (text) => record.prints.push(text),
    soundIndex: (name) => {
      if (!record.sounds.includes(name)) record.sounds.push(name);
      return record.sounds.indexOf(name) + 1;
    },
    addScore: (entity, _origin, score) => record.scores.push([entity.s.number, score])
  };
  return world;
}

/** These entities spawned into `world`, after a world's block, in `gametype`. */
export function spawnInto(
  world: Level,
  entities: readonly TestEntity[],
  record?: LevelRecord,
  gametype: number = GT.FFA
): Level {
  spawnEntitiesFromString(
    entityTokens(mapOf(...entities)),
    () => {},
    (vars) => spawnEntityFromVars(world, vars, gametype, (text) => record?.prints.push(text))
  );
  return world;
}

/** A recording level with these entities spawned into it. */
export function spawnedLevel(
  entities: readonly TestEntity[],
  record: LevelRecord = newRecord(),
  random?: () => number
): Level {
  return spawnInto(recordingLevel(record, random), entities, record);
}

/**
 * A connected client in `slot` standing at `origin`, in the world and able to be hurt, with the
 * box a standing player has. Inside the trigger brush is (32 32 20).
 */
export function clientAt(
  world: Level,
  slot: number,
  origin: Vec3,
  overrides: Partial<PlayerState> = {}
): GameEntity {
  const entity = world.gentities[slot];
  world.initEntity(entity, slot);
  entity.client = world.clients[slot];
  entity.client.ps = createIdlePlayerState({ origin: copy(origin), clientNum: slot, ...overrides });
  entity.client.pers.connected = CON.CONNECTED;
  entity.s.clientNum = slot;
  entity.classname = 'player';
  entity.takedamage = true;
  entity.health = 100;
  entity.r.contents = CONTENTS.BODY;
  entity.r.mins = vec3(-15, -15, -24);
  entity.r.maxs = vec3(15, 15, 32);
  entity.r.currentOrigin = copy(origin);
  world.linkEntity(entity);
  return entity;
}

/** A firing, as a target that records them saw it: numbers, the activator's null for no one. */
export interface Firing {
  other: number;
  activator: number | null;
}

/**
 * An entity named `targetname` whose use records who fired it and for whom.
 *
 * @returns the firings, in order
 */
export function useRecorder(world: Level, targetname: string): Firing[] {
  const fired: Firing[] = [];
  const entity = world.spawnEntity();
  entity.classname = 'test_recorder';
  entity.targetname = targetname;
  entity.use = (_self, other, activator) =>
    fired.push({ other: other.s.number, activator: activator?.s.number ?? null });
  return fired;
}

/** Run the level's frames from the frame after its time up to `until`, `step` ms apart. */
export function runUntil(world: Level, until: number, step = 8): void {
  for (let time = world.time + step; time <= until; time += step) world.runFrame(time);
}
