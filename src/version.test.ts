import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformString, versionString } from './version';

describe('version', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is the game name, the build, the platform and the day it was built', () => {
    expect(versionString()).toMatch(
      /^PlayCanvasQuake \d+\.\d+\.\d+(_g[0-9a-f]+)? node [A-Z][a-z]{2} [ \d]\d \d{4}$/
    );
  });

  it('is Node where there is no location', () => {
    expect(platformString()).toBe('node');
  });

  it("is the page's in a worker, which has a location and no window", () => {
    vi.stubGlobal('location', { protocol: 'http:' });
    expect(platformString()).toBe('browser');
    vi.stubGlobal('location', { protocol: 'app:' });
    expect(platformString()).toBe('shell');
  });
});
