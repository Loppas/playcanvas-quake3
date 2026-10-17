import { describe, expect, it } from 'vitest';

import { entityTokens } from '../formats/entity-text';
import type { PlayerState } from '../net/protocol';
import { triggerBsp } from './cm/collision-test-fixtures';
import { loadMap } from './cm/cm-load';
import { qvmAngleVectors } from './cm/q-math';
import {
  CONTENTS,
  EF_TELEPORT_BIT,
  GT,
  MOD,
  PM_DEAD,
  PM_SPECTATOR,
  PMF_TIME_KNOCKBACK,
  STAT,
  TEAM
} from './constants';
import { SOLID_BMODEL } from './entity-solid';
import { EV } from './events';
import { ET, setMovedir, SVF, type GameEntity } from './game-entity';
import { DEFAULT_ITEM_MATCH } from './item-touch';
import { JUMP_PAD_SOUND } from './jump-pad';
import { Level } from './level';
import { mapOf, type TestEntity } from './map-test-fixtures';
import { spawnEntitiesFromString, spawnEntityFromVars } from './spawn';
import {
  NO_ANGLES_PITCH,
  placePlayer,
  TELEPORT_KNOCKBACK_TIME,
  TELEPORT_SPECTATOR_ONLY,
  teleportEvents,
  teleportPlayer
} from './teleport';
import { touchTriggers } from './triggers';
import { createIdlePlayerState } from './types';
import { copy, vec3, type Vec3 } from './vec3';

/**
 * Teleporters: `TeleportPlayer`, `trigger_teleport`, `target_teleporter` and
 * `misc_teleporter_dest` (`g_misc.c:79–133`, `g_trigger.c:271–323`, `g_target.c:345–367`).
 *
 * The spits pinned here are ioquake3's `AngleVectors` as the game module's QVM runs it, compiled
 * from its C and printed.
 */

/** What a level printed and registered. */
interface Record {
  prints: string[];
  sounds: string[];
}

/** A level on the trigger map, with no host. */
function level(record: Record = { prints: [], sounds: [] }): Level {
  const world = new Level({ clipMap: loadMap(triggerBsp(), 'maps/test.bsp') });
  world.itemMatch = {
    ...DEFAULT_ITEM_MATCH,
    random: () => 0,
    print: (text) => record.prints.push(text),
    soundIndex: (name) => {
      if (!record.sounds.includes(name)) record.sounds.push(name);
      return record.sounds.indexOf(name) + 1;
    }
  };
  return world;
}

/** A level with this map's entities spawned into it, in free-for-all. */
function spawned(entities: readonly TestEntity[], record?: Record): Level {
  const world = level(record);
  spawnEntitiesFromString(
    entityTokens(mapOf(...entities)),
    () => {},
    (vars) => spawnEntityFromVars(world, vars, GT.FFA, (text) => record?.prints.push(text))
  );
  return world;
}

/** A client in `slot` standing at `origin`, in the world, that a telefrag can find. */
function player(world: Level, slot: number, origin: Vec3, overrides: Partial<PlayerState> = {}) {
  const entity = world.gentities[slot];
  world.initEntity(entity, slot);
  entity.client = world.clients[slot];
  entity.client.ps = createIdlePlayerState({ origin: copy(origin), clientNum: slot, ...overrides });
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

/** The temp entities carrying one event. */
function tempEvents(world: Level, event: number): GameEntity[] {
  return world.gentities.filter((e) => e.inuse && e.s.eType === ET.EVENTS + event);
}

/** The spit `AngleVectors` gives a yaw, by the game module's floats, times 400. */
function spitOf(yaw: number): Vec3 {
  const forward = [0, 0, 0];
  qvmAngleVectors([0, yaw, 0], forward, null, null);
  return vec3(Math.fround(forward[0] * 400), Math.fround(forward[1] * 400), forward[2] * 400);
}

describe('the game module’s AngleVectors', () => {
  it.each([
    // Yaw 180 is `q3dm17`'s north teleporter's destination; yaw 27's y and yaw 102's x are where
    // the engine's double DEG2RAD gives another float.
    [180, vec3(-400, -3.4969110856764019e-5, -0)],
    [90, vec3(-1.7484555428382009e-5, 400, -0)],
    [270, vec3(4.7699522838229313e-6, -400, -0)],
    [27, vec3(356.40261840820312, 181.59619140625, -0)],
    [102, vec3(-83.164649963378906, 391.25906372070312, -0)],
    [355, vec3(398.47787475585938, -34.862411499023438, -0)]
  ])('spits a player along yaw %d as the QVM does', (yaw, spit) => {
    const got = spitOf(yaw);
    expect(Object.is(got.x, spit.x) && Object.is(got.y, spit.y) && Object.is(got.z, spit.z)).toBe(
      true
    );
  });

  it("is G_SetMovedir's too, as `g_utils.c` is the game module's", () => {
    const movedir = vec3();
    setMovedir(vec3(0, 27, 0), movedir);
    // The engine's double DEG2RAD would give a y of 0.45399051904678345.
    expect(movedir).toEqual(vec3(0.89100652933120728, 0.45399048924446106, -0));
  });

  it('turns by all three angles', () => {
    const forward = [0, 0, 0];
    const right = [0, 0, 0];
    const up = [0, 0, 0];
    qvmAngleVectors([12.25, 199, 7], forward, right, up);
    expect(forward).toEqual([-0.92399019002914429, -0.31815522909164429, -0.21217766404151917]);
    expect(right).toEqual([-0.29869213700294495, 0.94688934087753296, -0.11909451335668564]);
    expect(up).toEqual([-0.2387993186712265, 0.046666368842124939, 0.96994692087173462]);
  });
});

describe('TeleportPlayer', () => {
  it('lands the player a unit over the destination, facing its way and thrown along it', () => {
    const world = level();
    const traveller = player(world, 0, vec3(10, 20, 30));
    const ps = traveller.client!.ps;

    teleportPlayer(world, traveller, vec3(816, 64, 348), vec3(0, 180, 0));

    expect(ps.origin).toEqual(vec3(816, 64, 349));
    expect(Object.is(ps.velocity.y, -3.4969110856764019e-5)).toBe(true);
    expect(ps.velocity.x).toBe(-400);
    expect(Object.is(ps.velocity.z, -0)).toBe(true);
    expect(ps.pmTime).toBe(TELEPORT_KNOCKBACK_TIME);
    expect(ps.pmFlags & PMF_TIME_KNOCKBACK).toBe(PMF_TIME_KNOCKBACK);
    // `SetClientViewAngle`, by the delta from the command's own angles.
    expect(ps.viewangles).toEqual(vec3(0, 180, 0));
    expect(ps.deltaAngles.y).toBe(32768);
    expect(ps.eFlags & EF_TELEPORT_BIT).toBe(EF_TELEPORT_BIT);
    // Linked where it landed, and the entity state saved from the move's results.
    expect(traveller.r.linked).toBe(true);
    expect(traveller.r.currentOrigin).toEqual(ps.origin);
    expect(traveller.s.pos.trBase).toEqual(vec3(816, 64, 349));
  });

  it('raises an effect where the player left and one where they arrive, each naming them', () => {
    const world = level();
    const traveller = player(world, 3, vec3(10.5, 20.5, 30.5));

    teleportPlayer(world, traveller, vec3(816, 64, 348), vec3(0, 180, 0));

    const [out] = tempEvents(world, EV.PLAYER_TELEPORT_OUT);
    const [into] = tempEvents(world, EV.PLAYER_TELEPORT_IN);
    // Each snapped, as a temp entity's origin is; the arrival at the destination, not the lift.
    expect(out.s.origin).toEqual(vec3(10, 20, 30));
    expect(into.s.origin).toEqual(vec3(816, 64, 348));
    expect(out.s.clientNum).toBe(3);
    expect(into.s.clientNum).toBe(3);
    // The departure first, so it is the lower slot.
    expect(out.s.number).toBeLessThan(into.s.number);
  });

  it('makes the two events alone where it is told, and moves no one', () => {
    const world = level();
    const traveller = player(world, 3, vec3(10, 20, 30));

    teleportEvents(world, traveller, vec3(1.5, 2.5, 3.5), vec3(816, 64, 348));

    const [out] = tempEvents(world, EV.PLAYER_TELEPORT_OUT);
    const [into] = tempEvents(world, EV.PLAYER_TELEPORT_IN);
    expect([out.s.origin, into.s.origin]).toEqual([vec3(1, 2, 3), vec3(816, 64, 348)]);
    expect([out.s.clientNum, into.s.clientNum]).toEqual([3, 3]);
    expect(out.s.number).toBeLessThan(into.s.number);
    expect(traveller.client!.ps.origin).toEqual(vec3(10, 20, 30));
  });

  it('telefrags a client standing where it lands, and no one else', () => {
    const world = level();
    const traveller = player(world, 0, vec3(10, 20, 30));
    const victim = player(world, 1, vec3(816, 64, 349));
    const bystander = player(world, 2, vec3(900, 64, 349));

    teleportPlayer(world, traveller, vec3(816, 64, 348), vec3(0, 180, 0));

    expect(victim.client!.lasthurtMod).toBe(MOD.TELEFRAG);
    // All of it, which `G_Damage` holds at −999.
    expect(victim.health).toBe(-999);
    expect(bystander.health).toBe(100);
    expect(traveller.health).toBe(100);
  });

  it('takes the player out of the world first, so a short hop does not telefrag them', () => {
    const world = level();
    const traveller = player(world, 0, vec3(10, 20, 30));

    // A destination the player's own box still covers where it is linked.
    teleportPlayer(world, traveller, vec3(20, 20, 29), vec3(0, 0, 0));

    expect(traveller.health).toBe(100);
    expect(traveller.client!.ps.origin).toEqual(vec3(20, 20, 30));
  });

  it.each([
    ['on the spectator team', (ps: GameEntity) => (ps.client!.sess.sessionTeam = TEAM.SPECTATOR)],
    ["out of a Clan Arena round", (ps: GameEntity) => (ps.client!.pers.roundSpectator = true)]
  ])('moves a spectator %s and nothing else: no effects, no telefrag, no link', (_name, watch) => {
    const world = level();
    const watcher = player(world, 0, vec3(10, 20, 30), { pmType: PM_SPECTATOR });
    watch(watcher);
    world.unlinkEntity(watcher);
    const stander = player(world, 1, vec3(816, 64, 349));

    teleportPlayer(world, watcher, vec3(816, 64, 348), vec3(0, 180, 0));

    const ps = watcher.client!.ps;
    expect(ps.origin).toEqual(vec3(816, 64, 349));
    expect(ps.velocity.x).toBe(-400);
    expect(ps.eFlags & EF_TELEPORT_BIT).toBe(EF_TELEPORT_BIT);
    expect(tempEvents(world, EV.PLAYER_TELEPORT_OUT)).toEqual([]);
    expect(tempEvents(world, EV.PLAYER_TELEPORT_IN)).toEqual([]);
    expect(stander.health).toBe(100);
    expect(watcher.r.linked).toBe(false);
    expect(watcher.r.currentOrigin).toEqual(ps.origin);
  });

  it("keeps the player's facing and speed for a destination with no angles", () => {
    const world = level();
    const traveller = player(world, 0, vec3(10, 20, 30), {
      velocity: vec3(1, 2, 3),
      viewangles: vec3(0, 45, 0)
    });
    const ps = traveller.client!.ps;

    teleportPlayer(world, traveller, vec3(816, 64, 348), vec3(NO_ANGLES_PITCH + 1, 90, 0));

    expect(ps.origin).toEqual(vec3(816, 64, 349));
    expect(ps.velocity).toEqual(vec3(1, 2, 3));
    expect(ps.pmTime).toBe(0);
    expect(ps.pmFlags & PMF_TIME_KNOCKBACK).toBe(0);
    expect(ps.viewangles).toEqual(vec3(0, 45, 0));
    expect(ps.deltaAngles).toEqual(vec3());
    // The bit still toggles: the player still jumped.
    expect(ps.eFlags & EF_TELEPORT_BIT).toBe(EF_TELEPORT_BIT);
  });

  it('toggles the teleport bit back on a second teleport', () => {
    const world = level();
    const traveller = player(world, 0, vec3(10, 20, 30));
    teleportPlayer(world, traveller, vec3(816, 64, 348), vec3(0, 180, 0));
    teleportPlayer(world, traveller, vec3(10, 20, 30), vec3(0, 0, 0));
    expect(traveller.client!.ps.eFlags & EF_TELEPORT_BIT).toBe(0);
  });
});

describe("a live check's placement", () => {
  it('puts the player at the origin itself, still and facing its way, and links them there', () => {
    const world = level();
    const traveller = player(world, 0, vec3(10, 20, 30), { velocity: vec3(1, 2, 3) });
    const ps = traveller.client!.ps;

    placePlayer(traveller, vec3(816.25, 64, 348), vec3(0, 180, 0), (e) => world.linkEntity(e));

    expect(ps.origin).toEqual(vec3(816.25, 64, 348));
    expect(ps.velocity).toEqual(vec3());
    expect(ps.pmTime).toBe(0);
    expect(ps.viewangles).toEqual(vec3(0, 180, 0));
    expect(ps.deltaAngles.y).toBe(32768);
    expect(ps.eFlags & EF_TELEPORT_BIT).toBe(EF_TELEPORT_BIT);
    expect(traveller.r.currentOrigin).toEqual(ps.origin);
    expect(traveller.s.pos.trBase).toEqual(vec3(816, 64, 348));
    expect(world.entitiesInBox(vec3(800, 50, 340), vec3(830, 80, 350))).toContain(0);
  });

  it('raises no effect and telefrags no one', () => {
    const world = level();
    const traveller = player(world, 0, vec3(10, 20, 30));
    const stander = player(world, 1, vec3(816, 64, 349));

    placePlayer(traveller, vec3(816, 64, 349), vec3(0, 180, 0), (e) => world.linkEntity(e));

    expect(tempEvents(world, EV.PLAYER_TELEPORT_OUT)).toEqual([]);
    expect(tempEvents(world, EV.PLAYER_TELEPORT_IN)).toEqual([]);
    expect(stander.health).toBe(100);
  });

  it('leaves a spectator out of the world', () => {
    const world = level();
    const watcher = player(world, 0, vec3(10, 20, 30), { pmType: PM_SPECTATOR });
    watcher.client!.sess.sessionTeam = TEAM.SPECTATOR;
    world.unlinkEntity(watcher);

    placePlayer(watcher, vec3(816, 64, 349), vec3(0, 180, 0), (e) => world.linkEntity(e));

    expect(watcher.client!.ps.origin).toEqual(vec3(816, 64, 349));
    expect(watcher.r.linked).toBe(false);
  });
});

/** A teleporter on the trigger map's brush, its destination at (816 64 348) facing west. */
const TELEPORTER: TestEntity[] = [
  { classname: 'trigger_teleport', model: '*1', target: 't33' },
  { classname: 'misc_teleporter_dest', targetname: 't33', origin: '816 64 348', angle: '180' }
];

/** The teleporter in a level. */
function teleporterOf(world: Level): GameEntity {
  return world.find(null, 'classname', 'trigger_teleport')!;
}

describe('spawning a teleporter', () => {
  it('is its brush, a trigger sent to the clients, with the jump pad’s sound registered', () => {
    const record: Record = { prints: [], sounds: [] };
    const world = spawned(TELEPORTER, record);
    const teleporter = teleporterOf(world);

    expect(teleporter.s.eType).toBe(ET.TELEPORT_TRIGGER);
    expect(teleporter.s.modelindex).toBe(1);
    expect(teleporter.s.solid).toBe(SOLID_BMODEL);
    expect(teleporter.r.contents).toBe(CONTENTS.TRIGGER);
    expect(teleporter.r.svFlags & SVF.NOCLIENT).toBe(0);
    expect(teleporter.r.linked).toBe(true);
    // "make sure the client precaches this sound", as id wrote it: the jump pad's.
    expect(record.sounds).toEqual([JUMP_PAD_SOUND]);
  });

  it('is hidden from the clients when it takes spectators only', () => {
    const world = spawned([
      { ...TELEPORTER[0], spawnflags: String(TELEPORT_SPECTATOR_ONLY) },
      TELEPORTER[1]
    ]);
    expect(teleporterOf(world).r.svFlags & SVF.NOCLIENT).toBe(SVF.NOCLIENT);
  });

  it('keeps its destination in use, unlinked, where the map put it, found by its name', () => {
    const world = spawned(TELEPORTER);
    const dest = world.find(null, 'targetname', 't33')!;
    expect(dest.classname).toBe('misc_teleporter_dest');
    expect(dest.inuse).toBe(true);
    expect(dest.r.linked).toBe(false);
    expect(dest.s.origin).toEqual(vec3(816, 64, 348));
    expect(dest.s.angles).toEqual(vec3(0, 180, 0));
  });

  it('stops on a model the map has not got, in collision’s words', () => {
    expect(() => spawned([{ ...TELEPORTER[0], model: '*2' }])).toThrow(
      'CM_InlineModel: bad number'
    );
  });
});

describe('touching a teleporter', () => {
  /** The teleporter's level, and a player standing in its brush, or at `x, y`. */
  function walkIn(overrides: Partial<PlayerState> = {}, x = 50, y = 50, entities = TELEPORTER) {
    const record: Record = { prints: [], sounds: [] };
    const world = spawned(entities, record);
    const walker = player(world, 0, vec3(x, y, 20), overrides);
    return { world, walker, record, ps: walker.client!.ps };
  }

  it('sends a player in its brush to the destination', () => {
    const { world, walker, ps } = walkIn();
    touchTriggers(world, walker);
    expect(ps.origin).toEqual(vec3(816, 64, 349));
    expect(ps.velocity.x).toBe(-400);
    expect(tempEvents(world, EV.PLAYER_TELEPORT_IN)).toHaveLength(1);
  });

  it("leaves one whose box reaches only into its bounds, by the brush's cut corner", () => {
    const { world, walker, ps } = walkIn({}, 75, 75);
    touchTriggers(world, walker);
    expect(ps.origin).toEqual(vec3(75, 75, 20));
  });

  it('refuses the dead', () => {
    const { world, walker, ps } = walkIn({ pmType: PM_DEAD });
    touchTriggers(world, walker);
    expect(ps.origin).toEqual(vec3(50, 50, 20));
  });

  it('sends a spectator, unseen', () => {
    const { world, walker, ps } = walkIn({ pmType: PM_SPECTATOR });
    walker.client!.sess.sessionTeam = TEAM.SPECTATOR;
    touchTriggers(world, walker);
    expect(ps.origin).toEqual(vec3(816, 64, 349));
    expect(tempEvents(world, EV.PLAYER_TELEPORT_OUT)).toEqual([]);
  });

  it('takes only spectators when it says so', () => {
    const only = [{ ...TELEPORTER[0], spawnflags: '1' }, TELEPORTER[1]];
    const playing = walkIn({}, 50, 50, only);
    touchTriggers(playing.world, playing.walker);
    expect(playing.ps.origin).toEqual(vec3(50, 50, 20));

    const watching = walkIn({ pmType: PM_SPECTATOR }, 50, 50, only);
    watching.walker.client!.sess.sessionTeam = TEAM.SPECTATOR;
    touchTriggers(watching.world, watching.walker);
    expect(watching.ps.origin).toEqual(vec3(816, 64, 349));
  });

  it('says so, every touch, when its destination is missing', () => {
    const { world, walker, ps, record } = walkIn({}, 50, 50, [
      { ...TELEPORTER[0], target: 't319' }
    ]);
    touchTriggers(world, walker);
    touchTriggers(world, walker);
    expect(ps.origin).toEqual(vec3(50, 50, 20));
    expect(record.prints).toEqual([
      'G_PickTarget: target t319 not found',
      "Couldn't find teleporter destination",
      'G_PickTarget: target t319 not found',
      "Couldn't find teleporter destination"
    ]);
  });

  it('lets a dead player through the pass untouched', () => {
    const { world, walker, ps } = walkIn();
    ps.stats[STAT.HEALTH] = 0;
    touchTriggers(world, walker);
    expect(ps.origin).toEqual(vec3(50, 50, 20));
  });
});

describe('a target_teleporter', () => {
  const FIRED: TestEntity[] = [
    { classname: 'target_teleporter', targetname: 'go', target: 't33', origin: '1 2 3' },
    TELEPORTER[1]
  ];

  it('sends whoever set it off to the destination', () => {
    const world = spawned(FIRED);
    const traveller = player(world, 0, vec3(10, 20, 30));
    const teleporter = world.find(null, 'classname', 'target_teleporter')!;

    teleporter.use!(teleporter, teleporter, traveller);

    expect(traveller.client!.ps.origin).toEqual(vec3(816, 64, 349));
    expect(teleporter.r.linked).toBe(false);
  });

  it('moves nothing that is not a client, or is no one', () => {
    const world = spawned(FIRED);
    const teleporter = world.find(null, 'classname', 'target_teleporter')!;
    expect(() => teleporter.use!(teleporter, teleporter, teleporter)).not.toThrow();
    // No one, as a train's corner fires it.
    expect(() => teleporter.use!(teleporter, teleporter, null)).not.toThrow();
    expect(tempEvents(world, EV.PLAYER_TELEPORT_IN)).toEqual([]);
  });

  it('says where it is when nothing can fire it', () => {
    const record: Record = { prints: [], sounds: [] };
    spawned([{ classname: 'target_teleporter', target: 't33', origin: '-1.5 2.9 3' }], record);
    expect(record.prints).toEqual(['untargeted target_teleporter at (-1 2 3)']);
  });

  it('says so when its destination is missing', () => {
    const record: Record = { prints: [], sounds: [] };
    const world = spawned([{ ...FIRED[0], target: 'nowhere' }], record);
    const traveller = player(world, 0, vec3(10, 20, 30));
    const teleporter = world.find(null, 'classname', 'target_teleporter')!;
    teleporter.use!(teleporter, teleporter, traveller);
    expect(record.prints).toEqual([
      'G_PickTarget: target nowhere not found',
      "Couldn't find teleporter destination"
    ]);
    expect(traveller.client!.ps.origin).toEqual(vec3(10, 20, 30));
  });
});
