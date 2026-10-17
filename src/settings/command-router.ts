import { atoi } from '../formats/c-scan';
import { configCommands } from '../formats/q3config';
import { isHostCommand } from '../server/host';
import { isGameCommand } from '../sim/game';

/**
 * How many files deep an `exec` may run. Quake 3 has no limit: a file that execs itself grows the
 * command buffer until it overflows, or, with the `exec` last, runs for ever.
 */
export const MAX_EXEC_DEPTH = 16;

/** Where the router sends what it doesn't run itself. */
export interface CommandRoutes {
  /** The client's own commands, which run at once. Whether it was one. */
  client(argv: readonly string[]): boolean;
  /**
   * The host's commands and the game module's, as a line for the host's command buffer. Whether
   * something took it, which with no server running a game module's is not; a promise holds every
   * command behind it until it settles, as Q3's `map` holds the program until the map is in.
   */
  host(line: string, argv: readonly string[]): boolean | Promise<void>;
  /** The settings' commands (`GameConfig.command`). Whether it was one. */
  config(argv: readonly string[]): boolean;
  /**
   * `CL_ForwardCommandToServer`: send a command nothing here knows to the server, as a client
   * command. Whether there was a server to send it to.
   */
  forward?(line: string, argv: readonly string[]): boolean;
}

export interface CommandRouterOptions extends CommandRoutes {
  /** A cfg's text by its path, or `undefined` where there is none. */
  readCfg(path: string): Promise<string | undefined>;
  /** Print to the console. */
  print(text: string): void;
  /** Where a command nothing takes is reported, once it runs from a file or behind one. */
  warn?: (message: string) => void;
}

/** A command waiting its turn, and how many files deep it came from. */
interface Queued {
  argv: readonly string[];
  depth: number;
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
 * The console's commands, as far as the port has a console: a bind's that is neither a button nor
 * cgame's, and the menu's. They go where `Cmd_ExecuteString` sends them (`cmd.c:800–850`): the
 * client's own, then the host's and the game module's, then the settings', then the server.
 *
 * `exec` and `wait` are the router's own, and so is holding for a map. Quake 3 reads a file at once
 * and puts its commands in front of whatever is queued behind it (`Cbuf_InsertText`,
 * `cmd.c:113–135`), and loads a map before the next command runs. The port does both
 * asynchronously, so while a file is read, a `wait` counts its frames or a map loads, every command
 * that comes waits behind it. A file's lines then run in order, and a nested `exec`'s file runs
 * before the lines after it.
 */
export class CommandRouter {
  private readonly options: CommandRouterOptions;
  private readonly warn: (message: string) => void;
  private readonly queue: Queued[] = [];
  private draining = false;
  private drained: Promise<void> = Promise.resolve();
  /** What {@link frame} lets go: each `wait`'s next frame. */
  private frames: (() => void)[] = [];

  constructor(options: CommandRouterOptions) {
    this.options = options;
    this.warn = options.warn ?? console.warn;
  }

  /**
   * Run a command: at once, unless something is ahead of it, when it waits its turn.
   *
   * @returns Whether it was taken. `false` is for a command nothing knows, run at once; one that
   *   waits is reported when it runs.
   */
  execute(argv: readonly string[]): boolean {
    if (!this.draining && !isExec(argv) && !isWait(argv)) {
      const taken = this.route(argv);
      if (typeof taken === 'boolean') return taken;
      this.startDrain(taken);
      return true;
    }
    this.queue.push({ argv, depth: 0 });
    if (!this.draining) this.startDrain();
    return true;
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

  private route(argv: readonly string[]): boolean | Promise<void> {
    if (this.options.client(argv)) return true;
    // The server's own commands, and the game module's, go in the server's command buffer, as Q3
    // runs a command at the console through the one `Cmd_ExecuteString`.
    if (isHostCommand(argv[0]) || isGameCommand(argv[0])) {
      return this.options.host(commandLine(argv), argv);
    }
    return this.options.config(argv) || this.forward(argv);
  }

  /**
   * `CL_ForwardCommandToServer` as id released it (`cl_main.c:787–807`): a key's release is dropped
   * without a word, and a press, like anything with no server to hear it, is unknown.
   */
  private forward(argv: readonly string[]): boolean {
    const name = argv[0] ?? '';
    if (name.startsWith('-')) return true;
    if (name.startsWith('+')) return false;
    return this.options.forward?.(commandLine(argv), argv) ?? false;
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
          const taken = this.route(argv);
          if (taken === false) this.warn(`Unknown command "${argv[0]}"`);
          else if (taken !== true && !(await succeeded(taken))) return;
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
