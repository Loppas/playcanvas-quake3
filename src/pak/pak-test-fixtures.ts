import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rangeResponse } from '../../scripts/baseq3-route.mjs';
import { baseq3Dir } from '../../scripts/fs-basepath.mjs';
import type { CacheStore } from './asset-cache';
import type { ByteSource } from './byte-source';
import { nodeFileSource } from './node-source';
import { ZipArchive } from './zip';

/**
 * Guarded fixtures for the real Quake 3 paks, in the pattern
 * `sim/octree-test-fixtures.ts` established for the collision bake: the data is a local
 * install that is never committed, so tests that need it `skipIf` when it
 * is absent and the suite still runs green on a clean checkout. Also the test doubles the pak
 * tests share.
 *
 * The install is the one the dev server reads: `fs_basepath`'s `baseq3`, from
 * `PCQ_FS_BASEPATH` in the environment or `.env.local`, else the repo's own `baseq3/`.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The `baseq3` folder the pak tests read. */
export const BASEQ3_DIR = baseq3Dir(REPO_ROOT, 'test');

/** The install's pk3 file names, keyed lowercase: an install can ship `PAK0.PK3`. */
const PAK_NAMES = (() => {
  try {
    const names = readdirSync(BASEQ3_DIR).filter((name) => /\.pk3$/i.test(name));
    return new Map(names.map((name) => [name.toLowerCase(), name]));
  } catch {
    return new Map<string, string>();
  }
})();

/** Path to a pak in the local install, whatever case its file name is in. */
export function pakPath(name: string): string {
  return resolve(BASEQ3_DIR, PAK_NAMES.get(name.toLowerCase()) ?? name);
}

/** Whether the local install has this pak, matched case-insensitively. */
export function havePak(name: string): boolean {
  return PAK_NAMES.has(name.toLowerCase());
}

/** The one pak every weapon asset lives in. */
export const havePak0 = havePak('pak0.pk3');

/** Index a pak from the local install. Call only when {@link havePak} passes. */
export function openPak(name: string): Promise<ZipArchive> {
  const path = pakPath(name);
  return ZipArchive.open(nodeFileSource(path));
}

/**
 * A file known to exist in retail pak0, used as the canonical lookup probe. The rocket
 * launcher is the weapon the formats' golden tests are built around.
 */
export const PROBE_ENTRY = 'models/weapons2/rocketl/rocketl.md3';

/** A byte source that records every read passed through it. */
export interface CountedSource extends ByteSource {
  /** Each read so far, as `[offset, length]`. */
  readonly reads: [number, number][];
}

/** Wrap a source so a test can see which ranges were read. */
export function countReads(source: ByteSource): CountedSource {
  const reads: [number, number][] = [];
  return {
    label: source.label,
    size: source.size,
    reads,
    read(offset, length, progress) {
      reads.push([offset, length]);
      return source.read(offset, length, progress);
    }
  };
}

/** Total bytes a {@link CountedSource} has read. */
export function bytesRead(source: CountedSource): number {
  return source.reads.reduce((total, [, length]) => total + length, 0);
}

/**
 * The dev server's `/baseq3/` route without the socket: the listing, and each pak answered
 * through the route's own `rangeResponse`. What stands in for a dev server in the boot tests,
 * so the client's discovery and range reads run against the server's real answers.
 *
 * The port's own map pk3s are served the same way, from `/maps/` with the listing at
 * `/maps/paks.json`, and {@link fakeServers} serves both at once.
 *
 * @param paks the served paks' bytes, by file name
 * @param route where the paks are served
 * @param listing where they are listed
 */
export function fakeDevServer(
  paks: Record<string, Uint8Array>,
  route = '/baseq3/',
  listing = route
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === listing) {
      const listed = Object.entries(paks).map(([name, bytes]) => ({
        name,
        size: bytes.byteLength
      }));
      return new Response(JSON.stringify({ paks: listed }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const name = url.startsWith(route) ? decodeURIComponent(url.slice(route.length)) : '';
    const bytes = paks[name];
    if (!bytes) return new Response('not found', { status: 404 });

    const answer = rangeResponse(new Headers(init?.headers).get('Range'), bytes.byteLength);
    const body =
      answer.status === 416
        ? null
        : bytes.slice(answer.start ?? 0, (answer.end ?? bytes.byteLength - 1) + 1);
    return new Response(body, { status: answer.status, headers: answer.headers });
  }) as typeof fetch;
}

/** The port's `/maps/` route, as {@link fakeDevServer} serves `/baseq3/`. */
export function fakeMapServer(paks: Record<string, Uint8Array>): typeof fetch {
  return fakeDevServer(paks, '/maps/', '/maps/paks.json');
}

/**
 * Several servers on one origin: each request goes to the first that has an answer other than a
 * 404.
 */
export function fakeServers(...servers: (typeof fetch)[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let answer = new Response('not found', { status: 404 });
    for (const server of servers) {
      answer = await server(input, init);
      if (answer.status !== 404) break;
    }
    return answer;
  }) as typeof fetch;
}

/** The browser's cache store in memory, standing in for OPFS: each file a `Blob`, by name. */
export function memoryCacheStore(): CacheStore & { files: Map<string, Blob> } {
  const files = new Map<string, Blob>();
  return {
    files,
    async read(name) {
      return files.get(name);
    },
    async write(name, chunks) {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for await (const chunk of chunks) parts.push(chunk);
      files.set(name, new Blob(parts));
    },
    async remove(name) {
      files.delete(name);
    }
  };
}
