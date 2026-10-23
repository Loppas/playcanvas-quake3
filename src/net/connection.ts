import { atof, atoi } from '../formats/c-scan';
import { tokenize } from '../formats/q3config';
import { PMOVE_MSEC, PMOVE_MSEC_MAX, PMOVE_MSEC_MIN } from '../sim/constants';
import {
  idSysteminfoRecord,
  isSysteminfoRecordKey,
  readSysteminfoRecord,
  type SysteminfoRecord
} from '../sim/rules';
import { ClientClock, UserCmdRing } from './client-clock';
import {
  CLC,
  CONFIGSTRING,
  MAX_CONFIGSTRINGS,
  MAX_PACKET_USERCMDS,
  MAX_RELIABLE_COMMANDS,
  PACKET_BACKUP,
  PACKET_MASK,
  SNAPFLAG,
  SVC
} from './commands';
import type { CvarStore } from './cvar';
import { readDeltaEntity, writeDeltaUserCmdKey } from './delta';
import { infoPairs, infoSetValueForKey, infoValueForKey } from './info';
import { hashKey, Message } from './msg';
import {
  adrToStringWithPort,
  compareAdr,
  isLANAddress,
  isLocalAddress,
  isOutOfBand,
  NA,
  netadr,
  type Net,
  type NetAdr
} from './net';
import { Netchan } from './netchan';
import {
  createEntityState,
  createNetUserCmd,
  GENTITYNUM_BITS,
  MAX_GENTITIES,
  type NetUserCmd
} from './protocol';
import { SnapshotReceiver } from './snapshot';

/**
 * `connstate_t` (`q_shared.h:1319–1330`): where a client is between being given a server and
 * playing on it. Quake 3's numbers, less the states the port never passes through: authorizing,
 * loading the cgame, and cinematics.
 */
export const CA = {
  /** Talking to no server. */
  DISCONNECTED: 1,
  /** Asking for a challenge. */
  CONNECTING: 3,
  /** Sending `connect`, with the challenge. */
  CHALLENGING: 4,
  /** The netchan is up, and the gamestate has not come. */
  CONNECTED: 5,
  /** The gamestate is in, and no snapshot the player is in has come. */
  PRIMED: 7,
  /** Playing. */
  ACTIVE: 8
} as const;

/** `RETRANSMIT_TIMEOUT` (`client.h:45`): how long a connection packet waits for its answer. */
const RETRANSMIT_TIMEOUT = 3000;

/**
 * `Com_Error( ERR_SERVERDISCONNECT )`: the server has let this client go, and said why. The match
 * ends there, printing nothing, and the reason waits for the main menu.
 */
export class ServerDisconnect extends Error {
  /**
   * `CL_GetServerCommand`'s words (`cl_cgame.c:290–297`).
   *
   * @param argv - The server's `disconnect` command, with its reason where it gave one.
   */
  constructor(argv: readonly string[]) {
    super(argv.length >= 2 ? `Server disconnected - ${argv[1]}` : 'Server disconnected');
    this.name = 'ServerDisconnect';
  }
}

/**
 * The client's end of the wire — Quake 3's `clientConnection_t` and `clientActive_t`
 * (`client.h:92–260`), with `CL_ParseServerMessage` and `CL_WritePacket` over them.
 *
 * It holds no game state and decides nothing: what it has is the bookkeeping that makes a
 * connection work. Which message was last received, which reliable commands each side has run, and
 * the snapshots kept so the next one can be decoded against them.
 *
 * The local client uses this as any other client would. That is the point of the loopback: there is
 * no shorter path from the host's state to the player's screen than the one a remote player takes.
 */
/** What a client is given besides its store, where a value is not the store's. */
export interface ClientConnectionOptions {
  /**
   * `sv_paused`, for the timeout exemption: the channel's where the server is a worker's,
   * else the shared store's.
   */
  serverPaused?: () => boolean;
}

export class ClientConnection {
  /** `clc.state`: one of {@link CA}. */
  state: number = CA.DISCONNECTED;
  /** `clc.netchan`: the channel to the host, or null before the host has taken the connection. */
  netchan: Netchan | null = null;
  /** The process's way out, which the last connect went through. */
  private net: Net | null = null;
  /**
   * Where an out-of-band packet goes that is not an answer to a connect: the client's that outlasts
   * the connection, whose are the lists' answers and a server's status (`cls`). It is given when
   * the packet landed, where its socket said.
   */
  onConnectionless: ((from: NetAdr, data: Uint8Array, time?: number) => void) | null = null;

  /**
   * The client's own settings, which a `connect` carries: `Cvar_InfoString(CVAR_USERINFO)`,
   * kept here by whoever owns the settings.
   */
  userinfo = '';

  /** `clc.servername`: the server as it was named. */
  servername = '';
  /** `clc.serverAddress`: where the connection packets go. */
  serverAddress: NetAdr = netadr(NA.BAD);
  /** `clc.challenge`: the client's own number while it asks for one, then the server's. */
  challenge = 0;
  /** `clc.connectTime`: when the last connection packet went. */
  private connectTime = 0;
  /** `clc.connectPacketCount`: how many have gone for this connection. */
  connectPacketCount = 0;
  /** `clc.lastPacketSentTime`, which paces what goes before the gamestate. */
  private lastPacketSentTime = 0;
  /** `clc.serverMessage`: the last `print` the server sent out of band, such as a refusal. */
  serverMessage = '';
  /** `clc.lastPacketTime`: when the last packet came, from anywhere. */
  private lastPacketTime = 0;
  /** `cl.timeoutcount`: the frames in a row the server has been past `cl_timeout`. */
  private timeoutCount = 0;
  /** `cl_paused->modified`: the frame `cl_paused` changed in counts as paused. */
  private pauseModified = false;
  /** `cl_paused`'s modification count as last read, which is what moves {@link pauseModified}. */
  private pauseCount = 0;

  /** The sequence number of the last message received, which is what a delta is measured from. */
  serverMessageSequence = 0;
  /**
   * The sequence number of the message the last gamestate came in, which is where cgame starts
   * counting snapshots (`CL_InitCGame` hands it to `CG_Init`, `cl_cgame.c:745`).
   */
  gamestateMessageNum = 0;

  /** The last server command received. */
  serverCommandSequence = 0;
  /** The last server command handed to whoever asked for it. */
  lastExecutedServerCommand = 0;
  private readonly serverCommands: string[] = new Array<string>(MAX_RELIABLE_COMMANDS).fill('');

  /** Our own reliable commands, kept until the server acknowledges them. */
  reliableSequence = 0;
  reliableAcknowledge = 0;
  private readonly reliableCommands: string[] = new Array<string>(MAX_RELIABLE_COMMANDS).fill('');

  /** Which slot we are in, once the gamestate says so. */
  clientNum = -1;
  /** Which map load we are playing, which every message we send is stamped with. */
  serverId = 0;
  /**
   * The rules the client predicts by, and the server's cvars its view reads beside them, as the
   * last systeminfo carried them, and id's before one has. Refilled in place, so whoever holds the
   * record reads the current ones.
   */
  readonly rules: SysteminfoRecord = idSysteminfoRecord();
  checksumFeed = 0;
  gameStateReceived = false;

  readonly configstrings: string[] = new Array<string>(MAX_CONFIGSTRINGS).fill('');

  readonly snapshots = new SnapshotReceiver();

  /** `cl.serverTime` and what keeps it, on `cls.realtime`, which the frames' runner moves on. */
  readonly clock = new ClientClock();
  /** The client's own commands, and the packets they went in. */
  readonly commands = new UserCmdRing();

  /**
   * The message every move packet is written into, reused. What {@link transmit} hands the netchan
   * is copied on its way out, so the buffer is free the moment the packet has gone.
   */
  private readonly moveMessage = Message.write();

  private readonly cvars: CvarStore;
  /**
   * `sv_paused` where it is not this store's: a listen server whose program is a worker's reads
   * it over its channel. The store's own, in a client that shares a process with its server.
   */
  private readonly serverPaused?: () => boolean;

  /**
   * @param cvars - Where the client's cvars are, which are registered here as `CL_Init` does.
   * @param options - What the client needs besides its store, where these are not in it.
   */
  constructor(cvars: CvarStore, options: ClientConnectionOptions = {}) {
    this.cvars = cvars;
    this.serverPaused = options.serverPaused;
    const defaults: [string, string][] = [
      ['cl_timeout', '200'],
      ['cl_timeNudge', '0'],
      ['cl_showTimeDelta', '0'],
      ['cl_maxpackets', '125'],
      ['cl_packetdup', '1'],
      ['cl_lanForcePackets', '1']
    ];
    for (const [name, value] of defaults) if (cvars.get(name) === '') cvars.set(name, value);
  }

  /**
   * `CL_Connect_f` (`cl_main.c:1735–1773`), once the server is found: leave whatever server this
   * was on, and start connecting to another. A server outside the process is asked for a challenge
   * first; the one in it is sent the `connect` at once.
   *
   * The command's own work — the server looked up, and one running in this page shut down — is the
   * client's that outlasts the connection.
   *
   * @param net - The process's way out.
   * @param server - The server as it was named.
   * @param address - Where it was found.
   */
  connect(net: Net, server: string, address: NetAdr): void {
    this.disconnect();
    this.net = net;
    this.servername = server;
    this.serverAddress = { ...address };

    if (isLocalAddress(address)) {
      this.state = CA.CHALLENGING;
    } else {
      this.state = CA.CONNECTING;
      this.challenge = ((rand() << 16) ^ rand() ^ net.now()) | 0;
    }
    // So that `checkForResend` sends at once.
    this.connectTime = -99999;
    this.connectPacketCount = 0;
  }

  /**
   * `CL_MapLoading` (`cl_main.c:1281–1317`): the server in this process has loaded a map.
   *
   * A client already on it stays connected, and only waits for the new gamestate, so only the
   * first map runs the handshake. Otherwise it connects, with no challenge, since nothing outside
   * the process can send from the loopback.
   */
  mapLoading(net: Net): void {
    if (this.state >= CA.CONNECTED && this.servername.toLowerCase() === 'localhost') {
      this.state = CA.CONNECTED;
      this.serverMessage = '';
      this.configstrings.fill('');
      this.lastPacketSentTime = -9999;
      return;
    }

    this.disconnect();
    this.net = net;
    this.servername = 'localhost';
    this.state = CA.CHALLENGING;
    this.connectTime = -RETRANSMIT_TIMEOUT;
    this.serverAddress = netadr(NA.LOOPBACK);
    this.checkForResend();
  }

  /**
   * `CL_Disconnect` (`cl_main.c:1376–1479`): leave the server, saying so three times in case two
   * are lost, and forget everything about it.
   */
  disconnect(): void {
    if (this.state >= CA.CONNECTED) {
      this.addReliableCommand('disconnect', true);
      for (let i = 0; i < 3; i++) this.transmit(this.writeMovePacket([]));
    }
    this.clearState();
  }

  /**
   * `CL_CheckForResend` (`cl_main.c:2370–2437`): while connecting, a `getchallenge` or a
   * `connect` every three seconds until the server answers. There is no giving up.
   *
   * The `connect` carries the userinfo with the protocol, the qport and the challenge on the front.
   */
  checkForResend(): void {
    const { net } = this;
    if (net === null) return;
    if (this.state !== CA.CONNECTING && this.state !== CA.CHALLENGING) return;
    const now = net.now();
    if (now - this.connectTime < RETRANSMIT_TIMEOUT) return;

    this.connectTime = now;
    this.connectPacketCount++;

    if (this.state === CA.CONNECTING) {
      net.outOfBandPrint(
        'client',
        this.serverAddress,
        `getchallenge ${this.challenge} ${net.gamename}`
      );
      return;
    }

    let info = infoSetValueForKey(this.userinfo, 'protocol', String(net.protocol));
    info = infoSetValueForKey(info, 'qport', String(net.qport));
    info = infoSetValueForKey(info, 'challenge', String(this.challenge));
    net.outOfBandData('client', this.serverAddress, `connect "${info}"`);
  }

  /**
   * `CL_CheckTimeout` (`cl_main.c:2899–2914`): leave a server that has sent nothing for
   * `cl_timeout` seconds. It must have been so for six frames running, so a stall of the client's
   * own is not taken for the server's silence.
   */
  checkTimeout(): void {
    const { net } = this;
    if (net === null) return;
    // `CL_CheckTimeout`'s pause exemption (`cl_main.c:2903–2905`): a paused local server sends
    // nothing, and is not silent. The count is reset, as the else branch there does.
    const paused = this.checkPaused() && this.serverIsPaused();
    const silent =
      !paused && net.now() - this.lastPacketTime > atof(this.cvars.get('cl_timeout')) * 1000;
    if (this.state >= CA.CONNECTED && silent) {
      if (++this.timeoutCount > 5) {
        net.print('');
        net.print('Server connection timed out.');
        this.disconnect();
      }
    } else {
      this.timeoutCount = 0;
    }
  }

  /**
   * `CL_CheckPaused` (`cl_main.c:2922–2931`): whether the client is paused. The frame in which
   * `cl_paused` changed counts as paused too, so a client just coming back cannot leave its server
   * behind; a snapshot clears the flag (`cl_parse.c:225–227`).
   */
  checkPaused(): boolean {
    const count = this.cvars.modificationCount('cl_paused');
    if (count !== this.pauseCount) {
      this.pauseCount = count;
      this.pauseModified = true;
    }
    return atoi(this.cvars.get('cl_paused')) !== 0 || this.pauseModified;
  }

  /** `sv_paused`, from the channel where the server is elsewhere, else from the store. */
  private serverIsPaused(): boolean {
    if (this.serverPaused) return this.serverPaused();
    return atoi(this.cvars.get('sv_paused')) !== 0;
  }

  /**
   * `CL_PacketEvent` (`cl_main.c:2840–2890`): a packet that reached the client.
   *
   * @param time - When it landed, where its socket said (`NetPacket.time`).
   * @returns whether it carried a message from the host, which has been read
   */
  packetEvent(from: NetAdr, data: Uint8Array, time?: number): boolean {
    // Any packet at all puts the timeout off, whoever sent it.
    if (this.net !== null) this.lastPacketTime = this.net.now();

    if (isOutOfBand(data)) {
      this.connectionlessPacket(from, data, time);
      return false;
    }

    const { netchan, net } = this;
    if (this.state < CA.CONNECTED || netchan === null || net === null) return false;

    if (data.length < 4) {
      net.print(`${adrToStringWithPort(from)}: Runt packet`);
      return false;
    }

    // Only the host's packets are sequenced for this connection.
    if (!compareAdr(from, netchan.remoteAddress)) return false;

    const message = netchan.process(data);
    if (message === null) return false;

    // What the next packet acknowledges, which is how the host notices a gamestate went missing.
    this.serverMessageSequence = message.sequence;
    this.parseServerMessage(message.data);
    return true;
  }

  /**
   * `CL_ConnectionlessPacket` (`cl_main.c:2623–2830`), for the answers to a connect. A server's
   * other answers are the client's that outlasts the connection: {@link onConnectionless}'s.
   */
  private connectionlessPacket(from: NetAdr, data: Uint8Array, time?: number): void {
    const msg = Message.read(data);
    msg.beginReading(true);
    msg.readLong();
    const argv = tokenize(msg.readStringLine());

    const command = (argv[0] ?? '').toLowerCase();
    if (command !== 'challengeresponse' && command !== 'connectresponse' && command !== 'print') {
      this.onConnectionless?.(from, data, time);
      return;
    }
    const { net } = this;
    if (net === null) return;

    switch (command) {
      case 'challengeresponse': {
        if (this.state !== CA.CONNECTING) return;

        const echoed = argv[2] ?? '';
        const version = argv[3] ?? '';
        if (version !== '' && atoi(version) !== net.protocol) {
          net.print(
            `^3Warning: Server reports protocol version ${atoi(version)}, ` +
              `we have ${net.protocol}. Trying anyways.`
          );
        }
        // The client's own number, sent back, is what shows the answer is to its question.
        if (echoed === '' || atoi(echoed) !== this.challenge) {
          net.print('Bad challenge for challengeResponse. Ignored.');
          return;
        }

        this.challenge = atoi(argv[1] ?? '');
        this.state = CA.CHALLENGING;
        this.connectPacketCount = 0;
        this.connectTime = -99999;
        // Whoever answered is the server from here, which lets a proxy hand the connection on.
        this.serverAddress = { ...from };
        return;
      }

      case 'connectresponse': {
        if (this.state >= CA.CONNECTED) {
          net.print('Dup connect received. Ignored.');
          return;
        }
        if (this.state !== CA.CHALLENGING) {
          net.print('connectResponse packet while not connecting. Ignored.');
          return;
        }
        if (!compareAdr(from, this.serverAddress)) {
          net.print('connectResponse from wrong address. Ignored.');
          return;
        }
        const challenge = argv[1] ?? '';
        if (challenge === '') {
          net.print('Bad connectResponse received. Ignored.');
          return;
        }
        if (atoi(challenge) !== this.challenge) {
          net.print('ConnectResponse with bad challenge received. Ignored.');
          return;
        }

        this.netchan = new Netchan(net);
        this.netchan.setup('client', from, net.qport, this.challenge);
        this.state = CA.CONNECTED;
        // So that the first packet, which asks for the gamestate, goes at once.
        this.lastPacketSentTime = -9999;
        return;
      }

      case 'print':
        if (!compareAdr(from, this.serverAddress)) return;
        this.serverMessage = msg.readString();
        net.print(this.serverMessage.replace(/\n$/, ''));
        return;
    }
  }

  /** `CL_ClearState` and the memset of `clc` that `CL_Disconnect` makes. */
  private clearState(): void {
    this.state = CA.DISCONNECTED;
    this.netchan = null;
    this.servername = '';
    this.serverAddress = netadr(NA.BAD);
    this.challenge = 0;
    this.connectTime = 0;
    this.connectPacketCount = 0;
    this.lastPacketSentTime = 0;
    this.serverMessage = '';
    this.lastPacketTime = 0;
    this.timeoutCount = 0;
    this.serverMessageSequence = 0;
    this.gamestateMessageNum = 0;
    this.serverCommandSequence = 0;
    this.lastExecutedServerCommand = 0;
    this.serverCommands.fill('');
    this.reliableSequence = 0;
    this.reliableAcknowledge = 0;
    this.reliableCommands.fill('');
    this.clientNum = -1;
    this.serverId = 0;
    this.checksumFeed = 0;
    this.gameStateReceived = false;
    this.configstrings.fill('');
    this.snapshots.clear();
    this.clock.clear();
    this.commands.clear();
  }

  /**
   * `CL_ParseServerMessage` (`cl_parse.c:858–934`): one message from the host.
   *
   * Everything in the message is read in order, and anything the port does not implement is an
   * error rather than a skip, because the commands are not self-delimiting: a byte it cannot
   * decode is the end of anything useful. So is a message that runs out before its `svc_EOF`.
   */
  private parseServerMessage(data: Uint8Array): void {
    const sequence = this.serverMessageSequence;
    const msg = Message.read(data);

    this.reliableAcknowledge = msg.readLong();
    if (this.reliableAcknowledge < this.reliableSequence - MAX_RELIABLE_COMMANDS) {
      this.reliableAcknowledge = this.reliableSequence;
    }

    for (;;) {
      if (msg.readCount > msg.curSize) {
        throw new Error('CL_ParseServerMessage: read past end of server message');
      }
      const command = msg.readByte();
      if (command === SVC.EOF) break;

      switch (command) {
        case SVC.NOP:
          break;
        case SVC.SERVER_COMMAND:
          this.parseCommandString(msg);
          break;
        case SVC.GAMESTATE:
          this.parseGamestate(msg);
          break;
        case SVC.SNAPSHOT:
          this.snapshots.parseSnapshot(msg, sequence, this.serverCommandSequence, (commandTime) =>
            this.snapshotPing(commandTime)
          );
          // "If we were just unpaused, we can only *now* really let the change come into effect"
          // (`cl_parse.c:225–227`).
          this.pauseModified = false;
          break;
        default:
          throw new Error(`connection: unknown server command byte ${command}`);
      }
    }
  }

  /**
   * `CL_ParseSnapshot`'s ping (`cl_parse.c:307–315`): the time since the newest packet whose last
   * command the snapshot's player state has reached, or 999 if none of those kept has.
   */
  private snapshotPing(commandTime: number): number {
    const { netchan } = this;
    if (netchan === null) return 999;
    for (let i = 0; i < PACKET_BACKUP; i++) {
      const packet = this.commands.outPackets[(netchan.outgoingSequence - 1 - i) & PACKET_MASK];
      if (commandTime >= packet.serverTime) return this.clock.realtime - packet.realtime;
    }
    return 999;
  }

  /**
   * `CL_GetServerCommand` (`cl_cgame.c:259–364`): take the next server command, or null when
   * there are none left to run.
   *
   * The client acts on a `cs` before the game sees it (`cl_cgame.c:324–329`). A restart sends one
   * with its new server id in the system info, and a client that missed it would stamp every move
   * with the old id, which the host drops as one that has not caught up with the restart.
   */
  nextServerCommand(): string | null {
    if (this.lastExecutedServerCommand >= this.serverCommandSequence) return null;
    this.lastExecutedServerCommand++;
    const slot = this.lastExecutedServerCommand & (MAX_RELIABLE_COMMANDS - 1);
    const command = this.serverCommands[slot];
    const argv = tokenize(command);
    if (argv[0] === 'cs') this.configstringModified(argv);
    return command;
  }

  /**
   * `CL_ConfigstringModified` (`cl_cgame.c:195–249`): one configstring changed without a
   * gamestate, as `cs <index> <value>`.
   */
  private configstringModified(argv: readonly string[]): void {
    const index = atoi(argv[1] ?? '');
    if (index < 0 || index >= MAX_CONFIGSTRINGS) {
      throw new Error(`CL_ConfigstringModified: bad index ${index}`);
    }
    // `Cmd_ArgsFrom(2)`: everything after the index.
    const value = argv.slice(2).join(' ');
    if (this.configstrings[index] === value) return;
    this.configstrings[index] = value;
    if (index === CONFIGSTRING.SYSTEMINFO) this.systemInfoChanged();
  }

  /**
   * `CL_SystemInfoChanged` (`cl_parse.c:342–436`): the server id every message is stamped with,
   * the rules a client's prediction replays, and the rest of the server's `CVAR_SYSTEMINFO` cvars.
   *
   * The rules, and the cvars beside them the view reads, go into {@link rules} and never into the
   * store, where Q3 sets every key as a cvar: they are the server's while the client is on it, and
   * a cvar would make them the player's. Q3 refuses any other key its own cvar flags say a server
   * may not set, and creates one it has never held read-only; the store makes both calls, and a
   * refusal is Q3's warning.
   */
  private systemInfoChanged(): void {
    const systemInfo = this.configstrings[CONFIGSTRING.SYSTEMINFO];
    this.serverId = atoi(infoValueForKey(systemInfo, 'sv_serverid'));
    readSysteminfoRecord(systemInfo, this.rules);

    for (const [key, value] of infoPairs(systemInfo)) {
      if (key.toLowerCase() === 'sv_serverid' || isSysteminfoRecordKey(key)) continue;
      if (!this.cvars.setServer(key, value)) {
        this.net?.print(`WARNING: server is not allowed to set ${key}=${value}\n`);
      }
    }
  }

  /**
   * `CL_AddReliableCommand` (`cl_main.c:580–599`): queue a command for the server.
   *
   * @param isDisconnect - Whether this is the `disconnect` a client leaves with, which may take
   *   the last slot: a client whose commands have backed up can still say it is going.
   */
  addReliableCommand(text: string, isDisconnect = false): void {
    const unacknowledged = this.reliableSequence - this.reliableAcknowledge;
    const room = isDisconnect ? MAX_RELIABLE_COMMANDS + 1 : MAX_RELIABLE_COMMANDS;
    if (unacknowledged >= room) throw new Error('Client command overflow');
    this.reliableSequence++;
    this.reliableCommands[this.reliableSequence & (MAX_RELIABLE_COMMANDS - 1)] = text;
  }

  /**
   * The message `CL_WritePacket` writes (`cl_input.c:764–879`), with these user commands.
   *
   * The delta is asked for by which command byte is used: a client that cannot decode what it was
   * last sent asks for a snapshot delta'd against nothing at all.
   *
   * The message is the connection's one buffer, rewritten each call: hand it to {@link transmit},
   * or copy it, before asking for another.
   *
   * @returns the message, for {@link transmit} to send
   */
  writeMovePacket(cmds: readonly NetUserCmd[]): Message {
    const msg = this.moveMessage;
    msg.clear();

    msg.writeLong(this.serverId);
    msg.writeLong(this.serverMessageSequence);
    msg.writeLong(this.serverCommandSequence);

    for (let i = this.reliableAcknowledge + 1; i <= this.reliableSequence; i++) {
      msg.writeByte(CLC.CLIENT_COMMAND);
      msg.writeLong(i);
      msg.writeString(this.reliableCommands[i & (MAX_RELIABLE_COMMANDS - 1)]);
    }

    if (cmds.length > 0) {
      const snap = this.snapshots.snap;
      const canDelta = snap.valid && this.serverMessageSequence === snap.messageNum;
      msg.writeByte(canDelta ? CLC.MOVE : CLC.MOVE_NO_DELTA);
      msg.writeByte(cmds.length);

      let key = this.checksumFeed;
      key ^= this.serverMessageSequence;
      key ^= hashKey(
        this.serverCommands[this.serverCommandSequence & (MAX_RELIABLE_COMMANDS - 1)],
        32
      );

      let oldcmd = createNetUserCmd();
      for (const cmd of cmds) {
        writeDeltaUserCmdKey(msg, key, oldcmd, cmd);
        oldcmd = cmd;
      }
    }

    return msg;
  }

  /**
   * `CL_Netchan_Transmit` (`cl_net_chan.c:152–170`): a message to the host, ended with `clc_EOF`,
   * every fragment of it at once. Nothing goes before the host has taken the connection.
   */
  transmit(msg: Message): void {
    if (this.netchan === null || this.net === null) return;
    this.lastPacketSentTime = this.net.now();
    msg.writeByte(CLC.EOF);
    this.netchan.transmit(msg.written);
    while (this.netchan.unsentFragments) this.netchan.transmitNextFragment();
  }

  /**
   * `CL_SendCmd` (`cl_input.c:904–927`): this frame's commands, and a packet if one is due.
   *
   * @param input - The frame's input as the wire carries it; its time is the clock's to set.
   */
  sendCmd(input: NetUserCmd): void {
    if (this.state < CA.CONNECTED) return;
    if (this.state >= CA.PRIMED) {
      this.commands.createNewCommands(input, this.clock, this.state === CA.ACTIVE, this.pmoveMsec);
    }
    if (this.readyToSendPacket()) this.writePacket();
  }

  /**
   * `pmove_msec`, which the systeminfo sets, held to 8–33 where it is read, as the server holds it
   * (`g_active.c:790–797`): the step the client's commands are made on, and the tick its
   * prediction chops them into.
   */
  get pmoveMsec(): number {
    const msec = Number.parseInt(this.cvars.get('pmove_msec'), 10) || PMOVE_MSEC;
    const held = Math.min(Math.max(msec, PMOVE_MSEC_MIN), PMOVE_MSEC_MAX);
    if (held !== msec) this.cvars.set('pmove_msec', String(held));
    return held;
  }

  /**
   * `CL_ReadyToSendPacket` (`cl_input.c:672–720`): whether a packet may go this frame.
   *
   * Until the gamestate is in, a packet a second is enough to ask for it. The loopback takes one
   * every frame, and so does a LAN server under `cl_lanForcePackets`. Anything else takes
   * `cl_maxpackets` a second at most, and the commands of a frame held back go in the next packet,
   * which saves a header and deltas better.
   */
  private readyToSendPacket(): boolean {
    const { net, netchan } = this;
    if (net === null || netchan === null) return false;

    const primed = this.state === CA.PRIMED || this.state === CA.ACTIVE;
    if (!primed && net.now() - this.lastPacketSentTime < 1000) return false;

    if (netchan.remoteAddress.type === NA.LOOPBACK) return true;

    // Send every frame for LAN, as Q3's `cl_lanForcePackets` does.
    if (atoi(this.cvars.get('cl_lanForcePackets')) !== 0 && isLANAddress(netchan.remoteAddress)) {
      return true;
    }

    let maxPackets = atoi(this.cvars.get('cl_maxpackets'));
    if (maxPackets < 15) {
      this.cvars.set('cl_maxpackets', '15');
      maxPackets = 15;
    } else if (maxPackets > 125) {
      this.cvars.set('cl_maxpackets', '125');
      maxPackets = 125;
    }
    const last = this.commands.outPackets[(netchan.outgoingSequence - 1) & PACKET_MASK];
    return this.clock.realtime - last.realtime >= Math.trunc(1000 / maxPackets);
  }

  /**
   * `CL_WritePacket` (`cl_input.c:743–895`): a packet to the host.
   *
   * It carries every command made since the packet `cl_packetdup` packets back, so a lost packet
   * or two costs nothing but the repeats. The server throws away the commands it has already run.
   */
  private writePacket(): void {
    const { netchan, net } = this;
    if (netchan === null || net === null) return;

    let packetDup = atoi(this.cvars.get('cl_packetdup'));
    if (packetDup < 0) {
      this.cvars.set('cl_packetdup', '0');
      packetDup = 0;
    } else if (packetDup > 5) {
      this.cvars.set('cl_packetdup', '5');
      packetDup = 5;
    }

    const { commands } = this;
    const since = commands.outPackets[(netchan.outgoingSequence - 1 - packetDup) & PACKET_MASK];
    let count = commands.cmdNumber - since.cmdNumber;
    if (count > MAX_PACKET_USERCMDS) {
      count = MAX_PACKET_USERCMDS;
      net.print('MAX_PACKET_USERCMDS');
    }
    const cmds: NetUserCmd[] = [];
    for (let i = count - 1; i >= 0; i--) cmds.push(commands.at(commands.cmdNumber - i));

    const packet = commands.outPackets[netchan.outgoingSequence & PACKET_MASK];
    packet.realtime = this.clock.realtime;
    packet.serverTime = cmds.length > 0 ? cmds[cmds.length - 1].serverTime : 0;
    packet.cmdNumber = commands.cmdNumber;
    this.transmit(this.writeMovePacket(cmds));
  }

  /**
   * `CL_SetCGameTime` (`cl_cgame.c:942–1022`): the server's time as the client has it this frame.
   *
   * The first snapshot the player is in ends the connecting, and sets the clock exactly on it.
   * After that the clock runs on the client's own time, and each new snapshot moves it a little.
   */
  setCGameTime(): void {
    const { clock, snapshots } = this;
    const { snap } = snapshots;
    if (this.state !== CA.ACTIVE) {
      if (this.state !== CA.PRIMED) return;
      if (snapshots.newSnapshots) {
        snapshots.newSnapshots = false;
        // `CL_FirstSnapshot`: a snapshot the player is not in yet is no start.
        if ((snap.snapFlags & SNAPFLAG.NOT_ACTIVE) === 0) {
          this.state = CA.ACTIVE;
          clock.firstSnapshot(snap.serverTime);
        }
      }
      if (this.state !== CA.ACTIVE) return;
    }

    if (!snap.valid) throw new Error('CL_SetCGameTime: !cl.snap.valid');
    if (snap.serverTime < clock.oldFrameServerTime) {
      throw new Error('cl.snap.serverTime < cl.oldFrameServerTime');
    }
    clock.oldFrameServerTime = snap.serverTime;

    clock.run(snap.serverTime, atoi(this.cvars.get('cl_timeNudge')));

    // Only on a new snapshot, so that a run of lost packets does not drag the clock about.
    if (snapshots.newSnapshots) {
      snapshots.newSnapshots = false;
      const shown = clock.adjustTimeDelta(snap.serverTime);
      if (atoi(this.cvars.get('cl_showTimeDelta')) !== 0) this.net?.print(shown);
    }
  }

  /**
   * `CL_ParseGamestate` (`cl_parse.c:390–470`): the world as it was before we arrived.
   *
   * It replaces everything. A gamestate arrives on connecting and on every map load, and in both
   * cases what the client knew is about to be wrong, so the snapshots and the baselines go with it.
   */
  private parseGamestate(msg: Message): void {
    this.connectPacketCount = 0;
    // `CL_ClearState`: the clock and the commands start again with the world.
    this.configstrings.fill('');
    this.snapshots.clear();
    this.clock.clear();
    this.commands.clear();

    this.gamestateMessageNum = this.serverMessageSequence;
    this.serverCommandSequence = msg.readLong();
    this.lastExecutedServerCommand = this.serverCommandSequence;

    for (;;) {
      const command = msg.readByte();
      if (command === SVC.EOF) break;

      if (command === SVC.CONFIGSTRING) {
        const index = msg.readShort();
        if (index < 0 || index >= MAX_CONFIGSTRINGS) {
          throw new Error(`connection: configstring index ${index} out of range`);
        }
        this.configstrings[index] = msg.readBigString();
        continue;
      }

      if (command === SVC.BASELINE) {
        const number = msg.readBits(GENTITYNUM_BITS);
        if (number < 0 || number >= MAX_GENTITIES) {
          throw new Error(`connection: baseline number ${number} out of range`);
        }
        const state = readDeltaEntity(msg, createEntityState(), createEntityState(), number);
        this.snapshots.setBaseline(number, state);
        continue;
      }

      throw new Error(`connection: bad command byte ${command} in a gamestate`);
    }

    this.clientNum = msg.readLong();
    this.checksumFeed = msg.readLong();

    // Quake 3 pulls the server id out of the system info, along with everything else a client has
    // to agree with the server about (`cl_parse.c:532`).
    this.systemInfoChanged();

    // `CL_InitCGame` (`cl_cgame.c:753`): the port's cgame needs no loading, so the client is primed
    // as the gamestate lands.
    this.gameStateReceived = true;
    this.state = CA.PRIMED;
  }

  /** `CL_ParseCommandString` (`cl_parse.c:820–845`). */
  private parseCommandString(msg: Message): void {
    const sequence = msg.readLong();
    // Big, because a `cs` for the systeminfo carries every rule cvar (see the host's writer).
    const text = msg.readBigString();

    // The server resends a command until it is acknowledged, so most arrivals are repeats.
    if (sequence <= this.serverCommandSequence) return;

    this.serverCommandSequence = sequence;
    this.serverCommands[sequence & (MAX_RELIABLE_COMMANDS - 1)] = text;
  }
}

/** `rand()` as glibc's: 31 bits. */
function rand(): number {
  return Math.floor(Math.random() * 0x80000000);
}
