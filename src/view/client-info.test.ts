import { describe, expect, it } from 'vitest';

import { CONFIGSTRING } from '../net/commands';
import { GT, TEAM } from '../sim/constants';
import {
  gamestateClients,
  keepClientInfo,
  loadClientInfo,
  newClientInfo,
  type ClientInfo
} from './client-info';

/** `CG_NewClientInfo`'s reading of a `CS_PLAYERS` string. */

describe('newClientInfo', () => {
  it("reads every field ClientUserinfoChanged writes, a bot's as a bot's", () => {
    const info = newClientInfo(
      'n\\^1Sarge\\t\\1\\model\\sarge/red\\hmodel\\sarge/blue\\c1\\4\\c2\\2\\hc\\70\\w\\3\\l\\1\\skill\\5\\tt\\2\\tl\\1',
      GT.FFA
    );
    expect(info).toEqual({
      name: '^1Sarge',
      color1: [1, 0, 0],
      color2: [0, 1, 0],
      botSkill: 5,
      handicap: 70,
      wins: 3,
      losses: 1,
      team: 1,
      teamTask: 2,
      teamLeader: 1,
      redTeam: '',
      blueTeam: '',
      named: { body: { model: 'sarge', skin: 'red' }, head: { model: 'sarge', skin: 'blue' } },
      look: { body: { model: 'sarge', skin: 'red' }, head: { model: 'sarge', skin: 'blue' } },
      deferred: false
    });
  });

  it("reads a human's team names, which a bot's string leaves out", () => {
    const info = newClientInfo('n\\Player\\model\\visor\\g_redteam\\Stroggs\\g_blueteam\\Pagans', GT.FFA);
    expect(info).toMatchObject({ redTeam: 'Stroggs', blueTeam: 'Pagans' });
  });

  it('takes the default skin for a model named without one', () => {
    const info = newClientInfo('n\\Doom\\model\\doom\\hmodel\\doom', GT.FFA);
    expect(info?.look).toEqual({
      body: { model: 'doom', skin: 'default' },
      head: { model: 'doom', skin: 'default' }
    });
  });

  it("puts the body's model on a head named with none, in the head's own skin", () => {
    const info = newClientInfo('n\\Visor\\model\\visor/gorre\\hmodel\\/red', GT.FFA);
    expect(info?.look.head).toEqual({ model: 'visor', skin: 'red' });
  });

  it('colours anything outside 1 to 7 white, as CG_ColorFromString does', () => {
    expect(newClientInfo('n\\A\\c1\\0\\c2\\9', GT.FFA)).toMatchObject({
      color1: [1, 1, 1],
      color2: [1, 1, 1]
    });
  });

  it('reads a colour as atoi does, from the digits it starts with', () => {
    expect(newClientInfo('n\\A\\c1\\2x\\c2\\1.5', GT.FFA)).toMatchObject({
      color1: [0, 1, 0],
      color2: [0, 0, 1]
    });
  });

  it('is nobody for an empty string: the player has left', () => {
    expect(newClientInfo('', GT.FFA)).toBeNull();
  });

  it("dresses a team game's players in their side's colours, whatever skin they chose", () => {
    const string = 'n\\Sarge\\model\\sarge/krusade\\hmodel\\sarge/krusade';

    const red = newClientInfo(`${string}\\t\\${TEAM.RED}`, GT.TEAM);
    expect(red?.look).toEqual({
      body: { model: 'sarge', skin: 'red' },
      head: { model: 'sarge', skin: 'red' }
    });

    const blue = newClientInfo(`${string}\\t\\${TEAM.BLUE}`, GT.CTF);
    expect(blue?.look.body.skin).toBe('blue');
    expect(blue?.look.head.skin).toBe('blue');
    // What they chose is kept, which is what two clients are compared by.
    expect(blue?.named.body.skin).toBe('krusade');

    // A free-for-all wears the chosen skin.
    expect(newClientInfo(string, GT.FFA)?.look.body.skin).toBe('krusade');
  });

  it("puts a team game's spectator in red, as Q3's default case leaves them", () => {
    const info = newClientInfo(`n\\Sarge\\model\\sarge\\t\\${TEAM.SPECTATOR}`, GT.TEAM);
    expect(info?.look.body.skin).toBe('red');
  });
});

describe('gamestateClients', () => {
  /** A gamestate's configstrings: its serverinfo, and a string for each slot given. */
  const gamestate =
    (gametype: number, players: Record<number, string>) =>
    (index: number): string => {
      if (index === CONFIGSTRING.SERVERINFO) return `\\g_gametype\\${gametype}\\mapname\\garage`;
      return players[index - CONFIGSTRING.PLAYERS] ?? '';
    };

  it("loads the client's own slot first, then every other with a string, by number", () => {
    const configstring = gamestate(GT.FFA, {
      0: 'n\\Anarki\\model\\anarki',
      3: 'n\\Visitor\\model\\visor',
      5: 'n\\Sarge\\model\\sarge'
    });
    const clients = gamestateClients(configstring, 3);
    expect(clients.map(({ clientNum, info }) => [clientNum, info.name])).toEqual([
      [3, 'Visitor'],
      [0, 'Anarki'],
      [5, 'Sarge']
    ]);
  });

  it("dresses everyone as the gamestate's game type has them", () => {
    const configstring = gamestate(GT.CTF, {
      1: `n\\Sarge\\model\\sarge/krusade\\t\\${TEAM.BLUE}`
    });
    expect(gamestateClients(configstring, 1)[0].info.look.body.skin).toBe('blue');
  });

  it("names nobody in a slot whose string is empty, the client's own among them", () => {
    expect(gamestateClients(gamestate(GT.FFA, { 2: 'n\\Sarge' }), 0)).toEqual([
      expect.objectContaining({ clientNum: 2 })
    ]);
  });
});

describe('keepClientInfo', () => {
  /** A client as their string reads, wearing `model` and `hmodel`, on a side. */
  const read = (model: string, head = model, gametype: number = GT.FFA, team: number = TEAM.FREE) =>
    newClientInfo(`n\\${model}\\model\\${model}\\hmodel\\${head}\\t\\${team}`, gametype)!;
  /** A client drawn in another's look meanwhile. */
  const deferred = (info: ClientInfo, lender: ClientInfo): ClientInfo => ({
    ...info,
    look: lender.look,
    deferred: true
  });

  it('shares a look a loaded client wears, loading nothing, whether put off or not', () => {
    const sarge = read('sarge/red');
    for (const defer of [false, true]) {
      expect(keepClientInfo(read('sarge/red'), [null, sarge], GT.FFA, defer)).toEqual({
        info: read('sarge/red'),
        load: false
      });
    }
  });

  it("loads a look nobody wears when looks are not put off, as under the gamestate's load", () => {
    expect(keepClientInfo(read('visor'), [read('sarge')], GT.FFA, false)).toEqual({
      info: read('visor'),
      load: true
    });
  });

  it("puts a look off in the first client's, whether that one is put off itself or not", () => {
    const doom = read('doom');
    const grunt = deferred(read('grunt'), doom);
    const kept = keepClientInfo(read('visor'), [null, grunt, read('sarge')], GT.FFA, true);
    expect(kept.load).toBe(false);
    expect(kept.info).toEqual({ ...read('visor'), look: doom.look, deferred: true });
    // Still named as their string names them, for the load that comes later.
    expect(kept.info.named.body.model).toBe('visor');
  });

  it('shares nothing with a client put off themselves, nor across a team name', () => {
    const grunt = deferred(read('grunt'), read('sarge'));
    expect(keepClientInfo(read('grunt'), [grunt], GT.FFA, false).load).toBe(true);

    const pagans = newClientInfo('n\\A\\model\\sarge\\g_blueteam\\Pagans', GT.FFA)!;
    expect(keepClientInfo(read('sarge'), [pagans], GT.FFA, false).load).toBe(true);
  });

  it('loads at once where a loaded client wears the same body and skin, whatever the head', () => {
    const kept = keepClientInfo(read('sarge', 'visor'), [read('sarge')], GT.FFA, true);
    expect(kept).toEqual({ info: read('sarge', 'visor'), load: true });
  });

  it("borrows in a team game only a model in the side's own skin, or loads at once", () => {
    const team = (model: string, side: number) => read(model, model, GT.TEAM, side);
    const redSarge = team('sarge', TEAM.RED);

    const borrowed = keepClientInfo(team('visor', TEAM.RED), [redSarge], GT.TEAM, true);
    expect(borrowed.info).toMatchObject({ look: redSarge.look, deferred: true });
    expect(borrowed.info.look.body.skin).toBe('red');

    // Nobody on blue to borrow from, and a skin of their own: neither shows a side wrong.
    expect(keepClientInfo(team('visor', TEAM.BLUE), [redSarge], GT.TEAM, true).load).toBe(true);
    const gorre = team('visor/gorre', TEAM.RED);
    expect(keepClientInfo(gorre, [redSarge], GT.TEAM, true)).toEqual({ info: gorre, load: true });
  });

  it('shares a look in a team game only with the same side', () => {
    const kept = keepClientInfo(
      read('sarge', 'sarge', GT.TEAM, TEAM.BLUE),
      [read('sarge', 'sarge', GT.TEAM, TEAM.RED)],
      GT.TEAM,
      false
    );
    expect(kept.load).toBe(true);
  });

  it('loads where nobody is in to lend a look', () => {
    expect(keepClientInfo(read('visor'), [null, null], GT.FFA, true).load).toBe(true);
  });
});

describe('loadClientInfo', () => {
  it("puts a client put off back in their own look, in their side's colours", () => {
    const own = newClientInfo(`n\\V\\model\\visor/gorre\\hmodel\\visor\\t\\${TEAM.BLUE}`, GT.CTF)!;
    const put = { ...own, look: newClientInfo('n\\S\\model\\sarge', GT.CTF)!.look, deferred: true };
    expect(loadClientInfo(put, GT.CTF)).toEqual(own);
  });
});
