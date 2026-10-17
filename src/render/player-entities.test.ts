// @vitest-environment jsdom
import { Layer, Vec3, type AppBase, type Entity } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createEntityState, MAX_CLIENTS } from '../net/protocol';
import { ANIM } from '../sim/animations';
import { EF_DEAD, EF_FIRING, GT } from '../sim/constants';
import { ET } from '../sim/game-entity';
import { PW } from '../sim/items';
import { vec3, type Vec3 as SimVec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { newClientInfo, type ClientInfo } from '../view/client-info';
import { CLASSIC_FULLSCREEN, setRendererStyle } from '../view/overbright';
import { playerLook } from '../view/player-model';
import type { PlayerCentity } from '../view/player-view';
import { SceneShaders } from '../view/scene-shaders';
import { NO_SCENE_FOGS, type SceneFogs } from './bsp-fog';
import { createTestApp } from './engine-test-fixtures';
import { packetEntity } from '../view/scene-sort';
import { PlayerEntities } from './player-entities';
import { PlayerRig } from './player-rig';
import { fetchingPlayerLibrary, playerLibrary, shownShells } from './player-test-fixtures';
import { SceneDraws } from './scene-draws';
import { TextureCache } from './texture-cache';

/**
 * Everyone else's bodies, and every corpse, on the null device: the synthetic `test` model, and
 * `sarge` beside it as the model a failed look falls back to.
 */

/** A player the snapshot carried, standing idle where it was placed. */
function player(
  number: number,
  clientNum: number,
  options: { origin?: SimVec3; yaw?: number; reset?: boolean; dead?: boolean } = {}
): PlayerCentity {
  const state = createEntityState(number);
  state.eType = ET.PLAYER;
  state.clientNum = clientNum;
  state.legsAnim = options.dead ? ANIM.BOTH_DEAD2 : ANIM.LEGS_IDLE;
  state.torsoAnim = options.dead ? ANIM.BOTH_DEAD2 : ANIM.TORSO_STAND;
  if (options.dead) state.eFlags |= EF_DEAD;
  return {
    state,
    origin: options.origin ?? vec3(64, 0, 24),
    angles: vec3(0, options.yaw ?? 0, 0),
    reset: options.reset ?? false,
    flashTime: Number.NEGATIVE_INFINITY,
    railFireTime: Number.NEGATIVE_INFINITY,
    pain: { time: Number.NEGATIVE_INFINITY, direction: 0 },
    bolt: null
  };
}

/** Who wears what: a clientinfo for each model. */
function wearing(model: string): ClientInfo {
  return newClientInfo(`n\\${model}\\model\\${model}\\hmodel\\${model}`, GT.FFA)!;
}

describe('PlayerEntities', () => {
  let app: AppBase;
  let players: PlayerEntities;
  /** `cgs.clientinfo`, as the test fills it. */
  let infos: Map<number, ClientInfo>;

  /** Draw a frame of these players. */
  const draw = (drawn: PlayerCentity[], time = 1050) =>
    players.update({ players: drawn, clientInfo: (n) => infos.get(n) ?? null, time });

  /** Draw a frame, wait for every body it asked for, and draw again so they show. */
  const drawBuilt = async (drawn: PlayerCentity[], time = 1050) => {
    draw(drawn, time);
    await players.settled();
    draw(drawn, time + 25);
  };

  /** Every body begun, whether still wanted or not. */
  let create: MockInstance<typeof PlayerRig.create>;
  /**
   * Wait for every body begun to land, and for every one given back to go: until a turn of the
   * event loop begins no body more, since one begins only once its models are read.
   */
  const landed = async () => {
    for (let begun = -1; begun !== create.mock.results.length; ) {
      begun = create.mock.results.length;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.allSettled(create.mock.results.map(({ value }) => value));
      await players.settled();
    }
  };

  beforeEach(() => {
    create = vi.spyOn(PlayerRig, 'create');
    app = createTestApp().app;
    const blended = new Layer({ name: 'blended' });
    app.scene.layers.push(blended);
    players = new PlayerEntities(
      app,
      playerLibrary(['test', 'sarge']),
      new TextureCache(app.graphicsDevice),
      { blendedLayers: [blended.id] }
    );
    infos = new Map([[1, wearing('test')]]);
  });

  afterEach(async () => {
    await players.destroy();
    app.destroy();
    create.mockRestore();
  });

  it('draws another player in the look their slot wears, where they were placed', async () => {
    await drawBuilt([player(1, 1, { origin: vec3(64, 0, 24) })]);
    const body = players.body(1)!;
    expect(body.model).toBe('test');
    expect(body.root.enabled).toBe(true);
    expect([...body.root.findByName('legs')!.getLocalPosition().toArray()]).toEqual([64, 0, 24]);
  });

  it('reads a look out of the paks when it is registered, so a body of it waits for nothing', async () => {
    const { library, fetched } = fetchingPlayerLibrary();
    const early = new PlayerEntities(app, library, new TextureCache(app.graphicsDevice));
    try {
      // `CG_LoadClientInfo` as the client's string arrives: nobody is drawing grunt yet.
      await early.register(playerLook('grunt', ''));
      expect(fetched).toEqual(['grunt']);

      const info = wearing('grunt');
      early.update({ players: [player(1, 1)], clientInfo: () => info, time: 1050 });
      await early.settled();

      expect(early.body(1)?.model).toBe('grunt');
      // The body asked the paks for nothing; the reading was done before it was wanted.
      expect(fetched).toEqual(['grunt']);
    } finally {
      await early.destroy();
    }
  });

  it("registers a look the install has not got as sarge's, saying so once", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { library, fetched } = fetchingPlayerLibrary();
    const early = new PlayerEntities(app, library, new TextureCache(app.graphicsDevice));
    try {
      await expect(early.register(playerLook('nobody', ''), 2)).resolves.toBe(true);
      // Its first body tried it, and the rest were built of what the first fell back to.
      expect(fetched).toEqual(['nobody']);
      const bodies = app.root.children.filter((body) => body.name === 'player-sarge-default');
      expect(bodies.map((body) => body.enabled)).toEqual([false, false, false]);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][1])).toContain('nobody: not in the install');
    } finally {
      await early.destroy();
      warn.mockRestore();
    }
  });

  it("lays a corpse in the queue in its owner's look, by the client it names", async () => {
    infos.set(2, wearing('sarge'));
    await drawBuilt([player(MAX_CLIENTS, 2, { dead: true })]);
    expect(players.body(MAX_CLIENTS)!.model).toBe('sarge');
  });

  it('draws nothing of a slot nobody is in', async () => {
    // A corpse can outlast its player, who leaves nobody in the slot to dress it as.
    const before = app.root.children.length;
    await drawBuilt([player(MAX_CLIENTS, 5, { dead: true })]);
    expect(players.body(MAX_CLIENTS)).toBeNull();
    expect(app.root.children).toHaveLength(before);
  });

  it('gives back a body whose entity stops coming, hidden, for the next to take', async () => {
    await drawBuilt([player(1, 1)]);
    const body = players.body(1)!;

    // A player gone to pieces, or a corpse sunk away, is simply not in the snapshot any more.
    draw([], 1100);
    expect(players.body(1)).toBeNull();
    expect(body.root.enabled).toBe(false);

    const built = create.mock.calls.length;
    draw([player(MAX_CLIENTS, 1, { dead: true })], 1125);
    expect(players.body(MAX_CLIENTS)).toBe(body);
    expect(body.root.enabled).toBe(true);
    expect(create.mock.calls).toHaveLength(built);
  });

  it('gives back the body of a corpse whose player has left', async () => {
    await drawBuilt([player(MAX_CLIENTS, 1, { dead: true })]);
    const body = players.body(MAX_CLIENTS)!;
    infos.delete(1);
    draw([player(MAX_CLIENTS, 1, { dead: true })], 1100);
    expect(players.body(MAX_CLIENTS)).toBeNull();
    expect(body.root.enabled).toBe(false);
  });

  it('hands a body given back to an entity arriving that frame, its clocks cleared', async () => {
    await drawBuilt([player(1, 1, { yaw: 90 })]);
    const body = players.body(1)!;

    // The queue hands its slot round as the player goes: no teleport resets the newcomer, yet it
    // faces where it looks at once, as a body of its own would.
    draw([player(MAX_CLIENTS, 1, { yaw: 180 })], 1100);
    expect(players.body(MAX_CLIENTS)).toBe(body);
    const legs = body.root.findByName('legs')!;
    const forward = legs.getLocalRotation().transformVector(new Vec3(1, 0, 0));
    expect(forward.x).toBeCloseTo(-1, 5);
  });

  it("hands on no shell of the last wearer's gun, to the corpse that takes the body", async () => {
    const armed = player(1, 1);
    armed.state.weapon = WP.MACHINEGUN;
    armed.state.powerups = 1 << PW.QUAD;
    await drawBuilt([armed]);
    const body = players.body(1)!;
    // The gun lands, and then its shells.
    await body.selectWeapon(WP.MACHINEGUN);
    draw([armed], 1100);
    await body.settled();
    draw([armed], 1125);
    expect(shownShells(body)).toContain('powerups/quadWeapon/gun');

    // Gone from the snapshot with the quad still on, and the body handed to the next corpse.
    draw([], 1150);
    draw([player(MAX_CLIENTS, 1, { dead: true })], 1175);
    expect(players.body(MAX_CLIENTS)).toBe(body);
    expect(shownShells(body)).toEqual([]);
  });

  it('draws a player and their corpse in registered bodies from the first frame', async () => {
    await players.register(playerLook('test', ''));
    const built = create.mock.calls.length;

    // The corpse laid as the player respawns.
    draw([player(1, 1, { reset: true }), player(MAX_CLIENTS, 1, { dead: true })]);
    expect(players.body(1)!.model).toBe('test');
    expect(players.body(MAX_CLIENTS)!.model).toBe('test');
    expect(players.body(1)).not.toBe(players.body(MAX_CLIENTS));
    expect(create.mock.calls).toHaveLength(built);
  });

  it('grows a busier look by a body more, of what is read, and keeps it', async () => {
    await players.destroy();
    const { library, fetched } = fetchingPlayerLibrary();
    players = new PlayerEntities(app, library, new TextureCache(app.graphicsDevice));
    infos.set(1, wearing('grunt'));
    await players.register(playerLook('grunt', ''));
    const built = create.mock.calls.length;

    // A second corpse while the first still lies.
    const second = player(MAX_CLIENTS + 1, 1, { dead: true });
    const drawn = [player(1, 1), player(MAX_CLIENTS, 1, { dead: true }), second];
    draw(drawn);
    expect(players.body(MAX_CLIENTS + 1)).toBeNull();
    await players.settled();
    draw(drawn, 1075);
    expect(players.body(MAX_CLIENTS + 1)!.model).toBe('grunt');
    expect(create.mock.calls).toHaveLength(built + 1);
    expect(fetched).toEqual(['grunt']);

    // The queue's next corpse takes a body at once as both sink away.
    draw([player(1, 1), player(MAX_CLIENTS + 2, 1, { dead: true })], 1100);
    expect(players.body(MAX_CLIENTS + 2)).not.toBeNull();
    expect(create.mock.calls).toHaveLength(built + 1);
  });

  it('waits for a body of the look still being built, rather than building another', async () => {
    const registering = players.register(playerLook('test', ''));
    draw([player(1, 1)]);
    expect(players.body(1)).toBeNull();
    await registering;
    draw([player(1, 1)], 1075);
    expect(players.body(1)!.model).toBe('test');
    // The player's, and the spare.
    expect(create.mock.calls).toHaveLength(2);
  });

  it('takes every body away as the match goes, and dresses the next match afresh', async () => {
    await drawBuilt([player(1, 1)]);
    const body = players.body(1)!;

    players.clear();
    await players.settled();
    expect(players.body(1)).toBeNull();
    expect(app.root.children).not.toContain(body.root);

    // The next match's first frame, on a clock started again.
    await drawBuilt([player(1, 1)], 50);
    expect(players.body(1)).not.toBe(body);
    expect(players.body(1)!.root.enabled).toBe(true);
  });

  it('draws the body already built for a slot the queue hands round in the same look', async () => {
    await drawBuilt([player(MAX_CLIENTS, 1, { dead: true })]);
    const first = players.body(MAX_CLIENTS)!;

    await drawBuilt([player(MAX_CLIENTS, 1, { origin: vec3(0, 96, 24), dead: true })], 1100);
    expect(players.body(MAX_CLIENTS)).toBe(first);
    expect([...first.root.findByName('legs')!.getLocalPosition().toArray()]).toEqual([0, 96, 24]);
  });

  it('dresses a slot again when a corpse in another look takes it', async () => {
    infos.set(2, wearing('sarge'));
    await drawBuilt([player(MAX_CLIENTS, 1, { dead: true })]);
    const first = players.body(MAX_CLIENTS)!;

    // A corpse laid in the queue is brought into view afresh.
    await drawBuilt([player(MAX_CLIENTS, 2, { dead: true, reset: true })], 1100);
    expect(players.body(MAX_CLIENTS)!.model).toBe('sarge');
    expect(first.root.enabled).toBe(false);
  });

  it("dresses a player again when their slot's look changes", async () => {
    await drawBuilt([player(1, 1)]);
    infos.set(1, wearing('sarge'));
    await drawBuilt([player(1, 1)], 1100);
    expect(players.body(1)!.model).toBe('sarge');
  });

  it('draws a player in their last look until a body of their next is in', async () => {
    await drawBuilt([player(1, 1)]);
    const last = players.body(1)!;
    infos.set(1, wearing('sarge'));

    draw([player(1, 1)], 1100);
    expect(players.body(1)).toBe(last);
    await players.settled();
    draw([player(1, 1)], 1125);
    expect(players.body(1)!.model).toBe('sarge');
    expect(last.root.enabled).toBe(false);
  });

  it('dresses a player again at once in a look with a body free', async () => {
    await players.register(playerLook('sarge', ''));
    await drawBuilt([player(1, 1)]);
    infos.set(1, wearing('sarge'));
    draw([player(1, 1)], 1100);
    expect(players.body(1)!.model).toBe('sarge');
  });

  it('draws nothing of the last look for an entity brought into view afresh', async () => {
    await drawBuilt([player(1, 1)]);
    infos.set(1, wearing('sarge'));
    draw([player(1, 1, { reset: true })], 1100);
    expect(players.body(1)).toBeNull();
    await players.settled();
    draw([player(1, 1)], 1125);
    expect(players.body(1)!.model).toBe('sarge');
  });

  it('keeps free a next body that lands after the look has gone again', async () => {
    await drawBuilt([player(1, 1)]);
    const last = players.body(1)!;

    // Dressed in sarge, then back in their own before sarge's body is in.
    infos.set(1, wearing('sarge'));
    draw([player(1, 1)], 1100);
    infos.set(1, wearing('test'));
    draw([player(1, 1)], 1125);
    await landed();
    expect(players.body(1)).toBe(last);
    const sarge = app.root.findByName('player-sarge-default')!;
    expect(sarge.enabled).toBe(false);

    // Sarge's again takes it at once, and builds nothing.
    const built = create.mock.calls.length;
    infos.set(1, wearing('sarge'));
    draw([player(1, 1)], 1150);
    expect(players.body(1)!.root).toBe(sarge);
    expect(create.mock.calls).toHaveLength(built);
  });

  it('keeps free a next body that lands after its entity has gone', async () => {
    await drawBuilt([player(1, 1)]);
    infos.set(1, wearing('sarge'));
    draw([player(1, 1)], 1100);
    draw([], 1125);
    await landed();
    const sarge = app.root.findByName('player-sarge-default')!;
    expect(sarge.enabled).toBe(false);

    draw([player(MAX_CLIENTS, 1, { dead: true })], 1150);
    expect(players.body(MAX_CLIENTS)!.root).toBe(sarge);
  });

  it('gives back a next body still building as the match goes', async () => {
    const before = app.root.children.length;
    await drawBuilt([player(1, 1)]);
    infos.set(1, wearing('sarge'));
    draw([player(1, 1)], 1100);
    players.clear();
    await landed();
    expect(app.root.children).toHaveLength(before);
  });

  it('builds the last look asked for, where it changes again while the next builds', async () => {
    await players.destroy();
    const library = playerLibrary(['test', 'sarge', 'grunt']);
    players = new PlayerEntities(app, library, new TextureCache(app.graphicsDevice));
    await drawBuilt([player(1, 1)]);
    infos.set(1, wearing('sarge'));
    draw([player(1, 1)], 1100);
    infos.set(1, wearing('grunt'));
    draw([player(1, 1)], 1125);
    await players.settled();
    draw([player(1, 1)], 1150);
    expect(players.body(1)!.model).toBe('grunt');
  });

  it('registers a body per wearer of a look and a spare, hidden, till the match goes', async () => {
    const before = app.root.children.length;
    await expect(players.register(playerLook('test', ''))).resolves.toBe(true);
    await expect(players.register(playerLook('test', ''))).resolves.toBe(false);
    // The client's, and one for their corpse.
    const registered = app.root.children.slice(before);
    expect(registered.map((body) => body.enabled)).toEqual([false, false]);

    // Two more come to wear it; fewer takes none away.
    await expect(players.register(playerLook('test', ''), 3)).resolves.toBe(false);
    expect(app.root.children).toHaveLength(before + 4);
    await players.register(playerLook('test', ''), 1);
    expect(app.root.children).toHaveLength(before + 4);

    players.clear();
    await players.settled();
    expect(app.root.children).toHaveLength(before);
    // The next match registers it afresh.
    await expect(players.register(playerLook('test', ''))).resolves.toBe(true);
  });

  it('gives back a body registered for a match that went while it was built', async () => {
    const before = app.root.children.length;
    const registering = players.register(playerLook('test', ''));
    players.clear();
    await registering;
    await landed();
    expect(app.root.children).toHaveLength(before);
  });

  it('shows every body built for the warm-up, of every look or those asked for', async () => {
    const before = app.root.children.length;
    await players.register(playerLook('test', ''));
    await players.register(playerLook('sarge', ''));
    const bodies = app.root.children.slice(before);
    const of = (model: string) => bodies.filter((body) => body.name === `player-${model}-default`);
    const shown = (model: string) => of(model).map((body) => body.enabled);
    const parts = of('test')[0].children.length;

    const every = await players.warm();
    every.at(0);
    expect([...shown('test'), ...shown('sarge')]).toEqual([true, true, true, true]);
    every.end();
    expect([...shown('test'), ...shown('sarge')]).toEqual([false, false, false, false]);
    // No shells built on them: the player's own body warms those for every body.
    expect(of('test')[0].children).toHaveLength(parts);

    const one = await players.warm([playerLook('sarge', '')]);
    one.at(0);
    expect([...shown('test'), ...shown('sarge')]).toEqual([false, false, true, true]);
    one.end();
    expect(shown('sarge')).toEqual([false, false]);
  });

  it('draws a stand-in of every kind of look for the warm-up, where bodies draw', async () => {
    const before = app.root.children.length;
    const warmed = (await players.warmKinds(['models/players/test/glow'], () => true))!;
    const standIn = app.root.children[before] as Entity;
    const blended = standIn.findByName('blended') as Entity;
    expect(blended.render!.layers).toEqual([app.scene.layers.getLayerByName('blended')!.id]);
    expect(standIn.enabled).toBe(false);
    warmed.at(0);
    expect(standIn.enabled).toBe(true);
    warmed.end();
    expect(app.root.children).toHaveLength(before);
  });

  it('draws it once a setting: a scene or none, fogs or none, a style', async () => {
    const own = { models: [], effects: [], gun: [], screen: [] };
    const scene = new SceneDraws(new SceneShaders(), own);
    const scened = new PlayerEntities(
      app,
      playerLibrary(['test', 'sarge']),
      new TextureCache(app.graphicsDevice),
      { scene }
    );
    /** A warm-up's stand-in, drawn and let go; `false` where there was none to draw. */
    const drawn = async () => {
      const warmed = await scened.warmKinds(['models/players/test/glow'], () => true);
      warmed?.at(0);
      warmed?.end();
      return warmed !== undefined;
    };
    const world = { layer: new Layer({ name: 'scene' }), fog: NO_SCENE_FOGS, key: () => {} };
    const fogged = { ...world, fog: { fogs: [{}] } as unknown as SceneFogs };
    try {
      expect([await drawn(), await drawn()]).toEqual([true, false]);
      scene.enter(world);
      expect([await drawn(), await drawn()]).toEqual([true, false]);
      scene.enter(fogged);
      expect([await drawn(), await drawn()]).toEqual([true, false]);
      setRendererStyle({ renderer: 'opengl2', overBrightBits: 1 });
      expect([await drawn(), await drawn()]).toEqual([true, false]);
      // Back where it was drawn first.
      setRendererStyle(CLASSIC_FULLSCREEN);
      scene.enter(null);
      expect(await drawn()).toBe(false);
    } finally {
      setRendererStyle(CLASSIC_FULLSCREEN);
      await scened.destroy();
    }
  });

  it("wears sarge's look where a model is not in the install", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infos.set(1, wearing('nobody'));
    await drawBuilt([player(1, 1)]);
    expect(players.body(1)!.model).toBe('sarge');
    expect(String(warn.mock.calls[0][1])).toContain('nobody: not in the install');
    // And it sounds like sarge, as `CG_LoadClientInfo` takes the sounds of the model that loaded.
    expect(players.voice(1)?.model).toBe('sarge');
    warn.mockRestore();
  });

  it('sounds like the model it wears, with its footsteps, once it is built', async () => {
    draw([player(1, 1)]);
    expect(players.voice(1)).toBeNull();
    await players.settled();
    expect(players.voice(1)).toEqual({ model: 'test', footsteps: 'boot' });
    expect(players.voice(2)).toBeNull();
  });

  it('brings a body into view afresh when it arrives again, with no swing round', async () => {
    await drawBuilt([player(1, 1, { yaw: 90 })]);
    // A respawn flips the teleport bit, which the view reads as a reset: the legs face the new
    // yaw at once, where a turn of 90° would otherwise take them several frames.
    draw([player(1, 1, { yaw: 180, reset: true })], 1100);
    const legs = players.body(1)!.root.findByName('legs')!;
    const forward = legs.getLocalRotation().transformVector(new Vec3(1, 0, 0));
    expect(forward.x).toBeCloseTo(-1, 5);
  });

  it('turns a body that has not been reset, rather than snapping it round', async () => {
    await drawBuilt([player(1, 1, { yaw: 90 })]);
    draw([player(1, 1, { yaw: 180 })], 1100);
    const legs = players.body(1)!.root.findByName('legs')!;
    const forward = legs.getLocalRotation().transformVector(new Vec3(1, 0, 0));
    expect(forward.x).toBeGreaterThan(-0.99);
  });

  it("hands each body its entity as CG_Player reads it, and what its events left", async () => {
    infos.set(1, newClientInfo('n\\Sarge\\model\\test\\hmodel\\test\\c1\\4', GT.FFA)!);
    const running = player(1, 1, { origin: vec3(8, 16, 24), yaw: 30, dead: true });
    running.state.legsAnim = ANIM.LEGS_RUN;
    running.state.torsoAnim = ANIM.TORSO_ATTACK;
    running.state.angles2 = vec3(0, 3, 0);
    running.state.pos.trDelta = vec3(0, 320, 0);
    running.state.eFlags |= EF_FIRING;
    running.state.weapon = WP.RAILGUN;
    running.flashTime = 1220;
    running.railFireTime = 1220;
    running.pain = { time: 1100, direction: 1 };
    // The entity's own powerup mask, which the shells and the haste trail are read from.
    running.state.powerups = (1 << PW.HASTE) | (1 << PW.QUAD);
    await drawBuilt([running]);
    const pose = vi.spyOn(players.body(1)!, 'pose');
    const drawn = vi.spyOn(players.body(1)!, 'draw');
    draw([running], 1234);
    expect(drawn).toHaveBeenCalledOnce();
    expect(pose).toHaveBeenCalledWith({
      origin: vec3(8, 16, 24),
      angles: vec3(0, 30, 0),
      legsAnim: ANIM.LEGS_RUN,
      torsoAnim: ANIM.TORSO_ATTACK,
      movementDir: 3,
      velocity: vec3(0, 320, 0),
      dead: true,
      weapon: WP.RAILGUN,
      firing: true,
      lastFireTime: 1220,
      railFireTime: 1220,
      painTime: 1100,
      painDirection: 1,
      time: 1234,
      color: [1, 0, 0],
      powerups: (1 << PW.HASTE) | (1 << PW.QUAD),
      team: 0,
      // Its entity's number in a map's scene, by its own.
      entity: packetEntity(1)
    });
  });

  it('keeps free a body let go while it was still being built', async () => {
    draw([player(1, 1)]);
    draw([], 1075);
    await players.settled();
    expect(players.body(1)).toBeNull();
    const body = app.root.findByName('player-test-default')!;
    expect(body.enabled).toBe(false);

    draw([player(MAX_CLIENTS, 1, { dead: true })], 1100);
    expect(players.body(MAX_CLIENTS)!.root).toBe(body);
  });

  it("reads a look's models from the paks when it is first named", async () => {
    await players.destroy();
    const { library, fetched } = fetchingPlayerLibrary();
    players = new PlayerEntities(app, library, new TextureCache(app.graphicsDevice));
    infos.set(1, wearing('grunt'));
    await drawBuilt([player(1, 1)]);
    expect(fetched).toEqual(['grunt']);
    expect(players.body(1)!.model).toBe('grunt');
  });

  it("reads a head from its own model's paks when it is worn apart from its body", async () => {
    await players.destroy();
    const { library, fetched } = fetchingPlayerLibrary();
    players = new PlayerEntities(app, library, new TextureCache(app.graphicsDevice));
    infos.set(1, newClientInfo('n\\Mixed\\model\\test\\hmodel\\grunt', GT.FFA)!);
    await drawBuilt([player(1, 1)]);
    expect(fetched).toEqual(['grunt']);
    expect(players.body(1)!.model).toBe('test');
  });

  it('holds the weapon its entity carries', async () => {
    const armed = player(1, 1);
    armed.state.weapon = WP.MACHINEGUN;
    await drawBuilt([armed]);
    const body = players.body(1)!;
    await body.selectWeapon(WP.MACHINEGUN);
    draw([armed], 1100);
    expect(body.muzzleOrigin()).not.toBeNull();
  });

  it('answers with each hasted runner’s puff, and nobody else’s', async () => {
    const runner = player(1, 1, { origin: vec3(8, 16, 24) });
    runner.state.legsAnim = ANIM.LEGS_RUN;
    runner.state.powerups = 1 << PW.HASTE;
    const idle = player(2, 2);
    await drawBuilt([runner, idle]);

    // Only the runner answers; the idle body lays nothing. A stalled frame pulls the mark up to
    // the clock (`cg_players.c:1515–1517`), so the next frame passes it once more before the
    // hundred-millisecond cadence resumes.
    expect(draw([runner, idle], 2000)).toEqual([vec3(8, 16, 8)]);
    expect(draw([runner, idle], 2050)).toEqual([vec3(8, 16, 8)]);
    expect(draw([runner, idle], 2100)).toEqual([vec3(8, 16, 8)]);
    expect(draw([runner, idle], 2150)).toEqual([]);
    expect(draw([runner, idle], 2200)).toEqual([vec3(8, 16, 8)]);
  });
});
