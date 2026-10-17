import type { ByteSource } from './byte-source';
import { createPakDropScreen } from './drop-screen';
import { installPaks, type Folder, type FolderPicker, type InstallFolder } from './install-folder';
import {
  devPakSources,
  discoverDevPaks,
  discoverMapPaks,
  filePakSources,
  mapPakSources,
  mountArchives,
  type MountProgress
} from './mount';
import type { PakFileSystem } from './vfs';

/**
 * The pak layer's boot routes: the install the dev server reads in place, the install folder the
 * player picks, and the drop screen. The port's own map pk3s mount apart from all three, since
 * they lie under whichever brings the player's paks.
 *
 * All end at the same {@link mountArchives} call over byte sources, so a dropped pak0, a pak0 in a
 * picked folder and a dev-served pak0 produce identical file systems. Which route runs, and what
 * the browser keeps between visits, is `asset-boot.ts`'s decision.
 */

/** Progress and outcome reporting, for the HUD. */
export type PakBootStatus =
  | { phase: 'discovering' }
  | { phase: 'waiting-for-drop' }
  | { phase: 'loading'; progress: MountProgress }
  | { phase: 'ready'; fs: PakFileSystem }
  | { phase: 'error'; message: string };

/** Seams for tests; every field defaults to the real implementation. */
export interface PakBootDeps {
  discover: typeof discoverDevPaks;
  devSources: typeof devPakSources;
  mount: typeof mountArchives;
}

const defaultDeps: PakBootDeps = {
  discover: discoverDevPaks,
  devSources: devPakSources,
  mount: mountArchives
};

/**
 * Mount every pak the dev server finds in `fs_basepath`, in ioq3's order, read in place.
 *
 * @param onStatus progress callback, called at least once per phase
 * @returns the mounted file system, or `undefined` when there is no install to read — any
 *   production build, or a dev server without paks — so the caller can try the next route
 */
export async function mountDevPaks(
  onStatus: (status: PakBootStatus) => void = () => {},
  deps: Partial<PakBootDeps> = {}
): Promise<PakFileSystem | undefined> {
  const { discover, devSources, mount } = { ...defaultDeps, ...deps };

  onStatus({ phase: 'discovering' });
  const paks = await discover();
  if (paks.length === 0) return undefined;
  return mountAndReport(devSources(paks), mount, onStatus);
}

/**
 * Mount the port's own map pk3s, `public/maps/*.pk3`, in ioq3's order. They are the bottom of the
 * search path, under the player's paks, and are there whichever way the
 * player's paks arrive, or if they never do.
 *
 * @returns the mounted file system, or `undefined` when none is listed; rejects only when none of
 *   those listed opens
 */
export async function mountMapPaks(): Promise<PakFileSystem | undefined> {
  const paks = await discoverMapPaks();
  if (paks.length === 0) return undefined;
  return mountArchives(mapPakSources(paks));
}

/**
 * Mount the paks of a picked install folder, in ioq3's order, read by range where they sit.
 *
 * @param folder the folder the player picked: the one holding `baseq3`, or `baseq3` itself
 * @param onStatus progress callback, called at least once per phase
 * @returns the mounted file system, or `undefined` for a folder that isn't an install
 */
export async function mountFolder(
  folder: Folder,
  onStatus: (status: PakBootStatus) => void = () => {},
  deps: Partial<PakBootDeps> = {}
): Promise<PakFileSystem | undefined> {
  const { mount } = { ...defaultDeps, ...deps };

  onStatus({ phase: 'discovering' });
  const paks = await installPaks(folder);
  if (paks.length === 0) return undefined;
  return mountAndReport(filePakSources(paks), mount, onStatus);
}

/** What the drop screen offers besides dropped paks. */
export interface AskOptions {
  /** The browser's folder picker, where it has one. */
  picker?: FolderPicker;
  /** A kept install folder to offer again, whose permission wants the player's click. */
  kept?: InstallFolder;
}

/** Paks the player gave: dropped, or in the install folder, read where they sit. */
export interface GivenPaks {
  fs: PakFileSystem;
  /** The install folder the paks are read from, or `undefined` for dropped paks. */
  folder?: InstallFolder;
}

/**
 * Show the drop screen and mount what the player gives, resolving once it mounts: dropped pk3s,
 * or the install folder, picked there or kept from a visit before.
 *
 * The promise stays pending until the player gives a readable pk3, which is the correct
 * behaviour for a game that cannot start without assets. Until then the screen stays up, saying
 * what went wrong.
 *
 * @param host element the drop screen attaches to
 * @param onStatus progress callback, called at least once per phase
 */
export function askForPaks(
  host: HTMLElement,
  onStatus: (status: PakBootStatus) => void = () => {},
  options: AskOptions = {},
  deps: Partial<PakBootDeps> = {}
): Promise<GivenPaks> {
  const { mount } = { ...defaultDeps, ...deps };
  const { picker, kept } = options;

  return new Promise<GivenPaks>((resolve) => {
    onStatus({ phase: 'waiting-for-drop' });
    const give = (given: GivenPaks) => {
      screen.destroy();
      resolve(given);
    };
    // Stay up: a corrupt pak or the wrong folder is recoverable by giving another.
    const say = (err: unknown) => screen.setMessage(err instanceof Error ? err.message : String(err));

    const readFolder = async (folder: InstallFolder) => {
      screen.setMessage('Reading…');
      const fs = await mountFolder(folder, onStatus, { mount });
      if (fs) give({ fs, folder });
      else {
        screen.setMessage(
          `No pk3 files in ${folder.name}. Choose the folder that holds baseq3, or baseq3 itself.`
        );
      }
    };

    const screen = createPakDropScreen(
      host,
      (files) => {
        const sources = filePakSources(files);
        if (sources.length === 0) {
          screen.setMessage('That was not a .pk3 file — try pak0.pk3 from your Quake 3 install.');
          return;
        }
        screen.setMessage('Reading…');
        mountAndReport(sources, mount, onStatus).then((fs) => give({ fs }), say);
      },
      {
        onPickFolder:
          picker &&
          (() => {
            picker()
              .then(readFolder, (err: unknown) => {
                // Cancelling the picker leaves the screen as it was.
                if (!(err instanceof DOMException && err.name === 'AbortError')) say(err);
              })
              .catch(say);
          }),
        keptFolder: kept && {
          name: kept.name,
          onUse: () => {
            kept
              .requestPermission({ mode: 'read' })
              .then((state) =>
                state === 'granted'
                  ? readFolder(kept)
                  : screen.setMessage(`${kept.name} wasn't opened: reading it was refused.`)
              )
              .catch(say);
          }
        }
      }
    );
  });
}

/** Mount sources, reporting progress and the final file system through `onStatus`. */
async function mountAndReport(
  sources: ByteSource[],
  mount: typeof mountArchives,
  onStatus: (status: PakBootStatus) => void
): Promise<PakFileSystem> {
  try {
    const fs = await mount(sources, {
      onProgress: (progress) => onStatus({ phase: 'loading', progress })
    });
    onStatus({ phase: 'ready', fs });
    return fs;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onStatus({ phase: 'error', message });
    throw err;
  }
}
