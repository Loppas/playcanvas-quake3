import { inflateEntry } from '../pak/zip';
import { decodeTga, type DecodedImage } from './tga';

/**
 * The decode worker's work, and the messages the page and the worker speak (`decode-worker.ts`,
 * `decoder.ts`). Each job is done by the same function the main thread would call, so the bytes
 * that come back are those it would have made.
 */

/** A job the page posts, its bytes moved across. */
export type DecodeJob =
  | { id: number; kind: 'inflate'; payload: Uint8Array; size: number }
  | { id: number; kind: 'tga'; bytes: Uint8Array; label: string };

/** The worker's answer to a job: what it made, or why it could not. */
export type DecodeAnswer =
  | { id: number; value: Uint8Array | DecodedImage }
  | { id: number; error: string };

/** Do a job as the worker does: its answer, and the buffers the answer moves back. */
export function runJob(job: DecodeJob): { answer: DecodeAnswer; transfer: Transferable[] } {
  const { id } = job;
  try {
    if (job.kind === 'inflate') {
      const value = inflateEntry(job.payload, job.size);
      return { answer: { id, value }, transfer: [value.buffer] };
    }
    const value = decodeTga(job.bytes, job.label);
    return { answer: { id, value }, transfer: [value.pixels.buffer] };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { answer: { id, error }, transfer: [] };
  }
}
