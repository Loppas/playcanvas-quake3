import { K } from '../formats/q3-keys';
import { MAX_CLIENTS } from '../net/protocol';
import type { EditField } from './edit-field';

/**
 * Q3's chat line: `messagemode` to `messagemode4` open it (`cl_console.c:104–158`), and
 * `Message_Key` edits and sends it (`cl_keys.c:758–792`). Engine-free.
 */

/** `chatField.widthInChars` for a line said to everyone, or told to one player. */
export const CHAT_WIDTH = 30;

/** `chatField.widthInChars` for a line said to the team, whose prompt is the longer. */
export const TEAM_CHAT_WIDTH = 25;

/** Who a line goes to: everyone, the team, or one player. */
export type ChatMode = 'say' | 'say_team' | 'tell';

/** What the four commands and `Message_Key` work on. */
export interface ChatLine {
  /** `chatField`: the line being typed. */
  field: EditField;
  /** `chat_team`: the line is said to the team. */
  team: boolean;
  /** `chat_playerNum`: the slot a tell goes to, or −1 to say the line. */
  playerNum: number;
  /** Whether the client is in a match: `clc.state == CA_ACTIVE`. */
  active(): boolean;
  /** `CL_AddReliableCommand`: a command for the server, sent as it is. */
  send(command: string): void;
  /** The MESSAGE catcher let go. */
  close(): void;
}

/**
 * `Con_MessageMode_f` to `Con_MessageMode4_f`, short of toggling the MESSAGE catcher: the line set
 * to say to everyone or to the team, or to tell `target`, cleared and given its width. A tell to a
 * number that is no slot, cgame's −1 for nobody, opens nothing; as the C sets `chat_playerNum`
 * before it looks, a tell line already open is said instead.
 *
 * @param target - A tell's: `CG_CrosshairPlayer`'s or `CG_LastAttacker`'s answer.
 * @returns whether the catcher toggles
 */
export function messageMode(line: ChatLine, mode: ChatMode, target = -1): boolean {
  if (mode === 'tell' && (target < 0 || target >= MAX_CLIENTS)) {
    line.playerNum = -1;
    return false;
  }
  line.playerNum = mode === 'tell' ? target : -1;
  line.team = mode === 'say_team';
  line.field.clear();
  line.field.widthInChars = mode === 'say_team' ? TEAM_CHAT_WIDTH : CHAT_WIDTH;
  return true;
}

/**
 * A key pressed at the chat line. Escape lets it go and clears it. Enter sends a line that isn't
 * empty, in a match, inside quotes as it was typed, to the server past the command buffer and its
 * tokenizer; then lets it go and clears it either way. Any other key is the field's.
 *
 * @returns whether the key was taken, so its browser default is stopped
 */
export function messageKey(key: number, line: ChatLine): boolean {
  const { field } = line;
  if (key === K.ESCAPE) {
    line.close();
    field.clear();
    return true;
  }
  if (key === K.ENTER || key === K.KP_ENTER) {
    if (field.text !== '' && line.active()) line.send(chatCommand(line, field.text));
    line.close();
    field.clear();
    return true;
  }
  return field.keyDown(key);
}

/** The command a line goes as (`cl_keys.c:771–781`), with the `\n` Q3 ends it with. */
function chatCommand(line: ChatLine, text: string): string {
  if (line.playerNum !== -1) return `tell ${line.playerNum} "${text}"\n`;
  return line.team ? `say_team "${text}"\n` : `say "${text}"\n`;
}
