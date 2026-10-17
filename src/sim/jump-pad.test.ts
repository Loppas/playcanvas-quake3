import { describe, expect, it } from 'vitest';

import { entityTokens, type SpawnVar } from '../formats/entity-text';
import type { PlayerState } from '../net/protocol';
import { triggerBsp } from './cm/collision-test-fixtures';
import { loadMap } from './cm/cm-load';
import type { ClipMap } from './cm/cm-local';
import { CONTENTS, GT, PM_DEAD, PM_SPECTATOR, STAT } from './constants';
import { SOLID_BMODEL } from './entity-solid';
import { EV, eventsSince } from './events';
import { ET, setEntityOrigin, SVF, type GameEntity } from './game-entity';
import { DEFAULT_ITEM_MATCH } from './item-touch';
import { FRAMETIME } from './item-spawn';
import {
  FLY_SOUND_DEBOUNCE,
  JUMP_PAD_MAXS,
  JUMP_PAD_MINS,
  JUMP_PAD_SOUND,
  TARGET_PUSH_SPEED,
  touchJumpPad,
  WINDFLY_SOUND
} from './jump-pad';
import { Level } from './level';
import { entityText } from './map-test-fixtures';
import { spawnEntitiesFromString, spawnEntityFromVars } from './spawn';
import { initTrigger, touchTriggers } from './triggers';
import { createIdlePlayerState } from './types';
import { vec3 } from './vec3';

/**
 * The jump pad: `SP_trigger_push`, `AimAtTarget`, `target_push` and `BG_TouchJumpPad`
 * (`g_trigger.c:143–261`, `bg_misc.c:1421–1454`).
 *
 * A pad on a BSP is its brush. A splat map's has no brush, so the port gives it a fixed box where
 * Quake 3 would stop. The apex the target marks, the launch velocity worked out from it in the game
 * module's floats, and the refusal to launch a flying player are the source's. The velocities
 * pinned here are ioquake3's C, run as the QVM runs it, compiled and printed.
 */

/** The sounds a level has registered, in order, as `G_SoundIndex` would number them. */
type Sounds = string[];

/** A level with the links a map that is not running a host has, and a gravity it can be told. */
function level(gravity = 800, clipMap?: ClipMap, sounds: Sounds = []): Level {
  const world = new Level({ clipMap });
  world.itemMatch = {
    ...DEFAULT_ITEM_MATCH,
    random: () => 0,
    gravity: () => gravity,
    soundIndex: (name) => {
      if (!sounds.includes(name)) sounds.push(name);
      return sounds.indexOf(name) + 1;
    }
  };
  return world;
}

/** A level with this map's entities spawned into it, in free-for-all. */
function spawned(text: string, gravity = 800, clipMap?: ClipMap, sounds?: Sounds): Level {
  const world = level(gravity, clipMap, sounds);
  const worlds: SpawnVar[][] = [];
  spawnEntitiesFromString(
    entityTokens(text),
    (vars) => worlds.push([...vars]),
    (vars) => spawnEntityFromVars(world, vars, GT.FFA, () => {})
  );
  return world;
}

/** The trigger map: an empty world, and `*1` a solid brush, its corner at (64, 64) cut off. */
function triggerMap(): ClipMap {
  return loadMap(triggerBsp(), 'maps/test.bsp');
}

/** A map of a world and a pad at the origin, aimed at `target`. */
function mapWithPad(target = 'apex'): string {
  return entityText([
    { classname: 'worldspawn' },
    { classname: 'trigger_push', origin: '0 0 0', target }
  ]);
}

/** The pad in a level, by its classname. */
function padOf(world: Level): GameEntity {
  return world.find(null, 'classname', 'trigger_push')!;
}

/** A pad at `origin` aimed at `apex`, with its think run, and the velocity it was armed with. */
function aimed(origin: string, apex: string, gravity = 800): GameEntity {
  const world = spawned(
    entityText([
      { classname: 'worldspawn' },
      { classname: 'trigger_push', origin, target: 'apex' },
      { classname: 'target_position', targetname: 'apex', origin: apex }
    ]),
    gravity
  );
  const pad = padOf(world);
  pad.think!(pad);
  return pad;
}

/** A client in slot 0 with a standing player state, box and all. */
function player(world: Level, overrides: Partial<PlayerState> = {}): GameEntity {
  const entity = world.gentities[0];
  entity.inuse = true;
  entity.client = world.clients[0];
  entity.client.ps = createIdlePlayerState(overrides);
  entity.r.mins = vec3(-15, -15, -24);
  entity.r.maxs = vec3(15, 15, 32);
  return entity;
}

/** A pad entity with the velocity it was armed with, in the world. */
function pad(world: Level, origin2 = vec3(400, 0, 100)): GameEntity {
  const entity = world.spawnEntity();
  entity.classname = 'trigger_push';
  entity.s.eType = ET.PUSH_TRIGGER;
  entity.r.contents = CONTENTS.TRIGGER;
  entity.s.origin2 = origin2;
  setEntityOrigin(entity, vec3());
  world.linkEntity(entity);
  return entity;
}

describe('spawning a jump pad', () => {
  it('is its brush model on a BSP: the inline model, a trigger, sent to clients', () => {
    const sounds: Sounds = [];
    const world = spawned(
      entityText([
        { classname: 'worldspawn' },
        { classname: 'trigger_push', model: '*1', target: 'apex' }
      ]),
      800,
      triggerMap(),
      sounds
    );
    const launcher = padOf(world);

    expect(launcher.s.eType).toBe(ET.PUSH_TRIGGER);
    expect(launcher.s.modelindex).toBe(1);
    expect(launcher.r.bmodel).toBe(true);
    // The model's bounds, a unit bigger each way, and the link's unit more.
    expect(launcher.r.mins).toEqual(vec3(-1, -1, -1));
    expect(launcher.r.maxs).toEqual(vec3(65, 65, 17));
    expect(launcher.r.absmin).toEqual(vec3(-2, -2, -2));
    expect(launcher.r.absmax).toEqual(vec3(66, 66, 18));
    // "Replaces the -1 from trap_SetBrushModel."
    expect(launcher.r.contents).toBe(CONTENTS.TRIGGER);
    expect(launcher.r.svFlags & SVF.NOCLIENT).toBe(0);
    expect(launcher.r.linked).toBe(true);
    expect(launcher.s.solid).toBe(SOLID_BMODEL);
    // "Make sure the client precaches this sound."
    expect(sounds).toEqual([JUMP_PAD_SOUND]);
    expect(launcher.nextthink).toBe(FRAMETIME);
  });

  it('is a trigger, sent to clients, with the box a splat map cannot carry', () => {
    const world = spawned(mapWithPad());
    const launcher = padOf(world);

    expect(launcher.s.eType).toBe(ET.PUSH_TRIGGER);
    expect(launcher.r.contents).toBe(CONTENTS.TRIGGER);
    // "unlike other triggers, we need to send this one to the client" (`g_trigger.c:202–203`).
    expect(launcher.r.svFlags & SVF.NOCLIENT).toBe(0);
    expect(launcher.r.linked).toBe(true);
    expect(launcher.r.bmodel).toBe(false);
    expect(launcher.r.mins).toEqual(JUMP_PAD_MINS);
    expect(launcher.r.maxs).toEqual(JUMP_PAD_MAXS);
    // "we must have some delay to make sure our use targets are present": a frame's think.
    expect(launcher.nextthink).toBe(FRAMETIME);
    expect(launcher.think).not.toBeNull();
    expect(launcher.touch).not.toBeNull();
  });

  it('keeps an angle as its direction, its angles cleared as they go out to the clients', () => {
    const world = spawned(
      entityText([
        { classname: 'worldspawn' },
        { classname: 'trigger_push', model: '*1', target: 'apex', angle: '-1' }
      ]),
      800,
      triggerMap()
    );
    const launcher = padOf(world);

    // `G_SetMovedir`'s straight up.
    expect(launcher.movedir).toEqual(vec3(0, 0, 1));
    expect(launcher.s.angles).toEqual(vec3());
  });

  it("stops on a model the map has not got, in collision's words", () => {
    const spawn = () =>
      spawned(
        entityText([{ classname: 'worldspawn' }, { classname: 'trigger_push', model: '*2' }]),
        800,
        triggerMap()
      );
    expect(spawn).toThrow('CM_InlineModel: bad number');
  });

  it('makes any trigger its model, made of nothing but a trigger, and hidden from clients', () => {
    const world = level(800, triggerMap());
    const trigger = world.spawnEntity();
    trigger.model = '*1';
    initTrigger(world, trigger);
    expect(trigger.r.bmodel).toBe(true);
    expect(trigger.r.contents).toBe(CONTENTS.TRIGGER);
    expect(trigger.r.svFlags).toBe(SVF.NOCLIENT);
    expect(trigger.r.linked).toBe(true);
  });

  it('is the only trigger a missing model leaves a box: any other stops, as Quake 3 does', () => {
    const world = level(800, triggerMap());
    const trigger = world.spawnEntity();
    expect(() => initTrigger(world, trigger)).toThrow('SV_SetBrushModel: NULL');
  });
});

describe('aiming a jump pad', () => {
  it('arms it with the velocity that reaches the target apex', () => {
    // 200 away and 100 up under gravity 800: time = sqrt(100 / (0.5 * 800)) = 0.5 s, so the
    // horizontal speed is 200 / 0.5 = 400 and the vertical 0.5 * 800 = 400.
    expect(aimed('0 0 0', '200 0 100').s.origin2).toEqual(vec3(400, 0, 400));
  });

  it('reads the gravity live, as `g_gravity.value` is read at the think', () => {
    // Under gravity 400 the same leap takes sqrt(100 / 200) = 0.7071 s, as a float.
    const launcher = aimed('0 0 0', '200 0 100', 400);
    expect(launcher.s.origin2).toEqual(vec3(282.84271240234375, 0, 282.84271240234375));
  });

  it('measures the height from the box centre too, not the target alone', () => {
    // The pad is 100 up and the target 100 above that: the leap is the same as the first case's.
    expect(aimed('0 0 100', '200 0 200').s.origin2).toEqual(vec3(400, 0, 400));
  });

  it('aims a diagonal pad along the line to its target, in floats', () => {
    // 282.84 away at the same half-second: in doubles 400 on each axis, and in the QVM's floats
    // the length rounds, which carries into the run.
    const launcher = aimed('0 0 0', '200 200 100');
    expect(launcher.s.origin2).toEqual(vec3(400.0000305175781, 400.0000305175781, 400));
  });

  it("is q3dm17's northern pad to the bit, where doubles miss by a millionth", () => {
    // Its brush's centre, (-32 800 338), aimed at `t90`.
    const launcher = aimed('-32 800 338', '-88 852 728');
    expect(launcher.s.origin2).toEqual(
      vec3(-56.71340560913086, 52.662445068359375, 789.9367065429688)
    );
  });

  it('takes the time of flight from a float quotient, as the QVM divides', () => {
    // 2 up: the quotient in doubles gives (2828.427001953125, 0, 56.568546295166016).
    const launcher = aimed('0 0 0', '200 0 2');
    expect(launcher.s.origin2).toEqual(vec3(2828.42724609375, 0, 56.568538665771484));
  });

  it("normalizes as ioquake3 does, by the inverse length, where id's took the root", () => {
    // id's 1.32 gives -72.29568481445312 here.
    const launcher = aimed('624 184 -44', '624 128 196');
    expect(launcher.s.origin2).toEqual(vec3(0, -72.29569244384766, 619.6773681640625));
  });

  it("takes its apex from its brush's centre, which a brush trigger's origin is not", () => {
    const world = spawned(
      entityText([
        { classname: 'worldspawn' },
        { classname: 'trigger_push', model: '*1', target: 'apex' },
        { classname: 'target_position', targetname: 'apex', origin: '232 32 108' }
      ]),
      800,
      triggerMap()
    );
    const launcher = padOf(world);
    launcher.think!(launcher);

    // The brush's centre is (32 32 8), so the apex is 200 along x and 100 up.
    expect(launcher.s.origin2).toEqual(vec3(400, 0, 400));
  });

  it('frees a pad whose target is not there', () => {
    const world = spawned(mapWithPad('missing'));
    const launcher = padOf(world);
    launcher.think!(launcher);

    expect(launcher.inuse).toBe(false);
  });

  it('frees a pad aimed level with itself, which is no leap at all', () => {
    expect(aimed('0 0 0', '200 0 0').inuse).toBe(false);
  });

  it('frees a pad aimed below itself, whose leap would be a NaN', () => {
    expect(aimed('0 0 0', '200 0 -100').inuse).toBe(false);
  });
});

describe('a target_push', () => {
  /** A level with a push, a target for it if `apex` is given, and the sounds registered. */
  function pushed(fields: Record<string, string>, apex?: string) {
    const sounds: Sounds = [];
    const entities: Record<string, string>[] = [
      { classname: 'worldspawn' },
      { classname: 'target_push', targetname: 'push', origin: '0 0 0', ...fields }
    ];
    if (apex) entities.push({ classname: 'target_position', targetname: 'apex', origin: apex });
    const world = spawned(entityText(entities), 800, undefined, sounds);
    const push = world.find(null, 'classname', 'target_push')!;
    return { world, push, sounds };
  }

  it('pushes along its angle at its speed, 1000 by default, and is never linked', () => {
    const { push } = pushed({ angle: '-1' });
    expect(push.speed).toBe(TARGET_PUSH_SPEED);
    expect(push.s.origin2).toEqual(vec3(0, 0, 1000));
    expect(push.s.angles).toEqual(vec3());
    expect(push.r.linked).toBe(false);
    expect(push.nextthink).toBe(0);
  });

  it("pushes along any other angle by its forward, in collision's floats", () => {
    const { push } = pushed({ angle: '90', speed: '100' });
    expect(push.s.origin2.y).toBe(100);
    // cos 90° as a float is not quite 0.
    expect(push.s.origin2.x).not.toBe(0);
    expect(Math.abs(push.s.origin2.x)).toBeLessThan(1e-5);
  });

  it('sounds like the wind, or like a pad with the bounce pad flag', () => {
    expect(pushed({ angle: '-1' }).sounds).toEqual([WINDFLY_SOUND]);
    expect(pushed({ angle: '-1', spawnflags: '1' }).sounds).toEqual([JUMP_PAD_SOUND]);
  });

  it('aims at a target as a pad does, from its own origin', () => {
    const { push } = pushed({ origin: '0 0 100', target: 'apex' }, '200 0 200');
    expect(push.nextthink).toBe(FRAMETIME);
    push.think!(push);
    expect(push.s.origin2).toEqual(vec3(400, 0, 400));
  });

  it("gives its activator its velocity, and the sound at most every 1.5 s, by the player's", () => {
    const { world, push } = pushed({ angle: '-2', speed: '300' });
    const walker = player(world);
    const heard = () =>
      world.gentities.filter((it) => it.inuse && it.s.eType === ET.EVENTS + EV.GENERAL_SOUND);

    world.time = 100;
    push.use!(push, push, walker);
    expect(walker.client!.ps.velocity).toEqual(vec3(0, 0, -300));
    expect(walker.flySoundDebounceTime).toBe(100 + FLY_SOUND_DEBOUNCE);
    expect(heard()).toHaveLength(1);

    world.time = 100 + FLY_SOUND_DEBOUNCE;
    push.use!(push, push, walker);
    expect(heard()).toHaveLength(1);

    world.time = 101 + FLY_SOUND_DEBOUNCE;
    push.use!(push, push, walker);
    expect(heard()).toHaveLength(2);
  });

  it('leaves a flyer and a spectator alone, and fired for no one does nothing', () => {
    const { world, push } = pushed({ angle: '-1' });
    const flyer = player(world);
    flyer.client!.ps.powerups[6] = 1; // PW.FLIGHT
    push.use!(push, push, flyer);
    expect(flyer.client!.ps.velocity).toEqual(vec3());

    const watcher = player(world, { pmType: PM_SPECTATOR });
    push.use!(push, push, watcher);
    expect(watcher.client!.ps.velocity).toEqual(vec3());

    // As a train's corner fires it.
    expect(() => push.use!(push, push, null)).not.toThrow();
  });
});

describe('touching a brush jump pad', () => {
  /** A level with a pad on the trigger map's brush, and a player standing at `origin`. */
  function walkIn(x: number, y: number) {
    const world = spawned(
      entityText([
        { classname: 'worldspawn' },
        { classname: 'trigger_push', model: '*1', target: 'apex' },
        { classname: 'target_position', targetname: 'apex', origin: '232 32 108' }
      ]),
      800,
      triggerMap()
    );
    const launcher = padOf(world);
    launcher.think!(launcher);
    const walker = player(world, { origin: vec3(x, y, 20) });
    touchTriggers(world, walker);
    return walker.client!.ps;
  }

  it('launches a player whose box is in its brush', () => {
    expect(walkIn(50, 50).velocity).toEqual(vec3(400, 0, 400));
  });

  it("leaves one whose box reaches only into its bounds, by the brush's cut corner", () => {
    expect(walkIn(75, 75).velocity).toEqual(vec3());
  });
});

describe('touching a jump pad', () => {
  it('gives the player the pad velocity and raises the event', () => {
    const world = level();
    const walker = player(world);
    const launcher = pad(world);
    walker.client!.ps.pmoveFramecount = 7;

    touchJumpPad(walker.client!.ps, launcher.s);

    expect(walker.client!.ps.velocity).toEqual(vec3(400, 0, 100));
    expect(walker.client!.ps.jumppadEnt).toBe(launcher.s.number);
    expect(walker.client!.ps.jumppadFrame).toBe(7);
    expect(eventsSince(walker.client!.ps, 0)).toEqual([{ event: EV.JUMP_PAD, parm: 0 }]);
  });

  it('calls a steep pad a launch: parm 1 for a push more than 45 degrees up', () => {
    const world = level();
    const walker = player(world);
    const launcher = pad(world, vec3(100, 0, 400));

    touchJumpPad(walker.client!.ps, launcher.s);

    // atan2(400, 100) is 76 degrees, so the pad is a launcher rather than a shove.
    expect(eventsSince(walker.client!.ps, 0)).toEqual([{ event: EV.JUMP_PAD, parm: 1 }]);
  });

  it('calls a slightly downward pad a shove, which only the normalized angle says', () => {
    // A downward push's `vectoangles` pitch is 350 degrees, not -10: taken raw that is a
    // launcher, and normalized it is the 10-degree shove it really is.
    const world = level();
    const walker = player(world);
    const launcher = pad(world, vec3(400, 0, -100));

    touchJumpPad(walker.client!.ps, launcher.s);

    expect(eventsSince(walker.client!.ps, 0)).toEqual([{ event: EV.JUMP_PAD, parm: 0 }]);
  });

  it('raises the event once for the same pad, and sets the velocity every time', () => {
    const world = level();
    const walker = player(world);
    const launcher = pad(world);
    const ps = walker.client!.ps;
    ps.pmoveFramecount = 7;

    touchJumpPad(ps, launcher.s);
    ps.velocity = vec3();
    touchJumpPad(ps, launcher.s);

    // "if we didn't hit this same jumppad the previous frame then don't play the event sound
    // again if we are in a fat trigger": one event, two velocity sets.
    expect(eventsSince(ps, 0)).toEqual([{ event: EV.JUMP_PAD, parm: 0 }]);
    expect(ps.velocity).toEqual(vec3(400, 0, 100));
  });

  it('raises it again for a different pad, even in the same frame', () => {
    const world = level();
    const walker = player(world);
    const first = pad(world);
    const second = pad(world);
    const ps = walker.client!.ps;

    touchJumpPad(ps, first.s);
    touchJumpPad(ps, second.s);

    expect(eventsSince(ps, 0).map(({ event }) => event)).toEqual([EV.JUMP_PAD, EV.JUMP_PAD]);
    expect(ps.jumppadEnt).toBe(second.s.number);
  });

  it('leaves a flying player alone, which is the whole refusal', () => {
    const world = level();
    const walker = player(world);
    const launcher = pad(world);
    const ps = walker.client!.ps;
    ps.powerups[6] = 1; // PW.FLIGHT
    ps.velocity = vec3(100, 0, 0);

    touchJumpPad(ps, launcher.s);

    // "flying characters don't hit bounce pads" (`bg_misc.c:1431–1434`).
    expect(ps.velocity).toEqual(vec3(100, 0, 0));
    expect(ps.jumppadEnt).toBe(0);
    expect(eventsSince(ps, 0)).toEqual([]);
  });

  it('leaves a spectator alone', () => {
    const world = level();
    const walker = player(world, { pmType: PM_SPECTATOR });
    const launcher = pad(world);

    touchJumpPad(walker.client!.ps, launcher.s);

    // "spectators don't use jump pads" (`bg_misc.c:1426–1429`).
    expect(walker.client!.ps.velocity).toEqual(vec3());
    expect(eventsSince(walker.client!.ps, 0)).toEqual([]);
  });

  it('leaves a corpse alone, a dead body not being a player', () => {
    const world = level();
    const walker = player(world, { pmType: PM_DEAD });
    walker.client!.ps.stats[STAT.HEALTH] = 0;
    const launcher = pad(world);

    touchJumpPad(walker.client!.ps, launcher.s);

    expect(walker.client!.ps.velocity).toEqual(vec3());
  });

  it('is worked by walking into it, through the trigger pass', () => {
    const world = level();
    const walker = player(world);
    const launcher = pad(world, vec3(0, 0, 400));
    launcher.touch = (self, other) => {
      if (other.client) touchJumpPad(other.client.ps, self.s);
    };

    touchTriggers(world, walker);

    expect(walker.client!.ps.velocity).toEqual(vec3(0, 0, 400));
    expect(eventsSince(walker.client!.ps, 0)).toEqual([{ event: EV.JUMP_PAD, parm: 1 }]);
  });

  it('is not touched by a player outside its box', () => {
    const world = level();
    const walker = player(world);
    const launcher = pad(world);
    launcher.touch = (self, other) => {
      if (other.client) touchJumpPad(other.client.ps, self.s);
    };
    setEntityOrigin(launcher, vec3(0, 0, 500));

    touchTriggers(world, walker);

    expect(walker.client!.ps.velocity).toEqual(vec3());
  });
});
