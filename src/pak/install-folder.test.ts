import { describe, expect, it } from 'vitest';
import { fakeFolder, fakeInstallFolder } from './folder-test-fixtures';
import { folderPicker, installPaks } from './install-folder';

const file = (name: string) => new File(['x'], name);
const names = (files: readonly File[]) => files.map((f) => f.name).sort();

describe('installPaks', () => {
  it("reads the pk3s in the picked folder's baseq3, whatever case the names are in", async () => {
    const folder = fakeFolder('ioquake', [
      file('readme.txt'),
      fakeFolder('missionpack', [file('pak0.pk3')]),
      fakeFolder('BaseQ3', [file('PAK0.PK3'), file('pak1.pk3'), file('q3config.cfg')])
    ]);
    expect(names(await installPaks(folder))).toEqual(['PAK0.PK3', 'pak1.pk3']);
  });

  it('reads baseq3 itself when that is the folder picked', async () => {
    expect(names(await installPaks(fakeFolder('baseq3', [file('pak0.pk3')])))).toEqual([
      'pak0.pk3'
    ]);
  });

  it('finds nothing in a folder that is not an install', async () => {
    const downloads = fakeFolder('Downloads', [file('pak0.pk3'), fakeFolder('baseq3')]);
    expect(await installPaks(downloads)).toEqual([]);
  });
});

describe('folderPicker', () => {
  it('is there only where the browser has one', () => {
    expect(folderPicker({})).toBeUndefined();
  });

  it('asks only to read, opening where it last opened for the install', async () => {
    const folder = fakeInstallFolder('ioquake');
    const calls: unknown[][] = [];
    const scope = {
      showDirectoryPicker(this: unknown, options: unknown) {
        calls.push([this, options]);
        return Promise.resolve(folder);
      }
    };
    expect(await folderPicker(scope)!()).toBe(folder);
    expect(calls).toEqual([[scope, { id: 'quake3-install', mode: 'read' }]]);
  });
});
