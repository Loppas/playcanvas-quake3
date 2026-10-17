import type { InfoFile } from '../formats/arena';
import type { NetAdr } from '../net/net';
import type { DataChannelLike } from '../net/peer-socket';
import type { Vec3 } from '../sim/vec3';
import type { HostMapData } from './host-map';

/**
 * What crosses between the page and its server program when the program runs in a worker: the
 * wire's packets, the side channels, the page's store and its files.
 *
 * The two halves are one Q3 program split in two, so what crosses is what a `trap_` would have
 * reached across in-process: `Cbuf`'s lines, the pause, `sv_running`, the map asks and the
 * console's words back.
 */

/**
 * What a live check asks of the worker's program: the state only the worker has — the host's
 * clock, its map, `sv_paused` where the server reads it — or a debug mutation a recipe wants.
 *
 * DEV only: the page's route to it is a DEV handle, and the worker answers only a DEV build, so a
 * built page carries neither end.
 */
export type DevRequest =
  /** The server's own state, which the page holds only as the channel's mirrors. */
  | { op: 'state' }
  /** `Cvar_Set` in the worker's store, where the server reads it — a recipe moving `sv_running`. */
  | { op: 'cvar'; name: string; value: string }
  /**
   * A client put at `origin`, facing `angles` in degrees, standing still, as a recipe has no
   * `setviewpos` to put one there: see `placePlayer`.
   */
  | { op: 'place'; client: number; origin: Vec3; angles: Vec3 };

/** The server's state as a live check reads it. */
export interface DevState {
  /** `sv.time`: the server's clock, which advances while the page's own frames do not. */
  hostTime: number;
  /** The map the server is playing, or null. */
  map: string | null;
  /** The entity text's length, as the page read it for the worker. */
  entities: number;
  /** `sv_paused` and `sv_running` as the worker's own store holds them. */
  svPaused: boolean;
  svRunning: boolean;
  /** Whether the server has commands it has not run yet. */
  commandsPending: boolean;
  /** The server's slots. */
  clients: number;
}

/** What the page tells the worker. */
export type PageToWorker =
  | {
      /** The program's start: its map, its store's values, its listing and its bot files. */
      type: 'boot';
      cvars: readonly { name: string; value: string }[];
      map: HostMapData;
      /** Every map the page's search path has, as `map <n>` takes them. */
      mapNames: readonly string[];
      botFiles: readonly InfoFile[];
      debugMode: boolean;
    }
  /** A packet from the client's end of the wire. */
  | { type: 'packet'; data: Uint8Array }
  /** A console line for the server's `Cbuf`, where a bind or the menu runs one. */
  | { type: 'command'; line: string }
  /**
   * A cvar of the page's store, which the worker's store takes the change of and does not
   * send back.
   */
  | { type: 'cvar'; name: string; value: string }
  /** A map the worker asked for, read. Its bytes are moved, not copied. */
  | { type: 'map'; id: number; data: HostMapData }
  /** A map the worker asked for that could not be read; the message is the load's failure. */
  | { type: 'mapFailed'; id: number; message: string }
  /**
   * `SV_Shutdown`, and why: the program stops and the worker lets its scope go. Inside `Com_Error`
   * the clients are told nothing.
   */
  | { type: 'shutdown'; finalMessage: string; error: boolean }
  /**
   * A peer's data channel, made on the page and moved here in the task that made it, numbered so
   * that its hang-up can name it.
   */
  | { type: 'channel'; id: number; peer: NetAdr; channel: DataChannelLike }
  /** A datagram that came through a master rather than down a channel. */
  | { type: 'deliver'; from: NetAdr; data: Uint8Array }
  /** A live check's ask (DEV only), answered with `devResult`. */
  | { type: 'dev'; id: number; request: DevRequest };

/** What the worker tells the page. */
export type WorkerToPage =
  /** A packet from the server's end of the wire. */
  | { type: 'packet'; data: Uint8Array }
  /** The server's state, when one of these moved: they were the one store's. */
  | { type: 'state'; svPaused: boolean; svRunning: boolean; commandsPending: boolean }
  /** The server's map load, as it starts and as it ends. */
  | { type: 'mapLoad'; loading: boolean }
  /** A load that failed or a frame that threw, which stops the program as `ERR_DROP` does. */
  | { type: 'failure'; message: string }
  /** `Com_Printf`: the server's console lines, for the page's console. */
  | { type: 'print'; text: string }
  /**
   * A cvar the worker's store set itself, the server's or the game's write, which the page's store
   * holds as it is held here and does not send back.
   */
  | { type: 'cvar'; name: string; value: string }
  /** `map <n>`, which the page's search path answers with `map` or `mapFailed`. */
  | { type: 'readMap'; id: number; name: string }
  /** The state a live check asked for (DEV only). */
  | { type: 'devResult'; id: number; state: DevState }
  /**
   * The program is up, and whether this worker can take a data channel: where it cannot, the page
   * opens no peers, and the match is its own client's.
   */
  | { type: 'ready'; channels: boolean }
  /** A datagram for a peer with no open channel, which the page's signalling routes. */
  | { type: 'route'; data: Uint8Array; to: NetAdr }
  /** The socket has let a peer's channel go: the one the page numbered so. */
  | { type: 'hangUp'; id: number; peer: NetAdr }
  /** The program has shut down and said its last: the page may close what carried it. */
  | { type: 'closed' };
