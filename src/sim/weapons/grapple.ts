import { TR, type PlayerState } from '../../net/protocol';
import { MASK, PMF_GRAPPLE_PULL, STAT } from '../constants';
import { dirToByte } from '../dir-byte';
import { EV } from '../events';
import { ET, SVF, addEvent, setEntityOrigin, type GameEntity } from '../game-entity';
import type { Level } from '../level';
import { accelerate } from '../pmove-math';
import type { TraceResult } from '../types';
import { add, copy, length, madd, normalize, scale, sub, vec3, type Vec3 } from '../vec3';
import { MISSILE_PRESTEP_TIME, WP } from './constants';
import { firingSolution, snapVectorTowards, truncVector } from './hitscan';

/**
 * The off-hand grappling hook.
 *
 * The hook is a missile (`fire_grapple`, `g_missile.c:682`): an ordinary entity in the level's
 * pool with `ET_MISSILE` on it and a trajectory on `s.pos`, run by `G_RunMissile` with the
 * rockets. What makes it a grapple is what its impact does — it stays in the world as
 * `ET_GRAPPLE`, and the pull it sets up is two fields on the player state that `pmove` reads.
 *
 * Three styles, chosen by CorkScrew's own `g_allowGrapple`. Each keeps its own game's
 * settings and behaviour, so choosing a style chooses its speeds too:
 *
 * - **`corkscrew`** (1) — the CorkScrew mod's own grapple, read from its compiled code.
 *   The hook flies at 1,600, and the pull is an *acceleration* toward the anchor, run ahead
 *   of the ordinary move, so a swing keeps its momentum.
 * - **`q3pull`** (2) — vanilla Quake 3's `PM_GrappleMove` (`bg_pmove.c:665`). Runs *inside* the
 *   move, aims at `grapplePoint − 16·forward` from the player origin so the target wanders
 *   with your view, eases in below 100 units, and then lets `PM_AirMove` run on top so you
 *   keep air control. Loose and steerable; you can orbit an anchor.
 * - **`q2winch`** (3) — Quake 2 CTF's winch (`ctf/g_ctf.c`, GPL). Runs *after* the move and
 *   hard-sets velocity to `normalize(hook − eye) * pullSpeed` every tick, wiping whatever
 *   pmove just produced, then adds a single frame of gravity. Stiff, fast and unsteerable:
 *   you snap to full speed the tick after the hook lands.
 *
 * Off-hand means the hook is not a weapon slot: firing it never changes `ps.weapon`, and
 * the weapon in hand keeps firing mid-swing. Releasing the key detaches.
 */

/** Which style the hook uses. */
export type GrappleMode = 'corkscrew' | 'q3pull' | 'q2winch';

/**
 * CorkScrew's `g_allowGrapple`, in its server menu's order: the value picks the style,
 * and 0 takes the hook away. The names are the menu's own.
 */
export const GRAPPLE_TYPES: readonly { mode: GrappleMode | null; name: string }[] = [
  { mode: null, name: 'disabled' },
  { mode: 'corkscrew', name: 'CorkScrew' },
  { mode: 'q3pull', name: 'Quake III' },
  { mode: 'q2winch', name: 'Quake II CTF' }
];

/** Q2 CTF's `CTF_GRAPPLE_SPEED` / `CTF_GRAPPLE_PULL_SPEED` (`ctf/g_ctf.h`). */
export const Q2_GRAPPLE_SPEED = 650;

/** Vanilla Q3's hook flight speed and pull cap (`fire_grapple`, `PM_GrappleMove`). */
export const Q3_GRAPPLE_SPEED = 800;

/**
 * CorkScrew's defaults for `g_grappleSpeed` and `g_grapplePull`, read from the cvar table in
 * its compiled game code.
 */
export const CORKSCREW_GRAPPLE_SPEED = 1600;
export const CORKSCREW_GRAPPLE_PULL = 800;

/**
 * CorkScrew's pull accelerates at 20 while the anchor is at least half the pull speed away.
 * Inside that, it heads for twice the distance, at `40 · distance / pull`.
 */
export const CORKSCREW_PULL_ACCEL = 20;
export const CORKSCREW_NEAR_ACCEL = 40;

/** A rope this steep (its direction's z, so 30 degrees) lifts CorkScrew's player off the ground. */
export const CORKSCREW_LIFT_Z = 0.5;

/**
 * Where Q2 CTF's hook leaves from (`CTFGrappleFire`): 24 units ahead and 8 to the right of the
 * player, and 6 below the eye — its `viewheight − 8 + 2`.
 */
export const Q2_GRAPPLE_OFFSET_FORWARD = 24;
export const Q2_GRAPPLE_OFFSET_RIGHT = 8;
export const Q2_GRAPPLE_OFFSET_UP = -6;

/** `PM_GrappleMove` aims this far in front of the anchor, so the target drifts with view. */
export const Q3_GRAPPLE_TARGET_OFFSET = 16;

/** Below this distance Q3's pull eases in linearly instead of running at full speed. */
export const Q3_GRAPPLE_EASE_DISTANCE = 100;

/**
 * How long a hook that catches nothing stays out — `fire_grapple`'s own `nextthink`, which is
 * the only lifetime it has. Nothing takes a caught one away but the player letting go.
 */
export const GRAPPLE_LIFETIME = 10000;

/**
 * `FRAMETIME` (`g_local.h`): when `Weapon_HookThink` runs after a catch. One server frame in the
 * original, and the same 100 ms here, since it is a duration rather than a count of frames.
 */
export const HOOK_THINK_TIME = 100;

/** `client->hook` with no hook out. Quake 3's is a null pointer. */
export const NO_HOOK = -1;

/** How a style throws its hook, in its own game. */
export interface GrappleStyle {
  hookSpeed: number;
  pullSpeed: number;
  /** Whether the launch velocity is truncated to whole units, as Q3's `SnapVector` does. */
  snap: boolean;
  /** Q2 CTF throws from beside the player; Q3 and CorkScrew from the muzzle point. */
  launch: 'muzzle' | 'q2';
  /**
   * Whether a hook lost while the key is still down is thrown again at once. CorkScrew's
   * `Weapon_HookFree` clears the flag that allows one throw per press; vanilla's doesn't.
   */
  refireWhileHeld: boolean;
}

const STYLES: Record<GrappleMode, GrappleStyle> = {
  corkscrew: {
    hookSpeed: CORKSCREW_GRAPPLE_SPEED,
    pullSpeed: CORKSCREW_GRAPPLE_PULL,
    snap: true,
    launch: 'muzzle',
    refireWhileHeld: true
  },
  q3pull: {
    hookSpeed: Q3_GRAPPLE_SPEED,
    pullSpeed: Q3_GRAPPLE_SPEED,
    snap: true,
    launch: 'muzzle',
    refireWhileHeld: false
  },
  q2winch: {
    hookSpeed: Q2_GRAPPLE_SPEED,
    pullSpeed: Q2_GRAPPLE_SPEED,
    snap: false,
    launch: 'q2',
    refireWhileHeld: false
  }
};

/**
 * `fire_grapple` (`g_missile.c:682–711`): throw the hook.
 *
 * Its own function rather than one of the `fire_*` family, because it carries none of what a
 * missile carries — no damage, no blast, no bounce — and one thing none of them do: the client
 * that threw it, in `s.otherEntityNum`, "use to match beam in client". That is how a client
 * picks its own hook out of a snapshot full of them and draws the cable to it.
 *
 * The 10 second `nextthink` is the hook's whole lifetime while it flies. A catch overwrites it,
 * so a hook in a wall is held until the player lets go.
 *
 * @param level - The level to spawn the hook in.
 * @param owner - The client throwing it: the hook's owner and its parent.
 * @param start - Where it leaves from.
 * @param dir - The aim, which need not be a unit vector.
 * @param style - The style throwing it, for the snap and the refire.
 * @param speed - Flight speed, which the style sets and a cvar may override.
 * @returns The hook's entity, already in the world.
 */
export function fireGrapple(
  level: Level,
  owner: GameEntity,
  start: Vec3,
  dir: Vec3,
  style: GrappleStyle,
  speed: number
): GameEntity {
  const aim = normalize(dir);

  const hook = level.spawnEntity();
  hook.classname = 'hook';
  hook.nextthink = level.time + GRAPPLE_LIFETIME;
  hook.think = (self) => hookFree(level, self, style.refireWhileHeld);
  hook.s.eType = ET.MISSILE;
  hook.r.svFlags = SVF.USE_CURRENT_ORIGIN;
  hook.s.weapon = WP.GRAPPLING_HOOK;
  hook.r.ownerNum = owner.s.number;
  hook.parent = owner;
  // It flies as any missile does, stopped by the world and by every player (`g_missile.c:696`).
  hook.clipmask = MASK.SHOT;

  hook.s.pos.trType = TR.LINEAR;
  // Unlagged's catch-up: timed from the thrower's command, a frame on, so the frame after the
  // throw finds the hook as far along as the command was behind the server's clock. A command on
  // or past the clock leaves it up to a frame behind the muzzle at first.
  hook.s.pos.trTime = owner.client
    ? owner.client.ps.commandTime + level.time - level.previousTime
    : level.time - MISSILE_PRESTEP_TIME;
  hook.s.otherEntityNum = owner.s.number;
  hook.s.pos.trBase = copy(start);
  const velocity = scale(aim, speed);
  hook.s.pos.trDelta = style.snap ? truncVector(velocity) : velocity;
  hook.r.currentOrigin = copy(start);

  if (owner.client) owner.client.hook = hook.s.number;

  return hook;
}

/**
 * `Weapon_HookFree` (`g_weapon.c:576–581`): the hook is gone, and so is the pull.
 *
 * Reached three ways — the key coming up, the 10 second `nextthink` on a hook that caught
 * nothing, and a restart — and all three end the same: the client has no hook, `pmove` has
 * nothing to pull toward, and the slot goes back.
 *
 * @param level - The level the hook is in.
 * @param hook - The hook entity.
 * @param refireWhileHeld - CorkScrew's own clears the one-throw-per-press flag as well, so a
 *   hook lost while the key is still down is thrown again on the next tick.
 */
export function hookFree(level: Level, hook: GameEntity, refireWhileHeld = false): void {
  const client = hook.parent?.client;
  if (client) {
    client.hook = NO_HOOK;
    client.ps.pmFlags &= ~PMF_GRAPPLE_PULL;
    if (refireWhileHeld) client.fireHeld = false;
  }
  level.freeEntity(hook);
}

/**
 * `Weapon_HookThink` (`g_weapon.c:583–598`): where the anchor has got to.
 *
 * A hook in a wall stays where it is. One that caught a player moves to the middle of their box,
 * snapped back towards where it was, but is not linked there: the world goes on finding it where
 * it caught, and only the pull follows.
 *
 * It runs once and never arms itself again, so a hook that caught a player corrects its anchor a
 * single time, 100 ms after the catch, and then lags them for as long as they are held. That is
 * the original's own behaviour rather than a simplification of it.
 */
function hookThink(hook: GameEntity): void {
  if (hook.enemy) {
    const anchor = snapVectorTowards(boxCentre(hook.enemy), hook.r.currentOrigin);
    setEntityOrigin(hook, anchor);
  }
  const client = hook.parent?.client;
  if (client) client.ps.grapplePoint = copy(hook.r.currentOrigin);
}

/** The middle of an entity's box, where it is for collision. */
function boxCentre(entity: GameEntity): Vec3 {
  return add(entity.r.currentOrigin, scale(add(entity.r.mins, entity.r.maxs), 0.5));
}

/**
 * The hook's branch of `G_MissileImpact` (`g_missile.c:364–408`): it caught something.
 *
 * Two entities come out of it, which is what makes the grapple unlike every other missile. The
 * hook *stays*: it stops being `ET_MISSILE` and becomes `ET_GRAPPLE`, the thing the cable is
 * drawn to, and it keeps its slot until the player lets go. Beside it goes a second entity
 * carrying nothing but the event saying where the catch happened, freed as soon as every client
 * has had time to see it.
 *
 * What it caught decides where it holds. A wall holds it where it struck. A player holds it at
 * the middle of their box, and becomes its enemy, which {@link hookThink} follows once; the event
 * is then `EV_MISSILE_HIT`, naming them.
 *
 * That second entity is not a `G_TempEntity`: Quake 3 spawns a plain `ET_GENERAL` one and puts
 * the event in `s.event` rather than in the entity type. The two are the same thing said two
 * ways, and this is the way said here.
 *
 * Nothing on the event names a weapon, so a client draws and sounds a catch on a wall as
 * `CG_MissileHitWall`'s default — which is the lightning gun's own case, a mark and a crackle
 * and no explosion.
 *
 * @param level - The level the hook is in.
 * @param hook - The hook that caught.
 * @param result - The trace that stopped it.
 */
export function hookImpact(level: Level, hook: GameEntity, result: TraceResult): void {
  const other = level.gentities[result.entityNum];
  const impact = level.spawnEntity();
  let caught: Vec3;
  if (other.takedamage && other.client) {
    addEvent(impact, EV.MISSILE_HIT, dirToByte(result.normal), level.time);
    impact.s.otherEntityNum = other.s.number;
    hook.enemy = other;
    caught = boxCentre(other);
  } else {
    caught = result.endpos;
    addEvent(impact, EV.MISSILE_MISS, dirToByte(result.normal), level.time);
    hook.enemy = null;
  }
  impact.freeAfterEvent = true;
  // "Change over to a normal entity right at the point of impact."
  impact.s.eType = ET.GENERAL;

  // Snapped back along the flight path rather than to the nearest unit, so the anchor and the
  // mark beside it can only end up outside the surface, never inside it.
  const anchor = snapVectorTowards(caught, hook.s.pos.trBase);
  hook.s.eType = ET.GRAPPLE;
  setEntityOrigin(hook, anchor);
  setEntityOrigin(impact, anchor);

  hook.think = hookThink;
  hook.nextthink = level.time + HOOK_THINK_TIME;

  const client = hook.parent?.client;
  if (client) {
    client.ps.pmFlags |= PMF_GRAPPLE_PULL;
    client.ps.grapplePoint = copy(hook.r.currentOrigin);
  }

  level.linkEntity(hook);
  level.linkEntity(impact);
}

/** The style, and speeds that override its own. */
export interface GrappleConfig {
  /** CorkScrew's `g_allowGrapple`: the style, or `null` for no hook at all. */
  mode: GrappleMode | null;
  /** Pull speed in units per second. Defaults to the style's own. */
  pullSpeed?: number;
  /** Hook flight speed. Defaults to the style's own. */
  hookSpeed?: number;
}

/** What a hook is thrown into, and by whom. */
export interface GrappleOptions extends Partial<GrappleConfig> {
  /** The world the hook is an entity in. */
  level: Level;
  /** The client who throws it: the hook's owner and parent. */
  owner: GameEntity;
}

/**
 * The off-hand hook for one client: `Weapon_GrapplingHook_Fire` and the release beside it.
 *
 * It holds the style and nothing else. Where the hook is, whether one is out and what it is
 * anchored to are all in the world — the entity in the level's pool, `client->hook` naming its
 * slot, and `PMF_GRAPPLE_PULL` with `ps.grapplePoint` on the player state, which is what makes
 * a hook something a snapshot can carry rather than something only the host knows about.
 */
export class Grapple {
  private readonly level: Level;
  private readonly owner: GameEntity;
  private config: GrappleConfig;

  /** @param options - The world to throw into, the client throwing, and the style. */
  constructor(options: GrappleOptions) {
    this.level = options.level;
    this.owner = options.owner;
    this.config = {
      mode: options.mode ?? 'corkscrew',
      pullSpeed: options.pullSpeed,
      hookSpeed: options.hookSpeed
    };
  }

  /** The style it throws in, or `null` while the hook is taken away. */
  get mode(): GrappleMode | null {
    return this.config.mode;
  }

  /**
   * The hook out in the world, or `null` for none — `client->hook`.
   *
   * Quake 3 holds the entity itself and the port holds its slot, so what is in the slot is
   * checked as well: a slot can be handed to something else, where a pointer cannot.
   */
  get hook(): GameEntity | null {
    const slot = this.owner.client?.hook ?? NO_HOOK;
    if (slot === NO_HOOK) return null;
    const entity = this.level.gentities[slot];
    return entity.inuse && entity.classname === 'hook' ? entity : null;
  }

  /**
   * What `pmove` needs for the pull it applies: the style, and the pull speed, which
   * `corkscrew` and `q3pull` read there. The Q2 winch pulls after the move ({@link applyPostMove}).
   *
   * Undefined with no style, which is a player who cannot throw a hook and so is never pulled.
   */
  get pmoveOptions(): { grappleMode: GrappleMode; grapplePullSpeed: number } | undefined {
    const { mode } = this.config;
    if (!mode) return undefined;
    return { grappleMode: mode, grapplePullSpeed: this.pullSpeed };
  }

  /**
   * Swap style or speeds at runtime, as a new `g_allowGrapple` does. A hook that is out
   * finishes as it was thrown: the change waits until it is back.
   *
   * @param config - The new style, or `null` to take the hook away.
   * @returns Whether the change was made, which it is not while a hook is out.
   */
  configure(config: GrappleConfig): boolean {
    if (this.hook) return false;
    this.config = { ...config };
    return true;
  }

  private get style(): GrappleStyle {
    return STYLES[this.config.mode ?? 'q3pull'];
  }

  /** Hook flight speed for the style. */
  private get hookSpeed(): number {
    return this.config.hookSpeed ?? this.style.hookSpeed;
  }

  /** Pull speed for the style. */
  private get pullSpeed(): number {
    return this.config.pullSpeed ?? this.style.pullSpeed;
  }

  /**
   * "Let go of the hook if we aren't firing" (`g_active.c:855–859`), which runs **before** the
   * move so that the tick the key comes up is a tick with no pull in it.
   *
   * The same call clears the one-throw-per-press flag. Quake 3 clears it in `ClientEndFrame`
   * from `EF_FIRING`, which is the weapon in hand; an off-hand hook has its own key and this is
   * where that key coming up is noticed.
   *
   * @param held - Whether the grapple key is down this tick.
   */
  checkRelease(held: boolean): void {
    if (held) return;
    const client = this.owner.client;
    if (client) client.fireHeld = false;
    this.release();
  }

  /**
   * `Weapon_GrapplingHook_Fire` (`g_weapon.c:568–574`) — one hook per press.
   *
   * Runs where `FireWeapon` runs, after the move and inside the same pass over the tick's
   * events, so the hook leaves from the muzzle point the tick ended at.
   *
   * A dead player throws nothing: `PM_Weapon` returns before any of its cases for one
   * (`bg_pmove.c:1550–1554`), and the hook is thrown outside the move, so the same test is made
   * here rather than inherited.
   *
   * @param held - Whether the grapple key is down this tick.
   */
  fire(held: boolean): void {
    if (!held) return;
    const client = this.owner.client;
    if (!client) return;
    if (client.ps.stats[STAT.HEALTH] <= 0) return;

    if (this.config.mode && !client.fireHeld && !this.hook) {
      const state = client.ps;
      const { muzzle, forward, right } = firingSolution(
        state.origin,
        state.viewangles,
        state.viewheight
      );
      const style = this.style;
      const start = style.launch === 'q2' ? q2LaunchPoint(state, forward, right) : muzzle;

      const hook = fireGrapple(this.level, this.owner, start, forward, style, this.hookSpeed);
      // Q2 CTF traces from the player to where the hook starts, so one thrown into a wall at
      // point-blank range still catches it; the first sweep from the origin stands in for that.
      if (style.launch === 'q2') hook.r.currentOrigin = copy(state.origin);
      this.level.linkEntity(hook);
    }

    client.fireHeld = true;
  }

  /**
   * Take the hook back, wherever it is. `player_die` does this too, so a hook out when its
   * owner dies is let go.
   */
  release(): void {
    const hook = this.hook;
    if (hook) hookFree(this.level, hook, this.style.refireWhileHeld);
  }

  /**
   * The Q2 winch pull, applied **after** the move has run.
   *
   * @param state - Player state; velocity is overwritten.
   * @param frametime - Tick length in seconds.
   */
  applyPostMove(state: PlayerState, frametime: number): void {
    grapplePostMove(state, this.config.mode, this.pullSpeed, frametime);
  }
}

/**
 * The Q2 winch pull, applied **after** the move has run ({@link Grapple.applyPostMove}, and the
 * client's replay of the same move, which has no grapple of its own).
 *
 * A hard set, not an acceleration: whatever pmove decided this tick is discarded. That is what
 * makes the Q2 grapple feel like a winch rather than a rope — no air control, no momentum, just a
 * rigid haul toward the anchor with a constant sag of one frame's gravity.
 *
 * @param state - Player state; velocity is overwritten.
 * @param mode - The grapple style in force, or null for none.
 * @param pullSpeed - The style's pull speed in units a second.
 * @param frametime - Tick length in seconds.
 */
export function grapplePostMove(
  state: PlayerState,
  mode: GrappleMode | null,
  pullSpeed: number,
  frametime: number
): void {
  if (mode !== 'q2winch') return;
  if (!(state.pmFlags & PMF_GRAPPLE_PULL)) return;

  const eye = vec3(state.origin.x, state.origin.y, state.origin.z + state.viewheight);
  const toHook = sub(state.grapplePoint, eye);
  if (length(toHook) === 0) return;

  state.velocity = scale(normalize(toHook), pullSpeed);
  // `SV_AddGravity` — one frame's worth, never accumulated, so it only ever sags.
  state.velocity.z -= state.gravity * frametime;
}

/** Where Q2 CTF's hook leaves from (`CTFGrappleFire`): beside the player, not from the eye. */
function q2LaunchPoint(state: PlayerState, forward: Vec3, right: Vec3): Vec3 {
  const eye = vec3(
    state.origin.x,
    state.origin.y,
    state.origin.z + state.viewheight + Q2_GRAPPLE_OFFSET_UP
  );
  return madd(madd(eye, Q2_GRAPPLE_OFFSET_FORWARD, forward), Q2_GRAPPLE_OFFSET_RIGHT, right);
}

/**
 * CorkScrew's own pull (`g_allowGrapple 1`), read from its compiled `bg_pmove`: an
 * acceleration toward the anchor with `PM_Accelerate`, where Q3 and Q2 CTF set the speed
 * outright.
 *
 * CorkScrew calls it from `PmoveSingle` ahead of the move chain, on a pull flag of its own, so
 * the ordinary walk, swim or air move still runs afterwards: friction, air control and gravity all
 * act on top of it, and a swing keeps its momentum. It measures from the player's origin, and
 * accelerates at 20 toward the pull speed until the anchor is half that distance away. Inside
 * that, it heads for twice the distance at `40 · distance / pull`, so the pull fades out as
 * the player arrives.
 *
 * @param state - Player state; velocity is accelerated in place.
 * @param pullSpeed - `g_grapplePull`; 800 by default.
 * @param frametime - Tick length in seconds.
 * @returns Whether the rope is steep enough to lift a walking player off the ground.
 */
export function grapplePullCorkScrew(
  state: PlayerState,
  pullSpeed: number,
  frametime: number
): boolean {
  const toAnchor = sub(state.grapplePoint, state.origin);
  const distance = length(toAnchor);
  if (distance === 0) return false;

  const dir = scale(toAnchor, 1 / distance);
  // `pull / 2` is an integer division in the original.
  if (distance < Math.trunc(pullSpeed / 2)) {
    const accel = distance * (CORKSCREW_NEAR_ACCEL / pullSpeed);
    state.velocity = accelerate(state.velocity, dir, 2 * distance, accel, frametime);
  } else {
    state.velocity = accelerate(state.velocity, dir, pullSpeed, CORKSCREW_PULL_ACCEL, frametime);
  }
  return dir.z > CORKSCREW_LIFT_Z;
}

/**
 * `PM_GrappleMove` (`bg_pmove.c:665`) — vanilla Q3's in-move pull.
 *
 * Aims at `grapplePoint − 16 · forward` measured from the player **origin**, not the eye,
 * and eases in linearly inside 100 units so you drift to the anchor instead of slamming
 * into it. The caller runs `PM_AirMove` immediately afterwards, which is where the air
 * control and gravity come back — the reason this mode feels like a rope you can steer.
 *
 * @param state - Player state; velocity is overwritten.
 * @param forward - View forward vector.
 * @param pullSpeed - Maximum pull speed; 800 in vanilla.
 */
export function grappleMoveQ3(
  state: PlayerState,
  forward: Vec3,
  pullSpeed = Q3_GRAPPLE_SPEED
): void {
  const target = madd(state.grapplePoint, -Q3_GRAPPLE_TARGET_OFFSET, forward);
  const toTarget = sub(target, state.origin);
  const distance = length(toTarget);
  if (distance === 0) {
    state.velocity = vec3();
    return;
  }

  const speed = distance <= Q3_GRAPPLE_EASE_DISTANCE ? 10 * distance : pullSpeed;
  state.velocity = scale(normalize(toTarget), Math.min(speed, pullSpeed));
}
