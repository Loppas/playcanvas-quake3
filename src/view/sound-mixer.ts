import { MAX_GENTITIES } from '../net/protocol';
import { dotProduct, f, vec3f, vectorNormalize, type Vec3f } from '../sim/cm/q-math';
import type { Vec3 } from '../sim/vec3';

/**
 * Quake 3's base mixer as ioquake3 runs it (`snd_dma.c`, `snd_mix.c`): what each sound is heard at
 * in each ear, which sounds are let start, and how the loops are merged. The sounds themselves are
 * played elsewhere; this keeps the mixer's state and its arithmetic, in its floats and its order.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `MAX_CHANNELS` (`snd_local.h:191`): the one-shots at once, and the loops after their merge. */
export const MAX_CHANNELS = 96;

/** `SOUND_FULLVOLUME` and `SOUND_ATTENUATE` (`snd_dma.c:50-52`): full to 80, silent at 1,330. */
const SOUND_FULLVOLUME = 80;
const SOUND_ATTENUATE = f(0.0008);

/** `THIRD_PERSON_THRESHOLD_SQ` (`snd_local.h:80`). */
const THIRD_PERSON_THRESHOLD_SQ = f(48 * 48);

/** `MAX_DOPPLER_SCALE` (`snd_local.h:78`), ioquake3's cap, which id's release has not got. */
const MAX_DOPPLER_SCALE = 50;

/** `START_SAMPLE_IMMEDIATE` (`snd_local.h:76`): started, and not yet reached by the mix. */
const START_SAMPLE_IMMEDIATE = 0x7fffffff;

/** A channel's master volume, and a loop's: a speaker's "sphere" at 90 (`snd_dma.c:889-894`). */
const MASTER_VOLUME = 127;
const SPHERE_VOLUME = 90;

/** `soundChannel_t` (`q_shared.h:1052-1061`). */
export const CHAN = {
  AUTO: 0,
  LOCAL: 1,
  WEAPON: 2,
  VOICE: 3,
  ITEM: 4,
  BODY: 5,
  LOCAL_SOUND: 6,
  ANNOUNCER: 7
} as const;

/** What the mixer needs of a sound: `sfx_t`'s name and its length. */
export interface MixerSfx {
  readonly name: string;
  /** `soundLength`: its samples at the output's rate. */
  readonly length: number;
}

/** `channel_t` (`snd_local.h:95-111`): a one-shot playing, or a loop after the merge. */
export class Channel<S extends MixerSfx> {
  /** `Com_Milliseconds` when it was taken. */
  allocTime = 0;
  /** The sample it began at, or {@link START_SAMPLE_IMMEDIATE} until the mix reaches it. */
  startSample = 0;
  entnum = 0;
  entchannel = 0;
  leftvol = 0;
  rightvol = 0;
  masterVol = 0;
  dopplerScale = 0;
  readonly origin: Vec3f = vec3f();
  fixedOrigin = false;
  sfx: S | null = null;
  doppler = false;
  fullVolume = false;
  /**
   * A loop's: the loop slot the merge began from, the entity whose loop it is. Quake 3 keeps no
   * such field; it is how a Doppler loop is told from another of its sound.
   */
  entity = 0;
  /** The free list's link, which Quake 3 writes over the channel's first bytes. */
  next: Channel<S> | null = null;
  readonly index: number;

  constructor(index: number) {
    this.index = index;
  }

  /** `Com_Memset` of a channel. */
  clear(): void {
    this.allocTime = 0;
    this.startSample = 0;
    this.entnum = 0;
    this.entchannel = 0;
    this.leftvol = 0;
    this.rightvol = 0;
    this.masterVol = 0;
    this.dopplerScale = 0;
    this.origin[0] = this.origin[1] = this.origin[2] = 0;
    this.fixedOrigin = false;
    this.sfx = null;
    this.doppler = false;
    this.fullVolume = false;
    this.entity = 0;
    this.next = null;
  }
}

/** `loopSound_t` (`snd_local.h:82-93`): an entity's loop, as the frame left it. */
export class LoopSound<S extends MixerSfx> {
  readonly origin: Vec3f = vec3f();
  readonly velocity: Vec3f = vec3f();
  sfx: S | null = null;
  mergeFrame = 0;
  active = false;
  /** Stopped at the next frame's clear: `AddLoopingSound`'s, where a real loop's is not. */
  kill = false;
  doppler = false;
  dopplerScale = 0;

  clear(): void {
    this.origin[0] = this.origin[1] = this.origin[2] = 0;
    this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
    this.sfx = null;
    this.mergeFrame = 0;
    this.active = false;
    this.kill = false;
    this.doppler = false;
    this.dopplerScale = 0;
  }
}

/**
 * `snd_vol` (`snd_mix.c:520-523`): `s_volume` in 255ths, its float product truncated, which the mix
 * scales every channel's ear volumes by.
 */
export function sndVol(volume: number): number {
  return Math.trunc(f(f(volume) * 255));
}

/** Where a listener is and which way it faces: `listener_origin` and `listener_axis`. */
export interface Listener {
  readonly origin: Vec3f;
  /** Forward, left and up. */
  readonly axis: readonly [Vec3f, Vec3f, Vec3f];
}

/** Two ear volumes. */
export interface EarVolumes {
  left: number;
  right: number;
}

/** `S_SpatializeOrigin`'s `source_vec` and `vec`. */
const sourceVec = vec3f();

/**
 * `S_SpatializeOrigin` (`snd_dma.c:424-474`): a sound's two ear volumes at a place. Full to 80
 * units and silent at 1,330, panned linearly, half in each ear straight ahead, and truncated. The
 * distance is in floats, and the pan and the fade in doubles stored as floats, as the C has them.
 *
 * @param masterVol - The volume at full: 127, or a speaker's loop's 90.
 * @param out - Written and returned.
 */
export function spatializeOrigin(
  origin: ArrayLike<number>,
  masterVol: number,
  listener: Listener,
  out: EarVolumes
): EarVolumes {
  sourceVec[0] = f(origin[0] - listener.origin[0]);
  sourceVec[1] = f(origin[1] - listener.origin[1]);
  sourceVec[2] = f(origin[2] - listener.origin[2]);
  let dist = vectorNormalize(sourceVec);
  dist = f(dist - SOUND_FULLVOLUME);
  if (dist < 0) dist = 0;
  dist = f(dist * SOUND_ATTENUATE);

  // `VectorRotate`'s second row: axis 1 is the left, so the dot is how far to the right.
  const dot = -dotProduct(sourceVec, listener.axis[1]);
  let rscale = f(0.5 * (1.0 + dot));
  let lscale = f(0.5 * (1.0 - dot));
  if (rscale < 0) rscale = 0;
  if (lscale < 0) lscale = 0;

  out.right = Math.max(0, Math.trunc(f(masterVol * f((1.0 - dist) * rscale))));
  out.left = Math.max(0, Math.trunc(f(masterVol * f((1.0 - dist) * lscale))));
  return out;
}

/** `DistanceSquared` (`q_shared.h:614-619`), in floats. */
function distanceSquared(p1: ArrayLike<number>, p2: ArrayLike<number>): number {
  const x = f(p2[0] - p1[0]);
  const y = f(p2[1] - p1[1]);
  const z = f(p2[2] - p1[2]);
  return f(f(f(x * x) + f(y * y)) + f(z * z));
}

/** `VectorLengthSquared` (`q_shared.h:603-605`), in floats. */
function lengthSquared(v: ArrayLike<number>): number {
  return f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]));
}

/** `VectorCopy` of a vector into a `vec3_t`. */
function copyInto(from: Vec3, to: Vec3f): void {
  to[0] = f(from.x);
  to[1] = f(from.y);
  to[2] = f(from.z);
}

/**
 * The base mixer's state and the calls cgame makes of it: the 96 channels and their scan, the
 * loops by entity and their merge, and the listener.
 *
 * Its clocks are Quake 3's two: `Com_Milliseconds`, real time in whole milliseconds, which a
 * channel is taken at; and the painted time, in samples at the output's rate, which a sound is
 * played out against.
 */
export class SoundMixer<S extends MixerSfx> {
  /** `s_channels`. */
  readonly channels: Channel<S>[] = Array.from({ length: MAX_CHANNELS }, (_, i) => new Channel(i));
  /** `loop_channels`, of which the first {@link numLoopChannels} are this frame's. */
  readonly loopChannels: Channel<S>[] = Array.from(
    { length: MAX_CHANNELS },
    (_, i) => new Channel(i)
  );
  numLoopChannels = 0;
  /** `loopSounds`: each entity's loop, and where its sounds are heard from. */
  readonly loopSounds: LoopSound<S>[] = Array.from(
    { length: MAX_GENTITIES },
    () => new LoopSound()
  );
  /** `listener_number`: whose sounds are heard from inside. */
  listenerNumber = 0;
  readonly listener: Listener = { origin: vec3f(), axis: [vec3f(), vec3f(), vec3f()] };
  /** `s_doppler`. */
  doppler = true;

  private freelist: Channel<S> | null = null;
  /** `S_AddLoopSounds`' static `loopFrame`. */
  private loopFrame = 0;
  private readonly volumes: EarVolumes = { left: 0, right: 0 };
  /** `S_Base_AddLoopingSound`'s `out`, and `S_Base_HearingThroughEntity`'s `sorigin`. */
  private readonly ahead = vec3f();
  private readonly sorigin = vec3f();

  constructor() {
    this.channelSetup();
  }

  /**
   * `S_Base_ClearSoundBuffer` (`snd_dma.c:688-712`), the mixer's half of `S_StopAllSounds`: every
   * loop and every channel gone.
   */
  clearSoundBuffer(): void {
    for (const loop of this.loopSounds) loop.clear();
    for (const channel of this.loopChannels) channel.clear();
    this.numLoopChannels = 0;
    this.channelSetup();
  }

  /**
   * `S_Base_StartSoundEx` (`snd_dma.c:527-648`): a sound started on an entity, at a place of its
   * own or, with no origin, wherever its entity is heard from as it moves.
   *
   * The same sound on the same entity within 50 ms is dropped, and so is a sixth at once (a tenth
   * on the listener). With every channel playing, the oldest of the entity's is taken, then the
   * oldest of anyone's but the listener's, and the listener's only if the first channel is theirs.
   * The channel a sound is started on is kept only to spare the announcer's from being taken.
   *
   * @param time - `Com_Milliseconds`.
   * @param localSound - `S_StartLocalSound`'s: heard at full volume wherever it is.
   * @returns the channel's index, or -1 for a sound dropped
   */
  startSound(
    origin: Vec3 | null,
    entityNum: number,
    entchannel: number,
    sfx: S,
    time: number,
    localSound = false
  ): number {
    if (!origin && (entityNum < 0 || entityNum >= MAX_GENTITIES)) {
      throw new Error(`S_StartSound: bad entitynum ${entityNum}`);
    }

    const allowed = entityNum === this.listenerNumber ? 8 : 4;
    const fullVolume = localSound || this.hearingThroughEntity(entityNum, origin);

    let inplay = 0;
    for (const ch of this.channels) {
      if (ch.entnum === entityNum && ch.sfx === sfx) {
        if (time - ch.allocTime < 50) return -1;
        inplay++;
      }
    }
    if (inplay > allowed) return -1;

    let ch = this.channelMalloc(time);
    if (!ch) {
      const chosen = this.oldestChannel(entityNum, time);
      if (chosen === -1) return -1;
      ch = this.channels[chosen];
      ch.allocTime = time;
    }

    if (origin) {
      copyInto(origin, ch.origin);
      ch.fixedOrigin = true;
    } else {
      ch.fixedOrigin = false;
    }
    ch.masterVol = MASTER_VOLUME;
    ch.entnum = entityNum;
    ch.sfx = sfx;
    ch.startSample = START_SAMPLE_IMMEDIATE;
    ch.entchannel = entchannel;
    // Until the next spatialize.
    ch.leftvol = ch.masterVol;
    ch.rightvol = ch.masterVol;
    ch.doppler = false;
    ch.fullVolume = fullVolume;
    return ch.index;
  }

  /** `S_Base_StartLocalSound` (`snd_dma.c:666-677`): on the listener, at full volume. */
  startLocalSound(sfx: S, channelNum: number, time: number): number {
    return this.startSound(null, this.listenerNumber, channelNum, sfx, time, true);
  }

  /**
   * `S_Base_ClearLoopingSounds` (`snd_dma.c:750-758`): each frame's `AddLoopingSound`s stopped,
   * or with `killall`, every loop, the real ones too.
   */
  clearLoopingSounds(killall: boolean): void {
    for (const loop of this.loopSounds) {
      if (killall || loop.kill || (loop.sfx && loop.sfx.length === 0)) {
        // `S_Base_StopLoopingSound`.
        loop.active = false;
        loop.kill = false;
      }
    }
    this.numLoopChannels = 0;
  }

  /**
   * `S_Base_AddLoopingSound` (`snd_dma.c:768-821`): an entity's loop for this frame, the last
   * added to an entity winning. One that moves is pitched up near the listener's entity: by how
   * much further from it the loop will be in a second than it is now, past ten times as far, up
   * to 50 times. ioquake3 also starts the read of its first painted samples from the scale the
   * frame before had, which a loop played at a rate has no use for.
   *
   * @param velocity - In units a second.
   */
  addLoopingSound(entityNum: number, origin: Vec3, velocity: Vec3, sfx: S): void {
    if (!sfx.length) throw new Error(`${sfx.name} has length 0`);
    const loop = this.loopSounds[entityNum];
    copyInto(origin, loop.origin);
    copyInto(velocity, loop.velocity);
    loop.active = true;
    loop.kill = true;
    loop.doppler = false;
    loop.dopplerScale = 1;
    loop.sfx = sfx;

    if (this.doppler && lengthSquared(loop.velocity) > 0) {
      loop.doppler = true;
      const listener = this.loopSounds[this.listenerNumber].origin;
      const lena = distanceSquared(listener, loop.origin);
      const ahead = this.ahead;
      ahead[0] = f(loop.origin[0] + loop.velocity[0]);
      ahead[1] = f(loop.origin[1] + loop.velocity[1]);
      ahead[2] = f(loop.origin[2] + loop.velocity[2]);
      const lenb = distanceSquared(listener, ahead);
      loop.dopplerScale = f(lenb / f(lena * 100));
      if (loop.dopplerScale <= 1) {
        loop.doppler = false;
      } else if (loop.dopplerScale > MAX_DOPPLER_SCALE) {
        loop.dopplerScale = MAX_DOPPLER_SCALE;
      }
    }
  }

  /**
   * `S_Base_AddRealLoopingSound` (`snd_dma.c:831-858`): a loop the frame's clear leaves alone,
   * heard where it was last added until a clear of every loop.
   */
  addRealLoopingSound(entityNum: number, origin: Vec3, velocity: Vec3, sfx: S): void {
    if (!sfx.length) throw new Error(`${sfx.name} has length 0`);
    const loop = this.loopSounds[entityNum];
    copyInto(origin, loop.origin);
    copyInto(velocity, loop.velocity);
    loop.sfx = sfx;
    loop.active = true;
    loop.kill = false;
    loop.doppler = false;
  }

  /** `S_Base_UpdateEntityPosition` (`snd_dma.c:1107-1112`): where an entity's sounds are heard. */
  updateEntityPosition(entityNum: number, origin: Vec3): void {
    if (entityNum < 0 || entityNum >= MAX_GENTITIES) {
      throw new Error(`S_UpdateEntityPosition: bad entitynum ${entityNum}`);
    }
    copyInto(origin, this.loopSounds[entityNum].origin);
  }

  /**
   * `S_Base_Respatialize` (`snd_dma.c:1122-1160`): the listener placed, every channel's volumes
   * worked again from where its sound now is, and the loops merged.
   *
   * @param axis - Forward, left and up.
   */
  respatialize(entityNum: number, head: Vec3, axis: readonly ArrayLike<number>[]): void {
    this.listenerNumber = entityNum;
    copyInto(head, this.listener.origin);
    for (let i = 0; i < 3; i++) {
      const row = this.listener.axis[i];
      row[0] = f(axis[i][0]);
      row[1] = f(axis[i][1]);
      row[2] = f(axis[i][2]);
    }

    for (const ch of this.channels) {
      if (!ch.sfx) continue;
      // "Local and first person sounds will always be full volume."
      if (ch.fullVolume) {
        ch.leftvol = ch.masterVol;
        ch.rightvol = ch.masterVol;
      } else {
        const origin = ch.fixedOrigin ? ch.origin : this.loopSounds[ch.entnum].origin;
        spatializeOrigin(origin, ch.masterVol, this.listener, this.volumes);
        ch.leftvol = this.volumes.left;
        ch.rightvol = this.volumes.right;
      }
    }

    this.addLoopSounds();
  }

  /**
   * `S_ScanChannelStarts` (`snd_dma.c:1170-1198`), as `S_Update` runs it before each mix: a sound
   * just started begins at the painted time, and one played out frees its channel.
   *
   * @param paintedTime - `s_paintedtime`, in samples at the output's rate.
   */
  scanChannelStarts(paintedTime: number): void {
    for (const ch of this.channels) {
      if (!ch.sfx) continue;
      if (ch.startSample === START_SAMPLE_IMMEDIATE) {
        ch.startSample = paintedTime;
        continue;
      }
      if (ch.startSample + ch.sfx.length <= paintedTime) this.channelFree(ch);
    }
  }

  /**
   * `S_AddLoopSounds` (`snd_dma.c:871-942`): every active loop, in entity order, merged with the
   * later loops of its sound that are not pitched, their truncated ear volumes summed and capped
   * at 255, into one channel. "All sounds are on the same cycle, so any duplicates can just sum
   * up the channel multipliers."
   */
  private addLoopSounds(): void {
    this.numLoopChannels = 0;
    const loopFrame = ++this.loopFrame;
    const { loopSounds, volumes } = this;

    for (let i = 0; i < MAX_GENTITIES; i++) {
      const loop = loopSounds[i];
      // Already merged into an earlier sound.
      if (!loop.active || loop.mergeFrame === loopFrame) continue;

      const master = loop.kill ? MASTER_VOLUME : SPHERE_VOLUME;
      spatializeOrigin(loop.origin, master, this.listener, volumes);
      let leftTotal = volumes.left;
      let rightTotal = volumes.right;

      for (let j = i + 1; j < MAX_GENTITIES; j++) {
        const loop2 = loopSounds[j];
        if (!loop2.active || loop2.doppler || loop2.sfx !== loop.sfx) continue;
        loop2.mergeFrame = loopFrame;
        spatializeOrigin(
          loop2.origin,
          loop2.kill ? MASTER_VOLUME : SPHERE_VOLUME,
          this.listener,
          volumes
        );
        leftTotal += volumes.left;
        rightTotal += volumes.right;
      }
      // Not audible.
      if (leftTotal === 0 && rightTotal === 0) continue;

      const ch = this.loopChannels[this.numLoopChannels];
      ch.masterVol = MASTER_VOLUME;
      ch.leftvol = Math.min(leftTotal, 255);
      ch.rightvol = Math.min(rightTotal, 255);
      ch.sfx = loop.sfx;
      ch.doppler = loop.doppler;
      ch.dopplerScale = loop.dopplerScale;
      ch.fullVolume = false;
      ch.entity = i;
      this.numLoopChannels++;
      if (this.numLoopChannels === MAX_CHANNELS) return;
    }
  }

  /**
   * `S_Base_HearingThroughEntity` (`snd_dma.c:487-516`): a sound on the listener's own entity
   * within 48 units of the listener is heard from inside it. "An outrageous hack to detect
   * whether or not the player is rendering in third person."
   */
  private hearingThroughEntity(entityNum: number, origin: Vec3 | null): boolean {
    if (this.listenerNumber !== entityNum) return false;
    let sorigin = this.loopSounds[entityNum].origin;
    if (origin) {
      sorigin = this.sorigin;
      copyInto(origin, sorigin);
    }
    return !(distanceSquared(sorigin, this.listener.origin) > THIRD_PERSON_THRESHOLD_SQ);
  }

  /** The last three tiers of `S_Base_StartSoundEx`'s search, for a channel to take. */
  private oldestChannel(entityNum: number, time: number): number {
    const { channels, listenerNumber } = this;
    // `sfx->lastTimeUsed`, which is now.
    let oldest = time;
    let chosen = -1;
    for (let i = 0; i < MAX_CHANNELS; i++) {
      const ch = channels[i];
      if (
        ch.entnum !== listenerNumber &&
        ch.entnum === entityNum &&
        ch.allocTime < oldest &&
        ch.entchannel !== CHAN.ANNOUNCER
      ) {
        oldest = ch.allocTime;
        chosen = i;
      }
    }
    if (chosen !== -1) return chosen;

    for (let i = 0; i < MAX_CHANNELS; i++) {
      const ch = channels[i];
      if (
        ch.entnum !== listenerNumber &&
        ch.allocTime < oldest &&
        ch.entchannel !== CHAN.ANNOUNCER
      ) {
        oldest = ch.allocTime;
        chosen = i;
      }
    }
    if (chosen !== -1) return chosen;

    if (channels[0].entnum === listenerNumber) {
      for (let i = 0; i < MAX_CHANNELS; i++) {
        if (channels[i].allocTime < oldest) {
          oldest = channels[i].allocTime;
          chosen = i;
        }
      }
    }
    // "dropping sound", at -1.
    return chosen;
  }

  /** `S_ChannelSetup` (`snd_dma.c:200-215`): every channel cleared and free, the last first. */
  private channelSetup(): void {
    for (const ch of this.channels) ch.clear();
    for (let i = MAX_CHANNELS - 1; i > 0; i--) this.channels[i].next = this.channels[i - 1];
    this.channels[0].next = null;
    this.freelist = this.channels[MAX_CHANNELS - 1];
  }

  /** `S_ChannelMalloc` (`snd_dma.c:189-198`). */
  private channelMalloc(time: number): Channel<S> | null {
    const ch = this.freelist;
    if (!ch) return null;
    this.freelist = ch.next;
    ch.allocTime = time;
    return ch;
  }

  /** `S_ChannelFree` (`snd_dma.c:183-187`). */
  private channelFree(ch: Channel<S>): void {
    ch.sfx = null;
    ch.next = this.freelist;
    this.freelist = ch;
  }
}
