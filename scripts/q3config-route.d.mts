/** Types for `q3config-route.mjs`, which the desktop shell imports. */

import type { Readable } from 'node:stream';

/** `Q3CONFIG_CFG` (`q_shared.h`). */
export declare const Q3CONFIG_CFG: 'q3config.cfg';

/** The favourite servers, which the game keeps beside the config. */
export declare const FAVORITES_TXT: 'favorites.txt';

/** The files the game keeps in `fs_homepath`, each at `/homepath/<name>`. */
export declare const KEPT_FILES: readonly string[];

/** The kept file a URL's path names, or `undefined` for any other path. */
export declare function keptFile(pathname: string): string | undefined;

/** The largest file the route takes. */
export declare const MAX_CONFIG_BYTES: number;

/** Whether a request comes from the page's own origin. */
export declare function isSameOrigin(
  headers: Record<string, string | string[] | undefined>
): boolean;

/** What to answer a request for a kept file with; see `configResponse`. */
export interface ConfigAnswer {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

/** Answer a request for a kept file, reading or replacing `file`. */
export declare function configResponse(
  method: string,
  body: string | undefined,
  file: string
): Promise<ConfigAnswer>;

/** Replace a file in the home folder, written beside it and moved into place. */
export declare function replaceFile(file: string, text: string): Promise<void>;

/** A request's body as text, or `null` for one past `limit` bytes. */
export declare function readBody(request: Readable, limit?: number): Promise<string | null>;
