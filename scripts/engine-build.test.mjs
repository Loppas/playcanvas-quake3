import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';

import { engineBuild } from './engine-build.mjs';

/** A JSON file, relative to the repo root. */
function readJson(path) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}

/**
 * The file PlayCanvas's package exports for these conditions, as Node and Vite pick one: the first
 * key of the `.` entry, in its own order, that is an active condition, then its `import`.
 */
function engineFile(conditions) {
  const pkg = readJson('node_modules/playcanvas/package.json');
  const active = new Set([...conditions, 'import', 'default']);
  const key = Object.keys(pkg.exports['.']).find((name) => active.has(name));
  const entry = pkg.exports['.'][key];
  return typeof entry === 'string' ? entry : entry.import;
}

describe('engineBuild', () => {
  it('serves the release build under the release mode', () => {
    const { resolve } = engineBuild('release');
    expect(engineFile(resolve.conditions)).toBe('./build/playcanvas/src/index.js');
  });

  it('serves the profiler build under the profiler mode', () => {
    const { resolve } = engineBuild('profiler');
    expect(engineFile(resolve.conditions)).toBe('./build/playcanvas.prf/src/index.js');
  });

  it("leaves the dev server's own conditions, and so the debug build, to every other mode", () => {
    expect(engineBuild('development')).toEqual({});
    expect(engineBuild('test')).toEqual({});
    // Vite's own client conditions in development, which pick the debug build.
    expect(engineFile(['module', 'browser', 'development'])).toBe('./build/playcanvas.dbg/src/index.js');
  });

  it("keeps each build's dependency bundle in a folder of its own", () => {
    expect(engineBuild('release').cacheDir).toBe('node_modules/.vite-release');
    expect(engineBuild('profiler').cacheDir).toBe('node_modules/.vite-profiler');
  });
});

/** The engine file `vite.config.ts` serves to an npm script, by the mode the script passes. */
async function servedEngine(script) {
  const mode = /--mode (\S+)/.exec(readJson('package.json').scripts[script])?.[1];
  const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
  const config = await resolveConfig({ configFile, mode, logLevel: 'silent' }, 'serve');
  // Vite's default conditions name the build by NODE_ENV, in a placeholder of its own.
  const conditions = config.environments.client.resolve.conditions.map((name) =>
    name === 'development|production' ? (config.isProduction ? 'production' : 'development') : name
  );
  return engineFile(conditions);
}

describe("the dev server's config", () => {
  it('serves the debug build to `npm run dev`', async () => {
    expect(await servedEngine('dev')).toBe('./build/playcanvas.dbg/src/index.js');
  });

  it('serves the release build to `npm run play`', async () => {
    expect(await servedEngine('play')).toBe('./build/playcanvas/src/index.js');
  });
});
