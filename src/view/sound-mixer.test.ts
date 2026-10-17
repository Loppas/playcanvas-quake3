import { beforeAll, describe, expect, it } from 'vitest';

import { bspEntityText } from '../formats/bsp';
import { readEntities } from '../formats/entity-text';
import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { vec3 } from '../sim/vec3';
import { CHAN, SoundMixer, sndVol } from './sound-mixer';
import {
  censusScript,
  handScripts,
  mixerCorpus,
  seededScript,
  type MixerCorpus
} from './sound-mixer-test-fixtures';

/**
 * The twin's corpora, as ioquake3's own `snd_dma.c` gave them: `S_SpatializeOrigin`, the channel
 * scan, the loops' add and clear functions and their merge, copied and compiled, over the corpora
 * `sound-mixer-test-fixtures.ts` writes. Each pins the steps, the channels playing summed over
 * them, the loop channels summed over the respatializes, and a digest of every step's channels and
 * every merge's.
 */
const SEEDED: Record<number, MixerCorpus> = {
  1: { steps: 23623, playing: 1833377, loops: 5587, digest: 'f1e3199f' },
  2: { steps: 22112, playing: 1820777, loops: 5966, digest: '875337bd' },
  3: { steps: 22437, playing: 1775593, loops: 5895, digest: '7b8a91ae' },
  4: { steps: 22559, playing: 1848540, loops: 5654, digest: '8ea92b62' }
};

/** Each retail map's looped speakers, heard from 48 places near them and from its spawn spots. */
const CENSUS: Record<string, MixerCorpus> = {
  'pro-q3dm13': { steps: 1024, playing: 0, loops: 231, digest: '26b4d33d' },
  'pro-q3dm6': { steps: 20, playing: 0, loops: 0, digest: '4b5c6de5' },
  'pro-q3tourney2': { steps: 992, playing: 0, loops: 240, digest: 'bd970876' },
  'pro-q3tourney4': { steps: 300, playing: 0, loops: 118, digest: 'e2cb8623' },
  q3ctf1: { steps: 1920, playing: 0, loops: 109, digest: '64f869ea' },
  q3ctf2: { steps: 1512, playing: 0, loops: 175, digest: '0e48a5aa' },
  q3ctf3: { steps: 4100, playing: 0, loops: 50, digest: '22fe82ba' },
  q3ctf4: { steps: 20, playing: 0, loops: 0, digest: '4b5c6de5' },
  q3dm0: { steps: 424, playing: 0, loops: 194, digest: '2700cf01' },
  q3dm1: { steps: 540, playing: 0, loops: 54, digest: '3e954164' },
  q3dm10: { steps: 495, playing: 0, loops: 110, digest: '71db5e31' },
  q3dm11: { steps: 910, playing: 0, loops: 87, digest: '4feef1f5' },
  q3dm12: { steps: 544, playing: 0, loops: 65, digest: '80887fff' },
  q3dm13: { steps: 1300, playing: 0, loops: 231, digest: '17a15195' },
  q3dm14: { steps: 1340, playing: 0, loops: 123, digest: 'd80404be' },
  q3dm15: { steps: 396, playing: 0, loops: 64, digest: 'c7193345' },
  q3dm16: { steps: 1120, playing: 0, loops: 56, digest: '613651a5' },
  q3dm17: { steps: 708, playing: 0, loops: 136, digest: '8f8bc7ee' },
  q3dm18: { steps: 689, playing: 0, loops: 53, digest: '8a8943ea' },
  q3dm19: { steps: 12, playing: 0, loops: 0, digest: '761962a5' },
  q3dm2: { steps: 504, playing: 0, loops: 106, digest: '48137db8' },
  q3dm3: { steps: 456, playing: 0, loops: 171, digest: 'eb5cc204' },
  q3dm4: { steps: 2420, playing: 0, loops: 185, digest: 'cd38a054' },
  q3dm5: { steps: 336, playing: 0, loops: 108, digest: 'e695682c' },
  q3dm6: { steps: 20, playing: 0, loops: 0, digest: '4b5c6de5' },
  q3dm7: { steps: 1364, playing: 0, loops: 136, digest: '7c493682' },
  q3dm8: { steps: 1200, playing: 0, loops: 178, digest: 'c5555a79' },
  q3dm9: { steps: 649, playing: 0, loops: 69, digest: '922028d1' },
  q3tourney1: { steps: 3348, playing: 0, loops: 338, digest: '4335c09d' },
  q3tourney2: { steps: 1064, playing: 0, loops: 229, digest: '791399c7' },
  q3tourney3: { steps: 342, playing: 0, loops: 57, digest: 'a5b5a383' },
  q3tourney4: { steps: 285, playing: 0, loops: 112, digest: 'f8cfca83' },
  q3tourney5: { steps: 513, playing: 0, loops: 57, digest: '59fe3536' },
  q3tourney6: { steps: 336, playing: 0, loops: 112, digest: '951ebca1' },
  q3tourney6_ctf: { steps: 294, playing: 0, loops: 97, digest: 'c0fefac3' },
  test_bigbox: { steps: 0, playing: 0, loops: 0, digest: '811c9dc5' }
};

/** A hand case run through the port's mixer: what it printed, and its corpus. */
function hand(name: string): { printed: string[]; corpus: MixerCorpus } {
  const printed: string[] = [];
  const corpus = mixerCorpus(handScripts()[name], (line) => printed.push(line));
  return { printed, corpus };
}

describe('the mixer against the twin, by hand', () => {
  it('fades and pans each sound by its distance and side as S_SpatializeOrigin does', () => {
    const { printed, corpus } = hand('distances');
    expect(printed).toEqual([
      // The local sound, full in both ears; then the one-shots at 1,330, 1,320, 1,316, 1,310,
      // 1,302, 81, 80 and 79 units ahead.
      'ch 87 sfx 30 ent 3 chan 6 alloc 1000 left 127 right 127 full 1',
      'ch 88 sfx 23 ent 1022 chan 0 alloc 1000 left 0 right 0 full 0',
      'ch 89 sfx 22 ent 1022 chan 0 alloc 1000 left 0 right 0 full 0',
      'ch 90 sfx 21 ent 1022 chan 0 alloc 1000 left 0 right 0 full 0',
      'ch 91 sfx 20 ent 1022 chan 0 alloc 1000 left 1 right 1 full 0',
      'ch 92 sfx 19 ent 1022 chan 0 alloc 1000 left 1 right 1 full 0',
      'ch 93 sfx 18 ent 1022 chan 0 alloc 1000 left 63 right 63 full 0',
      'ch 94 sfx 17 ent 1022 chan 0 alloc 1000 left 63 right 63 full 0',
      'ch 95 sfx 16 ent 1022 chan 0 alloc 1000 left 63 right 63 full 0',
      // The loops at 127, from 79 units to 1,310: those at 1,316 and on are silent, and merge
      // into nothing.
      'loop 0 sfx 0 left 63 right 63 doppler 0 scale 3f800000',
      'loop 1 sfx 1 left 63 right 63 doppler 0 scale 3f800000',
      'loop 2 sfx 2 left 63 right 63 doppler 0 scale 3f800000',
      'loop 3 sfx 3 left 1 right 1 doppler 0 scale 3f800000',
      'loop 4 sfx 4 left 1 right 1 doppler 0 scale 3f800000',
      // A speaker's at 90, silent past 1,302.
      'loop 5 sfx 8 left 45 right 45 doppler 0 scale 00000000',
      'loop 6 sfx 9 left 45 right 45 doppler 0 scale 00000000',
      'loop 7 sfx 10 left 44 right 44 doppler 0 scale 00000000',
      'loop 8 sfx 11 left 1 right 1 doppler 0 scale 00000000',
      // Hard left, hard right, behind and above at 100 units; and the sides at 1,316 and 1,320.
      'loop 9 sfx 24 left 124 right 0 doppler 0 scale 3f800000',
      'loop 10 sfx 25 left 0 right 124 doppler 0 scale 3f800000',
      'loop 11 sfx 26 left 62 right 62 doppler 0 scale 3f800000',
      'loop 12 sfx 27 left 62 right 62 doppler 0 scale 3f800000',
      'loop 13 sfx 28 left 1 right 0 doppler 0 scale 3f800000',
      'loop 14 sfx 29 left 0 right 1 doppler 0 scale 3f800000',
      // A unit more than doubles give, by the pan's float rounding and then the fade's.
      'loop 15 sfx 32 left 0 right 6 doppler 0 scale 00000000',
      'loop 16 sfx 33 left 49 right 0 doppler 0 scale 00000000',
      'loop 17 sfx 34 left 0 right 66 doppler 0 scale 3f800000',
      'loop 18 sfx 35 left 42 right 0 doppler 0 scale 00000000'
    ]);
    expect(corpus).toEqual({ steps: 38, playing: 199, loops: 19, digest: '705def2e' });
  });

  it("hears the listener's own sound from inside at 48 units, and not a 128th further", () => {
    const { printed, corpus } = hand('hearing');
    expect(printed).toEqual([
      'ch 93 sfx 2 ent 3 chan 0 alloc 1000 left 127 right 127 full 1',
      'ch 94 sfx 1 ent 3 chan 0 alloc 1000 left 63 right 63 full 0',
      'ch 95 sfx 0 ent 3 chan 0 alloc 1000 left 127 right 127 full 1'
    ]);
    expect(corpus).toEqual({ steps: 9, playing: 13, loops: 0, digest: 'bc98592e' });
  });

  it("keeps 96 of a hundred sounds' loops", () => {
    const { printed, corpus } = hand('crowded');
    expect(printed).toHaveLength(96);
    expect(printed.at(-1)).toBe('loop 95 sfx 95 left 62 right 62 doppler 0 scale 3f800000');
    expect(corpus).toEqual({ steps: 103, playing: 0, loops: 96, digest: '89cbf5f5' });
  });

  it("sums a sound's loops into a channel capped at 255, a pitched one taking the later", () => {
    const { printed, corpus } = hand('merge');
    // Both pitched loops take the five beside the listener, which the first had marked merged:
    // only the outer scan reads the mark.
    expect(printed).toEqual([
      'loop 0 sfx 0 left 255 right 211 doppler 1 scale 40b0b852',
      'loop 1 sfx 0 left 255 right 211 doppler 1 scale 41068f5c',
      'loop 2 sfx 1 left 179 right 89 doppler 0 scale 00000000'
    ]);
    expect(corpus).toEqual({ steps: 14, playing: 0, loops: 3, digest: '3e364feb' });
  });

  it("drops a loop missed for a frame, and keeps a speaker's until every loop is cleared", () => {
    const { printed, corpus } = hand('outAndBack');
    expect(printed).toEqual([
      'loop 0 sfx 0 left 62 right 62 doppler 0 scale 3f800000',
      'loop 1 sfx 1 left 81 right 0 doppler 0 scale 00000000',
      'loop 0 sfx 1 left 81 right 0 doppler 0 scale 00000000',
      'loop 0 sfx 0 left 62 right 62 doppler 0 scale 3f800000',
      'loop 1 sfx 1 left 81 right 0 doppler 0 scale 00000000'
    ]);
    expect(corpus).toEqual({ steps: 16, playing: 0, loops: 5, digest: 'f27e6de8' });
  });

  it('takes the oldest channel for a 97th sound, and drops a repeat and a sixth', () => {
    const { printed, corpus } = hand('channels');
    // The 97th, on another entity, takes the oldest but the announcer's.
    expect(printed).toContain('ch 94 sfx 96 ent 6 chan 0 alloc 1200 left 127 right 127 full 0');
    expect(printed).toContain('ch 95 sfx 0 ent 5 chan 7 alloc 1000 left 127 right 127 full 0');
    // The same sound again at once is dropped, and so is a sixth of a sound on one entity.
    expect(printed.filter((line) => line.includes('sfx 96 ent 6'))).toHaveLength(1);
    expect(printed.filter((line) => line.includes('sfx 97 ent 7'))).toEqual([
      'ch 91 sfx 97 ent 7 chan 0 alloc 1540 left 127 right 127 full 0',
      'ch 92 sfx 97 ent 7 chan 0 alloc 1480 left 127 right 127 full 0',
      'ch 93 sfx 97 ent 7 chan 0 alloc 1420 left 127 right 127 full 0',
      'ch 94 sfx 97 ent 7 chan 0 alloc 1360 left 127 right 127 full 0',
      'ch 95 sfx 97 ent 7 chan 0 alloc 1300 left 127 right 127 full 0'
    ]);
    // With every channel the listener's, the first among them, the oldest of all is taken.
    expect(printed.at(-1)).toBe('ch 95 sfx 96 ent 3 chan 6 alloc 2200 left 127 right 127 full 1');
    expect(corpus).toEqual({ steps: 407, playing: 19144, loops: 0, digest: '33273bdc' });
  });
});

describe('the mixer against the twin, seeded', () => {
  it.each([1, 2, 3, 4])('plays seed %i\'s 1,500 frames as the C does, to the bit', (seed) => {
    expect(mixerCorpus(seededScript(seed, 1500))).toEqual(SEEDED[seed]);
  });
});

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)("the mixer against the twin, on the retail maps' speakers", () => {
  let corpora: Record<string, MixerCorpus>;
  beforeAll(async () => {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    corpora = {};
    for (const path of fs.list('maps/', 'bsp')) {
      const map = path.slice('maps/'.length, -'.bsp'.length);
      const entities = readEntities(bspEntityText(await fs.readRequired(path), path));
      corpora[map] = mixerCorpus(censusScript(entities, 7));
    }
  }, 60_000);

  it("merges each map's looped speakers as the C does, wherever they are heard from", () => {
    expect(corpora).toEqual(CENSUS);
  });
});

describe('SoundMixer.startSound', () => {
  const sfx = { name: 'sound/weapons/rocket/rocklf1a.wav', length: 22050 };

  it('says which channel it took, or -1 for a sound it dropped', () => {
    const mixer = new SoundMixer();
    const index = mixer.startSound(vec3(64, 0, 0), 70, CHAN.AUTO, sfx, 1000);
    expect(mixer.channels[index]).toMatchObject({ sfx, entnum: 70, fixedOrigin: true });
    expect(mixer.startSound(null, 70, CHAN.AUTO, sfx, 1049)).toBe(-1);
    expect(mixer.startSound(null, 70, CHAN.AUTO, sfx, 1050)).not.toBe(-1);
  });

  it('refuses an entity past the last, as Com_Error does', () => {
    expect(() => new SoundMixer().startSound(null, 1024, CHAN.AUTO, sfx, 0)).toThrow(
      'S_StartSound: bad entitynum 1024'
    );
  });
});

describe('sndVol', () => {
  it("is s_volume in 255ths, a float's product truncated", () => {
    expect(sndVol(0.8)).toBe(204);
    expect(sndVol(1)).toBe(255);
    expect(sndVol(0)).toBe(0);
    // Where doubles truncate to 6.
    expect(sndVol(0.02745098)).toBe(7);
  });
});
