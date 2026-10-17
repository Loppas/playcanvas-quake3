import { describe, expect, it } from 'vitest';
import { ENTITYNUM_NONE, type PlayerState } from '../../net/protocol';
import { box, createFlatWorldTrace } from '../box-world';
import { CONTENTS, PMF_GRAPPLE_PULL, STAT } from '../constants';
import { byteToDir } from '../dir-byte';
import { EV, eventNumber } from '../events';
import { ET, type GameEntity } from '../game-entity';
import { Level } from '../level';
import { pmove } from '../pmove';
import { evaluateTrajectory } from '../trajectory';
import { clearTrace, createArmedPlayerState, createUserCmd, type TraceResult } from '../types';
import { length, normalize, sub, vec3, type Vec3 } from '../vec3';
import { WP } from './constants';
import {
  CORKSCREW_GRAPPLE_PULL,
  Grapple,
  HOOK_THINK_TIME,
  NO_HOOK,
  Q2_GRAPPLE_SPEED,
  Q3_GRAPPLE_SPEED,
  fireGrapple,
  grappleMoveQ3,
  grapplePullCorkScrew,
  type GrappleConfig,
  type GrappleMode,
  type GrappleStyle
} from './grapple';
import { missileImpact } from './missile';
import { linkPlayer, weaponWorld } from './weapon-test-fixtures';

const TICK = 8;

/** A room with a wall 500 units down +X to hook onto. */
const room = createFlatWorldTrace([box(500, -400, 0, 520, 400, 600)]);

/** How the hook is doing, read off the world rather than kept anywhere. */
type Phase = 'idle' | 'flying' | 'attached';

/**
 * A running session: a world with a client in it, its hook, and a **monotonic clock**.
 *
 * The clock has to persist across calls — `pmove` ignores any command whose `serverTime` is
 * behind `state.commandTime`, so a helper that restarts at zero each time silently
 * simulates nothing at all.
 *
 * The tick is `PlayerView`'s, which is Quake 3's: the frame runs the world — including the hook,
 * which is one of its missiles — then the release check, then the move, then `FireWeapon`.
 */
class Session {
  readonly state: PlayerState;
  readonly grapple: Grapple;
  readonly level: Level;
  readonly mode: GrappleMode;
  /** How far behind the frames each command is stamped, as a laggy client's are. */
  lag = 0;
  private time = 0;
  private tickIndex = 0;

  constructor(mode: GrappleMode = 'q3pull', pitch = 0, config: Partial<GrappleConfig> = {}) {
    const world = weaponWorld({ trace: room, grapple: mode });
    this.level = world.level;
    this.grapple = world.grapple;
    this.mode = mode;
    this.state = world.owner.client!.ps;
    Object.assign(this.state, plain(pitch));
    if (Object.keys(config).length > 0) this.grapple.configure({ mode, ...config });
  }

  /** The hook in the world, or `null` for none. */
  get hook(): GameEntity | null {
    return this.grapple.hook;
  }

  get phase(): Phase {
    const hook = this.hook;
    if (!hook) return 'idle';
    return hook.s.eType === ET.GRAPPLE ? 'attached' : 'flying';
  }

  /** Where the hook is right now, which is what the cable is drawn to. */
  get hookOrigin(): Vec3 {
    const hook = this.hook;
    if (!hook) throw new Error('no hook is out');
    return evaluateTrajectory(hook.s.pos, this.time);
  }

  /**
   * Every entity in the world that is not the player, bar the eight the body queue holds — which
   * every map takes at the start and which are nothing until a corpse is copied into one.
   */
  get spawned(): GameEntity[] {
    const entities: GameEntity[] = [];
    for (let i = 1; i < this.level.numEntities; i++) {
      const entity = this.level.gentities[i];
      if (entity.inuse && entity.classname !== 'bodyque') entities.push(entity);
    }
    return entities;
  }

  /**
   * Run the full pipeline for `ticks`.
   *
   * @param held - Whether the grapple key is down, by absolute tick number.
   * @param input - Extra user command fields, e.g. strafing.
   */
  run(
    ticks: number,
    held: (tick: number) => boolean = () => true,
    input: { rightmove?: number } = {}
  ): this {
    for (let i = 0; i < ticks; i++) {
      this.tickIndex++;
      this.time += TICK;
      const down = held(this.tickIndex);

      this.level.runFrame(this.time);
      this.grapple.checkRelease(down);
      const cmd = createUserCmd({
        serverTime: this.time - this.lag,
        angles: this.state.viewangles,
        weapon: this.state.weapon,
        ...input
      });
      pmove(this.state, cmd, room, this.grapple.pmoveOptions);
      this.grapple.applyPostMove(this.state, TICK / 1000);
      this.grapple.fire(down);
    }
    return this;
  }

  /** Hold the key until the hook catches, and say which tick it caught on. */
  catchWall(limit = 400): number {
    for (let i = 0; i < limit; i++) {
      this.run(1);
      if (this.phase === 'attached') return this.tickIndex;
    }
    throw new Error('the hook never caught');
  }
}

/** Player standing at the origin, looking at the far wall. */
function plain(pitch = 0): PlayerState {
  return createArmedPlayerState({ origin: vec3(0, 0, 24), viewangles: vec3(pitch, 0, 0) });
}

/**
 * The Q2 winch's speed before its one tick of gravity: `CTFGrapplePull` sets the pull speed
 * along the line to the hook, then takes a tick of gravity off z.
 */
const sagless = ({ velocity, gravity }: PlayerState) =>
  length(vec3(velocity.x, velocity.y, velocity.z + (gravity * TICK) / 1000));

describe('the hook is a missile', () => {
  it('is an `ET_MISSILE` in the level, run by the frame like a rocket', () => {
    const session = new Session().run(3);
    const hook = session.hook!;

    expect(hook.s.eType).toBe(ET.MISSILE);
    expect(hook.classname).toBe('hook');
    expect(hook.s.weapon).toBe(WP.GRAPPLING_HOOK);
    expect(hook.r.ownerNum).toBe(0);
    // It moved because `G_RunMissile` ran it, not because anything stepped it by hand.
    expect(hook.r.currentOrigin.x).toBeGreaterThan(14);
  });

  it('says whose it is, so a client can pick its own cable out of a snapshot', () => {
    // `fire_grapple`'s own comment: "use to match beam in client".
    const session = new Session();
    session.level.gentities[0].s.number = 3;
    session.state.clientNum = 3;
    session.run(1);
    expect(session.hook!.s.otherEntityNum).toBe(3);
  });

  it('fires once per press, not once per tick', () => {
    // `Weapon_GrapplingHook_Fire` guards on `fireHeld`; without it, holding the key would
    // spray hooks.
    const session = new Session().run(3);
    expect(session.spawned).toHaveLength(1);
  });

  it("is timed from the thrower's command, so a laggy thrower's hook makes up the lag", () => {
    // Thrown on time, the hook leaves the muzzle on the frame after the throw.
    const onTime = new Session().run(2);
    expect(onTime.hookOrigin.x).toBe(14);

    // Thrown by a command 100 ms behind the frames, it is already 100 ms out by then: unlagged's
    // catch-up, timed from the command a frame on.
    const late = new Session();
    late.lag = 100;
    late.run(14, (tick) => tick === 14);
    expect(late.hook!.s.pos.trTime).toBe(112 - 100 + TICK);
    late.run(1);
    expect(late.hookOrigin.x).toBeCloseTo(14 + Q3_GRAPPLE_SPEED * 0.1, 6);
  });

  it('is stepped 50 ms along when no client threw it, as every other missile is', () => {
    // The off-hand throw is a client's alone, so only `fire_grapple` itself can be handed one.
    const level = new Level({ startTime: 1000 });
    const style: GrappleStyle = {
      hookSpeed: Q3_GRAPPLE_SPEED,
      pullSpeed: Q3_GRAPPLE_SPEED,
      snap: true,
      launch: 'muzzle',
      refireWhileHeld: false
    };

    const hook = fireGrapple(
      level,
      level.spawnEntity(),
      vec3(0, 0, 24),
      vec3(1, 0, 0),
      style,
      Q3_GRAPPLE_SPEED
    );

    expect(hook.s.pos.trTime).toBe(1000 - 50);
  });

  it('throws no second hook while the first is out, whatever the key has done', () => {
    // Two guards, and they are not the same one. `fireHeld` is the key's — Quake 3 clears it
    // from `ClientEndFrame` rather than from the release — and `client->hook` is the server's
    // record that one is already out there.
    const session = new Session().run(2);
    const first = session.hook!;
    session.level.clients[0].fireHeld = false;

    session.run(2);
    expect(session.hook).toBe(first);
    expect(session.spawned).toEqual([first]);
  });

  it('flies to a wall and anchors there as an `ET_GRAPPLE`', () => {
    const session = new Session();
    session.catchWall();

    expect(session.hook!.s.eType).toBe(ET.GRAPPLE);
    expect(session.state.pmFlags & PMF_GRAPPLE_PULL).toBeTruthy();
    // The wall's near face is at x = 500; the anchor is snapped back along the flight path, so
    // it can only land outside the surface and never inside it.
    expect(session.state.grapplePoint.x).toBe(499);
    expect(session.hook!.s.pos.trBase).toEqual(session.state.grapplePoint);
  });

  it('leaves the catch beside it as an event, saying which way the surface faced', () => {
    const session = new Session();
    session.catchWall();
    const impact = session.spawned.find((entity) => entity !== session.hook)!;

    expect(eventNumber(impact.s.event)).toBe(EV.MISSILE_MISS);
    // A plain entity carrying an event, not a `G_TempEntity` whose type is the event.
    expect(impact.s.eType).toBe(ET.GENERAL);
    expect(impact.freeAfterEvent).toBe(true);
    expect(impact.r.currentOrigin).toEqual(session.state.grapplePoint);
    // The wall faces back down −X.
    expect(byteToDir(impact.s.eventParm).x).toBeLessThan(-0.98);
    // Nothing names a weapon, which is what makes a client draw it as the lightning gun's.
    expect(impact.s.weapon).toBe(WP.NONE);
  });

  it('keeps its own slot once caught, where the catch gives its back', () => {
    const session = new Session();
    session.catchWall();
    const hook = session.hook!;

    // Long enough for the event to have been seen and its entity freed.
    session.run(60);
    expect(session.spawned).toEqual([hook]);
    expect(session.phase).toBe('attached');
  });

  it('detaches the moment the key is released', () => {
    const session = new Session();
    const caught = session.catchWall();
    session.run(40, (tick) => tick <= caught + 20);

    expect(session.phase).toBe('idle');
    expect(session.state.pmFlags & PMF_GRAPPLE_PULL).toBeFalsy();
    expect(session.level.clients[0].hook).toBe(NO_HOOK);
  });

  it('can be fired again after a release', () => {
    const session = new Session();
    const caught = session.catchWall();
    session.run(60, (tick) => tick <= caught + 10 || tick > caught + 20);
    expect(session.phase).not.toBe('idle');
  });

  it('frees a hook that hits nothing after 10 seconds, as `Weapon_HookFree` does', () => {
    // Straight up, where the room has no ceiling. `fire_grapple` gives the hook a 10 second
    // `nextthink` (`g_missile.c:689`), like a missile's. It leaves at the end of tick 1, at
    // 8 ms, so it comes due at 10 008 ms: tick 1251.
    const session = new Session('q3pull', -89).run(1250);
    expect(session.phase).toBe('flying');

    session.run(1);
    expect(session.phase).toBe('idle');
    expect(session.state.pmFlags & PMF_GRAPPLE_PULL).toBeFalsy();
  });

  it('holds a hook that caught for as long as the key is down', () => {
    // The catch overwrites the 10 second think with `Weapon_HookThink`, so nothing takes an
    // anchored hook away but the player letting go.
    const session = new Session();
    session.catchWall();
    session.run(1400);
    expect(session.phase).toBe('attached');
  });

  it('does not change the weapon in hand — it is off-hand', () => {
    // The current weapon stays up and can fire mid-swing.
    const session = new Session();
    const weaponBefore = session.state.weapon;
    session.run(150);
    expect(session.state.weapon).toBe(weaponBefore);
  });

  it('throws none at all with the hook taken away', () => {
    const session = new Session();
    expect(session.grapple.configure({ mode: null })).toBe(true);
    session.run(60);
    expect(session.spawned).toEqual([]);
    expect(session.grapple.pmoveOptions).toBeUndefined();
  });
});

describe('q3pull — vanilla Quake 3 feel', () => {
  /** A session already attached to the wall, ready to be pulled. */
  function attached(): Session {
    const session = new Session('q3pull');
    session.catchWall();
    return session;
  }

  it('hauls the player toward the anchor', () => {
    const session = attached();
    const startX = session.state.origin.x;
    session.run(60);
    expect(session.state.origin.x).toBeGreaterThan(startX + 100);
  });

  it('pulls at the full 800 until the last 100 units', () => {
    const state = plain();
    state.grapplePoint = vec3(1000, 0, 24);
    grappleMoveQ3(state, vec3(1, 0, 0));
    expect(length(state.velocity)).toBeCloseTo(Q3_GRAPPLE_SPEED, 4);
  });

  it('eases in linearly inside 100 units, so it never slams', () => {
    // speed = 10 * distance below the threshold — the reason Q3's grapple settles at an
    // anchor rather than grinding into it the way Q2's does.
    const state = plain();
    // Target is `grapplePoint - 16 * forward`, so aim for a 50 unit gap.
    state.grapplePoint = vec3(state.origin.x + 66, 0, state.origin.z);
    grappleMoveQ3(state, vec3(1, 0, 0));
    expect(length(state.velocity)).toBeCloseTo(500, 4);
  });

  it('aims 16 units short of the anchor, measured from the origin not the eye', () => {
    // The offset is what lets you orbit an anchor: the target wanders as you look around.
    const state = plain();
    state.grapplePoint = vec3(1000, 0, 24);
    grappleMoveQ3(state, vec3(0, 1, 0));
    // Forward is +Y, so the target shifts 16 units along -Y and the pull tilts with it.
    expect(state.velocity.y).toBeLessThan(0);
    expect(state.velocity.x).toBeGreaterThan(0);
  });

  it('leaves a wiggle of air control on top of the pull', () => {
    // `PM_AirMove` runs after the pull, and the source comment for that line is literally
    // "We can wiggle a bit". Measured, it is exactly that: a fraction of a unit of lateral
    // deviation over 200 ticks of full strafe, because the pull overwrites velocity every
    // tick and the air move only gets one tick of acceleration in before it does. Real
    // steering, but nothing like free air control — worth pinning so a future change that
    // reorders the two shows up here as either zero or a great deal more.
    const straight = new Session('q3pull').run(200);
    const strafed = new Session('q3pull').run(200, () => true, { rightmove: 127 });

    const deviation = Math.abs(strafed.state.origin.y) - Math.abs(straight.state.origin.y);
    expect(deviation).toBeGreaterThan(0.1);
    expect(deviation).toBeLessThan(2);
  });

  it('leaves the ground, so friction only bites as the pull starts', () => {
    const session = attached();
    session.run(30);
    expect(session.state.groundEntityNum !== ENTITYNUM_NONE).toBe(false);
  });

  it('takes ground friction off a pull that starts on the floor, as Q3 does', () => {
    // `PM_GrappleMove` leaves `pml.walking` alone (bg_pmove.c:665–683), so the air move after
    // it runs ground friction: 800 − 800 × 6 × 0.008 = 761.6, snapped to 762.
    const state = plain();
    state.grapplePoint = vec3(1000, 0, 24);
    state.pmFlags |= PMF_GRAPPLE_PULL;
    const cmd = createUserCmd({ serverTime: TICK, angles: state.viewangles, weapon: state.weapon });
    pmove(state, cmd, room, { grappleMode: 'q3pull', grapplePullSpeed: Q3_GRAPPLE_SPEED });
    expect(state.velocity.x).toBe(762);
  });

  it('honours a configured pull speed', () => {
    const state = plain();
    state.grapplePoint = vec3(1000, 0, 24);
    grappleMoveQ3(state, vec3(1, 0, 0), 400);
    expect(length(state.velocity)).toBeCloseTo(400, 4);
  });
});

describe('q2winch — Quake 2 CTF feel', () => {
  it('hard-sets velocity toward the hook every tick', () => {
    // The defining difference: whatever pmove produced is discarded, so the speed is
    // exactly the pull speed, minus one frame of gravity sag.
    const session = new Session('q2winch');
    session.catchWall();
    session.run(50);

    const { state } = session;
    const eye = vec3(state.origin.x, state.origin.y, state.origin.z + state.viewheight);
    const expected: Vec3 = normalize(sub(state.grapplePoint, eye));

    // 650 along the line to the hook, then one tick of gravity off z: exactly, wherever the
    // anchor sits against the eye.
    expect(sagless(state)).toBeCloseTo(Q2_GRAPPLE_SPEED, 6);
    expect(normalize(state.velocity).x).toBeCloseTo(expected.x, 1);
  });

  it('keeps ground friction out of the air move, being Q2 rather than Q3', () => {
    const state = plain();
    state.velocity = vec3(650, 0, 0);
    state.pmFlags |= PMF_GRAPPLE_PULL;
    const cmd = createUserCmd({ serverTime: TICK, angles: state.viewangles, weapon: state.weapon });
    pmove(state, cmd, room, { grappleMode: 'q2winch', grapplePullSpeed: Q2_GRAPPLE_SPEED });
    expect(state.velocity.x).toBe(650);
  });

  it('never accumulates gravity, only sags by one frame of it', () => {
    // Re-set every tick, so a Q2 grapple droops by a constant amount rather than falling.
    const session = new Session('q2winch');
    session.catchWall();
    session.run(50);

    const sagFirst = session.state.velocity.z;
    session.run(1);
    expect(Math.abs(session.state.velocity.z - sagFirst)).toBeLessThan(100);
  });

  it('pulls toward the anchor from the eye, not from the feet', () => {
    // `CTFGrapplePull` measures from `owner->s.origin` with `viewheight` added, so an anchor
    // level with the eye pulls flat. From the feet the same anchor would tilt the pull upward
    // by a whole view height.
    const session = new Session('q2winch');
    const { state } = session;
    state.pmFlags |= PMF_GRAPPLE_PULL;
    state.grapplePoint = vec3(state.origin.x + 100, 0, state.origin.z + state.viewheight);
    state.velocity = vec3();
    session.grapple.applyPostMove(state, TICK / 1000);

    expect(state.velocity.x).toBeCloseTo(Q2_GRAPPLE_SPEED, 6);
    expect(state.velocity.y).toBeCloseTo(0, 6);
    // Nothing but the one tick of gravity's sag.
    expect(state.velocity.z).toBeCloseTo((-state.gravity * TICK) / 1000, 6);
  });

  it('keeps grinding into the wall rather than settling against it', () => {
    // Q2 CTF has no "slow down near the anchor" logic at all: you keep being driven into the
    // wall, which the wall clip absorbs.
    const session = new Session('q2winch');
    session.catchWall();
    session.run(400);
    const { state } = session;
    const eye = vec3(state.origin.x, state.origin.y, state.origin.z + state.viewheight);

    expect(length(sub(state.grapplePoint, eye))).toBeLessThan(64);
    expect(length(state.velocity)).toBeGreaterThan(Q2_GRAPPLE_SPEED * 0.5);
  });

  it('honours a configured pull speed', () => {
    const session = new Session('q2winch', 0, { pullSpeed: 300 });
    session.catchWall();
    session.run(30);
    expect(sagless(session.state)).toBeCloseTo(300, 6);
  });

  it('does nothing once released', () => {
    const session = new Session('q2winch');
    session.catchWall();
    session.grapple.release();
    session.state.velocity = vec3(1, 2, 3);
    session.grapple.applyPostMove(session.state, TICK / 1000);
    expect(session.state.velocity).toEqual(vec3(1, 2, 3));
  });

  it('throws the hook from beside the player, as CTFGrappleFire does', () => {
    const { trBase } = new Session('q2winch').run(1).hook!.s.pos;
    // 24 ahead, 8 to the right (−Y, facing +X), and 6 below the eye.
    expect(trBase.x).toBeCloseTo(24, 6);
    expect(trBase.y).toBeCloseTo(-8, 6);
    expect(trBase.z).toBeCloseTo(44, 6);
  });

  it('sweeps from the player, so a hook thrown into a wall at arm’s length still catches', () => {
    // `CTFGrappleFire` traces from the player to where the hook starts; the first sweep from
    // the origin stands in for that.
    const hook = new Session('q2winch').run(1).hook!;
    expect(hook.r.currentOrigin).toEqual(vec3(0, 0, 24));
    expect(hook.s.pos.trBase.x).toBeCloseTo(24, 6);
  });

  it('leaves the velocity unsnapped, where Q3 truncates it', () => {
    // Q2 CTF has no `SnapVector` on the launch, so 650 along a diagonal keeps its fraction.
    const session = new Session('q2winch', -30).run(1);
    const { trDelta } = session.hook!.s.pos;
    expect(length(trDelta)).toBeCloseTo(Q2_GRAPPLE_SPEED, 6);
    expect(Number.isInteger(trDelta.z)).toBe(false);
  });
});

describe("corkscrew — CorkScrew's own feel", () => {
  it('throws the hook at 1,600 from the muzzle point', () => {
    const session = new Session('corkscrew').run(1);
    // `CalcMuzzlePoint`: 14 units along the view from the eye.
    expect(session.hook!.s.pos.trBase).toEqual(vec3(14, 0, 50));

    // At the muzzle on the frame after the throw, and an 8 ms tick at 1,600 on the one after.
    session.run(2);
    expect(session.hookOrigin.x).toBeCloseTo(14 + 1600 * 0.008, 6);
  });

  it('accelerates toward the anchor rather than setting the speed', () => {
    const state = plain();
    state.grapplePoint = vec3(1000, 0, 24);
    const lifts = grapplePullCorkScrew(state, CORKSCREW_GRAPPLE_PULL, TICK / 1000);
    // `PM_Accelerate` toward 800 at 20: 20 × 0.008 × 800 = 128 in a tick.
    expect(state.velocity.x).toBeCloseTo(128, 6);
    expect(lifts).toBe(false);
  });

  it('eases off inside half the pull speed, heading for twice the distance', () => {
    const state = plain();
    state.grapplePoint = vec3(state.origin.x + 200, 0, state.origin.z);
    grapplePullCorkScrew(state, CORKSCREW_GRAPPLE_PULL, TICK / 1000);
    // 200 out: toward 400, at 40 × 200 / 800 = 10, so 10 × 0.008 × 400 = 32.
    expect(state.velocity.x).toBeCloseTo(32, 6);
  });

  it('keeps the momentum it already has across the rope', () => {
    const state = plain();
    state.velocity = vec3(0, 300, 0);
    state.grapplePoint = vec3(1000, 0, 24);
    grapplePullCorkScrew(state, CORKSCREW_GRAPPLE_PULL, TICK / 1000);
    // Only the part along the rope is topped up, so a swing keeps its sideways speed.
    expect(state.velocity.y).toBe(300);
  });

  it('lifts the player off the ground when the rope is steeper than 30 degrees', () => {
    const state = plain();
    state.grapplePoint = vec3(state.origin.x + 100, 0, state.origin.z + 100);
    expect(grapplePullCorkScrew(state, CORKSCREW_GRAPPLE_PULL, TICK / 1000)).toBe(true);
  });

  it('hauls the player to the wall, under the ordinary move', () => {
    const session = new Session('corkscrew');
    session.catchWall();
    const x = session.state.origin.x;
    session.run(60);
    expect(session.state.origin.x).toBeGreaterThan(x + 100);
  });

  it('throws a new hook at once when one is lost while the key is still down', () => {
    // CorkScrew's `Weapon_HookFree` clears its one-throw-per-press flag. Straight up, where the
    // room has no ceiling: the 10 second timeout ends the first hook on tick 1251, and the same
    // tick throws another, because `FireWeapon` runs after the frame that freed it.
    const session = new Session('corkscrew', -89).run(1250);
    const first = session.hook!;
    session.run(1);

    expect(session.phase).toBe('flying');
    expect(session.hook).not.toBe(first);
  });

  it('waits for the key to come up again in the styles that do not', () => {
    const session = new Session('q3pull', -89).run(1251);
    expect(session.phase).toBe('idle');
    session.run(60);
    expect(session.phase).toBe('idle');
  });
});

describe('mode comparison', () => {
  it('travels differently under each mode, which is the point of offering both', () => {
    // Not a value judgement, just the measurable difference between a rigid haul and a pull
    // that eases in and shares the tick with air movement. CorkScrew's own style, a third, is
    // the default.
    const travelled = (mode: GrappleMode) => new Session(mode).run(160).state.origin.x;
    const winch = travelled('q2winch');
    const rope = travelled('q3pull');

    // Both make real progress toward the 500-unit wall...
    expect(winch).toBeGreaterThan(100);
    expect(rope).toBeGreaterThan(100);
    // ...and they do not arrive together. Q3's hook also *flies* faster (800 vs 650), so it
    // starts pulling sooner — the modes differ in more than just the pull.
    expect(Math.abs(winch - rope)).toBeGreaterThan(20);
  });

  it('can be switched at runtime, but not while a hook is out', () => {
    const session = new Session('q2winch');
    session.run(1);
    expect(session.grapple.configure({ mode: 'q3pull' })).toBe(false);
    expect(session.grapple.mode).toBe('q2winch');

    session.run(1, () => false);
    expect(session.grapple.configure({ mode: 'q2winch', pullSpeed: 900 })).toBe(true);
    session.catchWall();
    session.run(30);
    expect(sagless(session.state)).toBeCloseTo(900, 6);
  });
});

describe('a hook that catches a player', () => {
  /**
   * A hook thrown along +X from the origin, and a player standing 200 units down it, linked
   * where they stand. What stops the hook is handed in, since the room's trace sees no players.
   */
  function thrown(): { level: Level; hook: GameEntity; target: GameEntity; state: PlayerState } {
    const world = weaponWorld({ trace: room, grapple: 'q3pull' });
    const state = world.owner.client!.ps;
    Object.assign(state, plain());
    world.grapple.fire(true);

    const target = world.level.gentities[1];
    target.client = world.level.clients[1];
    target.inuse = true;
    target.takedamage = true;
    target.r.contents = CONTENTS.BODY;
    Object.assign(target.client.ps, createArmedPlayerState({ origin: vec3(200, 0, 24) }));
    linkPlayer(world.level, target);

    return { level: world.level, hook: world.grapple.hook!, target, state };
  }

  /** The trace that stopped the hook at the player's near face. */
  function atFace(): TraceResult {
    return {
      ...clearTrace(vec3(184.875, 0, 50)),
      fraction: 0.5,
      normal: vec3(-1, 0, 0),
      entityNum: 1,
      contents: CONTENTS.BODY
    };
  }

  it('holds at the middle of their box, names them, and follows them', () => {
    const { level, hook, target, state } = thrown();
    missileImpact(level, hook, atFace(), room);

    expect(hook.s.eType).toBe(ET.GRAPPLE);
    expect(hook.enemy).toBe(target);
    // Their box is −24 to 32 about an origin at z = 24, so its middle is at z = 28.
    expect(state.grapplePoint).toEqual(vec3(200, 0, 28));
    const impact = level.gentities.find(
      (e) => e.inuse && eventNumber(e.s.event) === EV.MISSILE_HIT
    )!;
    expect(impact.s.otherEntityNum).toBe(1);
    // A hook hurts nothing.
    expect(target.client!.ps.stats[STAT.HEALTH]).toBe(100);
  });

  it('moves its anchor to where they got to 100 ms on, once, and lags them after', () => {
    const { level, hook, target, state } = thrown();
    missileImpact(level, hook, atFace(), room);

    // Snapped back towards where the hook was, so 260.5 is 260.
    target.r.currentOrigin = vec3(260.5, 0, 24);
    level.time += HOOK_THINK_TIME;
    level.runThink(hook);
    expect(state.grapplePoint).toEqual(vec3(260, 0, 28));
    expect(hook.r.currentOrigin).toEqual(vec3(260, 0, 28));

    // `Weapon_HookThink` never arms itself again.
    target.r.currentOrigin = vec3(320, 0, 24);
    level.time += HOOK_THINK_TIME;
    level.runThink(hook);
    expect(state.grapplePoint).toEqual(vec3(260, 0, 28));
  });

  it('holds where it struck anything that is not a player, and follows nothing', () => {
    const { level, hook, state } = thrown();
    const corpse = level.spawnEntity();
    corpse.takedamage = true;
    missileImpact(level, hook, { ...atFace(), entityNum: corpse.s.number }, room);

    expect(hook.enemy).toBeNull();
    expect(state.grapplePoint).toEqual(vec3(184, 0, 50));
  });
});
