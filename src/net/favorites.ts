import { tokenize } from '../formats/q3config';
import type { KeptText } from '../settings/config-file';
import { adrToStringWithPort, NA, type NetAdr } from './net';
import { AS, type ServerLists } from './server-lists';

/**
 * The favourite servers, as Team Arena keeps them (`ui_main.c:3416–3474`): up to 128, each with a
 * name, in the client's favourites list, and printed about as each is added.
 *
 * They are kept in `favorites.txt`, where Team Arena keeps them in `servercache.dat`: a server to a
 * line, its address as `connect` takes it, then its name in quotes. The file is read at start, and
 * written again whole after every change, where Team Arena writes it as its UI shuts down.
 */

/** A favourite as a line of the file has it. */
export interface Favorite {
  address: string;
  name: string;
}

/** A server's address as `connect` takes it, and as the file keeps it. */
export function favoriteAddress(adr: NetAdr): string {
  return adr.type === NA.LOOPBACK ? 'localhost' : adrToStringWithPort(adr);
}

/**
 * The file's favourites: a line's address, and the name after it if it has one. A line with more
 * than those does not read, and is dropped, as are blank lines and comments.
 */
export function readFavorites(text: string): Favorite[] {
  const favorites: Favorite[] = [];
  for (const line of text.split(/\r?\n/)) {
    const argv = tokenize(line);
    if (argv.length === 0 || argv.length > 2 || argv[0] === '') continue;
    favorites.push({ address: argv[0], name: argv[1] ?? '' });
  }
  return favorites;
}

/** The file for a list of favourites. A name loses any quote, which the file has no way to hold. */
export function writeFavorites(favorites: readonly Favorite[]): string {
  return favorites
    .map(({ address, name }) => `${address} "${name.replaceAll('"', '')}"\n`)
    .join('');
}

export interface FavoritesOptions {
  /** The client's lists, whose favourites these are. */
  servers: ServerLists;
  /** `Com_Printf`. */
  print: (text: string) => void;
}

/** The favourites list, kept in its file. */
export class Favorites implements KeptText {
  private readonly servers: ServerLists;
  private readonly print: (text: string) => void;
  private readonly listeners = new Set<() => void>();

  constructor(options: FavoritesOptions) {
    this.servers = options.servers;
    this.print = options.print;
  }

  /** The file's favourites put in the list, quietly, as Team Arena reads its file at start. */
  load(text: string): void {
    for (const { address, name } of readFavorites(text)) {
      this.servers.add(AS.FAVORITES, name, address);
    }
  }

  /**
   * `addFavorite` and `createFavorite` (`ui_main.c:3416–3440, 3456–3474`): a server added under a
   * name, with Team Arena's word for how it went.
   *
   * @returns `LAN_AddServer`'s answer: 1 added, 0 already there, −1 the list full.
   */
  add(address: string, name: string): number {
    const added = this.servers.add(AS.FAVORITES, name, address);
    if (added === 1) {
      this.print(`Added favorite server ${address}`);
      this.changed();
    } else {
      this.print(added === 0 ? 'Favorite already in list' : 'Favorite list full');
    }
    return added;
  }

  /** `deleteFavorite` (`ui_main.c:3442–3451`): the server at the address taken out, quietly. */
  remove(address: string): void {
    this.servers.remove(AS.FAVORITES, address);
    this.changed();
  }

  /** The file: each favourite's address, and its name as the list has it now. */
  text(): string {
    const favorites: Favorite[] = [];
    for (let n = 0; n < this.servers.count(AS.FAVORITES); n++) {
      const server = this.servers.server(AS.FAVORITES, n)!;
      const address = favoriteAddress(server.adr);
      if (address !== '') favorites.push({ address, name: server.hostName });
    }
    return writeFavorites(favorites);
  }

  onSave(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
