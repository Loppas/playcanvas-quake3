import { beforeAll, describe, expect, it } from 'vitest';

import { SoundStream, wavCodecOpenStream, type SoundStreamFile } from '../formats/wav';
import { fmtChunk, handWavNames, handWavs, pcmWav, riffWav } from '../formats/wav-test-fixtures';
import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import {
  BackgroundTrack,
  MUSIC_READ,
  musicNames,
  musicReadFrames,
  musicVolume,
  rawSamples,
  type MusicFile,
  type MusicRead
} from './music';
import {
  handMusicKeys,
  handVolumes,
  musicFiles,
  musicKeyCorpus,
  musicStreamCorpus,
  musicVolumeCorpus,
  seededMusicKeys,
  seededVolumes,
  streamCases,
  type MusicCorpus
} from './music-test-fixtures';

/**
 * The twin's corpora, as ioquake3's own code gave them: `CG_StartMusic`, the background track's
 * start and open, `S_Base_RawSamples`, and the codecs' search and the WAV codec's stream, copied
 * and compiled, over what `music-test-fixtures.ts` writes. Each pins its lines and their digest.
 */
const KEYS_HAND: MusicCorpus = { lines: 52, digest: '5d4ce5ac' };
const KEYS_SEEDED: MusicCorpus = { lines: 4453, digest: 'cbe908fc' };
const VOLUMES: MusicCorpus = { lines: 4014, digest: 'df2004e0' };
const STREAMS_HAND: MusicCorpus = { lines: 1222, digest: '8a06c6eb' };
const STREAMS_RETAIL: MusicCorpus = { lines: 656, digest: 'f1e88f5c' };

describe('the music against the twin', () => {
  it("starts each hand key's music as Quake 3 does, saying so", async () => {
    const lines: string[] = [];
    expect(await musicKeyCorpus(handMusicKeys(), musicFiles(), (line) => lines.push(line))).toEqual(
      KEYS_HAND
    );
    // An empty quote is no intro, and stops the music.
    expect(lines).toContain('music stop');
    expect(lines).toContain('said ^3WARNING: music file music/mono.wav is not 22k stereo');
    expect(lines).toContain('said ^1ERROR: Couldn\'t find "fmt" chunk');
    expect(lines).toContain('said ^3WARNING: Failed to open sound music/nofmt.wav!');
    expect(lines).toContain("said ^3WARNING: couldn't open music file music/nofmt.wav");
  });

  it('starts each seeded key as Quake 3 does', async () => {
    expect(await musicKeyCorpus(seededMusicKeys(1, 2000), musicFiles())).toEqual(KEYS_SEEDED);
  });

  it('makes each volume as Quake 3 does', () => {
    const lines: string[] = [];
    const pairs = [...handVolumes(), ...seededVolumes(1, 4000)];
    expect(musicVolumeCorpus(pairs, (line) => lines.push(line))).toEqual(VOLUMES);
    expect(lines).toContain('volume 0.600000 0.891927 137');
  });

  it("reads and copies each hand file's stream at four rates as Quake 3 does", async () => {
    const files = new Map([...handWavs(), ...musicFiles()]);
    const names = [...handWavNames(), ...musicFiles().keys()];
    const cases = streamCases(names, [22050, 44100, 48000, 11025], 1, 12);
    expect(await musicStreamCorpus(cases, files)).toEqual(STREAMS_HAND);
  });
});

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)("the music against the twin, on retail's tracks", () => {
  let corpus: MusicCorpus;
  beforeAll(async () => {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    const names = fs.list('music/', 'wav').sort();
    const files = new Map<string, Uint8Array>();
    for (const name of names) files.set(name, await fs.readRequired(name));
    corpus = await musicStreamCorpus(streamCases(names, [48000], 2, 40), files);
  }, 60_000);

  it('reads the start of every one at 48 kHz as Quake 3 does', () => {
    expect(corpus).toEqual(STREAMS_RETAIL);
  });
});

describe('musicNames', () => {
  it('takes the intro and the loop as two names', () => {
    expect(musicNames('music/fla22k_04_intro.wav music/fla22k_04_loop.wav')).toEqual({
      intro: 'music/fla22k_04_intro.wav',
      loop: 'music/fla22k_04_loop.wav'
    });
  });

  it('loops a lone name, and leaves a third', () => {
    expect(musicNames('music\\sonic5.wav')).toEqual({
      intro: 'music\\sonic5.wav',
      loop: 'music\\sonic5.wav'
    });
    expect(musicNames('a.wav b.wav c.wav')).toEqual({ intro: 'a.wav', loop: 'b.wav' });
  });

  it('has no intro for an empty key, a blank one or a comment, or an empty quote first', () => {
    for (const key of ['', '  \t', '// music/a.wav', '"" music/a.wav']) {
      expect(musicNames(key).intro).toBe('');
    }
  });

  it('reads a quoted name whole, and passes comments between', () => {
    expect(musicNames('"music/a b.wav" /* x */ music/c.wav')).toEqual({
      intro: 'music/a b.wav',
      loop: 'music/c.wav'
    });
  });

  it('cuts each name to MAX_QPATH', () => {
    const { intro, loop } = musicNames(`music/${'x'.repeat(70)} music/${'y'.repeat(70)}`);
    expect(intro).toBe(`music/${'x'.repeat(57)}`);
    expect(loop).toBe(`music/${'y'.repeat(57)}`);
  });
});

describe('musicVolume', () => {
  it("is 51 at the defaults: s_musicvolume's 0.25 of s_volume's 0.8, of 256", () => {
    expect(musicVolume(0.25, 0.8)).toBe(51);
    expect(musicVolume(1, 1)).toBe(256);
  });

  it("is the float product truncated, a unit above the double's at these", () => {
    expect(Math.trunc(256 * 0.6 * 0.891927)).toBe(136);
    expect(musicVolume(0.6, 0.891927)).toBe(137);
    expect(musicVolume(0.6, 0.970052)).toBe(149);
  });

  it('is 0 at either 0, below 0 under it, and 0x80000000 past an int', () => {
    expect(musicVolume(0, 0.8)).toBe(0);
    expect(musicVolume(0.25, 0)).toBe(0);
    expect(musicVolume(0.25, -0.8)).toBe(-51);
    expect(musicVolume(1e9, 1)).toBe(-2147483648);
  });
});

/** A file opened as a stream, which must open. */
function opened(bytes: Uint8Array): SoundStreamFile {
  return wavCodecOpenStream(bytes, () => {})!;
}

/** A read's copy as two plain lists. */
function copied(
  file: SoundStreamFile,
  samples: number,
  speed: number,
  at = file.offset,
  room = 1000
): [number[], number[]] {
  const left = new Int16Array(room);
  const right = new Int16Array(room);
  const frames = rawSamples(file, at, samples, speed, left, right);
  return [[...left.subarray(0, frames)], [...right.subarray(0, frames)]];
}

describe('rawSamples', () => {
  it('doubles each sample of 22 kHz at 44.1 kHz, each ear its own side', () => {
    const file = opened(pcmWav({ channels: 2, samples: [1, -1, 2, -2] }));
    expect(copied(file, 2, 44100)).toEqual([
      [1, 1, 2, 2],
      [-1, -1, -2, -2]
    ]);
  });

  it('puts a mono read in both ears', () => {
    const file = opened(pcmWav({ samples: [5, 6] }));
    expect(copied(file, 2, 22050)).toEqual([
      [5, 6],
      [5, 6]
    ]);
  });

  it('takes an 8-bit stereo read as signed, as Quake 3 does, and a mono one as unsigned', () => {
    const stereo = opened(pcmWav({ channels: 2, bits: 8, samples: [0x80, 0x7f] }));
    expect(copied(stereo, 1, 22050)).toEqual([[-128 * 256], [127 * 256]]);
    const mono = opened(pcmWav({ bits: 8, samples: [0x80, 0x7f] }));
    expect(copied(mono, 2, 22050)).toEqual([
      [0, -256],
      [0, -256]
    ]);
  });

  it('writes nothing for any other width or channels', () => {
    const wide = opened(riffWav([fmtChunk({ bits: 24 }), { name: 'data', bytes: [1, 2, 3] }]));
    expect(copied(wide, 1, 22050)).toEqual([[], []]);
    const three = opened(
      riffWav([fmtChunk({ channels: 3 }), { name: 'data', bytes: [1, 0, 2, 0, 3, 0] }])
    );
    expect(copied(three, 1, 22050)).toEqual([[], []]);
  });

  it('starts the scale again at each read, as Quake 3 copies each read alone', () => {
    // At 22,050 into 48,000 a read of 3 is 7 frames, and of 6 is 14: two reads of 3 are 14 too,
    // but a read of 5 is 11 and of 1 is 3.
    const file = opened(pcmWav({ channels: 2, samples: new Array<number>(12).fill(7) }));
    const frames = (samples: number) => copied(file, samples, 48000)[0].length;
    expect([frames(1), frames(3), frames(5), frames(6)]).toEqual([3, 7, 11, 14]);
  });

  it('reads a byte past the file as 0, as zeroed memory, and writes no more than it holds', () => {
    const file = opened(pcmWav({ channels: 2, samples: [9, 9] }));
    expect(copied(file, 3, 22050)).toEqual([
      [9, 0, 0],
      [9, 0, 0]
    ]);
    // A sample cut in two keeps the byte it has; an unsigned 8-bit 0 is the lowest.
    const files = musicFiles();
    expect(copied(opened(files.get('music/cut.wav')!), 2, 22050)).toEqual([
      [0x0201, 5],
      [0x0403, 0]
    ]);
    expect(copied(opened(files.get('music/cut8.wav')!), 4, 22050)[0]).toEqual([
      72 * 256,
      -28 * 256,
      -78 * 256,
      -128 * 256
    ]);
    // A sample at 8 times its rate is 8 frames, of which 5 fit.
    const left = new Int16Array(5);
    expect(rawSamples(file, file.offset, 1, 22050 * 8, left, new Int16Array(5))).toBe(5);
    expect([...left]).toEqual([9, 9, 9, 9, 9]);
  });
});

/** A track at 22,050 over a sink that keeps what it is told, and what it said. */
function track(speed = 22050) {
  const reads: Array<MusicRead & { from: number; left: number; right: number }> = [];
  const cuts: number[] = [];
  const said: string[] = [];
  const music = new BackgroundTrack(
    speed,
    {
      queue: (read, from, left, right) =>
        reads.push({ ...read, from, left: left[0], right: right[0] }),
      cut: (frame) => cuts.push(frame)
    },
    (text) => said.push(text)
  );
  return { music, reads, cuts, said };
}

/** A stereo file at 22,050 of this many samples, each its place in the file and its negative. */
function musicFile(
  name: string,
  samples: number,
  options: { channels?: number; rate?: number } = {}
): MusicFile {
  const { channels = 2, rate = 22050 } = options;
  const data = Array.from({ length: samples * channels }, (_, i) =>
    channels === 2 ? (i & 1 ? -(i >> 1) : i >> 1) % 32768 : i % 32768
  );
  return { name, file: opened(pcmWav({ channels, rate, samples: data })), said: [] };
}

/** Each read's place on the clock and in its file. */
function spans(reads: readonly MusicRead[]): Array<[string, number, number, number]> {
  return reads.map(({ name, start, frames, pos }) => [name, start, frames, pos]);
}

/**
 * The reads as passes through their files: each pass's file, where it began and its frames, a
 * read from a file's start beginning one. Each read must begin where the last ended.
 */
function passes(reads: readonly MusicRead[]): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  let end: number | null = null;
  for (const { name, start, frames, pos } of reads) {
    if (end !== null && start !== end) throw new Error(`gap at ${end}, the next read at ${start}`);
    end = start + frames;
    if (pos === 0 || out.length === 0) out.push([name, start, frames]);
    else out[out.length - 1][2] += frames;
  }
  return out;
}

describe('BackgroundTrack', () => {
  const SECOND = 22050;
  const READ = Math.round(MUSIC_READ * SECOND);
  const PRESTEP = Math.round(0.05 * SECOND);

  it('queues a read at a time to two seconds ahead, each heard from the painted time', () => {
    const { music, reads } = track();
    music.start(musicFile('music/a.wav', 5 * SECOND), 0);
    music.update(0, 0.25);
    const count = Math.ceil((2 * SECOND) / READ);
    expect(spans(reads)).toEqual(
      Array.from({ length: count }, (_, i) => ['music/a.wav', i * READ, READ, i * READ * 4])
    );
    expect(reads.every(({ from }) => from === PRESTEP)).toBe(true);
    expect([reads[1].left, reads[1].right]).toEqual([READ, -READ]);
    music.update(5, 0.25);
    expect(spans(reads)[count]).toEqual(['music/a.wav', count * READ, READ, count * READ * 4]);
    // Each read's frames come to no more than a buffer holds.
    expect(musicReadFrames(SECOND)).toBeGreaterThanOrEqual(READ + 2);
  });

  it('hands the intro to its loop with no gap, and the loop to itself', () => {
    const { music, reads } = track();
    const intro = musicFile('music/intro.wav', 3 * SECOND + 100);
    const loop = musicFile('music/loop.wav', SECOND + 7);
    music.start(intro, 0);
    music.setLoop(loop);
    for (let clock = 0; clock < 8 * SECOND; clock += 1000) music.update(clock, 0.25);
    expect(passes(reads).slice(0, 5)).toEqual([
      ['music/intro.wav', 0, 3 * SECOND + 100],
      ['music/loop.wav', 3 * SECOND + 100, SECOND + 7],
      ['music/loop.wav', 4 * SECOND + 107, SECOND + 7],
      ['music/loop.wav', 5 * SECOND + 114, SECOND + 7],
      ['music/loop.wav', 6 * SECOND + 121, SECOND + 7]
    ]);
  });

  it('loops a lone name from its start', () => {
    const { music, reads } = track();
    const lone = musicFile('music/lone.wav', SECOND);
    music.start(lone, 0);
    music.setLoop(lone);
    music.update(0, 0.25);
    expect(passes(reads)).toEqual([
      ['music/lone.wav', 0, SECOND],
      ['music/lone.wav', SECOND, SECOND]
    ]);
  });

  it("waits at the intro's end for the loop's read, then follows on with no gap", () => {
    const { music, reads } = track();
    music.start(musicFile('music/intro.wav', SECOND), 0);
    music.update(0, 0.25);
    music.update(100, 0.25);
    expect(passes(reads)).toEqual([['music/intro.wav', 0, SECOND]]);
    expect(music.playing).toBe(true);
    music.setLoop(musicFile('music/loop.wav', 3 * SECOND));
    music.update(200, 0.25);
    expect(passes(reads)[1].slice(0, 2)).toEqual(['music/loop.wav', SECOND]);
  });

  it("says Quake 3's warnings: for a file that won't open, and at each open of one not 22k", () => {
    const { music, reads, said } = track();
    const failed = '^3WARNING: Failed to open sound music/gone.wav!\n';
    const missing = { name: 'music/gone.wav', file: null, said: [failed] };
    music.start(missing, 0);
    music.setLoop(musicFile('music/loop.wav', SECOND));
    music.update(0, 0.25);
    expect(said).toEqual([failed, "^3WARNING: couldn't open music file music/gone.wav\n"]);
    // With no intro the loop is never tried.
    expect(reads).toEqual([]);
    expect(music.playing).toBe(false);

    said.length = 0;
    const mono = musicFile('music/mono.wav', SECOND, { channels: 1 });
    music.start(mono, 0);
    music.setLoop(mono);
    music.update(0, 0.25);
    // At its start, and again as its loop.
    const warning = '^3WARNING: music file music/mono.wav is not 22k stereo\n';
    expect(said).toEqual([warning, warning]);
    expect(passes(reads).map(([, start]) => start)).toEqual([0, SECOND]);
  });

  it('holds its place at 0, cutting the queue at the painted time, and goes on from there', () => {
    const { music, reads, cuts } = track();
    music.start(musicFile('music/a.wav', 10 * SECOND), 0);
    music.update(0, 0.25);
    const read = reads.length;
    music.update(10000, 0);
    const cut = 10000 + PRESTEP;
    expect(cuts).toEqual([cut]);
    // What plays out before the painted time is kept; the read across it goes, and all after.
    expect(music.queued.map(({ start }) => start)).toEqual([READ]);
    music.update(20000, 0);
    music.update(30000, -1);
    expect(reads.length).toBe(read);
    expect(cuts.length).toBe(1);
    expect(music.queued.length).toBe(0);

    music.update(40000, 0.25);
    expect(spans(reads)[read]).toEqual(['music/a.wav', 40000, READ, cut * 4]);
    expect(reads[read].from).toBe(40000 + PRESTEP);
  });

  it('goes back to the intro where a hold cuts it, having read on into the loop', () => {
    const { music, reads } = track();
    music.start(musicFile('music/intro.wav', SECOND), 0);
    music.setLoop(musicFile('music/loop.wav', 5 * SECOND));
    music.update(0, 0.25);
    expect(passes(reads).map(([name]) => name)).toEqual(['music/intro.wav', 'music/loop.wav']);
    const read = reads.length;
    music.update(1000, 0);
    music.update(1000, 0.25);
    const cut = 1000 + PRESTEP;
    expect(spans(reads)[read]).toEqual(['music/intro.wav', cut, READ, cut * 4]);
    expect(passes(reads.slice(read)).slice(0, 2)).toEqual([
      ['music/intro.wav', cut, SECOND - cut],
      ['music/loop.wav', SECOND, passes(reads.slice(read))[1][2]]
    ]);
  });

  it('starts again from the intro at the painted time, what was queued after it cut', () => {
    const { music, reads, cuts } = track();
    const intro = musicFile('music/intro.wav', 5 * SECOND);
    music.start(intro, 0);
    music.update(0, 0.25);
    const read = reads.length;
    music.start(intro, 5000);
    expect(cuts).toEqual([5000 + PRESTEP]);
    music.update(5000, 0.25);
    expect(spans(reads)[read]).toEqual(['music/intro.wav', 5000 + PRESTEP, READ, 0]);
  });

  it('stops at once, and reads no more', () => {
    const { music, reads, cuts } = track();
    music.start(musicFile('music/a.wav', 5 * SECOND), 0);
    music.update(0, 0.25);
    const read = reads.length;
    music.stop();
    expect(cuts).toEqual([-Infinity]);
    music.update(1, 0.25);
    expect(reads.length).toBe(read);
    expect([music.playing, music.rawend, music.queued.length]).toEqual([false, 0, 0]);
  });

  it('ends a loop that plays nothing, which Quake 3 reads again forever', () => {
    const of = (name: string, fmt: Parameters<typeof fmtChunk>[0], data: number[]): MusicFile => ({
      name,
      file: opened(riffWav([fmtChunk(fmt), { name: 'data', bytes: data }])),
      said: [`opened ${name}\n`]
    });
    const empty = of('music/empty.wav', { channels: 2 }, []);
    const wide = of('music/wide.wav', { bits: 24 }, [1, 2, 3]);
    for (const file of [empty, wide]) {
      const { music, reads, said } = track();
      music.start(musicFile('music/intro.wav', SECOND), 0);
      music.setLoop(file);
      music.update(0, 0.25);
      expect(passes(reads)).toEqual([['music/intro.wav', 0, SECOND]]);
      expect(music.playing).toBe(false);
      // Opened once, and ended at its first end.
      expect(said.filter((text) => text.startsWith('opened'))).toEqual([`opened ${file.name}\n`]);
    }
  });

  it('reads nothing of a file at a rate of 0, and waits on', () => {
    const { music, reads } = track();
    music.start(musicFile('music/still.wav', SECOND, { rate: 0 }), 0);
    music.update(0, 0.25);
    expect([reads.length, music.playing]).toEqual([0, true]);
  });

  it('lets a read go from its queue once it is played through', () => {
    const { music } = track();
    music.start(musicFile('music/a.wav', 10 * SECOND), 0);
    music.update(0, 0.25);
    const count = music.queued.length;
    expect(music.queued[0].start).toBe(0);
    music.update(READ - 1, 0.25);
    expect(music.queued[0].start).toBe(0);
    music.update(READ, 0.25);
    expect(music.queued[0].start).toBe(READ);
    expect(music.queued.length).toBe(count);
  });

  it('reads at the rate it plays at, the file being half of it', () => {
    const { music, reads } = track(44100);
    music.start(musicFile('music/a.wav', 5 * SECOND), 0);
    music.update(0, 0.25);
    // A read's 11,025 frames at 44.1 kHz take the file's 5,512, each played twice.
    const samples = Math.floor((Math.round(MUSIC_READ * 44100) * SECOND) / 44100);
    expect(spans(reads).slice(0, 2)).toEqual([
      ['music/a.wav', 0, 2 * samples, 0],
      ['music/a.wav', 2 * samples, 2 * samples, samples * 4]
    ]);
  });
});

describe('SoundStream', () => {
  it("reads to its data's length, and nothing after", () => {
    const stream = new SoundStream(opened(pcmWav({ samples: [1, 2, 3] })));
    expect([stream.read(4), stream.read(4), stream.read(4)]).toEqual([4, 2, 0]);
    expect(stream.pos).toBe(6);
  });
});
