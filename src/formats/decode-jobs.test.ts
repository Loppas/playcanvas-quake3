import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { havePak0, openPak } from '../pak/pak-test-fixtures';
import { inflateEntry } from '../pak/zip';
import { runJob, type DecodeAnswer } from './decode-jobs';
import { decodeTga, type DecodedImage } from './tga';

/** A 2×2 true-colour TGA stored bottom row first, so the decode flips it. */
function bottomUpTga(): Uint8Array {
  const header = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 24, 0];
  return new Uint8Array([...header, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
}

const text = new TextEncoder().encode(
  'textures/base_wall/basewall01 { qer_editorimage x }\n'.repeat(40)
);

/** What an answer carries, for a job that worked. */
const valueOf = <T extends Uint8Array | DecodedImage>(answer: DecodeAnswer) =>
  (answer as { value: Uint8Array | DecodedImage }).value as T;

/** Byte for byte, without a deep equality's walk of a quarter-million texels. */
const same = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);

describe('runJob', () => {
  it('inflates as the main thread does, moving back only what it made', () => {
    const payload = deflateSync(text);
    const { answer, transfer } = runJob({ id: 3, kind: 'inflate', payload, size: text.byteLength });
    expect(answer.id).toBe(3);
    const value = valueOf<Uint8Array>(answer);
    expect(value).toEqual(inflateEntry(payload, text.byteLength));
    expect(value).toEqual(text);
    // By identity: a deep equality finds any two buffers equal.
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(value.buffer);
  });

  it('decodes a TGA as the main thread does, moving back only its texels', () => {
    const bytes = bottomUpTga();
    const { answer, transfer } = runJob({ id: 4, kind: 'tga', bytes, label: 'a.tga' });
    const value = valueOf<DecodedImage>(answer);
    expect(value).toEqual(decodeTga(bottomUpTga(), 'a.tga'));
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(value.pixels.buffer);
  });

  it("answers a job that fails with the main thread's message, and moves nothing", () => {
    const label = 'models/broken.tga';
    const tga = runJob({ id: 5, kind: 'tga', bytes: new Uint8Array(4), label });
    expect(tga.answer).toEqual({ id: 5, error: 'models/broken.tga: too short to be a TGA' });
    expect(tga.transfer).toEqual([]);

    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    let thrown = '';
    try {
      inflateEntry(garbage, 16);
    } catch (err) {
      thrown = (err as Error).message;
    }
    expect(thrown).not.toBe('');
    const inflate = runJob({ id: 6, kind: 'inflate', payload: garbage, size: 16 });
    expect(inflate.answer).toEqual({ id: 6, error: thrown });
  });
});

// Guarded against the user's install — skipped on a clean checkout.
describe.skipIf(!havePak0)('runJob against retail pak0.pk3', () => {
  it("inflates and decodes sarge's files to the bytes the main thread makes of them", async () => {
    const pak0 = await openPak('pak0.pk3');
    const names = pak0.names().filter((name) => name.startsWith('models/players/sarge/'));
    let tgas = 0;
    for (const [id, name] of names.entries()) {
      const entry = pak0.entry(name)!;
      const bytes = (await pak0.read(name))!;
      if (entry.compressionMethod === 8) {
        const payload = await pak0.readRaw(entry);
        const job = runJob({ id, kind: 'inflate', payload, size: entry.uncompressedSize });
        expect(same(valueOf<Uint8Array>(job.answer), bytes), name).toBe(true);
      }
      if (name.endsWith('.tga')) {
        tgas++;
        const image = valueOf<DecodedImage>(runJob({ id, kind: 'tga', bytes, label: name }).answer);
        const here = decodeTga(bytes, name);
        expect([image.width, image.height], name).toEqual([here.width, here.height]);
        expect(same(image.pixels, here.pixels), name).toBe(true);
      }
    }
    // Sarge's skins are TGAs, so the decode was tried.
    expect(tgas).toBeGreaterThan(0);
  });
});
