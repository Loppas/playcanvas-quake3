// @vitest-environment jsdom
import type { Entity } from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';
import { simToWorld } from './coords';
import { K } from './formats/q3-keys';
import { CONFIGSTRING } from './net/commands';
import { ENTITYNUM_WORLD } from './net/protocol';
import {
  PlayerController,
  buildUserCmd,
  cameraPose,
  type CameraPose,
  horizontalSpeed,
  updatePeak
} from './player-controller';
import { CS } from './server/host';
import { defaultBinds } from './settings/binds';
import { KEYCATCH, type ClientInput } from './settings/client-input';
import { Cvars } from './settings/cvars';
import { routedInput } from './settings/input-test-fixtures';
import { createFlatWorldTrace } from './sim/box-world';
import { damage } from './sim/combat';
import {
  BUTTON_AFFIRMATIVE,
  BUTTON_ATTACK,
  BUTTON_TALK,
  CONTENTS,
  EF_TALK,
  GT,
  MOD,
  PITCH_LIMIT_DEGREES,
  STAT
} from './sim/constants';
import { EV } from './sim/events';
import { addEvent, ET } from './sim/game-entity';
import { SPAWN_LIFT } from './sim/game';
import { addPredictableEvent } from './sim/events';
import { touchItem } from './sim/item-touch';
import { findItem, HI, itemIndex, PW } from './sim/items';
import { mapOf, spawnSpot } from './sim/map-test-fixtures';
import { angleVectors } from './sim/pmove-math';
import type { PointContentsFn } from './sim/types';
import { vec3 } from './sim/vec3';
import { WP } from './sim/weapons/constants';
import { fireMissile } from './sim/weapons/missile';
import type { FirstPersonView } from './view/camera-feel';
import { createCenterPrint } from './view/center-print';
import { BIGCHAR_WIDTH } from './view/hud-text';
import { LocalEntities } from './view/local-entities';
import { PlayerView } from './view/player-view';

/** No key held. The keys themselves go through the binds: `settings/client-input.test.ts`. */
const STILL = { forwardmove: 0, rightmove: 0, upmove: 0 };

const LEVEL = { yaw: 0, pitch: 0 };

describe('buildUserCmd', () => {
  it('carries the move the held keys made', () => {
    const cmd = buildUserCmd({ forwardmove: 127, rightmove: -127, upmove: -127 }, LEVEL);
    expect([cmd.forwardmove, cmd.rightmove, cmd.upmove]).toEqual([127, -127, -127]);
  });

  it('carries the buttons held and the weapon request, whole', () => {
    // Every key is a bit of one number, so the attack and the off-hand hook ride together and
    // the command says nothing about which key held either.
    const both = buildUserCmd(STILL, LEVEL, {
      buttons: BUTTON_ATTACK | BUTTON_AFFIRMATIVE,
      weapon: WP.RAILGUN
    });
    expect(both.buttons).toBe(BUTTON_ATTACK | BUTTON_AFFIRMATIVE);
    // A *request*: `PM_Weapon` compares it against `ps.weapon` and owns the 450 ms switch.
    expect(both.weapon).toBe(WP.RAILGUN);

    const idle = buildUserCmd(STILL, LEVEL, { buttons: 0, weapon: WP.RAILGUN });
    expect(idle.buttons).toBe(0);
  });

  it('holds no button and requests nothing when no keys are given', () => {
    // The fly-camera path and the movement tests both call it this way.
    const cmd = buildUserCmd({ ...STILL, forwardmove: 127 }, LEVEL);
    expect(cmd.buttons).toBe(0);
    expect(cmd.weapon).toBe(WP.NONE);
  });

  it('negates look pitch into Q3 convention, so looking up points the view up', () => {
    // Look maths: pitch positive = up. Q3: pitch positive = down. Passing look pitch +20 must
    // yield a Q3 pitch that makes the forward vector point up (+Z in the Z-up sim).
    const cmd = buildUserCmd(STILL, { yaw: 30, pitch: 20 });
    expect(cmd.angles.x).toBe(-20);
    expect(cmd.angles.y).toBe(30);
    expect(angleVectors(cmd.angles).forward.z).toBeGreaterThan(0);
  });
});

describe('cameraPose', () => {
  const at = (angles: [number, number, number], origin: [number, number, number] = [0, 0, 0]): FirstPersonView => ({
    origin: vec3(...origin),
    angles: vec3(...angles)
  });

  it('places the camera at the world-space eye', () => {
    const pose = cameraPose(at([0, 0, 0], [100, 50, 200]));
    expect(pose.position).toEqual(simToWorld(vec3(100, 50, 200)));
  });

  it('a level view looks along world up', () => {
    const { up } = cameraPose(at([0, 0, 0]));
    expect(up[1]).toBeGreaterThan(0); // +Y
    expect(up[0]).toBeCloseTo(0);
    expect(up[2]).toBeCloseTo(0);
  });

  it('delivers view roll to the up vector', () => {
    // The up vector is a direction (simToWorld scales it by 1/32), so normalise before checking.
    const norm = (v: [number, number, number]): [number, number, number] => {
      const m = Math.hypot(v[0], v[1], v[2]);
      return [v[0] / m, v[1] / m, v[2] / m];
    };
    const level = norm(cameraPose(at([0, 0, 0])).up);
    const rolled = norm(cameraPose(at([0, 0, 15])).up); // 15 degrees of roll
    expect(level[2]).toBeCloseTo(0);
    // Roll about the forward axis tilts up into world Z by exactly sin(roll).
    expect(Math.abs(rolled[2])).toBeCloseTo(Math.sin((15 * Math.PI) / 180), 4);
  });

  it('looks downward when the Q3 pitch is positive', () => {
    const pose = cameraPose(at([30, 0, 0])); // Q3 pitch 30 = nose down
    expect(pose.target[1]).toBeLessThan(pose.position[1]);
  });

  it('aims a unit ahead of the eye, wherever the eye is', () => {
    const { position, target } = cameraPose(at([0, 90, 0], [100, 50, 200]));
    // Yaw 90 faces Q3's +y, the world's -z.
    const ahead = target.map((t, i) => t - position[i]);
    expect(ahead[0]).toBeCloseTo(0, 10);
    expect(ahead[1]).toBeCloseTo(0, 10);
    expect(ahead[2]).toBeCloseTo(-1 / 32, 10);
  });

  it('rolls the up vector about the view at any heading, keeping it square to the view', () => {
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const { position, target, up } = cameraPose(at([20, 135, 10], [100, 50, 200]));
    const ahead = target.map((t, i) => t - position[i]);
    expect(dot(up, ahead)).toBeCloseTo(0, 10);
    expect(Math.hypot(...up)).toBeCloseTo(1 / 32, 10);
    const level = cameraPose(at([20, 135, 0], [100, 50, 200])).up;
    expect(dot(up, level) * 32 * 32).toBeCloseTo(Math.cos((10 * Math.PI) / 180), 10);
  });

  it('writes the pose into the one it is given, as it would make it', () => {
    const view = at([20, 135, 10], [100, 50, 200]);
    const into: CameraPose = { position: [9, 9, 9], target: [9, 9, 9], up: [9, 9, 9] };
    expect(cameraPose(view, into)).toBe(into);
    expect(into).toEqual(cameraPose(view));
  });
});

describe('speedometer', () => {
  it('measures horizontal speed only, ignoring the vertical component', () => {
    // 3-4-5: horizontal 5, whatever the fall speed.
    expect(horizontalSpeed(vec3(3, 4, -999))).toBe(5);
    expect(horizontalSpeed(vec3(0, 0, 270))).toBe(0); // a pure jump reads zero
    expect(horizontalSpeed(vec3(320, 0, 0))).toBe(320);
  });

  it('holds the running peak and only resets when stopped on the ground', () => {
    // Climbing: the peak follows the max, on the ground or in the air.
    let peak = updatePeak(0, 320, true);
    expect(peak).toBe(320);
    peak = updatePeak(peak, 480, false); // strafe-jumping past the cap, airborne
    expect(peak).toBe(480);
    peak = updatePeak(peak, 300, true); // back on the ground and slower: peak holds
    expect(peak).toBe(480);
    // Airborne near-zero must NOT reset the peak (only a ground stop does).
    expect(updatePeak(480, 1, false)).toBe(480);
    // Standing still on the ground starts the next run's peak fresh.
    expect(updatePeak(480, 2, true)).toBe(2);
  });
});

/** The camera, which the controller only places. */
const camera = { setPosition: () => {}, lookAt: () => {} } as unknown as Entity;

/**
 * A player over flat ground, the cvars they are playing under, and their keys, as if the mouse
 * were captured, with the console those keys' commands run through.
 *
 * The settings the *match* reads - god, the spawn armor, the grapple type - reach it by being
 * in this store, and are tested where the game module reads them. What is tested here is what
 * the client owns: the camera, the look, and what it tells the host about itself.
 */
function controlled(
  cvarValues: Record<string, string> = {},
  height = 0,
  localEntities?: LocalEntities,
  pointContents?: PointContentsFn
) {
  const cvars = new Cvars({ debugMode: true, print: () => {} });
  for (const [name, value] of Object.entries(cvarValues)) cvars.set(name, value);
  const { input, router } = routedInput(defaultBinds());
  input.active = true;
  // A spawn stands the player nine units above the point itself, so the point goes that far
  // below where they are wanted.
  const trace = createFlatWorldTrace();
  const entities = mapOf(spawnSpot(vec3(0, 0, 24 + height - SPAWN_LIFT), 90));
  const map = { name: 'test', entities, trace };
  const controller = new PlayerController(
    camera,
    input,
    trace,
    map,
    cvars,
    {},
    localEntities,
    pointContents
  );
  return { cvars, input, router, controller };
}

/**
 * Run 60 Hz frames until `done`, as many as it takes for what the host did to be drawn: the
 * snapshot comes back at the end of a frame, and the client's clock, running a little behind the
 * newest, reaches it a frame or two later.
 */
function until(controller: PlayerController, done: () => boolean): void {
  for (let frame = 0; frame < 10 && !done(); frame++) controller.update(1 / 60);
  expect(done()).toBe(true);
}

describe('the look', () => {
  /** A frame at 60 Hz. */
  const FRAME = 1 / 60;

  /** Kill the player through the match's own `G_Damage`, then click them back in. */
  function dieAndRespawn(input: ClientInput, controller: PlayerController): void {
    const { game, clientNum } = controller.game;
    const { level } = game;
    const health = level.clients[clientNum].ps.stats[STAT.HEALTH];
    damage(level, level.gentities[clientNum], null, null, null, health + 10, 0, MOD.FALLING);
    // The death plays for 1.7 s before attack respawns the player.
    for (let frame = 0; frame < 120; frame++) controller.update(FRAME);
    input.keyDown(K.MOUSE1);
    for (let frame = 0; frame < 30 && !controller.respawned; frame++) controller.update(FRAME);
    input.keyUp(K.MOUSE1);
    expect(controller.respawned).toBe(true);
  }

  it('reaches the pitch limit either way after a spawn, however the player died looking', () => {
    // The camera's angles are the frame's own, so each turn shows on the frame it was made.
    const pitch = (controller: PlayerController): number => controller.sample().viewangles.x;
    for (const held of [20000, -20000]) {
      const { input, controller } = controlled();
      input.mouseMove(0, held);
      controller.update(FRAME);
      // Q3's pitch is positive looking down, and the mouse's y is positive moving down.
      expect(pitch(controller)).toBeCloseTo(Math.sign(held) * PITCH_LIMIT_DEGREES, 4);

      dieAndRespawn(input, controller);
      // The spawn faces the player level by moving `delta_angles` under the pitch they held.
      expect(pitch(controller)).toBeCloseTo(0, 4);

      // Further the same way, which a client clamped at the limit could not go.
      input.mouseMove(0, held);
      controller.update(FRAME);
      expect(pitch(controller)).toBeCloseTo(Math.sign(held) * PITCH_LIMIT_DEGREES, 4);
      // And back at once, with nothing held past the limit to wind off.
      input.mouseMove(0, -Math.sign(held) * 100);
      controller.update(FRAME);
      expect(Math.abs(pitch(controller))).toBeLessThan(PITCH_LIMIT_DEGREES - 10);
    }
  });
});

describe('the settings, read each frame', () => {
  /** F, which throws the hook. */
  const GRAPPLE_KEY = 'f'.charCodeAt(0);

  it('puts the camera behind the body from the next frame', () => {
    const { cvars, controller } = controlled();
    expect(controller.renderingThirdPerson).toBe(false);
    cvars.set('cg_thirdPerson', '1');
    controller.update(1 / 60);
    expect(controller.renderingThirdPerson).toBe(true);
  });

  it('floats the plum of a score the player makes, unless cg_scorePlums is off', () => {
    const plums = (on: string): string[] => {
      const { controller } = controlled({ cg_scorePlums: on });
      controller.update(1 / 60);
      const { game, clientNum } = controller.game;
      const me = game.level.gentities[clientNum];
      damage(game.level, me, me, me, null, 100000, 0, MOD.SUICIDE);
      until(controller, () => controller.player.stats[STAT.HEALTH] <= 0);
      // The obituary's plum arrives with the snapshots, a frame or two behind the death the
      // prediction draws.
      let shaders: string[] = [];
      for (let frame = 0; frame < 6 && shaders.length === 0; frame++) {
        controller.update(1 / 60);
        shaders = controller.plumSprites(vec3(0, -1000, 0)).map(({ shader }) => shader);
      }
      return shaders;
    };
    expect(plums('1')).toEqual(['gfx/2d/numbers/minus_32b', 'gfx/2d/numbers/one_32b']);
    expect(plums('0')).toEqual([]);
  });

  it('keeps team lines by cg_teamChatHeight and Time, and mutes chat by cg_teamChatsOnly', () => {
    /** What a red player's own say and say_team come back as, under these cvars. */
    const chat = (values: Record<string, string>) => {
      const { controller } = controlled({ g_gametype: String(GT.TEAM), ...values });
      const printed: string[] = [];
      controller.console = { print: (text) => printed.push(text), clearNotify: () => {} };
      controller.update(1 / 60);
      const { game, clientNum } = controller.game;
      game.clientCommand(clientNum, ['team', 'red']);
      for (let frame = 0; frame < 10; frame++) controller.update(1 / 60);
      game.clientCommand(clientNum, ['say', 'to all']);
      game.clientCommand(clientNum, ['say_team', 'to red']);
      for (let frame = 0; frame < 10; frame++) controller.update(1 / 60);
      return {
        said: printed.filter((text) => / \^[25]to /.test(text)).map((text) => text.slice(-9)),
        kept: controller.teamChat.pos
      };
    };
    expect(chat({ cg_teamChatHeight: '4' })).toEqual({
      said: ['^2to all\n', '^5to red\n'],
      kept: 1
    });
    expect(chat({ cg_teamChatHeight: '4', cg_teamChatTime: '0' })).toMatchObject({ kept: 0 });
    expect(chat({ cg_teamChatHeight: '0' })).toMatchObject({ kept: 0 });
    expect(chat({ cg_teamChatsOnly: '1' })).toEqual({ said: ['^5to red\n'], kept: 0 });
  });

  it('tells whoever last hurt the player: nobody, then themself, then the world', () => {
    const { controller } = controlled();
    controller.update(1 / 60);
    const sent = vi.spyOn(controller.game, 'sendClientCommand');
    const words = ['tell_attacker', 'ow'];
    controller.tellAttacker(words);
    expect(sent).not.toHaveBeenCalled();
    expect(controller.lastAttacker()).toBe(-1);

    const { game, clientNum } = controller.game;
    const me = game.level.gentities[clientNum];
    damage(game.level, me, me, me, null, 10, 0, MOD.ROCKET_SPLASH);
    until(controller, () => controller.attacker.time !== 0);
    controller.tellAttacker(words);
    expect(sent).toHaveBeenLastCalledWith(`tell ${clientNum} ow`);
    expect(controller.lastAttacker()).toBe(clientNum);

    damage(game.level, me, null, null, null, 10, 0, MOD.FALLING);
    until(controller, () => {
      controller.tellAttacker(words);
      return sent.mock.lastCall?.[0] === `tell ${ENTITYNUM_WORLD} ow`;
    });
  });

  it('tells the crosshair player: slot 0 in the first second, as Q3 does, then nobody', () => {
    const { controller } = controlled();
    controller.update(1 / 60);
    const sent = vi.spyOn(controller.game, 'sendClientCommand');
    const words = ['tell_target', 'hi'];
    expect(controller.time).toBeLessThan(1000);
    controller.tellTarget(words);
    expect(sent).toHaveBeenLastCalledWith('tell 0 hi');

    for (let frame = 0; frame < 120 && controller.time <= 1000; frame++) controller.update(1 / 60);
    sent.mockClear();
    controller.tellTarget(words);
    expect(sent).not.toHaveBeenCalled();
  });

  it('holds each plum among the local entities it is given', () => {
    const pool = new LocalEntities();
    const { controller } = controlled({}, 0, pool);
    controller.update(1 / 60);
    const { game, clientNum } = controller.game;
    const me = game.level.gentities[clientNum];
    damage(game.level, me, me, me, null, 100000, 0, MOD.SUICIDE);
    until(controller, () => pool.count > 0);
    expect(pool.count).toBe(1);
  });

  it("puts a newcomer's look off unless cg_deferPlayers is off", () => {
    const putOff = (on: string): boolean | undefined => {
      const { controller } = controlled({ cg_deferPlayers: on });
      controller.update(1 / 60);
      controller.game.host.setConfigstring(CONFIGSTRING.PLAYERS + 1, 'n\\Visor\\model\\visor');
      for (let frame = 0; frame < 6; frame++) controller.update(1 / 60);
      return controller.clientInfo(1)?.deferred;
    };
    expect(putOff('1')).toBe(true);
    expect(putOff('0')).toBe(false);
  });

  it('counts who is drawn in a look, a newcomer put off in it among them', () => {
    const { controller } = controlled();
    controller.update(1 / 60);
    const own = controller.clientInfo(controller.game.clientNum)!.look;
    expect(controller.wearers(own)).toBe(1);
    controller.game.host.setConfigstring(CONFIGSTRING.PLAYERS + 1, 'n\\Visor\\model\\visor');
    for (let frame = 0; frame < 6; frame++) controller.update(1 / 60);
    expect(controller.wearers(own)).toBe(2);
  });

  it('sets the max health from a new handicap at once', () => {
    // The handicap is the client's own and travels as userinfo, so a new one goes to the host as
    // a `userinfo` command and `ClientUserinfoChanged` is what acts on it.
    const { cvars, controller } = controlled({ handicap: '50' });
    expect(controller.player.stats[STAT.MAX_HEALTH]).toBe(50);
    expect(controller.player.stats[STAT.HEALTH]).toBe(75);
    cvars.set('handicap', '80');
    until(controller, () => controller.player.stats[STAT.MAX_HEALTH] === 80);
  });

  it('tells the host about the client only when what it says has changed', () => {
    // `CL_CheckUserinfo` (`cl_main.c:2545–2555`) sends one when a userinfo cvar was modified, not
    // every frame: it is a reliable command, and the ring those sit in is small enough that a
    // client which never stops talking is dropped for overflowing it.
    const { cvars, controller } = controlled();
    const client = controller.game.host.clients[controller.game.clientNum];
    const said = client.lastClientCommand;
    for (let frame = 0; frame < 10; frame++) controller.update(1 / 60);
    expect(client.lastClientCommand).toBe(said);

    cvars.set('name', 'Sarge');
    controller.update(1 / 60);
    expect(client.lastClientCommand).toBe(said + 1);
    expect(client.lastClientCommandString).toContain('Sarge');
  });

  it('builds the userinfo only in a frame after some cvar has changed', () => {
    // `CL_CheckUserinfo` asks `cvar_modifiedFlags` before it builds the string.
    const { cvars, controller } = controlled();
    controller.update(1 / 60);
    const read = vi.spyOn(cvars, 'get');
    const handicapReads = () => read.mock.calls.filter(([name]) => name === 'handicap').length;
    for (let frame = 0; frame < 3; frame++) controller.update(1 / 60);
    expect(handicapReads()).toBe(0);

    // Any cvar's change: the string is built again, and the same string is not sent.
    cvars.set('my_own_cvar', 'x');
    controller.update(1 / 60);
    expect(handicapReads()).toBe(1);
  });

  it("carries the team models in its userinfo, so a team game can dress the client in them", () => {
    // `team_model` and `team_headmodel` are `CVAR_USERINFO` (`cg_main.c:352–353`), and the
    // server picks them over `model` and `headmodel` above `GT_TEAM` (`g_client.c:775–782`).
    const { cvars, controller } = controlled();
    const client = controller.game.host.clients[controller.game.clientNum];

    cvars.set('team_model', 'visor/gorre');
    controller.update(1 / 60);
    expect(client.lastClientCommandString).toContain('team_model\\visor/gorre');

    cvars.set('team_headmodel', 'sarge/krusade');
    controller.update(1 / 60);
    expect(client.lastClientCommandString).toContain('team_headmodel\\sarge/krusade');
  });

  it('sends a new rate at once, as Q3 sends each userinfo cvar', () => {
    // `rate` is `CVAR_USERINFO` (`cl_main.c:3664`), so Data Rate reaches the server as it changes
    // rather than with the next change to something else.
    const { cvars, controller } = controlled();
    const client = controller.game.host.clients[controller.game.clientNum];
    const said = client.lastClientCommand;
    cvars.set('rate', '5000');
    controller.update(1 / 60);
    expect(client.lastClientCommand).toBe(said + 1);
    expect(client.lastClientCommandString).toContain('rate\\5000');
  });

  it('sends a new snaps at once, as Q3 sends each userinfo cvar', () => {
    // `snaps` is `CVAR_USERINFO` too, so a change to it alone reaches the server rather than
    // waiting for another userinfo cvar to move.
    const { cvars, controller } = controlled();
    const client = controller.game.host.clients[controller.game.clientNum];
    const said = client.lastClientCommand;
    cvars.set('snaps', '50');
    controller.update(1 / 60);
    expect(client.lastClientCommand).toBe(said + 1);
    expect(client.lastClientCommandString).toContain('snaps\\50');
  });

  it('lets no time pass in a paused frame, and keeps no event from the frame before', () => {
    const { cvars, input, controller } = controlled();
    controller.update(0.2);
    input.keyDown(K.MOUSE1);
    // The shot is the move's own event; whether it leaves anything to draw depends on what it
    // hit, and a paused frame must keep neither.
    until(controller, () => controller.events.length > 0);

    cvars.set('cl_paused', '1');
    // The frame the pause is set in still runs the client's half, as Q3's does: the server's own
    // check comes at the end of it.
    controller.update(1 / 60);
    const time = controller.time;
    controller.update(1 / 60);
    expect(controller.time).toBe(time);
    expect(controller.effects).toEqual([]);
    expect(controller.events).toEqual([]);
  });

  it('restarts at the next frame, with the player at the spawn, facing its way', () => {
    const { input, controller } = controlled();
    const forward = 'w'.charCodeAt(0);
    input.keyDown(forward);
    for (let frame = 0; frame < 30; frame++) controller.update(1 / 60);
    input.keyUp(forward);
    expect(controller.player.origin.y).toBeGreaterThan(10);

    controller.restart();
    until(controller, () => controller.mapRestart);
    expect([controller.player.origin.x, controller.player.origin.y]).toEqual([0, 0]);
    // The spawn's own yaw, which reaches the client as `delta_angles` under the angles it is
    // already holding rather than as anything it has to be told.
    expect(controller.player.viewangles.y).toBeCloseTo(90);
  });

  it('throws the hook of the type set, from the next frame, and none at type 0', () => {
    const { cvars, input, controller } = controlled({ g_allowGrapple: '0' });
    input.keyDown(GRAPPLE_KEY);
    controller.update(1 / 60);
    expect(controller.grappleHooks()).toEqual([]);

    input.keyUp(GRAPPLE_KEY);
    cvars.set('g_allowGrapple', '3');
    controller.update(1 / 60);
    input.keyDown(GRAPPLE_KEY);
    until(controller, () => controller.grappleHooks().length > 0);
  });

  it('tells the match whether it predicts its own pickups, as cg_predictItems does', () => {
    const read = (predictItems: string): boolean => {
      const { controller } = controlled({ cg_predictItems: predictItems });
      for (let frame = 0; frame < 10; frame++) controller.update(1 / 60);
      const { game, clientNum } = controller.game;
      return game.level.clients[clientNum].pers.predictItemPickup;
    };

    expect(read('1')).toBe(true);
    expect(read('0')).toBe(false);
  });

  it('draws the player from the snapshots with cg_nopredict, rather than predicting', () => {
    const travel = (nopredict: string): number => {
      const { input, controller } = controlled({ cg_nopredict: nopredict });
      const forward = 'w'.charCodeAt(0);
      for (let frame = 0; frame < 10; frame++) controller.update(1 / 60);
      const before = controller.player.origin.y;
      input.keyDown(forward);
      controller.update(1 / 60);
      const moved = controller.player.origin.y - before;
      input.keyUp(forward);
      return moved;
    };

    // Prediction moves the player on the frame the key goes down; with cg_nopredict the drawn
    // position waits for the snapshot that carries the move.
    expect(travel('0')).toBeGreaterThan(0.3);
    expect(travel('1')).toBe(0);
  });

  it("draws the player's own round as it fires with xp_delagWeapons, not a round trip on", () => {
    const framesToImpact = (delagWeapons: string): number => {
      const { input, controller } = controlled({
        cl_packetdelay: '100',
        sv_packetdelay: '100',
        xp_delagWeapons: delagWeapons
      });
      for (let frame = 0; frame < 120; frame++) controller.update(1 / 60);
      // Down at the floor, which is all there is to strike.
      input.mouseMove(0, 20000);
      controller.update(1 / 60);
      input.keyDown(K.MOUSE1);
      for (let frame = 0; frame < 60; frame++) {
        controller.update(1 / 60);
        input.keyUp(K.MOUSE1);
        if (controller.effects.some(({ type }) => type === 'impact')) return frame;
      }
      return -1;
    };

    expect(framesToImpact('1')).toBe(0);
    expect(framesToImpact('0')).toBeGreaterThan(10);
  });

  it('prints where a rail drawn early struck with cg_debugDelag, and asks the match to', () => {
    const report = (debugDelag: string) => {
      const { input, controller } = controlled({
        cg_debugDelag: debugDelag,
        xp_delagWeapons: '8'
      });
      const printed: string[] = [];
      controller.console = { print: (text) => printed.push(text), clearNotify: () => {} };
      const { game, clientNum } = controller.game;
      const { level } = game;
      const rail = level.spawnEntity();
      rail.item = findItem('weapon_railgun')!;
      rail.s.modelindex = itemIndex(rail.item);
      touchItem(level, rail, level.gentities[clientNum]);
      // Something as big as a player, ahead along +y, where the spawn faces.
      const body = level.spawnEntity();
      body.s.eType = ET.GENERAL;
      body.r.contents = CONTENTS.BODY;
      body.r.mins = vec3(-15, -15, -24);
      body.r.maxs = vec3(15, 15, 32);
      body.s.pos.trBase = vec3(0, 128, 24);
      body.r.currentOrigin = vec3(0, 128, 24);
      level.linkEntity(body);
      // Long enough for the switch to the railgun.
      for (let frame = 0; frame < 90; frame++) controller.update(1 / 60);
      input.keyDown(K.MOUSE1);
      controller.update(1 / 60);
      input.keyUp(K.MOUSE1);
      return {
        asked: level.clients[clientNum].pers.debugDelag,
        printed: printed.filter((text) => text.startsWith('^3Int: '))
      };
    };

    expect(report('1')).toEqual({ asked: true, printed: [expect.stringContaining(' 128.00 ')] });
    expect(report('0')).toEqual({ asked: false, printed: [] });
  });

  it("draws everyone else's missiles further on by cg_projectileNudge", () => {
    const drawnY = (nudge: string): number => {
      const { controller } = controlled({ cg_projectileNudge: nudge });
      for (let frame = 0; frame < 10; frame++) controller.update(1 / 60);
      const { level } = controller.game.game;
      // Nobody's rocket, high over the floor and flying along +y.
      const from = level.gentities[ENTITYNUM_WORLD];
      fireMissile(level, from, WP.ROCKET_LAUNCHER, vec3(0, 0, 500), vec3(0, 1, 0), () => {});
      for (let frame = 0; frame < 10; frame++) controller.update(1 / 60);
      return controller.missiles()[0].origin.y;
    };

    // 100 ms on, at the rocket's 900 units a second.
    expect(drawnY('100') - drawnY('0')).toBeCloseTo(90, 6);
  });
});

describe('the network frame', () => {
  it('sends the match a still command with the weapon asked for, whatever is held', () => {
    const { input, controller } = controlled();
    controller.update(1 / 60);
    input.keyDown(K.MOUSE1);
    input.keyDown('w'.charCodeAt(0));
    const frame = vi.spyOn(controller.game, 'frame');
    controller.networkFrame(16);
    expect(frame).toHaveBeenCalledOnce();
    const [msec, cmd] = frame.mock.calls[0];
    expect(msec).toBe(16);
    expect(cmd).toMatchObject({
      buttons: 0,
      forwardmove: 0,
      rightmove: 0,
      upmove: 0,
      weapon: controller.weaponSelect
    });
  });

  it('sends the talk button with a catcher up, and still nothing held', () => {
    const { input, router, controller } = controlled();
    controller.update(1 / 60);
    router.execute(['+attack']);
    input.setCatcher(KEYCATCH.UI);
    const frame = vi.spyOn(controller.game, 'frame');
    controller.networkFrame(16);
    expect(frame.mock.calls[0][1].buttons).toBe(BUTTON_TALK);
  });
});

describe('the talk button', () => {
  it('holds a player whose menu is up still under the balloon, and lets them go as it closes', () => {
    const { input, router, controller } = controlled();
    const { game, clientNum } = controller.game;
    const ps = () => game.level.clients[clientNum].ps;
    for (let frame = 0; frame < 30; frame++) controller.update(1 / 60);
    // Typed at the console, it names no key, so the menu opening lets nothing go.
    router.execute(['+forward']);
    input.setCatcher(KEYCATCH.UI);
    const before = { ...ps().origin };
    for (let frame = 0; frame < 10; frame++) controller.update(1 / 60);
    expect(ps().eFlags & EF_TALK).toBe(EF_TALK);
    expect(ps().origin).toEqual(before);

    input.setCatcher(0);
    for (let frame = 0; frame < 10; frame++) controller.update(1 / 60);
    expect(ps().eFlags & EF_TALK).toBe(0);
    expect(ps().origin.y).toBeGreaterThan(before.y);
  });
});

/** An item on the floor, as the item tests place one, and the slot it carries. */
function placed(controller: PlayerController, classname: string) {
  const { game, clientNum } = controller.game;
  const { level } = game;
  const entity = level.spawnEntity();
  entity.item = findItem(classname)!;
  entity.s.eType = ET.ITEM;
  entity.s.modelindex = itemIndex(entity.item);
  entity.r.contents = CONTENTS.TRIGGER;
  return { level, entity, player: level.gentities[clientNum], slot: entity.s.modelindex };
}

describe('the pickup display and the autoswitch', () => {
  it('shows the item the player just took, and takes a new weapon in hand', () => {
    const { controller } = controlled();
    const taken = placed(controller, 'weapon_railgun');
    touchItem(taken.level, taken.entity, taken.player);
    until(controller, () => controller.itemPickup === taken.slot);

    expect(controller.itemPickupTime).toBe(Math.floor(controller.time));
    expect(controller.weaponSelect).toBe(WP.RAILGUN);
    expect(controller.weaponSelectTime).toBe(controller.itemPickupTime);
  });

  it('never switches to the machinegun, however it is set', () => {
    // Q3's one exception: the machinegun is what a player always has, so taking another one is
    // not worth interrupting a fight for.
    const { controller } = controlled();
    const rail = placed(controller, 'weapon_railgun');
    touchItem(rail.level, rail.entity, rail.player);
    until(controller, () => controller.itemPickup === rail.slot);

    // A tick for the switch the rail's pickup began to raise its own event, as a match would
    // have between two touches: the client's prediction is a tick ahead of the server's state.
    for (let frame = 0; frame < 2; frame++) controller.update(1 / 60);

    const machinegun = placed(controller, 'weapon_machinegun');
    touchItem(machinegun.level, machinegun.entity, machinegun.player);
    until(controller, () => controller.itemPickup === machinegun.slot);
    expect(controller.weaponSelect).toBe(WP.RAILGUN);
  });

  it('switches for nothing but a weapon, and for no weapon with cg_autoswitch 0', () => {
    const off = controlled({ cg_autoswitch: '0' });
    const rail = placed(off.controller, 'weapon_railgun');
    touchItem(rail.level, rail.entity, rail.player);
    until(off.controller, () => off.controller.itemPickup === rail.slot);
    expect(off.controller.weaponSelect).toBe(WP.MACHINEGUN);

    const { controller } = controlled();
    const bullets = placed(controller, 'ammo_bullets');
    touchItem(bullets.level, bullets.entity, bullets.player);
    until(controller, () => controller.itemPickup === bullets.slot);
    expect(controller.weaponSelect).toBe(WP.MACHINEGUN);
  });

  it('remembers the powerup just taken, which is what pulses its icon', () => {
    const { controller } = controlled();
    const { game, clientNum } = controller.game;
    const { level } = game;
    addEvent(level.gentities[clientNum], EV.POWERUP_QUAD, 0, level.time);
    until(controller, () => controller.powerupActive === PW.QUAD);
    expect(controller.powerupTime).toBe(Math.floor(controller.time));
  });
});

describe('the center print', () => {
  const FRAME = 1 / 60;

  /** Raise one of the player's own use events and take the frame, as the move would have. */
  function used(event: number) {
    const { controller } = controlled();
    const { game, clientNum } = controller.game;
    addPredictableEvent(game.level.clients[clientNum].ps, event);
    until(controller, () => controller.centerPrint.text !== '');
    return controller;
  }

  it('names the item the player used, in the middle of the screen', () => {
    // `CG_UseItem` (`cg_event.c:357–365`): the message only the user sees.
    const controller = used(EV.USE_ITEM0 + HI.MEDKIT);
    expect(controller.centerPrint).toMatchObject({
      text: 'Use Medkit',
      charWidth: BIGCHAR_WIDTH,
      lines: 1
    });
    expect(controller.centerPrint.time).toBe(Math.floor(controller.time));
  });

  it('says "No item to use" for an empty hand, and takes a tag it has no item for the same way', () => {
    expect(used(EV.USE_ITEM0).centerPrint.text).toBe('No item to use');
    expect(used(EV.USE_ITEM0 + 5).centerPrint.text).toBe('No item to use');
  });

  it('names the teleporter too, whose use is otherwise silent', () => {
    // `BG_FindItemForHoldable` names it "Personal Teleporter", however long the display.
    expect(used(EV.USE_ITEM0 + HI.TELEPORTER).centerPrint.text).toBe('Use Personal Teleporter');
  });

  it("shows the match's own `cp`, which is how a team change is announced", () => {
    // `CG_ServerCommand`'s `cp` (`cg_servercmds.c:1006–1009`), put where `CG_UseItem` puts its
    // own message. The team change is the port's first sender of one.
    const { controller } = controlled();
    controller.update(FRAME);

    controller.game.sendClientCommand('team spectator');
    until(controller, () => /joined the spectators/.test(controller.centerPrint.text));
    expect(controller.centerPrint.charWidth).toBe(BIGCHAR_WIDTH);
  });

  it('raises "FIGHT!" where and as large as the restart asks, not where a used item goes', () => {
    const { controller } = controlled();
    controller.update(FRAME);

    controller.game.host.sendConsoleCommand('map_restart 0\n');
    for (let i = 0; i < 10 && controller.centerPrint.text !== 'FIGHT!'; i++) {
      controller.update(FRAME);
    }

    // `CG_CenterPrint( "FIGHT!", 120, GIANTCHAR_WIDTH*2 )` (`cg_servercmds.c:488`).
    expect(controller.centerPrint).toMatchObject({ text: 'FIGHT!', y: 120, charWidth: 64 });
  });
});

describe('a new gamestate', () => {
  const FRAME = 1 / 60;

  /**
   * Load a map under the player, as a server's own `map` does: a latched setting turns the restart
   * into a load. Runs until the client has the new gamestate.
   */
  function load(cvars: Cvars, controller: PlayerController): void {
    const gamestate = controller.game.gamestateMessageNum;
    cvars.set('sv_maxclients', '4');
    controller.restart();
    for (let i = 0; i < 20 && controller.game.gamestateMessageNum === gamestate; i++) {
      controller.update(FRAME);
    }
    expect(controller.game.gamestateMessageNum).not.toBe(gamestate);
  }

  it("drops the last world's centre print, pickup and pulse, as CG_Init's memset does", () => {
    const { cvars, controller } = controlled();
    controller.update(FRAME);
    controller.game.host.sendConsoleCommand('map_restart 0\n');
    until(controller, () => controller.centerPrint.text === 'FIGHT!');
    const rail = placed(controller, 'weapon_railgun');
    touchItem(rail.level, rail.entity, rail.player);
    until(controller, () => controller.itemPickup === rail.slot);
    addEvent(rail.player, EV.POWERUP_QUAD, 0, rail.level.time);
    until(controller, () => controller.powerupActive === PW.QUAD);

    // The new map's clock starts again under all three, which would hold them up for as long as
    // the last match ran.
    load(cvars, controller);
    expect(controller.centerPrint).toEqual(createCenterPrint());
    expect([controller.itemPickup, controller.itemPickupTime]).toEqual([0, 0]);
    expect([controller.powerupActive, controller.powerupTime]).toEqual([0, 0]);
  });

  it("keeps the new world's own print, sent as its gamestate went", () => {
    const { cvars, controller } = controlled();
    controller.update(FRAME);
    const { host, clientNum } = controller.game;
    const gamestate = controller.game.gamestateMessageNum;
    cvars.set('sv_maxclients', '4');
    controller.restart();
    let sent = false;
    for (let i = 0; i < 20 && controller.game.gamestateMessageNum === gamestate; i++) {
      // Once the gamestate is on its way, a print the first snapshot carries.
      if (!sent && host.clients[clientNum].state === CS.PRIMED) {
        host.sendServerCommand(clientNum, 'cp "Welcome"\n');
        sent = true;
      }
      controller.update(FRAME);
    }
    until(controller, () => controller.centerPrint.text === 'Welcome');
    // The new world's frames after it start nothing over.
    for (let i = 0; i < 5; i++) controller.update(FRAME);
    expect(controller.centerPrint.text).toBe('Welcome');
  });
});

describe('the player under the crosshair', () => {
  it("is scanned for from where the camera is placed this frame, cg.refdef's view", () => {
    const { controller } = controlled();
    controller.update(1 / 60);
    const scan = vi.spyOn(PlayerView.prototype, 'scanCrosshair');
    try {
      controller.scanCrosshair();
      expect(scan).toHaveBeenCalledOnce();
      const [origin, angles] = scan.mock.calls[0];
      expect(origin).toBe(controller.viewOrigin);
      expect(angles).toBe(controller.viewAngles);
    } finally {
      scan.mockRestore();
    }
  });
});

describe("the world's areas", () => {
  it('are closed as the snapshots the server sends say, through the wire and the view', () => {
    const { controller } = controlled();
    expect(Array.from(controller.areamask)).toEqual(new Array<number>(32).fill(0));

    // A map with no areas sends no mask; one byte of a mask that closes all but area 2.
    const { host } = controller.game;
    const sight = host.visibleEntities.bind(host);
    vi.spyOn(host, 'visibleEntities').mockImplementation((ps, numbers, areabits) => {
      sight(ps, numbers, areabits);
      areabits[0] = 0xfb;
      return 1;
    });
    until(controller, () => controller.areamask[0] === 0xfb);
    expect(Array.from(controller.areamask.subarray(0, 2))).toEqual([0xfb, 0]);
  });
});

describe("the world's contents", () => {
  it("are what the client's prediction moves in", () => {
    // A round trip on a clock the test moves, so the client has commands to replay.
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const passes = new Set<number>();
      const contents: PointContentsFn = (_point, passEntityNum) => {
        passes.add(passEntityNum);
        return 0;
      };
      const { controller } = controlled({ cl_packetdelay: '150' }, 0, undefined, contents);
      for (let frame = 0; frame < 120; frame++) {
        vi.advanceTimersByTime(1000 / 60);
        controller.update(1 / 60);
      }
      // Asked by the move, past the client's own player; the server's map holds none.
      expect(passes).toEqual(new Set([controller.game.clientNum]));
    } finally {
      vi.useRealTimers();
    }
  });
});
