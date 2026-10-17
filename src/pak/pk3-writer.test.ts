import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { memorySource } from './byte-source';
import { rawEntry, writePk3, type RawZipEntry } from './pk3-writer';
import { ZipArchive } from './zip';

const text = (s: string) => new TextEncoder().encode(s);

/** An archive's bytes, gathered from the writer's chunks. */
async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Every entry of an archive, read as stored, in its central directory's order. */
function rawEntriesOf(archive: ZipArchive): Promise<RawZipEntry[]> {
  return Promise.all(archive.names().map((name) => rawEntry(archive, archive.entry(name)!)));
}

/** A pak with a deflated entry, a stored one, and a name spelled in capitals. */
async function source(): Promise<ZipArchive> {
  const zip = zipSync(
    {
      'scripts/gfx.shader': text('shader stub\n'.repeat(64)),
      'models/a.md3': [text('IDP3'), { level: 0 }],
      'MODELS/Upper/B.TGA': text('upper')
    },
    { level: 6 }
  );
  return ZipArchive.open(memorySource('pak0.pk3', zip));
}

describe('writePk3', () => {
  it('copies stored and deflated entries as stored, and they read back byte-identical', async () => {
    const from = await source();
    expect(from.entry('scripts/gfx.shader')!.compressionMethod).toBe(8);
    expect(from.entry('models/a.md3')!.compressionMethod).toBe(0);

    const bytes = await collect(writePk3(await rawEntriesOf(from)));
    const copy = await ZipArchive.open(memorySource('copy.pk3', bytes));

    expect(copy.names()).toEqual(from.names());
    for (const name of from.names()) {
      const [was, is] = [from.entry(name)!, copy.entry(name)!];
      expect(is.rawName).toBe(was.rawName);
      expect([is.compressionMethod, is.crc32, is.compressedSize, is.uncompressedSize]).toEqual([
        was.compressionMethod,
        was.crc32,
        was.compressedSize,
        was.uncompressedSize
      ]);
      expect(await copy.readRaw(is), name).toEqual(await from.readRaw(was));
      expect(await copy.read(name), name).toEqual(await from.read(name));
    }
  });

  it('writes a zip that another reader opens', async () => {
    const from = await source();
    const unzipped = unzipSync(await collect(writePk3(await rawEntriesOf(from))));
    expect(Object.keys(unzipped)).toEqual(['scripts/gfx.shader', 'models/a.md3', 'MODELS/Upper/B.TGA']);
    expect(new TextDecoder().decode(unzipped['MODELS/Upper/B.TGA'])).toBe('upper');
  });

  it('writes the same bytes for the same entries', async () => {
    const entries = await rawEntriesOf(await source());
    expect(await collect(writePk3(entries))).toEqual(await collect(writePk3(entries)));
  });

  it('writes an empty archive as its end record alone', async () => {
    const bytes = await collect(writePk3([]));
    expect(bytes.byteLength).toBe(22);
    expect((await ZipArchive.open(memorySource('empty.pk3', bytes))).size).toBe(0);
  });

  it("refuses a payload that isn't its compressed size", async () => {
    const entry: RawZipEntry = {
      name: 'a.txt',
      compressionMethod: 0,
      crc32: 0,
      compressedSize: 4,
      uncompressedSize: 4,
      payload: text('abc')
    };
    await expect(collect(writePk3([entry]))).rejects.toThrow('a.txt has 3 bytes, not its 4');
  });

  it('refuses more entries than a zip without zip64 records', async () => {
    function* many(): Generator<RawZipEntry> {
      for (let i = 0; i < 0xffff; i++) {
        yield {
          name: `e${i}`,
          compressionMethod: 0,
          crc32: 0,
          compressedSize: 0,
          uncompressedSize: 0,
          payload: new Uint8Array(0)
        };
      }
    }
    await expect(collect(writePk3(many()))).rejects.toThrow(RangeError);
  });
});
