/**
 * `CG_TellTarget_f` and `CG_TellAttacker_f`'s one body (`cg_consolecmds.c:183–209`): `tell` to the
 * player cgame names, with the words after the command. Engine-free.
 */

/** The two commands' buffers, the words' and the command's (`cg_consolecmds.c:185–186`). */
const TELL_BUFFER = 128;

/**
 * The `tell` command to `target`, with the words after the command joined by spaces, as
 * `trap_Args` joins them. The words and the command are each cut to their 128-byte buffer, and the
 * command's cut is said as `Com_sprintf` says it.
 *
 * @param target - `CG_CrosshairPlayer`'s or `CG_LastAttacker`'s answer.
 * @param argv - The command and its words.
 * @param print - cgame's `Com_Printf`.
 * @returns the command, or `null` with nobody to tell.
 */
export function tellCommand(
  target: number,
  argv: readonly string[],
  print: (text: string) => void
): string | null {
  if (target === -1) return null;
  const message = argv.slice(1).join(' ').slice(0, TELL_BUFFER - 1);
  const command = `tell ${target} ${message}`;
  if (command.length >= TELL_BUFFER) {
    print(
      `Com_sprintf: Output length ${TELL_BUFFER} too short, require ${command.length + 1} bytes.\n`
    );
  }
  return command.slice(0, TELL_BUFFER - 1);
}
