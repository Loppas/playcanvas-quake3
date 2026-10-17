import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssetLibrary } from '../formats/asset-library';
import { fmtChunk, markedWav, pcmWav, riffWav } from '../formats/wav-test-fixtures';
import { TR, createEntityState } from '../net/protocol';
import { normalizePakPath } from '../pak/zip';
import { EV } from '../sim/events';
import { PW } from '../sim/items';
import { vec3, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import type { PlayerSound } from '../view/player-events';
import type { SoundCentity } from '../view/player-view';
import { FLIGHT_SOUND } from '../view/powerup-sounds';
import type { MusicRead } from '../view/music';
import { CHAN } from '../view/sound-mixer';
import { SoundBus, type SoundFiles, type SoundInput } from './sound-bus';

/** A gain, and what it is connected to. */
interface FakeGain {
  gain: { value: number };
}

/** A source, the gains it plays into, and how it was started. */
interface FakeSource {
  buffer: { file: number } | null;
  loop: boolean;
  playbackRate: { value: number };
  into: FakeGain[];
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

/** A buffer of samples, which says which of the library's files it holds. */
class FakeBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly data: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.data[channel];
  }

  copyToChannel(source: Float32Array, channel: number): void {
    this.data[channel].set(source.subarray(0, this.length));
  }

  /** The mark its first sample carries ({@link markedWav}). */
  get file(): number {
    return Math.round(this.data[0][0] * 32768);
  }
}

/** A Web Audio context that keeps every node it makes, and plays nothing. */
class FakeContext {
  readonly destination = {};
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly buffers: FakeBuffer[] = [];

  createGain() {
    const gain = { gain: { value: 1 }, connect: () => {} };
    this.gains.push(gain);
    return gain;
  }

  createChannelMerger() {
    return { connect: () => {} };
  }

  createChannelSplitter() {
    return { connect: () => {} };
  }

  createBufferSource() {
    const source: FakeSource & Record<string, unknown> = {
      buffer: null,
      loop: false,
      playbackRate: { value: 1 },
      into: [],
      connect: (node: FakeGain) => source.into.push(node),
      disconnect: () => {},
      start: vi.fn(),
      stop: vi.fn()
    };
    this.sources.push(source);
    return source;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
    const buffer = new FakeBuffer(numberOfChannels, length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  resume() {
    return Promise.resolve();
  }

  close() {
    return Promise.resolve();
  }
}

/** A library holding these sounds, each marked with its place in the list, and no models. */
function library(paths: readonly string[]): AssetLibrary {
  const files = new Map(paths.map((path, i) => [path, markedWav(i)]));
  return {
    files,
    playerModels: [],
    read: (path: string) => files.get(path)
  } as unknown as AssetLibrary;
}

/** A source's two ear volumes, out of 255. */
function ears(source: FakeSource): number[] {
  return source.into.map((node) => node.gain.value * 256);
}

const RAIL_HUM = 'sound/weapons/railgun/rg_hum.wav';
const ROCKET_FLY = 'sound/weapons/rocket/rockfly.wav';
const MENU_MOVE = 'sound/misc/menu2.wav';

/** The player, client 0, at the origin, looking along x, and nothing else. */
function quiet(): SoundInput {
  return {
    effects: [],
    events: [],
    missiles: [],
    time: 1000,
    // The gauntlet hums nothing in the hand.
    weapon: WP.GAUNTLET,
    firing: false,
    powerups: new Array<number>(16).fill(0),
    player: { number: 0, origin: vec3(0, 0, 0), body: true, loopSound: 0, sounds: [], splats: [] },
    view: { origin: vec3(0, 0, 26), angles: vec3(0, 0, 0) }
  };
}

/** A frame of a match: the railgun in hand, flying, a rocket in the air and another player. */
function frame(): SoundInput {
  const powerups = new Array<number>(16).fill(0);
  powerups[PW.FLIGHT] = 30000;
  const rocket = createEntityState(70);
  rocket.weapon = WP.ROCKET_LAUNCHER;
  return {
    ...quiet(),
    missiles: [{ state: rocket, origin: { x: 600, y: 0, z: 0 } }],
    weapon: WP.RAILGUN,
    powerups,
    others: {
      entities: [
        {
          number: 3,
          origin: { x: 300, y: 0, z: 0 },
          weapon: WP.RAILGUN,
          firing: false,
          powerups: 1 << PW.FLIGHT,
          loopSound: 0
        }
      ],
      sounds: [],
      voice: () => null
    }
  };
}

beforeEach(() => {
  // `Com_Milliseconds`, which the 50 ms rule reads, held still unless a test moves it.
  vi.spyOn(performance, 'now').mockReturnValue(1000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A bus holding these sounds, and the fake context it plays them on.
 *
 * @param files - Where it reads the match's sounds, and what it says.
 */
async function opened(
  paths: readonly string[],
  files?: SoundFiles
): Promise<{ bus: SoundBus; context: FakeContext }> {
  let context: FakeContext | null = null;
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal(
    'AudioContext',
    class extends FakeContext {
      constructor() {
        super();
        context = this;
      }
    }
  );
  const bus = await SoundBus.create(library(paths), undefined, files);
  return { bus, context: context! };
}

describe('SoundBus volumes', () => {
  it("plays a menu sound in both ears at 127, under s_volume's snd_vol", async () => {
    const { bus, context } = await opened([MENU_MOVE]);
    bus.volume = 0.8;
    bus.playMenu('move');
    const [master] = context.gains;
    expect(master.gain.value * 256).toBe(204);
    const [source] = context.sources;
    expect(source.buffer?.file).toBe(0);
    expect(ears(source)).toEqual([127, 127]);
    expect(bus.mixer.channels.find((ch) => ch.sfx)?.entchannel).toBe(CHAN.LOCAL_SOUND);
    bus.destroy();
  });

  it("hears the player's own sound from inside, and from the body past 48 units", async () => {
    const land: PlayerSound[] = [{ type: 'shared', path: 'sound/player/land1.wav' }];
    const { bus, context } = await opened(['sound/player/land1.wav']);
    bus.update(quiet());
    bus.update({ ...quiet(), player: { ...quiet().player, sounds: land } });
    // Started 26 units below the eye the last respatialize put the listener at.
    expect(ears(context.sources[0])).toEqual([127, 127]);

    // The eye 100 behind the body, and 64 above it, as a third person's.
    const behind = { origin: vec3(-100, 0, 64), angles: vec3(0, 0, 0) };
    bus.update({ ...quiet(), view: behind });
    vi.mocked(performance.now).mockReturnValue(2000);
    bus.update({ ...quiet(), view: behind, player: { ...quiet().player, sounds: land } });
    expect(ears(context.sources[1])).toEqual([61, 61]);
    bus.destroy();
  });
});

describe("SoundBus's world sounds", () => {
  it('places an event sound on its entity where the event found it', async () => {
    const path = 'sound/items/respawn1.wav';
    const { bus, context } = await opened([path]);
    bus.update({
      ...quiet(),
      effects: [{ type: 'sound', path, number: 70, origin: vec3(0, -300, 26) }]
    });
    // 300 units to the right.
    expect(ears(context.sources[0])).toEqual([0, 104]);
    bus.destroy();
  });
});

describe('SoundBus loops', () => {
  it("merges two bodies' hums into one source, their volumes summed", async () => {
    const { bus, context } = await opened([RAIL_HUM]);
    const hum = { weapon: WP.RAILGUN, firing: false, powerups: 0, loopSound: 0 };
    bus.update({
      ...quiet(),
      others: {
        entities: [
          { number: 3, origin: vec3(100, 0, 26), ...hum },
          { number: 4, origin: vec3(100, 0, 26), ...hum }
        ],
        sounds: [],
        voice: () => null
      }
    });
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].loop).toBe(true);
    expect(ears(context.sources[0])).toEqual([124, 124]);
    expect(bus.loops).toBe(1);
    bus.destroy();
  });

  it("starts a loop at the clock's place in it, every loop of a sound in phase", async () => {
    const { bus, context } = await opened([RAIL_HUM]);
    context.currentTime = 1.25;
    bus.update({ ...quiet(), weapon: WP.RAILGUN });
    expect(context.sources[0].start).toHaveBeenCalledWith(0, 0.25);
    bus.destroy();
  });

  it('adds no hum at the intermission or in hyperspace, keeping its source', async () => {
    const { bus, context } = await opened([RAIL_HUM]);
    const humming = { ...quiet(), weapon: WP.RAILGUN };
    bus.update(humming);
    const [source] = context.sources;
    expect(ears(source)).toEqual([63, 63]);

    bus.update({ ...humming, player: { ...humming.player, body: false } });
    expect(bus.loops).toBe(0);
    expect(ears(source)).toEqual([0, 0]);

    bus.update({ ...humming, hyperspace: true });
    expect(bus.loops).toBe(0);
    bus.update(humming);
    expect(context.sources).toHaveLength(1);
    expect(source.stop).not.toHaveBeenCalled();
    expect(ears(source)).toEqual([63, 63]);
    bus.destroy();
  });

  it("hears a flight over a body's hum, the last loop added to an entity winning", async () => {
    const { bus } = await opened([RAIL_HUM, FLIGHT_SOUND]);
    const powerups = new Array<number>(16).fill(0);
    powerups[PW.FLIGHT] = 30000;
    bus.update({ ...quiet(), weapon: WP.RAILGUN, powerups });
    expect(bus.loops).toBe(1);
    expect(bus.mixer.loopChannels[0].sfx?.name).toBe(FLIGHT_SOUND);
    bus.destroy();
  });

  it('clears every loop, the real ones too, at a map_restart', async () => {
    const { bus } = await opened([RAIL_HUM]);
    const { loopSounds } = bus.mixer;
    bus.update({ ...quiet(), weapon: WP.RAILGUN });
    const hum = bus.mixer.loopChannels[0].sfx!;
    bus.mixer.addRealLoopingSound(200, vec3(64, 0, 0), vec3(), hum);
    bus.update(quiet());
    expect(loopSounds[200].active).toBe(true);
    bus.update({ ...quiet(), mapRestart: true });
    expect(loopSounds[200].active).toBe(false);
    bus.destroy();
  });

  it("pitches a missile's flight loop as it passes, and not under s_doppler 0", async () => {
    const { bus, context } = await opened([ROCKET_FLY]);
    const rocket = createEntityState(70);
    rocket.weapon = WP.ROCKET_LAUNCHER;
    rocket.pos.trType = TR.LINEAR;
    rocket.pos.trDelta = vec3(900, 0, 0);
    const passing = (origin: Vec3, doppler: boolean): SoundInput => ({
      ...quiet(),
      missiles: [{ state: rocket, origin }],
      doppler
    });

    bus.update(passing(vec3(40, 0, 0), true));
    expect(bus.mixer.loopSounds[70].origin).toEqual([40, 0, 0]);
    const [pitched] = context.sources;
    expect(pitched.playbackRate.value).toBeCloseTo(5.5225, 4);

    bus.update(passing(vec3(40, 0, 0), false));
    // The pitched voice goes, and the loop plays in its sound's own.
    expect(pitched.stop).toHaveBeenCalledOnce();
    expect(context.sources[1].playbackRate.value).toBe(1);
    bus.destroy();
  });
});

describe('SoundBus.clear', () => {
  it("stops every sound a match left, loops and all, as S_StopAllSounds does", async () => {
    const { bus, context } = await opened([RAIL_HUM, ROCKET_FLY, FLIGHT_SOUND, MENU_MOVE]);
    bus.playMenu('move');
    bus.update(frame());
    // The two flights over their hums, merged, and the rocket's.
    expect(bus.loops).toBe(2);
    const looping = context.sources.filter((source) => source.loop);
    expect(looping).toHaveLength(2);

    bus.clear();
    expect(bus.loops).toBe(0);
    for (const source of context.sources) expect(source.stop).toHaveBeenCalledOnce();
    expect(bus.mixer.channels.every((ch) => !ch.sfx)).toBe(true);

    // The next match's first frame starts its loops afresh.
    bus.update(frame());
    expect(bus.loops).toBe(2);
    expect(context.sources.filter((source) => source.loop)).toHaveLength(4);
    bus.destroy();
  });
});

describe("SoundBus's registered sounds", () => {
  const HIT = 'sound/feedback/hit.wav';
  const FIRE = 'sound/world/fire1.wav';
  const BOBBER = 'sound/world/x_bobber.wav';
  const FRY = 'sound/player/fry.wav';
  const MISSING = 'sound/world/waterfall.wav';
  /** The paks the match's sounds are read from, each marked. */
  const paks = new Map([
    [FIRE, markedWav(5)],
    [BOBBER, markedWav(6)],
    [FRY, markedWav(9)]
  ]);
  /** The paks, a list of what the bus says, and one of the names it reads. */
  const files = (printed: string[] = [], asked: string[] = []): SoundFiles => ({
    read: (path) => {
      asked.push(path);
      return Promise.resolve(paks.get(normalizePakPath(path)));
    },
    print: (text) => printed.push(text)
  });
  /** `CS_SOUNDS` naming these, from slot 1. */
  const strings =
    (...names: string[]) =>
    (index: number) =>
      ['', ...names][index] ?? '';
  /** An entity's sound state, still and with nothing to play but what it is given. */
  const entity = (fields: Partial<SoundCentity> & Pick<SoundCentity, 'number' | 'origin'>) => ({
    soundOrigin: fields.origin,
    loopSound: 0,
    speaker: false,
    eventParm: 0,
    frame: 0,
    clientNum: 0,
    ...fields
  });
  /** The merge's loops: each one's sound and its two volumes. */
  const loops = (bus: SoundBus) =>
    bus.mixer.loopChannels
      .slice(0, bus.mixer.numLoopChannels)
      .map((ch) => [ch.sfx?.name, ch.leftvol, ch.rightvol]);
  const marks = (context: FakeContext) => context.sources.map((source) => source.buffer?.file);

  it("registers each slot's sound to the first empty one, and plays it on its entity", async () => {
    const printed: string[] = [];
    const { bus, context } = await opened([HIT], files(printed));
    await bus.registerGameSounds(strings(FIRE, '*falling1.wav', MISSING, '', BOBBER));
    expect(printed).toEqual([
      `^3WARNING: Failed to load sound ${MISSING}!\n`,
      `^3WARNING: could not find ${MISSING} - using default\n`
    ]);

    printed.length = 0;
    bus.update({
      ...quiet(),
      effects: [
        { type: 'gameSound', index: 1, name: FIRE, number: 70, origin: vec3(100, 0, 26) },
        { type: 'gameSound', index: 3, name: MISSING, number: 71, origin: vec3(100, 0, 26) }
      ]
    });
    // The second is the hit, its file loaded again and refused again, as `CG_CustomSound` does.
    expect(marks(context)).toEqual([5, 0]);
    expect(printed).toEqual([
      `^3WARNING: Failed to load sound ${MISSING}!\n`,
      `^3WARNING: could not find ${MISSING} - using default\n`
    ]);
    // The free list hands out the channels from the last.
    const playing = bus.mixer.channels.filter((ch) => ch.sfx);
    expect(playing.map((ch) => [ch.entnum, ch.entchannel])).toEqual([
      [71, CHAN.VOICE],
      [70, CHAN.VOICE]
    ]);
    bus.destroy();
  });

  it("refuses a file Quake 3's reader refuses, saying what it says", async () => {
    const MP3 = 'sound/world/kohout.wav';
    const mp3 = riffWav([fmtChunk({ format: 0x55, bits: 0 }), { name: 'data', bytes: [1, 2, 3] }]);
    const printed: string[] = [];
    const { bus } = await opened([HIT], {
      read: (path) => Promise.resolve(path === MP3 ? mp3 : undefined),
      print: (text) => printed.push(text)
    });
    await bus.registerGameSounds(strings(MP3));
    expect(printed).toEqual([
      '^1ERROR: Less than 8 bit sound is not supported\n',
      `^1ERROR: Incorrect/unsupported format in "${MP3}"\n`,
      `^3WARNING: Failed to load sound ${MP3}!\n`,
      `^3WARNING: could not find ${MP3} - using default\n`
    ]);
    bus.destroy();
  });

  it("loops a speaker's sound at 90 till all are cleared, a mover's while it is sent", async () => {
    const { bus } = await opened([HIT], files());
    await bus.registerGameSounds(strings(FIRE, BOBBER, MISSING));
    const speaker = entity({ number: 100, origin: vec3(100, 0, 26), loopSound: 1, speaker: true });
    // The mover's events are heard from its midpoint, and its loop from its origin.
    const mover = entity({
      number: 101,
      origin: vec3(0, -200, 26),
      soundOrigin: vec3(500, 0, 26),
      loopSound: 2
    });
    // A looped speaker whose file would not load loops the hit.
    const missing = entity({ number: 102, origin: vec3(0, 200, 26), loopSound: 3, speaker: true });
    bus.update({ ...quiet(), entities: [speaker, mover, missing] });
    expect(loops(bus)).toEqual([
      [FIRE, 44, 44],
      [BOBBER, 0, 114],
      [HIT, 81, 0]
    ]);
    expect(bus.mixer.loopSounds[101].origin).toEqual([0, -200, 26]);

    // Out of the snapshot, the speakers play on where they were, and the mover is silent.
    bus.update(quiet());
    expect(loops(bus)).toEqual([
      [FIRE, 44, 44],
      [HIT, 81, 0]
    ]);
    bus.update({ ...quiet(), mapRestart: true });
    expect(loops(bus)).toEqual([]);
    bus.destroy();
  });

  it("hears an entity's events from its sound origin where it has no loop", async () => {
    const { bus } = await opened([HIT], files());
    const mover = entity({ number: 101, origin: vec3(0, -200, 26), soundOrigin: vec3(500, 0, 26) });
    bus.update({ ...quiet(), entities: [mover] });
    expect(bus.mixer.loopSounds[101].origin).toEqual([500, 0, 26]);
    bus.destroy();
  });

  it('repeats a speaker with a random on CHAN_ITEM, each wait give or take that', async () => {
    const { bus, context } = await opened([HIT], files());
    await bus.registerGameSounds(strings(FIRE));
    // `crandom()` at 0: every repeat is the wait, 2 s.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const repeating = entity({
      number: 100,
      origin: vec3(100, 0, 26),
      speaker: true,
      eventParm: 1,
      frame: 20,
      clientNum: 10
    });
    // A wait alone never repeats.
    const waiting = entity({ number: 101, origin: vec3(), speaker: true, eventParm: 1, frame: 20 });
    const at = (time: number) => {
      vi.mocked(performance.now).mockReturnValue(time);
      bus.update({ ...quiet(), time: time + 0.5, entities: [repeating, waiting] });
    };
    at(1000);
    expect(marks(context)).toEqual([5]);
    expect(bus.mixer.channels.find((ch) => ch.sfx)).toMatchObject({
      entnum: 100,
      entchannel: CHAN.ITEM
    });
    at(2999);
    expect(context.sources).toHaveLength(1);
    at(3000);
    expect(context.sources).toHaveLength(2);
    bus.destroy();
  });

  it("plays the player's own triggered sound on them, a `*` name in their own voice", async () => {
    const FALLING = 'sound/player/sarge/falling1.wav';
    const { bus, context } = await opened([HIT, FALLING], files());
    await bus.setPlayerModel('sarge', 'normal');
    await bus.registerGameSounds(strings(FIRE, '*falling1.wav'));
    bus.update({
      ...quiet(),
      events: [
        { event: EV.GENERAL_SOUND, parm: 1 },
        { event: EV.GENERAL_SOUND, parm: 2 }
      ]
    });
    expect(marks(context)).toEqual([5, 1]);
    const playing = bus.mixer.channels.filter((ch) => ch.sfx);
    expect(playing.map((ch) => [ch.entnum, ch.entchannel, ch.fullVolume])).toEqual([
      [0, CHAN.VOICE, true],
      [0, CHAN.VOICE, true]
    ]);
    bus.destroy();
  });

  it('fries the player in lava under any hum their weapon has', async () => {
    const { bus } = await opened([HIT, RAIL_HUM], files());
    await bus.registerGameSounds(strings(FRY));
    const frying = { ...quiet().player, loopSound: 1 };
    bus.update({ ...quiet(), player: frying });
    expect(loops(bus)).toEqual([[FRY, 63, 63]]);
    bus.update({ ...quiet(), weapon: WP.RAILGUN, player: frying });
    expect(loops(bus)).toEqual([[RAIL_HUM, 63, 63]]);
    bus.destroy();
  });

  it('finds a name whatever its case, and takes none of 64 characters', async () => {
    const printed: string[] = [];
    const asked: string[] = [];
    const { bus } = await opened([HIT], files(printed, asked));
    const long = `sound/${'x'.repeat(54)}.wav`;
    await bus.registerGameSounds(strings('SOUND/WORLD/FIRE1.WAV', FIRE, long));
    expect(asked).toEqual(['SOUND/WORLD/FIRE1.WAV']);
    expect(printed).toEqual([`^3WARNING: Sound name is too long: ${long}\n`]);
    bus.destroy();
  });

  it('plays a global sound from the listener on CHAN_AUTO, at full volume', async () => {
    const { bus } = await opened([HIT], files());
    await bus.registerGameSounds(strings(FIRE));
    bus.update({
      ...quiet(),
      effects: [{ type: 'gameSound', index: 1, name: FIRE, number: 0, origin: null }]
    });
    expect(bus.mixer.channels.find((ch) => ch.sfx)).toMatchObject({
      entnum: 0,
      entchannel: CHAN.AUTO,
      fullVolume: true
    });
    bus.destroy();
  });

  it("keeps a slot's sound when a cs names a model's own sound there", async () => {
    const printed: string[] = [];
    const { bus, context } = await opened([HIT], files(printed));
    await bus.registerGameSounds(strings(FIRE));
    bus.registerGameSound(1, '*falling1.wav');
    bus.update({
      ...quiet(),
      effects: [
        { type: 'gameSound', index: 1, name: '*falling1.wav', number: 70, origin: vec3(100, 0, 26) }
      ]
    });
    expect(printed).toEqual([]);
    expect(marks(context)).toEqual([5]);
    bus.destroy();
  });

  it("fries everyone else, and loops a missile's own sound, under any added after", async () => {
    const { bus } = await opened([HIT, ROCKET_FLY], files());
    await bus.registerGameSounds(strings(FRY));
    const missile = (number: number, weapon: number) => {
      const state = createEntityState(number);
      state.weapon = weapon;
      state.loopSound = 1;
      return { state, origin: vec3(100, 0, 26) };
    };
    const body = { origin: vec3(100, 0, 26), weapon: WP.GAUNTLET, firing: false, powerups: 0 };
    bus.update({
      ...quiet(),
      missiles: [missile(70, WP.ROCKET_LAUNCHER), missile(71, WP.GRENADE_LAUNCHER)],
      others: { entities: [{ number: 3, ...body, loopSound: 1 }], sounds: [], voice: () => null }
    });
    const { loopSounds } = bus.mixer;
    expect([3, 70, 71].map((n) => loopSounds[n].sfx?.name)).toEqual([FRY, ROCKET_FLY, FRY]);
    bus.destroy();
  });

  it("starts every speaker's time over as the match goes", async () => {
    const { bus, context } = await opened([HIT], files());
    await bus.registerGameSounds(strings(FIRE));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const repeating = entity({
      number: 100,
      origin: vec3(100, 0, 26),
      speaker: true,
      eventParm: 1,
      frame: 20,
      clientNum: 10
    });
    bus.update({ ...quiet(), time: 1000, entities: [repeating] });
    bus.clear();
    vi.mocked(performance.now).mockReturnValue(1100);
    bus.update({ ...quiet(), time: 1100, entities: [repeating] });
    expect(marks(context)).toEqual([5, 5]);
    bus.destroy();
  });

  it("times a speaker by cg.time's whole milliseconds", async () => {
    const { bus, context } = await opened([HIT], files());
    await bus.registerGameSounds(strings(FIRE));
    // `crandom()` at -0.005: a random of 0.1 s draws its wait half a millisecond short.
    vi.spyOn(Math, 'random').mockReturnValue(0.4975);
    const speaker = entity({
      number: 100,
      origin: vec3(100, 0, 26),
      speaker: true,
      eventParm: 1,
      frame: 20,
      clientNum: 1
    });
    const at = (time: number) => {
      vi.mocked(performance.now).mockReturnValue(Math.floor(time));
      bus.update({ ...quiet(), time, entities: [speaker] });
    };
    // From 1,000: 2 s less half a millisecond, truncated, is due at 2,999.
    at(1000.7);
    at(2999.2);
    expect(context.sources).toHaveLength(2);
    bus.destroy();
  });

  it('loads a stereo sound into two channels, each its own side', async () => {
    const STEREO = 'sound/world/stereo.wav';
    const stereo = pcmWav({ channels: 2, rate: 48000, samples: [1000, -1000, 2000, -2000] });
    const { bus, context } = await opened([HIT], {
      read: (path) => Promise.resolve(path === STEREO ? stereo : undefined),
      print: () => {}
    });
    await bus.registerGameSounds(strings(STEREO));
    bus.update({
      ...quiet(),
      effects: [{ type: 'gameSound', index: 1, name: STEREO, number: 70, origin: vec3(100, 0, 26) }]
    });
    const buffer = context.sources[0].buffer as unknown as FakeBuffer;
    expect(buffer.numberOfChannels).toBe(2);
    expect([buffer.getChannelData(0)[1], buffer.getChannelData(1)[1]]).toEqual([
      2000 / 32768,
      -2000 / 32768
    ]);
    bus.destroy();
  });

  it('plays a sound named mid-match at the first frame after it is read', async () => {
    const { bus, context } = await opened([HIT], files());
    await bus.registerGameSounds(strings(FIRE));
    bus.registerGameSound(2, BOBBER);
    const effects: SoundInput['effects'] = [
      { type: 'gameSound', index: 2, name: BOBBER, number: 70, origin: vec3(100, 0, 26) }
    ];
    bus.update({ ...quiet(), effects });
    expect(context.sources).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    bus.update(quiet());
    expect(marks(context)).toEqual([6]);
    bus.destroy();
  });
});

describe("SoundBus's music", () => {
  const INTRO = 'music/intro.wav';
  const LOOP = 'music/loop.wav';
  const SLOW = 'music/slow.wav';
  /** A stereo track at 22,050 of so many seconds, its first sample its mark. */
  const track = (mark: number, seconds: number) =>
    pcmWav({
      channels: 2,
      samples: Array.from({ length: 2 * 22050 * seconds }, (_, i) => (i === 0 ? mark : 0))
    });
  const paks = new Map([
    [INTRO, track(3, 1)],
    [LOOP, track(4, 3)]
  ]);
  /** The paks, a list of the names read, and a read of {@link SLOW} that waits to be let go. */
  const files = (asked: string[] = []) => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const read = async (path: string) => {
      asked.push(path);
      if (path === SLOW) await slow;
      return paks.get(normalizePakPath(path)) ?? (path === SLOW ? track(9, 1) : undefined);
    };
    return { files: { read, print: () => {} } as SoundFiles, release: () => release() };
  };
  /** Every read in. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** The music's gain, made after the master's, and the sources played into it. */
  const musicGain = (context: FakeContext) => context.gains[1];
  const music = (context: FakeContext) =>
    context.sources.filter((source) => source.into[0] === musicGain(context));
  /** The marks of the files the music's sources began, each file's first read carrying its own. */
  const marks = (context: FakeContext) =>
    music(context)
      .map((source) => source.buffer?.file)
      .filter((mark) => mark !== 0);
  /** The painted time, in frames at the fake's 48 kHz: the clock and `s_mixPreStep`'s 0.05 s. */
  const PRESTEP = 2400;
  /** Which of these reads plays across a frame. */
  const across = (reads: readonly MusicRead[], frame: number) =>
    reads.findIndex(({ start, frames }) => start < frame && start + frames > frame);

  it('plays the intro a CS_MUSIC names, then its loop with no gap, into its own gain', async () => {
    const asked: string[] = [];
    const { bus, context } = await opened([], files(asked).files);
    bus.volume = 0.8;
    bus.startMusic(`${INTRO} ${LOOP}`);
    await settle();
    bus.mix();
    expect(marks(context)).toEqual([3, 4]);
    expect(asked).toEqual([INTRO, LOOP]);
    // `s_musicvolume` × `s_volume` in 256ths, under no `snd_vol`.
    expect(musicGain(context).gain.value).toBe(51 / 256);
    expect(context.gains[0].gain.value).toBe(204 / 256);
    // The intro heard from the painted time, each read from the frame the last ended on, and the
    // loop from the frame the intro ends on.
    const reads = bus.music.queued;
    const sources = music(context);
    expect(sources[0].start).toHaveBeenCalledWith(PRESTEP / 48000, PRESTEP / 48000);
    const loop = reads.findIndex(({ name }) => name === LOOP);
    expect(loop).toBeGreaterThan(1);
    for (let i = 1; i < reads.length; i++) {
      expect(reads[i].start).toBe(reads[i - 1].start + reads[i - 1].frames);
      expect(sources[i].start).toHaveBeenCalledWith(reads[i].start / 48000, 0);
    }
    expect(reads[loop].pos).toBe(0);
    // Each read in a buffer of its own while it plays.
    expect(new Set(sources.map((source) => source.buffer)).size).toBe(sources.length);
    bus.destroy();
  });

  it('loops a lone name, and stops at an empty CS_MUSIC', async () => {
    const { bus, context } = await opened([], files().files);
    bus.startMusic(INTRO);
    await settle();
    bus.mix();
    expect(marks(context)).toEqual([3, 3]);
    const made = music(context).length;
    bus.startMusic('');
    for (const source of music(context)) expect(source.stop).toHaveBeenCalledWith();
    context.currentTime = 1;
    bus.mix();
    expect(music(context)).toHaveLength(made);
    bus.destroy();
  });

  it('starts again from the intro at the painted time, reading nothing again', async () => {
    const asked: string[] = [];
    const { bus, context } = await opened([], files(asked).files);
    bus.startMusic(`${INTRO} ${LOOP}`);
    await settle();
    bus.mix();
    const sources = music(context);
    const reads = [...bus.music.queued];
    context.currentTime = 0.5;
    bus.startMusic(`${INTRO} ${LOOP}`);
    await settle();
    // The read playing is cut at the painted time, those after it never play, and those before
    // play on.
    const painted = 24000 + PRESTEP;
    const at = across(reads, painted);
    expect(sources[at].stop).toHaveBeenCalledWith(painted / 48000);
    for (const source of sources.slice(at + 1)) expect(source.stop).toHaveBeenCalledWith();
    for (const source of sources.slice(0, at)) expect(source.stop).not.toHaveBeenCalled();
    bus.mix();
    const restarted = music(context)[sources.length];
    expect(restarted.buffer?.file).toBe(3);
    expect(restarted.start).toHaveBeenCalledWith(painted / 48000, 0);
    expect(asked).toEqual([INTRO, LOOP]);
    bus.destroy();
  });

  it('drops a read that comes in after the music was started again, or stopped', async () => {
    const slow = files();
    const { bus, context } = await opened([], slow.files);
    bus.startMusic(SLOW);
    bus.startMusic(INTRO);
    await settle();
    slow.release();
    await settle();
    bus.mix();
    expect(marks(context)).toEqual([3, 3]);

    const late = files();
    const second = await opened([], late.files);
    second.bus.startMusic(SLOW);
    second.bus.clear();
    late.release();
    await settle();
    second.bus.mix();
    expect(music(second.context)).toHaveLength(0);
    bus.destroy();
    second.bus.destroy();
  });

  it('stops the music as the match goes', async () => {
    const { bus, context } = await opened([], files().files);
    bus.startMusic(INTRO);
    await settle();
    bus.mix();
    bus.clear();
    for (const source of music(context)) expect(source.stop).toHaveBeenCalledWith();
    expect(bus.music.playing).toBe(false);
    bus.destroy();
  });

  it('holds the music at s_musicvolume 0, silent at once, and goes on from there', async () => {
    const { bus, context } = await opened([], files().files);
    bus.startMusic(INTRO);
    await settle();
    bus.mix();
    bus.musicVolume = 0;
    expect(musicGain(context).gain.value).toBe(0);
    // A frame on which the painted time falls in a sample's later half.
    const sources = music(context);
    const reads = [...bus.music.queued];
    const scale = Math.fround(22050 / 48000);
    const into = (clock: number) => {
      const read = reads[across(reads, clock + PRESTEP)];
      return { read, at: (clock + PRESTEP - read.start) * scale };
    };
    let clock = 12000;
    while (into(clock).at % 1 <= 0.5) clock++;
    const { read, at } = into(clock);
    context.currentTime = clock / 48000;
    bus.mix();
    const painted = clock + PRESTEP;
    expect(sources[across(reads, painted)].stop).toHaveBeenCalledWith(painted / 48000);
    context.currentTime = 10;
    bus.mix();
    expect(music(context)).toHaveLength(sources.length);
    bus.musicVolume = 0.25;
    // `s_volume` at the bus's 1: 64 of 256.
    expect(musicGain(context).gain.value).toBe(64 / 256);
    bus.mix();
    // From the sample the hold cut in, heard from the painted time.
    const pos = read.pos + Math.trunc(at) * 4;
    expect(bus.music.queued[0]).toMatchObject({ start: 480000, pos });
    expect(music(context)[sources.length].start).toHaveBeenCalledWith(
      (480000 + PRESTEP) / 48000,
      PRESTEP / 48000
    );
    bus.destroy();
  });

  it('writes each buffer again once played through, so a long track makes no more', async () => {
    const { bus, context } = await opened([], files().files);
    bus.startMusic(INTRO);
    await settle();
    let made = 0;
    for (let time = 0; time < 120; time += 0.25) {
      context.currentTime = time;
      bus.mix();
      if (time === 30) made = context.buffers.length;
    }
    expect(music(context).length).toBeGreaterThan(110);
    expect(context.buffers.length).toBe(made);
    expect(bus.musicBuffers).toBe(made);
    bus.destroy();
  });

  it('leaves silence after each read in a buffer written again, whatever it held', async () => {
    // Every sample loud, 1.1 s of them: four reads of a quarter second, then the tenth left.
    const loud = pcmWav({ channels: 2, samples: new Array<number>(2 * 24255).fill(16384) });
    const { bus, context } = await opened([], {
      read: (path) => Promise.resolve(path === LOOP ? loud : undefined),
      print: () => {}
    });
    bus.startMusic(LOOP);
    await settle();
    for (let time = 0; time < 30; time += 0.25) {
      context.currentTime = time;
      bus.mix();
    }
    const voices = music(context).slice(-bus.music.queued.length);
    expect(new Set(bus.music.queued.map(({ frames }) => frames)).size).toBeGreaterThan(1);
    for (const [i, { start, frames }] of bus.music.queued.entries()) {
      const data = voices[i].buffer as unknown as FakeBuffer;
      expect(start).toBeGreaterThan(0);
      expect(data.getChannelData(0)[frames - 1]).toBe(0.5);
      expect(data.getChannelData(0).subarray(frames).every((sample) => sample === 0)).toBe(true);
    }
    bus.destroy();
  });
});

describe("a body's footsteps", () => {
  const STEP = 'sound/player/footsteps/step1.wav';
  const CLANK = 'sound/player/footsteps/clank2.wav';
  const SPLASH = 'sound/player/footsteps/splash3.wav';
  const WATER_IN = 'sound/player/watr_in.wav';
  const steps: PlayerSound[] = [
    { type: 'footstep', variant: 1 },
    { type: 'footstep', variant: 2, set: 'metal' },
    { type: 'footstep', variant: 3, set: 'splash' },
    { type: 'shared', path: WATER_IN }
  ];
  /** A frame in which slot 3 and the player make these sounds, and nothing loops. */
  const stepping = (footsteps?: boolean): SoundInput => ({
    ...quiet(),
    player: { ...quiet().player, sounds: steps },
    others: {
      entities: [],
      sounds: steps.map((sound) => ({ number: 3, origin: vec3(), voice: 3, sound })),
      voice: () => null
    },
    ...(footsteps === undefined ? {} : { footsteps })
  });

  it("are the floor's or the water's set where it is named, the model's otherwise", async () => {
    const { bus, context } = await opened([STEP, CLANK, SPLASH, WATER_IN]);
    bus.update(stepping());
    // Slot 3's four, whose slot has no voice and so the normal set, then the player's.
    expect(context.sources.map((source) => source.buffer?.file)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    bus.destroy();
  });

  it('are none at all under cg_footsteps 0, which leaves every other sound', async () => {
    const { bus, context } = await opened([STEP, CLANK, SPLASH, WATER_IN]);
    bus.update(stepping(false));
    expect(context.sources.map((source) => source.buffer?.file)).toEqual([3, 3]);
    // The splash is still playing on each, so it is not started again within 50 ms.
    bus.update(stepping(true));
    expect(context.sources.map((source) => source.buffer?.file)).toEqual([3, 3, 0, 1, 2, 0, 1, 2]);
    bus.destroy();
  });
});
