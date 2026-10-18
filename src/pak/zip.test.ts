import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { memorySource } from './byte-source';
import { nodeFileSource } from './node-source';
import {
  PROBE_ENTRY,
  bytesRead,
  countReads,
  havePak0,
  openPak,
  pakPath
} from './pak-test-fixtures';
import { EOCD_SEARCH_CHUNK, ZipArchive, inflateEntry, inflateWith, normalizePakPath } from './zip';

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

const open = (bytes: Uint8Array, label = 'synthetic.pk3') =>
  ZipArchive.open(memorySource(label, bytes));

const SHADER_TEXT = 'shader stub\n'.repeat(64);

/** A synthetic pk3 with both compression methods and a Windows-style uppercase path. */
function buildArchive(): Uint8Array {
  const body = new TextEncoder().encode(SHADER_TEXT);
  return zipSync(
    {
      'scripts/gfx.shader': body,
      // level 0 stores the entry uncompressed, so both zip methods are exercised.
      'models/weapons2/rocketl/rocketl.md3': [new Uint8Array([0x49, 0x44, 0x50, 0x33]), { level: 0 }],
      'MODELS/Weapons2/Shotgun/SHOTGUN.MD3': new TextEncoder().encode('uppercase')
    },
    { level: 6 }
  );
}

/** Append a comment of `length` bytes, patching the end record's comment length to match. */
function withComment(zip: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(zip.byteLength + length).fill(0x20);
  out.set(zip);
  new DataView(out.buffer).setUint16(zip.byteLength - 2, length, true);
  return out;
}

/** Splice `insert` in just before the end record of a zip that has no comment. */
function beforeEndRecord(zip: Uint8Array, insert: Uint8Array): Uint8Array {
  const eocd = zip.byteLength - 22;
  const out = new Uint8Array(zip.byteLength + insert.byteLength);
  out.set(zip.subarray(0, eocd));
  out.set(insert, eocd);
  out.set(zip.subarray(eocd), eocd + insert.byteLength);
  return out;
}

/**
 * A one-entry stored zip written by hand, so its local and central extra fields can differ in
 * length, which zipSync never does. The extra fields are zeros; nothing reads them.
 */
function handZip(name: string, data: Uint8Array, localExtra: number, centralExtra: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const localSize = 30 + nameBytes.length + localExtra;
  const centralSize = 46 + nameBytes.length + centralExtra;
  const directory = localSize + data.length;
  const eocd = directory + centralSize;
  const out = new Uint8Array(eocd + 22);
  const view = new DataView(out.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, localExtra, true);
  out.set(nameBytes, 30);
  out.set(data, localSize);

  view.setUint32(directory, 0x02014b50, true);
  view.setUint32(directory + 20, data.length, true);
  view.setUint32(directory + 24, data.length, true);
  view.setUint16(directory + 28, nameBytes.length, true);
  view.setUint16(directory + 30, centralExtra, true);
  out.set(nameBytes, directory + 46);

  view.setUint32(eocd, 0x06054b50, true);
  view.setUint16(eocd + 8, 1, true);
  view.setUint16(eocd + 10, 1, true);
  view.setUint32(eocd + 12, centralSize, true);
  view.setUint32(eocd + 16, directory, true);
  return out;
}

describe('normalizePakPath', () => {
  it('lowercases and forward-slashes, as Q3 does at index time', () => {
    expect(normalizePakPath('MODELS\\Weapons2\\RocketL\\ROCKETL.MD3')).toBe(
      'models/weapons2/rocketl/rocketl.md3'
    );
  });

  it('strips leading separators so absolute-looking references still resolve', () => {
    expect(normalizePakPath('/scripts/gfx.shader')).toBe('scripts/gfx.shader');
    expect(normalizePakPath('./scripts/gfx.shader')).toBe('scripts/gfx.shader');
  });
});

describe('ZipArchive', () => {
  it('indexes every file entry and excludes directories', async () => {
    const archive = await open(buildArchive());
    expect(archive.size).toBe(3);
    expect(archive.names()).toContain('scripts/gfx.shader');
    expect(archive.names().some((n) => n.endsWith('/'))).toBe(false);
  });

  it('reads an entry as stored, without inflating it', async () => {
    const archive = await open(buildArchive());
    const stored = archive.entry('models/weapons2/rocketl/rocketl.md3')!;
    expect(await archive.readRaw(stored)).toEqual(new Uint8Array([0x49, 0x44, 0x50, 0x33]));

    const deflated = archive.entry('scripts/gfx.shader')!;
    const raw = await archive.readRaw(deflated);
    expect(raw.byteLength).toBe(deflated.compressedSize);
    expect(raw.byteLength).toBeLessThan(deflated.uncompressedSize);
    expect(text(await archive.read('scripts/gfx.shader'))).toBe(SHADER_TEXT);
  });

  it('inflates deflated entries', async () => {
    const archive = await open(buildArchive());
    expect(text(await archive.read('scripts/gfx.shader'))).toBe(SHADER_TEXT);
  });

  it('returns stored entries verbatim', async () => {
    const archive = await open(buildArchive());
    // "IDP3" — the MD3 magic, so the stored path is proven byte-exact.
    expect([...(await archive.read(PROBE_ENTRY))!]).toEqual([0x49, 0x44, 0x50, 0x33]);
  });

  it('looks up case-insensitively regardless of how the entry was authored', async () => {
    const archive = await open(buildArchive());
    expect(text(await archive.read('models/weapons2/shotgun/shotgun.md3'))).toBe('uppercase');
    expect(text(await archive.read('MODELS/WEAPONS2/SHOTGUN/SHOTGUN.MD3'))).toBe('uppercase');
    expect(archive.entry('models/weapons2/shotgun/shotgun.md3')?.rawName).toBe(
      'MODELS/Weapons2/Shotgun/SHOTGUN.MD3'
    );
  });

  it('resolves backslash-separated references, as pk3s authored on Windows contain', async () => {
    const archive = await open(buildArchive());
    expect(text(await archive.read('scripts\\gfx.shader'))).toBe(SHADER_TEXT);
  });

  it('returns undefined for a path it does not hold', async () => {
    const archive = await open(buildArchive());
    expect(await archive.read('models/weapons2/bfg/bfg.md3')).toBeUndefined();
  });

  it('rejects a buffer that is not a zip, naming it', async () => {
    await expect(open(new Uint8Array(512), 'junk.pk3')).rejects.toThrow(
      /junk\.pk3: not a zip archive/
    );
    await expect(open(new Uint8Array(10), 'tiny.pk3')).rejects.toThrow(/not a zip archive/);
  });

  it('finds the directory when the archive carries a trailing comment', async () => {
    // The EOCD is no longer the last 22 bytes, so the backwards scan is what makes this work.
    expect((await open(withComment(buildArchive(), 5))).size).toBe(3);
  });

  it('refuses zip64 by its sentinel directory offset', async () => {
    const zip = buildArchive();
    new DataView(zip.buffer).setUint32(zip.byteLength - 22 + 16, 0xffffffff, true);
    await expect(open(zip)).rejects.toThrow(/zip64 archives are not supported/);
  });

  it('refuses zip64 by its locator, fetching it when the search stopped just past it', async () => {
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
    // The comment puts the end record at the very start of the first read, so the locator's
    // 20 bytes before it are outside what the search read.
    const zip = withComment(beforeEndRecord(buildArchive(), locator), EOCD_SEARCH_CHUNK - 22);
    await expect(open(zip)).rejects.toThrow(/zip64 archives are not supported/);
  });

  it('rejects a corrupt central directory instead of indexing garbage', async () => {
    const zip = buildArchive();
    const view = new DataView(zip.buffer);
    const directory = view.getUint32(zip.byteLength - 22 + 16, true);
    // A name length that runs the first record past the directory's end.
    view.setUint16(directory + 28, 0xffff, true);
    await expect(open(zip)).rejects.toThrow(/corrupt central directory at entry 0/);
  });

  it('rejects a directory that runs into its own end record, as minizip does', async () => {
    const zip = buildArchive();
    const view = new DataView(zip.buffer);
    const sizeField = zip.byteLength - 22 + 12;
    view.setUint32(sizeField, view.getUint32(sizeField, true) + 1, true);
    await expect(open(zip)).rejects.toThrow(/overruns its end record/);
  });

  it('rejects reading an entry whose local header is gone', async () => {
    const zip = buildArchive();
    const archive = await open(zip);
    // A memory source reads views, so this corrupts what it serves from now on.
    zip[archive.entry('scripts/gfx.shader')!.localHeaderOffset] = 0;
    await expect(archive.read('scripts/gfx.shader')).rejects.toThrow(/has no local header/);
  });
});

describe('ZipArchive: inflating elsewhere', () => {
  afterEach(() => inflateWith(inflateEntry));

  it('inflates a deflated entry by the inflater it is given, a stored one by none', async () => {
    const archive = await open(buildArchive());
    const asked: number[] = [];
    // As the page's worker does: later, and by the same function.
    inflateWith(async (payload, size) => {
      asked.push(size);
      await new Promise((resolve) => setTimeout(resolve));
      return inflateEntry(payload, size);
    });
    expect(text(await archive.read('scripts/gfx.shader'))).toBe(SHADER_TEXT);
    expect([...(await archive.read(PROBE_ENTRY))!]).toEqual([0x49, 0x44, 0x50, 0x33]);
    expect(asked).toEqual([SHADER_TEXT.length]);
  });

  it("rejects a read whose inflater fails, with the inflater's error", async () => {
    const archive = await open(buildArchive());
    inflateWith(() => Promise.reject(new Error('invalid block type')));
    await expect(archive.read('scripts/gfx.shader')).rejects.toThrow('invalid block type');
  });
});

describe('ZipArchive: the end-record search', () => {
  // The record starts 22 + comment bytes from the end, and the first read covers the last
  // EOCD_SEARCH_CHUNK bytes. These comments put the record's signature at the start of that
  // read, across its start by one to three bytes, just below it, and wholly in the next read.
  const atBoundary = EOCD_SEARCH_CHUNK - 22;

  it.each([
    ['at the start of the first read', atBoundary],
    ['across the boundary, one byte below it', atBoundary + 1],
    ['across the boundary, two bytes below it', atBoundary + 2],
    ['across the boundary, three bytes below it', atBoundary + 3],
    ['just below the boundary, the rest of the record above it', atBoundary + 4],
    ['wholly inside the second read', atBoundary + 100]
  ])('finds the record %s', async (_where, comment) => {
    const archive = await open(withComment(buildArchive(), comment));
    expect(archive.size).toBe(3);
    expect(text(await archive.read('scripts/gfx.shader'))).toBe(SHADER_TEXT);
  });

  it('reads backwards a chunk at a time, not the whole tail at once', async () => {
    const zip = withComment(buildArchive(), atBoundary + 100);
    const source = countReads(memorySource('commented.pk3', zip));
    await ZipArchive.open(source);
    // The second read reaches the start of this small file.
    expect(source.reads.slice(0, 2)).toEqual([
      [zip.byteLength - EOCD_SEARCH_CHUNK, EOCD_SEARCH_CHUNK],
      [0, zip.byteLength - EOCD_SEARCH_CHUNK]
    ]);
  });

  it('gives up at the longest comment a zip can carry', async () => {
    const size = 200_000;
    const source = countReads(memorySource('junk.pk3', new Uint8Array(size)));
    await expect(ZipArchive.open(source)).rejects.toThrow(/not a zip archive/);
    expect(Math.min(...source.reads.map(([offset]) => offset))).toBe(size - 22 - 0xffff);
  });

  it('finds a record behind the longest comment a zip can carry', async () => {
    expect((await open(withComment(buildArchive(), 0xffff))).size).toBe(3);
  });
});

describe('ZipArchive: reading by range', () => {
  it('opens a small archive in one read, because the tail holds its directory', async () => {
    const source = countReads(memorySource('small.pk3', buildArchive()));
    await ZipArchive.open(source);
    expect(source.reads).toHaveLength(1);
  });

  it('reads a directory beyond the tail in one more read', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `textures/a/long/directory/name/${i}.tga`,
        new Uint8Array([i & 0xff])
      ])
    );
    const source = countReads(memorySource('wide.pk3', zipSync(files, { level: 0 })));
    expect((await ZipArchive.open(source)).size).toBe(300);
    expect(source.reads).toHaveLength(2);
  });

  it('reads a stored and a deflated entry in one read each, never an unrelated one', async () => {
    const zip = zipSync(
      {
        'maps/big.bsp': [new Uint8Array(1 << 20).fill(0x41), { level: 0 }],
        'models/stored.md3': [new Uint8Array([0x49, 0x44, 0x50, 0x33]), { level: 0 }],
        'scripts/gfx.shader': new TextEncoder().encode(SHADER_TEXT),
        // Keeps the tail's first read clear of big.bsp, so any read of its bytes is a real one.
        'pad.bin': [new Uint8Array(2 * EOCD_SEARCH_CHUNK), { level: 0 }]
      },
      { level: 6 }
    );
    const source = countReads(memorySource('ranged.pk3', zip));
    const archive = await ZipArchive.open(source);
    const opening = source.reads.length;

    expect(archive.entry('models/stored.md3')!.compressionMethod).toBe(0);
    expect(archive.entry('scripts/gfx.shader')!.compressionMethod).toBe(8);
    expect([...(await archive.read('models/stored.md3'))!]).toEqual([0x49, 0x44, 0x50, 0x33]);
    expect(text(await archive.read('scripts/gfx.shader'))).toBe(SHADER_TEXT);
    expect(source.reads).toHaveLength(opening + 2);

    // big.bsp runs from its local header to the next entry's.
    const bigStart = archive.entry('maps/big.bsp')!.localHeaderOffset;
    const bigEnd = archive.entry('models/stored.md3')!.localHeaderOffset;
    for (const [offset, length] of source.reads) {
      expect(offset + length <= bigStart || offset >= bigEnd, `read ${offset}+${length}`).toBe(true);
    }
    expect(bytesRead(source)).toBeLessThan(2 * EOCD_SEARCH_CHUNK);
  });

  it("ends a read at its neighbour's local header, the last at the directory", async () => {
    // A splat map's octree, two entries read at once and each far shorter than the slack, so a
    // read that ran past its own entry would overlap the other's.
    const json = new TextEncoder().encode('{"version":1}');
    const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const zip = zipSync({ 'maps/x.voxel.json': json, 'maps/x.voxel.bin': bin }, { level: 0 });
    const source = countReads(memorySource('neighbours.pk3', zip));
    const archive = await ZipArchive.open(source);
    const opening = source.reads.length;

    const [readJson, readBin] = await Promise.all([
      archive.read('maps/x.voxel.json'),
      archive.read('maps/x.voxel.bin')
    ]);
    expect(readJson).toEqual(json);
    expect(readBin).toEqual(bin);
    const first = archive.entry('maps/x.voxel.json')!.localHeaderOffset;
    const second = archive.entry('maps/x.voxel.bin')!.localHeaderOffset;
    const directory = new DataView(zip.buffer).getUint32(zip.byteLength - 22 + 16, true);
    expect(source.reads.slice(opening)).toEqual([
      [first, second - first],
      [second, directory - second]
    ]);
  });

  it('ends a read at the local header of a directory entry after it', async () => {
    // A nested folder is written as a directory entry, `maps/`, between the two files.
    const zip = zipSync(
      { 'x.txt': new Uint8Array(4), maps: { 'x.voxel.bin': new Uint8Array(4) } },
      { level: 0 }
    );
    const source = countReads(memorySource('folders.pk3', zip));
    const archive = await ZipArchive.open(source);
    const opening = source.reads.length;

    await archive.read('x.txt');
    const [[offset, length], ...more] = source.reads.slice(opening);
    expect(more).toEqual([]);
    expect(offset).toBe(archive.entry('x.txt')!.localHeaderOffset);
    // What follows the read is a local header short of the next file's: the directory entry's.
    const end = offset + length;
    expect(new DataView(zip.buffer).getUint32(end, true)).toBe(0x04034b50);
    expect(end).toBeLessThan(archive.entry('maps/x.voxel.bin')!.localHeaderOffset);
  });

  it('reads the payload again when the local extra field outruns the central one', async () => {
    const data = new TextEncoder().encode('payload behind a long local extra field');
    const name = 'models/x.md3';
    const source = countReads(memorySource('extra.pk3', handZip(name, data, 1000, 0)));
    const archive = await ZipArchive.open(source);
    const opening = source.reads.length;

    expect(text(await archive.read(name))).toBe(text(data));
    // The first read took the header at the central record's lengths plus some slack; the
    // payload starts 1000 bytes of extra field in, past it, so it was read again, exactly.
    const reads = source.reads.slice(opening);
    expect(reads).toHaveLength(2);
    expect(reads[1]).toEqual([30 + name.length + 1000, data.byteLength]);
  });

  it('tells the progress of the reads that carry the payload, before inflating it', async () => {
    const data = new TextEncoder().encode('payload behind a long local extra field');
    const name = 'models/x.md3';
    const source = countReads(memorySource('extra.pk3', handZip(name, data, 1000, 0)));
    const archive = await ZipArchive.open(source);
    const opening = source.reads.length;
    const heard: [number, number][] = [];

    await archive.read(name, (received, total) => heard.push([received, total]));
    // Both reads: the header with its slack, then the payload behind the long extra field.
    expect(heard).toEqual(source.reads.slice(opening).map(([, length]) => [length, length]));

    const deflated = await ZipArchive.open(memorySource('d.pk3', buildArchive()));
    const told: number[] = [];
    await deflated.read('scripts/gfx.shader', (received) => told.push(received));
    expect(told).toHaveLength(1);
  });

  it('needs one read when the local extra field is the shorter one', async () => {
    const data = new TextEncoder().encode('payload');
    const source = countReads(memorySource('extra.pk3', handZip('models/x.md3', data, 0, 40)));
    const archive = await ZipArchive.open(source);
    const opening = source.reads.length;
    expect(text(await archive.read('models/x.md3'))).toBe('payload');
    expect(source.reads.length - opening).toBe(1);
  });
});

// Guarded against the user's install — skipped on a clean checkout.
describe.skipIf(!havePak0)('ZipArchive against retail pak0.pk3', () => {
  it('indexes the retail archive and finds a known weapon model', async () => {
    const pak0 = await openPak('pak0.pk3');
    // Measured from the retail pak0, then pinned.
    // A mismatch here means a different pak0, not a decoder bug.
    expect(pak0.size).toBe(3357);

    const entry = pak0.entry(PROBE_ENTRY);
    expect(entry).toBeDefined();
    expect(entry!.uncompressedSize).toBe(12608);
    expect(entry!.compressionMethod).toBe(8);
  });

  it('opens by reading its tail and its directory, not the pak', async () => {
    const source = countReads(nodeFileSource(pakPath('pak0.pk3')));
    await ZipArchive.open(source);
    // Measured, then pinned: the 4 KB tail and the 272,102-byte directory, 276,198 bytes of
    // a 479,493,658-byte pak.
    expect(source.reads).toEqual([
      [479_493_658 - EOCD_SEARCH_CHUNK, EOCD_SEARCH_CHUNK],
      [479_221_534, 272_102]
    ]);
    expect(bytesRead(source)).toBe(276_198);
  });

  it('decompresses a weapon model to a valid MD3 header, in one read', async () => {
    const source = countReads(nodeFileSource(pakPath('pak0.pk3')));
    const pak0 = await ZipArchive.open(source);
    const opening = source.reads.length;
    const md3 = (await pak0.read(PROBE_ENTRY))!;
    expect(source.reads.length - opening).toBe(1);
    expect(new TextDecoder().decode(md3.subarray(0, 4))).toBe('IDP3');
    // Version 15, little-endian (qcommon/qfiles.h).
    expect(new DataView(md3.buffer, md3.byteOffset).getInt32(4, true)).toBe(15);
    expect(md3.byteLength).toBe(pak0.entry(PROBE_ENTRY)!.uncompressedSize);
  });

  it('ships every weapon, plus the shader scripts', async () => {
    const pak0 = await openPak('pak0.pk3');
    const weapons = [
      'gauntlet',
      'machinegun',
      'shotgun',
      'grenadel',
      'rocketl',
      'lightning',
      'railgun',
      'plasma',
      'bfg',
      'grapple'
    ];
    for (const weapon of weapons) {
      expect(pak0.entry(`models/weapons2/${weapon}/${weapon}.md3`), weapon).toBeDefined();
      expect(pak0.entry(`models/weapons2/${weapon}/${weapon}_hand.md3`), weapon).toBeDefined();
    }
    expect(pak0.names().filter((n) => n.endsWith('.shader')).length).toBe(27);
  });
});
