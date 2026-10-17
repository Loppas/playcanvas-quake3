/** Types for `baseq3-route.mjs`, which the pak tests and the desktop shell import. */

import type { PlatformPath } from 'node:path';

/** The game directory under `fs_basepath`: ioq3's `BASEGAME`. */
export declare const BASEGAME: 'baseq3';

/** Resolve a request path below `root`, or `null` if it would land anywhere else. */
export declare function resolveInside(
  root: string,
  relative: string,
  path?: PlatformPath
): string | null;

/** Whether a name is a pk3 directly in the served folder. */
export declare function isPakName(name: string): boolean;

/** One entry of the pak listing. */
export interface PakListing {
  name: string;
  size: number;
}

/** Every pk3 file directly in `dir`, with its size, sorted by name. */
export declare function listPaks(dir: string): Promise<PakListing[]>;

/** What to answer a request with; see `rangeResponse`. */
export interface RangeAnswer {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  /** First byte to send, for a 206. */
  start?: number;
  /** Last byte to send, inclusive, for a 206. */
  end?: number;
}

/** The status and headers answering a request for a file of `size` bytes. */
export declare function rangeResponse(
  rangeHeader: string | null | undefined,
  size: number
): RangeAnswer;
