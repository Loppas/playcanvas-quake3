import { Game } from '../sim/game';
import { Net, type DatagramSocket } from '../net/net';
import type { CvarStore } from '../net/cvar';
import type { LoopbackLike } from '../net/loopback';
import type { InfoFile } from '../formats/arena';
import { Host, type HostMap } from './host';

/**
 * The server's half of Quake 3 as its own program: the cvar store, the `Net`, the `Host` and the
 * game module it runs, and the map source `map <n>` reads from.
 *
 * It is `Com_Frame`'s server half and nothing else — no client and no page. A listen server's runs
 * in a worker, a Node dedicated server's in its own process, and what drives it is a
 * timer: {@link runFrame} with the real time that passed. The client's half reaches it over a
 * `HostChannel` (`server/channel.ts`).
 */

/**
 * The longest frame a listen server runs (`Com_ModifyMsec`, `common.c:3045–3054`).
 *
 * A tab left in the background hands back an arbitrarily large delta on return, and running all
 * of it would both stall the frame and carry the player through a minute of held input. Q3 drops
 * the excess: time is lost, not owed. A dedicated server's clamp is 5000, not 200.
 */
export const MAX_FRAME_MSEC = 200;

/**
 * The longest frame a dedicated server runs (`Com_ModifyMsec`, `common.c:3038–3046`): four
 * seconds more than a listen server's, because a stalled server's clients would rather it caught
 * up than that its clock went backwards. Over 500 ms Q3 prints a hitch warning first
 * ({@link DedicatedServer} does the same).
 */
export const MAX_DEDICATED_FRAME_MSEC = 5000;

/**
 * How long a loop waits for the next whole frame, `SV_FrameMsec`'s wait (`sv_main.c:1026–1045`):
 * one frame's length less the time already accrued on the `Host`'s accumulator and the time spent
 * running the frame just done. Never negative, so a frame that ran late waits not at all.
 *
 * @param frameMsec - The server's frame length.
 * @param residualMsec - What the frame just run left on the `Host`'s accumulator.
 * @param spentMsec - The time the frame just run took.
 */
export function nextFrameWait(
  frameMsec: number,
  residualMsec: number,
  spentMsec: number
): number {
  return Math.max(0, frameMsec - residualMsec - spentMsec);
}

/**
 * Where the program finds maps and reads them, for `map <n>`. In Q3 the server's load
 * blocks the whole program; here it is a promise, and the program waits on it.
 */
export interface ServerMaps {
  /**
   * Whether a map's splat or its BSP is on the search path: `SV_Map_f`'s check, made before
   * anything.
   */
  exists(name: string): boolean;
  /**
   * Free the map being played and read another, resolving with it once it is in. A rejection is
   * Q3's `ERR_DROP` from inside the load, which stops the server ({@link ServerProgram.failure}).
   */
  load(name: string): Promise<HostMap>;
}

export interface ServerProgramOptions {
  /**
   * Where the cvars live.
   *
   * One store for the host, the game module and whatever console is driving them, because that is
   * what a cvar is: the one thing in Quake 3 that all three write and all three read.
   */
  cvars: CvarStore;
  /**
   * The first map, loaded: its entity text, which says where a player spawns and where the
   * intermission is watched from, and its collision, which the host answers `trap_Trace` out of.
   * A map without a spawn spot does not start.
   *
   * A program given none boots with no world — a dedicated server, which starts on whatever
   * `map` its console is given — and `sv_running` stays 0 until one is spawned.
   */
  map?: HostMap;
  /**
   * Where `map <n>` finds other maps. A program given none can load only the first again, from
   * what it was handed, as a latched cvar's reload does.
   */
  maps?: ServerMaps;
  /** The bot files, already read, which `addbot` finds its bots in. */
  botFiles?: readonly InfoFile[];
  /** `random()`, for a caller that wants the spawn choice pinned. */
  random?: () => number;
  /**
   * `DEBUG_MODE`, which a test can turn off: with it on, the host's `sv_cheats` is 1 whatever the
   * map command. The build's constant unless given.
   */
  debugMode?: boolean;
  /** `Sys_Milliseconds`: the clock the net's own timing reads. */
  now?: () => number;
  /**
   * The way to this program's client, where it is not a shared memory: a worker's
   * {@link LoopbackLike}. A program with none talks over its own two queues.
   */
  loopback?: LoopbackLike;
  /**
   * The socket to everyone but the loopback, for a program that has one from its start. One with
   * none talks over its loopback alone until a socket is put on its `Net`, as a dedicated server's
   * is once its command line has run.
   */
  socket?: DatagramSocket | null;
  /** `Com_Printf`: where the server's console lines go. */
  print?: (text: string) => void;
  /**
   * Whether this is a dedicated server, with no player of its own beside it. Quake 3 holds a
   * client to a command a second only then (`sv_client.c:1634`).
   */
  dedicated?: boolean;
}

export class ServerProgram {
  /** The server: its slots, its snapshots and its frame. */
  readonly host: Host;
  /** The match it runs. It belongs to the host, and is here for whoever asks the server's state. */
  readonly game: Game;

  /** The map being read, or null. No frame runs until it is in. */
  mapLoad: Promise<void> | null = null;
  /**
   * What stopped the server here, as Q3's `ERR_DROP` does: a map that failed to load or to spawn,
   * or a frame that threw.
   */
  failure: Error | null = null;

  /**
   * What a map load calls as it starts: `SV_SpawnServer`'s `CL_MapLoading`, which tells the client
   * its world is going away. A worker's program has no client to tell, and the page's learns it
   * over the channel instead.
   */
  onMapLoad: (() => void) | null = null;

  private readonly cvars: CvarStore;

  /** @param options - The cvars, the map's collision and entities, and who is playing. */
  constructor(options: ServerProgramOptions) {
    const { cvars } = options;
    this.cvars = cvars;

    let game: Game | null = null;
    const { maps } = options;
    this.host = new Host({
      cvars,
      debugMode: options.debugMode,
      dedicated: options.dedicated,
      print: options.print,
      // The frames are the port's clock: `Com_Frame`'s msec carries real time, so what the
      // net's own timing reads — a packet's delay, a client's rate — is the program's realtime
      // rather than a second clock beside it.
      net: new Net({
        cvars,
        print: options.print,
        now: options.now,
        loopback: options.loopback,
        socket: options.socket
      }),
      maps: maps && {
        exists: (name) => maps.exists(name),
        load: (name, killBots, cheat) => this.load(maps, name, killBots, cheat)
      },
      game: (host) => {
        game = new Game({
          traps: host,
          cvars,
          random: options.random,
          botFiles: options.botFiles
        });
        return game;
      }
    });
    if (!game) throw new Error('server: the host built no game module');
    this.game = game;

    if (options.map) this.host.spawnServer(options.map);
  }

  /**
   * `Com_EventLoop`, for the server: the socket's packets, then the loopback's. The client's half
   * reads its own end of the wire; this is everything addressed to the server.
   *
   * They reach the server only while it runs (`common.c:2210–2213`, `net_ip.c:1645–1648`). Quake 3
   * hands the rest to its client; a server's program has none, so a server with no map is silent.
   */
  readPackets(): void {
    const { net } = this.host;
    this.readArrivals();
    for (let packet; (packet = net.getLoopPacket('server')) !== null; ) {
      if (this.svRunning) this.host.packetEvent(packet.from, packet.data);
    }
  }

  /**
   * `NET_Sleep`'s wake between frames (`common.c:3147–3165`, `net_ip.c:1626–1653`): the socket read
   * as a datagram lands, and each packet handled then. A `getinfo` is answered within the wire's
   * time of its question, and a player's moves run as they land, so unlagged's `frameOffset` is
   * when each came after the frame. The loopback waits for the frame, as Quake 3's does.
   */
  readArrivals(): void {
    const { net } = this.host;
    for (let packet; (packet = net.getPacket()) !== null; ) {
      if (this.svRunning) this.host.packetEvent(packet.from, packet.data);
    }
  }

  /**
   * One frame of the server's half of `Com_Frame`: what the wire brought, and then the server's
   * frame. The client's half runs where the client does and sends its own packets; the flush of
   * what the server sent waits until the client has read it, as `Com_Frame`'s does.
   *
   * @param msec - The real time since the last frame, in milliseconds and any fraction of one.
   */
  runFrame(msec: number): void {
    this.readPackets();
    this.host.runFrame(msec);
  }

  /**
   * `NET_FlushPacketQueue` for the server's half: what a delay held goes out when its time comes.
   * An in-process client flushes the shared queue after it has read it; a program that drives its
   * own frames — a worker's, a dedicated server's — flushes here, once its frame is done.
   */
  flushPackets(): void {
    this.host.net.flushPacketQueue();
  }

  /**
   * `Cbuf` on the server's machine: a host command from the console, run at the top of the
   * server's next frame. A worker's arrives over its channel; a Node server's from stdin.
   *
   * @param text - The command as the console's line, as a bind or the menu runs one.
   */
  sendConsoleCommand(text: string): void {
    this.host.sendConsoleCommand(text);
  }

  /** Whether the host has commands it has not run yet, which a `map` waits behind. */
  get commandsPending(): boolean {
    return this.host.commandsPending;
  }

  /** How long the frame just run left on the `Host`'s accumulator, less than one frame. */
  get residualMsec(): number {
    return this.host.residualMsec;
  }

  /** `sv_paused`: whether the server is holding its world. */
  get svPaused(): boolean {
    return (Number.parseInt(this.cvars.get('sv_paused'), 10) || 0) !== 0;
  }

  /** `sv_running`: whether a map is running. */
  get svRunning(): boolean {
    return (Number.parseInt(this.cvars.get('sv_running'), 10) || 0) !== 0;
  }

  /**
   * `SV_Shutdown` (`sv_init.c:742–777`): the clients and the masters are told, and the server
   * stops ({@link Host.shutdown}).
   *
   * @param finalMessage - Why, in Quake 3's words for whatever stopped it.
   * @param error - Whether `Com_Error` is shutting it down, which tells the clients nothing.
   */
  shutdown(finalMessage: string, error = false): void {
    this.host.shutdown(finalMessage, error);
  }

  /**
   * Read a map the host asked for, and hand it back once it is in. The host spawns it, and the
   * client's next frames give the client its gamestate. A spawn that fails is the load's failure,
   * as it is inside Q3's `SV_SpawnServer`.
   *
   * The client goes back to waiting for a gamestate as the load starts, which is where
   * `SV_SpawnServer` calls `CL_MapLoading`.
   */
  private load(
    maps: ServerMaps,
    name: string,
    killBots = false,
    cheat: boolean | null = false
  ): void {
    this.onMapLoad?.();
    this.mapLoad = maps
      .load(name)
      .then((map) => this.host.spawnServer(map, killBots, cheat))
      .then(
        () => {
          this.mapLoad = null;
        },
        (err: unknown) => {
          this.failure = err instanceof Error ? err : new Error(String(err));
        }
      );
  }
}
