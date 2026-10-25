import { angleToShort } from './sim/client';
import { PMOVE_MSEC } from './sim/constants';
import { SNAPFLAG, CONFIGSTRING } from './net/commands';
import { infoSetValueForKey, infoValueForKey } from './net/info';
import type { CvarStore } from './net/cvar';
import type { UserCmdRing } from './net/client-clock';
import { CA, ClientConnection } from './net/connection';
import type { NetAdr } from './net/net';
import {
  createNetUserCmd,
  wireDrawnTime,
  type NetUserCmd,
  type PlayerState
} from './net/protocol';
import { frameMsec, snapshotGap, snapshotMsec } from './net/snapshot-rate';
import type { Host, HostMap } from './server/host';
import type { InfoFile } from './formats/arena';
import { InProcessHost, type HostChannel } from './server/channel';
import { MAX_FRAME_MSEC, type ServerMaps, type ServerProgram } from './server/program';
import { Game, grappleMode } from './sim/game';
import type { SysteminfoRules } from './sim/rules';
import { createUserCmd, type TraceFn, type UserCmd } from './sim/types';
import type { GrappleMode } from './sim/weapons/grapple';
import type { SourceSnapshot } from './view/player-view';

/**
 * The client of Quake 3 in one page: the one client that shares the process with its server, and
 * a channel to the server's program — in this process, or in a worker's. A server elsewhere
 * is reached through the page's own socket instead, with no program in the page.
 *
 * Quake 3 is always a server with clients attached, and a single-player game is that arrangement
 * with one of them in the same process. Nothing here shortcuts it: the client builds a user
 * command and sends it as packets down the loopback, the host reads it, thinks for the client, runs
 * its frame and encodes a snapshot, and the client decodes that snapshot to learn what happened.
 * What the player sees is what the wire carried, which is the whole point of keeping the seam.
 *
 * It owns the *client*, not the program: what the world is doing is the game module's, what is
 * drawn is the client's, and where the server runs is the channel's.
 */

/**
 * How many extra frames one {@link LocalGame.frame} will run to get back into a world that has
 * just been loaded: one to be given the gamestate, and one to enter the world with.
 */
const LOAD_FRAMES = 2;

/**
 * The most ticks the boot sends commands for while its gamestate comes in: enough for the largest,
 * `MAX_MSGLEN` in fragments, at a LAN client's rate.
 */
const BOOT_TICKS = 16;

/**
 * The longest frame a client whose server is elsewhere runs, `Com_ModifyMsec`'s
 * (`qcommon/common.c:3039–3044`). Q3 clamps a client of a remote server at 5000 ms — every match's
 * server here is a worker or remote — and clamps both halves alike at 200 only with the server in
 * the same frame ({@link MAX_FRAME_MSEC}). The excess is dropped: time lost, not owed. A frame
 * still makes at most `MAX_FRAME_COMMAND_MSEC` of commands, and the server's own frame stays 200.
 */
export const MAX_REMOTE_FRAME_MSEC = 5000;

/** A frame the view drew: its time, and the two snapshots it drew other players between. */
interface DrawnFrame {
  time: number;
  snapTime: number;
  nextSnapTime: number;
}

/** A map as the client loads it: the world it draws and predicts in. */
export interface ClientMap {
  /** The map's name, as the gamestate's `mapname` gave it. */
  name: string;
  /**
   * The map's collision, as the client loaded it from its own files. The view's trace is the
   * page's own handle on the same world, so this is for whoever needs the client's map itself.
   */
  trace?: TraceFn;
}

/**
 * The client's own load at each gamestate, `CL_InitCGame`'s (`cl_cgame.c:711–770`): the map its
 * `CS_SERVERINFO` names, from the client's own files wherever the server is, and what cgame
 * registers for the gamestate before its first frame (`CG_Init`). It runs for every gamestate, a
 * new map's or not, since each starts cgame over.
 */
export interface ClientLoader {
  /**
   * Load for a gamestate naming this map, keeping the world in hand when it is that map. A
   * rejection is `ERR_DROP`'s, and stops the game.
   */
  load(name: string): Promise<ClientMap>;
}

export interface LocalGameOptions {
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
   * A game given a {@link channel} to a program that is not here has none: the server's map is
   * the server's own to read.
   */
  map?: HostMap;
  /**
   * Where `map <n>` finds other maps, which is the server's own to read. A program given
   * none can load only the first again, from what it was handed, as a latched cvar's reload does.
   */
  maps?: ServerMaps;
  /**
   * The server, where it is not this process's to build: a channel to a worker's. The map,
   * the maps, the bot files and the debug mode are the channel's builder's then, and this game's
   * own options are the client's.
   */
  channel?: HostChannel;
  /**
   * The client's own load at each gamestate. A program given none has no client world to load —
   * its view traces what the page handed it.
   */
  clientLoader?: ClientLoader;
  /**
   * A server elsewhere, as `connect` named and found it, reached through the {@link channel}'s way
   * out: the page's own socket. Without one the client connects to the server in this page.
   */
  connect?: { server: string; address: NetAdr };
  /** The client's own settings, as a Quake 3 info string: its name, its model, its handicap. */
  userinfo?: string;
  /** `random()`, for a caller that wants the spawn choice pinned. */
  random?: () => number;
  /** The bot files, already read, which `addbot` finds its bots in. */
  botFiles?: readonly InfoFile[];
  /**
   * `DEBUG_MODE`, which a test can turn off: with it on, the host's `sv_cheats` is 1 whatever the
   * map command. The build's constant unless given.
   */
  debugMode?: boolean;
}

export class LocalGame {
  /**
   * The server's half: the program itself where it runs in this process, or the way to the
   * worker's where it does not.
   */
  readonly channel: HostChannel;
  /** The client's end of the wire: what it has been told, and what it has told the host. */
  readonly connection: ClientConnection;
  /** Whether the server is elsewhere, and none runs in this page. */
  readonly remote: boolean;

  /**
   * Server commands the client has been sent and nobody has acted on yet, each with its sequence
   * number, which is how a snapshot says which of them come before it.
   */
  private readonly serverCommands: { sequence: number; text: string }[] = [];
  /** The gamestate those commands came after: a new one leaves the old world's unread. */
  private commandsGamestate = 0;

  /** The one cvar store. */
  private readonly cvars: CvarStore;
  /** The frame the view drew last, which the commands made next carry: none before the first. */
  private drawnFrame: DrawnFrame = { time: 0, snapTime: 0, nextSnapTime: 0 };

  /** The client's own load that failed, or its spawn; the server's is the channel's. */
  private clientFailure: Error | null = null;

  /** The client's own world, as `CL_InitCGame` loaded the gamestate's name. */
  clientMap: ClientMap | null = null;
  /** The client's load in flight, or null. Its frames wait for it, as `CA_LOADING` holds Q3's. */
  clientLoad: Promise<void> | null = null;
  /** The client's own load at each gamestate, where it was given one. */
  private readonly clientLoader?: ClientLoader;

  /** @param options - The cvars, the map's collision and entities, and who is playing. */
  constructor(options: LocalGameOptions) {
    const { cvars, connect } = options;
    this.remote = connect !== undefined;
    // The client's own `snaps` is a setting like any other, defaulting to a snapshot
    // every server frame at the port's `sv_fps`; a player's own value stands, and the server holds
    // it to `sv_fps` where it reads it.
    this.cvars = cvars;
    // The client's timeout exemption reads `sv_paused` from the channel: the store's where the
    // server is this process's, the worker's word where it is not.
    this.connection = new ClientConnection(cvars, {
      serverPaused: () => this.channel.svPaused
    });
    this.clientLoader = options.clientLoader;

    if (options.channel) {
      this.channel = options.channel;
    } else {
      if (!options.map) throw new Error('local-game: no map and no channel to a server');
      this.channel = new InProcessHost({
        cvars,
        map: options.map,
        maps: options.maps,
        botFiles: options.botFiles,
        random: options.random,
        debugMode: options.debugMode,
        // The frames are the port's clock: `Com_Frame`'s msec carries real time, so what
        // the net's own timing reads — a packet's delay, a client's rate — is the program's
        // realtime rather than a second clock beside it.
        now: () => this.connection.clock.realtime
      });
    }
    this.channel.onMapLoad(() => this.connection.mapLoading(this.channel.net));
    this.connection.userinfo = this.withClientCvars(options.userinfo ?? '');
    // A server elsewhere answers as the network carries it, so the handshake is the frames'.
    if (connect) {
      this.connection.connect(this.channel.net, connect.server, connect.address);
      return;
    }

    // `CL_MapLoading`: the client connects to the server, which answers at once. The `connect`
    // brings the `connectResponse`, and the first packet the gamestate. A latency knob set this
    // early holds them back, and the frames finish the job.
    this.connection.mapLoading(this.channel.net);
    this.channel.readPackets();
    this.receive();
    this.connection.sendCmd(createNetUserCmd());
    this.channel.readPackets();
    this.receive();

    // "If this is the first usercmd we have received this gamestate, put the client into the
    // world" (`sv_client.c:1050–1055`). A client that has the gamestate is still only primed, and
    // what puts it in is a command; Quake 3's keeps sending them until a snapshot comes back, and
    // so does this one while its gamestate's fragments come in at its rate. Their zeroed angles
    // are what `ClientSpawn` sets the delta angles against, so the player is looking the spawn's
    // way when the first real command arrives. A handshake a latency knob holds back is left to
    // the frames.
    this.tick(createUserCmd());
    for (let i = 0; i < BOOT_TICKS && !this.playing && this.connection.state >= CA.CONNECTED; i++) {
      this.tick(createUserCmd());
    }
  }

  /**
   * The host, where the program runs in this process. A channel to a worker's has none: the
   * server's state is its own, and the page reads the mirrors instead.
   */
  get host(): Host {
    return this.requireProgram().host;
  }

  /** The match, where it runs in this process. It belongs to the host. */
  get game(): Game {
    return this.requireProgram().game;
  }

  /** The map the server is reading, or null. No frame runs until it is in. */
  get mapLoad(): Promise<void> | null {
    return this.channel.mapLoad;
  }

  /**
   * What stops the game here as Q3's `ERR_DROP` does: a load that failed, or its spawn — the
   * server's own load or the client's — or a server frame that threw.
   */
  get failure(): Error | null {
    return this.channel.failure ?? this.clientFailure;
  }

  /**
   * `SV_Shutdown` (`sv_init.c:742–777`): the server's clients and masters are told why, and it
   * stops, which `sv_running` says. Then `CL_Disconnect`: the client leaves its server, wherever
   * that is.
   *
   * @param finalMessage - Why, in Quake 3's words for whatever stopped it.
   * @param error - Whether `Com_Error` is shutting it down, which tells the server's clients
   *   nothing (`sv_init.c:751`).
   */
  shutdown(finalMessage: string, error = false): void {
    this.channel.shutdown(finalMessage, error);
    this.connection.disconnect();
  }

  private requireProgram(): ServerProgram {
    const { program } = this.channel;
    if (program === null) {
      throw new Error('local-game: the server program is not in this process');
    }
    return program;
  }

  /**
   * One 8 ms frame of the program.
   *
   * @param cmd - What the player is holding this tick, with its angles in degrees.
   */
  tick(cmd: Omit<UserCmd, 'serverTime'>): void {
    this.frame(PMOVE_MSEC, cmd);
  }

  /**
   * One frame of the program, and the frames it takes to get back into a world just loaded.
   *
   * @param msec - The real time since the last frame, in milliseconds and any fraction of one.
   * @param cmd - What the player is holding, with its angles in degrees.
   */
  frame(msec: number, cmd: Omit<UserCmd, 'serverTime'>): void {
    // The host asked for a map and stopped where it stood; nothing runs until the map is in. The
    // client's own load holds its frames the same way, as `CA_LOADING` does in Q3.
    if (this.mapLoad !== null || this.clientLoad !== null || this.failure !== null) return;
    // A client whose server is elsewhere keeps real time to 5000 (`Com_ModifyMsec`); one whose
    // server runs in this frame clamps with it at 200, as Q3's listen server does. The worker's
    // own frame is clamped at 200 in its loop; an in-process server's is clamped here, through it.
    const clamp = this.channel.program === null ? MAX_REMOTE_FRAME_MSEC : MAX_FRAME_MSEC;
    this.comFrame(Math.min(msec, clamp), cmd);

    // A map load hands the client a new gamestate, and until it has sent a command against that
    // world it is not playing: the snapshots it is sent meanwhile say so, which is what
    // `SNAPFLAG_NOT_ACTIVE` is for. Quake 3's client keeps sending packets through the load and
    // shows the loading screen meanwhile; this one runs the frames it takes, which is one to be
    // given the gamestate and one to enter the world with. A frame that started the client's own
    // load has none to run until it is in. A server elsewhere keeps its own time.
    if (this.remote) return;
    for (let i = 0; i < LOAD_FRAMES && !this.playing && this.clientLoad === null; i++) {
      this.comFrame(PMOVE_MSEC, cmd);
    }
  }

  /**
   * `Com_Frame` (`common.c:3084–3262`): `msec` of real time, the client's half and then the
   * server's, wherever the server runs.
   *
   * Quake 3 runs the server first and sends the client's packet at the end, to be read the frame
   * after. Here the client goes first, so its commands reach the host in the same frame, and the
   * snapshot the host sends back is read at the end of it. A packet is read when it arrives and the
   * entities move in `G_RunFrame` afterwards, so a command runs against the world as the *last*
   * frame left it: a rocket is stamped with that frame's clock, and the frame after flies it.
   *
   * The client sets its clock before it makes this frame's commands, where Quake 3 makes them
   * first, so that the clock's newest step always has its command.
   *
   * @param msec - The real time since the last frame.
   * @param cmd - What the player is holding, with its angles in degrees.
   */
  private comFrame(msec: number, cmd: Omit<UserCmd, 'serverTime'>): void {
    // `CL_Frame` (`cl_main.c:2964–3112`).
    const { connection } = this;
    connection.clock.realtime += msec;
    connection.checkTimeout();
    // `CL_CheckPaused` (`cl_main.c:2922–2931`), read once a frame: the frame `cl_paused` changed
    // in counts as paused, and a snapshot clears that (`cl_parse.c:225–227`).
    const paused = connection.checkPaused();
    const serverPaused = this.channel.svPaused;
    // `CL_SetCGameTime` (`cl_cgame.c:971–975`): a client whose server is in this process and is
    // paused does not run its clock. A remote server's `sv_paused` is nobody's here, so its world
    // runs on under the menu, as Q3's does.
    if (!(serverPaused && paused)) connection.setCGameTime();
    // `CL_SendCmd` (`cl_input.c:910–913`): and sends nothing, which reads `cl_paused` itself.
    const clPaused = (Number.parseInt(this.cvars.get('cl_paused'), 10) || 0) !== 0;
    if (!(serverPaused && clPaused)) connection.sendCmd(netUserCmd(cmd, this.drawnFrame));

    this.channel.pump(msec);
    this.receive();
    // `CL_CheckForResend` after the frame's packets are read, as Q3 reads before it sends: a
    // connect's answer that has landed is seen before a retransmit is considered, so the first
    // frame after a stall does not resend a connect the server already answered.
    connection.checkForResend();
    this.channel.net.flushPacketQueue();
  }

  /** The slot the local client plays in, which the gamestate says: 0 while it is the only one. */
  get clientNum(): number {
    return this.connection.clientNum;
  }

  /** `cl.snap.ps`: the player state the newest snapshot carried. */
  get playerState(): PlayerState {
    return this.connection.snapshots.snap.ps;
  }

  /** `cl.serverTime`: the client's clock, which is the time cgame draws. */
  get serverTime(): number {
    return this.connection.clock.serverTime;
  }

  /** The frame the view drew last, which the next commands carry. */
  setDrawnFrame(time: number, snapTime: number, nextSnapTime: number): void {
    this.drawnFrame = { time, snapTime, nextSnapTime };
  }

  /** `cl.cmds` and `cl.cmdNumber`: the commands prediction replays (`CG_PredictPlayerState`). */
  get commands(): UserCmdRing {
    return this.connection.commands;
  }

  /** The rules the client predicts with, as `CS_SYSTEMINFO` carried them. */
  get rules(): Readonly<SysteminfoRules> {
    return this.connection.rules;
  }

  /** `pmove_msec`, as the client's commands step by it. */
  get pmoveMsec(): number {
    return this.connection.pmoveMsec;
  }

  /**
   * `g_allowGrapple`'s style, as the systeminfo carried it, or null for a client whose match has
   * no hook.
   */
  get grappleMode(): GrappleMode | null {
    return grappleMode(this.connection.rules.g_allowGrapple);
  }

  /**
   * The gap between this client's snapshots as the server sends them: its `snaps`, held to the
   * systeminfo's `sv_fps` and rounded up to whole frames, as the host holds them apart.
   */
  get snapshotGap(): number {
    const svFps = Math.max(1, this.connection.rules.sv_fps);
    return snapshotGap(snapshotMsec(this.cvars.get('snaps'), svFps), frameMsec(svFps));
  }

  /** `xp_unlagged`, as the systeminfo carried it: which weapons the server rewinds for. */
  get unlagged(): number {
    return this.connection.rules.xp_unlagged;
  }

  /** The message the last gamestate came in, where cgame's snapshot numbers start. */
  get gamestateMessageNum(): number {
    return this.connection.gamestateMessageNum;
  }

  /** `CL_GetCurrentSnapshotNumber` (`cl_cgame.c:112–115`): the newest snapshot's number. */
  currentSnapshotNumber(): number {
    return this.connection.snapshots.snap.messageNum;
  }

  /** `CL_GetCurrentSnapshotNumber`'s other answer: the newest snapshot's time. */
  get latestSnapshotTime(): number {
    return this.connection.snapshots.snap.serverTime;
  }

  /**
   * `CL_GetSnapshot` (`cl_cgame.c:122–168`): a snapshot by number, or null for one that was lost
   * or is too old. What it holds is the client's own, and is written over 32 messages on.
   */
  snapshot(number: number): SourceSnapshot | null {
    const { snapshots } = this.connection;
    const snap = snapshots.get(number);
    if (snap === null) return null;
    return {
      snapFlags: snap.snapFlags,
      ping: snap.ping,
      serverTime: snap.serverTime,
      serverCommandNum: snap.serverCommandNum,
      areamask: snap.areamask,
      ps: snap.ps,
      entities: snapshots.entities(snap)
    };
  }

  /**
   * Take the server commands the client has been sent, up to and including `upTo`, oldest first.
   *
   * A server command is what the host says in words rather than in state — `map_restart` is the
   * one that matters here — and it is reliable, so one is delivered however many snapshots are
   * lost on the way. cgame runs a snapshot's before the snapshot is made current
   * (`CG_ExecuteNewServerCommands`), which is what the bound is for.
   *
   * @param upTo - The last to take, as a snapshot's `serverCommandNum` names it; all by default.
   */
  takeServerCommands(upTo = Number.POSITIVE_INFINITY): string[] {
    const taken: string[] = [];
    while (this.serverCommands.length > 0 && this.serverCommands[0].sequence <= upTo) {
      taken.push(this.serverCommands[0].text);
      this.serverCommands.shift();
    }
    return taken;
  }

  /**
   * `CG_ConfigString`: one configstring as the client has it, which the gamestate set and every
   * `cs` since has changed.
   */
  configstring(index: number): string {
    return this.connection.configstrings[index];
  }

  /**
   * `userinfo`: tell the host what this client's own settings are now.
   *
   * It goes as a reliable command rather than being written into the slot, because the settings
   * belong to the client and the match is being told about them. `ClientUserinfoChanged` is what
   * reads them at the far end, and a handicap takes effect at once there.
   *
   * @param userinfo - The whole info string, as `Cvar_InfoString` builds one.
   */
  setUserinfo(userinfo: string): void {
    this.connection.userinfo = this.withClientCvars(userinfo);
    this.connection.addReliableCommand(`userinfo "${this.connection.userinfo}"`);
  }

  /**
   * `trap_SendClientCommand`: run a command of the client's own at the far end.
   *
   * It goes as a reliable command, as `userinfo` does, and the match runs it at the top of its
   * next frame. `score` is the first the port sends, which `Cmd_Score_f` answers with the board.
   */
  sendClientCommand(text: string): void {
    this.connection.addReliableCommand(text);
  }

  /**
   * `map_restart`: start the match over on the same map, which is what the menu's Restart does.
   *
   * It runs at the top of the host's next frame, where `Cbuf_Execute` runs it, rather than in the
   * middle of this one.
   */
  restart(): void {
    this.channel.sendCommand('map_restart 0\n');
  }

  /**
   * `Cbuf` on the server's machine: a host command from the console, run at the top of the host's
   * next frame. Whether this client has a server to put it in — a client whose server is
   * elsewhere has none, and Q3's console forwards the command to the game instead.
   *
   * @param line - The command as the console's line, as a bind or the menu runs one.
   */
  consoleCommand(line: string): boolean {
    if (this.remote) return false;
    this.channel.sendCommand(line);
    return true;
  }

  /** Whether the host has commands it has not run yet, which a `map` waits behind. */
  get commandsPending(): boolean {
    return this.channel.commandsPending;
  }

  /**
   * `CL_InitCGame` (`cl_cgame.c:711–770`), which every gamestate runs (`CL_DownloadsComplete`,
   * `cl_main.c:2137–2141`): the client's own load, for the map the gamestate names out of
   * `CS_SERVERINFO`, and its frames wait for it, as `CA_LOADING` holds Q3's. The loader keeps a
   * map already in hand: the port's world is a splat, and reloading it to restart a match is not
   * worth Q3's fidelity.
   */
  private initCGame(): void {
    const { clientLoader } = this;
    if (!clientLoader) return;
    const serverinfo = this.connection.configstrings[CONFIGSTRING.SERVERINFO];
    const name = infoValueForKey(serverinfo, 'mapname');
    if (name === '') return;
    this.clientLoad = clientLoader.load(name).then(
      (clientMap) => {
        this.clientMap = clientMap;
        this.clientLoad = null;
      },
      (err: unknown) => {
        this.clientLoad = null;
        this.clientFailure = err instanceof Error ? err : new Error(String(err));
      }
    );
  }

  /** Whether the client is in the world, rather than being sent a world to arrive in. */
  private get playing(): boolean {
    const { snap } = this.connection.snapshots;
    return snap.valid && (snap.snapFlags & SNAPFLAG.NOT_ACTIVE) === 0;
  }

  /**
   * The client's own userinfo with its rate cvars on it, as Quake 3's carries them: `snaps` and
   * `rate` belong to the client, so they are in every userinfo the client sends rather than only
   * in the first. This client asks for the host's snapshot rate; its `rate` is Q3's
   * default, and a LAN client's is left alone by the host whatever it says.
   */
  private withClientCvars(userinfo: string): string {
    const info = infoSetValueForKey(userinfo, 'snaps', this.cvars.get('snaps'));
    return infoSetValueForKey(info, 'rate', this.cvars.get('rate'));
  }

  /**
   * Read everything the host has sent, and keep the commands for whoever acts on them. A server
   * elsewhere is on the page's socket, which the match reads while it lasts.
   */
  private receive(): void {
    const { net } = this.channel;
    const { connection } = this;
    for (let packet; (packet = net.getLoopPacket('client')) !== null; ) {
      connection.packetEvent(packet.from, packet.data);
    }
    for (let packet; this.remote && (packet = net.getPacket()) !== null; ) {
      connection.packetEvent(packet.from, packet.data, packet.time);
    }
    // A gamestate starts the commands over, so what the last world sent is never acted on, and
    // starts the client's own load.
    if (connection.gamestateMessageNum !== this.commandsGamestate) {
      this.commandsGamestate = connection.gamestateMessageNum;
      this.serverCommands.length = 0;
      this.initCGame();
    }
    for (;;) {
      const text = connection.nextServerCommand();
      if (text === null) break;
      this.serverCommands.push({ sequence: connection.lastExecutedServerCommand, text });
    }
  }
}

/**
 * `CL_FinishMove` (`cl_input.c:557–570`): one frame's input as a user command on the wire, less the
 * time, which the command ring stamps, and with the frame it was read under.
 */
function netUserCmd(cmd: Omit<UserCmd, 'serverTime'>, drawn: DrawnFrame): NetUserCmd {
  const out = createNetUserCmd();
  out.drawnTime = wireDrawnTime(drawn.time);
  out.drawnSnapTime = drawn.snapTime;
  out.drawnNextSnapTime = drawn.nextSnapTime;
  out.forwardmove = cmd.forwardmove;
  out.rightmove = cmd.rightmove;
  out.upmove = cmd.upmove;
  out.buttons = cmd.buttons;
  out.weapon = cmd.weapon;
  out.angles = [
    angleToShort(cmd.angles.x),
    angleToShort(cmd.angles.y),
    angleToShort(cmd.angles.z)
  ];
  return out;
}
