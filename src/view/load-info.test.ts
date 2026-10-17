import { describe, expect, it } from 'vitest';

import { CONFIGSTRING } from '../net/commands';
import { CA } from '../net/connection';
import { ServerProgram } from '../server/program';
import { Cvars } from '../settings/cvars';
import { createFlatWorldTrace } from '../sim/box-world';
import { GT } from '../sim/constants';
import { entityText, spawnSpot } from '../sim/map-test-fixtures';
import { vec3 } from '../sim/vec3';
import {
  connectingTo,
  connectMessage,
  connectState,
  gamestateInfo,
  localInfo,
  matchLines,
  previewLines,
  type MatchInfo
} from './load-info';

/** A server elsewhere as cgame reads it: a free-for-all on a map with no message, no limits. */
const MATCH: MatchInfo = {
  remote: true,
  hostname: 'Garage',
  motd: '',
  message: '',
  cheats: '0',
  gametype: GT.FFA,
  timelimit: 0,
  fraglimit: 0,
  capturelimit: 0,
  roundlimit: 0
};

/** A map whose worldspawn gives its longer name. */
const GARAGE = entityText([
  { classname: 'worldspawn', message: 'The Garage' },
  spawnSpot(vec3(0, 0, 16))
]);

describe("q3_ui's connect screen", () => {
  it('names the server as it was named', () => {
    expect(connectingTo('localhost:27960')).toBe('Connecting to localhost:27960');
  });

  it('says how far the connection has got, and how many times it has asked', () => {
    expect(connectState(CA.CONNECTING, 1)).toBe('Awaiting challenge...1');
    expect(connectState(CA.CHALLENGING, 3)).toBe('Awaiting connection...3');
    expect(connectState(CA.CONNECTED, 0)).toBe('Awaiting gamestate...');
  });

  it('says nothing while the server is looked up, nor once the gamestate is in', () => {
    for (const state of [CA.DISCONNECTED, CA.PRIMED, CA.ACTIVE]) {
      expect(connectState(state, 2)).toBe('');
    }
  });

  it("shows the server's print, cleaned, until the connection is up", () => {
    expect(connectMessage(CA.CHALLENGING, 'Server is full\n')).toBe('Server is full');
    expect(connectMessage(CA.CONNECTING, '^1Banned^7 here')).toBe('Banned here');
    expect(connectMessage(CA.CONNECTED, 'Server is full\n')).toBe('');
  });
});

describe("cgame's lines over a map's load", () => {
  it("puts a remote server's name and message of the day, cleaned, before the match's", () => {
    const lines = matchLines({ ...MATCH, hostname: '^1Garage^7 Rats', motd: 'Frag ^3responsibly' });
    expect(lines).toEqual({ server: ['Garage Rats', 'Frag responsibly'], match: ['Free For All'] });
  });

  it("keeps an unnamed server's line, and leaves out an empty message of the day", () => {
    expect(matchLines({ ...MATCH, hostname: '' }).server).toEqual(['']);
  });

  it('gives a server in this process none of its own lines', () => {
    expect(matchLines({ ...MATCH, remote: false, motd: 'Frag responsibly' }).server).toEqual([]);
  });

  it("reads the map's message, then the cheats, the game type and each limit that is set", () => {
    const lines = matchLines({
      ...MATCH,
      message: 'The ^2Garage',
      cheats: '1',
      timelimit: 15,
      fraglimit: 20
    });
    expect(lines.match).toEqual([
      'The Garage',
      'CHEATS ARE ENABLED',
      'Free For All',
      'timelimit 15',
      'fraglimit 20'
    ]);
  });

  it.each([
    [GT.FFA, ['Free For All', 'fraglimit 20']],
    [GT.TOURNAMENT, ['Tournament', 'fraglimit 20']],
    [GT.SINGLE_PLAYER, ['Single Player', 'fraglimit 20']],
    [GT.TEAM, ['Team Deathmatch', 'fraglimit 20']],
    [GT.CTF, ['Capture The Flag', 'capturelimit 8']],
    [GT.CA, ['Clan Arena', 'roundlimit 5']],
    [GT.OBELISK, ['Unknown Gametype', 'capturelimit 8']]
  ])('names game type %i, and the limit it is played to', (gametype, match) => {
    const limits = { fraglimit: 20, capturelimit: 8, roundlimit: 5 };
    expect(matchLines({ ...MATCH, ...limits, gametype }).match).toEqual(match);
  });

  it('leaves out a limit of 0', () => {
    expect(matchLines({ ...MATCH, gametype: GT.CTF }).match).toEqual(['Capture The Flag']);
    expect(matchLines({ ...MATCH, gametype: GT.CA }).match).toEqual(['Clan Arena']);
  });
});

describe("where cgame's lines are read from", () => {
  it("reads a gamestate's serverinfo and systeminfo, its message of the day and the map's", () => {
    const strings: Record<number, string> = {
      [CONFIGSTRING.SERVERINFO]:
        '\\sv_hostname\\Garage\\g_gametype\\4\\timelimit\\15\\fraglimit\\20' +
        '\\capturelimit\\8\\roundlimit\\5',
      [CONFIGSTRING.SYSTEMINFO]: '\\sv_cheats\\1\\sv_serverid\\7',
      [CONFIGSTRING.MOTD]: 'Frag responsibly',
      [CONFIGSTRING.MESSAGE]: 'The Garage'
    };
    expect(gamestateInfo((index) => strings[index] ?? '', true)).toEqual({
      remote: true,
      hostname: 'Garage',
      motd: 'Frag responsibly',
      message: 'The Garage',
      cheats: '1',
      gametype: GT.CTF,
      timelimit: 15,
      fraglimit: 20,
      capturelimit: 8,
      roundlimit: 5
    });
  });

  it("reads a match in this page from its cvars and the map's worldspawn", () => {
    const cvars: Record<string, string> = {
      g_gametype: '8',
      timelimit: '10',
      fraglimit: '20',
      capturelimit: '8',
      roundlimit: '7'
    };
    expect(localInfo((name) => cvars[name] ?? '', GARAGE, true)).toEqual({
      remote: false,
      hostname: '',
      motd: '',
      message: 'The Garage',
      cheats: '1',
      gametype: GT.CA,
      timelimit: 10,
      fraglimit: 20,
      capturelimit: 8,
      roundlimit: 7
    });
  });

  it("reads no message from an entity text that doesn't parse: the server says why", () => {
    expect(localInfo(() => '', '"classname" "worldspawn"', false).message).toBe('');
  });

  it("gives a map's preview its message alone, cleaned of colours, and nothing with none", () => {
    const coloured = entityText([{ classname: 'worldspawn', message: 'The ^1Longest^7 Yard' }]);
    expect(previewLines(coloured)).toEqual({ server: [], match: ['The Longest Yard'] });
    const plain = entityText([{ classname: 'worldspawn' }]);
    expect(previewLines(plain)).toEqual({ server: [], match: [] });
  });

  it.each([false, true])(
    'gives the lines its gamestate will before a server in this page starts (DEBUG_MODE %s)',
    (debugMode) => {
      const cvars = new Cvars({ debugMode, warn: () => {} });
      cvars.set('g_gametype', String(GT.TEAM));
      cvars.set('timelimit', '15');
      cvars.set('fraglimit', '30');
      const ahead = matchLines(localInfo((name) => cvars.get(name), GARAGE, debugMode));
      const cheats = debugMode ? ['CHEATS ARE ENABLED'] : [];
      expect(ahead).toEqual({
        server: [],
        match: ['The Garage', ...cheats, 'Team Deathmatch', 'timelimit 15', 'fraglimit 30']
      });

      const { host } = new ServerProgram({
        cvars,
        map: { name: 'garage', entities: GARAGE, trace: createFlatWorldTrace() },
        random: () => 0,
        debugMode
      });
      const info = gamestateInfo((index) => host.getConfigstring(index), false);
      expect(matchLines(info)).toEqual(ahead);
    }
  );
});
