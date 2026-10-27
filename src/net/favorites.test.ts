import { describe, expect, it } from 'vitest';

import { keepFile, type FileStore } from '../settings/config-file';
import { Cvars } from '../settings/cvars';
import { Favorites, favoriteAddress, readFavorites, writeFavorites } from './favorites';
import { NA, netadr } from './net';
import { AS, MAX_OTHER_SERVERS, ServerLists } from './server-lists';

/** A client's favourites over lists of their own, and what they print. */
function favorites(text = '') {
  const printed: string[] = [];
  const cvars = new Cvars({ debugMode: true, print: () => {} });
  const servers = new ServerLists({ cvars, now: () => 0, print: () => {} });
  const list = new Favorites({ servers, print: (line) => printed.push(line) });
  list.load(text);
  const names = () =>
    Array.from(
      { length: servers.count(AS.FAVORITES) },
      (_, n) => servers.server(AS.FAVORITES, n)!.hostName
    );
  return { list, servers, printed, names };
}

describe('the file', () => {
  it("reads a line's address and the name after it, and drops a line that doesn't read", () => {
    const text = [
      '10.0.0.5:27960 "Office"',
      '[2001:db8::1]:27961 "Six"',
      'quake.example.com',
      '',
      '// a comment',
      '10.0.0.6 "Too" many',
      '10.0.0.7:27960 "Last"'
    ].join('\r\n');
    expect(readFavorites(text)).toEqual([
      { address: '10.0.0.5:27960', name: 'Office' },
      { address: '[2001:db8::1]:27961', name: 'Six' },
      { address: 'quake.example.com', name: '' },
      { address: '10.0.0.7:27960', name: 'Last' }
    ]);
  });

  it('writes a line to each, a name losing the quotes the file has no way to hold', () => {
    expect(
      writeFavorites([
        { address: '10.0.0.5:27960', name: 'Office' },
        { address: 'quake.example.com:27960', name: 'The "Best"' }
      ])
    ).toBe('10.0.0.5:27960 "Office"\nquake.example.com:27960 "The Best"\n');
  });

  it('keeps an address as connect takes it', () => {
    expect(favoriteAddress(netadr(NA.IP, '10.0.0.5', 27961))).toBe('10.0.0.5:27961');
    expect(favoriteAddress(netadr(NA.IP6, '::1', 27960))).toBe('[::1]:27960');
    expect(favoriteAddress(netadr(NA.LOOPBACK))).toBe('localhost');
    expect(favoriteAddress(netadr(NA.BAD))).toBe('');
  });
});

describe('Favorites', () => {
  it('takes up the file quietly at start', () => {
    const file = '10.0.0.5:27960 "Office"\nquake.example.com "Named"\n';
    const { printed, names, list } = favorites(file);
    expect(names()).toEqual(['Office', 'Named']);
    expect(printed).toEqual([]);
    // A name is kept as typed, with the port it will be asked on.
    expect(list.text()).toBe('10.0.0.5:27960 "Office"\nquake.example.com:27960 "Named"\n');
  });

  it("adds a server with Team Arena's words, and says when the file changes", () => {
    const { list, printed, names } = favorites('10.0.0.5:27960 "Office"\n');
    let saves = 0;
    list.onSave(() => saves++);
    expect(list.add('10.0.0.6:27960', 'Home')).toBe(1);
    expect(list.add('10.0.0.5:27960', 'Again')).toBe(0);
    expect(names()).toEqual(['Office', 'Home']);
    expect(printed).toEqual(['Added favorite server 10.0.0.6:27960', 'Favorite already in list']);
    expect(saves).toBe(1);

    list.remove('10.0.0.5:27960');
    expect(names()).toEqual(['Home']);
    expect(saves).toBe(2);
  });

  it('refuses one past 128', () => {
    const lines = Array.from(
      { length: MAX_OTHER_SERVERS },
      (_, n) => `10.0.${n >> 8}.${n & 255} "S${n}"`
    );
    const { list, printed, names } = favorites(lines.join('\n'));
    expect(names()).toHaveLength(MAX_OTHER_SERVERS);
    expect(list.add('10.1.0.1:27960', 'One more')).toBe(-1);
    expect(printed).toEqual(['Favorite list full']);
  });

  it('writes the list with the names the servers answered with', () => {
    const { list, servers } = favorites('10.0.0.5:27960 "Office"\n');
    const office = netadr(NA.IP, '10.0.0.5', 27960);
    servers.ping(office, false);
    servers.infoResponse(office, '\\hostname\\Rats Nest\\mapname\\q3dm17');
    servers.getPing(0);
    expect(list.text()).toBe('10.0.0.5:27960 "Rats Nest"\n');
  });

  it('is written at once to every store on each change, and not at start', async () => {
    const writes: string[] = [];
    const store: FileStore = {
      read: async () => undefined,
      write: async (text) => {
        writes.push(text);
        return true;
      }
    };
    const { list } = favorites();
    const keeper = keepFile(list, [store], list.text());
    await keeper.settled();
    expect(writes).toEqual([]);
    list.add('10.0.0.6:27960', 'Home');
    await keeper.settled();
    expect(writes).toEqual(['10.0.0.6:27960 "Home"\n']);
  });
});
