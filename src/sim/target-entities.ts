import { spawnFloat, spawnVar, type SpawnVars } from '../formats/entity-text';
import { CONFIGSTRING } from '../net/commands';
import { CON } from './client';
import { f, vectorMA, vectorNormalize, vectorSubtract } from './cm/q-math';
import { DAMAGE_NO_KNOCKBACK, DAMAGE_NO_PROTECTION, damage } from './combat';
import { CONTENTS, MOD, TEAM } from './constants';
import { EV } from './events';
import { addEvent, ET, setEntityOrigin, setMovedir, SVF, type GameEntity } from './game-entity';
import { FRAMETIME } from './item-spawn';
import { touchItem } from './item-touch';
import { PW } from './items';
import type { Level } from './level';
import { pickTarget, useTargets } from './targets';
import { teamReturnFlag } from './team';
import { TELEFRAG_DAMAGE } from './teleport';
import { thinkTimeAfter } from './think-time';
import { copy, vec3, vtos } from './vec3';

/**
 * `g_target.c`'s targets: entities with no shape that do one thing when something fires them by
 * their `targetname` — a trigger, a timer, an item's pickup, a spawn, another target. The
 * teleporter and the push are with the things they share their work with.
 *
 * What fired a target is its `other`, and who set the chain off its `activator`, which is how a
 * target gives, prints or kills a player at the end of a chain of delays and relays.
 *
 * A train's corner fires its targets with no activator. Quake 3's QVM reads whatever lies near
 * address 0 for one; here it is no one, with no client, so a target that acts on a player does
 * nothing, and the rest pass the null on.
 */

/** `target_print`'s spawnflags (`g_target.c:138`): to one side's players, or the activator's. */
export const PRINT_RED_TEAM = 1;
export const PRINT_BLUE_TEAM = 2;
export const PRINT_PRIVATE = 4;

/** `target_speaker`'s spawnflags (`g_target.c:169`). */
export const SPEAKER_LOOPED_ON = 1;
export const SPEAKER_LOOPED_OFF = 2;
export const SPEAKER_GLOBAL = 4;
export const SPEAKER_ACTIVATOR = 8;

/** `MAX_QPATH` (`q_shared.h:246`): a speaker's sound path is cut to one less. */
export const MAX_QPATH = 64;

/** `target_laser`'s spawnflag 1: it starts on. */
export const LASER_START_ON = 1;

/** A laser's damage at each hit when the map gives no `dmg` (`g_target.c:325–327`). */
export const LASER_DAMAGE = 1;

/** How far a laser reaches (`g_target.c:268`). */
export const LASER_RANGE = 2048;

/** `target_relay`'s spawnflags (`g_target.c:372`). */
export const RELAY_RED_ONLY = 1;
export const RELAY_BLUE_ONLY = 2;
export const RELAY_RANDOM = 4;

/** How long `target_location` waits before numbering the locations: "Let them all spawn first". */
export const LOCATION_LINKUP_DELAY = 200;

/**
 * `SP_target_give` (`g_target.c:27–58`): give whoever set it off every item its `target` names, as
 * if they had picked each up, and take each out of the world for good.
 *
 * Such an item is never in the world to begin with: one with a `targetname` stands hidden from its
 * spawn.
 */
export function spawnTargetGive(level: Level, self: GameEntity): void {
  self.use = (it, _other, activator) => {
    if (!activator?.client) return;
    if (it.target === null) return;

    for (let t = level.find(null, 'targetname', it.target); t; ) {
      if (t.item) {
        touchItem(level, t, activator);
        // "make sure it isn't going to respawn or show any events".
        t.nextthink = 0;
        level.unlinkEntity(t);
      }
      t = level.find(t, 'targetname', it.target);
    }
  };
}

/**
 * `SP_target_remove_powerups` (`g_target.c:63–85`): take every powerup from whoever set it off, a
 * flag sent home first. A map puts one under its drops, so a flyer falls.
 *
 * One Flag CTF's neutral flag, the third Quake 3 sends home, is not one baseq3 hands out.
 */
export function spawnTargetRemovePowerups(level: Level, self: GameEntity): void {
  self.use = (_it, _other, activator) => {
    const client = activator?.client;
    if (!client) return;

    const { powerups } = client.ps;
    if (powerups[PW.REDFLAG]) {
      teamReturnFlag(level, TEAM.RED);
    } else if (powerups[PW.BLUEFLAG]) {
      teamReturnFlag(level, TEAM.BLUE);
    }
    powerups.fill(0);
  };
}

/**
 * `SP_target_delay` (`g_target.c:104–114`): fire its targets `wait` seconds after it is fired,
 * give or take `random`. An older map's `delay` is read in place of `wait`, and no wait at all is
 * a second. A second use before it fires puts the firing back.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 * @param vars - The pairs, for `delay` and `wait`.
 */
export function spawnTargetDelay(level: Level, self: GameEntity, vars: SpawnVars): void {
  // "check delay for backwards compatibility".
  if (spawnVar(vars, 'delay') !== undefined) {
    self.wait = spawnFloat(vars, 'delay', '0');
  } else {
    self.wait = spawnFloat(vars, 'wait', '1');
  }
  if (!self.wait) self.wait = 1;

  // `Use_Target_Delay` and `Think_Target_Delay` (`g_target.c:94–102`).
  self.use = (it, _other, activator) => {
    it.nextthink = thinkTimeAfter(level, it.wait, it.random);
    it.think = (delay) => useTargets(level, delay, delay.activator, level.itemMatch.print);
    it.activator = activator;
  };
}

/**
 * `SP_target_score` (`g_target.c:128–133`): `count` points to whoever set it off, 1 if the map
 * gives none, as a frag is scored.
 */
export function spawnTargetScore(level: Level, self: GameEntity): void {
  if (!self.count) self.count = 1;
  self.use = (it, _other, activator) => {
    if (activator) level.itemMatch.addScore(activator, it.r.currentOrigin, it.count);
  };
}

/**
 * `SP_target_print` (`g_target.c:161–163`): put its `message` in the middle of the screen: to the
 * player who set it off if it is private, to a side's players, or to everyone.
 *
 * A private print set off by something other than a player goes to whoever the other flags say.
 * A print with no `message` prints `<NULL>`, as the QVM's `va` writes a null string.
 */
export function spawnTargetPrint(level: Level, self: GameEntity): void {
  // `Use_Target_Print` (`g_target.c:142–159`).
  self.use = (it, _other, activator) => {
    const command = `cp "${it.message ?? '<NULL>'}"`;
    if (activator?.client && it.spawnflags & PRINT_PRIVATE) {
      level.sendServerCommand(activator.s.number, command);
      return;
    }

    if (it.spawnflags & (PRINT_RED_TEAM | PRINT_BLUE_TEAM)) {
      if (it.spawnflags & PRINT_RED_TEAM) teamCommand(level, TEAM.RED, command);
      if (it.spawnflags & PRINT_BLUE_TEAM) teamCommand(level, TEAM.BLUE, command);
      return;
    }

    level.sendServerCommand(null, command);
  };
}

/** `G_TeamCommand` (`g_utils.c:134–144`): a command to every connected player on one side. */
function teamCommand(level: Level, team: number, command: string): void {
  for (let i = 0; i < level.maxclients; i++) {
    const client = level.clients[i];
    if (client.pers.connected !== CON.CONNECTED) continue;
    if (client.sess.sessionTeam === team) level.sendServerCommand(i, command);
  }
}

/**
 * `SP_target_speaker` (`g_target.c:198–245`): a sound in the world, sent to the clients as an
 * `ET_SPEAKER` that carries it.
 *
 * Fired, it plays its sound once where it stands, everywhere at full volume if it is global, or on
 * whoever set it off if it is the activator's; a looping one is turned on or off instead, and
 * ignores the other two. A sound that starts with `*` is a player's own, and always the
 * activator's. A speaker that repeats is the client's to play (`CG_Speaker`), from the frame and
 * the `clientNum` its wait and its random are sent in, in tenths of a second.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 * @param vars - The pairs, for `noise`, `wait` and `random`.
 * @throws with Q3's `G_Error` for a speaker with no `noise`
 */
export function spawnTargetSpeaker(level: Level, self: GameEntity, vars: SpawnVars): void {
  const { print, soundIndex } = level.itemMatch;
  self.wait = spawnFloat(vars, 'wait', '0');
  self.random = spawnFloat(vars, 'random', '0');

  const noise = spawnVar(vars, 'noise');
  if (noise === undefined) {
    throw new Error(`target_speaker without a noise key at ${vtos(self.s.origin)}`);
  }

  // "force all client relative sounds to be "activator" speakers that play on the entity that
  // activates it".
  if (noise[0] === '*') self.spawnflags |= SPEAKER_ACTIVATOR;

  // `.wav` is added by a case-sensitive search, and the path cut to fit `MAX_QPATH`, which
  // `Com_sprintf` says it has done.
  let path = noise;
  if (!noise.includes('.wav')) {
    path = `${noise}.wav`;
    if (path.length >= MAX_QPATH) {
      print(
        `Com_sprintf: Output length ${MAX_QPATH} too short, require ${path.length + 1} bytes.`
      );
    }
  }
  self.noiseIndex = soundIndex(path.slice(0, MAX_QPATH - 1));

  // "a repeating speaker can be done completely client side".
  self.s.eType = ET.SPEAKER;
  self.s.eventParm = self.noiseIndex;
  self.s.frame = Math.trunc(f(self.wait * 10));
  self.s.clientNum = Math.trunc(f(self.random * 10));

  // "check for prestarted looping sound".
  if (self.spawnflags & SPEAKER_LOOPED_ON) self.s.loopSound = self.noiseIndex;

  self.use = (it, _other, activator) => useTargetSpeaker(level, it, activator);

  if (self.spawnflags & SPEAKER_GLOBAL) self.r.svFlags |= SVF.BROADCAST;

  self.s.pos.trBase = copy(self.s.origin);

  // "must link the entity so we get areas and clusters so the server can determine who to send
  // updates to".
  level.linkEntity(self);
}

/** `Use_Target_Speaker` (`g_target.c:181–196`). */
function useTargetSpeaker(level: Level, self: GameEntity, activator: GameEntity | null): void {
  if (self.spawnflags & (SPEAKER_LOOPED_ON | SPEAKER_LOOPED_OFF)) {
    // "looping sound toggles".
    self.s.loopSound = self.s.loopSound ? 0 : self.noiseIndex;
  } else if (self.spawnflags & SPEAKER_ACTIVATOR) {
    if (activator) addEvent(activator, EV.GENERAL_SOUND, self.noiseIndex, level.time);
  } else if (self.spawnflags & SPEAKER_GLOBAL) {
    addEvent(self, EV.GLOBAL_SOUND, self.noiseIndex, level.time);
  } else {
    addEvent(self, EV.GENERAL_SOUND, self.noiseIndex, level.time);
  }
}

/**
 * `SP_target_laser` (`g_target.c:335–340`): a beam that hurts whatever it falls on, at its `target`
 * or along its angles. A use turns it on or off. It starts a frame after the map spawns, "to let
 * everything else get spawned before we start firing".
 */
export function spawnTargetLaser(level: Level, self: GameEntity): void {
  self.think = (it) => startLaser(level, it);
  self.nextthink = level.time + FRAMETIME;
}

/**
 * `target_laser_start` (`g_target.c:306–333`): a beam, aimed at the first entity its `target`
 * names, or along the angles it had, which are cleared. A target that names nothing is printed,
 * and the beam is left with no direction, so it reaches nowhere.
 */
function startLaser(level: Level, self: GameEntity): void {
  self.s.eType = ET.BEAM;

  if (self.target !== null) {
    const enemy = level.find(null, 'targetname', self.target);
    if (!enemy) {
      level.itemMatch.print(
        `${self.classname} at ${vtos(self.s.origin)}: ${self.target} is a bad target`
      );
    }
    self.enemy = enemy;
  } else {
    setMovedir(self.s.angles, self.movedir);
  }

  // `target_laser_use` (`g_target.c:297–304`).
  self.use = (it, _other, activator) => {
    it.activator = activator;
    if (it.nextthink > 0) {
      laserOff(level, it);
    } else {
      laserOn(level, it);
    }
  };
  self.think = (it) => laserThink(level, it);

  if (!self.damage) self.damage = LASER_DAMAGE;

  if (self.spawnflags & LASER_START_ON) {
    laserOn(level, self);
  } else {
    laserOff(level, self);
  }
}

/** `target_laser_on` (`g_target.c:284–289`): fire now, as itself if no one turned it on. */
function laserOn(level: Level, self: GameEntity): void {
  if (!self.activator) self.activator = self;
  laserThink(level, self);
}

/** `target_laser_off` (`g_target.c:291–295`): out of the world, and no more thinks. */
function laserOff(level: Level, self: GameEntity): void {
  level.unlinkEntity(self);
  self.nextthink = 0;
}

/** Scratch for the laser's aim, in the game module's floats. */
const aim = { point: [0, 0, 0], movedir: [0, 0, 0], end: [0, 0, 0] };

/**
 * `target_laser_think` (`g_target.c:254–282`): trace the beam and hurt what it falls on, in the
 * QVM's floats, then go again.
 *
 * A target is aimed at by the middle of its box about where it spawned, wherever it is now. The
 * world's first player is never hurt by a laser, as Quake 3 hurts only a non-zero entity number.
 *
 * Quake 3 thinks again at `level.time` plus `FRAMETIME`, every 100 ms at its 50 ms frame; the time
 * is taken on Quake 3's frames ({@link Level.q3FrameTime}), so the laser keeps that rhythm at any
 * `sv_fps`.
 */
function laserThink(level: Level, self: GameEntity): void {
  const origin = [self.s.origin.x, self.s.origin.y, self.s.origin.z];
  const { point, movedir, end } = aim;
  movedir[0] = self.movedir.x;
  movedir[1] = self.movedir.y;
  movedir[2] = self.movedir.z;

  // "if pointed at another entity, set movedir to point at it".
  const enemy = self.enemy;
  if (enemy) {
    const { s, r } = enemy;
    vectorMA([s.origin.x, s.origin.y, s.origin.z], 0.5, [r.mins.x, r.mins.y, r.mins.z], point);
    vectorMA(point, 0.5, [r.maxs.x, r.maxs.y, r.maxs.z], point);
    vectorSubtract(point, origin, movedir);
    vectorNormalize(movedir);
    self.movedir = vec3(movedir[0], movedir[1], movedir[2]);
  }

  // "fire forward and see what we hit".
  vectorMA(origin, LASER_RANGE, movedir, end);
  const trace = level.trace(
    self.s.origin,
    vec3(),
    vec3(),
    vec3(end[0], end[1], end[2]),
    self.s.number,
    CONTENTS.SOLID | CONTENTS.BODY | CONTENTS.CORPSE
  );

  if (trace.entityNum) {
    // "hurt it if we can".
    damage(
      level,
      level.gentities[trace.entityNum],
      self,
      self.activator,
      copy(self.movedir),
      self.damage,
      DAMAGE_NO_KNOCKBACK,
      MOD.TARGET_LASER,
      copy(trace.endpos)
    );
  }

  self.s.origin2 = copy(trace.endpos);
  level.linkEntity(self);
  self.nextthink = level.q3FrameTime() + FRAMETIME;
}

/**
 * `SP_target_relay` (`g_target.c:398–400`): pass a firing on to its targets, or to one of them at
 * random. One side's relay ignores a player of the other side, but not anything else.
 */
export function spawnTargetRelay(level: Level, self: GameEntity): void {
  // `target_relay_use` (`g_target.c:377–396`).
  self.use = (it, _other, activator) => {
    const { print, random } = level.itemMatch;
    const team = activator?.client?.sess.sessionTeam;
    if (it.spawnflags & RELAY_RED_ONLY && team !== undefined && team !== TEAM.RED) return;
    if (it.spawnflags & RELAY_BLUE_ONLY && team !== undefined && team !== TEAM.BLUE) return;

    if (it.spawnflags & RELAY_RANDOM) {
      const target = pickTarget(level, it.target, random, print);
      target?.use?.(target, it, activator);
      return;
    }

    useTargets(level, it, activator, print);
  };
}

/** `SP_target_kill` (`g_target.c:412–414`): kill whoever set it off, as a telefrag, past god. */
export function spawnTargetKill(level: Level, self: GameEntity): void {
  // `target_kill_use` (`g_target.c:408–410`).
  self.use = (_it, _other, activator) => {
    if (!activator) return;
    damage(level, activator, null, null, null, TELEFRAG_DAMAGE, DAMAGE_NO_PROTECTION, MOD.TELEFRAG);
  };
}

/**
 * `SP_target_location` (`g_target.c:461–466`): a named place, for the team overlay and the team
 * chat to say where a player is. The first to think numbers them all into `CS_LOCATIONS`; it is
 * never linked.
 */
export function spawnTargetLocation(level: Level, self: GameEntity): void {
  self.think = () => linkLocations(level);
  self.nextthink = level.time + LOCATION_LINKUP_DELAY;
  setEntityOrigin(self, self.s.origin);
}

/**
 * `target_location_linkup` (`g_target.c:423–451`): number every location from 1 in entity order,
 * its `message` the configstring at `CS_LOCATIONS` plus its number, with "unknown" at 0, and chain
 * them through `nextTrain` with the last at the head.
 *
 * Nothing stops at the 63 `CS_LOCATIONS` holds, so a map with more writes on into `CS_PARTICLES`,
 * as Quake 3's does.
 */
function linkLocations(level: Level): void {
  if (level.locationLinked) return;
  level.locationLinked = true;
  level.locationHead = null;

  level.setConfigstring(CONFIGSTRING.LOCATIONS, 'unknown');

  let n = 1;
  for (let i = 0; i < level.numEntities; i++) {
    const entity = level.gentities[i];
    if (entity.classname.toLowerCase() !== 'target_location') continue;
    // "lets overload some variables!"
    entity.health = n;
    level.setConfigstring(CONFIGSTRING.LOCATIONS + n, entity.message ?? '');
    n++;
    entity.nextTrain = level.locationHead;
    level.locationHead = entity;
  }
}
