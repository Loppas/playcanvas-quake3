import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { inflateEntry } from '../pak/zip';
import { runJob, type DecodeAnswer, type DecodeJob } from './decode-jobs';
import { Decoder, type DecodeWorker } from './decoder';
import { decodeTga } from './tga';

/**
 * A worker on this thread: each job and answer crosses by a structured clone that moves the
 * buffers it is told to, as `postMessage` does, and the answers wait to be let go, so a test
 * decides their order.
 */
class StandInWorker implements DecodeWorker {
  readonly held: DecodeAnswer[] = [];
  private listener: (answer: DecodeAnswer) => void = () => {};

  postMessage(job: DecodeJob, transfer: Transferable[]): void {
    const { answer, transfer: back } = runJob(structuredClone(job, { transfer }));
    this.held.push(structuredClone(answer, { transfer: back }));
  }

  onMessage(listener: (answer: DecodeAnswer) => void): void {
    this.listener = listener;
  }

  /** Let the held answers go, in the order given by their place in {@link held}. */
  answer(order = this.held.map((_, i) => i)): void {
    const answers = order.map((i) => this.held[i]);
    this.held.length = 0;
    for (const answer of answers) this.listener(answer);
  }
}

/** A 2×2 true-colour TGA stored bottom row first. */
const tga = () =>
  new Uint8Array([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 24, 0, ...Array(12).keys()]);

const text = new TextEncoder().encode('sound/player/sarge/death1.wav\n'.repeat(50));

describe('Decoder', () => {
  it('inflates and decodes as the main thread does, leaving the caller its bytes', async () => {
    const worker = new StandInWorker();
    const decoder = new Decoder(worker);
    // The payload as a read gives it: a view into a larger buffer.
    const read = new Uint8Array([9, 9, ...deflateSync(text), 9]);
    const payload = read.subarray(2, read.byteLength - 1);
    const bytes = tga();
    const inflated = decoder.inflate(payload, text.byteLength);
    const decoded = decoder.decodeTga(bytes, 'models/a.tga');
    worker.answer();

    expect(await inflated).toEqual(inflateEntry(payload, text.byteLength));
    expect(await decoded).toEqual(decodeTga(tga(), 'models/a.tga'));
    // Copies went across: what the caller holds is still whole.
    expect(read.byteLength).toBe(payload.byteLength + 3);
    expect(bytes).toEqual(tga());
  });

  it('matches each answer to its job, whatever order they come back in', async () => {
    const worker = new StandInWorker();
    const decoder = new Decoder(worker);
    const first = decoder.inflate(deflateSync(text), text.byteLength);
    const second = decoder.decodeTga(tga(), 'models/b.tga');
    worker.answer([1, 0]);
    expect(await first).toEqual(text);
    expect((await second).width).toBe(2);
  });

  it("rejects a job that fails with the main thread's message, and does the next", async () => {
    const worker = new StandInWorker();
    const decoder = new Decoder(worker);
    const broken = decoder.decodeTga(new Uint8Array(4), 'models/broken.tga');
    const next = decoder.inflate(deflateSync(text), text.byteLength);
    worker.answer();
    await expect(broken).rejects.toThrow('models/broken.tga: too short to be a TGA');
    expect(await next).toEqual(text);
  });
});
