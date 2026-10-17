import type { ShellInstall, ShellInstalls } from './pak/game-data';

/**
 * Whether the page is in the desktop shell (`electron/main.mjs`), which serves it on its own
 * `app:` scheme. The shell answers the dev server's routes over the install and `q3config.cfg`,
 * and owns its keys, since it has no browser menu.
 */
export function inShell(location: Pick<Location, 'protocol'> = window.location): boolean {
  return location.protocol === 'app:';
}

/** The shell's route to its install (`electron/app-protocol.mjs`). */
const INSTALL_ROUTE = '/install';

/**
 * The shell's install, through its route: GET reads the installs, and POST opens the native folder
 * dialog and keeps its pick for the next launch.
 */
export function shellInstall(fetcher: typeof fetch = (...args) => fetch(...args)): ShellInstall {
  const call = async (method: 'GET' | 'POST'): Promise<ShellInstalls & { refused?: string }> => {
    const response = await fetcher(INSTALL_ROUTE, { method });
    if (!response.ok) throw new Error(`${method} ${INSTALL_ROUTE}: ${response.status}`);
    const body = (await response.json()) as { running: string; next: string | null; refused?: string };
    return {
      running: body.running,
      next: body.next ?? undefined,
      ...(body.refused === undefined ? {} : { refused: body.refused })
    };
  };
  return { read: () => call('GET'), pick: () => call('POST') };
}

/** The shell's route to what its launch started Chromium with (`electron/app-protocol.mjs`). */
const LAUNCH_ROUTE = '/launch';

/** What the shell's launch started Chromium with, which holds until the next launch. */
export interface ShellLaunch {
  /** Vertical sync, `r_swapInterval` as `q3config.cfg` had it then. */
  vsync: boolean;
}

/** What the shell's launch started Chromium with, through its route. */
export async function shellLaunch(
  fetcher: typeof fetch = (...args) => fetch(...args)
): Promise<ShellLaunch> {
  const response = await fetcher(LAUNCH_ROUTE);
  if (!response.ok) throw new Error(`GET ${LAUNCH_ROUTE}: ${response.status}`);
  const body = (await response.json()) as { vsync?: unknown };
  return { vsync: body.vsync !== false };
}
