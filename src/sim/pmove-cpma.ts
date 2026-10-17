import {
  BUTTON_ATTACK,
  BUTTON_TALK,
  EF_FIRING,
  MIN_WALK_NORMAL,
  OVERCLIP,
  PM_AIRACCELERATE,
  PM_DEAD,
  PM_DUCK_SCALE,
  PMF_CROUCH_SLIDE,
  PMF_GRAPPLE_PULL,
  PMF_RESPAWNED,
  STAT,
  STEP_EVENT_MIN_DELTA,
  STEPSIZE
} from './constants';
import { EV, addPredictableEvent } from './events';
import { PW } from './items';
import { Pmove } from './pmove';
import { accelerate, clipVelocity } from './pmove-math';
import { copy, dot, length, lengthSquared, normalize, vec3, type Vec3 } from './vec3';
import { WEAPON_DROPPING } from './weapons/constants';
import { torsoAnimation } from './weapons/weapon-state';
import { pmWeaponCpma } from './weapons/weapon-state-cpma';

/**
 * CPMA 1.48's move: id's {@link Pmove}, with each of CPMA's changes behind its own switch in the
 * rules. With every switch off it is id's move, step for step.
 */
export class CpmaPmove extends Pmove {
  /** `pmove_StepRise`: the rise of this move's step-up, for {@link run} to raise. */
  protected stepRise = 0;

  /**
   * `pmove_StepRise`: once the move is done, a step-up raises {@link EV.STEP} with its rise, so
   * the step comes after every event of the move's own.
   */
  override run() {
    super.run();
    if (this.stepRise) {
      addPredictableEvent(this.state, EV.STEP, this.stepRise);
    }
  }

  /**
   * `pmove_FiringFlag`: the firing flag is not raised while talking or lowering the weapon, and a
   * respawn ends once attack is up, whatever the use key is doing. `g_countdownHold`: nor is it
   * raised while a round counts down, since nothing fires.
   */
  protected override buttonFlags() {
    const { state, cmd } = this;
    if (!this.rules.pmove_FiringFlag) {
      super.buttonFlags();
    } else {
      const firing =
        !(cmd.buttons & BUTTON_TALK) &&
        !(state.pmFlags & PMF_RESPAWNED) &&
        (cmd.buttons & BUTTON_ATTACK) !== 0 &&
        Boolean(state.ammo[state.weapon]) &&
        state.weaponstate !== WEAPON_DROPPING;
      if (firing) {
        state.eFlags |= EF_FIRING;
      } else {
        state.eFlags &= ~EF_FIRING;
      }

      if (state.stats[STAT.HEALTH] > 0 && !(cmd.buttons & BUTTON_ATTACK)) {
        state.pmFlags &= ~PMF_RESPAWNED;
      }
    }

    if (this.rules.g_countdownHold && this.options.countdown) {
      state.eFlags &= ~EF_FIRING;
    }
  }

  /**
   * `PM_CheckDuck`, then the ends `pmove_CrouchSlide` has here: death, standing up, and CPMA's test
   * of the slide while the crouch is held.
   */
  protected override checkDuck() {
    super.checkDuck();
    if (this.state.pmType === PM_DEAD) {
      this.clearSlide();
    } else if (this.cmd.upmove < 0) {
      this.keepSlide();
    } else if (!this.ducked) {
      this.clearSlide();
    }
  }

  /**
   * `pmove_CrouchSlide`, with the crouch held: the slide ends unless it has time left, is not
   * rising, and is faster than `pmove_CrouchSlideStopSpeed` in three dimensions.
   */
  protected keepSlide() {
    const { state, rules } = this;
    const stop = rules.pmove_CrouchSlideStopSpeed;
    if (
      !rules.pmove_CrouchSlide ||
      state.stats[STAT.SLIDE_TIME] <= 0 ||
      state.velocity.z > 1 ||
      lengthSquared(state.velocity) <= stop * stop
    ) {
      this.clearSlide();
    }
  }

  /** `pmove_CrouchSlide`: the landing's slide, then id's crash land. */
  protected override crashLand() {
    this.startSlide();
    super.crashLand();
  }

  /**
   * `pmove_CrouchSlide`: a crouched landing faster than `pmove_CrouchSlideStartSpeed` in three
   * dimensions starts a slide, unless one is running. An upright landing ends one.
   */
  protected startSlide() {
    const { state, rules } = this;
    if (this.cmd.upmove >= 0 && !this.ducked) {
      this.clearSlide();
      return;
    }
    if (!rules.pmove_CrouchSlide) return;
    if (this.sliding && state.stats[STAT.SLIDE_TIME] > 0) return;

    const start = rules.pmove_CrouchSlideStartSpeed;
    if (lengthSquared(state.velocity) <= start * start) return;
    state.stats[STAT.SLIDE_TIME] = rules.pmove_CrouchSlideTime;
    state.pmFlags |= PMF_CROUCH_SLIDE;
  }

  /**
   * `pmove_CrouchSlide`: a corpse does not slide. One killed crouching stays ducked, so its landing
   * can start a slide, which this ends.
   */
  protected override deadMove() {
    this.state.pmFlags &= ~PMF_CROUCH_SLIDE;
    super.deadMove();
  }

  /**
   * The crouch slide's time runs down, and a slide whose time ran out on the last move ends, as
   * does any slide once `pmove_CrouchSlide` is off. Then the chain jump's window runs down. The
   * mark goes on the first move to find the window closed, one move after it closes, so a jump on
   * the move that closes it keeps the mark.
   */
  protected override moveTimers() {
    const { stats } = this.state;
    if (this.rules.pmove_CrouchSlide && this.sliding && stats[STAT.SLIDE_TIME] > 0) {
      stats[STAT.SLIDE_TIME] -= this.msec;
    } else {
      this.clearSlide();
    }
    if (stats[STAT.JUMP_TIME] > 0) {
      stats[STAT.JUMP_TIME] -= this.msec;
    } else if (stats[STAT.CHAIN_JUMPED]) {
      stats[STAT.CHAIN_JUMPED] = 0;
    }
  }

  /** `pmove_SnapVelocity` 0: the velocity keeps its fractions from move to move. */
  protected override snap() {
    if (this.rules.pmove_SnapVelocity) super.snap();
  }

  /**
   * `pmove_RampJump`: a jump while rising adds to the rise. `pmove_ChainJump`: a jump inside the
   * window adds to the jump, and marks it. Either `pmove_ChainJump` or `pmove_StepJump` opens the
   * window on every jump.
   */
  protected override jumpVelocity(): number {
    const { state, rules } = this;
    const { stats } = state;

    let velocity = super.jumpVelocity();
    if (rules.pmove_RampJump && state.velocity.z > 0) {
      velocity += state.velocity.z;
    }
    if (rules.pmove_ChainJump && stats[STAT.JUMP_TIME] > 0) {
      velocity +=
        stats[STAT.JUMP_TIME] > rules.pmove_ChainJumpLateTime
          ? rules.pmove_ChainJumpVelocity
          : rules.pmove_ChainJumpLateVelocity;
      stats[STAT.CHAIN_JUMPED] = 1;
    }
    if (rules.pmove_ChainJump || rules.pmove_StepJump) {
      stats[STAT.JUMP_TIME] = rules.pmove_ChainJumpTime;
    }
    return velocity;
  }

  /**
   * `pmove_CrouchSlide`: while sliding, a crouched wish over a quarter of the speed becomes
   * `pmove_CrouchSlideDuckScale` × the speed, where id's holds it to the quarter.
   */
  protected override duckWishSpeed(wishspeed: number): number {
    const { speed } = this.state;
    if (!this.sliding || !this.ducked || wishspeed <= speed * PM_DUCK_SCALE) {
      return super.duckWishSpeed(wishspeed);
    }
    return speed * this.rules.pmove_CrouchSlideDuckScale;
  }

  /**
   * `pmove_CrouchSlide`: a slide accelerates at `pmove_CrouchSlideAccel`, knocked back or not, and
   * on a slick floor too.
   */
  protected override walkAccelerate(slipping: boolean): number {
    return this.sliding ? this.rules.pmove_CrouchSlideAccel : super.walkAccelerate(slipping);
  }

  /** `pmove_WaterWaistAtOrigin`: the waist's sample is at the origin, crouched or standing. */
  protected override waistHeight(): number {
    return this.rules.pmove_WaterWaistAtOrigin ? 0 : super.waistHeight();
  }

  /**
   * `pmove_WaterHeadEventsAlive`: the dead make no sound as the head goes under or comes up, and
   * nobody in the battle suit gasps coming up.
   */
  protected override headWaterEvents() {
    const { state } = this;
    if (!this.rules.pmove_WaterHeadEventsAlive) {
      super.headWaterEvents();
      return;
    }
    if (state.pmType === PM_DEAD) return;
    if (!state.powerups[PW.BATTLESUIT]) {
      super.headWaterEvents();
    } else if (this.previousWaterlevel !== 3 && this.waterlevel === 3) {
      this.addEvent(EV.WATER_UNDER);
    }
  }

  /** `pmove_CrouchSlide`: the ground takes a constant `pmove_CrouchSlideDecel` a second. */
  protected override groundFriction(speed: number): number {
    return this.sliding ? this.rules.pmove_CrouchSlideDecel : super.groundFriction(speed);
  }

  /** CPMA's `PM_Weapon`, then id's `PM_TorsoAnimation`. */
  protected override weapon() {
    pmWeaponCpma(this.state, this.cmd, this.msec, this.weaponInput(), this.rules);
    torsoAnimation(this.state);
  }

  /** `pmove_KeepSlopeSpeed` 0: the clip is all, so a slope takes its share of the speed. */
  protected override clipToGround(normal: Vec3) {
    if (this.rules.pmove_KeepSlopeSpeed) {
      super.clipToGround(normal);
      return;
    }
    this.state.velocity = clipVelocity(this.state.velocity, normal, OVERCLIP);
  }

  /** `pmove_CrouchSlide`: leaving the ground ends the slide, before the air move's friction. */
  protected override airMove() {
    this.state.pmFlags &= ~PMF_CROUCH_SLIDE;
    super.airMove();
  }

  /**
   * `pmove_AirControl`: forward or back alone turns the velocity toward the wish; against the
   * velocity the accelerate is the air stop's; and a pure strafe accelerates at the strafe's, up to
   * the wish speed. Then a flag carrier is held to `pmove_FlagCarrierSpeedMax`.
   */
  protected override airAccelerate(wishdir: Vec3, wishspeed: number) {
    const { state, rules } = this;

    if (!rules.pmove_AirControl) {
      super.airAccelerate(wishdir, wishspeed);
    } else {
      this.airControl(wishdir, wishspeed);
      let accel = dot(state.velocity, wishdir) < 0 ? rules.pmove_AirStopAccel : PM_AIRACCELERATE;
      let speed = wishspeed;
      if (state.movementDir === 2 || state.movementDir === 6) {
        speed = Math.min(speed, rules.pmove_WishSpeed);
        accel = rules.pmove_StrafeAccel;
      }
      state.velocity = accelerate(state.velocity, wishdir, speed, accel, this.frametime);
    }

    this.flagCarrierLimit();
  }

  /**
   * CPMA's `PM_AirControl`: turn the horizontal velocity toward the wish by as much as they agree,
   * squared, and keep its speed.
   */
  protected airControl(wishdir: Vec3, wishspeed: number) {
    const { state } = this;
    if ((state.movementDir !== 0 && state.movementDir !== 4) || wishspeed === 0) return;

    const flat = vec3(state.velocity.x, state.velocity.y, 0);
    const speed = length(flat);
    let dir = normalize(flat);
    const agree = dot(dir, wishdir);
    if (agree > 0) {
      const k = 32 * this.rules.pmove_AirControlStrength * agree * agree * this.frametime;
      dir = normalize(vec3(dir.x * speed + wishdir.x * k, dir.y * speed + wishdir.y * k, 0));
    }
    state.velocity = vec3(dir.x * speed, dir.y * speed, state.velocity.z);
  }

  /**
   * `pmove_FlagCarrierSpeedMax`: a flag carrier's horizontal speed over the limit, as a multiple of
   * their speed, is dragged back by the square of the excess.
   */
  protected flagCarrierLimit() {
    const { state, rules } = this;
    if (!rules.pmove_FlagCarrierSpeedMax) return;
    if (!state.powerups[PW.REDFLAG] && !state.powerups[PW.BLUEFLAG]) return;

    const limit = state.speed * rules.pmove_FlagCarrierSpeedMax;
    const speed = Math.hypot(state.velocity.x, state.velocity.y);
    if (speed <= limit) return;
    const excess = (speed - limit) / limit;
    const keep = 1 - excess * excess * this.frametime;
    state.velocity = vec3(state.velocity.x * keep, state.velocity.y * keep, state.velocity.z);
  }

  /**
   * `PM_StepSlideMove`, with CPMA's changes.
   *
   * - `pmove_WholeSteps`: the step-up tests the space a whole step above instead of sweeping up
   *   to it, so it rises a whole step or not at all, and settles by a whole step. None is taken
   *   while the grapple pulls.
   * - `pmove_StepJump`: a player still rising may step up, inside the jump's window and under a
   *   speed.
   * - After a chained jump, the settle's clip leaves the fall alone.
   * - `pmove_StepRise`: a step-up that settles onto something keeps its rise in whole units, over
   *   2, where id's raises one of four heights whether it settled or not.
   */
  protected override stepSlideMove(gravity: boolean) {
    const { state, rules } = this;
    if (
      !rules.pmove_WholeSteps &&
      !rules.pmove_StepJump &&
      !rules.pmove_StepRise &&
      !state.stats[STAT.CHAIN_JUMPED]
    ) {
      super.stepSlideMove(gravity);
      return;
    }

    const startOrigin = copy(state.origin);
    const startVelocity = copy(state.velocity);

    if (!this.slideMove(gravity)) {
      return;
    }
    if (rules.pmove_WholeSteps && state.pmFlags & PMF_GRAPPLE_PULL) {
      return;
    }

    const down = vec3(startOrigin.x, startOrigin.y, startOrigin.z - STEPSIZE);
    let trace = this.trace(startOrigin, down);
    if (
      state.velocity.z > 0 &&
      (trace.fraction === 1 || trace.normal.z < MIN_WALK_NORMAL) &&
      !this.stepJumps()
    ) {
      return;
    }

    // A trace of no length is a test of the box where it stands: all solid, or clear to `up`.
    const up = vec3(startOrigin.x, startOrigin.y, startOrigin.z + STEPSIZE);
    trace = rules.pmove_WholeSteps ? this.trace(up, up) : this.trace(startOrigin, up);
    if (trace.allsolid) {
      return;
    }

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
      const clipped = clipVelocity(state.velocity, trace.normal, OVERCLIP);
      state.velocity = state.stats[STAT.CHAIN_JUMPED]
        ? vec3(clipped.x, clipped.y, state.velocity.z)
        : clipped;
    }

    const rise = state.origin.z - startOrigin.z;
    if (!rules.pmove_StepRise) {
      this.stepEvent(rise);
    } else if (trace.fraction < 1 && rise > STEP_EVENT_MIN_DELTA) {
      this.stepRise = Math.trunc(rise);
    }
  }

  /** `pmove_StepJump`: whether a player still rising may step up. */
  protected stepJumps(): boolean {
    const { state, rules } = this;
    return (
      Boolean(rules.pmove_StepJump) &&
      state.velocity.z <= rules.pmove_StepJumpVelocityMax &&
      state.stats[STAT.JUMP_TIME] > 0
    );
  }

  /** `pmove_CrouchSlide`: whether a crouch slide is running. */
  protected get sliding(): boolean {
    return (this.state.pmFlags & PMF_CROUCH_SLIDE) !== 0;
  }

  /** `pmove_CrouchSlide`: the slide ends, and its time with it. */
  protected clearSlide() {
    this.state.pmFlags &= ~PMF_CROUCH_SLIDE;
    this.state.stats[STAT.SLIDE_TIME] = 0;
  }
}
