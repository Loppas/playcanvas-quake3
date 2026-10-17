import { comParse, parseCursor } from '../formats/com-parse';
import { MAX_QPATH, SoundStream, toInt, type SoundStreamFile } from '../formats/wav';
import { f } from '../sim/cm/q-math';

/**
 * The music as ioquake3 plays it: the two names `CG_StartMusic` reads from `CS_MUSIC`
 * (`cg_main.c:1174-1184`), and the background track (`snd_dma.c:1367-1498`), its file read a
 * stretch at a time into a queue on the output's clock, the intro then the loop with no gap. The
 * queue is played elsewhere; this keeps its state and its arithmetic.
 *
 * Quake 3 keeps 16,384 samples written ahead, which a page's slow frame would run dry, read 30,000
 * bytes at a time. The port keeps {@link MUSIC_AHEAD} seconds queued, read {@link MUSIC_READ} at a
 * time, and cuts what it has queued past where Quake 3 would still be painting when the music
 * starts again or is held.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** At least this much is kept queued ahead of the output's clock, in seconds. */
export const MUSIC_AHEAD = 2;
/**
 * What each read of the file covers, in seconds of the output: about Quake 3's 30,000 bytes of 22
 * kHz stereo, and a read's copy is the frame's work, a millisecond for two seconds.
 */
export const MUSIC_READ = 0.25;
/**
 * `s_mixPreStep` (`snd_dma.c:1568`): how far ahead of the output Quake 3 paints, in seconds
 * (`snd_dma.c:1285-1286`). What is written for a time before that is never heard.
 */
export const MIX_PRESTEP = 0.05;

/**
 * The most frames a read can come to at an output's rate: a read takes the file's samples for
 * {@link MUSIC_READ}, which the scale's float makes at most two frames more.
 */
export function musicReadFrames(speed: number): number {
  return Math.round(MUSIC_READ * speed) + 16;
}

/** The music a `CS_MUSIC` names. */
export interface MusicNames {
  /** The track to play first, or `''` for no music. */
  intro: string;
  /** The track played over and over after it: the intro itself where only one is named. */
  loop: string;
}

/**
 * `CG_StartMusic`'s two tokens, each cut to `MAX_QPATH` as `Q_strncpyz` cuts it, and the loop
 * `S_Base_StartBackgroundTrack` makes of them (`snd_dma.c:1406-1424`): a lone name loops itself.
 *
 * @param configstring - `CS_MUSIC`.
 */
export function musicNames(configstring: string): MusicNames {
  const cursor = parseCursor(configstring);
  const intro = comParse(cursor).slice(0, MAX_QPATH - 1);
  const loop = comParse(cursor).slice(0, MAX_QPATH - 1);
  return { intro, loop: loop || intro };
}

/**
 * The music's volume, `S_Base_RawSamples`' (`snd_dma.c:1006-1010`): 256 × `s_musicvolume` ×
 * `s_volume` in floats, truncated. A sample is played at it over 256, and `snd_vol` plays no part.
 */
export function musicVolume(musicvolume: number, volume: number): number {
  return toInt(f(f(256 * f(musicvolume)) * f(volume)));
}

/** A 16-bit sample from a file's bytes, little-endian, a byte past their end silence. */
function short(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)) << 16) >> 16;
}

/**
 * `S_Base_RawSamples`' copy of a read (`snd_dma.c:1013-1088`): its samples at the output's rate,
 * each the one `i × scale` into the read in floats, the scale starting again with each read. A mono
 * read goes to both ears. An 8-bit stereo read is taken as signed, as Quake 3 takes it, and a mono
 * one as unsigned. A read of any other width or channels writes nothing.
 *
 * @param at - Where the read begins in the file's bytes.
 * @param samples - How many of the file's samples it holds.
 * @param speed - `dma.speed`: the output's rate.
 * @param left - Written with the left ear's 16-bit samples, before the volume; `right` the right.
 * @returns how many were written, at most as many as `left` holds
 */
export function rawSamples(
  file: SoundStreamFile,
  at: number,
  samples: number,
  speed: number,
  left: Int16Array,
  right: Int16Array
): number {
  const { bytes, info } = file;
  const { width, channels } = info;
  const scale = f(f(info.rate) / speed);
  let i = 0;
  if (width === 2 && (channels === 1 || channels === 2)) {
    for (; i < left.length; i++) {
      const src = toInt(f(i * scale));
      if (src >= samples) break;
      left[i] = short(bytes, at + src * 2 * channels);
      right[i] = channels === 2 ? short(bytes, at + src * 4 + 2) : left[i];
    }
  } else if (width === 1 && channels === 2) {
    for (; i < left.length; i++) {
      const src = toInt(f(i * scale));
      if (src >= samples) break;
      // `(char *)data`: signed.
      left[i] = (((bytes[at + src * 2] ?? 0) << 24) >> 24) * 256;
      right[i] = (((bytes[at + src * 2 + 1] ?? 0) << 24) >> 24) * 256;
    }
  } else if (width === 1 && channels === 1) {
    for (; i < left.length; i++) {
      const src = toInt(f(i * scale));
      if (src >= samples) break;
      const sample = ((bytes[at + src] ?? 0) - 128) * 256;
      left[i] = sample;
      right[i] = sample;
    }
  }
  return i;
}

/** A file the music opens: the name it was opened by, what opening it said, and the file. */
export interface MusicFile {
  name: string;
  /** The file, or `null` for one that would not open. */
  file: SoundStreamFile | null;
  /** What `S_CodecOpenStream` said opening it, said again at each open. */
  said: readonly string[];
}

/** A read of the music, queued on the output's clock. */
export interface MusicRead {
  /** The frame it begins at: `s_rawend` as it was written. */
  start: number;
  /** Its frames at the output's rate. */
  frames: number;
  /** The name of the file it was read from. */
  name: string;
  /** The stream it was read from, and the byte of the data it began at. */
  stream: SoundStream;
  pos: number;
}

/** Where the music's reads are played. */
export interface MusicSink {
  /**
   * Play a read, its samples in `left` and `right`, heard from frame `from`: Quake 3 paints nothing
   * before its painted time, so what of a read comes before that is never heard.
   */
  queue(read: MusicRead, from: number, left: Int16Array, right: Int16Array): void;
  /** Stop what is queued from a frame on, a read playing across it there; one past at once. */
  cut(frame: number): void;
}

/**
 * The background track (`s_backgroundStream`, `s_backgroundLoop`, `s_rawend[0]`): which file is
 * read, where, and what of it is queued.
 */
export class BackgroundTrack {
  /** `s_rawend[0]`: the frame the next read is queued at. */
  rawend = 0;
  /** What is queued and not yet played through, oldest first. */
  readonly queued: MusicRead[] = [];
  /** `s_backgroundStream`, or `null` for no music. */
  private stream: SoundStream | null = null;
  private streamName = '';
  /** `s_backgroundLoop`'s file, once it is read. */
  private loopFile: MusicFile | null = null;
  private readonly speed: number;
  /** {@link MUSIC_AHEAD}, {@link MUSIC_READ} and {@link MIX_PRESTEP} in frames. */
  private readonly ahead: number;
  private readonly readFrames: number;
  private readonly prestep: number;
  private readonly left: Int16Array;
  private readonly right: Int16Array;
  private readonly sink: MusicSink;
  private readonly print: (text: string) => void;

  /**
   * @param speed - `dma.speed`: the output's rate.
   * @param print - `Com_Printf`.
   */
  constructor(speed: number, sink: MusicSink, print: (text: string) => void) {
    this.speed = speed;
    this.ahead = Math.round(MUSIC_AHEAD * speed);
    this.readFrames = Math.round(MUSIC_READ * speed);
    this.prestep = Math.round(MIX_PRESTEP * speed);
    this.left = new Int16Array(musicReadFrames(speed));
    this.right = new Int16Array(musicReadFrames(speed));
    this.sink = sink;
    this.print = print;
  }

  /** Whether a track is open. */
  get playing(): boolean {
    return this.stream !== null;
  }

  /**
   * `S_Base_StartBackgroundTrack` once its intro is read (`snd_dma.c:1406-1424`): the intro opened
   * in place of what was playing, its loop to come by {@link setLoop}. Quake 3 closes the old
   * stream and plays on what it had written of it; what was queued past the painted time is cut,
   * and the intro is queued from there.
   *
   * @param soundtime - The output's clock, in frames.
   */
  start(intro: MusicFile, soundtime: number): void {
    this.loopFile = null;
    this.cut(soundtime + this.prestep);
    this.open(intro);
  }

  /** The loop's file, once it is read: what the track opens at each end. */
  setLoop(file: MusicFile): void {
    this.loopFile = file;
  }

  /** `S_Base_StopBackgroundTrack` (`snd_dma.c:1367-1373`): the stream closed, nothing heard. */
  stop(): void {
    this.stream = null;
    this.loopFile = null;
    this.queued.length = 0;
    this.rawend = 0;
    this.sink.cut(-Infinity);
  }

  /**
   * `S_UpdateBackgroundTrack` (`snd_dma.c:1431-1498`), each frame of the page's: the queue kept
   * {@link MUSIC_AHEAD} ahead of the clock, a read at a time, the loop opened again at each end.
   *
   * With `s_musicvolume` at 0 or below nothing is read. Quake 3 plays out what it had written and
   * reads no further, so the stream holds its place. The port cuts what is queued from the painted
   * time, and puts the stream back to the sample that would have been heard there.
   *
   * @param soundtime - The output's clock, in frames.
   */
  update(soundtime: number, musicvolume: number): void {
    const { queued } = this;
    while (queued.length > 0 && queued[0].start + queued[0].frames <= soundtime) queued.shift();
    if (!this.stream) return;
    const painted = soundtime + this.prestep;
    if (musicvolume <= 0) {
      this.hold(painted);
      return;
    }

    if (this.rawend < soundtime) this.rawend = soundtime;
    // Ends met with nothing queued since.
    let ends = 0;
    while (this.rawend < soundtime + this.ahead) {
      const stream: SoundStream = this.stream;
      const { info } = stream.file;
      const sampleBytes = info.width * info.channels;
      let fileSamples = Math.floor((this.readFrames * info.rate) / this.speed);
      if (fileSamples <= 0) return;
      const fileBytes = fileSamples * sampleBytes;
      const pos = stream.pos;
      const r = stream.read(fileBytes);
      if (r < fileBytes) fileSamples = Math.trunc(r / sampleBytes);
      if (r > 0) {
        const at = stream.file.offset + pos;
        const frames = rawSamples(stream.file, at, fileSamples, this.speed, this.left, this.right);
        if (frames === 0) continue;
        const read = { start: this.rawend, frames, name: this.streamName, stream, pos };
        queued.push(read);
        this.sink.queue(read, painted, this.left, this.right);
        this.rawend += frames;
        ends = 0;
        continue;
      }
      // The end: the loop opened again. Met twice with nothing between, the loop plays nothing,
      // and Quake 3 would read it again forever.
      if (++ends > 1) {
        this.stop();
        return;
      }
      // The loop's read is not in yet.
      if (!this.loopFile) return;
      this.open(this.loopFile);
      if (!this.stream) return;
    }
  }

  /**
   * `S_OpenBackgroundStream` (`snd_dma.c:1380-1399`): the old stream closed, and the file opened,
   * with what opening it says.
   */
  private open(file: MusicFile): void {
    this.stream = null;
    for (const text of file.said) this.print(text);
    if (!file.file) {
      this.print(`^3WARNING: couldn't open music file ${file.name}\n`);
      return;
    }
    this.stream = new SoundStream(file.file);
    this.streamName = file.name;
    const { channels, rate } = file.file.info;
    if (channels !== 2 || rate !== 22050) {
      this.print(`^3WARNING: music file ${file.name} is not 22k stereo\n`);
    }
  }

  /**
   * Hold the music where it is: what is queued from the painted time is cut, and the stream put
   * back to the sample of the read that would have been heard there.
   */
  private hold(painted: number): void {
    const { queued } = this;
    let at = 0;
    while (at < queued.length && queued[at].start + queued[at].frames <= painted) at++;
    if (at === queued.length) return;
    const read = queued[at];
    const { info } = read.stream.file;
    let pos = read.pos;
    if (read.start < painted) {
      const scale = f(f(info.rate) / this.speed);
      pos += toInt(f((painted - read.start) * scale)) * info.width * info.channels;
    }
    this.stream = read.stream;
    this.stream.pos = pos;
    this.streamName = read.name;
    this.cut(painted);
  }

  /** Cut the queue at a frame: what is queued from there goes, and the next read goes there. */
  private cut(frame: number): void {
    const { queued } = this;
    let at = 0;
    while (at < queued.length && queued[at].start + queued[at].frames <= frame) at++;
    if (at === queued.length) return;
    this.rawend = Math.min(this.rawend, Math.max(frame, queued[at].start));
    queued.length = at;
    this.sink.cut(frame);
  }
}
