import { describe, expect, it } from 'vitest';

import { ConnectScreen, LoadScreen, LoadScreens, downloaded } from './load-screen';
import { CA } from './net/connection';

/** The load screen: its bar, its line, and its steps settling; the connect screen before it; and the stack they stand on. */

/** A load screen on a stack of its own. */
function opened(title = 'garage_rats') {
  const screens = new LoadScreens();
  return { screens, screen: new LoadScreen(screens, title) };
}

describe('LoadScreen', () => {
  it("fills by each step's share, and never goes back", () => {
    const { screen } = opened();
    const map = screen.step('maps/garage_rats.sog', 3);
    const sounds = screen.step('sounds');
    expect(screen.fraction).toBe(0);

    sounds.finish();
    expect(screen.fraction).toBe(0.25);
    map.advance(0.5);
    expect(screen.fraction).toBe(0.625);
    map.advance(0.25);
    expect(screen.fraction).toBe(0.625);

    map.finish();
    expect(screen.fraction).toBe(1);
  });

  it('renames a step in its place, as a boot names its map once it knows its files', () => {
    const { screen } = opened('q3dm1');
    const map = screen.step('maps/q3dm1.sog', 3);
    screen.step('sounds');
    map.rename('maps/q3dm1.bsp');
    expect(screen.steps.map((step) => step.label)).toEqual(['maps/q3dm1.bsp', 'sounds']);
    expect(screen.line).toBe('Loading... maps/q3dm1.bsp');
  });

  it("names the first step still loading, as Q3's line does", () => {
    const { screen } = opened();
    const collision = screen.step('collision map');
    const sounds = screen.step('sounds');
    screen.step('graphics');
    expect(screen.line).toBe('Loading... collision map');

    // One that comes in early leaves the line on the one before it.
    sounds.finish();
    expect(screen.line).toBe('Loading... collision map');
    collision.finish();
    expect(screen.line).toBe('Loading... graphics');
    screen.loading!.finish();
    expect([screen.loading, screen.line]).toEqual([null, '']);
  });

  it('shows what the step on the line is doing, under it', () => {
    const { screen } = opened();
    const data = screen.step('game data', 2);
    const sounds = screen.step('sounds');
    expect(screen.detail).toBe('');

    // A later step's file waits for the line to reach it.
    sounds.advance(0.5, 'sound/weapons/change.wav (1/2)');
    expect(screen.detail).toBe('');
    data.advance(0.5, 'models/weapons2/rocketl/rocketl.md3 (1/2)');
    expect([screen.line, screen.detail]).toEqual([
      'Loading... game data',
      'models/weapons2/rocketl/rocketl.md3 (1/2)'
    ]);

    // One stands until another comes, and a new one shows at the same fraction.
    data.advance(0.75);
    expect(screen.detail).toBe('models/weapons2/rocketl/rocketl.md3 (1/2)');
    data.advance(0.75, 'models/weapons2/rocketl/rocketl_hand.md3 (2/2)');
    expect(screen.detail).toBe('models/weapons2/rocketl/rocketl_hand.md3 (2/2)');

    data.finish();
    expect([screen.line, screen.detail]).toEqual(['Loading... sounds', 'sound/weapons/change.wav (1/2)']);
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

  it("shows the map's name over its bar, and goes when it closes", () => {
    const { screens, screen } = opened();
    expect([screen.title, screen.bar]).toEqual(['garage_rats', true]);
    expect(screens.top).toBe(screen);
    screen.close();
    expect(screens.top).toBeNull();
  });

  it('keeps a line under the title for the server, and names it once it is known', () => {
    const { screen } = opened();
    expect(screen.server).toBe('');
    screen.showServer('localhost');
    expect(screen.server).toBe('Connecting to localhost');
  });

  it("shows cgame's lines under the panel, in their groups, with no group for none", () => {
    const { screen } = opened();
    expect(screen.groups).toEqual([]);
    screen.showInformation({ server: ['Garage', ''], match: ['Free For All', 'fraglimit 20'] });
    expect(screen.groups).toEqual([
      ['Garage', ''],
      ['Free For All', 'fraglimit 20']
    ]);

    screen.showInformation({ server: [], match: ['Tournament'] });
    expect(screen.groups).toEqual([['Tournament']]);
  });

  it('changes its revision with each change, and with nothing else', () => {
    const { screen } = opened();
    const map = screen.step('maps/garage_rats.sog', 3);
    let seen = screen.revision;
    const changed = () => {
      const moved = screen.revision !== seen;
      seen = screen.revision;
      return moved;
    };

    map.advance(0.5, 'maps/garage_rats.sog');
    expect(changed()).toBe(true);
    map.advance(0.25);
    map.advance(0.5, 'maps/garage_rats.sog');
    map.rename('maps/garage_rats.sog');
    expect(changed()).toBe(false);
    map.rename('maps/garage_rats.bsp');
    expect(changed()).toBe(true);
    screen.showServer('localhost');
    expect(changed()).toBe(true);
    screen.showInformation({ server: [], match: ['Free For All'] });
    expect(changed()).toBe(true);
    screen.step('sounds');
    expect(changed()).toBe(true);
  });
});

describe('ConnectScreen', () => {
  /** A connect screen on a stack of its own. */
  function connecting(server = 'localhost:27960') {
    const screens = new LoadScreens();
    return { screens, screen: new ConnectScreen(screens, server) };
  }

  it("stands in the load screen's panel, the server under the map's line, the bar's room empty", () => {
    const { screen } = connecting();
    expect([screen.title, screen.server, screen.bar, screen.fraction, screen.detail]).toEqual([
      '',
      'Connecting to localhost:27960',
      false,
      0,
      ''
    ]);
    // Its print stands where cgame's lines will, so the load takes the panel over without moving it.
    expect(screen.groups).toEqual([['']]);
  });

  it("follows the connection's state, and the server's print until the connection is up", () => {
    const { screen } = connecting();
    // Blank while the server is looked up.
    screen.show(null);
    expect([screen.line, screen.message]).toEqual(['', '']);

    screen.show({ state: CA.CONNECTING, connectPacketCount: 1, serverMessage: '' });
    expect([screen.line, screen.message]).toEqual(['Awaiting challenge...1', '']);
    const full = 'Server is full\n';
    screen.show({ state: CA.CHALLENGING, connectPacketCount: 2, serverMessage: full });
    expect([screen.line, screen.message, screen.groups]).toEqual([
      'Awaiting connection...2',
      'Server is full',
      [['Server is full']]
    ]);
    screen.show({ state: CA.CONNECTED, connectPacketCount: 0, serverMessage: full });
    expect([screen.line, screen.message]).toEqual(['Awaiting gamestate...', '']);
  });

  it('changes only when a line changes, though it is shown each frame', () => {
    const { screen } = connecting();
    const challenging = { state: CA.CHALLENGING, connectPacketCount: 1, serverMessage: '' };
    screen.show(challenging);
    const written = screen.revision;
    screen.show({ ...challenging });
    expect(screen.revision).toBe(written);
    screen.show({ ...challenging, connectPacketCount: 2 });
    expect(screen.revision).not.toBe(written);
  });

  it('goes when it closes', () => {
    const { screens, screen } = connecting();
    screen.close();
    expect(screens.top).toBeNull();
  });
});

describe('LoadScreens', () => {
  it('draws the newest on top, and the one under it once that goes', () => {
    const screens = new LoadScreens();
    const connect = new ConnectScreen(screens, 'localhost');
    // A map's load comes up before the connect screen under it goes.
    const load = new LoadScreen(screens, 'q3dm17');
    expect(screens.top).toBe(load);
    load.close();
    expect(screens.top).toBe(connect);
  });

  it('leaves the top up when one under it goes, and lets a closed one close again', () => {
    const screens = new LoadScreens();
    const connect = new ConnectScreen(screens, 'localhost');
    const load = new LoadScreen(screens, 'q3dm17');
    connect.close();
    connect.close();
    expect(screens.top).toBe(load);
    load.close();
    expect(screens.top).toBeNull();
  });
});
