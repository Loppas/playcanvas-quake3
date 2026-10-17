import { normalizePakPath } from '../pak/zip';
import { Digest } from '../sim/cm/collision-test-fixtures';
import { codecLoad, resampleSfx } from './wav';

/**
 * WAV files for tests, built byte by byte: a RIFF header, then chunks, each padded to an even
 * length as RIFF pads them. And the reader's corpus: sounds loaded at output rates by the port's
 * reader and digested as the twin, ioquake3's own reader compiled, digests them.
 */

/** A chunk: its four-character name and its bytes. */
export interface WavChunk {
  name: string;
  bytes: readonly number[] | Uint8Array;
  /** The length its header gives, where that is not its bytes'. */
  length?: number;
}

/** A little-endian integer of `size` bytes. */
function le(value: number, size: number): number[] {
  return Array.from({ length: size }, (_, i) => (value >>> (8 * i)) & 0xff);
}

/** A four-character name's bytes. */
function fourcc(name: string): number[] {
  return [...name].map((c) => c.charCodeAt(0));
}

/** A `fmt ` chunk's sixteen bytes, and any more. */
export function fmtChunk(options: {
  format?: number;
  channels?: number;
  rate?: number;
  bits?: number;
  extra?: readonly number[];
}): WavChunk {
  const { format = 1, channels = 1, rate = 22050, bits = 16, extra = [] } = options;
  const blockAlign = (channels * bits) >> 3;
  return {
    name: 'fmt ',
    bytes: [
      ...le(format, 2),
      ...le(channels, 2),
      ...le(rate, 4),
      ...le(rate * blockAlign, 4),
      ...le(blockAlign, 2),
      ...le(bits, 2),
      ...extra
    ]
  };
}

/** A file of these chunks, in this order. */
export function riffWav(chunks: readonly WavChunk[]): Uint8Array {
  let body: number[] = fourcc('WAVE');
  for (const { name, bytes, length } of chunks) {
    body = body.concat(fourcc(name), le(length ?? bytes.length, 4), Array.from(bytes));
    if (bytes.length & 1) body.push(0);
  }
  return new Uint8Array(fourcc('RIFF').concat(le(body.length, 4), body));
}

/** A PCM file: 16-bit samples, or 8-bit bytes, interleaved by channel. */
export function pcmWav(options: {
  channels?: number;
  rate?: number;
  bits?: 8 | 16;
  samples: readonly number[];
}): Uint8Array {
  const { channels = 1, rate = 22050, bits = 16, samples } = options;
  const data = bits === 16 ? samples.flatMap((sample) => le(sample & 0xffff, 2)) : [...samples];
  return riffWav([fmtChunk({ channels, rate, bits }), { name: 'data', bytes: data }]);
}

/**
 * A second of a 16-bit mono sound at 48 kHz whose first sample is `mark`: what a sound looks like
 * to a test that only needs to know which one it is, at a context of that rate.
 */
export function markedWav(mark: number): Uint8Array {
  const samples = new Array<number>(48000).fill(0);
  samples[0] = mark;
  return pcmWav({ rate: 48000, samples });
}

/** `n` samples that wander over the whole range, seeded by `step`. */
function wander(n: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => ((i * step) % 65536) - 32768);
}

/** A file with its header's fields as given, and this data. */
function headed(fmt: Parameters<typeof fmtChunk>[0], data: readonly number[]): Uint8Array {
  return riffWav([fmtChunk(fmt), { name: 'data', bytes: data }]);
}

/**
 * The hand cases, by the names they are read by: every rate and width the install has and some it
 * has not, chunks in each order, each refusal, and the codecs' search for a name.
 */
export function handWavs(): Map<string, Uint8Array> {
  const pcm = wander(5001, 977).flatMap((sample) => [sample & 0xff, (sample >> 8) & 0xff]);
  const bytes = wander(3001, 331).map((sample) => (sample >> 8) & 0xff);
  const files = new Map<string, Uint8Array>();
  for (const rate of [22050, 11025, 44100, 48000, 96000, 8000, 8012, 11000, 16000, 5000]) {
    files.set(`hand/mono16-${rate}.wav`, headed({ rate }, pcm));
    files.set(`hand/mono8-${rate}.wav`, headed({ rate, bits: 8 }, bytes));
    files.set(`hand/stereo16-${rate}.wav`, headed({ rate, channels: 2 }, pcm));
  }
  // 100,000 samples at 4,500 Hz read at 22,050 are 489,999 in floats and 490,000 in doubles.
  const long = wander(100000, 7919).flatMap((sample) => [sample & 0xff, (sample >> 8) & 0xff]);
  files.set('hand/mono16-4500.wav', headed({ rate: 4500 }, long));
  files.set('hand/stereo8.wav', headed({ channels: 2, bits: 8 }, bytes));
  files.set('hand/channels3.wav', headed({ channels: 3 }, pcm));
  files.set('hand/channels-negative.wav', headed({ channels: 0xffff }, pcm));
  files.set('hand/bits24.wav', headed({ bits: 24 }, pcm));
  files.set('hand/bits12.wav', headed({ bits: 12 }, pcm));
  files.set('hand/format-float.wav', headed({ format: 3, bits: 32 }, pcm));
  files.set('hand/format-mp3.wav', headed({ format: 0x55, bits: 0 }, pcm));
  files.set('hand/format-adpcm.wav', headed({ format: 2, bits: 4 }, pcm));
  files.set('hand/rate0.wav', headed({ rate: 0 }, pcm));
  files.set('hand/rate-negative.wav', headed({ rate: -22050 }, pcm));
  files.set('hand/odd-data.wav', headed({}, pcm.slice(0, 101)));
  files.set('hand/empty-data.wav', headed({}, []));
  const data = { name: 'data', bytes: pcm };
  const list = { name: 'LIST', bytes: [1, 2, 3] };
  files.set('hand/list-first.wav', riffWav([list, fmtChunk({}), data]));
  files.set('hand/fmt18.wav', riffWav([fmtChunk({ extra: [0, 0] }), data]));
  files.set('hand/fmt17.wav', riffWav([fmtChunk({ extra: [0] }), data]));
  // The reader takes 16 bytes of a format of 14, its bits the next chunk's name.
  const fmt14 = { name: 'fmt ', bytes: fmtChunk({}).bytes.slice(0, 14) };
  files.set('hand/fmt14.wav', riffWav([fmt14, { name: 'data', bytes: [1, 0, 2, 0] }]));
  files.set('hand/data-first.wav', riffWav([data, fmtChunk({})]));
  files.set('hand/no-data.wav', riffWav([fmtChunk({})]));
  files.set('hand/no-fmt.wav', riffWav([data]));
  files.set('hand/negative.wav', riffWav([{ name: 'LIST', bytes: [], length: -2 }, data]));
  files.set('hand/past-end.wav', riffWav([fmtChunk({}), { ...data, length: 1 << 20 }]));
  files.set('hand/huge.wav', riffWav([{ name: 'JUNK', bytes: [], length: 0x7fffffff }]));
  files.set('hand/nul-name.wav', riffWav([fmtChunk({}), { name: 'da\0a', bytes: [1, 0] }, data]));
  // Cut in its data chunk's name: no field is read short.
  files.set('hand/short.wav', headed({}, pcm).slice(0, 38));
  files.set('hand/noext.wav', headed({}, pcm));
  files.set('hand/track.ogg.wav', headed({}, pcm));
  files.set('hand/backslash.wav', headed({}, pcm));
  files.set('hand/upper.wav', headed({}, pcm));
  files.set('hand/dir.v2/noext.wav', headed({}, pcm));
  files.set(`hand/${'x'.repeat(55)}.wa`, headed({}, pcm));
  return files;
}

/** The names the hand cases are read by: each file's, and the codecs' search's own. */
export function handWavNames(): string[] {
  return [
    ...handWavs().keys(),
    'hand/noext',
    'hand/missing.wav',
    'hand/track.ogg',
    'hand\\backslash.wav',
    'HAND/UPPER.WAV',
    'hand/dir.v2/noext',
    `hand/${'x'.repeat(55)}`
  ].filter((name) => name !== 'hand/track.ogg.wav' && !name.endsWith('.wa'));
}

/** What a corpus came to: its loads, those that loaded, and their digest. */
export interface WavCorpus {
  sounds: number;
  loaded: number;
  digest: string;
}

/**
 * Load each name at each output rate through the port's reader, as `S_LoadSound` does: what each
 * said and came to, as the twin prints it, and a digest of every header, length and sample.
 *
 * @param files - The paks, by normalized name.
 * @param print - Told each line the twin prints, or nothing for a large corpus.
 */
export async function wavCorpus(
  names: readonly string[],
  files: ReadonlyMap<string, Uint8Array>,
  speeds: readonly number[],
  print?: (line: string) => void
): Promise<WavCorpus> {
  const read = (path: string) => Promise.resolve(files.get(normalizePakPath(path)));
  const digest = new Digest();
  let sounds = 0;
  let loaded = 0;
  for (const speed of speeds) {
    for (const name of names) {
      sounds++;
      const said = (text: string) => print?.(`said ${text.replace(/\n$/, '')}`);
      const file = await codecLoad(name, read, said);
      if (!file) {
        digest.int(0);
        print?.(`${name} ${speed} fail`);
        continue;
      }
      loaded++;
      const { rate, width, channels, samples, size } = file.info;
      const sound = resampleSfx(file, speed);
      digest.int(1).int(rate).int(width).int(channels).int(samples).int(size).int(sound.length);
      const data = new Uint8Array(sound.data.buffer, 0, sound.data.byteLength);
      const samplesDigest = new Digest().uint8s(data, 0, data.byteLength).hex();
      digest.uint8s(data, 0, data.byteLength);
      print?.(
        `${name} ${speed} rate ${rate} width ${width} channels ${channels} samples ${samples} ` +
          `size ${size} length ${sound.length} data ${samplesDigest}`
      );
    }
  }
  return { sounds, loaded, digest: digest.hex() };
}
