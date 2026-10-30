import { atoi } from '../formats/c-scan';
import { cleanStr } from '../formats/color-codes';
import { CONFIGSTRING } from './commands';
import { infoValueForKey } from './info';

/** `MAX_NAME_LENGTH` (`q_shared.h:253`): a name's buffer, its NUL included. */
const MAX_NAME_LENGTH = 32;

/**
 * What `sayto` needs of the client in a match: its configstrings, its own slot, and the way to the
 * server.
 */
export interface SaytoClient {
  configstring(index: number): string;
  /** `clc.clientNum`. */
  readonly clientNum: number;
  sendClientCommand(text: string): void;
}

/** `Com_HexStrToInt` (`q_shared.c:683–715`): `0x` and hex digits, or −1. */
function hexStrToInt(text: string): number {
  return /^0x[0-9a-fA-F]+$/.test(text) ? parseInt(text.slice(2), 16) : -1;
}

/**
 * `Com_FieldStringToPlayerName` (`common.c:3667–3696`): a name as the console's field writes it,
 * `\0xNN` standing for the character it codes, read back. A NUL ends it, as it ends the C's string.
 * At most `MAX_NAME_LENGTH` characters are kept: the C writes its NUL one past its buffer, so a
 * name that fills it matches nobody's.
 */
export function fieldStringToPlayerName(raw: string): string {
  let name = '';
  for (let at = 0; at < raw.length && name.length < MAX_NAME_LENGTH; at++) {
    const code = raw[at] === '\\' ? hexStrToInt(raw.slice(at + 1, at + 5)) : -1;
    if (code === 0) break;
    if (code > -1) {
      name += String.fromCharCode(code);
      at += 4;
    } else {
      name += raw[at];
    }
  }
  return name;
}

/**
 * `Com_PlayerNameToFieldString` (`common.c:3698–3737`): a name as the console's field writes it,
 * each character from the space down as `\0x` and its code in two lower-case hex digits, so the
 * name is one word. {@link fieldStringToPlayerName} reads it back.
 */
export function playerNameToFieldString(name: string): string {
  return name.replace(/[\0- ]/g, (ch) => `\\0x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * A player's `n` as `sayto` finds them by it and Tab lists it: cut to its buffer, and its colours
 * taken off (`cl_main.c:1828–1829`, `3510–3511`).
 */
function playerName(n: string): string {
  return cleanStr(n.slice(0, MAX_NAME_LENGTH - 1));
}

/** The slots `sv_maxclients` says the server has. */
function maxClients(client: Pick<SaytoClient, 'configstring'>): number {
  return atoi(infoValueForKey(client.configstring(CONFIGSTRING.SERVERINFO), 'sv_maxclients'));
}

/** The `n` of the player in a slot, `''` for none. */
function slotName(client: Pick<SaytoClient, 'configstring'>, clientNum: number): string {
  return infoValueForKey(client.configstring(CONFIGSTRING.PLAYERS + clientNum), 'n');
}

/**
 * The names Tab completes `sayto`'s from (`CL_CompletePlayerName`, `cl_main.c:1803–1840`): those
 * of the players in every slot below `sv_maxclients` but the client's own, a slot with an empty
 * `n` skipped, each as {@link playerName} has it, sorted by code unit as `Com_strCompare` sorts.
 */
export function otherPlayerNames(
  client: Pick<SaytoClient, 'configstring' | 'clientNum'>
): string[] {
  const names: string[] = [];
  const count = maxClients(client);
  for (let clientNum = 0; clientNum < count; clientNum++) {
    if (clientNum === client.clientNum) continue;
    const n = slotName(client, clientNum);
    if (n !== '') names.push(playerName(n));
  }
  return names.sort();
}

/**
 * The first slot below `sv_maxclients` whose player has the name, as {@link playerName} has it,
 * matched without regard to case, as `Q_stricmp` matches.
 *
 * @returns the slot, or −1.
 */
function findPlayer(client: SaytoClient, name: string): number {
  const count = maxClients(client);
  for (let clientNum = 0; clientNum < count; clientNum++) {
    if (playerName(slotName(client, clientNum)).toLowerCase() === name.toLowerCase()) {
      return clientNum;
    }
  }
  return -1;
}

/**
 * `CL_Sayto_f` (`cl_main.c:3486–3534`): `tell` the player named the words after the name, by the
 * slot their name is found at in the configstrings. The name typed keeps its own colours.
 *
 * @param argv - `sayto`, the name, and the words.
 * @param client - The client in a match, or `null` with none, which has no players to find.
 * @param print - The console's print.
 */
export function sayto(
  argv: readonly string[],
  client: SaytoClient | null,
  print: (text: string) => void
): void {
  if (argv.length < 3) {
    print('sayto <player name> <text>\n');
    return;
  }

  const name = fieldStringToPlayerName(argv[1]);
  const clientNum = client ? findPlayer(client, name) : -1;
  if (client && clientNum !== -1) {
    client.sendClientCommand(`tell ${clientNum} "${argv.slice(2).join(' ')}"`);
  } else {
    print(`No such player name: ${name}.\n`);
  }
}
