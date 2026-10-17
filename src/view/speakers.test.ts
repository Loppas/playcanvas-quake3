import { beforeAll, describe, expect, it } from 'vitest';

import { bspEntityText } from '../formats/bsp';
import { readEntities } from '../formats/entity-text';
import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { SpeakerSchedule } from './speakers';
import {
  censusSpeakers,
  handSpeakers,
  seededSpeakers,
  speakerCorpus,
  type SpeakerCorpus
} from './speakers-test-fixtures';

/**
 * The twin's corpora, as cgame's own `CG_Speaker` gave them, copied and compiled with `crandom()`
 * in the QVM's floats, over the corpora `speakers-test-fixtures.ts` writes: the steps, the sounds
 * started, and a digest of each step's start and next time.
 */
const SEEDED: Record<number, SpeakerCorpus> = {
  1: { steps: 27303, starts: 85, digest: 'f5cf0e53' },
  2: { steps: 27302, starts: 352, digest: '742bfe0c' },
  3: { steps: 27289, starts: 226, digest: 'd09440a3' },
  4: { steps: 27305, starts: 1429, digest: '96a4048f' }
};

/** The retail maps with repeating speakers; no other has one. */
const CENSUS: Record<string, SpeakerCorpus> = {
  q3ctf2: { steps: 52500, starts: 432, digest: 'a53338e4' },
  q3dm12: { steps: 112500, starts: 261, digest: '750c22fb' },
  q3dm17: { steps: 30000, starts: 14, digest: '10ebafae' },
  q3dm8: { steps: 45000, starts: 315, digest: 'be990039' }
};

describe('the speakers against the twin', () => {
  it("works each draw in the QVM's floats, where doubles would truncate a unit apart", () => {
    const schedule = new SpeakerSchedule();
    const next = handSpeakers().map((step) => {
      schedule.sounds(step.number, step.frame, step.clientNum, step.time, () => step.random);
      return schedule.next(step.number);
    });
    expect(next).toEqual([90325, 92325, -6645]);
    expect(speakerCorpus(handSpeakers())).toEqual({ steps: 3, starts: 3, digest: '1a9c4fb7' });
  });

  it('schedules every seeded corpus as CG_Speaker does, past where floats lose units', () => {
    for (const seed of [1, 2, 3, 4]) {
      expect(speakerCorpus(seededSpeakers(seed, 3000)), `seed ${seed}`).toEqual(SEEDED[seed]);
    }
  });
});

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)("the speakers against the twin, on the retail maps' own", () => {
  let corpora: Record<string, SpeakerCorpus>;
  beforeAll(async () => {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    corpora = {};
    for (const path of fs.list('maps/', 'bsp')) {
      const map = path.slice('maps/'.length, -'.bsp'.length);
      const entities = readEntities(bspEntityText(await fs.readRequired(path), path));
      const corpus = speakerCorpus(censusSpeakers(entities, 7));
      if (corpus.steps) corpora[map] = corpus;
    }
  }, 60_000);

  it("repeats each map's speakers for a minute as CG_Speaker does", () => {
    expect(corpora).toEqual(CENSUS);
  });
});

/** cgame's `random()`, always this. */
const always = (value: number) => () => value;

describe('SpeakerSchedule', () => {
  it('sounds a speaker with a random at the first frame it is in, then after its wait', () => {
    const schedule = new SpeakerSchedule();
    // `crandom()` at 0: the wait, 2 s, exactly.
    expect(schedule.sounds(100, 20, 10, 5000, always(0.5))).toBe(true);
    expect(schedule.next(100)).toBe(7000);
    expect(schedule.sounds(100, 20, 10, 6999, always(0.5))).toBe(false);
    expect(schedule.sounds(100, 20, 10, 7000, always(0.5))).toBe(true);
  });

  it('never repeats a speaker with a wait and no random', () => {
    const schedule = new SpeakerSchedule();
    expect(schedule.sounds(100, 20, 0, 5000, always(0.5))).toBe(false);
    expect(schedule.next(100)).toBe(0);
  });

  it('sounds one with a random and no wait again at the first frame its draw falls behind', () => {
    const schedule = new SpeakerSchedule();
    // A random of 1.2 s, and a draw of -1: due 1,200 ms ago.
    expect(schedule.sounds(100, 0, 12, 5000, always(0))).toBe(true);
    expect(schedule.next(100)).toBe(3800);
    expect(schedule.sounds(100, 0, 12, 5008, always(0))).toBe(true);
  });

  it("works the time in the QVM's floats, which lose units past 2^24 ms", () => {
    const schedule = new SpeakerSchedule();
    // 2^24 + 1 is no float, and rounds to 2^24; a draw of 0.5 adds 50 ms.
    expect(schedule.sounds(100, 0, 1, 2 ** 24 + 1, always(0.75))).toBe(true);
    expect(schedule.next(100)).toBe(2 ** 24 + 50);
  });

  it("starts every speaker's time over with cgame", () => {
    const schedule = new SpeakerSchedule();
    schedule.sounds(100, 20, 10, 5000, always(0.5));
    schedule.clear();
    expect(schedule.sounds(100, 20, 10, 5001, always(0.5))).toBe(true);
  });
});
