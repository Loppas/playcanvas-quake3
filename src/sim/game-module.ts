import type { NetUserCmd, PlayerState } from '../net/protocol';
import type { GameEntity } from './game-entity';
import type { PointContentsFn, TraceFn, TraceResult } from './types';
import type { Vec3 } from './vec3';

/**
 * The seam between the host and the game module: `gameExport_t` and `gameImport_t`
 * (`g_public.h:398–510`).
 *
 * Quake 3 calls the game module through a virtual machine, so the two sides can only pass numbers
 * and the boundary is exact. The port has no virtual machine, but keeping the same boundary is
 * what makes the host testable without a game and the game testable without a host.
 *
 * Both halves are declared here, on the game's side, because that is where `g_public.h` is: the
 * game publishes what it exports and what it needs, and the host implements the second and calls
 * the first. Nothing here reaches back into `src/server/`.
 */

/** `gameExport_t` (`g_public.h:398–425`): what the host calls. */
export interface GameModule {
  /** `GAME_INIT`: a map has loaded. `restart` is true for a `map_restart` rather than a new map. */
  init(levelTime: number, randomSeed: number, restart: boolean): void;
  /** `GAME_SHUTDOWN`. */
  shutdown(restart: boolean): void;
  /**
   * `GAME_CLIENT_CONNECT`: a slot has been taken. Returning a string refuses the connection and
   * the string is the reason.
   */
  clientConnect(clientNum: number, firstTime: boolean, isBot: boolean): string | null;
  /** `GAME_CLIENT_BEGIN`: the client is in the world and wants a body. */
  clientBegin(clientNum: number): void;
  /** `GAME_CLIENT_USERINFO_CHANGED`: the client's name, model or settings have changed. */
  clientUserinfoChanged(clientNum: number): void;
  /** `GAME_CLIENT_DISCONNECT`. */
  clientDisconnect(clientNum: number): void;
  /**
   * `GAME_CLIENT_COMMAND`: a reliable command from the client.
   *
   * Quake 3 passes only the slot and the game module reads the arguments back through
   * `trap_Argv`, because a virtual machine cannot be handed a string. The port passes the
   * arguments themselves, as the host tokenized and cleaned them.
   */
  clientCommand(clientNum: number, argv: readonly string[]): void;
  /**
   * `GAME_CLIENT_THINK`: run this client's pending user command.
   *
   * The command itself is not passed. The game module asks for it with
   * {@link GameTraps.getUserCmd}, which is Quake 3's `trap_GetUsercmd`.
   */
  clientThink(clientNum: number): void;
  /** `GAME_RUN_FRAME`: advance the match to this time. */
  runFrame(levelTime: number): void;
  /** `GAME_CONSOLE_COMMAND`: true if the game module recognised the command. */
  consoleCommand(command: string): boolean;
  /**
   * `BOTAI_START_FRAME`: the bots' frame, which the host runs before the game's own, at the time
   * the game's frames are about to reach.
   */
  botAIStartFrame(time: number): void;

  /**
   * `SV_LocateGameData` (`sv_game.c:196–210`), as three questions rather than three pointers.
   *
   * Quake 3 hands the host raw pointers into the game module's arrays, because both live in one
   * address space. What the host actually does with them is read an entity by number, ask how many
   * there are, and read a client's player state — so that is what the port asks for.
   */
  entity(number: number): GameEntity;
  numEntities(): number;
  playerState(clientNum: number): PlayerState;

  /**
   * The board as the `scores` command carries it, which a server's `getstatus` answer includes.
   * An export of the port's own: Quake 3's server cannot see the ranks the board is sorted by.
   */
  scoreboardMessage(): string;
}

/**
 * `gameImport_t` (`g_public.h:429–510`), reduced to the traps the game module actually calls.
 *
 * The host satisfies this by having the methods; nothing declares that it does. That is the one
 * thing the port gains over Quake 3's numbered trap calls, and it costs nothing in fidelity,
 * because the set of calls is still exactly this list.
 */
export interface GameTraps {
  /** `trap_SetConfigstring`. */
  setConfigstring(index: number, value: string): void;
  /** `trap_GetConfigstring`. */
  getConfigstring(index: number): string;
  /** `trap_SendServerCommand`; `null` for every client, which is Quake 3's −1. */
  sendServerCommand(clientNum: number | null, text: string): void;
  /** `trap_SendConsoleCommand`: a command for the host itself to run, not for any client. */
  sendConsoleCommand(text: string): void;
  /** `trap_GetUserinfo`. */
  getUserinfo(clientNum: number): string;
  /** `trap_SetUserinfo`. */
  setUserinfo(clientNum: number, userinfo: string): void;
  /** `trap_GetUsercmd`. */
  getUserCmd(clientNum: number): NetUserCmd;
  /** `trap_DropClient`. */
  dropClient(clientNum: number, reason: string): void;
  /**
   * `trap_Trace`: sweep a box through the world and its entities, and say what it hit.
   *
   * The game module has no map of its own and never opens one — this is the only way it learns
   * that anything is in the way, and the host answers it from whatever collision the map came
   * with and from the boxes of the entities it has linked. See {@link TraceFn} for the pass entity
   * and the mask.
   */
  trace(
    start: Vec3,
    mins: Vec3,
    maxs: Vec3,
    end: Vec3,
    passEntityNum: number,
    contentmask: number
  ): TraceResult;
  /**
   * `trap_PointContents`: what a point is inside, the map's contents OR'd with those of every
   * entity there but the pass entity. See {@link PointContentsFn}.
   */
  pointContents(point: Vec3, passEntityNum: number): number;
  /**
   * `trap_SetBrushModel`: make an entity the map's inline model `*N`, which its `model` key names,
   * with the model's bounds, and link it. The map's collision is the host's, so this is how a
   * trigger learns its shape.
   */
  setBrushModel(entity: GameEntity, name: string | null): void;
  /**
   * `trap_EntityContact`: whether a box in the world is in an entity at all — a brush model by its
   * brushes, anything else by its bounds.
   */
  entityContact(mins: Vec3, maxs: Vec3, entity: GameEntity): boolean;
  /** `trap_LinkEntity`. */
  linkEntity(entity: GameEntity): void;
  /** `trap_UnlinkEntity`. */
  unlinkEntity(entity: GameEntity): void;
  /**
   * `trap_AdjustAreaPortalState`: open or close the areaportal a door stands in, as the areas the
   * world last linked it in say.
   */
  adjustAreaPortalState(entity: GameEntity, open: boolean): void;
  /**
   * `trap_InPVS`: whether `p2` is in a cluster `p1`'s can see, in an area no shut door parts from
   * `p1`'s.
   */
  inPVS(p1: Vec3, p2: Vec3): boolean;
  /**
   * `trap_EntitiesInBox`: the number of every linked entity whose box touches this one.
   *
   * Quake 3 fills a caller's array up to a count, and both of its callers pass one as big as the
   * entity pool; the port hands the list back instead.
   */
  entitiesInBox(mins: Vec3, maxs: Vec3): number[];
  /**
   * `trap_GetEntityToken`: the next token of the map's entity text, or `null` once it has run out.
   *
   * The game module never opens the map. It reads the text the host hands over, which the host
   * starts again at every `GAME_INIT`, so a `map_restart` spawns the map's entities afresh.
   */
  getEntityToken(): string | null;
  /** `trap_Print`: a line for the console, which is where `G_Printf` goes. */
  print(text: string): void;
  /**
   * `trap_Milliseconds`: the real time, in whole milliseconds, which the game's frames are not.
   * Unlagged times a command from the end of the last frame by it.
   */
  milliseconds(): number;
  /** `trap_BotAllocateClient`: a free slot for a bot, already playing, or −1 if there is none. */
  botAllocateClient(): number;
  /** `trap_BotFreeClient`: give back a bot's slot. */
  botFreeClient(clientNum: number): void;
  /** `trap_BotUserCommand`: a bot's command, run as if it had come from a connection. */
  botUserCommand(clientNum: number, cmd: NetUserCmd): void;
  /**
   * `trap_BotGetServerCommand`: the next server command a bot has been sent, taken as read, or
   * `null` once there are none. A bot has no connection to acknowledge them over.
   */
  botGetServerCommand(clientNum: number): string | null;
}
