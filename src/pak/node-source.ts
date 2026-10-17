import { fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { checkRange, type ByteSource } from './byte-source';

/**
 * A byte source over a file on disk, for the runs that are not a page: the pak tests, and the
 * Node dedicated server's search path. The browser's counterparts live in `byte-source.ts`.
 */

/** Open file descriptors by path, so every source over one file shares one. */
const descriptors = new Map<string, number>();

/**
 * A byte source over a file on disk, reading each range with `fs.readSync` at an offset —
 * the Node counterpart of the browser's `File` source, and never the whole file.
 */
export function nodeFileSource(path: string, label = basename(path)): ByteSource {
  let fd = descriptors.get(path);
  if (fd === undefined) {
    fd = openSync(path, 'r');
    descriptors.set(path, fd);
  }
  const size = fstatSync(fd).size;
  const handle = fd;
  return {
    label,
    size,
    async read(offset, length) {
      checkRange(label, size, offset, length);
      const bytes = new Uint8Array(length);
      const got = readSync(handle, bytes, 0, length, offset);
      if (got !== length) throw new Error(`${label}: read ${got} of ${length} bytes at ${offset}`);
      return bytes;
    }
  };
}
