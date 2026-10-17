/** Types for `fs-basepath.mjs`, which the pak test fixtures import from TypeScript. */

/** The game directory under `fs_basepath`: ioq3's `BASEGAME`. */
export declare const BASEGAME: 'baseq3';

/** `fs_basepath`, absolute: `PCQ_FS_BASEPATH` from the environment or `.env` files, else `root`. */
export declare function fsBasepath(root: string, mode: string): string;

/** The folder the paks are read from: `baseq3` under {@link fsBasepath}. */
export declare function baseq3Dir(root: string, mode: string): string;
