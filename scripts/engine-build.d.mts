/** Types for `engine-build.mjs`, which `vite.config.ts` imports from TypeScript. */

/** The export condition each mode asks for: `profiler`, or the release build's `production`. */
export declare const ENGINE_CONDITIONS: Readonly<Record<string, string>>;

/** The engine's build condition and a cache folder of its own for a mode, or nothing. */
export declare function engineBuild(mode: string): {
  resolve?: { conditions: string[] };
  cacheDir?: string;
};
