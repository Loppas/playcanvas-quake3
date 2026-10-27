import { atoi } from '../formats/c-scan';
import { configCommands } from '../formats/q3config';

/**
 * How many files deep an `exec` may run. Quake 3 has no limit: a file that execs itself grows the
 * command buffer until it overflows, or, with the `exec` last, runs for ever.
 */
export const MAX_EXEC_DEPTH = 16;

/**
 * A command's function, `xcommand_t`, handed the command's words. A promise holds every command
 * behind it until it settles, as Q3's `map` holds the program until the map is in.
 */
export type CommandFunction = (argv: readonly string[]) => void | Promise<void>;

/** Where a part of the program puts its commands, as each of Q3's calls `Cmd_AddCommand`. */
export interface CommandTable {
  add(name: string, run: CommandFunction): void;
}

/** What `Cmd_ExecuteString` tries after the registered commands, in its order. */
export interface CommandRouterOptions {
  /** `Cvar_Command`: a cvar's name, and a value to set it to. Whether it was one. */
  cvar(argv: readonly string[]): boolean;
  /** `CL_GameCommand`: one of cgame's, where a cgame runs. Whether it was one. */
  cgame?(argv: readonly string[]): boolean;
  /**
   * `SV_GameCommand`: one of the game module's, as a line for the command buffer of a server this
   * program runs. Whether one took it.
   */
  game(line: string, argv: readonly string[]): boolean;
  /**
   * `CL_ForwardCommandToServer`'s send: a command nothing here knows, to the server as a client
   * command. Whether there was one to send it to. A program with no client half has none, and
   * says nothing of a command nothing takes (`null_client.c:68–69`).
   */
  forward?(line: string, argv: readonly string[]): boolean;
  /** A cfg's text by its path, or `undefined` where there is none. */
  readCfg(path: string): Promise<string | undefined>;
  /** Print to the console. */
  print(text: string): void;
}

/** A command waiting its turn, and how many files deep it came from. */
interface Queued {
  argv: readonly string[];
  depth: number;
}

/** What Quake 3 prints of a command nothing takes (`cl_main.c:1502`). */
export function unknownCommand(name: string): string {
  return `Unknown command "${name}^7"`;
}

/**
 * `COM_DefaultExtension` as id released it (`q_shared.c:57–76`): the extension, unless there is a
 * dot after the name's last slash. The walk back stops short of the name's first character, so a
 * leading dot doesn't count.
 */
export function defaultExtension(path: string, extension: string): string {
  for (let i = path.length - 1; i > 0 && path[i] !== '/'; i--) {
    if (path[i] === '.') return path;
  }
  return path + extension;
}

/** A command as a line another command buffer reads back into the same words. */
export function commandLine(argv: readonly (string | number)[]): string {
  return argv.map((arg) => `"${arg}"`).join(' ');
}

const isExec = (argv: readonly string[]) => argv[0]?.toLowerCase() === 'exec';
const succeeded = (held: Promise<void>) => held.then(() => true, () => false);
const isWait = (argv: readonly string[]) => argv[0]?.toLowerCase() === 'wait';

/**
 * The console's commands, as far as the port has a console: a bind's, the menu's and a cfg's.
 * Each goes where `Cmd_ExecuteString` sends it (`cmd.c:762–815`): to the command registered under
 * its name, matched without regard to case; else to the cvar of that name, cgame, the game module
 * and the server, in that order.
 *
 * `exec` and `wait` are the router's own, and so is holding for a map. Quake 3 reads a file at once
 * and puts its commands in front of whatever is queued behind it (`Cbuf_InsertText`,
 * `cmd.c:113–135`), and loads a map before the next command runs. The port does both
 * asynchronously, so while a file is read, a `wait` counts its frames or a map loads, every command
 * that comes waits behind it. A file's lines then run in order, and a nested `exec`'s file runs
 * before the lines after it.
 */
export class CommandRouter implements CommandTable {
  private readonly options: CommandRouterOptions;
  /** `cmd_functions`, by their names in lower case. */
  private readonly commands = new Map<string, CommandFunction>();
  private readonly queue: Queued[] = [];
  private draining = false;
  private drained: Promise<void> = Promise.resolve();
  /** What {@link frame} lets go: each `wait`'s next frame. */
  private frames: (() => void)[] = [];

  constructor(options: CommandRouterOptions) {
    this.options = options;
  }

  /** `Cmd_AddCommand` (`cmd.c:638–657`): a name already taken keeps its first command. */
  add(name: string, run: CommandFunction): void {
    const key = name.toLowerCase();
    if (this.commands.has(key)) {
      this.options.print(`Cmd_AddCommand: ${name} already defined\n`);
      return;
    }
    this.commands.set(key, run);
  }

  /** Run a command: at once, unless something is ahead of it, when it waits its turn. */
  execute(argv: readonly string[]): void {
    if (!this.draining && !isExec(argv) && !isWait(argv)) {
      const held = this.route(argv);
      if (held) this.startDrain(held);
      return;
    }
    this.queue.push({ argv, depth: 0 });
    if (!this.draining) this.startDrain();
  }

  /** `Com_Frame`'s turn at the buffer: a `wait` counts this frame. */
  frame(): void {
    const waiting = this.frames;
    this.frames = [];
    for (const go of waiting) go();
  }

  /** Resolves once every command asked for so far has run. */
  settled(): Promise<void> {
    return this.drained;
  }

  private route(argv: readonly string[]): void | Promise<void> {
    if (argv.length === 0) return;
    const run = this.commands.get(argv[0].toLowerCase());
    if (run) return run(argv);
    const { options } = this;
    if (options.cvar(argv) || options.cgame?.(argv)) return;
    const line = commandLine(argv);
    if (!options.game(line, argv)) this.forward(line, argv);
  }

  /**
   * `CL_ForwardCommandToServer` (`cl_main.c:1491–1511`): a key's release is dropped without a
   * word, and a press, like anything with no server to hear it, is unknown.
   */
  private forward(line: string, argv: readonly string[]): void {
    const { forward, print } = this.options;
    const name = argv[0];
    if (!forward || name.startsWith('-')) return;
    if (name.startsWith('+') || !forward(line, argv)) print(`${unknownCommand(name)}\n`);
  }

  /** Run the queue, after what holds it, as far as it goes before something has to wait. */
  private startDrain(held?: Promise<void>): void {
    this.draining = true;
    this.drained = this.drain(held);
  }

  private async drain(held: Promise<void> | undefined): Promise<void> {
    try {
      // A map that fails to load has said so where it failed, and takes the rest with it.
      if (held && !(await succeeded(held))) return;
      while (this.queue.length > 0) {
        const { argv, depth } = this.queue.shift()!;
        if (isExec(argv)) await this.exec(argv, depth);
        else if (isWait(argv)) await this.wait(argv);
        else {
          const holds = this.route(argv);
          if (holds && !(await succeeded(holds))) return;
        }
      }
    } finally {
      // A command that throws takes the rest with it, rather than leaving them behind later ones.
      this.queue.length = 0;
      this.draining = false;
    }
  }

  /**
   * `Cmd_Wait_f` (`cmd.c:52–58`): hold the rest for that many frames, or one. A negative count
   * holds id's buffer for ever, and counts as one, as ioq3 has it.
   */
  private async wait(argv: readonly string[]): Promise<void> {
    let frames = argv.length === 2 ? atoi(argv[1]) : 1;
    if (frames < 0) frames = 1;
    for (let i = 0; i < frames; i++) {
      await new Promise<void>((resolve) => this.frames.push(resolve));
    }
  }

  /**
   * `Cmd_Exec_f` as id released it (`cmd.c:256–277`), where ioq3 has since changed the messages:
   * they name the file as it was typed, not with the extension it was read under.
   */
  private async exec(argv: readonly string[], depth: number): Promise<void> {
    const { options } = this;
    if (argv.length !== 2) {
      options.print('exec <filename> : execute a script file\n');
      return;
    }
    if (depth >= MAX_EXEC_DEPTH) {
      options.print(`couldn't exec ${argv[1]}: nested too deeply\n`);
      return;
    }
    const text = await options.readCfg(defaultExtension(argv[1], '.cfg'));
    if (text === undefined) {
      options.print(`couldn't exec ${argv[1]}\n`);
      return;
    }
    options.print(`execing ${argv[1]}\n`);
    this.queue.unshift(...configCommands(text).map((line) => ({ argv: line, depth: depth + 1 })));
  }
}
