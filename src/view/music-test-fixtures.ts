import { codecOpenStream, SoundStream } from '../formats/wav';
import { fmtChunk, pcmWav, riffWav, type WavChunk } from '../formats/wav-test-fixtures';
import { normalizePakPath } from '../pak/zip';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { BackgroundTrack, musicNames, musicVolume, rawSamples, type MusicSink } from './music';

/**
 * The music's corpora, run through the port and digested as the twin, ioquake3's own code
 * compiled, digests them:
 * - `CS_MUSIC` strings, each read by `CG_StartMusic` and started as `S_Base_StartBackgroundTrack`
 *   starts it, its intro opened;
 * - `s_musicvolume` and `s_volume` as cvar strings, and the volume `S_Base_RawSamples` makes;
 * - files opened as streams and read a stretch at a time, each read copied by `S_Base_RawSamples`
 *   at an output's rate under a volume.
 *
 * Each corpus is lines, as the twin prints them, and a digest of their bytes.
 */

/** What a corpus came to: its lines, and their digest. */
export interface MusicCorpus {
  lines: number;
  digest: string;
}

/** Lines as the twin prints them, each digested as its bytes and a newline. */
class Lines {
  count = 0;
  private readonly digest = new Digest();
  private readonly print?: (line: string) => void;
  private readonly bytes = new Uint8Array(1);

  constructor(print?: (line: string) => void) {
    this.print = print;
  }

  line(text: string): void {
    this.count++;
    for (let i = 0; i <= text.length; i++) {
      this.bytes[0] = i < text.length ? text.charCodeAt(i) : 10;
      this.digest.uint8s(this.bytes, 0, 1);
    }
    this.print?.(text);
  }

  /** What Quake 3 printed, as the twin's `Com_Printf` prints it. */
  said(text: string): void {
    this.line(`said ${text.replace(/\n$/, '')}`);
  }

  corpus(): MusicCorpus {
    return { lines: this.count, digest: this.digest.hex() };
  }
}

/** A draw from 0 to n − 1, from the generator's high bits. */
function pick(random: Seeded, n: number): number {
  return (random.next() >>> 8) % n;
}

/** Paks of these files, by their normalized names. */
function reader(files: ReadonlyMap<string, Uint8Array>) {
  return (path: string) => Promise.resolve(files.get(normalizePakPath(path)));
}

/** A sink that plays nothing. */
const SILENT: MusicSink = { queue: () => {}, cut: () => {} };

/** `n` 16-bit samples that wander over the whole range, seeded by `step`. */
function wander(n: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => ((i * step) % 65536) - 32768);
}

/** A file whose data chunk counts 4,096 bytes and holds these, an odd count with no pad after. */
function cut(fmt: WavChunk, bytes: number[]): Uint8Array {
  const whole = riffWav([fmt, { name: 'data', bytes, length: 4096 }]);
  return bytes.length & 1 ? whole.slice(0, -1) : whole;
}

/**
 * The music files the hand cases name: stereo at 22 kHz, and each kind Quake 3 warns of or
 * refuses, or reads past.
 */
export function musicFiles(): Map<string, Uint8Array> {
  const stereo = (step: number) => pcmWav({ channels: 2, samples: wander(4000, step) });
  const files = new Map<string, Uint8Array>([
    ['music/intro.wav', stereo(977)],
    ['music/loop.wav', stereo(331)],
    ['music/noext.wav', stereo(7919)],
    ['music/two words.wav', stereo(13)],
    ['music/mono.wav', pcmWav({ samples: wander(3000, 101) })],
    ['music/rate.wav', pcmWav({ channels: 2, rate: 44100, samples: wander(3000, 211) })],
    [
      'music/bits8.wav',
      pcmWav({ channels: 2, bits: 8, samples: wander(3000, 59).map((s) => (s >> 8) & 0xff) })
    ],
    ['music/nofmt.wav', riffWav([{ name: 'data', bytes: [1, 0, 2, 0] }])],
    ['music/nodata.wav', riffWav([fmtChunk({ channels: 2 })])],
    // Cut short, mid-sample: data chunks that count bytes past the file's end, unpadded.
    ['music/cut.wav', cut(fmtChunk({ channels: 2 }), [1, 2, 3, 4, 5])],
    ['music/cut8.wav', cut(fmtChunk({ bits: 8 }), [200, 100, 50])]
  ]);
  return new Map([...files].map(([name, bytes]) => [normalizePakPath(name), bytes]));
}

/** `CS_MUSIC` strings for the edges: none, one, two, three, quoted, commented, cut and missing. */
export function handMusicKeys(): string[] {
  return [
    '',
    '   ',
    'music/intro.wav music/loop.wav',
    'music/loop.wav',
    'music\\loop.wav',
    'MUSIC/LOOP.WAV',
    'music/noext',
    'music/missing.wav',
    'music/mono.wav',
    'music/rate.wav',
    'music/bits8.wav',
    'music/nofmt.wav',
    'music/nodata.wav',
    '"music/two words.wav" music/loop.wav',
    'music/intro.wav music/loop.wav music/third.wav',
    '// all a comment',
    '/* a comment */ music/intro.wav',
    'music/intro.wav // a comment\n music/loop.wav',
    'music/intro.wav//no comment',
    '"" music/loop.wav',
    `music/${'x'.repeat(70)}.wav music/loop.wav`,
    `music/intro.wav music/${'y'.repeat(70)}`,
    '"music/intro.wav'
  ];
}

const KEY_NAMES = [
  'music/intro.wav',
  'music/loop.wav',
  'music\\loop.wav',
  'music/noext',
  'music/missing.wav',
  'music/mono.wav',
  'music/rate.wav',
  'music/nofmt.wav',
  `music/${'z'.repeat(60)}`,
  '"music/intro.wav"',
  '"music/two words.wav"',
  '""',
  '"open.wav',
  'music/loop.wav//x',
  'a"b'
];
const KEY_SPACES = [
  ' ',
  '  ',
  '\t',
  '\n',
  ' // a comment\n',
  ' /* a comment */ ',
  '/* open',
  '\r\n'
];

/** `CS_MUSIC` strings drawn from names and the spaces between them, comments among them. */
export function seededMusicKeys(seed: number, count: number): string[] {
  const random = new Seeded(seed);
  return Array.from({ length: count }, () => {
    let key = pick(random, 4) === 0 ? KEY_SPACES[pick(random, KEY_SPACES.length)] : '';
    const tokens = pick(random, 4);
    for (let i = 0; i < tokens; i++) {
      if (i > 0) key += KEY_SPACES[pick(random, KEY_SPACES.length)];
      key += KEY_NAMES[pick(random, KEY_NAMES.length)];
    }
    if (pick(random, 4) === 0) key += KEY_SPACES[pick(random, KEY_SPACES.length)];
    return key;
  });
}

/**
 * Start the music each `CS_MUSIC` names, as `CG_StartMusic` and `S_Base_StartBackgroundTrack` do:
 * what opening its intro said, then `music <intro>|<loop>` and the stream's header, or
 * `music stop`.
 *
 * @param files - The paks, by normalized name.
 * @param print - Told each line, or nothing for a large corpus.
 */
export async function musicKeyCorpus(
  keys: readonly string[],
  files: ReadonlyMap<string, Uint8Array>,
  print?: (line: string) => void
): Promise<MusicCorpus> {
  const lines = new Lines(print);
  const read = reader(files);
  for (const key of keys) {
    const { intro, loop } = musicNames(key);
    if (!intro) {
      lines.line('music stop');
      continue;
    }
    const said: string[] = [];
    const file = await codecOpenStream(intro, read, (text) => said.push(text));
    new BackgroundTrack(22050, SILENT, (text) => lines.said(text)).start(
      { name: intro, file, said },
      0
    );
    lines.line(`music ${intro}|${loop}`);
    if (file) {
      const { rate, width, channels, samples, size } = file.info;
      lines.line(
        `stream rate ${rate} width ${width} channels ${channels} samples ${samples} size ${size}`
      );
    }
  }
  return lines.corpus();
}

/** Each volume's pair: `s_musicvolume`, then `s_volume`, as cvar strings. */
export type VolumeCase = readonly [string, string];

/**
 * The hand pairs: the defaults, the ends, and two found by search over a slider's tenths against
 * `%f` values, where the product in floats truncates a unit above the product in doubles.
 */
export function handVolumes(): VolumeCase[] {
  return [
    ['0.25', '0.8'],
    ['1', '1'],
    ['0', '0.8'],
    ['0.25', '0'],
    ['-0.5', '0.8'],
    ['0.25', '-0.8'],
    ['10', '10'],
    ['1e9', '1'],
    ['-1e9', '1'],
    ['1e39', '1'],
    ['0.000001', '1'],
    ['0.162500', '0.700000'],
    // 137 in floats, 136 in doubles; 149 and 148.
    ['0.600000', '0.891927'],
    ['0.600000', '0.970052']
  ];
}

/** Pairs of cvar strings as the sliders and the console write them. */
export function seededVolumes(seed: number, count: number): VolumeCase[] {
  const random = new Seeded(seed);
  const value = (): string => {
    switch (pick(random, 4)) {
      case 0:
        return `${pick(random, 11) / 10}`;
      case 1:
        return (pick(random, 1000001) / 1000000).toFixed(6);
      case 2:
        return (pick(random, 3000001) / 1000000 - 1).toFixed(6);
      default:
        return `${pick(random, 1001) / 100}`;
    }
  };
  return Array.from({ length: count }, () => [value(), value()] as const);
}

/** A cvar's value: `atof` of its string, which the port's settings parse alike. */
function cvarValue(text: string): number {
  return Number.parseFloat(text);
}

/** `volume <s_musicvolume> <s_volume> <volume>` for each pair. */
export function musicVolumeCorpus(
  pairs: readonly VolumeCase[],
  print?: (line: string) => void
): MusicCorpus {
  const lines = new Lines(print);
  for (const [music, volume] of pairs) {
    lines.line(`volume ${music} ${volume} ${musicVolume(cvarValue(music), cvarValue(volume))}`);
  }
  return lines.corpus();
}

/** A stream's case: a file opened at an output's rate, under a volume, and its reads. */
export interface StreamCase {
  speed: number;
  name: string;
  volume: VolumeCase;
  /** Each read's size, in thousandths of the most a read can be, until the data's end. */
  reads: readonly number[];
}

/** The most frames a stream's case reads at once: inside the twin's 16,384 raw samples. */
const MOST_FRAMES = 16000;

/** Cases of every name at every rate, each with seeded reads and one of a few volumes. */
export function streamCases(
  names: readonly string[],
  speeds: readonly number[],
  seed: number,
  reads: number
): StreamCase[] {
  const random = new Seeded(seed);
  const volumes: VolumeCase[] = [
    ['0.25', '0.8'],
    ['1', '1'],
    ['0.5', '0.333333'],
    ['3', '2']
  ];
  return speeds.flatMap((speed) =>
    names.map((name) => ({
      speed,
      name,
      volume: volumes[pick(random, volumes.length)],
      reads: Array.from({ length: reads }, () =>
        pick(random, 3) === 0 ? 1000 : 1 + pick(random, 1000)
      )
    }))
  );
}

/**
 * Open each case's file as a stream and read it a stretch at a time, copying each read as
 * `S_Base_RawSamples` does at the case's rate: what opening it said, its header, and each read's
 * bytes asked and got, frames written and a digest of each ear's samples × the volume, as Quake 3
 * stores them.
 *
 * @param files - The paks, by normalized name.
 * @param print - Told each line, or nothing for a large corpus.
 */
export async function musicStreamCorpus(
  cases: readonly StreamCase[],
  files: ReadonlyMap<string, Uint8Array>,
  print?: (line: string) => void
): Promise<MusicCorpus> {
  const lines = new Lines(print);
  const read = reader(files);
  const left = new Int16Array(MOST_FRAMES + 400);
  const right = new Int16Array(MOST_FRAMES + 400);
  const product = new Int32Array(2);
  const productBytes = new Uint8Array(product.buffer);
  for (const { speed, name, volume, reads } of cases) {
    const file = await codecOpenStream(name, read, (text) => lines.said(text));
    if (!file) {
      lines.line(`stream ${name} ${speed} fail`);
      continue;
    }
    const { rate, width, channels, samples, size } = file.info;
    const intVolume = musicVolume(cvarValue(volume[0]), cvarValue(volume[1]));
    lines.line(
      `stream ${name} ${speed} rate ${rate} width ${width} channels ${channels} ` +
        `samples ${samples} size ${size} volume ${intVolume}`
    );
    const sampleBytes = width * channels;
    const most = Math.trunc((MOST_FRAMES * rate) / speed) * sampleBytes;
    const stream = new SoundStream(file);
    for (const thousandths of reads) {
      const bytes = Math.max(1, Math.trunc((most * thousandths) / 1000));
      const pos = stream.pos;
      const got = stream.read(bytes);
      if (got <= 0) {
        lines.line(`read ${bytes} end`);
        break;
      }
      const fileSamples = Math.trunc(got / sampleBytes);
      // A rate of 0 or below reads every frame from the first sample, without end.
      if (rate <= 0 && fileSamples > 0) {
        lines.line(`read ${bytes} got ${got} skip`);
        continue;
      }
      const frames = rawSamples(file, file.offset + pos, fileSamples, speed, left, right);
      const data = new Digest();
      for (let i = 0; i < frames; i++) {
        product[0] = Math.imul(left[i], intVolume);
        product[1] = Math.imul(right[i], intVolume);
        data.uint8s(productBytes, 0, 8);
      }
      lines.line(`read ${bytes} got ${got} frames ${frames} data ${data.hex()}`);
    }
  }
  return lines.corpus();
}
