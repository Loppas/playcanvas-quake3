// @vitest-environment jsdom
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askForPaks, mountDevPaks, mountFolder, mountMapPaks, type PakBootStatus } from './boot';
import { createPakDropScreen } from './drop-screen';
import { fakeFolder, fakeInstallFolder } from './folder-test-fixtures';
import { fakeDevServer, fakeMapServer, fakeServers } from './pak-test-fixtures';
import { PakFileSystem } from './vfs';

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

const pk3 = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, encode(body)])));

/** A real jsdom `File` holding a real zip, so the drop route runs whole: slice, read, mount. */
function pakFile(name: string, files: Record<string, string>): File {
  return new File([new Uint8Array(pk3(files))], name);
}

/** Fire a change event on the drop screen's hidden file input with the given files. */
function pick(host: HTMLElement, files: File[]): void {
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}

/** Click one of the drop screen's buttons. */
function click(host: HTMLElement, selector: string): void {
  host.querySelector<HTMLElement>(selector)!.click();
}

/** What the drop screen says. */
const message = (host: HTMLElement) => host.querySelector('.pak-drop-message')!.textContent;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createPakDropScreen', () => {
  it('reports files chosen through the picker', () => {
    const host = document.createElement('div');
    const onFiles = vi.fn();
    createPakDropScreen(host, onFiles);
    const file = pakFile('pak0.pk3', { 'a.txt': 'x' });
    pick(host, [file]);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('reports dropped files and prevents the browser navigating to them', () => {
    const host = document.createElement('div');
    const onFiles = vi.fn();
    const screen = createPakDropScreen(host, onFiles);
    const file = pakFile('pak0.pk3', { 'a.txt': 'x' });

    const event = new Event('drop', { cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
    screen.element.dispatchEvent(event);

    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('detaches cleanly on destroy', () => {
    const host = document.createElement('div');
    const onFiles = vi.fn();
    const screen = createPakDropScreen(host, onFiles);
    screen.destroy();
    expect(host.querySelector('.pak-drop')).toBeNull();
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('offers no folder where the browser has no picker', () => {
    const host = document.createElement('div');
    createPakDropScreen(host, vi.fn());
    expect(host.querySelector('.pak-drop-folder')).toBeNull();
    expect(host.querySelector('.pak-drop-kept')).toBeNull();
  });

  it('offers a kept folder first, named as text, then the picker', () => {
    const host = document.createElement('div');
    const onUse = vi.fn();
    const onPickFolder = vi.fn();
    createPakDropScreen(host, vi.fn(), { onPickFolder, keptFolder: { name: '<b>ioquake</b>', onUse } });

    const buttons = [...host.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toEqual(['Use <b>ioquake</b>', 'Choose your Quake 3 folder']);
    click(host, '.pak-drop-kept');
    click(host, '.pak-drop-folder');
    expect(onUse).toHaveBeenCalledOnce();
    expect(onPickFolder).toHaveBeenCalledOnce();
  });
});

describe('mountDevPaks', () => {
  it('mounts every pak the dev server lists, in order, with no drop screen', async () => {
    vi.stubGlobal(
      'fetch',
      fakeDevServer({
        'pak8.pk3': pk3({ 'scripts/gfx.shader': 'pak8.pk3' }),
        'PAK0.PK3': pk3({ 'scripts/gfx.shader': 'PAK0.PK3', 'models/a.md3': 'IDP3' })
      })
    );
    const statuses: PakBootStatus['phase'][] = [];

    const fs = await mountDevPaks((s) => statuses.push(s.phase));

    expect(document.querySelector('.pak-drop')).toBeNull();
    expect(fs!.mounted.map((a) => a.label)).toEqual(['PAK0.PK3', 'pak8.pk3']);
    // Later pak wins, through the real mount path and the route's real range answers.
    expect(decode(await fs!.read('scripts/gfx.shader'))).toBe('pak8.pk3');
    expect(decode(await fs!.read('models/a.md3'))).toBe('IDP3');
    expect(statuses).toEqual(['discovering', 'loading', 'loading', 'ready']);
  });

  it('returns undefined when the server has no install', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const statuses: PakBootStatus['phase'][] = [];
    expect(await mountDevPaks((s) => statuses.push(s.phase))).toBeUndefined();
    expect(statuses).toEqual(['discovering']);
  });

  it('returns undefined when there is no dev server at all', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await mountDevPaks()).toBeUndefined();
  });

  it('skips a pak that will not open, with a warning, and boots from the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      fakeDevServer({ 'pak0.pk3': pk3({ 'a.txt': 'x' }), 'broken.pk3': new Uint8Array(64) })
    );
    const fs = await mountDevPaks();
    expect(fs!.mounted.map((a) => a.label)).toEqual(['pak0.pk3']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/broken\.pk3.*not a zip archive/));
  });

  it('reports a mount where nothing opens as an error status', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fakeDevServer({ 'pak0.pk3': new Uint8Array(64) }));
    const statuses: PakBootStatus[] = [];

    await expect(mountDevPaks((s) => statuses.push(s))).rejects.toThrow(/could not open the pk3 file/);
    expect(statuses.at(-1)).toMatchObject({ phase: 'error' });
  });
});

describe('mountMapPaks', () => {
  it("mounts the port's own map pk3s, apart from the install's paks", async () => {
    vi.stubGlobal(
      'fetch',
      fakeServers(
        fakeDevServer({ 'pak0.pk3': pk3({ 'scripts/arenas.txt': 'retail' }) }),
        fakeMapServer({
          'map-b.pk3': pk3({ 'maps/b.ent': 'b', 'x.txt': 'b' }),
          'map-a.pk3': pk3({ 'maps/a.ent': 'a', 'x.txt': 'a' })
        })
      )
    );

    const fs = await mountMapPaks();

    expect(fs!.mounted.map((a) => a.label)).toEqual(['map-a.pk3', 'map-b.pk3']);
    expect(decode(await fs!.read('x.txt'))).toBe('b');
    expect(fs!.has('scripts/arenas.txt')).toBe(false);
  });

  it('returns undefined when none is served', async () => {
    vi.stubGlobal('fetch', fakeMapServer({}));
    expect(await mountMapPaks()).toBeUndefined();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await mountMapPaks()).toBeUndefined();
  });

  it('rejects when none of those listed opens', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fakeMapServer({ 'map-a.pk3': new Uint8Array(64) }));
    await expect(mountMapPaks()).rejects.toThrow(/could not open the pk3 file/);
  });
});

describe('mountFolder', () => {
  it("mounts a picked folder's paks in ioq3's order, read where they sit", async () => {
    const folder = fakeFolder('ioquake', [
      fakeFolder('baseq3', [
        pakFile('pak8.pk3', { 'a.txt': 'pak8' }),
        pakFile('PAK0.PK3', { 'a.txt': 'pak0', 'b.txt': 'b' })
      ])
    ]);
    const statuses: PakBootStatus['phase'][] = [];

    const fs = await mountFolder(folder, (s) => statuses.push(s.phase));

    expect(fs!.mounted.map((a) => a.label)).toEqual(['PAK0.PK3', 'pak8.pk3']);
    expect(decode(await fs!.read('a.txt'))).toBe('pak8');
    expect(statuses).toEqual(['discovering', 'loading', 'loading', 'ready']);
  });

  it('returns undefined for a folder that is not an install', async () => {
    const downloads = fakeFolder('Downloads', [pakFile('pak0.pk3', { 'a.txt': 'x' })]);
    expect(await mountFolder(downloads)).toBeUndefined();
  });
});

describe('askForPaks', () => {
  it('mounts a dropped File and takes the screen down', async () => {
    const host = document.createElement('div');
    const statuses: PakBootStatus['phase'][] = [];
    const pending = askForPaks(host, (s) => statuses.push(s.phase));
    expect(host.querySelector('.pak-drop')).not.toBeNull();

    pick(host, [pakFile('pak0.pk3', { 'models/weapons2/bfg/bfg.md3': 'IDP3' })]);
    const { fs, folder } = await pending;

    expect(fs).toBeInstanceOf(PakFileSystem);
    expect(folder).toBeUndefined();
    expect(decode(await fs.read('models/weapons2/bfg/bfg.md3'))).toBe('IDP3');
    // The screen goes away only once a usable file system exists.
    expect(host.querySelector('.pak-drop')).toBeNull();
    expect(statuses).toEqual(['waiting-for-drop', 'loading', 'ready']);
  });

  it("mounts several dropped paks in ioq3's order, whatever order they came in", async () => {
    const host = document.createElement('div');
    const pending = askForPaks(host);
    pick(host, [pakFile('pak8.pk3', { 'a.txt': 'pak8' }), pakFile('pak0.pk3', { 'a.txt': 'pak0' })]);
    const { fs } = await pending;
    expect(fs.mounted.map((a) => a.label)).toEqual(['pak0.pk3', 'pak8.pk3']);
    expect(decode(await fs.read('a.txt'))).toBe('pak8');
  });

  it('keeps waiting when the dropped file is not a pk3', async () => {
    const host = document.createElement('div');
    void askForPaks(host);

    pick(host, [new File(['hello'], 'readme.txt')]);
    await Promise.resolve();

    expect(host.querySelector('.pak-drop')).not.toBeNull();
    expect(message(host)).toMatch(/not a \.pk3/);
  });

  it('keeps waiting, showing why, when the dropped pak is unreadable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = document.createElement('div');
    const statuses: PakBootStatus[] = [];
    const pending = askForPaks(host, (s) => statuses.push(s));

    pick(host, [new File([new Uint8Array(64)], 'broken.pk3')]);
    await vi.waitFor(() => expect(message(host)).toMatch(/broken\.pk3: not a zip archive/));
    expect(host.querySelector('.pak-drop')).not.toBeNull();
    expect(statuses.at(-1)).toMatchObject({ phase: 'error' });

    // A good pak dropped next still boots.
    pick(host, [pakFile('pak0.pk3', { 'a.txt': 'x' })]);
    expect((await pending).fs.has('a.txt')).toBe(true);
  });

  it('reads a picked install folder where it sits', async () => {
    const folder = fakeInstallFolder('ioquake', [
      fakeFolder('baseq3', [pakFile('pak0.pk3', { 'a.txt': 'x' })])
    ]);
    const host = document.createElement('div');
    const pending = askForPaks(host, undefined, { picker: async () => folder });

    click(host, '.pak-drop-folder');
    const given = await pending;

    expect(given.folder).toBe(folder);
    expect(given.fs.has('a.txt')).toBe(true);
    expect(host.querySelector('.pak-drop')).toBeNull();
  });

  it('keeps waiting, saying why, for a folder that is not an install', async () => {
    const host = document.createElement('div');
    void askForPaks(host, undefined, { picker: async () => fakeInstallFolder('Downloads') });

    click(host, '.pak-drop-folder');

    await vi.waitFor(() => expect(message(host)).toMatch(/No pk3 files in Downloads/));
    expect(host.querySelector('.pak-drop')).not.toBeNull();
  });

  it('leaves the screen as it was when the picker is cancelled', async () => {
    const host = document.createElement('div');
    const cancelled = () =>
      Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
    void askForPaks(host, undefined, { picker: cancelled });
    const before = message(host);

    click(host, '.pak-drop-folder');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(message(host)).toBe(before);
  });

  it('offers a kept folder again, and reads it once reading is allowed', async () => {
    const kept = fakeInstallFolder(
      'ioquake',
      [fakeFolder('baseq3', [pakFile('pak0.pk3', { 'a.txt': 'x' })])],
      { now: 'prompt', asked: 'granted' }
    );
    const host = document.createElement('div');
    const pending = askForPaks(host, undefined, { kept });

    click(host, '.pak-drop-kept');
    const given = await pending;

    expect(kept.requests).toBe(1);
    expect(given.folder).toBe(kept);
    expect(given.fs.has('a.txt')).toBe(true);
  });

  it('keeps waiting when reading a kept folder is refused', async () => {
    const kept = fakeInstallFolder('ioquake', [], { now: 'prompt', asked: 'denied' });
    const host = document.createElement('div');
    void askForPaks(host, undefined, { kept });

    click(host, '.pak-drop-kept');

    await vi.waitFor(() => expect(message(host)).toMatch(/ioquake wasn't opened/));
    expect(host.querySelector('.pak-drop')).not.toBeNull();
  });
});
