import { describe, expect, it, vi } from 'vitest';

import { COLOR_TABLE } from '../formats/color-codes';
import { K } from '../formats/q3-keys';
import type { StatusReply } from '../net/client-static';
import { Favorites } from '../net/favorites';
import { stringToAdr } from '../net/net';
import { AS, ServerLists } from '../net/server-lists';
import { GameConfig } from '../settings/game-config';
import { Menu, type MenuItem, type MenuSound } from './menu';
import {
  LIST_HEIGHT,
  NO_ANSWER,
  serversMenu,
  SETTINGS_LABELS,
  STOP_STATUS
} from './menu-servers';

/** A server's `getinfo` answer, from what differs between the tests' servers. */
function info(fields: {
  hostname: string;
  mapname?: string;
  clients?: number;
  max?: number;
  gametype?: number;
}) {
  const { hostname, mapname = 'q3dm17', clients = 1, max = 12, gametype = 0 } = fields;
  return (
    `\\hostname\\${hostname}\\mapname\\${mapname}\\clients\\${clients}` +
    `\\sv_maxclients\\${max}\\gametype\\${gametype}\\protocol\\71\\gamename\\PlayCanvasQuake`
  );
}

const ARENA = '203.0.113.9:27960';
const OFFICE = '198.51.100.7:27960';
const DORM = '192.0.2.5:27961';

/**
 * The browser over the client's real lists, on a clock the test turns. The client's commands run
 * as the engine runs them: `globalservers` and `localservers` ask for a list, and `ping` takes a
 * slot, through the masters unless the test has opened a channel to the server, which the last
 * probe sees open. A server's status stands once the test gives it, and each call the page makes
 * for one is logged.
 */
function browser(cvars: Record<string, string> = {}, favoritesFile = '') {
  let now = 1000;
  const config = new GameConfig({ print: () => {} });
  for (const [name, value] of Object.entries(cvars)) config.cvars.set(name, value);
  const servers = new ServerLists({ cvars: config.cvars, now: () => now, print: () => {} });
  const printed: string[] = [];
  const favorites = new Favorites({ servers, print: (text) => printed.push(text) });
  favorites.load(favoritesFile);
  const saved = vi.fn();
  favorites.onSave(saved);
  const commands: string[][] = [];
  const channels = new Set<string>();
  const command = (argv: readonly string[]) => {
    commands.push([...argv]);
    if (argv[0] === 'globalservers') servers.askGlobal();
    if (argv[0] === 'localservers') servers.askLocal();
    if (argv[0] === 'ping') servers.ping(stringToAdr(argv[1])!, !channels.has(argv[1]));
  };
  const replies = new Map<string, StatusReply>();
  const statusCalls: string[] = [];
  const probed: string[] = [];
  const status = {
    getServerStatus: (address: string | null, take = true) => {
      statusCalls.push(address === null ? 'let all go' : take ? address : `let ${address} go`);
      return address !== null && take ? (replies.get(address) ?? null) : null;
    },
    probe: (address: string) => void probed.push(address),
    probeOpen: (address: string) => probed.at(-1) === address && channels.has(address)
  };
  const sounds: MenuSound[] = [];
  const menu = new Menu({ sound: (sound) => sounds.push(sound) });
  const startServer = { open: vi.fn() };
  const opened = serversMenu({
    menu,
    config,
    actions: { command },
    servers,
    status,
    favorites,
    startServer,
    protocol: 71,
    now: () => now
  });
  menu.open({ id: 'main', items: [{ label: 'MULTIPLAYER', activate: opened.open }] }, 'q3ui');
  const rig = {
    menu,
    config,
    servers,
    favorites,
    printed,
    saved,
    commands,
    sounds,
    startServer,
    statusCalls,
    probed,
    channels,
    /** A server's status, standing from now. */
    reply: (address: string, reply: StatusReply) => replies.set(address, reply),
    /** The box's settings, as their values. */
    settings: () => menu.page!.detail?.settings.map((row) => row.value) ?? null,
    /** The highlighted server's box, opened at SERVER INFO. */
    box: () => {
      rig.item('SERVER INFO').activate!();
      expect(menu.page!.title).toBe('Server Information');
      return menu.page!;
    },
    open: () => {
      commands.length = 0;
      opened.open();
    },
    /** The clock on. */
    at: (ms: number) => {
      now = ms;
    },
    /** The clock on, and a frame of the page's. */
    frame: (ms: number) => {
      now = ms;
      menu.frame();
    },
    /** A server's answer to its ping. */
    answer: (address: string, text: string) => servers.infoResponse(stringToAdr(address)!, text),
    /** The page's item by its label. */
    item: (label: string): MenuItem => {
      const found = menu.page!.items.find((each) => each.label === label);
      expect(found, label).toBeDefined();
      return found!;
    },
    /** The list, which reads no label. */
    list: () => menu.page!.items.find((each) => each.list !== undefined)!,
    /** The rows the list shows, as their cells' texts. */
    rows: () => rig.list().list!.rows.map((cells) => cells.map((cell) => cell.text)),
    /** The row chosen, by its host name, or null. */
    chosen: () => {
      const { rows, selected } = rig.list().list!;
      return selected < 0 ? null : rows[selected][0].text;
    },
    count: () => menu.page!.items.find((each) => each.place === 'count')!.label
  };
  return rig;
}

/** A refresh on Internet whose master lists `listed`, each pinged at 1000 and answered 40 later. */
function refreshed(listed: Record<string, string>, cvars: Record<string, string> = {}) {
  const rig = browser(cvars);
  rig.open();
  rig.servers.listed(Object.keys(listed).map((address) => stringToAdr(address)!));
  rig.frame(1000);
  rig.at(1040);
  for (const [address, text] of Object.entries(listed)) rig.answer(address, text);
  rig.frame(1040);
  return rig;
}

describe('ARENA SERVERS', () => {
  it("opens on Internet, asking the master for this protocol's servers, empty and full too", () => {
    const rig = browser();
    rig.open();
    expect(rig.menu.page!.id).toBe('arenaservers');
    expect(rig.menu.page!.title).toBe('ARENA SERVERS');
    expect(rig.item('Servers').value).toBe('Internet');
    expect(rig.commands).toEqual([['globalservers', '0', '71', 'empty', 'full']]);
    expect(rig.count()).toBe('Scanning For Servers.');
    expect(rig.menu.page!.status).toBe(STOP_STATUS);
  });

  it.each(['2', '6'])("opens ui_browserMaster %s, another of ioq3's masters, on Internet", (n) => {
    const rig = browser({ ui_browserMaster: n });
    rig.open();
    expect(rig.item('Servers').value).toBe('Internet');
    expect(rig.commands).toEqual([['globalservers', '0', '71', 'empty', 'full']]);
  });

  it.each([
    ['empty', '1', '0'],
    ['full', '0', '1']
  ])('asks the master for %s servers by their own filter alone', (word, empty, full) => {
    const rig = browser({ ui_browserShowEmpty: empty, ui_browserShowFull: full });
    rig.open();
    expect(rig.commands).toEqual([['globalservers', '0', '71', word]]);
  });

  it.each([
    ['1', 'ffa'],
    ['2', 'team'],
    ['3', 'tourney'],
    ['4', 'ctf'],
    ['5', 'gametype=8']
  ])('asks the master for game type %s by its word, without filters turned off', (game, word) => {
    const off = { ui_browserShowEmpty: '0', ui_browserShowFull: '0' };
    const rig = browser({ ui_browserGameType: game, ...off });
    rig.open();
    expect(rig.commands).toEqual([['globalservers', '0', '71', word]]);
  });

  it('greys all but Servers, BACK, SPECIFY and CREATE while it refreshes, as q3_ui does', () => {
    const rig = browser();
    rig.open();
    const controls = ['Game type', 'Sort by', 'Show full', 'Show empty'];
    const grayed = [...controls, 'REFRESH', 'FIGHT', 'ADD TO FAVORITES'];
    for (const label of grayed) expect(rig.item(label).grayed, label).toBe(true);
    expect(rig.list().grayed).toBe(true);
    for (const label of ['Servers', 'BACK', 'SPECIFY', 'CREATE']) {
      expect(rig.item(label).grayed ?? false, label).toBe(false);
    }
  });

  it('waits for the master, then pings what it lists, and lists each server as it answers', () => {
    const rig = browser();
    rig.open();
    rig.frame(1000);
    expect(rig.commands.filter(([name]) => name === 'ping')).toEqual([]);

    rig.servers.listed([stringToAdr(ARENA)!, stringToAdr(OFFICE)!]);
    rig.frame(1010);
    expect(rig.commands.slice(1)).toEqual([
      ['ping', ARENA],
      ['ping', OFFICE]
    ]);
    expect(rig.count()).toBe('2 of 2 Arena Servers.');

    rig.at(1050);
    rig.answer(OFFICE, info({ hostname: '^1Office', mapname: 'garage_rats', clients: 3 }));
    rig.frame(1050);
    expect(rig.rows()).toEqual([['OFFICE', 'GARAGE_RATS', '3/12', 'DM', '~41']]);
    expect(rig.menu.page!.status).toBe(STOP_STATUS);

    rig.at(1070);
    rig.answer(ARENA, info({ hostname: 'Arena', gametype: 3 }));
    rig.frame(1070);
    expect(rig.rows()).toEqual([
      ['OFFICE', 'GARAGE_RATS', '3/12', 'DM', '~41'],
      ['ARENA', 'Q3DM17', '1/12', 'Team DM', '~61']
    ]);
    // None out: the refresh is over, and the controls come back.
    expect(rig.menu.page!.status).toBe('');
    expect(rig.list().grayed).toBe(false);
    expect(rig.item('FIGHT').grayed).toBe(false);
  });

  it('pings every 10 msec at most, and no more than 32 at once', () => {
    const rig = browser();
    rig.open();
    const listed = Array.from({ length: 40 }, (_, n) => stringToAdr(`10.0.0.${n + 1}:27960`)!);
    rig.servers.listed(listed);
    rig.frame(1000);
    expect(rig.servers.pingQueueCount()).toBe(32);
    rig.frame(1005);
    expect(rig.commands.filter(([name]) => name === 'ping')).toHaveLength(32);
    expect(rig.count()).toBe('32 of 40 Arena Servers.');
  });

  it('leaves out a server whose ping reaches cl_maxPing, and says none was found', () => {
    const rig = browser();
    rig.open();
    rig.servers.listed([stringToAdr(ARENA)!]);
    rig.frame(1000);
    rig.frame(1799);
    expect(rig.count()).toBe('1 of 1 Arena Servers.');
    // The next read, 10 msec on, finds it past cl_maxPing.
    rig.frame(1810);
    expect(rig.rows()).toEqual([]);
    expect(rig.count()).toBe('No Servers Found.');
    expect(rig.list().grayed).toBe(true);
    expect(rig.item('FIGHT').grayed).toBe(true);
    expect(rig.item('REFRESH').grayed).toBe(false);
  });

  it("gives a full list's last row, at 128, to the next server to answer", () => {
    const rig = browser();
    rig.open();
    const names = Array.from({ length: 129 }, (_, n) => `S${String(n).padStart(3, '0')}`);
    const address = (n: number) => `10.0.0.${n + 1}:27960`;
    rig.servers.listed(names.map((_, n) => stringToAdr(address(n))!));
    rig.frame(1000);
    // 32 out at once, each answering 40 later, so the last goes out and answers alone.
    for (let round = 1; round <= 5; round++) {
      rig.at(1000 + 40 * round);
      for (let n = 32 * (round - 1); n < Math.min(32 * round, names.length); n++) {
        rig.answer(address(n), info({ hostname: names[n] }));
      }
      rig.frame(1000 + 40 * round);
    }
    // Sorted by ping, then by name, S127 was the last row when S128 answered.
    expect(rig.chosen()).toBe('S000');
    rig.menu.select(rig.menu.page!.items.indexOf(rig.list()));
    rig.menu.key(K.END);
    expect(rig.rows().slice(-2).map(([name]) => name)).toEqual(['S126', 'S128']);
  });

  it('says the master never answered once 5 seconds have gone', () => {
    const rig = browser();
    rig.open();
    rig.frame(5999);
    expect(rig.count()).toBe('Scanning For Servers.');
    rig.frame(6000);
    expect(rig.count()).toBe('No Response From Master Server.');
    expect(rig.menu.page!.status).toBe('');
  });

  it('asks the LAN master for Local, and again every 5 seconds while none is found', () => {
    const rig = browser({ ui_browserMaster: '0' });
    rig.open();
    expect(rig.item('Servers').value).toBe('Local');
    expect(rig.commands).toEqual([['localservers']]);
    rig.frame(5999);
    expect(rig.commands).toHaveLength(1);
    rig.frame(6000);
    expect(rig.commands).toEqual([['localservers'], ['localservers']]);
    rig.servers.infoResponse(stringToAdr(DORM)!, info({ hostname: 'Dorm' }));
    rig.frame(6010);
    expect(rig.commands.at(-1)).toEqual(['ping', DORM]);
  });

  it('stops at SPACE with the tally as it stands, and pings no more', () => {
    const rig = browser();
    rig.open();
    rig.servers.listed([stringToAdr(ARENA)!, stringToAdr(OFFICE)!]);
    rig.frame(1000);
    rig.at(1020);
    rig.answer(ARENA, info({ hostname: 'Arena' }));
    rig.frame(1020);
    expect(rig.menu.key(K.SPACE)).toBe(true);
    expect(rig.sounds.at(-1)).toBe('move');
    expect(rig.menu.page!.status).toBe('');
    expect(rig.rows().map(([name]) => name)).toEqual(['ARENA']);
    // No longer refreshing, SPACE is the list's key, or nothing.
    rig.frame(1040);
    expect(rig.rows().map(([name]) => name)).toEqual(['ARENA']);
  });

  it('marks a relayed ping with a tilde, in q3_ui\'s colours by how long it took', () => {
    const rig = browser();
    rig.open();
    rig.servers.listed([ARENA, OFFICE, DORM].map((address) => stringToAdr(address)!));
    rig.frame(1000);
    rig.at(1198);
    rig.answer(ARENA, info({ hostname: 'A' }));
    rig.frame(1198);
    rig.at(1249);
    rig.answer(OFFICE, info({ hostname: 'B' }));
    rig.frame(1249);
    rig.at(1399);
    rig.answer(DORM, info({ hostname: 'C' }));
    rig.frame(1399);
    const pings = rig.list().list!.rows.map((cells) => cells[4]);
    expect(pings).toEqual([
      { text: '~199', color: COLOR_TABLE[2] },
      { text: '~250', color: COLOR_TABLE[3] },
      { text: '~400', color: COLOR_TABLE[1] }
    ]);
  });

  it('colours a ping blue outside the pings the server takes players between', () => {
    const rig = refreshed({
      [ARENA]: `${info({ hostname: 'Arena' })}\\minPing\\100`,
      [OFFICE]: `${info({ hostname: 'Office' })}\\maxPing\\30`,
      [DORM]: `${info({ hostname: 'Dorm' })}\\minPing\\20\\maxPing\\60`
    });
    const pings = rig.list().list!.rows.map(([name, , , , ping]) => [name.text, ping]);
    expect(pings).toEqual([
      ['ARENA', { text: '~41', color: COLOR_TABLE[4] }],
      ['DORM', { text: '~41', color: COLOR_TABLE[2] }],
      ['OFFICE', { text: '~41', color: COLOR_TABLE[4] }]
    ]);
  });

  it("cuts a row's host name to 21 characters and its map name to 15, the box's whole", () => {
    const [hostname, mapname] = ['The Longest Running Arena', 'garage_rats_remix_v2'];
    const rig = refreshed({ [ARENA]: info({ hostname, mapname }) });
    expect(rig.rows()[0].slice(0, 2)).toEqual(['THE LONGEST RUNNING A', 'GARAGE_RATS_REM']);
    rig.box();
    expect([rig.settings()![0], rig.settings()![2]]).toEqual([hostname, mapname]);
  });

  it('culls by game type, Show Full and Show Empty, and sorts by Sort By, each in its cvar', () => {
    const rig = refreshed({
      [ARENA]: info({ hostname: 'Arena', clients: 0, gametype: 3 }),
      [OFFICE]: info({ hostname: 'Office', clients: 12, max: 12 }),
      [DORM]: info({ hostname: 'Dorm', clients: 4, max: 8, mapname: 'aardvark' })
    });
    const names = () => rig.rows().map(([name]) => name);
    expect(names()).toEqual(['ARENA', 'DORM', 'OFFICE']);

    rig.item('Show empty').key!(K.ENTER);
    expect(names()).toEqual(['DORM', 'OFFICE']);
    rig.item('Show full').key!(K.ENTER);
    expect(names()).toEqual(['DORM']);
    expect(rig.config.cvars.get('ui_browserShowEmpty')).toBe('0');
    expect(rig.config.cvars.get('ui_browserShowFull')).toBe('0');
    rig.item('Show empty').key!(K.ENTER);
    rig.item('Show full').key!(K.ENTER);

    // Team Deathmatch alone.
    rig.item('Game type').key!(K.RIGHTARROW);
    rig.item('Game type').key!(K.RIGHTARROW);
    expect(rig.item('Game type').value).toBe('Team Deathmatch');
    expect(names()).toEqual(['ARENA']);
    expect(rig.config.cvars.get('ui_browserGameType')).toBe('2');
    rig.item('Game type').key!(K.LEFTARROW);
    rig.item('Game type').key!(K.LEFTARROW);

    // Server Name, Map Name, then Open Player Spots, the most first.
    rig.item('Sort by').key!(K.RIGHTARROW);
    expect(names()).toEqual(['ARENA', 'DORM', 'OFFICE']);
    rig.item('Sort by').key!(K.RIGHTARROW);
    expect(names()).toEqual(['DORM', 'ARENA', 'OFFICE']);
    rig.item('Sort by').key!(K.RIGHTARROW);
    expect(names()).toEqual(['ARENA', 'DORM', 'OFFICE']);
    expect(rig.config.cvars.get('ui_browserSortKey')).toBe('2');
  });

  it('sorts by Game Type from the lowest number, and culls to the one game type chosen', () => {
    const rig = refreshed(
      {
        [ARENA]: info({ hostname: 'Arena', gametype: 8 }),
        [OFFICE]: info({ hostname: 'Office', gametype: 0 }),
        [DORM]: info({ hostname: 'Dorm', gametype: 3 })
      },
      { ui_browserSortKey: '3' }
    );
    const games = () => rig.rows().map(([name, , , game]) => [name, game]);
    expect(games()).toEqual([
      ['OFFICE', 'DM'],
      ['DORM', 'Team DM'],
      ['ARENA', 'CA']
    ]);
    // Free For All, the lowest, alone.
    rig.item('Game type').key!(K.RIGHTARROW);
    expect(rig.item('Game type').value).toBe('Free For All');
    expect(games()).toEqual([['OFFICE', 'DM']]);
  });

  it('keeps the chosen server chosen by its address as rows arrive and sort about it', () => {
    const rig = browser();
    rig.open();
    rig.servers.listed([ARENA, OFFICE, DORM].map((address) => stringToAdr(address)!));
    rig.frame(1000);
    rig.at(1100);
    rig.answer(ARENA, info({ hostname: 'Arena' }));
    rig.answer(OFFICE, info({ hostname: 'Office' }));
    rig.frame(1100);
    expect(rig.chosen()).toBe('ARENA');
    // The list is greyed until the refresh is over, and its arrows reach it all the same.
    rig.item('▼').activate!();
    expect(rig.chosen()).toBe('OFFICE');

    rig.at(1110);
    rig.answer(DORM, info({ hostname: 'Dorm' }));
    rig.frame(1110);
    expect(rig.rows().map(([name]) => name)).toEqual(['ARENA', 'OFFICE', 'DORM']);
    rig.item('Sort by').key!(K.RIGHTARROW);
    expect(rig.rows().map(([name]) => name)).toEqual(['ARENA', 'DORM', 'OFFICE']);
    expect(rig.chosen()).toBe('OFFICE');
  });

  it("takes q3_ui's list keys, and its arrows, which the keys pass by", () => {
    const listed = Object.fromEntries(
      Array.from({ length: 14 }, (_, n) => [`10.0.0.${n + 1}:27960`, info({ hostname: `S${n}` })])
    );
    const rig = refreshed(listed, { ui_browserSortKey: '0' });
    const list = rig.list();
    rig.menu.select(rig.menu.page!.items.indexOf(list));
    expect(rig.rows()).toHaveLength(LIST_HEIGHT);

    expect(rig.menu.key(K.UPARROW)).toBe(true);
    expect(rig.sounds.at(-1)).toBe('buzz');
    rig.menu.key(K.END);
    expect(rig.chosen()).toBe('S9');
    rig.menu.key(K.HOME);
    expect(rig.chosen()).toBe('S0');
    // The names sort as text: S0, S1, S10 to S13, then S2 to S9.
    rig.menu.key(K.PGDN);
    expect(rig.chosen()).toBe('S6');
    // A letter goes to the next name with it: S1 after S0.
    rig.menu.key(K.HOME);
    rig.menu.key('s'.charCodeAt(0));
    expect(rig.chosen()).toBe('S1');

    // Tab from the list goes on to the items after it, past the arrows: the corner's, then BACK.
    const arrows = rig.menu.page!.items.filter((each) => each.mouseOnly);
    expect(arrows.map((each) => each.label)).toEqual(['▲', '▼']);
    const next = () => {
      rig.menu.key(K.TAB);
      return rig.menu.page!.items[rig.menu.cursor].label;
    };
    expect([next(), next(), next()]).toEqual(['ADD TO FAVORITES', 'SERVER INFO', 'BACK']);
  });

  it('shows its kept rows at the next visit till REFRESH, and refreshes a source with none', () => {
    const rig = refreshed({ [ARENA]: info({ hostname: 'Arena' }) });
    rig.menu.key(K.ESCAPE);
    expect(rig.menu.page!.id).toBe('main');

    rig.open();
    expect(rig.commands).toEqual([]);
    expect(rig.count()).toBe('hit refresh to update');
    expect(rig.rows().map(([name]) => name)).toEqual(['ARENA']);

    rig.item('Servers').key!(K.LEFTARROW);
    expect(rig.item('Servers').value).toBe('Local');
    expect(rig.config.cvars.get('ui_browserMaster')).toBe('0');
    expect(rig.commands).toEqual([['localservers']]);
    rig.item('Servers').key!(K.RIGHTARROW);
    expect(rig.count()).toBe('hit refresh to update');

    rig.item('REFRESH').activate!();
    expect(rig.commands.at(-1)).toEqual(['globalservers', '0', '71', 'empty', 'full']);
    expect(rig.rows()).toEqual([]);
  });

  it('joins the chosen server at FIGHT, opens CREATE and SPECIFY over it, stops at BACK', () => {
    const rig = refreshed({ [ARENA]: info({ hostname: 'Arena' }) });
    rig.item('FIGHT').activate!();
    expect(rig.commands.at(-1)).toEqual(['connect', ARENA]);
    rig.item('CREATE').activate!();
    expect(rig.startServer.open).toHaveBeenCalledWith(true);
    rig.item('SPECIFY').activate!();
    expect(rig.menu.page!.id).toBe('specifyserver');
    rig.menu.pop();

    rig.item('REFRESH').activate!();
    rig.item('BACK').activate!();
    expect(rig.menu.page!.id).toBe('main');
  });

  it("adds the chosen server by its own name at ADD TO FAVORITES, with Team Arena's word", () => {
    const rig = refreshed({ [ARENA]: info({ hostname: '^1Arena' }) });
    rig.item('ADD TO FAVORITES').activate!();
    expect(rig.printed).toEqual([`Added favorite server ${ARENA}`]);
    expect(rig.servers.server(AS.FAVORITES, 0)).toMatchObject({ hostName: '^1Arena' });
    expect(rig.saved).toHaveBeenCalledOnce();
    rig.item('ADD TO FAVORITES').activate!();
    expect(rig.printed.at(-1)).toBe('Favorite already in list');
  });
});

describe("ARENA SERVERS' favourites", () => {
  const FILE = `${ARENA} "Mine"\n${OFFICE} "Gone"\n`;

  it('lists each favourite at the start as its address and "...", filled in as it answers', () => {
    const rig = browser({ ui_browserMaster: '7' }, FILE);
    rig.open();
    expect(rig.item('Servers').value).toBe('Favorites');
    rig.frame(1000);
    expect(rig.commands).toEqual([
      ['ping', ARENA],
      ['ping', OFFICE]
    ]);
    // Sorted by ping, then by name, which is each one's address till it answers.
    expect(rig.rows()).toEqual([
      [OFFICE, '', '', '', NO_ANSWER],
      [ARENA, '', '', '', NO_ANSWER]
    ]);
    rig.at(1030);
    rig.answer(ARENA, info({ hostname: 'Arena', clients: 2 }));
    rig.frame(1030);
    expect(rig.rows()[0]).toEqual(['ARENA', 'Q3DM17', '2/12', 'DM', '~31']);
    // A dead one stays as it is, whatever cl_maxPing says.
    rig.frame(1800);
    expect(rig.rows()[1]).toEqual([OFFICE, '', '', '', NO_ANSWER]);
    expect(rig.menu.page!.status).toBe('');
    expect(rig.item('DELETE').grayed).toBe(false);
  });

  it('refreshes at the first visit, knowing nothing of them yet, and shows them after', () => {
    const rig = browser({ ui_browserMaster: '7' }, FILE);
    rig.open();
    expect(rig.count()).toBe('Scanning For Servers.');
    rig.frame(1000);
    rig.frame(1800);
    rig.menu.key(K.ESCAPE);
    rig.open();
    expect(rig.count()).toBe('hit refresh to update');
    expect(rig.commands).toEqual([]);
  });

  it('takes the chosen favourite out at DELETE, or DEL on the list, and writes the file', () => {
    const rig = browser({ ui_browserMaster: '7' }, FILE);
    rig.open();
    rig.frame(1000);
    rig.frame(1800);
    // One button, reading each of its words in turn, holds the room of the wider.
    expect(rig.item('DELETE').labels).toEqual(['ADD TO FAVORITES', 'DELETE']);
    rig.item('DELETE').activate!();
    expect(rig.rows().map(([name]) => name)).toEqual([ARENA]);
    expect(rig.servers.count(AS.FAVORITES)).toBe(1);
    expect(rig.saved).toHaveBeenCalledOnce();

    rig.menu.select(rig.menu.page!.items.indexOf(rig.list()));
    expect(rig.menu.key(K.DEL)).toBe(true);
    expect(rig.rows()).toEqual([]);
    expect(rig.count()).toBe('No Servers Found.');
    expect(rig.printed).toEqual([]);
  });

  it('keeps every favourite at DEL with the cursor off the list', () => {
    const rig = browser({ ui_browserMaster: '7' }, FILE);
    rig.open();
    rig.frame(1000);
    rig.frame(1800);
    rig.menu.select(rig.menu.page!.items.indexOf(rig.item('Servers')));
    rig.menu.key(K.DEL);
    expect(rig.rows().map(([name]) => name)).toEqual([OFFICE, ARENA]);
    expect(rig.servers.count(AS.FAVORITES)).toBe(2);
    expect(rig.saved).not.toHaveBeenCalled();
  });

  it('stands a favourite added from another source in the list at once, as its address', () => {
    const rig = browser({ ui_browserMaster: '7' }, FILE);
    rig.open();
    rig.frame(1000);
    rig.frame(1800);
    rig.item('Servers').key!(K.LEFTARROW);
    expect(rig.item('Servers').value).toBe('Internet');
    rig.servers.listed([stringToAdr(DORM)!]);
    rig.frame(1810);
    rig.at(1830);
    rig.answer(DORM, info({ hostname: 'Dorm' }));
    rig.frame(1830);
    rig.item('ADD TO FAVORITES').activate!();
    rig.item('Servers').key!(K.RIGHTARROW);
    expect(rig.count()).toBe('hit refresh to update');
    expect(rig.rows().map(([name, , , , ping]) => [name, ping])).toEqual([
      [ARENA, NO_ANSWER],
      [OFFICE, NO_ANSWER],
      [DORM, NO_ANSWER]
    ]);
  });
});

/** A `scores` row: the slot, score, ping and time, then zeros, and the damage last. */
const scoreRow = (client: number, score: number, ping: number, time: number, damage = 0) =>
  [client, score, ping, time, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, damage].join(' ');

/**
 * A port server's status: its serverinfo with `keys` over a free-for-all's, two players, and
 * the board.
 */
function status(keys: Record<string, string | number> = {}): StatusReply {
  const fields: Record<string, string | number> = {
    sv_hostname: '^1Live ^7Check',
    mapname: 'garage_rats',
    g_gametype: 0,
    g_gamepreset: 'VQ3',
    fraglimit: 20,
    capturelimit: 8,
    roundlimit: 1,
    timelimit: 15,
    sv_maxclients: 8,
    g_needpass: 0,
    version: 'PlayCanvasQuake 0.1.0_gabc browser Sep 30 2026',
    com_gamename: 'PlayCanvasQuake',
    ...keys
  };
  return {
    info: Object.entries(fields).map(([key, value]) => `\\${key}\\${value}`).join(''),
    players: ['12 0 "Visor"', '7 48 "Sarge"'],
    board: [
      `scores 2 3 1 ${scoreRow(1, 12, 0, 3)} ${scoreRow(0, 7, 48, 2)}`,
      'cs 544 "n\\Sarge\\t\\2"',
      'cs 545 "n\\Visor\\t\\1\\skill\\3"'
    ]
  };
}

describe("ARENA SERVERS' Server Information box", () => {
  it('probes the highlighted server and asks its status, every 500 ms till it answers', () => {
    const rig = refreshed({ [ARENA]: info({ hostname: 'Arena' }) });
    expect(rig.probed).toEqual([ARENA]);
    expect(rig.statusCalls).toEqual(['let all go', ARENA]);
    rig.frame(1539);
    expect(rig.statusCalls).toHaveLength(2);
    rig.frame(1540);
    expect(rig.statusCalls).toEqual(['let all go', ARENA, ARENA]);
    expect(rig.probed).toEqual([ARENA]);
  });

  it('takes an answer and lets the server go, then asks nothing more while the page idles', () => {
    const rig = refreshed({ [ARENA]: info({ hostname: 'Arena' }) });
    rig.reply(ARENA, status());
    rig.frame(1540);
    expect(rig.statusCalls.slice(2)).toEqual([ARENA, `let ${ARENA} go`]);
    rig.frame(60000);
    rig.box();
    rig.frame(120000);
    expect(rig.statusCalls).toHaveLength(4);
  });

  it("opens at SERVER INFO over the page, which runs on under it, till CLOSE or Escape", () => {
    const rig = refreshed({ [ARENA]: info({ hostname: 'Arena' }) });
    const browser = rig.menu.page!;
    const box = rig.box();
    expect(box.layout).toBe('popup');
    expect(box.items.map((item) => item.label)).toEqual(['REFRESH', 'CLOSE']);
    expect(rig.menu.under).toBe(browser);
    // The cursor on CLOSE, and Escape as good as it.
    expect(rig.menu.cursor).toBe(1);
    rig.menu.key(K.ENTER);
    expect(rig.menu.page).toBe(browser);
    rig.box();
    rig.menu.key(K.ESCAPE);
    expect(rig.menu.page).toBe(browser);

    // A refresh started under the box runs on under it.
    rig.item('REFRESH').activate!();
    rig.box();
    rig.servers.listed([ARENA, DORM].map((address) => stringToAdr(address)!));
    rig.frame(2000);
    rig.at(2030);
    rig.answer(DORM, info({ hostname: 'Dorm' }));
    rig.frame(2030);
    const listed = rig.menu.under!.items.find((each) => each.list !== undefined)!.list!;
    expect(listed.rows.map(([name]) => name.text)).toEqual(['DORM']);
  });

  it('asks afresh at REFRESH, the last answer standing till the new one comes', () => {
    const rig = refreshed({ [ARENA]: info({ hostname: 'Arena' }) });
    rig.reply(ARENA, status());
    rig.frame(1540);
    const box = rig.box();
    rig.reply(ARENA, status({ fraglimit: 30 }));
    rig.statusCalls.length = 0;
    box.items[0].activate!();
    expect(rig.statusCalls).toEqual(['let all go']);
    expect(rig.settings()![5]).toBe('20 frags');
    rig.frame(1600);
    expect(rig.statusCalls).toEqual(['let all go', ARENA, `let ${ARENA} go`]);
    expect(rig.settings()![5]).toBe('30 frags');
  });

  it("lists its settings from its row's answer till its status comes, then from that", () => {
    const answer = info({ hostname: '^1Red ^7Arena', mapname: 'garage_rats', gametype: 1 });
    const rig = refreshed({ [ARENA]: `${answer}\\g_needpass\\1` });
    rig.box();
    expect(rig.menu.page!.detail!.settings.map((row) => row.label)).toEqual(SETTINGS_LABELS);
    expect(rig.settings()).toEqual([
      'Red Arena',
      ARENA,
      'garage_rats',
      'Tournament',
      '',
      '',
      '',
      '1/12',
      'Yes',
      ''
    ]);
    expect(rig.menu.page!.detail!.board).toBeNull();

    rig.reply(ARENA, status());
    rig.frame(1540);
    expect(rig.settings()).toEqual([
      'Live Check',
      ARENA,
      'garage_rats',
      'Free For All',
      'VQ3',
      '20 frags',
      '15 min',
      '2/8',
      'No',
      '0.1.0_gabc browser Sep 30 2026'
    ]);
  });

  it.each([
    [{ g_gametype: 1 }, '20 frags'],
    [{ g_gametype: 4 }, '8 captures'],
    [{ g_gametype: 8 }, '1 round'],
    [{ fraglimit: 0 }, 'None']
  ])('names the limit that ends the game: %o reads %s', (keys, limit) => {
    const rig = refreshed({ [ARENA]: info({ hostname: 'Arena' }) });
    rig.box();
    rig.reply(ARENA, status({ ...keys, timelimit: 0 }));
    rig.frame(1540);
    expect(rig.settings()!.slice(5, 7)).toEqual([limit, 'None']);
  });

  it("draws its board as a spectator's, the leading team first, from the status's lines", () => {
    const rig = refreshed({ [ARENA]: info({ hostname: 'Arena' }) });
    rig.box();
    rig.reply(ARENA, status({ g_gametype: 3 }));
    rig.frame(1540);
    const board = rig.menu.page!.detail!.board!;
    expect(board.lines).toEqual(['Red leads 3 to 1']);
    expect(board.rows.map((row) => [row.name, row.score, row.ping, row.time, row.you])).toEqual([
      ['Visor', '12', '0', '3', false],
      ['Sarge', '7', '48', '2', false]
    ]);
    expect(board.rows[0].botSkill).toBe(3);
  });

  it('moves to a newly highlighted server, and shows its row\'s settings till it answers', () => {
    const rig = refreshed({
      [ARENA]: info({ hostname: 'Arena' }),
      [DORM]: info({ hostname: 'Dorm' })
    });
    rig.reply(ARENA, status());
    rig.frame(1540);
    rig.menu.select(rig.menu.page!.items.indexOf(rig.list()));
    rig.menu.key(K.DOWNARROW);
    rig.frame(1541);
    expect(rig.probed).toEqual([ARENA, DORM]);
    expect(rig.statusCalls.slice(-2)).toEqual(['let all go', DORM]);
    rig.box();
    expect(rig.settings()!.slice(0, 2)).toEqual(['Dorm', DORM]);
    expect(rig.menu.page!.detail!.board).toBeNull();
  });

  it('asks nothing for a favourite that has never answered, and greys SERVER INFO', () => {
    const rig = browser({ ui_browserMaster: '7' }, `${ARENA} "Mine"\n`);
    rig.open();
    rig.frame(1000);
    rig.frame(1800);
    expect(rig.rows()).toEqual([[ARENA, '', '', '', NO_ANSWER]]);
    expect(rig.item('SERVER INFO').grayed).toBe(true);
    expect(rig.statusCalls).toEqual([]);
    expect(rig.probed).toEqual([]);
  });

  it('pings it once down the channel its probe opened, as it opens, and takes its time', () => {
    const rig = refreshed({
      [ARENA]: info({ hostname: 'Arena' }),
      [DORM]: info({ hostname: 'Dorm' })
    });
    const pings = () => rig.commands.filter(([name]) => name === 'ping').map(([, to]) => to);
    // Both answered 40 after 1000 through the masters: Arena first by name, and highlighted.
    expect(rig.rows().map(([name, , , , ping]) => [name, ping])).toEqual([
      ['ARENA', '~41'],
      ['DORM', '~41']
    ]);
    rig.frame(3000);
    expect(pings()).toEqual([ARENA, DORM]);

    rig.channels.add(ARENA);
    rig.frame(3040);
    expect(pings()).toEqual([ARENA, DORM, ARENA]);
    rig.at(3090);
    rig.answer(ARENA, info({ hostname: 'Arena' }));
    rig.frame(3090);
    // Slower than Dorm now, and still first until the list is next sorted.
    expect(rig.rows().map(([name, , , , ping]) => [name, ping])).toEqual([
      ['ARENA', '51'],
      ['DORM', '~41']
    ]);
    rig.frame(60000);
    expect(pings()).toHaveLength(3);
  });

  it('pings no row whose time is true already, down a channel open before it', () => {
    const rig = browser();
    rig.channels.add(ARENA);
    rig.open();
    rig.servers.listed([stringToAdr(ARENA)!]);
    rig.frame(1000);
    rig.at(1040);
    rig.answer(ARENA, info({ hostname: 'Arena' }));
    rig.frame(1040);
    expect(rig.rows()[0][4]).toBe('41');
    rig.frame(3000);
    expect(rig.commands.filter(([name]) => name === 'ping')).toEqual([['ping', ARENA]]);
  });

  it('pings a newly highlighted row once its own channel opens', () => {
    const rig = refreshed({
      [ARENA]: info({ hostname: 'Arena' }),
      [DORM]: info({ hostname: 'Dorm' })
    });
    const pings = () => rig.commands.filter(([name]) => name === 'ping').map(([, to]) => to);
    rig.channels.add(ARENA);
    rig.frame(1100);
    expect(pings()).toEqual([ARENA, DORM, ARENA]);
    rig.menu.select(rig.menu.page!.items.indexOf(rig.list()));
    rig.menu.key(K.DOWNARROW);
    rig.frame(1200);
    expect(pings()).toHaveLength(3);
    rig.channels.add(DORM);
    rig.frame(1300);
    expect(pings()).toEqual([ARENA, DORM, ARENA, DORM]);
  });

  it('pings it no more if that ping times out, and none while a refresh runs', () => {
    const rig = refreshed({ [ARENA]: info({ hostname: 'Arena' }) });
    rig.channels.add(ARENA);
    rig.frame(1100);
    rig.frame(1900);
    expect(rig.rows()[0][4]).toBe('~41');
    expect(rig.servers.pingQueueCount()).toBe(0);
    rig.frame(60000);
    expect(rig.commands.filter(([name]) => name === 'ping')).toHaveLength(2);

    rig.channels.clear();
    rig.item('REFRESH').activate!();
    rig.servers.listed([ARENA, DORM].map((address) => stringToAdr(address)!));
    rig.frame(60100);
    rig.at(60130);
    rig.answer(ARENA, info({ hostname: 'Arena' }));
    rig.frame(60130);
    // Highlighted afresh and asked for, with Dorm still out, and the channel open again.
    expect(rig.statusCalls.slice(-2)).toEqual(['let all go', ARENA]);
    rig.channels.add(ARENA);
    rig.frame(60140);
    expect(rig.commands.slice(-2)).toEqual([['ping', ARENA], ['ping', DORM]]);
  });
});

describe('SPECIFY SERVER', () => {
  /** SPECIFY, opened from the browser. */
  function specify() {
    const rig = browser();
    rig.open();
    rig.item('SPECIFY').activate!();
    return rig;
  }

  /** Type into a field, a character at a time, as the keys type. */
  const type = (rig: ReturnType<typeof specify>, label: string, text: string) => {
    rig.menu.select(rig.menu.page!.items.indexOf(rig.item(label)));
    for (const ch of text) rig.menu.char(ch);
  };

  it("offers q3_ui's Address and Port, 27960 until changed, and a Name, the cursor first", () => {
    const rig = specify();
    expect(rig.menu.page!.title).toBe('SPECIFY SERVER');
    expect(rig.menu.page!.items.map((each) => each.label)).toEqual([
      'Address',
      'Port',
      'Name',
      'ADD TO FAVORITES',
      'BACK',
      'FIGHT'
    ]);
    expect(rig.item('Port').value).toBe('27960');
    expect(rig.menu.cursor).toBe(0);
    // q3_ui's rooms, and one for the Name the port adds as long as it may be.
    const fields = ['Address', 'Port', 'Name'].map((label) => rig.item(label).widthInChars);
    expect(fields).toEqual([38, 6, 31]);
  });

  it('connects to the address, with the port after it where typed, and to nothing without', () => {
    const rig = specify();
    rig.item('FIGHT').activate!();
    expect(rig.commands.filter(([name]) => name === 'connect')).toEqual([]);
    type(rig, 'Address', 'quake.test');
    rig.item('FIGHT').activate!();
    expect(rig.commands.at(-1)).toEqual(['connect', 'quake.test:27960']);
    rig.menu.select(1);
    rig.menu.key(K.END);
    for (let i = 0; i < 5; i++) rig.menu.key(K.BACKSPACE);
    rig.item('FIGHT').activate!();
    expect(rig.commands.at(-1)).toEqual(['connect', 'quake.test']);
  });

  it('adds the address and port under the name, only with both, as createFavorite', () => {
    const rig = specify();
    type(rig, 'Address', 'quake.test');
    rig.item('ADD TO FAVORITES').activate!();
    expect(rig.printed).toEqual([]);
    type(rig, 'Name', 'My Arena');
    rig.item('ADD TO FAVORITES').activate!();
    expect(rig.printed).toEqual(['Added favorite server quake.test:27960']);
    expect(rig.servers.server(AS.FAVORITES, 0)).toMatchObject({ hostName: 'My Arena' });
    expect(rig.menu.page!.id).toBe('specifyserver');
  });

  it('takes a paste into a field, past a numbers-only check, as MField_Paste does', () => {
    const rig = specify();
    rig.menu.select(0);
    expect(rig.menu.paste('203.0.113.9\n')).toBe(true);
    expect(rig.item('Address').value).toBe('203.0.113.9');
    rig.menu.select(1);
    rig.menu.key(K.END);
    for (let i = 0; i < 5; i++) rig.menu.key(K.BACKSPACE);
    rig.menu.paste('2x7');
    expect(rig.item('Port').value).toBe('2x7');
  });

  it('is built afresh at each visit, as q3_ui builds it', () => {
    const rig = specify();
    type(rig, 'Address', 'quake.test');
    rig.menu.pop();
    rig.item('SPECIFY').activate!();
    expect(rig.item('Address').value).toBe('');
  });
});
