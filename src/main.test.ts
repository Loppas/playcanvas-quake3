// @vitest-environment jsdom
import { zipSync } from 'fflate';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import type { AppHandle, SetupOptions } from './App';
import { runJob, type DecodeAnswer, type DecodeJob } from './formats/decode-jobs';
import { decodeTga } from './formats/tga';
import { memorySource } from './pak/byte-source';
import type { FileStore } from './settings/config-file';

/**
 * Integration coverage for the DOM layer: `main.ts` builds the page, wires the HUD to the
 * app's update loop, and surfaces a failed boot to the user.
 *
 * The graphics device is the one seam that cannot run here — jsdom has no WebGPU or WebGL2 —
 * so `setupApp` is stubbed and everything downstream of it is the real code.
 */

const setupApp = vi.hoisted(() => vi.fn());
vi.mock('./App', () => ({ setupApp }));

// The asset boot is the other seam jsdom cannot run: it wants OPFS, then fetches the local
// install, and failing both puts up a drop screen and waits forever. Its parts are covered
// in `pak/boot.test.ts` and `formats/weapon-assets.test.ts`; here only `bootAssets`
// is stubbed, so the real status words and progress are what get tested.
const bootAssets = vi.hoisted(() => vi.fn());
vi.mock('./asset-boot', async () => ({
  ...(await vi.importActual<typeof import('./asset-boot')>('./asset-boot')),
  bootAssets
}));

// The kept files' stores are OPFS and the dev server's route, and jsdom has neither. With no
// stores, the rest of the config code runs for real.
const homeStores = vi.hoisted(() => vi.fn());
vi.mock('./settings/config-file', async () => ({
  ...(await vi.importActual<typeof import('./settings/config-file')>('./settings/config-file')),
  homeStores
}));

// jsdom has no workers. The decode worker's stand-in does each job as the worker does, on this
// thread, and answers a task later, as a worker would.
/** The scripts of the workers the page started, and the kinds of job each was given. */
let workers: { script: string; jobs: string[] }[] = [];
class StandInWorker {
  onmessage: ((event: { data: DecodeAnswer }) => void) | null = null;
  private readonly jobs: string[] = [];

  constructor(script: URL) {
    workers.push({ script: script.pathname, jobs: this.jobs });
  }

  postMessage(job: DecodeJob): void {
    this.jobs.push(job.kind);
    const { answer } = runJob(job);
    setTimeout(() => this.onmessage?.({ data: answer }));
  }
}

/** Update callbacks registered by main.ts against the fake app. */
let updateHandlers: ((dt: number) => void)[] = [];

/**
 * Build a fake {@link AppHandle} that records the update callbacks main.ts registers.
 *
 * @param overrides - Handle fields to override.
 */
function fakeHandle(overrides: Partial<AppHandle> = {}): AppHandle {
  return {
    app: {
      on: (_event: string, handler: (dt: number) => void) => updateHandlers.push(handler)
    },
    deviceType: 'webgpu',
    splatCount: 1_500_000,
    viewpos: () => '(-4 -4 69) : 0',
    ...overrides
  } as AppHandle;
}

/**
 * Drive the app's update loop.
 *
 * @param seconds - Total time to simulate.
 * @param step - Delta per tick, in seconds.
 */
function tick(seconds: number, step = 1 / 60) {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    updateHandlers.forEach((handler) => handler(step));
  }
}

/** Import main.ts fresh, so its top-level boot runs against the current mocks. */
async function bootPage() {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  await import('./main');
}

const hud = () => document.getElementById('hud');

/** An address with the status line on, which starts off. */
const STATUS_LINE = '/?pcq_drawStatusLine=1';

/** What the page started the app with. */
const setup = (): SetupOptions => setupApp.mock.calls[0][0] as SetupOptions;

/** The stand-ins a boot runs against, reset. */
function standIn() {
  workers = [];
  vi.stubGlobal('Worker', StandInWorker);
  updateHandlers = [];
  setupApp.mockReset();
  bootAssets.mockReset();
  // Default: a mount that never resolves, as when the drop screen is waiting for a file.
  bootAssets.mockReturnValue(new Promise(() => {}));
  homeStores.mockReset();
  homeStores.mockImplementation(() => []);
}

/** The page and its address as a boot found them. */
function cleanUp() {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
}

// The first import of main.ts transforms all it imports, which on a loaded machine can outlast a
// test's timeout, and a boot left running when its test timed out calls setupApp in the next. The
// first boot is taken here, with a minute to take.
beforeAll(async () => {
  standIn();
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  cleanUp();
}, 60_000);

beforeEach(standIn);

afterEach(cleanUp);

it('mounts a canvas and a HUD into the page', async () => {
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();

  expect(document.getElementById('application-canvas')).toBeInstanceOf(HTMLCanvasElement);
  expect(hud()).not.toBeNull();
});

it('boots the app against the mounted canvas', async () => {
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();

  expect(setupApp).toHaveBeenCalledOnce();
  expect(setup().canvas).toBe(document.getElementById('application-canvas'));
});

it('shows the load screen, and hands it to the app to take away', async () => {
  let started!: (handle: AppHandle) => void;
  setupApp.mockReturnValue(new Promise((resolve) => (started = resolve)));
  const booted = bootPage();
  await vi.waitFor(() => expect(setupApp).toHaveBeenCalledOnce());

  expect(document.querySelector('.load-title')?.textContent).toBe('playcanvas-quake3');
  expect(document.querySelector('.load-text')?.textContent).toBe('Loading... game data');
  // The app is handed the screen, for its own steps, and no map: it starts on the main menu.
  expect(setup().map).toBeUndefined();
  started(fakeHandle());
  await booted;
  // The app's to close, which a boot's map holds until the player is in its world.
  expect(document.querySelector('.load-screen')).not.toBeNull();
  setup().loading.close();
  expect(document.querySelector('.load-screen')).toBeNull();
});

it("fills the load screen's bar as the game data comes in, and names each file", async () => {
  let report!: (status: unknown) => void;
  bootAssets.mockImplementation((_host: HTMLElement, onStatus: (s: unknown) => void) => {
    report = onStatus;
    return new Promise(() => {});
  });
  let started!: (handle: AppHandle) => void;
  setupApp.mockReturnValue(new Promise((resolve) => (started = resolve)));
  const booted = bootPage();
  await vi.waitFor(() => expect(setupApp).toHaveBeenCalledOnce());
  const bar = () => document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow');
  const file = () => document.querySelector('.load-file')?.textContent;

  // The paks are mounted, a fifth of the boot's share, and the boot is the only step here.
  report({ phase: 'paks', pak: { phase: 'ready', fs: {} } });
  expect([bar(), file()]).toEqual(['20', 'extracting']);
  // Half the files are read, and they take the rest.
  report({
    phase: 'extracting',
    read: { done: 1, total: 2, path: 'sound/weapons/change.wav' },
    keeps: false
  });
  expect([bar(), file()]).toEqual(['60', 'reading sound/weapons/change.wav (1/2)']);
  started(fakeHandle());
  await booted;
});

it('reports backend and splat count once running, and lists no keys or settings', async () => {
  window.history.replaceState(null, '', STATUS_LINE);
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  tick(1);

  const text = hud()?.textContent ?? '';
  expect(text).toContain('webgpu');
  expect(text).toContain('opengl1, r_overBrightBits 1');
  expect(text).toContain('1.50M splats');
  // The keys are the Controls page's and the settings the menu's; the line is the game's
  // readings alone.
  expect(text).not.toMatch(/WASD|LMB|Esc menu/);
  expect(text).not.toContain('g_allowGrapple');
});

it('shows where the view is, as viewpos prints it, and follows it', async () => {
  let reading = '(-4 -4 69) : 0';
  window.history.replaceState(null, '', STATUS_LINE);
  setupApp.mockResolvedValue(fakeHandle({ viewpos: () => reading }));
  await bootPage();
  tick(1);
  expect(hud()?.textContent).toMatch(/^\d+ fps \| viewpos \(-4 -4 69\) : 0 \| webgpu/);

  reading = '(1056 2016 868) : 242';
  tick(1 / 60);
  expect(hud()?.textContent).toContain('viewpos (1056 2016 868) : 242 |');
});

it("hands the app the player's paks as soon as they are mounted, before the assets", async () => {
  const paks = { mounted: [] };
  bootAssets.mockImplementation(
    (_host: HTMLElement, _onStatus: unknown, options: { onMounted: (fs: unknown) => void }) => {
      options.onMounted(paks);
      return new Promise(() => {});
    }
  );
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();

  // The map is read through them, and waits for them but not for the assets.
  await expect(setup().paks).resolves.toBe(paks);
});

it("hands the app the favourite servers as favorites.txt's stores keep them", async () => {
  /** A store holding a file. */
  const kept = (text: string): FileStore => ({ read: async () => text, write: async () => true });
  const stores: Record<string, FileStore[]> = {
    'q3config.cfg': [kept('seta cg_fov "110"\n')],
    'favorites.txt': [kept('10.0.0.5:27960 "Office"\n')]
  };
  homeStores.mockImplementation((name: string) => stores[name]);
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();

  expect(setup().favorites.saved).toBe('10.0.0.5:27960 "Office"\n');
  expect(setup().favorites.stores).toBe(stores['favorites.txt']);
});

it("hands the app none of the player's paks when the boot fails before mounting any", async () => {
  bootAssets.mockRejectedValue(new Error('no pk3 files in the Quake 3 install'));
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();

  // The map is read from the port's own pk3s alone.
  await expect(setup().paks).resolves.toBeUndefined();
});

it('throws the grapple style the query string asks for', async () => {
  window.history.replaceState(null, '', '/?g_allowGrapple=3');
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();

  // The app throws the hook its config names.
  expect(setup().config.cvars.settings.allowGrapple).toBe(3);
});

it('takes the hook away at g_allowGrapple 0, as CorkScrew does', async () => {
  window.history.replaceState(null, '', '/?g_allowGrapple=0');
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();

  expect(setup().config.cvars.settings.allowGrapple).toBe(0);
});

it('starts with the status line hidden, and follows pcq_drawStatusLine', async () => {
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  tick(1);
  expect(hud()?.hidden).toBe(true);

  setup().config.command(['pcq_drawStatusLine', '1']);
  tick(1);
  expect(hud()?.hidden).toBe(false);
  expect(hud()?.textContent).toContain('fps');

  setup().config.command(['pcq_drawStatusLine', '0']);
  tick(1);
  expect(hud()?.hidden).toBe(true);
});

it('starts the map the address names, as the command line names one with +map', async () => {
  window.history.replaceState(null, '', '/?map=backyard');
  let started!: (handle: AppHandle) => void;
  setupApp.mockReturnValue(new Promise((resolve) => (started = resolve)));
  const booted = bootPage();
  await vi.waitFor(() => expect(setupApp).toHaveBeenCalledOnce());

  expect(document.querySelector('.load-title')?.textContent).toBe('backyard');
  expect(setup().map).toBe('backyard');
  started(fakeHandle());
  await booted;
});

it('quits the game at EXIT GAME before the window closes, then stops it if it stays', async () => {
  const quit = vi.fn();
  const destroy = vi.fn();
  const handle = fakeHandle({ quit });
  Object.assign(handle.app, { destroy });
  setupApp.mockResolvedValue(handle);
  const close = vi.spyOn(window, 'close').mockImplementation(() => {});
  try {
    await bootPage();
    setup().host.exit();
    expect(quit).toHaveBeenCalledOnce();
    expect(quit.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    // The browser kept the tab, which the page learns only by still being here.
    expect(destroy).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce(), { timeout: 2000 });
  } finally {
    close.mockRestore();
  }
});

it('gives the app a load screen of its own for each map it changes to', async () => {
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  setup().loading.close();

  const screen = setup().loadScreen('backyard');
  expect(document.querySelector('.load-title')?.textContent).toBe('backyard');
  screen.close();
  expect(document.querySelector('.load-screen')).toBeNull();
});

it('gives the app a connect screen for each connect, naming the server as named', async () => {
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  setup().loading.close();

  const screen = setup().connectScreen('localhost:27960');
  expect(document.querySelector('.load-server')?.textContent).toBe('Connecting to localhost:27960');
  screen.close();
  expect(document.querySelector('.load-screen')).toBeNull();
});

it('surfaces a failed boot with the status line off, since that is not the status line', async () => {
  window.history.replaceState(null, '', '/?pcq_drawStatusLine=0');
  setupApp.mockRejectedValue(new Error('Failed to load /maps/backyard.sog'));
  await bootPage().catch(() => {});

  expect(hud()?.hidden).toBe(false);
  expect(hud()?.textContent).toBe('Failed to load /maps/backyard.sog');
});

it('draws like the renderer the query string asks for, and says so in the HUD', async () => {
  window.history.replaceState(null, '', `${STATUS_LINE}&cl_renderer=opengl2&r_overBrightBits=0&r_specularMapping=0`);
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  tick(1);

  // The mapping pair only where one is off.
  expect(hud()?.textContent).toContain('opengl2, r_overBrightBits 0, r_specularMapping 0');
  expect(hud()?.textContent).not.toContain('r_normalMapping');
  // The same module instance main.ts set it on: `bootPage` reset the registry before importing.
  const { rendererStyle } = await import('./view/overbright');
  expect(rendererStyle()).toEqual({
    renderer: 'opengl2',
    overBrightBits: 0,
    normalMapping: true,
    specularMapping: false
  });
});

it("inflates the paks' entries, and decodes their TGAs, in a worker of its own", async () => {
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  expect(workers.map(({ script }) => script)).toEqual([
    expect.stringMatching(/decode-worker\.ts$/)
  ]);

  // The same module instances main.ts set them on: `bootPage` reset the registry before importing.
  const { ZipArchive } = await import('./pak/zip');
  const { decodeImage } = await import('./render/md3-mesh');
  const shader = 'textures/sfx/flame { }\n'.repeat(20);
  const zip = zipSync({ 'scripts/a.shader': new TextEncoder().encode(shader) });
  const archive = await ZipArchive.open(memorySource('a.pk3', zip));
  expect(new TextDecoder().decode(await archive.read('scripts/a.shader'))).toBe(shader);
  const tga = new Uint8Array([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 24, 0, 1, 2, 3]);
  const image = await decodeImage('models/a.tga', tga);
  expect([...image.pixels]).toEqual([...decodeTga(tga).pixels]);
  expect(workers[0].jobs).toEqual(['inflate', 'tga']);
});

it('reports pak read progress in the HUD', async () => {
  // The status callback is the only channel the asset layer has to the user while a 457 MB
  // pak0 streams in, so the HUD must reflect whatever phase it last reported.
  window.history.replaceState(null, '', STATUS_LINE);
  bootAssets.mockImplementation((_host: HTMLElement, onStatus: (s: unknown) => void) => {
    onStatus({
      phase: 'paks',
      pak: { phase: 'loading', progress: { label: 'pak0.pk3', index: 1, total: 9 } }
    });
    return new Promise(() => {});
  });
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  tick(1);

  expect(hud()?.textContent).toContain('assets: reading pak0.pk3 (1/9)');
});

it('reports a warm boot as coming from the cache', async () => {
  // The cache's whole point: the second boot never touches a pak, and the HUD should say so.
  window.history.replaceState(null, '', STATUS_LINE);
  bootAssets.mockImplementation((_host: HTMLElement, onStatus: (s: unknown) => void) => {
    onStatus({
      phase: 'ready',
      source: 'cache',
      library: { files: { size: 203 }, byteLength: 3.3 * 1024 * 1024 }
    });
    return new Promise(() => {});
  });
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  tick(1);

  expect(hud()?.textContent).toContain('assets: 203 files, 3.3 MB from cache');
});

it('keeps running when the asset boot fails', async () => {
  // Weapons are unavailable, but the map and movement must still boot.
  window.history.replaceState(null, '', STATUS_LINE);
  bootAssets.mockImplementation((_host: HTMLElement, onStatus: (s: unknown) => void) => {
    onStatus({ phase: 'error', message: 'pak0.pk3 failed to load (404)' });
    return Promise.reject(new Error('pak0.pk3 failed to load (404)'));
  });
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  tick(1);

  expect(hud()?.textContent).toContain('assets: pak0.pk3 failed to load (404)');
  expect(hud()?.classList.contains('error')).toBe(false);
});

it('reports the frame rate it is actually being ticked at', async () => {
  window.history.replaceState(null, '', STATUS_LINE);
  setupApp.mockResolvedValue(fakeHandle());
  await bootPage();
  tick(1, 1 / 144);

  expect(hud()?.textContent).toMatch(/^14[34] fps/);
});

it('surfaces a failed boot in the HUD instead of a blank screen', async () => {
  setupApp.mockRejectedValue(new Error('Failed to load /maps/backyard.sog'));
  await bootPage().catch(() => {
    // main.ts rethrows after reporting, which rejects the dynamic import.
  });

  expect(hud()?.textContent).toBe('Failed to load /maps/backyard.sog');
  expect(hud()?.classList.contains('error')).toBe(true);
  expect(document.querySelector('.load-screen')).toBeNull();
});
