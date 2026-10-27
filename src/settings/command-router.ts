import { atoi } from '../formats/c-scan';
import { comFilter } from '../formats/com-filter';
import { configCommands } from '../formats/q3config';

/**
 * How deep `exec` and `vstr` may nest before a frame passes, each running its text in front of
 * the rest (`Cbuf_InsertText`). Quake 3 has no limit: a file that execs itself grows the command
 * buffer until it overflows, and a cvar that runs itself, or a file with its `exec` last, runs for
 * ever inside the frame. A `wait` lets the frame pass, so a loop that waits runs on, as Q3's does.
 */
export const MAX_INSERT_DEPTH = 16;

/**
 * A command's function, `xcommand_t`, handed the command's words. A promise holds every command
 * behind it until it settles, as Q3's `map` holds the program until the map is in.
 */
export type CommandFunction = (argv: readonly string[]) => void | Promise<void>;

/** Where a part of the program puts its commands, as each of Q3's calls `Cmd_AddCommand`. */
export interface CommandTable {
  /**
   * A command, or with no function a name for completion alone, as cgame adds its own and the
   * game's: a line under that name goes on to the cvars, cgame, the game and the server.
   */
  add(name: string, run?: CommandFunction): void;
}

/** What `Cmd_ExecuteString` tries after the registered commands, in its order. */
export interface CommandRouterOptions {
  /** `Cvar_Command`: a cvar's name, and a value to set it to. Whether it was one. */
  cvar(argv: readonly string[]): boolean;
  /** `Cvar_VariableString`: a cvar's string, or `''` for one there is none of. */
  cvarString(name: string): string;
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

/**
 * A command waiting its turn, and how deep the `exec` or `vstr` that queued it nests: a `wait`
 * puts what is behind it back to 0.
 */
interface Queued {
  argv: readonly string[];
  depth: number;
}

/** A registered command as the router runs it: handed its depth, which only the router's own read. */
type Run = (argv: readonly string[], depth: number) => void | Promise<void>;

/** `cmd_function_t`: a name as it was added, and its function, or none for completion alone. */
interface Registered {
  name: string;
  run: Run | null;
}

/** What Quake 3 prints of a command nothing takes (`cl_main.c:1502`). */
export function unknownCommand(name: string): string {
  return `Unknown command "${name}^7"`;
}

/**
 * `COM_DefaultExtension` (`q_shared.c:144–151`): the extension, unless there is a dot after the
 * name's last slash.
 */
export function defaultExtension(path: string, extension: string): string {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && path.lastIndexOf('/') < dot ? path : path + extension;
}

/** A command as a line another command buffer reads back into the same words. */
export function commandLine(argv: readonly (string | number)[]): string {
  return argv.map((arg) => `"${arg}"`).join(' ');
}

const succeeded = (held: Promise<void>) => held.then(() => true, () => false);

/**
 * The console's commands, as far as the port has a console: a bind's, the menu's and a cfg's. Each
 * goes where
 * `Cmd_ExecuteString` sends it (`cmd.c:762–815`): to the command registered under its name,
 * matched without regard to case; else to the cvar of that name, cgame, the game module and the
 * server, in that order.
 *
 * The router is `cmd.c`, so `Cmd_Init`'s commands are its own (`cmd.c:860–870`): `cmdlist`,
 * `exec`, `execq`, `vstr`, `echo` and `wait`. Quake 3 reads a file at once and puts its commands in
 * front of whatever is queued behind it (`Cbuf_InsertText`, `cmd.c:113–135`), as `vstr` does a
 * cvar's, and loads a map before the next command runs. The port reads files and loads maps
 * asynchronously, so while a file is read, a `wait` counts its frames or a map loads, every command
 * that comes waits behind it. A file's lines then run in order, and a nested `exec`'s file runs
 * before the lines after it.
 */
export class CommandRouter implements CommandTable {
  private readonly options: CommandRouterOptions;
  /**
   * `cmd_functions`, by their names in lower case, the newest last: a command moves there as it
   * runs, as Q3 moves it to the head of its list (`cmd.c:777–779`).
   */
  private readonly commands = new Map<string, Registered>();
  private readonly queue: Queued[] = [];
  private draining = false;
  private drained: Promise<void> = Promise.resolve();
  /** What {@link frame} lets go: each `wait`'s next frame. */
  private frames: (() => void)[] = [];

  constructor(options: CommandRouterOptions) {
    this.options = options;
    this.register('cmdlist', (argv) => this.list(argv));
    this.register('exec', (argv, depth) => this.exec(argv, depth));
    this.register('execq', (argv, depth) => this.exec(argv, depth));
    this.register('vstr', (argv, depth) => this.vstr(argv, depth));
    this.register('echo', (argv) => void options.print(`${argv.slice(1).join(' ')}\n`));
    this.register('wait', (argv) => this.wait(argv));
  }

  /**
   * `Cmd_AddCommand` (`cmd.c:638–657`): a name already taken keeps what it has, and a command
   * says so, where a name for completion alone says nothing.
   */
  add(name: string, run?: CommandFunction): void {
    this.register(name, run ? (argv) => run(argv) : null);
  }

  /** Run a command: at once, unless something is ahead of it, when it waits its turn. */
  execute(argv: readonly string[]): void {
    if (this.draining) {
      this.queue.push({ argv, depth: 0 });
      return;
    }
    // What it holds for, or what it put in front of the rest, starts the queue.
    const held = this.route({ argv, depth: 0 });
    if (held || this.queue.length > 0) this.startDrain(held);
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

  private register(name: string, run: Run | null): void {
    const key = name.toLowerCase();
    if (this.commands.has(key)) {
      if (run) this.options.print(`Cmd_AddCommand: ${name} already defined\n`);
      return;
    }
    this.commands.set(key, { name, run });
  }

  /** Run the queue, after what holds it, as far as it goes before something has to wait. */
  private startDrain(held?: Promise<void> | void): void {
    this.draining = true;
    this.drained = this.drain(held);
  }

  private async drain(held: Promise<void> | void): Promise<void> {
    try {
      // A map that fails to load has said so where it failed, and takes the rest with it.
      if (held && !(await succeeded(held))) return;
      while (this.queue.length > 0) {
        const holds = this.route(this.queue.shift()!);
        if (holds && !(await succeeded(holds))) return;
      }
    } finally {
      // A command that throws takes the rest with it, rather than leaving them behind later ones.
      this.queue.length = 0;
      this.draining = false;
    }
  }

  private route({ argv, depth }: Queued): void | Promise<void> {
    if (argv.length === 0) return;
    const key = argv[0].toLowerCase();
    const registered = this.commands.get(key);
    if (registered) {
      this.commands.delete(key);
      this.commands.set(key, registered);
      if (registered.run) return registered.run(argv, depth);
    }
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

  /** Commands in front of the rest, one deeper than what queued them (`Cbuf_InsertText`). */
  private insert(commands: readonly (readonly string[])[], depth: number): void {
    this.queue.unshift(...commands.map((argv) => ({ argv, depth: depth + 1 })));
  }

  /** `Cmd_List_f` (`cmd.c:822–842`): the names, newest first, that the word after it matches. */
  private list(argv: readonly string[]): void {
    const { print } = this.options;
    const match = argv[1];
    let count = 0;
    for (const { name } of [...this.commands.values()].reverse()) {
      if (match !== undefined && !comFilter(match, name)) continue;
      print(`${name}\n`);
      count++;
    }
    print(`${count} commands\n`);
  }

  /**
   * `Cmd_Wait_f` (`cmd.c:52–60`): hold the rest for that many frames, or one, a negative count
   * as one. Once they have passed, nothing behind it is nested in this frame's `exec` or `vstr`.
   */
  private async wait(argv: readonly string[]): Promise<void> {
    let frames = argv.length === 2 ? atoi(argv[1]) : 1;
    if (frames < 0) frames = 1;
    for (let i = 0; i < frames; i++) {
      await new Promise<void>((resolve) => this.frames.push(resolve));
    }
    for (const queued of this.queue) queued.depth = 0;
  }

  /**
   * `Cmd_Exec_f` (`cmd.c:267–296`): its lines name the file with the extension it was read under,
   * and `execq` says nothing of a file it runs.
   */
  private async exec(argv: readonly string[], depth: number): Promise<void> {
    const { options } = this;
    const quiet = argv[0].toLowerCase() === 'execq';
    if (argv.length !== 2) {
      const q = quiet ? 'q' : '';
      options.print(`exec${q} <filename> : execute a script file${quiet ? ' without notification' : ''}\n`);
      return;
    }
    const path = defaultExtension(argv[1], '.cfg');
    if (depth >= MAX_INSERT_DEPTH) {
      options.print(`couldn't exec ${path}: nested too deeply\n`);
      return;
    }
    const text = await options.readCfg(path);
    if (text === undefined) {
      options.print(`couldn't exec ${path}\n`);
      return;
    }
    if (!quiet) options.print(`execing ${path}\n`);
    this.insert(configCommands(text), depth);
  }

  /** `Cmd_Vstr_f` (`cmd.c:306–316`): a cvar's string run as commands, in front of the rest. */
  private vstr(argv: readonly string[], depth: number): void {
    const { options } = this;
    if (argv.length !== 2) {
      options.print('vstr <variablename> : execute a variable command\n');
      return;
    }
    if (depth >= MAX_INSERT_DEPTH) {
      options.print(`vstr ${argv[1]}: nested too deeply\n`);
      return;
    }
    this.insert(configCommands(options.cvarString(argv[1])), depth);
  }
}
