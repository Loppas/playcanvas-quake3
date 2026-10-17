import { describe, expect, it } from 'vitest';

import { defaultHomepath } from './default-homepath.mjs';

describe('defaultHomepath', () => {
  it('is the local app-data folder on Windows', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local' };
    expect(defaultHomepath({ platform: 'win32', env, home: 'C:\\Users\\p' })).toBe(
      'C:\\Users\\p\\AppData\\Local\\playcanvas-quake3'
    );
    expect(defaultHomepath({ platform: 'win32', env: {}, home: 'C:\\Users\\p' })).toBe(
      'C:\\Users\\p\\AppData\\Local\\playcanvas-quake3'
    );
  });

  it("is Application Support on macOS, as ioq3's is", () => {
    expect(defaultHomepath({ platform: 'darwin', env: { HOME: '/Users/p' }, home: '/x' })).toBe(
      '/Users/p/Library/Application Support/playcanvas-quake3'
    );
  });

  it('is the XDG config folder on Linux, or ~/.config without one', () => {
    const home = '/home/p';
    expect(defaultHomepath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, home })).toBe(
      '/cfg/playcanvas-quake3'
    );
    expect(defaultHomepath({ platform: 'linux', env: { XDG_CONFIG_HOME: '' }, home })).toBe(
      '/home/p/.config/playcanvas-quake3'
    );
  });
});
