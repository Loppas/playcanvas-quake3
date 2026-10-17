import { CMD_BACKUP } from '../net/client-clock';
import { copyPlayerState } from '../net/delta';
import {
  MAX_GENTITIES,
  createPlayerState,
  type EntityState,
  type NetUserCmd,
  type PlayerState
} from '../net/protocol';
import { shortAngle } from '../sim/client';
import { f } from '../sim/cm/q-math';
import {
  DF_NO_FOOTSTEPS,
  EF_NODRAW,
  GT,
  PERS,
  PM_INTERMISSION,
  PM_NORMAL,
  PM_SPECTATOR,
  PMF_DUCKED,
  STAT,
  TEAM
} from '../sim/constants';
import { SOLID_BMODEL } from '../sim/entity-solid';
import { EV, addPredictableEvent } from '../sim/events';
import { ET } from '../sim/game-entity';
import { IT, ITEMS, PW, canItemBeGrabbed, playerTouchesItem } from '../sim/items';
import { JUMP_PAD_MAXS, JUMP_PAD_MINS, touchJumpPad } from '../sim/jump-pad';
import { clampViewPitchDelta, pmove } from '../sim/pmove';
import { CpmaPmove } from '../sim/pmove-cpma';
import type { SysteminfoRules } from '../sim/rules';
import { evaluateTrajectory } from '../sim/trajectory';
import {
  playerBounds,
  type InlineModels,
  type PointContentsFn,
  type TraceFn
} from '../sim/types';
import { length, scale, sub, vec3, type Vec3 } from '../sim/vec3';
import { Q2_GRAPPLE_SPEED, grapplePostMove, type GrappleMode } from '../sim/weapons/grapple';
import { adjustPositionForMover } from './mover-adjust';

/**
 * The client's own movement — Quake 3's `CG_PredictPlayerState` (`cg_predict.c:412–626`), the
 * trigger and item touches it predicts as it walks, and the error the camera is corrected by.
 *
 * Every drawn frame replays every command the server has not acknowledged, oldest first, from the
 * newest player state a snapshot carried. What comes out is where the player is *now* rather than
 * where they were when the snapshot was made — which is what keeps the camera on the mouse and
 * the movement under the keys while a round trip goes by.
 *
 * Prediction is drawn in whole steps: {@link state} is the newest 8 ms step's state and
 * {@link previousStep} the one before it, and the view blends between the two, so the drawn
 * position is the one the physics has for the instant drawn. A correction from the server is not
 * applied to the state either: it decays into the camera's origin only, over `cg_errorDecay`
 * (`cg_view.c:663–675`), so the body never jumps and the eye never lags a ping behind.
 *
 * Quake 3's `CG_CheckChangedPredictableEvents` is commented out at the revision this follows
 * (`cg_predict.c:592`) and is not ported: the sequence comparison in the view's own
 * `checkPlayerstateEvents` is what stops a predicted event from being played twice.
 */

/** A snapshot as prediction is handed one: `cg.snap` or `cg.nextSnap`. */
export interface PredictionSnapshot {
  serverTime: number;
  ps: PlayerState;
  entities: readonly EntityState[];
}

/** `cl.cmds` and `cl.cmdNumber`, which is the whole of what a replay reads. */
export interface CommandRing {
  readonly cmdNumber: number;
  at(number: number): NetUserCmd;
}

/** One frame's inputs to {@link Prediction.predict}. */
export interface PredictionFrame {
  /** `cg.snap`: the snapshot the clock has reached, and the fallback base. */
  snap: PredictionSnapshot;
  /** `cg.nextSnap`, or null while there is none. */
  nextSnap: PredictionSnapshot | null;
  /** `cg.nextFrameTeleport`: the player teleported between the two. */
  nextFrameTeleport: boolean;
  /** `cg.time`: this frame's clock. */
  cgTime: number;
  /** `cg.oldTime`: the last frame's, which a fresh error is dated by. */
  oldTime: number;
  /** `cl.cmdNumber` and `cl.cmds`, which is the whole of what is replayed. */
  commands: CommandRing;
  /** `CG_Trace`: the map, then the entities where they are drawn. */
  trace: TraceFn;
  /** `CG_PointContents`: the map's, and its brush models' where they are drawn. */
  pointContents: PointContentsFn;
  /** The rules `CS_SYSTEMINFO` carried. */
  rules: Readonly<SysteminfoRules>;
  /** `pmove_msec`, as the server clamps it. */
  pmoveMsec: number;
  /** `g_allowGrapple`'s style, or null for a client whose match has no hook. */
  grappleMode: GrappleMode | null;
  /** The match's gametype, which an item's grab rules read. */
  gametype: number;
  /** `cg_predictItems`: predict an item's own pickup rather than wait for the snapshot. */
  predictItems: boolean;
  /** `cg_showmiss`: how much of the replay's diagnostics to print. */
  showMiss: number;
  /** `cg_errordecay`: how long a correction takes to fade, in ms; 0 clears it at once. */
  errorDecay: number;
  /**
   * `cg_triggerEntities`: the items, jump pads and teleporters a touch is tested against, in the
   * snapshot's order.
   */
  triggers: readonly EntityState[];
  /** The map's inline models, which a brush trigger's touch is tested on. */
  inlineModels: InlineModels;
  /**
   * `cg_entities[ n ].currentState`: the current snapshot's entity of a number, which a mover the
   * player stands on is read from; undefined for one it has not got.
   */
  currentState(number: number): EntityState | undefined;
  /** `CG_Printf`, for `cg_showmiss`. */
  print(text: string): void;
}

/**
 * `cg.predictedPlayerState` and the state behind it, kept across frames: the error that has not
 * decayed, the item a prediction has already taken, and the last frame's prediction.
 */
export class Prediction {
  /** `cg.predictedPlayerState`: the state the newest replayed step left. */
  readonly state = createPlayerState();
  /** The step before it, which the drawn position blends from toward the newest. */
  readonly previousStep = createPlayerState();
  /**
   * `oldPlayerState`: the last frame's final prediction, which the frame's transitions compare
   * this frame's against — the respawn, the hurt and the jump pad all read the difference.
   */
  readonly oldState = createPlayerState();

  /**
   * When {@link state} stands, on the server's clock: the frame's time once a replay has carried
   * it along its mover, or the snapshot's own time for a snapshot's state taken whole. A miss is
   * measured with the base carried to it.
   */
  stateTime = 0;
  /**
   * The turn the last replay's mover gave the view, from {@link physicsTime} to the frame's time,
   * in degrees: what the drawn view turns by beside the mouse.
   */
  readonly moverTurn = vec3();
  /**
   * `cg.physicsTime`: the time of the snapshot the replay took its base from, which is where a
   * mover stands in every trace. Set as a replay is tried, so a frame that predicts nothing keeps
   * the last.
   */
  physicsTime = 0;

  /** `cg.validPPS`: false until the first frame, which copies the snapshot's state whole. */
  private valid = false;
  /** `cg.thisFrameTeleport`: set by a transition, respawn or follow change, cleared by the loop. */
  thisFrameTeleport = false;
  /**
   * `cg.hyperspace`: a replayed step touched a teleporter, so the frame draws no world until the
   * snapshot with the teleport arrives. The view clears it at every frame's start.
   */
  hyperspace = false;
  /** `cg.predictedError`: what the last correction still owes the camera. */
  private error = vec3();
  /** `cg.predictedErrorTime`: the clock time the error's reference frame belonged to. */
  private errorTime = 0;
  /** `cent->miscTime` per slot: an item a prediction has already taken on this clock. */
  private readonly itemTouchedAt = new Float64Array(MAX_GENTITIES);

  /** Whether any command ran, which is whether the frame's transitions happen at all. */
  moved = false;

  /**
   * `CG_ClearState`'s share, as a new gamestate makes the view start over: nothing the last world
   * predicted is carried into this one.
   */
  reset(): void {
    this.valid = false;
    this.thisFrameTeleport = false;
    this.hyperspace = false;
    this.error = vec3();
    this.errorTime = 0;
    this.moved = false;
    this.stateTime = 0;
    this.physicsTime = 0;
    this.moverTurn.x = this.moverTurn.y = this.moverTurn.z = 0;
    // `cg_entities`' `miscTime`, which `CG_Init`'s memset zeroes (`cg_main.c:1852`).
    this.itemTouchedAt.fill(0);
  }

  /**
   * `CG_PredictPlayerState` (`cg_predict.c:412–626`): replay what the server has not answered.
   *
   * @returns whether a command ran, which is what the caller's transitions are waiting on.
   */
  predict(frame: PredictionFrame): boolean {
    const { snap, commands } = frame;
    const state = this.state;

    // `cg.validPPS`: the first frame has no prediction behind it, so the snapshot's state is it.
    if (!this.valid) {
      this.valid = true;
      copyPlayerState(snap.ps, state);
      this.stateTime = snap.serverTime;
    }

    // `CMD_BACKUP`'s worth of commands is all the ring keeps. When even the oldest is newer than
    // the state's clock, the commands that connect the two are gone: the player holds their last
    // good position until the server answers again.
    const current = commands.cmdNumber;
    const oldest = current - CMD_BACKUP + 1;
    const oldestCmd = commands.at(oldest);
    if (oldestCmd.serverTime > snap.ps.commandTime && oldestCmd.serverTime < frame.cgTime) {
      if (frame.showMiss) frame.print('exceeded PACKET_BACKUP on commands\n');
      this.moved = false;
      return false;
    }
    const latestCmd = commands.at(current);

    // The base is the newest state the client has, which is ahead of the world everyone else is
    // drawn in; a teleport either way takes the older one, so nothing crosses the discontinuity.
    const baseSnap =
      frame.nextSnap !== null && !frame.nextFrameTeleport && !this.thisFrameTeleport
        ? frame.nextSnap
        : snap;
    const base = baseSnap.ps;
    this.physicsTime = baseSnap.serverTime;

    // Nothing newer than the base to replay — a local game's loopback answers in the same frame,
    // so most frames are this one. The prediction is left where it stands, and the view falls
    // back to the snapshots' own transitions and interpolation.
    if (latestCmd.serverTime <= base.commandTime) {
      this.moved = false;
      return false;
    }

    copyPlayerState(state, this.oldState);
    copyPlayerState(base, state);

    this.moved = false;
    for (let cmdNum = oldest; cmdNum <= current; cmdNum++) {
      const cmd = commands.at(cmdNum);

      // Under `pmove_fixed`, every command turns the view, skipped ones included, so the view
      // does not lag behind the quantised steps (`cg_predict.c:508–510`).
      this.updateViewAngles(cmd);

      // Already included in the base state, or from before a `map_restart`.
      if (cmd.serverTime <= state.commandTime) continue;
      if (cmd.serverTime > latestCmd.serverTime) continue;

      // The error is measured while the base is still where last frame's prediction left it.
      if (state.commandTime === this.oldState.commandTime) this.measureError(frame);

      // The round-up happens after the skip tests, as the server's does (`g_active.c:799–803`).
      const msec = frame.pmoveMsec;
      const serverTime = Math.trunc((cmd.serverTime + msec - 1) / msec) * msec;
      copyPlayerState(state, this.previousStep);
      pmove(
        state,
        {
          serverTime,
          forwardmove: cmd.forwardmove,
          rightmove: cmd.rightmove,
          upmove: cmd.upmove,
          buttons: cmd.buttons,
          weapon: cmd.weapon,
          angles: vec3(
            shortAngle(cmd.angles[0] + state.deltaAngles.x),
            shortAngle(cmd.angles[1] + state.deltaAngles.y),
            shortAngle(cmd.angles[2] + state.deltaAngles.z)
          )
        },
        frame.trace,
        {
          ...(frame.grappleMode !== null ? { grappleMode: frame.grappleMode } : {}),
          // "always be free from prediction errors with the gauntlet" (`cg_predict.c:578`).
          gauntletHit: false,
          pmoveMsec: msec,
          core: CpmaPmove,
          pointContents: frame.pointContents,
          rules: frame.rules,
          noFootsteps: (frame.rules.dmflags & DF_NO_FOOTSTEPS) !== 0
        }
      );
      // The Q2 winch is a hard set after the move, as it is on the server.
      grapplePostMove(state, frame.grappleMode, Q2_GRAPPLE_SPEED, msec / 1000);
      this.moved = true;

      this.touchTriggers(frame);
    }

    if (frame.showMiss > 1) frame.print(`[${latestCmd.serverTime} : ${frame.cgTime}] `);
    if (!this.moved) {
      if (frame.showMiss) frame.print('not moved\n');
      return false;
    }

    // "adjust for the movement of the groundentity": the replay met the mover where the base's
    // snapshot had it, and the frame is drawn later. Both steps the view blends go with it, on the
    // ground the newest stands on, and the view turns with it.
    const ground = state.groundEntityNum;
    const turn = this.moverTurn;
    this.carry(state.origin, ground, frame, turn);
    this.carry(this.previousStep.origin, ground, frame, vec3());
    state.viewangles.x = f(state.viewangles.x + turn.x);
    state.viewangles.y = f(state.viewangles.y + turn.y);
    state.viewangles.z = f(state.viewangles.z + turn.z);
    this.stateTime = frame.cgTime;
    return true;
  }

  /**
   * `CG_AdjustPositionForMover` from {@link physicsTime} to the frame's time, on a replayed
   * step's origin.
   *
   * @param origin - The step's origin, carried in place.
   * @param turn - What the mover turned by, written in place.
   */
  private carry(origin: Vec3, ground: number, frame: PredictionFrame, turn: Vec3): void {
    turn.x = turn.y = turn.z = 0;
    const { cgTime, currentState } = frame;
    const from = this.physicsTime;
    adjustPositionForMover(origin, ground, from, cgTime, currentState, origin, turn, turn);
  }

  /**
   * `CG_CalcViewValues`' error decay (`cg_view.c:663–675`): the share of the last correction that
   * is still owed to the camera's origin, or zero once its time is up. The state and the drawn
   * body are never corrected — only the eye slides.
   */
  cameraOffset(cgTime: number, decay: number): Vec3 {
    if (decay > 0) {
      const t = cgTime - this.errorTime;
      const f = (decay - t) / decay;
      if (f > 0 && f < 1) return scale(this.error, f);
      this.errorTime = 0;
    }
    return vec3();
  }

  /**
   * `cg_predict.c:522–574`: the difference between last frame's prediction and the snapshot's
   * answer, past a tenth of a unit, decayed into what the camera still owes. A teleport clears it
   * outright; `cg_errorDecay` 0 clears rather than decays.
   */
  private measureError(frame: PredictionFrame): void {
    if (this.thisFrameTeleport) {
      this.error = vec3();
      if (frame.showMiss) frame.print('PredictionTeleport\n');
      this.thisFrameTeleport = false;
      return;
    }

    // The base carried along its mover to when the last prediction stands: `cg.oldTime` after a
    // replay, as Quake 3 carries it. After a frame that drew the snapshot's own state it is that
    // snapshot's time, so a mover's own motion is never taken for a miss.
    const adjusted = vec3();
    const angles = vec3();
    const { origin, groundEntityNum: ground } = this.state;
    const { currentState } = frame;
    const from = this.physicsTime;
    const to = this.stateTime;
    adjustPositionForMover(origin, ground, from, to, currentState, adjusted, angles, angles);
    const delta = sub(this.oldState.origin, adjusted);
    const miss = length(delta);
    if (miss <= 0.1) return;

    if (frame.showMiss) frame.print(`Prediction miss: ${miss}\n`);
    if (frame.errorDecay) {
      const t = frame.cgTime - this.errorTime;
      let f = (frame.errorDecay - t) / frame.errorDecay;
      if (f < 0) f = 0;
      this.error = scale(this.error, f);
    } else {
      this.error = vec3();
    }
    this.error = vec3(this.error.x + delta.x, this.error.y + delta.y, this.error.z + delta.z);
    this.errorTime = frame.oldTime;
  }

  /**
   * `PM_UpdateViewAngles` (`bg_pmove.c:1796–1824`), the cgame replay's way: the command's angles
   * are shorts with the delta added, the pitch is fixed up and held, and the view turns — before
   * the skip tests, so even a command that is not simulated turns it.
   */
  private updateViewAngles(cmd: NetUserCmd): void {
    const { state } = this;
    clampViewPitchDelta(state, cmd.angles);
    if (state.pmType === PM_INTERMISSION) return;
    if (state.pmType !== PM_SPECTATOR && state.stats[STAT.HEALTH] <= 0) return;

    state.viewangles = vec3(
      shortAngle(cmd.angles[0] + state.deltaAngles.x),
      shortAngle(cmd.angles[1] + state.deltaAngles.y),
      shortAngle(cmd.angles[2] + state.deltaAngles.z)
    );
  }

  /**
   * `CG_TouchTriggerPrediction` (`cg_predict.c:326–382`): what the step that just ran walked
   * into. The jump pad is the same function the server runs, on the predicted state; the item is
   * a local illusion — an event, a hidden copy and a token round of ammo — because the inventory
   * is the server's alone; a teleporter sets {@link hyperspace}.
   *
   * A trigger is touched by its brush: the move's box at the predicted origin tested on the inline
   * model, where it stands in the world, as the server's contact tests it. A jump pad with no brush
   * model, a splat map's, is touched by the box the server gives it, where Quake 3 would pass it
   * over.
   */
  private touchTriggers(frame: PredictionFrame): void {
    const { state } = this;
    if (state.stats[STAT.HEALTH] <= 0) return;
    const spectator = state.pmType === PM_SPECTATOR;
    if (state.pmType !== PM_NORMAL && !spectator) return;

    const box = playerBounds((state.pmFlags & PMF_DUCKED) !== 0, false);
    for (const trigger of frame.triggers) {
      if (trigger.eType === ET.ITEM && !spectator) {
        this.touchItem(trigger, frame);
        continue;
      }

      if (trigger.solid !== SOLID_BMODEL) {
        if (trigger.eType !== ET.PUSH_TRIGGER) continue;
        const origin = evaluateTrajectory(trigger.pos, frame.cgTime);
        if (!this.padOverlaps(origin, box)) continue;
      } else {
        const cmodel = frame.inlineModels.inlineModel(trigger.modelindex);
        if (!cmodel) continue;
        if (!frame.inlineModels.contact(cmodel, state.origin, box.mins, box.maxs)) continue;
      }

      // A teleporter is the server's to work: the client only hides the world until it has.
      if (trigger.eType === ET.TELEPORT_TRIGGER) {
        this.hyperspace = true;
      } else if (trigger.eType === ET.PUSH_TRIGGER) {
        touchJumpPad(state, trigger);
      }
    }

    // "if we didn't touch a jump pad this pmove frame" (`cg_predict.c:377–381`).
    if (state.jumppadFrame !== state.pmoveFramecount) {
      state.jumppadFrame = 0;
      state.jumppadEnt = 0;
    }
  }

  /**
   * Whether the predicted player's box overlaps a pad's stand-in box, which is the contact the
   * server tests a pad without a brush model by.
   */
  private padOverlaps(padOrigin: Vec3, box: { mins: Vec3; maxs: Vec3 }): boolean {
    const { state } = this;
    const mins = vec3(
      state.origin.x + box.mins.x,
      state.origin.y + box.mins.y,
      state.origin.z + box.mins.z
    );
    const maxs = vec3(
      state.origin.x + box.maxs.x,
      state.origin.y + box.maxs.y,
      state.origin.z + box.maxs.z
    );
    const padMins = vec3(
      padOrigin.x + JUMP_PAD_MINS.x,
      padOrigin.y + JUMP_PAD_MINS.y,
      padOrigin.z + JUMP_PAD_MINS.z
    );
    const padMaxs = vec3(
      padOrigin.x + JUMP_PAD_MAXS.x,
      padOrigin.y + JUMP_PAD_MAXS.y,
      padOrigin.z + JUMP_PAD_MAXS.z
    );
    if (padMins.x > maxs.x || padMins.y > maxs.y || padMins.z > maxs.z) return false;
    if (padMaxs.x < mins.x || padMaxs.y < mins.y || padMaxs.z < mins.z) return false;
    return true;
  }

  /**
   * `CG_TouchItem` (`cg_predict.c:261–316`): the item that just came within reach. Nothing is
   * consumed here — the server does that on its own command — so what is drawn is what the
   * server still has, and none of the inventory moves beyond the token round that lets the
   * autoswitch happen a snapshot early.
   */
  private touchItem(item: EntityState, frame: PredictionFrame): void {
    if (!frame.predictItems) return;
    if (!playerTouchesItem(this.state, item, frame.cgTime, frame.rules)) return;
    // "never pick an item up twice in a prediction".
    if (this.itemTouchedAt[item.number] === frame.cgTime) return;
    if (!canItemBeGrabbed(frame.gametype, item, this.state, frame.rules)) return;

    const info = ITEMS[item.modelindex];
    // "Special case for flags: we don't predict touching our own flag" (`cg_predict.c:291–298`).
    // The `giType` test is ioquake3's: id's tested the tag alone, which a red player's railgun
    // and slugs and a blue player's plasma gun and cells share with the flags.
    if (frame.gametype === GT.CTF && info.giType === IT.TEAM) {
      const team = this.state.persistant[PERS.TEAM];
      if (
        (team === TEAM.RED && info.giTag === PW.REDFLAG) ||
        (team === TEAM.BLUE && info.giTag === PW.BLUEFLAG)
      ) {
        return;
      }
    }

    addPredictableEvent(this.state, EV.ITEM_PICKUP, item.modelindex);
    // "remove it from the frame so it won't be drawn", and remember it for this clock.
    item.eFlags |= EF_NODRAW;
    this.itemTouchedAt[item.number] = frame.cgTime;

    // A weapon gives a token round so the autoswitch works on the frame it is taken.
    if (info.giType === IT.WEAPON) {
      this.state.stats[STAT.WEAPONS] |= 1 << info.giTag;
      if (!this.state.ammo[info.giTag]) this.state.ammo[info.giTag] = 1;
    }
  }
}
