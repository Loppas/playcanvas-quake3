/**
 * Which of PlayCanvas's builds the dev server serves, by Vite's mode.
 *
 * The engine ships three, picked by its package's export conditions: the debug build, with its
 * checks and a validation scope around every WebGPU draw, which `npm run dev` serves as Vite's
 * default `development` condition picks it; the profiler build, the release code with its frame
 * and GPU timings kept; and the release build a player gets. `npm run play` serves the release
 * build, and a measuring script asks for the profiler build, each from a dependency cache of its
 * own so one build's bundle is never served for another.
 */

/** The export condition each mode asks for, beside the browser's own. */
export const ENGINE_CONDITIONS = {
  profiler: 'profiler',
  release: 'production'
};

/**
 * Vite's `resolve` and `cacheDir` for a mode: the engine's build condition and a cache folder of
 * its own, or nothing for any other mode, which keeps Vite's defaults and the debug build.
 *
 * @param mode - Vite's mode.
 * @returns The config's part, to spread into it.
 */
export function engineBuild(mode) {
  const condition = ENGINE_CONDITIONS[mode];
  if (condition === undefined) return {};
  return {
    resolve: { conditions: ['module', 'browser', condition] },
    cacheDir: `node_modules/.vite-${mode}`
  };
}
