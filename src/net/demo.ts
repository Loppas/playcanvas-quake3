import { MAX_CONFIGSTRINGS, SVC } from './commands';
import { copyEntityState, copyPlayerState, readDeltaEntity } from './delta';
import { MAX_MSGLEN, Message } from './msg';
import {
  createEntityState,
  createPlayerState,
  GENTITYNUM_BITS,
  MAX_GENTITIES,
  type EntityState,
  type PlayerState
} from './protocol';
import { SnapshotReceiver } from './snapshot';

/**
 * A Quake 3 demo, read back: every server message a client recorded, as `CL_ReadDemoMessage`
 * reads them (`cl_main.c:935-981`).
 *
 * The file is `[long sequence] [long length] [length bytes]` a message, the bytes those after the
 * netchan's header (`CL_WriteDemoMessage`, `cl_main.c:617-629`), and a length of -1 ends it
 * (`CL_StopRecord_f`, `:639-660`). The first message is the gamestate `CL_Record_f` writes for
 * the client as it stands. Each is parsed as `CL_ParseServerMessage` parses one
 * (`cl_parse.c:858-931`), through the port's own wire, which is Quake 3's `msg.c`.
 *
 * The states are Quake 3's own: the wire carries their fields as the port's, but a field's value
 * means what Quake 3's game module meant by it, and its flags and numbered kinds are not always
 * numbered as the port numbers its own.
 */

/** A snapshot of a demo, as a client decoded it. */
export interface DemoSnapshot {
  /** The server's time it was made at. */
  serverTime: number;
  /** The sequence of the message that carried it. */
  messageNum: number;
  snapFlags: number;
  /** The areas the client is not shown, a bit each, all 32 bytes, as the client keeps them. */
  areamask: Uint8Array;
  /** The recording client's player state. */
  ps: PlayerState;
  /** Its entities, in increasing number. */
  entities: EntityState[];
}

export interface Demo {
  /** Which slot the recording client had, as its gamestate says. */
  clientNum: number;
  /** The configstrings, as the last gamestate set them. */
  configstrings: string[];
  /** The server commands, each once, in their order. */
  serverCommands: string[];
  /** Every snapshot that could be decoded, in the order recorded. */
  snapshots: DemoSnapshot[];
}

/**
 * Read a demo.
 *
 * A file that stops short of a message ends there, as Quake 3 ends a truncated one. A command the
 * port does not read, as VoIP's, is an error: the commands are not self-delimiting, so nothing
 * after it can be read.
 *
 * @param bytes - The file.
 * @throws `CL_ReadDemoMessage: demoMsglen > MAX_MSGLEN` for a message longer than Q3's limit
 */
export function readDemo(bytes: Uint8Array): Demo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const receiver = new SnapshotReceiver();
  const demo: Demo = { clientNum: 0, configstrings: [], serverCommands: [], snapshots: [] };
  let serverCommandSequence = 0;

  for (let at = 0; at + 8 <= bytes.length; ) {
    const sequence = view.getInt32(at, true);
    const length = view.getInt32(at + 4, true);
    at += 8;
    if (length === -1) break;
    if (length > MAX_MSGLEN) throw new Error('CL_ReadDemoMessage: demoMsglen > MAX_MSGLEN');
    if (at + length > bytes.length) break;
    const msg = Message.read(bytes.slice(at, at + length));
    at += length;

    // The reliable acknowledge, which only the recording client needed.
    msg.readLong();
    for (;;) {
      const command = msg.readByte();
      if (command === SVC.EOF) break;
      switch (command) {
        case SVC.NOP:
          break;
        case SVC.SERVER_COMMAND: {
          const commandSequence = msg.readLong();
          const text = msg.readBigString();
          // A server command is sent again until it is acknowledged.
          if (commandSequence <= serverCommandSequence) break;
          serverCommandSequence = commandSequence;
          demo.serverCommands.push(text);
          break;
        }
        case SVC.GAMESTATE:
          serverCommandSequence = readGamestate(msg, receiver, demo);
          break;
        case SVC.SNAPSHOT: {
          receiver.newSnapshots = false;
          receiver.parseSnapshot(msg, sequence, serverCommandSequence);
          if (!receiver.newSnapshots) break;
          const { snap } = receiver;
          demo.snapshots.push({
            serverTime: snap.serverTime,
            messageNum: snap.messageNum,
            snapFlags: snap.snapFlags,
            areamask: snap.areamask.slice(),
            ps: copyPlayerState(snap.ps, createPlayerState()),
            entities: receiver
              .entities(snap)
              .map((state) => copyEntityState(state, createEntityState(state.number)))
          });
          break;
        }
        default:
          throw new Error(`demo: server command byte ${command}, which the port does not read`);
      }
    }
  }
  return demo;
}

/**
 * `CL_ParseGamestate` (`cl_parse.c:390-470`): the configstrings and the baselines, and the slot.
 *
 * @returns The server command sequence the gamestate starts from.
 */
function readGamestate(msg: Message, receiver: SnapshotReceiver, demo: Demo): number {
  receiver.clear();
  demo.configstrings = [];
  const serverCommandSequence = msg.readLong();
  for (;;) {
    const command = msg.readByte();
    if (command === SVC.EOF) break;
    if (command === SVC.CONFIGSTRING) {
      const index = msg.readShort();
      if (index < 0 || index >= MAX_CONFIGSTRINGS) {
        throw new Error(`demo: configstring index ${index} out of range`);
      }
      demo.configstrings[index] = msg.readBigString();
    } else if (command === SVC.BASELINE) {
      const number = msg.readBits(GENTITYNUM_BITS);
      if (number < 0 || number >= MAX_GENTITIES) {
        throw new Error(`demo: baseline number ${number} out of range`);
      }
      const state = readDeltaEntity(msg, createEntityState(), createEntityState(), number);
      receiver.setBaseline(number, state);
    } else {
      throw new Error(`demo: bad command byte ${command} in a gamestate`);
    }
  }
  demo.clientNum = msg.readLong();
  // The checksum feed, which only a pure server's client needs.
  msg.readLong();
  return serverCommandSequence;
}
