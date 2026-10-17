import { ENTITYNUM_NONE, ENTITYNUM_WORLD, type PlayerState } from '../net/protocol';
import {
  ANIM,
  TIMER_GESTURE,
  TIMER_LAND,
  continueLegsAnim,
  forceLegsAnim,
  startTorsoAnim
} from './animations';
import { toShort } from './client';
import {
  BOB_CYCLE_MASK,
  BOB_IDLE_SPEED,
  BOB_MOVE_DUCKED,
  BOB_MOVE_RUN,
  BUTTON_ATTACK,
  BUTTON_GESTURE,
  BUTTON_TALK,
  BUTTON_USE_HOLDABLE,
  CONTENTS,
  CRASH_LAND_SPEED,
  EF_FIRING,
  EF_TALK,
  FALL_DELTA_FAR,
  FALL_DELTA_MIN,
  FALL_DELTA_SCALE,
  FALL_DELTA_SHORT,
  GROUND_TRACE_DEPTH,
  MASK,
  MAX_CLIP_PLANES,
  MIN_WALK_NORMAL,
  MINS_Z,
  OVERCLIP,
  PITCH_LIMIT_DEGREES,
  PITCH_LIMIT_SHORT,
  PM_AIRACCELERATE,
  PM_DEAD,
  PM_DUCK_SCALE,
  PM_FLYACCELERATE,
  PM_FREEZE,
  PM_INTERMISSION,
  PM_SPECTATOR,
  PMF_ALL_TIMES,
  PMF_BACKWARDS_JUMP,
  PMF_BACKWARDS_RUN,
  PMF_DUCKED,
  PMF_GRAPPLE_PULL,
  PMF_JUMP_HELD,
  PMF_RESPAWNED,
  PMF_TIME_KNOCKBACK,
  PMF_TIME_LAND,
  PMF_TIME_WATERJUMP,
  PMOVE_MSEC,
  PS_PMOVEFRAMECOUNTBITS,
  STAT,
  STEP_EVENT_MIN_DELTA,
  STEPSIZE,
  SURF,
  SWIM_SINK_SPEED,
  TIME_LAND_MSEC,
  WATERJUMP_CLEAR_Z,
  WATERJUMP_FORWARD_SPEED,
  WATERJUMP_LEDGE_Z,
  WATERJUMP_MSEC,
  WATERJUMP_REACH,
  WATERJUMP_UP_SPEED
} from './constants';
import { EV, addPredictableEvent } from './events';
import { PW } from './items';
import {
  accelerate,
  angleVectors,
  applyFriction,
  clipVelocity,
  cmdScale,
  groundDrop,
  snapVector
} from './pmove-math';
import { ID_RULES, type SysteminfoRules } from './rules';
import {
  NO_CONTENTS,
  clearTrace,
  playerBounds,
  viewheightFor,
  type PointContentsFn,
  type TraceFn,
  type TraceResult,
  type UserCmd
} from './types';
import {
  CORKSCREW_GRAPPLE_PULL,
  grappleMoveQ3,
  grapplePullCorkScrew,
  type GrappleMode
} from './weapons/grapple';
import { pmWeapon, torsoAnimation, type WeaponTickInput } from './weapons/weapon-state';
import {
  copy,
  dot,
  cross,
  length,
  madd,
  normalize,
  scale,
  vec3,
  type Vec3
} from './vec3';

/**
 * ioquake3 player movement, ported to TypeScript.
 *
 * Faithful to `bg_pmove.c` / `bg_slidemove.c` in both equations and **call order** — several
 * behaviours (same-tick landing detection, jump resolved inside the walk move, the ground
 * trace running twice) live in the ordering rather than the maths.
 *
 * Simulated: walking, air movement, jumping, crouching, friction, acceleration, slide and
 * step moves, ground classification, the integer velocity snap, the walk cycle, the events the
 * view needs (step, landing, footstep, jump, splash), the `PM_Weapon` state machine, the knockback
 * friction window and the flight powerup's move. In a liquid it swims, wades and water-jumps, and
 * the floor's surface flags make it slick, keep a landing quiet, and pick its footsteps. It also
 * chooses the player's legs and torso animations where `bg_pmove.c` does, and moves a dead player
 * as a corpse.
 *
 * The weapon layer is a *sibling* of the move, not part of it: `PM_Weapon` emits events and
 * never touches velocity or origin (Q3 has no recoil), and knockback is applied to
 * `ps.velocity` between ticks by `weapons/splash.ts`, exactly where `ClientEvents` does it.
 * Damage, death and respawn are the game's, around the move (`player-life.ts`).
 *
 * Not simulated, and out of scope: the walk button, and every gameplay event Q3 emits beyond those
 * above.
 *
 * **The state it moves is `playerState_t` itself** — the one a snapshot carries — so the ground
 * is an entity number and the health is `stats[STAT_HEALTH]`. What the move does not own it does
 * not touch: the scores, the powerups, the delta angles. Its own working values are not on the
 * state at all but on the move, as Q3 keeps them on `pml_t`, which is why the ground *plane* is
 * here and only the ground *entity* is there.
 */

/**
 * Per-call inputs that are neither persistent state nor user command — Q3 carries these on
 * the `pmove_t` struct it builds fresh for each `Pmove()`.
 */
export interface PmoveOptions {
  /** See {@link WeaponTickInput.gauntletHit}. Defaults to false. */
  gauntletHit?: boolean;
  /** See {@link WeaponTickInput.freeAmmo}. Defaults to false. */
  freeAmmo?: boolean;
  /** See {@link WeaponTickInput.countdown}. Defaults to false. */
  countdown?: boolean;
  /**
   * Which grapple style is in force. `corkscrew` accelerates ahead of the ordinary
   * move and `q3pull` sets the velocity inside it; the Q2 winch is applied after the move, by
   * the caller. Defaults to `q3pull`.
   */
  grappleMode?: GrappleMode;
  /** Pull speed for `corkscrew` and `q3pull`; defaults to each one's own, 800 for both. */
  grapplePullSpeed?: number;
  /**
   * `pm->pmove_msec`: the longest tick a command is chopped into. Defaults to {@link PMOVE_MSEC}.
   */
  pmoveMsec?: number;
  /**
   * `pm->tracemask`: what the move's traces stop at, which the caller picks by who is moving
   * (`g_active.c:906–915`). Defaults to `MASK_PLAYERSOLID`, a living human's.
   */
  tracemask?: number;
  /**
   * `pm->noFootsteps`: running makes no footsteps, as `dmflags` 32 asks (`g_active.c:919`). A
   * landing's own footstep still sounds. Defaults to false.
   */
  noFootsteps?: boolean;
  /**
   * `pm->pointcontents`: what a point is inside, which the water level and the water jump ask.
   * Defaults to nothing anywhere, so a move with no world never swims.
   */
  pointContents?: PointContentsFn;
  /** The move's code: {@link Pmove}, or a class extending it. Defaults to {@link Pmove}. */
  core?: typeof Pmove;
  /** The rules of play, which the move reads its values and switches from. Defaults to id's. */
  rules?: Readonly<SysteminfoRules>;
}

/**
 * What a move leaves for the game beside the state: `pm->waterlevel`, `pm->watertype` and
 * `pm->touchents`.
 */
export interface PmoveResults {
  /** How deep in a liquid the player ended: 0 out of one, 1 at the feet, 2 the waist, 3 under. */
  waterlevel: number;
  /** The `CONTENTS_*` at the player's feet while in a liquid, and 0 out of one. */
  watertype: number;
  /**
   * The entities the last slice of the move stood on or ran into, each once, in the order met,
   * never the world, and no more than {@link MAXTOUCH}: what `ClientImpacts` touches.
   */
  touchents: number[];
}

/** `MAXTOUCH` (`bg_public.h:164`): the most entities one slice of a move can touch. */
export const MAXTOUCH = 32;

/** Bumps and planes the slide move is allowed before it gives up (bg_slidemove.c:45). */
const NUM_BUMPS = 4;/** Dot-product threshold for "the mover is heading into this plane" (bg_slidemove.c). */
const PLANE_INTERACT = 0.1;

/** Dot-product above which two clip planes count as the same plane. */
const SAME_PLANE = 0.99;

/**
 * On the tick the player leaves the ground, the legs go into a jump only if the ground is
 * further below than this (`PM_GroundTraceMissed`, bg_pmove.c:1081), or they would backflip
 * down every staircase.
 */
const JUMP_ANIM_DROP = 64;

/**
 * Speed a corpse on the ground loses per tick, whatever the tick's length (`PM_DeadMove`,
 * bg_pmove.c:826). At the 8 ms tick that is 2500 ups a second.
 */
const DEAD_FRICTION = 20;

/**
 * Advance the player to `cmd.serverTime`.
 *
 * Port of `Pmove` (bg_pmove.c:2025). Long commands are chopped into fixed slices of
 * `options.pmoveMsec`, which is Q3's `pmove_fixed 1` behaviour: every player gets the same
 * physics regardless of frame rate. Callers should advance time in multiples of the tick;
 * anything else leaves a short remainder tick, exactly as Q3 does.
 *
 * `state` is mutated in place, matching the C.
 *
 * @param state - Player state to advance.
 * @param cmd - Input to apply.
 * @param trace - `pm->trace`: the world, and whoever is in it besides the player.
 * @param options - Per-call inputs computed outside the move, such as the gauntlet's
 *   pre-move hit test.
 * @returns The water the last slice left the player in, which is none when no slice ran.
 */
export function pmove(
  state: PlayerState,
  cmd: UserCmd,
  trace: TraceFn,
  options: PmoveOptions = {}
): PmoveResults {
  const finalTime = cmd.serverTime;
  if (finalTime < state.commandTime) {
    return { waterlevel: 0, watertype: 0, touchents: [] };
  }

  // More than a second of backlog is discarded rather than simulated.
  if (finalTime > state.commandTime + 1000) {
    state.commandTime = finalTime - 1000;
  }

  // One frame per command, however many slices it takes (`Pmove`, bg_pmove.c:2038). The jump
  // pad's "is this the same pad as last frame" is what the count is for, and it is six bits.
  state.pmoveFramecount = (state.pmoveFramecount + 1) & ((1 << PS_PMOVEFRAMECOUNTBITS) - 1);

  const tick = options.pmoveMsec ?? PMOVE_MSEC;
  const working: UserCmd = { ...cmd, angles: copy(cmd.angles) };
  const results: PmoveResults = { waterlevel: 0, watertype: 0, touchents: [] };
  while (state.commandTime !== finalTime) {
    const msec = Math.min(finalTime - state.commandTime, tick);
    working.serverTime = state.commandTime + msec;
    const slice = new (options.core ?? Pmove)(state, working, trace, options);
    slice.run();
    results.waterlevel = slice.waterlevel;
    results.watertype = slice.watertype;
    results.touchents = slice.touchents;

    // Keep "jump is held" true across the slices of one command, so a chopped move cannot
    // be read as a release-and-press.
    if (state.pmFlags & PMF_JUMP_HELD) {
      working.upmove = 20;
    }
  }
  return results;
}

/**
 * `PM_UpdateViewAngles`'s pitch fix-up (`bg_pmove.c:1806–1822`): the limit is put on the delta
 * rather than on the view, so that a client holding an angle past it has nothing to wind off
 * before its view moves again — which is what a spawn leaves behind, since the facing it gives the
 * player is a delta against the angles they were already holding. The move is handed degrees with
 * the delta already in them and so cannot do it there; whoever builds that command runs this first.
 *
 * Its two early returns are Quake 3's own (`:1800–1806`): nobody turns at the intermission, and a
 * dead player's view does not move at all, delta and all — with a spectator the exception, since
 * whoever is watching goes on turning whatever their last body's health was.
 *
 * @param ps - The player state whose delta is fixed up.
 * @param angles - The command's angles, as shorts.
 */
export function clampViewPitchDelta(ps: PlayerState, angles: readonly number[]): void {
  if (ps.pmType === PM_INTERMISSION) return;
  if (ps.pmType !== PM_SPECTATOR && ps.stats[STAT.HEALTH] <= 0) return;

  const pitch = toShort(angles[0] + ps.deltaAngles.x);
  if (pitch > PITCH_LIMIT_SHORT) {
    ps.deltaAngles.x = PITCH_LIMIT_SHORT - angles[0];
  } else if (pitch < -PITCH_LIMIT_SHORT) {
    ps.deltaAngles.x = -PITCH_LIMIT_SHORT - angles[0];
  }
}

/**
 * One simulation tick. Port of `PmoveSingle` (bg_pmove.c:1835).
 *
 * Instance fields correspond to Q3's `pml` locals, which are zeroed every move for
 * determinism — here that falls out of constructing the object per tick.
 *
 * Its steps are protected, and split where CPMA's move departs from id's, so a class extending it
 * replaces a step and calls id's for the rest. {@link PmoveOptions.core} picks the class.
 */
export class Pmove {
  protected readonly state: PlayerState;
  protected readonly cmd: UserCmd;
  protected readonly traceFn: TraceFn;
  protected readonly pointContentsFn: PointContentsFn;

  /** `pm->waterlevel`, `pm->watertype` and `pm->touchents`: see {@link PmoveResults}. */
  waterlevel = 0;
  watertype = 0;
  readonly touchents: number[] = [];

  protected msec = 0;
  protected frametime = 0;
  protected forward = vec3();
  protected right = vec3();
  protected walking = false;
  protected groundPlane = false;
  protected groundTrace: TraceResult;
  protected previousOrigin = vec3();
  protected previousVelocity = vec3();
  /** The water level the move started at, which the water events compare the end's with. */
  protected previousWaterlevel = 0;
  protected mins = vec3();
  protected maxs = vec3();

  protected options: PmoveOptions;
  protected readonly rules: Readonly<SysteminfoRules>;
  protected readonly tracemask: number;

  /**
   * @param state - Player state to advance; mutated in place.
   * @param cmd - Input for this tick.
   * @param traceFn - `pm->trace`: the world, and whoever is in it besides the player.
   * @param options - Per-call inputs that are neither state nor user command.
   */
  constructor(state: PlayerState, cmd: UserCmd, traceFn: TraceFn, options: PmoveOptions = {}) {
    this.state = state;
    this.cmd = cmd;
    this.traceFn = traceFn;
    this.pointContentsFn = options.pointContents ?? NO_CONTENTS;
    this.options = options;
    this.rules = options.rules ?? ID_RULES;
    // "Corpses can fly through bodies" (`bg_pmove.c:1847–1849`).
    this.tracemask = options.tracemask ?? MASK.PLAYERSOLID;
    if (state.stats[STAT.HEALTH] <= 0) this.tracemask &= ~CONTENTS.BODY;
    this.groundTrace = clearTrace(state.origin);
    this.setBounds();
  }

  /**
   * `PM_AddEvent` (`bg_pmove.c:57–59`): raise one of the move's own events on the player state.
   *
   * Every event the move raises takes no argument, because the state it rides on already carries
   * everything a client would ask — which weapon fired is `ps.weapon`, and how far the player
   * fell is which of the three fall events it is.
   */
  protected addEvent(event: number) {
    addPredictableEvent(this.state, event);
  }

  /** Run the tick. Follows bg_pmove.c:1835's order exactly; see the class docs. */
  run() {
    const { state, cmd } = this;

    this.msec = clamp(cmd.serverTime - state.commandTime, 1, 200);
    state.commandTime = cmd.serverTime;
    this.frametime = this.msec * 0.001;
    this.previousOrigin = copy(state.origin);
    this.previousVelocity = copy(state.velocity);

    // The talk balloon: up while the talk button is held (`bg_pmove.c:1857–1861`).
    if (cmd.buttons & BUTTON_TALK) {
      state.eFlags |= EF_TALK;
    } else {
      state.eFlags &= ~EF_TALK;
    }

    this.buttonFlags();

    // Talking takes every other key (`bg_pmove.c:1878–1887`), "to prevent any possible intercept
    // proxy from adding fake talk balloons". The button itself stays, for the command's next tick.
    if (cmd.buttons & BUTTON_TALK) {
      cmd.buttons = BUTTON_TALK;
      cmd.forwardmove = 0;
      cmd.rightmove = 0;
      cmd.upmove = 0;
    }

    this.updateViewAngles();
    const basis = angleVectors(state.viewangles);
    this.forward = basis.forward;
    this.right = basis.right;

    // Jump must be released before it can be pressed again: vanilla Q3 has no auto-hop.
    if (cmd.upmove < 10) {
      state.pmFlags &= ~PMF_JUMP_HELD;
    }

    // The legs backpedal while moving back, and turn round again once the player moves
    // forward or only sideways (`bg_pmove.c:1920–1925`).
    if (cmd.forwardmove < 0) {
      state.pmFlags |= PMF_BACKWARDS_RUN;
    } else if (cmd.forwardmove > 0 || (cmd.forwardmove === 0 && cmd.rightmove)) {
      state.pmFlags &= ~PMF_BACKWARDS_RUN;
    }

    // A corpse has no say in where it goes (`bg_pmove.c:1927–1931`).
    if (state.pmType >= PM_DEAD) {
      cmd.forwardmove = 0;
      cmd.rightmove = 0;
      cmd.upmove = 0;
    }

    // A spectator's whole move (`bg_pmove.c:1933–1938`): the box, the fly move and the timers,
    // and none of the rest — no ground trace, so a spectator never lands, and no `PM_Weapon`, so
    // the gun is not run for somebody who has not got one. `PM_NOCLIP` is Q3's fourth branch and
    // is left out: nothing in the port sets `client.noclip`, and the port's debug flight is the
    // free camera.
    if (state.pmType === PM_SPECTATOR) {
      this.checkDuck();
      this.flyMove();
      this.dropTimers();
      return;
    }

    // Frozen, or watching from the intermission camera: no movement at all (`:1946–1952`).
    if (state.pmType === PM_FREEZE || state.pmType === PM_INTERMISSION) {
      return;
    }

    // How deep the move starts (`:1955–1956`), before the duck, so at the height the player was.
    this.setWaterLevel();
    this.previousWaterlevel = this.waterlevel;

    this.checkDuck();
    this.doGroundTrace();

    if (state.pmType === PM_DEAD) {
      this.deadMove();
    }

    this.dropTimers();
    this.moveTimers();

    const pulling = (state.pmFlags & PMF_GRAPPLE_PULL) !== 0;
    const grappleMode = this.options.grappleMode ?? 'q3pull';

    if (state.powerups[PW.FLIGHT]) {
      // The flight powerup's move replaces the chain whole (`bg_pmove.c:1975–1977`): no jump,
      // no grapple and no gravity — a 3D accelerate and slide.
      this.flyMove();
    } else if (pulling && grappleMode === 'corkscrew') {
      // CorkScrew pulls first, as an acceleration, and the ordinary move then runs on top of it:
      // it calls its pull from `PmoveSingle` ahead of the move chain, on a flag of its own,
      // rather than as the chain's grapple branch.
      const pull = this.options.grapplePullSpeed ?? CORKSCREW_GRAPPLE_PULL;
      if (grapplePullCorkScrew(state, pull, this.frametime)) this.walking = false;
      this.groundPlane = false;
      this.ordinaryMove();
    } else if (pulling && grappleMode !== 'corkscrew') {
      // `PmoveSingle` dispatches the grapple ahead of walk and air moves, then runs
      // `PM_AirMove` on top of it — the pull sets the velocity and the air move layers
      // steering, gravity and, on the floor, friction back over the result. Only vanilla-Q3
      // mode pulls in here; the Q2 winch is a post-move hard set, applied by the caller.
      if (grappleMode !== 'q2winch') {
        // `PM_GrappleMove` clears the ground plane but not `pml.walking` (bg_pmove.c:665–683),
        // so a player pulled along the floor still takes ground friction.
        grappleMoveQ3(state, this.forward, this.options.grapplePullSpeed);
        this.groundPlane = false;
      } else {
        // The winch is Q2's, not Q3's, and keeps a friction-free air move.
        this.walking = false;
      }
      this.airMove();
    } else {
      this.ordinaryMove();
    }

    this.animate();

    // Second ground trace: this is what makes landing register on the same tick it happens. Then
    // how deep the move ended.
    this.doGroundTrace();
    this.setWaterLevel();

    // `PM_Weapon` sits here in `PmoveSingle` — after the ground trace, before footsteps and
    // the velocity snap. It reads state and emits events; it never moves the player.
    this.weapon();

    this.footsteps();
    this.waterEvents();

    this.snap();
  }

  /**
   * The rest of `PmoveSingle`'s branches (`bg_pmove.c:1982–1993`), by where the player is: the
   * water jump while it runs, a swim at the waist or deeper, a walk on the ground, and otherwise
   * the air.
   */
  protected ordinaryMove() {
    if (this.state.pmFlags & PMF_TIME_WATERJUMP) {
      this.waterJumpMove();
    } else if (this.waterlevel > 1) {
      this.waterMove();
    } else if (this.walking) {
      this.walkMove();
    } else {
      this.airMove();
    }
  }

  /**
   * The flags `PmoveSingle` reads off the buttons before anything moves (`bg_pmove.c:1865–1877`):
   * the firing flag, and the end of a respawn.
   */
  protected buttonFlags() {
    const { state, cmd } = this;

    // The firing flag for the continuous weapons: attack held, with ammo, and not since a
    // respawn. Q3's other two conditions, intermission and noclip, have no state here.
    if (
      !(state.pmFlags & PMF_RESPAWNED) &&
      (cmd.buttons & BUTTON_ATTACK) !== 0 &&
      Boolean(state.ammo[state.weapon])
    ) {
      state.eFlags |= EF_FIRING;
    } else {
      state.eFlags &= ~EF_FIRING;
    }

    // A living player whose attack and use keys are both up is past their respawn: "clear the
    // respawned flag if attack and use are cleared", so the click that respawned a player uses
    // nothing either until every button is let go.
    if (
      state.stats[STAT.HEALTH] > 0 &&
      !(cmd.buttons & (BUTTON_ATTACK | BUTTON_USE_HOLDABLE))
    ) {
      state.pmFlags &= ~PMF_RESPAWNED;
    }
  }

  /**
   * Timers of the move's own, run after `PM_DropTimers` for a player and not for a spectator.
   * id's move has none.
   */
  protected moveTimers() {}

  /** `PM_Weapon`, then `PM_TorsoAnimation`. */
  protected weapon() {
    pmWeapon(this.state, this.cmd, this.msec, this.weaponInput(), this.rules);
    torsoAnimation(this.state);
  }

  /** What the weapon step is told from outside the move. */
  protected weaponInput(): WeaponTickInput {
    return {
      gauntletHit: this.options.gauntletHit ?? false,
      freeAmmo: this.options.freeAmmo ?? false,
      countdown: this.options.countdown ?? false
    };
  }

  /**
   * "Snap some parts of playerstate to save network bandwidth" (`bg_pmove.c:2014–2015`): the
   * velocity in whole units, which {@link snapVector} says the feel depends on.
   */
  protected snap() {
    this.state.velocity = snapVector(this.state.velocity);
  }

  /**
   * Port of `PM_UpdateViewAngles` (bg_pmove.c:1796), reduced to the pitch clamp. A dead player's
   * view does not move at all: it keeps the angles `player_die` gave it, and so does a player
   * held at the intermission camera. A spectator is the exception the health test carries
   * (`:1804`): whoever is spectating goes on turning whatever their last body's health was.
   */
  protected updateViewAngles() {
    if (this.state.pmType === PM_INTERMISSION) {
      return;
    }
    if (this.state.pmType !== PM_SPECTATOR && this.state.stats[STAT.HEALTH] <= 0) {
      return;
    }
    const { angles } = this.cmd;
    this.state.viewangles = vec3(
      clamp(angles.x, -PITCH_LIMIT_DEGREES, PITCH_LIMIT_DEGREES),
      angles.y,
      angles.z
    );
  }

  /**
   * Port of `PM_CheckDuck` (bg_pmove.c:1248). Ducking is instant; standing up requires a
   * zero-length trace with the standing box to come back clear, which is the headroom test.
   * A corpse lies at the floor whatever was held.
   */
  protected checkDuck() {
    const { state, cmd } = this;

    if (state.pmType === PM_DEAD) {
      this.setBounds();
      state.viewheight = viewheightFor(false, true);
      return;
    }

    if (cmd.upmove < 0) {
      state.pmFlags |= PMF_DUCKED;
    } else if (state.pmFlags & PMF_DUCKED) {
      const standing = playerBounds(false);
      const headroom = this.traceFn(
        state.origin,
        standing.mins,
        standing.maxs,
        state.origin,
        state.clientNum,
        this.tracemask
      );
      if (!headroom.allsolid) {
        state.pmFlags &= ~PMF_DUCKED;
      }
    }

    this.setBounds();
    state.viewheight = viewheightFor(this.ducked);
  }

  /**
   * Port of `PM_GroundTrace` (bg_pmove.c:1106). Produces the three-way classification the
   * feel depends on: walkable ground, steep slope (touching but sliding), and airborne.
   */
  protected doGroundTrace() {
    const { state } = this;
    const probe = vec3(state.origin.x, state.origin.y, state.origin.z - GROUND_TRACE_DEPTH);
    let trace = this.trace(state.origin, probe);

    if (trace.allsolid) {
      const corrected = this.correctAllSolid();
      if (!corrected) {
        this.setAirborne();
        return;
      }
      trace = corrected;
    }
    this.groundTrace = trace;

    if (trace.fraction === 1) {
      this.groundTraceMissed();
      return;
    }

    // Launched off the ground by a jump pad or explosion: do not re-attach this tick, and go
    // into the jump animation.
    if (state.velocity.z > 0 && dot(state.velocity, trace.normal) > 10) {
      this.forceJumpAnim();
      this.setAirborne();
      return;
    }

    // Too steep to stand on. Still a ground *plane*, so the air move clips against it and
    // the player slides down rather than sticking.
    if (trace.normal.z < MIN_WALK_NORMAL) {
      state.groundEntityNum = ENTITYNUM_NONE;
      this.groundPlane = true;
      this.walking = false;
      return;
    }

    // Solid ground ends a water jump, and the landing's hold with it (`bg_pmove.c:1167–1172`).
    if (state.pmFlags & PMF_TIME_WATERJUMP) {
      state.pmFlags &= ~(PMF_TIME_WATERJUMP | PMF_TIME_LAND);
      state.pmTime = 0;
    }

    if (state.groundEntityNum === ENTITYNUM_NONE) {
      this.crashLand();

      if (this.previousVelocity.z < CRASH_LAND_SPEED) {
        // Hard landing: collisions move the player but stop altering velocity for a moment.
        state.pmFlags |= PMF_TIME_LAND;
        state.pmTime = TIME_LAND_MSEC;
      }
    }

    state.groundEntityNum = trace.entityNum;
    this.groundPlane = true;
    this.walking = true;

    this.addTouchEnt(trace.entityNum);
  }

  /**
   * `PM_AddTouchEnt` (`bg_pmove.c:66-86`): something the move stood on or ran into, for the game
   * to touch once the move is over. The world is touched by nobody.
   */
  protected addTouchEnt(entityNum: number) {
    if (entityNum === ENTITYNUM_WORLD) return;
    if (this.touchents.length === MAXTOUCH) return;
    // "See if it is already added."
    if (this.touchents.includes(entityNum)) return;
    this.touchents.push(entityNum);
  }

  /**
   * Port of `PM_GroundTraceMissed` (bg_pmove.c:1068): the player is in free fall. On the tick
   * they leave the ground, the legs go into a jump if the ground is more than 64 units below;
   * a smaller drop, a stair, keeps them running.
   */
  protected groundTraceMissed() {
    const { state } = this;
    if (state.groundEntityNum !== ENTITYNUM_NONE) {
      const below = vec3(state.origin.x, state.origin.y, state.origin.z - JUMP_ANIM_DROP);
      if (this.trace(state.origin, below).fraction === 1) {
        this.forceJumpAnim();
      }
    }
    this.setAirborne();
  }

  /**
   * Force the legs into a jump: `LEGS_JUMPB` when moving back, which the landing remembers
   * through `PMF_BACKWARDS_JUMP` (bg_pmove.c:383–389).
   */
  protected forceJumpAnim() {
    const { state } = this;
    if (this.cmd.forwardmove >= 0) {
      forceLegsAnim(state, ANIM.LEGS_JUMP);
      state.pmFlags &= ~PMF_BACKWARDS_JUMP;
    } else {
      forceLegsAnim(state, ANIM.LEGS_JUMPB);
      state.pmFlags |= PMF_BACKWARDS_JUMP;
    }
  }

  /**
   * Port of `PM_CrashLand` (bg_pmove.c:923), reduced to the landing animation, the events it
   * raises and the restart of the walk cycle.
   *
   * The tick that lands is also the tick that stops the fall, so the velocity at the moment
   * of impact is nowhere in the state: `velocity` has already been clipped by the floor and
   * `previousVelocity` is the speed at the *start* of the tick. Q3 recovers the true impact
   * speed by solving the constant-acceleration quadratic for the time `t` at which the player
   * had fallen the distance actually covered, and reading the speed off at that instant.
   */
  protected crashLand() {
    const { state } = this;

    // The landing plays before anything else, and holds the legs for 130 ms.
    if (state.pmFlags & PMF_BACKWARDS_JUMP) {
      forceLegsAnim(state, ANIM.LEGS_LANDB);
    } else {
      forceLegsAnim(state, ANIM.LEGS_LAND);
    }
    state.legsTimer = TIMER_LAND;

    const dist = state.origin.z - this.previousOrigin.z;
    const vel = this.previousVelocity.z;
    const acc = -state.gravity;

    const a = acc / 2;
    const b = vel;
    const c = -dist;

    const den = b * b - 4 * a * c;
    if (den < 0) {
      return;
    }
    const t = (-b - Math.sqrt(den)) / (2 * a);

    const impact = vel + t * acc;
    let delta = impact * impact * FALL_DELTA_SCALE;
    if (this.ducked) {
      delta *= this.rules.pmove_FallDeltaDuckScale;
    }

    // Water breaks a fall: entirely with the head under, and by half or three quarters with the
    // feet or the waist in it (bg_pmove.c:962–973).
    if (this.waterlevel === 3) {
      return;
    }
    if (this.waterlevel === 2) {
      delta *= 0.25;
    }
    if (this.waterlevel === 1) {
      delta *= 0.5;
    }

    // Too soft to count: no sound, and the stride carries on (bg_pmove.c:975–977).
    if (delta < FALL_DELTA_MIN) {
      return;
    }

    // A floor that never hurts, as a bounce pad's, makes no sound either (bg_pmove.c:981–983).
    if (!(this.groundTrace.surfaceFlags & SURF.NODAMAGE)) {
      if (delta > FALL_DELTA_FAR) {
        this.addEvent(EV.FALL_FAR);
      } else if (delta > this.rules.pmove_FallDeltaMedium) {
        // A pain grunt, so not for a dead player (bg_pmove.c:987–990).
        if (state.stats[STAT.HEALTH] > 0) {
          this.addEvent(EV.FALL_MEDIUM);
        }
      } else if (delta > FALL_DELTA_SHORT) {
        this.addEvent(EV.FALL_SHORT);
      } else {
        this.addEvent(this.footstepEvent());
      }
    }

    // Any landing that counts starts the stride over (bg_pmove.c:998–999).
    state.bobCycle = 0;
  }

  /**
   * Port of `PM_Footsteps` (bg_pmove.c:1321): the walk cycle, its footstep or splash event and the
   * legs' animation.
   *
   * The cycle only advances while grounded and holding a movement key, which is why the view
   * bob stops dead when you do, and freezes mid-stride rather than resetting when you jump.
   * Q3's walk button is not ported, so the player is always running, and a crouched player
   * never plays a footstep. Nor does anyone under {@link PmoveOptions.noFootsteps}
   * (`bg_pmove.c:1410`). In water each stride splashes instead, crouched or not, and with the head
   * under it makes no sound.
   */
  protected footsteps() {
    const { state, cmd } = this;

    // Airborne leaves the cycle, and the legs, where they are, unless the player is swimming.
    if (state.groundEntityNum === ENTITYNUM_NONE) {
      if (this.waterlevel > 1) {
        continueLegsAnim(state, ANIM.LEGS_SWIM);
      }
      return;
    }

    if (!cmd.forwardmove && !cmd.rightmove) {
      const xyspeed = Math.hypot(state.velocity.x, state.velocity.y);
      if (xyspeed < BOB_IDLE_SPEED) {
        state.bobCycle = 0;
        continueLegsAnim(state, this.ducked ? ANIM.LEGS_IDLECR : ANIM.LEGS_IDLE);
      }
      return;
    }

    const backwards = (state.pmFlags & PMF_BACKWARDS_RUN) !== 0;
    let bobmove: number;
    if (this.ducked) {
      bobmove = BOB_MOVE_DUCKED;
      continueLegsAnim(state, backwards ? ANIM.LEGS_BACKCR : ANIM.LEGS_WALKCR);
    } else {
      bobmove = BOB_MOVE_RUN;
      continueLegsAnim(state, backwards ? ANIM.LEGS_BACK : ANIM.LEGS_RUN);
    }

    const old = state.bobCycle;
    state.bobCycle = (old + bobmove * this.msec) & BOB_CYCLE_MASK;

    // Offsetting by 64 puts the boundary at the extremes of the stride rather than the
    // middle, so the foot lands with the bob, not halfway through it.
    if (((old + 64) ^ (state.bobCycle + 64)) & 128) {
      if (this.waterlevel === 0) {
        if (!this.ducked && !this.options.noFootsteps) {
          this.addEvent(this.footstepEvent());
        }
      } else if (this.waterlevel === 1) {
        this.addEvent(EV.FOOTSPLASH);
      } else if (this.waterlevel === 2) {
        this.addEvent(EV.SWIM);
      }
    }
  }

  /**
   * Port of `PM_Animate` (bg_pmove.c:1713): the gesture button plays `TORSO_GESTURE` and holds
   * the torso for its length. Team Arena's other signals have no button here.
   */
  protected animate() {
    const { state, cmd } = this;
    if (cmd.buttons & BUTTON_GESTURE && state.torsoTimer === 0) {
      startTorsoAnim(state, ANIM.TORSO_GESTURE);
      state.torsoTimer = TIMER_GESTURE;
      this.addEvent(EV.TAUNT);
    }
  }

  /**
   * Port of `PM_DeadMove` (bg_pmove.c:816): a corpse on the ground loses 20 ups a tick until
   * it stops. In the air it falls as anything does.
   */
  protected deadMove() {
    if (!this.walking) {
      return;
    }
    const { state } = this;
    const speed = length(state.velocity) - DEAD_FRICTION;
    state.velocity = speed <= 0 ? vec3() : scale(normalize(state.velocity), speed);
  }

  /**
   * Port of `PM_CorrectAllSolid` (bg_pmove.c:1023). Crude depenetration: probe 27 positions
   * a unit apart and re-run the ground trace from the first one that is clear.
   */
  protected correctAllSolid(): TraceResult | null {
    const { origin } = this.state;

    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          const point = vec3(origin.x + i, origin.y + j, origin.z + k);
          if (this.trace(point, point).allsolid) {
            continue;
          }

          const probe = vec3(origin.x, origin.y, origin.z - GROUND_TRACE_DEPTH);
          return this.trace(origin, probe);
        }
      }
    }

    return null;
  }

  /** Port of `PM_DropTimers` (bg_pmove.c:1761): the movement timer and the animation holds. */
  protected dropTimers() {
    const { state } = this;

    if (state.pmTime) {
      if (this.msec >= state.pmTime) {
        state.pmFlags &= ~PMF_ALL_TIMES;
        state.pmTime = 0;
      } else {
        state.pmTime -= this.msec;
      }
    }

    if (state.legsTimer > 0) {
      state.legsTimer = Math.max(state.legsTimer - this.msec, 0);
    }
    if (state.torsoTimer > 0) {
      state.torsoTimer = Math.max(state.torsoTimer - this.msec, 0);
    }
  }

  /**
   * Port of `PM_CheckJump` (bg_pmove.c:358). Jump velocity is *assigned*, not added, so
   * jumping off a jump pad does not stack. There is no coyote time, no buffering and no
   * landing lockout — you can re-jump on the first tick you are grounded, which is what
   * makes strafe-jump chains possible. Nor can the player jump until attack has been let go
   * since their respawn.
   *
   * @returns Whether a jump was started this tick.
   */
  protected checkJump(): boolean {
    const { state, cmd } = this;

    if (state.pmFlags & PMF_RESPAWNED) {
      return false;
    }
    if (cmd.upmove < 10) {
      return false;
    }
    if (state.pmFlags & PMF_JUMP_HELD) {
      // Zeroed so PM_CmdScale does not count a held jump against horizontal speed.
      cmd.upmove = 0;
      return false;
    }

    this.groundPlane = false;
    this.walking = false;
    state.pmFlags |= PMF_JUMP_HELD;
    state.groundEntityNum = ENTITYNUM_NONE;
    state.velocity = vec3(state.velocity.x, state.velocity.y, this.jumpVelocity());
    this.addEvent(EV.JUMP);
    this.forceJumpAnim();
    return true;
  }

  /** The upward speed a jump leaves the ground with, which replaces whatever it had. */
  protected jumpVelocity(): number {
    return this.rules.pmove_JumpVelocity;
  }

  /**
   * Port of `PM_SetMovementDir` (bg_pmove.c:321): which of eight ways the legs face, from the
   * keys held. Letting go of a pure strafe leaves the legs on the forward diagonal, so the
   * player does not stop too crooked.
   */
  protected setMovementDir() {
    const { state } = this;
    const forward = this.cmd.forwardmove;
    const right = this.cmd.rightmove;

    if (forward || right) {
      if (right === 0 && forward > 0) state.movementDir = 0;
      else if (right < 0 && forward > 0) state.movementDir = 1;
      else if (right < 0 && forward === 0) state.movementDir = 2;
      else if (right < 0 && forward < 0) state.movementDir = 3;
      else if (right === 0 && forward < 0) state.movementDir = 4;
      else if (right > 0 && forward < 0) state.movementDir = 5;
      else if (right > 0 && forward === 0) state.movementDir = 6;
      else if (right > 0 && forward > 0) state.movementDir = 7;
    } else if (state.movementDir === 2) {
      state.movementDir = 1;
    } else if (state.movementDir === 6) {
      state.movementDir = 7;
    }
  }

  /**
   * Port of `PM_WalkMove` (bg_pmove.c:691). Its swim start and its jump into a swim (`:700–715`)
   * are not ported: nobody waist deep or more reaches the walk, as {@link ordinaryMove} sends them
   * to the swim.
   */
  protected walkMove() {
    const { state, rules } = this;

    if (this.checkJump()) {
      this.airMove();
      return;
    }

    // Ground friction is suppressed for the knockback window and on a slick floor (`PM_Friction`):
    // without this, a rocket jump's horizontal speed would be scrubbed off the instant it left the
    // floor, and rocket-jumping across a room would not work.
    const slipping =
      (state.pmFlags & PMF_TIME_KNOCKBACK) !== 0 ||
      (this.groundTrace.surfaceFlags & SURF.SLICK) !== 0;
    this.friction();

    const scaleFactor = cmdScale(this.cmd, state.speed);
    this.setMovementDir();
    const groundNormal = this.groundTrace.normal;

    // Project the view axes onto the ground plane rather than flattening to z = 0, so
    // movement follows the slope.
    let forward = clipVelocity(vec3(this.forward.x, this.forward.y, 0), groundNormal, OVERCLIP);
    let right = clipVelocity(vec3(this.right.x, this.right.y, 0), groundNormal, OVERCLIP);
    forward = normalize(forward);
    right = normalize(right);

    const wishvel = madd(
      scale(forward, this.cmd.forwardmove),
      this.cmd.rightmove,
      right
    );
    const wishdir = normalize(wishvel);
    let wishspeed = length(wishvel) * scaleFactor;
    wishspeed = this.duckWishSpeed(wishspeed);

    // Wading, or walking on the bottom (bg_pmove.c:758–767): the wish is held toward the swim's
    // share of the speed, a third of the way at each water level. id's has the swim's scale at
    // every level, and CPMA's the wade's at the first, which by default is the swim's.
    if (this.waterlevel) {
      const share = this.waterlevel === 1 ? rules.pmove_WaterWadeScale : rules.pmove_WaterSwimScale;
      const waterScale = 1 - (1 - share) * (this.waterlevel / 3);
      wishspeed = Math.min(wishspeed, state.speed * waterScale);
    }

    // A player who has just been hit, or has just spawned, loses full control for the
    // knockback window, as does one on a slick floor: they accelerate at the air rate and fall
    // as in the air, so a blast can move them along the floor (bg_pmove.c:769–787).
    state.velocity = accelerate(
      state.velocity,
      wishdir,
      wishspeed,
      this.walkAccelerate(slipping),
      this.frametime
    );
    if (slipping) {
      state.velocity = vec3(
        state.velocity.x,
        state.velocity.y,
        state.velocity.z - state.gravity * this.frametime
      );
    }

    // Outside that window walking applies no gravity, and the speed magnitude is restored after
    // clipping to the ground plane — together these are why slopes neither slow you down nor
    // speed you up. Inside it the fall is part of the magnitude, and the clip turns it along the
    // floor.
    this.clipToGround(groundNormal);

    if (state.velocity.x === 0 && state.velocity.y === 0) {
      return;
    }

    this.stepSlideMove(false);
  }

  /** The walk move's crouch (`bg_pmove.c:753–757`): the wish held to a quarter of the speed. */
  protected duckWishSpeed(wishspeed: number): number {
    if (!this.ducked) return wishspeed;
    return Math.min(wishspeed, this.state.speed * PM_DUCK_SCALE);
  }

  /**
   * The walk move's acceleration (`bg_pmove.c:771–775`): the air's in the knockback window and on
   * a slick floor.
   *
   * @param slipping - Whether either holds.
   */
  protected walkAccelerate(slipping: boolean): number {
    return slipping ? PM_AIRACCELERATE : this.rules.pmove_WalkAccel;
  }

  /**
   * The walk move's clip to the ground (`bg_pmove.c:790–798`), and the swim's along a slope it is
   * heading into (`:522–531`), which keep the speed.
   */
  protected clipToGround(normal: Vec3) {
    const { state } = this;
    const speed = length(state.velocity);
    state.velocity = clipVelocity(state.velocity, normal, OVERCLIP);
    state.velocity = scale(normalize(state.velocity), speed);
  }

  /** Port of `PM_AirMove` (bg_pmove.c:600). */
  protected airMove() {
    const { state } = this;

    // Friction runs in the air too (bg_pmove.c:609). Off the ground it measures the whole
    // speed, fall included, and removes nothing, so all it does is stop a drift under 1 ups.
    this.friction();

    const scaleFactor = cmdScale(this.cmd, state.speed);
    this.setMovementDir();

    const forward = normalize(vec3(this.forward.x, this.forward.y, 0));
    const right = normalize(vec3(this.right.x, this.right.y, 0));
    const wishvel = madd(scale(forward, this.cmd.forwardmove), this.cmd.rightmove, right);
    const wishdir = normalize(wishvel);
    const wishspeed = length(wishvel) * scaleFactor;

    this.airAccelerate(wishdir, wishspeed);

    // Standing on something too steep to walk on: clip against it so we slide off.
    if (this.groundPlane) {
      state.velocity = clipVelocity(state.velocity, this.groundTrace.normal, OVERCLIP);
    }

    this.stepSlideMove(true);
  }

  /** The air move's acceleration (`bg_pmove.c:637`). */
  protected airAccelerate(wishdir: Vec3, wishspeed: number) {
    const { state } = this;
    state.velocity = accelerate(
      state.velocity,
      wishdir,
      wishspeed,
      PM_AIRACCELERATE,
      this.frametime
    );
  }

  /**
   * Port of `PM_FlyMove` (bg_pmove.c:559), the flight powerup's move.
   *
   * Three differences from the air move. The wish direction is the **view's own**, so looking up
   * and pressing forward climbs; `upmove` is a third axis rather than a jump, and jump is never
   * checked, so the button held down flies instead of leaping. And no gravity is integrated:
   * a flying player who stops climbing hangs where they are.
   *
   * It is a level with a full 3D accelerate, so the friction it runs is the flight term (plus
   * the ground term underfoot, which is why flying along the floor is slower than running).
   *
   * A free spectator makes the same move (`bg_pmove.c:1933–1938`), and `PM_Friction` reads which
   * terms apply off the state rather than off the caller — the powerup for flight's 3, the move
   * type for the spectator's 5 — so a spectator's coast decays faster than a flying player's.
   */
  protected flyMove() {
    const { state } = this;

    this.friction();

    const scaleFactor = cmdScale(this.cmd, state.speed);
    let wishvel = vec3();
    if (scaleFactor !== 0) {
      wishvel = madd(
        scale(this.forward, scaleFactor * this.cmd.forwardmove),
        scaleFactor * this.cmd.rightmove,
        this.right
      );
      wishvel = vec3(wishvel.x, wishvel.y, wishvel.z + scaleFactor * this.cmd.upmove);
    }

    const wishdir = normalize(wishvel);
    const wishspeed = length(wishvel);

    state.velocity = accelerate(
      state.velocity,
      wishdir,
      wishspeed,
      PM_FLYACCELERATE,
      this.frametime
    );

    this.stepSlideMove(false);
  }

  /**
   * Port of `PM_WaterMove` (bg_pmove.c:470–534), the swim: a water jump if a ledge is in reach, and
   * otherwise a 3D accelerate along the view, as the fly move's, held to the swim's share of the
   * speed. With no keys held the player sinks, slowly.
   */
  protected waterMove() {
    const { state, cmd, rules } = this;

    if (this.checkWaterJump()) {
      this.waterJumpMove();
      return;
    }

    this.friction();

    const scaleFactor = cmdScale(cmd, state.speed);
    let wishvel = vec3(0, 0, -SWIM_SINK_SPEED);
    if (scaleFactor !== 0) {
      wishvel = madd(
        scale(this.forward, scaleFactor * cmd.forwardmove),
        scaleFactor * cmd.rightmove,
        this.right
      );
      wishvel = vec3(wishvel.x, wishvel.y, wishvel.z + scaleFactor * cmd.upmove);
    }

    const wishdir = normalize(wishvel);
    const wishspeed = Math.min(length(wishvel), state.speed * rules.pmove_WaterSwimScale);
    state.velocity = accelerate(
      state.velocity,
      wishdir,
      wishspeed,
      rules.pmove_WaterAccel,
      this.frametime
    );

    // "Make sure we can go up slopes easily under water."
    if (this.groundPlane && dot(state.velocity, this.groundTrace.normal) < 0) {
      this.clipToGround(this.groundTrace.normal);
    }

    this.slideMove(false);
  }

  /**
   * Port of `PM_CheckWaterJump` (bg_pmove.c:399–439): waist deep, facing a ledge whose lip is solid
   * within reach and whose top is clear, the player is thrown up and forward out of the water, and
   * moves as the water jump until they fall or land.
   *
   * The top is clear of anything solid to a player (`bg_pmove.c:427`): water, fog or a trigger
   * there does not refuse it, as anything there does in id's release.
   *
   * @returns Whether the jump started.
   */
  protected checkWaterJump(): boolean {
    const { state } = this;

    if (state.pmTime) {
      return false;
    }
    if (this.waterlevel !== 2) {
      return false;
    }

    const flat = normalize(vec3(this.forward.x, this.forward.y, 0));
    const spot = madd(state.origin, WATERJUMP_REACH, flat);
    spot.z += WATERJUMP_LEDGE_Z;
    if (!(this.pointContents(spot) & CONTENTS.SOLID)) {
      return false;
    }

    spot.z += WATERJUMP_CLEAR_Z;
    if (this.pointContents(spot) & (CONTENTS.SOLID | CONTENTS.PLAYERCLIP | CONTENTS.BODY)) {
      return false;
    }

    // Along the whole view, so looking up throws the player less far forward.
    state.velocity = vec3(
      this.forward.x * WATERJUMP_FORWARD_SPEED,
      this.forward.y * WATERJUMP_FORWARD_SPEED,
      WATERJUMP_UP_SPEED
    );
    state.pmFlags |= PMF_TIME_WATERJUMP;
    state.pmTime = WATERJUMP_MSEC;
    return true;
  }

  /**
   * Port of `PM_WaterJumpMove` (bg_pmove.c:451–462): no control, only the step slide and the fall,
   * which ends the jump once the player is coming down.
   *
   * The fall is taken twice a tick, as Quake 3 takes it: the slide's gravity, which the jump's
   * timer keeps (`slideMove` restores the velocity it started with, its fall included, while
   * `pmTime` runs), and this move's own.
   */
  protected waterJumpMove() {
    const { state } = this;

    this.stepSlideMove(true);

    state.velocity = vec3(
      state.velocity.x,
      state.velocity.y,
      state.velocity.z - state.gravity * this.frametime
    );
    if (state.velocity.z < 0) {
      state.pmFlags &= ~PMF_ALL_TIMES;
      state.pmTime = 0;
    }
  }

  /**
   * Port of `PM_SetWaterLevel` (bg_pmove.c:1204–1239): how deep the player is in a liquid, sampled
   * at the feet, the waist and the eye, each only once the one below is in it. The type is what
   * the feet are in.
   */
  protected setWaterLevel() {
    const { state } = this;
    this.waterlevel = 0;
    this.watertype = 0;

    const { x, y } = state.origin;
    let cont = this.pointContents(vec3(x, y, state.origin.z + MINS_Z + 1));
    if (!(cont & MASK.WATER)) {
      return;
    }
    this.watertype = cont;
    this.waterlevel = 1;

    cont = this.pointContents(vec3(x, y, state.origin.z + this.waistHeight()));
    if (!(cont & MASK.WATER)) {
      return;
    }
    this.waterlevel = 2;

    cont = this.pointContents(vec3(x, y, state.origin.z + state.viewheight));
    if (cont & MASK.WATER) {
      this.waterlevel = 3;
    }
  }

  /**
   * How far above the origin the waist's sample is: halfway from the feet to the eye, in whole
   * units, as `PM_SetWaterLevel`'s `int`s divide.
   */
  protected waistHeight(): number {
    return MINS_Z + Math.trunc((this.state.viewheight - MINS_Z) / 2);
  }

  /**
   * Port of `PM_WaterEvents` (bg_pmove.c:1432–1460): a splash as the feet go in or come out, and
   * {@link headWaterEvents}.
   */
  protected waterEvents() {
    if (!this.previousWaterlevel && this.waterlevel) {
      this.addEvent(EV.WATER_TOUCH);
    }
    if (this.previousWaterlevel && !this.waterlevel) {
      this.addEvent(EV.WATER_LEAVE);
    }
    this.headWaterEvents();
  }

  /** The head's water events: going under, and coming up, which gasps (`bg_pmove.c:1450–1459`). */
  protected headWaterEvents() {
    if (this.previousWaterlevel !== 3 && this.waterlevel === 3) {
      this.addEvent(EV.WATER_UNDER);
    }
    if (this.previousWaterlevel === 3 && this.waterlevel !== 3) {
      this.addEvent(EV.WATER_CLEAR);
    }
  }

  /**
   * `PM_Friction` (`bg_pmove.c:172–230`), which every move runs, with its terms read off the state.
   * The ground's is a step of its own, and is off in the knockback window, on a slick floor and
   * waist deep in water. The water's runs even wading, and harder the deeper.
   */
  protected friction() {
    const { state } = this;
    state.velocity = applyFriction(
      state.velocity,
      this.walking,
      (state.pmFlags & PMF_TIME_KNOCKBACK) !== 0 ||
        (this.groundTrace.surfaceFlags & SURF.SLICK) !== 0 ||
        this.waterlevel > 1,
      this.frametime,
      Boolean(state.powerups[PW.FLIGHT]),
      state.pmType === PM_SPECTATOR,
      (speed) => this.groundFriction(speed),
      this.waterlevel * this.rules.pmove_WaterFriction
    );
  }

  /** `PM_Friction`'s ground term: {@link groundDrop}. */
  protected groundFriction(speed: number): number {
    return groundDrop(speed, this.rules.pmove_WalkFriction);
  }

  /**
   * Port of `PM_SlideMove` (bg_slidemove.c:45) — collide and slide, remembering the planes
   * already hit so the mover is never turned back into one of them.
   *
   * @param gravity - Whether to integrate gravity over this move.
   * @returns Whether the move was clipped at all, which is the caller's "try stepping" signal.
   */
  protected slideMove(gravity: boolean): boolean {
    const { state } = this;
    const primalVelocity = copy(state.velocity);
    let endVelocity = vec3();

    if (gravity) {
      // Trapezoidal integration: move at the average of the start and end vertical speeds,
      // but store the full end velocity. This makes jump arcs exact at any tick length.
      endVelocity = copy(state.velocity);
      endVelocity.z -= state.gravity * this.frametime;
      state.velocity = vec3(
        state.velocity.x,
        state.velocity.y,
        (state.velocity.z + endVelocity.z) * 0.5
      );
      primalVelocity.z = endVelocity.z;

      if (this.groundPlane) {
        state.velocity = clipVelocity(state.velocity, this.groundTrace.normal, OVERCLIP);
      }
    }

    let timeLeft = this.frametime;

    // Seed the plane list with the ground normal and our own direction of travel, so
    // clipping can never turn us into the ground or reverse us.
    const planes: Vec3[] = [];
    if (this.groundPlane) {
      planes.push(copy(this.groundTrace.normal));
    }
    planes.push(normalize(state.velocity));

    let bumpcount = 0;
    for (; bumpcount < NUM_BUMPS; bumpcount++) {
      const end = madd(state.origin, timeLeft, state.velocity);
      const trace = this.trace(state.origin, end);

      if (trace.allsolid) {
        // Trapped in solid. Keep the horizontal velocity so sideways acceleration can still
        // work us free.
        state.velocity = vec3(state.velocity.x, state.velocity.y, 0);
        return true;
      }

      if (trace.fraction > 0) {
        state.origin = copy(trace.endpos);
      }
      if (trace.fraction === 1) {
        break;
      }

      // "Save entity for contact."
      this.addTouchEnt(trace.entityNum);

      timeLeft -= timeLeft * trace.fraction;

      if (planes.length >= MAX_CLIP_PLANES) {
        state.velocity = vec3();
        return true;
      }

      // Hit a plane we already know about — nudge along it rather than adding a duplicate.
      const known = planes.some((plane) => dot(trace.normal, plane) > SAME_PLANE);
      if (known) {
        state.velocity = madd(state.velocity, 1, trace.normal);
        continue;
      }
      planes.push(copy(trace.normal));

      const clipped = this.clipToPlanes(planes, state.velocity, endVelocity, gravity);
      if (clipped === null) {
        // Wedged into a corner formed by three planes: stop dead.
        state.velocity = vec3();
        return true;
      }
      state.velocity = clipped.velocity;
      endVelocity = clipped.endVelocity;
    }

    if (gravity) {
      state.velocity = endVelocity;
    }
    if (state.pmTime) {
      // During the post-landing timer, collisions reposition the player but must not change
      // velocity.
      state.velocity = primalVelocity;
    }

    return bumpcount !== 0;
  }

  /**
   * Clip a velocity so it runs parallel to every plane it is heading into, following two
   * planes into their crease where necessary.
   *
   * @param planes - Plane normals hit so far this move.
   * @param velocity - Velocity to clip.
   * @param endVelocity - Full-gravity velocity to clip alongside it.
   * @param gravity - Whether `endVelocity` is in use.
   * @returns The clipped pair, or null if the mover is wedged by three planes.
   */
  protected clipToPlanes(
    planes: Vec3[],
    velocity: Vec3,
    endVelocity: Vec3,
    gravity: boolean
  ): { velocity: Vec3; endVelocity: Vec3 } | null {
    for (let i = 0; i < planes.length; i++) {
      if (dot(velocity, planes[i]) >= PLANE_INTERACT) {
        continue;
      }

      let clipped = clipVelocity(velocity, planes[i], OVERCLIP);
      let endClipped = gravity ? clipVelocity(endVelocity, planes[i], OVERCLIP) : endVelocity;

      for (let j = 0; j < planes.length; j++) {
        if (j === i || dot(clipped, planes[j]) >= PLANE_INTERACT) {
          continue;
        }

        clipped = clipVelocity(clipped, planes[j], OVERCLIP);
        endClipped = gravity ? clipVelocity(endClipped, planes[j], OVERCLIP) : endClipped;

        // Clipping against the second plane fixed the first too.
        if (dot(clipped, planes[i]) >= 0) {
          continue;
        }

        // Otherwise run along the crease where the two planes meet.
        const dir = normalize(cross(planes[i], planes[j]));
        clipped = scale(dir, dot(dir, velocity));
        endClipped = gravity ? scale(dir, dot(dir, endVelocity)) : endClipped;

        const wedged = planes.some(
          (plane, k) => k !== i && k !== j && dot(clipped, plane) < PLANE_INTERACT
        );
        if (wedged) {
          return null;
        }
      }

      return { velocity: clipped, endVelocity: endClipped };
    }

    return { velocity, endVelocity };
  }

  /**
   * Port of `PM_StepSlideMove` (bg_slidemove.c:244) — up, slide, down.
   *
   * The *whole* horizontal move is retried from 18 units higher and then snapped back down.
   * That is why stairs feel like ramps at speed. The instant vertical teleport it produces is
   * hidden by the view's step glide, driven by the `step` event raised here.
   *
   * @param gravity - Whether to integrate gravity over this move.
   */
  protected stepSlideMove(gravity: boolean) {
    const { state } = this;
    const startOrigin = copy(state.origin);
    const startVelocity = copy(state.velocity);

    if (!this.slideMove(gravity)) {
      return;
    }

    // Never step up while still rising, unless there is walkable ground just below.
    const down = vec3(startOrigin.x, startOrigin.y, startOrigin.z - STEPSIZE);
    let trace = this.trace(startOrigin, down);
    if (state.velocity.z > 0 && (trace.fraction === 1 || trace.normal.z < MIN_WALK_NORMAL)) {
      return;
    }

    const up = vec3(startOrigin.x, startOrigin.y, startOrigin.z + STEPSIZE);
    trace = this.trace(startOrigin, up);
    if (trace.allsolid) {
      return;
    }

    // May be less than STEPSIZE under a low ceiling.
    const stepSize = trace.endpos.z - startOrigin.z;

    state.origin = copy(trace.endpos);
    state.velocity = copy(startVelocity);
    this.slideMove(gravity);

    const settle = vec3(state.origin.x, state.origin.y, state.origin.z - stepSize);
    trace = this.trace(state.origin, settle);
    if (!trace.allsolid) {
      state.origin = copy(trace.endpos);
    }
    if (trace.fraction < 1) {
      state.velocity = clipVelocity(state.velocity, trace.normal, OVERCLIP);
    }

    this.stepEvent(state.origin.z - startOrigin.z);
  }

  /**
   * The step-up's event, for how far it rose.
   *
   * Q3 bands the rise to one of four step events by fixed thresholds — delta < 7 -> 4, < 11 -> 8,
   * < 15 -> 12, else 16 (`bg_slidemove.c:317–329`). This bands to the *nearest* event, not the
   * next multiple up: a 12.8-unit stair reports 12, not 16.
   *
   * @param rise - How far the step-up raised the player.
   */
  protected stepEvent(rise: number) {
    if (rise > STEP_EVENT_MIN_DELTA) {
      if (rise < 7) {
        this.addEvent(EV.STEP_4);
      } else if (rise < 11) {
        this.addEvent(EV.STEP_8);
      } else if (rise < 15) {
        this.addEvent(EV.STEP_12);
      } else {
        this.addEvent(EV.STEP_16);
      }
    }
  }

  /**
   * `PM_FootstepForSurface` (`bg_pmove.c:905–913`): which footstep the ground underfoot makes, by
   * the surface flags the ground trace came back with. A metal floor clanks, and a silent one
   * makes event 0, which still takes its place in the ring of events. A splat map's floor has no
   * flags, so it is all plain footsteps.
   */
  protected footstepEvent(): number {
    const flags = this.groundTrace.surfaceFlags;
    if (flags & SURF.NOSTEPS) {
      return EV.NONE;
    }
    if (flags & SURF.METALSTEPS) {
      return EV.FOOTSTEP_METAL;
    }
    return EV.FOOTSTEP;
  }

  /** Mark the player as airborne, with no ground plane to clip against. */
  protected setAirborne() {
    this.state.groundEntityNum = ENTITYNUM_NONE;
    this.groundPlane = false;
    this.walking = false;
  }

  /** Refresh the collision box from the current stance. */
  protected setBounds() {
    const bounds = playerBounds(this.ducked, this.state.pmType === PM_DEAD);
    this.mins = bounds.mins;
    this.maxs = bounds.maxs;
  }

  protected get ducked(): boolean {
    return (this.state.pmFlags & PMF_DUCKED) !== 0;
  }

  /**
   * Trace the player's box through the world, past the player themselves, as every trace of the
   * move's goes (`pm->trace`, with `pm->ps->clientNum` and `pm->tracemask`).
   *
   * @param start - Sweep start.
   * @param end - Sweep end.
   */
  protected trace(start: Vec3, end: Vec3): TraceResult {
    return this.traceFn(start, this.mins, this.maxs, end, this.state.clientNum, this.tracemask);
  }

  /**
   * What a point is inside, past the player themselves (`pm->pointcontents`, with
   * `pm->ps->clientNum`).
   *
   * @param point - Where to look.
   */
  protected pointContents(point: Vec3): number {
    return this.pointContentsFn(point, this.state.clientNum);
  }
}

/**
 * @param value - Value to constrain.
 * @param min - Lower bound.
 * @param max - Upper bound.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
