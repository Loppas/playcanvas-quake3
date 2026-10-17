/**
 * Where a pak's bytes come from.
 *
 * ioq3 never reads a pk3 whole: it reads each one's central directory at start (`unzOpen`,
 * `files.c:1998`) and a file's bytes when something asks for them (`unzReadCurrentFile`,
 * `files.c:1535`). A byte source is the seam that lets the port do the same over whatever holds
 * the pak — memory in tests, a dropped `File`, or the dev server by HTTP `Range` — without the
 * zip reader knowing which.
 *
 * Engine-free, like the rest of `src/pak/`.
 */

/**
 * Told how a read is coming in: the bytes received so far, of the whole read. A source whose bytes
 * arrive at once tells it once, at the end.
 */
export type ByteProgress = (received: number, total: number) => void;

/** Random access to one archive's bytes. */
export interface ByteSource {
  /** File name or URL, for diagnostics and the mount's labels. */
  readonly label: string;
  /** Total length in bytes. */
  readonly size: number;
  /**
   * Exactly `length` bytes from `offset`. Rejects with a `RangeError` for a range that does not
   * lie inside the source, and with an `Error` if the backing store answers short.
   *
   * @param progress - Told as the bytes come in, since a map's splat is one read of 185 MB.
   */
  read(offset: number, length: number, progress?: ByteProgress): Promise<Uint8Array>;
}

/**
 * Throw a `RangeError` unless `[offset, offset + length)` lies inside `size` bytes. Shared, so
 * every source refuses the same ranges with the same message.
 */
export function checkRange(label: string, size: number, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > size
  ) {
    throw new RangeError(`${label}: cannot read ${length} bytes at ${offset} of ${size}`);
  }
}

/** A source over bytes already in memory. Reads are views of them, not copies. */
export function memorySource(label: string, bytes: Uint8Array): ByteSource {
  return {
    label,
    size: bytes.byteLength,
    async read(offset, length, progress) {
      checkRange(label, bytes.byteLength, offset, length);
      progress?.(length, length);
      return bytes.subarray(offset, offset + length);
    }
  };
}

/**
 * A source over a `Blob`. Each read slices the blob, so a
 * 457 MB pak0 is never held in memory whole.
 */
export function blobSource(blob: Blob, label = (blob as File).name): ByteSource {
  return {
    label,
    size: blob.size,
    async read(offset, length, progress) {
      checkRange(label, blob.size, offset, length);
      const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
      if (bytes.byteLength !== length) {
        throw new Error(`${label}: asked for ${length} bytes at ${offset}, got ${bytes.byteLength}`);
      }
      progress?.(length, length);
      return bytes;
    }
  };
}

/**
 * A source over HTTP `Range` requests: the dev server's `/baseq3/` route, and the shell's
 * `app://` handler.
 *
 * Only a 206 is accepted. A server that ignores `Range` answers 200 with the whole pak, which is
 * exactly the half-gigabyte read this seam exists to avoid, so a 200 is an error, not a fallback.
 *
 * @param url where the pak is served
 * @param label the pak's name, for diagnostics
 * @param size the pak's length, from the server's listing
 * @param fetchFn injected for tests
 */
export function httpSource(
  url: string,
  label: string,
  size: number,
  fetchFn: typeof fetch = globalThis.fetch
): ByteSource {
  return {
    label,
    size,
    async read(offset, length, progress) {
      checkRange(label, size, offset, length);
      // `bytes=a-b` is inclusive, so it has no spelling for an empty range.
      if (length === 0) return new Uint8Array(0);

      const last = offset + length - 1;
      const response = await fetchFn(url, { headers: { Range: `bytes=${offset}-${last}` } });
      if (response.status !== 206) {
        // Stop a 200's body, which would otherwise go on downloading the whole pak.
        await response.body?.cancel().catch(() => {});
        throw new Error(`${label}: expected 206 for bytes ${offset}-${last}, got ${response.status}`);
      }
      const short = (got: number) =>
        new Error(`${label}: asked for ${length} bytes at ${offset}, got ${got}`);
      if (!progress || !response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== length) throw short(bytes.byteLength);
        progress?.(length, length);
        return bytes;
      }
      // Into one buffer as the body comes in, so a watched read holds no more than a whole one.
      const bytes = new Uint8Array(length);
      const reader = response.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > length) {
          await reader.cancel().catch(() => {});
          throw short(received + value.byteLength);
        }
        bytes.set(value, received);
        received += value.byteLength;
        progress(received, length);
      }
      if (received !== length) throw short(received);
      return bytes;
    }
  };
}
