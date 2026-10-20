import {
  evictAllDurableObjects,
  evictDurableObject,
  listDurableObjectIds,
  runInDurableObject
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';

import { decodeFrame, encodeFrame, type MasterFrame } from '../../src/net/master-protocol';
import { NA, netadr, type NetAdr } from '../../src/net/net';
import { ICE_SERVERS, MAX_FRAME, type ConnectionRecord } from '../master-server';
import { oob, readList, text } from '../master-test-fixtures';
import worker, { MasterObject } from './worker';

/** Where the tests reach the Worker. */
const WORKER_URL = 'https://pcq-master.test/';

/** A request to the Worker, as from `ip`. */
function request(ip: string, headers: Record<string, string>) {
  const init = { headers: { ...headers, 'CF-Connecting-IP': ip } };
  return worker.fetch(new Request(WORKER_URL, init), env);
}

/**
 * A program's WebSocket to the master through the Worker, from `ip`, and the frames it reads.
 *
 * @param upgrade - The `Upgrade` header's value, a token cased as the program likes.
 */
async function connect(ip: string, upgrade = 'websocket') {
  const ws = (await request(ip, { Upgrade: upgrade })).webSocket!;
  ws.binaryType = 'arraybuffer';
  ws.accept();
  const frames: MasterFrame[] = [];
  let arrived = () => {};
  ws.addEventListener('message', (event) => {
    const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
    if (frame !== null) frames.push(frame);
    arrived();
  });
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve));

  /** The next frame the program reads, waited for. */
  async function next(): Promise<MasterFrame> {
    while (frames.length === 0) await new Promise<void>((resolve) => (arrived = resolve));
    return frames.shift()!;
  }
  const send = (frame: MasterFrame) => ws.send(encodeFrame(frame));
  return { ws, frames, next, send, closed };
}

type Program = Awaited<ReturnType<typeof connect>>;

/** The address the master greets a program with. */
async function greeting(program: Program): Promise<NetAdr> {
  const frame = await program.next();
  if (frame.kind !== 'greeting') throw new Error(`not a greeting: ${frame.kind}`);
  return frame.address;
}

/** A program at `ip` that has registered `port`, and the address it was granted. */
async function server(ip: string, port = 27960) {
  const program = await connect(ip);
  await greeting(program);
  program.send({ kind: 'register', port });
  const frame = await program.next();
  if (frame.kind !== 'registerResponse') throw new Error(`not a registerResponse: ${frame.kind}`);
  return { ...program, address: frame.address };
}

/** A datagram to the master, and the master's answer to it. */
async function ask(program: Program, line: string): Promise<Uint8Array> {
  program.send({ kind: 'datagram', data: oob(line) });
  const frame = await program.next();
  if (frame.kind !== 'datagram') throw new Error(`not a datagram: ${frame.kind}`);
  return frame.data;
}

/** The servers a list query finds, as `ip:port`. */
async function list(program: Program, line: string): Promise<string[] | null> {
  return readList(await ask(program, line));
}

/** A server's heartbeat, and the challenge of the `getinfo` the master sends down its link. */
async function heartbeat(host: Program): Promise<string> {
  const getinfo = text(await ask(host, 'heartbeat DarkPlaces\n'));
  const challenge = /^\xff\xff\xff\xffgetinfo (\S+)$/.exec(getinfo)?.[1];
  if (challenge === undefined) throw new Error(`not a getinfo: ${getinfo}`);
  return challenge;
}

/**
 * A server's `infoResponse` with this challenge, and the Internet's list as the server then asks
 * for it: a link's frames are handled in order, so the query is answered after the response.
 */
async function infoResponse(host: Program, challenge: string): Promise<string[] | null> {
  const keys = `\\challenge\\${challenge}\\gamename\\PlayCanvasQuake\\protocol\\1`;
  const counts = '\\clients\\1\\sv_maxclients\\8';
  host.send({ kind: 'datagram', data: oob(`infoResponse\n${keys}${counts}`) });
  return list(host, 'getserversExt PlayCanvasQuake 1');
}

/** The record the master keeps with its end of a WebSocket. */
function record(ws: WebSocket): ConnectionRecord {
  return ws.deserializeAttachment() as ConnectionRecord;
}

/** The one object the Worker hands every WebSocket to. */
async function object(): Promise<DurableObjectStub<MasterObject>> {
  const [id] = await listDurableObjectIds(env.MASTER);
  return env.MASTER.get(id);
}

/** The object evicted with its WebSockets left open, as Cloudflare evicts an idle one. */
async function evict(): Promise<void> {
  await evictDurableObject(await object());
}

/** The one object, and the master in it, as they were before each test: none. */
afterEach(() => evictAllDurableObjects({ webSockets: 'close' }));

describe('the master on Cloudflare', () => {
  it('greets a socket with its CF-Connecting-IP, and the ports up from 49152 by IP', async () => {
    const first = await connect('198.51.100.4');
    const second = await connect('198.51.100.4', 'WebSocket');
    const other = await connect('2001:db8::4');
    expect(await first.next()).toEqual({
      kind: 'greeting',
      address: netadr(NA.IP, '198.51.100.4', 49152),
      iceServers: ICE_SERVERS
    });
    expect(await greeting(second)).toEqual(netadr(NA.IP, '198.51.100.4', 49153));
    expect(await greeting(other)).toEqual(netadr(NA.IP6, '2001:db8::4', 49152));
  });

  it('lists a server that heartbeats once it answers the getinfo sent down its link', async () => {
    const host = await server('203.0.113.9');
    expect(host.address).toEqual(netadr(NA.IP, '203.0.113.9', 27960));
    expect(await infoResponse(host, await heartbeat(host))).toEqual(['203.0.113.9:27960']);

    const client = await connect('198.51.100.4');
    await greeting(client);
    expect(await list(client, 'getserversExt PlayCanvasQuake 1')).toEqual(['203.0.113.9:27960']);
  });

  it('finds a listen server by local, and passes signals and relays to and from it', async () => {
    const host = await server('203.0.113.20');
    const client = await connect('203.0.113.20');
    const from = await greeting(client);
    expect(await list(client, 'getserversExt PlayCanvasQuake 1 empty full')).toEqual([]);
    expect(await list(client, 'getserversExt PlayCanvasQuake 1 local')).toEqual([
      '203.0.113.20:27960'
    ]);

    const signal = { dial: 1, description: { type: 'offer' as const, sdp: 'v=0' } };
    client.send({ kind: 'signal', peer: host.address, signal });
    expect(await host.next()).toEqual({ kind: 'signal', peer: from, signal });

    client.send({ kind: 'relay', peer: host.address, data: oob('getinfo abc') });
    expect(await host.next()).toEqual({ kind: 'relay', peer: from, data: oob('getinfo abc') });
    host.send({ kind: 'relay', peer: from, data: oob('infoResponse\n\\challenge\\abc') });
    expect(await client.next()).toEqual({
      kind: 'relay',
      peer: host.address,
      data: oob('infoResponse\n\\challenge\\abc')
    });
  });

  it('answers a close, and lists the server that closed no more', async () => {
    const host = await server('203.0.113.30');
    const client = await connect('203.0.113.30');
    await greeting(client);

    host.ws.close(1000);
    await host.closed;
    expect(await list(client, 'getserversExt PlayCanvasQuake 1 local')).toEqual([]);
  });

  it('lists a server whose WebSocket failed no more', async () => {
    await server('203.0.113.40');
    const client = await connect('203.0.113.40');
    await greeting(client);

    await runInDurableObject(await object(), (instance: MasterObject, state) => {
      instance.webSocketError(state.getWebSockets().find((ws) => record(ws).registered)!);
    });
    expect(await list(client, 'getserversExt PlayCanvasQuake 1 local')).toEqual([]);
  });

  it('closes a WebSocket that sends a frame past MAX_FRAME, answering nothing after', async () => {
    const client = await connect('198.51.100.4');
    await greeting(client);

    await runInDurableObject(await object(), (instance: MasterObject, state) => {
      const [ws] = state.getWebSockets();
      instance.webSocketMessage(ws, new ArrayBuffer(MAX_FRAME + 1));
      // A query already on its way when the master closed the WebSocket.
      instance.webSocketMessage(ws, oob('getserversExt PlayCanvasQuake 1').buffer);
    });
    await client.closed;
    expect(client.frames).toEqual([]);
  });

  describe('woken after an eviction, with its WebSockets left open', () => {
    it('lists the same servers, and knows each socket by its address, greeting none', async () => {
      const host = await server('203.0.113.9');
      await infoResponse(host, await heartbeat(host));
      const listen = await server('198.51.100.20', 27961);
      const client = await connect('198.51.100.20');
      const from = await greeting(client);
      await evict();

      // The client's next frame is the list it asks for, which a greeting would come before.
      expect(await list(client, 'getserversExt PlayCanvasQuake 1')).toEqual(['203.0.113.9:27960']);
      expect(await list(client, 'getserversExt PlayCanvasQuake 1 local')).toEqual([
        '198.51.100.20:27961'
      ]);
      client.send({ kind: 'relay', peer: host.address, data: oob('getinfo abc') });
      expect(await host.next()).toEqual({ kind: 'relay', peer: from, data: oob('getinfo abc') });
      listen.send({ kind: 'relay', peer: from, data: oob('getinfo def') });
      expect(await client.next()).toEqual({
        kind: 'relay',
        peer: listen.address,
        data: oob('getinfo def')
      });
      // The port the client goes by is still taken.
      expect(await greeting(await connect('198.51.100.20'))).toEqual(
        netadr(NA.IP, '198.51.100.20', 49153)
      );
    });

    it('takes the answer to a getinfo the object before it sent', async () => {
      const host = await server('203.0.113.9');
      const challenge = await heartbeat(host);
      await evict();
      expect(await infoResponse(host, challenge)).toEqual(['203.0.113.9:27960']);
    });

    it('lists a server that closes after it no more', async () => {
      const host = await server('203.0.113.9');
      await infoResponse(host, await heartbeat(host));
      const client = await connect('198.51.100.4');
      await greeting(client);
      await evict();

      host.ws.close(1000);
      await host.closed;
      expect(await list(client, 'getserversExt PlayCanvasQuake 1')).toEqual([]);
    });

    it('gives the master back no WebSocket that holds no record', async () => {
      const kept = await connect('198.51.100.4');
      await greeting(kept);
      const stripped = await connect('198.51.100.4');
      await greeting(stripped);
      // As one the master refused as it connected holds none, until its close is answered.
      await runInDurableObject(await object(), (_instance: MasterObject, state) => {
        const [ws] = state.getWebSockets().filter((ws) => record(ws).address.port === 49153);
        ws.serializeAttachment(null);
      });
      await evict();

      const client = await connect('198.51.100.4');
      expect(await greeting(client)).toEqual(netadr(NA.IP, '198.51.100.4', 49153));
      expect(await list(kept, 'getserversExt PlayCanvasQuake 1')).toEqual([]);
    });
  });

  describe("looks a name up with the runtime's node:dns", () => {
    /** The master's answer to a name, as a client asks it. */
    async function resolve(name: string) {
      const client = await connect('198.51.100.4');
      await greeting(client);
      client.send({ kind: 'resolve', name, port: 27960 });
      return client.next();
    }

    it('answering with the addresses behind a CNAME', async () => {
      // The tests' DNS over HTTPS has this name alone (`vitest.config.ts`).
      expect(await resolve('master.example.test')).toEqual({
        kind: 'resolveResponse',
        name: 'master.example.test',
        port: 27960,
        addresses: [netadr(NA.IP, '192.0.2.8', 27960)],
        error: null
      });
    });

    it('answering a name not found with why, as Node does', async () => {
      expect(await resolve('nowhere.example.test')).toEqual({
        kind: 'resolveResponse',
        name: 'nowhere.example.test',
        port: 27960,
        addresses: [],
        error: 'ENOTFOUND'
      });
    });
  });

  it('refuses a request that is no WebSocket', async () => {
    const response = await request('198.51.100.4', {});
    expect(response.status).toBe(426);
    expect(response.headers.get('Upgrade')).toBe('websocket');
    expect(await response.text()).toBe('The master takes WebSockets alone.\n');
  });
});
