import * as pc from 'playcanvas';
import {
  AppBase,
  AppOptions,
  CameraComponentSystem,
  Color,
  ContainerHandler,
  DISPLAYFORMAT_LDR,
  ElementComponentSystem,
  ElementInput,
  Entity,
  FILLMODE_FILL_WINDOW,
  GAMMA_SRGB,
  GSplatComponentSystem,
  GSplatHandler,
  Keyboard,
  Mouse,
  RESOLUTION_AUTO,
  RenderComponentSystem,
  ScreenComponentSystem,
  TONEMAP_LINEAR,
  TextureHandler,
  createGraphicsDevice
} from 'playcanvas';

import type { BootedAssets } from './asset-boot';
import { loadCollisionOverlay, type CollisionOverlay } from './collision-overlay';
import { ARENAS_FILE, MENU_ARENA_LIST, loadArenas, loadInfos, readInfoFiles } from './formats/arena';
import { menuArenas } from './formats/arena-list';
import {
  DEFAULT_MODEL,
  DEFER_SHADER,
  WEAPON_ASSETS,
  playerModelDir,
  type PlayerModelSkin
} from './formats/asset-manifest';
import { parseBsp } from './formats/bsp';
import { parseMd3 } from './formats/md3';
import { parseSkin } from './formats/skin';
import { bspPath, mapKind as kindOfMap, mapNames, readBsp, type MapKind } from './formats/map-kind';
import { atoi } from './formats/c-scan';
import { cleanStr } from './formats/color-codes';
import { readEntities, readEntityText } from './formats/entity-text';
import { configCommands } from './formats/q3config';
import type { ShaderScript } from './formats/shader-script';
import { readOctree, splatMapFiles, wholeBuffer } from './formats/splat-map';
import { frameCap, paceFrames, unpacedWake, vsyncInForce } from './frame-pacer';
import { BspGameMap, GameMap, loadSplat } from './game-map';
import { KeyInput } from './key-input';
import { downloaded, type ConnectScreen, type LoadScreen, type LoadStep } from './load-screen';
import { MAX_REMOTE_FRAME_MSEC, type ClientLoader } from './local-game';
import { ClientStatic } from './net/client-static';
import { Favorites } from './net/favorites';
import { CONFIGSTRING, MAX_MODELS } from './net/commands';
import { CA, ServerDisconnect } from './net/connection';
import { infoValueForKey } from './net/info';
import type { NetAdr } from './net/net';
import type { PeerConnectionFactory } from './net/peer-signalling';
import { mountMapPaks } from './pak/boot';
import { mapConcurrent } from './pak/concurrency';
import type { GameDataContext } from './pak/game-data';
import { searchPath, type PakFileSystem } from './pak/vfs';
import { RemoteChannel } from './server/channel';
import { isHostCommand } from './server/host';
import { readHostMapData, type HostMapData } from './server/host-map';
import type { DevRequest } from './server/worker-messages';
import { WorkerChannel, type MapFiles } from './server/worker-channel';
import { BOT_LIST, BOTS_FILE, MAX_BOTS, MAX_BOTS_TEXT } from './sim/bots';
import { PlayerController, cameraPose, type CameraPose } from './player-controller';
import { deviceTypes } from './render/backend';
import { BspWorld, type BspWorldOptions } from './render/bsp-world';
import { holdFramesWithoutArea } from './render/canvas-area';
import { DebugPlayer } from './render/debug-player';
import { GibEffects } from './render/gib-effects';
import { HudIcons } from './render/hud-icons';
import { HudScreen } from './render/hud-screen';
import { HyperspaceScreen } from './render/hyperspace-screen';
import { SceneDraws } from './render/scene-draws';
import { Levelshots } from './render/levelshots';
import { MenuIcons } from './render/menu-icons';
import { MenuScreen } from './render/menu-screen';
import { guardMeshInstanceStorage } from './render/mesh-instance-storage';
import { PlayerBodies } from './render/player-bodies';
import { PlayerEntities } from './render/player-entities';
import { PlayerPreview } from './render/player-preview';
import { headIcon, ScoreboardScreen } from './render/scoreboard-screen';
import { SoundBus } from './render/sound-bus';
import { SplatLights } from './render/splat-lights';
import { TextureCache } from './render/texture-cache';
import { ViewmodelRig } from './render/viewmodel-rig';
import {
  countMade,
  gpuFinished,
  splatsSorted,
  warmUp,
  type Made,
  type Warmed
} from './render/warm-up';
import { setEyeFov } from './render/eye-fov';
import { FlagTrails } from './render/flag-trails';
import { FloatSprites } from './render/float-sprites';
import { HitBoxes } from './render/hit-boxes';
import { ItemEntities, listedItems } from './render/item-entities';
import { WorldEffects, type DrawnBolt, type DrawnHook } from './render/world-effects';
import type { WorldEffect } from './view/entity-events';
import { ClientInput } from './settings/client-input';
import { CommandRouter, commandLine } from './settings/command-router';
import { keepFile, type FileStore } from './settings/config-file';
import { GameConfig } from './settings/game-config';
import type { HomeFolder } from './settings/home-folder';
import { SHIPPED_PRESETS, listPresets, readCfg } from './settings/presets';
import {
  EF_FIRING,
  PERS,
  PMF_SCOREBOARD,
  PM_DEAD,
  PM_INTERMISSION,
  PM_SPECTATOR,
  STAT,
  TEAM
} from './sim/constants';
import { ITEMS, powerupMask } from './sim/items';
import {
  createScoreboardState,
  scoreboardFrame,
  scoresDown,
  scoresUp,
  type Scoreboard
} from './view/scoreboard';
import {
  clearTrace,
  NO_INLINE_MODELS,
  type InlineModels,
  type PointContentsFn,
  type TraceFn
} from './sim/types';
import type { Vec3 } from './sim/vec3';
import type { WeaponId } from './sim/weapons/constants';
import { brushModelsAtRest, type BrushModelPose } from './view/brush-models';
import type { FirstPersonView } from './view/camera-feel';
import { damageBlob } from './view/damage-feedback';
import { SceneLights, type DynamicLight } from './view/dynamic-lights';
import { setSunDirection } from './view/entity-light';
import { sceneStyle } from './view/overbright';
import { Explosions } from './view/explosions';
import { horizontalFov, verticalFov } from './view/fov';
import { LocalEntities } from './view/local-entities';
import { flagTrails } from './view/flag-trail';
import { readFlagStatus } from './view/flag-status';
import { FreeCamera } from './view/free-camera';
import { playerHitBoxes } from './view/hit-boxes';
import { Menu } from './view/menu';
import { gatherLights, moverGlows } from './view/light-sources';
import { gamestateInfo, localInfo, matchLines, previewLines } from './view/load-info';
import { Marks } from './view/marks';
import { errorPage, inGamePage, mainPage, setupPage } from './view/menu-pages';
import { serversMenu } from './view/menu-servers';
import { startServerPage } from './view/menu-start-server';
import { NotifyLines } from './view/notify-lines';
import { colorFromString } from './view/player-color';
import {
  fragmentBounceMark,
  impactMark,
  markMedia,
  playerShadow,
  playerSplash
} from './view/player-marks';
import { playerFloatSprite, playerSprite, type FloatSprite } from './view/player-sprites';
import { DEFAULT_LOOK, playerLook, sameLook, type PlayerLook } from './view/player-model';
import { PreviewClock } from './view/preview-clock';
import {
  PLAYER_PART,
  VIEW_WEAPON_PART,
  packetEntity,
  predictedEntity,
  viewWeaponEntity
} from './view/scene-sort';
import { ScenePolys, type PolyVerts } from './view/scene-polys';
import { SceneShaders, type SceneShaderSources, type SortedShader } from './view/scene-shaders';
import { serverInfo } from './view/server-info';
import { parseShaderState } from './view/shader-state';
import { spectatorStart } from './view/spectator-start';
import { IDLE_HAND } from './view/viewmodel';
import { isViewpos, viewpos } from './view/viewpos';
import { WEAPON_NAMES } from './view/weapon-select';
import { OPEN_AREAS } from './view/world-vis';
import { LIGHTMAP_2D } from './view/world-shaders';

/** How far in front of the player the debug body stands, in units. */
const DEBUG_PLAYER_DISTANCE = 96;

/** How many of the paks' skins are read at once, for the warm-up of every look's stages. */
const SKIN_READS = 8;

/**
 * Each step's share of the load screen's bar, against a weapon's 1, so that it fills at about an
 * even pace: about the time each keeps the game waiting, measured over a boot from the install
 * in dev. The game data and the map load side by side, and the map comes in second.
 */
const MAP_WEIGHT = 30;
const COLLISION_WEIGHT = 8;
const SOUNDS_WEIGHT = 18;
const GAME_SOUNDS_WEIGHT = 2;
const MEDIA_WEIGHT = 28;
const ITEMS_WEIGHT = 8;
const CLIENT_WEIGHT = 4;
/**
 * How much of the map's step its download fills, measured as the weights are: about two fifths of
 * the step's time. The rest is its unpacking: the bundle's textures decoded and uploaded, and its
 * codebook prepared (`SogBundleParser.load`).
 */
const MAP_DOWNLOAD_SHARE = 0.4;

export interface AppHandle {
  app: AppBase;
  /** Graphics backend actually used: 'webgpu' or 'webgl2'. */
  deviceType: string;
  /** How many splats the map being played draws, or 0 with none. */
  readonly splatCount: number;
  /** The map's collision debug overlay, or null if it failed to load or there is no map. */
  readonly collision: CollisionOverlay | null;
  /** `viewpos`'s reading of the view last drawn, or null with no match or preview to view. */
  viewpos(): string | null;
  /**
   * `quit`'s shutdown (`Com_Quit_f`): the match goes, its server's clients told "Server quit", or a
   * server elsewhere that this client has left. Closing or stopping the page is the caller's.
   */
  quit(): void;
  /**
   * Every arena the search path declares, as info strings, read once at the start as q3_ui's
   * `UI_LoadArenas` reads the files for the menus, and numbered and ordered as it numbers them.
   * Start Server lists its maps from them; nothing else reads them.
   */
  arenas: readonly string[];
  /**
   * What the device has made since the last warm-up ended, as a draw first met in play makes them:
   * shader modules and render pipelines. Null outside dev, on a device other than WebGPU, or before
   * the first warm-up.
   */
  madeSinceWarmUp(): Made | null;
}

/**
 * `viewpos`'s reading, printed where Q3's `CG_Printf` prints: the console, whose notify
 * lines show it and whose other half is the browser's console. And the clipboard, ready to paste
 * into splat-maps' `write_ent.bat`.
 */
function printViewpos(reading: string, print: (text: string) => void): void {
  print(`${reading}\n`);
  // A page served over plain HTTP to another machine has no clipboard, and a browser may refuse
  // it. The console's copy is still there.
  navigator.clipboard?.writeText(reading).catch(() => {});
}

/** What the app is started with. */
export interface SetupOptions {
  /** Canvas to render into. */
  canvas: HTMLCanvasElement;
  /**
   * The assets from the paks. The game waits for them, and for everything built from them; a
   * failed boot lets it start without them, with the map and movement alone.
   */
  assets: Promise<BootedAssets> | undefined;
  /**
   * The player's paks, as soon as they are mounted, or none for a boot that fails first. The map
   * waits for them, since it is read through them.
   */
  paks: Promise<PakFileSystem | undefined>;
  /**
   * The settings and the binds. The binds drive the player, and the view, the HUD, the effects
   * and the sound read the settings live, as cgame reads its cvars each frame.
   */
  config: GameConfig;
  /** The home folder, where `exec` looks for a cfg before the port's own. */
  home: HomeFolder;
  /** `favorites.txt` as it was read at start, and where it is kept. */
  favorites: { saved: string | undefined; stores: readonly FileStore[] };
  /** What the menu does beyond the game. */
  host: MenuHost;
  /**
   * The shell's: the vertical sync its launch started Chromium with, which holds until the next.
   * None in a browser, whose display paces every frame.
   */
  launchVsync?: boolean;
  /**
   * The load screen, which shows each step as it comes in, and is the app's to take away: once the
   * game has started, or, for a boot that starts a map, once the player is in its world.
   */
  loading: Pick<LoadScreen, 'step' | 'close' | 'showServer' | 'showInformation'>;
  /**
   * The map the boot starts, by its name, as `+map <n>` takes it. With none, the boot lands on the
   * main menu.
   */
  map?: string;
  /** A load screen for a map change, over the game, titled with the map's name. */
  loadScreen: (title: string) => MapLoadScreen;
  /**
   * The connect screen, from a `connect` until its server's map loads, titled with the server as
   * it was named.
   */
  connectScreen: (server: string) => Pick<ConnectScreen, 'show' | 'close'>;
}

/** What App does with a map's load screen. */
type MapLoadScreen = Pick<LoadScreen, 'step' | 'close' | 'showServer' | 'showInformation'>;

/** What the menu does beyond the game: `vid_restart`, export and import, and EXIT GAME. */
export interface MenuHost {
  /** Save the settings and reload the page, taking up the latched ones. */
  vidRestart(): void;
  /** Hand the player `q3config.cfg` to keep. */
  exportConfig(): void;
  /** Ask the player for a config, and run it. */
  importConfig(): void;
  /** EXIT GAME: close the shell, or the browser's tab where it lets the page. */
  exit(): void;
}

/**
 * Boot the app: on the backend `r_glDriver` asks for, load the map, a splat and its collision bake
 * or a BSP's world and collision, and drive the camera with the ioq3 pmove controller; or, for a
 * BSP while `pcq_preview` is set, its world for the free camera to fly, with no match. The game
 * starts once everything it draws and plays is in, under the load screen, as cgame registers a
 * level's media before its first frame (`CG_Init`, `cg_main.c:1897–1918`). With neither, the main
 * menu is up.
 *
 * The map is read through the search path: the port's own map pk3s, with the player's paks over
 * them once they are mounted (`map-format.md` §11). A map without its files, one collision or the
 * renderer refuses, or one with none the game can start, drops the match with Q3's words, which the
 * main menu shows, as `ERR_DROP` does. `map <n>` changes it: the old map is freed and
 * the new one read under a load screen of its own, while the game waits.
 *
 * @returns once the game has started
 */
export async function setupApp(setup: SetupOptions): Promise<AppHandle> {
  const { canvas, assets, paks, config, host, loading } = setup;
  const settings = config.cvars.settings;
  // The port's own map pk3s, the bottom of the search path. Only their directories are read, and
  // alongside everything else. None to mount leaves the map without its entities, which says so.
  const mapPaks = mountMapPaks().catch((err: unknown) => {
    console.warn('Map pk3s unavailable:', err);
    return undefined;
  });
  // What the game waits for, each named as cgame names it while it loads, in the order it loads
  // (`cg_main.c:1897–1918`): the map, the collision map, the sounds, the HUD's and the effects'
  // media, each weapon by its pickup name (`CG_LoadingItem`, `cg_info.c:79–89`), and the player by
  // their name (`CG_LoadingClient`, `cg_info.c:130–137`). The game data's step is the asset boot's.
  // A boot's `+map` has its map's steps first and its gamestate's last, which name everyone its
  // match has in it; a later map has a screen of its own.
  const bootMap = setup.map ? mapSteps(loading, splatMapFiles(setup.map).splat) : null;
  const steps = {
    sounds: loading.step('sounds', SOUNDS_WEIGHT),
    media: loading.step('game media', MEDIA_WEIGHT),
    weapons: new Map(WEAPON_ASSETS.map((asset) => [asset.id, loading.step(WEAPON_NAMES[asset.id])])),
    client: loading.step(settings.name, CLIENT_WEIGHT)
  };
  let bootSteps: MatchSteps | null = bootMap && {
    map: bootMap,
    gamestate: gamestateSteps(loading)
  };
  // No glslang/twgsl URLs needed: we only use the engine's built-in (already WGSL) shaders.
  const device = await createGraphicsDevice(canvas, {
    deviceTypes: deviceTypes(settings.glDriver),
    antialias: false,
    // An 8-bit backbuffer that isn't sRGB, which the camera below encodes into. Every blend then
    // happens in display space, as in Q3's framebuffer, and an effect's emissive colour is
    // exactly its brightness on screen. The engine's defaults, stated because the
    // effects depend on them.
    displayFormat: DISPLAYFORMAT_LDR
  });
  // Before any shader is made, which takes the mesh instance storage or not as it is made.
  await guardMeshInstanceStorage(device);
  // Dev only: what the device makes, and how much of it it had made as the last warm-up ended,
  // for a check that the warm-up leaves nothing to make in play.
  const made = import.meta.env.DEV ? countMade(device) : null;
  let madeAtWarmUp: Made | null = null;

  const keyboard = new Keyboard(window);
  const mouse = new Mouse(canvas);

  const options = new AppOptions();
  options.graphicsDevice = device;
  options.keyboard = keyboard;
  options.mouse = mouse;
  // The menu's items find the pointer through the element input.
  options.elementInput = new ElementInput(canvas);
  // The screen and element systems draw the HUD and the menu.
  options.componentSystems = [
    CameraComponentSystem,
    GSplatComponentSystem,
    RenderComponentSystem,
    ScreenComponentSystem,
    ElementComponentSystem
  ];
  // A .sog is a bundle: the gsplat handler unpacks it and loads the packed attribute planes
  // (means/scales/quats/sh0 .webp) as sub-assets, so TextureHandler is required as well.
  // ContainerHandler + RenderComponentSystem load the .collision.glb debug overlay.
  options.resourceHandlers = [GSplatHandler, TextureHandler, ContainerHandler];

  const app = new AppBase(canvas);
  app.init(options);
  app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(RESOLUTION_AUTO);
  // PlayCanvas clamps a frame's `dt` at `maxDeltaTime`, 0.1 s by default, and the port never
  // raised it: a hitch over 100 ms then lost the time above it from the client's clock while the
  // server kept it. A client whose server is elsewhere keeps real time to 5000, as
  // `Com_ModifyMsec` clamps it (`qcommon/common.c:3039–3044`).
  app.maxDeltaTime = MAX_REMOTE_FRAME_MSEC / 1000;
  // `com_maxfps`, `com_maxfpsUnfocused` and vertical sync, read at each of the display's frames,
  // which the shell started without vertical sync hands out at once only after something is drawn.
  const vsync = () => vsyncInForce(settings.swapInterval, setup.launchVsync);
  paceFrames(app, () => frameCap(settings, document.hasFocus(), vsync()), {
    wake: setup.launchVsync === false ? unpacedWake() : undefined
  });

  const resize = () => app.resizeCanvas();
  window.addEventListener('resize', resize);
  holdFramesWithoutArea(app);

  /** What the eye clears to; a BSP map's world clears to black, as `r_fastsky 1` does. */
  const clearColor = new Color(0.05, 0.05, 0.06);
  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor,
    farClip: 1000,
    // PlayCanvas' fov is vertical, and `cg_fov` is Quake Live's: the horizontal angle at
    // 4:3, the vertical kept on a wider screen. Its default, 89.2, is a 73° vertical, which
    // is 105.5° across at 16:9: the OSP/CPMA competitive style, and deliberate. It is also why
    // the viewmodel sits lower than in a stock screenshot: `CG_AddViewWeapon` drops the gun 0.2
    // units per degree past 90 across the screen, so 105.5 costs 3.1 units. Both are intended.
    fov: verticalFov(settings.fov),
    // Output encoded in the shader, with no tone curve: see the device's `displayFormat`.
    gammaCorrection: GAMMA_SRGB,
    toneMapping: TONEMAP_LINEAR
  });
  app.root.addChild(camera);
  /** The screen's aspect, which an automatic aspect ratio resolves against. */
  const screenAspect = () => {
    const { width, height } = app.graphicsDevice;
    return height > 0 ? width / height : 1;
  };
  // `cg_fov`, live, unwarped: a match's frame warps it once the eye is placed (`warpEye`). The
  // view weapon takes the eye's projection every frame, so it follows.
  app.on('update', () => setEyeFov(camera.camera!, settings.fov, screenAspect(), 0, 0));
  /**
   * A BSP map's whole 3D scene as Q3 draws it: every draw in the world's one list by Q3's key, at
   * its framebuffer's values, and the ramp after (`render/scene-draws.ts`). Keyed as each frame is
   * drawn, the warm-up's among them.
   */
  const sceneShaders = new SceneShaders();
  /** What a BSP map's scene is drawn as: `opengl1`'s, under the style's overbright bits. */
  const SCENE_STYLE = sceneStyle();
  const scene = new SceneDraws(sceneShaders, {
    models: [app.scene.layers.getLayerById(pc.LAYERID_WORLD)!],
    effects: [],
    gun: [],
    screen: []
  });
  app.on('prerender', () => scene.order());
  /** The grey a frame inside a teleporter shows for the world, last of what the eye draws. */
  const hyperspace = new HyperspaceScreen(app, camera, scene);

  // The camera driver and the overlay's setting are wired below, once the collision data has
  // loaded; these hold their teardown for the destroy handler (assigned late, like destroyDriver,
  // to avoid ordering hazards).
  let destroyDriver: () => void = () => {};
  let detachOverlayToggle: () => void = () => {};
  /**
   * Dress the client in the look it is looking out of, if it is not wearing it already: its own
   * `CS_PLAYERS` string's, or the followed player's while it follows somebody. Assigned once
   * the media are in, and run every frame from then on.
   */
  let wearWatched: () => void = () => {};

  // The keyboard and the mouse are the app's, which detaches them itself.
  app.on('destroy', () => {
    window.removeEventListener('resize', resize);
    detachOverlayToggle();
    destroyDriver();
  });

  // Start before loading: the SOG handler finishes its work (codebook prep, texture uploads)
  // on the app's frame tick, so the asset never completes on a stopped app.
  app.start();

  // The search path: the port's own map pk3s, and the player's paks over them once they are
  // mounted, or none of theirs if they never are. The map is read through it as Q3 reads a map
  // (`splat-maps/docs/map-format.md` §11).
  const fs = searchPath([await mapPaks, await paks]);
  /**
   * What the port loads a map from: its splat, or else its BSP; none where the search path has
   * neither.
   */
  const mapKind = (name: string): MapKind | null => kindOfMap(fs, name);
  /**
   * Whether `map` opens a map's preview, flown by the free camera with no game, in place of a
   * match: a BSP map's, while `pcq_preview` is set as the map starts.
   */
  const previews = (name: string): boolean => settings.preview && mapKind(name) === 'bsp';
  /**
   * The file a map loads from, as its load screen names it: its splat, or else its BSP, which
   * `CM_LoadMap` names where it finds none.
   */
  const mapFile = (name: string): string =>
    mapKind(name) === 'splat' ? splatMapFiles(name).splat : bspPath(name);
  // The boot's map step was added before the search path could say which file the map loads from.
  if (bootMap && setup.map && mapKind(setup.map) === 'bsp') bootMap.map.rename(bspPath(setup.map));
  // The textures everything drawn shares, each held by count.
  const textures = new TextureCache(app.graphicsDevice);

  /**
   * A map's files, each under its step of the load screen, in the order cgame and the host load
   * them: the splat, the collision map, the entities (`map-format.md` §11).
   *
   * @param entities - The map's entity text, where the caller has read it already.
   */
  const loadMap = async (name: string, steps: MapSteps, entities?: string): Promise<GameMap> => {
    // The map's megabytes as they come in, then its unpacking.
    const splat = await steps.map.track(
      loadSplat(app, fs, name, (received, total) =>
        steps.map.advance(
          total > 0 ? (MAP_DOWNLOAD_SHARE * received) / total : 0,
          total > 0 && received >= total ? 'unpacking' : downloaded(received, total)
        )
      )
    );
    // Debug collision overlay, as `pcq_drawCollision` has it: off by default, so it does not
    // haze over the map during play, and toggled by C under DEBUG_MODE. Optional: a
    // missing/failed .collision.glb must not stop the map from loading, so failure is logged and
    // the app runs without it.
    let collision: CollisionOverlay | null = null;
    try {
      collision = await loadCollisionOverlay(app, fs, name, settings.drawCollision);
    } catch (err) {
      console.warn('Collision overlay unavailable:', err);
    }
    const octree = await steps.collision.track(readOctree(fs, name));
    // `CM_LoadMap`'s entity string, which the host hands the game a token at a time.
    const text = entities ?? (await readEntityText(fs, name));
    return new GameMap(app, { name, splat, octree, entities: text, collision });
  };
  /**
   * What a map's world is built with: the settings `RE_LoadWorldMap` reads as the map starts.
   *
   * @param time - The clock its stages are made at, until its first frame plays them.
   */
  const worldOptions = async (
    name: string,
    time: number
  ): Promise<Omit<BspWorldOptions, 'bsp'>> => ({
    name,
    scripts: await shaderScripts(),
    fs,
    cache: textures,
    picmip: settings.picmip,
    mapOverBrightBits: settings.mapOverBrightBits,
    fullbright: settings.fullbright,
    subdivisions: settings.subdivisions,
    multitexture: settings.multitexture,
    textureEnvAdd: settings.textureEnvAdd,
    detailTextures: settings.detailTextures,
    time,
    offset: { factor: settings.offsetFactor, units: settings.offsetUnits },
    warn: print,
    scene
  });
  /** Each model's and skin's shaders, read once a page, for cgame's registrations' order. */
  const registeredFiles = new Map<string, Promise<readonly string[] | null>>();
  /** Where cgame's registrations read a model's or a skin's shaders: the search path. */
  const sceneSources: SceneShaderSources = {
    modelShaders: (path) => {
      let found = registeredFiles.get(path);
      if (!found) {
        found = (async () => {
          const bytes = fs.has(path) ? await fs.read(path) : undefined;
          if (!bytes) return null;
          try {
            return parseMd3(bytes, path).surfaces.flatMap((surface) => surface.shaders);
          } catch {
            return null;
          }
        })();
        registeredFiles.set(path, found);
      }
      return found;
    },
    skinShaders: async (path) => {
      const bytes = fs.has(path) ? await fs.read(path) : undefined;
      return bytes ? parseSkin(new TextDecoder().decode(bytes)).map((pair) => pair.shader) : null;
    }
  };
  /** Every shader {@link skinShaders} reads, once a page. */
  let lookShaders: Promise<string[]> | null = null;
  /**
   * Every shader a look in the paks can draw, for the warm-up to make each kind of stage of them
   * (`render/look-kinds.ts`): those each `models/players/<model>/<name>.skin` names, and Q3's
   * default, which a surface its skin leaves out draws. A skin that can't be read names none, as
   * no look can wear it.
   */
  const skinShaders = (): Promise<string[]> =>
    (lookShaders ??= (async () => {
      const skins = fs
        .list('models/players/', 'skin')
        .filter((path) => path.split('/').length === 4);
      const named = await mapConcurrent(skins, SKIN_READS, (path) =>
        sceneSources.skinShaders(path).catch(() => null)
      );
      return ['', ...named.flatMap((shaders) => shaders ?? [])];
    })());
  /** Whether the search path holds an image, through the extension fallback. */
  const hasImage = (name: string): boolean => fs.resolveImage(name) !== undefined;
  /**
   * A BSP map a match is played on, under its steps of the load screen: the file read once, then
   * the collision map and the world loaded from it as cgame loads them. The file is handed back
   * whole, as nothing loaded from it keeps it, for a server in this page to load as its own.
   *
   * @param collided - Told the map's entity text once its collision is in.
   */
  const loadBspMap = (
    name: string,
    steps: MapSteps,
    collided?: (entities: string) => void
  ): Promise<{ map: BspGameMap; bytes: Uint8Array }> =>
    steps.map.track(
      (async () => {
        const bytes = await readBsp(fs, name, (received, total) =>
          steps.map.advance(0, downloaded(received, total))
        );
        const map = await BspGameMap.load(app, camera.camera!, bytes, {
          ...(await worldOptions(name, 0)),
          cvars: config.cvars,
          collided: (entities) => {
            steps.collision.finish();
            // `RE_LoadWorldMap`, its images uploaded as each shader is registered.
            steps.map.advance(0, 'textures');
            collided?.(entities);
          }
        });
        return { map, bytes };
      })()
    );
  /**
   * The client's own load of the map a gamestate names, by what its files ship. A client with
   * neither file fails on the BSP, in `CM_LoadMap`'s words.
   */
  const loadClientMap = async (name: string, steps: MapSteps): Promise<GameMap | BspGameMap> =>
    mapKind(name) === 'splat' ? loadMap(name, steps) : (await loadBspMap(name, steps)).map;

  // q3_ui's `UI_LoadArenas`, which reads every arena at the start, says how many, and numbers them
  // in the order Start Server lists them. The game module's own read is for bots and Single Player.
  const parsed = loadArenas(
    await readInfoFiles(fs, ARENAS_FILE, '.arena', MENU_ARENA_LIST),
    (text) => console.log(text)
  );
  const arenas = menuArenas(parsed, (text) => console.log(text));
  // The bot files, which the game module loads its bots from at every map start. Q3's game module
  // reads them there itself; the port's reads nothing, so they are read once, here.
  const botFiles = await readInfoFiles(fs, BOTS_FILE, '.bot', BOT_LIST);
  // q3_ui's `UI_LoadBots` (`ui_gameinfo.c:412–444`): the same files read again for the menus, each
  // bot by its name and model. Q3's UI reads them for itself, and says nothing about them, as this
  // says nothing.
  const bots = loadInfos(botFiles, MAX_BOTS, MAX_BOTS_TEXT, () => {}).map((info) => ({
    name: infoValueForKey(info, 'name'),
    model: infoValueForKey(info, 'model')
  }));
  const botNames = bots.map((bot) => bot.name);

  // The match: the map being played, which `map <n>` changes, and the program playing it, whose
  // pmove controller drives the camera against the map's collision octree. There is none until
  // `map` starts one, and none again after `disconnect`; the map is in before the program starts.
  let map: GameMap | BspGameMap | null = null;
  let controller: PlayerController | null = null;
  /** The match's map from here on: the one just loaded, its world clearing as its kind does. */
  const playOn = (loaded: GameMap | BspGameMap) => {
    map = loaded;
    // A BSP map's scene: every draw in its world's list, its shaders in its registry.
    scene.enter(loaded instanceof BspGameMap ? loaded.world : null);
    camera.camera!.clearColor = loaded instanceof BspGameMap ? Color.BLACK : clearColor;
    // `tr.sunDirection`, as the map's load leaves it.
    setSunDirection(loaded instanceof BspGameMap ? loaded.world.sunDirection : undefined);
  };
  // A map's preview, in place of a match: its world, flown by the free camera, with no game, its
  // brush models where its entity text stands them, and the clock its stages play on.
  let mapPreview: BspWorld | null = null;
  let previewModels: readonly BrushModelPose[] = [];
  let previewClock = new PreviewClock(0);
  /** `r_offsetFactor` and `r_offsetUnits` as a frame reads them, into one object. */
  const worldOffset = { factor: 0, units: 0 };
  detachOverlayToggle = config.cvars.onChange((key) => {
    if (key === 'drawCollision' && map instanceof GameMap) {
      map.collision?.setVisible(settings.drawCollision);
    }
  });
  /** The program playing the match, for what only runs while there is one. */
  const current = (): PlayerController => {
    if (!controller) throw new Error('No match is running');
    return controller;
  };

  // First-person weapon. Built once the assets arrive; placement comes entirely
  // from the hand rig's `tag_weapon`, as Q3 does — see `viewmodel-rig.ts` for why that
  // matters. Declared here so the update loop below can drive it as soon as it exists.
  let viewmodel: ViewmodelRig | null = null;
  // cgame's local entities: one pool of 512 for the session, which every effect the client makes
  // and lets go of itself takes a place in.
  const localEntities = new LocalEntities();
  // Projectiles and impacts in the world; built alongside the viewmodel, from the same assets.
  let world: WorldEffects | null = null;
  // The map's items, drawn where the snapshots put them.
  let items: ItemEntities | null = null;
  // The flags carried on players' backs, one model a side, in a match of Capture the Flag.
  let trails: FlagTrails | null = null;
  // What floats in the world facing the view: the sprites over heads, and the score plums.
  let floats: FloatSprites | null = null;
  // `cg_drawBBox`'s hit boxes.
  let hitBoxes: HitBoxes | null = null;
  let sound: SoundBus | null = null;
  // The player's own body; everyone else's, and every corpse; and the gibs with the blood blob.
  let bodies: PlayerBodies | null = null;
  let players: PlayerEntities | null = null;
  let gibs: GibEffects | null = null;
  // The HUD: its 2D half, over everything, and its 3D icons, under that.
  let hud: HudScreen | null = null;
  let icons: HudIcons | null = null;
  // The menu's player preview, the Model page's icons, and the models and skins it offers; and
  // Start Server's levelshots.
  let preview: PlayerPreview | null = null;
  let menuIcons: MenuIcons | null = null;
  let levelshots: Levelshots | null = null;
  let menuModels: readonly PlayerModelSkin[] = [];
  /** Where the game data came from, which GAME DATA shows. */
  let gameData: GameDataContext | undefined;
  // The debug body, dev only.
  let debugPlayer: DebugPlayer | null = null;
  // The game is held until everything is in: under the load screen it neither runs nor takes the
  // keys and the mouse. `begin` lets it go. A map read later holds the match again, under a load
  // screen of its own.
  let began = false;
  let loadingMap = false;
  let begin: () => void = () => {};
  /**
   * A map's load screen, kept over the match once the map is in until the player is put in it, as
   * Quake 3 draws `CG_DrawInformation` until the first snapshot the player is in. The match runs
   * under it meanwhile.
   */
  let entering: Pick<LoadScreen, 'close'> | null = null;
  /**
   * The entering screen's steps for its match's first gamestate, which loads under it, or null
   * once that has loaded.
   */
  let enteringGamestate: GamestateSteps | null = null;
  const closeEntering = () => {
    entering?.close();
    entering = null;
    enteringGamestate = null;
  };
  /** The match the boot's `+map` started, and its gamestate's steps on the boot's screen. */
  let bootMatch = null as { playing: PlayerController; gamestate: GamestateSteps } | null;

  // The map the player moves in: whichever is loaded, asked at each trace, each point's contents
  // and each inline model, so that a map can be changed under the host, the view, the gibs and
  // the effects. With none, nothing is solid and there is no water.
  const worldTrace: TraceFn = (start, mins, maxs, end, passEntityNum, contentmask) =>
    map ? map.trace(start, mins, maxs, end, passEntityNum, contentmask) : clearTrace(end);
  const worldContents: PointContentsFn = (point, passEntityNum) =>
    map ? map.pointContents(point, passEntityNum) : 0;
  const mapModels = () => map?.inlineModels ?? NO_INLINE_MODELS;
  const worldModels: InlineModels = {
    inlineModel: (index) => mapModels().inlineModel(index),
    contact: (model, origin, mins, maxs) => mapModels().contact(model, origin, mins, maxs),
    transformedBoxTrace: (model, start, mins, maxs, end, contentmask, origin, angles) =>
      mapModels().transformedBoxTrace(model, start, mins, maxs, end, contentmask, origin, angles),
    transformedPointContents: (point, model, origin, angles) =>
      mapModels().transformedPointContents(point, model, origin, angles),
    modelBounds: (model, mins, maxs) => mapModels().modelBounds(model, mins, maxs)
  };
  // `CG_Trace` and `CG_PointContents`: the client's world, the map and the brush models it was
  // sent where the match's frame stands them, which the gibs, the trails and the eye's warp are
  // in. With no match, the map alone.
  const clientWorldTrace: TraceFn = (start, mins, maxs, end, passEntityNum, contentmask) =>
    (controller?.trace ?? worldTrace)(start, mins, maxs, end, passEntityNum, contentmask);
  const clientWorldContents: PointContentsFn = (point, passEntityNum) =>
    (controller?.pointContents ?? worldContents)(point, passEntityNum);
  // The console, as far as the port has one: everything printed goes to the browser's console,
  // and its last few lines show over the top of the game, each on the real clock.
  const notify = new NotifyLines();
  const print = (text: string) => notify.print(text, performance.now());
  // The browser's own peer connections and WebSockets, for the page's client and its host alike.
  const createPeerConnection: PeerConnectionFactory = (iceServers) =>
    new RTCPeerConnection({ iceServers });
  const connectWebSocket = (url: string) => new WebSocket(url);
  // The client that outlasts every match: the page's own socket, the masters it reaches servers
  // through, and what it has asked of them.
  const cls = new ClientStatic({
    cvars: config.cvars,
    createPeerConnection,
    connect: connectWebSocket,
    print
  });
  // Its favourite servers, from their file, which is written again after every change.
  const favorites = new Favorites({ servers: cls.servers, print });
  favorites.load(setup.favorites.saved ?? '');
  keepFile(favorites, setup.favorites.stores, favorites.text());
  // The console's commands, `exec` among them, which reads the home folder before the port's own
  // cfgs. `viewpos` runs here, at the press, as Q3 runs a console command between frames.
  const commands = new CommandRouter({
    client: (argv) => {
      // The client's own, which run with no match as well.
      switch (argv[0]?.toLowerCase()) {
        case 'connect':
          cls.connect(argv, leaveFor, found);
          return true;
        case 'reconnect':
          cls.reconnect(leaveFor, found);
          return true;
        case 'disconnect':
          disconnect();
          return true;
        case 'serverstatus':
          cls.serverStatus(argv);
          return true;
        case 'globalservers':
          cls.globalServers(argv);
          return true;
        case 'localservers':
          cls.localServers();
          return true;
        case 'ping':
          cls.ping(argv);
          return true;
      }
      // A preview's view is the free camera's.
      if (!controller && mapPreview && isViewpos(argv)) {
        printViewpos(viewpos(flyer.view()), print);
        return true;
      }
      // cgame's own, which are nobody's while no cgame runs.
      if (!controller) return false;
      if (input.cgameCommand(argv)) return true;
      if (isViewpos(argv)) {
        printViewpos(viewpos(drawnView(controller)), print);
        return true;
      }
      // `CG_ScoresDown_f`/`CG_ScoresUp_f` (`cg_consolecmds.c:87–116`): the press asks the match
      // for the board when the cache is stale — `trap_SendClientCommand( "score" )` — and the
      // release starts the fade. The board itself draws from the state this moves on.
      if (argv[0] === '+scores') {
        if (scoresDown(scoreboardState, controller.time, controller.scores)) {
          controller.game.sendClientCommand('score');
        }
        return true;
      }
      if (argv[0] === '-scores') {
        scoresUp(scoreboardState, controller.time);
        return true;
      }
      // `CG_LoadDeferredPlayers` on demand (`cg_consolecmds.c:503`).
      if (argv[0]?.toLowerCase() === 'loaddeferred') {
        controller.loadDeferredPlayers();
        return true;
      }
      return false;
    },
    host: (line, argv) => {
      // A map that previews is no server's to load, so `map` leaves the match for it.
      const preview = argv[0].toLowerCase() === 'map' && argv[1] !== undefined && previews(argv[1]);
      if (controller && preview) return startMatch(argv[1]);
      if (!controller?.game.consoleCommand(line)) return noServer(line, argv);
      return argv[0].toLowerCase() === 'map' ? hostSettled(controller) : true;
    },
    config: (argv) => config.command(argv),
    forward: (line) => forward(line),
    readCfg: (path) => readCfg(path, setup.home),
    print
  });
  /**
   * The host's commands with no server running in this page, as Q3 answers them with
   * `com_sv_running` 0 (`sv_ccmds.c:223, 335`): `map` starts one, and the game module's are
   * nobody's here, so they go to a server elsewhere as the client's.
   */
  const noServer = (line: string, argv: readonly string[]): boolean | Promise<void> => {
    if (argv[0].toLowerCase() === 'map') return startMatch(argv[1]);
    if (!isHostCommand(argv[0])) return forward(line);
    print('Server is not running.\n');
    return true;
  };
  /**
   * `CL_ForwardCommandToServer`: a command nothing here knows, sent to the match's server as a
   * client command. Whether there was a match to send it to.
   */
  const forward = (line: string): boolean => {
    if (!controller) return false;
    controller.game.sendClientCommand(line);
    return true;
  };
  /**
   * Resolves once the host has run the commands it was sent, and read any map they asked for: a
   * `map` holds the command buffer as Q3's load holds the program. The host runs them at the top of
   * its next frame, so this looks after each of the page's frames.
   */
  const hostSettled = (playing: PlayerController): Promise<void> =>
    new Promise((resolve, reject) => {
      const look = () => {
        const running = controller === playing && playing.game.failure === null;
        if (
          running &&
          (playing.game.commandsPending || playing.game.mapLoad || playing.game.clientLoad)
        ) {
          return;
        }
        app.off('update', look);
        // A match dropped meanwhile takes the commands behind the map with it.
        if (running) resolve();
        else reject(new Error('Disconnected from server'));
      };
      app.on('update', look);
    });
  // The player's keys and mouse, through the binds. A bound command that is neither a
  // button nor a weapon's runs as the console would run it, C's toggle among them.
  const input = new ClientInput(config.binds, { command: (argv) => commands.execute(argv) });
  // The server's map is the entity text and the collision, and the server's own to read: the
  // page reads the files and hands them to the worker that hosts the match. The world
  // the client draws and predicts in is the client's own load, from the gamestate it is sent.
  /** Where a worker's program finds maps: the page's search path reads them. */
  const workerMaps: MapFiles = {
    names: () => mapNames(fs),
    read: (name) => readHostMapData(fs, name)
  };
  /**
   * `CL_InitCGame` (`cl_cgame.c:711–770`), at every gamestate, while its frames wait: what the last
   * gamestate's cgame left goes (`CL_FlushMemory`), the map it names is read from the client's own
   * files where it is not the one in hand, and everyone it names is registered (`CG_Init`). All of
   * it under a load screen, as every `CL_InitCGame` draws one: for a match's first gamestate, the
   * screen the match was started under; otherwise one of its own.
   */
  const clientLoader: ClientLoader = {
    load: async (name) => {
      const playing = controller;
      const inHand = map?.name === name;
      loadingMap = true;
      let screen: Pick<LoadScreen, 'close'>;
      let loads: { map: MapSteps | null; gamestate: GamestateSteps };
      if (inHand && entering !== null && enteringGamestate !== null) {
        screen = entering;
        loads = { map: null, gamestate: enteringGamestate };
        entering = null;
        enteringGamestate = null;
      } else {
        closeEntering();
        const own = setup.loadScreen(name);
        closeConnectScreen();
        if (playing) {
          const { game } = playing;
          own.showServer(game.connection.servername);
          const info = gamestateInfo((index) => game.configstring(index), !game.channel.svRunning);
          own.showInformation(matchLines(info));
        }
        loads = {
          map: inHand ? null : mapSteps(own, mapFile(name)),
          gamestate: gamestateSteps(own)
        };
        screen = own;
      }
      let world: GameMap | BspGameMap;
      try {
        // `CG_Shutdown`: what the last gamestate's cgame left goes with it, and a map kept in hand
        // is drawn as the renderer started again draws it.
        clearMatch();
        if (inHand && map instanceof BspGameMap) map.world.unswap();
        if (loads.map) {
          await map?.destroy();
          map = null;
          const next = await loadClientMap(name, loads.map);
          // A match dropped while its next map loaded has no use for it.
          if (controller !== playing) {
            void next.destroy();
            throw new Error('Disconnected from server');
          }
          playOn(next);
        }
        await registerSounds(playing, loads.gamestate.sounds);
        // `CG_RegisterGraphics`, for the scene's order: cgame's shaders after the world's.
        sceneShaders.bind(map instanceof BspGameMap ? map.world.registry : null);
        // `CG_InitMarkPolys`, and the polys tested against the new world's fogs.
        marks.clear();
        scenePolys.inWorld(map instanceof BspGameMap ? map.world.registry.fogs : []);
        await registerSceneGraphics(playing);
        await registerFlags(playing);
        await registerItems(playing, loads.gamestate.items);
        await registerClients(playing, loads.gamestate.clients);
        if (controller !== playing || map === null) throw new Error('Disconnected from server');
        await warmMatch();
        // `CG_Init`'s `CG_StartMusic` (`cg_main.c:1937`), heard from the frame after the load, as
        // Quake 3 mixes nothing until `CL_InitCGame` is done.
        if (playing && controller === playing) {
          sound?.startMusic(playing.game.configstring(CONFIGSTRING.MUSIC));
        }
        world = map;
      } catch (err) {
        screen.close();
        throw err;
      } finally {
        loadingMap = false;
      }
      entering = screen;
      // `CL_InitCGame`'s clearing: nothing the last gamestate printed shows under this one.
      notify.clear();
      return { name, trace: world.trace };
    }
  };
  /**
   * `map <n>` with no match: `SV_Map_f`'s look for the map (`sv_ccmds.c:138–171`), then a match
   * on it, which resolves once the map is in and the program is playing it. The menu goes as the
   * load starts, as `CL_MapLoading` takes the keys from it.
   */
  const startMatch = (name: string | undefined): boolean | Promise<void> => {
    const boot = bootSteps;
    bootSteps = null;
    if (!name) return true;
    const kind = mapKind(name);
    if (kind === null) {
      print(`Can't find map ${bspPath(name)}\n`);
      return true;
    }
    menu.forceOff();
    // `CL_MapLoading` (`cl_main.c:1303–1306`): a client of a server elsewhere leaves it.
    closeConnectScreen();
    if (controller || mapPreview) leave();
    return previews(name) ? buildPreview(name, boot) : buildMatch(name, boot);
  };
  /**
   * A match on a map that is there, under the boot's screen or one of its own, which its first
   * gamestate then loads under.
   */
  const buildMatch = async (name: string, boot: MatchSteps | null): Promise<void> => {
    const screen = boot ? null : setup.loadScreen(name);
    const shown = screen ?? setup.loading;
    const loads = boot ?? matchSteps(screen!, mapFile(name));
    // `CL_MapLoading`'s name for the server in this process (`cl_main.c:1307`).
    shown.showServer('localhost');
    loadingMap = true;
    let playing: PlayerController;
    try {
      // cgame's lines, for the whole load: the server they describe starts only once the world is
      // in, so they are read from what it will start with. `map` leaves cheats off, and a
      // DEBUG_MODE build on (`sv_ccmds.c:210–218`).
      const inform = (entities: string) => {
        const info = localInfo((cvar) => config.cvars.get(cvar), entities, config.cvars.debugMode);
        shown.showInformation(matchLines(info));
      };
      // The client's world first, as `CL_InitCGame` loads it, then the server's map, which the
      // worker's `SV_SpawnServer` reads (`CM_LoadMap` and `CM_EntityString`) before the gamestate
      // goes out.
      let serverMap: HostMapData;
      if (mapKind(name) === 'bsp') {
        // The worker is handed the file the client read, once the client has loaded from it.
        const loaded = await loadBspMap(name, loads.map, inform);
        playOn(loaded.map);
        serverMap = { kind: 'bsp', name, bsp: wholeBuffer(loaded.bytes) };
      } else {
        const entities = await readEntityText(fs, name);
        inform(entities);
        playOn(await loadMap(name, loads.map, entities));
        serverMap = await readHostMapData(fs, name);
      }
      playing = await play(serverMap);
      controller = playing;
    } catch (err) {
      screen?.close();
      drop(err);
      throw err;
    } finally {
      loadingMap = false;
    }
    // The boot's screen is the boot's to hand over, once the boot is done.
    if (screen) {
      entering = screen;
      enteringGamestate = loads.gamestate;
    } else {
      bootMatch = { playing, gamestate: loads.gamestate };
    }
    notify.clear();
  };
  /** The shader scripts the boot parsed, in Q3's order; none where the boot failed. */
  const shaderScripts = async (): Promise<Map<string, ShaderScript>> =>
    (await assets?.catch(() => undefined))?.library.shaders ?? new Map<string, ShaderScript>();
  /**
   * A map's preview, for a BSP map while `pcq_preview` is set: its world, for the free camera to
   * fly from where a spectator first stands, with no game, server or player. It loads under the
   * boot's screen or one of its own, as a match's map does, and is drawn once under it before it
   * shows.
   */
  const buildPreview = async (name: string, boot: MatchSteps | null): Promise<void> => {
    const screen = boot ? null : setup.loadScreen(name);
    const shown = screen ?? setup.loading;
    const path = bspPath(name);
    const step = boot ? boot.map.map : screen!.step(path, MAP_WEIGHT);
    if (boot) {
      // What a match loads after its world, which a preview has no use for.
      boot.map.collision.finish();
      boot.gamestate.items.finish();
      boot.gamestate.clients.finish();
    }
    loadingMap = true;
    let models: readonly BrushModelPose[] = [];
    try {
      // `RE_LoadWorldMap`, its images uploaded as each shader is registered.
      const world = await step.track(
        (async () => {
          const bytes = await readBsp(fs, name, (received, total) =>
            step.advance(0, downloaded(received, total))
          );
          const bsp = parseBsp(bytes, path);
          shown.showInformation(previewLines(bsp.entityString));
          models = brushModelsAtRest(readEntities(bsp.entityString), bsp.models);
          step.advance(0, 'textures');
          return BspWorld.load(app, camera.camera!, {
            ...(await worldOptions(name, settings.previewTime)),
            bsp
          });
        })()
      );
      mapPreview = world;
      scene.enter(world);
      sceneShaders.bind(world.registry);
      setSunDirection(world.sunDirection);
      previewModels = models;
      previewClock = new PreviewClock(settings.previewTime);
      flyer.start(spectatorStart(readEntities(world.entities)));
      placeCamera(flyer.view());
      camera.camera!.clearColor = Color.BLACK;
      await warmPreview(world);
    } catch (err) {
      screen?.close();
      drop(err);
      throw err;
    } finally {
      loadingMap = false;
    }
    screen?.close();
    notify.clear();
  };
  /**
   * The match on a map, wired to the page: its console, and the bodies of who joins.
   *
   * The server's program is the worker's: the page boots it with the map's bytes, its own
   * store's values, the bot files and the map listing, and reads the client's half of the channel
   * from then on.
   */
  const play = async (serverMap: HostMapData): Promise<PlayerController> => {
    const channel = new WorkerChannel({
      cvars: config.cvars,
      maps: workerMaps,
      boot: { map: serverMap, botFiles, debugMode: config.cvars.debugMode },
      print,
      // Players elsewhere reach the server through the page's own peer connections and masters.
      peers: { createPeerConnection, connect: connectWebSocket }
    });
    // The worker builds its program and reads the map before it can answer a connect; wait for it,
    // so the client's first `connect` is answered at once rather than retransmitted into a
    // `loopback:reconnect` while the program is still being built.
    await channel.ready;
    const playing = new PlayerController(
      camera,
      input,
      worldTrace,
      channel,
      config.cvars,
      { clientLoader },
      localEntities,
      worldContents,
      worldModels
    );
    wire(playing);
    return playing;
  };
  /**
   * The match on a server elsewhere that `connect` found, through the page's own socket. Its map
   * is the one the server's gamestate names, which the client reads from its own files.
   */
  const join = (server: string, address: NetAdr): PlayerController => {
    const channel = new RemoteChannel(cls.net);
    const playing = new PlayerController(
      camera,
      input,
      worldTrace,
      channel,
      config.cvars,
      { clientLoader, connect: { server, address } },
      localEntities,
      worldContents,
      worldModels
    );
    wire(playing);
    return playing;
  };
  /** A match wired to the page: the page's client, its console, and the bodies of who joins. */
  const wire = (playing: PlayerController) => {
    cls.attach(playing.game.channel.net, playing.game.connection);
    playing.console = { print, clearNotify: () => notify.clear() };
    // Q3 takes a player's gender from the model their clientinfo loaded, so it is read off the
    // body built for them: the player's own, or the one drawing their entity. Male until one is
    // built.
    playing.gender = (clientNum) => {
      const own = clientNum === playing.player.clientNum;
      const config = own ? bodies?.config : players?.body(clientNum)?.config;
      return config?.gender ?? 'male';
    };
    // `CG_LoadClientInfo` as a client's look is loaded during play, which no warm-up follows.
    playing.registerClient = (info) =>
      void registerSceneLook(info.look).then(() =>
        registerLook(info.look, playing.wearers(info.look), true)
      );
  };
  /**
   * `CG_LoadClientInfo` (`cg_players.c:652–734`): a look's models read and its bodies built, its
   * sounds, and its portrait for the scoreboard, so that the first frame to draw them has them.
   * Reading a model out of the paks costs around 150 ms, and a body waiting on it is a bot that
   * spawns bodiless. Only the player's own look can arrive before the media are in, and the boot
   * has already read it.
   *
   * @param wearers - How many clients are drawn in the look, each with a body of it.
   * @param warm - Whether to draw a look's new bodies once now, as a load's warm-up would.
   */
  const registerLook = async (look: PlayerLook, wearers: number, warm = false): Promise<void> => {
    const entities = players;
    const bus = sound;
    const icons = menuIcons;
    if (!entities) return;
    if ((await entities.register(look, wearers)) && warm) {
      try {
        warmUp(app, [await entities.warm([look]), scene.warm()]);
      } catch (err) {
        console.warn('Warm-up failed:', err);
      }
    }
    const portrait = headIcon(look.head);
    await Promise.all([bus?.loadVoice(look.body.model), portrait && icons?.prepare(portrait)]);
  };
  /**
   * `CG_RegisterGraphics` after the world (`cg_main.c:822-1065`), for the order a BSP map's scene
   * sorts cgame's shaders in: its media, the flags and the team's in the games that have them, the
   * items `CS_ITEMS` lists with their weapons, the marks, and `CS_MODELS`' models.
   */
  const registerSceneGraphics = async (playing: PlayerController | null) => {
    if (!playing || !(map instanceof BspGameMap)) return;
    const { game } = playing;
    const models: string[] = [];
    for (let i = 1; i < MAX_MODELS; i++) {
      const name = game.configstring(CONFIGSTRING.MODELS + i);
      if (!name) break;
      models.push(name);
    }
    const { gametype } = serverInfo(game.configstring(CONFIGSTRING.SERVERINFO));
    const items = game.configstring(CONFIGSTRING.ITEMS);
    const { world } = map;
    await sceneShaders.registerGraphics({ gametype, items, models }, sceneSources);
    // The marks' stages, made with the world's for the warm-up.
    await world.preparePolys(Object.values(marksMedia));
  };
  /**
   * `CG_RegisterClientModelname`'s registrations of a look (`cg_players.c:522-614`), for the
   * scene's order: its legs', torso's and head's models, then their skins.
   */
  const registerSceneLook = (look: PlayerLook): Promise<void> => {
    const dir = playerModelDir(look.body.model);
    const headDir = playerModelDir(look.head.model);
    const files = {
      models: [`${dir}lower.md3`, `${dir}upper.md3`, `${headDir}head.md3`],
      skins: [
        `${dir}lower_${look.body.skin}.skin`,
        `${dir}upper_${look.body.skin}.skin`,
        `${headDir}head_${look.head.skin}.skin`
      ]
    };
    return sceneShaders.registerLook(files, sceneSources);
  };
  /**
   * `CG_RegisterSounds`' `CS_SOUNDS` (`cg_main.c:715-724`): each sound the gamestate names, read
   * and registered before the graphics, each named under the screen's line.
   */
  const registerSounds = async (playing: PlayerController | null, step: LoadStep) => {
    if (playing && sound) {
      const { game } = playing;
      await sound.registerGameSounds(
        (index) => game.configstring(CONFIGSTRING.SOUNDS + index),
        (done, total, name) => step.advance(done / total, name)
      );
    }
    step.finish();
  };
  /**
   * The flags' models, which `CG_RegisterGraphics` registers before the items, and only for a
   * match of Capture the Flag (`cg_main.c:892–897`).
   */
  const registerFlags = async (playing: PlayerController | null) => {
    if (!playing) return;
    await trails?.register(serverInfo(playing.game.configstring(CONFIGSTRING.SERVERINFO)).gametype);
  };
  /**
   * `CG_RegisterItemVisuals` for every item a gamestate's `CS_ITEMS` lists (`cg_main.c:1014–1022`),
   * each named under the screen's line as `CG_LoadingItem` names it (`cg_info.c:79–89`).
   */
  const registerItems = async (playing: PlayerController | null, step: LoadStep) => {
    if (playing && items) {
      const slots = listedItems(playing.game.configstring(CONFIGSTRING.ITEMS));
      await items.register(slots, (slot, at) =>
        step.advance(at / slots.length, ITEMS[slot].pickupName)
      );
    }
    step.finish();
  };
  /**
   * `CG_RegisterClients` (`cg_main.c:1129–1150`): everyone a gamestate names, each named under the
   * screen's line as `CG_LoadingClient` names them (`cg_info.c:130–137`), and each look loaded
   * before the first frame draws it, none put off.
   */
  const registerClients = async (playing: PlayerController | null, step: LoadStep) => {
    if (playing) {
      const clients = playing.registerClients();
      for (const [at, { info, load }] of clients.entries()) {
        step.advance(at / clients.length, `${cleanStr(info.name)} (${at + 1}/${clients.length})`);
        if (!load) continue;
        await registerSceneLook(info.look);
        await registerLook(info.look, playing.wearers(info.look));
      }
    }
    step.finish();
  };
  /**
   * `RE_EndRegistration`, the last of `CL_InitCGame` (`cl_cgame.c:761`): everything the match can
   * draw, drawn once under the load screen (`render/warm-up.ts`), and the device's work waited for.
   * First a frame draws the map's splat sorted, as a splat's first such frame copies it in a pass
   * of its own. One that fails costs only the compiles it would have saved, so the load goes on
   * without it.
   */
  const warmMatch = async () => {
    try {
      await splatsSorted(app, camera.camera!);
      const entities = players;
      const warmed = await Promise.all([
        map?.warm(camera),
        world?.warm(),
        items?.warm(),
        viewmodel?.warm(),
        gibs?.warm(),
        hud?.warm(),
        icons?.warm(),
        trails?.warm(),
        floats?.warm(),
        hitBoxes?.warm(),
        bodies?.warm(),
        entities?.warm(),
        // Every kind of stage a look that joins later can draw.
        entities ? skinShaders().then((names) => entities.warmKinds(names, hasImage)) : undefined,
        scoreboardScreen.warm(),
        hyperspace.warm(),
        // Every fog pass the rest hold, on a map with fogs.
        scene.warm()
      ]);
      warmUp(app, warmed.filter((draws): draws is Warmed => draws !== undefined));
      await gpuFinished(app.graphicsDevice);
    } catch (err) {
      console.warn('Warm-up failed:', err);
    }
    if (made) madeAtWarmUp = { ...made };
  };
  /** {@link warmMatch} for a preview, whose world is all it draws. */
  const warmPreview = async (world: BspWorld) => {
    try {
      warmUp(app, [world.warm(), scene.warm()]);
      await gpuFinished(app.graphicsDevice);
    } catch (err) {
      console.warn('Warm-up failed:', err);
    }
    if (made) madeAtWarmUp = { ...made };
  };
  /** `Com_Error`'s banner (`common.c:286–292`). */
  const printError = (message: string) =>
    print(`********************\nERROR: ${message}\n********************\n`);
  /**
   * The match goes, and the page is left with none: `SV_Shutdown` and `CL_Disconnect`.
   *
   * @param finalMessage - What a server in this page tells its clients, in Quake 3's words for what
   *   ended it. A server elsewhere is told only that this client left.
   * @param error - Whether `Com_Error` ends it, whose shutdown tells the server's clients nothing
   *   (`sv_init.c:751`).
   */
  const leave = (finalMessage = '', error = false) => {
    // `SV_Shutdown` (`sv_init.c:742–777`): the server stops, which `sv_running` says, and the
    // client leaves its server.
    controller?.game.shutdown(finalMessage, error);
    controller = null;
    closeConnectScreen();
    closeEntering();
    cls.detach();
    menu.forceOff();
    clearMatch();
    const gone = map;
    map = null;
    void gone?.destroy();
    const previewed = mapPreview;
    mapPreview = null;
    void previewed?.destroy();
    camera.camera!.clearColor = clearColor;
  };
  /**
   * `disconnect` (`CL_Disconnect_f`, `cl_main.c:998–1004`): the match goes by id's
   * `ERR_DISCONNECT`, whose banner says so, and which leaves no message for the main menu.
   */
  const disconnect = () => {
    if (!controller) {
      // A `connect` still looking its server up goes as it came, and so does a preview, which no
      // server was playing.
      closeConnectScreen();
      if (mapPreview) leave();
      return;
    }
    printError('Disconnected from server');
    leave('Server disconnected', true);
  };
  /** A `connect` under way, from the command until the map its server names is being read. */
  let connectScreen: Pick<ConnectScreen, 'show' | 'close'> | null = null;
  const closeConnectScreen = () => {
    connectScreen?.close();
    connectScreen = null;
  };
  /**
   * `CL_Connect_f`'s work before the server is looked up: whatever the page was playing goes,
   * and the connect's screen comes up, titled with the server as it was named.
   */
  const leaveFor = (finalMessage: string, server: string) => {
    closeConnectScreen();
    if (controller || mapPreview) leave(finalMessage);
    // `Con_Close` and `Key_SetCatcher( 0 )`.
    notify.clear();
    menu.forceOff();
    connectScreen = setup.connectScreen(server);
  };
  /**
   * `CL_Connect_f`, once the server is found or isn't: the match on it, or the main menu. A
   * lookup given up meanwhile, by `disconnect` or a map, has no screen left to end.
   */
  const found = (server: string, address: NetAdr | null) => {
    if (connectScreen === null) return;
    if (address === null) closeConnectScreen();
    else controller = join(server, address);
  };
  /**
   * The message a dropped match left, for the main menu to show: `com_errorMessage`, which only
   * the error screen's key clears.
   */
  let errorMessage: string | null = null;
  /**
   * `Com_Error( ERR_DROP )`: a match that can't go on, whether its map failed to load or it threw
   * in its frame, goes as `disconnect` takes it, and its message is kept for the main menu.
   */
  const drop = (err: unknown) => {
    errorMessage = err instanceof Error ? err.message : String(err);
    printError(errorMessage);
    leave(`Server crashed: ${errorMessage}`, true);
  };
  /**
   * `Com_Error( ERR_SERVERDISCONNECT )`: the server let this client go and said why, which the
   * main menu shows. Nothing is printed, and a server in this page goes with the match.
   */
  const serverDisconnect = (err: ServerDisconnect) => {
    errorMessage = err.message;
    leave('Server disconnected', true);
  };
  /**
   * `Com_Quit_f` (`common.c:376–392`): the program quitting, by EXIT GAME or a tab going. The
   * server's clients are told "Server quit", or a server elsewhere that this client has left, and
   * the match goes. Once gone, a second quit has nothing to tell.
   */
  const quit = () => {
    if (controller) leave('Server quit');
  };
  // A tab going goes on without waiting, and the worker with it, so its quit is a best try. A page
  // kept for the back button has not quit.
  const pageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) quit();
  };
  window.addEventListener('pagehide', pageHide);
  app.on('destroy', () => window.removeEventListener('pagehide', pageHide));
  // The in-game menu. Escape, or losing the mouse, opens it over the game, which waits
  // under it. Resume and Restart ask for the mouse back from their own click; a browser that
  // refuses leaves the game running without it until a click on the view, as at the start.
  // The keys and the mouse, once the game begins.
  let keys: KeyInput | null = null;
  const menu = new Menu({
    sound: (cue) => sound?.playMenu(cue),
    closed: () => {
      if (keys) keys.menuOpen = false;
    }
  });
  // `trap_Cmd_ExecuteText` for the two commands the bot pages send, which go where a bind's go:
  // the host's command buffer, run at the top of its next frame.
  const sendCommand = (...argv: (string | number)[]) =>
    current().game.consoleCommand(commandLine(argv));
  /** `trap_Cmd_ExecuteText`: a console command from a page, run as a bind's would run. */
  const runCommand = (argv: readonly string[]) => {
    if (!commands.execute(argv)) console.warn(`Unknown command "${argv[0]}"`);
  };
  // The presets both Server Options pages offer, looked for again each time the in-game menu opens
  // or Server Options is built, so a cfg put in the home folder's `presets` meanwhile is offered.
  let presets: readonly string[] = SHIPPED_PRESETS;
  const refreshPresets = () => void listPresets(setup.home).then((found) => (presets = found));
  const models = () => menuModels;
  const { launchVsync } = setup;
  const setupMenu = setupPage({
    menu,
    config,
    models,
    gameData: () => gameData,
    actions: host,
    launchVsync
  });
  const startServer = startServerPage({
    menu,
    config,
    arenas,
    bots: () => bots,
    presets: () => presets,
    refreshPresets,
    missing: (icon) => menuIcons?.missing(icon) ?? false,
    actions: { command: runCommand },
    canDraw: (map) => mapKind(map) !== null,
    preview: previews
  });
  // The server browser, over the client's lists, which outlive it.
  const servers = serversMenu({
    menu,
    config,
    actions: { command: runCommand },
    servers: cls.servers,
    status: cls,
    favorites,
    startServer,
    protocol: cls.net.protocol,
    now: cls.net.now
  });
  const mainMenu = mainPage(menu, setupMenu, startServer, servers, host, config);
  const inGame = inGamePage(
    {
      menu,
      config,
      models,
      launchVsync,
      bots: () => botNames,
      presets: () => presets,
      clientInfo: (clientNum) => controller?.clientInfo(clientNum) ?? null,
      // `cgs.gametype`: what the match is playing, which a restart into another game moves and
      // the latched cvar does not. With no match, what the next one will play.
      gametype: () =>
        controller
          ? serverInfo(controller.game.configstring(CONFIGSTRING.SERVERINFO)).gametype
          : atoi(config.cvars.get('g_gametype')),
      maxClients: () =>
        controller ? serverInfo(controller.game.configstring(CONFIGSTRING.SERVERINFO)).maxclients : 0,
      // The string itself, for Server info's read-only page.
      serverinfo: () => (controller ? controller.game.configstring(CONFIGSTRING.SERVERINFO) : ''),
      // `sv_running`, for the rows a client of a remote server greys: the worker's word,
      // where the host runs elsewhere.
      serverRunning: () => controller?.game.channel.svRunning ?? false,
      matchRunning: () => controller !== null,
      actions: {
        ...host,
        resume: () => keys?.capture(),
        restart: () => {
          current().restart();
          keys?.capture();
        },
        // `cmd team <what>`, which goes to the match as a client command rather than through the
        // host's buffer: it is the player's own word about where they are playing.
        setTeam: (team) => current().game.sendClientCommand(`team ${team}`),
        addBot: (name, skill, team, delay) => sendCommand('addbot', name, skill, team, delay),
        removeBot: (clientNum) => sendCommand('clientkick', clientNum),
        command: runCommand,
        addFavorite: (address, name) => void favorites.add(address, name)
      }
    },
    setupMenu
  );
  /**
   * The in-game menu, over the game. While the match is not in the world yet — connecting, or
   * reading a map — Escape leaves it instead, and the mouse lost does nothing, as a minimised Q3
   * (`cl_keys.c:1294–1302`).
   */
  const openMenu = (escape: boolean) => {
    if (connectScreen !== null || (controller && controller.game.connection.state !== CA.ACTIVE)) {
      if (escape) disconnect();
      return;
    }
    if (!controller && !mapPreview) return;
    refreshPresets();
    menu.open(inGame);
    if (keys) keys.menuOpen = true;
  };
  /** `UI_MainMenu`: the main menu, or its error screen while a dropped match's message stands. */
  const openMain = () => {
    const page =
      errorMessage === null
        ? mainMenu
        : errorPage(errorMessage, () => {
            errorMessage = null;
            menu.open(mainMenu, 'q3ui');
          });
    menu.open(page, 'q3ui');
    if (keys) keys.menuOpen = true;
  };
  begin = () => {
    keys = new KeyInput(
      canvas,
      input,
      {
        key: (key) => menu.key(key),
        char: (ch) => menu.char(ch),
        paste: (text) => menu.paste(text),
        open: openMenu
      },
      controller !== null || mapPreview !== null
    );
    keys.menuOpen = menu.isOpen;
    began = true;
  };
  // The scoreboard: `cg`'s own state, and the port's screen for it. It draws over the HUD, and
  // over the menu only for the server browser's board, since Q3 draws none of the match's while
  // the menu is up.
  const scoreboardState = createScoreboardState();
  /** The match's board this frame, or null: drawn at the frame's end, unless the menu shows one. */
  let gameBoard: Scoreboard | null = null;
  const scoreboardScreen = new ScoreboardScreen(app, camera);
  const menuScreen = new MenuScreen(app, camera, menu);
  // Game options' crosshair, drawn from the HUD's own pictures once it has them (`Crosshair_Draw`),
  // the Model page's icons, which are the models' own, and Start Server's levelshots.
  menuScreen.images = (name) => {
    if (name.startsWith('models/players/')) return menuIcons?.get(name) ?? null;
    if (name.startsWith('levelshots/')) return levelshots?.get(name) ?? null;
    return hud?.image(name) ?? null;
  };
  if (import.meta.env.DEV) {
    // Dev-only, like `pcq` below: the controller, so a smoke check can reach the player's life.
    // `pcqInput.active = true` stands in for the captured mouse, which a script can't take, so
    // synthetic keys reach the game. `pcqMenu.open()` opens the menu, as a script can't press
    // Escape for the browser, and `pcqMenu.menu.key(k)` presses a key in it; `pcqMenu.setup()`
    // opens Setup's pages where q3_ui puts them. `pcqMap()` is the map being played, so a check can
    // count what it holds and what freeing it gives back, and `pcqError()` the message a dropped
    // match left.
    Object.defineProperty(window, 'pcqController', { configurable: true, get: () => controller });
    (window as unknown as { pcqInput: unknown }).pcqInput = input;
    // `pcqConsole('disconnect')` runs a console line, as a script can't type one.
    (window as unknown as { pcqConsole: unknown }).pcqConsole = (line: string) => {
      for (const argv of configCommands(line)) {
        if (!commands.execute(argv)) console.warn(`Unknown command "${argv[0]}"`);
      }
    };
    (window as unknown as { pcqMenu: unknown }).pcqMenu = {
      menu,
      open: () => openMenu(true),
      setup: () => {
        menu.open(setupMenu, 'q3ui');
        if (keys) keys.menuOpen = true;
      }
    };
    (window as unknown as { pcqMap: unknown }).pcqMap = () => map;
    // `pcqPreview()` is a map's preview once it is in and drawn, for a check to wait on, as one
    // waits on `pcqController` for a match.
    (window as unknown as { pcqPreview: unknown }).pcqPreview = () =>
      loadingMap ? null : mapPreview;
    (window as unknown as { pcqError: unknown }).pcqError = () => errorMessage;
    // `pcqClient` is the page's client, whose lists and pings a check reads as the browser would.
    (window as unknown as { pcqClient: unknown }).pcqClient = cls;
    // Dev-only, like `pcqController`: the worker's program, for a live check's reads. The
    // host's clock and map are the worker's, and only the mirrors cross; `pcqDev({ op: 'state' })`
    // asks it there, and `pcqDev({ op: 'cvar', name, value })` moves one where it reads it.
    (window as unknown as { pcqDev: unknown }).pcqDev = (request: DevRequest) => {
      const channel = controller?.game.channel;
      return channel instanceof WorkerChannel ? channel.dev(request) : null;
    };
  }
  // Where the player stands, for the debug body to stand in front of.
  const playerPlace = () => ({
    origin: current().player.origin,
    yaw: current().player.viewangles.y
  });
  // Which weapon the rig has been asked for. Tracked here rather than calling `select`
  // every frame purely to avoid allocating a promise per frame for a no-op.
  let shownWeapon: WeaponId | null = null;
  // The fly camera: out of the eyes, and flown through the binds while the game waits.
  const flyer = new FreeCamera();
  // The game view's light: the map's grid, and its dynamic lights (`tr.refdef.dlights`), gathered
  // each frame before anything is shaded. The HUD's models and the menu's are scenes of their own,
  // with no world, and take neither.
  const sceneLights = new SceneLights();
  // The impacts' explosions, kept ahead of both what draws them and what they light.
  const explosions = new Explosions(Math.random, localEntities);
  // The frame's polys (`RE_AddPolyToScene`), which a BSP map's world draws, and cgame's marks, cut
  // on its world (`R_MarkFragments`) and added to them each frame, as are the shadows and wakes.
  const scenePolys = new ScenePolys<SortedShader>(print);
  const marksMedia = markMedia((name) => sceneShaders.handle(name, LIGHTMAP_2D));
  // `RE_RegisterShader` gives a shader that failed 0, which a poly refuses.
  const addPoly = (shader: SortedShader, numVerts: number, verts: PolyVerts, first: number) =>
    scenePolys.add(shader.shader?.defaultShader ? null : shader, numVerts, verts, first);
  const marks = new Marks<SortedShader>(
    {
      markFragments: (numPoints, points, projection, maxPoints, pointBuffer, maxFragments, out) =>
        map instanceof BspGameMap
          ? map.world.marks.markFragments(
              numPoints,
              points,
              projection,
              maxPoints,
              pointBuffer,
              maxFragments,
              out
            )
          : 0,
      addPoly
    },
    marksMedia.energy
  );
  // The same lights on the splat map, through the material every splat component draws with.
  const splatLights = new SplatLights(app.scene.gsplat.material);
  if (import.meta.env.DEV) {
    // Dev-only, like `pcqController` above: the frame's lights, so a check can see what lit it.
    (window as unknown as { pcqLights: unknown }).pcqLights = sceneLights;
    // And the fly camera, which a check places with `start` and reads with `view`.
    (window as unknown as { pcqFlyer: unknown }).pcqFlyer = flyer;
    // And the marks kept and the frame's polys, so a check can count what was added.
    (window as unknown as { pcqMarks: unknown }).pcqMarks = { marks, polys: scenePolys };
  }
  let flying = false;
  // `cg.refdef`: the view the last frame was drawn from, which `viewpos` reads. The controller's,
  // or the fly camera's while it is out.
  const drawnView = (playing: PlayerController): FirstPersonView =>
    flying ? flyer.view() : { origin: playing.viewOrigin, angles: playing.viewAngles };
  /** The eye's pose, written again each frame it is placed. */
  const eyePose: CameraPose = { position: [0, 0, 0], target: [0, 0, 0], up: [0, 0, 0] };
  /** Put the eye at a view, in Q3's frame. */
  const placeCamera = (view: FirstPersonView) => {
    const { position, target, up } = cameraPose(view, eyePose);
    camera.setPosition(position[0], position[1], position[2]);
    camera.lookAt(target[0], target[1], target[2], up[0], up[1], up[2]);
  };
  /**
   * `CG_CalcFov`'s warp while the eye is in a liquid: the world, its vis and the view weapon all
   * take it.
   *
   * @param time - `cg.time`.
   */
  const warpEye = (eye: Vec3, time: number) =>
    setEyeFov(camera.camera!, settings.fov, screenAspect(), clientWorldContents(eye, -1), time);
  /**
   * `CG_Shutdown`, then a fresh cgame's `cg`: what the last match's frames left in the world and on
   * the screen goes, at every map load and as the match goes. A new host's clock starts again,
   * and its entity numbers are handed out anew.
   */
  const clearMatch = () => {
    // Every place, those of the last match's view among them, which goes with its controller.
    localEntities.clear();
    explosions.clear();
    world?.clear();
    gibs?.clear();
    items?.clear();
    players?.clear();
    bodies?.clear();
    trails?.clear();
    floats?.update([]);
    hitBoxes?.update([]);
    sound?.clear();
    hud?.clear();
    icons?.update(null, 0);
    viewmodel?.clear();
    if (viewmodel) viewmodel.visible = false;
    scoreboardScreen.update(null);
    Object.assign(scoreboardState, createScoreboardState());
    notify.clear();
    hyperspace.show(null);
  };
  /** A frame of the match, while one runs. */
  const playFrame = (controller: PlayerController, dt: number): void => {
    const takingOff = settings.flyCamera && !flying;
    flying = settings.flyCamera;
    if (takingOff) flyer.start({ origin: controller.viewOrigin, angles: controller.viewAngles });
    if (flying && !menu.isOpen) {
      // The keys and the mouse are the camera's, and the player takes none of them.
      flyer.fly(input.keyMove(), input.takeMouse(), settings, dt);
      input.takeCommands();
    }
    // `UI_SetActiveMenu`: the menu, or the fly camera out, sets `cl_paused`, which holds the
    // client's clock and its server's frame while the game is still drawn, as Q3's does.
    // Its sound plays on, as Q3's mixer does.
    config.cvars.set('cl_paused', menu.isOpen || flying ? '1' : '0');
    controller.update(dt);
    if (flying) placeCamera(flyer.view());
    warpEye(drawnView(controller).origin, controller.time);
    // A BSP map's world, drawn from the view the frame is drawn from once the frame's lights are
    // in, its stages on the match's clock. A gamestate this frame read may have begun loading the
    // next map, which frees this one first.
    let shownWorld: BspWorld | null = null;
    if (!loadingMap) {
      // `CG_ShaderStateChanged`: every swap the shader state lists, each time cgame read it.
      const states = controller.takeShaderStates();
      if (map instanceof BspGameMap) {
        for (const state of states) {
          for (const swap of parseShaderState(state)) {
            map.world.remapShader(swap.oldShader, swap.newShader, swap.timeOffset);
          }
        }
        shownWorld = map.world;
      }
    }
    // `cg.hyperspace`: in a teleporter the server has not yet answered, the world is a grey that
    // the gun and the 2D draw over. The fly camera is out of the player's eyes.
    hyperspace.show(controller.hyperspace && !flying ? controller.time : null);
    scene.hyperspace = controller.hyperspace && !flying;
    if (controller.mapRestart) {
      // `CG_MapRestart`: what the last game left in the world goes with it.
      explosions.clear();
      world?.clear();
      gibs?.clear();
      marks.clear();
    }
    const player = controller.player;
    const time = controller.time;
    // `EF_FIRING`: the continuous flash, the barrel, the lightning bolt and the firing loop.
    const firing = (player.eFlags & EF_FIRING) !== 0;
    // `cg.renderingThirdPerson`: the body shows, and the view weapon does not, as with
    // the fly camera out of the eyes.
    const thirdPerson = controller.renderingThirdPerson || flying;
    // `CG_AddViewWeapon`, which leaves before anything else for a spectator and at the
    // intermission (`cg_weapons.c:1364–1370`): there is no gun in a hand that is not playing.
    // Nor in the hand of a side's player flying as a spectator, as Clan Arena's dead do.
    const unarmed =
      player.persistant[PERS.TEAM] === TEAM.SPECTATOR ||
      player.pmType === PM_INTERMISSION ||
      player.pmType === PM_SPECTATOR;
    const origin = controller.sample().origin;
    // Whoever the client is looking out of: itself, until it follows somebody. The body built
    // from the player state is that player's, so it wears their look, sounds like their model
    // and takes their `color1` (`CG_Player`, `cg_players.c:2259–2270`).
    const followed = controller.followed;
    wearWatched();
    // `color1`, read live.
    const color = followed ? followed.color1 : colorFromString(settings.color1);

    // Everyone else, as `CG_Player` draws them: nobody in a slot it does not know.
    const others = controller
      .players()
      .filter(({ state }) => controller.clientInfo(state.clientNum) !== null);

    // This frame's impacts start their explosions, and the frame's lights come from its state,
    // before any model is lit by them. `r_dynamiclight` is read live, as the renderer reads it
    // each scene.
    // How the server's rules have the missiles drawn, as the serverinfo carries them.
    const looks = controller.serverInfo.missiles;
    const missiles = controller.missiles();
    explosions.update(controller.effects, time, looks);
    // The frame's polys begin empty (`R_InitNextFrame`); `cg_marks` and the renderer's
    // `r_marksOnTriangleMeshes` are read live. Each impact leaves its mark as its explosion is made
    // (`CG_MissileHitWall`).
    scenePolys.begin();
    marks.enabled = settings.marks;
    if (map instanceof BspGameMap) {
      map.world.marks.onTriangleMeshes = settings.marksOnTriangleMeshes;
    }
    for (const effect of controller.effects) {
      if (effect.type === 'impact') impactMark(marks, marksMedia, effect, Math.random, time);
    }
    sceneLights.enabled = settings.dynamicLight;
    // The map's light grid, and its scales read live, which light every model in the view.
    sceneLights.grid = map instanceof BspGameMap ? map.world.lightGrid : null;
    sceneLights.ambientScale = settings.ambientScale;
    sceneLights.directedScale = settings.directedScale;
    // A BSP map's models lit as `opengl1` lights them, as its world is drawn; a splat's by the
    // style.
    sceneLights.style = map instanceof BspGameMap ? SCENE_STYLE : undefined;
    // The splat map's view-dependent colour, read live: a larger angle re-renders it less often as
    // the eye moves, the sheen lagging by the threshold.
    app.scene.gsplat.colorUpdateAngle = settings.gsplatColorAngle;

    // The bodies placed before the view weapon, as `CG_AddPacketEntities` runs before
    // `CG_AddViewWeapon`: the hand's frames follow this frame's torso. Each gun's flash is placed
    // with it, for its light; nothing is lit until every light is in.
    const otherPuffs = players?.pose({
      players: others,
      clientInfo: (clientNum) => controller.clientInfo(clientNum),
      time
    }) ?? [];
    const ownPuff = bodies?.pose({
      player,
      origin,
      pain: controller.pain,
      shown: thirdPerson && controller.bodyDrawn,
      respawned: controller.respawned,
      firing,
      lastFireTime: controller.lastFireTime,
      railFireTime: controller.railFireTime,
      time,
      color,
      team: player.persistant[PERS.TEAM]
    }) ?? null;
    // Each body's shadow and wake as `CG_Player` adds them, the player's own first, the world's
    // alone traced; then `CG_AddMarks`. Neither in hyperspace (`cg_view.c:815-818`).
    if (!(controller.hyperspace && !flying)) {
      const shadows = settings.shadows;
      if (controller.bodyDrawn && bodies) {
        const legs = bodies.own.legsYaw;
        const powerups = powerupMask(player.powerups);
        playerShadow(origin, powerups, legs, shadows, worldTrace, marks, marksMedia.shadow, time);
        playerSplash(origin, shadows, clientWorldContents, worldTrace, addPoly, marksMedia.wake);
      }
      for (const { state, origin: at } of others) {
        const rig = players?.body(state.number);
        if (!rig) continue;
        const legs = rig.legsYaw;
        playerShadow(at, state.powerups, legs, shadows, worldTrace, marks, marksMedia.shadow, time);
        playerSplash(at, shadows, clientWorldContents, worldTrace, addPoly, marksMedia.wake);
      }
      marks.addMarks(time);
    }
    if (viewmodel) {
      viewmodel.playerColor = color;
      if (player.weapon !== shownWeapon) {
        shownWeapon = player.weapon as WeaponId;
        // `PM_Weapon` has already run the 200 ms drop by the time `ps.weapon` changes, so
        // the model swaps at the bottom of the arc, out of sight, exactly as Q3's does.
        viewmodel.select(shownWeapon).catch((err: unknown) => {
          console.warn('Viewmodel unavailable for weapon', shownWeapon, err);
        });
      }
      viewmodel.visible = !thirdPerson && !unarmed;
      if (!thirdPerson) {
        viewmodel.pose({
          weapon: player.weapon as WeaponId,
          hand: bodies?.handFrames() ?? IDLE_HAND,
          xyspeed: Math.hypot(player.velocity.x, player.velocity.y),
          bobCycle: player.bobCycle,
          viewAngles: controller.viewAngles,
          landChange: controller.landing.landChange,
          landTime: controller.landing.landTime,
          time,
          lastFireTime: controller.lastFireTime,
          railFireTime: controller.railFireTime,
          firing,
          // The predicted entity's mask, as `CG_AddViewWeapon` reads it (`cg_weapons.c:1436`).
          powerups: powerupMask(player.powerups),
          fov: horizontalFov(settings.fov, screenAspect())
        });
      }
    }

    // The movers as `CG_Mover` places them, for their brush models and their glows.
    const movers = controller.movers();
    gatherLights(sceneLights, {
      own: {
        number: player.clientNum,
        origin,
        powerups: powerupMask(player.powerups),
        flash: bodies?.flashDlight()
      },
      players: others.map(({ state, origin: at }) => ({
        number: state.number,
        origin: at,
        powerups: state.powerups,
        flash: players?.body(state.number)?.flashDlight()
      })),
      // Where each is drawn, as the world effects place it.
      missiles: missiles.map(({ state, origin: at }) => ({
        number: state.number,
        weapon: state.weapon as WeaponId,
        origin: at
      })),
      glows: moverGlows(movers),
      explosions: explosions.live,
      viewWeapon: viewmodel?.flashDlight(),
      time
    });
    splatLights.write(sceneLights.lights);
    // The world seen once the frame's lights are in, as the renderer walks it with them, by the
    // snapshot's areamask whatever the camera, the fly camera's too; then played, as they light
    // its brush models.
    if (shownWorld) {
      drawWorld(shownWorld, drawnView(controller), movers, controller.areamask, sceneLights.lights);
      shownWorld.drawPolys(scenePolys);
      shownWorld.animate(time, sceneLights);
    }
    // Every body, and the view weapon, lit by them.
    players?.draw();
    bodies?.draw();
    viewmodel?.draw();
    // `cg_drawBBox`, read live: each body's hit box, the player's own while it shows.
    hitBoxes?.update(
      settings.drawBBox
        ? playerHitBoxes(
            others,
            (clientNum) => controller.clientInfo(clientNum)?.team ?? TEAM.FREE,
            thirdPerson && controller.bodyDrawn ? { origin, ps: player } : null
          )
        : []
    );

    // `CG_PlayerPowerups` trails a flag behind whoever carries one, the player's own body
    // included — which in first person hangs behind the camera, where they never see it.
    trails?.update(
      flagTrails([
        {
          origin,
          angles: player.viewangles,
          powerups: powerupMask(player.powerups),
          order: predictedEntity(PLAYER_PART.flag)
        },
        ...others.map(({ state, origin: at, angles }) => ({
          origin: at,
          angles,
          powerups: state.powerups,
          order: packetEntity(state.number, PLAYER_PART.flag)
        }))
      ]),
      time,
      camera
    );

    // On the simulation's clock, and reading its live projectile list, so a rocket is drawn
    // where the collision thinks it is rather than where the renderer guessed. Beams start at
    // the flash of the weapon drawn: the view weapon's, or the body's in third person.
    const muzzle = thirdPerson
      ? (bodies?.muzzleOrigin() ?? null)
      : (viewmodel?.muzzleOrigin() ?? null);
    // Each lightning bolt from its own gun's flash: the player's, and each other player's
    // from their body's.
    const bolts: DrawnBolt[] = [];
    const ownBolt = controller.lightningBolt();
    // The player's own from the view weapon, which adds it with the gun, or from their body.
    const ownOrder = thirdPerson
      ? predictedEntity(PLAYER_PART.bolt)
      : viewWeaponEntity(VIEW_WEAPON_PART.bolt);
    if (ownBolt && muzzle) {
      bolts.push({ ...ownBolt, key: player.clientNum, muzzle, order: ownOrder });
    }
    for (const { state, bolt } of others) {
      const flash = bolt && players?.body(state.number)?.muzzleOrigin();
      if (bolt && flash) bolts.push({ ...bolt, key: state.number, muzzle: flash });
    }
    // Each grappling hook from its thrower's gun's flash, in their colour: the player's own
    // from the gun drawn, and each other player's from their body's.
    const hooks: DrawnHook[] = controller.grappleHooks().map((hook) => {
      const { owner, position } = hook;
      const own = owner === player.clientNum;
      const flash = own ? muzzle : (players?.body(owner)?.muzzleOrigin() ?? null);
      // An empty slot's clientinfo is all zeroes, as a rail nobody's is black.
      const color1 = own ? color : (controller.clientInfo(owner)?.color1 ?? [0, 0, 0]);
      return { key: owner, position, start: flash ?? hook.muzzle, color1 };
    });
    items?.update(controller.items(), time, camera, color);
    // The haste puffs the bodies left this frame, drawn with the frame's other effects.
    const puffs: WorldEffect[] = [...otherPuffs, ...(ownPuff ? [ownPuff] : [])].map((origin) => ({
      type: 'hastePuff',
      origin
    }));
    world?.update(
      puffs.length > 0 ? [...controller.effects, ...puffs] : controller.effects,
      missiles,
      time,
      muzzle,
      bolts,
      hooks,
      // `cg.refdef.vieworg`: where the view is, which is what a puff it is inside of is let go
      // for. In first person a jump pad's puff is thrown at the player's own feet.
      controller.viewOrigin,
      explosions.live,
      looks,
      controller.lasers()
    );
    const splats =
      gibs?.update({
        gibOrigins: controller.gibOrigins,
        allPieces: settings.gibs,
        time,
        eye: controller.viewOrigin,
        // `CG_DamageBlendBlob` draws in first person only (`cg_view.c:811–813`).
        blob: thirdPerson ? null : damageBlob(controller.damage, time)
      }) ?? [];
    // `CG_ConfigStringModified`'s sounds, registered before the frame's events play them.
    for (const { index, name } of controller.takeSoundChanges()) {
      sound?.registerGameSound(index, name);
    }
    // `CG_StartMusic`, at a `cs` for `CS_MUSIC` and at a `map_restart`.
    const music = controller.takeMusicStart();
    if (music !== null) sound?.startMusic(music);
    sound?.update({
      effects: controller.effects,
      events: controller.events,
      missiles,
      entities: controller.soundEntities(),
      time,
      weapon: player.weapon as WeaponId,
      firing,
      powerups: player.powerups,
      player: {
        number: player.clientNum,
        origin,
        body: controller.bodyDrawn,
        loopSound: player.loopSound,
        sounds: controller.playerSounds,
        splats
      },
      others: {
        entities: others.map(({ state, origin: where }) => ({
          number: state.number,
          origin: where,
          weapon: state.weapon as WeaponId,
          firing: (state.eFlags & EF_FIRING) !== 0,
          powerups: state.powerups,
          loopSound: state.loopSound
        })),
        sounds: controller.entitySounds,
        voice: (number) => players?.voice(number) ?? null
      },
      view: drawnView(controller),
      hyperspace: controller.hyperspace,
      mapRestart: controller.mapRestart,
      footsteps: settings.footsteps,
      doppler: settings.doppler
    });

    const info = controller.serverInfo;
    // `CG_PlayerSprites` over everyone drawn — over the player's own body only where it is seen,
    // from behind (`RF_THIRD_PERSON`) — and the score plums' digits, `CG_AddScorePlum`'s.
    const viewer = {
      team: player.persistant[PERS.TEAM],
      gametype: info.gametype,
      drawFriend: settings.drawFriend
    };
    const floating: FloatSprite[] = [];
    const overHead = (eFlags: number, clientNum: number, at: Vec3, order: number) => {
      const team = controller.clientInfo(clientNum)?.team ?? TEAM.FREE;
      const shader = playerSprite(eFlags, team, viewer);
      if (shader) floating.push(playerFloatSprite(shader, at, order));
    };
    for (const { state, origin: at } of others) {
      overHead(state.eFlags, state.clientNum, at, packetEntity(state.number, PLAYER_PART.sprite));
    }
    if (thirdPerson && controller.bodyDrawn) {
      overHead(player.eFlags, player.clientNum, origin, predictedEntity(PLAYER_PART.sprite));
    }
    floating.push(...controller.plumSprites(drawnView(controller).origin));
    floats?.update(floating);

    // `CG_Draw2D`, after the 3D view. The speed is the speedometer's readout, its peak and all.
    const { speed, peak } = controller.readout();
    const flags = readFlagStatus(
      controller.game.configstring(CONFIGSTRING.FLAGSTATUS),
      info.gametype
    );
    // `Con_DrawNotify`, the client's own, drawn over cgame's 2D. A menu hides the lines, but not
    // at the intermission.
    const notifyRows = notify.rows(
      performance.now(),
      menu.isOpen && player.pmType !== PM_INTERMISSION
    );
    const frame = hud?.update(
      {
        health: player.stats[STAT.HEALTH],
        armor: player.stats[STAT.ARMOR],
        armorTier: player.stats[STAT.ARMOR_TIER],
        weapon: player.weapon,
        weapons: player.stats[STAT.WEAPONS],
        ammo: player.ammo,
        lowAmmo: info.lowAmmo,
        weaponState: player.weaponstate,
        weaponTime: player.weaponTime,
        weaponSelect: controller.weaponSelect,
        weaponSelectTime: controller.weaponSelectTime,
        damage: controller.damage,
        thirdPerson,
        speed,
        peak,
        time,
        realTime: performance.now(),
        gametype: info.gametype,
        scores1: atoi(controller.game.configstring(CONFIGSTRING.SCORES1)),
        scores2: atoi(controller.game.configstring(CONFIGSTRING.SCORES2)),
        score: player.persistant[PERS.SCORE],
        team: player.persistant[PERS.TEAM],
        // Whose state this is: the followed player's while following, which is what the follow
        // line names.
        clientNum: player.clientNum,
        pmFlags: player.pmFlags,
        pmType: player.pmType,
        fraglimit: info.fraglimit,
        capturelimit: info.capturelimit,
        roundlimit: info.roundlimit,
        redflag: flags.red,
        blueflag: flags.blue,
        warmup: atoi(controller.game.configstring(CONFIGSTRING.WARMUP)),
        clientInfo: (clientNum) => controller.clientInfo(clientNum),
        showScores: scoreboardState.showScores,
        powerups: player.powerups,
        powerupActive: controller.powerupActive,
        powerupTime: controller.powerupTime,
        holdable: player.stats[STAT.HOLDABLE_ITEM],
        pickup: controller.itemPickup,
        pickupTime: controller.itemPickupTime,
        centerPrint: controller.centerPrint,
        rewards: controller.rewards,
        interrupted: controller.connectionInterrupted,
        // `cgs.localServer`: the match is this page's own server's.
        localServer: !controller.game.remote,
        lagometer: controller.lagometer
      },
      notifyRows
    );
    // The announcer's voices: what the snapshots said and its queue let out, and the two the HUD
    // says as it draws — the countdown's second, and a reward as its medals come up.
    for (const cue of controller.voices) sound?.playAnnouncer(cue);
    if (frame?.warmupVoice) sound?.playAnnouncer(frame.warmupVoice);
    if (frame?.reward?.voice) sound?.playAnnouncer(frame.reward.voice);
    // `CG_DrawScoreboard`, the last of `CG_Draw2D` (`cg_draw.c:2615–2619`).
    gameBoard = scoreboardFrame(scoreboardState, {
      time,
      paused: menu.isOpen,
      warmup: atoi(controller.game.configstring(CONFIGSTRING.WARMUP)),
      dead: player.pmType === PM_DEAD,
      intermission: player.pmType === PM_INTERMISSION,
      scoreboardSpectator:
        player.persistant[PERS.TEAM] === TEAM.SPECTATOR &&
        (player.pmFlags & PMF_SCOREBOARD) !== 0,
      gametype: info.gametype,
      clientNum: player.clientNum,
      rank: player.persistant[PERS.RANK],
      score: player.persistant[PERS.SCORE],
      team: player.persistant[PERS.TEAM],
      scores: controller.scores,
      ready: player.stats[STAT.CLIENTS_READY],
      clientInfo: (clientNum) => controller.clientInfo(clientNum),
      killedBy: controller.killedBy
    });
    // The looks put off load under a board that has been up a while (`cg_scoreboard.c:416–419`).
    if (gameBoard?.loadDeferred) controller.loadDeferredPlayers();
    // The 3D icons follow the status bar the 2D half drew.
    icons?.update(frame?.statusBar ?? null, time);
    debugPlayer?.update(time);
  };
  /**
   * One frame of the match: the whole of it, or its network half while its server's map is not
   * in yet. A `Com_Error` in it ends the match.
   */
  const matchFrame = (playing: PlayerController, dt: number) => {
    try {
      if (connectScreen !== null) playing.networkFrame(dt * 1000);
      else playFrame(playing, dt);
    } catch (err) {
      if (err instanceof ServerDisconnect) {
        serverDisconnect(err);
        return;
      }
      console.error(err);
      drop(err);
    }
  };
  /**
   * A BSP map's world drawn from a view: its brush models placed, what the view sees, the curves at
   * the rows it keeps, and the eye's clip planes set from it, the sky from the eye unless
   * `r_fastsky` is on, the fogs from the eye, and the world's entities as `r_drawentities` has it.
   * Its stages are played once the frame's lights are in (`BspWorld.animate`).
   *
   * @param models - The brush models drawn, as `CG_Mover` adds them.
   * @param areamask - The areas closed to the view, as `cg.refdef.areamask` has them.
   * @param lights - The frame's dynamic lights, every one cgame added, which the walk takes.
   */
  const drawWorld = (
    world: BspWorld,
    view: FirstPersonView,
    models: readonly BrushModelPose[],
    areamask: Uint8Array,
    lights: readonly DynamicLight[]
  ): void => {
    world.placeModels(models);
    world.see(view, settings, areamask, lights);
    world.drawSky(view, settings.fastSky);
    world.drawFog(view);
    world.showEntities(settings.drawEntities);
    worldOffset.factor = settings.offsetFactor;
    worldOffset.units = settings.offsetUnits;
    world.offset(worldOffset);
  };
  /**
   * A frame of a map's preview: the free camera flown through the binds while the menu is down,
   * and the world drawn from its view on the preview's clock. No game runs to take the weapon
   * commands, so they are let go of. A shader opengl1 drops the map for, drawn, drops the preview
   * as a `Com_Error` does a match.
   */
  const previewFrame = (preview: BspWorld, dt: number): void => {
    if (!menu.isOpen) flyer.fly(input.keyMove(), input.takeMouse(), settings, dt);
    input.takeCommands();
    const view = flyer.view();
    placeCamera(view);
    try {
      const time = previewClock.frame(dt * 1000, settings.previewTime);
      // No light but the grid's.
      sceneLights.clear();
      // No server, so no area is closed.
      drawWorld(preview, view, previewModels, OPEN_AREAS, sceneLights.lights);
      sceneLights.grid = preview.lightGrid;
      sceneLights.style = SCENE_STYLE;
      sceneLights.ambientScale = settings.ambientScale;
      sceneLights.directedScale = settings.directedScale;
      preview.animate(time, sceneLights);
    } catch (err) {
      console.error(err);
      drop(err);
    }
  };
  // When the page last ran a frame of its own, which the hidden page's timer counts from.
  let lastFrame = performance.now();
  app.on('update', (dt: number) => {
    lastFrame = performance.now();
    // `Com_Frame`'s `Cbuf_Execute`: a `wait` counts this frame.
    commands.frame();
    gameBoard = null;
    cls.frame();
    // A map the program failed to read or to spawn, or a server frame that threw, drops the match.
    const failure = controller?.game.failure;
    if (failure) drop(failure);
    // A client that has left its server, with none in this page, is at the main menu with no word
    // why: its connection timed out (`CL_CheckTimeout`).
    if (controller?.game.remote && controller.game.connection.state === CA.DISCONNECTED) leave();
    if (keys) keys.playing = controller !== null || mapPreview !== null;
    if (hud) hud.shown = controller !== null && connectScreen === null;
    // Under a load screen no cgame runs, and the match waits.
    if (controller && began && !loadingMap) matchFrame(controller, dt);
    if (mapPreview && began && !loadingMap) previewFrame(mapPreview, dt);
    // The frame that put the player in the world is the first drawn.
    if (entering !== null && (controller === null || controller.inWorld)) closeEntering();
    // `SCR_DrawScreenField`'s connect screen, from the connection as this frame left it.
    connectScreen?.show(controller?.game.connection ?? null);
    // `CL_Frame`'s: disconnected, with nothing holding the keys, the main menu comes up
    // (`cl_main.c:3005–3009`).
    const idle = !controller && !mapPreview;
    if (began && idle && !loadingMap && connectScreen === null && !menu.isOpen) openMain();
    menuScreen.opaque = idle;
    // The page's own work before it draws, as the server browser's refresh runs from its draw.
    menu.frame();
    menuScreen.update();
    // A levelshot no page drew this frame is given back.
    levelshots?.sweep();
    // `S_Update`, with `s_volume` and `s_musicvolume` read live, whether a match runs or not.
    if (sound) {
      sound.volume = settings.volume;
      sound.musicVolume = settings.musicVolume;
      sound.mix();
    }
    // Over the page, on q3_ui's clock, which runs on real time while the game waits.
    preview?.update(menuScreen.previewView, performance.now());
    // The server browser's board of the highlighted server, where its page has settled, or else
    // the match's.
    const panelBoard = menuScreen.boardView;
    scoreboardScreen.update(panelBoard?.board ?? gameBoard, panelBoard?.box);
  });
  // A hidden page runs no frames, but its client still reaches its server, as a minimised Q3 runs
  // on: the network half of a frame from a timer, once a second, as often as a browser runs one on
  // a hidden page and well inside a server's timeout. The worker's server would drop its own
  // player too. A server that has stopped on an error ends the match here as a frame would, and
  // its masters hear of it then.
  const hiddenFrames = setInterval(() => {
    if (!document.hidden) return;
    const now = performance.now();
    const msec = now - lastFrame;
    lastFrame = now;
    cls.frame();
    // Under a load screen no cgame runs, as in the page's own frames.
    if (!controller || !began || loadingMap) return;
    const failure = controller.game.failure;
    if (failure) {
      drop(failure);
      return;
    }
    try {
      controller.networkFrame(msec);
    } catch (err) {
      console.error(err);
      drop(err);
    }
  }, 1000);
  app.on('destroy', () => clearInterval(hiddenFrames));
  destroyDriver = () => {
    keys?.destroy();
    scoreboardScreen.destroy();
    menuScreen.destroy();
    preview?.destroy();
    menuIcons?.destroy();
    levelshots?.destroy();
    viewmodel?.destroy();
    world?.destroy();
    void items?.destroy();
    trails?.destroy();
    floats?.destroy();
    hitBoxes?.destroy();
    sound?.destroy();
    gibs?.destroy();
    hud?.destroy();
    icons?.destroy();
    void bodies?.destroy();
    void players?.destroy();
    void debugPlayer?.hide();
    void mapPreview?.destroy();
    cls.close();
  };

  // Everything drawn and played from the paks, in `CG_Init`'s order: the sounds, then the
  // graphics, which are the effects, the gibs, the HUD and every weapon, then the player
  // (`cg_main.c:1908–1918`). The game begins once it is all in, or has failed.
  const presented = assets
    ?.then(async ({ library, gameData: found }) => {
      gameData = found;
      for (const warning of library.shaderWarnings) print(warning);
      const bus = await steps.sounds.track(
        SoundBus.create(
          library,
          (done, total, path) => steps.sounds.advance(done / total, `${path} (${done}/${total})`),
          { read: (path) => fs.read(path), print }
        )
      );
      bus.volume = settings.volume;
      bus.musicVolume = settings.musicVolume;
      sound = bus;
      if (import.meta.env.DEV) {
        // Dev-only, like `pcqPlayer` below: the sound bus, so a check can read its mixer.
        (window as unknown as { pcqSound: unknown }).pcqSound = bus;
      }
      // No initial `select` — the update loop drives it from `ps.weapon`, so the rig always
      // shows what the simulation says is in hand rather than a second opinion.
      const rig = new ViewmodelRig(app, library, camera, sceneLights, scene);
      viewmodel = rig;
      // The game media's parts, each named under the load screen's line as it starts.
      const parts = ['effects', 'gibs', 'HUD', '3D icons'];
      const building = (part: string) => {
        const at = parts.indexOf(part);
        steps.media.advance(at / parts.length, `${part} (${at + 1}/${parts.length})`);
      };
      building('effects');
      const effects = await WorldEffects.create(
        app,
        library,
        camera,
        sceneLights,
        localEntities,
        clientWorldContents,
        scene
      );
      world = effects;
      items = ItemEntities.create(app, library, textures, {
        blendedLayers: effects.blendedLayers,
        lights: sceneLights,
        scene
      });
      floats = await FloatSprites.create(app, library, camera, effects.blendedLayers, scene);
      hitBoxes = HitBoxes.create(app, effects.blendedLayers, scene);
      trails = FlagTrails.create(app, library, textures, {
        blendedLayers: effects.blendedLayers,
        lights: sceneLights,
        scene
      });
      const rigOptions = {
        blendedLayers: effects.blendedLayers,
        camera,
        lights: sceneLights,
        scene
      };
      menuModels = library.playerModels;
      const entities = new PlayerEntities(app, library, textures, rigOptions);
      players = entities;
      if (import.meta.env.DEV) {
        // Dev-only, like `pcqSound` above: everyone else's bodies, so a smoke check can see who is
        // drawn, in what look and where.
        (window as unknown as { pcqPlayers: unknown }).pcqPlayers = players;
      }
      // Every skin read now, behind the menu, so that the first map's warm-up need not wait for it.
      void skinShaders();
      preview = new PlayerPreview(app, library, textures, camera);
      menuIcons = new MenuIcons(library, textures);
      // `deferShader`, which cgame registers with its media (`cg_main.c:844`): the scoreboard's
      // cross over a portrait, ready for the board's first frames.
      void menuIcons.prepare(DEFER_SHADER);
      // Read from the whole search path, the port's own maps' with the player's paks'.
      levelshots = new Levelshots(fs, textures);
      // The board's portraits are the Model page's own icons.
      scoreboardScreen.images = (name) => menuIcons?.get(name) ?? null;
      building('gibs');
      gibs = await GibEffects.create(
        app,
        library,
        camera,
        clientWorldTrace,
        effects.blendedLayers,
        Math.random,
        sceneLights,
        localEntities,
        clientWorldContents,
        scene,
        (markType, at, normal, random, time) =>
          fragmentBounceMark(marks, marksMedia, markType, at, normal, random, time)
      );
      building('HUD');
      try {
        // The live settings, so the HUD's cvars take effect as they change.
        hud = await HudScreen.create(app, library, camera, textures, settings);
      } catch (err) {
        console.warn('HUD unavailable:', err);
      }
      building('3D icons');
      try {
        icons = await HudIcons.create(app, library, camera, textures);
      } catch (err) {
        console.warn('HUD 3D icons unavailable:', err);
      }
      steps.media.finish();
      // Every weapon, built before it is first chosen, as `CG_RegisterItemVisuals` registers each
      // one the level holds (`cg_main.c:1017–1022`).
      await Promise.all(
        WEAPON_ASSETS.map((asset) =>
          steps.weapons
            .get(asset.id)!
            .track(rig.load(asset.id))
            .catch((err: unknown) => console.warn('Viewmodel unavailable for weapon', asset.id, err))
        )
      );
      // The player's own body: drawn in third person, and always playing, so the view
      // weapon follows its torso. It wears `model` and `headmodel` — or, while the client
      // follows somebody, what they wear, since the body drawn from the player state is theirs.
      // A change to either dresses it again behind the pause, and the last body is given back
      // once the new one is on.
      const wear = (look: PlayerLook): Promise<PlayerBodies> =>
        PlayerBodies.create(app, library, textures, look, rigOptions);
      let dressings = 0;
      const dress = async (look: PlayerLook): Promise<void> => {
        const dressing = ++dressings;
        // A look already worn, as "sarge/default" is "sarge"'s, needs no dressing; counting this one
        // has let any dressing in flight go.
        if (bodies && sameLook(bodies.look, look)) return;
        let built: PlayerBodies;
        let sounds: string;
        try {
          built = await wear(look);
          sounds = look.body.model;
        } catch (err) {
          // `CG_LoadClientInfo`: a look that fails is sarge's, sounds and all (`cg_players.c:672–694`).
          console.warn(`Player model unavailable; wearing ${DEFAULT_MODEL}:`, err);
          built = await wear(DEFAULT_LOOK);
          sounds = DEFAULT_MODEL;
        }
        if (dressing !== dressings) {
          await built.destroy();
          return;
        }
        const worn = bodies;
        bodies = built;
        void worn?.destroy();
        // The HUD's head and its icon are the head's (`cg_players.c:602–607`); the sounds and the
        // footsteps are the body's.
        const { head } = built.look;
        await Promise.all([
          bus.setPlayerModel(sounds, built.config.footsteps),
          hud?.setPlayerIcon(head.model, head.skin),
          icons
            ?.setPlayerModel(head.model, head.skin, built.config.headOffset)
            .catch((err: unknown) => console.warn('HUD head unavailable:', err))
        ]);
      };
      /**
       * What the client is looking out of wears: the followed player's look, or its own.
       *
       * Its own comes from its `CS_PLAYERS` string and not from the cvars, because that is where
       * the match has had its say — the server picks `team_model` over `model` above `GT_TEAM`
       * (`g_client.c:775–782`) and the client wears it in its side's colours, and Quake 3
       * reads the player's own body out of `cgs.clientinfo` like everyone else's. The cvars serve
       * only until that string is in.
       */
      const wornLook = (): PlayerLook =>
        controller?.followed?.look ??
        controller?.clientInfo(controller.game.clientNum)?.look ??
        playerLook(settings.model, settings.headModel);
      /** The look last asked for, so that one already on its way is not asked for again. */
      let asked: PlayerLook | null = null;
      const redress = (look: PlayerLook) => {
        asked = look;
        return dress(look).catch((err: unknown) => console.warn('Player model unavailable:', err));
      };
      // One look is asked for at a time, whatever changed it: the client's own string, which the
      // Model page's cvars reach through the server's `ClientUserinfoChanged`, or who is being
      // followed.
      wearWatched = () => {
        const look = wornLook();
        if (asked && sameLook(asked, look)) return;
        void redress(look);
      };
      await steps.client.track(redress(wornLook()));
      if (import.meta.env.DEV) {
        debugPlayer = new DebugPlayer(app, library, textures, rigOptions);
        exposeDebugPlayer(debugPlayer, textures, playerPlace);
      }
    })
    .catch((err: unknown) => {
      console.warn('Weapon assets unavailable:', err);
    });
  // Q3's `+map`, run as the console runs it once the program is up (`Com_AddStartupCommands`): its
  // map loads alongside the media, under the boot's one screen.
  if (setup.map) commands.execute(['map', setup.map]);
  await Promise.all([presented, commands.settled()]);
  begin();
  // The boot's screen stays over the match its `+map` started, which loads its first gamestate
  // under it, until the player is in the world, as any map's does. With none, the game has begun.
  if (bootMatch !== null && bootMatch.playing === controller) {
    entering = loading;
    enteringGamestate = bootMatch.gamestate;
  } else {
    loading.close();
  }
  bootMatch = null;

  const handle: AppHandle = {
    app,
    deviceType: device.deviceType,
    get splatCount() {
      return map instanceof GameMap ? map.splatCount : 0;
    },
    get collision() {
      return map instanceof GameMap ? map.collision : null;
    },
    viewpos: () =>
      controller
        ? viewpos(drawnView(controller))
        : mapPreview
          ? viewpos(flyer.view())
          : null,
    quit,
    arenas,
    madeSinceWarmUp: () =>
      made && madeAtWarmUp
        ? {
            shaders: made.shaders - madeAtWarmUp.shaders,
            pipelines: made.pipelines - madeAtWarmUp.pipelines
          }
        : null
  };

  if (import.meta.env.DEV) {
    // Dev-only handles for console poking / automated smoke checks. `pcEngine` has to be
    // the app's own module instance: vite pre-bundles playcanvas, so a separate dynamic
    // import from the console yields different classes whose entities have no app.
    (window as unknown as { pcq: AppHandle }).pcq = handle;
    (window as unknown as { pcEngine: unknown }).pcEngine = pc;
  }

  return handle;
}

/** A map's own steps of a load screen: its file, then its collision map. */
interface MapSteps {
  map: LoadStep;
  collision: LoadStep;
}

/**
 * Add a map's steps to a load screen, named as cgame names them while it loads.
 *
 * @param file - The file the map loads from.
 */
function mapSteps(screen: Pick<LoadScreen, 'step'>, file: string): MapSteps {
  return {
    map: screen.step(file, MAP_WEIGHT),
    collision: screen.step('collision map', COLLISION_WEIGHT)
  };
}

/**
 * A gamestate's own steps of a load screen, after its map's: the sounds it names, the items it
 * lists, and everyone.
 */
interface GamestateSteps {
  sounds: LoadStep;
  items: LoadStep;
  clients: LoadStep;
}

/**
 * Add a gamestate's steps to a load screen, named as `CG_Init` names them
 * (`cg_main.c:1908-1916`).
 */
function gamestateSteps(screen: Pick<LoadScreen, 'step'>): GamestateSteps {
  return {
    sounds: screen.step('sounds', GAME_SOUNDS_WEIGHT),
    items: screen.step('items', ITEMS_WEIGHT),
    clients: screen.step('clients', CLIENT_WEIGHT)
  };
}

/** A new match's steps of a load screen: its map's, then its first gamestate's. */
interface MatchSteps {
  map: MapSteps;
  gamestate: GamestateSteps;
}

/**
 * Add a new match's steps to a load screen of its own.
 *
 * @param file - The file its map loads from.
 */
function matchSteps(screen: Pick<LoadScreen, 'step'>, file: string): MatchSteps {
  return { map: mapSteps(screen, file), gamestate: gamestateSteps(screen) };
}

/**
 * The debug view, dev only: `pcqPlayer.show('xaero', 'blue')` stands a
 * model in front of the player, facing them, and `pcqPlayer.hide()` takes it away, freeing what
 * it held. `pcqPlayer.textures()` counts the textures the bodies hold.
 *
 * @param place - Where the player stands and which way they face.
 */
function exposeDebugPlayer(
  debug: DebugPlayer,
  textures: TextureCache,
  place: () => { origin: Vec3; yaw: number }
): void {
  (window as unknown as { pcqPlayer: unknown }).pcqPlayer = {
    show: (model?: string, skin?: string) => {
      const at = place();
      const radians = (at.yaw * Math.PI) / 180;
      const origin = {
        x: at.origin.x + DEBUG_PLAYER_DISTANCE * Math.cos(radians),
        y: at.origin.y + DEBUG_PLAYER_DISTANCE * Math.sin(radians),
        z: at.origin.z
      };
      return debug.show(origin, at.yaw + 180, model, skin);
    },
    hide: () => debug.hide(),
    textures: () => textures.size,
    get current() {
      return debug.current;
    }
  };
}
