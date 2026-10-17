import { CONFIGSTRING } from '../net/commands';
import { MAX_CLIENTS } from '../net/protocol';
import { f } from './cm/q-math';
import { FL } from './constants';
import type { GameEntity } from './game-entity';
import type { Level } from './level';
import { addRemap, buildShaderStateConfig } from './shader-remap';

/**
 * A map's entities reach one another by name: one's `target` is another's `targetname`.
 * `g_utils.c` finds them by it, either to fire every one or to face one of them. Entities that
 * share a `team` are grouped the same way, by `G_FindTeams` (`g_main.c`), which is what a set of
 * items at one spot and a set of movers on one path are made of.
 */

/** `MAXCHOICES` (`g_utils.c:190`): how many of a name {@link pickTarget} will choose among. */
export const MAX_CHOICES = 32;

/**
 * `G_PickTarget` (`g_utils.c:192–221`): one of the entities this name finds, at random.
 *
 * Only the first {@link MAX_CHOICES} are in the running. Quake 3 takes one by `rand() % n`,
 * and the port's `random()` is a fraction, so it is scaled to the count instead.
 *
 * @param level - Whose entities to look through.
 * @param targetname - The name to find them by.
 * @param random - A fraction in [0, 1).
 * @param print - Where `G_Printf` goes.
 * @returns the entity, or null, with a line printed, when nothing has the name
 */
export function pickTarget(
  level: Level,
  targetname: string | null,
  random: () => number,
  print: (text: string) => void
): GameEntity | null {
  if (targetname === null) {
    print('G_PickTarget called with NULL targetname');
    return null;
  }

  const choices: GameEntity[] = [];
  for (let entity = level.find(null, 'targetname', targetname); entity; ) {
    choices.push(entity);
    if (choices.length === MAX_CHOICES) break;
    entity = level.find(entity, 'targetname', targetname);
  }

  if (choices.length === 0) {
    print(`G_PickTarget: target ${targetname} not found`);
    return null;
  }

  return choices[Math.floor(random() * choices.length)];
}

/**
 * `G_UseTargets` (`g_utils.c:235–266`): fire everything this entity's `target` names.
 *
 * First, an entity carrying a pair of shaders swaps them, with or without a target, and every
 * client is sent the level's swaps (`shader-remap.ts`). Then each target found is used in turn,
 * and one that has no `use` is stepped over. An entity that names itself is not used, and one
 * that is freed by what it fired stops the firing there.
 *
 * @param level - Whose entities to look through.
 * @param entity - What is firing, or null for nothing.
 * @param activator - Who set it off: a spawning player, for a spawn spot's; null for no one, as
 *   for a train's corner.
 * @param print - Where `G_Printf` goes.
 */
export function useTargets(
  level: Level,
  entity: GameEntity | null,
  activator: GameEntity | null,
  print: (text: string) => void
): void {
  if (entity === null) return;

  const { targetShaderName, targetShaderNewName } = entity;
  if (targetShaderName !== null && targetShaderNewName !== null) {
    // `level.time * 0.001`, in the QVM's floats.
    const seconds = f(f(level.time) * f(0.001));
    addRemap(level.shaderRemaps, targetShaderName, targetShaderNewName, seconds);
    const state = buildShaderStateConfig(level.shaderRemaps, print);
    level.setConfigstring(CONFIGSTRING.SHADERSTATE, state);
  }

  if (entity.target === null) return;

  for (let target = level.find(null, 'targetname', entity.target); target; ) {
    if (target === entity) {
      print('WARNING: Entity used itself.');
    } else {
      target.use?.(target, entity, activator);
    }
    if (!entity.inuse) {
      print('entity was removed while using targets');
      return;
    }
    target = level.find(target, 'targetname', entity.target);
  }
}

/**
 * `G_FindTeams` (`g_main.c:262–316`): chain together the entities that share a `team`, so that a
 * map can place a set of items at one spot or a set of movers on one path and mean the set.
 *
 * The first of a team is its master; the rest are marked {@link FL.TEAMMEMBER} and point at it,
 * and the master's chain runs back through them. A member's `targetname` moves to the master,
 * because it is the one a target should reach: firing any member fires the group.
 *
 * Item groups use the chain at respawn time and mover groups at their first move, so only the
 * linking is here.
 *
 * @param level - Whose entities to chain.
 * @param print - Where `G_Printf` goes.
 */
export function findTeams(level: Level, print: (text: string) => void): void {
  let teams = 0;
  let entities = 0;

  for (let i = MAX_CLIENTS; i < level.numEntities; i++) {
    const first = level.gentities[i];
    if (!first.inuse || first.team === null || first.flags & FL.TEAMMEMBER) continue;

    first.teammaster = first;
    teams++;
    entities++;

    for (let j = i + 1; j < level.numEntities; j++) {
      const member = level.gentities[j];
      if (!member.inuse || member.team === null || member.flags & FL.TEAMMEMBER) continue;
      if (first.team !== member.team) continue;

      entities++;
      member.teamchain = first.teamchain;
      first.teamchain = member;
      member.teammaster = first;
      member.flags |= FL.TEAMMEMBER;

      // A target should find the master rather than this one, so the name moves to it.
      if (member.targetname !== null) {
        first.targetname = member.targetname;
        member.targetname = null;
      }
    }
  }

  print(`${teams} teams with ${entities} entities`);
}
