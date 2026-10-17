import { describe, expect, it } from 'vitest';

import { Loopback, MAX_LOOPBACK, MessageLoopback } from './loopback';

describe('the loopback', () => {
  it('delivers a message to the side it was addressed to, and not to the other', () => {
    const loopback = new Loopback();
    loopback.send('client', Uint8Array.of(1, 2, 3));

    expect(loopback.receive('server')).toBeNull();
    expect(loopback.receive('client')).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('delivers messages in the order they were sent', () => {
    const loopback = new Loopback();
    for (let i = 0; i < 5; i++) loopback.send('server', Uint8Array.of(i));

    const seen: number[] = [];
    for (;;) {
      const message = loopback.receive('server');
      if (message === null) break;
      seen.push(message[0]);
    }

    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it('copies what it is given, so the sender may reuse its buffer', () => {
    const loopback = new Loopback();
    const buffer = Uint8Array.of(7, 7, 7);
    loopback.send('client', buffer);
    buffer.fill(0);

    expect(loopback.receive('client')).toEqual(Uint8Array.of(7, 7, 7));
  });

  it('drops the oldest messages when a side does not read', () => {
    const loopback = new Loopback();
    for (let i = 0; i < MAX_LOOPBACK + 3; i++) loopback.send('client', Uint8Array.of(i));

    expect(loopback.pending('client')).toBe(MAX_LOOPBACK);

    const first = loopback.receive('client');
    expect(first?.[0]).toBe(3);
  });

  it('forgets everything on a clear, as a disconnect does', () => {
    const loopback = new Loopback();
    loopback.send('client', Uint8Array.of(1));
    loopback.send('server', Uint8Array.of(2));

    loopback.clear();

    expect(loopback.receive('client')).toBeNull();
    expect(loopback.receive('server')).toBeNull();
  });
});

describe('a loopback across a message channel', () => {
  it('posts a copy of what it is given, whose buffer the post may move', () => {
    const posted: { data: Uint8Array; transfer: Transferable[] }[] = [];
    const loopback = new MessageLoopback((data, transfer) => posted.push({ data, transfer }));
    const buffer = Uint8Array.of(7, 7, 7);

    loopback.send('client', buffer);
    buffer.fill(0);

    expect(posted).toHaveLength(1);
    expect(posted[0].data).toEqual(Uint8Array.of(7, 7, 7));
    expect(posted[0].transfer).toEqual([posted[0].data.buffer]);
  });

  it('queues what the other end delivered, in the order it arrived', () => {
    const loopback = new MessageLoopback(() => {});
    loopback.deliver(Uint8Array.of(1));
    loopback.deliver(Uint8Array.of(2));

    expect(loopback.receive('client')).toEqual(Uint8Array.of(1));
    expect(loopback.receive('client')).toEqual(Uint8Array.of(2));
    expect(loopback.receive('client')).toBeNull();
  });

  it('drops the oldest message when the other end has not read', () => {
    const loopback = new MessageLoopback(() => {});
    for (let i = 0; i < MAX_LOOPBACK + 3; i++) loopback.deliver(Uint8Array.of(i));

    expect(loopback.receive('client')?.[0]).toBe(3);
  });
});
