// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPakDropScreen } from './drop-screen';

afterEach(() => vi.unstubAllEnvs());

describe('the drop screen', () => {
  it('says whose the game is, and that the player brings their own', () => {
    const screen = createPakDropScreen(document.createElement('div'), () => {});
    const text = screen.element.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('not affiliated with or endorsed by id Software');
    expect(text).toContain('you need your own copy of Quake III Arena');
    screen.destroy();
  });

  it('links the source it was built from, and each notice the build publishes beside it', () => {
    vi.stubEnv('BASE_URL', '/playcanvas-quake3/');
    const screen = createPakDropScreen(document.createElement('div'), () => {});
    const links = [...screen.element.querySelectorAll('a')];
    expect(__PRODUCT_NOTICES__).toContain('LICENSE.txt');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      __PRODUCT_SOURCE__,
      ...__PRODUCT_NOTICES__.map((name) => `/playcanvas-quake3/${name}`)
    ]);
    // Each in a tab of its own, which leaves the screen waiting where it was.
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener');
    }
    screen.destroy();
  });
});
