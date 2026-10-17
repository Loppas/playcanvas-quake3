/** Types for `q3-commands.mjs`, which the page and the desktop shell import. */

/** Split a config into command lines, as `Cbuf_Execute` does. */
export declare function commandLines(text: string): string[];

/** Split a command line into its tokens, as `Cmd_TokenizeString` does. */
export declare function tokenize(line: string): string[];

/** Every command in a config, as `exec` runs them: each line's tokens, blank lines left out. */
export declare function configCommands(text: string): string[][];
