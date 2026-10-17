import { afterEach, describe, expect, it, vi } from 'vitest';

/** `DEBUG_MODE` as a module evaluated under `DEV` would have it. */
async function debugModeUnder(dev: boolean): Promise<boolean> {
  vi.resetModules();
  vi.stubEnv('DEV', dev);
  return (await import('./config')).DEBUG_MODE;
}

describe('DEBUG_MODE', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is on under the dev server and off in a build', async () => {
    expect(await debugModeUnder(true)).toBe(true);
    expect(await debugModeUnder(false)).toBe(false);
  });
});
