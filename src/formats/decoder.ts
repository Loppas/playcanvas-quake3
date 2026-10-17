import type { DecodeAnswer, DecodeJob } from './decode-jobs';
import type { DecodedImage } from './tga';

/** The little of a `Worker` a decoder needs, so that a test can stand in for one. */
export interface DecodeWorker {
  postMessage(job: DecodeJob, transfer: Transferable[]): void;
  /** Hear the worker's answers. */
  onMessage(listener: (answer: DecodeAnswer) => void): void;
}

interface Waiting {
  resolve(value: Uint8Array | DecodedImage): void;
  reject(error: Error): void;
}

/**
 * The page's end of the decode worker (`decode-worker.ts`): each job posted with a copy of its
 * bytes moved across, and its answer matched back by its id. A job that fails rejects with the
 * message the main thread's call would have thrown.
 */
export class Decoder {
  private readonly worker: DecodeWorker;
  private readonly waiting = new Map<number, Waiting>();
  private next = 0;

  /**
   * @param worker the worker: the page's own, built from `decode-worker.ts`, unless one is given
   */
  constructor(worker: DecodeWorker = pageWorker()) {
    this.worker = worker;
    worker.onMessage((answer) => {
      const waiting = this.waiting.get(answer.id)!;
      this.waiting.delete(answer.id);
      if ('error' in answer) waiting.reject(new Error(answer.error));
      else waiting.resolve(answer.value);
    });
  }

  /** `inflateEntry`, in the worker. */
  readonly inflate = (payload: Uint8Array, size: number): Promise<Uint8Array> => {
    // A copy goes across, since the payload is a view of whatever buffer its read filled.
    const own = payload.slice();
    return this.post({ id: this.next++, kind: 'inflate', payload: own, size }, own.buffer);
  };

  /** `decodeTga`, in the worker. */
  readonly decodeTga = (bytes: Uint8Array, label: string): Promise<DecodedImage> => {
    // A copy goes across, since the library keeps the file's bytes.
    const own = bytes.slice();
    return this.post({ id: this.next++, kind: 'tga', bytes: own, label }, own.buffer);
  };

  /** Post a job, moving `buffer` across, and wait for its answer. */
  private post<T extends Uint8Array | DecodedImage>(job: DecodeJob, buffer: ArrayBuffer) {
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(job.id, { resolve: resolve as Waiting['resolve'], reject });
      this.worker.postMessage(job, [buffer]);
    });
  }
}

/** The page's own decode worker. */
function pageWorker(): DecodeWorker {
  const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' });
  return {
    postMessage: (job, transfer) => worker.postMessage(job, transfer),
    onMessage: (listener) => {
      worker.onmessage = (event: MessageEvent<DecodeAnswer>) => listener(event.data);
    }
  };
}
