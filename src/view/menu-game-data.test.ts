import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import type { CacheInfo } from '../pak/asset-cache';
import { fakeInstallFolder, memoryKeptStore } from '../pak/folder-test-fixtures';
import { GameData, type GameDataContext, type GameDataSource, type ShellInstalls } from '../pak/game-data';
import type { FolderPicker, InstallFolder } from '../pak/install-folder';
import { memoryCacheStore } from '../pak/pak-test-fixtures';
import { Menu, type MenuItem } from './menu';
import { PENDING, gameDataMenu, gameDataPage, shownName } from './menu-game-data';

/** GAME DATA, as the browser, the shell and the dev server each have it. */

/** A cache of 52.3 MB, made from two paks. */
const CACHE: CacheInfo = {
  version: 'v',
  playerModels: [],
  paks: [
    { name: 'pak0.pk3', size: 1 },
    { name: 'pak1.pk3', size: 1 }
  ],
  size: Math.round(52.3 * 1024 * 1024)
};

/** The browser's game data over memory, with a cache in it unless the game runs from a folder. */
function browser(
  source: GameDataSource,
  kept: { folder?: InstallFolder; clearing?: boolean; picker?: FolderPicker } = {}
) {
  const store = memoryKeptStore(kept.folder, kept.clearing);
  const cache = memoryCacheStore();
  if (source.kind !== 'folder') cache.files.set('assets.pk3', new Blob(['PK']));
  const context: GameDataContext = { source, record: new GameData(store, cache), picker: kept.picker };
  return { store, context };
}

/** The page, open, as Setup opens it. */
async function opened(context: GameDataContext) {
  const menu = new Menu();
  menu.open(await gameDataPage(menu, context));
  return menu;
}

const labels = (menu: Menu) => menu.page!.items.map((item) => item.label);

function row(menu: Menu, label: string): MenuItem {
  const found = menu.page!.items.find((item) => item.label === label);
  expect(found, label).toBeDefined();
  return found!;
}

/** Put the cursor on a row and press a key there. */
function press(menu: Menu, label: string, key: number): void {
  menu.select(menu.page!.items.findIndex((item) => item.label === label));
  menu.key(key);
}

/** Whether the line saying a change waits shows. */
const pending = (menu: Menu) => !row(menu, PENDING).hidden;

describe('GAME DATA in a browser', () => {
  it('shows a folder: where the files come from, the folder, and its paks', async () => {
    const folder = fakeInstallFolder('ioquake');
    const { context } = browser({ kind: 'folder', paks: 3, folder }, { folder, picker: vi.fn() });
    const menu = await opened(context);
    expect(menu.page!.title).toBe('GAME DATA');
    expect(labels(menu)).toEqual(['Files from', 'Folder', 'Paks', PENDING, 'BACK']);
    expect(row(menu, 'Files from').value).toBe('Folder');
    expect(row(menu, 'Folder').value).toBe('ioquake');
    expect(row(menu, 'Paks')).toMatchObject({ value: '3', inactive: true });
    expect(pending(menu)).toBe(false);
  });

  it('shows the cache: the paks it was made from, its size, and CLEAR CACHE', async () => {
    const { context } = browser({ kind: 'cache', paks: 2, cache: CACHE }, { picker: vi.fn() });
    const menu = await opened(context);
    expect(labels(menu)).toEqual(['Files from', 'Folder', 'Paks', 'Cache', 'Clear cache', PENDING, 'BACK']);
    expect(row(menu, 'Files from').value).toBe('Dropped paks');
    expect(row(menu, 'Folder').value).toBe('none');
    expect(row(menu, 'Paks').value).toBe('2');
    expect(row(menu, 'Cache')).toMatchObject({ value: '52.3 MB', inactive: true });
    expect(row(menu, 'Clear cache')).toMatchObject({ value: 'off', hidden: false });
    expect(pending(menu)).toBe(false);
  });

  it('fixes FILES FROM at dropped paks where the browser has no folder picker', async () => {
    const { context } = browser({ kind: 'cache', paks: 2, cache: CACHE });
    const menu = await opened(context);
    expect(labels(menu)).toEqual(['Files from', 'Paks', 'Cache', 'Clear cache', PENDING, 'BACK']);
    expect(row(menu, 'Files from')).toMatchObject({ value: 'Dropped paks', grayed: true });
  });

  it('shows dropped paks, their cache once it is written, and CLEAR CACHE only then', async () => {
    const source: GameDataSource = { kind: 'paks', paks: 1 };
    const { context } = browser(source, { picker: vi.fn() });
    const menu = await opened(context);
    expect(row(menu, 'Cache').value).toBe('none');
    expect(row(menu, 'Clear cache').hidden).toBe(true);
    source.cache = { ...CACHE, size: 1024 * 1024 };
    expect(row(menu, 'Cache').value).toBe('1.0 MB');
    expect(row(menu, 'Clear cache').hidden).toBe(false);
  });

  it('turns from the cache to a folder through the picker, which a cancel leaves as it was', async () => {
    const folder = fakeInstallFolder('quake3');
    const picker = vi
      .fn<FolderPicker>()
      .mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
      .mockResolvedValueOnce(folder);
    const { store, context } = browser({ kind: 'cache', paks: 2, cache: CACHE }, { picker });
    const menu = await opened(context);

    press(menu, 'Files from', K.RIGHTARROW);
    // Called in the key's own handler, where the browser lets a page open its picker.
    expect(picker).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(picker).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(row(menu, 'Files from').value).toBe('Dropped paks');
    expect(pending(menu)).toBe(false);

    press(menu, 'Files from', K.RIGHTARROW);
    await vi.waitFor(() => expect(row(menu, 'Files from').value).toBe('Folder'));
    expect(row(menu, 'Folder').value).toBe('quake3');
    expect(store.folder).toBe(folder);
    // The folder has the cache cleared at the next start, so CLEAR CACHE has nothing to say.
    expect(store.marked).toBe(true);
    expect(row(menu, 'Clear cache').hidden).toBe(true);
    expect(pending(menu)).toBe(true);
  });

  it('takes a turn to a folder back by turning back to dropped paks, CLEAR CACHE as it was', async () => {
    const folder = fakeInstallFolder('quake3');
    const { store, context } = browser(
      { kind: 'cache', paks: 2, cache: CACHE },
      { picker: vi.fn<FolderPicker>().mockResolvedValue(folder) }
    );
    const menu = await opened(context);

    press(menu, 'Files from', K.RIGHTARROW);
    await vi.waitFor(() => expect(store.folder).toBe(folder));
    press(menu, 'Files from', K.RIGHTARROW);
    await vi.waitFor(() => expect(row(menu, 'Files from').value).toBe('Dropped paks'));
    expect(store).toMatchObject({ folder: undefined, marked: false });
    expect(pending(menu)).toBe(false);

    press(menu, 'Clear cache', K.ENTER);
    await vi.waitFor(() => expect(store.marked).toBe(true));
    press(menu, 'Files from', K.RIGHTARROW);
    await vi.waitFor(() => expect(store.folder).toBe(folder));
    press(menu, 'Files from', K.RIGHTARROW);
    await vi.waitFor(() => expect(store.folder).toBeUndefined());
    await vi.waitFor(() => expect(row(menu, 'Clear cache').value).toBe('on'));
    expect(store.marked).toBe(true);
    expect(pending(menu)).toBe(true);
  });

  it('marks the cache with CLEAR CACHE, and takes the mark off', async () => {
    const { store, context } = browser({ kind: 'cache', paks: 2, cache: CACHE }, { picker: vi.fn() });
    const menu = await opened(context);
    press(menu, 'Clear cache', K.ENTER);
    await vi.waitFor(() => expect(row(menu, 'Clear cache').value).toBe('on'));
    expect(store.marked).toBe(true);
    expect(pending(menu)).toBe(true);

    press(menu, 'Clear cache', K.ENTER);
    await vi.waitFor(() => expect(row(menu, 'Clear cache').value).toBe('off'));
    expect(store.marked).toBe(false);
    expect(pending(menu)).toBe(false);
  });

  it('turns from a folder to dropped paks, and back to the same folder with no picker', async () => {
    const folder = fakeInstallFolder('ioquake');
    const picker = vi.fn<FolderPicker>();
    const { store, context } = browser({ kind: 'folder', paks: 3, folder }, { folder, picker });
    const menu = await opened(context);

    press(menu, 'Files from', K.LEFTARROW);
    await vi.waitFor(() => expect(row(menu, 'Files from').value).toBe('Dropped paks'));
    expect(store.folder).toBeUndefined();
    expect(row(menu, 'Folder').value).toBe('none');
    expect(pending(menu)).toBe(true);

    press(menu, 'Files from', K.RIGHTARROW);
    await vi.waitFor(() => expect(row(menu, 'Files from').value).toBe('Folder'));
    expect(store.folder).toBe(folder);
    expect(picker).not.toHaveBeenCalled();
    expect(pending(menu)).toBe(false);
  });

  it('picks another folder from FOLDER, and the running one again to take it back', async () => {
    const folder = fakeInstallFolder('ioquake');
    const other = fakeInstallFolder('quake3');
    const picker = vi.fn<FolderPicker>().mockResolvedValueOnce(other).mockResolvedValueOnce(folder);
    const { store, context } = browser({ kind: 'folder', paks: 3, folder }, { folder, picker });
    const menu = await opened(context);

    press(menu, 'Folder', K.ENTER);
    expect(picker).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(row(menu, 'Folder').value).toBe('quake3'));
    expect(store.folder).toBe(other);
    expect(pending(menu)).toBe(true);

    press(menu, 'Folder', K.ENTER);
    await vi.waitFor(() => expect(row(menu, 'Folder').value).toBe('ioquake'));
    expect(pending(menu)).toBe(false);
  });

  it('reads the running folder back from storage, a copy of its handle, as the running one', async () => {
    const folder = fakeInstallFolder('ioquake');
    const copy: InstallFolder = { ...fakeInstallFolder('ioquake'), isSameEntry: async (to) => to === folder };
    const { context } = browser({ kind: 'folder', paks: 3, folder }, { folder: copy, picker: vi.fn() });
    expect(pending(await opened(context))).toBe(false);
  });

  it('shows a folder kept for the next start as waiting, whether or not the cache is marked', async () => {
    const folder = fakeInstallFolder('quake3');
    const { context } = browser({ kind: 'cache', paks: 2, cache: CACHE }, { folder, picker: vi.fn() });
    const menu = await opened(context);
    expect(row(menu, 'Files from').value).toBe('Folder');
    expect(pending(menu)).toBe(true);
  });

  it('opens with what is recorded now, which a change made earlier shows as waiting', async () => {
    const { context } = browser({ kind: 'cache', paks: 2, cache: CACHE }, { clearing: true, picker: vi.fn() });
    const menu = await opened(context);
    expect(row(menu, 'Clear cache').value).toBe('on');
    expect(pending(menu)).toBe(true);
  });
});

describe('GAME DATA in the shell', () => {
  const RUNNING = 'C:\\Games\\Quake3';

  function shell(next: string | null = RUNNING) {
    const read = vi.fn(async (): Promise<ShellInstalls> => ({ running: RUNNING, next: next ?? undefined }));
    const pick = vi.fn<() => Promise<ShellInstalls & { refused?: string }>>();
    return { read, pick, context: { source: { kind: 'shell', paks: 5 }, install: { read, pick } } as const };
  }

  it('shows the install, which picks another, and its paks', async () => {
    const { context } = shell();
    const menu = await opened(context);
    expect(labels(menu)).toEqual(['Files from', 'Install', 'Paks', PENDING, 'BACK']);
    expect(row(menu, 'Files from').value).toBe('Install');
    expect(row(menu, 'Install').value).toBe(RUNNING);
    expect(row(menu, 'Paks').value).toBe('5');
    expect(pending(menu)).toBe(false);
  });

  it('keeps a pick for the next launch, and a pick of the running install takes it back', async () => {
    const { pick, context } = shell();
    const menu = await opened(context);
    pick.mockResolvedValueOnce({ running: RUNNING, next: 'D:\\q3' });
    press(menu, 'Install', K.ENTER);
    await vi.waitFor(() => expect(row(menu, 'Install').value).toBe('D:\\q3'));
    expect(pending(menu)).toBe(true);

    pick.mockResolvedValueOnce({ running: RUNNING, next: RUNNING });
    press(menu, 'Install', K.ENTER);
    await vi.waitFor(() => expect(row(menu, 'Install').value).toBe(RUNNING));
    expect(pending(menu)).toBe(false);
  });

  it('says so in the status when a pick holds no paks', async () => {
    const { pick, context } = shell();
    const menu = await opened(context);
    pick.mockResolvedValueOnce({ running: RUNNING, next: RUNNING, refused: 'E:\\empty' });
    press(menu, 'Install', K.ENTER);
    await vi.waitFor(() => expect(row(menu, 'Install').status).toBe('There are no Quake 3 paks in that folder'));
    expect(pending(menu)).toBe(false);
  });

  it('shows a launch whose next install is gone as waiting', async () => {
    const menu = await opened(shell(null).context);
    expect(row(menu, 'Install').value).toBe('none');
    expect(pending(menu)).toBe(true);
  });
});

describe('GAME DATA on the dev server', () => {
  it('names the dev server and its paks, with nothing to change', async () => {
    const menu = await opened({ source: { kind: 'dev', paks: 241 } });
    expect(labels(menu)).toEqual(['Files from', 'Paks', 'BACK']);
    expect(row(menu, 'Files from')).toMatchObject({ value: 'Dev server', inactive: true });
    expect(row(menu, 'Paks').value).toBe('241');
  });
});

describe('gameDataMenu', () => {
  it('opens over the page it was opened from, and nothing before the boot has found the data', async () => {
    const menu = new Menu();
    const under = { items: [] };
    menu.open(under);
    let context: GameDataContext | undefined;
    const gameData = gameDataMenu(menu, () => context);
    gameData.open(under);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(menu.page).toBe(under);

    context = { source: { kind: 'dev', paks: 1 } };
    gameData.open(under);
    await vi.waitFor(() => expect(menu.page?.id).toBe('gamedata'));
  });

  it('opens nothing once the player has left the page it was opened from', async () => {
    const menu = new Menu();
    const under = { items: [] };
    menu.open(under);
    gameDataMenu(menu, () => ({ source: { kind: 'dev', paks: 1 } })).open(under);
    menu.push({ items: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(menu.page?.id).toBeUndefined();
    expect(menu.depth).toBe(2);
  });
});

describe('shownName', () => {
  it('draws only printable ASCII, each other character a ?', () => {
    expect(shownName('Café')).toBe('Caf?');
    expect(shownName('\u{1F600} ioq3')).toBe('? ioq3');
  });

  it('cuts a long path to its tail, after "..."', () => {
    const path = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Quake 3 Arena';
    const shown = shownName(path);
    expect(shown).toHaveLength(30);
    expect(shown).toBe(`...${path.slice(-27)}`);
    expect(shownName('C:\\Games\\Quake3')).toBe('C:\\Games\\Quake3');
  });
});
