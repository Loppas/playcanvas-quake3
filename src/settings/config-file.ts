import { opfsAvailable, opfsRoot } from '../browser-storage';

/**
 * Where the files the game keeps are kept: `q3config.cfg`, and the favourite servers'
 * `favorites.txt` beside it.
 *
 * The desktop shell keeps them in `fs_homepath` alone, as Q3 keeps its one file. A browser build
 * keeps them in OPFS. Dev keeps them in both: the copy in `fs_homepath` can be opened in an editor
 * and is read first, so an edit made there takes effect at the next load, as it would in Q3. Export
 * and import hand the config to the player and take one back.
 */

/** `Q3CONFIG_CFG` (`q_shared.h`). */
export const Q3CONFIG_CFG = 'q3config.cfg';

/** The favourite servers, which the game keeps beside the config. */
export const FAVORITES_TXT = 'favorites.txt';

/** The route to a kept file in `fs_homepath` (`scripts/q3config-route.mjs`). */
export function homeRoute(name: string): string {
  return `/homepath/${name}`;
}

/** The route to the config in `fs_homepath`. */
export const CONFIG_ROUTE = homeRoute(Q3CONFIG_CFG);

/** One place a kept file is kept. */
export interface FileStore {
  /** The file's text, or `undefined` if there is none or it can't be read. */
  read(): Promise<string | undefined>;
  /** Replace the file. Never throws: a store that can't be written is passed over. */
  write(text: string): Promise<boolean>;
}

/** A kept file in the build's folder in OPFS, beside the asset cache (`pak/asset-cache.ts`). */
export function opfsFile(name: string): FileStore {
  return {
    async read() {
      if (!opfsAvailable()) return undefined;
      try {
        const root = await opfsRoot();
        const file = await (await root.getFileHandle(name)).getFile();
        return await file.text();
      } catch {
        return undefined;
      }
    },
    async write(text) {
      if (!opfsAvailable()) return false;
      try {
        const root = await opfsRoot();
        const writable = await (await root.getFileHandle(name, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
        return true;
      } catch {
        return false;
      }
    }
  };
}

/**
 * A kept file in `fs_homepath`, over its route.
 *
 * @param fetcher - `fetch`, or a stand-in for a test.
 */
export function routeFile(
  name: string,
  fetcher: typeof fetch = (...args) => fetch(...args)
): FileStore {
  const route = homeRoute(name);
  return {
    async read() {
      try {
        const response = await fetcher(route, { cache: 'no-store' });
        // 204 is the route's answer before there is a file.
        return response.status === 200 ? await response.text() : undefined;
      } catch {
        return undefined;
      }
    },
    async write(text) {
      try {
        const response = await fetcher(route, {
          method: 'PUT',
          body: text,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
        return response.ok;
      } catch {
        return false;
      }
    }
  };
}

/**
 * The stores a kept file is kept in, in the order they are read: in the desktop shell, the file
 * in `fs_homepath` alone; in dev, that file, then OPFS; in a browser build, OPFS alone.
 *
 * @param shell - In the desktop shell, which dev can be too.
 */
export function homeStores(
  name: string,
  dev: boolean = import.meta.env.DEV,
  shell = false
): FileStore[] {
  if (shell) return [routeFile(name)];
  return dev ? [routeFile(name), opfsFile(name)] : [opfsFile(name)];
}

/** The saved file: the first store's that has one, or `undefined` on a first run. */
export async function readKeptFile(stores: readonly FileStore[]): Promise<string | undefined> {
  for (const store of stores) {
    const text = await store.read();
    if (text !== undefined) return text;
  }
  return undefined;
}

/** What a kept file holds, and when that changes: the config, or the favourite servers. */
export interface KeptText {
  /** The file, as it should now read. */
  text(): string;
  /**
   * Hear of each change.
   *
   * @returns Stop hearing.
   */
  onSave(listener: () => void): () => void;
}

/** What {@link keepFile} returns. */
export interface FileKeeper {
  /** Stop writing the file. */
  stop(): void;
  /** Resolves once every write asked for so far is done. */
  settled(): Promise<void>;
}

/**
 * Keep a file up to date: rewritten in every store whenever what it holds changes, as Q3 rewrites
 * its config (`Com_WriteConfiguration`, `common.c:2950–2962`).
 *
 * Changes made together are written once, after the task that made them, and a write waits for
 * the one before it. A file that differs from what it should hold at start, as on a first run, is
 * written at once, as Q3 writes the cvars it registered new.
 *
 * @param saved - The file as read at start.
 */
export function keepFile(
  source: KeptText,
  stores: readonly FileStore[],
  saved?: string
): FileKeeper {
  let written = saved;
  let wanted = false;
  let stopped = false;
  let running: Promise<void> | null = null;

  const flush = async () => {
    while (wanted && !stopped) {
      wanted = false;
      const text = source.text();
      if (text === written) continue;
      written = text;
      await Promise.all(stores.map((store) => store.write(text)));
    }
    running = null;
  };
  const schedule = () => {
    wanted = true;
    running ??= Promise.resolve().then(flush);
  };

  const stopListening = source.onSave(schedule);
  schedule();
  return {
    stop: () => {
      // A write already asked for is dropped too.
      stopped = true;
      stopListening();
    },
    settled: () => running ?? Promise.resolve()
  };
}

/**
 * Hand a file to the player to save, as a download: the config's export, and what the console
 * writes in a build that keeps its home folder where the player can't open it.
 *
 * @param name - The name the download is offered under.
 * @param text - The file.
 */
export function downloadFile(
  name: string,
  text: string,
  document: Document = window.document
): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Let the download take the file before the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Ask the player for a config to import.
 *
 * @returns The file's text, or `undefined` if they pick none.
 */
export function pickConfigFile(document: Document = window.document): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cfg,text/plain';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) resolve(undefined);
      else file.text().then(resolve, () => resolve(undefined));
    });
    input.addEventListener('cancel', () => resolve(undefined));
    input.click();
  });
}
