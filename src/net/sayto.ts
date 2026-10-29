import { atoi } from '../formats/c-scan';
import { cleanStr } from '../formats/color-codes';
import { CONFIGSTRING } from './commands';
import { infoValueForKey } from './info';

/** `MAX_NAME_LENGTH` (`q_shared.h:253`): a name's buffer, its NUL included. */
const MAX_NAME_LENGTH = 32;

/** What `sayto` needs of the client in a match: its configstrings, and the way to the server. */
export interface SaytoClient {
  configstring(index: number): string;
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
 * The first slot below `sv_maxclients` whose player has the name: theirs cut to its buffer, its
 * colours taken off, and matched without regard to case, as `Q_stricmp` matches.
 *
 * @returns the slot, or −1.
 */
function findPlayer(client: SaytoClient, name: string): number {
  const serverinfo = client.configstring(CONFIGSTRING.SERVERINFO);
  const count = atoi(infoValueForKey(serverinfo, 'sv_maxclients'));
  for (let clientNum = 0; clientNum < count; clientNum++) {
    const info = client.configstring(CONFIGSTRING.PLAYERS + clientNum);
    const cleanName = cleanStr(infoValueForKey(info, 'n').slice(0, MAX_NAME_LENGTH - 1));
    if (cleanName.toLowerCase() === name.toLowerCase()) return clientNum;
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
