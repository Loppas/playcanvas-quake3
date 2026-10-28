import type { Entity } from 'playcanvas';

import { simToWorld } from './coords';
import type { Gender } from './formats/animation-config';
import { LocalGame, type LocalGameOptions } from './local-game';
import { infoSetValueForKey } from './net/info';
import { ENTITYNUM_NONE, type PlayerState } from './net/protocol';
import type { HostMap } from './server/host';
import { isHostChannel, type HostChannel } from './server/channel';
import type { ClientInput, KeyMove } from './settings/client-input';
import type { Cvars } from './settings/cvars';
import { SETTINGS, USERINFO_SETTINGS, type Settings } from './settings/registry';
import { STAT } from './sim/constants';
import { EV, eventNumber, type Event } from './sim/events';
import { HI_NUM_HOLDABLE, IT, ITEMS, NUM_ITEMS, PW, findItemForHoldable } from './sim/items';
import type { DrawnLaser, GrappleHook, LightningBolt } from './view/effects';
import { angleVectors, type ViewBasis } from './sim/pmove-math';
import {
  NO_CONTENTS,
  NO_INLINE_MODELS,
  createUserCmd,
  type InlineModels,
  type PointContentsFn,
  type TraceFn,
  type UserCmd
} from './sim/types';
import { vec3, type Vec3 } from './sim/vec3';
import { WP, type WeaponId } from './sim/weapons/constants';
import type { AnnouncerCue } from './view/announcer';
import type { BrushModelPose } from './view/brush-models';
import type { WorldEffect } from './view/entity-events';
import type { CameraFeel, FirstPersonView, ViewSample } from './view/camera-feel';
import {
  centerPrint,
  createCenterPrint,
  USE_ITEM_CHAR_WIDTH,
  USE_ITEM_Y,
  type CenterPrintState
} from './view/center-print';
import type { ClientInfo, GamestateClient } from './view/client-info';
import type { DamageFeedback } from './view/damage-feedback';
import type { Lagometer } from './view/lagometer';
import { LocalEntities } from './view/local-entities';
import { clientLook, type LookAngles } from './view/look';
import type { EntitySound } from './view/other-player-events';
import type { PlayerSound } from './view/player-events';
import type { PlayerLook } from './view/player-model';
import type { RewardState } from './view/rewards';
import type { FloatSprite } from './view/player-sprites';
import {
  PlayerView,
  type ItemCentity,
  type MissileCentity,
  type PlayerCentity,
  type SoundCentity,
  type SoundChange,
  type ViewConsole
} from './view/player-view';
import type { Scores } from './view/scores';
import type { ServerInfo } from './view/server-info';
import { weaponCommand } from './view/weapon-select';

/**
 * `CG_EntityEvent`'s three `EV_POWERUP_*` cases (`cg_event.c:1189–1214`): the powerup each is
 * about, of the ones a player's own state can carry.
 */
const POWERUP_EVENTS: Readonly<Record<number, number>> = {
  [EV.POWERUP_QUAD]: PW.QUAD,
  [EV.POWERUP_BATTLESUIT]: PW.BATTLESUIT,
  [EV.POWERUP_REGEN]: PW.REGEN
};

/** No key held. */
const STILL: KeyMove = { forwardmove: 0, rightmove: 0, upmove: 0 };

/**
 * Horizontal speed at or below which the peak readout is considered reset: a player standing on
 * the ground. Matches the idle band the bob cycle uses, so each run's peak starts fresh.
 */
const PEAK_RESET_SPEED = 5;

/** A speed readout for the HUD, in Q3 units per second (ups). */
export interface SpeedReadout {
  /** Current horizontal speed (X/Y only) — the figure every Quake speed measurement refers to. */
  speed: number;
  /** Peak horizontal speed since the last ground stop; climbs past the 320 cap when strafe-jumping. */
  peak: number;
}

/** Horizontal speed (X/Y), ignoring the vertical component, as every Quake speedometer does. */
export function horizontalSpeed(v: Vec3): number {
  return Math.hypot(v.x, v.y);
}

/**
 * Roll the speedometer's peak forward one frame.
 *
 * The peak holds the fastest horizontal speed of the current run — so strafe-jumping past the
 * 320 ups cap is legible — and snaps back to the live figure once the player is standing still
 * on the ground, starting the next run's peak fresh.
 *
 * @param peak - Peak so far, in ups.
 * @param live - Current horizontal speed, in ups.
 * @param grounded - Whether the player is on walkable ground.
 */
export function updatePeak(peak: number, live: number, grounded: boolean): number {
  return grounded && live < PEAK_RESET_SPEED ? live : Math.max(peak, live);
}

/** A camera placement in PlayCanvas world space (metres, Y-up), ready for `Entity.lookAt`. */
export interface CameraPose {
  /** Eye position. */
  position: [number, number, number];
  /** A point one unit ahead along the view direction. */
  target: [number, number, number];
  /** Up vector, carrying the view roll. */
  up: [number, number, number];
}

/** The rest of one frame's input, beside the move the keys make. */
export interface CmdKeys {
  /** `CL_CmdButtons`' bits: every `+button<i>` the binds are holding, in one number. */
  buttons: number;
  /** `cl.cgameUserCmdValue`: the weapon the player is asking to hold. */
  weapon: WeaponId;
}

/**
 * `CL_CreateCmd` (`cl_input.c:576–640`): translate one frame of input into a user command.
 *
 * Pure so the sign conventions can be pinned by test.
 *
 * @param move - The move the held keys make, as the binds hold them (`CL_KeyMove`).
 * @param look - Current look direction (yaw/pitch, pitch positive looking up).
 * @param keys - The buttons held and the weapon asked for; defaults to neither.
 */
export function buildUserCmd(
  move: KeyMove,
  look: LookAngles,
  keys: CmdKeys = { buttons: 0, weapon: WP.NONE }
): Omit<UserCmd, 'serverTime'> {
  return createUserCmd({
    forwardmove: move.forwardmove,
    rightmove: move.rightmove,
    upmove: move.upmove,
    // Q3 view angles are [pitch, yaw, roll] with pitch positive looking *down*; the look maths
    // keeps pitch positive looking up, so it is negated here.
    angles: vec3(-look.pitch, look.yaw, 0),
    buttons: keys.buttons,
    weapon: keys.weapon
  });
}

/**
 * What {@link cameraPose} works in, written again at each call, so a frame's pose makes nothing.
 */
const POSE_BASIS: ViewBasis = { forward: vec3(), right: vec3(), up: vec3() };
const POSE_UP: Vec3 = vec3();

/**
 * Where to put the camera for a first-person view, in PlayCanvas world space.
 *
 * Pure so it can be tested without an engine. `angleVectors` deliberately ignores roll (the
 * collision basis never rolls), so the view roll is applied here by rotating the up vector about
 * the forward axis — `up' = up·cos(roll) + right·sin(roll)`, exactly as ioq3's `AngleVectors`
 * folds roll into its up. Without this, `cg_runroll` (the strafing bank) and the bob roll that
 * `camera-feel.ts` computes never reach the camera.
 *
 * @param view - The first-person view (eye origin + Q3 angles), in sim units.
 * @param into - Where the pose is written; a new one by default.
 */
export function cameraPose(
  view: FirstPersonView,
  into: CameraPose = { position: [0, 0, 0], target: [0, 0, 0], up: [0, 0, 0] }
): CameraPose {
  const basis = angleVectors(view.angles, POSE_BASIS);
  const roll = (view.angles.z * Math.PI) / 180;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const rolledUp = POSE_UP;
  rolledUp.x = basis.up.x * cr + basis.right.x * sr;
  rolledUp.y = basis.up.y * cr + basis.right.y * sr;
  rolledUp.z = basis.up.z * cr + basis.right.z * sr;

  const { position, target } = into;
  simToWorld(view.origin, position);
  simToWorld(basis.forward, target);
  target[0] += position[0];
  target[1] += position[1];
  target[2] += position[2];
  simToWorld(rolledUp, into.up);
  return into;
}

/**
 * The game camera: the player's keys and mouse, through the binds, driving a client of a Quake 3
 * server running in this process.
 *
 * It owns the program — the host, the match and this client's end of the wire — and hands the view
 * that client to draw from. What the player sees is what the snapshot carried, and the settings
 * reach the match the way a client's do: the ones that belong to the match are cvars the game
 * module reads, and the ones that belong to the player go as a userinfo string.
 *
 * The sim runs in Q3 units, Z-up; {@link simToWorld} is the only place that meets the renderer.
 */
export class PlayerController {
  /**
   * The program: a host, the match it runs, and this client's end of the wire to it.
   *
   * It is the outermost thing here — the controller is only one of its clients — so it is what a
   * console, a test or a debugger reaches through to ask what either end has been told.
   */
  readonly game: LocalGame;
  private readonly view: PlayerView;
  private readonly input: ClientInput;
  /** Where every setting lives, the match's and the client's alike. Live: read every frame. */
  private readonly settings: Readonly<Settings>;
  /** The store behind {@link settings}, whose strings the userinfo carries. */
  private readonly cvars: Cvars;
  /**
   * `cl.viewangles`: where the player is looking, which is theirs and not the server's. The pitch
   * has no bound here, since the server holds the view within its limit (`clientLook`).
   */
  private angles: LookAngles;
  /** `cg.weaponSelect`: the weapon the player is asking for, a request rather than a change. */
  private selected: WeaponId;
  /** The camera's view as last placed, in Quake units: in the eyes, or behind the body. */
  private placed: FirstPersonView = { origin: vec3(), angles: vec3() };
  /** The userinfo last sent, so that only a change is sent again. */
  private userinfo: string;
  /** The store's count of every change as the userinfo was last built, so it is built only then. */
  private userinfoTotal: number;

  /** Peak horizontal speed since the last ground stop, in ups; drives the speedometer. */
  private peak = 0;
  /** Events the last {@link update} produced; replaced each frame. */
  private frameEvents: readonly Event[] = [];
  /** `cg.weaponSelectTime`: when a weapon was last asked for, or the player respawned. */
  private selectTime = Number.NEGATIVE_INFINITY;
  /** `cg.itemPickup` and `cg.itemPickupTime`: the last item taken, and when, or 0 for none yet. */
  private pickup = 0;
  private pickupTime = 0;
  /** `cg.powerupActive` and `cg.powerupTime`: the powerup just taken, whose icon pulses. */
  private activePowerup = 0;
  private activePowerupTime = 0;
  /** `cg.centerPrint` and the four numbers `CG_CenterPrint` keeps with it. */
  private readonly center: CenterPrintState = createCenterPrint();

  private readonly camera: Entity;

  /**
   * @param camera - Camera entity to drive.
   * @param input - The player's keys and mouse, through the binds; `key-input.ts` feeds it.
   * @param trace - Swept-AABB trace against the world, which the client traces its own effects
   *   against: whichever map is loaded.
   * @param server - The server: its first map, loaded — its entity text, which says where the
   *   player spawns, and its collision — where the host runs in this process (the tests'), or a
   *   channel to a worker's program, which has that map of its own.
   * @param cvars - Every setting, as one store: the match's, the client's and the console's, which
   *   in Quake 3 are one set of values and are here too.
   * @param program - Where `map <n>` finds other maps and reads them, the client's own load at
   *   each gamestate, and the bot files `addbot` finds its bots in. A worker's program reads its
   *   own; what the page keeps is the client's load. Or the server elsewhere that `connect` found,
   *   which the channel's way out reaches.
   * @param localEntities - The pool the client's local entities take their places in.
   * @param pointContents - What a point is inside of the world, as {@link trace} traces it:
   *   whichever map is loaded.
   * @param inlineModels - The world's inline models, which a trigger's predicted touch is tested
   *   on: whichever map is loaded.
   */
  constructor(
    camera: Entity,
    input: ClientInput,
    trace: TraceFn,
    server: HostMap | HostChannel,
    cvars: Cvars,
    program: Pick<LocalGameOptions, 'maps' | 'clientLoader' | 'botFiles' | 'connect'> = {},
    localEntities = new LocalEntities(),
    pointContents: PointContentsFn = NO_CONTENTS,
    inlineModels: InlineModels = NO_INLINE_MODELS
  ) {
    this.camera = camera;
    this.input = input;
    this.settings = cvars.settings;
    this.cvars = cvars;
    // The view angles are the client's own and start where a fresh one's do. The spawn's facing
    // arrives as `delta_angles` against them, so nothing here has to be told where to look.
    this.angles = { yaw: 0, pitch: 0 };

    this.userinfoTotal = cvars.totalModifications();
    this.userinfo = this.buildUserinfo();
    this.game = new LocalGame({
      cvars,
      ...(isHostChannel(server) ? { channel: server } : { map: server }),
      ...program,
      userinfo: this.userinfo
    });
    this.view = new PlayerView(this.game, trace, localEntities, pointContents, inlineModels);
    // The camera as the settings have it, as each frame will.
    this.applySettings();
    this.selected = this.view.player.weapon as WeaponId;

    this.placeCamera();
  }

  /**
   * The network half of a frame alone: the match's frame with nothing held, and the view left as
   * it was. There is no world to draw while a server elsewhere is being reached, and a hidden page
   * draws nothing, but the server still hears from the client, as a minimised Quake 3 runs on. A
   * catcher's talk button goes with it, as with every command, so a player whose menu is up behind
   * another tab is still talking.
   *
   * @param msec - The real time since the last frame.
   */
  networkFrame(msec: number): void {
    const keys = { buttons: this.input.talkButton(), weapon: this.selected };
    this.game.frame(msec, buildUserCmd(STILL, this.angles, keys));
  }

  /**
   * @param dt - Frame delta in seconds. A paused frame's is 0: no tick runs, so the game's time
   *   stands still, while the settings still apply and the camera is still placed, as cgame draws
   *   the frozen game under the menu (`CL_SetCGameTime`, `cl_cgame.c:971–975`).
   */
  update(dt: number) {
    this.applySettings();

    // The weapon commands since the last frame, which cgame runs before the move is made.
    const player = this.view.player;
    let shown = false;
    for (const argv of this.input.takeCommands()) {
      const loadout = { weapons: player.stats[STAT.WEAPONS], ammo: player.ammo };
      const result = weaponCommand(argv, this.selected, loadout);
      if (!result) continue;
      this.selected = result.weapon;
      shown ||= result.shown;
    }

    const mouse = this.input.takeMouse();
    this.angles = clientLook(this.angles, mouse.dx, mouse.dy, this.settings);

    this.frameEvents = this.view.advance(
      dt * 1000,
      buildUserCmd(this.input.keyMove(), this.angles, {
        buttons: this.input.cmdButtons(),
        weapon: this.selected
      })
    );

    // `CG_Init`'s memset of `cg` at a new gamestate (`cg_main.c:1851`): the last world's print,
    // pickup and pulse were timed on a clock the new map's starts again under. Before this frame's
    // own are taken, which the new world's first snapshot may carry.
    if (this.view.gamestateChanged) {
      Object.assign(this.center, createCenterPrint());
      this.pickup = 0;
      this.pickupTime = 0;
      this.activePowerup = 0;
      this.activePowerupTime = 0;
    }

    // The view's centre print: the match's own `cp` (`cg_servercmds.c:1006–1009`), which is where
    // a team change is announced, "FIGHT!", or "You fragged".
    const printed = this.view.centerPrint;
    if (printed !== null) {
      const at = Math.floor(this.view.time);
      centerPrint(this.center, printed.text, printed.y, printed.charWidth, at);
    }

    if (this.view.respawned) {
      // `CG_Respawn`: the weapon asked for is the one spawned with, and the weapon bar shows it.
      // The look is not touched — `SetClientViewAngle` faces the player at the spawn by moving
      // `delta_angles` under the angles they are already holding, which is the whole reason a
      // server can point a client's view at all.
      this.selected = this.view.player.weapon as WeaponId;
      this.selectTime = Math.floor(this.view.time);
    }
    // A weapon command shows the bar, whatever it asked for (`cg_weapons.c:1555, 1591, 1632`).
    if (shown) this.selectTime = Math.floor(this.view.time);

    // `CG_ItemPickup` (`cg_event.c:406–419`), for the events of this frame's ticks. The last
    // pickup of the frame is the one shown, as each overwrites the one before.
    const now = Math.floor(this.view.time);
    for (const { event, parm } of this.frameEvents) {
      const number = eventNumber(event);
      if (number === EV.ITEM_PICKUP || number === EV.GLOBAL_ITEM_PICKUP) {
        if (parm < 1 || parm >= NUM_ITEMS) continue;
        this.pickup = parm;
        this.pickupTime = now;
        const item = ITEMS[parm];
        // "see if it should be the grabbed weapon": a weapon goes straight to hand, which is
        // what `cg_autoswitch` is for — and never the machinegun, which every player has.
        if (this.settings.autoswitch && item.giType === IT.WEAPON && item.giTag !== WP.MACHINEGUN) {
          this.selected = item.giTag as WeaponId;
          this.selectTime = now;
        }
        continue;
      }
      // `CG_EntityEvent`'s `EV_POWERUP_*`: the powerup just taken up pulses its icon.
      const pulse = POWERUP_EVENTS[number];
      if (pulse !== undefined) {
        this.activePowerup = pulse;
        this.activePowerupTime = now;
        continue;
      }
      // `CG_UseItem`'s `EV_USE_ITEM0 + tag` (`cg_event.c:344–365`): what the player used, told
      // in the middle of the screen — which only they are told, being the one it happened to.
      if (number >= EV.USE_ITEM0 && number <= EV.USE_ITEM15) {
        this.useItem(number - EV.USE_ITEM0, now);
      }
    }

    // Track the peak off the live post-tick velocity (not the interpolated sample, which could
    // shave a peak), and reset it once the player has come to rest on the ground.
    this.peak = updatePeak(
      this.peak,
      horizontalSpeed(this.view.player.velocity),
      this.view.player.groundEntityNum !== ENTITYNUM_NONE
    );

    this.placeCamera();
  }

  /**
   * The player state this frame is drawn from, for presentation layers that need more than the
   * camera pose — the viewmodel rig reads `weapon`, `bobCycle` and `velocity` from here.
   *
   * Read-only, and not by convention alone: it is this client's copy of the last player state the
   * server sent it, and the next snapshot replaces whatever is written here. What a player does
   * reaches the match as a user command and comes back as state, which is the only way round.
   */
  get player(): Readonly<PlayerState> {
    return this.view.player;
  }

  /**
   * The server's clock in milliseconds — what the viewmodel and every effect run on.
   *
   * Deliberately not a wall clock: {@link lastFireTime} is stamped on it as the shot's snapshot
   * is read, and timing an animation from one clock against an event stamped on another drifts
   * apart over a session.
   */
  get time(): number {
    return this.view.time;
  }

  /** Whether the player has been put in the world: the view has a snapshot they are in. */
  get inWorld(): boolean {
    return this.view.inWorld;
  }

  /** The server has stopped answering: the client's commands have outrun its buffer. */
  get connectionInterrupted(): boolean {
    return this.view.connectionInterrupted;
  }

  /** The lagometer's samples, which the HUD draws. */
  get lagometer(): Lagometer {
    return this.view.lagometer;
  }

  /** `cg.scores`: the board the match last sent, which the scoreboard draws. */
  get scores(): Scores {
    return this.view.scores;
  }

  /** `cgs`' serverinfo: what the HUD and the effects read of the match's rules. Read-only. */
  get serverInfo(): ServerInfo {
    return this.view.serverInfo;
  }

  /** `cg.killerName`: who killed the player during the last frame, for the board's line. */
  get killedBy(): string | null {
    return this.view.killedBy;
  }

  /** Simulation time of the last shot, or `-Infinity`; drives the flash and the recoil. */
  get lastFireTime(): number {
    return this.view.lastFireTime;
  }

  /** Simulation time of the railgun's last shot, or `-Infinity`; brings its glow back. */
  get railFireTime(): number {
    return this.view.railFireTime;
  }

  /** `cg.weaponSelect`: the weapon asked for, which the weapon bar marks and names. */
  get weaponSelect(): WeaponId {
    return this.selected;
  }

  /** `cg.weaponSelectTime`, on {@link time}'s clock: the last weapon command or respawn. */
  get weaponSelectTime(): number {
    return this.selectTime;
  }

  /**
   * `CG_UseItem`'s message (`cg_event.c:357–365`): "No item to use", or the item's own name.
   *
   * The tag is clamped the way Q3 clamps it; anything past baseq3's holdables, or one the table
   * has no item for, reads as nothing to use. The sound is the sound bus's, and the medkit's
   * 500 ms usage model is a body's.
   *
   * @param tag - `HI` tag the use event carried.
   * @param time - `cg.time` the message is raised at.
   */
  private useItem(tag: number, time: number): void {
    const item = tag > 0 && tag <= HI_NUM_HOLDABLE ? findItemForHoldable(tag) : null;
    const text = item ? `Use ${item.pickupName}` : 'No item to use';
    centerPrint(this.center, text, USE_ITEM_Y, USE_ITEM_CHAR_WIDTH, time);
  }

  /** `cg.itemPickup`: the last item taken, which the HUD shows for three seconds. */
  get itemPickup(): number {
    return this.pickup;
  }

  /** `cg.itemPickupTime`, on {@link time}'s clock: when that was, or 0 before any. */
  get itemPickupTime(): number {
    return this.pickupTime;
  }

  /** `cg.powerupActive`: the powerup just taken, whose timer icon pulses. */
  get powerupActive(): number {
    return this.activePowerup;
  }

  /** `cg.powerupTime`, on {@link time}'s clock: when it was taken. */
  get powerupTime(): number {
    return this.activePowerupTime;
  }

  /** `cg.centerPrint` and its clock: the message in the middle of the screen. */
  get centerPrint(): Readonly<CenterPrintState> {
    return this.center;
  }

  /**
   * The view's angles this frame, as the camera is placed from them: the run and bob tilts
   * included. The viewmodel adds its sway to these, as Q3 does.
   */
  get viewAngles(): FirstPersonView['angles'] {
    return this.placed.angles;
  }

  /** Where the camera is this frame, in Quake units: `cg.refdef.vieworg`. */
  get viewOrigin(): Vec3 {
    return this.placed.origin;
  }

  /** Whether the camera is behind the body this frame: `cg_thirdPerson`, or dead, if playing. */
  get renderingThirdPerson(): boolean {
    return this.view.renderingThirdPerson;
  }

  /** The player state this frame is drawn from: between snapshots, with the frame's own angles. */
  sample(): ViewSample {
    return this.view.sample();
  }

  /** The camera's current landing dip, for the gun's own. */
  get landing(): Readonly<Pick<CameraFeel, 'landChange' | 'landTime'>> {
    return this.view.landing;
  }

  /** What happened in the world this frame, for the presentation layer. Cleared each update. */
  get effects(): readonly WorldEffect[] {
    return this.view.effects;
  }

  /** The projectiles in flight, each where it is drawn this frame, for the renderer. */
  missiles(): MissileCentity[] {
    return this.view.missiles();
  }

  /** `CG_Trace`: the map, then everyone the client was sent, where this frame stands them. */
  get trace(): TraceFn {
    return this.view.trace;
  }

  /** `CG_PointContents`: the map's, then the brush models', where this frame draws them. */
  get pointContents(): PointContentsFn {
    return this.view.pointContents;
  }

  /** The lightning bolt to draw this frame, or `null`. */
  lightningBolt(): LightningBolt | null {
    return this.view.lightningBolt();
  }

  /** Every grappling hook to draw this frame with its cable: the player's own and anyone else's. */
  grappleHooks(): GrappleHook[] {
    return this.view.grappleHooks();
  }

  /** `CG_Respawn`: the player came back this frame. */
  get respawned(): boolean {
    return this.view.respawned;
  }

  /** `cg.mapRestart`: the game started over this frame, so what the last one left goes with it. */
  get mapRestart(): boolean {
    return this.view.mapRestart;
  }

  /** What the player's own body sounded this frame. */
  get playerSounds(): readonly PlayerSound[] {
    return this.view.playerSounds;
  }

  /** The announcer's voices started this frame, oldest first. */
  get voices(): readonly AnnouncerCue[] {
    return this.view.voices;
  }

  /** The rewards waiting for the HUD, which it moves on as it shows them. */
  get rewards(): RewardState {
    return this.view.rewards;
  }

  /** The score plums' digits this frame, turned across the view from `eye`. */
  plumSprites(eye: Vec3): FloatSprite[] {
    return this.view.plumSprites(eye);
  }

  /** Where the player, or a corpse they left, went to pieces this frame. */
  get gibOrigins(): readonly Vec3[] {
    return this.view.gibOrigins;
  }

  /** What everyone else sounded this frame: other players, and each corpse that went to pieces. */
  get entitySounds(): readonly EntitySound[] {
    return this.view.entitySounds;
  }

  /** The view's reaction to the last hurt: the kick, the blob and the HUD head's flinch. */
  get damage(): Readonly<DamageFeedback> {
    return this.view.damage;
  }

  /** When the last pain sound played, and which way the torso twitches for it. */
  get pain(): { time: number; direction: number } {
    return this.view.pain;
  }

  /** Whether the player is gibbed, with no body to draw until the respawn. */
  get gibbed(): boolean {
    return this.view.gibbed;
  }

  /** Whether the player has a body to be drawn at all: `ET_PLAYER` over `ET_INVISIBLE`. */
  get bodyDrawn(): boolean {
    return this.view.bodyDrawn;
  }

  /** Whether the frame is in a teleporter's hyperspace: grey for the world, the gun over it. */
  get hyperspace(): boolean {
    return this.view.hyperspace;
  }

  /**
   * Every player the snapshot carried, placed for this frame: everyone else, living and dead, and
   * every corpse, the player's own among them.
   */
  players(): PlayerCentity[] {
    return this.view.players();
  }

  /** Every item the snapshot carried, for the renderer to draw where it stands. */
  items(): ItemCentity[] {
    return this.view.items();
  }

  /** Every laser the snapshot carried, for the renderer to draw its beam. */
  lasers(): DrawnLaser[] {
    return this.view.lasers();
  }

  /** Every mover the snapshot carried, for the world to draw its brush model where it stands. */
  movers(): readonly BrushModelPose[] {
    return this.view.movers();
  }

  /**
   * Every entity the snapshot carried but its players and missiles, for the sound bus: where each
   * is heard from, its loop, and a speaker's repeat.
   */
  soundEntities(): readonly SoundCentity[] {
    return this.view.soundEntities();
  }

  /** The areas the current snapshot closes to the view, for the world not to draw. */
  get areamask(): Uint8Array {
    return this.view.areamask;
  }

  /** The shader states cgame read since last asked, for the world to swap as each lists. */
  takeShaderStates(): string[] {
    return this.view.takeShaderStates();
  }

  /** The `CS_SOUNDS` slots cgame read a `cs` for since last asked, for the bus to register. */
  takeSoundChanges(): SoundChange[] {
    return this.view.takeSoundChanges();
  }

  /** `CS_MUSIC` as cgame last started the music from it since last asked, or `null`. */
  takeMusicStart(): string | null {
    return this.view.takeMusicStart();
  }

  /** `cgs.clientinfo`: who is in a slot, as their `CS_PLAYERS` string says, or `null`. */
  clientInfo(clientNum: number): ClientInfo | null {
    return this.view.clientInfo(clientNum);
  }

  /** How many clients are drawn in a look, those put off in it among them. */
  wearers(look: PlayerLook): number {
    return this.view.wearers(look);
  }

  /**
   * The player this client is looking out of while it follows somebody, or `null` while the state
   * it is drawn from is its own. What is worn, heard and coloured is theirs.
   */
  get followed(): ClientInfo | null {
    return this.view.followed;
  }

  /** Where the client's prints go: the obituaries, and every `print` the server sends. */
  set console(console: ViewConsole) {
    this.view.console = console;
  }

  /** `ci->gender` for each slot, off the model its body was built of, for the obituaries. */
  set gender(gender: (clientNum: number) => Gender) {
    this.view.gender = gender;
  }

  /**
   * `CG_LoadClientInfo`: read what a client wears as their string arrives during play, or as a
   * look put off is loaded, so that a body of it is built without waiting for the paks.
   */
  set registerClient(register: (info: ClientInfo) => void) {
    this.view.registerClient = register;
  }

  /**
   * `CG_RegisterClients`, for the client's load: everyone the gamestate names, own slot first,
   * and whether each one's look is to be loaded.
   */
  registerClients(): (GamestateClient & { load: boolean })[] {
    return this.view.registerClients();
  }

  /** `CG_LoadDeferredPlayers`: everyone drawn in another's look meanwhile is put in their own. */
  loadDeferredPlayers(): void {
    this.view.loadDeferredPlayers();
  }

  /**
   * The `EV_*` events this frame's ticks left on the player state.
   *
   * Not the same channel as {@link effects}: these are what the simulation itself raised, and the
   * weapon change lives here rather than there. The sound bus wants `EV_CHANGE_WEAPON` at the
   * moment the key was pressed, which is 200 ms before `ps.weapon` actually moves.
   */
  get events(): readonly Event[] {
    return this.frameEvents;
  }

  /** Current + peak horizontal speed, for the speedometer HUD. */
  readout(): SpeedReadout {
    return { speed: horizontalSpeed(this.view.sample().velocity), peak: this.peak };
  }

  /**
   * `map_restart 0`: at the next tick the projectiles, the hook and the corpses go, and the
   * player spawns afresh, facing the spawn's way with the weapon they spawn with.
   */
  restart(): void {
    this.view.restart();
  }

  /**
   * `Cvar_InfoString( CVAR_USERINFO )` (`cvar.c:948–962`): the settings that belong to this
   * client, as the info string a client sends the server.
   *
   * Only the keys the match reads are in it, which is what Quake 3's userinfo flag picks out: the
   * rest of the settings are the client's own business and never leave it. Each value is the
   * cvar's own string, as `Cvar_InfoString` writes it — a flag is "1", where its JavaScript
   * boolean would be "true", which no reader of a userinfo parses.
   */
  private buildUserinfo(): string {
    const warn = (message: string) => this.view.console.print(`${message}\n`);
    let info = '';
    for (const setting of USERINFO_SETTINGS) {
      const { cvar } = SETTINGS[setting];
      info = infoSetValueForKey(info, cvar, this.cvars.get(cvar), warn);
    }
    return info;
  }

  /**
   * Put the settings in force for this frame's ticks.
   *
   * Almost nothing is left to do here: the match's settings are cvars in the same store the game
   * module reads, so god, the spawn armor and the grapple type are already live where they are
   * read. What is here is the camera, which is the client's alone, and `CL_CheckUserinfo`
   * (`cl_main.c:2545–2555`) — a userinfo cvar that changed is sent on, and a new handicap takes
   * effect at the far end the moment `ClientUserinfoChanged` reads it. Q3 asks
   * `cvar_modifiedFlags` for a userinfo cvar's change; the store's count of every change stands in,
   * and the string built then tells whether one of the userinfo's moved.
   */
  private applySettings(): void {
    this.view.thirdPerson = this.settings.thirdPerson;
    this.view.scorePlums = this.settings.scorePlums;
    this.view.deferPlayers = this.settings.deferPlayers;
    this.view.noPredict = this.settings.noPredict;
    this.view.errorDecay = this.settings.errorDecay;
    this.view.showMiss = this.settings.showMiss;
    this.view.predictItems = this.settings.predictItems;
    this.view.delagWeapons = this.settings.delagWeapons;
    this.view.projectileNudge = this.settings.projectileNudge;
    this.view.debugDelag = this.settings.debugDelag;

    const total = this.cvars.totalModifications();
    if (total === this.userinfoTotal) return;
    this.userinfoTotal = total;
    const userinfo = this.buildUserinfo();
    if (userinfo === this.userinfo) return;
    this.userinfo = userinfo;
    this.game.setUserinfo(userinfo);
  }

  private placeCamera() {
    this.placed = this.view.view();
    const { position, target, up } = cameraPose(this.placed);
    this.camera.setPosition(position[0], position[1], position[2]);
    this.camera.lookAt(target[0], target[1], target[2], up[0], up[1], up[2]);
  }
}
