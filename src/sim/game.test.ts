import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveManifest } from '../formats/asset-manifest';
import { bspFile } from '../formats/bsp-test-fixtures';
import { entityTokens } from '../formats/entity-text';
import { CONFIGSTRING, MAX_SOUNDS } from '../net/commands';
import { infoValueForKey } from '../net/info';
import type { CvarStore } from '../net/cvar';
import { ClientConnection } from '../net/connection';
import { testCvars } from '../net/net-test-fixtures';
import {
  createNetUserCmd,
  ENTITYNUM_NONE,
  ENTITYNUM_WORLD,
  MAX_CLIENTS,
  type NetUserCmd
} from '../net/protocol';
import { CS, Host } from '../server/host';
import { hostMapFromData } from '../server/host-map';
import { connectLocal, connectRemote, drain, fixtureHost, sendMove } from '../server/host-test-fixtures';
import { ANIM, animOf } from './animations';
import {
  angleToShort,
  awardSprite,
  CON,
  isSpectator,
  NUM_PING_SAMPLES,
  setClientViewAngle,
  SPECTATOR,
  TEAM_STATE
} from './client';
import { box, createFlatWorldTrace } from './box-world';
import { CA_ROUND_WARMUP, CA_WIN_DELAY } from './clan-arena';
import { DAMAGE_NO_PROTECTION, damage } from './combat';
import {
  BUTTON_AFFIRMATIVE,
  BUTTON_ATTACK,
  BUTTON_GESTURE,
  BUTTON_TALK,
  BUTTON_USE_HOLDABLE,
  CONTENTS,
  DF_NO_FOOTSTEPS,
  CROUCH_HEIGHT,
  DEAD_HEIGHT,
  DEFAULT_VIEWHEIGHT,
  EF_AWARDS,
  EF_AWARD_EXCELLENT,
  EF_CONNECTION,
  EF_DEAD,
  EF_NODRAW,
  EF_PLAYER_EVENT,
  EF_TEAMVOTED,
  EF_TELEPORT_BIT,
  EF_VOTED,
  FL,
  GT,
  MASK,
  MOD,
  PERS,
  PITCH_LIMIT_DEGREES,
  PITCH_LIMIT_SHORT,
  PM_DEAD,
  PM_FREEZE,
  PM_INTERMISSION,
  PM_NORMAL,
  PM_SPECTATOR,
  PMF_FOLLOW,
  PMF_SCOREBOARD,
  PMF_GRAPPLE_PULL,
  PMF_TIME_KNOCKBACK,
  PMOVE_MSEC,
  RANK_TIED_FLAG,
  REWARD_SPRITE_TIME,
  SCORE_NOT_PRESENT,
  STAT,
  TEAM
} from './constants';
import { entityContact, setBrushModel } from './clip-trace';
import { triggerBsp } from './cm/collision-test-fixtures';
import { addPredictableEvent, EV, eventNumber, eventsSince } from './events';
import { ET, SVF, type GameEntity } from './game-entity';
import type { GameModule, GameTraps } from './game-module';
import { findItem, HI, itemIndex, ITEMS, NUM_ITEMS, PW } from './items';
import { EVENT_VALID_MSEC, INTERMISSION_DELAY_TIME } from './level';
import {
  cleanName,
  Game,
  isGameCommand,
  SPAWN_HEALTH_BONUS,
  SPAWN_LIFT,
  SPECTATOR_SPEED,
  type GameOptions
} from './game';
import { entityText, mapOf, ORIGIN_MAP, spawnSpot, type TestEntity } from './map-test-fixtures';
import { FRY_SOUND } from './player-life';
import { HASTE_RATE } from './powerups';
import { presetRules } from './rules-test-fixtures';
import { ServerWorld, type WorldMap } from './server-world';
import { TELEFRAG_DAMAGE } from './teleport';
import { distinctAsks, recordingTrace, type TraceAsk } from './trace-test-fixtures';
import {
  NO_CONTENTS,
  clearTrace,
  playerBounds,
  type PointContentsFn,
  type TraceFn,
  type TraceResult
} from './types';
import { copy, vec3, type Vec3 } from './vec3';
import { ALL_WEAPONS, AMMO_INFINITE, WEAPON_READY, WP } from './weapons/constants';
import { radiusDamage } from './weapons/splash';

/** `G_Damage` from the world, as a fall hurts: no inflictor, no attacker and no push. */
function hurt(game: Game, clientNum: number, points: number): void {
  damage(game.level, game.level.gentities[clientNum], null, null, null, points, 0, MOD.FALLING);
}

/** The cvars, which are the only thing a session crosses a map on. */
function store(initial: Record<string, string> = {}): CvarStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  const counts = new Map<string, number>();
  let total = 0;
  const set = (name: string, value: string) => {
    // A cvar set to what it already holds is not a modification, which is what makes the count
    // worth keeping: it changes only when somebody actually changed something.
    if ((values.get(name) ?? '') === value) return;
    values.set(name, value);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    total++;
  };
  return {
    values,
    get: (name) => values.get(name) ?? '',
    set,
    setServer: (name, value) => {
      set(name, value);
      return true;
    },
    modificationCount: (name) => counts.get(name) ?? 0,
    totalModifications: () => total
  };
}

/** A map with no collision, which {@link TestTraps}' world is cleared over. */
const EMPTY_WORLD: WorldMap = {
  trace: (_start, _mins, _maxs, end) => clearTrace(end),
  pointContents: NO_CONTENTS
};

/** A host that records rather than transmits, which is every trap the game module calls. */
class TestTraps implements GameTraps {
  readonly configstrings = new Map<number, string>();
  readonly commands: { to: number | null; text: string }[] = [];
  readonly consoleCommands: string[] = [];

  /**
   * Every configstring and command in the order they were produced.
   *
   * A configstring reaches a client as a reliable command like any other, so the order the two
   * kinds are interleaved in is something a client can actually observe.
   */
  readonly events: string[] = [];
  readonly dropped: { clientNum: number; reason: string }[] = [];
  readonly linked: number[] = [];
  readonly unlinked: number[] = [];

  userinfos = new Map<number, string>();
  cmds = new Map<number, NetUserCmd>();
  readonly prints: string[] = [];

  /** The map's entity text. `makeGame` starts it before `init`, as the host does. */
  entities = ORIGIN_MAP;
  private tokens = entityTokens(this.entities);

  /**
   * The world clients move through. Empty by default, as a game module with no map has: nothing
   * is solid, so a spawned client falls. A test that wants ground puts one here.
   */
  world: TraceFn = (_start, _mins, _maxs, end) => clearTrace(end);
  /** What the world holds at a point, which is nothing until a test fills a pool. */
  contents: PointContentsFn = NO_CONTENTS;

  setConfigstring(index: number, value: string): void {
    this.configstrings.set(index, value);
    this.events.push(`cs ${index}`);
  }

  getConfigstring(index: number): string {
    return this.configstrings.get(index) ?? '';
  }

  sendServerCommand(clientNum: number | null, text: string): void {
    this.commands.push({ to: clientNum, text });
    this.events.push(text);
  }

  getUserinfo(clientNum: number): string {
    return this.userinfos.get(clientNum) ?? '';
  }

  setUserinfo(clientNum: number, userinfo: string): void {
    this.userinfos.set(clientNum, userinfo);
  }

  getUserCmd(clientNum: number): NetUserCmd {
    return this.cmds.get(clientNum) ?? createNetUserCmd();
  }

  dropClient(clientNum: number, reason: string): void {
    this.dropped.push({ clientNum, reason });
  }

  sendConsoleCommand(text: string): void {
    this.consoleCommands.push(text);
  }

  trace(
    start: Vec3,
    mins: Vec3,
    maxs: Vec3,
    end: Vec3,
    passEntityNum: number,
    contentmask: number
  ): TraceResult {
    return this.world(start, mins, maxs, end, passEntityNum, contentmask);
  }

  pointContents(point: Vec3, passEntityNum: number): number {
    return this.contents(point, passEntityNum);
  }

  /** A map with no collision, whose answer to any `*N` is that it has no such model. */
  setBrushModel(entity: GameEntity, name: string | null): void {
    setBrushModel(undefined, entity, name, (linked) => this.linkEntity(linked));
  }

  entityContact(mins: Vec3, maxs: Vec3, entity: GameEntity): boolean {
    return entityContact(undefined, entity, mins, maxs);
  }

  linkEntity(entity: GameEntity): void {
    // `SV_LinkEntity`'s box, which is what a blast measures to, and the world's order, which is
    // what it finds things in.
    this.links.link(entity);
    this.linked.push(entity.s.number);
  }

  unlinkEntity(entity: GameEntity): void {
    this.links.unlink(entity);
    this.unlinked.push(entity.s.number);
  }

  /** The game this answers for, which `makeGame` sets: the box is looked for among its entities. */
  module: GameModule | null = null;

  /** The server's world, over a map with no clip map, which only links and finds. */
  private readonly links = new ServerWorld((number) => this.module!.entity(number), EMPTY_WORLD);

  entitiesInBox(mins: Vec3, maxs: Vec3): number[] {
    return this.links.areaEntities(mins, maxs);
  }

  /** The portals opened and closed, in order: a world of one area has none to change. */
  readonly portals: { number: number; open: boolean }[] = [];

  adjustAreaPortalState(entity: GameEntity, open: boolean): void {
    this.portals.push({ number: entity.s.number, open });
  }

  /** What `inPVS` answers, and each pair it was asked about: a world of one cluster sees all. */
  sees = true;
  readonly sights: [Vec3, Vec3][] = [];

  inPVS(p1: Vec3, p2: Vec3): boolean {
    this.sights.push([{ ...p1 }, { ...p2 }]);
    return this.sees;
  }

  getEntityToken(): string | null {
    return this.tokens();
  }

  print(text: string): void {
    this.prints.push(text);
  }

  /** `Sys_Milliseconds`, which a test moves by hand. */
  clock = 0;

  milliseconds(): number {
    return this.clock;
  }

  /**
   * Read the entity text from its start again, and clear the world, as the host does before every
   * `GAME_INIT`.
   */
  restartEntities(): void {
    this.tokens = entityTokens(this.entities);
    this.links.clear(EMPTY_WORLD);
  }

  // A bot needs a host's slots, so a test of one runs behind a real host; these have none to give.
  botAllocateClient(): number {
    return -1;
  }

  botFreeClient(): void {}

  botUserCommand(): void {}

  botGetServerCommand(): string | null {
    return null;
  }
}

interface Fixture {
  game: Game;
  traps: TestTraps;
  cvars: ReturnType<typeof store>;
}

function makeGame(
  options: Partial<GameOptions> & { entities?: string } = {},
  cvarValues = {}
): Fixture {
  const traps = new TestTraps();
  const { entities, ...gameOptions } = options;
  if (entities !== undefined) traps.entities = entities;
  const cvars = store(cvarValues);
  const game = new Game({
    traps,
    cvars,
    maxclients: 4,
    // Always the first of the furthest half, so a spawn point is a decision rather than a coin.
    random: () => 0,
    ...gameOptions
  });
  traps.module = game;
  traps.restartEntities();
  game.init(0, 1, false);
  return { game, traps, cvars };
}

/** Bring a client all the way in, as the host would. */
function join(fixture: Fixture, clientNum: number, userinfo = '\\name\\Sarge'): void {
  fixture.traps.userinfos.set(clientNum, userinfo);
  expect(fixture.game.clientConnect(clientNum, true, false)).toBeNull();
  fixture.game.clientBegin(clientNum);
}

/** Bring a bot in, which is a client the counts and the ready check both step over. */
function joinBot(fixture: Fixture, clientNum: number, userinfo = '\\name\\Grunt'): void {
  fixture.traps.userinfos.set(clientNum, userinfo);
  expect(fixture.game.clientConnect(clientNum, true, true)).toBeNull();
  fixture.game.clientBegin(clientNum);
}

/** Hold these buttons down, and hand the command to the game as the host would. */
function press(fixture: Fixture, clientNum: number, buttons: number): void {
  const cmd = createNetUserCmd();
  cmd.serverTime = fixture.game.level.time;
  cmd.buttons = buttons;
  fixture.traps.cmds.set(clientNum, cmd);
  fixture.game.clientThink(clientNum);
}

/** A match that has ended and gone to the intermission, with the clients already in it. */
function atIntermission(clients = 1, options: Partial<GameOptions> = {}): Fixture {
  const fixture = makeGame(options, { timelimit: '1' });
  for (let i = 0; i < clients; i++) join(fixture, i);
  // One player cannot tie, so the time limit is free to end the match; two need a score between
  // them, which the frag limit is high enough not to notice. The scores are set outright rather
  // than assumed to be zero, because arriving clients telefrag each other and that scores.
  fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 1;
  for (let i = 1; i < clients; i++) fixture.game.level.clients[i].ps.persistant[PERS.SCORE] = 0;
  fixture.game.calculateRanks();

  fixture.game.runFrame(60_000);
  fixture.game.runFrame(61_000);
  expect(fixture.game.level.intermissiontime).toBe(61_000);
  return fixture;
}

/** Put a client on a side, which is what the team change will do when it arrives. */
function putOnTeam(fixture: Fixture, clientNum: number, team: number): void {
  fixture.game.level.clients[clientNum].sess.sessionTeam = team;
  fixture.game.calculateRanks();
}

/** What a client is told about the state of the match. */
function warmupString(fixture: Fixture): string {
  return fixture.traps.configstrings.get(CONFIGSTRING.WARMUP) ?? '';
}

/** Every `print` the match has sent to everyone. */
function prints(fixture: Fixture): string[] {
  return fixture.traps.commands.map((command) => command.text);
}

/** The corpses in the world: the body slots something has been copied into and not retired. */
function corpses(game: Game): GameEntity[] {
  return game.level.bodyQue.filter((body) => body.r.linked);
}

describe('a client connecting', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeGame();
  });

  it('takes the slot and waits there', () => {
    fixture.traps.userinfos.set(0, '\\name\\Sarge');
    expect(fixture.game.clientConnect(0, true, false)).toBeNull();

    const client = fixture.game.level.clients[0];
    expect(client.pers.connected).toBe(CON.CONNECTING);
    expect(client.pers.netname).toBe('Sarge');
    expect(fixture.game.level.gentities[0].client).toBe(client);
  });

  it('is announced once, and not when it is only being carried over', () => {
    fixture.traps.userinfos.set(0, '\\name\\Sarge');
    fixture.game.clientConnect(0, true, false);
    expect(fixture.traps.commands.map((c) => c.text)).toContain('print "Sarge^7 connected\n"');

    fixture.traps.commands.length = 0;
    fixture.game.clientConnect(0, false, false);
    expect(fixture.traps.commands.map((c) => c.text)).not.toContain('print "Sarge^7 connected\n"');
  });

  it('is announced renamed once in the world, white after the old name', () => {
    fixture.traps.userinfos.set(0, '\\name\\^1Sarge');
    fixture.game.clientConnect(0, true, false);
    fixture.traps.userinfos.set(0, '\\name\\Grunt');
    fixture.game.clientUserinfoChanged(0);
    // Still connecting: a name taken before the world is nobody's news.
    const renamed = () => fixture.traps.commands.filter((c) => c.text.includes('renamed'));
    expect(renamed()).toEqual([]);

    fixture.game.clientBegin(0);
    fixture.traps.userinfos.set(0, '\\name\\Visor');
    fixture.game.clientUserinfoChanged(0);
    expect(renamed().map((c) => c.text)).toEqual(['print "Grunt^7 renamed to Visor\n"']);
  });

  it('is refused by a password it does not have', () => {
    const { game, traps } = makeGame({}, { g_password: 'rocket' });
    traps.userinfos.set(0, '\\name\\Sarge\\ip\\1.2.3.4');
    expect(game.clientConnect(0, true, false)).toBe('Invalid password');

    traps.userinfos.set(0, '\\name\\Sarge\\ip\\1.2.3.4\\password\\rocket');
    expect(game.clientConnect(0, true, false)).toBeNull();
  });

  it('is never asked for one when it shares the host’s process', () => {
    const { game, traps } = makeGame({}, { g_password: 'rocket' });
    traps.userinfos.set(0, '\\name\\Sarge\\ip\\localhost');

    expect(game.clientConnect(0, true, false)).toBeNull();
    expect(game.level.clients[0].pers.localClient).toBe(true);
  });

  it('says in g_needpass whether one is wanted, from the next frame on', () => {
    const { game, cvars } = makeGame({}, { g_needpass: '1' });
    game.runFrame(100);
    expect(cvars.get('g_needpass')).toBe('0');

    cvars.set('g_password', 'rocket');
    expect(cvars.get('g_needpass')).toBe('0');
    game.runFrame(200);
    expect(cvars.get('g_needpass')).toBe('1');

    // `none` is no password, whatever its case (`g_main.c:1745`).
    cvars.set('g_password', 'None');
    game.runFrame(300);
    expect(cvars.get('g_needpass')).toBe('0');
  });

  it('forces a disconnect on a slot that is somehow still occupied', () => {
    join(fixture, 0);
    expect(fixture.game.level.gentities[0].inuse).toBe(true);

    fixture.game.clientConnect(0, true, false);
    expect(fixture.traps.configstrings.get(CONFIGSTRING.PLAYERS + 0)).toContain('n\\Sarge');
    expect(fixture.game.level.clients[0].pers.connected).toBe(CON.CONNECTING);
  });

  it('publishes what another client needs to draw it on a scoreboard', () => {
    fixture.traps.userinfos.set(0, '\\name\\Sarge\\model\\sarge\\handicap\\60\\color1\\4');
    fixture.game.clientConnect(0, true, false);

    const players = fixture.traps.configstrings.get(CONFIGSTRING.PLAYERS + 0) ?? '';
    expect(players).toContain('n\\Sarge');
    expect(players).toContain('model\\sarge');
    expect(players).toContain('hc\\60');
    expect(players).toContain('c1\\4');
  });

  it('takes cg_debugDelag from the userinfo only while sv_cheats is on', () => {
    fixture.traps.userinfos.set(0, '\\name\\Sarge\\cg_debugDelag\\1');
    fixture.game.clientConnect(0, true, false);
    const pers = fixture.game.level.clients[0].pers;
    expect(pers.debugDelag).toBe(false);

    fixture.cvars.set('sv_cheats', '1');
    fixture.game.clientUserinfoChanged(0);
    expect(pers.debugDelag).toBe(true);
    fixture.traps.userinfos.set(0, '\\name\\Sarge\\cg_debugDelag\\0');
    fixture.game.clientUserinfoChanged(0);
    expect(pers.debugDelag).toBe(false);
  });
});

describe('a client entering the world', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeGame();
    join(fixture, 0);
  });

  it('is connected, in the world, and counted', () => {
    const client = fixture.game.level.clients[0];
    expect(client.pers.connected).toBe(CON.CONNECTED);
    expect(fixture.game.level.gentities[0].inuse).toBe(true);
    expect(fixture.game.level.gentities[0].classname).toBe('player');
    expect(fixture.game.level.numPlayingClients).toBe(1);
    expect(fixture.traps.linked).toContain(0);
  });

  it('is announced, and never in a tournament where there are only two of them', () => {
    expect(fixture.traps.commands.map((c) => c.text)).toContain(
      'print "Sarge^7 entered the game\n"'
    );

    const duel = makeGame({ gametype: GT.TOURNAMENT });
    join(duel, 0);
    expect(duel.traps.commands.map((c) => c.text)).not.toContain(
      'print "Sarge^7 entered the game\n"'
    );
  });

  it('starts with the loadout Quake 3 hands out, when nothing has said otherwise', () => {
    const bare = makeGame();
    bare.game.clientConnect(0, true, false);
    bare.game.clientBegin(0);
    const { ps } = bare.game.level.clients[0];

    expect(ps.stats[STAT.WEAPONS]).toBe((1 << WP.MACHINEGUN) | (1 << WP.GAUNTLET));
    expect(ps.ammo[WP.MACHINEGUN]).toBe(100);
    expect(ps.ammo[WP.GAUNTLET]).toBe(-1);
    expect(ps.weapon).toBe(WP.MACHINEGUN);
    expect(ps.stats[STAT.ARMOR]).toBe(0);
  });

  it('hands out the whole rack under `pcq_spawnWeapons 1`, and still the machinegun in hand', () => {
    const racked = makeGame({}, { pcq_spawnWeapons: '1' });
    racked.game.clientConnect(0, true, false);
    racked.game.clientBegin(0);
    const { ps } = racked.game.level.clients[0];

    // `pcq_spawnWeapons` is the port's testing aid now that the map hands weapons out: what is
    // owned changes, what is held does not, because the machinegun is what Quake 3 starts you
    // with.
    for (const weapon of ALL_WEAPONS) {
      expect(ps.stats[STAT.WEAPONS] & (1 << weapon), String(weapon)).toBeTruthy();
    }
    expect(ps.ammo[WP.MACHINEGUN]).toBe(AMMO_INFINITE);
    expect(ps.weapon).toBe(WP.MACHINEGUN);
  });

  it('registers the testing loadout off, and the testing armor at none', () => {
    const fixture = makeGame();
    expect(fixture.cvars.get('pcq_spawnWeapons')).toBe('0');
    expect(fixture.cvars.get('pcq_spawnArmor')).toBe('0');
  });

  it('gives a team game 50 bullets rather than 100, as TDM does', () => {
    const team = makeGame({ gametype: GT.TEAM });
    team.game.clientConnect(0, true, false);
    team.game.clientBegin(0);
    const { ps } = team.game.level.clients[0];

    expect(ps.ammo[WP.MACHINEGUN]).toBe(50);
    expect(ps.stats[STAT.WEAPONS]).toBe((1 << WP.MACHINEGUN) | (1 << WP.GAUNTLET));
  });

  describe('the ammo bonus', () => {
    const CQ3_BONUS = {
      g_startingAmmoBonus_sg: '2',
      g_startingAmmoBonus_gl: '3',
      g_startingAmmoBonus_rl: '2',
      g_startingAmmoBonus_lg: '20',
      g_startingAmmoBonus_rg: '3'
    };

    /** A first spawn in `gametype` under CQ3's bonus and these cvars, with no warmup. */
    function spawned(gametype: number, cvarValues: Record<string, string> = {}) {
      const fixture = makeGame({ gametype }, { g_doWarmup: '0', ...CQ3_BONUS, ...cvarValues });
      fixture.game.clientConnect(0, true, false);
      fixture.game.clientBegin(0);
      return fixture;
    }

    /** The shotgun's to the railgun's ammo. */
    function bonus(fixture: Fixture): number[] {
      return fixture.game.level.clients[0].ps.ammo.slice(WP.SHOTGUN, WP.RAILGUN + 1);
    }

    it('gives a live tourney or CTF spawn the ammo, without the weapons', () => {
      for (const gametype of [GT.TOURNAMENT, GT.CTF]) {
        const fixture = spawned(gametype);
        expect(bonus(fixture), String(gametype)).toEqual([2, 3, 2, 20, 3]);
        expect(fixture.game.level.clients[0].ps.stats[STAT.WEAPONS]).toBe(
          (1 << WP.MACHINEGUN) | (1 << WP.GAUNTLET)
        );
      }
    });

    it('gives none in the other modes, and leaves Clan Arena its own loadout', () => {
      for (const gametype of [GT.FFA, GT.SINGLE_PLAYER, GT.TEAM]) {
        expect(bonus(spawned(gametype)), String(gametype)).toEqual([0, 0, 0, 0, 0]);
      }
      const none = Object.fromEntries(Object.keys(CQ3_BONUS).map((cvar) => [cvar, '0']));
      expect(bonus(spawned(GT.CA))).toEqual(bonus(spawned(GT.CA, none)));
    });

    it('gives none in the warmup, and gives it to a spawn once the match is live', () => {
      const fixture = spawned(GT.CTF, { g_doWarmup: '1' });
      expect(fixture.game.level.warmupTime).toBe(-1);
      expect(bonus(fixture)).toEqual([0, 0, 0, 0, 0]);

      fixture.game.level.warmupTime = 0;
      fixture.game.clientRespawn(fixture.game.level.gentities[0]);
      expect(bonus(fixture)).toEqual([2, 3, 2, 20, 3]);
    });

    it("leaves `pcq_spawnWeapons`' infinite ammo as it is", () => {
      expect(bonus(spawned(GT.CTF, { pcq_spawnWeapons: '1' }))).toEqual([-1, -1, -1, -1, -1]);
    });

    it("gives CQ3's alone of the presets", () => {
      const presets = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'];
      const given = presets.map((name) => {
        const rules = Object.entries(presetRules(name)).filter(([cvar]) =>
          cvar.startsWith('g_startingAmmoBonus_')
        );
        return bonus(spawned(GT.CTF, Object.fromEntries(rules.map(([k, v]) => [k, String(v)]))));
      });
      expect(given).toEqual([
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [2, 3, 2, 20, 3],
        [0, 0, 0, 0, 0]
      ]);
    });
  });

  it('starts over the health limit, to drain back down to it', () => {
    const { ps } = fixture.game.level.clients[0];

    expect(ps.stats[STAT.MAX_HEALTH]).toBe(100);
    expect(ps.stats[STAT.HEALTH]).toBe(100 + SPAWN_HEALTH_BONUS);
  });

  it('takes its health limit from the handicap it asked for', () => {
    const handicapped = makeGame();
    join(handicapped, 1, '\\name\\Sarge\\handicap\\60');
    const { ps } = handicapped.game.level.clients[1];

    expect(ps.stats[STAT.MAX_HEALTH]).toBe(60);
    expect(ps.stats[STAT.HEALTH]).toBe(60 + SPAWN_HEALTH_BONUS);
  });

  it('stands at a spawn point, a little above it', () => {
    const placed = makeGame({
      entities: mapOf(spawnSpot(vec3(100, 200, 16), 90))
    });
    join(placed, 0);
    const { ps } = placed.game.level.clients[0];

    // The spawn's 100 ms think integrates the drop from the lift before the first command;
    // the rest of the fall is the first commands'. Measured at 8 ms ticks.
    expect(ps.origin).toEqual(vec3(100, 200, 21.2304));
    expect(ps.viewangles.y).toBe(90);
  });

  it('comes out of the spawn with the state the move would leave', () => {
    const placed = makeGame({
      entities: mapOf(spawnSpot(vec3(100, 200, 16), 90))
    });
    join(placed, 0);
    const { ps } = placed.game.level.clients[0];

    // Without Q3's spawn think the view height was zero until the first
    // command, and the clock was put at the spawn's time rather than on the move's grid.
    expect(ps.viewheight).toBe(DEFAULT_VIEWHEIGHT);
    expect(ps.pmType).toBe(PM_NORMAL);
    expect(ps.commandTime).toBe(placed.game.level.time);
    expect(ps.commandTime % PMOVE_MSEC).toBe(0);
  });

  it('has an entity state other clients can be sent', () => {
    const entity = fixture.game.level.gentities[0];

    expect(entity.s.eType).toBe(ET.PLAYER);
    expect(entity.s.clientNum).toBe(0);
    expect(entity.s.weapon).toBe(WP.MACHINEGUN);
  });
});

describe('a client spawning again', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeGame();
    join(fixture, 0);
  });

  it('counts the spawn, so its own client knows it happened', () => {
    const { ps } = fixture.game.level.clients[0];
    expect(ps.persistant[PERS.SPAWN_COUNT]).toBe(1);

    fixture.game.clientRespawn(fixture.game.level.gentities[0]);
    expect(ps.persistant[PERS.SPAWN_COUNT]).toBe(2);
  });

  it('keeps the score and loses the life', () => {
    const client = fixture.game.level.clients[0];
    client.ps.persistant[PERS.SCORE] = 7;
    client.ps.stats[STAT.HEALTH] = 4;
    client.damageBlood = 30;

    fixture.game.clientRespawn(fixture.game.level.gentities[0]);

    expect(client.ps.persistant[PERS.SCORE]).toBe(7);
    expect(client.ps.stats[STAT.HEALTH]).toBe(100 + SPAWN_HEALTH_BONUS);
    expect(client.damageBlood).toBe(0);
  });

  it('keeps the name and the tournament record, which are the player’s and not the life’s', () => {
    const client = fixture.game.level.clients[0];
    client.sess.wins = 2;

    fixture.game.clientRespawn(fixture.game.level.gentities[0]);

    expect(client.pers.netname).toBe('Sarge');
    expect(client.sess.wins).toBe(2);
  });

  it('flips the teleport bit, so the client does not slide across the map to it', () => {
    const client = fixture.game.level.clients[0];
    const before = client.ps.eFlags;

    fixture.game.clientRespawn(fixture.game.level.gentities[0]);

    expect(client.ps.eFlags).not.toBe(before);
  });

  it("arrives with a teleporter's effect, at the spot, as every spawn into the world does", () => {
    const arrivals = () =>
      fixture.game.level.gentities.filter(
        (e) => e.inuse && e.s.eType === ET.EVENTS + EV.PLAYER_TELEPORT_IN
      );
    // The first spawn's, from `ClientBegin`, at the spot's nine units of lift.
    expect(arrivals().map((e) => e.s.origin)).toEqual([vec3(0, 0, SPAWN_LIFT)]);

    fixture.game.clientRespawn(fixture.game.level.gentities[0]);
    expect(arrivals()).toHaveLength(2);
    expect(arrivals()[1].s.clientNum).toBe(0);

    // A spectator's spawn puts nobody into the world, so it has none.
    fixture.game.level.clients[0].sess.sessionTeam = TEAM.SPECTATOR;
    fixture.game.clientRespawn(fixture.game.level.gentities[0]);
    expect(arrivals()).toHaveLength(2);
  });
});

describe('the connection sprite', () => {
  /** On the player state and on the entity, in that order. */
  const sprite = (entity: GameEntity) => [
    entity.client!.ps.eFlags & EF_CONNECTION,
    entity.s.eFlags & EF_CONNECTION
  ];

  it('is up once the last command is over 100 ms behind the frames, until the next', () => {
    const fixture = makeGame();
    join(fixture, 0);
    const { game } = fixture;
    const entity = game.level.gentities[0];
    game.runFrame(1000);
    press(fixture, 0, 0);

    // The command ran at the last frame's time, so the next frame finds it on time and each after
    // that one frame later. 100 ms is not yet trouble.
    for (const time of [1050, 1100, 1150]) {
      game.runFrame(time);
      expect(sprite(entity)).toEqual([0, 0]);
    }
    game.runFrame(1200);
    expect(sprite(entity)).toEqual([EF_CONNECTION, EF_CONNECTION]);

    // The next command takes it off the player state at the frame's end, after the entity state
    // is built from it, so the entity keeps it a frame longer.
    press(fixture, 0, 0);
    game.runFrame(1250);
    expect(sprite(entity)).toEqual([0, EF_CONNECTION]);
    game.runFrame(1300);
    expect(sprite(entity)).toEqual([0, 0]);
  });

  it("stays down over a player's respawn, since the spawn runs a think on their command", () => {
    const fixture = makeGame();
    join(fixture, 0);
    const { game } = fixture;
    const entity = game.level.gentities[0];
    game.runFrame(1000);
    press(fixture, 0, 0);
    game.runFrame(1050);

    game.clientRespawn(entity);
    game.runFrame(1100);
    expect(sprite(entity)).toEqual([0, 0]);
  });

  it("is up on a respawned bot until its next think, which the spawn does not run", () => {
    const fixture = makeGame();
    joinBot(fixture, 0);
    const { game } = fixture;
    const entity = game.level.gentities[0];
    game.runFrame(1000);
    game.runFrame(1050);
    expect(sprite(entity)).toEqual([0, 0]);

    // A bot thinks when the frame comes round, which is not the spawn's think.
    game.clientRespawn(entity);
    expect(sprite(entity)).toEqual([EF_CONNECTION, EF_CONNECTION]);
    game.runFrame(1100);
    expect(sprite(entity)).toEqual([0, EF_CONNECTION]);
    game.runFrame(1150);
    expect(sprite(entity)).toEqual([0, 0]);
  });
});

describe('a player whose commands are late', () => {
  it('is recorded for a rewind where the slide put them, where a snapshot shows them', () => {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    const { game } = fixture;
    const entity = game.level.gentities[0];
    const client = game.level.clients[0];
    game.runFrame(1000);
    press(fixture, 0, 0);
    // Running down +x as the move leaves them, on the floor.
    client.ps.velocity = vec3(320, 0, 0);

    game.runFrame(1050);
    expect(client.history[client.historyHead].origin).toEqual(vec3(0, 0, 24));

    // A frame late: slid on 50 ms by the velocity, though the player state stays where it was.
    game.runFrame(1100);
    expect(entity.s.pos.trBase).toEqual(vec3(16, 0, 24));
    expect(client.history[client.historyHead].origin).toEqual(vec3(16, 0, 24));
    expect(client.ps.origin.x).toBe(0);
  });
});

describe("an award's sprite", () => {
  it('comes off at the first think once its two seconds are up', () => {
    const fixture = makeGame();
    join(fixture, 0);
    const client = fixture.game.level.clients[0];
    const time = fixture.game.level.time;
    awardSprite(client, EF_AWARD_EXCELLENT, time);

    fixture.game.level.time = time + REWARD_SPRITE_TIME;
    press(fixture, 0, 0);
    // "if ( level.time > client->rewardTime )": still up on its last millisecond.
    expect(client.ps.eFlags & EF_AWARDS).toBe(EF_AWARD_EXCELLENT);

    fixture.game.level.time = time + REWARD_SPRITE_TIME + 1;
    press(fixture, 0, 0);
    expect(client.ps.eFlags & EF_AWARDS).toBe(0);
  });
});

describe("the map's entities", () => {
  /** The spawn spots a game spawned, by origin. */
  const spots = (game: Game) => {
    const found: Vec3[] = [];
    for (let spot = game.level.find(null, 'classname', 'info_player_deathmatch'); spot; ) {
      found.push(spot.s.origin);
      spot = game.level.find(spot, 'classname', 'info_player_deathmatch');
    }
    return found;
  };

  it('spawns them at the map start, in order, after the body queue', () => {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(1, 2, 3)), spawnSpot(vec3(4, 5, 6))) });
    expect(spots(fixture.game)).toEqual([vec3(1, 2, 3), vec3(4, 5, 6)]);
    const { level } = fixture.game;
    const first = level.find(null, 'classname', 'info_player_deathmatch')!;
    expect(first.s.number).toBe(MAX_CLIENTS + level.bodyQue.length);
  });

  it("sends the map's name and music, the server's message of the day, and names the world", () => {
    const fixture = makeGame(
      {
        entities: entityText([
          { classname: 'worldspawn', message: 'The Garage', music: 'music/a.wav music/b.wav' },
          spawnSpot(vec3())
        ])
      },
      { g_motd: 'Frag responsibly' }
    );
    expect(fixture.traps.configstrings.get(CONFIGSTRING.MESSAGE)).toBe('The Garage');
    expect(fixture.traps.configstrings.get(CONFIGSTRING.MUSIC)).toBe('music/a.wav music/b.wav');
    expect(fixture.traps.configstrings.get(CONFIGSTRING.MOTD)).toBe('Frag responsibly');
    expect(fixture.game.level.gentities[ENTITYNUM_WORLD].classname).toBe('worldspawn');
    expect(fixture.game.level.gentities[ENTITYNUM_NONE].classname).toBe('nothing');
  });

  it('sends no message of the day unless the server has one, as g_motd starts empty', () => {
    expect(makeGame().traps.configstrings.get(CONFIGSTRING.MOTD)).toBe('');
  });

  it('sets the gravity from the map, and back to 800 on a map that says nothing', () => {
    const light = makeGame({
      entities: entityText([{ classname: 'worldspawn', gravity: '400' }, spawnSpot(vec3())])
    });
    expect(light.cvars.get('g_gravity')).toBe('400');

    // A gravity typed at the console lasts until the next map load, as it does in Quake 3.
    const fixture = makeGame({}, { g_gravity: '100' });
    expect(fixture.cvars.get('g_gravity')).toBe('800');
  });

  it("hands a pad's aim `g_gravity.value`, a C float, where the move reads its integer", () => {
    const fixture = makeGame({
      entities: entityText([{ classname: 'worldspawn', gravity: '800.7' }, spawnSpot(vec3())])
    });
    fixture.game.runFrame(100);
    expect(fixture.game.level.itemMatch.gravity()).toBe(800.7000122070312);
  });

  it("hands a map's spawn the gravity from before its world set its own, as a vmCvar", () => {
    const fixture = makeGame(
      { entities: entityText([{ classname: 'worldspawn', gravity: '400' }, spawnSpot(vec3())]) },
      { g_gravity: '100.5' }
    );
    expect(fixture.game.level.itemMatch.gravity()).toBe(100.5);
    // Each frame takes the cvar up again.
    fixture.game.runFrame(100);
    expect(fixture.game.level.itemMatch.gravity()).toBe(400);
  });

  it("stops the map start when the world is not first, with G_Error's words", () => {
    expect(() => makeGame({ entities: entityText([spawnSpot(vec3())]) })).toThrow(
      "SP_worldspawn: The first entity isn't 'worldspawn'"
    );
    expect(() => makeGame({ entities: '' })).toThrow('SpawnEntities: no entities');
  });

  it('says which entities it cannot spawn', () => {
    const fixture = makeGame({
      entities: mapOf(
        spawnSpot(vec3()),
        { classname: 'item_quad' },
        { classname: 'func_breakable' }
      )
    });
    // The bots are loaded after the map's entities, as `G_InitGame` loads them, and the item
    // registry is written out between the two.
    expect(fixture.traps.prints).toEqual([
      "func_breakable doesn't have a spawn function",
      '0 teams with 0 entities',
      '3 items registered',
      '0 bots parsed'
    ]);
  });

  it("publishes the map's items as CS_ITEMS, the loadout's two weapons always on it", () => {
    const fixture = makeGame({
      entities: mapOf(spawnSpot(vec3()), { classname: 'item_quad' })
    });

    const items = fixture.traps.configstrings.get(CONFIGSTRING.ITEMS) ?? '';
    expect(items).toHaveLength(NUM_ITEMS);
    expect(items[0]).toBe('0');
    expect(items[8]).toBe('1'); // the gauntlet, which every player holds
    expect(items[10]).toBe('1'); // and the machinegun
    expect(items[28]).toBe('1'); // the quad the map placed
    expect(items.split('1')).toHaveLength(4);
    expect(fixture.traps.prints).toContain('3 items registered');
  });

  it("stands the map's items up, two frames into the match", () => {
    const fixture = makeGame({
      entities: mapOf(spawnSpot(vec3()), { classname: 'weapon_railgun', origin: '64 0 128' })
    });
    // The world the item drops through, which the host would have given before the map loaded.
    fixture.traps.world = createFlatWorldTrace();

    fixture.game.runFrame(100);
    fixture.game.runFrame(200);

    const railgun = fixture.game.level.find(null, 'classname', 'weapon_railgun')!;
    expect(railgun.s.eType).toBe(ET.ITEM);
    expect(railgun.r.linked).toBe(true);
    expect(railgun.s.origin.z).toBeLessThan(128);
    expect(railgun.s.origin.z - 15).toBeLessThan(0.2);
    expect(railgun.s.origin.z).toBeGreaterThanOrEqual(15);
  });

  it('names only sounds the asset manifest brings, on a map without a BSP', async () => {
    // A splat map's match, whose only Quake 3 data may be a browser's cache of the manifest: all
    // a map without brushes can hold, every item and a jump pad, and a player in it.
    const fixture = makeGame({
      entities: mapOf(
        spawnSpot(vec3()),
        { classname: 'info_player_intermission', origin: '0 0 64' },
        ...ITEMS.slice(1).map(({ classname }, i) => ({ classname, origin: `${i * 64} 0 16` })),
        { classname: 'trigger_push', origin: '0 128 16', target: 'apex' },
        { classname: 'target_position', targetname: 'apex', origin: '0 256 256' }
      )
    });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    fixture.game.runFrame(100);
    fixture.game.runFrame(200);

    // Every file the manifest names, as an install that has them all gives them to the cache.
    const everything = {
      has: () => true,
      list: () => [],
      resolveImage: (reference: string) => reference,
      read: async () => undefined
    };
    const { files } = await resolveManifest(everything, () => [], () => []);
    const named = [...fixture.traps.configstrings]
      .filter(([index]) => index >= CONFIGSTRING.SOUNDS && index < CONFIGSTRING.SOUNDS + MAX_SOUNDS)
      .map(([, name]) => name)
      // A model's own sounds, which the manifest brings with each model it brings.
      .filter((name) => name !== '' && !name.startsWith('*'));
    // The match's own, the pad's and the powerups' arrival, so the map stood up as it should.
    const stood = [FRY_SOUND, 'sound/world/jumppad.wav', 'sound/items/poweruprespawn.wav'];
    expect(named).toEqual(expect.arrayContaining(stood));
    expect(named.filter((name) => !files.includes(name.toLowerCase()))).toEqual([]);
  });

  it('holds the map’s powerups out of the world for their first appearance', () => {
    const fixture = makeGame({
      entities: mapOf(spawnSpot(vec3()), { classname: 'item_quad', origin: '64 0 128' })
    });
    fixture.traps.world = createFlatWorldTrace();

    fixture.game.runFrame(100);
    fixture.game.runFrame(200);

    const quad = fixture.game.level.find(null, 'classname', 'item_quad')!;
    expect(quad.s.eType).toBe(ET.ITEM);
    expect(quad.r.linked).toBe(false);
    expect(quad.r.contents).toBe(0);
    expect(quad.s.eFlags & EF_NODRAW).toBe(EF_NODRAW);
    // "45 + crandom() * 15" from the frame it was finished on, at worst at 60 seconds.
    expect(quad.nextthink).toBeGreaterThanOrEqual(200 + 30_000);
    expect(quad.nextthink).toBeLessThanOrEqual(200 + 60_000);
  });

  it('stops at the first spawn on a map with no spawn spot at all', () => {
    const fixture = makeGame({ entities: mapOf({ classname: 'target_position', origin: '0 0 0' }) });
    fixture.traps.userinfos.set(0, '\\name\\Sarge');
    fixture.game.clientConnect(0, true, false);
    expect(() => fixture.game.clientBegin(0)).toThrow("Couldn't find a spawn point");
  });

  it('spawns at one of the furthest half of the spots, at random', () => {
    const map = mapOf(...[100, 200, 300, 400].map((x) => spawnSpot(vec3(x, 0, 0))));
    // A first spawn measures from the origin, so 400 and 300 are the furthest half.
    for (const [roll, x] of [
      [0, 400],
      [0.49, 400],
      [0.5, 300],
      [0.99, 300]
    ]) {
      const fixture = makeGame({ entities: map, random: () => roll });
      join(fixture, 0);
      expect(fixture.game.level.clients[0].ps.origin.x, `random ${roll}`).toBe(x);
    }
  });
});

describe('the match’s sounds', () => {
  it('names one once, hands the same slot back, and writes it where a client looks', () => {
    const { game, traps } = makeGame();
    const first = game.soundIndex('sound/items/poweruprespawn.wav');
    expect(first).toBeGreaterThan(0);
    expect(game.soundIndex('sound/items/poweruprespawn.wav')).toBe(first);
    expect(traps.configstrings.get(CONFIGSTRING.SOUNDS + first)).toBe(
      'sound/items/poweruprespawn.wav'
    );

    const second = game.soundIndex('sound/items/respawn1.wav');
    expect(second).not.toBe(first);
    expect(traps.configstrings.get(CONFIGSTRING.SOUNDS + second)).toBe('sound/items/respawn1.wav');
  });

  it('leaves an empty name at slot zero, which is no sound at all', () => {
    const { game } = makeGame();
    expect(game.soundIndex('')).toBe(0);
  });

  it('names the fry first, before anything the map names', () => {
    const { game, traps } = makeGame();
    expect(game.level.sndFry).toBe(1);
    expect(traps.configstrings.get(CONFIGSTRING.SOUNDS + 1)).toBe('sound/player/fry.wav');
  });
});

describe('choosing a spawn spot', () => {
  /** A client in the host's own process, whose first spawn is the map's marked one. */
  const LOCAL = '\\name\\Sarge\\ip\\localhost';
  /** Two plain spots, 100 and 400 along. */
  const TWO_SPOTS = mapOf(spawnSpot(vec3(100, 0, 0)), spawnSpot(vec3(400, 0, 0)));
  /** The same two, with the nearer marked initial. */
  const NEAR_MARKED = mapOf(
    spawnSpot(vec3(400, 0, 0)),
    { ...spawnSpot(vec3(100, 0, 0)), spawnflags: '1' }
  );
  const at = (fixture: Fixture, clientNum: number) =>
    fixture.game.level.clients[clientNum].ps.origin.x;
  const health = (fixture: Fixture, clientNum: number) =>
    fixture.game.level.clients[clientNum].ps.stats[STAT.HEALTH];

  it('passes over a spot somebody is standing on while there is a free one', () => {
    const fixture = makeGame({ entities: TWO_SPOTS });
    join(fixture, 0);
    expect(at(fixture, 0)).toBe(400);

    join(fixture, 1);
    expect(at(fixture, 1)).toBe(100);
    expect(health(fixture, 0)).toBeGreaterThan(0);
  });

  it('takes the first spot when all are taken, and telefrags whoever is on it, god or not', () => {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(100, 0, 0))) });
    join(fixture, 0);
    fixture.game.lives[0].god = true;

    join(fixture, 1);

    expect(at(fixture, 1)).toBe(100);
    expect(health(fixture, 1)).toBe(100 + SPAWN_HEALTH_BONUS);
    expect(health(fixture, 0)).toBeLessThanOrEqual(0);
    expect(fixture.game.level.clients[0].ps.pmType).toBe(PM_DEAD);
  });

  it('counts a player lying where they died as standing there, until they respawn', () => {
    const fixture = makeGame({ entities: TWO_SPOTS });
    join(fixture, 0);
    hurt(fixture.game, 0, 1000);

    join(fixture, 1);
    expect(at(fixture, 1)).toBe(100);
  });

  it('keeps a spot closed to bots from bots, and one closed to humans from humans', () => {
    const map = mapOf(
      { ...spawnSpot(vec3(400, 0, 0)), nohumans: '1' },
      { ...spawnSpot(vec3(100, 0, 0)), nobots: '1' }
    );
    const human = makeGame({ entities: map });
    join(human, 0);
    expect(at(human, 0)).toBe(100);

    const bot = makeGame({ entities: map });
    joinBot(bot, 0);
    expect(at(bot, 0)).toBe(400);
  });

  it("puts a local player's first spawn at the map's marked spot, and later ones anywhere", () => {
    const fixture = makeGame({ entities: NEAR_MARKED });
    join(fixture, 0, LOCAL);
    const client = fixture.game.level.clients[0];
    expect(at(fixture, 0)).toBe(100);
    expect(client.pers.initialSpawn).toBe(true);

    fixture.game.clientRespawn(fixture.game.level.gentities[0]);
    expect(at(fixture, 0)).toBe(400);
  });

  it('gives a client from elsewhere no marked spot, and never spends its first spawn', () => {
    const fixture = makeGame({ entities: NEAR_MARKED });
    join(fixture, 0);
    expect(at(fixture, 0)).toBe(400);
    expect(fixture.game.level.clients[0].pers.initialSpawn).toBe(false);
  });

  it('spawns a local player the ordinary way when somebody is on the marked spot', () => {
    const fixture = makeGame({
      entities: mapOf(
        { ...spawnSpot(vec3(400, 0, 0)), spawnflags: '1' },
        spawnSpot(vec3(100, 0, 0))
      )
    });
    join(fixture, 0);
    expect(at(fixture, 0)).toBe(400);

    join(fixture, 1, LOCAL);
    expect(at(fixture, 1)).toBe(100);
    expect(health(fixture, 0)).toBeGreaterThan(0);
  });

  it("fires the spot's targets, with the player as the one who set them off", () => {
    const fixture = makeGame({
      entities: mapOf(
        { ...spawnSpot(vec3(100, 0, 0)), target: 'gift' },
        { classname: 'target_position', targetname: 'gift', origin: '0 0 0' }
      )
    });
    const gift = fixture.game.level.find(null, 'targetname', 'gift')!;
    const used: string[] = [];
    gift.use = (self, other, activator) =>
      void used.push(`${self.targetname} ${other.classname} ${activator?.classname}`);

    join(fixture, 0);

    expect(used).toEqual(['gift info_player_deathmatch player']);
  });

  it('starts a spectator at the intermission point, out of the world, firing nothing', () => {
    const fixture = makeGame({
      entities: mapOf(
        { ...spawnSpot(vec3(100, 0, 0)), target: 'gift' },
        { classname: 'info_player_intermission', origin: '10 20 30', angles: '5 45 0' },
        { classname: 'target_position', targetname: 'gift', origin: '0 0 0' }
      )
    });
    let used = 0;
    fixture.game.level.find(null, 'targetname', 'gift')!.use = () => void used++;
    fixture.traps.userinfos.set(0, '\\name\\Sarge');
    fixture.game.clientConnect(0, true, false);
    fixture.game.level.clients[0].sess.sessionTeam = TEAM.SPECTATOR;

    fixture.game.clientBegin(0);

    const { ps } = fixture.game.level.clients[0];
    expect(ps.origin).toEqual(vec3(10, 20, 30));
    // The spawn's think replays the view angles through the 16-bit wire form (`PM_UpdateViewAngles`
    // under `pmove_fixed`), so the pitch stands as the short's own value; 45 is exact.
    expect(ps.viewangles.x).toBe(4.998779296875);
    expect(ps.viewangles.y).toBe(45);
    expect(fixture.traps.linked).not.toContain(0);
    expect(used).toBe(0);
  });
});

describe('a client leaving', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeGame();
    join(fixture, 0);
  });

  it('takes its body, its scoreboard row and its place in the counts', () => {
    fixture.game.clientDisconnect(0);

    expect(fixture.game.level.clients[0].pers.connected).toBe(CON.DISCONNECTED);
    expect(fixture.game.level.gentities[0].inuse).toBe(false);
    expect(fixture.game.level.gentities[0].classname).toBe('disconnected');
    expect(fixture.traps.configstrings.get(CONFIGSTRING.PLAYERS + 0)).toBe('');
    expect(fixture.game.level.numConnectedClients).toBe(0);
    expect(fixture.traps.unlinked).toContain(0);
  });

  it('does nothing at all the second time', () => {
    fixture.game.clientDisconnect(0);
    const unlinks = fixture.traps.unlinked.length;

    fixture.game.clientDisconnect(0);
    expect(fixture.traps.unlinked.length).toBe(unlinks);
  });

  it('lets anyone watching it off the view before the view goes', () => {
    join(fixture, 1);
    const watcher = fixture.game.level.clients[1];
    watcher.sess.sessionTeam = TEAM.SPECTATOR;
    watcher.sess.spectatorState = SPECTATOR.FOLLOW;
    watcher.sess.spectatorClient = 0;

    watcher.ps.pmFlags |= PMF_FOLLOW;
    watcher.ps.clientNum = 0;

    fixture.game.clientDisconnect(0);

    // `StopFollowing` (`g_client.c:1271–1278`): free again, and their own client number back.
    expect(watcher.sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(watcher.ps.pmFlags & PMF_FOLLOW).toBe(0);
    expect(watcher.ps.clientNum).toBe(1);
    // The slot they were watching is left where it was, which is where a cycle starts from.
    expect(watcher.sess.spectatorClient).toBe(0);
  });

  it('drops what the player carried, the same toss a death makes', () => {
    const client = fixture.game.level.clients[0];
    const entity = fixture.game.level.gentities[0];
    entity.s.weapon = WP.ROCKET_LAUNCHER;
    client.ps.stats[STAT.WEAPONS] |= 1 << WP.ROCKET_LAUNCHER;
    client.ps.ammo[WP.ROCKET_LAUNCHER] = 5;
    client.ps.powerups[PW.QUAD] = fixture.game.level.time + 30_000;

    fixture.game.clientDisconnect(0);

    const thrown = fixture.game.level.gentities.filter(
      (e) => e.inuse && (e.flags & FL.DROPPED_ITEM) !== 0
    );
    expect(thrown.map((e) => e.item?.classname)).toEqual([
      'weapon_rocketlauncher',
      'item_quad'
    ]);
  });

  it('goes as a teleporter sends a player, from where they stood', () => {
    const client = fixture.game.level.clients[0];
    client.ps.origin = vec3(100.5, -20.5, 40.25);

    fixture.game.clientDisconnect(0);

    const departures = fixture.game.level.gentities.filter(
      (e) => e.inuse && e.s.eType === ET.EVENTS + EV.PLAYER_TELEPORT_OUT
    );
    expect(departures).toHaveLength(1);
    expect(departures[0].s.origin).toEqual(vec3(100, -20, 40));
    expect(departures[0].s.clientNum).toBe(0);
  });

  it('drops nothing for a player who was only watching, or one already gone', () => {
    const client = fixture.game.level.clients[0];
    const entity = fixture.game.level.gentities[0];
    entity.s.weapon = WP.ROCKET_LAUNCHER;
    client.ps.ammo[WP.ROCKET_LAUNCHER] = 5;
    client.sess.sessionTeam = TEAM.SPECTATOR;

    fixture.game.clientDisconnect(0);
    expect(
      fixture.game.level.gentities.filter((e) => (e.flags & FL.DROPPED_ITEM) !== 0)
    ).toHaveLength(0);
    // Nor does a spectator leave by a teleporter's effect.
    expect(
      fixture.game.level.gentities.filter(
        (e) => e.inuse && e.s.eType === ET.EVENTS + EV.PLAYER_TELEPORT_OUT
      )
    ).toHaveLength(0);

    // And a second disconnect of the same slot has nothing left to toss either.
    const connected = makeGame();
    join(connected, 0);
    connected.game.level.gentities[0].s.weapon = WP.RAILGUN;
    connected.game.level.clients[0].ps.ammo[WP.RAILGUN] = 5;
    connected.game.clientDisconnect(0);
    const thrown = connected.game.level.gentities.filter(
      (e) => (e.flags & FL.DROPPED_ITEM) !== 0
    );
    expect(thrown).toHaveLength(1);

    connected.game.clientDisconnect(0);
    expect(
      connected.game.level.gentities.filter((e) => (e.flags & FL.DROPPED_ITEM) !== 0)
    ).toHaveLength(1);
  });

  it('gives a tournament win to whoever is left', () => {
    const duel = makeGame({ gametype: GT.TOURNAMENT });
    join(duel, 0);
    join(duel, 1, '\\name\\Grunt');
    duel.game.level.clients[0].ps.persistant[PERS.SCORE] = 5;
    duel.game.calculateRanks();

    duel.game.clientDisconnect(duel.game.level.sortedClients[1]);

    expect(duel.game.level.clients[0].sess.wins).toBe(1);
  });
});

describe('the ranks', () => {
  it('sort the players by score and put the spectators below them', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    join(fixture, 2, '\\name\\C');

    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 1;
    fixture.game.level.clients[1].ps.persistant[PERS.SCORE] = 9;
    fixture.game.level.clients[2].sess.sessionTeam = TEAM.SPECTATOR;
    fixture.game.calculateRanks();

    expect(fixture.game.level.sortedClients.slice(0, 3)).toEqual([1, 0, 2]);
    expect(fixture.game.level.numPlayingClients).toBe(2);
    expect(fixture.game.level.numConnectedClients).toBe(3);
  });

  it('mark both of a tie as tied', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 4;
    fixture.game.level.clients[1].ps.persistant[PERS.SCORE] = 4;

    fixture.game.calculateRanks();

    expect(fixture.game.level.clients[0].ps.persistant[PERS.RANK] & RANK_TIED_FLAG).toBeTruthy();
    expect(fixture.game.level.clients[1].ps.persistant[PERS.RANK] & RANK_TIED_FLAG).toBeTruthy();
  });

  it('publish the two leading scores, and say so when there are not two', () => {
    const fixture = makeGame();
    expect(fixture.traps.configstrings.get(CONFIGSTRING.SCORES1)).toBeUndefined();

    join(fixture, 0, '\\name\\A');
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 3;
    fixture.game.calculateRanks();

    expect(fixture.traps.configstrings.get(CONFIGSTRING.SCORES1)).toBe('3');
    expect(fixture.traps.configstrings.get(CONFIGSTRING.SCORES2)).toBe(String(SCORE_NOT_PRESENT));
  });

  it('do not let a bot vote', () => {
    const fixture = makeGame();
    fixture.traps.userinfos.set(0, '\\name\\Bot');
    fixture.game.clientConnect(0, true, true);
    fixture.game.clientBegin(0);

    expect(fixture.game.level.numPlayingClients).toBe(1);
    expect(fixture.game.level.numVotingClients).toBe(0);
  });
});

describe('the score', () => {
  /** The score plums in the world, as a client would find them in a snapshot. */
  function plums(fixture: Fixture): GameEntity[] {
    return fixture.game.level.gentities.filter(
      (entity) => entity.inuse && entity.s.eType === ET.EVENTS + EV.SCOREPLUM
    );
  }

  it('counts a kill for the killer and ranks the match again', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    // Arriving clients telefrag one another, which scores; the two start level for a clean read.
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 0;
    fixture.game.level.clients[1].ps.persistant[PERS.SCORE] = 0;
    fixture.game.calculateRanks();

    fixture.game.addScore(fixture.game.level.gentities[0], vec3(), 1);

    expect(fixture.game.level.clients[0].ps.persistant[PERS.SCORE]).toBe(1);
    // `AddScore` ends in `CalculateRanks`, which reorders the players by what they now have.
    expect(fixture.game.level.sortedClients[0]).toBe(0);
    expect(fixture.game.level.clients[0].ps.persistant[PERS.RANK]).toBe(0);
    expect(fixture.game.level.clients[1].ps.persistant[PERS.RANK]).toBe(1);
  });

  it('scores a telefrag for whoever arrives', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    const scores = [0, 1].map((i) => fixture.game.level.clients[i].ps.persistant[PERS.SCORE]);

    // Two clients on one spot: the arrival kills whoever was there (`G_KillBox`), and scores it.
    expect(scores.filter((s) => s > 0).length).toBe(1);
  });

  it('scores nothing during the warmup', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '20' });
    join(fixture, 0, '\\name\\A');
    fixture.game.runFrame(0);
    expect(fixture.game.level.warmupTime).not.toBe(0);
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 0;

    fixture.game.addScore(fixture.game.level.gentities[0], vec3(), 1);

    expect(fixture.game.level.clients[0].ps.persistant[PERS.SCORE]).toBe(0);
    expect(plums(fixture)).toEqual([]);
  });

  it('shows the scorer alone a plum where it happened, carrying the points', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    const before = plums(fixture).length;

    fixture.game.addScore(fixture.game.level.gentities[1], vec3(100, 50, 24), -1);

    const [plum] = plums(fixture).slice(before);
    expect(plum.s.pos.trBase).toEqual(vec3(100, 50, 24));
    expect(plum.r.svFlags & SVF.SINGLECLIENT).toBe(SVF.SINGLECLIENT);
    expect(plum.r.singleClient).toBe(1);
    expect(plum.s.otherEntityNum).toBe(1);
    expect(plum.s.time).toBe(-1);
  });

  it('scores nothing for an entity with no client', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 0;
    const world = fixture.game.level.gentities[ENTITYNUM_WORLD];

    fixture.game.addScore(world, vec3(), 5);

    expect(fixture.game.level.clients[0].ps.persistant[PERS.SCORE]).toBe(0);
  });

  it('adds to the team’s score in a team game, and to nobody’s otherwise', () => {
    const ffa = makeGame();
    join(ffa, 0, '\\name\\A');
    ffa.game.level.clients[0].sess.sessionTeam = TEAM.RED;
    ffa.game.level.clients[0].ps.persistant[PERS.TEAM] = TEAM.RED;
    ffa.game.addScore(ffa.game.level.gentities[0], vec3(), 3);
    expect(ffa.game.level.teamScores[TEAM.RED]).toBe(0);

    const tdm = makeGame({ gametype: GT.TEAM });
    join(tdm, 0, '\\name\\A');
    tdm.game.level.clients[0].sess.sessionTeam = TEAM.RED;
    tdm.game.level.clients[0].ps.persistant[PERS.TEAM] = TEAM.RED;
    tdm.game.addScore(tdm.game.level.gentities[0], vec3(), 3);
    expect(tdm.game.level.teamScores[TEAM.RED]).toBe(3);
  });
});

describe('the scores message', () => {
  /** The newest `scores` command sent to one client, split into its tokens. */
  function scoresTo(fixture: Fixture, clientNum: number): string[] | undefined {
    const command = fixture.traps.commands
      .filter((c) => c.to === clientNum && c.text.startsWith('scores '))
      .at(-1);
    return command?.text.trim().split(/\s+/);
  }

  it("sends Q3's fourteen numbers per client, in score order, then the damage given", () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 7;
    fixture.game.level.clients[1].ps.persistant[PERS.SCORE] = 3;
    fixture.game.level.clients[0].damageGiven = 640;
    fixture.game.level.clients[1].damageGiven = 12;
    fixture.game.calculateRanks();

    fixture.game.sendScoreboard(0);

    const argv = scoresTo(fixture, 0)!;
    // `scores <count> <red> <blue>` then, per client, fourteen numbers (`g_cmds.c:75–84`), and
    // the port's fifteenth.
    expect(argv.slice(0, 4)).toEqual(['scores', '2', '0', '0']);
    const numbers = argv.slice(4).map(Number);
    expect(numbers).toHaveLength(30);
    // The first entry is the leader: slot 0, score 7, then ping, minutes, flags, powerups,
    // accuracy, impressive, excellent, gauntlet, defend, assist, perfect, captures, damage.
    expect(numbers.slice(0, 15)).toEqual([0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 640]);
    expect(numbers[15]).toBe(1);
    expect(numbers[16]).toBe(3);
    // `perfect` is the first place alone: the runner-up has no deaths either and is not perfect.
    expect(numbers[15 + 12]).toBe(0);
    expect(numbers[15 + 14]).toBe(12);
  });

  it('is the same command whoever it is for, which a server status carries', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    fixture.game.level.clients[1].ps.persistant[PERS.SCORE] = 4;
    fixture.game.calculateRanks();

    fixture.game.sendScoreboard(0);
    fixture.game.sendScoreboard(1);

    const sent = fixture.traps.commands.filter((c) => c.text.startsWith('scores ')).slice(-2);
    expect(sent.map((c) => c.text)).toEqual([
      `${fixture.game.scoreboardMessage()}\n`,
      `${fixture.game.scoreboardMessage()}\n`
    ]);
    expect(fixture.game.scoreboardMessage()).toMatch(/^scores 2 0 0 1 4 /);
  });

  it('caps a ping at 999', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    fixture.game.level.clients[0].pers.realPing = 1200;
    fixture.game.calculateRanks();

    fixture.game.sendScoreboard(0);

    // `cl->ps.ping < 999 ? cl->ps.ping : 999` (`g_cmds.c:53–57`), with true ping for the
    // engine's, as Excessive Plus's board has it.
    expect(scoresTo(fixture, 0)![4 + 2]).toBe('999');
  });

  it('counts the minutes since each client entered', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    fixture.game.level.clients[0].pers.enterTime = 0;
    fixture.game.level.time = 125_000;
    fixture.game.calculateRanks();

    fixture.game.sendScoreboard(0);

    // `(level.time - enterTime) / 60000` (`g_cmds.c:76`), truncated: two minutes.
    expect(Number(scoresTo(fixture, 0)![4 + 3])).toBe(2);
  });

  it('says a connecting client’s ping is −1', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    fixture.traps.userinfos.set(1, '\\name\\B');
    fixture.game.clientConnect(1, true, false);
    fixture.game.calculateRanks();

    fixture.game.sendScoreboard(0);

    // The connecting client sorts last, so its entry is the second fifteen.
    const numbers = scoresTo(fixture, 0)!.slice(4).map(Number);
    expect(numbers.length).toBe(30);
    expect(numbers[15]).toBe(1);
    expect(numbers[17]).toBe(-1);
  });

  it('marks the first place with no deaths as perfect', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 5;
    fixture.game.calculateRanks();

    fixture.game.sendScoreboard(0);
    expect(scoresTo(fixture, 0)![4 + 12]).toBe('1');

    fixture.game.level.clients[0].ps.persistant[PERS.KILLED] = 1;
    fixture.game.calculateRanks();
    fixture.game.sendScoreboard(0);
    const last = fixture.traps.commands.filter((c) => c.text.startsWith('scores ')).at(-1)!.text;
    expect(last.trim().split(/\s+/)[4 + 12]).toBe('0');
  });

  it('divides the hits by the shots for the accuracy column', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    const client = fixture.game.level.clients[0];
    client.accuracyShots = 8;
    client.accuracyHits = 3;
    fixture.game.calculateRanks();

    fixture.game.sendScoreboard(0);

    // `accuracy_hits * 100 / accuracy_shots` (`g_cmds.c:67`), an integer division: 37.
    expect(Number(scoresTo(fixture, 0)![4 + 6])).toBe(37);
  });

  it('sends nothing to a bot', () => {
    const fixture = makeGame();
    joinBot(fixture, 0);

    fixture.game.sendScoreboard(0);

    expect(scoresTo(fixture, 0)).toBeUndefined();
  });

  it('stops at the 1000-byte buffer, and counts the entries that fit', () => {
    const fixture = makeGame({ maxclients: MAX_CLIENTS });
    const level = fixture.game.level;
    for (let i = 0; i < MAX_CLIENTS; i++) {
      level.clients[i].pers.connected = CON.CONNECTED;
      level.sortedClients[i] = i;
    }
    level.numConnectedClients = MAX_CLIENTS;

    fixture.game.sendScoreboard(0);

    // A full server is 64 entries of ~29 characters, which does not fit Q3's 1000-byte string
    // (`g_cmds.c:86–89`). The count is the entries written, not the clients there are.
    const argv = scoresTo(fixture, 0)!;
    const count = Number(argv[1]);
    expect(count).toBeLessThan(MAX_CLIENTS);
    expect(argv.slice(4)).toHaveLength(count * 15);
  });

  it('sends the dead their own board as they die', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    fixture.traps.commands.length = 0;

    hurt(fixture.game, 1, 1000);

    // `Cmd_Score_f( self )` (`g_combat.c:571`): the victim's board, with the death's −1 on it.
    const board = fixture.traps.commands.find(
      (command) => command.to === 1 && command.text.startsWith('scores ')
    );
    expect(board).toBeDefined();
    expect(fixture.game.level.clients[1].ps.persistant[PERS.KILLED]).toBe(1);
  });

  it('answers a client that asks for the board with its own scores command', () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    fixture.traps.commands.length = 0;

    fixture.game.clientCommand(0, ['score']);

    expect(fixture.traps.commands.filter((c) => c.to === 0 && c.text.startsWith('scores '))).toHaveLength(
      1
    );
  });

  it('answers nothing to a client that is still connecting', () => {
    const fixture = makeGame();
    fixture.traps.userinfos.set(0, '\\name\\A');
    fixture.game.clientConnect(0, true, false);
    fixture.traps.commands.length = 0;

    fixture.game.clientCommand(0, ['score']);

    expect(fixture.traps.commands.filter((c) => c.text.startsWith('scores '))).toHaveLength(0);
  });

  it("tells a client of a command it doesn't know, by the name it sent (g_cmds.c:1821)", () => {
    const fixture = makeGame();
    join(fixture, 0, '\\name\\A');
    fixture.traps.commands.length = 0;

    fixture.game.clientCommand(0, ['NoSuch', 'word']);
    fixture.game.clientCommand(0, ['score']);

    expect(fixture.traps.commands.filter((c) => c.text.startsWith('print '))).toEqual([
      { to: 0, text: 'print "unknown cmd NoSuch\n"' }
    ]);

    // At the intermission Quake 3 says it as chat instead, word for word (`:1776–1780`).
    fixture.traps.commands.length = 0;
    fixture.game.level.intermissiontime = 1000;
    fixture.game.clientCommand(0, ['NoSuch', 'word']);
    expect(fixture.traps.commands).toEqual([{ to: 0, text: 'chat "A^7\x19: ^2NoSuch word"' }]);
  });

  it('sends the board to everyone when the intermission begins', () => {
    const fixture = makeGame({}, { timelimit: '1' });
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    // Level scores, or the tie check vetoes the limit: arriving clients telefrag and score.
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 1;
    fixture.game.level.clients[1].ps.persistant[PERS.SCORE] = 0;
    fixture.game.calculateRanks();
    // The frame before the one the limit lands on, so only the end's own sends are counted.
    fixture.game.runFrame(60_000);
    fixture.traps.commands.length = 0;

    fixture.game.runFrame(61_000);

    // `SendScoreboardMessageToAllClients` at `BeginIntermission` (`g_main.c:1029`): the board the
    // match ended on, sent before anyone is moved to the camera.
    const boards = fixture.traps.commands.filter((c) => c.text.startsWith('scores '));
    expect(boards.map((c) => c.to).sort()).toEqual([0, 1]);
  });

  it('sends the board again when a rank moves during the intermission', () => {
    const fixture = atIntermission(2);
    fixture.traps.commands.length = 0;

    fixture.game.calculateRanks();

    // "Do this at BeginIntermission time and whenever ranks are recalculated" (`g_main.c:909–910`,
    // `:887–893`): the board is the only thing on screen, so a move is sent rather than waited for.
    const boards = fixture.traps.commands.filter((c) => c.text.startsWith('scores '));
    expect(boards.map((c) => c.to).sort()).toEqual([0, 1]);
  });
});

describe('the three lifetimes across a reconnect', () => {
  it('carry the session over and leave the persistent data behind', () => {
    const cvars = store();
    const first = makeGame({ cvars });
    join(first, 0, '\\name\\Sarge');
    first.game.level.clients[0].sess.wins = 3;
    first.game.level.clients[0].pers.enterTime = 5000;
    first.game.shutdown(false);

    // A new map: a new game module, a new level, and nothing but the cvars in between.
    const second = makeGame({ cvars });
    second.traps.userinfos.set(0, '\\name\\Sarge');
    second.game.clientConnect(0, false, false);

    const client = second.game.level.clients[0];
    expect(client.sess.wins).toBe(3);
    expect(client.pers.enterTime).toBe(0);
    expect(second.traps.prints).not.toContain('Gametype changed, clearing session data.');
  });

  it('throw the session away when the gametype changed under it', () => {
    const cvars = store({ g_gametype: String(GT.FFA) });
    const ffa = makeGame({ cvars });
    join(ffa, 0, '\\name\\Sarge');
    ffa.game.level.clients[0].sess.wins = 3;
    ffa.game.shutdown(false);

    // The gametype is a cvar, and a latched one, so the match that takes it up is the next.
    cvars.set('g_gametype', String(GT.TOURNAMENT));
    const duel = makeGame({ cvars });
    duel.traps.userinfos.set(0, '\\name\\Sarge');
    duel.game.clientConnect(0, false, false);

    expect(duel.game.level.newSession).toBe(true);
    expect(duel.game.level.clients[0].sess.wins).toBe(0);
    // And the module says so as it starts, as Q3's does (`g_session.c:180–181`).
    expect(duel.traps.prints).toContain('Gametype changed, clearing session data.');
  });
});

describe('a name on a scoreboard', () => {
  it('is left alone when there is nothing wrong with it', () => {
    expect(cleanName('Sarge')).toBe('Sarge');
  });

  it('is never nothing', () => {
    expect(cleanName('')).toBe('UnnamedPlayer');
    expect(cleanName('   ')).toBe('UnnamedPlayer');
  });

  it('loses a leading run of spaces, and caps one in the middle', () => {
    expect(cleanName('  Sarge')).toBe('Sarge');
    expect(cleanName('a      b')).toBe('a   b');
  });

  it('refuses black, which would hide a name against a dark background', () => {
    expect(cleanName('^0Sarge')).toBe('Sarge');
    expect(cleanName('^1Sarge')).toBe('^1Sarge');
  });

  it('is short enough to sit in a scoreboard row', () => {
    expect(cleanName('S'.repeat(80)).length).toBeLessThan(36);
  });
});

describe('the warmup', () => {
  it('is skipped entirely unless the map was told to hold one', () => {
    const fixture = makeGame();

    expect(fixture.game.level.warmupTime).toBe(0);
    expect(warmupString(fixture)).toBe('');
  });

  it('starts out waiting for players, and says so', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '20' });

    expect(fixture.game.level.warmupTime).toBe(-1);
    expect(warmupString(fixture)).toBe('-1');
  });

  it('is not held again after the restart it ends in, and spends the flag saying so', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '20', g_restarted: '1' });

    expect(fixture.game.level.warmupTime).toBe(0);
    expect(fixture.cvars.get('g_restarted')).toBe('0');
  });

  it('keeps waiting with one player in a free-for-all', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '20' });
    join(fixture, 0);

    fixture.game.runFrame(1000);

    expect(fixture.game.level.warmupTime).toBe(-1);
  });

  it('counts down from the second player, a second short of the full warmup', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '20' });
    join(fixture, 0);
    join(fixture, 1);

    fixture.game.runFrame(1000);

    // "fudge by -1 to account for extra delays": nineteen seconds, not twenty.
    expect(fixture.game.level.warmupTime).toBe(20_000);
    expect(warmupString(fixture)).toBe('20000');
  });

  it('goes back to waiting when a player leaves mid-countdown', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '20' });
    join(fixture, 0);
    join(fixture, 1);
    fixture.game.runFrame(1000);
    expect(fixture.game.level.warmupTime).toBe(20_000);

    fixture.game.clientDisconnect(1);
    fixture.game.runFrame(2000);

    expect(fixture.game.level.warmupTime).toBe(-1);
    expect(warmupString(fixture)).toBe('-1');
  });

  it('begins play outright when the warmup is a second or less', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '1' });
    join(fixture, 0);
    join(fixture, 1);

    fixture.game.runFrame(1000);

    expect(fixture.game.level.warmupTime).toBe(0);
    expect(fixture.traps.consoleCommands).toEqual([]);
    expect(fixture.cvars.get('g_restarted')).toBe('0');
  });

  it('ends in a restart, and asks for only one of them', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '2' });
    join(fixture, 0);
    join(fixture, 1);

    fixture.game.runFrame(1000);
    expect(fixture.game.level.warmupTime).toBe(2000);

    fixture.game.runFrame(2000);
    expect(fixture.traps.consoleCommands).toEqual([]);

    fixture.game.runFrame(2008);
    expect(fixture.cvars.get('g_restarted')).toBe('1');
    expect(fixture.traps.consoleCommands).toEqual(['map_restart 0\n']);
    expect(fixture.game.level.restarted).toBe(true);
    // Ten seconds added, so nothing asks for a second restart while the first is on its way.
    expect(fixture.game.level.warmupTime).toBe(12_000);

    fixture.game.runFrame(3000);
    expect(fixture.traps.consoleCommands).toHaveLength(1);
  });

  it('starts over when g_warmup is changed while it is counting', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '20' });
    join(fixture, 0);
    join(fixture, 1);
    fixture.game.runFrame(1000);
    expect(fixture.game.level.warmupTime).toBe(20_000);

    fixture.cvars.set('g_warmup', '5');
    fixture.game.runFrame(2000);

    expect(fixture.game.level.warmupTime).toBe(6000);
    expect(warmupString(fixture)).toBe('6000');
  });

  it('is not returned to by a free-for-all that has begun', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '1' });
    join(fixture, 0);
    join(fixture, 1);
    fixture.game.runFrame(1000);
    expect(fixture.game.level.warmupTime).toBe(0);

    fixture.game.clientDisconnect(1);
    fixture.game.runFrame(2000);

    expect(fixture.game.level.warmupTime).toBe(0);
  });

  it('is returned to by a tournament that loses a player, whatever g_doWarmup says', () => {
    const fixture = makeGame({ gametype: GT.TOURNAMENT }, { g_warmup: '20' });
    join(fixture, 0);
    join(fixture, 1);
    fixture.game.runFrame(1000);
    expect(fixture.game.level.warmupTime).toBe(0);

    fixture.game.clientDisconnect(1);
    fixture.game.runFrame(2000);
    expect(fixture.game.level.warmupTime).toBe(-1);
    expect(warmupString(fixture)).toBe('-1');

    // And counts down again on its own, though nothing ever asked for a warmup.
    join(fixture, 2);
    fixture.game.runFrame(3000);
    expect(fixture.game.level.warmupTime).toBe(22_000);
  });

  it('waits for one player on each side in a team game, not two anywhere', () => {
    const fixture = makeGame({ gametype: GT.TEAM }, { g_doWarmup: '1', g_warmup: '20' });
    join(fixture, 0);
    join(fixture, 1);
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.RED);

    fixture.game.runFrame(1000);
    expect(fixture.game.level.warmupTime).toBe(-1);

    putOnTeam(fixture, 1, TEAM.BLUE);
    fixture.game.runFrame(2000);

    expect(fixture.game.level.warmupTime).toBe(21_000);
  });

  it('is never counted down in a Single Player match', () => {
    const fixture = makeGame({ gametype: GT.SINGLE_PLAYER }, { g_doWarmup: '1', g_warmup: '20' });
    join(fixture, 0);
    join(fixture, 1);

    fixture.game.runFrame(1000);

    expect(fixture.game.level.warmupTime).toBe(-1);
  });

  it('is left alone entirely while nobody is playing, because a restart runs empty frames', () => {
    const fixture = makeGame({ gametype: GT.TOURNAMENT });
    expect(fixture.game.level.warmupTime).toBe(0);

    fixture.game.runFrame(1000);

    // A tournament with fewer than two players goes back to waiting — but not this one, which has
    // nobody in it because the clients have not been reconnected yet.
    expect(fixture.game.level.warmupTime).toBe(0);
  });

  it('holds the time limit back while it runs', () => {
    const fixture = makeGame({}, { g_doWarmup: '1', g_warmup: '20', timelimit: '1' });
    join(fixture, 0);
    join(fixture, 1);
    // A score nobody could really have got during a warmup, so that it is the warmup holding the
    // limit back and not the tie that two players on nothing would be.
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 1;

    fixture.game.runFrame(70_000);

    expect(fixture.game.level.warmupTime).toBe(89_000);
    expect(fixture.game.level.intermissionQueued).toBe(0);
  });
});

describe('the exit rules', () => {
  it('end a match on the time limit', () => {
    const fixture = makeGame({}, { timelimit: '1' });
    join(fixture, 0);

    fixture.game.runFrame(59_000);
    expect(fixture.game.level.intermissionQueued).toBe(0);

    fixture.game.runFrame(60_000);
    expect(fixture.game.level.intermissionQueued).toBe(60_000);
    expect(fixture.traps.configstrings.get(CONFIGSTRING.INTERMISSION)).toBe('1');
    expect(prints(fixture)).toContain('print "Timelimit hit.\n"');
  });

  it('let no limit end a tied match, and end it on the frag that breaks the tie', () => {
    const fixture = makeGame({}, { timelimit: '1' });
    join(fixture, 0);
    join(fixture, 1);
    // Arriving clients telefrag one another and that scores; both start level for the tie.
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 0;
    fixture.game.level.clients[1].ps.persistant[PERS.SCORE] = 0;
    fixture.game.calculateRanks();

    fixture.game.runFrame(60_000);
    expect(fixture.game.level.intermissionQueued).toBe(0);

    // Sudden death is only this: past the limit, the first score that is not level ends it.
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 1;
    fixture.game.calculateRanks();

    expect(fixture.game.level.intermissionQueued).toBe(60_000);
  });

  it('end a match with one player in it, because one player cannot tie', () => {
    const fixture = makeGame({}, { timelimit: '1' });
    join(fixture, 0);

    fixture.game.runFrame(60_000);

    expect(fixture.game.level.intermissionQueued).toBe(60_000);
  });

  it('name the player who hit the frag limit', () => {
    const fixture = makeGame({}, { fraglimit: '5' });
    join(fixture, 0, '\\name\\Sarge');
    join(fixture, 1, '\\name\\Grunt');
    fixture.game.runFrame(1000);

    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 5;
    fixture.game.calculateRanks();

    expect(fixture.game.level.intermissionQueued).toBe(1000);
    expect(prints(fixture)).toContain('print "Sarge^7 hit the fraglimit.\n"');
  });

  it('tell the clients the match is over before the print, for the frag limit alone', () => {
    const limit = makeGame({}, { fraglimit: '5' });
    join(limit, 0, '\\name\\Sarge');
    join(limit, 1, '\\name\\Grunt');
    limit.game.runFrame(1000);
    limit.game.level.clients[0].ps.persistant[PERS.SCORE] = 5;
    limit.game.calculateRanks();

    const ending = (fixture: Fixture): string[] =>
      fixture.traps.events.filter(
        (event) => event === `cs ${CONFIGSTRING.INTERMISSION}` || event.includes(' hit')
      );

    expect(ending(limit)).toEqual([
      `cs ${CONFIGSTRING.INTERMISSION}`,
      'print "Sarge^7 hit the fraglimit.\n"'
    ]);

    // Every other rule prints first and ends the match after, which is Quake 3's order and not a
    // tidier one.
    const time = makeGame({}, { timelimit: '1' });
    join(time, 0);
    time.game.runFrame(60_000);

    expect(ending(time)).toEqual([
      'print "Timelimit hit.\n"',
      `cs ${CONFIGSTRING.INTERMISSION}`
    ]);
  });

  it('end a team match on a team reaching the frag limit', () => {
    const fixture = makeGame({ gametype: GT.TEAM }, { fraglimit: '5' });
    join(fixture, 0);
    join(fixture, 1);
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.BLUE);
    fixture.game.runFrame(1000);

    fixture.game.level.teamScores[TEAM.RED] = 5;
    fixture.game.calculateRanks();

    expect(fixture.game.level.intermissionQueued).toBe(1000);
    expect(prints(fixture)).toContain('print "Red hit the fraglimit.\n"');
  });

  it('swap the frag limit for the capture limit at capture the flag', () => {
    const fixture = makeGame({ gametype: GT.CTF }, { fraglimit: '1', capturelimit: '3' });
    join(fixture, 0);
    join(fixture, 1);
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.BLUE);
    fixture.game.runFrame(1000);

    fixture.game.level.teamScores[TEAM.RED] = 2;
    fixture.game.calculateRanks();
    expect(fixture.game.level.intermissionQueued).toBe(0);

    fixture.game.level.teamScores[TEAM.RED] = 3;
    fixture.game.calculateRanks();

    expect(fixture.game.level.intermissionQueued).toBe(1000);
    expect(prints(fixture)).toContain('print "Red hit the capturelimit.\n"');
  });

  it('ignore the capture limit below capture the flag', () => {
    const fixture = makeGame({ gametype: GT.TEAM }, { capturelimit: '1' });
    join(fixture, 0);
    join(fixture, 1);
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.BLUE);
    fixture.game.runFrame(1000);

    fixture.game.level.teamScores[TEAM.RED] = 5;
    fixture.game.calculateRanks();

    expect(fixture.game.level.intermissionQueued).toBe(0);
  });

  it('correct a negative limit rather than obey it', () => {
    const fixture = makeGame({}, { timelimit: '-1', fraglimit: '-5', capturelimit: '-2' });
    join(fixture, 0);

    fixture.game.runFrame(1000);

    expect(fixture.cvars.get('timelimit')).toBe('0');
    expect(fixture.cvars.get('fraglimit')).toBe('0');
    expect(fixture.cvars.get('capturelimit')).toBe('0');
    expect(fixture.game.level.intermissionQueued).toBe(0);
  });

  it('wait a second between qualifying for the intermission and going to it', () => {
    const fixture = makeGame({}, { timelimit: '1' });
    join(fixture, 0);

    fixture.game.runFrame(60_000);
    expect(fixture.game.level.intermissiontime).toBe(0);

    fixture.game.runFrame(60_800);
    expect(fixture.game.level.intermissiontime).toBe(0);

    fixture.game.runFrame(61_000);
    expect(fixture.game.level.intermissionQueued).toBe(0);
    expect(fixture.game.level.intermissiontime).toBe(61_000);
  });

  it('end nothing once the match has already ended', () => {
    const fixture = makeGame({}, { timelimit: '1' });
    join(fixture, 0);
    fixture.game.runFrame(60_000);
    fixture.game.runFrame(61_000);
    const said = fixture.traps.commands.length;

    fixture.game.runFrame(120_000);

    expect(fixture.game.level.intermissiontime).toBe(61_000);
    expect(fixture.game.level.intermissionQueued).toBe(0);
    expect(fixture.traps.commands).toHaveLength(said);
  });
});

describe('the intermission', () => {
  it('takes every client out of the world and stands it at the camera', () => {
    const fixture = atIntermission(2);

    for (const clientNum of [0, 1]) {
      const entity = fixture.game.level.gentities[clientNum];
      const client = fixture.game.level.clients[clientNum];
      expect(client.ps.pmType).toBe(PM_INTERMISSION);
      expect(client.ps.origin).toEqual(fixture.game.level.intermissionOrigin);
      expect(client.ps.viewangles).toEqual(fixture.game.level.intermissionAngle);
      // Nothing left to see, to hear or to hit.
      expect(entity.s.modelindex).toBe(0);
      expect(entity.s.loopSound).toBe(0);
      expect(entity.r.contents).toBe(0);
      expect(entity.s.eType).toBe(ET.GENERAL);
    }
  });

  it('respawns whoever was dead, so a body watches rather than a corpse', () => {
    const fixture = makeGame({}, { timelimit: '1' });
    join(fixture, 0);
    const client = fixture.game.level.clients[0];
    const spawns = client.ps.persistant[PERS.SPAWN_COUNT];
    client.ps.stats[STAT.HEALTH] = 0;

    fixture.game.runFrame(60_000);
    fixture.game.runFrame(61_000);

    expect(client.ps.persistant[PERS.SPAWN_COUNT]).toBe(spawns + 1);
    expect(client.ps.stats[STAT.HEALTH]).toBeGreaterThan(0);
    expect(client.ps.pmType).toBe(PM_INTERMISSION);
    // The respawn is `ClientRespawn`'s, which leaves the body behind.
    expect(corpses(fixture.game)).toHaveLength(1);
  });

  it('clears the powerups, so a match won under quad does not glow at the camera', () => {
    const fixture = makeGame({}, { timelimit: '1' });
    join(fixture, 0);
    fixture.game.level.clients[0].ps.powerups[2] = 90_000;

    fixture.game.runFrame(60_000);
    fixture.game.runFrame(61_000);

    expect(fixture.game.level.clients[0].ps.powerups.every((time) => time === 0)).toBe(true);
  });

  it('starts once, whatever asks for it afterwards', () => {
    const fixture = atIntermission();

    fixture.game.level.time = 90_000;
    fixture.game.beginIntermission();

    expect(fixture.game.level.intermissiontime).toBe(61_000);
  });

  it('records a tournament\’s win and loss from the order of the scoreboard', () => {
    const fixture = makeGame({ gametype: GT.TOURNAMENT }, { timelimit: '1' });
    join(fixture, 0);
    join(fixture, 1);
    fixture.game.level.clients[1].ps.persistant[PERS.SCORE] = 5;
    fixture.game.calculateRanks();

    fixture.game.beginIntermission();

    expect(fixture.game.level.clients[1].sess.wins).toBe(1);
    expect(fixture.game.level.clients[0].sess.losses).toBe(1);
  });

  it('lets a spectator off the view it was riding before that view stops existing', () => {
    const fixture = makeGame({}, { timelimit: '1' });
    join(fixture, 0);
    join(fixture, 1);
    const follower = fixture.game.level.clients[1];
    follower.sess.sessionTeam = TEAM.SPECTATOR;
    follower.sess.spectatorState = SPECTATOR.FOLLOW;
    follower.sess.spectatorClient = 0;
    follower.ps.pmFlags |= PMF_FOLLOW;
    follower.ps.clientNum = 0;

    fixture.game.beginIntermission();

    expect(follower.sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(follower.ps.pmFlags & PMF_FOLLOW).toBe(0);
    // Its own slot again, rather than the one whose state it was being shown.
    expect(follower.ps.clientNum).toBe(1);
    expect(follower.sess.sessionTeam).toBe(TEAM.SPECTATOR);
  });

  it('gives a follower that got off a dead view enough life to own one of its own', () => {
    const fixture = makeGame();
    join(fixture, 0);
    const client = fixture.game.level.clients[0];
    client.sess.spectatorState = SPECTATOR.FOLLOW;
    client.ps.stats[STAT.HEALTH] = 0;

    fixture.game.stopFollowing(fixture.game.level.gentities[0]);

    expect(client.ps.stats[STAT.HEALTH]).toBe(1);
  });

  it("sits at the map's intermission point, facing what it targets", () => {
    const fixture = makeGame({
      entities: mapOf(
        spawnSpot(vec3()),
        {
          classname: 'info_player_intermission',
          origin: '100 0 50',
          angles: '0 180 0',
          target: 'view'
        },
        { classname: 'target_position', targetname: 'view', origin: '200 100 50' }
      )
    });

    fixture.game.findIntermissionPoint();

    const { intermissionOrigin, intermissionAngle } = fixture.game.level;
    expect(intermissionOrigin).toEqual(vec3(100, 0, 50));
    expect(intermissionAngle.x).toBeCloseTo(0, 4);
    expect(intermissionAngle.y).toBeCloseTo(45, 4);
  });

  it('turns the way its own angles say when it targets nothing it can find, and says so', () => {
    const fixture = makeGame({
      entities: mapOf(
        spawnSpot(vec3()),
        {
          classname: 'info_player_intermission',
          origin: '1 2 3',
          angles: '10 20 0',
          target: 'gone'
        }
      )
    });

    fixture.game.findIntermissionPoint();

    expect(fixture.game.level.intermissionOrigin).toEqual(vec3(1, 2, 3));
    expect(fixture.game.level.intermissionAngle).toEqual(vec3(10, 20, 0));
    expect(fixture.traps.prints).toEqual([
      '0 teams with 0 entities',
      '2 items registered',
      '0 bots parsed',
      'G_PickTarget: target gone not found'
    ]);
  });

  it('falls back to a spawn spot, lifted, on a map that has no intermission point', () => {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(100, 0, 0), 90)) });

    fixture.game.findIntermissionPoint();

    expect(fixture.game.level.intermissionOrigin).toEqual(vec3(100, 0, SPAWN_LIFT));
    expect(fixture.game.level.intermissionAngle).toEqual(vec3(0, 90, 0));
  });

  it('sends a client that spawns during it to the camera instead of into the world', () => {
    const fixture = atIntermission();
    fixture.traps.linked.length = 0;

    join(fixture, 1);

    expect(fixture.game.level.clients[1].ps.pmType).toBe(PM_INTERMISSION);
    expect(fixture.traps.linked).not.toContain(1);
  });

  it('answers a client that asks for the board, and no other command', () => {
    const fixture = atIntermission();
    const client = fixture.game.level.clients[0];
    const health = client.ps.stats[STAT.HEALTH];
    fixture.traps.commands.length = 0;

    fixture.game.clientCommand(0, ['kill']);
    fixture.game.clientCommand(0, ['team', 'spectator']);
    fixture.game.clientCommand(0, ['score']);

    expect(client.ps.stats[STAT.HEALTH]).toBe(health);
    expect(client.sess.sessionTeam).toBe(TEAM.FREE);
    expect(prints(fixture).filter((text) => text.startsWith('scores '))).toHaveLength(1);
  });
});

describe('leaving the intermission', () => {
  it('never happens inside five seconds, however fast the ready', () => {
    const fixture = atIntermission();
    press(fixture, 0, BUTTON_ATTACK);

    fixture.game.runFrame(65_900);
    expect(fixture.game.level.intermissiontime).toBe(61_000);

    fixture.game.runFrame(66_100);
    expect(fixture.game.level.intermissiontime).toBe(0);
  });

  it('happens at once when every human is ready', () => {
    const fixture = atIntermission(2);
    fixture.game.runFrame(70_000);
    expect(fixture.game.level.intermissiontime).toBe(61_000);

    press(fixture, 0, BUTTON_ATTACK);
    fixture.game.runFrame(70_008);
    expect(fixture.game.level.intermissiontime).toBe(61_000);

    press(fixture, 1, BUTTON_USE_HOLDABLE);
    fixture.game.runFrame(70_016);
    expect(fixture.game.level.intermissiontime).toBe(0);
  });

  it('gives the first ready a ten second timer when somebody else is not', () => {
    const fixture = atIntermission(2);
    press(fixture, 0, BUTTON_ATTACK);

    fixture.game.runFrame(70_000);
    expect(fixture.game.level.readyToExit).toBe(true);
    expect(fixture.game.level.exitTime).toBe(70_000);

    fixture.game.runFrame(79_900);
    expect(fixture.game.level.intermissiontime).toBe(61_000);

    fixture.game.runFrame(80_100);
    expect(fixture.game.level.intermissiontime).toBe(0);
  });

  it('forgets a timer that is running once nobody wants to go', () => {
    const fixture = atIntermission(2);
    press(fixture, 0, BUTTON_ATTACK);
    fixture.game.runFrame(70_000);
    expect(fixture.game.level.readyToExit).toBe(true);

    // The one client that was ready leaves, which takes its ready with it.
    fixture.game.clientDisconnect(0);
    fixture.game.runFrame(70_008);

    expect(fixture.game.level.readyToExit).toBe(false);
    expect(fixture.game.level.intermissiontime).toBe(61_000);
  });

  it('counts no bot, so one human alone among them is everybody', () => {
    const fixture = atIntermission();
    joinBot(fixture, 1);
    joinBot(fixture, 2);
    press(fixture, 0, BUTTON_ATTACK);

    fixture.game.runFrame(70_000);

    expect(fixture.game.level.intermissiontime).toBe(0);
  });

  it('leaves a match with nobody human in it fifteen seconds in', () => {
    const fixture = makeGame({}, { timelimit: '1' });
    joinBot(fixture, 0);
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 1;
    fixture.game.calculateRanks();
    fixture.game.runFrame(60_000);
    fixture.game.runFrame(61_000);
    expect(fixture.game.level.intermissiontime).toBe(61_000);

    // Nobody is asked, so nothing starts the ten second timer until the five second floor does.
    fixture.game.runFrame(65_900);
    expect(fixture.game.level.readyToExit).toBe(false);

    fixture.game.runFrame(66_100);
    expect(fixture.game.level.readyToExit).toBe(true);
    expect(fixture.game.level.exitTime).toBe(66_100);
    expect(fixture.game.level.intermissiontime).toBe(61_000);

    fixture.game.runFrame(76_000);
    expect(fixture.game.level.intermissiontime).toBe(61_000);

    fixture.game.runFrame(76_200);
    expect(fixture.game.level.intermissiontime).toBe(0);
  });

  it('tells every client which of them are ready', () => {
    const fixture = atIntermission(2);
    press(fixture, 1, BUTTON_ATTACK);

    fixture.game.runFrame(62_000);

    for (const clientNum of [0, 1]) {
      expect(fixture.game.level.clients[clientNum].ps.stats[STAT.CLIENTS_READY]).toBe(1 << 1);
    }
  });

  it('reads a fresh press only, so a key held through the last frag is not a ready', () => {
    const fixture = atIntermission();
    const client = fixture.game.level.clients[0];
    client.buttons = BUTTON_ATTACK;

    press(fixture, 0, BUTTON_ATTACK);
    expect(client.readyToExit).toBe(false);

    press(fixture, 0, 0);
    press(fixture, 0, BUTTON_ATTACK);
    expect(client.readyToExit).toBe(true);
  });

  it('keeps a ready once it has been said', () => {
    const fixture = atIntermission();
    press(fixture, 0, BUTTON_ATTACK);
    expect(fixture.game.level.clients[0].readyToExit).toBe(true);

    press(fixture, 0, 0);

    expect(fixture.game.level.clients[0].readyToExit).toBe(true);
  });

  it('never happens this way in a Single Player match', () => {
    const fixture = atIntermission(1, { gametype: GT.SINGLE_PLAYER });
    press(fixture, 0, BUTTON_ATTACK);

    fixture.game.runFrame(120_000);

    expect(fixture.game.level.intermissiontime).toBe(61_000);
  });
});

describe('the level exit', () => {
  it('asks the host for nextmap, which by default is this map again', () => {
    const fixture = atIntermission();

    fixture.game.exitLevel();

    expect(fixture.traps.consoleCommands).toEqual(['vstr nextmap\n']);
    expect(fixture.game.level.intermissiontime).toBe(0);
  });

  it('takes the rotation hook instead when one is set behind the default', () => {
    const fixture = atIntermission();
    fixture.cvars.set('nextmap', 'map_restart 0');
    fixture.cvars.set('d1', 'map q3dm1');

    fixture.game.exitLevel();

    expect(fixture.traps.consoleCommands).toEqual(['vstr d1\n']);
    // The next one is queued behind it, so the rotation goes on rather than stopping here.
    expect(fixture.cvars.get('nextmap')).toBe('vstr d2');
  });

  it('zeroes the scores, so the match that comes back is not already over', () => {
    const fixture = atIntermission(2);
    fixture.game.level.teamScores[TEAM.RED] = 3;
    fixture.game.level.clients[1].ps.persistant[PERS.SCORE] = 9;

    fixture.game.exitLevel();

    expect(fixture.game.level.teamScores[TEAM.RED]).toBe(0);
    expect(fixture.game.level.clients[0].ps.persistant[PERS.SCORE]).toBe(0);
    expect(fixture.game.level.clients[1].ps.persistant[PERS.SCORE]).toBe(0);
  });

  it('writes the sessions out before it marks anyone as reconnecting', () => {
    const fixture = atIntermission();
    fixture.game.level.clients[0].sess.wins = 4;

    fixture.game.exitLevel();

    expect(fixture.cvars.get('session0').split(' ')[4]).toBe('4');
    expect(fixture.game.level.clients[0].pers.connected).toBe(CON.CONNECTING);
  });

  it('restarts a tournament in place rather than changing map, and asks once', () => {
    const fixture = atIntermission(2, { gametype: GT.TOURNAMENT });

    fixture.game.exitLevel();
    expect(fixture.traps.consoleCommands).toEqual(['map_restart 0\n']);
    expect(fixture.game.level.restarted).toBe(true);
    expect(fixture.game.level.intermissiontime).toBe(0);

    fixture.game.exitLevel();
    expect(fixture.traps.consoleCommands).toHaveLength(1);
  });
});

describe('a team', () => {
  it('is counted by who is on it, including whoever is still connecting', () => {
    const fixture = makeGame({ gametype: GT.TEAM });
    join(fixture, 0);
    join(fixture, 1);
    fixture.traps.userinfos.set(2, '\\name\\Bitterman');
    fixture.game.clientConnect(2, true, false);
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.RED);
    fixture.game.level.clients[2].sess.sessionTeam = TEAM.RED;

    expect(fixture.game.teamCount(TEAM.RED)).toBe(3);
    expect(fixture.game.teamCount(TEAM.BLUE)).toBe(0);
  });

  it('can be counted without the client that is about to leave it', () => {
    const fixture = makeGame({ gametype: GT.TEAM });
    join(fixture, 0);
    join(fixture, 1);
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.RED);

    expect(fixture.game.teamCount(TEAM.RED, 1)).toBe(1);
  });
});

describe('a spectator', () => {
  /**
   * A match with a player in slot 0 and a spectator in slot 1, with a way to hand the spectator
   * commands. Every team change is made by hand, so these tests stand apart from `SetTeam`.
   *
   * @param state - The spectator state slot 1 is put in.
   * @param watching - Who slot 1 is watching, for a follower.
   */
  function spectating(state: number = SPECTATOR.FREE, watching = 0) {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');

    const client = fixture.game.level.clients[1];
    client.sess.sessionTeam = TEAM.SPECTATOR;
    client.sess.spectatorState = state;
    client.sess.spectatorClient = watching;
    fixture.game.clientBegin(1);
    fixture.game.calculateRanks();

    /** Hand the spectator one command, without running the frame that ends it. */
    const think = (input: Partial<NetUserCmd> = {}): void => {
      const cmd = createNetUserCmd();
      Object.assign(cmd, input, { serverTime: fixture.game.level.time + PMOVE_MSEC });
      fixture.traps.cmds.set(1, cmd);
      fixture.game.clientThink(1);
    };

    /** Run ticks of 8 ms with the given command held by the spectator. */
    const run = (ticks: number, input: Partial<NetUserCmd> = {}): void => {
      for (let i = 0; i < ticks; i++) {
        const time = fixture.game.level.time + PMOVE_MSEC;
        think({ ...input });
        fixture.game.runFrame(time);
      }
    };

    return { ...fixture, client, think, run };
  }

  it('flies free at its own speed', () => {
    const { client, run } = spectating();

    // The climb takes longer to reach its ceiling than a flying player's, because the spectator's
    // friction is pulling the harder of the two against it.
    run(60, { upmove: 127 });

    expect(client.ps.pmType).toBe(PM_SPECTATOR);
    expect(client.ps.speed).toBe(SPECTATOR_SPEED);
    expect(client.ps.velocity.z).toBe(SPECTATOR_SPEED);
  });

  it('takes itself out of the world every command, so nothing can find it there', () => {
    const { game, traps, run } = spectating();
    // A client who was playing a moment ago is still linked where they stood.
    traps.linkEntity(game.level.gentities[1]);

    run(1);

    expect(game.level.gentities[1].r.linked).toBe(false);
  });

  it('moves through the players, since its own move is traced without their bodies', () => {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    const world = recordingTrace(createFlatWorldTrace());
    fixture.traps.world = world.trace;
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    const client = fixture.game.level.clients[1];
    client.sess.sessionTeam = TEAM.SPECTATOR;
    client.sess.spectatorState = SPECTATOR.FREE;
    fixture.game.clientBegin(1);

    world.asked.length = 0;
    const time = fixture.game.level.time + PMOVE_MSEC;
    const cmd = createNetUserCmd();
    Object.assign(cmd, { forwardmove: 127, serverTime: time });
    fixture.traps.cmds.set(1, cmd);
    fixture.game.clientThink(1);

    // "Spectators can fly through bodies" (`g_active.c:336`).
    expect(distinctAsks(world.asked.filter((ask) => ask.passEntityNum === 1))).toEqual([
      { passEntityNum: 1, contentmask: MASK.PLAYERSOLID & ~CONTENTS.BODY }
    ]);
  });

  it('carries its origin onto its entity, which is where the world would look for it', () => {
    const { client, game, run } = spectating();

    run(20, { forwardmove: 127 });

    expect(client.ps.origin.x).not.toBe(0);
    expect(game.level.gentities[1].s.origin).toEqual(client.ps.origin);
  });

  it('still makes its triggers pass, which is what lets go of a pad it is no longer on', () => {
    const { client, run } = spectating();
    client.ps.jumppadEnt = 42;
    client.ps.jumppadFrame = 7;

    run(1);

    expect(client.ps.jumppadEnt).toBe(0);
    expect(client.ps.jumppadFrame).toBe(0);
  });

  it("is frozen the moment it starts following, since the view it is shown is somebody else's", () => {
    const { client, think } = spectating(SPECTATOR.FOLLOW);
    const origin = { ...client.ps.origin };

    // A think with no frame after it, so the end of frame has not copied the view over yet.
    think({ forwardmove: 127, upmove: 127 });

    expect(client.ps.pmType).toBe(PM_FREEZE);
    expect(client.ps.origin).toEqual(origin);
    expect(client.ps.velocity).toEqual(vec3());
  });

  it('watching the scoreboard does not even read the command', () => {
    const { client, run } = spectating(SPECTATOR.SCOREBOARD);
    const commandTime = client.ps.commandTime;

    run(20, { forwardmove: 127, upmove: 127 });

    expect(client.ps.commandTime).toBe(commandTime);
    expect(client.ps.velocity).toEqual(vec3());
  });

  it('watching the scoreboard is marked as such, and a free spectator is not', () => {
    const { client, run } = spectating(SPECTATOR.SCOREBOARD);

    run(1);
    expect(client.ps.pmFlags & PMF_SCOREBOARD).toBe(PMF_SCOREBOARD);

    client.sess.spectatorState = SPECTATOR.FREE;
    run(1);
    expect(client.ps.pmFlags & PMF_SCOREBOARD).toBe(0);
  });
});

describe('a spectator following somebody', () => {
  /** A player in slot 0, a second in slot 2, and a follower in slot 1 watching slot 0. */
  function following(watching = 0) {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    join(fixture, 2, '\\name\\Major');

    const client = fixture.game.level.clients[1];
    client.sess.sessionTeam = TEAM.SPECTATOR;
    client.sess.spectatorState = SPECTATOR.FOLLOW;
    client.sess.spectatorClient = watching;
    fixture.game.clientBegin(1);
    fixture.game.calculateRanks();

    /** Hand the follower one command, without running the frame that ends it. */
    const think = (input: Partial<NetUserCmd> = {}): void => {
      const cmd = createNetUserCmd();
      Object.assign(cmd, input, { serverTime: fixture.game.level.time + PMOVE_MSEC });
      fixture.traps.cmds.set(1, cmd);
      fixture.game.clientThink(1);
    };

    const frame = (): void => {
      const time = fixture.game.level.time + PMOVE_MSEC;
      think();
      fixture.game.runFrame(time);
    };

    return { ...fixture, client, think, frame };
  }

  it('makes no move of its own: the view it is shown is the other player s, move type and all', () => {
    const { client, game, think, frame } = following();
    const followed = game.level.clients[0];
    frame();
    const origin = { ...client.ps.origin };

    think({ forwardmove: 127, upmove: 127 });

    expect(client.ps.pmType).toBe(followed.ps.pmType);
    expect(client.ps.speed).toBe(followed.ps.speed);
    expect(client.ps.origin).toEqual(origin);
  });

  it("is shown the whole of the followed player's state, their slot number included", () => {
    const { client, game, frame } = following();
    const followed = game.level.clients[0];
    followed.ps.origin = vec3(64, 128, 24);
    followed.ps.stats[STAT.HEALTH] = 42;

    frame();

    expect(client.ps.origin).toEqual(vec3(64, 128, 24));
    expect(client.ps.stats[STAT.HEALTH]).toBe(42);
    expect(client.ps.clientNum).toBe(0);
    expect(client.ps.pmFlags & PMF_FOLLOW).toBe(PMF_FOLLOW);
  });

  it('keeps its own two vote flags over the copy, and takes none of the other player s', () => {
    const { client, game, frame } = following();
    client.ps.eFlags |= EF_VOTED;
    game.level.clients[0].ps.eFlags |= EF_TEAMVOTED;

    frame();

    expect(client.ps.eFlags & EF_VOTED).toBe(EF_VOTED);
    expect(client.ps.eFlags & EF_TEAMVOTED).toBe(0);
  });

  it('watches whoever is playing when it is a dedicated camera', () => {
    const { client, game, frame } = following(-1);

    frame();

    expect(game.level.follow1).toBe(0);
    expect(client.ps.clientNum).toBe(0);
    // A camera is never dropped to free spectating; it waits for somebody to watch.
    expect(client.sess.spectatorClient).toBe(-1);
  });

  it('is put back on its own feet when the player it was watching goes', () => {
    const { client, game, frame } = following();
    frame();
    expect(client.ps.pmFlags & PMF_FOLLOW).toBe(PMF_FOLLOW);

    game.clientDisconnect(0);
    frame();

    expect(client.sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(client.ps.pmFlags & PMF_FOLLOW).toBe(0);
    expect(client.ps.clientNum).toBe(1);
  });

  it('is put back on its own feet when the player it was watching starts spectating too', () => {
    const { client, game, frame } = following();
    frame();
    expect(client.ps.pmFlags & PMF_FOLLOW).toBe(PMF_FOLLOW);

    game.level.clients[0].sess.sessionTeam = TEAM.SPECTATOR;
    game.calculateRanks();
    frame();

    expect(client.sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(client.ps.pmFlags & PMF_FOLLOW).toBe(0);
    expect(client.ps.clientNum).toBe(1);
  });

  it('does not ride the view of a client that is still connecting', () => {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    // Connected, so the slot is taken and on a team, but never begun.
    fixture.traps.userinfos.set(2, '\\name\\Major');
    expect(fixture.game.clientConnect(2, true, false)).toBeNull();

    const client = fixture.game.level.clients[1];
    client.sess.sessionTeam = TEAM.SPECTATOR;
    client.sess.spectatorState = SPECTATOR.FOLLOW;
    client.sess.spectatorClient = 2;
    client.ps.pmFlags |= PMF_FOLLOW;
    fixture.game.calculateRanks();

    const time = fixture.game.level.time + PMOVE_MSEC;
    const cmd = createNetUserCmd();
    cmd.serverTime = time;
    fixture.traps.cmds.set(1, cmd);
    fixture.game.clientThink(1);
    fixture.game.runFrame(time);

    expect(fixture.game.level.clients[2].pers.connected).toBe(CON.CONNECTING);
    expect(client.sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(client.ps.clientNum).toBe(1);
  });

  it('is never dropped to free spectating while it is a dedicated camera', () => {
    const { client, game, frame } = following(-1);
    frame();
    expect(client.ps.pmFlags & PMF_FOLLOW).toBe(PMF_FOLLOW);

    // Nobody is playing any more, so there is no first client for the camera to watch.
    game.level.clients[0].sess.sessionTeam = TEAM.SPECTATOR;
    game.level.clients[2].sess.sessionTeam = TEAM.SPECTATOR;
    game.calculateRanks();
    frame();

    expect(game.level.follow1).toBe(-1);
    expect(client.sess.spectatorState).toBe(SPECTATOR.FOLLOW);
    expect(client.ps.clientNum).toBe(1);
  });

  it('follows nobody at all while its dedicated slot is empty', () => {
    const { client, game, frame } = following(-2);
    // With one player left there is a first to follow and no second.
    game.level.clients[2].sess.sessionTeam = TEAM.SPECTATOR;
    game.calculateRanks();

    frame();

    expect(game.level.follow2).toBe(-1);
    expect(client.ps.clientNum).toBe(1);
    expect(client.sess.spectatorState).toBe(SPECTATOR.FOLLOW);
  });
});

describe("a spectator's attack key", () => {
  /** Players in slots 0, 2 and 3, and a free spectator in slot 1: three to walk between. */
  function cycling() {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    join(fixture, 2, '\\name\\Major');
    join(fixture, 3, '\\name\\Slash');

    const client = fixture.game.level.clients[1];
    client.sess.sessionTeam = TEAM.SPECTATOR;
    client.sess.spectatorState = SPECTATOR.FREE;
    fixture.game.clientBegin(1);
    fixture.game.calculateRanks();

    /** One command with these buttons, and the frame that ends it. */
    const hold = (buttons: number): void => {
      const time = fixture.game.level.time + PMOVE_MSEC;
      const cmd = createNetUserCmd();
      Object.assign(cmd, { buttons, serverTime: time });
      fixture.traps.cmds.set(1, cmd);
      fixture.game.clientThink(1);
      fixture.game.runFrame(time);
    };

    return { ...fixture, client, hold };
  }

  it('starts it following the next client that is playing', () => {
    const { client, hold } = cycling();

    hold(BUTTON_ATTACK);

    expect(client.sess.spectatorState).toBe(SPECTATOR.FOLLOW);
    expect(client.sess.spectatorClient).toBe(2);
  });

  it('cycles on the press and not on the hold, and walks forwards', () => {
    const { client, hold } = cycling();

    hold(BUTTON_ATTACK);
    hold(BUTTON_ATTACK);
    expect(client.sess.spectatorClient).toBe(2);

    hold(0);
    hold(BUTTON_ATTACK);
    expect(client.sess.spectatorClient).toBe(3);
  });

  it('steps over the other spectators, and wraps round the end', () => {
    const { client, game, hold } = cycling();
    // Slot 1 is the spectator doing the watching, and now slots 2 and 3 are spectators too.
    game.level.clients[2].sess.sessionTeam = TEAM.SPECTATOR;
    game.level.clients[3].sess.sessionTeam = TEAM.SPECTATOR;
    game.calculateRanks();

    hold(BUTTON_ATTACK);

    expect(client.sess.spectatorClient).toBe(0);
  });

  it('steps over the slots nobody is in', () => {
    // Only slots 0 and 1 are taken, so the cycle has to walk past two empty ones to come back.
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    const client = fixture.game.level.clients[1];
    client.sess.sessionTeam = TEAM.SPECTATOR;
    client.sess.spectatorState = SPECTATOR.FREE;
    fixture.game.clientBegin(1);
    fixture.game.calculateRanks();

    const time = fixture.game.level.time + PMOVE_MSEC;
    const cmd = createNetUserCmd();
    Object.assign(cmd, { buttons: BUTTON_ATTACK, serverTime: time });
    fixture.traps.cmds.set(1, cmd);
    fixture.game.clientThink(1);

    expect(client.sess.spectatorClient).toBe(0);
    expect(client.sess.spectatorState).toBe(SPECTATOR.FOLLOW);
  });

  it('switches a dedicated camera between the two rather than walking the slots', () => {
    const { client, hold } = cycling();
    client.sess.spectatorClient = -1;

    hold(BUTTON_ATTACK);
    expect(client.sess.spectatorClient).toBe(-2);

    hold(0);
    hold(BUTTON_ATTACK);
    expect(client.sess.spectatorClient).toBe(-1);
  });

  it('leaves the view where it was when there is nobody else to watch', () => {
    const { client, game, hold } = cycling();
    game.level.clients[0].sess.sessionTeam = TEAM.SPECTATOR;
    game.level.clients[2].sess.sessionTeam = TEAM.SPECTATOR;
    game.level.clients[3].sess.sessionTeam = TEAM.SPECTATOR;
    game.calculateRanks();

    hold(BUTTON_ATTACK);

    expect(client.sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(client.sess.spectatorClient).toBe(0);
  });
});

describe('the team change', () => {
  /** A match on a floor, with a player in slot 0 already in it. */
  function playing(options: Partial<GameOptions> = {}, cvarValues: Record<string, string> = {}) {
    const fixture = makeGame(
      { entities: mapOf(spawnSpot(vec3(0, 0, 20))), ...options },
      cvarValues
    );
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    return fixture;
  }

  /** Every centre print the match has broadcast. */
  function centerPrints(fixture: Fixture): string[] {
    return fixture.traps.commands
      .filter((command) => command.text.startsWith('cp '))
      .map((command) => command.text);
  }

  it('takes a player out of the match', () => {
    const fixture = playing();
    const client = fixture.game.level.clients[0];

    fixture.game.clientCommand(0, ['team', 'spectator']);

    expect(client.sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(client.sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(fixture.game.level.gentities[0].r.linked).toBe(false);
  });

  it('kills them on the way out, so what they were carrying is left behind', () => {
    const fixture = playing();
    const client = fixture.game.level.clients[0];
    const entity = fixture.game.level.gentities[0];
    entity.s.weapon = WP.ROCKET_LAUNCHER;
    client.ps.stats[STAT.WEAPONS] |= 1 << WP.ROCKET_LAUNCHER;
    client.ps.ammo[WP.ROCKET_LAUNCHER] = 5;
    client.ps.powerups[PW.QUAD] = fixture.game.level.time + 30_000;

    fixture.game.clientCommand(0, ['team', 'spectator']);

    // "Kill him (makes sure he loses flags, etc)" (`g_cmds.c:609–614`).
    const thrown = fixture.game.level.gentities.filter(
      (e) => e.inuse && (e.flags & FL.DROPPED_ITEM) !== 0
    );
    expect(thrown.map((e) => e.item?.classname)).toEqual(['weapon_rocketlauncher', 'item_quad']);
  });

  it('kills them even in god mode, since it is not damage that does it', () => {
    const fixture = playing();
    const entity = fixture.game.level.gentities[0];
    entity.flags |= FL.GODMODE;

    fixture.game.clientCommand(0, ['team', 'spectator']);

    expect(entity.flags & FL.GODMODE).toBe(0);
  });

  it('tells everyone, in the middle of the screen', () => {
    const fixture = playing();

    fixture.game.clientCommand(0, ['team', 'spectator']);
    fixture.game.level.clients[0].switchTeamTime = 0;
    fixture.game.clientCommand(0, ['team', 'free']);

    expect(centerPrints(fixture)).toEqual([
      'cp "Sarge^7 joined the spectators.\n"',
      'cp "Sarge^7 joined the battle.\n"'
    ]);
  });

  it('puts a spectator back into the match, body and all', () => {
    const fixture = playing();
    fixture.game.clientCommand(0, ['team', 'spectator']);
    fixture.game.level.clients[0].switchTeamTime = 0;

    fixture.game.clientCommand(0, ['team', 'free']);

    const client = fixture.game.level.clients[0];
    expect(client.sess.sessionTeam).toBe(TEAM.FREE);
    expect(client.sess.spectatorState).toBe(SPECTATOR.NOT);
    expect(client.ps.stats[STAT.HEALTH]).toBeGreaterThan(0);
    expect(fixture.game.level.gentities[0].r.linked).toBe(true);
  });

  it("takes Quake 3's words for the sorts of spectator there are", () => {
    const cases: [string, number, number][] = [
      ['s', SPECTATOR.FREE, 0],
      ['spectator', SPECTATOR.FREE, 0],
      ['follow1', SPECTATOR.FOLLOW, -1],
      ['follow2', SPECTATOR.FOLLOW, -2],
      ['scoreboard', SPECTATOR.SCOREBOARD, 0],
      ['score', SPECTATOR.SCOREBOARD, 0]
    ];

    for (const [word, state, watching] of cases) {
      const fixture = playing();
      fixture.game.clientCommand(0, ['team', word]);
      const { sess } = fixture.game.level.clients[0];
      expect([word, sess.sessionTeam, sess.spectatorState, sess.spectatorClient]).toEqual([
        word,
        TEAM.SPECTATOR,
        state,
        watching
      ]);
    }
  });

  it('is refused when it is the team already held, so playing on costs nothing', () => {
    const fixture = playing();

    fixture.game.clientCommand(0, ['team', 'free']);

    expect(fixture.game.level.clients[0].ps.persistant[PERS.SCORE]).toBe(0);
    expect(centerPrints(fixture)).toEqual([]);
  });

  it('is not refused among the spectators, where the sort of spectator can change', () => {
    const fixture = playing();
    fixture.game.clientCommand(0, ['team', 'scoreboard']);
    fixture.game.level.clients[0].switchTeamTime = 0;

    fixture.game.clientCommand(0, ['team', 'spectator']);

    expect(fixture.game.level.clients[0].sess.spectatorState).toBe(SPECTATOR.FREE);
  });

  it('seats nobody in a tournament that already has its two players', () => {
    const fixture = playing({ gametype: GT.TOURNAMENT });
    join(fixture, 1, '\\name\\Bones');
    join(fixture, 2, '\\name\\Major');
    fixture.game.calculateRanks();
    expect(fixture.game.level.numNonSpectatorClients).toBe(2);

    fixture.game.clientCommand(2, ['team', 'free']);

    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.SPECTATOR);
  });

  it('seats nobody past g_maxGameClients', () => {
    const fixture = playing({ maxGameClients: 1 });
    join(fixture, 1, '\\name\\Bones');
    fixture.game.clientCommand(1, ['team', 'spectator']);
    fixture.game.level.clients[1].switchTeamTime = 0;
    fixture.game.calculateRanks();

    fixture.game.clientCommand(1, ['team', 'free']);

    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.SPECTATOR);
  });

  it('puts whoever starts spectating at the front of the queue, and moves the rest back', () => {
    const fixture = playing();
    join(fixture, 1, '\\name\\Bones');
    join(fixture, 2, '\\name\\Major');

    fixture.game.clientCommand(1, ['team', 'spectator']);
    fixture.game.clientCommand(2, ['team', 'spectator']);

    // The longest wait is the highest number, which is who a tournament seats next — and
    // the player still in the match is not in the queue at all.
    expect(fixture.game.level.clients.slice(0, 3).map((c) => c.sess.spectatorNum)).toEqual([
      0, 1, 0
    ]);
  });

  it('sends a spectator who played again and came back to the front of the queue', () => {
    const fixture = playing();
    join(fixture, 1, '\\name\\Bones');
    fixture.game.clientCommand(0, ['team', 'spectator']);
    fixture.game.clientCommand(1, ['team', 'spectator']);
    expect(fixture.game.level.clients[0].sess.spectatorNum).toBe(1);

    fixture.game.level.clients[0].switchTeamTime = 0;
    fixture.game.clientCommand(0, ['team', 'free']);
    fixture.game.level.clients[0].switchTeamTime = 0;
    fixture.game.clientCommand(0, ['team', 'spectator']);

    expect(fixture.game.level.clients.slice(0, 2).map((c) => c.sess.spectatorNum)).toEqual([0, 1]);
  });

  it('moves the waiting spectators back when somebody new connects', () => {
    const fixture = playing();
    fixture.game.clientCommand(0, ['team', 'spectator']);
    expect(fixture.game.level.clients[0].sess.spectatorNum).toBe(0);

    join(fixture, 1, '\\name\\Bones');

    expect(fixture.game.level.clients[0].sess.spectatorNum).toBe(1);
    expect(fixture.game.level.clients[1].sess.spectatorNum).toBe(0);
  });

  it('says nothing when a spectator only changes what sort of spectator it is', () => {
    const fixture = playing();
    fixture.game.clientCommand(0, ['team', 'spectator']);
    fixture.game.level.clients[0].switchTeamTime = 0;

    fixture.game.clientCommand(0, ['team', 'scoreboard']);

    expect(centerPrints(fixture)).toEqual(['cp "Sarge^7 joined the spectators.\n"']);
  });

  it('is refused more than once every five seconds', () => {
    const fixture = playing();
    fixture.game.clientCommand(0, ['team', 'spectator']);

    fixture.game.clientCommand(0, ['team', 'free']);

    expect(fixture.game.level.clients[0].sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(prints(fixture)).toContain(
      'print "May not switch teams more than once per 5 seconds.\n"'
    );
  });

  it('counts a loss against a tournament player who walks out of the match', () => {
    const fixture = playing({ gametype: GT.TOURNAMENT });

    fixture.game.clientCommand(0, ['team', 'spectator']);

    expect(fixture.game.level.clients[0].sess.losses).toBe(1);
  });

  it('counts nothing against a spectator who was out of the match already', () => {
    const fixture = playing({ gametype: GT.TOURNAMENT });
    fixture.game.clientCommand(0, ['team', 'spectator']);
    fixture.game.level.clients[0].switchTeamTime = 0;

    fixture.game.clientCommand(0, ['team', 'scoreboard']);

    expect(fixture.game.level.clients[0].sess.losses).toBe(1);
  });

  it('says which team the client is on when it is asked with no argument', () => {
    const fixture = playing();

    fixture.game.clientCommand(0, ['team']);
    fixture.game.clientCommand(0, ['team', 'spectator']);
    fixture.game.clientCommand(0, ['team']);

    expect(prints(fixture)).toContain('print "Free team\n"');
    expect(prints(fixture)).toContain('print "Spectator team\n"');
  });
});

describe('joining a side', () => {
  /** A team game on a floor, with nobody on a side yet. */
  function sides(cvarValues: Record<string, string> = {}): Fixture {
    const fixture = makeGame(
      { gametype: GT.TEAM, entities: mapOf(spawnSpot(vec3(0, 0, 20))) },
      cvarValues
    );
    fixture.traps.world = createFlatWorldTrace();
    return fixture;
  }

  // Each word is asked for against a board leaning the other way: somebody already stands on the
  // side the word names, so `PickTeam` would answer the opposite one and the word is what decides.
  it.each([
    ['red', TEAM.RED],
    ['r', TEAM.RED],
    ['blue', TEAM.BLUE],
    ['b', TEAM.BLUE]
  ])('takes Quake 3’s own word “%s” over the side that is behind', (word, side) => {
    const fixture = sides();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    putOnTeam(fixture, 0, side);

    fixture.game.clientCommand(1, ['team', word]);

    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(side);
  });

  it('takes the side that is behind when the word names neither', () => {
    const fixture = sides();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    fixture.game.clientCommand(0, ['team', 'red']);

    fixture.game.clientCommand(1, ['team', 'free']);

    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.BLUE);
  });

  it('means the free team in a game without sides', () => {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    fixture.game.clientCommand(0, ['team', 'spectator']);
    fixture.game.level.clients[0].switchTeamTime = 0;

    fixture.game.clientCommand(0, ['team', 'red']);

    expect(fixture.game.level.clients[0].sess.sessionTeam).toBe(TEAM.FREE);
  });

  it('refuses a side already two ahead while g_teamForceBalance is on', () => {
    const fixture = sides({ g_teamForceBalance: '1' });
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    join(fixture, 2, '\\name\\Major');
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.RED);

    fixture.game.clientCommand(2, ['team', 'red']);

    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(prints(fixture)).toContain('cp "Red team has too many players.\n"');
  });

  it('refuses the other side on the same terms', () => {
    const fixture = sides({ g_teamForceBalance: '1' });
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    join(fixture, 2, '\\name\\Major');
    putOnTeam(fixture, 0, TEAM.BLUE);
    putOnTeam(fixture, 1, TEAM.BLUE);

    fixture.game.clientCommand(2, ['team', 'blue']);

    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(prints(fixture)).toContain('cp "Blue team has too many players.\n"');
  });

  it('registers the two side cvars off, as Quake 3 does', () => {
    const fixture = sides();

    expect(fixture.cvars.get('g_teamAutoJoin')).toBe('0');
    expect(fixture.cvars.get('g_teamForceBalance')).toBe('0');
  });

  it('allows a spread of one, which is what an odd number of players makes', () => {
    const fixture = sides({ g_teamForceBalance: '1' });
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    putOnTeam(fixture, 0, TEAM.RED);

    fixture.game.clientCommand(1, ['team', 'red']);

    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.RED);
  });

  it('never holds a bot to the balance, since a bot is how a side gets filled', () => {
    const fixture = sides({ g_teamForceBalance: '1' });
    joinBot(fixture, 0);
    joinBot(fixture, 1, '\\name\\Grunt');
    joinBot(fixture, 2, '\\name\\Major');
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.RED);

    fixture.game.clientCommand(2, ['team', 'red']);

    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.RED);
  });

  it('never holds the client in this process to it either', () => {
    const fixture = sides({ g_teamForceBalance: '1' });
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    join(fixture, 2, '\\name\\Major\\ip\\localhost');
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.RED);

    fixture.game.clientCommand(2, ['team', 'red']);

    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.RED);
  });

  it('puts an arrival on the side its userinfo asked for, without beginning it', () => {
    const fixture = sides();
    fixture.traps.userinfos.set(1, '\\name\\Grunt\\teampref\\blue');

    expect(fixture.game.clientConnect(1, true, true)).toBeNull();

    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.BLUE);
    // `SetTeam` stops at a client that is still connecting, so nothing has a body yet.
    expect(fixture.game.level.gentities[1].r.linked).toBe(false);
  });

  it('seats an arrival that asked for nothing while g_teamAutoJoin is on', () => {
    const fixture = sides({ g_teamAutoJoin: '1' });
    join(fixture, 0);
    fixture.game.clientCommand(0, ['team', 'red']);
    fixture.traps.userinfos.set(1, '\\name\\Bones');

    expect(fixture.game.clientConnect(1, true, false)).toBeNull();

    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.BLUE);
  });

  it('leaves an arrival spectating when neither its userinfo nor the match asks', () => {
    const fixture = sides();
    fixture.traps.userinfos.set(1, '\\name\\Bones');

    expect(fixture.game.clientConnect(1, true, false)).toBeNull();

    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.SPECTATOR);
  });

  it('finds the slot from the client, since the entity is not numbered yet', () => {
    const fixture = sides();
    // `BG_PlayerStateToEntityState` writes a zeroed player state's `clientNum` over the entity's
    // number while a client is connected without having begun, and `ClientConnect` is inside that
    // window; Quake 3 takes the slot from the client instead (`g_cmds.c:527–528`).
    fixture.game.level.gentities[1].s.number = 0;
    fixture.traps.userinfos.set(1, '\\name\\Grunt\\teampref\\red');

    expect(fixture.game.clientConnect(1, true, true)).toBeNull();

    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.RED);
    // Slot 0 is the one the entity's number would have named.
    expect(fixture.game.level.clients[0].sess.sessionTeam).not.toBe(TEAM.RED);
  });
});

describe('a base to spawn at', () => {
  /** A spot of one of CTF's four kinds. */
  function teamSpot(classname: string, origin: ReturnType<typeof vec3>, yaw = 0) {
    return {
      classname,
      origin: `${origin.x} ${origin.y} ${origin.z}`,
      angles: `0 ${yaw} 0`
    };
  }

  /** Two bases at opposite ends, and one ordinary spot between them to fall back to. */
  const BASES = mapOf(
    spawnSpot(vec3(0, 0, 20)),
    teamSpot('team_CTF_redplayer', vec3(0, 200, 20), 270),
    teamSpot('team_CTF_redspawn', vec3(0, 240, 20), 270),
    teamSpot('team_CTF_blueplayer', vec3(0, -200, 20), 90),
    teamSpot('team_CTF_bluespawn', vec3(0, -240, 20), 90)
  );

  /** A capture-the-flag match on a floor. */
  function ctf(entities = BASES): Fixture {
    const fixture = makeGame({ gametype: GT.CTF, entities });
    fixture.traps.world = createFlatWorldTrace();
    return fixture;
  }

  it('is the side’s own player spot at the start of a match', () => {
    const fixture = ctf();
    join(fixture, 0);

    fixture.game.clientCommand(0, ['team', 'red']);

    // `TEAM_BEGIN` is what a team change leaves behind, so this is the `player` spot. The spawn's
    // think leaves the yaw as the short's own value, as Q3's does: 270 is -90.
    expect(fixture.game.level.clients[0].ps.origin.y).toBe(200);
    expect(fixture.game.level.clients[0].ps.viewangles.y).toBe(-90);
  });

  it('is the side’s own respawn spot once they are playing', () => {
    const fixture = ctf();
    join(fixture, 0);
    fixture.game.clientCommand(0, ['team', 'blue']);
    expect(fixture.game.level.clients[0].pers.teamState.state).toBe(TEAM_STATE.ACTIVE);

    fixture.game.clientSpawn(fixture.game.level.gentities[0]);

    expect(fixture.game.level.clients[0].ps.origin.y).toBe(-240);
  });

  it('is the other side’s base for the other side', () => {
    const fixture = ctf();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');

    fixture.game.clientCommand(0, ['team', 'red']);
    fixture.game.clientCommand(1, ['team', 'blue']);

    expect(fixture.game.level.clients[0].ps.origin.y).toBe(200);
    expect(fixture.game.level.clients[1].ps.origin.y).toBe(-200);
  });

  it('falls back to the ordinary search on a map with no bases in it', () => {
    const fixture = ctf(mapOf(spawnSpot(vec3(0, 0, 20))));
    join(fixture, 0);

    fixture.game.clientCommand(0, ['team', 'red']);

    expect(fixture.game.level.clients[0].ps.origin.y).toBe(0);
  });

  it('is not looked for at all below GT_CTF, where a team game spawns like any other', () => {
    const fixture = makeGame({ gametype: GT.TEAM, entities: BASES });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);

    fixture.game.clientCommand(0, ['team', 'red']);

    expect(fixture.game.level.clients[0].ps.origin.y).toBe(0);
  });

  it('tells every client both flags are home, and warns about a map with none', () => {
    const fixture = ctf();

    expect(fixture.traps.configstrings.get(CONFIGSTRING.FLAGSTATUS)).toBe('00');
    expect(fixture.traps.prints.join('')).toContain('No team_CTF_redflag in map');
    expect(fixture.traps.prints.join('')).toContain('No team_CTF_blueflag in map');
  });

  it('says none of that in a game without flags', () => {
    const fixture = makeGame({ gametype: GT.TEAM, entities: BASES });

    expect(fixture.traps.configstrings.get(CONFIGSTRING.FLAGSTATUS)).toBeUndefined();
    expect(fixture.traps.prints.join('')).not.toContain('team_CTF_redflag');
  });
});

describe('Clan Arena', () => {
  /** A spot of one of CTF's four kinds. */
  function teamSpot(classname: string, origin: ReturnType<typeof vec3>, yaw = 0) {
    return {
      classname,
      origin: `${origin.x} ${origin.y} ${origin.z}`,
      angles: `0 ${yaw} 0`
    };
  }

  /** Both sides' spots of both kinds, one ordinary spot, and a rocket launcher on the floor. */
  const ARENA = mapOf(
    spawnSpot(vec3(0, 0, 20)),
    teamSpot('team_CTF_redplayer', vec3(0, 200, 20), 270),
    teamSpot('team_CTF_redspawn', vec3(0, 240, 20), 270),
    teamSpot('team_CTF_blueplayer', vec3(0, -200, 20), 90),
    teamSpot('team_CTF_bluespawn', vec3(0, -240, 20), 90),
    { classname: 'weapon_rocketlauncher', origin: '64 0 20' }
  );

  /** A Clan Arena match on a floor. */
  function arena(entities = ARENA, cvarValues = {}): Fixture {
    const fixture = makeGame({ gametype: GT.CA, entities }, cvarValues);
    fixture.traps.world = createFlatWorldTrace();
    return fixture;
  }

  it('registers the round limit at 5, and announces a change to it', () => {
    const fixture = arena();
    expect(fixture.cvars.get('roundlimit')).toBe('5');

    fixture.cvars.set('roundlimit', '3');
    fixture.game.runFrame(100);

    expect(prints(fixture).join('')).toContain('Server: roundlimit changed to 3');
  });

  it("spawns a side at its own respawn spots, even at a match's start", () => {
    const fixture = arena();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');

    fixture.game.clientCommand(0, ['team', 'red']);
    fixture.game.clientCommand(1, ['team', 'blue']);

    expect(fixture.game.level.clients[0].ps.origin.y).toBe(240);
    expect(fixture.game.level.clients[1].ps.origin.y).toBe(-240);
  });

  it('spawns at the ordinary spots on a map with no respawn spots, never at a player spot', () => {
    const fixture = arena(
      mapOf(spawnSpot(vec3(0, 0, 20)), teamSpot('team_CTF_redplayer', vec3(0, 200, 20), 270))
    );
    join(fixture, 0);

    fixture.game.clientCommand(0, ['team', 'red']);

    expect(fixture.game.level.clients[0].ps.origin.y).toBe(0);
  });

  it("hands every spawn the mode's rack, whatever the testing settings say", () => {
    const fixture = arena(ARENA, { pcq_spawnArmor: '50', pcq_spawnWeapons: '1' });
    join(fixture, 0);

    fixture.game.clientCommand(0, ['team', 'red']);

    const { ps } = fixture.game.level.clients[0];
    expect(ps.weapon).toBe(WP.ROCKET_LAUNCHER);
    expect(ps.stats[STAT.WEAPONS] & (1 << WP.BFG)).toBe(0);
    expect(ps.ammo[WP.MACHINEGUN]).toBe(200);
    expect(ps.stats[STAT.HEALTH]).toBe(100);
    expect(ps.stats[STAT.ARMOR]).toBe(150);
  });

  it('stands no item on the map', () => {
    const standing = (fixture: Fixture) =>
      fixture.game.level.gentities.some((e) => e.inuse && e.classname === 'weapon_rocketlauncher');

    expect(standing(arena())).toBe(false);
    expect(standing(makeGame({ gametype: GT.TEAM, entities: ARENA }))).toBe(true);
  });

  it('drops nothing at a death', () => {
    const fixture = arena();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    fixture.game.clientCommand(0, ['team', 'red']);
    fixture.game.clientCommand(1, ['team', 'blue']);
    const { level } = fixture.game;
    level.clients[1].ps.powerups[PW.QUAD] = level.time + 30_000;

    const shooter = level.gentities[0];
    damage(level, level.gentities[1], shooter, shooter, null, 1000, 0, MOD.RAILGUN);

    const dropped = level.gentities.filter((e) => e.inuse && (e.flags & FL.DROPPED_ITEM) !== 0);
    expect(dropped).toHaveLength(0);
  });

  it('is not ended by the capture limit', () => {
    const fixture = arena(ARENA, { capturelimit: '1', roundlimit: '0' });
    join(fixture, 0);
    join(fixture, 1);
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.BLUE);
    fixture.game.runFrame(1000);

    fixture.game.level.teamScores[TEAM.RED] = 5;
    fixture.game.calculateRanks();

    expect(fixture.game.level.intermissionQueued).toBe(0);
  });

  describe('its rounds', () => {
    /**
     * One red respawn spot and two blue, apart, so neither side's spawns telefrag each other, and
     * an intermission camera of its own, where the spectators start.
     */
    const ROUNDS = mapOf(
      spawnSpot(vec3(0, 0, 20)),
      teamSpot('team_CTF_redspawn', vec3(0, 240, 20), 270),
      teamSpot('team_CTF_bluespawn', vec3(-200, -240, 20), 90),
      teamSpot('team_CTF_bluespawn', vec3(200, -240, 20), 90),
      teamSpot('info_player_intermission', vec3(0, 0, 300))
    );

    /** Red in slot 0 and each side's player on it, before any frame has run. */
    function manned(blues = 1, cvarValues = {}): Fixture {
      const fixture = arena(ROUNDS, cvarValues);
      join(fixture, 0);
      fixture.game.clientCommand(0, ['team', 'red']);
      for (let i = 1; i <= blues; i++) {
        join(fixture, i, '\\name\\Bones' + i);
        fixture.game.clientCommand(i, ['team', 'blue']);
      }
      return fixture;
    }

    /** A match into its first round: counted down from the first frame, and played once past it. */
    function playing(blues = 1, cvarValues = {}): Fixture {
      const fixture = manned(blues, cvarValues);
      fixture.game.runFrame(1000);
      fixture.game.runFrame(1100 + CA_ROUND_WARMUP);
      expect(fixture.game.level.roundTime).toBe(0);
      return fixture;
    }

    /** A rail that takes a fresh spawn's armour and health to nothing, and no lower. */
    function kill(fixture: Fixture, victim: number, attacker: number): void {
      const { level } = fixture.game;
      const by = level.gentities[attacker];
      damage(level, level.gentities[victim], by, by, null, 250, 0, MOD.RAILGUN);
      expect(level.clients[victim].ps.stats[STAT.HEALTH]).toBe(0);
    }

    /** A command from `clientNum` at the level's time, with these buttons held. */
    function think(fixture: Fixture, clientNum: number, buttons = 0): void {
      const cmd = createNetUserCmd();
      cmd.serverTime = fixture.game.level.time;
      cmd.buttons = buttons;
      fixture.traps.cmds.set(clientNum, cmd);
      fixture.game.clientThink(clientNum);
    }

    /** One command from `clientNum`, with the weapon it holds, and the frame it is stamped for. */
    function step(fixture: Fixture, clientNum: number, buttons = 0): void {
      const time = fixture.game.level.time + PMOVE_MSEC;
      const cmd = createNetUserCmd();
      cmd.serverTime = time;
      cmd.buttons = buttons;
      cmd.weapon = fixture.game.level.clients[clientNum].ps.weapon;
      fixture.traps.cmds.set(clientNum, cmd);
      fixture.game.clientThink(clientNum);
      fixture.game.runFrame(time);
    }

    /** The centre prints that tell of a round, which a team change's leave out. */
    function roundPrints(fixture: Fixture): string[] {
      return prints(fixture).filter((text) => text.startsWith('cp ') && text.includes('round'));
    }

    /**
     * `clientNum`'s command once their respawn is due, which starts them watching, and the frame
     * after it, which finds them gone from the round: the time returned.
     */
    function watch(fixture: Fixture, clientNum: number): number {
      const { game } = fixture;
      const due = game.level.clients[clientNum].respawnTime;
      game.runFrame(due + 50);
      think(fixture, clientNum);
      expect(isSpectator(game.level.clients[clientNum])).toBe(true);
      game.runFrame(due + 100);
      return due + 100;
    }

    /** Blue's one player killed in a round and watching, and when blue was found out. */
    function blueOut(cvarValues = {}): { fixture: Fixture; out: number } {
      const fixture = playing(1, cvarValues);
      kill(fixture, 1, 0);
      return { fixture, out: watch(fixture, 1) };
    }

    /** The obituaries raised and not yet retired. */
    function obituaries(fixture: Fixture): number {
      const { gentities } = fixture.game.level;
      return gentities.filter((e) => e.inuse && e.s.eType === ET.EVENTS + EV.OBITUARY).length;
    }

    it("pins CPMA's numbers: a ten-second countdown and a second's win delay", () => {
      expect(CA_ROUND_WARMUP).toBe(10_000);
      expect(CA_WIN_DELAY).toBe(1000);
    });

    it('waits between rounds until each side has a player, then counts the first one down', () => {
      const fixture = arena(ROUNDS);
      expect(warmupString(fixture)).toBe('-1');
      join(fixture, 0);
      fixture.game.clientCommand(0, ['team', 'red']);
      fixture.game.runFrame(1000);
      expect(fixture.game.level.roundTime).toBe(-1);
      expect(warmupString(fixture)).toBe('-1');

      join(fixture, 1, '\\name\\Bones');
      fixture.game.clientCommand(1, ['team', 'blue']);
      fixture.game.runFrame(2000);
      expect(warmupString(fixture)).toBe(String(2000 + CA_ROUND_WARMUP));

      fixture.game.runFrame(2000 + CA_ROUND_WARMUP);
      expect(fixture.game.level.roundTime).toBe(2000 + CA_ROUND_WARMUP);
      fixture.game.runFrame(2100 + CA_ROUND_WARMUP);
      expect(fixture.game.level.roundTime).toBe(0);
      expect(warmupString(fixture)).toBe('0');
    });

    it("leaves the warmup to Quake 3's own until the match is under way", () => {
      const fixture = manned(1, { g_doWarmup: '1' });
      fixture.game.runFrame(1000);

      expect(fixture.game.level.warmupTime).toBeGreaterThan(0);
      expect(warmupString(fixture)).toBe(String(fixture.game.level.warmupTime));
      expect(fixture.game.level.roundTime).toBe(-1);
    });

    it("respawns everyone on a side as a countdown starts, with the mode's loadout", () => {
      const fixture = manned();
      const { level } = fixture.game;
      level.clients[0].ps.stats[STAT.ARMOR] = 10;
      level.clients[1].ps.ammo[WP.ROCKET_LAUNCHER] = 3;
      const spawns = [0, 1].map((i) => level.clients[i].ps.persistant[PERS.SPAWN_COUNT]);

      fixture.game.runFrame(1000);

      // Every one of them still standing: none is telefragged by where they stood.
      expect(level.clients[0].ps.stats[STAT.HEALTH]).toBe(100);
      expect(level.clients[1].ps.stats[STAT.HEALTH]).toBe(100);
      expect(level.clients[0].ps.stats[STAT.ARMOR]).toBe(150);
      expect(level.clients[1].ps.ammo[WP.ROCKET_LAUNCHER]).toBe(50);
      expect(level.clients[0].ps.persistant[PERS.SPAWN_COUNT]).toBe(spawns[0] + 1);
      expect(level.clients[1].ps.persistant[PERS.SPAWN_COUNT]).toBe(spawns[1] + 1);
    });

    it('gives the round to the side still standing, a second after the other is out', () => {
      const { fixture, out } = blueOut();
      const { level } = fixture.game;

      fixture.game.runFrame(out + CA_WIN_DELAY);
      expect(level.teamScores[TEAM.RED]).toBe(0);
      expect(level.roundTime).toBe(0);

      fixture.game.runFrame(out + CA_WIN_DELAY + 100);
      expect(level.teamScores[TEAM.RED]).toBe(1);
      expect(level.teamScores[TEAM.BLUE]).toBe(0);
      expect(fixture.traps.configstrings.get(CONFIGSTRING.SCORES1)).toBe('1');
      expect(roundPrints(fixture)).toEqual(['cp "^1RED^7 has won the round"']);
      // The frag is the player's; only the round is the side's.
      expect(level.clients[0].ps.persistant[PERS.SCORE]).toBe(1);
    });

    it('counts the next round down at once, bringing the dead back and leaving the bodies', () => {
      const { fixture, out } = blueOut();
      const { level } = fixture.game;

      fixture.game.runFrame(out + CA_WIN_DELAY + 100);

      expect(level.roundTime).toBe(out + CA_WIN_DELAY + 100 + CA_ROUND_WARMUP);
      expect(level.clients[0].ps.stats[STAT.HEALTH]).toBe(100);
      expect(level.clients[1].ps.stats[STAT.HEALTH]).toBe(100);
      expect(corpses(fixture.game)).toHaveLength(1);
    });

    it("takes back a hook that is out when the round's respawn comes", () => {
      const fixture = playing();
      const { level } = fixture.game;
      step(fixture, 0, BUTTON_AFFIRMATIVE);
      const hook = level.clients[0].hook;
      expect(hook).toBeGreaterThanOrEqual(0);

      kill(fixture, 1, 0);
      const out = watch(fixture, 1);
      expect(level.clients[0].hook).toBe(hook);
      fixture.game.runFrame(out + CA_WIN_DELAY + 100);

      expect(level.roundTime).toBeGreaterThan(0);
      expect(level.clients[0].hook).toBe(-1);
      expect(level.gentities[hook].inuse).toBe(false);
    });

    it('calls the round a draw when both sides are out inside the second', () => {
      const fixture = playing();
      const { level } = fixture.game;
      kill(fixture, 1, 0);
      fixture.game.runFrame(level.time + 300);
      // Red's last player goes a moment later, to their own rocket, say.
      hurt(fixture.game, 0, 1000);
      const out = watch(fixture, 1);
      watch(fixture, 0);
      fixture.game.runFrame(out + CA_WIN_DELAY + 100);

      expect(level.teamScores[TEAM.RED]).toBe(0);
      expect(level.teamScores[TEAM.BLUE]).toBe(0);
      expect(roundPrints(fixture)).toEqual(['cp "The round is a draw!"']);
      expect(level.roundTime).toBeGreaterThan(0);
    });

    it('leaves the dead watching from their own side, their body left behind, unasked', () => {
      const fixture = playing(2);
      const { level } = fixture.game;
      kill(fixture, 1, 0);
      const client = level.clients[1];
      const spawns = client.ps.persistant[PERS.SPAWN_COUNT];

      fixture.game.runFrame(client.respawnTime);
      think(fixture, 1, BUTTON_ATTACK);
      expect(isSpectator(client)).toBe(false);

      fixture.game.runFrame(client.respawnTime + 50);
      think(fixture, 1);
      expect(isSpectator(client)).toBe(true);
      expect(client.sess.sessionTeam).toBe(TEAM.BLUE);
      expect(client.sess.spectatorState).toBe(SPECTATOR.FREE);
      expect(client.ps.persistant[PERS.SPAWN_COUNT]).toBe(spawns);
      expect(corpses(fixture.game)).toHaveLength(1);
      expect(level.gentities[1].r.linked).toBe(false);

      // From the next command on, they fly as a spectator does.
      fixture.game.runFrame(client.respawnTime + 100);
      think(fixture, 1);
      expect(client.ps.pmType).toBe(PM_SPECTATOR);
      expect(level.gentities[1].r.linked).toBe(false);
      expect(level.roundTime).toBe(0);
    });

    it('lets the dead up as ever while the match waits for its first round', () => {
      const fixture = arena(ROUNDS);
      const { level } = fixture.game;
      join(fixture, 0);
      fixture.game.clientCommand(0, ['team', 'red']);
      fixture.game.runFrame(1000);
      hurt(fixture.game, 0, 1000);
      const spawns = level.clients[0].ps.persistant[PERS.SPAWN_COUNT];

      // Nor do they start watching when the respawn is due: they get up when they choose to.
      fixture.game.runFrame(4000);
      think(fixture, 0);
      expect(isSpectator(level.clients[0])).toBe(false);
      fixture.game.runFrame(4100);
      think(fixture, 0, BUTTON_ATTACK);

      expect(level.clients[0].ps.persistant[PERS.SPAWN_COUNT]).toBe(spawns + 1);
    });

    it('leaves the dead watching once a round has been played, while the match waits', () => {
      const fixture = playing();
      const { level } = fixture.game;
      fixture.game.clientCommand(1, ['team', 'spectator']);
      fixture.game.runFrame(level.time + 100);
      expect(level.roundTime).toBe(-1);
      hurt(fixture.game, 0, 1000);
      const spawns = level.clients[0].ps.persistant[PERS.SPAWN_COUNT];

      fixture.game.runFrame(level.clients[0].respawnTime + 50);
      think(fixture, 0, BUTTON_ATTACK);

      expect(level.clients[0].ps.persistant[PERS.SPAWN_COUNT]).toBe(spawns);
      expect(isSpectator(level.clients[0])).toBe(true);
    });

    it('takes no hit in a countdown but a telefrag, and brings its victim straight back', () => {
      const fixture = manned();
      const { level } = fixture.game;
      fixture.game.runFrame(1000);
      const red = level.gentities[0];
      const blue = level.clients[1];

      damage(level, level.gentities[1], red, red, vec3(1, 0, 0), 250, 0, MOD.RAILGUN);
      expect(blue.ps.stats[STAT.HEALTH]).toBe(100);
      expect(blue.ps.stats[STAT.ARMOR]).toBe(150);
      expect(blue.ps.velocity).toEqual(vec3(0, 0, 0));

      const telefrag = [TELEFRAG_DAMAGE, DAMAGE_NO_PROTECTION, MOD.TELEFRAG] as const;
      damage(level, level.gentities[1], red, red, null, ...telefrag);
      expect(blue.ps.stats[STAT.HEALTH]).toBeLessThanOrEqual(0);
      const spawns = blue.ps.persistant[PERS.SPAWN_COUNT];
      fixture.game.runFrame(1100);
      expect(blue.ps.persistant[PERS.SPAWN_COUNT]).toBe(spawns + 1);
      expect(blue.ps.stats[STAT.HEALTH]).toBe(100);
    });

    it('spends no ammo until the round is being played', () => {
      const fixture = manned();
      const { level } = fixture.game;
      fixture.game.runFrame(1000);
      const { ps } = level.clients[0];

      // The attack that respawned the player is let go first, as any spawn asks.
      step(fixture, 0);
      step(fixture, 0, BUTTON_ATTACK);
      expect(level.gentities.some((e) => e.inuse && e.s.eType === ET.MISSILE)).toBe(true);
      expect(ps.ammo[WP.ROCKET_LAUNCHER]).toBe(50);

      fixture.game.runFrame(1100 + CA_ROUND_WARMUP);
      for (let i = 0; i < 200 && ps.ammo[WP.ROCKET_LAUNCHER] === 50; i++) {
        step(fixture, 0, BUTTON_ATTACK);
      }
      expect(ps.ammo[WP.ROCKET_LAUNCHER]).toBe(49);
    });

    it('ends the match at the round limit, and counts nothing down after it', () => {
      const { fixture, out } = blueOut({ roundlimit: '1' });
      const { level } = fixture.game;

      fixture.game.runFrame(out + CA_WIN_DELAY + 100);

      expect(prints(fixture)).toContain('print "Red hit the roundlimit.\n"');
      expect(level.intermissionQueued).toBe(out + CA_WIN_DELAY + 100);
      expect(warmupString(fixture)).toBe('0');
      expect(level.clients[1].ps.stats[STAT.HEALTH]).toBe(0);

      // Nor once the intermission has begun.
      fixture.game.runFrame(out + CA_WIN_DELAY + 100 + INTERMISSION_DELAY_TIME);
      fixture.game.runFrame(out + CA_WIN_DELAY + 200 + INTERMISSION_DELAY_TIME);
      expect(level.intermissiontime).toBeGreaterThan(0);
      expect(warmupString(fixture)).toBe('0');
    });

    it('ends it for blue as for red', () => {
      const fixture = playing(1, { roundlimit: '2' });
      fixture.game.level.teamScores[TEAM.BLUE] = 2;

      fixture.game.calculateRanks();

      expect(prints(fixture)).toContain('print "Blue hit the roundlimit.\n"');
      expect(fixture.game.level.intermissionQueued).toBeGreaterThan(0);
    });

    it('goes back to waiting when a side is emptied, whatever was being played', () => {
      const { fixture, out } = blueOut();
      const { level } = fixture.game;

      fixture.game.clientCommand(1, ['team', 'spectator']);
      fixture.game.runFrame(out + 100);

      expect(level.roundTime).toBe(-1);
      expect(level.roundWinTime).toBe(0);
      expect(warmupString(fixture)).toBe('-1');
      expect(roundPrints(fixture)).toEqual([]);
      expect(level.teamScores[TEAM.RED]).toBe(0);
    });

    describe('its dead', () => {
      it('counts a player just killed in the round until they watch, at their respawn time', () => {
        const fixture = playing();
        const { level } = fixture.game;
        kill(fixture, 1, 0);
        fixture.game.runFrame(level.clients[1].respawnTime);
        expect(level.roundWinTime).toBe(0);

        const out = watch(fixture, 1);
        expect(level.roundWinTime).toBe(out + CA_WIN_DELAY);
      });

      it('follows the living of either side with attack, the watcher kept on their own', () => {
        const fixture = playing(2);
        const { level } = fixture.game;
        kill(fixture, 1, 0);
        watch(fixture, 1);
        const watcher = level.clients[1];

        think(fixture, 1, BUTTON_ATTACK);
        expect(watcher.sess.spectatorState).toBe(SPECTATOR.FOLLOW);
        expect(watcher.sess.spectatorClient).toBe(2);
        fixture.game.runFrame(level.time + 100);
        expect(watcher.ps.clientNum).toBe(2);
        expect(watcher.ps.pmFlags & PMF_FOLLOW).toBe(PMF_FOLLOW);

        think(fixture, 1);
        think(fixture, 1, BUTTON_ATTACK);
        expect(watcher.sess.spectatorClient).toBe(0);
        expect(watcher.sess.sessionTeam).toBe(TEAM.BLUE);
      });

      it('lets a follower cycle on a command behind the clock of the one followed', () => {
        const fixture = playing(2);
        const { level } = fixture.game;
        kill(fixture, 1, 0);
        watch(fixture, 1);
        const watcher = level.clients[1];
        think(fixture, 1, BUTTON_ATTACK);
        expect(watcher.sess.spectatorClient).toBe(2);

        // The one followed has thought ahead of the frame, and the end frame hands the follower
        // that clock with the rest of the state.
        const ahead = createNetUserCmd();
        ahead.serverTime = level.time + 100;
        fixture.traps.cmds.set(2, ahead);
        fixture.game.clientThink(2);
        fixture.game.runFrame(level.time + PMOVE_MSEC);
        expect(watcher.ps.commandTime).toBeGreaterThan(level.time);

        think(fixture, 1);
        think(fixture, 1, BUTTON_ATTACK);
        expect(watcher.sess.spectatorClient).toBe(0);
      });

      it('passes over the watching as it cycles', () => {
        const fixture = playing(2);
        const { level } = fixture.game;
        kill(fixture, 1, 0);
        watch(fixture, 1);
        kill(fixture, 2, 0);
        watch(fixture, 2);

        think(fixture, 1, BUTTON_ATTACK);
        expect(level.clients[1].sess.spectatorClient).toBe(0);
      });

      it('keeps a watcher on their side as they follow and stop, and lets none be followed', () => {
        const fixture = playing(2);
        const { level } = fixture.game;
        kill(fixture, 1, 0);
        watch(fixture, 1);
        const watcher = level.clients[1];

        fixture.game.clientCommand(1, ['follow', '2']);
        expect(watcher.sess.spectatorState).toBe(SPECTATOR.FOLLOW);
        expect(watcher.sess.spectatorClient).toBe(2);
        expect(watcher.sess.sessionTeam).toBe(TEAM.BLUE);

        fixture.game.clientCommand(1, ['follow']);
        expect(watcher.sess.spectatorState).toBe(SPECTATOR.FREE);
        expect(watcher.sess.sessionTeam).toBe(TEAM.BLUE);
        expect(watcher.ps.persistant[PERS.TEAM]).toBe(TEAM.BLUE);

        // Nobody follows a watcher, and a player who asks to stays in the game.
        fixture.game.clientCommand(0, ['follow', '1']);
        expect(level.clients[0].sess.sessionTeam).toBe(TEAM.RED);
        expect(level.clients[0].sess.spectatorState).toBe(SPECTATOR.NOT);
      });

      it('drops a follower to free flight on their side once the one followed watches too', () => {
        const fixture = playing(2);
        const { level } = fixture.game;
        kill(fixture, 1, 0);
        watch(fixture, 1);
        think(fixture, 1, BUTTON_ATTACK);
        const watcher = level.clients[1];

        kill(fixture, 2, 0);
        fixture.game.runFrame(level.time + 100);
        expect(watcher.sess.spectatorState).toBe(SPECTATOR.FOLLOW);

        const before = fixture.traps.commands.length;
        watch(fixture, 2);
        expect(watcher.sess.spectatorState).toBe(SPECTATOR.FREE);
        // Let off where they were rather than begun again, which would say they entered the game.
        const told = fixture.traps.commands.slice(before).map(({ text }) => text);
        expect(told.filter((text) => text.includes('entered the game'))).toEqual([]);
        expect(watcher.sess.sessionTeam).toBe(TEAM.BLUE);
        expect(watcher.ps.persistant[PERS.TEAM]).toBe(TEAM.BLUE);
        expect(watcher.ps.pmFlags & PMF_FOLLOW).toBe(0);
        expect(watcher.ps.clientNum).toBe(1);
        expect(isSpectator(watcher)).toBe(true);
      });

      it('lets a watcher off a view that disconnects, still on their side', () => {
        const fixture = playing(2);
        const { level } = fixture.game;
        kill(fixture, 1, 0);
        watch(fixture, 1);
        think(fixture, 1, BUTTON_ATTACK);

        fixture.game.clientDisconnect(2);

        expect(level.clients[1].sess.spectatorState).toBe(SPECTATOR.FREE);
        expect(level.clients[1].sess.sessionTeam).toBe(TEAM.BLUE);
      });

      it("brings the watching back at the next round's respawn, with no second body", () => {
        const fixture = playing(2);
        const { level } = fixture.game;
        kill(fixture, 1, 0);
        watch(fixture, 1);
        think(fixture, 1, BUTTON_ATTACK);
        kill(fixture, 0, 2);
        const out = watch(fixture, 0);
        fixture.game.runFrame(out + CA_WIN_DELAY + 100);

        expect(level.teamScores[TEAM.BLUE]).toBe(1);
        expect(level.roundTime).toBeGreaterThan(0);
        for (const i of [0, 1]) {
          const client = level.clients[i];
          expect(isSpectator(client)).toBe(false);
          expect(client.sess.spectatorState).toBe(SPECTATOR.NOT);
          expect(client.ps.stats[STAT.HEALTH]).toBe(100);
          expect(client.ps.clientNum).toBe(i);
          expect(client.ps.pmFlags & PMF_FOLLOW).toBe(0);
          expect(level.gentities[i].r.linked).toBe(true);
        }
        expect(corpses(fixture.game)).toHaveLength(2);
      });

      it('moves a watcher to the other side with no second body and no death', () => {
        const fixture = playing(2);
        const { level } = fixture.game;
        kill(fixture, 1, 0);
        watch(fixture, 1);
        // A late arrival watches with a life in hand, which a death would take.
        join(fixture, 3, '\\name\\Late');
        fixture.game.clientCommand(3, ['team', 'blue']);
        fixture.game.runFrame(level.time + 5000);
        think(fixture, 3);
        expect(level.clients[3].ps.pmType).toBe(PM_SPECTATOR);
        const deaths = obituaries(fixture);

        fixture.game.clientCommand(1, ['team', 'red']);
        fixture.game.clientCommand(3, ['team', 'red']);

        for (const i of [1, 3]) {
          expect(level.clients[i].sess.sessionTeam).toBe(TEAM.RED);
          expect(isSpectator(level.clients[i])).toBe(true);
          expect(level.gentities[i].r.linked).toBe(false);
        }
        expect(corpses(fixture.game)).toHaveLength(1);
        expect(obituaries(fixture)).toBe(deaths);
      });

      it('has a player who joins a side mid-round watch from it until the next, told so', () => {
        const fixture = playing();
        const { level } = fixture.game;
        join(fixture, 2, '\\name\\Late');
        const before = fixture.traps.commands.length;

        fixture.game.clientCommand(2, ['team', 'blue']);

        const late = level.clients[2];
        const told = fixture.traps.commands.slice(before);
        expect(late.sess.sessionTeam).toBe(TEAM.BLUE);
        expect(isSpectator(late)).toBe(true);
        expect(level.gentities[2].r.linked).toBe(false);
        // At the spectators' spot, the intermission camera's, rather than on a side's.
        expect(late.ps.origin).toEqual(vec3(0, 0, 300));
        expect(told).toContainEqual({ to: 2, text: 'cp "You will join ^4BLUE^7 next round\n"' });
        expect(told.some(({ text }) => text.includes('joined the blue team'))).toBe(false);

        // Blue's last player in the round goes; the next round's respawn brings the arrival in.
        kill(fixture, 1, 0);
        const out = watch(fixture, 1);
        fixture.game.runFrame(out + CA_WIN_DELAY + 100);
        expect(level.teamScores[TEAM.RED]).toBe(1);
        expect(isSpectator(late)).toBe(false);
        expect(level.gentities[2].r.linked).toBe(true);
      });

      it('lets a player join a side as ever during a countdown', () => {
        const fixture = manned();
        const { level } = fixture.game;
        fixture.game.runFrame(1000);
        join(fixture, 2, '\\name\\Late');

        fixture.game.clientCommand(2, ['team', 'blue']);

        expect(isSpectator(level.clients[2])).toBe(false);
        expect(prints(fixture)).toContain('cp "Late^7 joined the blue team.\n"');
      });

      it('has kill pass over a player who joined mid-round, watching from their side', () => {
        const fixture = playing();
        join(fixture, 2, '\\name\\Late');
        fixture.game.clientCommand(2, ['team', 'blue']);
        const late = fixture.game.level.clients[2];
        const health = late.ps.stats[STAT.HEALTH];
        const told = obituaries(fixture);
        expect(health).toBeGreaterThan(0);

        fixture.game.clientCommand(2, ['kill']);

        expect(late.ps.stats[STAT.HEALTH]).toBe(health);
        expect(obituaries(fixture)).toBe(told);
      });
    });
  });
});

describe('friendly fire', () => {
  it('is off until the cvar says otherwise, and the match is what G_Damage reads it from', () => {
    // No cvar value given: the default is half of what is under test.
    const fixture = makeGame({ gametype: GT.TEAM, entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    fixture.game.clientCommand(0, ['team', 'red']);
    fixture.game.clientCommand(1, ['team', 'red']);
    const { level } = fixture.game;
    const mate = level.clients[1];
    const shooter = level.gentities[0];
    const rocket = () =>
      damage(level, level.gentities[1], shooter, shooter, null, 30, 0, MOD.ROCKET);

    const before = mate.ps.stats[STAT.HEALTH];
    rocket();
    expect(mate.ps.stats[STAT.HEALTH]).toBe(before);

    fixture.cvars.set('g_friendlyFire', '1');
    rocket();
    expect(mate.ps.stats[STAT.HEALTH]).toBe(before - 30);
  });

  it('costs the one who kills a teammate a point', () => {
    const fixture = makeGame(
      { gametype: GT.TEAM, entities: mapOf(spawnSpot(vec3(0, 0, 20))) },
      { g_friendlyFire: '1' }
    );
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    fixture.game.clientCommand(0, ['team', 'red']);
    fixture.game.clientCommand(1, ['team', 'red']);
    const { level } = fixture.game;
    const shooter = level.gentities[0];

    damage(level, level.gentities[1], shooter, shooter, null, 1000, 0, MOD.ROCKET);

    expect(level.clients[0].ps.persistant[PERS.SCORE]).toBe(-1);
  });
});

describe('a forced taunt', () => {
  /** A client standing on a floor, past the spawn's hold, with a think per call. */
  function standing() {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    fixture.game.clientConnect(0, true, false);
    fixture.game.clientBegin(0);

    const think = (input: Partial<NetUserCmd> = {}): void => {
      const time = fixture.game.level.time + PMOVE_MSEC;
      const cmd = createNetUserCmd();
      Object.assign(cmd, input, { serverTime: time });
      fixture.traps.cmds.set(0, cmd);
      fixture.game.clientThink(0);
      fixture.game.runFrame(time);
    };

    for (let i = 0; i < 40; i++) think();
    return { ...fixture, think };
  }

  it('plays on the next command, however empty the command was', () => {
    // `Team_ForceGesture` sets the flag on the entity and `ClientThink_real` turns it into a
    // button (`g_active.c:873–876`), so the taunt is animated by the ordinary move.
    const fixture = standing();
    const { level } = fixture.game;
    level.gentities[0].flags |= FL.FORCE_GESTURE;

    fixture.think();

    expect(animOf(level.clients[0].ps.torsoAnim)).toBe(ANIM.TORSO_GESTURE);
  });

  it('is spent by being read, so it plays once and not every frame after', () => {
    const fixture = standing();
    const { level } = fixture.game;
    level.gentities[0].flags |= FL.FORCE_GESTURE;

    fixture.think();

    expect(level.gentities[0].flags & FL.FORCE_GESTURE).toBe(0);
    // The latch is taken before the flag is read, so nothing downstream thinks a key was held.
    expect(level.clients[0].buttons & BUTTON_GESTURE).toBe(0);
  });
});

describe('the follow command', () => {
  /** Players in slots 0, 2 and 3, and a spectator in slot 1: three to walk between. */
  function watching() {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    join(fixture, 2, '\\name\\Major');
    join(fixture, 3, '\\name\\Slash');
    fixture.game.clientCommand(1, ['team', 'spectator']);
    fixture.game.calculateRanks();
    return fixture;
  }

  it('watches a client by slot', () => {
    const fixture = watching();

    fixture.game.clientCommand(1, ['follow', '2']);

    const { sess } = fixture.game.level.clients[1];
    expect(sess.spectatorState).toBe(SPECTATOR.FOLLOW);
    expect(sess.spectatorClient).toBe(2);
  });

  it('watches a client by name, colours and case aside', () => {
    const fixture = watching();

    fixture.game.clientCommand(1, ['follow', 'major']);

    expect(fixture.game.level.clients[1].sess.spectatorClient).toBe(2);
  });

  it('says so when nobody answers to the name', () => {
    const fixture = watching();

    fixture.game.clientCommand(1, ['follow', 'Doom']);

    expect(prints(fixture)).toContain('print "User Doom is not on the server\n"');
    expect(fixture.game.level.clients[1].sess.spectatorState).toBe(SPECTATOR.FREE);
  });

  it('watches no other spectator', () => {
    const fixture = watching();
    fixture.game.clientCommand(2, ['team', 'spectator']);

    fixture.game.clientCommand(1, ['follow', '2']);

    expect(fixture.game.level.clients[1].sess.spectatorState).toBe(SPECTATOR.FREE);
  });

  it('does not take a player out of the match to watch themselves', () => {
    const fixture = watching();

    fixture.game.clientCommand(0, ['follow', '0']);

    expect(fixture.game.level.clients[0].sess.sessionTeam).toBe(TEAM.FREE);
    expect(fixture.game.level.clients[0].sess.spectatorState).not.toBe(SPECTATOR.FOLLOW);
  });

  it('takes a player out of the match to do it', () => {
    const fixture = watching();

    fixture.game.clientCommand(0, ['follow', '2']);

    const { sess } = fixture.game.level.clients[0];
    expect(sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(sess.spectatorState).toBe(SPECTATOR.FOLLOW);
    expect(sess.spectatorClient).toBe(2);
  });

  it('with no argument, lets a follower off the view it is riding', () => {
    const fixture = watching();
    fixture.game.clientCommand(1, ['follow', '2']);

    fixture.game.clientCommand(1, ['follow']);

    expect(fixture.game.level.clients[1].sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(fixture.game.level.clients[1].ps.clientNum).toBe(1);
  });

  it('cycles forwards and backwards on its own two commands', () => {
    const fixture = watching();

    fixture.game.clientCommand(1, ['follownext']);
    expect(fixture.game.level.clients[1].sess.spectatorClient).toBe(2);

    fixture.game.clientCommand(1, ['followprev']);
    expect(fixture.game.level.clients[1].sess.spectatorClient).toBe(0);
  });
});

describe('the kill command', () => {
  /** A match on a floor, with a player in slot 0 already in it, at no score. */
  function playing(): Fixture {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    expect(fixture.game.level.clients[0].ps.persistant[PERS.SCORE]).toBe(0);
    return fixture;
  }

  /** Each obituary raised and not yet retired: the means, the dead and the killer. */
  function obituaries(fixture: Fixture): number[][] {
    return fixture.game.level.gentities
      .filter((e) => e.inuse && e.s.eType === ET.EVENTS + EV.OBITUARY)
      .map(({ s }) => [s.eventParm, s.otherEntityNum, s.otherEntityNum2]);
  }

  it('kills the player by their own hand, gibbed and a point down', () => {
    const fixture = playing();
    const client = fixture.game.level.clients[0];
    const entity = fixture.game.level.gentities[0];

    fixture.game.clientCommand(0, ['kill']);

    expect(client.ps.pmType).toBe(PM_DEAD);
    expect(client.ps.stats[STAT.HEALTH]).toBe(-999);
    expect(entity.health).toBe(-999);
    expect(client.ps.persistant[PERS.SCORE]).toBe(-1);
    expect(obituaries(fixture)).toEqual([[MOD.SUICIDE, 0, 0]]);
    expect(entity.s.eType).toBe(ET.INVISIBLE);
  });

  it('kills a player in god mode, and takes god mode away', () => {
    const fixture = playing();
    const entity = fixture.game.level.gentities[0];
    entity.flags |= FL.GODMODE;

    fixture.game.clientCommand(0, ['kill']);

    expect(entity.flags & FL.GODMODE).toBe(0);
    expect(fixture.game.level.clients[0].ps.pmType).toBe(PM_DEAD);
  });

  it('passes over the dead, leaving the body whole', () => {
    const fixture = playing();
    const client = fixture.game.level.clients[0];
    const entity = fixture.game.level.gentities[0];
    hurt(fixture.game, 0, client.ps.stats[STAT.HEALTH] + 5);
    expect(entity.s.eType).toBe(ET.PLAYER);

    fixture.game.clientCommand(0, ['kill']);

    // A body at −999 would be gibbed by `body_die`.
    expect(client.ps.stats[STAT.HEALTH]).toBe(-5);
    expect(entity.s.eType).toBe(ET.PLAYER);
  });

  it('passes over a spectator', () => {
    const fixture = playing();
    fixture.game.clientCommand(0, ['team', 'spectator']);
    const client = fixture.game.level.clients[0];
    const health = client.ps.stats[STAT.HEALTH];
    const told = obituaries(fixture);
    expect(health).toBeGreaterThan(0);

    fixture.game.clientCommand(0, ['kill']);

    expect(client.ps.stats[STAT.HEALTH]).toBe(health);
    expect(obituaries(fixture)).toEqual(told);
  });

  it('is matched whatever its case, as every client command is', () => {
    const fixture = playing();
    fixture.traps.commands.length = 0;

    fixture.game.clientCommand(0, ['Score']);
    expect(prints(fixture).filter((text) => text.startsWith('scores '))).toHaveLength(1);

    fixture.game.clientCommand(0, ['KILL']);
    expect(fixture.game.level.clients[0].ps.pmType).toBe(PM_DEAD);
  });
});

describe('a client that has not finished arriving', () => {
  it('is not thought about at all, not even to be read at an intermission', () => {
    const fixture = atIntermission();
    // Connected, never begun: Quake 3 asks that before it asks anything else, so this client
    // neither readies up nor is moved.
    fixture.traps.userinfos.set(1, '\name\Bones');
    expect(fixture.game.clientConnect(1, true, false)).toBeNull();
    const client = fixture.game.level.clients[1];

    press(fixture, 1, BUTTON_ATTACK);

    expect(client.readyToExit).toBe(false);
    expect(client.buttons).toBe(0);
  });

  /**
   * A bot, because a bot's entity is in use from the moment it connects (`ClientConnect`) and so
   * is the only kind of client a frame reaches before it has begun. One frame of that is enough
   * to leave its entity numbered 0: the entity state is built from a player state that is still
   * all zeroes, and `BG_PlayerStateToEntityState` writes that state's `clientNum` as the number.
   */
  function waiting(fixture: Fixture): GameEntity {
    fixture.traps.userinfos.set(1, '\\name\\Bones');
    expect(fixture.game.clientConnect(1, true, true)).toBeNull();
    fixture.game.runFrame(100);
    expect(fixture.game.level.gentities[1].s.number).toBe(0);
    return fixture.game.level.gentities[1];
  }

  it('is given its slot back when it begins, and spawns nobody else', () => {
    const fixture = makeGame();
    join(fixture, 0);
    const player = fixture.game.level.clients[0];
    const spawns = player.ps.persistant[PERS.SPAWN_COUNT];
    const bot = waiting(fixture);

    fixture.game.clientBegin(1);

    // `G_InitGentity`'s `e->s.number = e - g_entities`, which is the only thing that puts the
    // number right. Without it the begin reads the 0 and spawns whoever is in slot 0 instead,
    // which leaves the bot bodiless for the rest of the map and throws the player across it.
    expect(bot.s.number).toBe(1);
    expect(fixture.game.level.clients[1].ps.clientNum).toBe(1);
    expect(fixture.game.level.clients[1].ps.stats[STAT.HEALTH]).toBe(100 + SPAWN_HEALTH_BONUS);
    expect(bot.r.linked).toBe(true);
    expect(player.ps.persistant[PERS.SPAWN_COUNT]).toBe(spawns);
  });

  it('does not drag a spectator through the end of a frame on its way', () => {
    const fixture = makeGame();
    join(fixture, 0);
    fixture.game.clientCommand(0, ['team', 'spectator']);
    waiting(fixture);

    const watcher = fixture.game.level.gentities[0];
    // Something only a rebuild would put back, and `SpectatorClientEndFrame` returns before the
    // rebuild (`g_active.c:1110–1116`). The frame's end for the waiting client is its own.
    watcher.s.eType = ET.GENERAL;

    fixture.game.runFrame(200);

    expect(watcher.s.eType).toBe(ET.GENERAL);
  });
});

describe("the tournament's queue", () => {
  /** Two playing in slots 0 and 1, and `waiting` spectators behind them. */
  function tournament(waiting: number, cvarValues: Record<string, string> = {}): Fixture {
    const fixture = makeGame({ gametype: GT.TOURNAMENT }, cvarValues);
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    // Each arrival goes to the front of the queue, so the first to wait ends up with the highest
    // number: slot 2 waits longer than slot 3.
    for (let i = 0; i < waiting; i++) join(fixture, 2 + i, `\\name\\Waiting${i}`);
    return fixture;
  }

  it('seats whoever has waited longest when a seat comes free', () => {
    const fixture = tournament(2);
    expect(fixture.game.level.clients[2].sess.spectatorNum).toBe(1);
    expect(fixture.game.level.clients[3].sess.spectatorNum).toBe(0);

    fixture.game.clientDisconnect(1);
    fixture.game.runFrame(1000);

    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.FREE);
    expect(fixture.game.level.clients[3].sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(fixture.game.level.numPlayingClients).toBe(2);
  });

  it('leaves a match that already has its two alone', () => {
    const fixture = tournament(1);

    fixture.game.runFrame(1000);

    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.SPECTATOR);
  });

  it('seats nobody at an intermission, where the round is already over', () => {
    const fixture = tournament(1);
    fixture.game.clientDisconnect(1);
    fixture.game.level.intermissiontime = 1000;

    fixture.game.runFrame(2000);

    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.SPECTATOR);
  });

  it('passes over the scoreboard spectator, who is watching rather than waiting', () => {
    const fixture = tournament(2);
    fixture.game.clientCommand(2, ['team', 'scoreboard']);
    expect(fixture.game.level.clients[2].sess.spectatorNum).toBe(1);

    fixture.game.clientDisconnect(1);
    fixture.game.runFrame(1000);

    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(fixture.game.level.clients[3].sess.sessionTeam).toBe(TEAM.FREE);
  });

  it('passes over a dedicated camera, which is a place to watch from', () => {
    const fixture = tournament(2);
    fixture.game.clientCommand(2, ['team', 'follow1']);
    expect(fixture.game.level.clients[2].sess.spectatorClient).toBe(-1);

    fixture.game.clientDisconnect(1);
    fixture.game.runFrame(1000);

    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(fixture.game.level.clients[3].sess.sessionTeam).toBe(TEAM.FREE);
  });

  it('passes over a client that has not finished arriving', () => {
    const fixture = tournament(0);
    // Connected but never begun, and queued ahead of the spectator who arrives after it.
    fixture.traps.userinfos.set(3, '\\name\\Major');
    expect(fixture.game.clientConnect(3, true, false)).toBeNull();
    join(fixture, 2, '\\name\\Slash');
    expect(fixture.game.level.clients[3].sess.spectatorNum).toBe(1);

    fixture.game.clientDisconnect(1);
    fixture.game.runFrame(1000);

    expect(fixture.game.level.clients[3].sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.FREE);
  });

  it('leaves the seat for a client that is on its way to it', () => {
    const fixture = makeGame({ gametype: GT.TOURNAMENT });
    join(fixture, 0);
    // A bot waiting out `addbot`'s delay: connected onto the free team, but not yet begun, so
    // `CalculateRanks` counts it among the non-spectators and not among the playing.
    fixture.traps.userinfos.set(1, '\\name\\Bones');
    expect(fixture.game.clientConnect(1, true, false)).toBeNull();
    join(fixture, 2, '\\name\\Waiting');
    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.FREE);
    const spawns = fixture.game.level.clients[2].ps.persistant[PERS.SPAWN_COUNT];

    fixture.game.runFrame(1000);

    // Quake 3 would offer the seat and refuse it in the same frame, and go on doing so every
    // frame until the bot arrived — leaving the spectator frozen and respawning.
    const waiting = fixture.game.level.clients[2];
    expect(waiting.sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(waiting.sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(waiting.ps.persistant[PERS.SPAWN_COUNT]).toBe(spawns);
  });

  it('starts the countdown again from the moment the match is whole', () => {
    const fixture = tournament(1, { g_warmup: '20' });
    expect(fixture.game.level.warmupTime).toBe(0);

    fixture.game.clientDisconnect(1);
    fixture.game.runFrame(1000);

    // The seat is filled before the count is taken, so the match never goes back to waiting —
    // but the countdown does start again, because the new player has not warmed up.
    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.FREE);
    expect(fixture.game.level.warmupTime).toBe(20_000);
  });

  it('seats them through the team change, so they arrive with a body and are announced', () => {
    const fixture = tournament(1);
    fixture.traps.commands.length = 0;

    fixture.game.clientDisconnect(1);
    fixture.game.runFrame(1000);

    expect(fixture.game.level.gentities[2].r.linked).toBe(true);
    expect(fixture.game.level.clients[2].sess.spectatorState).toBe(SPECTATOR.NOT);
    expect(
      fixture.traps.commands.map((command) => command.text).filter((text) => text.startsWith('cp '))
    ).toEqual(['cp "Waiting0^7 joined the battle.\n"']);
  });
});

describe("the tournament's loser", () => {
  /** A tournament played to its intermission, slot 0 ahead, with `waiting` spectators behind. */
  function finished(waiting = 0): Fixture {
    const fixture = makeGame({ gametype: GT.TOURNAMENT }, { timelimit: '1' });
    join(fixture, 0);
    join(fixture, 1, '\\name\\Bones');
    for (let i = 0; i < waiting; i++) join(fixture, 2 + i, `\\name\\Waiting${i}`);
    fixture.game.level.clients[0].ps.persistant[PERS.SCORE] = 1;
    fixture.game.level.clients[1].ps.persistant[PERS.SCORE] = 0;
    fixture.game.calculateRanks();

    fixture.game.runFrame(60_000);
    fixture.game.runFrame(61_000);
    expect(fixture.game.level.intermissiontime).toBe(61_000);
    return fixture;
  }

  it('makes the second-placed player a spectator and leaves the winner on', () => {
    const fixture = finished();

    fixture.game.exitLevel();

    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(fixture.game.level.clients[1].sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(fixture.game.level.clients[0].sess.sessionTeam).toBe(TEAM.FREE);
  });

  it('sends them to the back of the line, behind whoever was already waiting', () => {
    const fixture = finished(1);
    expect(fixture.game.level.clients[2].sess.spectatorNum).toBe(0);

    fixture.game.exitLevel();

    expect(fixture.game.level.clients[1].sess.spectatorNum).toBe(0);
    expect(fixture.game.level.clients[2].sess.spectatorNum).toBe(1);
  });

  it('is nobody when the match is not a pair, however it came to hold three', () => {
    const fixture = finished(1);
    putOnTeam(fixture, 2, TEAM.FREE);
    expect(fixture.game.level.numPlayingClients).toBe(3);

    fixture.game.exitLevel();

    // Second place is a place in a pair, so a match of three has no loser to send away — and the
    // round still restarts, because that is not the loser's doing.
    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.FREE);
    expect(fixture.game.level.clients[2].sess.sessionTeam).toBe(TEAM.FREE);
    expect(fixture.traps.consoleCommands).toEqual(['map_restart 0\n']);
  });

  it('is left alone when they have already gone', () => {
    const fixture = finished();
    fixture.game.level.clients[1].pers.connected = CON.CONNECTING;

    fixture.game.exitLevel();

    expect(fixture.game.level.clients[1].sess.sessionTeam).toBe(TEAM.FREE);
  });
});

describe('the match settings', () => {
  it('reads the latched pair where a map starts and nowhere else', () => {
    const fixture = makeGame({}, { g_gametype: String(GT.TOURNAMENT), sv_maxclients: '3' });
    expect(fixture.game.gametype).toBe(GT.TOURNAMENT);
    expect(fixture.game.level.maxclients).toBe(3);

    // The console takes the new value at once and the match keeps the one it started with, which
    // is the whole of what latching is.
    fixture.cvars.set('g_gametype', String(GT.FFA));
    fixture.game.runFrame(100);
    expect(fixture.game.gametype).toBe(GT.TOURNAMENT);

    fixture.traps.restartEntities();

    fixture.game.init(0, 1, false);
    expect(fixture.game.gametype).toBe(GT.FFA);
  });

  it('falls back to a free-for-all for a gametype Quake 3 does not have', () => {
    const fixture = makeGame({}, { g_gametype: '99' });

    expect(fixture.game.gametype).toBe(GT.FFA);
    expect(fixture.cvars.get('g_gametype')).toBe('0');
  });

  it('leaves a cvar the store already holds alone, whatever default it is offered', () => {
    const fixture = makeGame({ maxclients: 4 }, { sv_maxclients: '2', fraglimit: '7' });

    expect(fixture.cvars.get('sv_maxclients')).toBe('2');
    expect(fixture.cvars.get('fraglimit')).toBe('7');
  });

  it('announces a change to a limit the match is being run to', () => {
    const fixture = makeGame();
    join(fixture, 0);
    fixture.traps.commands.length = 0;

    fixture.cvars.set('fraglimit', '5');
    fixture.game.runFrame(100);

    expect(fixture.traps.commands).toEqual([
      { to: null, text: 'print "Server: fraglimit changed to 5\n"' }
    ]);
  });

  it('announces it once, however many frames follow', () => {
    const fixture = makeGame();
    join(fixture, 0);
    fixture.traps.commands.length = 0;

    fixture.cvars.set('timelimit', '15');
    fixture.game.runFrame(100);
    fixture.game.runFrame(200);

    expect(fixture.traps.commands).toHaveLength(1);
  });

  it('announces each change in the frame after it, one change after another', () => {
    const fixture = makeGame();
    join(fixture, 0);
    fixture.game.runFrame(100);
    fixture.traps.commands.length = 0;

    fixture.cvars.set('timelimit', '15');
    fixture.game.runFrame(200);
    fixture.cvars.set('fraglimit', '5');
    fixture.game.runFrame(300);

    expect(fixture.traps.commands.map(({ text }) => text)).toEqual([
      'print "Server: timelimit changed to 15\n"',
      'print "Server: fraglimit changed to 5\n"'
    ]);
  });

  it('asks after none of its cvars in a frame when nothing in the store has changed', () => {
    const fixture = makeGame();
    join(fixture, 0);
    fixture.game.runFrame(100);
    const asked = vi.spyOn(fixture.cvars, 'modificationCount');
    fixture.game.runFrame(200);
    fixture.game.runFrame(300);
    // `CheckCvars` reads the password's own count every frame, as `g_main.c:1740–1751` does.
    expect(asked.mock.calls.map(([name]) => name)).toEqual(['g_password', 'g_password']);
  });

  it('says nothing about the ones a match is not run to', () => {
    const fixture = makeGame();
    join(fixture, 0);
    fixture.traps.commands.length = 0;

    fixture.cvars.set('g_gametype', String(GT.TOURNAMENT));
    fixture.cvars.set('g_restarted', '1');
    fixture.game.runFrame(100);

    expect(fixture.traps.commands).toEqual([]);
  });

  it('announces a change to dmflags, as Quake 3 tracks it', () => {
    const fixture = makeGame();
    join(fixture, 0);
    fixture.traps.commands.length = 0;

    fixture.cvars.set('dmflags', '32');
    fixture.game.runFrame(100);

    expect(fixture.traps.commands).toEqual([
      { to: null, text: 'print "Server: dmflags changed to 32\n"' }
    ]);
  });

  it("registers the preset's label as id's Quake 3, and says nothing when a preset writes another", () => {
    const fixture = makeGame();
    expect(fixture.cvars.get('g_gamepreset')).toBe('VQ3');
    join(fixture, 0);
    fixture.traps.commands.length = 0;

    fixture.cvars.set('g_gamepreset', 'CPM');
    fixture.game.runFrame(100);

    expect(fixture.traps.commands).toEqual([]);
  });
});

describe('the move', () => {
  const GROUND_Z = 24;

  /**
   * A client standing on a floor, past the spawn's 100 ms hold, ready to be given commands.
   *
   * The spawn point stands clear of the floor: `SelectSpawnPoint` lifts a player nine units and a
   * standing one's origin is twenty-four above its feet, so a point on the floor itself would put
   * them inside it.
   */
  function standing(cvarValues: Record<string, string> = {}) {
    // The testing loadout, because the move's tests fire guns the map would otherwise hand out.
    const fixture = makeGame(
      { entities: mapOf(spawnSpot(vec3(0, 0, 20))) },
      { pcq_spawnWeapons: '1', ...cvarValues }
    );
    fixture.traps.world = createFlatWorldTrace();
    fixture.game.clientConnect(0, true, false);
    fixture.game.clientBegin(0);
    const client = fixture.game.level.clients[0];

    /** Run `ticks` frames of 8 ms with the given command held. */
    const run = (ticks: number, input: Partial<NetUserCmd> = {}): void => {
      for (let i = 0; i < ticks; i++) {
        const time = fixture.game.level.time + PMOVE_MSEC;
        const cmd = createNetUserCmd();
        Object.assign(cmd, input, { serverTime: time });
        fixture.traps.cmds.set(0, cmd);
        fixture.game.clientThink(0);
        fixture.game.runFrame(time);
      }
    };

    // The spawn drops the player to the floor and lets the 100 ms knockback hold expire.
    run(40);
    return { ...fixture, client, run };
  }

  it('drops the spawned client onto the world the host traces, and leaves it there', () => {
    const { client } = standing();

    // The trace backs a sweep off by its own epsilon, so resting is a fraction above the floor.
    expect(client.ps.origin.z).toBeCloseTo(GROUND_Z, 0);
    expect(client.ps.groundEntityNum).toBe(ENTITYNUM_WORLD);
    expect(client.ps.velocity.z).toBe(0);
  });

  it('falls for ever in a world the host has no collision for', () => {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.game.clientConnect(0, true, false);
    fixture.game.clientBegin(0);
    const client = fixture.game.level.clients[0];
    for (let i = 0; i < 40; i++) {
      const time = fixture.game.level.time + PMOVE_MSEC;
      const cmd = createNetUserCmd();
      cmd.serverTime = time;
      fixture.traps.cmds.set(0, cmd);
      fixture.game.clientThink(0);
      fixture.game.runFrame(time);
    }

    expect(client.ps.groundEntityNum).toBe(ENTITYNUM_NONE);
    expect(client.ps.origin.z).toBeLessThan(0);
  });

  it('leaves the water the move found on the entity, until a spawn clears it', () => {
    const { game, traps, run, client } = standing();
    const asked = new Set<number>();
    traps.contents = (point, passEntityNum) => {
      asked.add(passEntityNum);
      return point.z < 30 ? CONTENTS.SLIME : 0;
    };
    const entity = game.level.gentities[0];

    run(1);
    expect([entity.waterlevel, entity.watertype]).toEqual([2, CONTENTS.SLIME]);
    expect(asked).toEqual(new Set([0]));

    // The spawn's own frame finds the slime again, but a spectator's frames take no water.
    game.clientCommand(0, ['team', 'spectator']);
    run(1);
    expect(client.sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect([entity.waterlevel, entity.watertype]).toEqual([0, 0]);
  });

  it('drowns a client under the host water at the frame end, and fries one in its lava', () => {
    const { game, traps, run, client } = standing();
    // At the max, so no drain moves it.
    client.ps.stats[STAT.HEALTH] = 100;
    traps.contents = (point) => (point.z < 1000 ? CONTENTS.WATER : 0);
    run(1500);
    expect(client.ps.stats[STAT.HEALTH]).toBe(100);
    run(1);
    expect(client.ps.stats[STAT.HEALTH]).toBe(96);
    expect(client.ps.loopSound).toBe(0);

    traps.contents = (point) => (point.z < 30 ? CONTENTS.LAVA : 0);
    run(1);
    expect(client.ps.loopSound).toBe(game.level.sndFry);
    expect(game.level.gentities[0].s.loopSound).toBe(game.level.sndFry);
  });

  it('gives a spawn under water its 12 s of air', () => {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    fixture.traps.world = createFlatWorldTrace();
    fixture.traps.contents = (point) => (point.z < 1000 ? CONTENTS.WATER : 0);
    join(fixture, 0);
    const { level } = fixture.game;
    expect(level.gentities[0].waterlevel).toBe(3);
    expect(level.clients[0].airOutTime).toBe(level.time + 12_000);
  });

  it("drops what a death carried whatever the host's contents, nodrop too", () => {
    for (const [contents, drops] of [
      [0, 1],
      [CONTENTS.NODROP, 1]
    ]) {
      const { game, traps, client } = standing();
      game.level.gentities[0].s.weapon = WP.ROCKET_LAUNCHER;
      client.ps.ammo[WP.ROCKET_LAUNCHER] = 5;
      traps.contents = () => contents;
      game.clientCommand(0, ['kill']);
      const dropped = game.level.gentities.filter(
        (e) => e.inuse && (e.flags & FL.DROPPED_ITEM) !== 0
      );
      expect(dropped).toHaveLength(drops);
    }
  });

  it("leaves the entity state's origin where it was, as `G_SetOrigin` never writes it", () => {
    const { game } = standing();
    const entity = game.level.gentities[0];
    expect(entity.s.origin).toEqual(vec3());
    expect(entity.s.pos.trBase.z).toBeGreaterThan(20);
  });

  it('puts the pitch limit on the delta, so nothing is left to wind off before the view moves', () => {
    // `PM_UpdateViewAngles` clamps the sum of the command and the delta and writes the difference
    // back into the delta (`bg_pmove.c:1806-1822`). Without that, a client holding an angle past
    // the limit would sit at the limit and have to wind all the way back before its view moved.
    const { client, run } = standing();
    const held = angleToShort(90);

    run(1, { angles: [held, 0, 0] });
    expect(client.ps.viewangles.x).toBeCloseTo(PITCH_LIMIT_DEGREES, 4);
    expect(client.ps.deltaAngles.x).toBe(PITCH_LIMIT_SHORT - held);

    // The same difference is still there when the command comes back, which is what makes the
    // clamp a turn the server made rather than a range the client lost.
    run(1, { angles: [0, 0, 0] });
    expect(client.ps.viewangles.x).toBeLessThan(0);
  });

  it('puts the pitch limit on the delta looking down as well', () => {
    const { client, run } = standing();
    const held = angleToShort(-90);

    run(1, { angles: [held, 0, 0] });
    expect(client.ps.viewangles.x).toBeCloseTo(-PITCH_LIMIT_DEGREES, 4);
    expect(client.ps.deltaAngles.x).toBe(-PITCH_LIMIT_SHORT - held);
  });

  it('reads `pcq_god` at the think, so it spares the next hit and not the one before it', () => {
    // Q3's `god` cheat, kept as a setting. Read where `g_speed` and `g_gravity` are read, which is
    // what makes it live: what it does happens at the next hit rather than when it was typed.
    const { client, game, cvars, run } = standing();

    const before = client.ps.stats[STAT.HEALTH];
    hurt(game, 0, 25);
    expect(client.ps.stats[STAT.HEALTH]).toBe(before - 25);

    cvars.set('pcq_god', '1');
    run(1);
    const spared = client.ps.stats[STAT.HEALTH];
    hurt(game, 0, 25);
    expect(client.ps.stats[STAT.HEALTH]).toBe(spared);
  });

  it('reads `pcq_spawnArmor` at the spawn, so a life gets what was set during the one before', () => {
    const { client, game, cvars } = standing();
    expect(client.ps.stats[STAT.ARMOR]).toBe(0);

    cvars.set('pcq_spawnArmor', '50');
    game.clientRespawn(game.level.gentities[0]);
    expect(client.ps.stats[STAT.ARMOR]).toBe(50);
  });

  it('fires the weapon the client is holding, and the shot leaves an entity behind', () => {
    // `ClientEvents` → `FireWeapon`: the move raises the event and the game module turns it into
    // something in the world, which is the only way a shot reaches anybody else.
    const { client, game, run } = standing();
    client.ps.weapon = WP.ROCKET_LAUNCHER;

    run(1, { buttons: BUTTON_ATTACK, weapon: WP.ROCKET_LAUNCHER });

    const missiles = game.level.gentities
      .slice(MAX_CLIENTS, game.level.numEntities)
      .filter((entity) => entity.inuse && entity.s.eType === ET.MISSILE);
    expect(missiles).toHaveLength(1);
    expect(missiles[0].r.ownerNum).toBe(0);
  });

  it('runs the missiles it fired from the frame, and links them where they get to', () => {
    const { client, game, run } = standing();
    client.ps.weapon = WP.ROCKET_LAUNCHER;
    run(1, { buttons: BUTTON_ATTACK, weapon: WP.ROCKET_LAUNCHER });
    const rocket = game.level.gentities
      .slice(MAX_CLIENTS, game.level.numEntities)
      .find((entity) => entity.inuse && entity.s.eType === ET.MISSILE)!;
    const launched = rocket.r.currentOrigin.x;

    run(3, { weapon: WP.ROCKET_LAUNCHER });

    expect(rocket.r.currentOrigin.x).toBeGreaterThan(launched);
    expect(rocket.r.linked).toBe(true);
  });

  it('links the impact a hitscan shot leaves, so that anyone is told about it', () => {
    // An entity nothing has linked reaches nobody, and an impact that reaches nobody is an
    // impact nobody sees.
    const { client, game, run, traps } = standing();
    client.ps.weapon = WP.MACHINEGUN;
    traps.linked.length = 0;

    run(1, { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });

    const impacts = game.level.gentities
      .slice(MAX_CLIENTS, game.level.numEntities)
      .filter((entity) => entity.inuse && entity.s.eType > ET.EVENTS);
    // Looking level over a flat floor, the round runs to the end of its range and marks nothing;
    // aimed down, it strikes the floor and leaves its spark.
    expect(impacts.length).toBeLessThanOrEqual(1);
    for (const impact of impacts) expect(traps.linked).toContain(impact.s.number);
  });

  it('walks the client where the command says, and rebuilds what others are told from it', () => {
    const { client, game, run } = standing();
    const entity = game.level.gentities[0];

    run(60, { forwardmove: 127 });

    expect(client.ps.origin.x).toBeGreaterThan(100);
    expect(client.ps.origin.y).toBeCloseTo(0, 5);
    // `ClientEndFrame`'s `BG_PlayerStateToEntityState`, which is the only place this happens —
    // and it snaps, so what everyone else is told is the origin at whole units.
    expect(entity.s.pos.trBase.x).toBe(Math.trunc(client.ps.origin.x));
    expect(entity.s.groundEntityNum).toBe(ENTITYNUM_WORLD);
    expect(entity.r.linked).toBe(true);
  });

  it('adds the delta angles the server turned the client by, and clamps the pitch', () => {
    const { client, game, run } = standing();

    // `SetClientViewAngle`: the client keeps sending the same angles and they now add up
    // elsewhere, which is how a spawn faces a player without the next command undoing it.
    setClientViewAngle(game.level.gentities[0], vec3(0, 90, 0));
    run(1);
    expect(client.ps.viewangles.y).toBeCloseTo(90, 1);

    // A short is signed: looking up is a negative angle rather than one just under a full turn.
    run(1, { angles: [angleToShort(-30), 0, 0] });
    expect(client.ps.viewangles.x).toBeCloseTo(-30, 1);

    // `PM_UpdateViewAngles`' clamp, which the move owns: straight down is as far as it goes.
    run(1, { angles: [angleToShort(120), 0, 0] });
    expect(client.ps.viewangles.x).toBeCloseTo(PITCH_LIMIT_DEGREES, 3);
  });

  it('reads `g_speed` and `g_gravity` at every think, so both are live', () => {
    const { client, cvars, run } = standing();
    expect(client.ps.speed).toBe(320);
    expect(client.ps.gravity).toBe(800);

    cvars.set('g_speed', '480');
    cvars.set('g_gravity', '400');
    run(1);

    expect(client.ps.speed).toBe(480);
    expect(client.ps.gravity).toBe(400);
  });

  it('moves in `pmove_msec` ticks, rounding each command up to one and dropping the one between', () => {
    const { client, cvars, run } = standing();
    cvars.set('pmove_msec', '16');
    // In the air, where each tick's fall is snapped to a whole speed: 12.8 comes to 13 at 16 ms,
    // where two ticks of 6.4 come to 12 at 8.
    client.ps.origin.z += 100;
    const start = client.ps.commandTime;
    expect(start % 16).toBe(0);

    run(1);
    expect(client.ps.commandTime).toBe(start + 16);
    expect(client.ps.velocity.z).toBe(-13);

    // The next command is stamped where the clock already is, so nothing is thought.
    run(1);
    expect(client.ps.commandTime).toBe(start + 16);
    expect(client.ps.velocity.z).toBe(-13);

    run(2);
    expect(client.ps.commandTime).toBe(start + 32);
    expect(client.ps.velocity.z).toBe(-26);
  });

  it('registers `pmove_msec` at Quake 3’s 8', () => {
    expect(makeGame().cvars.get('pmove_msec')).toBe('8');
  });

  it('holds `pmove_msec` to 8–33 where it is read', () => {
    const { cvars, run } = standing();

    cvars.set('pmove_msec', '5');
    run(1);
    expect(cvars.get('pmove_msec')).toBe('8');

    cvars.set('pmove_msec', '50');
    run(1);
    expect(cvars.get('pmove_msec')).toBe('33');
  });

  it('drops a command that moves the clock nowhere, think and all', () => {
    const { client, game, traps } = standing();
    const cmd = createNetUserCmd();
    Object.assign(cmd, { serverTime: client.ps.commandTime, buttons: BUTTON_ATTACK });
    traps.cmds.set(0, cmd);

    game.clientThink(0);

    expect(client.buttons).toBe(0);
  });

  it('runs without footsteps under dmflags 32, read at the frame as a vmCvar_t is', () => {
    const { client, cvars, run } = standing();
    const footsteps = (ticks: number): number => {
      let count = 0;
      for (let i = 0; i < ticks; i++) {
        const since = client.ps.eventSequence;
        run(1, { forwardmove: 127 });
        count += eventsSince(client.ps, since).filter(
          ({ event }) => eventNumber(event) === EV.FOOTSTEP
        ).length;
      }
      return count;
    };
    expect(footsteps(100)).toBeGreaterThan(0);

    cvars.set('dmflags', String(DF_NO_FOOTSTEPS));
    // `G_UpdateCvars` reads it at the frame, after this think.
    run(1, { forwardmove: 127 });
    expect(footsteps(100)).toBe(0);
  });

  it("moves by the rules' cvars, with CPMA's switches", () => {
    const { client, run } = standing({ pmove_JumpVelocity: '275', pmove_SnapVelocity: '0' });
    run(1, { upmove: 127 });
    expect(client.ps.velocity.z).toBeCloseTo(275 - 800 * 0.008, 10);
  });

  it('multiplies the speed by 1.3 while haste is held', () => {
    const { client, run } = standing();

    client.ps.powerups[PW.HASTE] = 1;
    run(1);
    expect(client.ps.speed).toBeCloseTo(320 * HASTE_RATE, 6);

    // Read beside `g_speed` at every think, so the powerup running out brings the speed back.
    client.ps.powerups[PW.HASTE] = 0;
    run(1);
    expect(client.ps.speed).toBe(320);
  });

  it("multiplies the speed by each preset's haste, truncated in single precision", () => {
    const hasted = (cvarValues: Record<string, string>) => {
      const { client, run } = standing(cvarValues);
      client.ps.powerups[PW.HASTE] = 1;
      run(1);
      return client.ps.speed;
    };
    const presets = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'];
    const factors = presets.map((name) => String(presetRules(name).g_hasteFactor));
    expect(factors.map((factor) => hasted({ g_hasteFactor: factor }))).toEqual([
      416, 400, 400, 425, 400
    ]);
    // 90 × 1.3 is 116.99999 in the VM's single precision, and a double's 117.
    expect(hasted({ g_speed: '90' })).toBe(116);
  });

  it('hands the cvar to the shot, so a shell fired under quad carries the factor', () => {
    const { client, game, cvars, run } = standing();
    cvars.set('g_quadfactor', '4');
    // Read again at the top of the next frame, as a `vmCvar_t` is (`G_UpdateCvars`).
    run(1);
    client.ps.powerups[PW.QUAD] = 1;
    // In hand and ready, so the one tick below is the shot rather than a weapon change.
    client.ps.weapon = WP.ROCKET_LAUNCHER;
    client.ps.weaponstate = WEAPON_READY;
    client.ps.weaponTime = 0;

    run(1, { buttons: BUTTON_ATTACK, weapon: WP.ROCKET_LAUNCHER });

    // `FireWeapon` reads `g_quadfactor` at the shot (`g_weapon.c:802–807`), and a missile carries
    // what it was worth (`g_weapon.c:397–398`).
    const rocket = game.level.gentities.find(
      (entity) => entity.inuse && entity.s.eType === ET.MISSILE
    );
    expect(rocket?.damage).toBe(400);
    expect(rocket?.splashDamage).toBe(400);
  });

  it('hands the rules to a missile in flight, so a grenade bounces by them', () => {
    const { client, game, run } = standing({ g_bounceTruncate_gl: '1' });
    client.ps.weapon = WP.GRENADE_LAUNCHER;
    client.ps.weaponstate = WEAPON_READY;
    client.ps.weaponTime = 0;
    run(1, { buttons: BUTTON_ATTACK, weapon: WP.GRENADE_LAUNCHER });
    const grenade = game.level.gentities.find(
      (entity) => entity.inuse && entity.s.eType === ET.MISSILE
    )!;
    const fired = grenade.s.pos.trTime;
    for (let i = 0; i < 250 && grenade.s.pos.trTime === fired; i++) run(1);

    // Its first bounce, in whole units, as only the switch has it.
    expect(grenade.s.pos.trTime).not.toBe(fired);
    const { trBase, trDelta } = grenade.s.pos;
    const whole = [trBase.x, trBase.y, trBase.z, trDelta.x, trDelta.y, trDelta.z];
    expect(whole.every(Number.isInteger)).toBe(true);
  });

  it('hands the rules to the level, so a hit reads them as they stand', () => {
    const { client, game, cvars, run } = standing();
    const entity = game.level.gentities[0];
    let before = client.ps.stats[STAT.HEALTH];
    // A hit of nothing costs id's least, a point.
    damage(game.level, entity, null, null, null, 0, 0, MOD.ROCKET);
    expect(client.ps.stats[STAT.HEALTH]).toBe(before - 1);

    cvars.set('g_minDamage', '0');
    run(1);
    before = client.ps.stats[STAT.HEALTH];
    damage(game.level, entity, null, null, null, 0, 0, MOD.ROCKET);
    expect(client.ps.stats[STAT.HEALTH]).toBe(before);
  });

  it('expires a powerup at the end of the frame its time has passed on', () => {
    const { client, game, run } = standing();
    const endsAt = game.level.time + PMOVE_MSEC;
    client.ps.powerups[PW.QUAD] = endsAt;

    run(1);
    // `level.time` is now exactly the powerup's own end, and the test is strictly less than:
    // it runs to the instant it names, and goes on the frame after (`g_active.c:1118–1123`).
    expect(game.level.time).toBe(endsAt);
    expect(client.ps.powerups[PW.QUAD]).toBe(endsAt);

    run(1);
    expect(client.ps.powerups[PW.QUAD]).toBe(0);
  });

  it('expires powerups at the intermission too, where the rest of the frame is skipped', () => {
    // Q3's `ClientEndFrame` turns the expired powerups off before it returns for the intermission
    // (`g_active.c:1112–1126`), which the port's early return would otherwise skip.
    const fixture = atIntermission();
    const client = fixture.game.level.clients[0];
    client.ps.powerups[PW.QUAD] = fixture.game.level.time - 1;

    fixture.game.runFrame(fixture.game.level.time + 100);

    expect(client.ps.powerups[PW.QUAD]).toBe(0);
  });

  it('hurts a client that lands hard, through the life around the move', () => {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 500))) });
    fixture.traps.world = createFlatWorldTrace();
    fixture.game.clientConnect(0, true, false);
    fixture.game.clientBegin(0);
    const client = fixture.game.level.clients[0];
    const full = client.ps.stats[STAT.HEALTH];

    for (let i = 0; i < 200; i++) {
      const time = fixture.game.level.time + PMOVE_MSEC;
      const cmd = createNetUserCmd();
      cmd.serverTime = time;
      fixture.traps.cmds.set(0, cmd);
      fixture.game.clientThink(0);
      fixture.game.runFrame(time);
    }

    expect(client.ps.origin.z).toBeCloseTo(GROUND_Z, 0);
    expect(client.ps.stats[STAT.HEALTH]).toBeLessThan(full);
    // `P_DamageFeedback`, which `ClientEndFrame` runs: a fall has no direction, so it is centred.
    expect(client.ps.damageCount).toBeGreaterThan(0);
    expect(client.ps.damageYaw).toBe(255);
  });

  it('leaves a body on the level when a client dies and comes back', () => {
    const { client, game, run } = standing();
    const before = client.ps.persistant[PERS.SPAWN_COUNT];

    // Dead, but not in pieces: a gibbed player leaves a body nobody can see.
    client.ps.stats[STAT.HEALTH] = 1;
    hurt(game, 0, 10);
    run(1);
    expect(client.ps.pmType).toBe(PM_DEAD);
    expect(corpses(game)).toHaveLength(0);

    // The death has to have played before attack brings the player back.
    run(300, { buttons: BUTTON_ATTACK });

    const [body] = corpses(game);
    expect(body.s.eType).toBe(ET.PLAYER);
    expect(body.r.ownerNum).toBe(0);
    expect(client.ps.persistant[PERS.SPAWN_COUNT]).toBe(before + 1);
    expect(client.ps.stats[STAT.HEALTH]).toBe(100 + SPAWN_HEALTH_BONUS);
    expect(client.ps.pmType).toBe(PM_NORMAL);
  });

  it("blows a corpse apart with the player's own blast, where the corpse lies", () => {
    const { client, game, run, traps } = standing();
    client.ps.stats[STAT.HEALTH] = 1;
    hurt(game, 0, 10);
    run(300, { buttons: BUTTON_ATTACK });
    const [body] = corpses(game);
    expect(body.s.eType).toBe(ET.PLAYER);

    // `G_RadiusDamage` finds a body by the box the host linked it with, so a blast at its middle
    // reaches it — and the gib rides on the corpse's own entity rather than on the player's.
    const { x, y, z } = body.r.currentOrigin;
    const player = game.level.gentities[0];
    const blast = vec3(x, y, z - 16);
    radiusDamage(game.level, traps.world, blast, player, 60, 120, null, MOD.ROCKET_SPLASH);

    // `GibEntity` leaves the body where it is, out of the world's way and with nothing to draw:
    // it is still in its slot, and still sinking, until the queue comes round to it again.
    expect(body.s.eType).toBe(ET.INVISIBLE);
    expect(body.r.contents).toBe(0);
    expect(body.takedamage).toBe(false);
    expect(eventNumber(body.s.event)).toBe(EV.GIB_PLAYER);
    expect(body.s.eventParm).toBe(0);
  });

  it('sinks a corpse away from the frame, with nobody thinking for it', () => {
    const { client, game, run } = standing();
    client.ps.stats[STAT.HEALTH] = 1;
    hurt(game, 0, 50);
    run(300, { buttons: BUTTON_ATTACK });
    expect(corpses(game)).toHaveLength(1);

    // A corpse is an entity, so `G_RunFrame` runs it with everything else in the world: the
    // frames below carry no command at all, and it sinks away anyway.
    const until = game.level.time + 7000;
    while (game.level.time < until) game.runFrame(game.level.time + PMOVE_MSEC);
    expect(corpses(game)).toHaveLength(0);
  });

  describe('the off-hand hook', () => {
    /** A wall across the spawn's facing, 500 units out, for a hook to catch. */
    const WALL = box(500, -400, 0, 520, 400, 600);

    /** The grapple key: CorkScrew's `+button5`, which is bit 5 of a command's buttons. */
    const HOOK = { buttons: BUTTON_AFFIRMATIVE };

    /** A client on a floor facing a wall, with the grapple style `g_allowGrapple` names. */
    function grappler(type: string) {
      const fixture = standing({ g_allowGrapple: type });
      fixture.traps.world = createFlatWorldTrace([WALL]);
      return fixture;
    }

    /** The hook this client has out, or undefined — `client->hook` names its slot. */
    function hookOf(game: Game, clientNum = 0) {
      const slot = game.level.clients[clientNum].hook;
      return slot < 0 ? undefined : game.level.gentities[slot];
    }

    /** Hold the key until the hook catches the wall, and say how it went. */
    function catchWall(fixture: ReturnType<typeof grappler>): void {
      for (let tick = 0; tick < 120; tick++) {
        fixture.run(1, HOOK);
        if (hookOf(fixture.game)?.s.eType === ET.GRAPPLE) return;
      }
      throw new Error('the hook never caught the wall');
    }

    it('is thrown by a bit of the command rather than by the weapon in hand', () => {
      const { game, client, run } = grappler('1');
      const weapon = client.ps.weapon;

      run(1, HOOK);

      const hook = hookOf(game)!;
      expect(hook.s.eType).toBe(ET.MISSILE);
      expect(hook.s.weapon).toBe(WP.GRAPPLING_HOOK);
      // "Use to match beam in client": which client's cable this is.
      expect(hook.s.otherEntityNum).toBe(0);
      // Off-hand: the weapon in hand never changes, and attack was never pressed.
      expect(client.ps.weapon).toBe(weapon);
    });

    it('throws nothing while the key is up, and one hook per press while it is down', () => {
      const { game, run } = grappler('1');
      run(10);
      expect(hookOf(game)).toBeUndefined();

      run(1, HOOK);
      const first = hookOf(game)!.s.number;
      run(10, HOOK);
      expect(hookOf(game)!.s.number).toBe(first);
    });

    it('catches the wall and hauls the player toward it, in the style the cvar named', () => {
      const fixture = grappler('1');
      catchWall(fixture);
      expect(fixture.client.ps.pmFlags & PMF_GRAPPLE_PULL).toBeTruthy();

      // The move is told which pull to run, and CorkScrew's accelerates toward the anchor at
      // 128 a tick where Quake III's `PM_GrappleMove` is at its full 800 the moment the hook
      // lands. A move that had not been told would run Quake III's.
      fixture.run(1, HOOK);
      const { x, y } = fixture.client.ps.velocity;
      expect(Math.hypot(x, y)).toBeLessThan(300);

      const before = fixture.client.ps.origin.x;
      fixture.run(20, HOOK);
      expect(fixture.client.ps.origin.x).toBeGreaterThan(before);
    });

    it("throws CorkScrew's where nothing has named a style, which is the table's own default", () => {
      const { game, run } = standing();
      run(1, HOOK);

      const hook = hookOf(game)!;
      expect(hook.s.weapon).toBe(WP.GRAPPLING_HOOK);
      // CorkScrew's hook flies at 1,600, where Quake III's flies at 800 and Quake II CTF's at 650.
      expect(hook.s.pos.trDelta.x).toBeCloseTo(1600, 0);
    });

    it('lets go the tick the key comes up, before the move rather than after it', () => {
      const fixture = grappler('1');
      catchWall(fixture);

      fixture.run(1);
      expect(hookOf(fixture.game)).toBeUndefined();
      expect(fixture.client.ps.pmFlags & PMF_GRAPPLE_PULL).toBeFalsy();
    });

    it("winches after the move, where Quake II CTF's own pull runs", () => {
      // `CTFGrapplePull` hard-sets the velocity once pmove has had its say, so the speed is the
      // pull's rather than anything the move produced.
      const fixture = grappler('3');
      catchWall(fixture);
      fixture.run(1, HOOK);

      const { x, y, z } = fixture.client.ps.velocity;
      expect(Math.hypot(x, y, z + fixture.client.ps.gravity * 0.008)).toBeCloseTo(650, 6);
    });

    it('throws none at all with the hook turned off', () => {
      const { game, run } = grappler('0');
      run(20, HOOK);
      expect(hookOf(game)).toBeUndefined();
    });

    it('takes a new g_allowGrapple at the think, once the hook that is out comes back', () => {
      // Read where `g_speed` and `g_gravity` are read, so it is live as they are — but a hook
      // finishes as it was thrown.
      const fixture = grappler('1');
      fixture.run(1, HOOK);
      const corkscrew = hookOf(fixture.game)!.s.pos.trDelta.x;

      fixture.cvars.set('g_allowGrapple', '3');
      fixture.run(10, HOOK);
      expect(hookOf(fixture.game)!.s.pos.trDelta.x).toBe(corkscrew);

      fixture.run(1);
      fixture.run(1, HOOK);
      // Quake II CTF's hook flies at 650 where CorkScrew's flies at 1,600.
      expect(hookOf(fixture.game)!.s.pos.trDelta.x).toBeCloseTo(650, 0);
    });

    it('throws into the match that is running, not the one before it', () => {
      // A `map_restart` builds a new match, and the hooks belong to it as the lives and the
      // weapons do: one left pointing at the match before would throw into a world nobody is in.
      const fixture = grappler('1');
      fixture.game.shutdown(true);
      fixture.traps.restartEntities();
      fixture.game.init(fixture.game.level.time, 1, true);
      fixture.game.clientConnect(0, false, false);
      fixture.game.clientBegin(0);

      fixture.run(1, HOOK);

      const hook = hookOf(fixture.game);
      expect(hook).toBeDefined();
      expect(fixture.game.level.gentities[hook!.s.number]).toBe(hook);
    });

    it('is let go by player_die, and a dead player throws no other', () => {
      // `g_combat.c:455–457`, before the death itself: the pull is on the player state, so a
      // hook left out would go on hauling the corpse about.
      const fixture = grappler('1');
      catchWall(fixture);
      const { client, game } = fixture;

      client.ps.stats[STAT.HEALTH] = 5;
      hurt(game, 0, 50);
      expect(client.ps.pmType).toBe(PM_DEAD);
      expect(hookOf(game)).toBeUndefined();
      expect(client.ps.pmFlags & PMF_GRAPPLE_PULL).toBeFalsy();

      fixture.run(20, HOOK);
      expect(hookOf(game)).toBeUndefined();
    });
  });
});

describe('the game module behind a host', () => {
  let host: Host;
  let game: Game;
  let connection: ClientConnection;

  beforeEach(() => {
    const cvars = store();
    host = fixtureHost({
      cvars,
      maxclients: 4,
      game: (h) => {
        game = new Game({ traps: h, cvars, maxclients: 4, random: () => 0 });
        return game;
      }
    });
    host.spawnServer({ name: 'test', entities: ORIGIN_MAP });
    connection = new ClientConnection(testCvars());
  });

  it("spawns the map's entities again on a restart, from the start of its text", () => {
    const count = () => {
      let n = 0;
      for (let spot = game.level.find(null, 'classname', 'info_player_deathmatch'); spot; n++) {
        spot = game.level.find(spot, 'classname', 'info_player_deathmatch');
      }
      return n;
    };
    expect(count()).toBe(1);
    host.mapRestart(0);
    expect(count()).toBe(1);
  });

  it('gives the local client a spawn it learns about only by decoding a snapshot', () => {
    connectLocal(host, connection, '\\name\\Sarge');

    // The first user command is what puts the client in the world, and after that the only thing
    // it is ever told is a snapshot.
    sendMove(host, connection, [createNetUserCmd()]);
    host.runFrame(host.clients[0].snapshotMsec + host.frameMsec);
    drain(host, connection);

    const snap = connection.snapshots.snap;
    expect(snap.valid).toBe(true);
    expect(snap.ps.clientNum).toBe(0);
    expect(snap.ps.stats[STAT.HEALTH]).toBe(100 + SPAWN_HEALTH_BONUS);
    expect(snap.ps.stats[STAT.WEAPONS]).toBe(game.level.clients[0].ps.stats[STAT.WEAPONS]);
    expect(snap.ps.persistant[PERS.SPAWN_COUNT]).toBe(1);

    // Its own body is not among the entities: everything about it is already in the player
    // state, so sending it twice would only be a second copy to disagree with the first. What is
    // there is the arrival's effect, where it stands.
    const entities = connection.snapshots.entities();
    expect(entities).toHaveLength(1);
    expect(entities[0].eType).toBe(ET.EVENTS + EV.PLAYER_TELEPORT_IN);
    expect(entities[0].pos.trBase).toEqual(snap.ps.origin);
  });

  it('tells the local client what its own move did, through the ring on its player state', () => {
    const cvars = store();
    const ground = fixtureHost({
      cvars,
      maxclients: 4,
      game: (h) =>
        new Game({
          traps: h,
          cvars,
          maxclients: 4,
          random: () => 0
        })
    });
    ground.spawnServer({
      name: 'test',
      entities: mapOf(spawnSpot(vec3(0, 0, 20))),
      trace: createFlatWorldTrace()
    });
    const player = new ClientConnection(testCvars());
    connectLocal(ground, player, '\\name\\Sarge');

    // Standing still until the spawn's 100 ms hold is over, then jump.
    const send = (upmove: number) => {
      const cmd = createNetUserCmd();
      cmd.serverTime = ground.time + ground.frameMsec;
      cmd.upmove = upmove;
      sendMove(ground, player, [cmd]);
      ground.runFrame(ground.frameMsec);
    };
    for (let i = 0; i < 20; i++) send(0);
    send(127);
    // A snapshot goes at the client's own rate, every 56 ms of frames under `snaps` 20, so the
    // frames run on until one has gone since the jump.
    for (let i = 0; i < 7; i++) ground.runFrame(ground.frameMsec);
    drain(ground, player);

    // The jump is not something the client is told about in words: it reads it out of the ring
    // on the player state the snapshot carried, at the sequence the snapshot carried too.
    const { ps } = player.snapshots.snap;
    expect(ps.eventSequence).toBeGreaterThan(0);
    expect(eventsSince(ps, ps.eventSequence - 1)).toEqual([{ event: EV.JUMP, parm: 0 }]);
    expect(ps.groundEntityNum).toBe(ENTITYNUM_NONE);
  });

  it("stands a BSP's pad on its brush from the host's collision, and launches who falls in", () => {
    const cvars = store();
    let match: Game | null = null;
    const host = fixtureHost({
      cvars,
      maxclients: 4,
      game: (h) => {
        match = new Game({ traps: h, cvars, maxclients: 4, random: () => 0 });
        return match;
      }
    });
    const entities = mapOf(
      spawnSpot(vec3(50, 50, 40)),
      { classname: 'trigger_push', model: '*1', target: 'apex' },
      { classname: 'target_position', targetname: 'apex', origin: '232 32 108' }
    );
    const bsp = bspFile(triggerBsp({ entityString: `${entities}\0` }));
    host.spawnServer(hostMapFromData({ kind: 'bsp', name: 'trigger', bsp: bsp.slice().buffer }));
    const game = match!;
    const pad = game.level.find(null, 'classname', 'trigger_push')!;

    // Its brush, and aimed by the time anyone sees it, in the settle frames.
    expect([pad.r.bmodel, pad.s.modelindex]).toEqual([true, 1]);
    expect(pad.s.origin2).toEqual(vec3(400, 0, 400));
    // `SV_PointContents` reads the trigger's brush, solid as q3map makes it, but not its cut.
    expect(host.pointContents(vec3(10, 10, 8), -1)).toBe(CONTENTS.SOLID);
    expect(host.pointContents(vec3(60, 60, 8), -1)).toBe(0);

    const player = new ClientConnection(testCvars());
    connectLocal(host, player, '\\name\\Sarge');
    const { ps } = game.level.clients[0];
    let launched = false;
    for (let i = 0; i < 40 && !launched; i++) {
      const cmd = createNetUserCmd();
      cmd.serverTime = host.time + host.frameMsec;
      sendMove(host, player, [cmd]);
      host.runFrame(host.frameMsec);
      launched = ps.jumppadEnt === pad.s.number;
    }
    expect(launched).toBe(true);
    expect(ps.velocity).toEqual(vec3(400, 0, 400));
  });

  it('sends a corpse as an entity, which is the only way a client is ever shown one', () => {
    const cvars = store();
    let match: Game;
    const ground = fixtureHost({
      cvars,
      maxclients: 4,
      game: (h) => {
        match = new Game({
          traps: h,
          cvars,
          maxclients: 4,
          random: () => 0
        });
        return match;
      }
    });
    ground.spawnServer({
      name: 'test',
      entities: mapOf(spawnSpot(vec3(0, 0, 20))),
      trace: createFlatWorldTrace()
    });
    const player = new ClientConnection(testCvars());
    connectLocal(ground, player, '\\name\\Sarge');

    /** One command, as a client sends one: attack held is what brings a dead player back. */
    const send = (buttons: number): void => {
      const cmd = createNetUserCmd();
      cmd.serverTime = ground.time + ground.frameMsec;
      cmd.buttons = buttons;
      sendMove(ground, player, [cmd]);
      ground.runFrame(ground.frameMsec);
    };

    // Stand until the spawn is settled, then die without being gibbed, then come back.
    for (let i = 0; i < 20; i++) send(0);
    const client = match!.level.clients[0];
    client.ps.stats[STAT.HEALTH] = 1;
    hurt(match!, 0, 10);
    for (let i = 0; i < 300; i++) send(BUTTON_ATTACK);
    drain(ground, player);

    // The client is never told that somebody died. It is sent an entity, reads `ET_PLAYER` with
    // `EF_DEAD` on it, and draws a corpse — which is what makes a body a thing in the world.
    const corpse = player.snapshots
      .entities()
      .find((state) => state.eType === ET.PLAYER && (state.eFlags & EF_DEAD) !== 0);
    expect(corpse).toBeDefined();
    expect(corpse!.number).toBeGreaterThanOrEqual(MAX_CLIENTS);
    expect(corpse!.legsAnim).toBe(corpse!.torsoAnim);
    expect(corpse!.pos.trBase.z).toBeCloseTo(24, 0);
    // Its own player state says it is alive again, in the same snapshot.
    expect(player.snapshots.snap.ps.stats[STAT.HEALTH]).toBe(100 + SPAWN_HEALTH_BONUS);
  });

  it('moves the local client through the world the host was given, and says so in a snapshot', () => {
    const cvars = store();
    const ground = fixtureHost({
      cvars,
      maxclients: 4,
      game: (h) =>
        new Game({
          traps: h,
          cvars,
          maxclients: 4,
          random: () => 0
        })
    });
    ground.spawnServer({
      name: 'test',
      entities: mapOf(spawnSpot(vec3(0, 0, 20))),
      trace: createFlatWorldTrace()
    });
    const player = new ClientConnection(testCvars());
    connectLocal(ground, player, '\\name\\Sarge');

    // Most of a second of walking forward, one command per frame, as a client sends them.
    for (let i = 0; i < 100; i++) {
      const cmd = createNetUserCmd();
      cmd.serverTime = ground.time + ground.frameMsec;
      cmd.forwardmove = 127;
      sendMove(ground, player, [cmd]);
      ground.runFrame(ground.frameMsec);
    }
    drain(ground, player);

    // The client is told where it is only by the snapshot, and where it is comes from the world
    // the host traces: standing on it, and further along than it started.
    const { ps } = player.snapshots.snap;
    expect(ps.groundEntityNum).toBe(ENTITYNUM_WORLD);
    expect(ps.origin.z).toBeCloseTo(24, 0);
    expect(ps.origin.x).toBeGreaterThan(150);
  });

  it('sends one client the body of another, spawned by the game module', () => {
    const local = connectLocal(host, connection, '\\name\\Sarge');
    sendMove(host, connection, [createNetUserCmd()]);

    const other = connectRemote(host, '\\name\\Grunt');
    host.clientEnterWorld(other, null);

    host.runFrame(host.clients[0].snapshotMsec + host.frameMsec);
    drain(host, connection);

    const entities = connection.snapshots.entities();
    const bodies = entities.filter((e) => e.eType === ET.PLAYER);
    expect(bodies.map((e) => e.clientNum)).toEqual([other]);
    expect(bodies[0].weapon).toBe(WP.MACHINEGUN);
    // The map has one spot, so Grunt arrived on top of Sarge and telefragged them, and everyone
    // is sent the obituary that says so.
    const obituary = entities.find((e) => e.eType === ET.EVENTS + EV.OBITUARY);
    expect(obituary).toMatchObject({
      eventParm: MOD.TELEFRAG,
      otherEntityNum: local,
      otherEntityNum2: other
    });
  });

  it("sends one client another's event on that other client's entity state", () => {
    connectLocal(host, connection, '\\name\\Sarge');
    sendMove(host, connection, [createNetUserCmd()]);

    const other = connectRemote(host, '\\name\\Grunt');
    host.clientEnterWorld(other, null);

    // Hurt the other client where the game module would, so the event goes on their player state
    // as `G_AddEvent` puts a client's events there. The pain debounce starts at zero, which the
    // match's clock is long past, so the hit is worth a sound.
    hurt(game, other, 20);

    host.runFrame(host.clients[0].snapshotMsec + host.frameMsec);
    drain(host, connection);

    // Sarge never sees Grunt's player state — nobody but Grunt does. What reaches Sarge is the
    // entity state `BG_PlayerStateToEntityState` built out of it, with the event copied across.
    const [grunt] = connection.snapshots.entities();
    expect(grunt.clientNum).toBe(other);
    expect(eventNumber(grunt.event)).toBe(EV.PAIN);
    expect(grunt.eventParm).toBe(game.level.clients[other].ps.stats[STAT.HEALTH]);
  });

  it('names the local client localhost, so it is never asked for a password', () => {
    connectLocal(host, connection, '\\name\\Sarge');
    expect(game.level.clients[0].pers.localClient).toBe(true);
  });

  it('publishes the scoreboard row through the host’s configstrings', () => {
    const clientNum = connectLocal(host, connection, '\\name\\Sarge');
    host.clientEnterWorld(clientNum, null);

    expect(host.getConfigstring(CONFIGSTRING.PLAYERS + clientNum)).toContain('n\\Sarge');
  });

  it('asks the host for the restart its warmup ends in', () => {
    const cvars = store({ g_doWarmup: '1', g_warmup: '2' });
    const warmup = fixtureHost({
      cvars,
      maxclients: 4,
      game: (h) => new Game({ traps: h, cvars, maxclients: 4, random: () => 0 })
    });
    warmup.spawnServer({ name: 'test', entities: ORIGIN_MAP });

    for (const name of ['Sarge', 'Grunt']) {
      warmup.clientEnterWorld(connectRemote(warmup, `\\name\\${name}`), null);
    }
    expect(warmup.getConfigstring(CONFIGSTRING.WARMUP)).toBe('-1');

    warmup.runFrame(2000);

    expect(warmup.commandQueue).toEqual(['map_restart 0']);
    expect(cvars.get('g_restarted')).toBe('1');
  });

  it('carries a session across a map_restart and leaves the persistent data behind', () => {
    const clientNum = connectLocal(host, connection, '\\name\\Sarge');
    host.clientEnterWorld(clientNum, null);
    game.level.clients[clientNum].sess.wins = 3;
    game.level.clients[clientNum].ps.persistant[PERS.SCORE] = 7;

    host.mapRestart(0);

    // The session went out to a cvar and came back through the connect; nothing else did.
    expect(game.level.clients[clientNum].sess.wins).toBe(3);
    expect(game.level.clients[clientNum].ps.persistant[PERS.SCORE]).toBe(0);
  });

  it('hands a tournament round on to whoever was waiting in the queue', () => {
    const cvars = store({ timelimit: '1' });
    let roundGame!: Game;
    const rounds = fixtureHost({
      cvars,
      maxclients: 3,
      game: (h) =>
        (roundGame = new Game({
          traps: h,
          cvars,
          maxclients: 3,
          gametype: GT.TOURNAMENT,
          random: () => 0
        }))
    });
    rounds.spawnServer({ name: 'test', entities: ORIGIN_MAP });

    const slots = ['Sarge', 'Grunt', 'Bones'].map((name) => {
      const clientNum = connectRemote(rounds, `\\name\\${name}`);
      rounds.clientEnterWorld(clientNum, null);
      return clientNum;
    });
    const [sarge, grunt, bones] = slots;
    // A tournament seats two, so the third arrival waits.
    expect(roundGame.level.clients[bones].sess.sessionTeam).toBe(TEAM.SPECTATOR);

    roundGame.level.clients[sarge].ps.persistant[PERS.SCORE] = 1;
    roundGame.level.clients[grunt].ps.persistant[PERS.SCORE] = 0;
    roundGame.calculateRanks();

    // The time limit ends the round and the intermission comes up.
    rounds.runFrame(60_000);
    rounds.runFrame(61_000);
    expect(roundGame.level.intermissiontime).toBe(61_000);

    // Leaving it sends the loser to the back of the queue and asks for the same map again, which
    // is the host's to do.
    roundGame.exitLevel();
    expect(rounds.commandQueue).toContain('map_restart 0');
    rounds.mapRestart(0);
    rounds.runFrame(1000);

    // The winner stays on, and the round that comes back is against whoever had been waiting.
    expect(roundGame.level.clients[sarge].sess.sessionTeam).toBe(TEAM.FREE);
    expect(roundGame.level.clients[bones].sess.sessionTeam).toBe(TEAM.FREE);
    expect(roundGame.level.clients[grunt].sess.sessionTeam).toBe(TEAM.SPECTATOR);
  });

  it('runs a warmup through its restart into a match being played', () => {
    const cvars = store({ g_doWarmup: '1', g_warmup: '2' });
    let warmupGame!: Game;
    const warmup = fixtureHost({
      cvars,
      maxclients: 4,
      game: (h) => {
        warmupGame = new Game({ traps: h, cvars, maxclients: 4, random: () => 0 });
        return warmupGame;
      }
    });
    warmup.spawnServer({ name: 'test', entities: ORIGIN_MAP });
    for (const name of ['Sarge', 'Grunt']) {
      warmup.clientEnterWorld(connectRemote(warmup, `\\name\\${name}`), null);
    }

    // The countdown runs out and asks for the restart; the frame after is what runs it.
    warmup.runFrame(2000);
    expect(warmupGame.level.restarted).toBe(true);
    warmup.runFrame(8);

    expect(warmupGame.level.warmupTime).toBe(0);
    expect(warmupGame.level.restarted).toBe(false);
    // The flag is spent by the map that reads it, so the match that follows warms up no further.
    expect(cvars.get('g_restarted')).toBe('0');
    expect(warmup.getConfigstring(CONFIGSTRING.WARMUP)).toBe('');
    // A restart sends no gamestate, so the configstrings it changes have to reach the clients
    // as commands of their own.
    expect(warmup.clients[0].reliableCommands).toContain(`cs ${CONFIGSTRING.WARMUP} ""`);
  });

  it('runs a match out, watches it, and starts the next one on the same map', () => {
    const cvars = store({ timelimit: '1' });
    let match!: Game;
    const arena = fixtureHost({
      cvars,
      maxclients: 4,
      game: (h) => {
        match = new Game({ traps: h, cvars, maxclients: 4, random: () => 0 });
        return match;
      }
    });
    arena.spawnServer({ name: 'test', entities: ORIGIN_MAP });

    const player = new ClientConnection(testCvars());
    const clientNum = connectLocal(arena, player, '\\name\\Sarge');
    sendMove(arena, player, [createNetUserCmd()]);

    // A minute of match, and the time limit ends it.
    arena.runFrame(61_000);
    expect(match.level.intermissiontime).toBeGreaterThan(0);
    expect(match.level.clients[clientNum].ps.pmType).toBe(PM_INTERMISSION);

    // The one player watching says it is done with, which is what the fire button means here.
    const fire = createNetUserCmd();
    fire.buttons = BUTTON_ATTACK;
    fire.serverTime = arena.time;
    sendMove(arena, player, [fire]);
    expect(match.level.clients[clientNum].readyToExit).toBe(true);

    // Past the five second floor, the match asks the host for whatever comes next — which on a
    // server nobody has given a rotation is this map again.
    arena.runFrame(6000);
    expect(arena.commandQueue).toEqual(['vstr nextmap']);

    // The restart runs before the frame simulates anything, so the new match starts its clock
    // exactly where the old one stopped.
    const restartAt = arena.time;
    arena.runFrame(8);

    expect(match.level.intermissiontime).toBe(0);
    expect(match.level.startTime).toBe(restartAt);
    expect(match.level.clients[clientNum].pers.connected).toBe(CON.CONNECTED);
    expect(match.level.clients[clientNum].ps.persistant[PERS.SCORE]).toBe(0);
  });

  it('gives the slot back when the host drops the client', () => {
    const clientNum = connectLocal(host, connection, '\\name\\Sarge');
    host.clientEnterWorld(clientNum, null);
    expect(game.level.numConnectedClients).toBe(1);

    host.dropClient(clientNum, 'testing');

    expect(game.level.clients[clientNum].pers.connected).toBe(CON.DISCONNECTED);
    expect(game.level.numConnectedClients).toBe(0);
  });
});

describe('a bot', () => {
  /** The bot files, as `scripts/bots.txt` writes them. */
  const BOT_FILES = [
    {
      path: 'scripts/bots.txt',
      text: [
        '{ name Sarge model sarge aifile bots/sarge_c.c }',
        '{ name Grunt model grunt aifile bots/grunt_c.c }'
      ].join('\n')
    }
  ];

  let host: Host;
  let game: Game;
  let cvars: ReturnType<typeof store>;
  let lines: string[];

  function makeHost(values: Record<string, string> = {}, maxclients = 4, dedicated = false): void {
    cvars = store(values);
    lines = [];
    host = fixtureHost({
      cvars,
      maxclients,
      dedicated,
      print: (text) => lines.push(text),
      game: (h) => {
        game = new Game({ traps: h, cvars, maxclients, random: () => 0, botFiles: BOT_FILES });
        return game;
      }
    });
    host.spawnServer({
      name: 'test',
      entities: mapOf(spawnSpot(vec3(0, 0, 0)), spawnSpot(vec3(500, 0, 0)))
    });
  }

  /** The local client, all the way into the world, as the program brings it. */
  function joinLocal(): number {
    const connection = new ClientConnection(testCvars());
    const clientNum = connectLocal(host, connection, '\\name\\Me');
    const cmd = createNetUserCmd();
    cmd.serverTime = host.time + host.frameMsec;
    sendMove(host, connection, [cmd]);
    return clientNum;
  }

  /** Type a console command, and run the frame that runs it. */
  function enter(command: string): void {
    host.sendConsoleCommand(`${command}\n`);
    host.runFrame(host.frameMsec);
  }

  beforeEach(() => makeHost());

  it('joins from addbot, as the bot its block describes', () => {
    joinLocal();
    enter('addbot sarge');

    const bot = game.entity(1);
    expect(bot.r.svFlags & SVF.BOT).not.toBe(0);
    expect(game.level.clients[1].pers.connected).toBe(CON.CONNECTED);
    expect(bot.r.linked).toBe(true);
    const cs = host.getConfigstring(CONFIGSTRING.PLAYERS + 1);
    expect(infoValueForKey(cs, 'n')).toBe('Sarge');
    expect(infoValueForKey(cs, 'model')).toBe('sarge');
    expect(infoValueForKey(cs, 'skill')).toBe('4.00');
    expect(host.clients[1].name).toBe('Sarge');
    expect(lines).toContain('2 bots parsed');
  });

  it("has clients load its look at once, added a second into a match beside a player's own", () => {
    joinLocal();
    const sent = vi.spyOn(host, 'sendServerCommand');
    // To every client at once, which the host hands to each in turn.
    const loads = () =>
      sent.mock.calls.filter(([to, text]) => to === null && text === 'loaddefered\n');
    enter('addbot sarge');
    expect(loads()).toEqual([]);

    // A second on, after the bot's own string, as `ClientConnect` sends it.
    for (let i = 0; i * host.frameMsec <= 1000; i++) host.runFrame(host.frameMsec);
    enter('addbot grunt');
    expect(loads()).toEqual([[null, 'loaddefered\n']]);
    const texts = sent.mock.calls.map(([, text]) => text);
    const string = texts.findIndex((text) => text.startsWith(`cs ${CONFIGSTRING.PLAYERS + 2} `));
    expect(string).toBeGreaterThanOrEqual(0);
    expect(string).toBeLessThan(texts.indexOf('loaddefered\n'));
  });

  it('leaves a dedicated server to say nothing of it, there being no player of its own', () => {
    makeHost({}, 4, true);
    joinLocal();
    for (let i = 0; i * host.frameMsec <= 1000; i++) host.runFrame(host.frameMsec);
    const sent = vi.spyOn(host, 'sendServerCommand');
    enter('addbot grunt');
    expect(sent.mock.calls.map(([, text]) => text)).not.toContain('loaddefered\n');
  });

  it('counts as a client and a player, and not as a voter', () => {
    joinLocal();
    enter('addbot grunt');

    const { level } = game;
    expect(level.numConnectedClients).toBe(2);
    expect(level.numNonSpectatorClients).toBe(2);
    expect(level.numPlayingClients).toBe(2);
    expect(level.numVotingClients).toBe(1);
  });

  it('is a player to a tournament, which starts counting down with it', () => {
    makeHost({ g_gametype: String(GT.TOURNAMENT) });
    joinLocal();
    host.runFrame(host.frameMsec);
    expect(game.level.warmupTime).toBe(-1);

    enter('addbot sarge');
    host.runFrame(host.frameMsec);

    expect(game.level.warmupTime).toBeGreaterThan(0);
  });

  it('moves on the frame rather than on its commands', () => {
    enter('addbot sarge');
    const ps = game.level.clients[0].ps;
    const start = ps.origin.z;

    for (let i = 0; i < 50; i++) host.runFrame(host.frameMsec);

    expect(ps.origin.z).toBeLessThan(start - 50);
    expect(ps.commandTime).toBe(game.level.time);
  });

  it('keeps a command it is sent between frames for the next frame to run', () => {
    enter('addbot sarge');
    const ps = game.level.clients[0].ps;
    const before = ps.commandTime;
    const cmd = createNetUserCmd();
    cmd.serverTime = game.level.time + 100;

    host.botUserCommand(0, cmd);
    expect(ps.commandTime).toBe(before);

    host.runFrame(host.frameMsec);
    expect(ps.commandTime).toBe(game.level.time);
  });

  it('reads what it is sent, so however much it is sent it stays', () => {
    enter('addbot sarge');
    for (let i = 0; i < 200; i++) {
      host.sendServerCommand(null, `print "${i}"`);
      if (i % 10 === 0) host.runFrame(host.frameMsec);
    }
    host.runFrame(host.frameMsec);
    expect(host.clients[0].state).toBe(CS.ACTIVE);
  });

  it('is sent the last command it was sent each frame, which it keeps running', () => {
    enter('addbot sarge');
    const held = createNetUserCmd();
    Object.assign(held, { forwardmove: 127, buttons: 1, weapon: WP.SHOTGUN, angles: [100, 0, 0] });
    held.serverTime = game.level.time + host.frameMsec;
    host.botUserCommand(0, held);

    for (let i = 0; i < 3; i++) host.runFrame(host.frameMsec);
    expect(host.getUserCmd(0)).toEqual({ ...held, serverTime: host.time });
  });

  it('is held by bot_pause, which stills its command each frame and reads it nothing', () => {
    enter('addbot sarge');
    const held = createNetUserCmd();
    Object.assign(held, { forwardmove: 127, buttons: 1, weapon: WP.SHOTGUN, angles: [100, 0, 0] });
    held.serverTime = game.level.time + host.frameMsec;
    host.botUserCommand(0, held);
    cvars.set('bot_pause', '1');

    host.runFrame(host.frameMsec);
    const cmd = host.getUserCmd(0);
    expect(cmd.serverTime).toBe(host.time);
    expect([cmd.forwardmove, cmd.rightmove, cmd.upmove, cmd.buttons]).toEqual([0, 0, 0, 0]);
    // Only the move and the buttons: it looks where it did, with the gun it asked for.
    expect([cmd.angles, cmd.weapon]).toEqual([[100, 0, 0], WP.SHOTGUN]);

    // So it is dropped once 64 go unread, as a paused bot is in Q3.
    for (let i = 0; i < 200 && host.clients[0].state !== CS.FREE; i++) {
      host.sendServerCommand(null, `print "${i}"`);
      if (i % 10 === 0) host.runFrame(host.frameMsec);
    }
    expect(host.clients[0].state).toBe(CS.FREE);
  });

  it('is sent a command each frame, paused or not, so it never wears the connection sprite', () => {
    const me = joinLocal();
    enter('addbot sarge');
    const bot = me + 1;
    for (let t = 0; t < 2000; t += host.frameMsec) host.runFrame(host.frameMsec);
    expect(game.level.clients[bot].ps.eFlags & EF_CONNECTION).toBe(0);
    // The local client has sent nothing since it came in.
    expect(game.level.clients[me].ps.eFlags & EF_CONNECTION).toBe(EF_CONNECTION);

    cvars.set('bot_pause', '1');
    for (let t = 0; t < 2000; t += host.frameMsec) host.runFrame(host.frameMsec);
    expect(game.level.clients[bot].ps.eFlags & EF_CONNECTION).toBe(0);
  });

  it('waits out the delay addbot gives it before it begins, unless it is kicked first', () => {
    enter('addbot sarge 4 free 500');
    expect(game.level.clients[0].pers.connected).toBe(CON.CONNECTING);

    // The delay is on the level's clock, which the map's last settle frame left 100 ms behind the
    // server's: the bot begins 400 ms of frames on.
    for (let t = 0; t < 392; t += host.frameMsec) host.runFrame(host.frameMsec);
    expect(game.level.clients[0].pers.connected).toBe(CON.CONNECTING);
    host.runFrame(host.frameMsec);
    expect(game.level.clients[0].pers.connected).toBe(CON.CONNECTED);

    enter('addbot grunt 4 free 500');
    enter('kick grunt');
    for (let t = 0; t < 1000; t += host.frameMsec) host.runFrame(host.frameMsec);
    expect(game.entity(1).inuse).toBe(false);
    expect(game.level.clients[1].pers.connected).toBe(CON.DISCONNECTED);
  });

  it('takes a skill, a team and a name to go by', () => {
    enter('addbot sarge 2 free 0 Dummy');
    const userinfo = host.getUserinfo(0);
    expect(infoValueForKey(userinfo, 'name')).toBe('Dummy');
    expect(infoValueForKey(userinfo, 'skill')).toBe('2.00');
    expect(infoValueForKey(userinfo, 'handicap')).toBe('70');
    expect(game.level.clients[0].ps.stats[STAT.MAX_HEALTH]).toBe(70);
  });

  it('prefers the team with fewer players in a team game, when addbot names none', () => {
    makeHost({ g_gametype: String(GT.TEAM) });
    enter('addbot sarge');
    expect(infoValueForKey(host.getUserinfo(0), 'teampref')).toBe('blue');
  });

  it('says why it cannot join, and gives the slot back', () => {
    enter('addbot doom');
    expect(lines).toContain("Error: Bot 'doom' not defined");
    expect(host.clients[0].state).toBe(CS.FREE);

    enter('addbot');
    expect(lines).toContain('Usage: Addbot <botname> [skill 1-5] [team] [msec delay] [altname]');

    makeHost({}, 1);
    enter('addbot sarge');
    enter('addbot grunt');
    expect(lines).toContain('Unable to add bot. All player slots are in use.');
  });

  it('is kept by a map load, and begins on the new map with its session', () => {
    enter('addbot sarge');
    game.level.clients[0].sess.wins = 3;

    host.spawnServer({ name: 'next', entities: mapOf(spawnSpot(vec3(0, 0, 0))) });

    expect(game.entity(0).r.svFlags & SVF.BOT).not.toBe(0);
    expect(game.level.clients[0].pers.connected).toBe(CON.CONNECTED);
    expect(game.level.clients[0].sess.wins).toBe(3);
  });

  it('is a command the app sends to the host, as the host sends it here', () => {
    expect(isGameCommand('AddBot')).toBe(true);
    expect(isGameCommand('kick')).toBe(false);
    expect(game.consoleCommand('say hello')).toBe(false);
  });
});

describe("players in each other's way", () => {
  const BOT_FILES = [
    {
      path: 'scripts/bots.txt',
      text: [
        '{ name Sarge model sarge aifile bots/sarge_c.c }',
        '{ name Grunt model grunt aifile bots/grunt_c.c }'
      ].join('\n')
    }
  ];
  /** Where a standing player's origin rests on the floor at z = 0. */
  const GROUND_Z = 24;
  /** A wall across +x, whose near face is at x = 300. */
  const WALL = box(300, -512, 0, 316, 512, 512);

  let host: Host;
  let game: Game;
  let cvars: ReturnType<typeof store>;
  /** Every trace the host was asked for, by who it passed and what it stopped at. */
  let asked: TraceAsk[];

  beforeEach(() => {
    cvars = store();
    // The testing loadout: these tests aim and fire guns the map would otherwise hand out.
    cvars.set('pcq_spawnWeapons', '1');
    const world = recordingTrace(createFlatWorldTrace([WALL]));
    asked = world.asked;
    host = fixtureHost({
      cvars,
      maxclients: 4,
      game: (h) => {
        game = new Game({ traps: h, cvars, maxclients: 4, random: () => 0, botFiles: BOT_FILES });
        return game;
      }
    });
    host.spawnServer({
      name: 'test',
      entities: mapOf(spawnSpot(vec3(0, 0, 20)), spawnSpot(vec3(0, 200, 20))),
      trace: world.trace
    });
    // Two held bots, in slots 0 and 1, standing on their spots.
    for (const name of ['sarge', 'grunt']) {
      host.sendConsoleCommand(`addbot ${name}\n`);
      host.runFrame(host.frameMsec);
    }
    frames(40);
  });

  function frames(count: number): void {
    for (let i = 0; i < count; i++) host.runFrame(host.frameMsec);
  }

  /** Stand a player at `origin`, at rest, where the world and their entity state have them too. */
  function put(clientNum: number, origin: Vec3): void {
    const { ps } = game.level.clients[clientNum];
    ps.origin = copy(origin);
    ps.velocity = vec3();
    const entity = game.entity(clientNum);
    entity.s.pos.trBase = copy(origin);
    entity.r.currentOrigin = copy(origin);
    host.linkEntity(entity);
  }

  /** Hold a command, which a bot runs at every frame until it is given another. */
  function hold(clientNum: number, input: Partial<NetUserCmd>): void {
    const cmd = createNetUserCmd();
    Object.assign(cmd, input, { serverTime: game.level.time + host.frameMsec });
    host.botUserCommand(clientNum, cmd);
  }

  /** Kill a player without gibbing them: their spawn's 125 health, and five more. */
  function kill(clientNum: number): void {
    hurt(game, clientNum, game.level.clients[clientNum].ps.stats[STAT.HEALTH] + 5);
  }

  /** A player's health, off their player state. */
  function health(clientNum: number): number {
    return game.level.clients[clientNum].ps.stats[STAT.HEALTH];
  }

  /** The temp entity the last shot of this kind left, if any. */
  function lastEvent(event: number): GameEntity | undefined {
    return game.level.gentities
      .slice(MAX_CLIENTS, game.level.numEntities)
      .filter((entity) => entity.inuse && entity.s.eType === ET.EVENTS + event)
      .at(-1);
  }

  it('brings a bot back on g_forcerespawn, and leaves it dead when that is 0', () => {
    // A bot presses nothing, so the forced respawn is the only way it ever comes back.
    cvars.set('g_forcerespawn', '5');
    kill(1);
    // 1.7 s of death and 5 s more, in 8 ms ticks.
    frames(900);
    expect(health(1)).toBe(125);

    cvars.set('g_forcerespawn', '0');
    kill(1);
    frames(3200);
    expect(health(1)).toBeLessThanOrEqual(0);
  });

  it('stops a player walking into another an epsilon short of them, and leaves them be', () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(100, 0, GROUND_Z));

    hold(0, { forwardmove: 127 });
    frames(125);

    const walker = game.level.clients[0].ps.origin;
    expect(walker.x).toBeCloseTo(100 - 30 - 0.125, 3);
    expect(game.level.clients[1].ps.origin.x).toBe(100);
  });

  it('stands a player on the head of another, who is what they stand on', () => {
    put(1, vec3(100, 0, GROUND_Z));
    frames(10);
    const below = game.level.clients[1].ps.origin.z;
    put(0, vec3(100, 0, below + 80));

    frames(125);

    const { ps } = game.level.clients[0];
    expect(ps.origin.z).toBeCloseTo(below + 32 + 24 + 0.125, 3);
    expect(ps.groundEntityNum).toBe(1);
  });

  it('links a player round their snapped origin, and keeps them at their exact one', () => {
    // `g_active.c:960–979`: a blast measures to the linked box, a trace clips at the origin.
    put(0, vec3(10.75, -20.5, GROUND_Z));
    frames(1);

    const entity = game.entity(0);
    const { origin } = game.level.clients[0].ps;
    expect(origin.x).toBe(10.75);
    expect(origin.y).toBe(-20.5);
    expect(entity.r.currentOrigin).toEqual(origin);
    expect(entity.r.absmin.x).toBe(10 - 15 - 1);
    expect(entity.r.absmin.y).toBe(-20 - 15 - 1);
  });

  it('gives the world the box a move ended in, so a crouching player is shot crouching', () => {
    hold(0, { upmove: -127 });
    frames(1);
    expect(game.entity(0).r.maxs.z).toBe(CROUCH_HEIGHT);

    // And standing up again is not stopped by the crouched box the player left in the world.
    hold(0, {});
    frames(1);
    expect(game.entity(0).r.maxs.z).toBe(32);
  });

  it('packs the box a move ended in for the clients to trace, and nothing of a corpse', () => {
    // `SV_LinkEntity`'s `s.solid`: 15 either way, 24 below, and the top plus 32.
    expect(game.entity(0).s.solid).toBe(((32 + 32) << 16) | (24 << 8) | 15);
    hold(0, { upmove: -127 });
    frames(1);
    expect(game.entity(0).s.solid).toBe(((CROUCH_HEIGHT + 32) << 16) | (24 << 8) | 15);

    // A corpse is `CONTENTS_CORPSE`, which stops neither a move nor a client's trace.
    kill(0);
    expect(game.entity(0).s.solid).toBe(0);
    frames(1);
    expect(game.entity(0).s.solid).toBe(0);
  });

  it('makes a dead player a corpse, no taller than one, which the living walk through', () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(100, 0, GROUND_Z));
    kill(1);
    expect(game.entity(1).r.contents).toBe(CONTENTS.CORPSE);

    hold(0, { forwardmove: 127 });
    frames(125);

    expect(game.entity(1).r.maxs.z).toBe(DEAD_HEIGHT);
    expect(game.level.clients[0].ps.origin.x).toBeGreaterThan(200);
  });

  it('lets a dead player fall through the living', () => {
    put(1, vec3(100, 0, GROUND_Z));
    frames(10);
    put(0, vec3(100, 0, GROUND_Z + 80));
    kill(0);

    frames(125);

    expect(game.level.clients[0].ps.origin.z).toBeLessThan(GROUND_Z + 1);
  });

  it("moves a bot, a dead player and a living one with Quake 3's masks, past themselves", () => {
    const masks = (clientNum: number) =>
      distinctAsks(asked.filter((ask) => ask.passEntityNum === clientNum));

    asked.length = 0;
    frames(1);
    const bot = MASK.PLAYERSOLID | CONTENTS.BOTCLIP;
    expect(masks(0)).toEqual([{ passEntityNum: 0, contentmask: bot }]);

    kill(0);
    frames(1);
    asked.length = 0;
    frames(1);
    const dead = MASK.PLAYERSOLID & ~CONTENTS.BODY;
    expect(masks(0)).toEqual([{ passEntityNum: 0, contentmask: dead }]);
  });

  it('stops a round at a player in the way, bleeds them and hurts them', () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(100, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.MACHINEGUN;
    const before = health(1);

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
    frames(1);

    const impact = lastEvent(EV.BULLET_HIT_FLESH)!;
    expect(impact.s.origin.x).toBeGreaterThan(80);
    expect(impact.s.origin.x).toBeLessThanOrEqual(85);
    // Whom it struck, where a wall's impact carries the surface, and whose round it was.
    expect(impact.s.eventParm).toBe(1);
    expect(impact.s.otherEntityNum).toBe(0);
    expect(lastEvent(EV.BULLET_HIT_WALL)).toBeUndefined();
    expect(health(1)).toBe(before - 7);
    expect(game.level.clients[1].lasthurtMod).toBe(MOD.MACHINEGUN);
  });

  /** A corpse the player in slot 0 left, standing at `x` in their line of fire. */
  function ownCorpseAt(x: number): void {
    const corpse = game.level.spawnEntity();
    const { mins, maxs } = playerBounds(false);
    corpse.r.mins = mins;
    corpse.r.maxs = maxs;
    corpse.r.currentOrigin = vec3(x, 0, GROUND_Z);
    corpse.r.contents = CONTENTS.CORPSE;
    corpse.r.ownerNum = 0;
    host.linkEntity(corpse);
  }

  it("fires a round through the shooter's own corpse, as Quake 3's rounds go", () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(100, 0, GROUND_Z));
    ownCorpseAt(50);
    game.level.clients[0].ps.weapon = WP.MACHINEGUN;

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
    frames(1);

    expect(lastEvent(EV.BULLET_HIT_FLESH)!.s.origin.x).toBeGreaterThan(80);
  });

  it("fires the lightning through the shooter's own corpse too", () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(100, 0, GROUND_Z));
    ownCorpseAt(50);
    game.level.clients[0].ps.weapon = WP.LIGHTNING;

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.LIGHTNING });
    frames(1);

    expect(lastEvent(EV.MISSILE_HIT)!.s.origin.x).toBe(Math.trunc(100 - 15 - 0.125));
  });

  it("stops the lightning gun's bolt at a player in the way, and hurts them", () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(100, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.LIGHTNING;
    const before = health(1);

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.LIGHTNING });
    frames(1);

    // At the near face, less the epsilon, then snapped as a temp entity's origin is.
    const impact = lastEvent(EV.MISSILE_HIT)!;
    expect(impact.s.origin.x).toBe(Math.trunc(100 - 15 - 0.125));
    expect(impact.s.otherEntityNum).toBe(1);
    expect(impact.s.weapon).toBe(WP.LIGHTNING);
    expect(lastEvent(EV.MISSILE_MISS)).toBeUndefined();
    expect(health(1)).toBe(before - 8);
  });

  it('sends a rail through a player to the wall behind, hurts them, and puts them back', () => {
    // The one shot thinks before the one firing, so nothing but the rail links them again.
    put(1, vec3(0, 0, GROUND_Z));
    put(0, vec3(100, 0, GROUND_Z));
    game.level.clients[1].ps.weapon = WP.RAILGUN;
    const before = health(0);

    hold(1, { buttons: BUTTON_ATTACK, weapon: WP.RAILGUN });
    frames(1);

    const beam = lastEvent(EV.RAILTRAIL)!;
    expect(beam.s.origin.x).toBeGreaterThan(298);
    expect(beam.s.origin.x).toBeLessThanOrEqual(300);
    expect(game.entity(0).r.linked).toBe(true);
    expect(health(0)).toBe(before - 100);
  });

  it('kills with the rail, and tells everyone who and how', () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(100, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.RAILGUN;
    // Not so low that the rail's 100 takes them past −40 and gibs them.
    game.level.clients[1].ps.stats[STAT.HEALTH] = 70;

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.RAILGUN });
    frames(1);

    const dead = game.level.clients[1];
    expect(dead.ps.pmType).toBe(PM_DEAD);
    expect(game.entity(1).r.contents).toBe(CONTENTS.CORPSE);
    expect(lastEvent(EV.OBITUARY)!.s).toMatchObject({
      eventParm: MOD.RAILGUN,
      otherEntityNum: 1,
      otherEntityNum2: 0
    });
    // The death names the killer, and the dead player's camera looks back along the rail.
    expect(eventNumber(dead.ps.externalEvent)).toBe(EV.DEATH1);
    expect(dead.ps.externalEventParm).toBe(0);
    expect(dead.ps.stats[STAT.DEAD_YAW]).toBe(180);
    expect(game.level.clients[0].lastkilledClient).toBe(1);
  });

  it('punches a player within reach with the gauntlet, before the move fires it', () => {
    put(0, vec3(0, 0, GROUND_Z));
    // The muzzle is 14 ahead of the eye and reaches 32 further: 46, past their face at 40.
    put(1, vec3(55, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.GAUNTLET;
    const before = health(1);
    const events = game.level.clients[0].ps.eventSequence;

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.GAUNTLET });
    frames(1);

    expect(health(1)).toBe(before - 50);
    const blood = lastEvent(EV.MISSILE_HIT)!;
    expect(blood.s.otherEntityNum).toBe(1);
    expect(blood.s.weapon).toBe(WP.GAUNTLET);
    expect(game.level.clients[1].lasthurtMod).toBe(MOD.GAUNTLET);
    // The move fired it, which it does for the gauntlet only on a hit.
    const fired = eventsSince(game.level.clients[0].ps, events).map((e) => eventNumber(e.event));
    expect(fired).toContain(EV.FIRE_WEAPON);
  });

  it('punches once a swing, however long attack is held', () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(55, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.GAUNTLET;
    const before = health(1);

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.GAUNTLET });
    // 400 ms a swing: the first lands at once, and the next not for another 50 frames.
    frames(40);
    expect(health(1)).toBe(before - 50);
  });

  it('punches nothing while talking, without attack, or with another weapon in hand', () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(55, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.GAUNTLET;
    const before = health(1);

    hold(0, { buttons: BUTTON_ATTACK | BUTTON_TALK, weapon: WP.GAUNTLET });
    frames(1);
    hold(0, { weapon: WP.GAUNTLET });
    frames(1);
    expect(health(1)).toBe(before);

    // The machinegun at the same range: a round's 7, and no punch.
    game.level.clients[0].ps.weapon = WP.MACHINEGUN;
    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
    frames(1);
    expect(health(1)).toBe(before - 7);
  });

  it('holds the punch while a round counts down, under g_countdownHold', () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(55, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.GAUNTLET;
    // Nothing in free-for-all counts a round down, so this one never ends.
    game.level.roundTime = game.level.time + 10_000;
    cvars.set('g_countdownHold', '1');
    // At the max, so no second's drain moves it either.
    game.level.clients[1].ps.stats[STAT.HEALTH] = 100;
    const events = game.level.clients[0].ps.eventSequence;

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.GAUNTLET });
    frames(1);
    expect(lastEvent(EV.MISSILE_HIT)).toBeUndefined();
    const fired = eventsSince(game.level.clients[0].ps, events).map((e) => eventNumber(e.event));
    expect(fired).not.toContain(EV.FIRE_WEAPON);

    // id's punches, and only the countdown's own rule keeps the hurt off.
    cvars.set('g_countdownHold', '0');
    frames(1);
    expect(lastEvent(EV.MISSILE_HIT)!.s.otherEntityNum).toBe(1);
    expect(health(1)).toBe(100);
  });

  it('holds every trigger while a round counts down, under g_countdownHold', () => {
    put(0, vec3(0, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.MACHINEGUN;
    game.level.roundTime = game.level.time + 10_000;
    cvars.set('g_countdownHold', '1');
    const events = game.level.clients[0].ps.eventSequence;

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
    frames(5);
    const fired = eventsSince(game.level.clients[0].ps, events).map((e) => eventNumber(e.event));
    expect(fired).not.toContain(EV.FIRE_WEAPON);
  });

  it('asks the host what a blast reaches', () => {
    const asked = vi.spyOn(host, 'entitiesInBox');
    put(0, vec3(0, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.ROCKET_LAUNCHER;
    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.ROCKET_LAUNCHER });
    frames(1);
    hold(0, { weapon: WP.ROCKET_LAUNCHER });
    frames(60);
    expect(asked).toHaveBeenCalled();
  });

  it('swings the gauntlet at nothing out of reach, and neither hurts nor fires', () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(70, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.GAUNTLET;
    const before = health(1);
    const events = game.level.clients[0].ps.eventSequence;

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.GAUNTLET });
    frames(1);

    expect(health(1)).toBe(before);
    expect(lastEvent(EV.MISSILE_HIT)).toBeUndefined();
    const fired = eventsSince(game.level.clients[0].ps, events).map((e) => eventNumber(e.event));
    expect(fired).not.toContain(EV.FIRE_WEAPON);
  });

  it('sends a rail with nothing in its way to the end of its range, and unlinks nothing', () => {
    // Past the wall, facing away from it: open air as far as the rail goes.
    put(0, vec3(400, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.RAILGUN;

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.RAILGUN });
    frames(1);

    expect(lastEvent(EV.RAILTRAIL)!.s.origin.x).toBeGreaterThan(8000);
    expect(game.entity(ENTITYNUM_NONE).r.linked).toBe(false);
  });

  it('stops a rail at the fourth it passes through, as MAX_RAIL_HITS has it', () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(0, 200, GROUND_Z));
    // Four more boxes in a row, made of what a player is.
    for (const x of [60, 100, 140, 180]) {
      const standIn = game.level.spawnEntity();
      const { mins, maxs } = playerBounds(false);
      standIn.r.mins = mins;
      standIn.r.maxs = maxs;
      standIn.r.currentOrigin = vec3(x, 0, GROUND_Z);
      standIn.r.contents = CONTENTS.BODY;
      host.linkEntity(standIn);
    }
    game.level.clients[0].ps.weapon = WP.RAILGUN;

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.RAILGUN });
    frames(1);

    const beam = lastEvent(EV.RAILTRAIL)!;
    expect(beam.s.origin.x).toBeGreaterThan(163);
    expect(beam.s.origin.x).toBeLessThanOrEqual(165);
  });

  it("sets a rocket off at a player in its way, having left its own player's box", () => {
    put(0, vec3(0, 0, GROUND_Z));
    put(1, vec3(200, 0, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.ROCKET_LAUNCHER;

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.ROCKET_LAUNCHER });
    frames(1);
    hold(0, { weapon: WP.ROCKET_LAUNCHER });
    frames(50);

    // The muzzle is inside the shooter's own box, so a rocket that did not pass its owner would
    // go off where it was fired.
    const rocket = game.level.gentities
      .slice(MAX_CLIENTS, game.level.numEntities)
      .find((entity) => entity.s.weapon === WP.ROCKET_LAUNCHER && entity.s.eType === ET.GENERAL)!;
    expect(eventNumber(rocket.s.event)).toBe(EV.MISSILE_HIT);
    expect(rocket.s.otherEntityNum).toBe(1);
    expect(rocket.s.origin.x).toBeGreaterThan(180);
    expect(rocket.s.origin.x).toBeLessThanOrEqual(185);
    // Its direct hit, and none of its blast, which passes over whoever it hit.
    expect(health(1)).toBe(125 - 100);
    expect(game.level.clients[1].lasthurtMod).toBe(MOD.ROCKET);
  });

  it("reaches a player beside a rocket's blast, on the shooter's account", () => {
    put(0, vec3(0, 0, GROUND_Z));
    // Beside the rocket's line to the wall, near where it goes off.
    put(1, vec3(270, 40, GROUND_Z));
    game.level.clients[0].ps.weapon = WP.ROCKET_LAUNCHER;
    const before = health(1);

    hold(0, { buttons: BUTTON_ATTACK, weapon: WP.ROCKET_LAUNCHER });
    frames(1);
    hold(0, { weapon: WP.ROCKET_LAUNCHER });
    frames(60);

    const bystander = game.level.clients[1];
    expect(health(1)).toBeLessThan(before);
    expect(bystander.lasthurtClient).toBe(0);
    expect(bystander.lasthurtMod).toBe(MOD.ROCKET_SPLASH);
    // Pushed away from the blast, to +y.
    expect(bystander.ps.velocity.y).toBeGreaterThan(0);
  });

  describe("what everyone else is sent of a player's move", () => {
    /** Every event a player's move sent on its own, oldest first. */
    function sentAlone(clientNum: number): GameEntity[] {
      return game.level.gentities
        .slice(MAX_CLIENTS, game.level.numEntities)
        .filter(
          (entity) =>
            entity.inuse &&
            entity.s.eFlags & EF_PLAYER_EVENT &&
            entity.s.otherEntityNum === clientNum
        );
    }

    /** The event an event-only entity is, with the counter taken off. */
    function eventOf(entity: GameEntity): number {
      return eventNumber(entity.s.eType - ET.EVENTS);
    }

    it("puts the move's first event on the player's entity, and sends the next on its own", () => {
      // A jump and a shot in one move (`g_active.c:949–954`).
      put(0, vec3(0, 0, GROUND_Z));
      hold(0, { upmove: 127, buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
      frames(1);

      const player = game.entity(0);
      const { ps } = game.level.clients[0];
      expect(eventNumber(player.s.event)).toBe(EV.JUMP);
      const [shot] = sentAlone(0);
      expect(sentAlone(0)).toHaveLength(1);
      expect(eventOf(shot)).toBe(EV.FIRE_WEAPON);
      // Everything the player's entity is, so the client can play it as theirs: the weapon it
      // fired, and where they were, in whole units.
      expect(shot.s.weapon).toBe(WP.MACHINEGUN);
      expect(shot.s.clientNum).toBe(0);
      expect(shot.s.pos.trBase).toEqual(player.s.pos.trBase);
      expect(shot.s.number).toBeGreaterThanOrEqual(MAX_CLIENTS);
      // To everyone but the player, who has it on their player state.
      expect(shot.r.svFlags & SVF.NOTSINGLECLIENT).toBe(SVF.NOTSINGLECLIENT);
      expect(shot.r.singleClient).toBe(0);
      expect(ps.entityEventSequence).toBe(ps.eventSequence);
    });

    it("keeps a hurt on the player's entity, and sends each of the move's on its own", () => {
      // The pain is raised at the frame's end (`P_DamageFeedback`), and holds the entity until it
      // is old. A move meanwhile sends both its events alone, one at the think and one at the
      // frame's end (`g_active.c:1179–1184`).
      put(0, vec3(0, 0, GROUND_Z));
      hurt(game, 0, 10);
      frames(1);
      expect(eventNumber(game.entity(0).s.event)).toBe(EV.PAIN);

      hold(0, { upmove: 127, buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
      frames(1);

      expect(eventNumber(game.entity(0).s.event)).toBe(EV.PAIN);
      expect(sentAlone(0).map(eventOf)).toEqual([EV.JUMP, EV.FIRE_WEAPON]);
      const { ps } = game.level.clients[0];
      expect(ps.entityEventSequence).toBe(ps.eventSequence);
    });

    it('loses the first of a move to a hurt in the same frame, as Q3 does', () => {
      // The think puts the jump on the entity, and the frame's end puts the pain over it before
      // any snapshot is taken. The shot, which went on its own, still goes.
      put(0, vec3(0, 0, GROUND_Z));
      hurt(game, 0, 10);
      hold(0, { upmove: 127, buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
      frames(1);

      expect(eventNumber(game.entity(0).s.event)).toBe(EV.PAIN);
      expect(sentAlone(0).map(eventOf)).toEqual([EV.FIRE_WEAPON]);
    });

    it('keeps a move\'s event on the entity for as long as any other event', () => {
      // "Save results of pmove" marks the entity's event as new, so the frame does not take it off
      // before a client has had its 300 ms to see it.
      put(0, vec3(0, 0, GROUND_Z));
      hold(0, { upmove: 127 });
      frames(1);
      hold(0, {});
      frames(Math.floor(EVENT_VALID_MSEC / PMOVE_MSEC));
      expect(eventNumber(game.entity(0).s.event)).toBe(EV.JUMP);

      frames(2);
      expect(eventNumber(game.entity(0).s.event)).toBe(0);
    });
  });
});

describe('lag compensation', () => {
  /** A record of nothing, as a spawn's clearing leaves each one. */
  const ZERO_RECORD = { origin: vec3(), mins: vec3(), maxs: vec3(), time: 0 };

  /**
   * Two clients on their own spots, past the spawn's hold, each given a command at every 8 ms
   * frame, the one in slot 0 first. The world notes where client 1 is traced at by every shot.
   */
  function twoPlayers(cvarValues: Record<string, string> = {}) {
    const fixture = makeGame(
      { entities: mapOf(spawnSpot(vec3(0, 0, 20)), spawnSpot(vec3(0, 400, 20))) },
      { pcq_spawnWeapons: '1', ...cvarValues }
    );
    const { game, traps } = fixture;
    const floor = createFlatWorldTrace();
    const shotAt: Vec3[] = [];
    traps.world = (start, mins, maxs, end, passEntityNum, contentmask) => {
      if (contentmask === MASK.SHOT) shotAt.push(copy(game.level.gentities[1].r.currentOrigin));
      return floor(start, mins, maxs, end, passEntityNum, contentmask);
    };
    join(fixture, 0);
    join(fixture, 1);

    /** Run `ticks` frames, each client holding its own command. */
    const run = (ticks: number, inputs: Partial<NetUserCmd>[] = []): void => {
      for (let i = 0; i < ticks; i++) {
        const time = game.level.time + PMOVE_MSEC;
        for (const clientNum of [0, 1]) {
          const cmd = createNetUserCmd();
          Object.assign(cmd, inputs[clientNum], { serverTime: time });
          traps.cmds.set(clientNum, cmd);
          game.clientThink(clientNum);
        }
        game.runFrame(time);
      }
    };

    run(40);
    return { ...fixture, run, shotAt };
  }

  it("records each player at every frame's end, where a snapshot shows them", () => {
    const { game, run } = twoPlayers();
    run(5, [{}, { forwardmove: 127 }]);

    const client = game.level.clients[1];
    const newest = client.history[client.historyHead];
    expect(newest.time).toBe(game.level.time);
    expect(newest.origin).toEqual(game.entity(1).s.pos.trBase);
    // 850 ms of 8 ms frames.
    expect(client.history).toHaveLength(107);
  });

  it('records nobody watching, nobody still connecting, and nobody at the intermission', () => {
    const fixture = twoPlayers();
    putOnTeam(fixture, 1, TEAM.SPECTATOR);
    fixture.game.clientConnect(2, true, true);
    fixture.run(5);
    const { clients, time } = fixture.game.level;
    expect(clients[1].history[clients[1].historyHead].time).toBe(time - 5 * PMOVE_MSEC);
    expect(clients[2].history).toEqual([]);

    const over = atIntermission();
    const client = over.game.level.clients[0];
    over.game.runFrame(62_000);
    expect(client.history[client.historyHead].time).toBe(61_000);
  });

  it('fills the history at a teleport with where the player left from', () => {
    const { game } = twoPlayers();
    const entity = game.entity(0);
    const from = copy(entity.r.currentOrigin);

    game.useTeleporter(entity);

    const { history, historyHead } = game.level.clients[0];
    expect(entity.r.currentOrigin).not.toEqual(from);
    // Every record, the ones the frames since the spawn had not reached yet included, a frame
    // apart back from now.
    expect(history.map((record) => record.origin)).toEqual(Array(107).fill(from));
    expect(history.map((record) => record.time)).toEqual(
      history.map((_, i) => game.level.time - (historyHead - i) * PMOVE_MSEC)
    );
  });

  it('is zeroed by a spawn, all but the record its own end of frame makes', () => {
    // The spawn fills the history and its clearing zeroes it, in unlagged and Excessive Plus
    // alike.
    const { game } = twoPlayers();
    const entity = game.entity(0);

    game.clientRespawn(entity);

    const { history, historyHead } = game.level.clients[0];
    expect(history[historyHead]).toMatchObject({
      origin: entity.s.pos.trBase,
      time: game.level.time
    });
    expect(history.filter((_, i) => i !== historyHead)).toEqual(Array(106).fill(ZERO_RECORD));
  });

  it.each([
    ['1', 20 * PMOVE_MSEC],
    // Otherwise a snapshot gap before the command ran: a client that names no `snaps` is sent
    // one every 50 ms, which go at every seventh frame.
    ['0', 56]
  ])("at xp_unlagged %s, a human's rail finds others as they were %i ms back", (unlagged, back) => {
    const { game, run, shotAt } = twoPlayers({ xp_unlagged: unlagged });
    run(30, [{}, { forwardmove: 127 }]);
    const { history } = game.level.clients[1];
    const at = (time: number) => history.find((record) => record.time === time)!.origin;
    const drawn = game.level.time - 20 * PMOVE_MSEC;
    const then = at(game.level.time - back);
    const now = copy(game.entity(1).r.currentOrigin);
    game.level.clients[0].ps.weapon = WP.RAILGUN;
    shotAt.length = 0;

    const fire = { buttons: BUTTON_ATTACK, weapon: WP.RAILGUN };
    const frame = { drawnTime: drawn, drawnSnapTime: drawn, drawnNextSnapTime: drawn };
    run(1, [{ ...fire, ...frame }, { forwardmove: 127 }]);

    expect(shotAt).toEqual([then]);
    expect(then.x).toBeLessThan(now.x - 10);
  });

  it('finds others for a rail as they were drawn with xp_unlagged never set', () => {
    const { game, run, shotAt } = twoPlayers();
    run(30, [{}, { forwardmove: 127 }]);
    const drawn = game.level.time - 20 * PMOVE_MSEC;
    const then = game.level.clients[1].history.find((record) => record.time === drawn)!.origin;
    game.level.clients[0].ps.weapon = WP.RAILGUN;
    shotAt.length = 0;

    const frame = { drawnTime: drawn, drawnSnapTime: drawn, drawnNextSnapTime: drawn };
    run(1, [{ buttons: BUTTON_ATTACK, weapon: WP.RAILGUN, ...frame }, { forwardmove: 127 }]);

    expect(shotAt).toEqual([then]);
  });

  it("times each command from the host's clock where the last frame ended", () => {
    const { game, traps } = twoPlayers();
    traps.clock = 5000;
    game.runFrame(game.level.time + PMOVE_MSEC);
    expect(game.level.frameStartTime).toBe(5000);

    traps.clock = 5013;
    const cmd = createNetUserCmd();
    cmd.serverTime = game.level.time + PMOVE_MSEC;
    traps.cmds.set(0, cmd);
    game.clientThink(0);

    expect(game.level.clients[0].frameOffset).toBe(13);
  });

  it('times a command before any frame from the map start, and none from a stopped frame', () => {
    const fixture = makeGame();
    const { game, traps } = fixture;
    traps.clock = 700;
    traps.restartEntities();
    game.init(0, 1, false);
    expect(game.level.frameStartTime).toBe(700);

    game.level.restarted = true;
    traps.clock = 900;
    game.runFrame(PMOVE_MSEC);

    expect(game.level.frameStartTime).toBe(700);
  });

  it.each([
    ['', '125', 50],
    ['30', '125', 33],
    ['125', '125', 8],
    // `sv_fps` caps what a client may ask for.
    ['125', '20', 50]
  ])("holds snaps '%s' apart under sv_fps %s by %i ms, as the host does", (snaps, svFps, msec) => {
    const fixture = makeGame({}, { sv_fps: svFps });
    join(fixture, 0, snaps ? `\\name\\A\\snaps\\${snaps}` : '\\name\\A');

    expect(fixture.game.level.clients[0].pers.snapshotMsec).toBe(msec);
  });

  it('measures true ping at every command, and the board shows it', () => {
    const { game, traps } = twoPlayers();
    // Each command is run 3 ms after its frame ended, and drew the frame 100 ms before the last
    // one: less the 56 ms gap of a client that names no `snaps`, 47.
    for (let i = 0; i < NUM_PING_SAMPLES; i++) {
      traps.clock += 3;
      const drawn = game.level.time - 100;
      const cmd = createNetUserCmd();
      Object.assign(cmd, {
        serverTime: game.level.time + PMOVE_MSEC,
        drawnTime: drawn,
        drawnSnapTime: drawn,
        drawnNextSnapTime: drawn
      });
      traps.cmds.set(0, cmd);
      game.clientThink(0);
      game.runFrame(game.level.time + PMOVE_MSEC);
    }

    expect(game.level.clients[0].pers.realPing).toBe(47);
    // Fifteen numbers an entry, the slot first and the ping third.
    const board = game.scoreboardMessage().split(' ').slice(4);
    const pingOf = (slot: number) =>
      board[board.findIndex((field, i) => i % 15 === 0 && field === String(slot)) + 2];
    expect(pingOf(0)).toBe('47');
    // The other's commands name no drawn frame, so each is measured from its own time.
    expect(pingOf(1)).toBe('0');
  });

  it('starts true ping over for whoever connects into the slot next', () => {
    const fixture = twoPlayers();
    const { pers } = fixture.game.level.clients[0];
    pers.pingSamples.fill(47);
    pers.realPing = 47;

    fixture.game.clientDisconnect(0);
    // A bot, whose spawn runs no command of its own to measure.
    joinBot(fixture, 0);

    expect(pers.pingSamples).toEqual(Array(NUM_PING_SAMPLES).fill(0));
    expect(pers.realPing).toBe(0);
  });
});

describe('a client using a holdable', () => {
  /** A map of two spawn spots, the second 512 units from the first. */
  const TWO_SPOTS = mapOf(spawnSpot(vec3(0, 0, 24), 90), spawnSpot(vec3(512, 0, 24), 180));
  /** A third spot beyond both, so a choice measured from the player is not a choice from home. */
  const THREE_SPOTS = mapOf(
    spawnSpot(vec3(0, 0, 24), 90),
    spawnSpot(vec3(512, 0, 24), 180),
    spawnSpot(vec3(700, 0, 24), 270)
  );

  /** Send one command from `clientNum`, and run the frame it is stamped for, as the host does. */
  function step(fixture: Fixture, input: Partial<NetUserCmd> = {}, clientNum = 0): void {
    const time = fixture.game.level.time + PMOVE_MSEC;
    const cmd = createNetUserCmd();
    Object.assign(cmd, input, { serverTime: time });
    fixture.traps.cmds.set(clientNum, cmd);
    fixture.game.clientThink(clientNum);
    fixture.game.runFrame(time);
  }

  /** A joined client at one of the map's two spots, holding one item, past its own respawn. */
  function holding(classname: string): Fixture {
    const fixture = makeGame({ entities: TWO_SPOTS });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    // The click that respawned the player has to be let go before anything can be used
    // (`bg_pmove.c:1872–1876`), so the first command goes out with nothing held.
    step(fixture);
    fixture.game.level.clients[0].ps.stats[STAT.HOLDABLE_ITEM] = itemIndex(findItem(classname)!);
    return fixture;
  }

  /** The temp entities carrying one event, as a client would find them in a snapshot. */
  function tempEvents(fixture: Fixture, event: number): GameEntity[] {
    return fixture.game.level.gentities.filter((e) => e.inuse && e.s.eType === ET.EVENTS + event);
  }

  it('teleports to the other spot, with an effect at each end', () => {
    const fixture = holding('holdable_teleporter');
    const { ps } = fixture.game.level.clients[0];
    // `ClientSpawn` chose the furthest spot from the map's origin, which is the 512 one.
    expect(ps.origin.x).toBe(512);
    // The spawn's think leaves the player a little above the spot, so land before the frame the
    // out-effect's origin is measured from.
    for (let i = 0; i < 30 && ps.velocity.z !== 0; i++) step(fixture);
    expect(ps.velocity.z).toBe(0);
    const before = copy(ps.origin);
    // The spawn's own arrival, at the 512 spot, is still in the world.
    const arrivals = tempEvents(fixture, EV.PLAYER_TELEPORT_IN);
    expect(arrivals.map((e) => e.s.origin.x)).toEqual([512]);

    step(fixture, { buttons: BUTTON_USE_HOLDABLE });

    // The other spot, lifted nine units as a spawn is, and one more as `TeleportPlayer` adds
    // (`g_misc.c:98`) — the player's own spot is passed over, since they hold it until the
    // teleport unlinks them.
    expect(ps.origin.x).toBe(0);
    expect(ps.origin.y).toBe(0);
    expect(ps.origin.z).toBe(24 + SPAWN_LIFT + 1);
    expect(ps.stats[STAT.HOLDABLE_ITEM]).toBe(0);

    // The effects: one where they were, one where they now are, each naming the client for the
    // teleport's own look.
    const out = tempEvents(fixture, EV.PLAYER_TELEPORT_OUT);
    const into = tempEvents(fixture, EV.PLAYER_TELEPORT_IN).filter((e) => !arrivals.includes(e));
    expect(out).toHaveLength(1);
    expect(out[0].s.origin).toEqual(
      vec3(Math.trunc(before.x), Math.trunc(before.y), Math.trunc(before.z))
    );
    expect(out[0].s.clientNum).toBe(0);
    expect(into).toHaveLength(1);
    // The effect is at the spot itself; the player lands one unit above it (`g_misc.c:90–98`).
    expect(into[0].s.origin).toEqual(vec3(0, 0, 33));
    expect(into[0].s.clientNum).toBe(0);
  });

  it('is spat out along the spot’s facing, and told not to interpolate', () => {
    const fixture = holding('holdable_teleporter');
    const { ps } = fixture.game.level.clients[0];
    const flags = ps.eFlags;

    step(fixture, { buttons: BUTTON_USE_HOLDABLE });

    // `AngleVectors( angles, velocity ) * 400` and the 160 ms knockback window
    // (`g_misc.c:99–107`): the spot they arrive at faces yaw 90, so the spit is +y, with the
    // x the game module's float cosine of 90° leaves, as a twin of its C gives it.
    expect(ps.velocity.x).toBe(-1.7484555428382009e-5);
    expect(ps.velocity.y).toBe(400);
    expect(ps.velocity.z).toBe(-0);
    expect(ps.pmTime).toBe(160);
    expect(ps.pmFlags & PMF_TIME_KNOCKBACK).toBeTruthy();
    // `SetClientViewAngle`: the view is the spot's, and the delta carries it.
    expect(ps.viewangles.y).toBe(90);
    // The teleport bit toggles, which is what stops a client sliding them across the map.
    expect(ps.eFlags & EF_TELEPORT_BIT).toBe(flags & EF_TELEPORT_BIT ? 0 : EF_TELEPORT_BIT);
  });

  it('telefrags whoever is standing where it lands', () => {
    // Both spots taken — the player's own and the other — leaves the map's first spot, which is
    // the one the second client holds, and `G_KillBox` is what arrives with the teleporter.
    const fixture = holding('holdable_teleporter');
    join(fixture, 1);
    const victim = fixture.game.level.clients[1];
    expect(victim.ps.origin.x).toBe(0);

    step(fixture, { buttons: BUTTON_USE_HOLDABLE });

    expect(victim.ps.stats[STAT.HEALTH]).toBeLessThanOrEqual(0);
    expect(victim.lasthurtMod).toBe(MOD.TELEFRAG);
    // And the teleporter went where the victim was.
    expect(fixture.game.level.clients[0].ps.origin.z).toBe(24 + SPAWN_LIFT + 1);
  });

  it('chooses the spot furthest from where the player stands, as a respawn does', () => {
    // Three spots, so "furthest from the player" and "furthest from the map's origin" are two
    // different answers: from the 700 spot the furthest is 0, from the origin it is 700.
    const fixture = makeGame({ entities: THREE_SPOTS });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    step(fixture);
    const { ps } = fixture.game.level.clients[0];
    expect(ps.origin.x).toBe(700);
    ps.stats[STAT.HOLDABLE_ITEM] = itemIndex(findItem('holdable_teleporter')!);

    step(fixture, { buttons: BUTTON_USE_HOLDABLE });

    expect(ps.origin.x).toBe(0);
  });

  it("chooses as for a human whoever uses it, a bot included, as ioquake3's does", () => {
    // The furthest spot from the player is closed to humans, so a human's choice is the other.
    const fixture = makeGame({
      entities: mapOf(spawnSpot(vec3(300, 0, 24)), {
        ...spawnSpot(vec3(700, 0, 24)),
        nohumans: '1'
      })
    });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    const entity = fixture.game.level.gentities[0];
    const { ps } = fixture.game.level.clients[0];
    entity.r.svFlags |= SVF.BOT;
    ps.origin = vec3(0, 0, 24);

    fixture.game.useTeleporter(entity);

    expect(ps.origin.x).toBe(300);
  });

  it('names the client using it in both effects, whichever slot they are', () => {
    // A second client, so a client number of 0 is not the only one the effects could carry.
    const fixture = makeGame({ entities: TWO_SPOTS });
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    join(fixture, 1);
    step(fixture, {}, 1);
    fixture.game.level.clients[1].ps.stats[STAT.HOLDABLE_ITEM] = itemIndex(
      findItem('holdable_teleporter')!
    );

    step(fixture, { buttons: BUTTON_USE_HOLDABLE }, 1);

    expect(tempEvents(fixture, EV.PLAYER_TELEPORT_OUT).at(-1)!.s.clientNum).toBe(1);
    expect(tempEvents(fixture, EV.PLAYER_TELEPORT_IN).at(-1)!.s.clientNum).toBe(1);
  });

  it('heals a medkit to 25 over the max, and takes the item out of the hand', () => {
    const fixture = holding('holdable_medkit');
    const { ps } = fixture.game.level.clients[0];
    ps.stats[STAT.HEALTH] = 40;
    const since = ps.eventSequence;

    step(fixture, { buttons: BUTTON_USE_HOLDABLE });

    expect(ps.stats[STAT.HEALTH]).toBe(125);
    expect(ps.stats[STAT.HOLDABLE_ITEM]).toBe(0);
    // The move raised the use; the match turned it into the heal.
    expect(eventsSince(ps, since).map(({ event }) => eventNumber(event))).toContain(
      EV.USE_ITEM0 + HI.MEDKIT
    );
  });

  it('refuses the medkit at 25 over the max, and keeps it', () => {
    // The spawn arrives at exactly the heal's ceiling, so the first press is refused.
    const fixture = holding('holdable_medkit');
    const { ps } = fixture.game.level.clients[0];
    expect(ps.stats[STAT.HEALTH]).toBe(125);

    step(fixture, { buttons: BUTTON_USE_HOLDABLE });

    expect(ps.stats[STAT.HEALTH]).toBe(125);
    expect(ps.stats[STAT.HOLDABLE_ITEM]).toBe(itemIndex(findItem('holdable_medkit')!));
  });

  it('raises use-item-zero with nothing in hand', () => {
    const fixture = holding('holdable_medkit');
    const { ps } = fixture.game.level.clients[0];
    ps.stats[STAT.HOLDABLE_ITEM] = 0;
    const since = ps.eventSequence;

    step(fixture, { buttons: BUTTON_USE_HOLDABLE });

    expect(eventsSince(ps, since).map(({ event }) => eventNumber(event))).toContain(EV.USE_ITEM0);
    expect(ps.stats[STAT.HOLDABLE_ITEM]).toBe(0);
  });
});

describe('a client walking into an item', () => {
  /** A map whose one spawn spot has an item standing on the floor under it. */
  const ITEM_MAP = mapOf(spawnSpot(vec3()), {
    classname: 'weapon_railgun',
    origin: '0 0 24'
  });

  /** A joined client standing at the origin on a floor, with the map's item already stood up. */
  function standing(cvarValues: Record<string, string> = {}): Fixture {
    const fixture = makeGame({ entities: ITEM_MAP }, cvarValues);
    fixture.traps.world = createFlatWorldTrace();
    join(fixture, 0);
    fixture.game.runFrame(100);
    fixture.game.runFrame(200);
    return fixture;
  }

  /** The item the map placed, by its slot on the entity. */
  function placedItem(fixture: Fixture): GameEntity {
    const number = itemIndex(findItem('weapon_railgun')!);
    return fixture.game.level.gentities.find(
      (entity) => entity.inuse && entity.item && entity.s.modelindex === number
    )!;
  }

  it('arms them for the match’s own weapon respawn, not the table’s', () => {
    const fixture = standing({ g_weaponrespawn: '9' });
    const before = fixture.game.level.time;

    press(fixture, 0, 0);

    const { ps } = fixture.game.level.clients[0];
    expect(ps.stats[STAT.WEAPONS] & (1 << WP.RAILGUN)).toBeTruthy();
    expect(ps.ammo[WP.RAILGUN]).toBe(10);

    const item = placedItem(fixture);
    expect(item.r.contents).toBe(0);
    expect(item.s.eFlags & EF_NODRAW).toBe(EF_NODRAW);
    expect(item.nextthink).toBe(before + 9_000);
    expect(eventNumber(ps.externalEvent)).toBe(EV.ITEM_PICKUP);
    expect(ps.externalEventParm).toBe(itemIndex(findItem('weapon_railgun')!));

    // The map's clock is the match's: it comes back when the 9 seconds are up.
    fixture.game.runFrame(before + 9_000);
    expect(item.r.contents).toBe(CONTENTS.TRIGGER);
    expect(item.s.eFlags & EF_NODRAW).toBe(0);
  });

  it('registers Q3’s weapon respawn defaults when nothing has said otherwise', () => {
    const fixture = makeGame();
    expect(fixture.cvars.get('g_weaponrespawn')).toBe('5');
    expect(fixture.cvars.get('g_weaponTeamRespawn')).toBe('30');
  });

  it('picks nothing up while noclip', () => {
    const fixture = standing();
    fixture.game.level.clients[0].noclip = true;
    press(fixture, 0, 0);
    const item = placedItem(fixture);
    expect(item.r.contents).toBe(CONTENTS.TRIGGER);
    expect(item.nextthink).toBe(0);
    // Quake 3's loadout has no railgun, so the pickup that did not happen leaves nothing of one.
    const { ps } = fixture.game.level.clients[0];
    expect(ps.stats[STAT.WEAPONS] & (1 << WP.RAILGUN)).toBe(0);
    expect(ps.ammo[WP.RAILGUN]).toBe(0);
  });
});

describe('the inactivity timer (g_inactivity)', () => {
  /** A player on another machine. */
  const REMOTE = '\\name\\Sarge\\ip\\1.2.3.4';
  const WARNING = 'cp "Ten seconds until inactivity drop!\n"';

  /** A frame every 100 ms up to `until`, the player sending `input` in each. */
  function hold(fixture: Fixture, until: number, input: Partial<NetUserCmd> = {}): void {
    const { game, traps } = fixture;
    for (let time = game.level.time + 100; time <= until; time += 100) {
      game.runFrame(time);
      traps.cmds.set(0, { ...createNetUserCmd(), ...input, serverTime: time });
      game.clientThink(0);
    }
  }

  const warnings = (fixture: Fixture) =>
    fixture.traps.commands.filter(({ to, text }) => to === 0 && text === WARNING);

  it('drops a player who stands still for its seconds, warning them ten seconds before', () => {
    const fixture = makeGame({}, { g_inactivity: '30' });
    join(fixture, 0, REMOTE);

    hold(fixture, 19_900);
    expect(warnings(fixture)).toHaveLength(0);
    hold(fixture, 20_100);
    expect(warnings(fixture)).toHaveLength(1);
    hold(fixture, 30_000);
    expect(fixture.traps.dropped).toEqual([]);
    hold(fixture, 30_100);
    expect(fixture.traps.dropped).toEqual([{ clientNum: 0, reason: 'Dropped due to inactivity' }]);
    expect(warnings(fixture)).toHaveLength(1);
  });

  it('starts again whenever the player moves or attacks', () => {
    const fixture = makeGame({}, { g_inactivity: '30' });
    join(fixture, 0, REMOTE);

    hold(fixture, 25_000);
    hold(fixture, 25_100, { forwardmove: 127 });
    hold(fixture, 50_000);
    hold(fixture, 50_100, { buttons: BUTTON_ATTACK });
    hold(fixture, 80_000);
    expect(fixture.traps.dropped).toEqual([]);
    hold(fixture, 80_200);
    expect(fixture.traps.dropped).toHaveLength(1);
  });

  it("never drops the player at a listen server's own screen", () => {
    const fixture = makeGame({}, { g_inactivity: '30' });
    join(fixture, 0, '\\name\\Sarge\\ip\\localhost');
    hold(fixture, 60_000);
    expect(fixture.traps.dropped).toEqual([]);
    expect(warnings(fixture)).toHaveLength(0);
  });

  it('drops nobody at 0, and gives everyone a minute when it is turned on in play', () => {
    const fixture = makeGame();
    join(fixture, 0, REMOTE);
    hold(fixture, 100_000);
    expect(fixture.traps.dropped).toEqual([]);

    fixture.cvars.set('g_inactivity', '5');
    hold(fixture, 159_900);
    expect(fixture.traps.dropped).toEqual([]);
    hold(fixture, 160_100);
    expect(fixture.traps.dropped).toHaveLength(1);
  });
});

describe("the movers' calls into the game and the host", () => {
  it("registers a mover's second model in CS_MODELS, from 1, each once", () => {
    const { game, traps } = makeGame();
    const { modelIndex } = game.level.itemMatch;
    expect(modelIndex('models/test/frame.md3')).toBe(1);
    expect(modelIndex('models/test/rail.md3')).toBe(2);
    expect(modelIndex('models/test/frame.md3')).toBe(1);
    expect(traps.configstrings.get(CONFIGSTRING.MODELS + 1)).toBe('models/test/frame.md3');
    expect(traps.configstrings.get(CONFIGSTRING.SOUNDS + 1)).not.toBe('models/test/frame.md3');
  });

  it("hands a door's portal to the host", () => {
    const { game, traps } = makeGame();
    game.level.adjustAreaPortalState(game.level.gentities[80], true);
    expect(traps.portals).toEqual([{ number: 80, open: true }]);
  });

  it('asks the host whether one point sees another', () => {
    const { game, traps } = makeGame();
    traps.sees = false;
    expect(game.level.inPVS(vec3(1, 2, 3), vec3(4, 5, 6))).toBe(false);
    expect(traps.sights).toEqual([[vec3(1, 2, 3), vec3(4, 5, 6)]]);
  });
});

describe("the move's touches", () => {
  /** A player on a floor the move's traces name as an entity, a frame after landing on it. */
  function onFloor() {
    const fixture = makeGame({ entities: mapOf(spawnSpot(vec3(0, 0, 20))) });
    const floor = fixture.game.level.spawnEntity();
    const flat = createFlatWorldTrace();
    fixture.traps.world = (...args) => {
      const result = flat(...args);
      return result.fraction < 1 ? { ...result, entityNum: floor.s.number } : result;
    };
    join(fixture, 0);
    fixture.game.runFrame(1000);
    press(fixture, 0, 0);
    fixture.game.runFrame(1050);
    return { fixture, floor, entity: fixture.game.level.gentities[0] };
  }

  it('touches what the move stood on once the player is linked at the exact origin', () => {
    const { fixture, floor } = onFloor();
    const seen: Vec3[] = [];
    floor.touch = (_self, other) => seen.push(copy(other.r.currentOrigin));
    press(fixture, 0, 0);
    const { ps } = fixture.game.level.clients[0];
    // An eighth of a unit above the floor, which a snapped origin would lose.
    expect(ps.origin.z % 1).not.toBe(0);
    expect(seen).toEqual([copy(ps.origin)]);
  });

  it('keeps an event a touch raised on the entity, for every client to see', () => {
    const { fixture, floor, entity } = onFloor();
    entity.eventTime = 0;
    floor.touch = (_self, other) => addPredictableEvent(other.client!.ps, EV.JUMP_PAD, 0);
    press(fixture, 0, 0);
    expect(entity.eventTime).toBe(1050);
  });
});

describe('the chat', () => {
  /** Every chat line sent, to whom and what it said. */
  function chat(fixture: Fixture): { to: number | null; text: string }[] {
    return fixture.traps.commands.filter((command) => /^t?chat /.test(command.text));
  }

  /** A free-for-all with A, B and C in, the commands and prints of their arrival cleared. */
  function threeIn(cvarValues = {}): Fixture {
    const fixture = makeGame({}, cvarValues);
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    join(fixture, 2, '\\name\\C');
    fixture.traps.commands.length = 0;
    fixture.traps.prints.length = 0;
    return fixture;
  }

  /** A `target_location` at a point. */
  function location(origin: Vec3, message: string, count?: number): TestEntity {
    return {
      classname: 'target_location',
      origin: `${origin.x} ${origin.y} ${origin.z}`,
      message,
      ...(count === undefined ? {} : { count: String(count) })
    };
  }

  /**
   * A team game with these locations, linked: A and B on red, C on blue and D watching, A at the
   * origin.
   */
  function teamGame(...locations: TestEntity[]): Fixture {
    const entities = mapOf(spawnSpot(vec3()), ...locations);
    const fixture = makeGame({ gametype: GT.TEAM, entities });
    ['A', 'B', 'C', 'D'].forEach((name, i) => join(fixture, i, `\\name\\${name}`));
    putOnTeam(fixture, 0, TEAM.RED);
    putOnTeam(fixture, 1, TEAM.RED);
    putOnTeam(fixture, 2, TEAM.BLUE);
    putOnTeam(fixture, 3, TEAM.SPECTATOR);
    // `target_location_linkup` runs 200 ms in.
    fixture.game.runFrame(1000);
    fixture.game.level.gentities[0].r.currentOrigin = vec3();
    fixture.traps.commands.length = 0;
    fixture.traps.prints.length = 0;
    return fixture;
  }

  it("says a line to everyone who has begun, in green, as G_Say's chat (g_cmds.c:871–929)", () => {
    const fixture = threeIn();
    // A bot's entity is in use from its connect, before it has begun.
    fixture.traps.userinfos.set(3, '\\name\\Grunt');
    fixture.game.clientConnect(3, true, true);
    expect(fixture.game.level.gentities[3].inuse).toBe(true);

    fixture.game.clientCommand(0, ['say', 'hello', 'there']);

    const line = 'chat "A^7\x19: ^2hello there"';
    expect(chat(fixture)).toEqual([0, 1, 2].map((to) => ({ to, text: line })));
  });

  it('says nothing for a say with no words, and an empty line for an empty one', () => {
    const fixture = threeIn();

    fixture.game.clientCommand(0, ['say']);
    expect(chat(fixture)).toEqual([]);

    fixture.game.clientCommand(0, ['SAY', '']);
    expect(chat(fixture).map((line) => line.text)).toEqual(Array(3).fill('chat "A^7\x19: ^2"'));
  });

  it('joins the words by single spaces, a quoted one whole, its line breaks made spaces', () => {
    const fixture = threeIn();

    fixture.game.clientCommand(0, ['say', 'two  spaces', 'and', 'a\nbreak\rhere']);

    expect(chat(fixture)[0].text).toBe('chat "A^7\x19: ^2two  spaces and a break here"');
  });

  it('cuts what was said to 149 characters (MAX_SAY_TEXT)', () => {
    const fixture = threeIn();

    fixture.game.clientCommand(0, ['say', 'x'.repeat(100), 'y'.repeat(100)]);

    const said = `${'x'.repeat(100)} ${'y'.repeat(48)}`;
    expect(said).toHaveLength(149);
    expect(chat(fixture)[0].text).toBe(`chat "A^7\x19: ^2${said}"`);
  });

  it('stops ConcatArgs before a word that would fill MAX_STRING_CHARS (g_cmds.c:134–159)', () => {
    const fixture = atIntermission();

    // At the intermission the whole command is said, so a command of one 1,023-byte word says
    // nothing, and one ending in such a word says the words before it, the space left on.
    fixture.traps.commands.length = 0;
    fixture.game.clientCommand(0, ['z'.repeat(1023)]);
    fixture.game.clientCommand(0, ['a', 'z'.repeat(1021)]);

    expect(chat(fixture).map((line) => line.text)).toEqual([
      'chat "Sarge^7\x19: ^2"',
      'chat "Sarge^7\x19: ^2a "'
    ]);
  });

  it('prints a line said to everyone on the console where no client runs beside the server', () => {
    const dedicated = threeIn({ cl_running: '0' });
    dedicated.game.clientCommand(0, ['say', 'hello']);
    dedicated.game.clientCommand(0, ['say_team', 'hi']);
    dedicated.game.clientCommand(0, ['tell', '1', 'psst']);
    // `G_Printf( "%s%s\n", name, text )`: the marks as they are, and the text without its colour.
    expect(dedicated.traps.prints).toEqual(['A^7\x19: hello\n', 'A^7\x19: hi\n']);

    // The page's server, whose player is printed the line by cgame.
    const page = threeIn({ cl_running: '1', dedicated: '1' });
    page.game.clientCommand(0, ['say', 'hello']);
    expect(page.traps.prints).toEqual([]);
  });

  it('says a team line to everyone below a team game, as plain chat', () => {
    const fixture = threeIn();

    fixture.game.clientCommand(0, ['say_team', 'hi']);

    expect(chat(fixture)).toEqual([0, 1, 2].map((to) => ({ to, text: 'chat "A^7\x19: ^2hi"' })));
  });

  it("says a team line to the speaker's team alone, in cyan, as tchat (OnSameTeam)", () => {
    const fixture = teamGame();

    fixture.game.clientCommand(0, ['say_team', 'hi']);
    // A spectator's team is the spectators.
    fixture.game.clientCommand(3, ['say_team', 'hey']);

    expect(chat(fixture)).toEqual([
      { to: 0, text: 'tchat "\x19(A^7\x19)\x19: ^5hi"' },
      { to: 1, text: 'tchat "\x19(A^7\x19)\x19: ^5hi"' },
      { to: 3, text: 'tchat "\x19(D^7\x19)\x19: ^5hey"' }
    ]);
  });

  it("says where the speaker is: the nearest location in their PVS (Team_GetLocation)", () => {
    const fixture = teamGame(
      location(vec3(100, 0, 0), 'Rail'),
      location(vec3(50, 0, 0), 'Hidden'),
      location(vec3(300, 0, 0), 'Far')
    );
    fixture.traps.inPVS = (_p1, p2) => p2.x !== 50;

    fixture.game.clientCommand(0, ['say_team', 'hi']);

    expect(chat(fixture)[0].text).toBe('tchat "\x19(A^7\x19) (Rail)\x19: ^5hi"');
  });

  it('names the first of two locations as near, as the chain walks back to it', () => {
    const fixture = teamGame(
      location(vec3(0, 100, 0), 'First'),
      location(vec3(0, -100, 0), 'Second')
    );

    fixture.game.clientCommand(0, ['say_team', 'hi']);

    expect(chat(fixture)[0].text).toBe('tchat "\x19(A^7\x19) (First)\x19: ^5hi"');
  });

  it("colours a location by its count, held to 0–7 once it isn't 0 (Team_GetLocationMsg)", () => {
    const said = (count: number) => {
      const fixture = teamGame(location(vec3(100, 0, 0), 'Rail', count));
      fixture.game.clientCommand(0, ['say_team', 'hi']);
      return chat(fixture)[0].text;
    };

    expect(said(3)).toBe('tchat "\x19(A^7\x19) (^3Rail^7)\x19: ^5hi"');
    expect(said(12)).toBe('tchat "\x19(A^7\x19) (^7Rail^7)\x19: ^5hi"');
    // Found non-zero before it is held, so a negative count is black.
    expect(said(-2)).toBe('tchat "\x19(A^7\x19) (^0Rail^7)\x19: ^5hi"');
  });

  it('names a location with no message as nothing, as its configstring does', () => {
    const fixture = teamGame({ classname: 'target_location', origin: '100 0 0' });

    fixture.game.clientCommand(0, ['say_team', 'hi']);

    expect(chat(fixture)[0].text).toBe('tchat "\x19(A^7\x19) ()\x19: ^5hi"');
  });

  it('says no location before the locations link, or where none is in sight', () => {
    const early = makeGame({
      gametype: GT.TEAM,
      entities: mapOf(spawnSpot(vec3()), location(vec3(100, 0, 0), 'Rail'))
    });
    join(early, 0, '\\name\\A');
    putOnTeam(early, 0, TEAM.RED);
    early.game.clientCommand(0, ['say_team', 'hi']);
    expect(chat(early)[0].text).toBe('tchat "\x19(A^7\x19)\x19: ^5hi"');

    const unseen = teamGame(location(vec3(100, 0, 0), 'Rail'));
    unseen.traps.sees = false;
    unseen.game.clientCommand(0, ['say_team', 'hi']);
    expect(chat(unseen)[0].text).toBe('tchat "\x19(A^7\x19)\x19: ^5hi"');
  });

  it('cuts the name and the location to 63 bytes as Com_sprintf does, and says so', () => {
    /** What A's team line puts on the console and sends, by its location's length. */
    const said = (length: number) => {
      const fixture = teamGame(location(vec3(100, 0, 0), 'L'.repeat(length)));
      fixture.game.clientCommand(0, ['say_team', 'hi']);
      return { prints: fixture.traps.prints, line: chat(fixture)[0].text };
    };
    /** A's name part around a location: 13 bytes and the location. */
    const nameAround = (loc: string) => `\x19(A^7\x19) (${loc})\x19: `;

    // The location first, into its own 64 bytes, then the name around it, then the echo.
    const cut = nameAround('L'.repeat(63)).slice(0, 63);
    expect(said(64)).toEqual({
      prints: [
        'Com_sprintf: Output length 64 too short, require 65 bytes.\n',
        'Com_sprintf: Output length 64 too short, require 77 bytes.\n',
        `${cut}hi\n`
      ],
      line: `tchat "${cut}^5hi"`
    });

    // A location of 51 bytes makes a name of 64, one too many; one of 50 fits.
    expect(said(51).prints[0]).toBe('Com_sprintf: Output length 64 too short, require 65 bytes.\n');
    expect(said(51).line).toBe(`tchat "${nameAround('L'.repeat(51)).slice(0, 63)}^5hi"`);
    expect(said(50)).toEqual({
      prints: [`${nameAround('L'.repeat(50))}hi\n`],
      line: `tchat "${nameAround('L'.repeat(50))}^5hi"`
    });
  });

  it("lets a free-for-all's onlookers chat to its players", () => {
    const fixture = threeIn();
    putOnTeam(fixture, 2, TEAM.SPECTATOR);

    fixture.game.clientCommand(2, ['say', 'hi']);

    expect(chat(fixture).map((line) => line.to)).toEqual([0, 1, 2]);
  });

  it("keeps a tournament's onlookers from chatting to its players", () => {
    const duel = makeGame({ gametype: GT.TOURNAMENT });
    join(duel, 0, '\\name\\A');
    join(duel, 1, '\\name\\B');
    join(duel, 2, '\\name\\C');
    join(duel, 3, '\\name\\D');
    putOnTeam(duel, 0, TEAM.FREE);
    putOnTeam(duel, 1, TEAM.FREE);
    putOnTeam(duel, 2, TEAM.SPECTATOR);
    putOnTeam(duel, 3, TEAM.SPECTATOR);
    duel.traps.commands.length = 0;

    duel.game.clientCommand(2, ['say', 'hi']);
    duel.game.clientCommand(0, ['say', 'gg']);

    expect(chat(duel)).toEqual([
      { to: 2, text: 'chat "C^7\x19: ^2hi"' },
      { to: 3, text: 'chat "C^7\x19: ^2hi"' },
      ...[0, 1, 2, 3].map((to) => ({ to, text: 'chat "A^7\x19: ^2gg"' }))
    ]);
  });

  it('tells a slot in magenta, and the teller their own line (Cmd_Tell_f, g_cmds.c:973)', () => {
    const fixture = threeIn();

    fixture.game.clientCommand(0, ['tell', '2', 'meet', 'at', 'the\nrail']);

    const line = 'chat "\x19[A^7\x19]\x19: ^6meet at the rail"';
    expect(chat(fixture)).toEqual([
      { to: 2, text: line },
      { to: 0, text: line }
    ]);
  });

  it('tells a name, its colours and case aside, and says so when nobody answers to it', () => {
    const fixture = threeIn();
    fixture.traps.userinfos.set(1, '\\name\\^1Bo^2nes');
    fixture.game.clientUserinfoChanged(1);
    fixture.traps.commands.length = 0;

    fixture.game.clientCommand(0, ['tell', 'bones', 'hi']);
    fixture.game.clientCommand(0, ['tell', 'Doom', 'hi']);

    expect(fixture.traps.commands.filter((command) => command.to === 1)).toEqual([
      { to: 1, text: 'chat "\x19[A^7\x19]\x19: ^6hi"' }
    ]);
    expect(prints(fixture)).toContain('print "User Doom is not on the server\n"');
  });

  it('gives the usage for a tell with no text, and tells oneself once', () => {
    const fixture = threeIn();

    fixture.game.clientCommand(0, ['tell', '1']);
    fixture.game.clientCommand(0, ['tell', '0', 'note']);

    expect(fixture.traps.commands).toEqual([
      { to: 0, text: 'print "Usage: tell <player id> <message>\n"' },
      { to: 0, text: 'chat "\x19[A^7\x19]\x19: ^6note"' }
    ]);
  });

  it('sends a bot no copy of its own tell', () => {
    const fixture = threeIn();
    joinBot(fixture, 3);
    fixture.traps.commands.length = 0;

    fixture.game.clientCommand(3, ['tell', '0', 'hi']);

    expect(chat(fixture)).toEqual([{ to: 0, text: 'chat "\x19[Grunt^7\x19]\x19: ^6hi"' }]);
  });

  it('says no location in a tell below a team game', () => {
    const entities = mapOf(spawnSpot(vec3()), location(vec3(100, 0, 0), 'Rail'));
    const fixture = makeGame({ entities });
    join(fixture, 0, '\\name\\A');
    join(fixture, 1, '\\name\\B');
    fixture.game.runFrame(1000);
    fixture.traps.commands.length = 0;

    fixture.game.clientCommand(0, ['tell', '1', 'hi']);

    expect(chat(fixture)[0].text).toBe('chat "\x19[A^7\x19]\x19: ^6hi"');
  });

  it('says where the teller is to a teammate alone, and to the teller', () => {
    const fixture = teamGame(location(vec3(100, 0, 0), 'Rail'));

    fixture.game.clientCommand(0, ['tell', '1', 'here']);
    fixture.game.clientCommand(0, ['tell', '2', 'there']);

    expect(chat(fixture)).toEqual([
      { to: 1, text: 'chat "\x19[A^7\x19] (Rail)\x19: ^6here"' },
      { to: 0, text: 'chat "\x19[A^7\x19] (Rail)\x19: ^6here"' },
      { to: 2, text: 'chat "\x19[A^7\x19]\x19: ^6there"' },
      // The teller's own copy is a tell to a teammate.
      { to: 0, text: 'chat "\x19[A^7\x19] (Rail)\x19: ^6there"' }
    ]);
  });

  it("keeps a tournament onlooker's tell from its players, but not their own copy", () => {
    const duel = makeGame({ gametype: GT.TOURNAMENT });
    join(duel, 0, '\\name\\A');
    join(duel, 1, '\\name\\B');
    join(duel, 2, '\\name\\C');
    putOnTeam(duel, 2, TEAM.SPECTATOR);
    duel.traps.commands.length = 0;

    duel.game.clientCommand(2, ['tell', '0', 'hi']);

    expect(chat(duel)).toEqual([{ to: 2, text: 'chat "\x19[C^7\x19]\x19: ^6hi"' }]);
  });

  it('chats at the intermission, and says any other command there to everyone', () => {
    const fixture = atIntermission(2);
    fixture.traps.commands.length = 0;

    fixture.game.clientCommand(0, ['say_team', 'well', 'played']);
    fixture.game.clientCommand(1, ['kill']);

    expect(chat(fixture).map((line) => line.text)).toEqual([
      'chat "Sarge^7\x19: ^2well played"',
      'chat "Sarge^7\x19: ^2well played"',
      'chat "Sarge^7\x19: ^2kill"',
      'chat "Sarge^7\x19: ^2kill"'
    ]);
    expect(fixture.game.level.clients[1].ps.stats[STAT.HEALTH]).toBeGreaterThan(0);
  });
});
