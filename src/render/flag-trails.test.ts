// @vitest-environment jsdom
import { Vec3, type AppBase, type Entity } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssetLibrary } from '../formats/asset-library';
import { buildMd3 } from '../formats/md3-test-fixtures';
import { GT } from '../sim/constants';
import { vec3 } from '../sim/vec3';
import { flagTrails as trailPlaces } from '../view/flag-trail';
import { SceneShaders } from '../view/scene-shaders';
import { PLAYER_PART, packetEntity } from '../view/scene-sort';
import { PW } from '../sim/items';
import { createTestApp } from './engine-test-fixtures';
import { FlagTrails } from './flag-trails';
import { encode, whiteTga } from './player-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';
import { TextureCache } from './texture-cache';
import { WARM_TIMES } from './warm-up';

/**
 * The flags on their carriers' backs, drawn as `CG_TrailItem` draws them: the flag item's own
 * world model, behind and above the carrier, turned across their facing.
 */

const RED = 'models/flags/r_flag.md3';
const BLUE = 'models/flags/b_flag.md3';

/**
 * Both flag models over white textures, as the item on its stand is drawn from.
 *
 * @param broken - Models whose bytes are no model at all.
 */
function library(paths: readonly string[] = [RED, BLUE], broken: readonly string[] = []): AssetLibrary {
  const files = new Map<string, Uint8Array>([
    ['scripts/flags.shader', encode('')],
    ['models/flags/r_flag2.tga', whiteTga()],
    ['models/flags/b_flag2.tga', whiteTga()]
  ]);
  for (const path of paths) {
    const texture = path === RED ? 'models/flags/r_flag2.tga' : 'models/flags/b_flag2.tga';
    const model = buildMd3({ surfaces: [{ name: 'flag', shader: texture }] });
    files.set(path, broken.includes(path) ? encode('not a model') : model);
  }
  return new AssetLibrary(files);
}

describe('FlagTrails', () => {
  let app: AppBase;
  let camera: Entity;
  let trails: FlagTrails | null;

  beforeEach(() => {
    const test = createTestApp();
    app = test.app;
    camera = test.camera;
    trails = null;
  });

  afterEach(() => {
    trails?.destroy();
    app.destroy();
  });

  /** The flags of a Capture the Flag match, drawn on `carriers`. */
  async function draw(
    carriers: Parameters<typeof trailPlaces>[0],
    assets = library()
  ): Promise<FlagTrails> {
    if (!trails) {
      trails = FlagTrails.create(app, assets, new TextureCache(app.graphicsDevice));
      await trails.register(GT.CTF);
    }
    trails.update(trailPlaces(carriers), 1000, camera);
    return trails;
  }

  const model = (team: 'red' | 'blue'): Entity => {
    const found = trails!.drawn(team);
    if (!found) throw new Error(`no ${team} flag model`);
    return found;
  };

  it("puts each flag where its carrier's back is", async () => {
    await draw([
      { origin: vec3(100, 0, 24), angles: vec3(0, 0, 0), powerups: 1 << PW.REDFLAG },
      { origin: vec3(-100, 0, 24), angles: vec3(0, 180, 0), powerups: 1 << PW.BLUEFLAG }
    ]);

    expect(model('red').enabled).toBe(true);
    expect([...model('red').getLocalPosition().toArray()]).toEqual([84, 0, 40]);
    // Facing −X, so its flag hangs sixteen the other way.
    expect(model('blue').getLocalPosition().x).toBeCloseTo(-84);
  });

  it('turns the model across the carrier, not along them', async () => {
    await draw([{ origin: vec3(0, 0, 0), angles: vec3(0, 0, 0), powerups: 1 << PW.REDFLAG }]);

    // Yaw 0 + 90: the model's own forward points along the world's +Y.
    const forward = model('red').getLocalRotation().transformVector(new Vec3(1, 0, 0));
    expect(forward.x).toBeCloseTo(0);
    expect(forward.y).toBeCloseTo(1);
  });

  it("numbers a flag in a map's scene as its carrier's flag", async () => {
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [],
      gun: [],
      screen: []
    });
    trails = FlagTrails.create(app, library(), new TextureCache(app.graphicsDevice), { scene });
    await trails.register(GT.CTF);
    const order = packetEntity(3, PLAYER_PART.flag);
    const powerups = 1 << PW.REDFLAG;
    await draw([{ origin: vec3(0, 0, 0), angles: vec3(0, 0, 0), powerups, order }]);
    expect(sceneDraw(model('red').render!.meshInstances[0])!.entity.value).toBe(order);
  });

  it('hides a flag nobody is carrying', async () => {
    await draw([{ origin: vec3(0, 0, 0), angles: vec3(0, 0, 0), powerups: 1 << PW.REDFLAG }]);
    expect(model('red').enabled).toBe(true);
    expect(model('blue').enabled).toBe(false);

    await draw([]);
    expect(model('red').enabled).toBe(false);
  });

  it('shows both flags for the warm-up, then hides them again', async () => {
    await draw([{ origin: vec3(0, 0, 0), angles: vec3(0, 0, 0), powerups: 1 << PW.REDFLAG }]);
    const warmed = trails!.warm();
    warmed.at(0);
    expect([model('red').enabled, model('blue').enabled]).toEqual([true, true]);
    warmed.at(WARM_TIMES[1]);
    warmed.end();
    // Each as it was: the carried one still up.
    expect([model('red').enabled, model('blue').enabled]).toEqual([true, false]);
  });

  it('draws nothing for a side whose model the install has not got', async () => {
    await draw(
      [
        { origin: vec3(0, 0, 0), angles: vec3(0, 0, 0), powerups: 1 << PW.REDFLAG },
        { origin: vec3(0, 0, 0), angles: vec3(0, 0, 0), powerups: 1 << PW.BLUEFLAG }
      ],
      library([RED])
    );

    expect(trails!.drawn('red')).not.toBeNull();
    expect(trails!.drawn('blue')).toBeNull();
  });

  it('draws nothing for a side whose model will not build, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await draw(
        [
          { origin: vec3(0, 0, 0), angles: vec3(0, 0, 0), powerups: 1 << PW.REDFLAG },
          { origin: vec3(0, 0, 0), angles: vec3(0, 0, 0), powerups: 1 << PW.BLUEFLAG }
        ],
        library([RED, BLUE], [RED])
      );

      expect(trails!.drawn('red')).toBeNull();
      expect(model('blue').enabled).toBe(true);
      expect(warn).toHaveBeenCalledWith(`flag trail: no model for ${RED}`, expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('builds nothing for any game but Capture the Flag', async () => {
    trails = FlagTrails.create(app, library(), new TextureCache(app.graphicsDevice));
    for (const gametype of [GT.FFA, GT.TOURNAMENT, GT.SINGLE_PLAYER, GT.TEAM, GT.ONEFCTF, GT.CA]) {
      await trails.register(gametype);
    }

    expect([trails.drawn('red'), trails.drawn('blue')]).toEqual([null, null]);
    expect(app.root.findByName('flag-trail-red')).toBeNull();
    expect(app.root.findByName('flag-trail-blue')).toBeNull();
  });

  it('builds both flags once for a match of Capture the Flag', async () => {
    trails = FlagTrails.create(app, library(), new TextureCache(app.graphicsDevice));
    await trails.register(GT.CTF);
    const red = model('red');
    expect(model('blue')).not.toBe(red);
    expect(red.enabled).toBe(false);

    await trails.register(GT.CTF);
    expect(model('red')).toBe(red);
  });

  it("frees both flags as the match goes, and builds the next match's afresh", async () => {
    const textures = new TextureCache(app.graphicsDevice);
    trails = FlagTrails.create(app, library(), textures);
    await trails.register(GT.CTF);
    const red = model('red');
    expect(textures.size).toBeGreaterThan(0);

    trails.clear();
    expect([trails.drawn('red'), trails.drawn('blue')]).toEqual([null, null]);
    expect(red.parent).toBeNull();
    expect(textures.size).toBe(0);

    await trails.register(GT.CTF);
    expect(model('red')).not.toBe(red);
    expect(model('red').parent).not.toBeNull();
  });

  it('frees flags still being built as the match goes', async () => {
    const textures = new TextureCache(app.graphicsDevice);
    trails = FlagTrails.create(app, library(), textures);
    const building = trails.register(GT.CTF);
    trails.clear();
    await building;

    expect([trails.drawn('red'), trails.drawn('blue')]).toEqual([null, null]);
    expect(app.root.findByName('flag-trail-red')).toBeNull();
    expect(textures.size).toBe(0);
  });
});
