/**
 * The desktop shell's Windows build (`npm run shell:build`): an unpacked, unsigned folder,
 * `release/win-unpacked`, holding the main process, the route code it shares with the dev server,
 * and the web build. No Quake 3 data goes in; the shell reads the player's install.
 *
 * Vite copies all of `public/maps/` into `dist/`, other captures included. Every map pk3 goes in,
 * with the listing the build wrote for them, since the game mounts them all and reads each map
 * whole from them. No loose file goes in: the game reads none.
 *
 * The licence and the notices go beside the exe, where `app.asar` would hide them.
 */

import { existsSync, readdirSync } from 'node:fs';

import { NOTICE_FILES, THIRD_PARTY_NOTICES } from './scripts/notices.mjs';

/**
 * Whether the game mounts a file: the map pk3s do, and their listing is how (`vite.config.ts`).
 *
 * @param {string} name
 */
const mounted = (name) => /\.pk3$/i.test(name) || name === 'paks.json';
// The build writes `dist` first; a test imports this config without one.
const unused = existsSync('dist/maps')
  ? readdirSync('dist/maps').filter((name) => !mounted(name))
  : [];

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'io.github.loppas.playcanvas-quake3',
  productName: 'playcanvas-quake3',
  directories: { output: 'release' },
  // Electron as `install-electron` unpacks it, copied in: `npm install` doesn't fetch it, so
  // `shell:build` runs that first. Unpacking the zip again ends in a folder rename that Windows can
  // refuse (EPERM) while a virus scan holds the new `electron.exe`.
  electronDist: 'node_modules/electron/dist',
  // The main process has no native modules to rebuild.
  npmRebuild: false,
  files: [
    'package.json',
    'electron/*.mjs',
    '!electron/*.test.mjs',
    'scripts/baseq3-route.mjs',
    'scripts/default-homepath.mjs',
    'scripts/home-cfg-route.mjs',
    'scripts/q3-commands.mjs',
    'scripts/q3config-route.mjs',
    'dist/**',
    ...unused.map((name) => `!dist/maps/${name}`),
    '!node_modules/**'
  ],
  extraFiles: [...NOTICE_FILES, { from: `dist/${THIRD_PARTY_NOTICES}`, to: THIRD_PARTY_NOTICES }],
  electronLanguages: ['en-US'],
  win: { target: 'dir' }
};
