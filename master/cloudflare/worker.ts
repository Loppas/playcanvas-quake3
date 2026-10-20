import { lookup } from 'node:dns/promises';

import { DurableObject } from 'cloudflare:workers';

import { MasterServer, type ConnectionRecord, type MasterWebSocket } from '../master-server';

/**
 * The master on Cloudflare: a Worker that hands each WebSocket to one Durable Object, which runs
 * {@link MasterServer} on them, as `wrangler.jsonc` declares the two.
 *
 * The object holds its WebSockets by the hibernation API, so it costs nothing while they are idle:
 * it is evicted then with them left open, and the next object gives the master back each one with
 * the record the master kept in it. A Worker can't dial WebRTC, so the master checks a server down
 * the server's own link.
 */

declare global {
  namespace Cloudflare {
    interface Env {
      /** The object's class, bound in `wrangler.jsonc`. */
      MASTER: DurableObjectNamespace<MasterObject>;
    }
  }
}

/**
 * The source port every connection is given, as Cloudflare names a client by its IP alone: the
 * first of the dynamic ports (RFC 6335). The master takes the first port up from it that no live
 * connection goes by.
 */
const SOURCE_PORT = 49152;

export default {
  /** A WebSocket, handed to the one object with the client's `CF-Connecting-IP`; nothing else. */
  fetch(request: Request, env: Cloudflare.Env) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('The master takes WebSockets alone.\n', {
        status: 426,
        headers: { Upgrade: 'websocket' }
      });
    }
    return env.MASTER.getByName('master').fetch(request);
  }
} satisfies ExportedHandler<Cloudflare.Env>;

/** The Durable Object the master runs in. */
export class MasterObject extends DurableObject {
  private readonly master = new MasterServer({
    // The master's records keep its times, so its clock is one a new object doesn't start again.
    now: () => Date.now(),
    lookup: (name) => lookup(name, { all: true })
  });
  /** The master's end of each WebSocket the object holds. */
  private readonly ends = new Map<WebSocket, ObjectEnd>();

  /**
   * An object made afresh, as one is after an eviction: the master is given back each WebSocket
   * the object holds, with the record the master kept in it, before the event that woke it.
   */
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    for (const ws of ctx.getWebSockets()) {
      // One the master refused as it connected holds none, and is held till its close is answered.
      const record = ws.deserializeAttachment() as ConnectionRecord | null;
      if (record !== null) this.master.restore(this.end(ws), record);
    }
  }

  fetch(request: Request): Response {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const ip = request.headers.get('CF-Connecting-IP') ?? '';
    this.master.connect(this.end(server), ip, SOURCE_PORT);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.ends.get(ws)?.message(message);
  }

  webSocketClose(ws: WebSocket): void {
    // The runtime doesn't answer a close under the hibernation API, so the object does.
    ws.close();
    this.closed(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.closed(ws);
  }

  /** The master's end of a WebSocket the object holds, its events passed on from now. */
  private end(ws: WebSocket): ObjectEnd {
    const end = new ObjectEnd(ws);
    this.ends.set(ws, end);
    return end;
  }

  private closed(ws: WebSocket): void {
    this.ends.get(ws)?.closed();
    this.ends.delete(ws);
  }
}

interface EndEvent {
  type: string;
  data?: unknown;
}

/**
 * The master's end of a WebSocket held by the hibernation API, whose events come to the object's
 * handlers rather than to listeners on the WebSocket: the object passes each on here.
 */
class ObjectEnd implements MasterWebSocket {
  /** Unread: a binary message comes to the object as an ArrayBuffer. */
  binaryType = 'arraybuffer';
  private readonly ws: WebSocket;
  /** By the type of event each listens for. */
  private readonly listeners = new Map<string, ((event: EndEvent) => void)[]>();

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  send(data: Uint8Array<ArrayBuffer>): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }

  serializeAttachment(record: ConnectionRecord): void {
    this.ws.serializeAttachment(record);
  }

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: EndEvent) => void): void;
  addEventListener(type: string, listener: (event: EndEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** A message the object was handed. */
  message(data: string | ArrayBuffer): void {
    this.dispatch({ type: 'message', data });
  }

  /** The WebSocket closed or failed, as the object was told. */
  closed(): void {
    this.dispatch({ type: 'close' });
  }

  private dispatch(event: EndEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}
