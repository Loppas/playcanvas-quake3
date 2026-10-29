import { MAX_CLIENTS } from '../net/protocol';
import type { HudInput } from './hud';

/**
 * Who last hurt the player, as cgame keeps it: `cg.attackerTime`, which `CG_DamageFeedback` stamps
 * (`cg_playerstate.c:103`) and `CG_DrawAttacker` clears (`cg_draw.c:668–691`), and what
 * `tell_attacker` reads of it through `CG_LastAttacker`. The head `CG_DrawAttacker` draws in the
 * corner is not drawn; its clearing runs as `cg_drawAttacker`'s default 1 runs it. Engine-free.
 */

/** `ATTACKER_HEAD_TIME` (`cg_local.h:53`): how long the attacker is kept once the player lives. */
export const ATTACKER_HEAD_TIME = 10000;

/** `CG_TellAttacker_f`'s buffers, the words' and the command's (`cg_consolecmds.c:200–201`). */
const TELL_BUFFER = 128;

/** `cg.attackerTime`. */
export interface AttackerState {
  /** When the player was last hurt, in `cg.time`'s whole milliseconds; 0 for nobody to name. */
  time: number;
}

/** As `CG_Init` leaves it, `cg` cleared: nobody. */
export function createAttacker(): AttackerState {
  return { time: 0 };
}

/**
 * `CG_LastAttacker`: who last hurt the player, while the attacker time holds.
 *
 * @param attacker - `PERS_ATTACKER` of the snapshot's player state: a slot, or the world's number.
 * @returns that, or −1 with nobody kept.
 */
export function lastAttacker(state: Readonly<AttackerState>, attacker: number): number {
  return state.time ? attacker : -1;
}

/**
 * `CG_DrawAttacker`'s clearing, called where it would draw: with the player alive and the attacker
 * another player, one whose info has gone, or who hurt the player more than
 * {@link ATTACKER_HEAD_TIME} ago, is let go. Nothing is let go while the player is dead, nor a hurt
 * by the world or by the player themself. Moves `state` on.
 *
 * @param input - The predicted player's health and `PERS_ATTACKER`, whose state it is, `cg.time`
 *   and `cgs.clientinfo`.
 */
export function expireAttacker(
  state: AttackerState,
  input: Pick<HudInput, 'health' | 'attackerNum' | 'clientNum' | 'time' | 'clientInfo'>
): void {
  if (input.health <= 0) return;
  const { attackerNum } = input;
  if (attackerNum < 0 || attackerNum >= MAX_CLIENTS || attackerNum === input.clientNum) return;
  if (!input.clientInfo(attackerNum) || Math.floor(input.time) - state.time > ATTACKER_HEAD_TIME) {
    state.time = 0;
  }
}

/**
 * `CG_TellAttacker_f`'s command: `tell` to the last attacker, with the words after
 * `tell_attacker` joined by spaces, as `trap_Args` joins them. The words and the command are each
 * cut to their 128-byte buffer, and the command's cut is said as `Com_sprintf` says it.
 *
 * @param attacker - {@link lastAttacker}'s answer.
 * @param argv - `tell_attacker` and its words.
 * @param print - cgame's `Com_Printf`.
 * @returns the command, or `null` with nobody to tell.
 */
export function tellAttackerCommand(
  attacker: number,
  argv: readonly string[],
  print: (text: string) => void
): string | null {
  if (attacker === -1) return null;
  const message = argv.slice(1).join(' ').slice(0, TELL_BUFFER - 1);
  const command = `tell ${attacker} ${message}`;
  if (command.length >= TELL_BUFFER) {
    print(
      `Com_sprintf: Output length ${TELL_BUFFER} too short, require ${command.length + 1} bytes.\n`
    );
  }
  return command.slice(0, TELL_BUFFER - 1);
}
