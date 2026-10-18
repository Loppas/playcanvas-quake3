import { inflateSync } from 'fflate';
import type { ByteProgress, ByteSource } from './byte-source';

/**
 * Minimal zip reader for `.pk3` archives, over a {@link ByteSource}.
 *
 * A pk3 *is* a plain zip (`qcommon/files.c`) — id never extended the format — so the whole
 * pak layer needs nothing more than the central directory plus stored/deflate entries.
 * We read the directory rather than streaming the file top-to-bottom because Q3 semantics
 * (case-insensitive lookup, later-pak override) are a name-index problem.
 *
 * Like ioq3, the reader never holds an archive whole. Opening reads the file's
 * tail and its central directory, as `unzOpen` does (`files.c:1998`); an entry's bytes are read
 * by range when something asks for them, as `unzReadCurrentFile` reads them (`files.c:1535`).
 *
 * Engine-free by design: parsers emit typed arrays, the glue layer turns
 * them into PlayCanvas resources.
 */

/** Central-directory file header. */
const SIG_CENTRAL = 0x02014b50;
/** Local file header, immediately before each entry's payload. */
const SIG_LOCAL = 0x04034b50;
/** End of central directory record. */
const SIG_EOCD = 0x06054b50;
/** Zip64 end of central directory locator — present only on archives we refuse. */
const SIG_ZIP64_LOCATOR = 0x07064b50;

/** Fixed size of an EOCD record before its variable-length comment. */
const EOCD_SIZE = 22;
/** A zip comment is a uint16 length, so the EOCD starts at most this far from the end. */
const MAX_COMMENT = 0xffff;
/** The zip64 locator's size; it sits immediately before the EOCD record. */
const ZIP64_LOCATOR_SIZE = 20;
/** Fixed parts of a central-directory record and of a local header, before their names. */
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;

/**
 * Bytes read per step of the backwards search for the EOCD record. A pk3 rarely carries a
 * comment, so the first step finds the record — and, for a small pak, the directory with it.
 */
export const EOCD_SEARCH_CHUNK = 4096;

/**
 * Bytes read past an entry's expected local header, so one read usually covers the header and
 * the payload even when the local extra field is longer than the central record's. The two can
 * differ: Info-ZIP's extended timestamp, for one, carries more fields locally than centrally.
 */
const LOCAL_HEADER_SLACK = 256;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** A field of all-ones is zip64's "look in the extra field" sentinel. */
const ZIP64_SENTINEL = 0xffffffff;

/** Inflate a deflated entry's payload to its `size` bytes, on the calling thread. */
export function inflateEntry(payload: Uint8Array, size: number): Uint8Array {
  return inflateSync(payload, { out: new Uint8Array(size) });
}

/** How every archive inflates its deflated entries: {@link inflateEntry}, or a worker's. */
export type Inflate = (payload: Uint8Array, size: number) => Uint8Array | Promise<Uint8Array>;

let inflate: Inflate = inflateEntry;

/**
 * Inflate every archive's entries with `inflater` from now on. The page hands them to a worker,
 * so reading a pak inflates nothing on the thread that draws; Node and the tests inflate in place.
 */
export function inflateWith(inflater: Inflate): void {
  inflate = inflater;
}

/** One file inside the archive, located but not yet decompressed. */
export interface ZipEntry {
  /** Name exactly as stored in the archive, for diagnostics. */
  rawName: string;
  /** Lowercased, forward-slashed lookup key — Q3's own normalization. */
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** Offset of the *local* header; the payload sits past its own variable-length fields. */
  localHeaderOffset: number;
  /**
   * The central record's name plus extra-field length. The local header repeats both, usually
   * at the same length, so this sizes the one read that fetches header and payload together;
   * the local header's own lengths still decide where the payload starts.
   */
  centralNameExtraLength: number;
  /**
   * Offset of what follows the entry in the archive: the next local header after its own, the
   * central directory when none does, or the archive's end when neither does.
   */
  nextHeaderOffset: number;
}

/**
 * Normalize a pak path to its lookup key: backslashes to forward slashes, lowercased, no
 * leading separator.
 *
 * Q3 lowercases entries at index time and compares case-insensitively
 * (`qcommon/files.c`), which is why `models/weapons2/...` in code finds
 * `MODELS/WEAPONS2/...` in an archive authored on Windows.
 */
export function normalizePakPath(path: string): string {
  let normalized = path.replace(/\\/g, '/').toLowerCase();
  while (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** `head` followed by `tail`, in a new buffer unless one of them is empty. */
function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (tail.byteLength === 0) return head;
  if (head.byteLength === 0) return tail;
  const out = new Uint8Array(head.byteLength + tail.byteLength);
  out.set(head);
  out.set(tail, head.byteLength);
  return out;
}

/** The end of an archive, as read while searching it for the EOCD record. */
interface Tail {
  /** File offset of `bytes[0]`; `bytes` runs to the end of the file. */
  start: number;
  bytes: Uint8Array;
  /** File offset of the EOCD record. */
  eocd: number;
}

/**
 * Find the end-of-central-directory record by searching backwards from the end of the file,
 * {@link EOCD_SEARCH_CHUNK} bytes at a time, as minizip's `unzlocal_SearchCentralDir` does
 * (`unzip.c:326`), and never further back than the longest comment allows.
 *
 * Each chunk is joined onto the bytes already read, so the few positions whose signature
 * straddles the previous chunk's start — which minizip covers by overlapping its reads by four
 * bytes — are scanned once the lower chunk arrives. The record is found whichever side of a
 * boundary it falls on.
 */
async function findEocd(source: ByteSource): Promise<Tail> {
  const { label, size } = source;
  const notZip = () => new Error(`${label}: not a zip archive: no end-of-central-directory record`);
  if (size < EOCD_SIZE) throw notZip();

  const limit = Math.max(0, size - EOCD_SIZE - MAX_COMMENT);
  let bytes: Uint8Array = new Uint8Array(0);
  let start = size;
  // The highest position not yet scanned; a record needs EOCD_SIZE bytes from its start.
  let at = size - EOCD_SIZE;

  while (start > limit) {
    const chunkStart = Math.max(limit, start - EOCD_SEARCH_CHUNK);
    bytes = concat(await source.read(chunkStart, start - chunkStart), bytes);
    start = chunkStart;

    const view = dataView(bytes);
    for (; at >= start; at--) {
      if (view.getUint32(at - start, true) === SIG_EOCD) return { start, bytes, eocd: at };
    }
  }
  throw notZip();
}

/**
 * Parse `entryCount` central-directory records, bounds-checking each against the buffer.
 *
 * @param directoryOffset - Where the directory starts in the archive.
 * @param size - The archive's length.
 */
function parseDirectory(
  label: string,
  directory: Uint8Array,
  entryCount: number,
  directoryOffset: number,
  size: number
): Map<string, ZipEntry> {
  const view = dataView(directory);
  const decoder = new TextDecoder();
  const index = new Map<string, ZipEntry>();
  // The central directory and every local header, a directory entry's included: the places an
  // entry's bytes can end.
  const starts = new Set([directoryOffset]);
  let at = 0;

  for (let i = 0; i < entryCount; i++) {
    const corrupt = () => new Error(`${label}: corrupt central directory at entry ${i}`);
    if (at + CENTRAL_HEADER_SIZE > directory.byteLength || view.getUint32(at, true) !== SIG_CENTRAL) {
      throw corrupt();
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const nameStart = at + CENTRAL_HEADER_SIZE;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > directory.byteLength) throw corrupt();

    const rawName = decoder.decode(directory.subarray(nameStart, nameStart + nameLength));
    const localHeaderOffset = view.getUint32(at + 42, true);
    starts.add(localHeaderOffset);
    // Directory entries carry no payload; Q3's flat virtual FS has no use for them.
    if (!rawName.endsWith('/')) {
      const entry: ZipEntry = {
        rawName,
        name: normalizePakPath(rawName),
        compressionMethod: view.getUint16(at + 10, true),
        crc32: view.getUint32(at + 16, true),
        compressedSize: view.getUint32(at + 20, true),
        uncompressedSize: view.getUint32(at + 24, true),
        localHeaderOffset,
        centralNameExtraLength: nameLength + extraLength,
        nextHeaderOffset: size
      };
      // Within one archive a duplicate name means the later entry wins, matching the
      // override rule we apply across archives.
      index.set(entry.name, entry);
    }
    at = next;
  }

  const sorted = [...starts].sort((a, b) => a - b);
  const following = new Map(sorted.map((start, i) => [start, sorted[i + 1] ?? size]));
  for (const entry of index.values()) {
    entry.nextHeaderOffset = following.get(entry.localHeaderOffset)!;
  }
  return index;
}

/**
 * A parsed pk3: its byte source and a name index. Entries are read and decompressed only on
 * {@link ZipArchive.read}, so mounting a 457 MB pak0 costs its tail and directory.
 */
export class ZipArchive {
  /** Human-readable source label (file name / URL), used in error messages. */
  readonly label: string;
  private readonly source: ByteSource;
  private readonly index: Map<string, ZipEntry>;

  private constructor(source: ByteSource, index: Map<string, ZipEntry>) {
    this.label = source.label;
    this.source = source;
    this.index = index;
  }

  /**
   * Read an archive's central directory: the tail search for its end record, then the
   * directory in one ranged read — or none, when the tail already holds it, as a small pak's
   * does. Rejects if the source is not a readable zip.
   */
  static async open(source: ByteSource): Promise<ZipArchive> {
    const label = source.label;
    const found = await findEocd(source);
    const { eocd } = found;
    let { start, bytes } = found;

    // zip64 puts a locator just before the record. The search can stop with the record at the
    // very start of what it read, and then those bytes have yet to be fetched.
    const locator = eocd - ZIP64_LOCATOR_SIZE;
    if (locator >= 0 && locator < start) {
      bytes = concat(await source.read(locator, start - locator), bytes);
      start = locator;
    }
    const view = dataView(bytes);
    const zip64 = () => new Error(`${label}: zip64 archives are not supported`);
    if (locator >= 0 && view.getUint32(locator - start, true) === SIG_ZIP64_LOCATOR) throw zip64();

    const entryCount = view.getUint16(eocd - start + 10, true);
    const directorySize = view.getUint32(eocd - start + 12, true);
    const directoryOffset = view.getUint32(eocd - start + 16, true);
    if (directoryOffset === ZIP64_SENTINEL || directorySize === ZIP64_SENTINEL) throw zip64();
    // minizip refuses a directory that runs into its own end record (`unzip.c:471–473`).
    if (directoryOffset + directorySize > eocd) {
      throw new Error(`${label}: corrupt central directory: it overruns its end record`);
    }

    const directory =
      directoryOffset >= start
        ? bytes.subarray(directoryOffset - start, directoryOffset - start + directorySize)
        : await source.read(directoryOffset, directorySize);
    return new ZipArchive(
      source,
      parseDirectory(label, directory, entryCount, directoryOffset, source.size)
    );
  }

  /** Number of indexed file entries (directories excluded). */
  get size(): number {
    return this.index.size;
  }

  /** The archive's length in bytes. */
  get byteLength(): number {
    return this.source.size;
  }

  /** Look up an entry without reading it. Path matching is case-insensitive. */
  entry(path: string): ZipEntry | undefined {
    return this.index.get(normalizePakPath(path));
  }

  /** Every entry's normalized name, in central-directory order. */
  names(): string[] {
    return [...this.index.keys()];
  }

  /**
   * Read and decompress one entry by name, or `undefined` if the archive does not hold it.
   *
   * @param progress - Told as the entry's bytes come in, before any inflating.
   */
  async read(path: string, progress?: ByteProgress): Promise<Uint8Array | undefined> {
    const entry = this.entry(path);
    return entry ? this.readEntry(entry, progress) : undefined;
  }

  /** Read and decompress an entry located by {@link ZipArchive.entry}. */
  async readEntry(entry: ZipEntry, progress?: ByteProgress): Promise<Uint8Array> {
    if (entry.compressionMethod !== METHOD_STORED && entry.compressionMethod !== METHOD_DEFLATE) {
      throw new Error(
        `${this.label}: ${entry.rawName} uses unsupported compression method ${entry.compressionMethod}`
      );
    }
    const payload = await this.readRaw(entry, progress);
    return entry.compressionMethod === METHOD_STORED
      ? payload
      : inflate(payload, entry.uncompressedSize);
  }

  /**
   * An entry's payload as the archive stores it, deflated or not: what a copy of the entry into
   * another pak needs, without inflating it.
   *
   * One ranged read in the common case: the local header at the central record's lengths, some
   * slack, and the payload. Only a local extra field longer than the slack costs a second read,
   * and then `progress` hears both.
   *
   * The slack stops at the next local header, so reads of neighbouring entries never overlap:
   * Chromium's HTTP cache answers the later of two overlapping ranges in flight on a URL it has
   * not cached with only the bytes they share.
   */
  async readRaw(entry: ZipEntry, progress?: ByteProgress): Promise<Uint8Array> {
    const { label, size } = this.source;
    const local = entry.localHeaderOffset;
    const guess = Math.min(
      entry.nextHeaderOffset - local,
      LOCAL_HEADER_SIZE + entry.centralNameExtraLength + LOCAL_HEADER_SLACK + entry.compressedSize
    );
    const noLocalHeader = () => new Error(`${label}: ${entry.rawName} has no local header`);
    if (guess < LOCAL_HEADER_SIZE) throw noLocalHeader();

    const head = await this.source.read(local, guess, progress);
    const view = dataView(head);
    if (view.getUint32(0, true) !== SIG_LOCAL) throw noLocalHeader();
    // The local header repeats the name and extra fields, and its extra field length may
    // differ from the central directory's — so the payload offset must come from here.
    const payloadStart = LOCAL_HEADER_SIZE + view.getUint16(26, true) + view.getUint16(28, true);
    const payloadEnd = payloadStart + entry.compressedSize;
    if (local + payloadEnd > size) {
      throw new Error(`${label}: ${entry.rawName} runs past the end of the archive`);
    }
    return payloadEnd <= head.byteLength
      ? head.subarray(payloadStart, payloadEnd)
      : this.source.read(local + payloadStart, entry.compressedSize, progress);
  }
}
