import './style.css';
import { setupApp, type MenuHost } from './App';
import { assetActivity, assetProgress, bootAssets, describeAssetStatus } from './asset-boot';
import { GAME_NAME } from './config';
import { exitGame } from './exit-game';
import { Decoder } from './formats/decoder';
import { ConnectScreen, LoadScreen } from './load-screen';
import type { PakFileSystem } from './pak/vfs';
import { inflateWith } from './pak/zip';
import { decodeTgasWith } from './render/md3-mesh';
import {
  exportConfigFile,
  FAVORITES_TXT,
  homeStores,
  keepFile,
  pickConfigFile,
  Q3CONFIG_CFG,
  readKeptFile
} from './settings/config-file';
import { GameConfig } from './settings/game-config';
import { homeFolders, searchFolders } from './settings/home-folder';
import { vidRestart } from './settings/vid-restart';
import { inShell, shellLaunch } from './shell';
import { setRendererStyle } from './view/overbright';
import { readModel } from './view/player-model';

const shell = inShell();

// The paks' entries are inflated, and their TGAs decoded, in a worker of their own, so a look
// read in play costs the thread that draws nothing for either.
const decoder = new Decoder();
inflateWith(decoder.inflate);
decodeTgasWith(decoder.decodeTga);

/** The game data's share of the load screen's bar, against a weapon's 1, as `App.ts` weighs its steps. */
const GAME_DATA_WEIGHT = 70;

// The settings and the binds: the defaults, then the saved `q3config.cfg`, then the query
// string's. The file is read where `homeStores` keeps it, and every change is written back. The
// favourite servers' file beside it is read with it, for the client to take up once it is built.
const stores = homeStores(Q3CONFIG_CFG, import.meta.env.DEV, shell);
const favoriteStores = homeStores(FAVORITES_TXT, import.meta.env.DEV, shell);
// The shell's launch, read with them: the vertical sync Chromium was started with holds until the
// next. A shell that can't say is taken as paced, as a browser is.
const [saved, savedFavorites, launch] = await Promise.all([
  readKeptFile(stores),
  readKeptFile(favoriteStores),
  shell
    ? shellLaunch().catch((err: unknown) => {
        console.warn('The shell did not say how it was launched:', err);
        return undefined;
      })
    : undefined
]);
const config = new GameConfig({ config: saved, search: window.location.search, shell });
const keeper = keepFile(config, stores, saved);
// The home folder the other cfgs are read from, kept where the config is.
const home = searchFolders(homeFolders(import.meta.env.DEV, shell));
const settings = config.cvars.settings;
if (import.meta.env.DEV) {
  // Dev-only, like `pcqAssets`: `pcqConfig.command(['cg_fov', '100'])` runs a console command.
  (window as unknown as { pcqConfig: unknown }).pcqConfig = config;
}
/** Quits the game, once there is one: EXIT GAME's, before the window closes. */
let quitGame = () => {};
/** Stops the game, once there is one: EXIT GAME's, where a browser keeps the tab open. */
let stopGame = () => {};
/** What the menu does beyond the game: `vid_restart`, export and import, and EXIT GAME. */
const host: MenuHost = {
  vidRestart: () => void vidRestart(config, keeper),
  exportConfig: () => exportConfigFile(config.text()),
  importConfig: () => {
    void pickConfigFile().then((text) => {
      if (text !== undefined) config.exec(text);
    });
  },
  exit: () => exitGame(root, () => quitGame(), () => stopGame())
};
setRendererStyle({
  renderer: settings.renderer,
  overBrightBits: settings.overBrightBits,
  normalMapping: settings.normalMapping,
  specularMapping: settings.specularMapping
});
// The renderer's settings are latched, so the ones the page started with are the ones in force.
// The mapping pair is named only where one is off.
const renderer = [
  `${settings.renderer}, r_overBrightBits ${settings.overBrightBits}`,
  ...(settings.normalMapping ? [] : ['r_normalMapping 0']),
  ...(settings.specularMapping ? [] : ['r_specularMapping 0'])
].join(', ');

const root = document.querySelector<HTMLDivElement>('#root')!;
root.innerHTML = `
  <canvas id="application-canvas"></canvas>
  <div id="hud" class="hud"></div>
`;

const hud = document.getElementById('hud')!;
const canvas = document.getElementById('application-canvas') as HTMLCanvasElement;

/**
 * The map the game starts: the address's `?map=`, as Q3's command line takes `+map`. With
 * none, the game starts on the main menu.
 */
const firstMap = new URLSearchParams(window.location.search).get('map') || undefined;

// Nothing plays until everything is in: the map's name, or the game's, over a bar, which a drop
// screen covers while it asks for the game data. The app takes it away once its game has started,
// and a boot that fails takes it away here.
const loading = new LoadScreen(root, firstMap ?? GAME_NAME);
const gameData = loading.step('game data', GAME_DATA_WEIGHT);
if (import.meta.env.DEV) {
  // Dev-only, like `pcqConfig`: the load screen, so a smoke check can time its steps.
  (window as unknown as { pcqLoading: unknown }).pcqLoading = loading;
}

// Quake assets: the install read in place, else what the browser kept, else the drop screen.
// They load alongside the map, and the game waits for both. The map is read through the player's
// paks, so it waits for them to be mounted, but not for the assets read out of them.
let assetStatus = 'assets: starting';
let mounted: (paks: PakFileSystem | undefined) => void = () => {};
const playerPaks = new Promise<PakFileSystem | undefined>((resolve) => (mounted = resolve));
const assets = bootAssets(
  root,
  (status) => {
    assetStatus = describeAssetStatus(status);
    gameData.advance(assetProgress(status), assetActivity(status));
  },
  // The model `model` wears, which the boot reads along with sarge.
  { model: readModel(settings.model).model, shell, onMounted: mounted }
);
assets
  .then(({ library }) => {
    if (import.meta.env.DEV) {
      // Dev-only handle for console poking / automated smoke checks, like `window.pcq`.
      (window as unknown as { pcqAssets: unknown }).pcqAssets = library;
    }
  })
  // One handled chain, not two: a second bare `.then` would leave a failed boot as an
  // unhandled rejection. The failure is already surfaced through assetStatus, and the map
  // and movement still run without weapons, read from the port's own map pk3s alone.
  .catch(() => mounted(undefined));

/** The message that stopped the game, which holds the status line, or null while it runs. */
let failure: string | null = null;

/** Stop the game with a message: a boot's that failed before there was a menu to show it on. */
function fail(err: unknown): void {
  failure = err instanceof Error ? err.message : String(err);
  hud.hidden = false;
  hud.textContent = failure;
  hud.classList.add('error');
}

try {
  const handle = await setupApp({
    canvas,
    assets,
    paks: playerPaks,
    config,
    home,
    favorites: { saved: savedFavorites, stores: favoriteStores },
    host,
    launchVsync: launch?.vsync,
    loading,
    map: firstMap,
    loadScreen: (title) => new LoadScreen(root, title),
    connectScreen: (server) => new ConnectScreen(root, server)
  });
  const { app, deviceType, viewpos } = handle;
  quitGame = () => handle.quit();
  stopGame = () => app.destroy();

  // Simple fps readout.
  let frames = 0;
  let elapsed = 0;
  let fps = 0;
  app.on('update', (dt: number) => {
    frames++;
    elapsed += dt;
    if (elapsed >= 0.5) {
      fps = Math.round(frames / elapsed);
      frames = 0;
      elapsed = 0;
    }
    // `pcq_drawStatusLine`, live. A failure's message is not the status line, and shows
    // whatever it says.
    if (failure !== null) return;
    hud.hidden = !settings.drawStatusLine;
    if (hud.hidden) return;
    // Where the view is, as `viewpos` would print it, for placing a map's entities, and what
    // the map draws; neither while no match runs. It reads out the game alone; the keys are the
    // Controls page's to show.
    const view = viewpos();
    hud.textContent = [
      `${fps} fps`,
      ...(view === null ? [] : [`viewpos ${view}`]),
      deviceType,
      renderer,
      ...(view === null ? [] : [`${(handle.splatCount / 1e6).toFixed(2)}M splats`]),
      assetStatus
    ].join(' | ');
  });
} catch (err) {
  loading.close();
  fail(err);
  throw err;
}
