import {
  GT,
  PMF_FOLLOW,
  PMF_SCOREBOARD,
  PM_INTERMISSION,
  PM_SPECTATOR,
  TEAM
} from '../sim/constants';
import { ITEMS, NUM_ITEMS } from '../sim/items';
import { WP, type WeaponId } from '../sim/weapons/constants';
import type { AnnouncerCue } from './announcer';
import { expireAttacker, type AttackerState } from './attacker';
import { centerPrintLines, type CenterPrintState } from './center-print';
import type { ClientInfo } from './client-info';
import { FPS_RIGHT, FPS_Y, FpsCounter } from './fps-counter';
import { disconnectFrame, type HudDisconnect } from './hud-disconnect';
import { createHeadMotion, statusBarHead, type HeadMotion, type StatusBarHead } from './hud-head';
import { SCREEN_HEIGHT, SCREEN_WIDTH, type HudAnchor, type HudRect } from './hud-layout';
import { hudScores, type HudScores } from './hud-scores';
import { followLines, spectatorLines } from './hud-spectator';
import {
  AMMO_X,
  ARMOR_X,
  FIELD_WIDTH,
  HEALTH_X,
  ICON_SIZE,
  STATUS_COLORS,
  ammoColor,
  colorForHealth,
  fieldDigits,
  healthColor,
  type Digit,
  type Rgba
} from './hud-status';
import { powerupTimers, type PowerupTimer } from './powerup-timers';
import { drawReward, type RewardFrame, type RewardState } from './rewards';
import { drawTeamChat, type TeamChatFrame, type TeamChatState } from './team-chat';
import { fadeAlpha } from './weapon-bar';
import {
  BIGCHAR_HEIGHT,
  BIGCHAR_WIDTH,
  SMALLCHAR_HEIGHT,
  SMALLCHAR_WIDTH,
  stringWidth
} from './hud-text';
import { createWarmupState, hudWarmup, type WarmupState } from './hud-warmup';
import { lagometerFrame, type HudLagometer, type Lagometer } from './lagometer';
import { ammoWarningLevel } from './low-ammo';
import {
  PEAK_Y,
  SPEED_Y,
  SpeedGraph,
  speedReadout,
  speedometerLayout,
  type SpeedometerMode
} from './speedometer';
import { weaponBar, type WeaponBar } from './weapon-bar';

/**
 * The HUD, frame by frame: what `CG_Draw2D` draws, and where on Q3's
 * 640×480 grid, for the render layer to put on screen. Engine-free, so every rule of it is tested
 * without a device.
 *
 * Only what the port has is drawn. Q3's team overlay, vote and attacker pieces have nothing behind
 * them. Its lagometer has nothing to measure in a local game (`cg_draw.c:1641`), so Quake
 * Live's speedometer takes its box there, and the one beside it where the lagometer draws.
 */

/** How the HUD is set: Q3's cvars, and Quake Live's speedometer. */
export interface HudSettings {
  /** `cg_draw2D`: off hides everything the HUD draws, the 3D icons included. */
  draw2D: boolean;
  /** `cg_draw3dIcons`: the head, the ammo box and the armor as models, or as icons. */
  draw3dIcons: boolean;
  /** `cg_drawCrosshair`: 0 for none; otherwise crosshair a–j by its remainder of 10, so 4 is e. */
  drawCrosshair: number;
  /** `cg_crosshairSize`, on Q3's grid. */
  crosshairSize: number;
  /** `cg_drawFPS`: the frame rate at the top right. */
  drawFPS: boolean;
  /** `cg_lagometer`: the frame and snapshot graphs at the bottom right, on a remote server. */
  lagometer: boolean;
  /** `cg_nopredict`, which the lagometer marks with "snc". */
  noPredict: boolean;
  /** `cg_speedometer`. */
  speedometer: SpeedometerMode;
  /** `cg_centertime`: how many seconds a message in the middle of the screen stays up. */
  centerTime: number;
  /** `cg_drawRewards`: the reward's medals at the top of the screen. */
  drawRewards: boolean;
  /** `cg_teamChatHeight`: how many lines the team chat box shows; 0 hides it. */
  teamChatHeight: number;
  /** `cg_teamChatTime`: how long a line stays in the team chat box, in milliseconds. */
  teamChatTime: number;
}

/** What the HUD reads this frame, all of it the player's. */
export interface HudInput {
  /** `STAT_HEALTH`: the player's own status draws only above 0. */
  health: number;
  /** `STAT_ARMOR`. */
  armor: number;
  /** `STAT_ARMOR_TIER`: which armour the bar shows, as `ARMOR_TIER` numbers them. */
  armorTier: number;
  /** The weapon in hand: `ps.weapon`. */
  weapon: number;
  /** `STAT_WEAPONS`. */
  weapons: number;
  /** Ammo per weapon; −1 is infinite. */
  ammo: readonly number[];
  /** `g_lowAmmo_<w>` by weapon, from the serverinfo: the warning's marks and the count's red. */
  lowAmmo: readonly number[];
  weaponState: number;
  weaponTime: number;
  /** `cg.weaponSelect`: the weapon asked for. */
  weaponSelect: number;
  /** `cg.weaponSelectTime`, or −∞ before any switch. */
  weaponSelectTime: number;
  /** The last hurt: when, and `damageX`. */
  damage: { time: number; x: number };
  /** `cg.attackerTime`: when the last hurt came, which the frame lets go as it would draw it. */
  attacker: AttackerState;
  /** `PERS_ATTACKER`: who caused it, a slot or the world's number. */
  attackerNum: number;
  /** `cg.renderingThirdPerson`: no crosshair. */
  thirdPerson: boolean;
  /** Horizontal speed, and its peak since the player last stood still, in ups. */
  speed: number;
  peak: number;
  /** Game time in milliseconds. */
  time: number;
  /** Real time in milliseconds, which the frame rate is counted on. */
  realTime: number;
  /** `g_gametype`, from the serverinfo. */
  gametype: number;
  /** `CS_SCORES1` and `CS_SCORES2`: the top two scores, or the two teams'. */
  scores1: number;
  scores2: number;
  /** `PERS_SCORE`: the player's own score. */
  score: number;
  /** `PERS_TEAM`, which picks which box is the player's, and whether they are playing at all. */
  team: number;
  /** `ps.clientNum`: whose state this is, which is the followed player's while following. */
  clientNum: number;
  /** `ps.pm_flags`, for `PMF_FOLLOW`: the state being drawn belongs to somebody else. */
  pmFlags: number;
  /** `ps.pm_type`, for `PM_SPECTATOR`: flying as a spectator, whatever the team. */
  pmType: number;
  /** `cgs.fraglimit` and `cgs.capturelimit`, and Clan Arena's round limit. */
  fraglimit: number;
  capturelimit: number;
  roundlimit: number;
  /** `cgs.redflag` and `cgs.blueflag`, from `CS_FLAGSTATUS`: where each side's flag is. */
  redflag: number;
  blueflag: number;
  /** `CS_WARMUP`: −1 waiting, the countdown's end time, or 0 being played. */
  warmup: number;
  /**
   * `cgs.clientinfo`, which a tournament's warmup reads the two names from, and the head whether
   * it is crossed out.
   */
  clientInfo: (clientNum: number) => ClientInfo | null;
  /**
   * `cg.showScores`: the scores key is held, which hides the player's own status bar and the rest
   * of that block (`cg_draw.c:2557`).
   */
  showScores: boolean;
  /** `ps.powerups`: the end time of each powerup held, by its `PW` value. */
  powerups: readonly number[];
  /** `cg.powerupActive`: the powerup just taken up, whose icon pulses. */
  powerupActive: number;
  /** `cg.powerupTime`: when that was. */
  powerupTime: number;
  /** `STAT_HOLDABLE_ITEM`: the held item's table slot, or 0 for none. */
  holdable: number;
  /** `cg.itemPickup`: the last item taken, whose icon and name show for three seconds. */
  pickup: number;
  /** `cg.itemPickupTime`: when it was taken, or 0 before any. */
  pickupTime: number;
  /** `cg.centerPrint` and its clock: the message in the middle of the screen, or the empty one. */
  centerPrint: CenterPrintState;
  /** `cg.rewardStack` and its arrays: the rewards waiting to be shown, which the frame moves on. */
  rewards: RewardState;
  /** `cgs.teamChatMsgs` and their ring: the team chat box's lines, which the frame moves on. */
  teamChat: TeamChatState;
  /**
   * `cgs.clientinfo[cg.clientNum].team`: the player's own team, whoever they are following, which
   * colours the team chat box.
   */
  ownTeam: number;
  /** The client's commands have outrun its buffer: the server has stopped answering. */
  interrupted: boolean;
  /** `cgs.localServer`: the server runs in this page, and the lagometer has nothing to measure. */
  localServer: boolean;
  /** The lagometer's samples. */
  lagometer: Lagometer;
}

/** What the HUD carries from frame to frame. */
export interface HudState {
  /** The head's look-around. */
  head: HeadMotion;
  /** `CG_DrawFPS`'s frame times. */
  fps: FpsCounter;
  /** The speedometer graph's history. */
  speeds: SpeedGraph;
  /** `cg.warmupCount`: the countdown's second. */
  warmup: WarmupState;
  /** `random()`, for the head's look-around. */
  random: () => number;
}

export function createHudState(random: () => number = Math.random): HudState {
  return {
    head: createHeadMotion(),
    fps: new FpsCounter(),
    speeds: new SpeedGraph(),
    warmup: createWarmupState(),
    random
  };
}

/** Each part's group on screen: the ammo slot keeps to the left edge, the rest to the middle. */
export const AMMO_ANCHOR: HudAnchor = 'left';
export const BAR_ANCHOR: HudAnchor = 'centre';

/** Where `CG_Draw3DModel` sets the ammo box and the armor in their views (`cg_draw.c:549–570`). */
export const AMMO_MODEL_ORIGIN = [70, 0, 0] as const;
export const ARMOR_MODEL_ORIGIN = [90, 0, -10] as const;

/** Crosshairs a–j (`NUM_CROSSHAIRS`, `cg_local.h`; `cg_main.c:868–870`). */
export const NUM_CROSSHAIRS = 10;

/** The ammo warning's line (`cg_draw.c:2304`). */
export const AMMO_WARNING_Y = 64;

/** A number on the status bar: its digits, all on `STATUS_Y`, in one colour. */
export interface HudField {
  digits: Digit[];
  color: Rgba;
}

/** A model in a 3D icon's own view, placed as `CG_Draw3DModel` places it (`cg_draw.c:267–303`). */
export interface IconModel {
  /** In front of the view, which looks along +X. */
  origin: readonly [number, number, number];
  /** Pitch, yaw and roll, in degrees. */
  angles: readonly [number, number, number];
}

/** The status bar (`CG_DrawStatusBar`, `cg_draw.c:519–644`). */
export interface StatusBar {
  /** The ammo count, when there is one: Q3 hides −1, infinite. */
  ammo: HudField | null;
  /** The held weapon's ammo box, spinning in 3D, for a weapon that has one, whatever its ammo. */
  ammoModel: (IconModel & { weapon: WeaponId }) | null;
  /** The held weapon's icon in 2D, beside a count that shows. */
  ammoIcon: WeaponId | null;
  health: HudField;
  /**
   * The head, as its model or its icon, crossed out while the client is drawn in a loaded client's
   * look (`CG_DrawHead`, `cg_draw.c:345–349`).
   */
  head: StatusBarHead & { model: boolean; deferred: boolean };
  /** The armor count, above 0. */
  armor: HudField | null;
  /** The armor, spinning in 3D, while there is any. */
  armorModel: IconModel | null;
  /** The armor's icon in 2D, beside its count. */
  armorIcon: boolean;
  /** The armour's tier, whose item's model or icon is shown. */
  armorTier: number;
}

/** A line of text in `bigchars` (`CG_DrawStringExt`). */
export interface HudText {
  text: string;
  /** The first character's left edge and top, on Q3's grid. */
  x: number;
  y: number;
  charWidth: number;
  charHeight: number;
  color: Rgba;
  /** A black copy under it, 2 right and 2 down. */
  shadow: boolean;
  anchor: HudAnchor;
}

/** The crosshair (`CG_DrawCrosshair`, `cg_draw.c:1864–1919`), centred on the view. */
export interface HudCrosshair {
  shader: string;
  size: number;
  /** `CG_ColorForHealth`, which only a stage that reads the vertex colour takes. */
  color: Rgba;
}

/** `CG_DrawPickupItem`: how long the icon and the name stay up. */
export const PICKUP_DISPLAY_TIME = 3000;

/** `CG_DrawPickupItem` (`cg_draw.c:1298–1321`): the last item taken, at the lower left. */
export interface PickupItem {
  /** The table slot, whose icon and name show. */
  item: number;
  /** The icon's box, one icon in from the edge and two up from the bottom. */
  icon: HudRect;
  /** The icon's fade, from `CG_FadeColor(cg.itemPickupTime, 3000)`. */
  alpha: number;
  /** The name beside it, which Q3 draws at full strength however the icon fades. */
  name: HudText;
}

/**
 * `CG_DrawHoldableItem` (`cg_draw.c:1417–1426`): the one holdable the player carries, drawn in
 * the status block rather than the lower right.
 */
export interface HoldableItem {
  /** The table slot, whose icon draws. */
  item: number;
  icon: HudRect;
}

/** The speedometer's parts this frame. */
export interface HudSpeedometer {
  /** The number and its peak line, or none. */
  readout: HudText[];
  /** The graph's box and its group; its columns come from `speedColumns`. */
  graph: { rect: HudRect; anchor: HudAnchor } | null;
}

/** Everything the HUD draws this frame; `null` for a part not drawn. */
export interface HudFrame {
  statusBar: StatusBar | null;
  ammoWarning: HudText | null;
  crosshair: HudCrosshair | null;
  weaponBar: WeaponBar | null;
  speedometer: HudSpeedometer | null;
  fps: HudText | null;
  /** `CG_DrawScores`: the lower right's boxes and limit, drawn alive or dead. */
  scores: HudScores | null;
  /** `CG_DrawSpectator`: SPECTATOR, and what to do about it, for somebody not playing. */
  spectator: HudText[];
  /** `CG_DrawFollow`: "following" and whose view this is, in the warmup's place. */
  follow: HudText[];
  /** `CG_DrawWarmup`: the mode's name and the countdown, while a match waits. */
  warmup: HudText[];
  /** `CG_DrawWarmup`'s voice: three, two or one, as the countdown's second is drawn. */
  warmupVoice: AnnouncerCue | null;
  /** `CG_DrawPowerups`: the timers of the powerups held, drawn alive or scoreboarded. */
  powerups: PowerupTimer[];
  /** `CG_DrawLowerLeft`: the last item taken, while it is still fading. */
  pickup: PickupItem | null;
  /** `CG_DrawHoldableItem`: the carried item's icon, in the status block. */
  holdable: HoldableItem | null;
  /** `CG_DrawCenterString`: the message in the middle of the screen, its lines faded. */
  centerPrint: HudText[];
  /** `CG_DrawReward`: the medals, and the reward's voice as it comes up. */
  reward: RewardFrame | null;
  /** `CG_DrawTeamInfo`: the team chat box, in a team game. */
  teamChat: TeamChatFrame | null;
  /** `CG_DrawLagometer`: the frame and snapshot graphs at the bottom right. */
  lagometer: HudLagometer | null;
  /** `CG_DrawDisconnect`: "Connection Interrupted", and the net icon blinking. */
  disconnect: HudDisconnect | null;
}

const WHITE: Rgba = [1, 1, 1, 1];

/** `cg_drawCrosshair`'s shader (`cg_draw.c:1872–1912`), or `null` for none. A negative setting is a. */
export function crosshairShader(setting: number): string | null {
  const ca = Math.trunc(setting);
  if (!ca) return null;
  return `gfx/2d/crosshair${'abcdefghij'[Math.max(0, ca) % NUM_CROSSHAIRS]}`;
}

/** The guns with an ammo box to spin: every one but the gauntlet and the hook (`bg_misc.c:359–471`). */
export function hasAmmoModel(weapon: number): boolean {
  return weapon >= WP.MACHINEGUN && weapon <= WP.BFG;
}

/**
 * The HUD for this frame, in `CG_Draw2D`'s terms (`cg_draw.c:2522–2620`).
 *
 * With `cg_draw2D` off nothing draws. The player's own status, the ammo warning, the crosshair and
 * the weapon bar draw only while they live; the frame rate and the speedometer draw either way, as
 * the lagometer and the upper right do.
 *
 * A spectator is a branch of its own before any of that (`cg_draw.c:2548–2555`): SPECTATOR
 * instead of the status block, and the crosshair kept, which is the one piece of the player's own
 * screen somebody watching still has. The follow line takes the warmup text's place rather than
 * sharing the top of the screen with it (`:2611–2613`).
 *
 * Moves `state` on: the head's look-around, the frame count and the speed graph; and the input's
 * rewards, team chat box and attacker, as Q3's drawing moves them.
 */
export function hudFrame(state: HudState, input: HudInput, settings: HudSettings): HudFrame {
  // The graph's history runs whether it is drawn or not, as the lagometer's does.
  state.speeds.add(input.speed);
  if (!settings.draw2D) {
    return {
      statusBar: null,
      ammoWarning: null,
      crosshair: null,
      weaponBar: null,
      speedometer: null,
      fps: null,
      scores: null,
      spectator: [],
      follow: [],
      warmup: [],
      warmupVoice: null,
      powerups: [],
      pickup: null,
      holdable: null,
      centerPrint: [],
      reward: null,
      teamChat: null,
      lagometer: null,
      disconnect: null
    };
  }

  // A spectator has no status block at all, and no scoreboard rule over what it has: the branch
  // is taken before the one the scoreboard is in.
  const spectating = input.team === TEAM.SPECTATOR;
  // A side's player flying as a spectator, as Clan Arena's dead and its late arrivals do, has no
  // status either, and the spectator's crosshair.
  const flying = input.pmType === PM_SPECTATOR;
  // "don't draw any status if dead or the scoreboard is being explicitly shown" (`cg_draw.c:2557`).
  const alive = input.health > 0;
  const own = !spectating && !flying && alive && !input.showScores;
  // `CG_DrawFollow` reads the flag alone, and answers whether it drew: the warmup text is what
  // it draws over.
  const follow =
    (input.pmFlags & PMF_FOLLOW) !== 0
      ? followLines(input.clientInfo(input.clientNum)?.name ?? '')
      : [];
  // Not merely hidden behind the follow line: `CG_DrawWarmup` is not called at all while one is
  // drawn, so its countdown neither moves on nor speaks under it.
  const warmup = follow.length ? null : hudWarmup(state.warmup, input);
  // Where the board takes `CG_Draw2D`'s place: the intermission's, and a spectator's
  // (`cg_draw.c:2538–2541, 2638–2642`).
  const boardOnly =
    input.pmType === PM_INTERMISSION || (spectating && (input.pmFlags & PMF_SCOREBOARD) !== 0);
  // "if ( !cg_lagometer.integer || cgs.localServer )" (`cg_draw.c:1641`).
  const lagometer = settings.lagometer && !input.localServer;
  // In the upper right, which draws dead, spectating or scoreboarded too (`cg_draw.c:2600`).
  if (!boardOnly) expireAttacker(input.attacker, input);
  return {
    statusBar: own ? statusBar(state, input, settings) : null,
    ammoWarning: own ? ammoWarning(input) : null,
    crosshair: spectating || flying || own ? crosshair(input, settings) : null,
    weaponBar: own
      ? weaponBar(input.weapons, input.ammo, input.weaponSelect, input.weaponSelectTime, input.time)
      : null,
    speedometer: speedometer(input, settings.speedometer, lagometer),
    // Outside the status block, so drawn dead, spectating or scoreboarded, but not where the board
    // alone draws.
    lagometer: lagometer && !boardOnly ? lagometerFrame(input.lagometer, settings.noPredict) : null,
    // `CG_DrawLagometer`'s, where it draws. The intermission's commands move no state on
    // (`g_active.c:806–810`), so its connection would read as interrupted.
    disconnect: input.interrupted && !boardOnly ? disconnectFrame(input.time) : null,
    fps: settings.drawFPS ? fps(state, input.realTime) : null,
    scores: hudScores(input),
    spectator: spectating ? spectatorLines(input.gametype) : [],
    follow,
    warmup: warmup?.lines ?? [],
    warmupVoice: warmup?.voice ?? null,
    // The powerups and the pickup are in `CG_DrawLowerRight` and `CG_DrawLowerLeft`, outside the
    // scoreboard's block; each checks only that the player is alive.
    powerups: alive
      ? powerupTimers(input.powerups, input.powerupActive, input.powerupTime, input.time)
      : [],
    pickup: alive ? pickupItem(input.pickup, input.pickupTime, input.time) : null,
    holdable: own && input.holdable ? { item: input.holdable, icon: HOLDABLE_ICON } : null,
    // The last of the status block, so a reward waits — medals and voice — while the player is
    // dead or holding the scores key (`cg_draw.c:2583`).
    reward: own && settings.drawRewards ? drawReward(input.rewards, input.time) : null,
    // Outside the status block, so drawn dead or spectating, in a team game alone
    // (`cg_draw.c:2587–2591`); its lines go only as it draws.
    teamChat:
      input.gametype >= GT.TEAM && !boardOnly
        ? drawTeamChat(input.teamChat, settings, input.time, input.ownTeam)
        : null,
    // `CG_DrawCenterString`, the last of `CG_Draw2D`'s block: the message draws whether the
    // player is alive, and only the scoreboard hides it (`cg_draw.c:2615–2619`).
    centerPrint: centrePrint(input, settings)
  };
}

/** The message in the middle of the screen for this frame, or none. */
function centrePrint(input: HudInput, settings: HudSettings): HudText[] {
  if (input.showScores) return [];
  return centerPrintLines(input.centerPrint, input.time, settings.centerTime * 1000).map(
    (line): HudText => ({
      text: line.text,
      x: line.x,
      y: line.y,
      charWidth: line.charWidth,
      charHeight: line.charHeight,
      color: [1, 1, 1, line.alpha],
      shadow: false,
      anchor: 'centre'
    })
  );
}

/**
 * `CG_DrawHoldableItem`'s box: one icon wide, the right edge, halfway down (`cg_draw.c:1421`).
 */
export const HOLDABLE_ICON: HudRect = {
  x: SCREEN_WIDTH - ICON_SIZE,
  y: (SCREEN_HEIGHT - ICON_SIZE) / 2,
  w: ICON_SIZE,
  h: ICON_SIZE
};

/**
 * `CG_DrawPickupItem`'s icon and name, while `CG_FadeColor` still shows them.
 *
 * An item outside the table is nothing to draw: Q3 would read past the table, which is not
 * something a port can do.
 */
function pickupItem(item: number, pickupTime: number, time: number): PickupItem | null {
  if (item < 1 || item >= NUM_ITEMS) return null;
  // A time of 0 is "never taken one", which is the one case `CG_FadeColor` refuses outright.
  const alpha = pickupTime ? fadeAlpha(pickupTime, PICKUP_DISPLAY_TIME, time) : null;
  if (alpha === null) return null;
  const y = SCREEN_HEIGHT - 2 * ICON_SIZE;
  return {
    item,
    icon: { x: 8, y, w: ICON_SIZE, h: ICON_SIZE },
    alpha,
    name: {
      text: ITEMS[item].pickupName,
      x: ICON_SIZE + 16,
      y: y + (ICON_SIZE / 2 - BIGCHAR_HEIGHT / 2),
      charWidth: BIGCHAR_WIDTH,
      charHeight: BIGCHAR_HEIGHT,
      color: WHITE,
      shadow: true,
      anchor: 'left'
    }
  };
}

/** `CG_DrawStatusBar`: the 3D icons, the head, then the numbers and the 2D icons. */
function statusBar(state: HudState, input: HudInput, settings: HudSettings): StatusBar {
  const now = Math.floor(input.time);
  const weapon = input.weapon as WeaponId;
  const icons3d = settings.draw3dIcons;

  // The count shows only for ammo of 0 or more (`cg_draw.c:578–607`).
  const showAmmo = weapon !== WP.NONE && input.ammo[weapon] > -1;
  const armored = input.armor > 0;
  return {
    ammo: showAmmo
      ? {
          digits: fieldDigits(AMMO_X, FIELD_WIDTH, input.ammo[weapon]),
          color: ammoColor(
            input.weaponState,
            input.weaponTime,
            input.ammo[weapon],
            input.lowAmmo[weapon] ?? 0
          )
        }
      : null,
    ammoModel:
      icons3d && hasAmmoModel(weapon)
        ? { weapon, origin: AMMO_MODEL_ORIGIN, angles: [0, 90 + 20 * Math.sin(now / 1000), 0] }
        : null,
    ammoIcon: showAmmo && !icons3d ? weapon : null,
    health: {
      digits: fieldDigits(HEALTH_X, FIELD_WIDTH, input.health),
      color: healthColor(input.health, now)
    },
    head: {
      ...statusBarHead(state.head, input.damage, now, state.random),
      model: icons3d,
      deferred: input.clientInfo(input.clientNum)?.deferred ?? false
    },
    armor: armored
      ? { digits: fieldDigits(ARMOR_X, FIELD_WIDTH, input.armor), color: STATUS_COLORS.normal }
      : null,
    // A turn every 2048 ms, while there is any armor at all (`cg_draw.c:567–574`).
    armorModel:
      icons3d && input.armor
        ? { origin: ARMOR_MODEL_ORIGIN, angles: [0, ((now & 2047) * 360) / 2048, 0] }
        : null,
    armorIcon: armored && !icons3d,
    armorTier: input.armorTier
  };
}

/** `CG_DrawAmmoWarning` (`cg_draw.c:2286–2305`), from `CG_CheckAmmo`'s count. */
function ammoWarning(input: HudInput): HudText | null {
  const warning = ammoWarningLevel(input.weapons, input.ammo, input.weapon, input.lowAmmo);
  if (!warning) return null;
  return centred(warning === 2 ? 'OUT OF AMMO' : 'LOW AMMO WARNING', AMMO_WARNING_Y, 'big');
}

/** `CG_DrawCrosshair`: none in third person, and tinted by health (`cg_crosshairHealth 1`). */
function crosshair(input: HudInput, settings: HudSettings): HudCrosshair | null {
  const shader = crosshairShader(settings.drawCrosshair);
  if (!shader || input.thirdPerson) return null;
  return {
    shader,
    size: settings.crosshairSize,
    color: colorForHealth(input.health, input.armor)
  };
}

/** The speedometer's number and graph for a mode, the graph clear of a lagometer drawn. */
function speedometer(
  input: HudInput,
  mode: SpeedometerMode,
  lagometer: boolean
): HudSpeedometer | null {
  const layout = speedometerLayout(mode, lagometer);
  if (!layout) return null;
  const lines = speedReadout(input.speed, input.peak);
  return {
    readout: layout.readout
      ? [centred(lines.speed, SPEED_Y, 'big'), centred(lines.peak, PEAK_Y, 'small')]
      : [],
    graph: layout.graph
  };
}

/** `CG_DrawFPS`: "60fps", right-aligned at the top right, from the fifth frame it counts. */
function fps(state: HudState, realTime: number): HudText | null {
  const count = state.fps.frame(realTime);
  if (count === null) return null;
  const text = `${count}fps`;
  return {
    text,
    x: FPS_RIGHT - stringWidth(text, BIGCHAR_WIDTH),
    y: FPS_Y,
    charWidth: BIGCHAR_WIDTH,
    charHeight: BIGCHAR_HEIGHT,
    color: WHITE,
    shadow: true,
    anchor: 'right'
  };
}

/**
 * A white line centred on the screen: `CG_DrawBigString`, shadowed, or `CG_DrawSmallString`,
 * without (`cg_drawtools.c:217–235`).
 */
function centred(text: string, y: number, size: 'big' | 'small'): HudText {
  const big = size === 'big';
  const charWidth = big ? BIGCHAR_WIDTH : SMALLCHAR_WIDTH;
  return {
    text,
    x: SCREEN_WIDTH / 2 - stringWidth(text, charWidth) / 2,
    y,
    charWidth,
    charHeight: big ? BIGCHAR_HEIGHT : SMALLCHAR_HEIGHT,
    color: WHITE,
    shadow: big,
    anchor: 'centre'
  };
}
