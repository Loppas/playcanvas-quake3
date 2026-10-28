import { PRODUCT_NAME } from './formats/q3config';
import { GAMENAME } from './net/net';
import { inShell } from './shell';

/** `Q3_VERSION` (`q_shared.h:75`): the port's name and its version, which the console draws. */
export const Q3_VERSION = `${PRODUCT_NAME} ${__PRODUCT_VERSION__}`;

/**
 * `PLATFORM_STRING` (`q_platform.h:416–420`): what the port is running in. Quake 3's is the system
 * and processor it was built for; the port is one build for a browser, the desktop shell and Node,
 * so it asks where it is. A worker, where a tab's server runs, has no window but a location of its
 * own, which says where the page is.
 */
export function platformString(): string {
  const { location } = globalThis as { location?: Pick<Location, 'protocol'> };
  if (location === undefined) return 'node';
  return inShell(location) ? 'shell' : 'browser';
}

/**
 * The `version` cvar (`common.c:2794–2795`), which a server's serverinfo carries:
 * `Q3_VERSION PLATFORM_STRING PRODUCT_DATE`, with the port's game name for ioquake3's.
 */
export function versionString(): string {
  return `${GAMENAME} ${__PRODUCT_VERSION__} ${platformString()} ${__PRODUCT_DATE__}`;
}
