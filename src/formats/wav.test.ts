import { beforeAll, describe, expect, it } from 'vitest';

import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { codecLoad, codecOpenStream, resampleSfx, wavCodecLoad, type SoundFileData } from './wav';
import {
  fmtChunk,
  handWavNames,
  handWavs,
  pcmWav,
  riffWav,
  wavCorpus,
  type WavCorpus
} from './wav-test-fixtures';

/**
 * The twin's corpora, as ioquake3's own reader gave them: `S_CodecGetSound`, the WAV codec and
 * `S_LoadSound`'s `ResampleSfx`, copied and compiled, over the files and names
 * `wav-test-fixtures.ts` writes. Each pins the loads, those that loaded, and a digest of every
 * header, length and sample.
 */
const HAND: WavCorpus = { sounds: 264, loaded: 220, digest: 'a78ab155' };
const RETAIL: WavCorpus = { sounds: 598, loaded: 598, digest: '065b697f' };

describe('the reader against the twin', () => {
  it('reads and resamples each hand case at four rates as Quake 3 does, saying so', async () => {
    const lines: string[] = [];
    const rates = [22050, 44100, 48000, 11025];
    const corpus = await wavCorpus(handWavNames(), handWavs(), rates, (line) => lines.push(line));
    expect(corpus).toEqual(HAND);
    // A stereo file at half the rate steps half a frame, and a 14-byte format reads its bits from
    // the next chunk's name.
    expect(lines).toContain(
      'hand/stereo16-11025.wav 22050 rate 11025 width 2 channels 2 samples 2500 size 10002 ' +
        'length 5000 data 90ec65ab'
    );
    expect(lines).toContain('said ^1ERROR: Incorrect/unsupported format in "hand/fmt14.wav"');
  });
});

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)("the reader against the twin, on retail's sounds", () => {
  let corpus: WavCorpus;
  beforeAll(async () => {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    const names = fs.list('sound/', 'wav').sort();
    const files = new Map<string, Uint8Array>();
    for (const name of names) files.set(name, await fs.readRequired(name));
    corpus = await wavCorpus(names, files, [48000]);
  }, 60_000);

  it('loads every one at 48 kHz as Quake 3 does', () => {
    expect(corpus).toEqual(RETAIL);
  });
});

/** What the reader says, kept. */
function listener(): { said: string[]; print: (text: string) => void } {
  const said: string[] = [];
  return { said, print: (text) => said.push(text) };
}

/** A file's samples at a rate, as a plain list. */
function resampled(bytes: Uint8Array, speed: number): number[] {
  const loaded = wavCodecLoad(bytes, 'test.wav', () => {}) as SoundFileData;
  return [...resampleSfx(loaded, speed).data];
}

describe('wavCodecLoad', () => {
  it("reads a header's channels, rate and width, and the samples its data's size makes", () => {
    const bytes = pcmWav({ channels: 2, rate: 11025, bits: 8, samples: [1, 2, 3, 4, 5, 6, 7] });
    const loaded = wavCodecLoad(bytes, 'test.wav', () => {});
    expect(loaded?.info).toEqual({ rate: 11025, width: 1, channels: 2, size: 7, samples: 3 });
    expect([...(loaded?.data ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('passes any chunk it does not know, before the format or after it, each padded even', () => {
    const bytes = riffWav([
      { name: 'LIST', bytes: [1, 2, 3] },
      fmtChunk({}),
      { name: 'fact', bytes: [9] },
      { name: 'data', bytes: [1, 0, 2, 0] }
    ]);
    expect(wavCodecLoad(bytes, 'test.wav', () => {})?.info.samples).toBe(2);
  });

  it("skips a format's extra bytes, unpadded", () => {
    const bytes = riffWav([fmtChunk({ extra: [0, 0] }), { name: 'data', bytes: [1, 0] }]);
    expect(wavCodecLoad(bytes, 'test.wav', () => {})?.info.samples).toBe(1);
  });

  it('reads the format tag and ignores it, so any data is played as PCM', () => {
    const bytes = riffWav([fmtChunk({ format: 0x55 }), { name: 'data', bytes: [1, 0] }]);
    expect(wavCodecLoad(bytes, 'test.wav', () => {})?.info.samples).toBe(1);
  });

  it('refuses fewer than 8 bits, as an MP3 in a WAV has, saying why', () => {
    const { said, print } = listener();
    const bytes = riffWav([fmtChunk({ format: 0x55, bits: 0 }), { name: 'data', bytes: [1] }]);
    expect(wavCodecLoad(bytes, 'sound/mp3.wav', print)).toBeNull();
    expect(said).toEqual([
      '^1ERROR: Less than 8 bit sound is not supported\n',
      '^1ERROR: Incorrect/unsupported format in "sound/mp3.wav"\n'
    ]);
  });

  it('refuses data before its format, which the search for the format passes', () => {
    const { said, print } = listener();
    const bytes = riffWav([{ name: 'data', bytes: [1, 0] }, fmtChunk({})]);
    expect(wavCodecLoad(bytes, 'test.wav', print)).toBeNull();
    expect(said).toEqual([
      '^1ERROR: Couldn\'t find "data" chunk\n',
      '^1ERROR: Incorrect/unsupported format in "test.wav"\n'
    ]);
  });

  it('refuses a file with no format, and stops at a negative length, saying so', () => {
    const { said, print } = listener();
    const bytes = riffWav([{ name: 'data', bytes: [1, 0] }]);
    expect(wavCodecLoad(bytes, 'test.wav', print)).toBeNull();
    const negative = riffWav([{ name: 'LIST', bytes: [], length: -2 }, fmtChunk({})]);
    expect(wavCodecLoad(negative, 'test.wav', print)).toBeNull();
    expect(said).toEqual([
      '^1ERROR: Couldn\'t find "fmt" chunk\n',
      '^1ERROR: Incorrect/unsupported format in "test.wav"\n',
      '^3WARNING: Negative chunk length\n',
      '^1ERROR: Couldn\'t find "fmt" chunk\n',
      '^1ERROR: Incorrect/unsupported format in "test.wav"\n'
    ]);
  });

  it('refuses a file of no channels, over which Quake 3 divides by zero', () => {
    const { said, print } = listener();
    expect(wavCodecLoad(pcmWav({ channels: 0, samples: [1, 2] }), 'test.wav', print)).toBeNull();
    expect(said).toEqual(['^1ERROR: Incorrect/unsupported format in "test.wav"\n']);
  });

  it('is nothing for a file the paks have not got, and says nothing', () => {
    const { said, print } = listener();
    expect(wavCodecLoad(undefined, 'test.wav', print)).toBeNull();
    expect(said).toEqual([]);
  });
});

describe('resampleSfx', () => {
  const samples = [100, -200, 300, -400, 500, -600];

  it('keeps every sample at its own rate', () => {
    expect(resampled(pcmWav({ rate: 22050, samples }), 22050)).toEqual(samples);
  });

  it('repeats each sample to a higher rate, and drops them to a lower one', () => {
    expect(resampled(pcmWav({ rate: 11025, samples: [1, 2, 3] }), 22050)).toEqual([
      1, 1, 2, 2, 3, 3
    ]);
    expect(resampled(pcmWav({ rate: 44100, samples }), 22050)).toEqual([100, 300, 500]);
  });

  it('makes an 8-bit sample 16, about 128', () => {
    const bytes = pcmWav({ rate: 22050, bits: 8, samples: [0, 128, 255] });
    expect(resampled(bytes, 22050)).toEqual([-32768, 0, 32512]);
  });

  it('steps a stereo file by half a frame at half the rate, swapping its sides each other', () => {
    const bytes = pcmWav({ channels: 2, rate: 11025, samples: [1, -1, 2, -2] });
    expect(resampled(bytes, 22050)).toEqual([1, -1, -1, 2, 2, -2, -2, 0]);
  });

  it('counts the samples out, and steps through them, in floats', () => {
    const loaded = wavCodecLoad(
      pcmWav({ rate: 22050, samples: Array.from({ length: 1000 }, (_, i) => i) }),
      'test.wav',
      () => {}
    ) as SoundFileData;
    const { length, data } = resampleSfx(loaded, 48000);
    // 1,000 over a step of 0.459375 rounded to a float; each step 117/256 of a sample, short of
    // 0.459375, so the last few are never reached.
    expect(length).toBe(2176);
    expect(data[2175]).toBe(Math.floor((2175 * 117) / 256));
    // A step's float where doubles count one more.
    const slow = wavCodecLoad(handWavs().get('hand/mono16-4500.wav'), 'test.wav', () => {});
    expect(resampleSfx(slow as SoundFileData, 22050).length).toBe(489999);
  });
});

describe('codecLoad', () => {
  /** Paks holding these files, and the names read from them in order. */
  const paks = (files: Record<string, Uint8Array>) => {
    const asked: string[] = [];
    const read = (path: string) => {
      asked.push(path);
      return Promise.resolve(files[path]);
    };
    return { asked, read };
  };
  const one = pcmWav({ samples: [1] });

  it('finds a name with no extension as a WAV', async () => {
    const { asked, read } = paks({ 'sound/world/drone.wav': one });
    const loaded = await codecLoad('sound/world/drone', read, () => {});
    expect(loaded?.info.samples).toBe(1);
    expect(asked).toEqual(['sound/world/drone.wav']);
  });

  it('says a WAV it cannot load failed, having tried no other codec', async () => {
    const { asked, read } = paks({});
    const { said, print } = listener();
    expect(await codecLoad('sound/world/waterfall.wav', read, print)).toBeNull();
    expect(asked).toEqual(['sound/world/waterfall.wav']);
    expect(said).toEqual(['^3WARNING: Failed to load sound sound/world/waterfall.wav!\n']);
  });

  it('tries a name whose extension no codec reads with the WAV codec\'s after it', async () => {
    const { asked, read } = paks({ 'music/track.ogg.wav': one });
    expect((await codecLoad('music/track.ogg', read, () => {}))?.info.samples).toBe(1);
    expect(asked).toEqual(['music/track.ogg.wav']);
  });

  it('cuts a name made too long for MAX_QPATH, and says so', async () => {
    const { asked, read } = paks({});
    const { said, print } = listener();
    const name = `sound/${'x'.repeat(54)}`;
    await codecLoad(name, read, print);
    expect(asked).toEqual([`${name}.wa`]);
    expect(said[0]).toBe('Com_sprintf: Output length 64 too short, require 65 bytes.\n');
  });

  it('opens a stream by the same search, its data where the header left off', async () => {
    const bytes = riffWav([
      { name: 'LIST', bytes: [1, 2, 3] },
      fmtChunk({ channels: 2 }),
      { name: 'data', bytes: [1, 0, 2, 0] }
    ]);
    const { asked, read } = paks({ 'music/track.wav': bytes });
    const file = await codecOpenStream('music/track', read, () => {});
    expect(asked).toEqual(['music/track.wav']);
    expect(file?.info).toMatchObject({ channels: 2, samples: 1, size: 4 });
    expect([...file!.bytes.subarray(file!.offset, file!.offset + 4)]).toEqual([1, 0, 2, 0]);
  });

  it("says a stream would not open, with the reader's error and none of the format's", async () => {
    const nofmt = riffWav([{ name: 'data', bytes: [1, 0] }]);
    const { read } = paks({ 'music/nofmt.wav': nofmt });
    const { said, print } = listener();
    expect(await codecOpenStream('music/nofmt.wav', read, print)).toBeNull();
    expect(said).toEqual([
      '^1ERROR: Couldn\'t find "fmt" chunk\n',
      '^3WARNING: Failed to open sound music/nofmt.wav!\n'
    ]);
  });

  it("says a cut name needed a byte more than it has, as Windows' _vsnprintf says", async () => {
    const { asked, read } = paks({});
    const { said, print } = listener();
    // 63 of it kept, 67 with the extension, and cut back to the 63.
    await codecLoad(`sound/${'x'.repeat(70)}`, read, print);
    expect(asked).toEqual([`sound/${'x'.repeat(57)}`]);
    expect(said[0]).toBe('Com_sprintf: Output length 64 too short, require 65 bytes.\n');
  });
});
