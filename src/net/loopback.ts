/**
 * The loopback — Quake 3's `net_chan.c:416–476`, the pair of queues a local game talks over.
 *
 * A Quake 3 client and server are the same program, and a single-player game is a client
 * connecting to a server inside its own process. It does not shortcut: the server encodes a real
 * message, the netchan puts it in packets, and the packets go into a queue for the client to take
 * out and decode. What crosses is bytes, and both halves run the code they would run over a wire.
 *
 * That is the point of it, and it is why the port keeps it rather than calling the game module
 * directly. The local player is a client like any other, so anything that works locally works
 * remotely, and anything the encoding gets wrong is wrong here too, where a test can see it.
 */

/**
 * `MAX_LOOPBACK` (`net_chan.c:424`): messages a side may hold before the oldest is dropped.
 *
 * Quake 3's comment says the depth exists to hold a complete gamestate, which is the largest
 * thing sent in one go.
 */
export const MAX_LOOPBACK = 16;

/** Which end of the loopback a message is going to, or being read from. */
export type LoopbackSide = 'client' | 'server';

/**
 * A loopback, as {@link Net} uses one: what a side sends goes to the other side, and what it
 * receives is what the other side sent. {@link Loopback} is the in-process one; a worker's host
 * puts a {@link MessageLoopback} on each end of its boundary.
 */
export interface LoopbackLike {
  /** Put a message in `to`'s queue, copying it. */
  send(to: LoopbackSide, data: Uint8Array): void;
  /** Take the next message from `side`'s queue, or null if there is none. */
  receive(side: LoopbackSide): Uint8Array | null;
}

interface LoopbackQueue {
  readonly messages: (Uint8Array | null)[];
  /** How many have been taken out. */
  get: number;
  /** How many have been put in. */
  send: number;
}

function createQueue(): LoopbackQueue {
  return { messages: new Array<Uint8Array | null>(MAX_LOOPBACK).fill(null), get: 0, send: 0 };
}

/**
 * The two queues, one per side, that a local client and its host exchange messages through.
 *
 * Quake 3 indexes a queue by the side that reads it, so sending means writing into the *other*
 * side's queue — `loopbacks[sock^1]` at `net_chan.c:469`. Naming the destination says the same
 * thing without the arithmetic.
 */
export class Loopback implements LoopbackLike {
  private readonly queues: Record<LoopbackSide, LoopbackQueue> = {
    client: createQueue(),
    server: createQueue()
  };

  /**
   * Put a message in a side's queue, copying it.
   *
   * The copy is what keeps the two halves honest: the sender goes on using its own buffer for the
   * next message, and a receiver that reached into it would be reading state rather than a
   * message, which is the mistake this whole arrangement exists to prevent.
   */
  send(to: LoopbackSide, data: Uint8Array): void {
    const queue = this.queues[to];
    const index = queue.send & (MAX_LOOPBACK - 1);
    queue.send++;
    queue.messages[index] = data.slice();
  }

  /**
   * Take the next message from a side's queue, or null if there is none.
   *
   * A side that has not read for a while loses the messages that overflowed, exactly as a slow
   * connection loses packets: the read index is dragged forward to the oldest message still held.
   */
  receive(side: LoopbackSide): Uint8Array | null {
    const queue = this.queues[side];

    if (queue.send - queue.get > MAX_LOOPBACK) {
      queue.get = queue.send - MAX_LOOPBACK;
    }

    if (queue.get >= queue.send) return null;

    const index = queue.get & (MAX_LOOPBACK - 1);
    queue.get++;
    const message = queue.messages[index];
    queue.messages[index] = null;
    return message;
  }

  /** How many messages are waiting for a side to read. */
  pending(side: LoopbackSide): number {
    const queue = this.queues[side];
    return Math.min(queue.send - queue.get, MAX_LOOPBACK);
  }

  /** Drop everything in both queues, as a disconnect does. */
  clear(): void {
    for (const side of ['client', 'server'] as const) {
      const queue = this.queues[side];
      queue.messages.fill(null);
      queue.get = 0;
      queue.send = 0;
    }
  }
}

/**
 * A loopback whose other end is across a message channel — a worker's boundary. What a
 * side sends is handed to the post, and what arrives from the other end is queued here for the
 * side to read. Each end has exactly one peer, so which side a message is going to is always the
 * peer's, and neither the post nor a delivery has to say.
 *
 * The queue is capped as the in-process one is: an end that has not read for a while, a page
 * whose frames have stopped among them, loses the oldest messages as a slow link loses packets.
 */
export class MessageLoopback implements LoopbackLike {
  private readonly queue: Uint8Array[] = [];
  /**
   * Where a message leaves this end: the other end's delivery. The message's buffer is handed over
   * with it, for the post to move rather than copy.
   */
  private readonly post: (data: Uint8Array, transfer: Transferable[]) => void;

  /** @param post - Where a message leaves this end: the other end's delivery. */
  constructor(post: (data: Uint8Array, transfer: Transferable[]) => void) {
    this.post = post;
  }

  send(_to: LoopbackSide, data: Uint8Array): void {
    // The copy is the in-process loopback's, for the same reason: the sender goes on using its
    // own buffer, and the peer gets the message rather than whatever is written there next. The
    // copy moves where the peer is another scope, so the crossing copies nothing.
    const copy = data.slice();
    this.post(copy, [copy.buffer]);
  }

  receive(_side: LoopbackSide): Uint8Array | null {
    return this.queue.shift() ?? null;
  }

  /** A message that arrived from the other end. */
  deliver(data: Uint8Array): void {
    if (this.queue.length >= MAX_LOOPBACK) this.queue.shift();
    this.queue.push(data);
  }
}
