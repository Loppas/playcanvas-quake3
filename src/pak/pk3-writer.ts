import type { ZipArchive, ZipEntry } from './zip';

/**
 * Writing a pk3: a plain zip, which is all ioq3 reads (`unzOpen`, `files.c:1998`).
 *
 * The browser's cache is one more pak, its entries copied out of the paks the player dropped as
 * those paks store them. So each keeps its compression method, sizes and CRC, and nothing is
 * inflated or deflated again. The writer gives an entry's local header and payload at a time,
 * then the central directory and its end record, for the caller to write in order.
 *
 * No zip64: a cache is a few thousand files and tens of megabytes, far inside a plain zip's
 * limits, and an archive past them is refused rather than written wrong.
 *
 * Engine-free, like the reader.
 */

/** An entry to copy: its name, and its method, sizes and CRC as its archive records them. */
export type RawZipEntry = Pick<
  ZipEntry,
  'compressionMethod' | 'crc32' | 'compressedSize' | 'uncompressedSize'
> & {
  /** The name to store, spelled as the source archive spells it. */
  name: string;
  /** The payload as stored: `compressedSize` bytes. */
  payload: Uint8Array;
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/** Version 2.0, the one deflate needs; every zip reader handles it. */
const ZIP_VERSION = 20;
/** General-purpose flag bit 11: the name is UTF-8. */
const FLAG_UTF8 = 0x0800;
/**
 * 1980-01-01 at midnight, the earliest date a zip records, for every entry: the same entries
 * always make the same bytes.
 */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;

/** zip64's sentinels. A count or an offset that reaches one needs zip64, which isn't written. */
const ZIP64_COUNT = 0xffff;
const ZIP64_OFFSET = 0xffffffff;

/** An entry of `archive`, read as stored, ready to copy into another pak. */
export async function rawEntry(archive: ZipArchive, entry: ZipEntry): Promise<RawZipEntry> {
  return {
    name: entry.rawName,
    compressionMethod: entry.compressionMethod,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    payload: await archive.readRaw(entry)
  };
}

/**
 * A pk3 holding `entries`, in their order, as chunks to write one after another.
 *
 * @throws RangeError for an archive only zip64 could record, and Error for a payload that isn't
 *   its entry's compressed size
 */
export async function* writePk3(
  entries: AsyncIterable<RawZipEntry> | Iterable<RawZipEntry>
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const directory: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for await (const entry of entries) {
    if (entry.payload.byteLength !== entry.compressedSize) {
      throw new Error(
        `pk3: ${entry.name} has ${entry.payload.byteLength} bytes, not its ${entry.compressedSize}`
      );
    }
    if (directory.length + 1 >= ZIP64_COUNT) throw needsZip64(`${ZIP64_COUNT - 1} entries`);

    const name = encoder.encode(entry.name);
    const flags = isAscii(entry.name) ? 0 : FLAG_UTF8;
    const record = new Uint8Array(LOCAL_HEADER_SIZE + name.byteLength + entry.compressedSize);
    const local = new DataView(record.buffer);
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, ZIP_VERSION, true);
    local.setUint16(6, flags, true);
    setEntryFields(local, 8, entry);
    local.setUint16(26, name.byteLength, true);
    record.set(name, LOCAL_HEADER_SIZE);
    record.set(entry.payload, LOCAL_HEADER_SIZE + name.byteLength);

    directory.push(centralRecord(entry, name, flags, offset));
    offset += record.byteLength;
    if (offset >= ZIP64_OFFSET) throw needsZip64('4 GB');
    yield record;
  }

  const size = directory.reduce((total, record) => total + record.byteLength, 0);
  if (offset + size >= ZIP64_OFFSET) throw needsZip64('4 GB');
  const tail = new Uint8Array(size + EOCD_SIZE);
  let at = 0;
  for (const record of directory) {
    tail.set(record, at);
    at += record.byteLength;
  }
  const end = new DataView(tail.buffer, size);
  end.setUint32(0, SIG_EOCD, true);
  end.setUint16(8, directory.length, true);
  end.setUint16(10, directory.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  yield tail;
}

/** An entry's central-directory record, pointing at its local header. */
function centralRecord(
  entry: RawZipEntry,
  name: Uint8Array,
  flags: number,
  offset: number
): Uint8Array<ArrayBuffer> {
  const record = new Uint8Array(CENTRAL_HEADER_SIZE + name.byteLength);
  const view = new DataView(record.buffer);
  view.setUint32(0, SIG_CENTRAL, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(8, flags, true);
  setEntryFields(view, 10, entry);
  view.setUint16(28, name.byteLength, true);
  view.setUint32(42, offset, true);
  record.set(name, CENTRAL_HEADER_SIZE);
  return record;
}

/** The method, time, date, CRC and sizes: the run of fields a local header and a central record share. */
function setEntryFields(view: DataView, at: number, entry: RawZipEntry): void {
  view.setUint16(at, entry.compressionMethod, true);
  view.setUint16(at + 2, DOS_TIME, true);
  view.setUint16(at + 4, DOS_DATE, true);
  view.setUint32(at + 6, entry.crc32, true);
  view.setUint32(at + 10, entry.compressedSize, true);
  view.setUint32(at + 14, entry.uncompressedSize, true);
}

/** Whether a name is plain ASCII, which a zip reads the same with or without the UTF-8 flag. */
function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function needsZip64(limit: string): RangeError {
  return new RangeError(`pk3: past ${limit}, which only zip64 records`);
}
