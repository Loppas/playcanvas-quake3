import { f } from '../sim/cm/q-math';

/**
 * Quake 3's sound files as ioquake3 reads them: the codecs' search for a name (`snd_codec.c`),
 * the WAV reader (`snd_codec_wav.c`), whole or as a stream, and the resampling to the output's
 * rate (`snd_mem.c`).
 *
 * The reader is Quake 3's, not a browser's: it takes chunks in any order, reads the format tag
 * and ignores it, so whatever the data is is played as PCM, and refuses fewer than 8 bits. The
 * port has the WAV codec alone, as ioquake3 built without Vorbis and Opus has.
 */

/** `MAX_QPATH` (`q_shared.h:246`). */
export const MAX_QPATH = 64;

/** The codecs a name's extension is looked up among, and tried in this order (`S_CodecInit`). */
const CODECS = ['wav'] as const;

/**
 * `snd_info_t` (`snd_codec.h:30-38`): what a file's header says of its samples. Its `dataofs` is
 * left out, which the WAV reader sets to 0.
 */
export interface SoundInfo {
  rate: number;
  /** Bytes a sample: `bits / 8`. */
  width: number;
  channels: number;
  /** Each channel's, as the data's size makes them. */
  samples: number;
  /** The data chunk's length in bytes. */
  size: number;
}

/** A file read: its header, and its data chunk's bytes. */
export interface SoundFileData {
  info: SoundInfo;
  data: Uint8Array;
}

/** `sfx_t`'s samples once loaded (`S_LoadSound`). */
export interface LoadedSound {
  /** `soundLength`: each channel's samples at the output's rate. */
  length: number;
  /** `soundChannels`. */
  channels: number;
  /** 16-bit samples, interleaved: `length × channels` of them. */
  data: Int16Array;
}

/** Reads a file from the paks by name, or `undefined` where there is none. */
export type ReadSoundFile = (path: string) => Promise<Uint8Array | undefined>;

/**
 * A file as a pk3's handle reaches it (`FS_Read`, `FS_Seek`): read from a position that stops at
 * its end. Bytes asked for past the end are not there, and read as zeros, where Quake 3's are
 * whatever its stack or its hunk held.
 */
class SoundFile {
  pos = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** `FS_Read`: up to `length` bytes, as many as there are. */
  read(length: number): Uint8Array {
    const start = this.pos;
    this.pos = Math.min(start + Math.max(length, 0), this.bytes.byteLength);
    return this.bytes.subarray(start, this.pos);
  }

  /** `FGetLittleLong`. */
  long(): number {
    const b = this.read(4);
    return (b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16) | ((b[3] ?? 0) << 24);
  }

  /** `FGetLittleShort`. */
  short(): number {
    const b = this.read(2);
    return (((b[0] ?? 0) | ((b[1] ?? 0) << 8)) << 16) >> 16;
  }

  /**
   * `FS_Seek` from here, as a pk3's file seeks (`files.c:1611-1672`): forward by reading, or for a
   * negative offset, read again from the start to there.
   */
  seek(offset: number): void {
    if (offset < 0) {
      this.pos = Math.min(Math.max(this.pos + offset, 0), this.bytes.byteLength);
    } else {
      this.read(offset);
    }
  }
}

/** `S_ReadChunkInfo` (`snd_codec_wav.c:58-75`): a chunk's name and length, or -1. */
function readChunkInfo(
  file: SoundFile,
  print: (text: string) => void
): { name: string; len: number } {
  const name = file.read(4);
  if (name.byteLength !== 4) return { name: '', len: -1 };
  const len = file.long();
  if (len < 0) {
    print('^3WARNING: Negative chunk length\n');
    return { name: '', len: -1 };
  }
  return { name: String.fromCharCode(...name), len };
}

/**
 * `S_FindRIFFChunk` (`snd_codec_wav.c:84-101`): the length of the next chunk of a name, the file
 * left at its data, or -1. Each chunk passed is skipped to an even length.
 */
function findRiffChunk(file: SoundFile, chunk: string, print: (text: string) => void): number {
  for (;;) {
    const { name, len } = readChunkInfo(file, print);
    if (len < 0) return -1;
    if (name === chunk) return len;
    // `PAD( len, 2 )`, in an int.
    file.seek(((len + 1) | 0) & ~1);
  }
}

/**
 * `S_ReadRIFFHeader` (`snd_codec_wav.c:131-180`): the header, past the first 12 bytes unread, or
 * `null` for a file it refuses, with Quake 3's error.
 */
function readRiffHeader(file: SoundFile, print: (text: string) => void): SoundInfo | null {
  file.read(12);
  const fmtlen = findRiffChunk(file, 'fmt ', print);
  if (fmtlen < 0) {
    print('^1ERROR: Couldn\'t find "fmt" chunk\n');
    return null;
  }

  // The format tag, read and ignored.
  file.short();
  const channels = file.short();
  const rate = file.long();
  file.long();
  file.short();
  const bits = file.short();
  if (bits < 8) {
    print('^1ERROR: Less than 8 bit sound is not supported\n');
    return null;
  }
  const width = Math.trunc(bits / 8);

  if (fmtlen > 16) file.seek(fmtlen - 16);

  const size = findRiffChunk(file, 'data', print);
  if (size < 0) {
    print('^1ERROR: Couldn\'t find "data" chunk\n');
    return null;
  }
  // Quake 3 divides by zero here for a file of no channels, and ends; the port refuses it.
  if (channels === 0) return null;
  return { rate, width, channels, size, samples: Math.trunc(Math.trunc(size / width) / channels) };
}

/**
 * `S_WAV_CodecLoad` (`snd_codec_wav.c:198-236`): a file's header and data, or `null` for one that
 * is not there or that the reader refuses, with Quake 3's error for the second.
 *
 * @param bytes - The file, or `undefined` for one the paks have not got.
 */
export function wavCodecLoad(
  bytes: Uint8Array | undefined,
  filename: string,
  print: (text: string) => void
): SoundFileData | null {
  if (!bytes) return null;
  const file = new SoundFile(bytes);
  const info = readRiffHeader(file, print);
  if (!info) {
    print(`^1ERROR: Incorrect/unsupported format in "${filename}"\n`);
    return null;
  }
  return { info, data: file.read(info.size) };
}

/**
 * A file opened as a stream (`snd_stream_t`, `snd_codec.h:42-50`): its header, and its bytes with
 * where its data chunk begins in them.
 */
export interface SoundStreamFile {
  info: SoundInfo;
  bytes: Uint8Array;
  /** Where the data chunk's bytes begin. */
  offset: number;
}

/**
 * `S_WAV_CodecOpenStream` (`snd_codec_wav.c:243-259`): a file's header, or `null` for one that is
 * not there or that the reader refuses. A refusal says only the reader's error, where a load says
 * too that the format is unsupported.
 *
 * @param bytes - The file, or `undefined` for one the paks have not got.
 */
export function wavCodecOpenStream(
  bytes: Uint8Array | undefined,
  print: (text: string) => void
): SoundStreamFile | null {
  if (!bytes) return null;
  const file = new SoundFile(bytes);
  const info = readRiffHeader(file, print);
  return info ? { info, bytes, offset: file.pos } : null;
}

/** A stream open on a file: `snd_stream_t`'s place in its data, which each open starts again. */
export class SoundStream {
  /** `pos`: the bytes of the data read. */
  pos = 0;
  readonly file: SoundStreamFile;

  constructor(file: SoundStreamFile) {
    this.file = file;
  }

  /**
   * `S_WAV_CodecReadStream` (`snd_codec_wav.c:277-290`): up to `bytes` more of the data, as many as
   * the data chunk's length leaves. The read's first byte is at the file's `offset` plus `pos` as
   * it was; bytes that length counts past the file's end are not there, and are silence.
   *
   * @returns how many bytes were read
   */
  read(bytes: number): number {
    const remaining = this.file.info.size - this.pos;
    if (remaining <= 0) return 0;
    const read = Math.min(bytes, remaining);
    this.pos += read;
    return read;
  }
}

/** A float stored into an int, as x86-64 stores one: truncated, and `0x80000000` out of range. */
export function toInt(value: number): number {
  return value >= -2147483648 && value < 2147483648 ? Math.trunc(value) : -2147483648;
}

/**
 * `ResampleSfx` (`snd_mem.c:116-163`): a file's samples at the output's rate, each the one before
 * it in the file by an 8.8 fixed-point step, and 8-bit samples made 16. "This is usually 0.5, 1,
 * or 2." A sample read past the data is silence.
 *
 * @param speed - `dma.speed`: the output's rate.
 */
export function resampleSfx({ info, data }: SoundFileData, speed: number): LoadedSound {
  const { channels, width } = info;
  const stepscale = f(f(info.rate) / f(speed));
  const outcount = toInt(f(f(info.samples) / stepscale));
  const fracstep = toInt(f(f(stepscale * 256) * channels));
  const out = new Int16Array(outcount > 0 && channels > 0 ? outcount * channels : 0);

  let srcsample = 0;
  let samplefrac = 0;
  for (let i = 0; i < outcount; i++) {
    srcsample = (srcsample + (samplefrac >> 8)) | 0;
    samplefrac &= 255;
    samplefrac = (samplefrac + fracstep) | 0;
    for (let j = 0; j < channels; j++) {
      const at = srcsample + j;
      let sample = 0;
      if (width === 2) {
        if (at >= 0 && 2 * at + 1 < data.byteLength) {
          sample = ((data[2 * at] | (data[2 * at + 1] << 8)) << 16) >> 16;
        }
      } else if (at >= 0 && at < data.byteLength) {
        sample = (data[at] - 128) << 8;
      }
      out[i * channels + j] = sample;
    }
  }
  return { length: outcount, channels, data: out };
}

/** `COM_GetExtension` (`q_shared.c:83-90`): after the last dot past the last `/`. */
function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && name.lastIndexOf('/') < dot ? name.slice(dot + 1) : '';
}

/** `COM_StripExtension` (`q_shared.c:98-109`) into `MAX_QPATH`. */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  const end = dot >= 0 && name.lastIndexOf('/') < dot ? Math.min(MAX_QPATH, dot + 1) : MAX_QPATH;
  return name.slice(0, end - 1);
}

/**
 * `S_CodecGetSound` (`snd_codec.c:37-116`): the name by the codec its extension names, then, if
 * that fails, without it, by each other codec's.
 *
 * @param verb - `load` for a sound, `open` for a stream, as the warning says.
 * @param codec - The WAV codec's load or open of a file read by a name.
 * @returns what the codec made, or `null` with Quake 3's warning
 */
async function codecGetSound<T>(
  filename: string,
  read: ReadSoundFile,
  print: (text: string) => void,
  verb: 'load' | 'open',
  codec: (bytes: Uint8Array | undefined, name: string) => T | null
): Promise<T | null> {
  let localName = filename.slice(0, MAX_QPATH - 1);
  let orgCodec: string | null = null;

  const ext = getExtension(localName);
  if (ext) {
    const named = CODECS.find((name) => name === ext.toLowerCase());
    if (named) {
      const loaded = codec(await read(localName), localName);
      if (loaded) return loaded;
      // "Loader failed, most likely because the file isn't there; try again without the
      // extension".
      orgCodec = named;
      localName = stripExtension(filename);
    }
  }

  for (const name of CODECS) {
    if (name === orgCodec) continue;
    let altName = `${localName}.${name}`;
    if (altName.length >= MAX_QPATH) {
      // Windows' `Q_vsnprintf` wraps Microsoft's `_vsnprintf`, which cannot say what a cut string
      // needed, and gives the size instead (`q_shared.c:782-800`).
      print(`Com_sprintf: Output length ${MAX_QPATH} too short, require ${MAX_QPATH + 1} bytes.\n`);
      altName = altName.slice(0, MAX_QPATH - 1);
    }
    const loaded = codec(await read(altName), altName);
    if (loaded) return loaded;
  }

  print(`^3WARNING: Failed to ${verb} sound ${filename}!\n`);
  return null;
}

/**
 * `S_CodecLoad` (`snd_codec.c:165-168`): a sound's file read whole.
 *
 * @returns the file read, or `null` with Quake 3's warning
 */
export function codecLoad(
  filename: string,
  read: ReadSoundFile,
  print: (text: string) => void
): Promise<SoundFileData | null> {
  return codecGetSound(filename, read, print, 'load', (bytes, name) =>
    wavCodecLoad(bytes, name, print)
  );
}

/**
 * `S_CodecOpenStream` (`snd_codec.c:175-178`): a file opened to be read a stretch at a time.
 *
 * @returns its header and bytes, or `null` with Quake 3's warning
 */
export function codecOpenStream(
  filename: string,
  read: ReadSoundFile,
  print: (text: string) => void
): Promise<SoundStreamFile | null> {
  return codecGetSound(filename, read, print, 'open', (bytes) => wavCodecOpenStream(bytes, print));
}

/**
 * `S_LoadSound` (`snd_mem.c:215-274`): a sound read by its name and resampled, or `null` for one
 * that will not load.
 *
 * @param speed - `dma.speed`: the output's rate.
 */
export async function loadSound(
  name: string,
  read: ReadSoundFile,
  speed: number,
  print: (text: string) => void
): Promise<LoadedSound | null> {
  const loaded = await codecLoad(name, read, print);
  return loaded ? resampleSfx(loaded, speed) : null;
}
