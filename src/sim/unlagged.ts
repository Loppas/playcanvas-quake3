import type { NetUserCmd } from '../net/protocol';
import { snapshotGap } from '../net/snapshot-rate';
import {
  NOT_SAVED,
  NUM_PING_SAMPLES,
  createHistoryRecord,
  isSpectator,
  type GameClient,
  type HistoryRecord
} from './client';
import { SVF, copyVec, type GameEntity } from './game-entity';
import type { Level } from './level';
import { copy, lerp, type Vec3 } from './vec3';
import { WP } from './weapons/constants';

/**
 * Lag compensation: unlagged's backward reconciliation (`g_unlagged.c`) and its true ping, as
 * Excessive Plus ships them.
 *
 * Every player's position is recorded at each frame's end. A hitscan shot moves every other
 * player back to where the shooter saw them, for its traces and the hurt they do, and puts them
 * back after. Where the shooter saw them is the port's own: each command names the two snapshots
 * its frame drew the others between, and how far between, so a target is put where it was drawn.
 *
 * Where Excessive Plus counts one frame back from the time a command ran, the port counts the gap
 * between the client's snapshots: Excessive Plus sent a snapshot every frame.
 */

/** How far back a history reaches: unlagged's 17 records of Quake 3's 50 ms frame. */
export const HISTORY_MSEC = 850;

/** Scratch for the two records a rewind interpolates between. */
const before = createHistoryRecord();
const after = createHistoryRecord();

/**
 * `G_ResetHistory`: fill a client's history with where they stand now, stamped a frame apart back
 * from now, so a rewind never puts them somewhere between a jump's two ends.
 *
 * @param entity - The client's entity.
 */
export function resetHistory(level: Level, entity: GameEntity): void {
  const client = entity.client!;
  const { history } = client;
  if (history.length === 0) return;
  const frame = level.time - level.previousTime;
  client.historyHead = history.length - 1;
  for (let i = client.historyHead, time = level.time; i >= 0; i--, time -= frame) {
    const record = history[i];
    copyVec(entity.r.currentOrigin, record.origin);
    copyVec(entity.r.mins, record.mins);
    copyVec(entity.r.maxs, record.maxs);
    record.time = time;
  }
}

/**
 * `G_StoreHistory`: record where a client stands at this frame's end. The origin is the entity's
 * `trBase`, which is what a snapshot carries and so what the others draw.
 *
 * A history holds {@link HISTORY_MSEC} of frames, so it is sized again when the frame's length
 * changes.
 *
 * @param entity - The client's entity.
 */
export function storeHistory(level: Level, entity: GameEntity): void {
  const client = entity.client!;
  const frame = level.time - level.previousTime;
  if (frame > 0) sizeHistory(client, Math.ceil(HISTORY_MSEC / frame));
  const { history } = client;
  if (history.length === 0) return;

  client.historyHead = (client.historyHead + 1) % history.length;
  const record = history[client.historyHead];
  copyVec(entity.s.pos.trBase, record.origin);
  copyVec(entity.r.mins, record.mins);
  copyVec(entity.r.maxs, record.maxs);
  record.time = level.time;
}

/**
 * Make a client's history `length` records long, keeping the newest it holds. One made longer
 * repeats its oldest record before them, so a time older than that still finds the oldest.
 */
function sizeHistory(client: GameClient, length: number): void {
  const old = client.history;
  const count = old.length;
  if (count === length) return;

  const history = Array.from({ length }, createHistoryRecord);
  if (count > 0) {
    for (let i = 0; i < length; i++) {
      const from = old[(client.historyHead - Math.min(i, count - 1) + count) % count];
      copyRecord(from, history[length - 1 - i]);
    }
  }
  client.history = history;
  client.historyHead = length - 1;
}

/**
 * `G_DoTimeShiftFor`: move every other player back for a shot. A weapon `xp_unlagged` covers
 * ({@link unlaggedCovers}) moves them to where this player drew them; any other moves them to
 * where they were a snapshot gap before the command ran.
 *
 * A covered shot puts each target at its history at the two snapshot times the shooter's command
 * names, and between them by the command's own fraction. A command with no drawn frame is taken at
 * its own time, as Excessive Plus takes every command. Any other shot puts each target between the
 * two records either side of {@link fallbackTime}. A bot never rewinds.
 *
 * A railgun shot by a client with `cg_debugDelag` prints each target's rewind to them.
 *
 * @param shooter - The shooter's entity.
 * @param weapon - The weapon the shot is from.
 * @param unlagged - `xp_unlagged`.
 */
export function timeShiftFor(
  level: Level,
  shooter: GameEntity,
  weapon: number,
  unlagged: number
): void {
  const client = shooter.client;
  // "don't time shift for mistakes or bots"
  if (!shooter.inuse || !client || shooter.r.svFlags & SVF.BOT) return;

  let time: number;
  let snapTime: number;
  let nextSnapTime: number;
  let frac = 0;
  if (unlaggedCovers(weapon, unlagged)) {
    const cmd = client.pers.cmd;
    time = drawnTime(cmd);
    snapTime = cmd.drawnSnapTime ? cmd.drawnSnapTime : cmd.serverTime;
    nextSnapTime = cmd.drawnSnapTime ? cmd.drawnNextSnapTime : cmd.serverTime;
    // The client's fraction never takes a target outside the two snapshots it names.
    const span = nextSnapTime - snapTime;
    if (span > 0) frac = Math.min(Math.max((time - snapTime) / span, 0), 1);
  } else {
    // "do just 50ms"
    time = fallbackTime(level, client);
    snapTime = time;
    nextSnapTime = time;
  }

  const report = client.pers.debugDelag && weapon === WP.RAILGUN ? { shooter, time } : null;
  for (let i = 0; i < level.maxclients; i++) {
    const target = level.gentities[i];
    if (isRewound(target, shooter)) {
      timeShiftClient(level, target, snapTime, nextSnapTime, frac, report);
    }
  }
}

/**
 * `G_UndoTimeShiftFor`: put back everyone this shooter's rewind moved.
 *
 * @param shooter - The shooter's entity.
 */
export function undoTimeShiftFor(level: Level, shooter: GameEntity): void {
  if (!shooter.inuse || !shooter.client || shooter.r.svFlags & SVF.BOT) return;
  for (let i = 0; i < level.maxclients; i++) {
    const target = level.gentities[i];
    if (isRewound(target, shooter)) unTimeShiftClient(level, target);
  }
}

/**
 * `G_UnTimeShiftClient`: put a client back where the rewind found them, if it moved them this
 * frame, and in the world by the box it found them by.
 *
 * @param entity - The client's entity.
 */
export function unTimeShiftClient(level: Level, entity: GameEntity): void {
  const saved = entity.client?.saved;
  if (!saved || saved.time !== level.time) return;

  entity.r.currentOrigin = copy(saved.origin);
  entity.r.mins = copy(saved.mins);
  entity.r.maxs = copy(saved.maxs);
  saved.time = NOT_SAVED;
  level.linkEntity(entity);
  entity.r.absmin = copy(saved.absmin);
  entity.r.absmax = copy(saved.absmax);
}

/**
 * Unlagged's true ping, which Excessive Plus always measures: each command a connected client
 * sends, one that moves no time included, puts {@link fallbackTime} less the time its frame was
 * drawn at into a ring, and the ring's mean, held at 0 or more, is the ping the scoreboard shows.
 * The snapshot gap it takes off is most of what drawing behind the newest snapshot adds.
 *
 * @param client - The client whose command is running, its `frameOffset` taken.
 */
export function samplePing(level: Level, client: GameClient): void {
  const { pers } = client;
  pers.pingSamples[pers.sampleHead] = fallbackTime(level, client) - drawnTime(pers.cmd);
  pers.sampleHead = (pers.sampleHead + 1) % NUM_PING_SAMPLES;

  // "get an average of the samples we saved up"
  let sum = 0;
  for (const sample of pers.pingSamples) sum += sample;
  pers.realPing = Math.max(Math.trunc(sum / NUM_PING_SAMPLES), 0);
}

/** Where a rewind put a target, as `cg_debugDelag` prints it on both sides. */
export interface DelagShift {
  /** The time the shot was aimed at. */
  time: number;
  /** The two snapshot times the target was put between. */
  j: number;
  k: number;
  /** Where it was put. */
  origin: Vec3;
  /** How far from the first time toward the second. */
  frac: number;
  /** Where it was at each. */
  origin1: Vec3;
  origin2: Vec3;
}

/**
 * The first two lines `cg_debugDelag` prints of a target, which the server and the client print
 * alike, field for field (`g_unlagged.c`'s `G_TimeShiftClient`, `cg_unlagged.c`).
 *
 * @param head - The first line's colour and label.
 * @param fracColor - The second line's colour.
 */
export function delagLines(head: string, fracColor: string, shift: DelagShift): string {
  const { time, j, k, origin, frac, origin1, origin2 } = shift;
  // `%d`: the fraction says how far between the snapshots the time is.
  return (
    `${head}: time: ${Math.trunc(time)}, j: ${j}, k: ${k}, origin: ${printed(origin)}\n` +
    `${fracColor}frac: ${frac.toFixed(4)}, origin1: ${printed(origin1)}, ` +
    `origin2: ${printed(origin2)}\n`
  );
}

/** A point as `%0.2f %0.2f %0.2f` prints it. */
function printed(v: Vec3): string {
  return `${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.z.toFixed(2)}`;
}

/**
 * Whether `xp_unlagged` covers a weapon: every one at 1, otherwise those whose `1 << weapon` it
 * has.
 */
export function unlaggedCovers(weapon: number, unlagged: number): boolean {
  return unlagged === 1 || (unlagged & (1 << weapon)) !== 0;
}

/**
 * Unlagged's `attackTime`: the time a command's frame was drawn at, or the command's own time for
 * one sent before the view drew a frame.
 */
export function drawnTime(cmd: NetUserCmd): number {
  return cmd.drawnSnapTime ? cmd.drawnTime : cmd.serverTime;
}

/**
 * Unlagged's `attackTime % 256`: the seed a command's shot is scattered by, from the whole
 * milliseconds of its drawn time.
 */
export function shotSeed(cmd: NetUserCmd): number {
  return Math.trunc(drawnTime(cmd)) % 256;
}

/**
 * Excessive Plus's `level.previousTime + frameOffset`: the time a client's command ran, the last
 * frame's time and its `frameOffset`, less the gap between the client's snapshots, rounded up to
 * whole frames as they really go.
 */
function fallbackTime(level: Level, client: GameClient): number {
  const gap = snapshotGap(client.pers.snapshotMsec, level.time - level.previousTime);
  return level.time + client.frameOffset - gap;
}

/**
 * Whether a rewind moves this player: anyone in use but the shooter, the dead and bots included,
 * unless they watch (Excessive Plus's test, which takes in Clan Arena's eliminated).
 */
function isRewound(target: GameEntity, shooter: GameEntity): boolean {
  return target !== shooter && target.inuse && !!target.client && !isSpectator(target.client);
}

/** Who a rewind is printed to, and the time their shot was aimed at. */
interface DelagReport {
  shooter: GameEntity;
  time: number;
}

/**
 * `G_TimeShiftClient`, at the shooter's two snapshots: the target goes to where it was at each,
 * and between the two by `frac`. A time at or past the newest record is where the target is now,
 * and with both there it is not moved.
 *
 * @param report - Who to print the rewind to, or `null`.
 */
function timeShiftClient(
  level: Level,
  entity: GameEntity,
  snapTime: number,
  nextSnapTime: number,
  frac: number,
  report: DelagReport | null
): void {
  const client = entity.client!;
  const atSnap = historyAt(client, snapTime, before);
  const atNextSnap = historyAt(client, nextSnapTime, after);
  if (!atSnap && !atNextSnap) {
    if (report) {
      // Left where it is, which is every place the lines name.
      const origin = entity.r.currentOrigin;
      printShift(level, report, '^1No rec', {
        time: report.time,
        j: level.time,
        k: level.time,
        origin,
        frac: 0,
        origin1: origin,
        origin2: origin
      });
    }
    return;
  }

  const { saved } = client;
  // "make sure it doesn't get re-saved"
  if (saved.time !== level.time) {
    copyVec(entity.r.currentOrigin, saved.origin);
    copyVec(entity.r.mins, saved.mins);
    copyVec(entity.r.maxs, saved.maxs);
    copyVec(entity.r.absmin, saved.absmin);
    copyVec(entity.r.absmax, saved.absmax);
    saved.time = level.time;
  }

  const from = atSnap ? before : saved;
  const to = atNextSnap ? after : saved;
  entity.r.currentOrigin = lerp(from.origin, to.origin, frac);
  entity.r.mins = lerp(from.mins, to.mins, frac);
  entity.r.maxs = lerp(from.maxs, to.maxs, frac);
  if (report) {
    printShift(level, report, '^1Rec', {
      time: report.time,
      j: snapTime,
      k: nextSnapTime,
      origin: entity.r.currentOrigin,
      frac,
      origin1: from.origin,
      origin2: to.origin
    });
  }
  level.linkEntity(entity);
}

/**
 * `G_TimeShiftClient`'s print to the shooter: the target's two lines, then the frame's time, when
 * the shooter's command ran, and how far back from each the shot was aimed.
 */
function printShift(level: Level, report: DelagReport, head: string, shift: DelagShift): void {
  const { shooter } = report;
  const time = Math.trunc(report.time);
  const estTime = level.time + shooter.client!.frameOffset;
  level.sendServerCommand(
    shooter.s.number,
    `print "${delagLines(head, '^2', shift)}` +
      `^7level.time: ${level.time}, est time: ${estTime}, ` +
      `level.time delta: ${level.time - time}, est real ping: ${estTime - time}\n"`
  );
}

/**
 * `G_TimeShiftClient`'s search: where a client stood at `time`, between the two records either side
 * of it, or at the oldest for a time before them all.
 *
 * @param out - Where to write it.
 * @returns false for a time at or past the newest record.
 */
function historyAt(client: GameClient, time: number, out: HistoryRecord): boolean {
  const { history, historyHead: head } = client;
  const count = history.length;
  if (count === 0) return false;

  // "find two entries in the history whose times sandwich time"
  let j = head;
  let k = head;
  do {
    if (history[j].time <= time) break;
    k = j;
    j = j > 0 ? j - 1 : count - 1;
  } while (j !== head);
  if (j === k) return false;

  // "we wrapped, so grab the earliest"
  if (j === head) {
    copyRecord(history[k], out);
    return true;
  }
  const frac = (time - history[j].time) / (history[k].time - history[j].time);
  out.origin = lerp(history[j].origin, history[k].origin, frac);
  out.mins = lerp(history[j].mins, history[k].mins, frac);
  out.maxs = lerp(history[j].maxs, history[k].maxs, frac);
  out.time = time;
  return true;
}

/** `*to = *from` for a record. */
function copyRecord(from: HistoryRecord, to: HistoryRecord): void {
  copyVec(from.origin, to.origin);
  copyVec(from.mins, to.mins);
  copyVec(from.maxs, to.maxs);
  to.time = from.time;
}
