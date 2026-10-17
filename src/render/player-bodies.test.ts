// @vitest-environment jsdom
import { Layer, Vec3, type AppBase, type Entity } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIdlePlayerState } from '../sim/types';
import { ANIM } from '../sim/animations';
import { PW } from '../sim/items';
import { vec3 } from '../sim/vec3';
import { playerLook } from '../view/player-model';
import { SceneShaders } from '../view/scene-shaders';
import { PLAYER_PART, predictedEntity } from '../view/scene-sort';
import { IDLE_HAND } from '../view/viewmodel';
import { createTestApp } from './engine-test-fixtures';
import { PlayerBodies, type PlayerBodiesInput } from './player-bodies';
import { fetchingPlayerLibrary, playerLibrary } from './player-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';
import { TextureCache } from './texture-cache';

/** The player's own body, on the null device with the synthetic `test` model. */

/** A frame with the player standing idle at the origin, seen from their eyes. */
function input(overrides: Partial<PlayerBodiesInput> = {}): PlayerBodiesInput {
  return {
    player: createIdlePlayerState(),
    origin: vec3(),
    pain: { time: Number.NEGATIVE_INFINITY, direction: 0 },
    shown: false,
    respawned: false,
    firing: false,
    lastFireTime: Number.NEGATIVE_INFINITY,
    railFireTime: Number.NEGATIVE_INFINITY,
    time: 1050,
    ...overrides
  };
}

describe('PlayerBodies', () => {
  let app: AppBase;
  let bodies: PlayerBodies;

  beforeEach(async () => {
    app = createTestApp().app;
    const blended = new Layer({ name: 'blended' });
    app.scene.layers.push(blended);
    bodies = await PlayerBodies.create(
      app,
      playerLibrary(),
      new TextureCache(app.graphicsDevice),
      playerLook('test', ''),
      { blendedLayers: [blended.id] }
    );
  });

  afterEach(async () => {
    await bodies.destroy();
    app.destroy();
  });

  it('gives the view weapon the hand at rest before the body has played', () => {
    expect(bodies.handFrames()).toEqual(IDLE_HAND);
  });

  it("keeps the player's own body out of sight in first person, its torso playing for the hand", () => {
    bodies.update(input({ time: 1050 }));
    bodies.update(input({ time: 1075 }));
    expect(bodies.own.root.enabled).toBe(false);
    // Every row of the test model starts on frame 0, TORSO_DROP's among them, so the torso's
    // frames 0 and 1 are the hand's 6 and 7.
    expect(bodies.handFrames()).toEqual({ from: 6, to: 7, frac: 0.5 });
  });

  it('shows it in third person', () => {
    bodies.update(input({ shown: true }));
    expect(bodies.own.root.enabled).toBe(true);
  });

  it("numbers the body in a map's scene as the predicted player, first of all", async () => {
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [],
      gun: [],
      screen: []
    });
    const placed = await PlayerBodies.create(
      app,
      playerLibrary(),
      new TextureCache(app.graphicsDevice),
      playerLook('test', ''),
      { scene }
    );
    try {
      placed.update(input({ shown: true }));
      const legs = placed.own.root.findByName('legs') as Entity;
      expect(sceneDraw(legs.render!.meshInstances[0])!.entity.value).toBe(
        predictedEntity(PLAYER_PART.legs)
      );
    } finally {
      await placed.destroy();
    }
  });

  it('reads its models from the paks first, as for a model the player has just picked', async () => {
    const { library, fetched } = fetchingPlayerLibrary();
    const worn = await PlayerBodies.create(
      app,
      library,
      new TextureCache(app.graphicsDevice),
      playerLook('grunt', '')
    );
    expect(fetched).toEqual(['grunt']);
    expect(worn.own.model).toBe('grunt');
    await worn.destroy();
  });

  it('brings the body into view afresh on a respawn, with no swing round to the new yaw', () => {
    const facing = (yaw: number) => createIdlePlayerState({ viewangles: vec3(0, yaw, 0) });
    bodies.update(input({ player: facing(90), shown: true }));
    bodies.update(input({ player: facing(180), shown: true, respawned: true, time: 1100 }));
    const legs = bodies.own.root.findByName('legs')!;
    const forward = legs.getLocalRotation().transformVector(new Vec3(1, 0, 0));
    expect(forward.x).toBeCloseTo(-1, 5);
  });

  it('reads the player state’s powerups as the entity’s mask, and answers with the trail', async () => {
    // `ps.powerups` is the slots' end times; the entity carries the mask, which is what the
    // shells and the trail are read from (`BG_PlayerStateToEntityState`).
    const running = createIdlePlayerState({
      legsAnim: ANIM.LEGS_RUN,
      powerups: createIdlePlayerState().powerups.map((_, i) =>
        i === PW.HASTE || i === PW.QUAD ? 1050 : 0
      )
    });
    expect(bodies.update(input({ player: running, time: 0 }))).toEqual(vec3(0, 0, -16));
    bodies.update(input({ player: running, shown: true, time: 50 }));
    await bodies.own.settled();
    bodies.update(input({ player: running, shown: true, time: 100 }));
    expect(bodies.own.root.findByName('powerups/quad/legs')).toBeTruthy();
  });
});
