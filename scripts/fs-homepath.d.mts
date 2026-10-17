/** Types for `fs-homepath.mjs`, which the dedicated server's entry imports from TypeScript. */

/** `fs_homepath`, absolute: `PCQ_FS_HOMEPATH` from the environment or `.env` files, else the OS's. */
export declare function fsHomepath(root: string, mode: string): string;
