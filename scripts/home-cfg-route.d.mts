/** Types for `home-cfg-route.mjs`, which the desktop shell imports. */

/** The URL prefix the home folder is read under. */
export declare const HOME_ROUTE: '/homepath/';

/** Whether a name is a cfg: the `.cfg` extension, in any case. */
export declare function isCfgName(name: string): boolean;

/** Whether a path below the home folder may be read. */
export declare function isHomePath(relative: string): boolean;

/** The names of the cfg and `.txt` files directly in `dir`, sorted. */
export declare function listFiles(dir: string): Promise<string[]>;

/** What to answer a request below the route with; see `homeCfgResponse`. */
export interface HomeCfgAnswer {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

/** Answer a request below the route: a cfg's text, a folder's listing, or a file replaced. */
export declare function homeCfgResponse(
  method: string,
  encoded: string,
  home: string,
  body?: string
): Promise<HomeCfgAnswer>;
