import type { PageToWorker } from './worker-messages';
import { startServerWorker } from './worker-server';

/**
 * A listen server's program, where its host runs: this worker. The page and the program
 * speak the messages of `worker-messages.ts`, and this is the boundary — nothing else.
 */
const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
};

const server = startServerWorker({
  post: (message, transfer) => scope.postMessage(message, transfer),
  onMessage: (listener) =>
    scope.addEventListener('message', (event) => listener(event.data as PageToWorker)),
  now: () => performance.now(),
  close: () => scope.close(),
  onError: (err) => console.error(err),
  // Chrome 130, Firefox 144 and Safari 15 move a data channel to a worker; an older browser has
  // no `RTCDataChannel` here.
  channels: typeof RTCDataChannel !== 'undefined'
});

// `while (1) Com_Frame();` (`sys_main.c:785–899`): the frames are the worker's own, on real time,
// and a worker's timers run however hidden the page is — which is why the host is here. Each wait
// is what `SV_FrameMsec` returns, so the frames keep their cadence whatever the timer's grain.
let last = performance.now();
const loop = (): void => {
  const started = performance.now();
  server.frame(started - last);
  last = started;
  setTimeout(loop, server.waitMsec(performance.now() - started));
};
loop();
