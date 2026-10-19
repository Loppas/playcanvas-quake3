import { lookup } from 'node:dns/promises';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { MasterLink, type WebSocketLike } from '../src/net/master-link';
import type { Resolved } from '../src/net/master-protocol';
import { FakeRtc } from '../src/net/peer-test-fixtures';
import { MASTER_ADR } from './master-test-fixtures';
import { startMaster } from './node-master';

/** The master as Node runs it, on `ws` and Node's `dns.lookup`, at a link over a real WebSocket. */

describe('the master on Node', () => {
  const closers: (() => void)[] = [];

  afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
  });

  it("looks a name up with Node's dns.lookup, answering with every address it has", async () => {
    const master = await startMaster({
      createPeerConnection: new FakeRtc().create,
      print: () => {},
      port: 0
    });
    closers.push(() => master.close());
    // `ws`'s WebSocket is the link's as it is.
    const ws: WebSocketLike = new WebSocket(`ws://127.0.0.1:${master.port}`);
    const link = new MasterLink(MASTER_ADR, ws);
    closers.push(() => link.close());

    const answered = new Promise<Resolved>((resolve) => (link.onResolved = resolve));
    link.send({ kind: 'resolve', name: 'localhost', port: 27960 });
    const answer = await answered;

    const found = await lookup('localhost', { all: true });
    expect(answer.error).toBeNull();
    expect(answer.addresses.map((adr) => adr.ip).sort()).toEqual(
      found.map(({ address }) => address).sort()
    );
  });
});
