/**
 * Info strings — Quake 3's `q_shared.c:1090–1361`.
 *
 * A pile of key/value pairs written as one string, `\key\value\key\value`, which is how a client
 * tells a server its name and settings, how a server tells its clients about itself, and how an
 * arena file's blocks are kept. The format is on the wire, so it is not the port's to change.
 *
 * Keys match without regard to case, and a key is held once: setting one replaces it wherever it
 * was, and puts the new pair first.
 *
 * Two sizes: {@link MAX_INFO_STRING} for the userinfo and the serverinfo, and
 * {@link BIG_INFO_STRING} for a systeminfo, which carries every rule cvar and outgrows the first.
 */

import { BIG_INFO_STRING } from './msg';

/** `MAX_INFO_STRING` (`q_shared.h:237`): an info string's size, its NUL included. */
export const MAX_INFO_STRING = 1024;

/** The characters no key or value may hold: each would end a pair early or run a command. */
const BLACKLIST = ['\\', ';', '"'];

/**
 * `Info_ValueForKey` (`q_shared.c:1090–1137`): the value for a key, or an empty string if it is
 * not there.
 */
export function infoValueForKey(info: string, key: string): string {
  const parts = info.split('\\');
  const wanted = key.toLowerCase();
  // An info string opens with a separator, so the first piece is empty and the pairs follow it.
  for (let i = parts[0] === '' ? 1 : 0; i + 1 < parts.length; i += 2) {
    if (parts[i].toLowerCase() === wanted) return parts[i + 1];
  }
  return '';
}

/**
 * `Info_NextPair` (`q_shared.c:1146–1170`): every pair in the string, in order. A lone key with
 * no value behind it is not a pair and ends the walk; Q3's own reader breaks on it.
 */
export function infoPairs(info: string): Array<[string, string]> {
  const parts = info.split('\\');
  const pairs: Array<[string, string]> = [];
  for (let i = parts[0] === '' ? 1 : 0; i + 1 < parts.length; i += 2) {
    pairs.push([parts[i], parts[i + 1]]);
  }
  return pairs;
}

/**
 * `Info_RemoveKey` (`q_shared.c:1186–1235`): the string without the first pair whose key matches.
 *
 * @throws for a string of {@link MAX_INFO_STRING} or more, which Q3 drops the server for
 */
export function infoRemoveKey(info: string, key: string): string {
  return removeKey(info, key, MAX_INFO_STRING);
}

/** {@link infoRemoveKey} at `BIG_INFO_STRING` (`Info_RemoveKey_Big`, `q_shared.c:1239–1280`). */
export function infoRemoveKeyBig(info: string, key: string): string {
  return removeKey(info, key, BIG_INFO_STRING);
}

/**
 * `Info_SetValueForKey` (`q_shared.c:1330–1361`): set a key, or remove it by setting it to an
 * empty value. The new pair goes first.
 *
 * Q3 refuses a key or value holding a backslash, a semicolon or a quote, and a pair that would
 * take the string to {@link MAX_INFO_STRING}. It says so and carries on, so these do too.
 *
 * @param warn - Where Q3's console message goes.
 * @returns the new string. A refused pair leaves the string as it was, except that a pair too long
 *   to fit has already taken the key's old pair out.
 * @throws for a string of {@link MAX_INFO_STRING} or more, which Q3 drops the server for
 */
export function infoSetValueForKey(
  info: string,
  key: string,
  value: string,
  warn: (message: string) => void = console.warn
): string {
  return setValueForKey(info, key, value, MAX_INFO_STRING, 'Info', warn);
}

/**
 * {@link infoSetValueForKey} at `BIG_INFO_STRING` (`Info_SetValueForKey_Big`,
 * `q_shared.c:1365–1400`), which a systeminfo needs: it carries every rule cvar and outgrows the
 * ordinary size.
 */
export function infoSetValueForKeyBig(
  info: string,
  key: string,
  value: string,
  warn: (message: string) => void = console.warn
): string {
  return setValueForKey(info, key, value, BIG_INFO_STRING, 'BIG Info', warn);
}

/** The walk both removals share; the limit is the only difference between Q3's two. */
function removeKey(info: string, key: string, limit: number): string {
  if (info.length >= limit) throw new Error('Info_RemoveKey: oversize infostring');
  if (key.includes('\\')) return info;

  const parts = info.split('\\');
  const wanted = key.toLowerCase();
  for (let i = parts[0] === '' ? 1 : 0; i + 1 < parts.length; i += 2) {
    if (parts[i].toLowerCase() !== wanted) continue;
    parts.splice(i, 2);
    return parts.length === 1 ? '' : parts.join('\\');
  }
  return info;
}

/** The set both sizes share; the limit and the message Q3 prints are the differences. */
function setValueForKey(
  info: string,
  key: string,
  value: string,
  limit: number,
  label: string,
  warn: (message: string) => void
): string {
  if (info.length >= limit) throw new Error('Info_SetValueForKey: oversize infostring');

  for (const banned of BLACKLIST) {
    if (key.includes(banned) || value.includes(banned)) {
      warn(`Can't use keys or values with a '${banned}': ${key} = ${value}`);
      return info;
    }
  }

  const rest = removeKey(info, key, limit);
  if (value === '') return rest;

  const pair = `\\${key}\\${value}`;
  if (pair.length + rest.length >= limit) {
    warn(`${label} string length exceeded`);
    return rest;
  }
  return pair + rest;
}

/**
 * `Info_Print` (`common.c:543–583`): an info string as console lines, one pair to a line with the
 * key padded to twenty characters. A key with nothing after it ends the list.
 */
export function infoPrintLines(info: string): string[] {
  const parts = info.split('\\');
  const lines: string[] = [];
  for (let i = parts[0] === '' ? 1 : 0; i < parts.length; i += 2) {
    // A separator at the very end closes the last value, and starts no key.
    if (i === parts.length - 1 && parts[i] === '') break;
    const key = parts[i].padEnd(20);
    if (i + 1 === parts.length) {
      lines.push(`${key} MISSING VALUE`);
      break;
    }
    lines.push(`${key} ${parts[i + 1]}`);
  }
  return lines;
}

/**
 * `Info_Validate` (`q_shared.c`): an info string a client sent can be trusted to be one.
 *
 * A quote or a semicolon in a userinfo is how a client would try to end the string early and
 * append keys of its own, so a string carrying either is refused whole rather than repaired.
 *
 * @param info - The info string to check.
 */
export function infoValidate(info: string): boolean {
  return !info.includes('"') && !info.includes(';');
}
