import { atof, atoi } from '../formats/c-scan';
import {
  parseSpawnVars,
  parseVector,
  spawnInt,
  spawnString,
  spawnVar,
  type EntityTokens,
  type SpawnVars
} from '../formats/entity-text';
import { FL, GT } from './constants';
import { setEntityOrigin, type GameEntity } from './game-entity';
import { spawnItem } from './item-spawn';
import { spawnJumpPad, spawnTargetPush } from './jump-pad';
import { ARMOR_TIER, armorKind, findItem, IT } from './items';
import type { Level } from './level';
import { spawnFuncBobbing, spawnFuncPendulum, spawnFuncRotating } from './cyclic-movers';
import { spawnFuncButton, spawnFuncDoor, spawnFuncPlat, spawnFuncStatic } from './movers';
import { spawnPortalCamera, spawnPortalSurface } from './portals';
import { spawnShooter } from './shooters';
import {
  spawnTargetDelay,
  spawnTargetGive,
  spawnTargetKill,
  spawnTargetLaser,
  spawnTargetLocation,
  spawnTargetPrint,
  spawnTargetRelay,
  spawnTargetRemovePowerups,
  spawnTargetScore,
  spawnTargetSpeaker
} from './target-entities';
import { spawnTargetTeleporter, spawnTriggerTeleport } from './teleport';
import {
  spawnFuncTimer,
  spawnTriggerAlways,
  spawnTriggerHurt,
  spawnTriggerMultiple
} from './triggers';
import { spawnFuncTrain, spawnPathCorner } from './trains';
import { copy, vec3 } from './vec3';
import { WP } from './weapons/constants';

/**
 * A map's entities, spawned: `g_spawn.c`'s loop, its `fields[]` and its `spawns[]`.
 *
 * The text arrives a token at a time through `trap_GetEntityToken`, and each entity is spawned as
 * soon as its block is read. The first block is the world's, and the game module handles it
 * itself (`SP_worldspawn`), since what it sets is the match's rather than any entity's.
 *
 * The spawn table holds all of baseq3's; a classname it has not got is freed with Q3's message.
 *
 * Engine-free, like the rest of the game module.
 */

/** How an entity of one classname comes into the world: a `spawns[]` entry's function. */
type SpawnFunction = (entity: GameEntity, vars: SpawnVars, level: Level) => void;

/**
 * `gametypeNames` (`g_spawn.c:400`): the names the `gametype` key is matched against.
 *
 * Clan Arena reads the key as team deathmatch: CPMA's game module holds no name of its own for it,
 * and a Quake 3 map names only Quake 3's modes.
 */
const GAMETYPE_NAMES = [
  'ffa',
  'tournament',
  'single',
  'team',
  'ctf',
  'oneflag',
  'obelisk',
  'harvester',
  'team'
];

/**
 * `fields[]` (`g_spawn.c:92–114`): the keys copied straight onto an entity before its spawn
 * function runs. Any other key is the spawn function's to read, or no one's. `F_FLOAT`,
 * `F_VECTOR` and `F_ANGLEHACK` store C floats.
 */
const FIELDS = new Map<string, (entity: GameEntity, value: string) => void>([
  ['classname', (entity, value) => (entity.classname = newString(value))],
  ['origin', (entity, value) => (entity.s.origin = parseVector(value))],
  ['model', (entity, value) => (entity.model = newString(value))],
  ['model2', (entity, value) => (entity.model2 = newString(value))],
  ['spawnflags', (entity, value) => (entity.spawnflags = atoi(value))],
  ['speed', (entity, value) => (entity.speed = Math.fround(atof(value)))],
  ['target', (entity, value) => (entity.target = newString(value))],
  ['targetname', (entity, value) => (entity.targetname = newString(value))],
  ['message', (entity, value) => (entity.message = newString(value))],
  ['team', (entity, value) => (entity.team = newString(value))],
  ['wait', (entity, value) => (entity.wait = Math.fround(atof(value)))],
  ['random', (entity, value) => (entity.random = Math.fround(atof(value)))],
  ['count', (entity, value) => (entity.count = atoi(value))],
  ['health', (entity, value) => (entity.health = atoi(value))],
  ['dmg', (entity, value) => (entity.damage = atoi(value))],
  ['angles', (entity, value) => (entity.s.angles = parseVector(value))],
  // `F_ANGLEHACK`: a yaw alone, which throws away any pitch and roll an `angles` before it set.
  ['angle', (entity, value) => (entity.s.angles = vec3(0, Math.fround(atof(value)), 0))],
  ['targetshadername', (entity, value) => (entity.targetShaderName = newString(value))],
  ['targetshadernewname', (entity, value) => (entity.targetShaderNewName = newString(value))]
]);

/** `SP_info_player_deathmatch` (`g_client.c:37–48`): a spawn spot, closed to bots or to humans. */
const spawnSpot: SpawnFunction = (entity, vars) => {
  if (spawnInt(vars, 'nobots', '0')) entity.flags |= FL.NO_BOTS;
  if (spawnInt(vars, 'nohumans', '0')) entity.flags |= FL.NO_HUMANS;
};

/** A point that stays where the map put it, for something to aim at: `G_SetOrigin`. */
const point: SpawnFunction = (entity) => setEntityOrigin(entity, entity.s.origin);

/** What Q3 frees the moment it is spawned, since the compiler has already used it. */
const free: SpawnFunction = (entity, _vars, level) => level.freeEntity(entity);

/** Nothing to do: the entity is found by its classname later. */
const nothing: SpawnFunction = () => {};

/** `spawns[]` (`g_spawn.c:184–258`), as far as the port spawns it. Matched by exact name. */
const SPAWNS = new Map<string, SpawnFunction>([
  [
    // `SP_info_player_start` (`g_client.c:53–56`).
    'info_player_start',
    (entity, vars, level) => {
      entity.classname = 'info_player_deathmatch';
      spawnSpot(entity, vars, level);
    }
  ],
  ['info_player_deathmatch', spawnSpot],
  ['info_player_intermission', nothing],
  // CTF's four, whose spawn functions in Quake 3 are empty (`g_team.c:1165–1195`): a team spot is
  // nothing but a classname, an origin and an angle, and `SelectRandomTeamSpawnPoint` finds it by
  // walking the entities. The first two are where a side starts a match, the last two where it
  // comes back.
  ['team_CTF_redplayer', nothing],
  ['team_CTF_blueplayer', nothing],
  ['team_CTF_redspawn', nothing],
  ['team_CTF_bluespawn', nothing],
  // `g_misc.c:36–55`.
  ['info_null', free],
  ['info_notnull', point],
  ['info_camp', point],
  ['func_group', free],
  // `g_target.c:419–421`.
  ['target_position', point],
  // `g_misc.c:65–67`, `:141–154`.
  ['light', free],
  ['misc_model', free],
  ['item_botroam', nothing],
  // `g_trigger.c:199–213`: a jump pad, which arms itself a frame later against its target.
  ['trigger_push', (entity, _vars, level) => spawnJumpPad(level, entity)],
  // `g_trigger.c:242–261`: a push something else fires, along its angle or at a target.
  ['target_push', (entity, _vars, level) => spawnTargetPush(level, entity)],
  // `g_trigger.c:305–323`: a brush that teleports whoever walks into it.
  ['trigger_teleport', (entity, _vars, level) => spawnTriggerTeleport(level, entity)],
  // `g_target.c:362–367`: a teleport something else fires.
  ['target_teleporter', (entity, _vars, level) => spawnTargetTeleporter(level, entity)],
  // `g_misc.c:132–133`: where a teleporter lands a player, found by its name and never linked.
  ['misc_teleporter_dest', nothing],
  // The rest of `g_trigger.c`: brushes that fire their targets or hurt, and the timer.
  ['trigger_multiple', (entity, vars, level) => spawnTriggerMultiple(level, entity, vars)],
  ['trigger_always', (entity, _vars, level) => spawnTriggerAlways(level, entity)],
  ['trigger_hurt', (entity, _vars, level) => spawnTriggerHurt(level, entity)],
  ['func_timer', (entity, vars, level) => spawnFuncTimer(level, entity, vars)],
  // The rest of `g_target.c`.
  ['target_give', (entity, _vars, level) => spawnTargetGive(level, entity)],
  ['target_remove_powerups', (entity, _vars, level) => spawnTargetRemovePowerups(level, entity)],
  ['target_delay', (entity, vars, level) => spawnTargetDelay(level, entity, vars)],
  ['target_speaker', (entity, vars, level) => spawnTargetSpeaker(level, entity, vars)],
  ['target_print', (entity, _vars, level) => spawnTargetPrint(level, entity)],
  ['target_laser', (entity, _vars, level) => spawnTargetLaser(level, entity)],
  ['target_score', (entity, _vars, level) => spawnTargetScore(level, entity)],
  ['target_relay', (entity, _vars, level) => spawnTargetRelay(level, entity)],
  ['target_kill', (entity, _vars, level) => spawnTargetKill(level, entity)],
  ['target_location', (entity, _vars, level) => spawnTargetLocation(level, entity)],
  // `g_misc.c:158–238`: a portal, and the camera it shows the view from.
  ['misc_portal_surface', (entity, _vars, level) => spawnPortalSurface(level, entity)],
  ['misc_portal_camera', (entity, vars, level) => spawnPortalCamera(level, entity, vars)],
  // `g_misc.c:315–337`: launchers that fire when fired.
  ['shooter_rocket', (entity, _vars, level) => spawnShooter(level, entity, WP.ROCKET_LAUNCHER)],
  ['shooter_grenade', (entity, _vars, level) => spawnShooter(level, entity, WP.GRENADE_LAUNCHER)],
  ['shooter_plasma', (entity, _vars, level) => spawnShooter(level, entity, WP.PLASMAGUN)],
  // `g_mover.c:948–1242, 1474–1479`: the binary movers, and the one that stands still.
  ['func_door', (entity, vars, level) => spawnFuncDoor(level, entity, vars)],
  ['func_plat', (entity, vars, level) => spawnFuncPlat(level, entity, vars)],
  ['func_button', (entity, vars, level) => spawnFuncButton(level, entity, vars)],
  ['func_static', (entity, vars, level) => spawnFuncStatic(level, entity, vars)],
  // `g_mover.c:1404–1457, 1502–1633`: trains and their corners, and the movers that never stop.
  ['func_train', (entity, vars, level) => spawnFuncTrain(level, entity, vars)],
  ['path_corner', (entity, _vars, level) => spawnPathCorner(level, entity)],
  ['func_rotating', (entity, vars, level) => spawnFuncRotating(level, entity, vars)],
  ['func_bobbing', (entity, vars, level) => spawnFuncBobbing(level, entity, vars)],
  ['func_pendulum', (entity, vars, level) => spawnFuncPendulum(level, entity, vars)]
]);

/**
 * `G_NewString` (`g_spawn.c:305–330`): a value as the entity keeps it, with `\n` made a line
 * break. A backslash before anything else stays a backslash, and that character is dropped.
 */
export function newString(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') {
      i++;
      out += value[i] === 'n' ? '\n' : '\\';
    } else {
      out += value[i];
    }
  }
  return out;
}

/**
 * `G_SpawnEntitiesFromString` (`g_spawn.c:623–642`): read the map's entities and spawn each.
 *
 * @param next - `trap_GetEntityToken`.
 * @param spawnWorld - `SP_worldspawn`, handed the first block.
 * @param spawnEntity - `G_SpawnGEntityFromSpawnVars`, handed each block after it.
 * @throws with Q3's `G_Error` for a text with no entities, and as {@link parseSpawnVars} does
 */
export function spawnEntitiesFromString(
  next: EntityTokens,
  spawnWorld: (vars: SpawnVars) => void,
  spawnEntity: (vars: SpawnVars) => void
): void {
  const world = parseSpawnVars(next);
  if (!world) throw new Error('SpawnEntities: no entities');
  spawnWorld(world);
  for (let vars = parseSpawnVars(next); vars; vars = parseSpawnVars(next)) spawnEntity(vars);
}

/**
 * The check `SP_worldspawn` opens with (`g_spawn.c:567–570`): the first block is the world's.
 *
 * @throws with Q3's `G_Error` when it is not
 */
export function checkWorldspawn(vars: SpawnVars): void {
  if (spawnString(vars, 'classname', '').toLowerCase() !== 'worldspawn') {
    throw new Error("SP_worldspawn: The first entity isn't 'worldspawn'");
  }
}

/**
 * `G_SpawnGEntityFromSpawnVars` (`g_spawn.c:397–473`): spawn one entity from its pairs.
 *
 * The pairs are copied on, the gametype keys may free the entity at once, and then its classname
 * decides what it is.
 *
 * @param level - Where the entity goes.
 * @param vars - Its pairs.
 * @param gametype - `g_gametype`, which the filter keys are read against.
 * @param print - `G_Printf`, for a classname with no spawn function.
 */
export function spawnEntityFromVars(
  level: Level,
  vars: SpawnVars,
  gametype: number,
  print: (text: string) => void
): void {
  const entity = level.spawnEntity();
  for (const [key, value] of vars) FIELDS.get(key.toLowerCase())?.(entity, value);

  if (!inGametype(vars, gametype)) {
    level.freeEntity(entity);
    return;
  }
  const item = findItem(entity.classname);
  // Clan Arena stands no item on the map: every weapon comes with the spawn.
  if (gametype === GT.CA && item) {
    level.freeEntity(entity);
    return;
  }
  // The green armour gives the green tier, so it stands only while the rules have tiers. Without
  // them it is CPMA's, which baseq3's table has not got.
  const green = item?.giType === IT.ARMOR && armorKind(item.quantity) === ARMOR_TIER.GA;
  if (green && !level.rules.armor_tiered) {
    print(`${entity.classname} doesn't have a spawn function`);
    level.freeEntity(entity);
    return;
  }

  // "move editor origin to pos".
  entity.s.pos.trBase = copy(entity.s.origin);
  entity.r.currentOrigin = copy(entity.s.origin);

  if (!callSpawn(entity, vars, level, print)) level.freeEntity(entity);
}

/**
 * The gametype keys (`g_spawn.c:410–463`): whether an entity is in this gametype.
 *
 * `notsingle` removes it from Single Player, `notteam` from the team games, `notfree` from the
 * rest, and `notq3a` from Quake 3 itself. `gametype` keeps it only in the gametypes whose names
 * are in the value, found by substring, so `"ffa tournament"` and `"xffax"` both keep it in FFA.
 */
export function inGametype(vars: SpawnVars, gametype: number): boolean {
  if (gametype === GT.SINGLE_PLAYER && spawnInt(vars, 'notsingle', '0')) return false;
  if (gametype >= GT.TEAM ? spawnInt(vars, 'notteam', '0') : spawnInt(vars, 'notfree', '0')) {
    return false;
  }
  if (spawnInt(vars, 'notq3a', '0')) return false;

  const value = spawnVar(vars, 'gametype');
  if (value !== undefined && gametype >= GT.FFA && gametype < GT.MAX_GAME_TYPE) {
    return value.includes(GAMETYPE_NAMES[gametype]);
  }
  return true;
}

/**
 * `G_CallSpawn` (`g_spawn.c:268–295`): run the spawn function for the entity's classname.
 *
 * Q3 looks through the item list first, and the port does too: a map names an item by the same
 * `classname` the table holds, so `weapon_railgun` is an item before it is anything else. The
 * match is exact, as Q3's `strcmp` is.
 *
 * @returns whether there was one
 */
function callSpawn(
  entity: GameEntity,
  vars: SpawnVars,
  level: Level,
  print: (text: string) => void
): boolean {
  const item = findItem(entity.classname);
  if (item) {
    spawnItem(level, entity, item, vars);
    return true;
  }

  const spawn = SPAWNS.get(entity.classname);
  if (!spawn) {
    print(`${entity.classname} doesn't have a spawn function`);
    return false;
  }
  spawn(entity, vars, level);
  return true;
}
