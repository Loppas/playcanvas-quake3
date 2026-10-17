import { describe, expect, it, vi } from 'vitest';
import { LocalGame, type ClientMap, type ClientLoader } from './local-game';
import { ClientStatic } from './net/client-static';
import { CONFIGSTRING } from './net/commands';
import { CA } from './net/connection';
import { infoValueForKey } from './net/info';
import { NA, Net, stringToAdr } from './net/net';
import { MemoryNetwork } from './net/net-test-fixtures';
import type { NetUserCmd } from './net/protocol';
import { RemoteChannel } from './server/channel';
import { CS, type HostMap } from './server/host';
import { ServerProgram, type ServerMaps } from './server/program';
import { Cvars } from './settings/cvars';
import { createFlatWorldTrace } from './sim/box-world';
import { mapOf, spawnSpot } from './sim/map-test-fixtures';
import { PMOVE_MSEC, PMOVE_MSEC_MAX, PMOVE_MSEC_MIN } from './sim/constants';
import { createUserCmd } from './sim/types';
import { vec3 } from './sim/vec3';

/**
 * `map <n>` through the whole program: the host asks, the program reads the map while no frame
 * runs, and the client arrives in it by way of a new gamestate.
 */

/** A map on flat ground, with one spawn spot at `x`. */
const flatMap = (name: string, x: number): HostMap => ({
  name,
  entities: mapOf(spawnSpot(vec3(x, 0, 16))),
  trace: createFlatWorldTrace()
});

/** A program whose map reads are answered by hand, as a slow download is. */
function slowMaps(known: readonly string[]) {
  const asked: string[] = [];
  let answer: (map: HostMap) => void = () => {};
  let refuse: (err: Error) => void = () => {};
  const maps: ServerMaps = {
    exists: (name) => known.includes(name),
    load: (name) => {
      asked.push(name);
      return new Promise((resolve, reject) => {
        answer = resolve;
        refuse = reject;
      });
    }
  };
  return { maps, asked, answer: (map: HostMap) => answer(map), refuse: (e: Error) => refuse(e) };
}

function start(maps: ServerMaps, clientLoader?: ClientLoader): LocalGame {
  const cvars = new Cvars({ debugMode: true, warn: () => {} });
  return new LocalGame({ cvars, map: flatMap('garage', 0), maps, clientLoader, random: () => 0 });
}

/** A client loader whose loads are answered by hand, as a slow download is. */
function slowClientLoader() {
  const asked: string[] = [];
  let answer: (map: ClientMap) => void = () => {};
  let refuse: (err: Error) => void = () => {};
  const clientLoader: ClientLoader = {
    load: (name) => {
      asked.push(name);
      return new Promise((resolve, reject) => {
        answer = resolve;
        refuse = reject;
      });
    }
  };
  return {
    clientLoader,
    asked,
    answer: (map: ClientMap) => answer(map),
    refuse: (e: Error) => refuse(e)
  };
}

const still = () => createUserCmd();
const forward = () => ({ ...createUserCmd(), forwardmove: 127 });

/** Where the match has the local player: the server's player state, not the client's copy. */
const serverOrigin = (game: LocalGame) => game.game.level.clients[game.clientNum].ps.origin;
/** The match's own state for the local player. */
const serverPlayer = (game: LocalGame) => game.game.level.clients[game.clientNum].ps;
/** The name the match knows the local player by. */
const serverName = (game: LocalGame) => game.game.level.clients[game.clientNum].pers.netname;

describe('LocalGame: map <n>', () => {
  it('reads the map while no frame runs, then puts the client into it', async () => {
    const program = slowMaps(['backyard']);
    const game = start(program.maps);
    for (let i = 0; i < 5; i++) game.tick(still());
    expect(game.playerState.origin.x).toBe(0);
    // Something the last world said that nobody acted on, which the new one never hears.
    game.host.sendServerCommand(game.clientNum, 'print "old world\n"');
    game.tick(still());

    game.host.sendConsoleCommand('map backyard\n');
    game.tick(still());
    expect(program.asked).toEqual(['backyard']);
    const loading = game.mapLoad;
    expect(loading).not.toBeNull();

    // The server stands where it stood while the map is read, and nothing the client says reaches
    // it meanwhile: Q3's load blocks the whole program, messages and all.
    const time = game.host.time;
    const standing = { ...serverOrigin(game) };
    game.setUserinfo('\\name\\Grunt');
    for (let i = 0; i < 5; i++) game.tick(forward());
    expect(game.host.time).toBe(time);
    expect(serverOrigin(game)).toEqual(standing);
    expect(serverName(game)).not.toBe('Grunt');

    program.answer(flatMap('backyard', 512));
    await loading;
    expect(game.mapLoad).toBeNull();

    // The client has the new gamestate, which names the map, and stands on its spawn spot. The
    // gamestate goes in fragments when it is long, which the frames carry: run the ones it
    // takes, until the client is in the new world.
    for (let i = 0; i < 10 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());
    const serverinfo = game.connection.configstrings[CONFIGSTRING.SERVERINFO];
    expect(serverinfo).toContain('\\mapname\\backyard');
    expect(game.connection.serverId).toBe(game.host.serverId);
    expect(game.playerState.origin.x).toBe(512);
    // The clock started again with the map, at 0, and has run its settle frames since.
    expect(game.host.time).toBeLessThan(time);
    expect(game.host.time).toBeGreaterThanOrEqual(400);
    // Its commands started again with the new world, as its clock did: the frames it took to
    // get in made one each.
    expect(game.connection.commands.cmdNumber).toBeLessThanOrEqual(6);
    expect(game.takeServerCommands().join()).not.toContain('old world');
  });

  it('runs devmap through the same load, leaving the cheats on', async () => {
    const program = slowMaps(['backyard']);
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    const game = new LocalGame({
      cvars,
      map: flatMap('garage', 0),
      maps: program.maps,
      random: () => 0,
      debugMode: false
    });
    // The boot's own map is a `map`: cheats off, which the client reads out of the systeminfo and
    // takes back into the one store they share.
    for (let i = 0; i < 5 && cvars.get('sv_cheats') !== '0'; i++) game.tick(still());
    expect(cvars.get('sv_cheats')).toBe('0');

    game.host.sendConsoleCommand('devmap backyard\n');
    game.tick(still());
    program.answer(flatMap('backyard', 512));
    await game.mapLoad;

    expect(cvars.get('sv_cheats')).toBe('1');
  });

  it('stops where it stands when the map fails to load, as ERR_DROP stops Q3', async () => {
    const program = slowMaps(['backyard']);
    const game = start(program.maps);
    game.host.sendConsoleCommand('map backyard\n');
    game.tick(still());
    const loading = game.mapLoad;

    program.refuse(new Error("Couldn't load maps/backyard.voxel.json"));
    await loading;

    expect(game.failure?.message).toBe("Couldn't load maps/backyard.voxel.json");
    const time = game.host.time;
    const standing = { ...serverOrigin(game) };
    for (let i = 0; i < 5; i++) game.tick(forward());
    expect(game.host.time).toBe(time);
    expect(serverOrigin(game)).toEqual(standing);
  });

  it('stops the same way when the map is in but will not spawn, and says why', async () => {
    const program = slowMaps(['backyard']);
    const game = start(program.maps);
    game.host.sendConsoleCommand('map backyard\n');
    game.tick(still());
    const loading = game.mapLoad;

    // No entities at all: `G_SpawnEntitiesFromString` finds no worldspawn.
    program.answer({ name: 'backyard', entities: '', trace: createFlatWorldTrace() });
    await loading;

    expect(game.failure?.message).toMatch(/entities/);
    expect(game.mapLoad).not.toBeNull();
    const time = game.host.time;
    for (let i = 0; i < 5; i++) game.tick(forward());
    expect(game.host.time).toBe(time);
  });

  it("sends its own client the shutdown's snapshots, and none when Com_Error shuts it down", () => {
    /** The loopback packets a shutdown sends the page's own client. */
    const sent = (error: boolean): number => {
      const game = start(slowMaps([]).maps);
      game.tick(still());
      const { net } = game.host;
      while (net.getLoopPacket('client') !== null);
      game.shutdown('Server crashed: boom', error);
      let packets = 0;
      while (net.getLoopPacket('client') !== null) packets++;
      return packets;
    };
    // `SV_FinalMessage`'s two passes each send a snapshot, even to a client on the loopback.
    expect([sent(false), sent(true)]).toEqual([2, 0]);
  });

  it('leaves the match running for a map that is not there', () => {
    const program = slowMaps(['backyard']);
    const game = start(program.maps);
    game.host.sendConsoleCommand('map bakyard\n');
    const time = game.host.time;

    game.tick(still());

    expect(program.asked).toEqual([]);
    expect(game.mapLoad).toBeNull();
    expect(game.host.time).toBeGreaterThan(time);
  });
});

describe("LocalGame: the client's own map", () => {
  it('loads the map its gamestate names, and holds its frames until it is in', async () => {
    const client = slowClientLoader();
    const game = start(slowMaps([]).maps, client.clientLoader);
    for (let i = 0; i < 5 && client.asked.length === 0; i++) game.tick(still());
    expect(client.asked).toEqual(['garage']);

    // `CA_LOADING`: no frame runs while the client's world is read, as the host's own load holds
    // it.
    const loading = game.clientLoad;
    expect(loading).not.toBeNull();
    const time = game.host.time;
    for (let i = 0; i < 3; i++) game.tick(forward());
    expect(game.host.time).toBe(time);

    client.answer({ name: 'garage', trace: createFlatWorldTrace() });
    await loading;
    expect(game.clientLoad).toBeNull();
    expect(game.clientMap?.name).toBe('garage');

    for (let i = 0; i < 5 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());
    expect(game.connection.state).toBe(CA.ACTIVE);
    expect(game.host.time).toBeGreaterThan(time);
  });

  it('loads again at each gamestate, on the map in hand too, and holds its frames', async () => {
    const client = slowClientLoader();
    const host = slowMaps(['garage']);
    const game = start(host.maps, client.clientLoader);
    for (let i = 0; i < 5 && client.asked.length === 0; i++) game.tick(still());
    client.answer({ name: 'garage', trace: createFlatWorldTrace() });
    await game.clientLoad;
    for (let i = 0; i < 10 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());
    expect(game.connection.state).toBe(CA.ACTIVE);

    // `map garage`: the same map again. Its gamestate starts cgame over, as every one does
    // (`CL_DownloadsComplete`), so the client's load runs again; keeping the world is the loader's.
    game.host.sendConsoleCommand('map garage\n');
    game.tick(still());
    host.answer(flatMap('garage', 0));
    await game.mapLoad;
    for (let i = 0; i < 5 && client.asked.length === 1; i++) game.tick(still());
    expect(client.asked).toEqual(['garage', 'garage']);

    const loading = game.clientLoad;
    expect(loading).not.toBeNull();
    const time = game.host.time;
    for (let i = 0; i < 3; i++) game.tick(forward());
    expect(game.host.time).toBe(time);

    client.answer({ name: 'garage', trace: createFlatWorldTrace() });
    await loading;
    for (let i = 0; i < 10 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());
    expect(game.connection.state).toBe(CA.ACTIVE);
  });

  it('stops where it stands when the client cannot read its map, as ERR_DROP does', async () => {
    const client = slowClientLoader();
    const game = start(slowMaps([]).maps, client.clientLoader);
    for (let i = 0; i < 5 && client.asked.length === 0; i++) game.tick(still());
    const loading = game.clientLoad;

    client.refuse(new Error("Can't find map maps/garage.sog"));
    await loading;

    expect(game.clientLoad).toBeNull();
    expect(game.failure?.message).toBe("Can't find map maps/garage.sog");
    const time = game.host.time;
    for (let i = 0; i < 3; i++) game.tick(forward());
    expect(game.host.time).toBe(time);
  });

  it('loads nothing where it was given no place to read its maps', () => {
    const game = start(slowMaps([]).maps);
    for (let i = 0; i < 5; i++) game.tick(still());

    expect(game.clientMap).toBeNull();
    expect(game.clientLoad).toBeNull();
  });
});

describe('LocalGame: the pause', () => {
  /** A program in the world, its client playing, and the store its cvars are in. */
  function playing(): { game: LocalGame; cvars: Cvars } {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    const game = new LocalGame({ cvars, map: flatMap('garage', 0), random: () => 0 });
    for (let i = 0; i < 5 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());
    return { game, cvars };
  }

  it("holds the client's clock and its sends while its own server is paused", () => {
    const { game, cvars } = playing();
    const time = game.host.time;

    cvars.set('cl_paused', '1');
    // The frame the pause is set in still runs the client's half, as Q3's does: the server's own
    // check comes at the end of it, and stops its frame there.
    game.tick(forward());
    const pausedTime = game.host.time;
    const serverTime = game.serverTime;
    const cmdNumber = game.connection.commands.cmdNumber;
    const sent = game.connection.netchan!.outgoingSequence;
    expect(pausedTime).toBe(time);

    game.tick(forward());
    game.tick(forward());

    expect(cvars.get('sv_paused')).toBe('1');
    expect(game.host.time).toBe(pausedTime);
    expect(game.serverTime).toBe(serverTime);
    expect(game.connection.commands.cmdNumber).toBe(cmdNumber);
    // `CL_SendCmd` sends nothing while paused, so no packet goes either.
    expect(game.connection.netchan!.outgoingSequence).toBe(sent);
  });

  it('holds the unpausing frame too, until a snapshot says otherwise', () => {
    const { game, cvars } = playing();
    cvars.set('cl_paused', '1');
    game.tick(forward());
    game.tick(forward());

    cvars.set('cl_paused', '0');
    const serverTime = game.serverTime;
    // `CL_CheckPaused` counts the frame `cl_paused` changed in as paused (`cl_parse.c:225–227`).
    game.tick(forward());
    expect(game.serverTime).toBe(serverTime);
    game.tick(forward());
    expect(game.serverTime).toBeGreaterThan(serverTime);
  });

  it('runs on after the pause is lifted', () => {
    const { game, cvars } = playing();
    const time = game.host.time;
    cvars.set('cl_paused', '1');
    game.tick(forward());
    game.tick(forward());

    cvars.set('cl_paused', '0');
    for (let i = 0; i < 3; i++) game.tick(forward());

    // Q3's early return leaves `sv_paused` standing when the pause ends, and nothing reads it
    // then: the client's own gates need `cl_paused` too.
    expect(cvars.get('sv_paused')).toBe('1');
    expect(game.host.time).toBeGreaterThan(time);
  });
});

describe("LocalGame: the console's host commands", () => {
  it("puts them in the host's buffer, which says so until the next frame runs them", () => {
    const game = start(slowMaps([]).maps);
    for (let i = 0; i < 5 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());
    const time = game.host.time;

    expect(game.consoleCommand('map_restart 0\n')).toBe(true);
    expect(game.commandsPending).toBe(true);

    game.tick(still());

    // `Cbuf_Execute` runs them at the top of the frame, and nothing waits behind them after it.
    expect(game.commandsPending).toBe(false);
    expect(game.host.time).toBeGreaterThan(time);
  });
});

describe("LocalGame: the systeminfo's cvars", () => {
  it("takes a server's own key and refuses one that is the client's, warning as Q3 does", () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cvars = new Cvars({ debugMode: true, warn: () => {} });
      const game = new LocalGame({ cvars, map: flatMap('garage', 0), random: () => 0 });
      for (let i = 0; i < 5 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());
      const name = cvars.get('name');
      log.mockClear();

      // A server that tries to set one of the client's own cvars, and one of its own.
      game.host.setConfigstring(CONFIGSTRING.SYSTEMINFO, '\\name\\Grunt\\pmove_JumpVelocity\\300');
      for (let i = 0; i < 2; i++) game.tick(still());

      expect(cvars.get('name')).toBe(name);
      expect(cvars.get('pmove_JumpVelocity')).toBe('300');
      expect(log.mock.calls.flat().join()).toContain(
        'WARNING: server is not allowed to set name=Grunt'
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe('LocalGame: a command of the client\'s own', () => {
  it('sends `score` to the match, and the board it answers comes back as a server command', () => {
    const game = start(slowMaps([]).maps);
    game.tick(still());
    game.takeServerCommands();

    game.sendClientCommand('score');
    for (let i = 0; i < 2; i++) game.tick(still());

    const board = game.takeServerCommands().find((command) => command.startsWith('scores '));
    expect(board).toBeDefined();
  });

  it("asks its own server's status over the loopback, for the page's client to print", () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    const game = new LocalGame({
      cvars,
      map: flatMap('garage', 0),
      userinfo: '\\name\\Visor',
      random: () => 0
    });
    // The host measures a ping at the top of its frame, and the one acknowledgement it has by the
    // first is stamped at time 0, which doesn't count. A frame more gives it one that does.
    game.tick(still());
    const printed: string[] = [];
    const cls = new ClientStatic({
      cvars,
      createPeerConnection: () => {
        throw new Error('no peers in this test');
      },
      connect: () => {
        throw new Error('no masters in this test');
      },
      print: (line) => printed.push(line)
    });
    cls.attach(game.channel.net, game.connection);

    cls.serverStatus(['serverstatus']);
    game.tick(still());

    expect(printed).toContain('Server settings:');
    expect(printed).toContain(`${'mapname'.padEnd(24)}garage`);
    const players = printed.indexOf('Players:');
    expect(printed.slice(players, players + 3)).toEqual([
      'Players:',
      'num: score: ping: name:',
      '0    0      0     "Visor"'
    ]);
  });
});

describe('LocalGame: the handshake', () => {
  it('connects through it at once, and is playing after the first tick', () => {
    const game = start(slowMaps([]).maps);
    // In the world as the constructor ends, and playing from the first frame that sees it.
    expect(game.connection.state).toBe(CA.PRIMED);
    game.tick(still());

    expect(game.connection.state).toBe(CA.ACTIVE);
    const client = game.host.clients[game.clientNum];
    expect(client.netchan.remoteAddress.type).toBe(NA.LOOPBACK);
    expect(infoValueForKey(client.userinfo, 'ip')).toBe('localhost');
    expect(infoValueForKey(client.userinfo, 'protocol')).toBe('2');
    // The client's own rate, which its userinfo carries: this client asks its host for the
    // host's snapshot rate, and its `rate` is the port's default, which the LAN rule then ignores.
    expect(infoValueForKey(client.userinfo, 'snaps')).toBe('125');
    expect(infoValueForKey(client.userinfo, 'rate')).toBe('50000');
    expect(client.rate).toBe(99999);
  });

  it("keeps a player's own snaps of 20, which the elsewhere default no longer is", () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    cvars.set('snaps', '20');
    const game = new LocalGame({ cvars, map: flatMap('garage', 0), random: () => 0 });
    game.tick(still());

    expect(infoValueForKey(game.host.clients[game.clientNum].userinfo, 'snaps')).toBe('20');
  });

  it("keeps a snaps of the client's own over the local host's rate", () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    cvars.set('snaps', '50');
    const game = new LocalGame({ cvars, map: flatMap('garage', 0), random: () => 0 });
    game.tick(still());

    const client = game.host.clients[game.clientNum];
    expect(infoValueForKey(client.userinfo, 'snaps')).toBe('50');
    expect(client.snapshotMsec).toBe(20);
  });

  it('stays connected over a map change, with no second handshake', async () => {
    const program = slowMaps(['backyard']);
    const game = start(program.maps);
    const { netchan } = game.connection;

    game.host.sendConsoleCommand('map backyard\n');
    game.tick(still());
    // Waiting for the new gamestate from the moment the load starts.
    expect(game.connection.state).toBe(CA.CONNECTED);
    const loading = game.mapLoad;
    program.answer(flatMap('backyard', 512));
    await loading;

    expect(game.connection.state).toBe(CA.CONNECTED);
    // The new gamestate goes in fragments, which the frames carry.
    for (let i = 0; i < 10 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());
    expect(game.connection.state).toBe(CA.ACTIVE);
    expect(game.connection.netchan).toBe(netchan);
  });

  it('finishes the handshake over frames when a latency knob holds it back', () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    cvars.set('cl_packetdelay', '50');
    const game = new LocalGame({ cvars, map: flatMap('garage', 0), random: () => 0 });
    expect(game.connection.state).toBe(CA.CHALLENGING);

    for (let i = 0; i < 20 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());
    expect(game.connection.state).toBe(CA.ACTIVE);
  });
});

describe('LocalGame: a silent server', () => {
  it('is left once nothing has come from it for cl_timeout, six frames running', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cvars = new Cvars({ debugMode: true, warn: () => {} });
      const game = new LocalGame({ cvars, map: flatMap('garage', 0), random: () => 0 });
      // The host's answers held back past the client's timeout, so it reads as silent: the frames
      // carry the time the delay and the timeout are both measured on.
      cvars.set('sv_packetdelay', '999');
      cvars.set('cl_timeout', '0.5');

      for (let i = 0; i < 100 && game.connection.state !== CA.DISCONNECTED; i++) {
        game.tick(still());
      }
      expect(game.connection.state).toBe(CA.DISCONNECTED);
      expect(log).toHaveBeenCalledWith('Server connection timed out.');
    } finally {
      log.mockRestore();
    }
  });
});

describe("LocalGame: the client's clock", () => {
  /** A program, and the frames of a display at `hz`, each a whole number of milliseconds. */
  function display(hz: number, cvars: Record<string, string> = {}) {
    const store = new Cvars({ debugMode: true, warn: () => {} });
    for (const [name, value] of Object.entries(cvars)) store.set(name, value);
    const game = new LocalGame({ cvars: store, map: flatMap('garage', 0), random: () => 0 });
    let frames = 0;
    /** Run a second of frames, and how far the clock was behind the newest snapshot after each. */
    const second = (): number[] => {
      const behind: number[] = [];
      for (let i = 0; i < hz; i++, frames++) {
        const msec = Math.round(((frames + 1) * 1000) / hz) - Math.round((frames * 1000) / hz);
        game.frame(msec, still());
        behind.push(game.connection.snapshots.snap.serverTime - game.connection.clock.serverTime);
      }
      return behind;
    };
    return { game, second };
  }

  it.each([60, 144, 240])(
    'makes one command a step at %i frames a second, and the host runs every one',
    (hz) => {
      const { game, second } = display(hz);
      second();
      const { commands } = game.connection;
      const made = commands.cmdNumber;
      const time = game.host.time;
      second();

      // A second is 125 steps, and the host's frames keep to real time as the client's do.
      expect(Math.abs(commands.cmdNumber - made - 125)).toBeLessThanOrEqual(1);
      expect(Math.abs(game.host.time - time - 1000)).toBeLessThanOrEqual(PMOVE_MSEC);
      // Each a step on from the last, as far back as the ring keeps them.
      const newest = commands.at(commands.cmdNumber).serverTime;
      for (let back = 1; back < 64; back++) {
        expect(commands.at(commands.cmdNumber - back).serverTime).toBe(newest - back * PMOVE_MSEC);
      }
      expect(serverPlayer(game).commandTime).toBe(newest);
    }
  );

  it('runs about 5 ms behind the snapshot it had as the frame began', () => {
    const { second } = display(125);
    second();
    // A snapshot every 8 ms moves the clock 8/50 of Quake 3's step: on by 0.16 until it comes
    // within 5 ms, and back by 0.32 when it does, which keeps it between 4.84 and 5.32. The frame
    // has read a snapshot a frame newer since, which the next frame's clock goes by.
    const share = PMOVE_MSEC / 50;
    for (const behind of second()) {
      expect(behind - PMOVE_MSEC).toBeGreaterThanOrEqual(5 - share - 1e-9);
      expect(behind - PMOVE_MSEC).toBeLessThanOrEqual(5 + 2 * share + 1e-9);
    }
  });

  it("answers the newest snapshot's time with its number, as the view reads them", () => {
    const { game, second } = display(125);
    second();
    const newest = game.snapshot(game.currentSnapshotNumber())!;
    expect(game.latestSnapshotTime).toBe(newest.serverTime);
    expect(newest.serverTime).toBeGreaterThan(0);
  });

  it("hands the view each snapshot's areamask from the client's ring, as CL_GetSnapshot", () => {
    const { game, second } = display(125);
    second();
    const number = game.currentSnapshotNumber();
    expect(game.snapshot(number)!.areamask).toBe(game.connection.snapshots.get(number)!.areamask);
  });

  it("times a snapshot's ping from when the last command it answered went", () => {
    const ping = (delay: string) => {
      const { game } = display(125, { sv_packetdelay: delay });
      const { commands, clock } = game.connection;
      // When each command went: the frame that made it, whose packet carries it.
      const sent = new Map<number, number>();
      for (let frame = 0; frame < 250; frame++) {
        const before = commands.cmdNumber;
        game.frame(PMOVE_MSEC, still());
        for (let n = before + 1; n <= commands.cmdNumber; n++) {
          sent.set(commands.at(n).serverTime, clock.realtime);
        }
      }
      const snap = game.snapshot(game.currentSnapshotNumber())!;
      return { ping: snap.ping, since: clock.realtime - sent.get(snap.ps.commandTime)! };
    };
    // The loopback answers within the frame its packet went.
    expect(ping('0')).toEqual({ ping: 0, since: 0 });
    // Held back 100 ms, the answer is a frame grid's step or so later.
    const held = ping('100');
    expect(held.ping).toBe(held.since);
    expect(held.ping).toBeGreaterThanOrEqual(100);
  });

  it('runs cl_timeNudge ms further behind, and 30 at most', () => {
    const lag = (nudge: string): number => {
      const { second } = display(125, { cl_timeNudge: nudge });
      second();
      return Math.min(...second());
    };
    expect(lag('20') - lag('0')).toBe(20);
    expect(lag('100') - lag('0')).toBe(30);
  });

  it('prints the offset each time a snapshot moves it, with cl_showTimeDelta', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const quiet = display(240);
      log.mockClear();
      quiet.second();
      expect(log).not.toHaveBeenCalled();

      // Twice the frames of the snapshots, which are what move it.
      const { game, second } = display(240, { cl_showTimeDelta: '1' });
      second();
      log.mockClear();
      second();
      const printed = log.mock.calls.map(([line]) => String(line));
      expect(printed).toHaveLength(125);
      expect(printed.every((line) => /^-?\d+$/.test(line))).toBe(true);
      expect(Number(printed.at(-1))).toBe(Math.trunc(game.connection.clock.serverTimeDelta));
    } finally {
      log.mockRestore();
    }
  });
});

describe('LocalGame: the frame each command was read under', () => {
  const frame = (cmd: NetUserCmd) => [cmd.drawnTime, cmd.drawnSnapTime, cmd.drawnNextSnapTime];

  it('carries the last drawn frame to the server as it was, to a 256th of a millisecond', () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    const game = new LocalGame({ cvars, map: flatMap('garage', 0), random: () => 0 });
    for (let i = 0; i < 10; i++) game.frame(PMOVE_MSEC, still());

    const drawn = Math.floor(game.serverTime);
    game.setDrawnFrame(drawn + 0.6, drawn - 8, drawn);
    game.frame(PMOVE_MSEC, still());

    const { commands } = game.connection;
    const sent = commands.at(commands.cmdNumber);
    // 0.6 is 153.6 256ths, and goes as 154.
    expect(frame(sent)).toEqual([drawn + 154 / 256, drawn - 8, drawn]);
    // The match keeps it as it came, beside the command's own time before the clamp.
    const kept = game.game.level.clients[game.clientNum].pers.cmd;
    expect(kept.serverTime).toBe(sent.serverTime);
    expect(frame(kept)).toEqual(frame(sent));
  });

  it('carries no frame at all on the commands made before the view drew one', () => {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    const game = new LocalGame({ cvars, map: flatMap('garage', 0), random: () => 0 });
    game.frame(PMOVE_MSEC, still());

    const { commands } = game.connection;
    expect(frame(commands.at(commands.cmdNumber))).toEqual([0, 0, 0]);
    expect(frame(game.game.level.clients[game.clientNum].pers.cmd)).toEqual([0, 0, 0]);
  });
});

describe('LocalGame: what the prediction reads', () => {
  /** A program over a store the test keeps, so it can set the cvars itself. */
  function program(): { game: LocalGame; cvars: Cvars } {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    const game = new LocalGame({ cvars, map: flatMap('garage', 0), random: () => 0 });
    return { game, cvars };
  }

  it('holds pmove_msec to the move range when it is read outside it', () => {
    const { game, cvars } = program();

    cvars.set('pmove_msec', '2');
    expect(game.pmoveMsec).toBe(PMOVE_MSEC_MIN);
    // Set back into its range where it was read, as the server does.
    expect(cvars.get('pmove_msec')).toBe(String(PMOVE_MSEC_MIN));

    cvars.set('pmove_msec', '100');
    expect(game.pmoveMsec).toBe(PMOVE_MSEC_MAX);
  });

  it("reads g_allowGrapple's style for the client's prediction", () => {
    const { game, cvars } = program();

    // CorkScrew's default is its own hook.
    expect(game.grappleMode).toBe('corkscrew');
    cvars.set('g_allowGrapple', '3');
    expect(game.grappleMode).toBe('q2winch');
    cvars.set('g_allowGrapple', '0');
    expect(game.grappleMode).toBeNull();
  });
});

describe('LocalGame: what the view draws others by', () => {
  function program(): { game: LocalGame; cvars: Cvars } {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    const game = new LocalGame({ cvars, map: flatMap('garage', 0), random: () => 0 });
    return { game, cvars };
  }

  it("works out the gap between the client's snapshots from its snaps and sv_fps", () => {
    const { game, cvars } = program();
    // The page's own game asks for every frame: 8 ms at 125.
    expect(game.snapshotGap).toBe(8);
    // 50 ms rounded up to whole 8 ms frames.
    cvars.set('snaps', '20');
    expect(game.snapshotGap).toBe(56);
    cvars.set('sv_fps', '20');
    expect(game.snapshotGap).toBe(50);
  });

  it("holds the client's snaps to the server's own sv_fps, whatever it is", () => {
    const { game, cvars } = program();
    // 250 a second is 4 ms frames, and snaps of 1000 are held to every one of them.
    cvars.set('snaps', '1000');
    cvars.set('sv_fps', '250');
    expect(game.snapshotGap).toBe(4);
  });

  it('reads an sv_fps under 1 as 1, a snapshot a second, until the host corrects it', () => {
    const { game, cvars } = program();
    cvars.set('sv_fps', '0');
    expect(game.snapshotGap).toBe(1000);
  });

  it("reads xp_unlagged as the systeminfo sets it", () => {
    const { game, cvars } = program();
    expect(game.unlagged).toBe(1);
    cvars.set('xp_unlagged', '204');
    expect(game.unlagged).toBe(204);
  });
});

describe('LocalGame: a channel to a server that is not here', () => {
  /**
   * The worker's shape: a program the client cannot reach, and a channel whose mirrors the test
   * drives as the worker's messages would. The wire is the program's own net, so the client plays.
   */
  /** @param prepare - What to do to the program before the client first reaches it. */
  function elsewhere(prepare?: (program: ServerProgram) => void) {
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    // The worker's timer, which the test drives: real time is the channel's to move, as a worker's
    // own loop does.
    let realtime = 0;
    const program = new ServerProgram({
      cvars,
      map: flatMap('garage', 0),
      random: () => 0,
      now: () => realtime
    });
    const channel = {
      program: null,
      net: program.host.net,
      pumps: [] as number[],
      sent: [] as string[],
      commandsPending: false,
      svPaused: false,
      svRunning: true,
      mapLoad: null as Promise<void> | null,
      failure: null as Error | null,
      loadListener: null as (() => void) | null,
      shutdowns: [] as [string, boolean][],
      readPackets(): void {
        program.readPackets();
      },
      pump(msec: number): void {
        this.pumps.push(msec);
        realtime += msec;
        program.runFrame(msec);
      },
      sendCommand(line: string): void {
        this.sent.push(line);
        program.sendConsoleCommand(line);
      },
      onMapLoad(listener: () => void): void {
        this.loadListener = listener;
        program.onMapLoad = listener;
      },
      shutdown(finalMessage: string, error = false): void {
        this.shutdowns.push([finalMessage, error]);
        program.shutdown(finalMessage, error);
      }
    };
    prepare?.(program);
    const game = new LocalGame({ cvars, channel });
    return { game, cvars, program, channel };
  }

  it('boots and plays with the program out of reach', () => {
    const { game } = elsewhere();
    expect(game.connection.state).toBe(CA.PRIMED);
    game.tick(still());
    expect(game.connection.state).toBe(CA.ACTIVE);

    // The page has no program: the sim is the server's, wherever it runs.
    expect(() => game.host).toThrow(/not in this process/);
    expect(() => game.game).toThrow(/not in this process/);
  });

  it('runs the client half and gives the channel the time', () => {
    const { game, channel } = elsewhere();
    // The boot's ticks: one with its two load frames, and one more while the gamestate's last
    // fragment comes, whose first load frame gets into the world.
    expect(channel.pumps).toEqual([8, 8, 8, 8, 8]);

    // Playing by then, so the frame is the one it is: no catch-up frames to run.
    game.frame(20, forward());
    expect(channel.pumps).toEqual([8, 8, 8, 8, 8, 20]);
  });

  it('is in the world when the boot is over, the gamestate near the largest there is', () => {
    // Three strings the compression can do little with, about as long as a gamestate lets them be:
    // 4200 letters apiece overflow it.
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const text = (seed: number) =>
      Array.from({ length: 4150 }, (_, i) => letters[(i * 7919 + i * i * 31 + seed) % 62]);
    const { game, channel } = elsewhere((program) => {
      const indexes = [CONFIGSTRING.MOTD, CONFIGSTRING.MESSAGE, CONFIGSTRING.MUSIC];
      for (const [n, index] of indexes.entries()) {
        program.host.setConfigstring(index, text(n).join(''));
      }
    });

    // A fragment every other frame, at a LAN client's rate: 29 frames, the boot's first tick and
    // nine more.
    expect(channel.pumps).toHaveLength(29);
    expect(game.connection.state).toBe(CA.PRIMED);
    game.tick(still());
    expect(game.connection.state).toBe(CA.ACTIVE);
  });

  it("sends the console's lines, the restart and the shutdown over the channel", () => {
    const { game, channel } = elsewhere();
    game.consoleCommand('map garage\n');
    game.restart();
    expect(channel.sent).toEqual(['map garage\n', 'map_restart 0\n']);

    channel.commandsPending = true;
    expect(game.commandsPending).toBe(true);
    const loading = Promise.resolve();
    channel.mapLoad = loading;
    expect(game.mapLoad).toBe(loading);
    channel.failure = new Error('dropped');
    expect(game.failure?.message).toBe('dropped');

    game.shutdown('Server disconnected', true);
    expect(channel.shutdowns).toEqual([['Server disconnected', true]]);
  });

  it("gates the client on the channel's pause, not the page's store", () => {
    const { game, cvars, channel } = elsewhere();
    for (let i = 0; i < 5 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());

    cvars.set('cl_paused', '1');
    channel.svPaused = true;
    game.tick(forward());
    const serverTime = game.serverTime;
    const cmdNumber = game.connection.commands.cmdNumber;

    // The channel's word is the one that gates: the store's own `sv_paused` says 0 here.
    cvars.set('sv_paused', '0');
    game.tick(forward());
    game.tick(forward());
    expect(game.serverTime).toBe(serverTime);
    expect(game.connection.commands.cmdNumber).toBe(cmdNumber);

    cvars.set('cl_paused', '0');
    channel.svPaused = false;
    game.tick(forward());
    game.tick(forward());
    expect(game.serverTime).toBeGreaterThan(serverTime);
  });

  it('goes back to waiting for a gamestate when the server starts a map load', () => {
    const { game, channel } = elsewhere();
    for (let i = 0; i < 5 && game.connection.state !== CA.ACTIVE; i++) game.tick(still());
    expect(game.connection.state).toBe(CA.ACTIVE);

    // The worker's `mapLoad` message, which is `SV_SpawnServer`'s `CL_MapLoading`.
    channel.loadListener?.();
    expect(game.connection.state).toBe(CA.CONNECTED);
    expect(game.connection.servername).toBe('localhost');
  });
});

describe('LocalGame: a server elsewhere', () => {
  /**
   * A dedicated server at 10.0.0.1, on a network in memory, and a page at 10.0.0.2 whose client
   * reaches it through the page's own socket.
   *
   * @param prepare - What to do to the page's store before the client is made.
   * @param clientLoader - Where the client reads the map the gamestate names, if anywhere.
   */
  function elsewhere(prepare?: (cvars: Cvars) => void, clientLoader?: ClientLoader) {
    const network = new MemoryNetwork();
    const program = new ServerProgram({
      cvars: new Cvars({ debugMode: true, warn: () => {} }),
      map: flatMap('garage', 0),
      socket: network.socket('10.0.0.1'),
      random: () => 0,
      now: () => network.now
    });
    const cvars = new Cvars({ debugMode: true, warn: () => {} });
    prepare?.(cvars);
    const socket = network.socket('10.0.0.2');
    const net = new Net({ cvars, socket, now: () => network.now, print: () => {} });
    const game = new LocalGame({
      cvars,
      channel: new RemoteChannel(net),
      connect: { server: '10.0.0.1', address: stringToAdr('10.0.0.1')! },
      userinfo: '\\name\\Visitor',
      clientLoader
    });
    /** A frame of the client's, then one of the server's, a tick on. */
    const frame = () => {
      network.advance(PMOVE_MSEC);
      game.tick(still());
      program.runFrame(PMOVE_MSEC);
    };
    /** Frames until the client is in the world, and how many it took. */
    const play = (): number => {
      let frames = 0;
      while (frames < 100 && game.connection.state !== CA.ACTIVE) {
        frame();
        frames++;
      }
      return frames;
    };
    return { network, program, cvars, socket, game, frame, play };
  }

  it('connects through the socket, and plays with no frame run fast', () => {
    const { game, program, play } = elsewhere();
    expect(game.remote).toBe(true);
    expect(game.connection.state).toBe(CA.CONNECTING);

    const frames = play();
    expect(game.connection.state).toBe(CA.ACTIVE);
    const client = program.host.clients[game.clientNum];
    expect(infoValueForKey(client.userinfo, 'ip')).toBe('10.0.0.2');
    expect(infoValueForKey(client.userinfo, 'name')).toBe('Visitor');
    // One frame a tick, however far from the world the client is: its clock is real time.
    expect(game.connection.clock.realtime).toBe(frames * PMOVE_MSEC);
  });

  it("reads a connect's answer that has landed before it resends, as Q3 reads before it sends", () => {
    const { network, game, frame } = elsewhere();
    // Through the challenge: the connect goes, and the server answers it. The client has not read
    // the answer yet, as a load holds its frames.
    frame();
    frame();
    expect(game.connection.state).toBe(CA.CHALLENGING);
    const sent = game.connection.connectPacketCount;

    // Three seconds later the answer is still queued: the frame reads it before it considers a
    // retransmit, so no second connect goes and no slot is reset.
    network.advance(4000);
    game.tick(still());
    expect(game.connection.state).toBe(CA.CONNECTED);
    expect(game.connection.connectPacketCount).toBe(sent);
  });

  it("asks a server elsewhere for a snapshot every server frame, and keeps a player's own", () => {
    const left = elsewhere();
    left.play();
    expect(infoValueForKey(left.program.host.clients[0].userinfo, 'snaps')).toBe('125');

    const own = elsewhere((cvars) => cvars.set('snaps', '50'));
    own.play();
    expect(infoValueForKey(own.program.host.clients[0].userinfo, 'snaps')).toBe('50');
  });

  it("keeps real time to 5000 ms after a long frame, as Q3's remote client does", () => {
    const { game, play } = elsewhere();
    play();
    const before = game.connection.clock.realtime;
    // A frame of a minute, as a tab left in the background hands back: a client whose server is
    // elsewhere clamps at 5000 and drops the rest (`Com_ModifyMsec`, `common.c:3039–3044`).
    game.frame(60_000, still());
    expect(game.connection.clock.realtime - before).toBe(5000);
  });

  it('has no server to give a host command to', () => {
    const { game } = elsewhere();
    expect(game.consoleCommand('status')).toBe(false);
    expect(game.channel.svRunning).toBe(false);
  });

  it("hands on an answer not its connection's with when its socket says it landed", () => {
    const { network, socket, game } = elsewhere();
    const receive = socket.receive.bind(socket);
    socket.receive = () => {
      const packet = receive();
      return packet && { ...packet, time: 1234.5 };
    };
    const landed: (number | undefined)[] = [];
    game.connection.onConnectionless = (_from, _data, time) => landed.push(time);

    const answer = Uint8Array.from('\xff\xff\xff\xffinfoResponse\n', (c) => c.charCodeAt(0));
    network.socket('10.0.0.3').send(answer, stringToAdr('10.0.0.2')!);
    game.tick(still());
    expect(landed).toEqual([1234.5]);
  });

  it('hears why the server went, as a command for cgame to act on', () => {
    const { game, program, frame, play } = elsewhere();
    play();
    game.takeServerCommands();

    program.shutdown('Server quit');
    frame();
    expect(game.takeServerCommands()).toContain('disconnect "Server quit"');
  });

  it('is told what changed while it read its map, as it enters the world', async () => {
    const reads = slowClientLoader();
    const { game, program, frame, play } = elsewhere(undefined, reads.clientLoader);
    for (let i = 0; i < 10 && reads.asked.length === 0; i++) frame();
    expect(program.host.clients[game.clientNum].state).toBe(CS.PRIMED);

    // Somebody joins meanwhile, which a primed client is not sent.
    const joined = 'n\\Ghost\\t\\0';
    program.host.setConfigstring(CONFIGSTRING.PLAYERS + 5, joined);
    frame();
    game.takeServerCommands();
    expect(game.configstring(CONFIGSTRING.PLAYERS + 5)).toBe('');

    reads.answer({ name: 'garage', trace: createFlatWorldTrace() });
    await game.clientLoad;
    play();
    frame();
    game.takeServerCommands();
    expect(game.configstring(CONFIGSTRING.PLAYERS + 5)).toBe(joined);
  });

  it('leaves the server on shutdown, which lets the slot go', () => {
    const { game, program, frame, play } = elsewhere();
    play();
    const slot = program.host.clients[game.clientNum];
    expect(slot.state).toBe(CS.ACTIVE);

    game.shutdown('');
    expect(game.connection.state).toBe(CA.DISCONNECTED);
    frame();
    expect(slot.state).toBe(CS.ZOMBIE);
  });
});
