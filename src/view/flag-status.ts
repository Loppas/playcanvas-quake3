import { GT } from '../sim/constants';

/**
 * `cgs.redflag` and `cgs.blueflag`: where each side's flag is, as the client reads `CS_FLAGSTATUS`
 * (`CG_SetConfigValues` and `CG_ConfigStringModified`, `cg_servercmds.c:353–361`, `:220–222`).
 * Engine-free.
 *
 * The string is two digits, red first, and they are not `flagStatus_t`'s own numbers: the game
 * writes them through `ctfFlagStatusRemap` (`g_team.c:185–190`), which sends at-base, taken and
 * dropped to "0", "1" and "2" and leaves One Flag CTF's two as "*". So what arrives here is
 * already 0, 1 or 2, and that is the icon's place in each side's three (`cg_main.c:898–903`).
 */

/** What a client knows about the two flags, or −1 for a side the match has not spoken about. */
export interface FlagStatus {
  red: number;
  blue: number;
}

/** `cgs.redflag = cgs.blueflag = -1`: what a client has before any string (`cg_main.c:1874`). */
export const FLAGS_UNKNOWN: FlagStatus = { red: -1, blue: -1 };

/**
 * `CS_FLAGSTATUS`, read as the client reads it.
 *
 * Only Capture the Flag reads the string at all; every other gametype leaves both at −1, which is
 * what the HUD's `>= 0 && <= 2` then refuses to draw. Quake 3 gets its refusal from the arithmetic
 * instead — `s[0] - '0'` on the empty string is −48 — and the port says −1 for the same silence.
 *
 * @param configstring - `CS_FLAGSTATUS`.
 * @param gametype - `cgs.gametype`.
 */
export function readFlagStatus(configstring: string, gametype: number): FlagStatus {
  if (gametype !== GT.CTF) return FLAGS_UNKNOWN;
  return { red: digit(configstring, 0), blue: digit(configstring, 1) };
}

/** `s[n] - '0'`, or −1 where the string is shorter than Quake 3's two. */
function digit(configstring: string, index: number): number {
  const code = configstring.charCodeAt(index);
  return Number.isNaN(code) ? -1 : code - 0x30;
}
