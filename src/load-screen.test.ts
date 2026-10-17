// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { ConnectScreen, LoadScreen, downloaded } from './load-screen';
import { CA } from './net/connection';

/** The load screen: its bar, its line, and its steps settling; and the connect screen before it. */

/** A load screen on a root of its own. */
function opened(title = 'garage_rats') {
  const root = document.createElement('div');
  return { root, screen: new LoadScreen(root, title) };
}

const line = (root: HTMLElement) => root.querySelector('.load-text')!.textContent;
const file = (root: HTMLElement) => root.querySelector('.load-file')!.textContent;
const bar = (root: HTMLElement) => Number(root.querySelector('[role=progressbar]')!.getAttribute('aria-valuenow'));

describe('LoadScreen', () => {
  it("fills by each step's share, and never goes back", () => {
    const { root, screen } = opened();
    const map = screen.step('maps/garage_rats.sog', 3);
    const sounds = screen.step('sounds');
    expect(bar(root)).toBe(0);

    sounds.finish();
    expect(screen.fraction).toBe(0.25);
    map.advance(0.5);
    expect(screen.fraction).toBe(0.625);
    map.advance(0.25);
    expect(screen.fraction).toBe(0.625);
    expect(bar(root)).toBe(63);

    map.finish();
    expect(bar(root)).toBe(100);
  });

  it('renames a step in its place, as a boot names its map once it knows its files', () => {
    const { root, screen } = opened('q3dm1');
    const map = screen.step('maps/q3dm1.sog', 3);
    screen.step('sounds');
    map.rename('maps/q3dm1.bsp');
    expect(screen.steps.map((step) => step.label)).toEqual(['maps/q3dm1.bsp', 'sounds']);
    expect(line(root)).toBe('Loading... maps/q3dm1.bsp');
  });

  it("names the first step still loading, as Q3's line does", () => {
    const { root, screen } = opened();
    const collision = screen.step('collision map');
    const sounds = screen.step('sounds');
    screen.step('graphics');
    expect(line(root)).toBe('Loading... collision map');

    // One that comes in early leaves the line on the one before it.
    sounds.finish();
    expect(line(root)).toBe('Loading... collision map');
    collision.finish();
    expect(line(root)).toBe('Loading... graphics');
    screen.loading!.finish();
    expect([screen.loading, line(root)]).toEqual([null, '']);
  });

  it('shows what the step on the line is doing, under it', () => {
    const { root, screen } = opened();
    const data = screen.step('game data', 2);
    const sounds = screen.step('sounds');
    expect(file(root)).toBe('');

    // A later step's file waits for the line to reach it.
    sounds.advance(0.5, 'sound/weapons/change.wav (1/2)');
    expect(file(root)).toBe('');
    data.advance(0.5, 'models/weapons2/rocketl/rocketl.md3 (1/2)');
    expect([line(root), file(root)]).toEqual([
      'Loading... game data',
      'models/weapons2/rocketl/rocketl.md3 (1/2)'
    ]);

    // One stands until another comes, and a new one shows at the same fraction.
    data.advance(0.75);
    expect(file(root)).toBe('models/weapons2/rocketl/rocketl.md3 (1/2)');
    data.advance(0.75, 'models/weapons2/rocketl/rocketl_hand.md3 (2/2)');
    expect(file(root)).toBe('models/weapons2/rocketl/rocketl_hand.md3 (2/2)');

    data.finish();
    expect([line(root), file(root)]).toEqual(['Loading... sounds', 'sound/weapons/change.wav (1/2)']);
  });

  it("reads a download's megabytes, of the whole where it is known", () => {
    expect(downloaded(1024 * 1024 * 84.1, 1024 * 1024 * 176.2)).toBe('84.1 of 176.2 MB');
    expect(downloaded(1024 * 1024 * 3, 0)).toBe('3.0 MB');
  });

  it('finishes a step once its work settles, either way', async () => {
    const { screen } = opened();
    const graphics = screen.step('graphics');
    const clients = screen.step('clients');

    expect(await graphics.track(Promise.resolve(7))).toBe(7);
    expect(graphics.finished).toBe(true);
    await expect(clients.track(Promise.reject(new Error('no model')))).rejects.toThrow('no model');
    expect(clients.finished).toBe(true);
  });

  it("shows the map's name, and goes when it closes", () => {
    const { root, screen } = opened();
    expect(root.querySelector('.load-title')!.textContent).toBe('garage_rats');
    screen.close();
    expect(root.querySelector('.load-screen')).toBeNull();
  });

  it('keeps a line under the title for the server, and names it once it is known', () => {
    const { root, screen } = opened();
    const server = root.querySelector('.load-server')!;
    expect(server.textContent).toBe('');
    screen.showServer('localhost');
    expect(server.textContent).toBe('Connecting to localhost');
  });

  it("shows cgame's lines under the panel, in their groups, with no group for none", () => {
    const { root, screen } = opened();
    const groups = () =>
      [...root.querySelectorAll('.load-panel > .load-info > .load-group')].map((group) =>
        [...group.querySelectorAll('p')].map((line) => line.textContent)
      );
    screen.showInformation({ server: ['Garage', ''], match: ['Free For All', 'fraglimit 20'] });
    expect(groups()).toEqual([
      ['Garage', ''],
      ['Free For All', 'fraglimit 20']
    ]);

    screen.showInformation({ server: [], match: ['Tournament'] });
    expect(groups()).toEqual([['Tournament']]);
  });
});

describe('ConnectScreen', () => {
  /** A connect screen on a root of its own. */
  function connecting(server = 'localhost:27960') {
    const root = document.createElement('div');
    return { root, screen: new ConnectScreen(root, server) };
  }

  const message = (root: HTMLElement) =>
    root.querySelector('.load-info .load-message')!.textContent;

  it("stands in the load screen's panel, the server under the map's line, the bar hidden", () => {
    const { root } = connecting();
    expect(root.querySelector('.load-title')!.textContent).toBe('');
    expect(root.querySelector('.load-server')!.textContent).toBe('Connecting to localhost:27960');
    // The bar keeps its room, so the load takes the panel over without moving it.
    expect(root.querySelector<HTMLElement>('.load-bar')!.style.visibility).toBe('hidden');
    const shape = (host: HTMLElement) =>
      [...host.querySelector('.load-panel')!.children].map((part) => part.className);
    const loading = document.createElement('div');
    new LoadScreen(loading, 'garage_rats');
    expect(shape(root)).toEqual(shape(loading));
  });

  it("follows the connection's state, and the server's print until the connection is up", () => {
    const { root, screen } = connecting();
    // Blank while the server is looked up.
    screen.show(null);
    expect([line(root), message(root)]).toEqual(['', '']);

    screen.show({ state: CA.CONNECTING, connectPacketCount: 1, serverMessage: '' });
    expect([line(root), message(root)]).toEqual(['Awaiting challenge...1', '']);
    const full = 'Server is full\n';
    screen.show({ state: CA.CHALLENGING, connectPacketCount: 2, serverMessage: full });
    expect([line(root), message(root)]).toEqual(['Awaiting connection...2', 'Server is full']);
    screen.show({ state: CA.CONNECTED, connectPacketCount: 0, serverMessage: full });
    expect([line(root), message(root)]).toEqual(['Awaiting gamestate...', '']);
  });

  it('writes a line only when it changes', () => {
    const { root, screen } = connecting();
    const challenging = { state: CA.CHALLENGING, connectPacketCount: 1, serverMessage: '' };
    screen.show(challenging);
    const written = root.querySelector('.load-text')!.firstChild;
    screen.show({ ...challenging });
    expect(root.querySelector('.load-text')!.firstChild).toBe(written);
    screen.show({ ...challenging, connectPacketCount: 2 });
    expect(root.querySelector('.load-text')!.firstChild).not.toBe(written);
  });

  it('goes when it closes', () => {
    const { root, screen } = connecting();
    screen.close();
    expect(root.querySelector('.load-screen')).toBeNull();
  });
});
