// @vitest-environment jsdom
import { Vec3, type AppBase, type Entity, type MeshInstance, type StandardMaterial } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssetLibrary } from '../formats/asset-library';
import { buildMd3 } from '../formats/md3-test-fixtures';
import { TR, createEntityState } from '../net/protocol';
import { ET } from '../sim/game-entity';
import { GREEN_ARMOR_TINT, ITEMS, NUM_ITEMS, findItem, itemIndex } from '../sim/items';
import { copy, vec3, type Vec3 as QuakeVec3 } from '../sim/vec3';
import { worldToSim } from '../coords';
import { SceneLights } from '../view/dynamic-lights';
import { entityLightAt } from '../view/entity-light';
import type { ItemCentity } from '../view/player-view';
import type { Rgb } from '../view/player-color';
import { SceneShaders } from '../view/scene-shaders';
import { packetEntity } from '../view/scene-sort';
import { createTestApp, expectClose, uniform } from './engine-test-fixtures';
import { TextureCache } from './texture-cache';
import { ItemEntities, listedItems } from './item-entities';
import { encode, whiteTga } from './player-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';

/**
 * The items on the map, drawn as `CG_Item` draws them: a spin, a bob, a scale-up after a respawn,
 * a weapon lifted onto its own middle and made half again as large, and the ring or sphere that
 * comes with a powerup or a health.
 */

const ARMOR = 'models/powerups/armor/armor_yel.md3';
const SHARD = 'models/powerups/armor/shard.md3';
const SHARD_SPHERE = 'models/powerups/armor/shard_sphere.md3';
const HEALTH = 'models/powerups/health/medium_cross.md3';
const HEALTH_SPHERE = 'models/powerups/health/medium_sphere.md3';
const RAIL = 'models/weapons2/railgun/railgun.md3';
const MG = 'models/weapons2/machinegun/machinegun.md3';
const QUAD = 'models/powerups/instant/quad.md3';
const QUAD_RING = 'models/powerups/instant/quad_ring.md3';

/**
 * A lit base, an entity-coloured glow and a mirror, as the railgun's items shader has; and the
 * yellow armour's scrolling energy.
 */
const SHADERS = `
models/weapons2/railgun/rail
{
  { map models/weapons2/railgun/rail.tga rgbGen lightingDiffuse }
  { map models/weapons2/railgun/rail.tga blendfunc add rgbGen entity }
  { map models/weapons2/railgun/rail.tga blendfunc add tcGen environment }
}
models/powerups/armor/energy_yel1
{
  { map models/powerups/armor/energy_yel3.tga blendFunc GL_ONE GL_ONE tcMod scroll 7.4 1.3
    }
}
`;

/**
 * The item models these tests draw, over white textures.
 *
 * @param replaced - Files to put in place of the library's own.
 */
function library(replaced: [string, Uint8Array][] = []): AssetLibrary {
  const one = (shader: string) => buildMd3({ surfaces: [{ name: 'item', shader }] });
  return new AssetLibrary(
    new Map([
      ['scripts/items.shader', encode(SHADERS)],
      ['models/powerups/armor/newyellow.tga', whiteTga()],
      ['models/powerups/armor/energy_yel3.tga', whiteTga()],
      ['models/powerups/health/cross.tga', whiteTga()],
      ['models/powerups/health/sphere.tga', whiteTga()],
      ['models/weapons2/railgun/rail.tga', whiteTga()],
      ['models/weapons2/machinegun/mg.tga', whiteTga()],
      ['models/weapons2/machinegun/machinegun_barrel.md3', one('models/weapons2/machinegun/mg.tga')],
      ['models/powerups/instant/quad.tga', whiteTga()],
      ['models/powerups/instant/ring.tga', whiteTga()],
      [
        ARMOR,
        buildMd3({
          surfaces: [
            { name: 'armor', shader: 'models/powerups/armor/newyellow.tga' },
            { name: 'energy', shader: 'models/powerups/armor/energy_yel1' }
          ]
        })
      ],
      [SHARD, one('models/powerups/armor/newyellow.tga')],
      [SHARD_SPHERE, one('models/powerups/armor/newyellow.tga')],
      [HEALTH, one('models/powerups/health/cross.tga')],
      [HEALTH_SPHERE, one('models/powerups/health/sphere.tga')],
      [
        RAIL,
        buildMd3({
          bounds: { mins: [0, 0, 0], maxs: [32, 16, 16] },
          surfaces: [{ name: 'w_rail', shader: 'models/weapons2/railgun/rail' }]
        })
      ],
      [
        MG,
        buildMd3({
          tags: { tag_barrel: [{ origin: [8, 0, 0] }] },
          surfaces: [{ name: 'w_mg', shader: 'models/weapons2/machinegun/mg.tga' }]
        })
      ],
      [QUAD, one('models/powerups/instant/quad.tga')],
      [QUAD_RING, one('models/powerups/instant/ring.tga')],
      ...replaced
    ])
  );
}

/** `CS_ITEMS` listing these items, by classname. */
function listing(...classnames: string[]): string {
  const listed = new Array<string>(NUM_ITEMS).fill('0');
  for (const classname of classnames) listed[itemIndex(findItem(classname)!)] = '1';
  return listed.join('');
}

let nextNumber = 1;

/** An item entity as the client is sent one, and the view's own record around it. */
function item(
  classname: string,
  options: { origin?: QuakeVec3; respawnTime?: number; eFlags?: number; number?: number } = {}
): ItemCentity {
  const state = createEntityState(options.number ?? nextNumber++);
  state.eType = ET.ITEM;
  state.modelindex = itemIndex(findItem(classname)!);
  state.eFlags = options.eFlags ?? 0;
  state.pos.trType = TR.STATIONARY;
  state.pos.trBase = copy(options.origin ?? vec3());
  return {
    state,
    origin: copy(options.origin ?? vec3()),
    respawnTime: options.respawnTime ?? 0
  };
}

/** A draw's emissive colour. */
function emissive(instance: MeshInstance): number[] {
  const { r, g, b } = (instance.material as StandardMaterial).emissive;
  return [r, g, b];
}

describe('ItemEntities', () => {
  let app: AppBase;
  let camera: Entity;
  let items: ItemEntities | null;

  beforeEach(() => {
    const test = createTestApp();
    app = test.app;
    camera = test.camera;
    items = null;
    nextNumber = 1;
  });

  afterEach(async () => {
    await items?.destroy();
    app.destroy();
  });

  /** Draw one frame, and one more once anything new has been built, as the next frame would. */
  async function draw(list: readonly ItemCentity[], time = 1000, color?: Rgb): Promise<ItemEntities> {
    items ??= ItemEntities.create(app, library(), new TextureCache(app.graphicsDevice));
    items.update(list, time, camera, color);
    await items.settled();
    items.update(list, time, camera, color);
    return items;
  }

  /** The model built for an item entity number. */
  const model = (number: number): Entity => {
    const found = items!.drawn(number);
    if (!found) throw new Error(`nothing drawn for item ${number}`);
    return found;
  };

  /** One of an item's models, by the name the renderer builds it under. */
  const part = (number: number, name: string): Entity => {
    const found = model(number).findByName(name) as Entity | null;
    if (!found) throw new Error(`item ${number} has no ${name}`);
    return found;
  };

  /** A model's forward, as its local rotation turns the world's. */
  const forward = (entity: Entity): number[] => [
    ...entity.getLocalRotation().transformVector(new Vec3(1, 0, 0)).toArray()
  ];

  /** How long a model's light's direction is, in its own frame: 1 unless its axis is scaled. */
  const lightLength = (entity: Entity): number =>
    Math.hypot(...uniform(entity.render!.meshInstances[0], 'q3_light[0]').slice(8, 11));

  it('draws an item where the snapshot puts it, bobbing four units about its height', async () => {
    await draw([item('item_armor_combat', { origin: vec3(64, 0, 24) })]);

    const armor = model(1);
    expect(armor.enabled).toBe(true);
    expect([...armor.getLocalPosition().toArray()].slice(0, 2)).toEqual([64, 0]);
    // `4 + cos( ( cg.time + 1000 ) * scale ) * 4` (`cg_ents.c:262–263`), scale 0.005 + number * 1e-5.
    expect(armor.getLocalPosition().z).toBeCloseTo(24 + 0.687903906025761, 9);
  });

  it('draws nothing for one the snapshot left out, or flagged NODRAW', async () => {
    const armor = item('item_armor_combat', { origin: vec3(64, 0, 24) });
    await draw([armor]);
    expect(model(1).enabled).toBe(true);

    await draw([]);
    expect(model(1).enabled).toBe(false);

    await draw([item('item_armor_combat', { number: 1, eFlags: 0x80 })]);
    expect(model(1).enabled).toBe(false);
  });

  it('throws for a slot past the table, as `CG_Error` does', async () => {
    const bad = item('item_armor_combat');
    bad.state.modelindex = NUM_ITEMS;
    items = ItemEntities.create(app, library(), new TextureCache(app.graphicsDevice));
    expect(() => items!.update([bad], 1000, camera)).toThrow(`Bad item index ${NUM_ITEMS}`);
  });

  it("draws nothing for the table's placeholder slot", async () => {
    const placeholder = item('item_armor_combat');
    placeholder.state.modelindex = 0;
    items = ItemEntities.create(app, library(), new TextureCache(app.graphicsDevice));
    items.update([placeholder], 1000, camera);
    await items.settled();
    expect(items.drawn(1)).toBeNull();
  });

  it("lights each model of an item where it is drawn, the scene's lights folded in", async () => {
    const lights = new SceneLights();
    lights.add({ x: 64, y: 0, z: 80 }, 200, [0.2, 0.2, 1]);
    items = ItemEntities.create(app, library(), new TextureCache(app.graphicsDevice), { lights });
    await draw([item('item_quad', { origin: vec3(64, 0, 24) })]);
    // The quad and its ring, twelve units above it: each takes the light at its own origin.
    const directed = ['main', 'second'].map((name) => {
      const entity = part(1, name);
      const at = entity.getPosition();
      const lit = entityLightAt(worldToSim(at.x, at.y, at.z), lights);
      const light = uniform(entity.render!.meshInstances[0], 'q3_light[0]');
      // A uniform holds a float32, a unit's millionth apart at a few hundred.
      for (let i = 0; i < 3; i++) expect(light[4 + i]).toBeCloseTo(lit.directed[i], 3);
      return light[6];
    });
    expect(directed[0]).not.toBeCloseTo(directed[1], 3);
  });

  it('spins the rest slowly and health at twice the rate', async () => {
    await draw([
      item('item_armor_combat', { origin: vec3(-64, 0, 24) }),
      item('item_health', { origin: vec3(64, 0, 24) })
    ]);

    // `( cg.time & 2047 ) * 360 / 2048` for the rest, `( cg.time & 1023 ) * 360 / 1024` for health.
    expect(forward(part(1, 'main'))[0]).toBeCloseTo(-0.9972904566786902, 7);
    expect(forward(part(1, 'main'))[1]).toBeCloseTo(0.07356456359966729, 7);
    expect(forward(part(2, 'main'))[0]).toBeCloseTo(0.989176509964781, 7);
    expect(forward(part(2, 'main'))[1]).toBeCloseTo(-0.1467304744553615, 7);
  });

  it('lifts a weapon off its own middle and draws it half again as large', async () => {
    await draw([item('weapon_railgun', { origin: vec3(64, 0, 24) })]);

    const rail = part(1, 'main');
    const [x, y, z] = rail.getLocalPosition().toArray();
    expect(x).toBeCloseTo(16.54516381565638, 7);
    expect(y).toBeCloseTo(6.801290635834845, 7);
    // The +8 and the -8 of the middle cancel here; the bob is on the container.
    expect(z).toBeCloseTo(0, 9);
    expect([...rail.getLocalScale().toArray()]).toEqual([1.5, 1.5, 1.5]);
    // Its light's direction is dotted with the scaled axis, so it is lit half again as hard
    // (`tr_light.c:375-377`).
    expect(lightLength(rail)).toBeCloseTo(1.5, 5);
  });

  it("puts a weapon's barrel on its tag, lit as hard as its gun", async () => {
    await draw([item('weapon_machinegun', { origin: vec3(64, 0, 24) })]);

    const barrel = part(1, 'main').findByName('barrel') as Entity | null;
    expect(barrel).not.toBeNull();
    expect([...barrel!.getLocalPosition().toArray()]).toEqual([8, 0, 0]);
    expect(lightLength(barrel!)).toBeCloseTo(1.5, 5);
  });

  it("numbers an item's models in a map's scene as its entity's parts, in order", async () => {
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [],
      gun: [],
      screen: []
    });
    items = ItemEntities.create(app, library(), new TextureCache(app.graphicsDevice), { scene });
    await draw([
      item('weapon_machinegun', { number: 7, origin: vec3(64, 0, 24) }),
      item('item_quad', { number: 9, origin: vec3(0, 64, 24) })
    ]);
    const numberOf = (entity: Entity) => sceneDraw(entity.render!.meshInstances[0])!.entity.value;
    expect([
      numberOf(part(7, 'main')),
      numberOf(part(7, 'main').findByName('barrel') as Entity),
      numberOf(part(9, 'main')),
      numberOf(part(9, 'second'))
    ]).toEqual([packetEntity(7, 0), packetEntity(7, 1), packetEntity(9, 0), packetEntity(9, 2)]);
  });

  it("draws a powerup's ring the other way and twelve units up, and a health's sphere at its own height", async () => {
    await draw([
      item('item_quad', { number: 4, origin: vec3(0, 64, 24) }),
      item('item_health', { number: 2, origin: vec3(0, -64, 24) })
    ]);

    const ring = part(4, 'second') as Entity | null;
    expect(ring).not.toBeNull();
    expect(ring!.getLocalPosition().z).toBeCloseTo(12, 9);
    // `spinAngles[1] = ( cg.time & 1023 ) * 360 / -1024.0f`: the fast rate, turned the other way.
    expect(forward(ring!)[0]).toBeCloseTo(0.989176509964781, 7);
    expect(forward(ring!)[1]).toBeCloseTo(0.1467304744553615, 7);

    const sphere = part(2, 'second') as Entity | null;
    expect(sphere).not.toBeNull();
    // A health's second model stands where the item does, with no rise.
    expect([...sphere!.getLocalPosition().toArray()]).toEqual([0, 0, 0]);
    expect(model(2).getLocalPosition().y).toBe(-64);
  });

  it('draws no ring for an item that has none', async () => {
    await draw([item('item_armor_combat', { origin: vec3(64, 0, 24) })]);
    expect(part(1, 'main').findByName('second')).toBeNull()
    expect(model(1).findByName('second')).toBeNull();
  });

  it('scales an item up over the second after it respawns, then leaves it be', async () => {
    const armor = item('item_armor_combat', { origin: vec3(64, 0, 24), respawnTime: 1000 });
    await draw([armor], 1250);
    expect(part(1, 'main').getLocalScale().x).toBeCloseTo(0.25, 9);
    // Lit as softly, by its scaled axis.
    expect(lightLength(part(1, 'main'))).toBeCloseTo(0.25, 5);

    await draw([armor], 2000);
    expect(part(1, 'main').getLocalScale().x).toBeCloseTo(1, 9);
    expect(lightLength(part(1, 'main'))).toBeCloseTo(1, 5);
  });

  it("tints the railgun with the player's colour, as ioq3's item does", async () => {
    await draw([item('weapon_railgun', { origin: vec3(64, 0, 24) })], 1000, [0, 1, 0]);

    const [base, glow] = part(1, 'main').render!.meshInstances;
    expect((base.material as StandardMaterial).emissiveVertexColor).toBe(true);
    // `rgbGen entity` shows at twice color1, as classic Q3's ramp doubles it.
    expect(emissive(glow)).toEqual([0, 2, 0]);
  });

  it("draws the Green Armor as the yellow armour's model, in its tint", async () => {
    await draw([
      item('item_armor_combat', { origin: vec3(64, 0, 24) }),
      item('item_armor_jacket', { origin: vec3(0, 64, 24) })
    ]);
    const yellow = part(1, 'main').render!.meshInstances;
    const green = part(2, 'main').render!.meshInstances;
    expect(green.map((draw) => draw.mesh)).toEqual(yellow.map((draw) => draw.mesh));
    // The body, drawn still, and the energy, played every frame.
    expect(yellow).toHaveLength(2);
    for (const [i, draw] of yellow.entries()) {
      const [r, g, b] = emissive(draw);
      expect(r).toBeGreaterThan(0);
      expect(emissive(green[i])).toEqual([
        r * GREEN_ARMOR_TINT[0],
        g * GREEN_ARMOR_TINT[1],
        b * GREEN_ARMOR_TINT[2]
      ]);
    }
  });

  it("mirrors the railgun by where the camera is, taken into the item's frame", async () => {
    camera.setPosition(0.5, 1, 3);
    await draw([item('weapon_railgun', { origin: vec3(64, 0, 24) })]);
    const rail = part(1, 'main');
    const [, , mirror] = rail.render!.meshInstances;
    const eye = rail.getWorldTransform().clone().invert().transformPoint(camera.getPosition());
    expectClose(uniform(mirror, 'q3_viewer'), [eye.x, eye.y, eye.z, 1]);
  });

  it('keeps a built item for a slot that comes back, rather than building it again', async () => {
    const armor = item('item_armor_combat', { origin: vec3(64, 0, 24) });
    await draw([armor]);
    const built = model(1);

    await draw([]);
    await draw([item('item_armor_combat', { number: 1, origin: vec3(0, 0, 24) })]);

    expect(model(1)).toBe(built);
    expect(built.enabled).toBe(true);
  });

  it('rebuilds a number that comes back wearing another item', async () => {
    await draw([item('item_armor_combat', { origin: vec3(64, 0, 24) })]);
    const armor = model(1);

    await draw([item('weapon_railgun', { number: 1, origin: vec3(64, 0, 24) })]);

    expect(model(1)).not.toBe(armor);
    expect(part(1, 'main').getLocalScale().x).toBeCloseTo(1.5, 9);
  });

  it("frees every model as the match goes, and builds the next match's afresh", async () => {
    const textures = new TextureCache(app.graphicsDevice);
    items = ItemEntities.create(app, library(), textures);
    const armor = item('item_armor_combat', { origin: vec3(64, 0, 24) });
    await draw([armor]);
    const built = items.drawn(1)!;
    expect(textures.size).toBeGreaterThan(0);

    items.clear();
    expect(items.drawn(1)).toBeNull();
    expect(built.parent).toBeNull();
    expect(app.root.findByName('item-item_armor_combat')).toBeNull();
    expect(textures.size).toBe(0);

    await draw([armor]);
    expect(items.drawn(1)).not.toBe(built);
    expect(items.drawn(1)).not.toBeNull();
  });

  it('frees a model still being built as the match goes', async () => {
    const textures = new TextureCache(app.graphicsDevice);
    items = ItemEntities.create(app, library(), textures);
    items.update([item('item_armor_combat', { origin: vec3(64, 0, 24) })], 1000, camera);
    items.clear();
    await items.settled();
    expect(items.drawn(1)).toBeNull();
    expect(textures.size).toBe(0);
  });

  it('draws no second model for armor, whose sphere is registered and never drawn', async () => {
    await draw([item('item_armor_shard', { origin: vec3(64, 0, 24) })]);
    expect(model(1).findByName('second')).toBeNull();
  });

  it('builds each item the gamestate lists, naming each, and draws it from the first', async () => {
    items = ItemEntities.create(app, library(), new TextureCache(app.graphicsDevice));
    const named: string[] = [];
    await items.register(listedItems(listing('item_quad', 'item_armor_combat')), (slot, at) =>
      named.push(`${at} ${ITEMS[slot].pickupName}`)
    );
    expect(named).toEqual(['0 Armor', '1 Quad Damage']);

    items.update([item('item_quad', { origin: vec3(0, 64, 24) })], 1000, camera);
    expect(model(1).enabled).toBe(true);
    expect(part(1, 'second').getLocalPosition().z).toBeCloseTo(12, 9);
  });

  it('stops registering once the match it was for has gone', async () => {
    items = ItemEntities.create(app, library(), new TextureCache(app.graphicsDevice));
    const listed = listedItems(listing('item_armor_combat', 'item_quad'));
    await items.register(listed, (_slot, at) => {
      if (at === 0) items!.clear();
    });
    expect(app.root.findByName('item-item_quad')).toBeNull();
  });

  it('draws every entity of an item from its one build, each placed and lit apart', async () => {
    const lights = new SceneLights();
    lights.add({ x: 64, y: 0, z: 40 }, 200, [1, 0.2, 0.2]);
    items = ItemEntities.create(app, library(), new TextureCache(app.graphicsDevice), { lights });
    await items.register(listedItems(listing('item_armor_combat')));
    items.update(
      [
        item('item_armor_combat', { origin: vec3(64, 0, 24) }),
        item('item_armor_combat', { origin: vec3(-256, 0, 24) })
      ],
      1000,
      camera
    );
    const [near, far] = [1, 2].map((number) => part(number, 'main').render!.meshInstances);
    for (const [i, draw] of near.entries()) {
      expect(draw.material).toBe(far[i].material);
      expect(draw.mesh).toBe(far[i].mesh);
      expect(draw).not.toBe(far[i]);
    }
    expect(uniform(near[0], 'q3_light[0]')).not.toEqual(uniform(far[0], 'q3_light[0]'));
  });

  it('builds an item the gamestate did not list as it is first seen', async () => {
    items = ItemEntities.create(app, library(), new TextureCache(app.graphicsDevice));
    await items.register(listedItems(listing('item_armor_combat')));
    const rail = item('weapon_railgun', { origin: vec3(64, 0, 24) });
    items.update([rail], 1000, camera);
    expect(items.drawn(1)).toBeNull();

    await items.settled();
    items.update([rail], 1000, camera);
    expect(model(1).enabled).toBe(true);
  });

  it('draws nothing of an item whose model will not load, and builds it once', async () => {
    const broken = library([[ARMOR, new Uint8Array(4)]]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    items = ItemEntities.create(app, broken, new TextureCache(app.graphicsDevice));
    const armor = item('item_armor_combat', { origin: vec3(64, 0, 24) });
    await draw([armor]);
    await draw([armor]);
    expect(items.drawn(1)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("shows each item's build for the warm-up's frames, played at each, then hides", async () => {
    items = ItemEntities.create(app, library(), new TextureCache(app.graphicsDevice));
    await items.register(listedItems(listing('item_armor_combat')));
    const built = app.root.findByName('item-item_armor_combat') as Entity;
    const [, energy] = (built.findByName('main') as Entity).render!.meshInstances;
    const offset = () => uniform(energy, 'q3_coords[0]').slice(6, 7);
    expect(built.enabled).toBe(false);

    const warmed = items.warm();
    warmed.at(0);
    expect(built.enabled).toBe(true);
    const still = offset();
    warmed.at(0.5);
    expect(offset()).not.toEqual(still);

    warmed.end();
    expect(built.enabled).toBe(false);
  });
});

describe('listedItems', () => {
  it('reads the table slots CS_ITEMS lists, never the placeholder', () => {
    expect(listedItems('1101')).toEqual([1, 3]);
    expect(listedItems('')).toEqual([]);
  });
});




