import { spawnInt, spawnString, spawnVector, type SpawnVars } from '../formats/entity-text';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { angleVectors, f } from '../sim/cm/q-math';
import { vec3, type Vec3 } from '../sim/vec3';
import { MAX_CHANNELS, SoundMixer, type Channel, type MixerSfx } from './sound-mixer';

/**
 * The mixer's corpus: steps of starts, positions, loops, listeners and scans, run through the
 * port's mixer and digested as the twin, ioquake3's own `snd_dma.c` compiled, digests them. The
 * steps are seeded frames, or a map's looped speakers heard from seeded places; the twin reads
 * them as {@link mixerInputs} writes them.
 */

/** What a step does, as the twin numbers it. */
export const STEP = {
  time: 0,
  start: 1,
  position: 2,
  clear: 3,
  loop: 4,
  real: 5,
  respatialize: 6,
  scan: 7,
  doppler: 8,
  buffer: 9,
  print: 10
} as const;

/**
 * One step, as the twin reads it: a type, four ints and twelve floats.
 *
 * - `time`: `Com_Milliseconds`.
 * - `start`: entity, channel, sfx and flags (1 an origin, 2 local); the origin.
 * - `position`: entity; the origin.
 * - `clear`: killall.
 * - `loop` and `real`: entity and sfx; the origin and the velocity.
 * - `respatialize`: entity; the head, then the axis's nine.
 * - `scan`: the painted time.
 * - `doppler`: `s_doppler`.
 */
export interface MixerStep {
  type: number;
  ints: [number, number, number, number];
  floats: number[];
}

/** A corpus: its sounds' lengths, and its steps. */
export interface MixerScript {
  lengths: number[];
  steps: MixerStep[];
}

/** What the twin prints of a corpus. */
export interface MixerCorpus {
  steps: number;
  /** Channels playing, summed over the digests. */
  playing: number;
  /** Loop channels, summed over the respatializes. */
  loops: number;
  digest: string;
}

/** A sound of the corpus, by its number. */
interface CorpusSfx extends MixerSfx {
  readonly index: number;
}

function step(type: number, ints: number[] = [], floats: readonly number[] = []): MixerStep {
  const all = [0, 0, 0, 0];
  ints.forEach((value, i) => (all[i] = value));
  return { type, ints: all as MixerStep['ints'], floats: floats.map((value) => f(value)) };
}

/** The twin's `pick`: a number below `n`, from the high bits. */
function pick(random: Seeded, n: number): number {
  return (random.next() >>> 8) % n;
}

/** A point within `range` units of `around`, in 256ths. */
function near(random: Seeded, around: readonly number[], range: number): number[] {
  const [x, y, z] = random.vec(range * 256);
  return [f(around[0] + x), f(around[1] + y), f(around[2] + z)];
}

/** `AnglesToAxis` of seeded angles, in the engine's floats: forward, left and up. */
function seededAxis(random: Seeded): number[] {
  const angles = [pick(random, 180) - 90, pick(random, 360), pick(random, 40) - 20];
  const forward = [0, 0, 0];
  const right = [0, 0, 0];
  const up = [0, 0, 0];
  angleVectors(angles, forward, right, up);
  return [...forward, 0 - right[0], 0 - right[1], 0 - right[2], ...up];
}

/**
 * Seeded frames of a match's sound, in cgame's order: the loops cleared, the frame's starts, the
 * entities' places and loops, the listener, and the scan. Some frames start a burst of a hundred
 * sounds, which fills the channels and takes them; some clear every loop or every channel, or turn
 * `s_doppler` over.
 */
export function seededScript(seed: number, frames: number): MixerScript {
  const random = new Seeded(seed);
  const lengths = Array.from({ length: 24 }, () => 200 + pick(random, 60000));
  // The listener, two of its neighbours, other entities, and the world.
  const entities = [3, 0, 1, 2, 4, 64, 65, 66, 100, 200, 1021, 1022];
  const steps: MixerStep[] = [];
  let time = 1000;
  let painted = 0;
  let listener = 3;
  let head = [0, 0, 0];

  for (let frame = 0; frame < frames; frame++) {
    const dt = 1 + pick(random, 30);
    time += dt;
    painted += dt * 22 + pick(random, 22);
    steps.push(step(STEP.time, [time]));
    steps.push(step(STEP.clear, [pick(random, 50) === 0 ? 1 : 0]));
    if (pick(random, 100) === 0) steps.push(step(STEP.buffer));
    if (pick(random, 40) === 0) steps.push(step(STEP.doppler, [pick(random, 2)]));

    // The listener's own entity, inside or out of its 48 units.
    const inside = pick(random, 2) === 0;
    steps.push(step(STEP.position, [listener], near(random, head, inside ? 32 : 256)));

    const burst = pick(random, 60) === 0;
    const starts = burst ? 90 + pick(random, 20) : pick(random, 6);
    for (let i = 0; i < starts; i++) {
      const entity = entities[pick(random, entities.length)];
      const placed = pick(random, 10) < 3;
      const local = pick(random, 20) === 0;
      if (!placed && pick(random, 2) === 0) {
        steps.push(step(STEP.position, [entity], near(random, head, 1600)));
      }
      const origin = placed ? near(random, head, 1600) : [0, 0, 0];
      const sfx = burst ? pick(random, lengths.length) : pick(random, 12);
      steps.push(
        step(STEP.start, [entity, pick(random, 8), sfx, (placed ? 1 : 0) | (local ? 2 : 0)], origin)
      );
    }

    const loops = pick(random, 10);
    for (let i = 0; i < loops; i++) {
      const entity =
        pick(random, 3) === 0 ? entities[pick(random, entities.length)] : 64 + pick(random, 60);
      const real = pick(random, 5) === 0;
      // A missile passing close, pitched by its speed.
      const passing = !real && pick(random, 6) === 0;
      const origin = near(random, head, passing ? 120 : 1500);
      const velocity = passing || pick(random, 10) === 0 ? random.vec(1200 * 256) : [0, 0, 0];
      const sfx = 12 + pick(random, 12);
      steps.push(step(real ? STEP.real : STEP.loop, [entity, sfx], [...origin, ...velocity]));
    }

    if (pick(random, 50) === 0) listener = listener === 3 ? 0 : 3;
    head = near(random, head, 128);
    steps.push(step(STEP.respatialize, [listener], [...head, ...seededAxis(random)]));
    steps.push(step(STEP.scan, [painted]));
  }
  return { lengths, steps };
}

/** A listener at the origin facing along x, its left along y. */
const FACING_X = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * The hand cases, each a short corpus that prints what it left:
 *
 * - `distances`: loops and one-shots straight ahead at 79, 80, 81, 1,302, 1,310, 1,316, 1,320
 *   and 1,330 units, at 127 and a speaker's 90; hard left and right, behind and above; where the
 *   pan's and the fade's float roundings move a volume; a local sound;
 * - `hearing`: the listener's own sounds from inside at 48 units, and not a 128th further;
 * - `crowded`: a hundred sounds' loops, of which the merge keeps 96;
 * - `merge`: five loops of a sound beside the listener, capped at 255, three speakers' of
 *   another, and a pitched loop that the later loop of its sound merges into;
 * - `outAndBack`: a loop added, missed for a frame, and added again; a speaker's through a frame's
 *   clear, and gone at a clear of every loop;
 * - `channels`: 97 sounds, the last taking the oldest channel; the same sound within 50 ms; a
 *   sixth of one sound on an entity; and the listener's own taking the oldest of all.
 */
export function handScripts(): Record<string, MixerScript> {
  const long = 1_000_000;
  const distances: MixerStep[] = [step(STEP.time, [1000])];
  const ahead = [79, 80, 81, 1302, 1310, 1316, 1320, 1330];
  ahead.forEach((x, i) => {
    distances.push(step(STEP.loop, [64 + i, i], [x, 0, 0, 0, 0, 0]));
    distances.push(step(STEP.real, [80 + i, 8 + i], [x, 0, 0, 0, 0, 0]));
    distances.push(step(STEP.start, [1022, 0, 16 + i, 1], [x, 0, 0]));
  });
  const around = [
    [0, 100, 0],
    [0, -100, 0],
    [-100, 0, 0],
    [0, 0, 100],
    [0, 1316, 0],
    [0, -1320, 0]
  ];
  around.forEach((origin, i) => {
    distances.push(step(STEP.loop, [96 + i, 24 + i], [...origin, 0, 0, 0]));
  });
  // Where the pan's float rounding moves a speaker's volume, then the fade's a loop's and a
  // speaker's: each a unit off in doubles.
  const rounded = [
    [STEP.real, -105.3671875, -1241.69140625, -29.59765625],
    [STEP.real, 99.73046875, 636.53125, 29.36328125],
    [STEP.loop, 7.0390625, -671.296875, 90.7265625],
    [STEP.real, 63.96875, 742.28515625, 24.30078125]
  ];
  rounded.forEach(([type, ...origin], i) => {
    distances.push(step(type, [110 + i, 32 + i], [...origin, 0, 0, 0]));
  });
  distances.push(step(STEP.start, [3, 6, 30, 2]));
  distances.push(step(STEP.respatialize, [3], FACING_X), step(STEP.print));

  const merge: MixerStep[] = [step(STEP.time, [1000]), step(STEP.position, [3], [0, 0, 0])];
  for (let i = 0; i < 5; i++) merge.push(step(STEP.loop, [64 + i, 0], [10, 4 * i, 0, 0, 0, 0]));
  for (let i = 0; i < 3; i++) merge.push(step(STEP.real, [70 + i, 1], [-20, 8 * i, 0, 0, 0, 0]));
  merge.push(step(STEP.loop, [60, 0], [40, 0, 0, 900, 0, 0]));
  merge.push(step(STEP.loop, [62, 0], [30, 0, 0, -900, 0, 0]));
  merge.push(step(STEP.respatialize, [3], FACING_X), step(STEP.print));

  const outAndBack: MixerStep[] = [
    step(STEP.time, [1000]),
    step(STEP.clear, [0]),
    step(STEP.loop, [70, 0], [100, 0, 0, 0, 0, 0]),
    step(STEP.real, [71, 1], [0, 200, 0, 0, 0, 0]),
    step(STEP.respatialize, [3], FACING_X),
    step(STEP.print),
    step(STEP.clear, [0]),
    step(STEP.respatialize, [3], FACING_X),
    step(STEP.print),
    step(STEP.clear, [0]),
    step(STEP.loop, [70, 0], [100, 0, 0, 0, 0, 0]),
    step(STEP.respatialize, [3], FACING_X),
    step(STEP.print),
    step(STEP.clear, [1]),
    step(STEP.respatialize, [3], FACING_X),
    step(STEP.print)
  ];

  // The oldest of entity 5's is the announcer's, which the 97th passes over.
  const channels: MixerStep[] = [step(STEP.respatialize, [3], FACING_X)];
  for (let i = 0; i < 96; i++) {
    channels.push(step(STEP.time, [1000 + i]), step(STEP.start, [5, i === 0 ? 7 : 0, i, 0]));
  }
  channels.push(step(STEP.time, [1200]), step(STEP.start, [6, 0, 96, 0]));
  // The same sound on the same entity at once.
  channels.push(step(STEP.start, [6, 0, 96, 0]), step(STEP.print), step(STEP.buffer));
  // A sixth of one sound on an entity.
  for (let i = 0; i < 6; i++) {
    channels.push(step(STEP.time, [1300 + 60 * i]), step(STEP.start, [7, 0, 97, 0]));
  }
  channels.push(step(STEP.print), step(STEP.buffer));
  // The listener's own, which take the oldest of all once the first channel is theirs.
  for (let i = 0; i < 96; i++) {
    channels.push(step(STEP.time, [2000 + i]), step(STEP.start, [3, 6, i, 2]));
  }
  channels.push(step(STEP.time, [2200]), step(STEP.start, [3, 6, 96, 2]), step(STEP.print));

  // The listener's own entity at 48 units, then a 128th further, and a sound placed at 48.
  const hearing: MixerStep[] = [
    step(STEP.time, [1000]),
    step(STEP.respatialize, [3], [0, 0, 48, ...FACING_X.slice(3)]),
    step(STEP.position, [3], [0, 0, 0]),
    step(STEP.start, [3, 0, 0, 0]),
    step(STEP.position, [3], [0, 0, -0.0078125]),
    step(STEP.start, [3, 0, 1, 0]),
    step(STEP.start, [3, 0, 2, 1], [48, 0, 48]),
    step(STEP.respatialize, [3], [0, 0, 48, ...FACING_X.slice(3)]),
    step(STEP.print)
  ];

  // A hundred sounds' loops, all heard: the merge keeps 96.
  const crowded: MixerStep[] = [step(STEP.time, [1000])];
  for (let i = 0; i < 100; i++) crowded.push(step(STEP.loop, [64 + i, i], [100, 0, 0, 0, 0, 0]));
  crowded.push(step(STEP.respatialize, [3], FACING_X), step(STEP.print));

  return {
    distances: { lengths: new Array<number>(36).fill(long), steps: distances },
    hearing: { lengths: [long, long, long], steps: hearing },
    crowded: { lengths: new Array<number>(100).fill(long), steps: crowded },
    merge: { lengths: [long, long], steps: merge },
    outAndBack: { lengths: [long, long], steps: outAndBack },
    channels: { lengths: new Array<number>(98).fill(long), steps: channels }
  };
}

/** A sound's name as `SP_target_speaker` makes it, `.wav` added where it has none. */
function speakerSound(noise: string): string {
  return (noise.includes('.wav') ? noise : `${noise}.wav`).toLowerCase();
}

/**
 * A map's looped speakers heard from seeded places: each a real loop at 90, re-added each frame as
 * `CG_EntityEffects` adds it, from listeners near the speakers and at the spawn spots.
 *
 * The speakers are numbered past the clients in the text's order; the merge's order is by number,
 * and its sums are not.
 */
export function censusScript(entities: readonly SpawnVars[], seed: number): MixerScript {
  const random = new Seeded(seed);
  const sounds = new Map<string, number>();
  const speakers: { number: number; origin: number[]; sfx: number }[] = [];
  const spots: { origin: number[]; yaw: number }[] = [];
  entities.forEach((vars) => {
    const classname = spawnString(vars, 'classname', '');
    const at = vec3();
    spawnVector(vars, 'origin', '0 0 0', at);
    const origin = [at.x, at.y, at.z];
    if (classname === 'info_player_deathmatch') {
      spots.push({ origin, yaw: spawnInt(vars, 'angle', '0') });
    }
    const noise = spawnString(vars, 'noise', '');
    if (classname !== 'target_speaker' || !(spawnInt(vars, 'spawnflags', '0') & 1)) return;
    if (!noise || noise.startsWith('*')) return;
    const name = speakerSound(noise);
    if (!sounds.has(name)) sounds.set(name, sounds.size);
    speakers.push({ number: 64 + speakers.length, origin, sfx: sounds.get(name)! });
  });

  const steps: MixerStep[] = [];
  const heard = (head: number[], axis: number[]) => {
    steps.push(step(STEP.clear, [0]));
    for (const { number, origin, sfx } of speakers) {
      steps.push(step(STEP.real, [number, sfx], [...origin, 0, 0, 0]));
    }
    steps.push(step(STEP.respatialize, [0], [...head, ...axis]));
  };
  if (speakers.length > 0) {
    for (let i = 0; i < 48; i++) {
      const speaker = speakers[pick(random, speakers.length)];
      heard(near(random, speaker.origin, 384), seededAxis(random));
    }
  }
  for (const { origin, yaw } of spots) {
    const forward = [0, 0, 0];
    const right = [0, 0, 0];
    const up = [0, 0, 0];
    angleVectors([0, yaw, 0], forward, right, up);
    const axis = [...forward, 0 - right[0], 0 - right[1], 0 - right[2], ...up];
    heard([origin[0], origin[1], origin[2] + 26], axis);
  }
  return { lengths: Array.from({ length: sounds.size }, () => 22050), steps };
}

/** Each sound's number, as the twin prints it, or -1 for none. */
function sfxIndex(sfx: CorpusSfx | null): number {
  return sfx ? sfx.index : -1;
}

/** A channel playing, into a digest; a free one as -1, as its first bytes are the free list's. */
function digestChannel(digest: Digest, ch: Channel<CorpusSfx>): void {
  if (!ch.sfx) {
    digest.int(-1);
    return;
  }
  digest
    .int(sfxIndex(ch.sfx))
    .int(ch.entnum)
    .int(ch.entchannel)
    .int(ch.allocTime)
    .int(ch.startSample)
    .int(ch.leftvol)
    .int(ch.rightvol)
    .int(ch.masterVol)
    .int(ch.fixedOrigin ? 1 : 0)
    .int(ch.fullVolume ? 1 : 0);
  if (ch.fixedOrigin) digest.float(ch.origin[0]).float(ch.origin[1]).float(ch.origin[2]);
}

/**
 * Run a corpus through the port's mixer: every step's channels digested, and after each
 * respatialize the merge's loop channels too.
 *
 * @param print - Given each `print` step's lines, as the twin prints them.
 */
export function mixerCorpus(
  script: MixerScript,
  print: (line: string) => void = () => {}
): MixerCorpus {
  const sfx: CorpusSfx[] = script.lengths.map((length, index) => {
    return { name: `s${index}`, length, index };
  });
  const mixer = new SoundMixer<CorpusSfx>();
  const digest = new Digest();
  let time = 0;
  let playing = 0;
  let loops = 0;
  const at = (floats: readonly number[], from: number): Vec3 =>
    vec3(floats[from], floats[from + 1], floats[from + 2]);

  for (const { type, ints, floats } of script.steps) {
    switch (type) {
      case STEP.time:
        time = ints[0];
        break;
      case STEP.start: {
        const origin = ints[3] & 1 ? at(floats, 0) : null;
        mixer.startSound(origin, ints[0], ints[1], sfx[ints[2]], time, (ints[3] & 2) !== 0);
        break;
      }
      case STEP.position:
        mixer.updateEntityPosition(ints[0], at(floats, 0));
        break;
      case STEP.clear:
        mixer.clearLoopingSounds(ints[0] !== 0);
        break;
      case STEP.loop:
        mixer.addLoopingSound(ints[0], at(floats, 0), at(floats, 3), sfx[ints[1]]);
        break;
      case STEP.real:
        mixer.addRealLoopingSound(ints[0], at(floats, 0), at(floats, 3), sfx[ints[1]]);
        break;
      case STEP.respatialize: {
        const axis = [floats.slice(3, 6), floats.slice(6, 9), floats.slice(9, 12)];
        mixer.respatialize(ints[0], at(floats, 0), axis);
        loops += mixer.numLoopChannels;
        digest.int(mixer.numLoopChannels);
        for (let i = 0; i < mixer.numLoopChannels; i++) {
          const ch = mixer.loopChannels[i];
          digest
            .int(sfxIndex(ch.sfx))
            .int(ch.leftvol)
            .int(ch.rightvol)
            .int(ch.doppler ? 1 : 0)
            .float(ch.dopplerScale);
        }
        break;
      }
      case STEP.scan:
        mixer.scanChannelStarts(ints[0]);
        break;
      case STEP.doppler:
        mixer.doppler = ints[0] !== 0;
        break;
      case STEP.buffer:
        mixer.clearSoundBuffer();
        break;
      case STEP.print:
        printMixer(mixer, print);
        break;
    }
    for (let i = 0; i < MAX_CHANNELS; i++) {
      digestChannel(digest, mixer.channels[i]);
      if (mixer.channels[i].sfx) playing++;
    }
  }
  return { steps: script.steps.length, playing, loops, digest: digest.hex() };
}

/** A float's bits, as eight hex digits. */
function floatBits(value: number): string {
  const bits = new DataView(new ArrayBuffer(4));
  bits.setFloat32(0, value, true);
  return bits.getUint32(0, true).toString(16).padStart(8, '0');
}

/**
 * The mixer's channels playing and its loop channels, a line each, as the twin prints them, a
 * Doppler scale by its bits.
 */
function printMixer(mixer: SoundMixer<CorpusSfx>, print: (line: string) => void): void {
  for (const ch of mixer.channels) {
    if (!ch.sfx) continue;
    print(
      `ch ${ch.index} sfx ${sfxIndex(ch.sfx)} ent ${ch.entnum} chan ${ch.entchannel} ` +
        `alloc ${ch.allocTime} left ${ch.leftvol} right ${ch.rightvol} ` +
        `full ${ch.fullVolume ? 1 : 0}`
    );
  }
  for (let i = 0; i < mixer.numLoopChannels; i++) {
    const ch = mixer.loopChannels[i];
    print(
      `loop ${i} sfx ${sfxIndex(ch.sfx)} left ${ch.leftvol} right ${ch.rightvol} ` +
        `doppler ${ch.doppler ? 1 : 0} scale ${floatBits(ch.dopplerScale)}`
    );
  }
}

/** A corpus as the twin reads it: the lengths, then a step a line, each float by its bits. */
export function mixerInputs({ lengths, steps }: MixerScript): string {
  const hex = floatBits;
  const lines = [`${lengths.length} ${lengths.join(' ')}`, `${steps.length}`];
  for (const { type, ints, floats } of steps) {
    const all = [...floats, ...new Array<number>(12 - floats.length).fill(0)];
    lines.push(`${type} ${ints.join(' ')} ${all.map(hex).join(' ')}`);
  }
  return lines.join('\n') + '\n';
}

/** A hand-written step, for a test's own corpus. */
export { step as mixerStep };
