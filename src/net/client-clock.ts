import { PACKET_BACKUP } from './commands';
import { createNetUserCmd, type NetUserCmd } from './protocol';

/**
 * The client's clock and its own commands — the half of Quake 3's `clientActive_t` that keeps time
 * (`cl_cgame.c:801–1022`) and the command ring it stamps (`cl_input.c:624–659`).
 *
 * The client never knows the server's time, only what the snapshots said it was when they left.
 * So it keeps an offset from its own clock to the server's and nudges it as snapshots arrive,
 * aiming to run just behind the newest one it has: close enough to be current, and behind enough
 * that there is always a snapshot ahead of it to draw towards.
 *
 * The commands are stamped on that clock. Quake 3 makes one a drawn frame; this makes one for each
 * `pmove_msec` step of the clock, on the server's grid, which is the move `pmove_fixed` gives
 * Quake 3 without the commands it throws away.
 */

/** `RESET_TIME` (`cl_cgame.c:821`): how far the offset may be out before it is set, not nudged. */
const RESET_TIME = 500;

/**
 * The snapshot interval `CL_AdjustTimeDelta`'s creep is sized for: Quake 3's 20 a second, which
 * moves the clock a millisecond forward, or two back, every 50 ms.
 */
const DRIFT_INTERVAL = 50;

/** How far `cl_timeNudge` can move the clock either way (`cl_cgame.c:995–999`). */
const MAX_TIME_NUDGE = 30;

/** `CMD_BACKUP` (`cg_public.h:25`): how many of its own commands the client keeps. */
export const CMD_BACKUP = 64;

/** `CMD_MASK` (`cg_public.h:26`). */
export const CMD_MASK = CMD_BACKUP - 1;

/**
 * The most time one frame makes commands for. Quake 3 counts a frame as 200 ms at most, so a
 * hitch does not move the player through everything that was held during it (`cl_input.c:647–651`).
 */
const MAX_FRAME_COMMAND_MSEC = 200;

/**
 * `outPacket_t` (`client.h:79–84`): a packet the client sent, which the next is measured from, and
 * a snapshot's ping.
 */
export interface OutPacket {
  /** `p_realtime`: the client's time it went. */
  realtime: number;
  /** `p_serverTime`: the newest command's time, or 0 for a packet with none. */
  serverTime: number;
  /** `p_cmdNumber`: the newest command it carried. */
  cmdNumber: number;
}

export class ClientClock {
  /** `cls.realtime`: the client's own time, the length of every frame added up. */
  realtime = 0;
  /** `cl.serverTime`: the server's time as the client has it this frame. */
  serverTime = 0;
  /** `cl.oldServerTime`: the last frame's, which the clock never runs back past. */
  oldServerTime = 0;
  /** `cl.oldFrameServerTime`: the newest snapshot's time as of the last frame. */
  oldFrameServerTime = 0;
  /** `cl.serverTimeDelta`: the server's time less the client's. */
  serverTimeDelta = 0;
  /** `cl.extrapolatedSnapshot`: the clock came within 5 ms of the newest snapshot. */
  private extrapolatedSnapshot = false;
  /** The newest snapshot's time when the offset was last moved, or null before it has been. */
  private adjustedAt: number | null = null;

  /**
   * The clock was put on a snapshot's time rather than run to it, so the commands start again
   * from the step it is in. Whoever makes the commands clears it.
   */
  jumped = false;

  /** `CL_ClearState`'s share, as a new gamestate makes it: all but the client's own time. */
  clear(): void {
    this.serverTime = 0;
    this.oldServerTime = 0;
    this.oldFrameServerTime = 0;
    this.serverTimeDelta = 0;
    this.extrapolatedSnapshot = false;
    this.adjustedAt = null;
    this.jumped = false;
  }

  /** `CL_FirstSnapshot` (`cl_cgame.c:885–887`): exactly on the first snapshot's time. */
  firstSnapshot(snapTime: number): void {
    this.serverTimeDelta = snapTime - this.realtime;
    this.oldServerTime = snapTime;
    this.jumped = true;
  }

  /**
   * `CL_SetCGameTime`'s clock (`cl_cgame.c:983–1015`): this frame's time, never behind the last
   * frame's however the offset or the nudge has moved.
   *
   * @param snapTime - The newest snapshot's time.
   * @param timeNudge - `cl_timeNudge`: milliseconds to run behind, or ahead if negative.
   */
  run(snapTime: number, timeNudge: number): void {
    const tn = Math.max(-MAX_TIME_NUDGE, Math.min(MAX_TIME_NUDGE, timeNudge));
    this.serverTime = Math.max(this.realtime + this.serverTimeDelta - tn, this.oldServerTime);
    this.oldServerTime = this.serverTime;

    // Nearly past the newest snapshot, the nudge aside: pull back a little when the next comes.
    if (this.realtime + this.serverTimeDelta >= snapTime - 5) this.extrapolatedSnapshot = true;
  }

  /**
   * `CL_AdjustTimeDelta` (`cl_cgame.c:823–870`): move the offset towards what a new snapshot says.
   *
   * It is only moved when a snapshot arrives, so a run of lost packets cannot drag it about. A
   * large difference is taken at once, a middling one halved, and otherwise the clock creeps
   * forward a millisecond a snapshot and backs off two whenever it came near running out.
   *
   * The creep is Quake 3's at its 20 snapshots a second. A faster server's snapshots each take
   * their share of it, never more than Quake 3's whole step, so the clock drifts at the same rate
   * however often they come, and what is drawn on it moves as evenly as real time does.
   *
   * @param snapTime - The new snapshot's time.
   * @returns what `cl_showTimeDelta` prints
   */
  adjustTimeDelta(snapTime: number): string {
    const newDelta = snapTime - this.realtime;
    const deltaDelta = Math.abs(newDelta - this.serverTimeDelta);
    const since = this.adjustedAt === null ? DRIFT_INTERVAL : snapTime - this.adjustedAt;
    const share = Math.min(Math.max(since / DRIFT_INTERVAL, 0), 1);
    this.adjustedAt = snapTime;

    let shown = '';
    if (deltaDelta > RESET_TIME) {
      this.serverTimeDelta = newDelta;
      this.oldServerTime = snapTime;
      this.serverTime = snapTime;
      this.jumped = true;
      shown = '<RESET> ';
    } else if (deltaDelta > 100) {
      shown = '<FAST> ';
      this.serverTimeDelta = (this.serverTimeDelta + newDelta) >> 1;
    } else if (this.extrapolatedSnapshot) {
      this.extrapolatedSnapshot = false;
      this.serverTimeDelta -= 2 * share;
    } else {
      this.serverTimeDelta += share;
    }
    // Printed as the whole milliseconds Quake 3's is.
    return `${shown}${Math.trunc(this.serverTimeDelta)}`;
  }
}

/**
 * `cl.cmds` and `cl.cmdNumber` (`client.h:123–124`): the commands the client has made, kept so
 * that each packet can carry the last few again, and `cl.outPackets`, the packets they went in.
 */
export class UserCmdRing {
  private readonly cmds: NetUserCmd[] = Array.from({ length: CMD_BACKUP }, createNetUserCmd);
  /** `cl.cmdNumber`: how many commands have been made, the newest's number. */
  cmdNumber = 0;
  /** `cl.outPackets`, by the netchan's outgoing sequence. */
  readonly outPackets: OutPacket[] = Array.from({ length: PACKET_BACKUP }, () => ({
    realtime: 0,
    serverTime: 0,
    cmdNumber: 0
  }));

  /** The buttons of frames that made no command, which the next command carries. */
  private latched = 0;

  /** `CL_ClearState`'s share, as a new gamestate makes it. */
  clear(): void {
    for (const cmd of this.cmds) Object.assign(cmd, createNetUserCmd());
    this.cmdNumber = 0;
    for (const packet of this.outPackets) {
      packet.realtime = 0;
      packet.serverTime = 0;
      packet.cmdNumber = 0;
    }
    this.latched = 0;
  }

  /** The command with this number, `cl.cmds[number & CMD_MASK]`. */
  at(number: number): NetUserCmd {
    return this.cmds[number & CMD_MASK];
  }

  /**
   * `CL_CreateNewCommands` (`cl_input.c:631–659`): this frame's commands.
   *
   * Once the clock runs there is one for each step of it the frame has reached, stamped with the
   * step's end, so a step's command is made once the clock is past its start. A frame may make
   * none, or several with the same input. Before then the clock stands, and a command a frame is
   * what puts the client in the world, as Quake 3's does.
   *
   * @param input - The frame's input, as `CL_CreateCmd` builds it; its time is set here.
   * @param clock - This frame's clock.
   * @param running - Whether the clock has had its first snapshot.
   * @param step - `pmove_msec`, as the server holds it: how long each command's step is.
   */
  createNewCommands(input: NetUserCmd, clock: ClientClock, running: boolean, step: number): void {
    this.latched |= input.buttons;
    if (!running) {
      this.add(input, clock.serverTime);
      return;
    }

    // Rounded up, as a command's time is under `pmove_fixed` (`g_active.c:799–803`).
    const newest = Math.ceil(clock.serverTime / step) * step;
    // The step after the last command's on this grid, which a change of step may have moved.
    const next = (Math.floor(this.at(this.cmdNumber).serverTime / step) + 1) * step;
    const steps = Math.floor(MAX_FRAME_COMMAND_MSEC / step);
    const first = clock.jumped ? newest : Math.max(next, newest - (steps - 1) * step);
    clock.jumped = false;
    for (let serverTime = first; serverTime <= newest; serverTime += step) {
      this.add(input, serverTime);
    }
  }

  private add(input: NetUserCmd, serverTime: number): void {
    this.cmdNumber++;
    const cmd = this.at(this.cmdNumber);
    cmd.serverTime = serverTime;
    cmd.angles = [input.angles[0], input.angles[1], input.angles[2]];
    cmd.buttons = input.buttons | this.latched;
    cmd.weapon = input.weapon;
    cmd.forwardmove = input.forwardmove;
    cmd.rightmove = input.rightmove;
    cmd.upmove = input.upmove;
    cmd.drawnTime = input.drawnTime;
    cmd.drawnSnapTime = input.drawnSnapTime;
    cmd.drawnNextSnapTime = input.drawnNextSnapTime;
    this.latched = 0;
  }
}
