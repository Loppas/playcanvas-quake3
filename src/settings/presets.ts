import { type HomeFolder, homePath } from './home-folder';

/**
 * The presets: cfgs in `presets` that set a ruleset's cvars, run with `exec`, so a switch takes
 * effect as each value is read. The port ships one for id's Quake 3 and one for each of CPMA's
 * rulesets. A player's own go in the home folder's `presets`, where a copy of a shipped one is
 * read in its place.
 */

/** The presets' folder, in the home folder and among the port's own files. */
export const PRESET_DIR = 'presets';

/** The shipped presets by name, in the order they are offered: id's Quake 3's, then CPMA's. */
export const SHIPPED_PRESETS: readonly string[] = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'];

/** The shipped files' text, by their paths in lower case. */
const SHIPPED_CFGS = new Map(
  Object.entries(
    import.meta.glob<string>('./presets/*.cfg', { query: '?raw', import: 'default', eager: true })
  ).map(([file, text]) => [file.slice('./'.length).toLowerCase(), text])
);

/**
 * One of the port's own cfgs, by its path as `exec` names it, matched without regard to case, as
 * Q3 finds a file in a pak (`FS_FilenameCompare`).
 *
 * @returns Its text, or `undefined` for a file the port doesn't ship.
 */
export function shippedCfg(path: string): string | undefined {
  return SHIPPED_CFGS.get(path.toLowerCase());
}

/**
 * A cfg by its name: the home folder's, else the port's own, as Q3 searches `fs_homepath` before
 * the install. The name is taken as a path the way the console's writes take it ({@link homePath}),
 * so a cfg is read back by the name it was written under.
 *
 * @returns Its text, or `undefined` where neither has it.
 */
export async function readCfg(name: string, home: HomeFolder): Promise<string | undefined> {
  const path = homePath(name);
  return (await home.read(path)) ?? shippedCfg(path);
}

/**
 * The cfgs Tab lists for `exec`, by the paths {@link readCfg} reads them by, as ioquake3 lists its
 * search path's (`FS_ListFilteredFiles`, `files.c:2189–2322`): the home folder's directly in it,
 * then the port's own, as a pak's are listed, with their folder.
 */
export async function listCfgs(home: Pick<HomeFolder, 'list'>): Promise<string[]> {
  return [...(await home.list('', '.cfg')), ...SHIPPED_CFGS.keys()];
}

/**
 * The presets on offer, by their files' names without `.cfg`: the shipped ones in their order,
 * then the home folder's others, sorted.
 */
export async function listPresets(home: HomeFolder): Promise<string[]> {
  const shipped = new Set(SHIPPED_PRESETS);
  const own = (await home.list(PRESET_DIR, '.cfg'))
    .map((file) => file.slice(0, -'.cfg'.length))
    .filter((name) => !shipped.has(name.toLowerCase()));
  return [...SHIPPED_PRESETS, ...own.sort()];
}
