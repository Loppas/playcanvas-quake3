import type { Footsteps } from '../formats/animation-config';
import type { AssetLibrary } from '../formats/asset-library';
import {
  ANNOUNCER_SOUNDS,
  CUSTOM_SOUNDS,
  FOOTSTEP_SETS,
  MENU_SOUND_FILES,
  WEAPON_ASSETS,
  type WeaponAssetSet
} from '../formats/asset-manifest';
import {
  MAX_QPATH,
  codecOpenStream,
  loadSound,
  resampleSfx,
  wavCodecLoad,
  type LoadedSound,
  type ReadSoundFile
} from '../formats/wav';
import { MAX_SOUNDS } from '../net/commands';
import { ENTITYNUM_WORLD } from '../net/protocol';
import { qvmAngleVectors } from '../sim/cm/q-math';
import { EV, eventNumber, type Event } from '../sim/events';
import { PW } from '../sim/items';
import { evaluateTrajectoryDelta } from '../sim/trajectory';
import { vec3, type Vec3 } from '../sim/vec3';
import type { WeaponId } from '../sim/weapons/constants';
import type { AnnouncerCue } from '../view/announcer';
import type { FirstPersonView } from '../view/camera-feel';
import type { WorldEffect } from '../view/entity-events';
import type { GibSound } from '../view/fragments';
import type { MenuSound } from '../view/menu';
import {
  BackgroundTrack,
  musicNames,
  musicReadFrames,
  musicVolume,
  type MusicFile,
  type MusicRead,
  type MusicSink
} from '../view/music';
import type { EntitySound, EntitySoundKind } from '../view/other-player-events';
import {
  customSoundName,
  customSoundPath,
  type CustomSound,
  type PlayerSound
} from '../view/player-events';
import type { MissileCentity, SoundCentity } from '../view/player-view';
import type { Voice as ModelVoice } from '../view/player-model';
import { WEAR_OFF_SOUND, itemAt, pickupSound, useItemSound } from '../view/item-sounds';
import { QUAD_SOUND, FLIGHT_SOUND, powerupEventSound } from '../view/powerup-sounds';
import { powerupsWearingOff } from '../view/powerup-timers';
import { CHAN, MAX_CHANNELS, SoundMixer, sndVol, type MixerSfx } from '../view/sound-mixer';
import { SpeakerSchedule } from '../view/speakers';
import { playsFireSound, weaponLoop } from '../view/weapon-sounds';

/**
 * The sound bus: Quake 3's base mixer (`view/sound-mixer.ts`) played through Web Audio.
 *
 * Each of the mixer's 96 channels is a voice: a source into two gains, one an ear, set each frame
 * to the channel's ear volumes over 256. Each merged loop is a looping voice of its sound, started
 * at the context's clock modulo its length, so every loop of a sound is in phase and one dropped
 * for a frame comes back in phase, as Quake 3 paints a loop from `s_paintedtime`. A Doppler loop
 * is a voice of its own, played at its scale. Every voice goes through a master gain of `s_volume`
 * as the mixer's `snd_vol`, over 256, so an ear's gain is its volume × `snd_vol` / 65,536, as
 * `S_PaintChannelFrom16` scales a sample.
 *
 * The frame is cgame's (`CG_DrawActiveFrame`): the loops cleared, the snapshot's events started,
 * the entities placed and their loops added, the predicted player first, and the listener placed
 * last, from the view. A sound starts on the channel `CHAN_AUTO`, the menu's and the announcer's
 * on theirs, and the match's named sounds on Quake 3's: the mixer keeps a channel only to spare
 * the announcer's.
 *
 * Every sound is read by Quake 3's reader and resampled to the context's rate as Quake 3 resamples
 * it (`formats/wav.ts`). The match's own, `CS_SOUNDS`, are registered as cgame registers them: a
 * file that will not load is handle 0, the hit, with Quake 3's warning, looped where it loops.
 *
 * The music is the background track (`view/music.ts`), its reads queued on the context's clock
 * into a gain of its own, `s_musicvolume` × `s_volume`, as Quake 3 writes it under no `snd_vol`.
 */

/** A sound the bus plays: one file, decoded once and known by its name, as Quake 3's `sfx_t`. */
export interface Sfx extends MixerSfx {
  readonly buffer: AudioBuffer;
}

/** What the player's own entity is this frame: the predicted player, which cgame adds first. */
export interface PlayerSoundInput {
  /** `cg.snap->ps.clientNum`: the listener's entity, which the player's every sound is on. */
  number: number;
  /** `lerpOrigin`: where the body is. */
  origin: Vec3;
  /**
   * The entity is `ET_PLAYER`, and so hums and flies; at the intermission, for a spectator and
   * once gibbed it is `ET_INVISIBLE`, and has no `CG_Player`.
   */
  body: boolean;
  /** `ps.loopSound`: the `CS_SOUNDS` slot of the fry in lava or slime, or 0. */
  loopSound: number;
  /** The body's sounds. */
  sounds: readonly PlayerSound[];
  /** The gibs' splats, each where it hit. */
  splats: readonly GibSound[];
}

/** Another player, or a corpse, as its sounds hear it. */
export interface SoundEntity {
  /** Its entity number, which its sounds are started on. */
  number: number;
  /** `lerpOrigin`: where it is drawn this frame. */
  origin: Vec3;
  /** The weapon in its hand, for the weapon's loop. */
  weapon: WeaponId;
  /** `EF_FIRING`: the loop is the weapon's firing sound rather than its ready sound. */
  firing: boolean;
  /** `es.powerups`: the bitmask of what it holds, for the flight powerup's loop. */
  powerups: number;
  /** `s.loopSound`: the `CS_SOUNDS` slot of its fry, or 0. */
  loopSound: number;
}

/** Everyone else this frame. */
export interface OthersSoundInput {
  /**
   * Every other player and corpse drawn: where each is, and what it holds
   * (`CG_AddPlayerWeapon`).
   */
  entities: readonly SoundEntity[];
  /** What they sounded this frame. */
  sounds: readonly EntitySound[];
  /** Whose voice a slot's body has, or `null` while it has none yet. */
  voice(number: number): ModelVoice | null;
}

/** Everything the bus needs about this frame. */
export interface SoundInput {
  /** What happened in the world: the impacts, and the sounds the client read off its entities. */
  effects: readonly WorldEffect[];
  /** The player's own events off their player state; the weapon change is here, not in the
   * effect list. */
  events: readonly Event[];
  /** The projectiles in flight, each where it is drawn, for their looping flight sounds. */
  missiles: readonly Pick<MissileCentity, 'state' | 'origin'>[];
  /** Every other entity the snapshot carried: the speakers, the movers and the rest. */
  entities?: readonly SoundCentity[];
  /** `cg.time`, which is how fast along its trajectory each missile is going. */
  time: number;
  /** Weapon in hand, for its loop. */
  weapon: WeaponId;
  /** `EF_FIRING`: the loop is the weapon's firing sound rather than its ready sound. */
  firing: boolean;
  /** `ps.powerups`: the end time of each powerup held, for the wear-off tick and the flight. */
  powerups: readonly number[];
  /** The player's own entity. */
  player: PlayerSoundInput;
  /** Everyone else. */
  others?: OthersSoundInput;
  /** `cg.refdef`'s origin and the angles of its axis: where the listener is. */
  view: Readonly<FirstPersonView>;
  /** `cg.hyperspace`: no entity is added, and so no loop, this frame. */
  hyperspace?: boolean;
  /** A `map_restart` this frame's snapshots ran, which clears every loop (`CG_MapRestart`). */
  mapRestart?: boolean;
  /**
   * `cg_footsteps`: false silences every body's footsteps, splashes and clanks
   * (`cg_event.c:552–586`). True when absent.
   */
  footsteps?: boolean;
  /** `s_doppler`. On when absent. */
  doppler?: boolean;
}

/** Where the bus reads the match's sounds from, and where it says what Quake 3 would. */
export interface SoundFiles {
  /** A file from the paks, by its name. */
  read: ReadSoundFile;
  /** `Com_Printf`. */
  print: (text: string) => void;
}

/** No paks: every sound the match names is missing. */
const NO_FILES: SoundFiles = { read: () => Promise.resolve(undefined), print: () => {} };

/**
 * What a `CS_SOUNDS` slot holds (`cgs.gameSounds`): its sound, `null` for handle 0, or the read of
 * a sound registered mid-match, which a play of it waits for.
 */
type GameSound = Sfx | null | Promise<Sfx | null>;

/**
 * Handle 0, which `S_BeginRegistration` registers first, "changed to a sound in baseq3"
 * (`snd_dma.c:402`): what plays for a sound that would not load.
 */
const DEFAULT_SOUND = ANNOUNCER_SOUNDS.hit;

/** No velocity: what every loop but a missile's is added with. */
const AT_REST = vec3();

/**
 * A sound as the mix plays it: its samples at the context's rate in a buffer, a stereo one in two
 * channels and any other in one, as `S_PaintChannelFrom16` reads them, and nothing for a sound of
 * no channels. A buffer cannot be empty, so a sound of no samples has one of silence.
 */
function sfxOf(context: BaseAudioContext, name: string, sound: LoadedSound): Sfx {
  const { length, channels, data } = sound;
  const stereo = channels === 2;
  const buffer = context.createBuffer(stereo ? 2 : 1, Math.max(length, 1), context.sampleRate);
  if (stereo) {
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < length; i++) {
      left[i] = data[2 * i] / 32768;
      right[i] = data[2 * i + 1] / 32768;
    }
  } else if (channels > 0) {
    const mono = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) mono[i] = data[i] / 32768;
  }
  return { name, buffer, length };
}

/** A file in hand read and resampled as Quake 3 loads it, or `null` for one it refuses. */
function sfxFrom(
  context: BaseAudioContext,
  name: string,
  bytes: Uint8Array,
  print: (text: string) => void
): Sfx | null {
  const loaded = wavCodecLoad(bytes, name, print);
  return loaded ? sfxOf(context, name, resampleSfx(loaded, context.sampleRate)) : null;
}

/** "could not find %s - using default" (`snd_dma.c:380`). */
function couldNotFind(name: string): string {
  return `^3WARNING: could not find ${name} - using default\n`;
}

/** Whether a sound is still being read. */
function reading(sound: GameSound): sound is Promise<Sfx | null> {
  return sound instanceof Promise;
}

/** A sound playing in the two ears: its source, into a gain an ear, into the master. */
class Voice {
  /** The bus's frame the voice was last heard in, for a loop's. */
  heard = 0;
  sfx: Sfx | null = null;
  private source: AudioBufferSourceNode | null = null;
  private readonly context: AudioContext;
  private readonly left: GainNode;
  private readonly right: GainNode;
  /** A stereo sound's ears, made at the first. */
  private splitter: ChannelSplitterNode | null = null;
  private leftvol = 0;
  private rightvol = 0;
  private scale = 1;

  constructor(context: AudioContext, destination: AudioNode) {
    this.context = context;
    this.left = context.createGain();
    this.right = context.createGain();
    this.left.gain.value = 0;
    this.right.gain.value = 0;
    const merger = context.createChannelMerger(2);
    this.left.connect(merger, 0, 0);
    this.right.connect(merger, 0, 1);
    merger.connect(destination);
  }

  /**
   * Play a sound in place of whatever the voice was playing.
   *
   * @param offset - Where in it to begin, in seconds.
   */
  play(sfx: Sfx, loop: boolean, offset: number): void {
    this.stop();
    const source = this.context.createBufferSource();
    source.buffer = sfx.buffer;
    source.loop = loop;
    if (sfx.buffer.numberOfChannels > 1) {
      // Each ear its own side, as the mixer paints a stereo sound.
      if (!this.splitter) {
        this.splitter = this.context.createChannelSplitter(2);
        this.splitter.connect(this.left, 0);
        this.splitter.connect(this.right, 1);
      }
      source.connect(this.splitter);
    } else {
      source.connect(this.left);
      source.connect(this.right);
    }
    source.start(0, offset);
    this.source = source;
    this.sfx = sfx;
    this.scale = 1;
  }

  /** The two ear volumes, 0–255, each over 256. */
  set(leftvol: number, rightvol: number): void {
    if (leftvol !== this.leftvol) {
      this.leftvol = leftvol;
      this.left.gain.value = leftvol / 256;
    }
    if (rightvol !== this.rightvol) {
      this.rightvol = rightvol;
      this.right.gain.value = rightvol / 256;
    }
  }

  /** A Doppler loop's scale: how many of its samples are read for each one played. */
  rate(scale: number): void {
    if (!this.source || scale === this.scale) return;
    this.scale = scale;
    this.source.playbackRate.value = scale;
  }

  stop(): void {
    if (!this.source) return;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
    this.sfx = null;
  }
}

/** How long a music buffer rests once played through before it is written again, in seconds. */
const MUSIC_BUFFER_REST = 0.5;

/** A read of the music playing: its buffer and source, and the frame its buffer is played to. */
interface MusicVoice {
  buffer: AudioBuffer;
  source: AudioBufferSourceNode;
  start: number;
  until: number;
}

/**
 * The music's reads played: each written into a buffer of the queue's own and played by a source
 * started on the context's clock at the read's frame, into the music's gain. A buffer holds a whole
 * read with silence after it, so a source plays its buffer through while the next read's starts on
 * the frame the last ended on. A buffer played through is kept and written again.
 */
class MusicQueue implements MusicSink {
  /** `S_Base_RawSamples`' volume over 256. */
  readonly gain: GainNode;
  /** The voices, and the buffers resting. */
  readonly voices: MusicVoice[] = [];
  readonly spare: AudioBuffer[] = [];
  private readonly context: AudioContext;
  /** Each buffer's frames. */
  private readonly length: number;
  private readonly samples: Float32Array<ArrayBuffer>;

  constructor(context: AudioContext, length: number) {
    this.context = context;
    this.length = length;
    this.samples = new Float32Array(length);
    this.gain = context.createGain();
    this.gain.connect(context.destination);
  }

  queue(read: MusicRead, from: number, left: Int16Array, right: Int16Array): void {
    const { context } = this;
    const rate = context.sampleRate;
    this.rest(Math.round(context.currentTime * rate));
    const buffer = this.spare.pop() ?? context.createBuffer(2, this.length, rate);
    this.write(buffer, 0, left, read.frames);
    this.write(buffer, 1, right, read.frames);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const when = Math.max(read.start, from);
    source.start(when / rate, (when - read.start) / rate);
    this.voices.push({ buffer, source, start: read.start, until: read.start + this.length });
  }

  cut(frame: number): void {
    const rate = this.context.sampleRate;
    const now = Math.round(this.context.currentTime * rate);
    for (const voice of this.voices) {
      if (voice.until <= frame) continue;
      if (frame <= now || voice.start >= frame) {
        // Not begun, or to stop now: it never sounds again.
        voice.source.stop();
        voice.until = Math.min(voice.until, now);
      } else {
        voice.source.stop(frame / rate);
        voice.until = frame;
      }
    }
  }

  /** The buffers played through and rested, kept to be written again. */
  private rest(clock: number): void {
    const rested = clock - Math.round(MUSIC_BUFFER_REST * this.context.sampleRate);
    let kept = 0;
    for (const voice of this.voices) {
      if (voice.until <= rested) {
        voice.source.disconnect();
        this.spare.push(voice.buffer);
      } else {
        this.voices[kept++] = voice;
      }
    }
    this.voices.length = kept;
  }

  /** An ear's samples into a buffer's channel, and silence after them. */
  private write(buffer: AudioBuffer, channel: number, ear: Int16Array, frames: number): void {
    const { samples } = this;
    for (let i = 0; i < frames; i++) samples[i] = ear[i] / 32768;
    samples.fill(0, frames);
    buffer.copyToChannel(samples, channel);
  }
}

export class SoundBus {
  /** The mixer's state, which a live check reads. */
  readonly mixer = new SoundMixer<Sfx>();
  /** The background track's, and its queue's. */
  readonly music: BackgroundTrack;
  private readonly musicQueue: MusicQueue;
  private readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly library: AssetLibrary;
  private readonly files: SoundFiles;
  /**
   * Every sound loaded, by its name as `S_FindName` compares one: without regard to case, and a
   * `\` not a `/`.
   */
  private readonly sounds: Map<string, Sfx>;
  /** Each name that would not load, and what its load said, which each registration says again. */
  private readonly refused = new Map<string, { name: string; said: string[] }>();
  /** Each sound being read, which a registration of its name waits on. */
  private readonly readingSounds = new Map<string, Promise<Sfx | null>>();
  /** `cgs.gameSounds`. */
  private readonly gameSounds: GameSound[] = new Array<GameSound>(MAX_SOUNDS).fill(null);
  /** `CS_SOUNDS` as cgame has it, for a slot that holds handle 0, whose name is played instead. */
  private readonly gameSoundNames: string[] = new Array<string>(MAX_SOUNDS).fill('');
  /** Starts waiting on their sounds' reads, started at the first frame after the read is done. */
  private readonly waiting: Array<{
    entityNum: number;
    channel: number;
    sound: Promise<Sfx | null>;
    read: Sfx | null | undefined;
  }> = [];
  /** `CG_Speaker`'s times. */
  private readonly speakers = new SpeakerSchedule();
  private readonly assets = new Map<WeaponId, WeaponAssetSet>();
  /** `s_volume`. */
  private sVolume = 1;
  /** `s_musicvolume`. */
  private sMusicVolume = 0.25;
  /**
   * The music's files, opened by the names the last start gave, kept for a start that names them
   * again: a `map_restart` reads nothing.
   */
  private musicFiles = new Map<string, Promise<MusicFile>>();
  /** Bumped by each start and stop of the music, so a read that comes in late is dropped. */
  private musicGeneration = 0;

  /** Each model's own sounds, sarge's where it lacks one, decoded once a body wears it. */
  private readonly voices = new Map<string, Map<CustomSound, Sfx>>();
  /** Each model's decoding, so a model is decoded once however many bodies wear it. */
  private readonly decoding = new Map<string, Promise<void>>();
  /** The player's own voice: the chosen model's, once its sounds are in. */
  private ownVoice: ModelVoice | null = null;
  /** Bumped by each {@link setPlayerModel}, so one still decoding gives way to the next. */
  private modelGeneration = 0;

  /** Each channel's voice, made at the channel's first sound. */
  private readonly channelVoices: (Voice | undefined)[] = new Array(MAX_CHANNELS);
  /** Each sound's loop, kept for the match once it has been heard. */
  private readonly loopVoices = new Map<Sfx, Voice>();
  private readonly loopVoiceList: Voice[] = [];
  /** Each Doppler loop's, by the entity it is pitched for. */
  private readonly dopplerVoices = new Map<number, Voice>();
  /** Voices whose loops went, for the next. */
  private readonly spareVoices: Voice[] = [];
  /** Counted by each {@link update}, for which loops were heard in it. */
  private frame = 0;

  /**
   * `cent->pe.lightningFiring` of the player's own entity: whether their weapon's firing loop was
   * added the frame before.
   */
  private lightningFiring = false;
  /** `cg.oldTime`: the last frame's time, which the wear-off tick is measured against. */
  private oldTime: number | null = null;
  /** `cg.refdef.viewaxis`, and the right `AngleVectors` gives. */
  private readonly axis: [number[], number[], number[]] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  private readonly right = [0, 0, 0];
  private readonly angles = [0, 0, 0];
  private readonly velocity = vec3();
  private detachResume: () => void = () => {};

  private constructor(
    context: AudioContext,
    library: AssetLibrary,
    files: SoundFiles,
    sounds: Map<string, Sfx>
  ) {
    this.context = context;
    this.library = library;
    this.files = files;
    this.sounds = sounds;
    this.master = context.createGain();
    this.master.gain.value = sndVol(this.sVolume) / 256;
    this.master.connect(context.destination);
    this.musicQueue = new MusicQueue(context, musicReadFrames(context.sampleRate));
    this.musicQueue.gain.gain.value = musicVolume(this.sMusicVolume, this.sVolume) / 256;
    this.music = new BackgroundTrack(context.sampleRate, this.musicQueue, files.print);
    for (const asset of WEAPON_ASSETS) this.assets.set(asset.id, asset);

    // A page cannot start audio until the user has interacted with it. The game needs a click
    // for pointer lock anyway, so the first one doubles as the unlock.
    const resume = () => {
      void this.context.resume();
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    this.detachResume = () => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
  }

  /**
   * Load every sound the manifest extracted, once.
   *
   * A model's own sounds are left until a body wears the model: the library holds sarge's beside
   * the chosen model's, and the sounds of any model read later, and only the worn ones are wanted.
   *
   * @param library - The extracted assets.
   * @param onDecoded - Called as each sound is loaded: how many are, of how many, and the one
   *   just loaded.
   * @param files - Where the match's own sounds are read from, and Quake 3's warnings go.
   */
  static async create(
    library: AssetLibrary,
    onDecoded: (done: number, total: number, path: string) => void = () => {},
    files: SoundFiles = NO_FILES
  ): Promise<SoundBus> {
    const context = new AudioContext();
    const sounds = new Map<string, Sfx>();
    const modelSounds = new Set(library.playerModels.map(({ model }) => `sound/player/${model}/`));
    const paths = [...library.files.keys()].filter(
      (path) => path.endsWith('.wav') && !modelSounds.has(path.slice(0, path.lastIndexOf('/') + 1))
    );

    let yielded = performance.now();
    for (const [i, path] of paths.entries()) {
      const sfx = sfxFrom(context, path, library.files.get(path)!, files.print);
      if (sfx) sounds.set(path, sfx);
      onDecoded(i + 1, paths.length, path);
      // The load screen is drawn between the loads.
      if (performance.now() - yielded > 16) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        yielded = performance.now();
      }
    }

    return new SoundBus(context, library, files, sounds);
  }

  /**
   * Take the chosen model's own sounds, and its footsteps: `CG_LoadClientInfo`'s sounds,
   * each the model's own or sarge's (`cg_players.c:705–722`).
   *
   * @param footsteps - The set its `animation.cfg` names.
   * @returns once they are decoded; a later call supersedes one still decoding
   */
  async setPlayerModel(model: string, footsteps: Footsteps): Promise<void> {
    const generation = ++this.modelGeneration;
    await this.loadVoice(model);
    if (generation === this.modelGeneration) this.ownVoice = { model, footsteps };
  }

  /**
   * `CG_RegisterSounds`' `CS_SOUNDS` (`cg_main.c:715-724`), at each gamestate: each slot's sound
   * read and registered, from the first slot to the first empty one, a model's own `*` sounds left
   * to their models.
   *
   * @param configstring - `CG_ConfigString( CS_SOUNDS + index )`.
   * @param onRegistered - Called as each slot is: how many are, of how many, and its name.
   * @returns once every sound is in
   */
  async registerGameSounds(
    configstring: (index: number) => string,
    onRegistered: (done: number, total: number, name: string) => void = () => {}
  ): Promise<void> {
    this.gameSounds.fill(null);
    for (let i = 0; i < MAX_SOUNDS; i++) this.gameSoundNames[i] = configstring(i);
    const empty = this.gameSoundNames.indexOf('', 1);
    const count = (empty === -1 ? MAX_SOUNDS : empty) - 1;
    for (let i = 1; i <= count; i++) {
      const name = this.gameSoundNames[i];
      if (name[0] !== '*') this.gameSounds[i] = await this.registerSound(name);
      onRegistered(i, count, name);
    }
  }

  /**
   * `CG_ConfigStringModified`'s `CS_SOUNDS` (`cg_servercmds.c:347-350`): a slot named mid-match,
   * its sound registered, a `*` name leaving the slot as it was. A play of it waits for its read.
   */
  registerGameSound(index: number, name: string): void {
    this.gameSoundNames[index] = name;
    if (name[0] === '*') return;
    const sound = this.registerSound(name);
    this.gameSounds[index] = sound;
    if (reading(sound)) {
      void sound.then((sfx) => {
        if (this.gameSounds[index] === sound) this.gameSounds[index] = sfx;
      });
    }
  }

  /**
   * `S_Base_RegisterSound` (`snd_dma.c:353-385`), by `S_FindName`'s rules: a name already loaded is
   * its sound; one that would not load is loaded again, which says what it said again, and is
   * handle 0; anything else is read.
   */
  private registerSound(name: string): GameSound {
    const { print } = this.files;
    if (!name) {
      print('^3WARNING: Sound name is empty\n');
      return null;
    }
    if (name.length >= MAX_QPATH) {
      print(`^3WARNING: Sound name is too long: ${name}\n`);
      return null;
    }
    if (name[0] === '*') {
      print(`^3WARNING: Tried to load player sound directly: ${name}\n`);
      return null;
    }
    const key = name.toLowerCase();
    const sfx = this.sounds.get(key);
    if (sfx) return sfx;
    const refused = this.refused.get(key);
    if (refused) {
      for (const text of refused.said) print(text);
      print(couldNotFind(refused.name));
      return null;
    }
    let read = this.readingSounds.get(key);
    if (!read) {
      read = this.readSound(name, key);
      this.readingSounds.set(key, read);
    }
    return read;
  }

  /** `S_memoryLoad` of a name not yet read: its sound, or `null` with Quake 3's warning. */
  private async readSound(name: string, key: string): Promise<Sfx | null> {
    const said: string[] = [];
    const print = (text: string) => {
      said.push(text);
      this.files.print(text);
    };
    const loaded = await loadSound(name, this.files.read, this.context.sampleRate, print);
    this.readingSounds.delete(key);
    if (!loaded) {
      this.refused.set(key, { name, said });
      this.files.print(couldNotFind(name));
      return null;
    }
    const sfx = sfxOf(this.context, name, loaded);
    this.sounds.set(key, sfx);
    return sfx;
  }

  /**
   * `s_volume`, which the mix scales every sound by as `snd_vol`, its 255ths
   * (`snd_mix.c:520-523`).
   */
  get volume(): number {
    return this.sVolume;
  }

  set volume(value: number) {
    if (value === this.sVolume) return;
    this.sVolume = value;
    this.master.gain.value = sndVol(value) / 256;
    this.musicQueue.gain.gain.value = musicVolume(this.sMusicVolume, value) / 256;
  }

  /**
   * `s_musicvolume`, which with `s_volume` makes the music's volume. At 0 or below the music holds
   * its place.
   */
  get musicVolume(): number {
    return this.sMusicVolume;
  }

  set musicVolume(value: number) {
    if (value === this.sMusicVolume) return;
    this.sMusicVolume = value;
    this.musicQueue.gain.gain.value = musicVolume(value, this.sVolume) / 256;
  }

  /**
   * `CG_StartMusic` (`cg_main.c:1174-1184`): the music a `CS_MUSIC` names, from its intro, or none
   * for an empty one. Each file is read from the paks and opened as `S_CodecOpenStream` opens it;
   * the intro takes over from what was playing once it is read, and the loop follows it once both
   * are.
   */
  startMusic(configstring: string): void {
    const { intro, loop } = musicNames(configstring);
    const generation = ++this.musicGeneration;
    if (!intro) {
      this.music.stop();
      return;
    }
    const files = new Map<string, Promise<MusicFile>>();
    for (const name of [intro, loop]) {
      files.set(name, files.get(name) ?? this.musicFiles.get(name) ?? this.openMusic(name));
    }
    this.musicFiles = files;
    void files.get(intro)!.then((introFile) => {
      if (generation !== this.musicGeneration) return;
      this.music.start(introFile, this.clock());
      void files.get(loop)!.then((loopFile) => {
        if (generation === this.musicGeneration) this.music.setLoop(loopFile);
      });
    });
  }

  /** How many buffers the music's queue has made, those resting among them. */
  get musicBuffers(): number {
    return this.musicQueue.voices.length + this.musicQueue.spare.length;
  }

  /**
   * One of the menu's four sounds: `S_StartLocalSound` on `CHAN_LOCAL_SOUND`, from the listener's
   * own entity, so heard at full volume. The same sound again within 50 ms is dropped, as from any
   * entity, so a page going back, which Q3 starts the out sound for twice, plays it once.
   */
  playMenu(cue: MenuSound): void {
    this.playLocal(MENU_SOUND_FILES[cue], CHAN.LOCAL_SOUND);
  }

  /**
   * One of the announcer's voices, or a hit beep: `S_StartLocalSound` as the menu's are, the
   * voices on `CHAN_ANNOUNCER` and the beeps on `CHAN_LOCAL_SOUND` (`cg_playerstate.c:318-328`).
   */
  playAnnouncer(cue: AnnouncerCue): void {
    const beep = cue === 'hit' || cue === 'hitTeam';
    this.playLocal(ANNOUNCER_SOUNDS[cue], beep ? CHAN.LOCAL_SOUND : CHAN.ANNOUNCER);
  }

  /**
   * A frame of the match's sound, in `CG_DrawActiveFrame`'s order (`cg_view.c:779-843`): the
   * loops cleared, the snapshots' sounds started, the entities placed and their loops added, the
   * powerups' tick, and the listener placed.
   */
  update(input: SoundInput): void {
    const { mixer } = this;
    const { player } = input;
    const now = Math.floor(performance.now());
    const footsteps = input.footsteps ?? true;
    mixer.doppler = input.doppler ?? true;

    mixer.clearLoopingSounds(false);
    // `CG_MapRestart` clears every loop, the real ones too, as the snapshots run it.
    if (input.mapRestart) mixer.clearLoopingSounds(true);

    this.startWaiting(now);
    this.playEffects(input.effects, now);
    if (input.others) this.playOthers(input.others, footsteps, now);
    this.playOwnEvents(input, now);
    this.playPlayer(player, footsteps, now);

    // `CG_AddPacketEntities`, which hyperspace skips (`cg_view.c:816-821`).
    if (!input.hyperspace) {
      // The predicted player first: `CG_EntityEffects`, then `CG_Player`'s weapon and flight, the
      // last loop added to an entity winning.
      mixer.updateEntityPosition(player.number, player.origin);
      this.addLoop(player.number, player.origin, player.loopSound, false);
      if (player.body) {
        this.lightningFiring = this.addPlayerWeapon(
          player.number,
          player.origin,
          input.weapon,
          input.firing
        );
        if (input.powerups[PW.FLIGHT]) this.addFlight(player.number, player.origin);
      }
      if (input.entities) this.addEntities(input.entities, input.time, now);
      if (input.others) this.addOthers(input.others);
      this.addMissiles(input.missiles, input.time);
    }

    this.powerupTick(player.number, input.powerups, input.time, now);
    this.respatialize(player.number, input.view);
  }

  /**
   * `S_Update`, once a frame of the page's whether a match runs or not: the music read on, and each
   * sound the mix has played out frees its channel.
   */
  mix(): void {
    const clock = this.clock();
    this.music.update(clock, this.sMusicVolume);
    this.mixer.scanChannelStarts(clock);
  }

  /**
   * `S_StopAllSounds` (`snd_dma.c:719-728`), as the match goes: the music stopped, every sound
   * stopped, the loops cleared, and every channel free.
   */
  clear(): void {
    this.musicGeneration++;
    this.musicFiles.clear();
    this.music.stop();
    this.mixer.clearSoundBuffer();
    this.waiting.length = 0;
    // `CG_Init`'s clear of `cg_entities`, for the next gamestate's cgame.
    this.speakers.clear();
    for (const voice of this.channelVoices) voice?.stop();
    for (const voice of this.loopVoiceList) this.retire(voice);
    this.loopVoices.clear();
    this.loopVoiceList.length = 0;
    for (const voice of this.dopplerVoices.values()) this.retire(voice);
    this.dopplerVoices.clear();
    this.lightningFiring = false;
    this.oldTime = null;
  }

  /** How many loops are sounding: the merge's channels this frame. */
  get loops(): number {
    return this.mixer.numLoopChannels;
  }

  /** Stop everything and release the context. */
  destroy(): void {
    this.detachResume();
    this.clear();
    void this.context.close();
  }

  /**
   * A model's own sounds, decoded once however many bodies wear it (`CG_LoadClientInfo`,
   * `cg_players.c:705–722`): the model's own file for each, or sarge's where it has none, which is
   * then the same sound as sarge's own.
   *
   * Read as a client's string arrives, with their models, so that a body is heard from the first
   * frame it is drawn; one whose look nobody read ahead decodes on being drawn instead. Either
   * way the model's files are in the library first, since the sounds are read out of them.
   *
   * @returns once they are decoded
   */
  loadVoice(model: string): Promise<void> {
    let decoding = this.decoding.get(model);
    if (!decoding) {
      decoding = this.decodeVoice(model);
      this.decoding.set(model, decoding);
    }
    return decoding;
  }

  private async decodeVoice(model: string): Promise<void> {
    const has = (path: string) => this.library.read(path) !== undefined;
    const sounds = new Map<CustomSound, Sfx>();
    for (const name of CUSTOM_SOUNDS) {
      const path = customSoundPath(model, name, has);
      let sfx = this.sounds.get(path);
      const bytes = sfx ? undefined : this.library.read(path);
      if (bytes) {
        sfx = sfxFrom(this.context, path, bytes, this.files.print) ?? undefined;
        if (sfx) this.sounds.set(path, sfx);
      }
      if (sfx) sounds.set(name, sfx);
    }
    this.voices.set(model, sounds);
  }

  /** `S_StartLocalSound`, from outside the frame or within it. */
  private playLocal(path: string, channel: number): void {
    const sfx = this.sounds.get(path);
    if (!sfx) return;
    const index = this.mixer.startLocalSound(sfx, channel, Math.floor(performance.now()));
    if (index >= 0) this.voice(index, sfx);
  }

  /**
   * `S_StartSound`, on `CHAN_AUTO` unless told: at a place of its own, or on an entity, wherever
   * that is heard from as it moves.
   */
  private start(
    origin: Vec3 | null,
    entityNum: number,
    sfx: Sfx | undefined,
    time: number,
    channel: number = CHAN.AUTO
  ): void {
    if (!sfx) return;
    const index = this.mixer.startSound(origin, entityNum, channel, sfx, time);
    if (index >= 0) this.voice(index, sfx);
  }

  /**
   * `S_StartSound` of a registered sound on an entity: handle 0 plays the hit, and a sound still
   * being read is started at the first frame after it is in.
   */
  private startGameSound(entityNum: number, channel: number, sound: GameSound, time: number): void {
    if (reading(sound)) {
      const wait = { entityNum, channel, sound, read: undefined as Sfx | null | undefined };
      this.waiting.push(wait);
      void sound.then((sfx) => (wait.read = sfx));
      return;
    }
    this.start(null, entityNum, sound ?? this.sounds.get(DEFAULT_SOUND), time, channel);
  }

  /** The starts whose sounds' reads are done, each where its entity is heard from by now. */
  private startWaiting(time: number): void {
    const { waiting } = this;
    let kept = 0;
    for (const wait of waiting) {
      if (wait.read === undefined) {
        waiting[kept++] = wait;
        continue;
      }
      this.startGameSound(wait.entityNum, wait.channel, wait.read, time);
    }
    waiting.length = kept;
  }

  /**
   * `CG_EntityEvent`'s `EV_GENERAL_SOUND` and `EV_GLOBAL_SOUND` (`cg_event.c:1020-1038`): the
   * slot's sound or, where it holds handle 0, `CG_CustomSound` of its name. A `*` name is a model's
   * own sound, in the voice of `voice`; any other is registered again, which says again what its
   * load said.
   *
   * @param voice - The voice a `*` name is in, if it is the player's own.
   */
  private playGameSound(
    entityNum: number,
    channel: number,
    index: number,
    name: string,
    voice: ModelVoice | null,
    time: number
  ): void {
    const sound = this.gameSounds[index];
    if (sound !== null) {
      this.startGameSound(entityNum, channel, sound, time);
    } else if (name[0] === '*') {
      const custom = customSoundName(name);
      const sfx = custom && voice ? this.voices.get(voice.model)?.get(custom) : undefined;
      this.start(null, entityNum, sfx, time, channel);
    } else {
      this.startGameSound(entityNum, channel, this.registerSound(name), time);
    }
  }

  /** A channel's sound begun on its voice, over whatever it took the channel from. */
  private voice(index: number, sfx: Sfx): void {
    let voice = this.channelVoices[index];
    if (!voice) voice = this.channelVoices[index] = new Voice(this.context, this.master);
    voice.play(sfx, false, 0);
    const ch = this.mixer.channels[index];
    voice.set(ch.leftvol, ch.rightvol);
  }

  /**
   * The snapshots' world sounds: each impact where it landed, on the world's entity
   * (`CG_MissileHitWall`), and each sound the client read off an entity on that entity, placed
   * where the event found it (`CG_SetEntitySoundPosition`). The hook's catch names no weapon,
   * so it is heard as the lightning gun's hit, which is what CorkScrew's own catch borrows.
   */
  private playEffects(effects: readonly WorldEffect[], now: number): void {
    for (const effect of effects) {
      if (effect.type === 'impact') {
        const sfx = this.pick(this.assets.get(effect.weapon)?.impactSounds);
        this.start(effect.origin, ENTITYNUM_WORLD, sfx, now);
      } else if (effect.type === 'sound') {
        if (effect.origin) this.mixer.updateEntityPosition(effect.number, effect.origin);
        this.start(null, effect.number, this.sounds.get(effect.path), now);
      } else if (effect.type === 'gameSound') {
        // A general sound on `CHAN_VOICE`, a global one on `CHAN_AUTO`.
        const { number, origin, index, name } = effect;
        if (origin) this.mixer.updateEntityPosition(number, origin);
        this.playGameSound(number, origin ? CHAN.VOICE : CHAN.AUTO, index, name, null, now);
      }
    }
  }

  /**
   * Everyone else's sounds, each started on its entity, placed where the event put it.
   *
   * A body's voice is its model's, whose sounds are decoded as its client's string arrives
   * ({@link loadVoice}), and failing that as it is first drawn, so they are in by the time it is
   * heard. A model's own sound from a body with no voice yet is not heard.
   */
  private playOthers({ sounds, voice }: OthersSoundInput, footsteps: boolean, now: number): void {
    for (const { number, origin, voice: slot, sound } of sounds) {
      this.mixer.updateEntityPosition(number, origin);
      if (!footsteps && sound.type === 'footstep') continue;
      this.start(null, number, this.soundSfx(sound, voice(slot)), now);
    }
  }

  /** The player's own events, each on their own entity. */
  private playOwnEvents(input: SoundInput, now: number): void {
    const own = input.player.number;
    for (const { event, parm } of input.events) {
      switch (eventNumber(event)) {
        // `EV_CHANGE_WEAPON` fires when the key is pressed, 200 ms before `ps.weapon` actually
        // changes — watching `ps.weapon` instead would play the click late.
        case EV.CHANGE_WEAPON:
          this.start(null, own, this.sounds.get('sound/weapons/change.wav'), now);
          break;

        // `CG_FireWeapon`: the shot is the player's own event, and the weapon it was fired from
        // is the one in hand. It reads the firing loop the frame before added.
        case EV.FIRE_WEAPON: {
          if (!playsFireSound(input.weapon, this.lightningFiring)) break;
          // "Play quad sound if needed" (`cg_weapons.c:1708–1711`), before the shot's own.
          if (input.powerups[PW.QUAD]) this.start(null, own, this.sounds.get(QUAD_SOUND), now);
          this.start(null, own, this.pick(this.assets.get(input.weapon)?.fireSounds), now);
          break;
        }

        // `CG_EntityEvent`'s three powerup cases: the quad punch, a hit the suit took, and a
        // regeneration tick.
        case EV.POWERUP_QUAD:
        case EV.POWERUP_BATTLESUIT:
        case EV.POWERUP_REGEN: {
          const path = powerupEventSound(eventNumber(event));
          if (path) this.start(null, own, this.sounds.get(path), now);
          break;
        }

        // `CG_UseItem` (`cg_event.c:344–397`). The center print is the controller's, and the
        // medkit's usage model waits for the players' effects.
        case EV.USE_ITEM0:
        case EV.USE_ITEM1:
        case EV.USE_ITEM2: {
          const path = useItemSound(eventNumber(event) - EV.USE_ITEM0);
          if (path) this.start(null, own, this.sounds.get(path), now);
          break;
        }

        // `CG_EntityEvent`'s `EV_ITEM_PICKUP`: the player's own pickup — the world's is for
        // everyone else, and reaches the bus as an effect.
        case EV.ITEM_PICKUP: {
          const item = itemAt(parm);
          if (item) this.start(null, own, this.sounds.get(pickupSound(item) ?? ''), now);
          break;
        }

        // A speaker the player set off, as its activator: a `*` name in their own voice.
        case EV.GENERAL_SOUND:
          this.playGameSound(own, CHAN.VOICE, parm, this.gameSoundNames[parm], this.ownVoice, now);
          break;

        default:
          break;
      }
    }
  }

  /** The body's sounds, on the player's own entity, and the gibs' splats where they hit. */
  private playPlayer(
    { number, sounds, splats }: PlayerSoundInput,
    footsteps: boolean,
    now: number
  ): void {
    for (const sound of sounds) {
      if (!footsteps && sound.type === 'footstep') continue;
      this.start(null, number, this.soundSfx(sound, this.ownVoice), now);
    }
    // The world's entity, with an origin of its own (`cg_localents.c:196`).
    for (const splat of splats) {
      this.start(splat.origin, ENTITYNUM_WORLD, this.sounds.get(splat.path), now);
    }
  }

  /**
   * `CG_AddPlayerWeapon`'s loop (`cg_weapons.c:1238–1249`): the held weapon's firing sound while
   * `EF_FIRING` is set, if it has one, or its ready sound, on the body's entity.
   *
   * @returns `lightningFiring`: whether it was the firing sound
   */
  private addPlayerWeapon(
    number: number,
    origin: Vec3,
    weapon: WeaponId,
    firing: boolean
  ): boolean {
    const asset = this.assets.get(weapon);
    const path = weaponLoop(asset, firing);
    const sfx = path ? this.sounds.get(path) : undefined;
    if (sfx) this.mixer.addLoopingSound(number, origin, AT_REST, sfx);
    return firing && asset?.firingSound !== undefined;
  }

  /** `CG_PlayerPowerups`: "flight plays a looped sound" (`cg_players.c:1855–1858`). */
  private addFlight(number: number, origin: Vec3): void {
    const sfx = this.sounds.get(FLIGHT_SOUND);
    if (sfx) this.mixer.addLoopingSound(number, origin, AT_REST, sfx);
  }

  /**
   * `CG_EntityEffects`' loop (`cg_ents.c:126-138`): an entity's `s.loopSound` at its origin, a
   * speaker's a real loop. Handle 0 loops the hit, and a sound still being read waits for it.
   */
  private addLoop(number: number, origin: Vec3, loopSound: number, real: boolean): void {
    if (!loopSound) return;
    const sound = this.gameSounds[loopSound];
    if (reading(sound)) return;
    const sfx = sound ?? this.sounds.get(DEFAULT_SOUND);
    if (!sfx) return;
    if (real) this.mixer.addRealLoopingSound(number, origin, AT_REST, sfx);
    else this.mixer.addLoopingSound(number, origin, AT_REST, sfx);
  }

  /**
   * Every entity but the players and the missiles, as `CG_AddCEntity` adds each: where its sounds
   * are heard from and its loop (`CG_EntityEffects`), then a speaker's repeat on `CHAN_ITEM`
   * (`CG_Speaker`), at `cg.time`'s whole milliseconds.
   */
  private addEntities(entities: readonly SoundCentity[], time: number, now: number): void {
    const cgTime = Math.floor(time);
    for (const entity of entities) {
      const { number, speaker } = entity;
      this.mixer.updateEntityPosition(number, entity.soundOrigin);
      this.addLoop(number, entity.origin, entity.loopSound, speaker);
      if (!speaker) continue;
      if (this.speakers.sounds(number, entity.frame, entity.clientNum, cgTime, Math.random)) {
        this.startGameSound(number, CHAN.ITEM, this.gameSounds[entity.eventParm], now);
      }
    }
  }

  /** Everyone else drawn, each placed, then its fry, its weapon's loop and its flight. */
  private addOthers({ entities, voice }: OthersSoundInput): void {
    for (const entity of entities) {
      const worn = voice(entity.number);
      if (worn) void this.loadVoice(worn.model);
      this.mixer.updateEntityPosition(entity.number, entity.origin);
      this.addLoop(entity.number, entity.origin, entity.loopSound, false);
      this.addPlayerWeapon(entity.number, entity.origin, entity.weapon, entity.firing);
      if (entity.powerups & (1 << PW.FLIGHT)) this.addFlight(entity.number, entity.origin);
    }
  }

  /**
   * `CG_Missile`'s flight loop, at where each is drawn and with how fast it is going at the frame's
   * time, which pitches it as it passes (`cg_ents.c:457-464`), over any loop it carries.
   */
  private addMissiles(missiles: SoundInput['missiles'], time: number): void {
    for (const { state, origin } of missiles) {
      this.mixer.updateEntityPosition(state.number, origin);
      this.addLoop(state.number, origin, state.loopSound, false);
      const path = this.assets.get(state.weapon as WeaponId)?.missileFlySound;
      const sfx = path ? this.sounds.get(path) : undefined;
      if (!sfx) continue;
      evaluateTrajectoryDelta(state.pos, time, this.velocity);
      this.mixer.addLoopingSound(state.number, origin, this.velocity, sfx);
    }
  }

  /**
   * `CG_PowerupTimerSounds` (`cg_view.c:699–718`): a powerup crossing a whole second while under
   * five from its end ticks, on the player's own entity.
   */
  private powerupTick(own: number, powerups: readonly number[], time: number, now: number): void {
    if (this.oldTime !== null && powerupsWearingOff(powerups, time, this.oldTime)) {
      this.start(null, own, this.sounds.get(WEAR_OFF_SOUND), now);
    }
    this.oldTime = time;
  }

  /**
   * `trap_S_Respatialize` from the view, `cg.refdef.viewaxis` built as cgame's `AnglesToAxis`
   * builds it; then each channel's voice set to its volumes, and each merged loop's.
   */
  private respatialize(own: number, view: Readonly<FirstPersonView>): void {
    const { angles, axis, right } = this;
    angles[0] = view.angles.x;
    angles[1] = view.angles.y;
    angles[2] = view.angles.z;
    qvmAngleVectors(angles, axis[0], right, axis[2]);
    // `VectorSubtract( vec3_origin, right, axis[1] )`.
    axis[1][0] = 0 - right[0];
    axis[1][1] = 0 - right[1];
    axis[1][2] = 0 - right[2];
    this.mixer.respatialize(own, view.origin, axis);

    const { mixer } = this;
    for (let i = 0; i < MAX_CHANNELS; i++) {
      const ch = mixer.channels[i];
      if (ch.sfx) this.channelVoices[i]?.set(ch.leftvol, ch.rightvol);
    }

    const frame = ++this.frame;
    for (let i = 0; i < mixer.numLoopChannels; i++) {
      const ch = mixer.loopChannels[i];
      const voice = ch.doppler ? this.dopplerVoice(ch.entity, ch.sfx!) : this.loopVoice(ch.sfx!);
      voice.set(ch.leftvol, ch.rightvol);
      voice.rate(ch.doppler ? ch.dopplerScale : 1);
      voice.heard = frame;
    }
    for (const voice of this.loopVoiceList) {
      if (voice.heard !== frame) voice.set(0, 0);
    }
    for (const [entity, voice] of this.dopplerVoices) {
      if (voice.heard === frame) continue;
      this.retire(voice);
      this.dopplerVoices.delete(entity);
    }
  }

  /** A sound's loop, begun on the clock's cycle the first time it is heard. */
  private loopVoice(sfx: Sfx): Voice {
    let voice = this.loopVoices.get(sfx);
    if (!voice) {
      voice = this.spareVoice();
      voice.play(sfx, true, this.cycle(sfx));
      this.loopVoices.set(sfx, voice);
      this.loopVoiceList.push(voice);
    }
    return voice;
  }

  /** A Doppler loop's, for its entity. */
  private dopplerVoice(entity: number, sfx: Sfx): Voice {
    let voice = this.dopplerVoices.get(entity);
    if (!voice) {
      voice = this.spareVoice();
      this.dopplerVoices.set(entity, voice);
    }
    if (voice.sfx !== sfx) voice.play(sfx, true, this.cycle(sfx));
    return voice;
  }

  /** Where a loop is on the mixer's one cycle: the painted time modulo its length, in seconds. */
  private cycle(sfx: Sfx): number {
    return (this.clock() % sfx.length) / this.context.sampleRate;
  }

  /** The context's clock, in frames: the mixer's time. */
  private clock(): number {
    return Math.round(this.context.currentTime * this.context.sampleRate);
  }

  /**
   * A music file read from the paks and opened as `S_CodecOpenStream` opens it, with what that
   * said, which each open of it says again.
   */
  private async openMusic(name: string): Promise<MusicFile> {
    const said: string[] = [];
    const file = await codecOpenStream(name, this.files.read, (text) => said.push(text));
    return { name, file, said };
  }

  private spareVoice(): Voice {
    return this.spareVoices.pop() ?? new Voice(this.context, this.master);
  }

  private retire(voice: Voice): void {
    voice.stop();
    voice.set(0, 0);
    this.spareVoices.push(voice);
  }

  /** One of a list, at random — the machinegun has four fire sounds, and cycles them. */
  private pick(paths: readonly string[] | undefined): Sfx | undefined {
    if (!paths || paths.length === 0) return undefined;
    return this.sounds.get(paths[Math.floor(Math.random() * paths.length)]);
  }

  /**
   * A body's sound, as `CG_CustomSound` and the footstep sets resolve it in its voice, or a shot as
   * `CG_FireWeapon` picks one.
   */
  private soundSfx(sound: EntitySoundKind, voice: ModelVoice | null): Sfx | undefined {
    switch (sound.type) {
      case 'custom':
        return voice ? this.voices.get(voice.model)?.get(sound.name) : undefined;
      case 'footstep': {
        // A slot nobody is in has every field zero, and zero is the normal set.
        const stem = FOOTSTEP_SETS[sound.set ?? voice?.footsteps ?? 'normal'];
        return this.sounds.get(`sound/player/footsteps/${stem}${sound.variant}.wav`);
      }
      case 'shared':
        return this.sounds.get(sound.path);
      case 'fire':
        return this.pick(this.assets.get(sound.weapon)?.fireSounds);
    }
  }
}
