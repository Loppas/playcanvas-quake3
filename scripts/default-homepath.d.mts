/** Types for `default-homepath.mjs`, which the desktop shell imports. */

/** The folder's name. */
export declare const HOMEPATH_NAME: 'playcanvas-quake3';

/** The platform, environment and home folder {@link defaultHomepath} goes by. */
export interface HomepathSystem {
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

/** The OS's own place for `fs_homepath`, in the platform's own path style. */
export declare function defaultHomepath(system?: HomepathSystem): string;
