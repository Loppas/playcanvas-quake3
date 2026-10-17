import { runJob, type DecodeJob } from './decode-jobs';

/**
 * The decode worker: pak entries inflated and TGAs decoded off the page's thread. The page and
 * this speak the messages of `decode-jobs.ts`, and this is the boundary — nothing else.
 */
const scope = self as unknown as {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<DecodeJob>) => void): void;
};

scope.addEventListener('message', (event) => {
  const { answer, transfer } = runJob(event.data);
  scope.postMessage(answer, transfer);
});
