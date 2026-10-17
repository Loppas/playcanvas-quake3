/**
 * The desktop shell: the web build in a window of its own, reading the Quake 3 install where it
 * sits and keeping `q3config.cfg` and `favorites.txt` in `fs_homepath`.
 *
 * The page is served on the `app:` scheme (`app-protocol.mjs`), registered standard and secure so
 * `fetch`, OPFS and pointer lock behave as on a web origin. There is no application menu, so no
 * accelerator takes a key from the game, Ctrl+W among them.
 */

import nodePath from 'node:path';
import { BrowserWindow, Menu, app, dialog, net, protocol } from 'electron';

import { BASEGAME } from '../scripts/baseq3-route.mjs';
import { defaultHomepath } from '../scripts/default-homepath.mjs';
import { handleAppRequest, proxyPage, servePage } from './app-protocol.mjs';
import { installOf, keepInstall, keptInstall } from './basepath.mjs';
import { launchSwitches, launchVsync } from './launch-switches.mjs';

/** The scheme, and the page's origin on it. */
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://game`;

/** The Vite dev server to take the page from, under `npm run shell` (`scripts/shell-dev.mjs`). */
const DEV_SERVER = process.env.PCQ_SHELL_DEV_SERVER;

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
  }
]);
Menu.setApplicationMenu(null);

/** `fs_homepath`, where the game keeps `q3config.cfg` and the shell its pick of install. */
const homepath = defaultHomepath();
/** Vertical sync as this launch takes it up: Chromium reads its switches only as it starts. */
const vsync = launchVsync(homepath);
for (const name of launchSwitches(vsync)) app.commandLine.appendSwitch(name);

/** @type {BrowserWindow | undefined} The game's window, once it is open. */
let gameWindow;

/**
 * The native folder dialog, asking for the install: over the game's window where it is open.
 *
 * @param {BrowserWindow} [parent]
 * @returns {Promise<string | undefined>} the folder picked, or `undefined` for none.
 */
async function pickFolder(parent) {
  /** @type {Electron.OpenDialogOptions} */
  const options = {
    title: 'Where is Quake 3 installed?',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory']
  };
  const pick = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return pick.canceled ? undefined : pick.filePaths[0];
}

/**
 * The install to read: the one kept, else one the player picks, kept for the next start.
 *
 * @param {string} homepath - `fs_homepath`.
 * @returns {Promise<string | undefined>} `fs_basepath`, or `undefined` if the player gives up.
 */
async function findInstall(homepath) {
  const kept = await keptInstall(homepath);
  if (kept) return kept;
  for (;;) {
    const folder = await pickFolder();
    if (folder === undefined) return undefined;
    const install = await installOf(folder);
    if (install) {
      await keepInstall(homepath, install);
      return install;
    }
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: 'There are no Quake 3 paks in that folder.',
      detail: `Pick the folder that holds baseq3, with pak0.pk3 in it.\n\n${folder}`,
      buttons: ['Pick again', 'Quit'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 1) return undefined;
  }
}

/**
 * Open the game's window on the page.
 *
 * @returns {Promise<void>}
 */
function openWindow() {
  const win = new BrowserWindow({ width: 1280, height: 800, backgroundColor: '#000000' });
  gameWindow = win;
  // The window holds the game alone: it opens no other, and goes nowhere else.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) event.preventDefault();
  });
  if (DEV_SERVER) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F12') return;
      win.webContents.toggleDevTools();
      event.preventDefault();
    });
  }
  return win.loadURL(`${ORIGIN}/`);
}

app
  .whenReady()
  .then(async () => {
    const install = await findInstall(homepath);
    if (!install) {
      app.quit();
      return;
    }
    /** @type {import('./app-protocol.mjs').AppRoutes} */
    const routes = {
      baseq3: nodePath.join(install, BASEGAME),
      homepath,
      install: { running: install, pick: () => pickFolder(gameWindow) },
      launch: { vsync },
      page: DEV_SERVER
        ? proxyPage(DEV_SERVER, (url, init) => net.fetch(url, init))
        : servePage(nodePath.join(import.meta.dirname, '..', 'dist'))
    };
    protocol.handle(SCHEME, (request) => handleAppRequest(request, routes));
    await openWindow();
  })
  .catch((/** @type {unknown} */ error) => {
    dialog.showErrorBox(app.name, error instanceof Error ? error.message : String(error));
    app.quit();
  });

app.on('window-all-closed', () => app.quit());
