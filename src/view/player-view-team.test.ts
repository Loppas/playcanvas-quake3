import { describe, expect, it, vi } from 'vitest';

import { atoi } from '../formats/c-scan';
import { K } from '../formats/q3-keys';
import { CONFIGSTRING } from '../net/commands';
import { infoValueForKey } from '../net/info';
import { GameConfig } from '../settings/game-config';
import { PERS, PM_INTERMISSION, PM_SPECTATOR, PMOVE_MSEC, STAT, TEAM } from '../sim/constants';
import { SPECTATOR } from '../sim/client';
import type { UserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { Menu, type MenuPage } from './menu';
import { inGamePage, setupPage, type MenuContext } from './menu-pages';
import { CATCH_UP, ViewWorld } from './view-test-fixtures';

/**
 * The `team` command through the real loop: the client sends it up the wire, the match changes
 * the team and answers with a centre print, and what the client is shown afterwards is the
 * spectator's own state — and the menu's team page, which is the only thing that sends it.
 */

function live(): ViewWorld {
  return new ViewWorld({ origin: vec3(0, 0, 24) });
}

/** Where the two held bots stand, well apart, so a glide between them would be plain. */
const HERE = vec3(200, 0, 24);
const THERE = vec3(-200, 0, 24);

/** A command holding nothing, for the ticks that only want time to pass. */
const STILL: Omit<UserCmd, 'serverTime'> = {
  forwardmove: 0,
  rightmove: 0,
  upmove: 0,
  angles: vec3(),
  buttons: 0,
  weapon: WP.MACHINEGUN
};

/** One frame of holding `input`, which is one tick of the loop. */
function tick(world: ViewWorld, input: Partial<Omit<UserCmd, 'serverTime'>> = {}): void {
  const cmd: Omit<UserCmd, 'serverTime'> = {
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
    angles: vec3(),
    buttons: 0,
    weapon: WP.MACHINEGUN,
    ...input
  };
  world.view.advance(PMOVE_MSEC, cmd);
}

/**
 * The ticks a team change takes to reach the player state, and the view to draw it. The spawn it
 * makes puts the player's clock at the frame's time, which the command sent alongside does not
 * pass, so that command moves nothing and a spectator's first move is the tick after.
 */
function settle(world: ViewWorld): void {
  for (let i = 0; i < 2 + CATCH_UP; i++) tick(world);
}

/** Ticks until the view says `done`, as many as it takes a snapshot to be drawn and a few. */
function until(world: ViewWorld, done: () => boolean): void {
  for (let i = 0; i < CATCH_UP + 3 && !done(); i++) tick(world);
  expect(done()).toBe(true);
}

describe('the team command through the wire', () => {
  it('tells the client, in the middle of the screen, that it has left the match', () => {
    const world = live();
    tick(world);

    world.game.sendClientCommand('team spectator');
    until(world, () => world.view.centerPrint !== null);

    expect(world.view.centerPrint?.text).toMatch(/joined the spectators/);
    // Where `CG_UseItem` puts its own message.
    expect(world.view.centerPrint).toMatchObject({ y: 144, charWidth: 16 });
    // Frame-scoped: the next frame has nothing to raise.
    tick(world);
    expect(world.view.centerPrint).toBeNull();
  });

  it('leaves the client spectating, flying where it stood', () => {
    const world = live();
    tick(world);

    world.game.sendClientCommand('team spectator');
    for (let i = 0; i < 40; i++) tick(world, { upmove: 127 });

    const client = world.level.clients[world.game.clientNum];
    expect(client.sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(client.sess.spectatorState).toBe(SPECTATOR.FREE);
    expect(client.ps.pmType).toBe(PM_SPECTATOR);
    expect(client.ps.velocity.z).toBeGreaterThan(0);
    expect(world.entity.r.linked).toBe(false);
  });

  it('leaves a spectator flying free no body to draw', () => {
    const world = live();
    tick(world);
    // Playing, there is a body behind the camera for `cg_thirdPerson` to put it in front of.
    expect(world.view.bodyDrawn).toBe(true);

    world.game.sendClientCommand('team spectator');
    settle(world);

    // `BG_PlayerStateToEntityState` makes a spectator `ET_INVISIBLE`, so third person has
    // nothing to show where the camera used to sit behind them.
    expect(world.view.player.pmType).toBe(PM_SPECTATOR);
    expect(world.view.bodyDrawn).toBe(false);
  });

  it('keeps a spectator in its own eyes under cg_thirdPerson, as ioquake3 does', () => {
    const world = live();
    world.view.thirdPerson = true;
    tick(world);
    expect(world.view.renderingThirdPerson).toBe(true);

    world.game.sendClientCommand('team spectator');
    settle(world);
    expect(world.view.player.persistant[PERS.TEAM]).toBe(TEAM.SPECTATOR);
    expect(world.view.renderingThirdPerson).toBe(false);
  });

  it('leaves nobody a body at the intermission', () => {
    const world = live();
    tick(world);

    world.view.player.pmType = PM_INTERMISSION;
    expect(world.view.bodyDrawn).toBe(false);
  });

  it('puts the client back into the match when it asks to play again', () => {
    const world = live();
    tick(world);
    world.game.sendClientCommand('team spectator');
    tick(world);
    world.level.clients[world.game.clientNum].switchTeamTime = 0;

    world.game.sendClientCommand('team free');
    tick(world);

    const client = world.level.clients[world.game.clientNum];
    expect(client.sess.sessionTeam).toBe(TEAM.FREE);
    expect(client.ps.stats[STAT.HEALTH]).toBeGreaterThan(0);
    expect(world.entity.r.linked).toBe(true);
  });
});

describe('a spectator changing who they watch', () => {
  /** A match with two held bots on spots of their own, and the player watching the first. */
  function watching(): ViewWorld {
    const world = new ViewWorld({ origin: vec3(0, 0, 24), spots: [HERE, THERE] });
    for (const name of ['grunt', 'sarge']) {
      world.game.host.sendConsoleCommand(`addbot ${name}\n`);
      for (let i = 0; i < 40; i++) tick(world);
    }
    expect(world.level.clients[1].ps.origin).toEqual(HERE);
    expect(world.level.clients[2].ps.origin).toEqual(THERE);

    world.game.sendClientCommand('team spectator');
    tick(world);
    world.game.sendClientCommand('follow 1');
    until(world, () => world.view.player.clientNum === 1);
    return world;
  }

  it('does not glide across the map from the last one', () => {
    const world = watching();

    // Half-tick frames, so anything drawn between two snapshots shows: the view is where one or
    // the other stands, and never half way between.
    world.game.sendClientCommand('follownext');
    for (let i = 0; i < 2 * (1 + CATCH_UP) + 2 && world.view.player.clientNum !== 2; i++) {
      world.view.advance(PMOVE_MSEC / 2, STILL);
      expect([HERE, THERE]).toContainEqual(world.view.sample().origin);
    }
    expect(world.view.player.clientNum).toBe(2);
    world.view.advance(PMOVE_MSEC / 2, STILL);
    expect(world.view.sample().origin).toEqual(THERE);
  });

  it('does not read the new one\'s wounds as a hurt of its own', () => {
    const world = watching();
    const before = world.view.damage.time;
    // The player being watched next was hurt a moment ago, which their state still carries.
    const hurt = world.level.clients[2].ps;
    hurt.damageEvent = 7;
    hurt.damageCount = 40;
    hurt.damageYaw = 90;

    world.game.sendClientCommand('follownext');
    until(world, () => world.view.player.clientNum === 2);
    expect(world.view.damage.time).toBe(before);
  });

  it("does not read the new one's spawns as a respawn of its own", () => {
    const world = watching();
    // Whoever is watched next has died and come back a few times since the match began, so the
    // spawn count riding in on their state is not the one this client has been counting against.
    world.level.clients[2].ps.persistant[PERS.SPAWN_COUNT] += 3;

    world.game.sendClientCommand('follownext');
    until(world, () => world.view.player.clientNum === 2);
    // A respawn brings the body into view afresh, which would replay a corpse's death.
    expect(world.view.respawned).toBe(false);
  });

  it("does not hear the new one's hits and place as news of its own", () => {
    const world = watching();
    // Whoever is watched next has hit more and stands higher than the one watched now.
    const next = world.level.clients[2].ps;
    next.persistant[PERS.HITS] += 5;
    next.persistant[PERS.RANK] = 0;
    world.level.clients[1].ps.persistant[PERS.RANK] = 2;

    world.game.sendClientCommand('follownext');
    const heard: string[] = [];
    for (let i = 0; i < 100; i++) {
      tick(world);
      heard.push(...world.view.voices);
    }

    expect(world.view.player.clientNum).toBe(2);
    expect(heard).toEqual([]);
  });

  it('is the one being watched, whose look and colour the client takes', () => {
    const world = watching();
    // Both bots joined after the client's load, so their looks were put off until now.
    world.view.loadDeferredPlayers();

    // The body built from a followed player's state is that player's, and `CG_Player` dresses
    // what it draws from the state's own `clientNum` (`cg_players.c:2259–2270`) — so a client
    // watching a bot wears the bot's model rather than its own `model` cvar. The status bar's
    // head is that slot's as well (`cg_draw.c:468–469`).
    expect(world.view.followed?.look.body.model).toBe('grunt');

    world.game.sendClientCommand('follownext');
    until(world, () => world.view.followed?.look.body.model === 'sarge');
  });

  it('has a body to draw, which is the one being watched', () => {
    // A follower is wearing the followed player's whole state, so what stands behind the camera
    // in third person is that player — unlike a spectator flying free, who is nobody.
    expect(watching().view.bodyDrawn).toBe(true);
  });

  it('is nobody while the state on show is the client’s own', () => {
    const world = live();
    tick(world);

    // There is a client in the slot to be had: what answers nobody is `PMF_FOLLOW` being clear,
    // which is how Quake 3 knows a state is the viewer's own (`CG_DrawFollow`, `cg_draw.c:2259`).
    expect(world.view.clientInfo(world.game.clientNum)).not.toBeNull();
    expect(world.view.followed).toBeNull();

    // And a spectator with nobody to follow is still looking out of its own state.
    world.game.sendClientCommand('team spectator');
    settle(world);

    expect(world.view.player.pmType).toBe(PM_SPECTATOR);
    expect(world.view.followed).toBeNull();
  });
});

describe('the team page over a live match', () => {
  /** The in-game menu over a running match, wired to it as `App` wires it. */
  function menuOver(world: ViewWorld) {
    const menu = new Menu();
    const resumed = vi.fn();
    const config = new GameConfig({ warn: () => {} });
    const context: MenuContext = {
      menu,
      config,
      models: () => [],
      bots: () => [],
      presets: () => [],
      clientInfo: () => null,
      // `cgs.gametype`, as `App` reads it out of the serverinfo the match keeps.
      gametype: () => atoi(infoValueForKey(world.game.host.getConfigstring(CONFIGSTRING.SERVERINFO), 'g_gametype')),
      maxClients: () => 8,
      serverinfo: () => world.game.host.getConfigstring(CONFIGSTRING.SERVERINFO),
      // The match is this client's own server's, as `App`'s host answers it.
      serverRunning: () => true,
      actions: {
        resume: resumed,
        restart: () => {},
        vidRestart: () => {},
        exportConfig: () => {},
        importConfig: () => {},
        exit: () => {},
        addBot: () => {},
        removeBot: () => {},
        setTeam: (team) => world.game.sendClientCommand(`team ${team}`),
        command: () => {},
        addFavorite: () => {}
      }
    };
    const page: MenuPage = inGamePage(context, setupPage(context));
    menu.open(page);
    return { menu, page, resumed };
  }

  /** Point at a row by what it reads, and click it. */
  function click(menu: Menu, label: string): void {
    const index = menu.page!.items.findIndex((row) => row.label === label);
    expect(index, label).toBeGreaterThanOrEqual(0);
    menu.hover(index, { x: 0.5 });
    menu.key(K.MOUSE1);
  }

  it('takes the player out of the match from SPECTATE, and puts them back from JOIN GAME', () => {
    const world = live();
    tick(world);
    const { menu, page, resumed } = menuOver(world);
    const client = world.level.clients[world.game.clientNum];

    click(menu, 'START');
    click(menu, 'SPECTATE');
    settle(world);

    expect(client.sess.sessionTeam).toBe(TEAM.SPECTATOR);
    expect(client.ps.pmType).toBe(PM_SPECTATOR);
    // The whole menu went, and the game is being played again under it.
    expect(menu.isOpen).toBe(false);
    expect(resumed).toHaveBeenCalledOnce();

    // Q3's five seconds between team changes, which a player waits out rather than a test.
    client.switchTeamTime = 0;
    menu.open(page);
    click(menu, 'START');
    click(menu, 'JOIN GAME');
    tick(world);

    expect(client.sess.sessionTeam).toBe(TEAM.FREE);
    expect(client.ps.stats[STAT.HEALTH]).toBeGreaterThan(0);
    expect(world.entity.r.linked).toBe(true);
  });
});
