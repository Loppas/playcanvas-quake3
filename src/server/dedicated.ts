import { readInfoFiles, type InfoFile } from '../formats/arena';
import { tokenize } from '../formats/q3config';
import { mapKind } from '../formats/map-kind';
import type { CvarStore } from '../net/cvar';
import type { DatagramSocket } from '../net/net';
import type { PakFileSystem } from '../pak/vfs';
import { CommandRouter, commandLine } from '../settings/command-router';
import type { GameConfig } from '../settings/game-config';
import type { HomeFolder } from '../settings/home-folder';
import { readCfg } from '../settings/presets';
import { BOT_LIST, BOTS_FILE } from '../sim/bots';
import { isGameCommand } from '../sim/game';
import { HOST_COMMANDS } from './host';
import { hostMapFromData, readHostMapData } from './host-map';
import {
  MAX_DEDICATED_FRAME_MSEC,
  ServerProgram,
  nextFrameWait,
  type ServerMaps
} from './program';

/**
 * The dedicated server: Quake 3's `ioq3ded` as the port can have it — the same
 * {@link ServerProgram} a listen server's worker runs, in a process with no page at all.
 *
 * What makes it dedicated is what it does without: no client half, and no local player beside it,
 * so the host's `dedicated` flag is set and Q3's flood protection, its slots and its timeouts bite
 * exactly where they do. Everyone reaches it through its network: the socket its entry opens, and
 * whatever keeps that socket reachable.
 *
 * It boots with no map, as Q3's does: the world comes from the command line's `+map` or from the
 * console's own `map`, and until one is spawned `sv_running` is 0 and the server answers nobody.
 *
 * The frame is Q3's dedicated frame: {@link frameMsec} paces the loop (`SV_FrameMsec`), the msec
 * is the real time that passed, and `Com_ModifyMsec` clamps it at {@link MAX_DEDICATED_FRAME_MSEC}
 * with a hitch warning over 500. An error in a frame is `Com_Error`'s: the server goes, and the
 * program waits at its console for the next `map`. `quit` ends it.
 */

/** Q3's hitch warning threshold (`common.c:3041`): a frame longer than this is reported. */
const HITCH_WARN_MSEC = 500;

/**
 * `Com_Error`'s "solid stream of ERR_DROP" (`common.c:286–295`): an error this soon after the
 * last counts towards a fatal one, and the fourth such in a row is.
 */
const ERROR_STREAM_MSEC = 100;
const ERROR_STREAM_COUNT = 3;

/** `Sys_Error`'s exit code (`sys_main.c:452–464`). */
const SYS_ERROR_EXIT_CODE = 3;

/** A server's way to everyone but the loopback, and what keeps it open. */
export interface ServerNetwork {
  /** The socket, or null when none could be opened and only the loopback is left. */
  readonly socket: DatagramSocket | null;
  /**
   * Told as a master grants the server's registration, each time a connection to it opens: the
   * server's to set.
   */
  onRegistered?: (() => void) | null;
  /** The network's turn in each frame: its connections kept. */
  frame(): void;
  /** Everything let go, once the server has said its last. */
  close(): void;
}

export interface DedicatedServerOptions {
  /** The cvars and the binds: `exec q3config.cfg` has run, or there is no file to run. */
  config: GameConfig;
  /** The search path: the map's files, the bots and nothing else are read here. */
  fs: PakFileSystem;
  /** Where `exec` finds cfgs — the home folder first, then the port's own presets. */
  home: HomeFolder;
  /** `Com_Printf`: the console's lines. */
  print: (text: string) => void;
  /** The words behind the program's name: Q3's `+commands`, `+set` among them. */
  argv?: readonly string[];
  /**
   * The network, opened once the command line has run, as `NET_Init` follows `Com_Init`
   * (`sys_main.c:881–882`): what the command line's cvars and cfgs set is what it opens with.
   * Without one the server has only its loopback.
   */
  network?: (cvars: CvarStore) => Promise<ServerNetwork | null>;
  /** `Sys_Milliseconds`: the clock the net's own timing reads. */
  now?: () => number;
  /** `random()`, for a caller that wants the spawn choice pinned. */
  random?: () => number;
  /** `DEBUG_MODE`, which a test can turn off. The build's unless given. */
  debugMode?: boolean;
  /**
   * Told each error a frame throws, before `Com_Error` takes it: the entry writes its stack to
   * stderr, where Q3 has none to write.
   */
  onError?: (err: Error) => void;
}

export class DedicatedServer {
  /**
   * The server: its slots, its snapshots and its frame. An error's shutdown frees all of it
   * (`sv_init.c:755–772`), so a new one is built then, as the boot built the first.
   */
  program: ServerProgram;
  /** The console's commands, as the entry's stdin and a test feed them. */
  readonly router: CommandRouter;
  /** Whether the server has stopped, which is the process's cue to go. */
  stopped = false;
  /** `Sys_Exit`'s code for the process: 0, or {@link SYS_ERROR_EXIT_CODE} after a fatal error. */
  exitCode = 0;

  private readonly options: DedicatedServerOptions;
  private readonly botFiles: readonly InfoFile[];
  private readonly printLine: (text: string) => void;
  private readonly now: () => number;
  /** The network, once the boot has opened it. */
  private network: ServerNetwork | null = null;
  /** `Com_Error`'s `lastErrorTime` and `errorCount`: how close the errors have come. */
  private lastErrorTime = 0;
  private errorCount = 0;

  /**
   * @param options - The cvars, the search path and the console's own settings.
   * @param botFiles - The bots' files, already read, which `addbot` finds its bots in.
   */
  constructor(options: DedicatedServerOptions, botFiles: readonly InfoFile[]) {
    const { config } = options;
    this.options = options;
    this.botFiles = botFiles;
    this.printLine = options.print;
    this.now = options.now ?? (() => performance.now());
    this.program = this.build();

    // A dedicated server has no client half: no command is the client's own, none is cgame's, and
    // none is sent on to a server.
    this.router = new CommandRouter({
      cvar: (argv) => config.cvarCommand(argv),
      cvarString: (name) => config.cvars.get(name),
      game: (line, argv) => {
        if (!isGameCommand(argv[0])) return false;
        this.program.sendConsoleCommand(line);
        return true;
      },
      readCfg: (path) => readCfg(path, options.home),
      print: options.print
    });
    config.addCommands(this.router);
    for (const name of HOST_COMMANDS) {
      this.router.add(name, (argv) => this.program.sendConsoleCommand(commandLine(argv)));
    }
    // `Com_Quit_f` (`common.c:376–392`): the rest of the line the reason the clients are given.
    // Nothing behind it runs, as `Sys_Quit` never returns.
    this.router.add('quit', (argv) => {
      this.stop(argv.slice(1).join(' ') || 'Server quit');
      return new Promise<void>(() => {});
    });
  }

  /** A server with no map, on the network as it stands. */
  private build(): ServerProgram {
    const { config, fs } = this.options;
    const maps: ServerMaps = {
      // `SV_Map_f`'s check: a map is on the search path when its splat or its BSP is.
      exists: (name) => mapKind(fs, name) !== null,
      load: async (name) =>
        hostMapFromData(await readHostMapData(fs, name), {
          cvars: config.cvars,
          print: this.options.print
        })
    };
    return new ServerProgram({
      cvars: config.cvars,
      maps,
      botFiles: this.botFiles,
      socket: this.network?.socket ?? null,
      print: this.options.print,
      now: this.options.now,
      random: this.options.random,
      debugMode: this.options.debugMode,
      // `com_dedicated`: Q3 holds a client to a command a second only on a dedicated server
      // (`sv_client.c:1634`), and a dedicated one has no player of its own beside it.
      dedicated: true
    });
  }

  /**
   * The network the boot opened: its socket is the server's from now on, and what lands on it
   * between frames is read as it lands ({@link ServerProgram.readArrivals}). That is
   * `NET_Sleep`'s wake, inside `Com_Frame`, so what throws there is `Com_Error`'s as in a frame.
   * A master's grant of the server's registration is the host's to hear.
   */
  open(network: ServerNetwork | null): void {
    this.network = network;
    const socket = network?.socket ?? null;
    this.program.host.net.socket = socket;
    if (socket !== null) socket.onArrival = () => this.guarded(() => this.program.readArrivals());
    if (network !== null) network.onRegistered = () => this.program.host.masterRegistered();
  }

  /**
   * `SV_FrameMsec` (`sv_main.c:1026–1045`): how long the loop waits for the next frame, which is
   * one game frame here. The leftover fraction is `Host`'s own accumulator, so a coarse timer
   * loses nothing.
   */
  get frameMsec(): number {
    return this.program.host.frameMsec;
  }

  /**
   * `SV_FrameMsec`'s wait for the loop (`sv_main.c:1026–1045`): one game frame less the leftover
   * on the `Host`'s accumulator and the time already spent running this frame, so a coarse timer
   * holds the frame's cadence.
   *
   * @param spentMsec - The time the frame just run has taken.
   */
  waitMsec(spentMsec: number): number {
    return nextFrameWait(this.program.host.frameMsec, this.program.residualMsec, spentMsec);
  }

  /**
   * `Sys_ConsoleInput` → `Com_QueueEvent(SE_CONSOLE)` → `Cmd_ExecuteString`: one console line,
   * run through the same router a page's console uses.
   */
  consoleLine(line: string): void {
    const argv = tokenize(line);
    if (argv.length > 0) this.router.execute(argv);
  }

  /**
   * One frame of `Com_Frame`'s server half, on the loop's clock: the real time that passed, the
   * clamp, the server's frame, the net's flush and the console's `wait`s.
   *
   * @param msec - The real time since the last frame, in milliseconds and any fraction of one.
   */
  frame(msec: number): void {
    this.guarded(() => this.comFrame(msec));
  }

  /**
   * A turn of the program's in `Com_Frame`'s `setjmp( abortframe )` (`common.c:3097–3099`):
   * whatever throws is `Com_Error`'s. So is a map that failed to read or to spawn: it did so
   * between turns, where Q3's blocking load fails inside a frame, and is the next turn's error.
   */
  private guarded(turn: () => void): void {
    let failure = this.program.failure;
    if (failure === null) {
      try {
        turn();
      } catch (err) {
        failure = asError(err);
        this.options.onError?.(failure);
      }
    }
    if (failure !== null) this.error(failure.message);
  }

  private comFrame(msec: number): void {
    // `Com_ModifyMsec` (`common.c:3038–3046`): a dedicated server reports the hitch and clamps at
    // 5000, not at the 200 a listen server clamps at. The report names the time as it came in.
    if (this.program.svRunning && msec > HITCH_WARN_MSEC) {
      this.printLine(`Hitch warning: ${Math.floor(msec)} msec frame time\n`);
    }
    this.program.runFrame(Math.min(msec, MAX_DEDICATED_FRAME_MSEC));
    // A program that drives its own frames flushes its own queue, once its frame is done — the
    // same order a worker's loop keeps.
    this.program.flushPackets();
    // `Com_Frame`'s turn at the command buffer, after the server's frame: a `wait` counts this one.
    this.router.frame();
    this.network?.frame();
  }

  /**
   * `Com_Error` (`common.c:266–365`) with no client half: `ERR_DROP`'s banner, and the server
   * shut down with the error as its reason, telling its clients nothing; then a server with no map,
   * whose console waits for the next. The fourth error in a row each under 100 ms after the last
   * is `ERR_FATAL`: the server goes as fatally crashed, and the process with it. An error thrown
   * while one is handled is `Com_Error`'s recursive one, which goes straight to `Sys_Error`.
   */
  private error(message: string): void {
    const now = this.now();
    let fatal = false;
    if (now - this.lastErrorTime < ERROR_STREAM_MSEC) {
      if (++this.errorCount > ERROR_STREAM_COUNT) fatal = true;
    } else {
      this.errorCount = 0;
    }
    this.lastErrorTime = now;

    try {
      if (fatal) {
        this.program.shutdown(`Server fatal crashed: ${message}`, true);
        this.sysError(message);
        return;
      }
      this.printLine(`********************\nERROR: ${message}\n********************\n`);
      this.program.shutdown(`Server crashed: ${message}`, true);
      this.program = this.build();
    } catch (err) {
      this.options.onError?.(asError(err));
      this.sysError(`recursive error after: ${message}`);
    }
  }

  /**
   * `Sys_Error` (`sys_main.c:452–464`), without the crash log Q3 writes: the message, and the
   * process goes with `Sys_Exit`'s code 3.
   */
  private sysError(message: string): void {
    this.printLine(`${message}\n`);
    this.close();
    this.exitCode = SYS_ERROR_EXIT_CODE;
  }

  /**
   * `SV_Shutdown`: the clients and the masters are told why, and the server stops; then the
   * network goes, as the process is about to.
   *
   * @param finalMessage - Why, in Quake 3's words for whatever stopped it.
   */
  stop(finalMessage: string): void {
    this.program.shutdown(finalMessage);
    this.close();
  }

  /** The network let go, its socket waking nothing after, and the process's cue to go given. */
  private close(): void {
    if (this.network?.socket) this.network.socket.onArrival = null;
    this.network?.close();
    this.network = null;
    this.stopped = true;
  }
}

/** What a `catch` caught, as an `Error`. */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The boot and the server: Q3's init half and then its first commands.
 *
 * `+set` and `+seta` are the command line's cvars, applied before anything reads one, as
 * `Com_StartupVariable` applies them (`common.c:1710–1745`); the server is built with no map; and
 * every other `+` command then runs in order, as `CL_AddCommandsFromArgv` queues them — `+map`
 * among them, which is what spawns the first world on the server's first frame.
 *
 * A dedicated build registers `dedicated` at 1, where a page's defaults to 0
 * (`common.c:2737–2741`); a `+set dedicated` on the command line still wins, because it runs
 * after. From then on it is write protected, as ioq3ded registers it `CVAR_INIT`.
 *
 * The network opens last, once the command line's cfgs have run, so that a `net_port` or
 * `sv_runMaster` one of them sets is the one it opens with. Quake 3 opens it before those run, so
 * only a `+set` reaches its first bind.
 */
export async function startDedicatedServer(
  options: DedicatedServerOptions
): Promise<DedicatedServer> {
  const { cvars } = options.config;
  if (cvars.get('dedicated') === '0') cvars.load('dedicated', '1');

  const commands = commandsFromArgv(options.argv ?? []);
  for (const command of commands) {
    if (isStartupSet(command[0])) options.config.command(command);
  }
  cvars.writeProtect('dedicated');
  const botFiles = await readInfoFiles(options.fs, BOTS_FILE, '.bot', BOT_LIST);
  const server = new DedicatedServer(options, botFiles);
  for (const command of commands) {
    if (!isStartupSet(command[0])) server.router.execute(command);
  }
  await server.router.settled();
  server.open((await options.network?.(cvars)) ?? null);
  return server;
}

/**
 * Q3's `CL_AddCommandsFromArgv` (`cl_main.c:3345–3403`): each `+word` starts a command, and the
 * words behind it — up to the next `+` — are its arguments. Everything else on the line, the
 * `-flags` among them, belongs to nothing here.
 */
export function commandsFromArgv(argv: readonly string[]): string[][] {
  const commands: string[][] = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('+')) continue;
    const command = [argv[i].slice(1)];
    while (i + 1 < argv.length && !argv[i + 1].startsWith('+')) command.push(argv[++i]);
    commands.push(command);
  }
  return commands;
}

/** `Com_StartupVariable`'s pair (`common.c:1710–1745`): the command line's cvars, set at init. */
function isStartupSet(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'set' || lower === 'seta';
}
