import { spawnFloat, spawnString, type SpawnVars } from '../formats/entity-text';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { f } from '../sim/cm/q-math';
import { SpeakerSchedule } from './speakers';

/**
 * The speakers' corpus: `CG_Speaker` calls, run through the port's schedule and digested as the
 * twin, cgame's own `CG_Speaker` compiled, digests them. The calls are seeded frames of speakers
 * with every width of wait and random the wire carries, or a map's repeating speakers heard for a
 * minute; the twin reads them as {@link speakerInputs} writes them.
 */

/** A step: `CG_Speaker` of a speaker in the snapshot, or cgame starting over. */
export interface SpeakerStep {
  /** 0: `CG_Speaker`; 1: `CG_Init`'s clear. */
  type: number;
  number: number;
  /** `s.frame`: the wait, in tenths of a second, as the wire's 16 bits carry it. */
  frame: number;
  /** `s.clientNum`: the random, in tenths, as the wire's 8 bits carry it. */
  clientNum: number;
  /** `cg.time`. */
  time: number;
  /** What cgame's `random()` gives, should the speaker sound: `(rand() & 0x7fff) / 0x7fff`. */
  random: number;
}

/** What the twin prints of a corpus. */
export interface SpeakerCorpus {
  steps: number;
  /** The sounds started. */
  starts: number;
  digest: string;
}

/** The twin's `pick`: a number below `n`, from the high bits. */
function pick(random: Seeded, n: number): number {
  return (random.next() >>> 8) % n;
}

/** A QVM `random()`'s value. */
function qvmRandom(random: Seeded): number {
  return f(pick(random, 0x8000) / f(0x7fff));
}

/**
 * Seeded frames of a dozen speakers, each in the snapshot three frames in four, from a time that
 * may be past where floats lose units: waits and randoms of 0, small, and any the wire carries,
 * and now and then cgame starting over.
 */
export function seededSpeakers(seed: number, frames: number): SpeakerStep[] {
  const random = new Seeded(seed);
  const starts = [0, 1000, 2 ** 24 - 20000, 2 ** 24 + 1, 2 ** 25 + 7, 2 ** 30];
  let time = starts[pick(random, starts.length)];
  const speakers = [64, 65, 100, 200, 511, 1000, 1021, 70, 71, 72, 73, 74].map((number) => ({
    number,
    frame: [0, 1 + pick(random, 100), pick(random, 0x10000)][pick(random, 3)],
    clientNum: [0, 1 + pick(random, 30), pick(random, 0x100)][pick(random, 3)]
  }));
  const steps: SpeakerStep[] = [];
  for (let i = 0; i < frames; i++) {
    time += 1 + pick(random, 50);
    if (pick(random, 500) === 0) {
      steps.push({ type: 1, number: 0, frame: 0, clientNum: 0, time, random: 0 });
    }
    for (const speaker of speakers) {
      if (pick(random, 4) === 0) continue;
      steps.push({ type: 0, ...speaker, time, random: qvmRandom(random) });
    }
  }
  return steps;
}

/**
 * A map's repeating speakers, those `CG_Speaker` sounds again, each heard every 8 ms frame for a
 * minute from the time a match starts, with seeded draws. Each carries what `SP_target_speaker`
 * sends: its wait and random in tenths, as the wire's widths leave them.
 */
export function censusSpeakers(entities: readonly SpawnVars[], seed: number): SpeakerStep[] {
  const random = new Seeded(seed);
  const speakers: Pick<SpeakerStep, 'number' | 'frame' | 'clientNum'>[] = [];
  for (const vars of entities) {
    if (spawnString(vars, 'classname', '') !== 'target_speaker') continue;
    const clientNum = Math.trunc(f(spawnFloat(vars, 'random', '0') * 10)) & 0xff;
    if (!clientNum) continue;
    const frame = Math.trunc(f(spawnFloat(vars, 'wait', '0') * 10)) & 0xffff;
    speakers.push({ number: 64 + speakers.length, frame, clientNum });
  }
  const steps: SpeakerStep[] = [];
  for (let time = 1000; time < 61000; time += 8) {
    for (const speaker of speakers) {
      steps.push({ type: 0, ...speaker, time, random: qvmRandom(random) });
    }
  }
  return steps;
}

/**
 * Draws found by search where the QVM's floats and doubles truncate the next time apart, each a
 * speaker at its first sounding: a random of 9.9 s, and draws 374 and 422 of `0x7fff`.
 */
export function handSpeakers(): SpeakerStep[] {
  const draw = (rand: number) => f(rand / f(0x7fff));
  return [
    { type: 0, number: 100, frame: 0, clientNum: 99, time: 99999, random: draw(374) },
    { type: 0, number: 101, frame: 20, clientNum: 99, time: 99999, random: draw(374) },
    { type: 0, number: 102, frame: 20, clientNum: 99, time: 1000, random: draw(422) }
  ];
}

/** Run a corpus through the port's schedule: each step's start and next time digested. */
export function speakerCorpus(steps: readonly SpeakerStep[]): SpeakerCorpus {
  const schedule = new SpeakerSchedule();
  const digest = new Digest();
  let starts = 0;
  for (const step of steps) {
    if (step.type === 1) {
      schedule.clear();
      continue;
    }
    const { number, frame, clientNum, time } = step;
    const sounded = schedule.sounds(number, frame, clientNum, time, () => step.random);
    if (sounded) starts++;
    digest.int(sounded ? 1 : 0).int(schedule.next(number));
  }
  return { steps: steps.length, starts, digest: digest.hex() };
}

/** A corpus as the twin reads it: its count, then a step a line, the draw by its bits. */
export function speakerInputs(steps: readonly SpeakerStep[]): string {
  const bits = new DataView(new ArrayBuffer(4));
  const lines = steps.map(({ type, number, frame, clientNum, time, random }) => {
    bits.setFloat32(0, random);
    const draw = bits.getUint32(0).toString(16).padStart(8, '0');
    return `${type} ${number} ${frame} ${clientNum} ${time} ${draw}`;
  });
  return `${steps.length}\n${lines.join('\n')}\n`;
}
