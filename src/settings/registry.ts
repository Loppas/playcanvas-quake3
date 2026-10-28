import { MAX_CLIENTS } from '../net/protocol';
import { SV_FPS } from '../net/snapshot-rate';
import type { Backend } from '../render/backend';
import { GT, PMOVE_MSEC } from '../sim/constants';
import type { Renderer } from '../view/overbright';
import type { SpeedometerMode } from '../view/speedometer';

/**
 * The port's settings, each a cvar: Q3's own, a mod's where the setting is the mod's (CorkScrew's
 * `g_allowGrapple`, Quake Live's `cg_speedometer`), or the port's own under `pcq_`.
 *
 * Each has a default string, as `Cvar_Get` registers one; a reader that takes its value from a
 * string as the code using it would; and the menu section it sits in.
 * `cvars.ts` holds their values. DOM-free.
 */
export interface Settings {
  /** `name`: the player's name, colour codes and all. */
  name: string;
  /** `handicap`: the max health, 1–100; anything else counts as 100. */
  handicap: number;
  /** `color1`: the rail's colour, 1–7 as `CG_ColorFromString` reads it. */
  color1: number;
  /** `model`: the player's model, with its skin after a slash. */
  model: string;
  /** `headmodel`, which Q3's model page sets along with the model. */
  headModel: string;
  /** `team_model`: the model a team game dresses the player in instead. */
  teamModel: string;
  /** `team_headmodel`, which the model page sets along with `team_model`. */
  teamHeadModel: string;
  /** `sensitivity`: mouse counts to degrees, through `m_yaw` and `m_pitch`. */
  sensitivity: number;
  /** `m_pitch`: degrees a count, up and down. Below 0 the mouse is inverted. */
  mPitch: number;
  /** `m_yaw`: degrees a count, side to side. */
  mYaw: number;
  /** `r_glDriver`: the graphics backend, WebGPU or WebGL2. */
  glDriver: Backend;
  /** `cl_renderer`: which of ioq3's renderers to draw like. */
  renderer: Renderer;
  /** `r_overBrightBits`: 0 to 2, clamped there as Q3 clamps it. */
  overBrightBits: number;
  /**
   * `r_normalMapping`: `opengl2` lights models per pixel while this or `r_specularMapping` is on,
   * and per vertex with both off.
   */
  normalMapping: boolean;
  /** `r_specularMapping`: see {@link Settings.normalMapping}. */
  specularMapping: boolean;
  /**
   * `r_picmip`: how many times a map's textures are halved as they upload, 0 to 16, clamped there
   * as Q3 clamps it. The port's default is 0, full size, where Q3's is 1.
   */
  picmip: number;
  /** `cg_fov`: the horizontal angle at 4:3, as Quake Live defines it. */
  fov: number;
  /**
   * `r_swapInterval`: vertical sync, a frame at each of the display's, with `com_maxfps` lifted.
   * The shell starts Chromium paced to the display or not by it, so there a change waits for the
   * next launch.
   */
  swapInterval: boolean;
  /** `com_maxfps`: the most frames a second, while vertical sync is off; 0 for no cap. */
  maxFps: number;
  /** `com_maxfpsUnfocused`: the most while the window has lost its focus, vertical sync or not. */
  maxFpsUnfocused: number;
  /** `s_volume`: the master volume. */
  volume: number;
  /** `s_musicvolume`: the music's volume, under the master volume. */
  musicVolume: number;
  /** `s_doppler`: a missile's flight loop is pitched up as it passes. */
  doppler: boolean;
  /** `rate`: the most a server should send this client, in bytes a second. */
  rate: number;
  /**
   * `snaps`: how many snapshots a second the client asks its server for, held to the server's
   * `sv_fps`. A snapshot every server frame at the port's `sv_fps`.
   */
  snaps: number;
  /** `cg_draw3dIcons`: the status bar's head, ammo box and armor as models, or as icons. */
  draw3dIcons: boolean;
  /** `cg_autoswitch`: a weapon taken up is put in hand at once, but never a machinegun. */
  autoswitch: boolean;
  /** `cg_centertime`: how many seconds a message in the middle of the screen stays up. */
  centerTime: number;
  /** `cg_speedometer`: 0 off, 1 the graph, 2 the number and the graph, 3 the number. */
  speedometer: SpeedometerMode;
  /** `cg_drawCrosshair`: 0 for none; otherwise crosshair a–j by its remainder of 10. */
  drawCrosshair: number;
  /** `cg_crosshairSize`, on Q3's 640×480 grid. */
  crosshairSize: number;
  /** `cg_marks`: off, cgame makes no mark on a wall, and no shadow under a player. */
  marks: boolean;
  /** `r_dynamiclight`: off, the renderer takes none of the frame's dynamic lights. */
  dynamicLight: boolean;
  /**
   * `cg_shadows`: 1, a mark under each player and a wake round them in water; 2 and 3 Quake 3's
   * stencil and planar shadows, which are not drawn, and the wake; 0 neither.
   */
  shadows: number;
  /** `r_marksOnTriangleMeshes`: a mark lands on a map's triangle soups too. */
  marksOnTriangleMeshes: boolean;
  /** `cg_drawFPS`: the frame rate at the top right. */
  drawFPS: boolean;
  /** `cg_lagometer`: the frame and snapshot graphs at the bottom right, on a remote server. */
  lagometer: boolean;
  /** `cg_draw2D`: off, the HUD draws nothing at all. */
  draw2D: boolean;
  /** `cg_drawRewards`: the reward's medals at the top of the screen. */
  drawRewards: boolean;
  /** `cg_drawFriend`: the marker over each teammate in a team game. */
  drawFriend: boolean;
  /** `cg_scorePlums`: the points a score is worth, floating up where it happened. */
  scorePlums: boolean;
  /**
   * `cg_deferPlayers`: a player joining in a look nobody wears is drawn in a loaded one until the
   * scoreboard is up, and their own loaded then.
   */
  deferPlayers: boolean;
  /** `cg_predictItems`: cgame predicts an item's pickup, and the userinfo tells the match to. */
  predictItems: boolean;
  /** `cg_nopredict`: no local simulation; the snapshots' interpolation is drawn instead. */
  noPredict: boolean;
  /** `cg_errordecay`: how long a prediction correction takes to fade, in ms. */
  errorDecay: number;
  /** `cg_showmiss`: how much of the replay's diagnostics the console prints. */
  showMiss: number;
  /**
   * `xp_delagWeapons`: Excessive Plus's early effects, the player's own hitscan shots drawn as they
   * are predicted rather than when the server's events for them arrive. A mask: 1 the machinegun,
   * 2 the shotgun, 4 the lightning gun (whose bolt is drawn from the prediction anyway), 8 the
   * railgun. A weapon the server's `xp_unlagged` does not rewind for waits for the server.
   */
  delagWeapons: number;
  /**
   * `cg_projectileNudge`: how many milliseconds further on than the player's own the client draws
   * everyone else's missiles, grenades aside, to show them nearer where they are by now.
   */
  projectileNudge: number;
  /** `cl_noprint`: nothing printed goes into the console, though the devtools still get it. */
  noPrint: boolean;
  /** `con_notifytime`: how long a line shows on the notify lines, in seconds. */
  notifyTime: number;
  /** `con_notifylines`: how many of the console's last lines the notify lines show, 1–16. */
  notifyLines: number;
  /** `cl_conXOffset`: the notify lines' indent from the left, in the screen's pixels. */
  conXOffset: number;
  /** `scr_conspeed`: how fast the console drops and lifts, in screens a second. */
  conSpeed: number;
  /** `con_scale`: the console's and the notify lines' characters, 1–4 times 8 by 16 pixels. */
  conScale: number;
  /** `cg_teamChatsOnly`: in a team game, only team chat is shown and heard. */
  teamChatsOnly: boolean;
  /** `cg_teamChatHeight`: how many lines the team chat box shows, up to 8; 0 hides it. */
  teamChatHeight: number;
  /** `cg_teamChatTime`: how long a line stays in the team chat box, in milliseconds. */
  teamChatTime: number;
  /**
   * `g_gametype`: 0 free-for-all, 1 tournament, 3 team deathmatch, 4 capture the flag, 8 clan
   * arena.
   */
  gametype: number;
  /** `fraglimit`: the score that ends a match, or 0 for none. */
  fragLimit: number;
  /** `timelimit`: the minutes a match runs for, or 0 for none. */
  timeLimit: number;
  /** `capturelimit`: the captures that end a capture the flag match, or 0 for none. */
  captureLimit: number;
  /** `roundlimit`: the rounds that end a clan arena match, or 0 for none. */
  roundLimit: number;
  /** `g_doWarmup`: a match waits for its players and counts down before it starts. */
  doWarmup: boolean;
  /** `g_warmup`: the seconds that countdown runs for. */
  warmup: number;
  /** `g_forcerespawn`: the seconds a body may lie there before it respawns anyway; 0 for never. */
  forceRespawn: number;
  /** `sv_maxclients`: how many slots the server has. */
  maxClients: number;
  /** `sv_fps`: the server's game frames a second, and the most snapshots a client is sent. */
  svFps: number;
  /** `pmove_msec`: the move's step, in milliseconds, and the client's command step. */
  pmoveMsec: number;
  /**
   * `dedicated`: how a server is advertised — 0 and 1 on the LAN's list only, 2 heartbeating to the
   * Internet's master too. A page's listen server takes it as the menu sets it; the Node entry's
   * server loads 1 at its start, and holds it write protected once its command line has run, as
   * ioq3ded registers it `CVAR_INIT` (`common.c:2737`).
   */
  dedicated: number;
  /** `sv_hostname`: the server's name, as its serverinfo carries it and the browser lists it. */
  hostname: string;
  /**
   * `sv_master1`: the Internet's master, which `globalservers` asks. Every server registers with
   * it, and one on `dedicated 2` heartbeats to it.
   */
  master1: string;
  /**
   * `sv_master2`: the LAN's master, which `localservers` asks first. Every server registers with
   * it, and one on `dedicated 2` heartbeats to it.
   */
  master2: string;
  /** `net_port`: the port a server asks its masters for, and in Node binds its peers to. */
  netPort: number;
  /** `sv_runMaster`: the Node dedicated server runs a master inside itself. */
  runMaster: boolean;
  /**
   * `g_allowGrapple`: CorkScrew's grapple type, as its menu numbers them — 0 none,
   * 1 CorkScrew, 2 Quake III, 3 Quake II CTF.
   */
  allowGrapple: number;
  /**
   * `pcq_spawnWeapons`: every weapon at each spawn, with infinite ammo.
   *
   * Quake 3 spawns a player with the machinegun and the gauntlet, because everything else is a
   * pickup and the map is what hands it out — so this is off, and it is kept as the port's
   * testing aid for a map with no items of its own and for tests that want a full rack.
   */
  spawnWeapons: boolean;
  /** `pcq_spawnArmor`: the armor each spawn starts with. */
  spawnArmor: number;
  /**
   * `xp_unlagged`: Excessive Plus's lag compensation, the hitscan weapons whose shots the server
   * rewinds the other players for — every one at 1, otherwise a mask of `1 << weapon`.
   */
  unlagged: number;
  /** `ui_ffa_fraglimit`: the frag limit Server Options opens on for a free-for-all. */
  uiFfaFragLimit: number;
  /** `ui_ffa_timelimit`: its time limit. */
  uiFfaTimeLimit: number;
  /** `ui_tourney_fraglimit`: the frag limit for a tournament. */
  uiTourneyFragLimit: number;
  /** `ui_tourney_timelimit`: its time limit. */
  uiTourneyTimeLimit: number;
  /** `ui_team_fraglimit`: the frag limit for team deathmatch. */
  uiTeamFragLimit: number;
  /** `ui_team_timelimit`: its time limit. */
  uiTeamTimeLimit: number;
  /** `ui_team_friendly`: its friendly fire, 1 on. */
  uiTeamFriendly: number;
  /** `ui_ctf_capturelimit`: the capture limit for capture the flag. */
  uiCtfCaptureLimit: number;
  /** `ui_ctf_timelimit`: its time limit. */
  uiCtfTimeLimit: number;
  /** `ui_ctf_friendly`: its friendly fire, 1 on. */
  uiCtfFriendly: number;
  /** `ui_ca_roundlimit`: the round limit for clan arena. */
  uiCaRoundLimit: number;
  /** `ui_ca_timelimit`: its time limit. */
  uiCaTimeLimit: number;
  /**
   * `ui_browserMaster`: the server browser's source, by q3_ui's numbers: 0 Local, 1 Internet, 7
   * Favorites.
   */
  uiBrowserMaster: number;
  /** `ui_browserGameType`: the game its list shows, 0 for all of them. */
  uiBrowserGameType: number;
  /** `ui_browserSortKey`: what it sorts its list by. */
  uiBrowserSortKey: number;
  /** `ui_browserShowFull`: whether it lists full servers. */
  uiBrowserShowFull: number;
  /** `ui_browserShowEmpty`: whether it lists empty ones. */
  uiBrowserShowEmpty: number;
  /** `pcq_god`: Q3's `god` command, kept as a setting. */
  god: boolean;
  /** `cg_thirdPerson`: the camera behind the body rather than in its eyes. */
  thirdPerson: boolean;
  /** `pcq_drawCollision`: the collision overlay. */
  drawCollision: boolean;
  /** `cg_drawBBox`: each player's hit box, where they are drawn. */
  drawBBox: boolean;
  /** `cg_debugDelag`: each rewind a railgun shot makes, printed by the server and the client. */
  debugDelag: boolean;
  /** `pcq_drawStatusLine`: the DOM debug line along the top. */
  drawStatusLine: boolean;
  /** `pcq_flyCamera`: the free camera. */
  flyCamera: boolean;
  /** `bot_pause`: every bot sent a command with no move and no button, each frame. A cheat. */
  botPause: boolean;
  /** `cl_packetdelay`: the client's own packets held back, in milliseconds. A cheat. */
  packetDelay: number;
  /** `sv_packetdelay`: the host's packets held back, in milliseconds. A cheat. */
  serverPacketDelay: number;
  /**
   * `r_drawentities`: with it off, a map's world draws its tree and no entity, its brush models
   * among them. A cheat.
   */
  drawEntities: boolean;
  /**
   * `r_fullbright`: a map's world drawn without its light, every surface's lightmap white. A
   * cheat.
   */
  fullbright: boolean;
  /**
   * `r_mapOverBrightBits`: the overbright bits a map's light was baked for. Its lightmaps and
   * vertex colours are shifted by this less `r_overBrightBits` as the map loads.
   */
  mapOverBrightBits: number;
  /**
   * `r_subdivisions`: the farthest a map's curves may stand off their grids, in units. A curve is
   * subdivided as it loads until it is within this.
   */
  subdivisions: number;
  /**
   * `r_ext_multitexture`: a map's shaders draw their first two stages as one pass of two textures
   * where they can.
   */
  multitexture: boolean;
  /** `r_ext_texture_env_add`: so too where the second texture is added to the first. */
  textureEnvAdd: boolean;
  /** `r_detailtextures`: a map's shaders draw their `detail` stages. */
  detailTextures: boolean;
  /**
   * `r_lodCurveError`: how far off a map's curves are drawn coarser. A row of a curve is dropped
   * once it stands off its neighbours by less than its distance from the view over this. A cheat.
   */
  lodCurveError: number;
  /** `r_fastsky`: a map's sky left undrawn, the clear's black showing where it would be. */
  fastSky: boolean;
  /**
   * `r_novis`: a map's every leaf drawn, whatever its eye's cluster can see, from the next time
   * that cluster changes. A cheat.
   */
  noVis: boolean;
  /** `r_nocull`: nothing of a map culled by the view's frustum or by a face's facing. A cheat. */
  noCull: boolean;
  /** `r_lockpvs`: the leafs a map draws kept as they were, wherever its eye goes. A cheat. */
  lockPvs: boolean;
  /** `r_showcluster`: the eye's cluster and area printed each time they change. A cheat. */
  showCluster: boolean;
  /** `r_znear`: the near plane, in units. A cheat. */
  zNear: number;
  /**
   * `r_offsetFactor`: how far a `polygonOffset` shader is pulled towards the viewer by its slope,
   * as `glPolygonOffset`'s factor. A cheat.
   */
  offsetFactor: number;
  /** `r_offsetUnits`: how far by the depth's units, as `glPolygonOffset`'s. A cheat. */
  offsetUnits: number;
  /** `r_ambientScale`: what a map's light grid's ambient light is scaled by. A cheat. */
  ambientScale: number;
  /** `r_directedScale`: what a map's light grid's directed light is scaled by. A cheat. */
  directedScale: number;
  /** `r_facePlaneCull`: a map's faces turned away from the eye left undrawn. */
  facePlaneCull: boolean;
  /**
   * `pcq_preview`: `map` of a BSP map opens its preview in place of a match, read as the map
   * starts. A cheat.
   */
  preview: boolean;
  /**
   * `pcq_previewTime`: where a map's preview holds its clock, in milliseconds, as Q3's `cg.time`
   * would read; at 0 the clock runs, from the preview's first frame. A cheat.
   */
  previewTime: number;
  /** `cm_noAreas`: every area connected to every other, whatever its doors. A cheat. */
  noAreas: boolean;
  /** `cm_noCurves`: traces pass through a map's curves. A cheat. */
  noCurves: boolean;
  /** `cm_playerCurveClip`: a point's trace meets a map's curves, as a box's does. A cheat. */
  playerCurveClip: boolean;
  /** `cg_gibs`: every piece of a gib, or only the skull or the brain. */
  gibs: boolean;
  /** `cg_footsteps`: footsteps, splashes and clanks are heard. A cheat. */
  footsteps: boolean;
  /**
   * `pcq_gsplatColorAngle`: the angle the splat map's view-dependent colour is re-rendered at, in
   * degrees. Larger re-renders the colour less often as the eye moves, the sheen lagging it by the
   * threshold; the engine's own 10° is the default.
   */
  gsplatColorAngle: number;
}

/**
 * Where Setup shows a setting: Player, Controls, System's Graphics, Display, Sound and Network
 * pages, Game options, Server options, and Debug, which is in force only under `DEBUG_MODE`.
 */
export type MenuSection =
  | 'player'
  | 'controls'
  | 'graphics'
  | 'display'
  | 'sound'
  | 'network'
  | 'game'
  | 'server'
  | 'debug';

/** A value read from a string, or why it can't be used, worded to follow the string. */
export type Reading<T> = { value: T } | { problem: string };

/** One setting: its cvar, its default, how it reads a string, and where the menu has it. */
export interface SettingDef<T> {
  /** The cvar, spelled as the file writes it. Matched without regard to case. */
  cvar: string;
  /** The default string, as `Cvar_Get` registers it. */
  default: string;
  /** Take the value from a string, as the code using the cvar reads it. */
  read(raw: string): Reading<T>;
  /** Its menu section, or `null` for one no menu shows. */
  section: MenuSection | null;
  /**
   * `CVAR_CHEAT`: refused while the server's `sv_cheats` is 0, and put back to its default when
   * one says so.
   */
  cheat?: boolean;
  /**
   * Taken up later rather than at once: `'reload'` at the page's next start, as `vid_restart`
   * applies the renderer's settings; `'server'` when the server takes it up, as a map load applies
   * the match's two, the dedicated server's frame `dedicated`, and the network's opening
   * `net_port`.
   */
  latched?: 'reload' | 'server';
  /**
   * `false` for one Q3 registers without `CVAR_ARCHIVE`, which `q3config.cfg` holds only once
   * `seta` sets it: a `set` line for it is read, then left out when the file is next written.
   */
  archive?: boolean;
  /** `CVAR_NORESTART`: `cvar_restart` leaves it as it is. */
  noRestart?: boolean;
}

export type SettingDefs = { readonly [K in keyof Settings]: SettingDef<Settings[K]> };

interface Range {
  min?: number;
  max?: number;
  /** Pull a value outside the range back to it, rather than refusing it. */
  clamp?: boolean;
  /** What a refused value is not, as the report puts it. */
  expected?: string;
}

function inRange(value: number, { min = -Infinity, max = Infinity, clamp, expected }: Range): Reading<number> {
  if (value >= min && value <= max) return { value };
  if (clamp) return { value: Math.min(max, Math.max(min, value)) };
  return { problem: `is not ${expected}` };
}

/** Read through the cvar's `integer`: any whole number, within the range. */
function wholeNumber(range: Range = {}): (raw: string) => Reading<number> {
  return (raw) => {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(value)) return { problem: 'is not a whole number' };
    return inRange(value, range);
  };
}

/** Read through the cvar's `value`: any number, within the range. */
function decimal(range: Range = {}): (raw: string) => Reading<number> {
  return (raw) => {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value)) return { problem: 'is not a number' };
    return inRange(value, range);
  };
}

/** A switch, read as Q3 reads one, through the cvar's `integer`: any whole number but 0 is on. */
function flag(raw: string): Reading<boolean> {
  const reading = wholeNumber()(raw);
  return 'value' in reading ? { value: reading.value !== 0 } : reading;
}

function text(raw: string): Reading<string> {
  return { value: raw };
}

function renderer(raw: string): Reading<Renderer> {
  const value = raw.toLowerCase();
  return value === 'opengl1' || value === 'opengl2'
    ? { value }
    : { problem: 'is neither opengl1 nor opengl2' };
}

/** `webgl2`, in any case, or else WebGPU, as an old config's `opengl32` reads. */
function backend(raw: string): Reading<Backend> {
  return { value: raw.toLowerCase() === 'webgl2' ? 'webgl2' : 'webgpu' };
}

const FOUR_TYPES: Range = { min: 0, max: 3, expected: '0, 1, 2 or 3' };

/** Every setting, in the order the file lists them. */
export const SETTINGS: SettingDefs = {
  // Player, with Q3's defaults (`cl_main.c:3663–3674`); `color1` 4 is red.
  name: { cvar: 'name', default: 'UnnamedPlayer', read: text, section: 'player' },
  handicap: { cvar: 'handicap', default: '100', read: wholeNumber(), section: 'player' },
  color1: { cvar: 'color1', default: '4', read: wholeNumber(), section: 'player' },
  model: { cvar: 'model', default: 'sarge', read: text, section: 'player' },
  headModel: { cvar: 'headmodel', default: 'sarge', read: text, section: 'player' },
  // `DEFAULT_TEAM_MODEL` and `DEFAULT_TEAM_HEAD` (`cg_local.h:88–89`), which outside a Team Arena
  // build are both sarge. Quake 3's engine seeds these with "james" and "*james"
  // (`cl_main.c:3668–3669`), a Team Arena character in no baseq3 pak — cgame then fails to
  // register it and falls back to exactly these two.
  teamModel: { cvar: 'team_model', default: 'sarge', read: text, section: 'player' },
  teamHeadModel: { cvar: 'team_headmodel', default: 'sarge', read: text, section: 'player' },

  // Controls > Look: Q3's `m_yaw` and `m_pitch` (`cl_main.c:3622–3623`), with the
  // sensitivity at 6.8, 0.15° a count, where Q3's is 5 (`cl_main.c:3592`).
  sensitivity: { cvar: 'sensitivity', default: '6.8', read: decimal(), section: 'controls' },
  mPitch: { cvar: 'm_pitch', default: '0.022', read: decimal(), section: 'controls' },
  mYaw: { cvar: 'm_yaw', default: '0.022', read: decimal(), section: 'controls' },

  // System > Graphics, each waiting for `vid_restart`. ioq3 no longer registers `r_glDriver`,
  // where Q3 named its OpenGL library; the port names the backend there.
  glDriver: {
    cvar: 'r_glDriver',
    default: 'webgpu',
    read: backend,
    section: 'graphics',
    latched: 'reload'
  },
  renderer: {
    cvar: 'cl_renderer',
    default: 'opengl1',
    read: renderer,
    section: 'graphics',
    latched: 'reload'
  },
  overBrightBits: {
    cvar: 'r_overBrightBits',
    default: '1',
    read: wholeNumber({ min: 0, max: 2, clamp: true }),
    section: 'graphics',
    latched: 'reload'
  },
  // `opengl2`'s pair, with ioq3's defaults (`tr_init.c:1303–1304`).
  normalMapping: {
    cvar: 'r_normalMapping',
    default: '1',
    read: flag,
    section: 'graphics',
    latched: 'reload'
  },
  specularMapping: {
    cvar: 'r_specularMapping',
    default: '1',
    read: flag,
    section: 'graphics',
    latched: 'reload'
  },
  // `tr_init.c:1030-1033`, archived and latched.
  picmip: {
    cvar: 'r_picmip',
    default: '0',
    read: wholeNumber({ min: 0, max: 16, clamp: true }),
    section: 'graphics',
    latched: 'reload'
  },

  // System > Display: 89.2 is a 73° vertical. `CG_CalcFov` holds it to 1–160
  // (`cg_view.c:489–494`).
  fov: {
    cvar: 'cg_fov',
    default: '89.2',
    read: decimal({ min: 1, max: 160, clamp: true }),
    section: 'display'
  },
  // The frame's pace, archived as ioq3 archives each (`common.c:2758–2760, 2783`,
  // `tr_init.c:1086`). Vertical sync is on where ioq3's is 0, so a frame is the display's, and
  // `r_swapInterval` is the page's at once, where ioq3 latches it. `com_maxfps` is 125 where
  // ioq3's is 85.
  swapInterval: { cvar: 'r_swapInterval', default: '1', read: flag, section: 'display' },
  maxFps: { cvar: 'com_maxfps', default: '125', read: wholeNumber(), section: 'display' },
  maxFpsUnfocused: {
    cvar: 'com_maxfpsUnfocused',
    default: '0',
    read: wholeNumber(),
    section: null
  },
  // System > Sound (`snd_main.c:479-480`).
  volume: { cvar: 's_volume', default: '0.8', read: decimal(), section: 'sound' },
  musicVolume: { cvar: 's_musicvolume', default: '0.25', read: decimal(), section: 'sound' },
  // ioquake3's `s_doppler` (`snd_main.c:482`), archived, on no page.
  doppler: { cvar: 's_doppler', default: '1', read: flag, section: null },
  // System > Network, with Q3's default (`cl_main.c:3664`), sized to carry `snaps` 125.
  // It goes to the server in the userinfo, which holds it to 1000–90000.
  rate: { cvar: 'rate', default: '50000', read: wholeNumber(), section: 'network' },
  // `snaps` (`cl_main.c:3665`): a snapshot every server frame at the port's `sv_fps`, Q3's
  // relationship kept while its literal 20 is not. It goes to the server in the userinfo,
  // which holds it to `sv_fps`; a change to it alone now reaches the server.
  snaps: { cvar: 'snaps', default: '125', read: wholeNumber(), section: 'network' },

  // Game options, with Q3's defaults (`cg_main.c:219–231`), and Quake Live's speedometer, off.
  draw3dIcons: { cvar: 'cg_draw3dIcons', default: '1', read: flag, section: 'game' },
  speedometer: {
    cvar: 'cg_speedometer',
    default: '0',
    read: wholeNumber(FOUR_TYPES) as (raw: string) => Reading<SpeedometerMode>,
    section: 'game'
  },
  // `cg_autoswitch` (`cg_main.c:212`): a weapon taken up is put in hand at once, but not a
  // machinegun. Q3 keeps it in Controls rather than Game options (`ui_controls2.c:274`); the
  // port's Controls page is binds alone, so nothing shows it and the console sets it.
  autoswitch: { cvar: 'cg_autoswitch', default: '1', read: flag, section: null },
  // `cg_centertime` (`cg_main.c:243`): Q3 flags it a cheat and keeps it out of every menu the
  // port has, as it does `cg_autoswitch`.
  centerTime: { cvar: 'cg_centertime', default: '3', read: decimal(), section: null },
  drawCrosshair: { cvar: 'cg_drawCrosshair', default: '4', read: wholeNumber(), section: 'game' },
  crosshairSize: { cvar: 'cg_crosshairSize', default: '24', read: decimal(), section: 'game' },
  // q3_ui's Marks on Walls (`ui_preferences.c:132-134`), cgame's `cg_marks` (`cg_main.c:237`).
  marks: { cvar: 'cg_marks', default: '1', read: flag, section: 'game' },
  // q3_ui's Game Options set the renderer's `r_dynamiclight` (`ui_preferences.c:137`), which
  // both renderers register at 1 (`tr_init.c:1082`).
  dynamicLight: { cvar: 'r_dynamiclight', default: '1', read: flag, section: 'game' },
  // `cg_shadows` (`cg_main.c:217`), archived, which no page of q3_ui's shows.
  shadows: { cvar: 'cg_shadows', default: '1', read: wholeNumber(), section: null },
  // ioquake3's `r_marksOnTriangleMeshes` (`tr_init.c:1147`), archived, on no page.
  marksOnTriangleMeshes: {
    cvar: 'r_marksOnTriangleMeshes',
    default: '0',
    read: flag,
    section: null
  },
  drawFPS: { cvar: 'cg_drawFPS', default: '0', read: flag, section: 'game' },
  // `cg_lagometer` (`cg_main.c:238`), archived, which no page of q3_ui's shows.
  lagometer: { cvar: 'cg_lagometer', default: '1', read: flag, section: null },
  draw2D: { cvar: 'cg_draw2D', default: '1', read: flag, section: 'game' },
  // `cg_drawRewards` (`cg_main.c:230`): no page of q3_ui's shows it, so the console sets it.
  drawRewards: { cvar: 'cg_drawRewards', default: '1', read: flag, section: null },
  // `cg_drawFriend` and `cg_scorePlums` (`cg_main.c:277, 308`), which no page of q3_ui's shows
  // either. The plums' cvar is plural, where cgame's variable is not.
  drawFriend: { cvar: 'cg_drawFriend', default: '1', read: flag, section: null },
  scorePlums: { cvar: 'cg_scorePlums', default: '1', read: flag, section: null },
  // `cg_deferPlayers` (`cg_main.c:269–273`): baseq3's 1, archived, on no page of q3_ui's.
  deferPlayers: { cvar: 'cg_deferPlayers', default: '1', read: flag, section: null },
  // The prediction's own switches (`cg_main.c:254–257, 268`), which no q3_ui page shows either.
  // `cg_predictItems` goes to the server in the userinfo as well as to cgame, as Quake 3's does,
  // and is archived as its is; the other three are not archived in Q3 and so not here.
  predictItems: { cvar: 'cg_predictItems', default: '1', read: flag, section: null },
  noPredict: { cvar: 'cg_nopredict', default: '0', read: flag, section: null, archive: false },
  errorDecay: {
    cvar: 'cg_errordecay',
    default: '100',
    read: wholeNumber(),
    section: null,
    archive: false
  },
  showMiss: {
    cvar: 'cg_showmiss',
    default: '0',
    read: wholeNumber(),
    section: null,
    archive: false
  },
  // Excessive Plus's two for the client's side of its lag compensation, archived as its are.
  delagWeapons: {
    cvar: 'xp_delagWeapons',
    default: '0',
    read: wholeNumber({ min: 0, expected: '0 or more' }),
    section: null
  },
  projectileNudge: {
    cvar: 'cg_projectileNudge',
    default: '0',
    read: wholeNumber(),
    section: null
  },
  // The console's, with ioquake3's defaults and flags (`cl_main.c:3560, 3608`,
  // `cl_console.c:368–370`), on no page. `con_notifylines` is held to 1–16, as
  // `Cvar_CheckRange` holds it.
  noPrint: { cvar: 'cl_noprint', default: '0', read: flag, section: null, archive: false },
  notifyTime: { cvar: 'con_notifytime', default: '3', read: decimal(), section: null },
  notifyLines: {
    cvar: 'con_notifylines',
    default: '3',
    read: wholeNumber({ min: 1, max: 16, clamp: true }),
    section: null
  },
  conXOffset: {
    cvar: 'cl_conXOffset',
    default: '0',
    read: wholeNumber(),
    section: null,
    archive: false
  },
  // `cl_console.c:371–374`: `con_scale` is held to 1–4, as `Cvar_CheckRange` holds it.
  conSpeed: { cvar: 'scr_conspeed', default: '3', read: decimal(), section: null },
  conScale: {
    cvar: 'con_scale',
    default: '1',
    read: decimal({ min: 1, max: 4, clamp: true }),
    section: null
  },
  // cgame's chat, with ioquake3's defaults, archived (`cg_main.c:265–266, 278`), on no page.
  teamChatsOnly: { cvar: 'cg_teamChatsOnly', default: '0', read: flag, section: null },
  teamChatHeight: {
    cvar: 'cg_teamChatHeight',
    default: '0',
    read: wholeNumber(),
    section: null
  },
  teamChatTime: { cvar: 'cg_teamChatTime', default: '3000', read: wholeNumber(), section: null },

  // Server options. The match's own, with Q3's defaults (`gameCvarTable`, `g_main.c:105–132`):
  // `g_gametype` and `sv_maxclients` latch, because a match is built around them and cannot take
  // up either where it stands. Neither is archived, as in Q3 (`g_main.c:109`,
  // `sv_init.c:641`), so each start is a free-for-all of 8. A limit is taken as given and corrected
  // by the match, as Q3 corrects one rather than refusing it.
  gametype: {
    cvar: 'g_gametype',
    default: '0',
    read: wholeNumber({ min: 0, max: GT.MAX_GAME_TYPE - 1, expected: "one of the gametypes" }),
    section: 'server',
    latched: 'server',
    archive: false
  },
  // The limits survive a `cvar_restart`, as baseq3's three do (`g_main.c:116–118`).
  fragLimit: {
    cvar: 'fraglimit',
    default: '20',
    read: wholeNumber(),
    section: 'server',
    noRestart: true
  },
  timeLimit: {
    cvar: 'timelimit',
    default: '0',
    read: wholeNumber(),
    section: 'server',
    noRestart: true
  },
  captureLimit: {
    cvar: 'capturelimit',
    default: '8',
    read: wholeNumber(),
    section: 'server',
    noRestart: true
  },
  roundLimit: {
    cvar: 'roundlimit',
    default: '5',
    read: wholeNumber(),
    section: 'server',
    noRestart: true
  },
  doWarmup: { cvar: 'g_doWarmup', default: '0', read: flag, section: 'server' },
  warmup: { cvar: 'g_warmup', default: '20', read: wholeNumber(), section: 'server' },
  forceRespawn: { cvar: 'g_forcerespawn', default: '20', read: wholeNumber(), section: 'server' },
  maxClients: {
    cvar: 'sv_maxclients',
    default: '8',
    // `SV_BoundMaxClients` (`sv_init.c:589–603`) holds it rather than refusing it.
    read: wholeNumber({ min: 1, max: MAX_CLIENTS, clamp: true }),
    section: 'server',
    latched: 'server',
    archive: false
  },
  // The server's frame and the move's step, which a server's systeminfo carries: Q3 registers
  // neither archived (`sv_init.c:667`, `g_main.c:178`), and corrects each where it is read rather
  // than refusing it (`sv_main.c:1083–1085`, `g_active.c:790–797`).
  svFps: {
    cvar: 'sv_fps',
    default: String(SV_FPS),
    read: wholeNumber(),
    section: 'server',
    archive: false
  },
  pmoveMsec: {
    cvar: 'pmove_msec',
    default: String(PMOVE_MSEC),
    read: wholeNumber(),
    section: 'server',
    archive: false
  },
  // `Cvar_Get("dedicated", ...)` with `Cvar_CheckRange(0, 2, qtrue)` (`common.c:2737–2741`): a
  // whole number 0–2, latched, and never written to the file. The dedicated build's default of 1
  // is the Node entry's to load.
  dedicated: {
    cvar: 'dedicated',
    default: '0',
    read: wholeNumber({ min: 0, max: 2, expected: '0, 1 or 2' }),
    section: null,
    latched: 'server',
    archive: false
  },
  // `sv_hostname`, with Q3's default, and archived as Q3's is (`sv_init.c:640`).
  hostname: { cvar: 'sv_hostname', default: 'noname', read: text, section: null },
  // Quake 3 has five slots, the first two not archived and the rest archived (`sv_init.c:675–678`).
  // The port keeps two: the Internet's, as Q3's first, and the LAN's, a player's own to set. The
  // Internet's names the port's hosted master, as Q3's names id's (`qcommon.h:260`), and the LAN's
  // the master on this machine. An empty slot names none.
  master1: {
    cvar: 'sv_master1',
    default: 'wss://pcq3-master.cheapskatecorner.com',
    read: text,
    section: null,
    archive: false
  },
  master2: { cvar: 'sv_master2', default: 'localhost', read: text, section: null },
  // `Cvar_Get("net_port", va("%i", PORT_SERVER), CVAR_LATCH)` (`net_ip.c:1447`): taken up when the
  // server next registers.
  netPort: {
    cvar: 'net_port',
    default: '27960',
    read: wholeNumber({ min: 0, max: 65535, expected: 'a port, 0 to 65535' }),
    section: null,
    latched: 'server',
    archive: false
  },
  // The port's own, read once as the Node dedicated server starts.
  runMaster: { cvar: 'sv_runMaster', default: '0', read: flag, section: null, archive: false },

  // CorkScrew's grapple type, of which its menu offers only four, and the port's spawn armor.
  allowGrapple: { cvar: 'g_allowGrapple', default: '1', read: wholeNumber(FOUR_TYPES), section: 'server' },
  spawnWeapons: {
    cvar: 'pcq_spawnWeapons',
    default: '0',
    read: flag,
    section: 'server'
  },
  spawnArmor: {
    cvar: 'pcq_spawnArmor',
    default: '0',
    read: wholeNumber({ min: 0, expected: '0 or more' }),
    section: 'server'
  },
  // Excessive Plus's, archived as its is.
  unlagged: {
    cvar: 'xp_unlagged',
    default: '1',
    read: wholeNumber({ min: 0, expected: '0 or more' }),
    section: 'server'
  },

  // What Server Options opens on for each game, and keeps from its last FIGHT: q3_ui's, with its
  // defaults (`ui_main.c:161–173`), then clan arena's, at the match's own defaults.
  uiFfaFragLimit: { cvar: 'ui_ffa_fraglimit', default: '20', read: wholeNumber(), section: null },
  uiFfaTimeLimit: { cvar: 'ui_ffa_timelimit', default: '0', read: wholeNumber(), section: null },
  uiTourneyFragLimit: { cvar: 'ui_tourney_fraglimit', default: '0', read: wholeNumber(), section: null },
  uiTourneyTimeLimit: { cvar: 'ui_tourney_timelimit', default: '15', read: wholeNumber(), section: null },
  uiTeamFragLimit: { cvar: 'ui_team_fraglimit', default: '0', read: wholeNumber(), section: null },
  uiTeamTimeLimit: { cvar: 'ui_team_timelimit', default: '20', read: wholeNumber(), section: null },
  uiTeamFriendly: { cvar: 'ui_team_friendly', default: '1', read: wholeNumber(), section: null },
  uiCtfCaptureLimit: { cvar: 'ui_ctf_capturelimit', default: '8', read: wholeNumber(), section: null },
  uiCtfTimeLimit: { cvar: 'ui_ctf_timelimit', default: '30', read: wholeNumber(), section: null },
  uiCtfFriendly: { cvar: 'ui_ctf_friendly', default: '0', read: wholeNumber(), section: null },
  uiCaRoundLimit: { cvar: 'ui_ca_roundlimit', default: '5', read: wholeNumber(), section: null },
  uiCaTimeLimit: { cvar: 'ui_ca_timelimit', default: '0', read: wholeNumber(), section: null },

  // What the server browser opens on, and keeps from its last visit: ioquake3's, with its defaults
  // (`ui_main.c:188–192`), Internet first.
  uiBrowserMaster: { cvar: 'ui_browserMaster', default: '1', read: wholeNumber(), section: null },
  uiBrowserGameType: {
    cvar: 'ui_browserGameType',
    default: '0',
    read: wholeNumber(),
    section: null
  },
  uiBrowserSortKey: { cvar: 'ui_browserSortKey', default: '4', read: wholeNumber(), section: null },
  uiBrowserShowFull: {
    cvar: 'ui_browserShowFull',
    default: '1',
    read: wholeNumber(),
    section: null
  },
  uiBrowserShowEmpty: {
    cvar: 'ui_browserShowEmpty',
    default: '1',
    read: wholeNumber(),
    section: null
  },

  // Debug, all off. All of them are cheat protected: a server whose `sv_cheats` is 0
  // holds them at their defaults.
  god: { cvar: 'pcq_god', default: '0', read: flag, section: 'debug', cheat: true },
  thirdPerson: { cvar: 'cg_thirdPerson', default: '0', read: flag, section: 'debug', cheat: true },
  drawCollision: {
    cvar: 'pcq_drawCollision',
    default: '0',
    read: flag,
    section: 'debug',
    cheat: true
  },
  drawBBox: { cvar: 'cg_drawBBox', default: '0', read: flag, section: 'debug', cheat: true },
  debugDelag: { cvar: 'cg_debugDelag', default: '0', read: flag, section: 'debug', cheat: true },
  drawStatusLine: {
    cvar: 'pcq_drawStatusLine',
    default: '0',
    read: flag,
    section: 'debug',
    cheat: true
  },
  flyCamera: { cvar: 'pcq_flyCamera', default: '0', read: flag, section: 'debug', cheat: true },
  botPause: { cvar: 'bot_pause', default: '0', read: flag, section: 'debug', cheat: true },

  // The net's testing knobs, which Q3 flags `CVAR_CHEAT` and does not archive (`common.c:2775`).
  packetDelay: {
    cvar: 'cl_packetdelay',
    default: '0',
    read: wholeNumber({ min: 0, max: 999, clamp: true }),
    section: null,
    cheat: true,
    archive: false
  },
  serverPacketDelay: {
    cvar: 'sv_packetdelay',
    default: '0',
    read: wholeNumber({ min: 0, max: 999, clamp: true }),
    section: null,
    cheat: true,
    archive: false
  },
  // The renderer's, which Q3 flags `CVAR_CHEAT` alone too (`tr_init.c:1126`).
  drawEntities: {
    cvar: 'r_drawentities',
    default: '1',
    read: flag,
    section: null,
    cheat: true,
    archive: false
  },
  // A cheat, latched (`tr_init.c:1063`).
  fullbright: {
    cvar: 'r_fullbright',
    default: '0',
    read: flag,
    section: null,
    cheat: true,
    latched: 'reload',
    archive: false
  },
  // Latched and never archived (`tr_init.c:1064`). Q3 reads it whole, unclamped.
  mapOverBrightBits: {
    cvar: 'r_mapOverBrightBits',
    default: '2',
    read: wholeNumber(),
    section: null,
    latched: 'reload',
    archive: false
  },
  // Latched and archived, and never clamped (`tr_init.c:1052`).
  subdivisions: {
    cvar: 'r_subdivisions',
    default: '4',
    read: decimal(),
    section: null,
    latched: 'reload'
  },
  // Each archived and latched (`tr_init.c:1022, 1024`).
  multitexture: {
    cvar: 'r_ext_multitexture',
    default: '1',
    read: flag,
    section: null,
    latched: 'reload'
  },
  textureEnvAdd: {
    cvar: 'r_ext_texture_env_add',
    default: '1',
    read: flag,
    section: null,
    latched: 'reload'
  },
  // Archived and latched (`tr_init.c:1034`).
  detailTextures: {
    cvar: 'r_detailtextures',
    default: '1',
    read: flag,
    section: null,
    latched: 'reload'
  },
  // A cheat, archived, and read at each draw (`tr_init.c:1071`). Q3 takes any number, unclamped.
  lodCurveError: {
    cvar: 'r_lodCurveError',
    default: '250',
    read: decimal(),
    section: null,
    cheat: true
  },
  // Archived, and read at each draw (`tr_init.c:1079`). q3_ui's Game Options show it, inverted, as
  // High Quality Sky (`ui_preferences.c:99, 121-123`).
  fastSky: { cvar: 'r_fastsky', default: '0', read: flag, section: 'game' },
  // The visible set's, cheats and nothing else (`tr_init.c:1128-1130, 1143`).
  noVis: {
    cvar: 'r_novis',
    default: '0',
    read: flag,
    section: null,
    cheat: true,
    archive: false
  },
  noCull: {
    cvar: 'r_nocull',
    default: '0',
    read: flag,
    section: null,
    cheat: true,
    archive: false
  },
  lockPvs: {
    cvar: 'r_lockpvs',
    default: '0',
    read: flag,
    section: null,
    cheat: true,
    archive: false
  },
  showCluster: {
    cvar: 'r_showcluster',
    default: '0',
    read: flag,
    section: null,
    cheat: true,
    archive: false
  },
  // A cheat, held to its range (`tr_init.c:1074-1075`).
  zNear: {
    cvar: 'r_znear',
    default: '4',
    read: decimal({ min: 0.001, max: 200, clamp: true }),
    section: null,
    cheat: true,
    archive: false
  },
  // Cheats (`tr_init.c:1140-1141`).
  offsetFactor: {
    cvar: 'r_offsetFactor',
    default: '-1',
    read: decimal(),
    section: null,
    cheat: true,
    archive: false
  },
  offsetUnits: {
    cvar: 'r_offsetUnits',
    default: '-2',
    read: decimal(),
    section: null,
    cheat: true,
    archive: false
  },
  // Cheats, read at each entity's light (`tr_init.c:1097-1098`).
  ambientScale: {
    cvar: 'r_ambientScale',
    default: '0.6',
    read: decimal(),
    section: null,
    cheat: true,
    archive: false
  },
  directedScale: {
    cvar: 'r_directedScale',
    default: '1',
    read: decimal(),
    section: null,
    cheat: true,
    archive: false
  },
  // Archived (`tr_init.c:1089`).
  facePlaneCull: { cvar: 'r_facePlaneCull', default: '1', read: flag, section: null },
  // The port's own: `map` of a BSP map opens its preview, flown by the free camera with no game,
  // in place of a match. A cheat, and never archived.
  preview: {
    cvar: 'pcq_preview',
    default: '0',
    read: flag,
    section: null,
    cheat: true,
    archive: false
  },
  // The port's own, to hold a map's preview at the time of a Quake 3 screenshot, as `fixedtime`
  // holds Quake 3. A cheat, and never archived.
  previewTime: {
    cvar: 'pcq_previewTime',
    default: '0',
    read: wholeNumber({ min: 0, expected: '0 or more' }),
    section: null,
    cheat: true,
    archive: false
  },
  // Collision's, which `CM_LoadMap` registers as cheats, the last of them archived
  // (`cm_load.c:584-586`).
  noAreas: {
    cvar: 'cm_noAreas',
    default: '0',
    read: flag,
    section: null,
    cheat: true,
    archive: false
  },
  noCurves: {
    cvar: 'cm_noCurves',
    default: '0',
    read: flag,
    section: null,
    cheat: true,
    archive: false
  },
  playerCurveClip: {
    cvar: 'cm_playerCurveClip',
    default: '1',
    read: flag,
    section: null,
    cheat: true
  },

  // No menu shows `cg_gibs`, as none of Q3's does.
  gibs: { cvar: 'cg_gibs', default: '1', read: flag, section: null },
  // `CVAR_CHEAT` alone (`cg_main.c:258`).
  footsteps: {
    cvar: 'cg_footsteps',
    default: '1',
    read: flag,
    section: null,
    cheat: true,
    archive: false
  },
  // The port's own, for a machine that could use the GPU time back: how often the splat map's
  // view-dependent colour is re-rendered, in degrees. The engine's 10° is a colour pass every
  // 0.176 m walked; a larger angle re-renders less, the sheen lagging the eye by it.
  gsplatColorAngle: {
    cvar: 'pcq_gsplatColorAngle',
    default: '10',
    read: wholeNumber({ min: 0, expected: '0 or more' }),
    section: null
  }
};

/** The settings' keys, in the order the file lists them. */
export const SETTING_KEYS = Object.keys(SETTINGS) as (keyof Settings)[];

/**
 * The settings that belong to the client rather than to the match, which travel as a Quake 3
 * userinfo string: `Cvar_InfoString(CVAR_USERINFO)` over the cvars flagged that way
 * (`cvar.c:948–962`). The match's own — god, the spawn armor, the grapple type — are cvars the
 * game module reads where it stands, and reach it by being in the same store.
 */
export const USERINFO_SETTINGS: readonly (keyof Settings)[] = [
  'name',
  'model',
  'headModel',
  'teamModel',
  'teamHeadModel',
  'handicap',
  'color1',
  // The match runs the item's touch itself; this picks whether its event takes the predictable
  // route, which is what lets cgame's own touch agree with it (`g_client.c:729–735`).
  'predictItems',
  'rate',
  // `snaps` is `CVAR_USERINFO` too, so a change to it alone reaches the server.
  'snaps',
  // Asks the server to print each rewind of the player's railgun shots, as unlagged's does.
  'debugDelag'
];

const KEY_BY_CVAR = new Map(SETTING_KEYS.map((key) => [SETTINGS[key].cvar.toLowerCase(), key]));

/** A setting by its cvar, matched without regard to case, as `Cvar_FindVar` matches. */
export function settingForCvar(name: string): keyof Settings | undefined {
  return KEY_BY_CVAR.get(name.toLowerCase());
}

/** Every setting at its default. */
function defaultSettings(): Settings {
  const settings: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const reading = SETTINGS[key].read(SETTINGS[key].default);
    if (!('value' in reading)) throw new Error(`${SETTINGS[key].cvar}'s default ${reading.problem}`);
    settings[key] = reading.value;
  }
  return settings as unknown as Settings;
}

/** Every setting at its default. */
export const DEFAULT_SETTINGS: Readonly<Settings> = defaultSettings();
