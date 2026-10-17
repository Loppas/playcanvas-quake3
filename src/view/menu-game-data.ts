import type {
  GameDataContext,
  GameDataRecord,
  GameDataSource,
  RecordedGameData,
  ShellInstall,
  ShellInstalls
} from '../pak/game-data';
import { sameFolder, type InstallFolder } from '../pak/install-folder';
import type { Menu, MenuItem, MenuPage } from './menu';
import { back, radioButton, spinControl } from './menu-widgets';

/**
 * GAME DATA: where the game's files come from, and where the next start takes them from. The
 * port's own page, which Setup opens where q3_ui has CD Key, and which stands where CD Key stands
 * (`ui_cdkey.c:198–231`).
 *
 * Its rows are latched, as Q3's are ("will be changed upon restarting"): a change is recorded at
 * once for the next start, which carries it out, and nothing changes under the running game. A
 * line says so while a change waits, and setting a row back takes the change back.
 * - In the browser: FILES FROM, the install folder or paks dropped at the start; FOLDER, which
 *   picks another; and, for a game read from the cache, its size and CLEAR CACHE.
 * - In the shell: INSTALL, which picks another in the native dialog.
 * - On the dev server: where the files come from, with nothing to change.
 *
 * The paks are counted rather than named, since a whole install's don't fit the page.
 */

/** The line under the rows while a change waits. */
export const PENDING = 'Takes effect when the game next starts';
/** Q3's yellow, softened, as the menu draws a warning. */
const PENDING_COLOR = [1, 0.85, 0.3] as const;

/** FILES FROM's choices in a browser. */
const SOURCES = ['Folder', 'Dropped paks'];
/** FILES FROM, where nothing can change it. */
const SOURCE_NAMES: Record<GameDataSource['kind'], string> = {
  dev: 'Dev server',
  shell: 'Install',
  folder: 'Folder',
  cache: 'Dropped paks',
  paks: 'Dropped paks'
};

const FILES_FROM_STATUS = 'The install folder, read where it sits, or paks dropped at the start';
const FOLDER_STATUS = 'Picks the folder that holds baseq3';
const CLEAR_STATUS = 'Removes the kept paks, so the next start asks for them';
const REFUSED_STATUS = 'There are no Quake 3 paks in that folder';

/** The longest name or path a row shows; a longer one loses its head. */
const MAX_SHOWN = 30;

/**
 * A name as the menu's font draws it: printable ASCII, each other character a `?`, and cut to its
 * tail after "..." where it is longer than `max`.
 */
export function shownName(name: string, max: number = MAX_SHOWN): string {
  const ascii = Array.from(name, (ch) => (ch >= ' ' && ch <= '~' ? ch : '?')).join('');
  return ascii.length <= max ? ascii : `...${ascii.slice(ascii.length - (max - 3))}`;
}

/** A cache's size, in megabytes to a tenth. */
function megabytes(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** GAME DATA, opened afresh each time with what is recorded now. */
export interface GameDataMenu {
  /**
   * Read what is recorded, then open the page over `under`, if that is still the page on top.
   * Nothing opens before the boot has found the game data.
   */
  open(under: MenuPage): void;
}

/** @param context - Where the running game's data came from, once the boot has found it. */
export function gameDataMenu(menu: Menu, context: () => GameDataContext | undefined): GameDataMenu {
  let opening = false;
  return {
    open(under) {
      const data = context();
      if (!data || opening) return;
      opening = true;
      void gameDataPage(menu, data)
        .then((page) => {
          if (menu.page === under) menu.push(page);
        })
        .finally(() => (opening = false));
    }
  };
}

/** The page for where the game data came from, with what is recorded now. */
export async function gameDataPage(menu: Menu, data: GameDataContext): Promise<MenuPage> {
  const { source, record, install } = data;
  if (install) return shellPage(menu, source, install, await install.read().catch(() => undefined));
  if (record && source.kind !== 'dev' && source.kind !== 'shell') {
    return browserPage(menu, { ...data, source, record });
  }
  return page(menu, [info('Files from', () => SOURCE_NAMES[source.kind]), paksRow(source)]);
}

/** The page, with BACK after its rows. */
function page(menu: Menu, items: readonly MenuItem[]): MenuPage {
  return { id: 'gamedata', title: 'GAME DATA', layout: 'form', items: [...items, back(menu)] };
}

/** A row that only says something, which the cursor passes by. */
function info(label: string, value: () => string): MenuItem {
  return {
    label,
    inactive: true,
    get value() {
      return value();
    }
  };
}

function paksRow(source: GameDataSource): MenuItem {
  return info('Paks', () => String(source.paks));
}

/** The line saying a change waits for the next start, shown while one does. */
function pendingLine(pending: () => boolean): MenuItem {
  return {
    label: PENDING,
    color: PENDING_COLOR,
    inactive: true,
    place: 'pending',
    get hidden() {
      return !pending();
    }
  };
}

/** What is recorded, and whether its folder is the one the game runs on. */
interface BrowserState extends RecordedGameData {
  running: boolean;
}

/**
 * The browser's rows. Each change is written as it is made, then read back, so the rows show what
 * the next start will find. Changes run one at a time, in the order they are made.
 */
async function browserPage(
  menu: Menu,
  data: GameDataContext & {
    source: Exclude<GameDataSource, { kind: 'dev' | 'shell' }>;
    record: GameDataRecord;
  }
): Promise<MenuPage> {
  const { source, record, picker } = data;
  const runningFolder = source.kind === 'folder' ? source.folder : undefined;
  const read = async (): Promise<BrowserState> => {
    const recorded = await record.recorded();
    const { folder } = recorded;
    const running = folder !== undefined && runningFolder !== undefined && (await sameFolder(folder, runningFolder));
    return { ...recorded, running };
  };
  let state = await read();
  // CLEAR CACHE as the player last set it, which a turn to a folder and back puts back.
  let clearing = state.clearing && state.folder === undefined;
  let queue = Promise.resolve();
  const change = (act: () => Promise<void>) => {
    queue = queue
      .then(act)
      .catch(() => {})
      .then(async () => {
        state = await read();
      })
      .catch(() => {});
  };
  // The picker needs the key's or the click's own handler, so it is called before anything waits.
  const pick = () => {
    if (!picker) return;
    const picking = picker();
    change(async () => {
      const folder = await picking.catch(() => undefined);
      if (folder) await record.keepFolder(folder);
    });
  };
  const keep = (folder: InstallFolder) => change(() => record.keepFolder(folder));
  const drop = () =>
    change(async () => {
      await record.forgetFolder();
      if (source.kind !== 'folder') await record.markClear(clearing);
    });

  const rows: MenuItem[] = [
    spinControl({
      label: 'Files from',
      status: () => FILES_FROM_STATUS,
      names: SOURCES,
      get: () => (state.folder ? 0 : 1),
      // Turning back to the running folder keeps it again, with no picker.
      set: (index) => (index === 1 ? drop() : runningFolder ? keep(runningFolder) : pick()),
      grayed: () => !picker
    })
  ];
  if (picker) {
    rows.push({
      label: 'Folder',
      get value() {
        return state.folder ? shownName(state.folder.name) : 'none';
      },
      status: FOLDER_STATUS,
      activate: pick
    });
  }
  rows.push(paksRow(source));
  if (source.kind !== 'folder') {
    rows.push(
      info('Cache', () => (source.cache ? megabytes(source.cache.size) : 'none')),
      radioButton({
        label: 'Clear cache',
        status: () => CLEAR_STATUS,
        get: () => state.clearing,
        set: (on) => {
          clearing = on;
          change(() => record.markClear(on));
        },
        // A folder has the cache cleared anyway.
        hidden: () => !source.cache || state.folder !== undefined
      })
    );
  }
  rows.push(
    pendingLine(() =>
      source.kind === 'folder' ? !state.running : state.folder !== undefined || state.clearing
    )
  );
  return page(menu, rows);
}

/** The shell's rows: its install, which the native dialog changes for the next launch. */
function shellPage(
  menu: Menu,
  source: GameDataSource,
  install: ShellInstall,
  read: ShellInstalls | undefined
): MenuPage {
  let installs = read;
  let refused = false;
  let picking = false;
  return page(menu, [
    info('Files from', () => SOURCE_NAMES.shell),
    {
      label: 'Install',
      get value() {
        if (!installs) return '?';
        return installs.next === undefined ? 'none' : shownName(installs.next);
      },
      get status() {
        return refused ? REFUSED_STATUS : FOLDER_STATUS;
      },
      activate: () => {
        if (picking) return;
        picking = true;
        void install
          .pick()
          .then((after) => {
            installs = after;
            refused = after.refused !== undefined;
          })
          .catch(() => {})
          .finally(() => (picking = false));
      }
    },
    paksRow(source),
    pendingLine(() => installs !== undefined && installs.next !== installs.running)
  ]);
}
