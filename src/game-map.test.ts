// @vitest-environment jsdom
import { zipSync } from 'fflate';
import {
  BoundingBox,
  Entity,
  Vec3,
  type AppBase,
  type Asset,
  type RenderComponent,
  type ResourceHandler
} from 'playcanvas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCollisionOverlay } from './collision-overlay';
import { LUMP_ENTITIES, LUMP_FOGS, LUMP_NODES, parseBsp } from './formats/bsp';
import { bspFile, buildBsp, entityLump, int32s } from './formats/bsp-test-fixtures';
import {
  BspGameMap,
  GameMap,
  loadFromBytes,
  loadHostMap,
  loadSplat,
  type BspGameMapOptions
} from './game-map';
import { testCvars } from './net/net-test-fixtures';
import { memorySource } from './pak/byte-source';
import { PakFileSystem } from './pak/vfs';
import { ZipArchive } from './pak/zip';
import { createTestApp } from './render/engine-test-fixtures';
import { TextureCache } from './render/texture-cache';
import { WARM_TIMES } from './render/warm-up';
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from './net/protocol';
import { clipBsp, cubeBsp, patchBsp, triggerBsp } from './sim/cm/collision-test-fixtures';
import { CONTENTS, MASK } from './sim/constants';
import { packBin } from './sim/octree-test-fixtures';
import { vec3 } from './sim/vec3';
import { SparseVoxelOctree } from './sim/voxel-svo';

/**
 * A map's files, loaded from bytes the search path read. A splat needs a GPU to parse, so the
 * handlers here stand in for the engine's: each records what it was handed, as the SOG bundle
 * parser and the container parser read it (`file.contents`), and makes a resource of nothing.
 */

/** What a stand-in handler was handed, per load. */
interface Handed {
  url: string;
  contents: ArrayBuffer | null | undefined;
}

/** A stand-in for a loaded resource: what the engine asks of a splat's or a container's. */
interface StandInResource {
  destroy: () => void;
  /** How many sorters hold a splat, which defers its freeing. */
  refCount: number;
  gsplatData: { numSplats: number };
  instantiateRenderEntity: () => Entity;
  /** A splat's bounds, in its own space. */
  aabb?: BoundingBox;
}

/**
 * Put a stand-in handler for `type` on the app, recording what it is handed.
 *
 * @param resources - Filled with each resource it makes.
 */
function standIn(app: AppBase, type: string, resources: StandInResource[] = []): Handed[] {
  const handed: Handed[] = [];
  app.loader.addHandler(type, {
    load(
      url: { load: string; original: string },
      callback: (err: string | null, data?: unknown) => void,
      asset: Asset
    ) {
      const { contents } = asset.file as { contents?: ArrayBuffer };
      handed.push({ url: url.original, contents });
      const resource: StandInResource = {
        destroy: vi.fn(),
        refCount: 0,
        gsplatData: { numSplats: 42 },
        // A container's one mesh, as the collision bake's is.
        instantiateRenderEntity: () => {
          const entity = new Entity('collision');
          entity.addComponent('render', { type: 'box' });
          return entity;
        }
      };
      resources.push(resource);
      callback(null, resource);
    },
    open: (_url: string, data: unknown) => data,
    patch() {}
  } as unknown as ResourceHandler);
  return handed;
}

/** A search path of one pak holding the given files. */
async function searchPathOf(files: Record<string, Uint8Array>): Promise<PakFileSystem> {
  const fs = new PakFileSystem();
  // Stored, as a map pk3 stores its splat.
  fs.mount(await ZipArchive.open(memorySource('map-test.pk3', zipSync(files, { level: 0 }))));
  return fs;
}

let app: AppBase;
let camera: Entity;
beforeEach(() => {
  ({ app, camera } = createTestApp());
});

describe('loadFromBytes', () => {
  it('hands the parser the bytes by the file name, then lets them go', async () => {
    const handed = standIn(app, 'gsplat');
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const asset = await loadFromBytes(app, 'maps/room.sog', 'gsplat', bytes);

    // The name is what picks the parser, and the bytes are read in place of fetching it.
    expect(handed).toHaveLength(1);
    expect(handed[0].url).toBe('maps/room.sog');
    expect([...new Uint8Array(handed[0].contents!)]).toEqual([1, 2, 3, 4]);
    expect(app.assets.get(asset.id)).toBe(asset);
    expect(asset.loaded).toBe(true);
    // A splat's bytes are 185 MB, and the asset lives as long as the map does.
    expect((asset.file as { contents: ArrayBuffer | null }).contents).toBeNull();
  });

  it('rejects with the file named when the parser fails', async () => {
    app.loader.addHandler('gsplat', {
      load: (_url: unknown, callback: (err: string) => void) => callback('bad bundle'),
      open: (_url: string, data: unknown) => data,
      patch() {}
    } as unknown as ResourceHandler);
    await expect(loadFromBytes(app, 'maps/room.sog', 'gsplat', new Uint8Array(1))).rejects.toThrow(
      'Failed to load maps/room.sog: bad bundle'
    );
  });
});

describe('loadSplat', () => {
  it("reads the map's .sog through the search path, telling its progress", async () => {
    const handed = standIn(app, 'gsplat');
    const splat = new Uint8Array(64).fill(7);
    const fs = await searchPathOf({ 'maps/room.sog': splat });
    const heard: number[] = [];

    await loadSplat(app, fs, 'room', (received, total) => heard.push(received / total));

    expect([...new Uint8Array(handed[0].contents!)]).toEqual([...splat]);
    expect(heard.at(-1)).toBe(1);
  });

  it("says Q3's `Can't find map` for a map without one", async () => {
    const fs = await searchPathOf({ 'maps/room.ent': new Uint8Array(1) });
    await expect(loadSplat(app, fs, 'room')).rejects.toThrow("Can't find map maps/room.sog");
  });
});

/** A one-block octree, empty: enough to trace against. */
function emptyOctree(): SparseVoxelOctree {
  return SparseVoxelOctree.fromBuffers(
    {
      version: '1.1',
      gridBounds: { min: [0, 0, 0], max: [4, 4, 4] },
      sceneBounds: { min: [0, 0, 0], max: [4, 4, 4] },
      voxelResolution: 1,
      leafSize: 4,
      treeDepth: 0,
      numInteriorNodes: 0,
      numMixedLeaves: 0,
      nodeCount: 1,
      leafDataCount: 0
    },
    packBin([0], [])
  );
}

/** A map's pk3: its splat and its collision mesh. */
const mapFiles = (name: string) => ({
  [`maps/${name}.sog`]: new Uint8Array(8),
  [`maps/${name}.collision.glb`]: new Uint8Array(8)
});

/** Load a map as the app does, over the stand-in handlers. */
async function loadMap(fs: PakFileSystem, name: string): Promise<GameMap> {
  const splat = await loadSplat(app, fs, name);
  const collision = await loadCollisionOverlay(app, fs, name, false);
  return new GameMap(app, { name, splat, octree: emptyOctree(), entities: '{}', collision });
}

/** Everything a map could leave behind, counted. */
const counts = () => ({
  assets: app.assets.list().length,
  splats: app.root.findComponents('gsplat').length,
  entities: app.root.children.length
});

/** Destroy a map, running the frames it waits for. */
async function destroyed(map: GameMap): Promise<void> {
  const done = map.destroy();
  for (let frame = 0; frame < 3; frame++) app.fire('frameend');
  await done;
}

/** A map's collision files, as a bake writes them: the header and the packed nodes. */
const octreeFiles = (name: string) => ({
  [`maps/${name}.voxel.json`]: new TextEncoder().encode(
    JSON.stringify({
      version: '1.1',
      gridBounds: { min: [0, 0, 0], max: [4, 4, 4] },
      sceneBounds: { min: [0, 0, 0], max: [4, 4, 4] },
      voxelResolution: 1,
      leafSize: 4,
      treeDepth: 0,
      numInteriorNodes: 0,
      numMixedLeaves: 0,
      nodeCount: 1,
      leafDataCount: 0
    })
  ),
  [`maps/${name}.voxel.bin`]: new Uint8Array(packBin([0], []))
});

describe('loadHostMap', () => {
  it("reads the server's map — the entity text and the collision — and no splat", async () => {
    const fs = await searchPathOf({
      ...octreeFiles('room'),
      'maps/room.ent': new TextEncoder().encode('{\n"classname" "worldspawn"\n}\n')
    });

    const map = await loadHostMap(fs, 'room');

    expect(map.name).toBe('room');
    expect(map.entities).toContain('worldspawn');
    // It answers traces out of its own collision, and reads no splat: the server draws nothing.
    const origin = { x: 0, y: 0, z: 0 };
    const end = { x: 64, y: 0, z: 0 };
    expect(map.trace!(origin, origin, origin, end, ENTITYNUM_NONE, MASK.PLAYERSOLID).fraction).toBe(
      1
    );
  });

  it("says what it could not find, as `CM_LoadMap` does", async () => {
    const fs = await searchPathOf({ 'maps/room.ent': new Uint8Array(1) });
    await expect(loadHostMap(fs, 'room')).rejects.toThrow("Couldn't load maps/room.voxel.json");
  });
});

describe('GameMap', () => {
  it('puts the splat in the scene, and takes it out and frees it', async () => {
    const splats: StandInResource[] = [];
    standIn(app, 'gsplat', splats);
    standIn(app, 'container');
    const fs = await searchPathOf(mapFiles('room'));
    const before = counts();

    const map = await loadMap(fs, 'room');
    expect(map.splatCount).toBe(42);
    expect(counts()).toEqual({
      assets: before.assets + 2,
      splats: 1,
      entities: before.entities + 2
    });

    await destroyed(map);
    expect(counts()).toEqual(before);
    // `unload`, not only `remove`: the splat's resource is what holds its planes.
    expect(splats[0].destroy).toHaveBeenCalledOnce();
  });

  it('cycles two maps and back with nothing left of either', async () => {
    standIn(app, 'gsplat');
    standIn(app, 'container');
    const fs = await searchPathOf({ ...mapFiles('garage'), ...mapFiles('backyard') });
    const before = counts();

    for (const name of ['garage', 'backyard', 'garage']) {
      const map = await loadMap(fs, name);
      // One map in the scene at a time: the one just loaded.
      expect(app.root.findComponents('gsplat')).toHaveLength(1);
      expect(map.root.parent).toBe(app.root);
      await destroyed(map);
      expect(counts()).toEqual(before);
    }
  });

  it('traces against its own octree, and finds what a point is inside in it', async () => {
    standIn(app, 'gsplat');
    standIn(app, 'container');
    const map = await loadMap(await searchPathOf(mapFiles('room')), 'room');
    const origin = { x: 0, y: 0, z: 0 };
    const end = { x: 64, y: 0, z: 0 };
    expect(map.trace(origin, origin, origin, end, ENTITYNUM_NONE, MASK.PLAYERSOLID).fraction).toBe(
      1
    );
    // Open inside the octree's grid, which is the sim's −128..0 each way, and solid outside it.
    expect(map.pointContents({ x: -64, y: -64, z: -32 }, ENTITYNUM_NONE)).toBe(0);
    expect(map.pointContents({ x: 0, y: 0, z: 1e6 }, ENTITYNUM_NONE)).toBe(CONTENTS.SOLID);
  });

  it("moves the eye to the splat's middle, then a corner, for the warm-up, and back", async () => {
    const splats: StandInResource[] = [];
    standIn(app, 'gsplat', splats);
    standIn(app, 'container');
    const map = await loadMap(await searchPathOf(mapFiles('room')), 'room');
    splats[0].aabb = new BoundingBox(new Vec3(0, 1, 2), new Vec3(4, 3, 2));
    map.root.setPosition(10, 0, 0);
    const eye = new Entity('eye');
    app.root.addChild(eye);
    eye.setPosition(1, 2, 3);
    const at = () => [...eye.getPosition().toArray()];

    const warmed = map.warm(eye);
    warmed.at(0);
    expect(at()).toEqual([10, 1, 2]);
    // Still inside the bounds, and as far from the middle as they are big: far enough that the
    // engine works the splat's colour out again.
    warmed.at(WARM_TIMES[1]);
    expect(at()).toEqual([14, 4, 4]);
    warmed.end();
    expect(at()).toEqual([1, 2, 3]);
  });

  it('leaves the eye where it is for a splat with no bounds', async () => {
    standIn(app, 'gsplat');
    standIn(app, 'container');
    const map = await loadMap(await searchPathOf(mapFiles('room')), 'room');
    const eye = new Entity('eye');
    app.root.addChild(eye);
    eye.setPosition(1, 2, 3);

    const warmed = map.warm(eye);
    for (const seconds of WARM_TIMES) warmed.at(seconds);
    warmed.end();
    expect([...eye.getPosition().toArray()]).toEqual([1, 2, 3]);
  });

  it('resolves only once the sorter has let the splat go, and a frame has passed', async () => {
    const splats: StandInResource[] = [];
    standIn(app, 'gsplat', splats);
    standIn(app, 'container');
    const map = await loadMap(await searchPathOf(mapFiles('room')), 'room');
    splats[0].refCount = 1;

    let done = false;
    const destroying = map.destroy().then(() => (done = true));
    /** Every frame a check waits on, with all it set going run through. */
    const frame = async () => {
      app.fire('frameend');
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await frame();
    await frame();
    expect(done).toBe(false);

    // The sorter lets go; the director frees the splat on the frame after.
    splats[0].refCount = 0;
    await frame();
    expect(done).toBe(false);
    await frame();
    await destroying;
    expect(done).toBe(true);
  });
});

describe('BspGameMap', () => {
  /** The world's settings at their defaults, its search path holding no image. */
  const options = (name: string, more: Partial<BspGameMapOptions> = {}): BspGameMapOptions => ({
    name,
    scripts: new Map(),
    fs: { resolveImage: () => undefined, read: async () => undefined },
    cache: new TextureCache(app.graphicsDevice),
    picmip: 0,
    mapOverBrightBits: 2,
    fullbright: false,
    subdivisions: 4,
    multitexture: true,
    textureEnvAdd: true,
    detailTextures: true,
    time: 0,
    offset: { factor: -1, units: -2 },
    warn: () => {},
    ...more
  });

  /** A map loaded from its file, through the test's eye. */
  const load = (file: Uint8Array, opts: BspGameMapOptions) =>
    BspGameMap.load(app, camera.camera!, file, opts);

  /** A player's box dropped onto the collision tests' cube, whose top is at z 64. */
  const fall = (map: BspGameMap) =>
    map.trace(
      vec3(0, 0, 200),
      vec3(-15, -15, -24),
      vec3(15, 15, 32),
      vec3(0, 0, 0),
      ENTITYNUM_NONE,
      MASK.PLAYERSOLID
    );

  it('draws the world and traces its collision, both loaded from the one file', async () => {
    const told: string[] = [];
    const map = await load(
      bspFile(cubeBsp()),
      options('cube', { collided: (entities) => told.push(entities) })
    );

    expect(map.name).toBe('cube');
    // `CM_EntityString`: lump 0, its closing NUL kept, as the game's reader takes it.
    expect(map.entities).toBe('{ "classname" "worldspawn" }\0');
    expect(told).toEqual([map.entities]);
    expect(map.root).toBe(map.world.root);
    expect(map.root.parent).toBe(app.root);
    expect(camera.camera!.layers).toContain(map.world.layer.id);
    const trace = fall(map);
    // The box's feet stop SURFACE_CLIP_EPSILON above the cube's top.
    expect(trace.endpos.z - 24).toBeCloseTo(64.125, 4);
    expect([trace.normal, trace.entityNum]).toEqual([vec3(0, 0, 1), ENTITYNUM_WORLD]);
    // `CG_PointContents`' world: the cube is solid, and above it is nothing.
    expect(map.pointContents(vec3(0, 0, 0), ENTITYNUM_NONE)).toBe(CONTENTS.SOLID);
    expect(map.pointContents(vec3(0, 0, 100), ENTITYNUM_NONE)).toBe(0);
    await map.destroy();
  });

  it('tests a box on its own inline models, which a trigger is touched by', async () => {
    const map = await load(bspFile(triggerBsp()), options('trigger'));
    const [mins, maxs] = [vec3(-15, -15, -24), vec3(15, 15, 32)];

    expect(map.inlineModels.inlineModel(1)).toBe(1);
    expect(map.inlineModels.contact(1, vec3(50, 50, 20), mins, maxs)).toBe(true);
    expect(map.inlineModels.contact(1, vec3(75, 75, 20), mins, maxs)).toBe(false);
    expect(() => map.inlineModels.inlineModel(2)).toThrow('CM_InlineModel: bad number');
    await map.destroy();
  });

  it('stops a player at player clip, and lets a shot through, as the server does', async () => {
    const shaders = cubeBsp().shaders.map((shader, i) =>
      i === 0 ? { ...shader, contentFlags: CONTENTS.PLAYERCLIP } : shader
    );
    const map = await load(bspFile(cubeBsp({ shaders })), options('clip'));

    expect(fall(map).endpos.z - 24).toBeCloseTo(64.125, 4);
    const shot = map.trace(
      vec3(0, 0, 200),
      vec3(),
      vec3(),
      vec3(0, 0, 0),
      ENTITYNUM_NONE,
      MASK.SHOT
    );
    expect(shot.fraction).toBe(1);
    await map.destroy();
  });

  it("stops on collision's words for a map both loaders refuse, in cgame's order", async () => {
    // A node on a plane the map has not got, which `CM_LoadMap` refuses, and a fog lump the
    // renderer refuses.
    const file = buildBsp({
      [LUMP_NODES]: int32s(5, -1, -1, 0, 0, 0, 0, 0, 0),
      [LUMP_FOGS]: new Uint8Array(73)
    });
    // Read whole, as a preview reads it, the renderer's check comes first.
    expect(() => parseBsp(file, 'maps/both.bsp')).toThrow(
      'LoadMap: funny lump size in maps/both.bsp'
    );

    await expect(load(file, options('both'))).rejects.toThrow(
      "CM_LoadMap: maps/both.bsp's node 0's plane 5, which the map has not got"
    );
  });

  it('tells its caller the entity text before the renderer reads its lumps', async () => {
    const told: string[] = [];
    const file = buildBsp({
      [LUMP_ENTITIES]: entityLump('{ "classname" "worldspawn" }'),
      [LUMP_FOGS]: new Uint8Array(73)
    });

    await expect(
      load(file, options('fog', { collided: (entities) => told.push(entities) }))
    ).rejects.toThrow('LoadMap: funny lump size in maps/fog.bsp');
    expect(told).toEqual(['{ "classname" "worldspawn" }\0']);
  });

  it("reads collision's cvars from the store it is given, as each trace runs", async () => {
    const cvars = testCvars();
    const map = await load(bspFile(patchBsp()), options('patch', { cvars }));
    const point = () =>
      map.trace(vec3(16, 16, 50), vec3(), vec3(), vec3(16, 16, -50), ENTITYNUM_NONE, MASK.SOLID);

    expect(point().fraction).toBeLessThan(1);
    cvars.set('cm_playerCurveClip', '0');
    expect(point().fraction).toBe(1);
    await map.destroy();
  });

  it("prints collision's warnings where the world's go", async () => {
    // The patch's points as a bowtie, whose cells' triangles have no plane (`cm-load.test.ts`).
    const bowtie = [0, 0, 0, 32, 0, 0, 64, 0, 0, 0, 32, 0, 16, 16, 0, 32, 0, 0, 0, 64, 0, 0, 32, 0];
    const bsp = clipBsp();
    bsp.drawVerts.xyz = Float32Array.from([...bowtie, 0, 0, 0]);
    const lines: string[] = [];

    const map = await load(bspFile(bsp), options('bowtie', { warn: (line) => lines.push(line) }));

    expect(lines.filter((line) => line.includes('CM_GridPlane'))).toEqual(
      new Array(4).fill('WARNING: CM_GridPlane unresolvable\n')
    );
    await map.destroy();
  });

  it('keeps nothing of the file, which may then be moved to a server elsewhere', async () => {
    const file = bspFile(cubeBsp());
    const map = await load(file, options('cube'));

    // As a transfer to the worker moves it: the buffer is the other side's from here on.
    structuredClone(file.buffer, { transfer: [file.buffer] });

    expect(file.byteLength).toBe(0);
    expect(map.entities).toBe('{ "classname" "worldspawn" }\0');
    expect(fall(map).endpos.z - 24).toBeCloseTo(64.125, 4);
    await map.destroy();
  });

  it('takes its world out of the scene and frees it', async () => {
    const map = await load(bspFile(cubeBsp()), options('cube'));
    const { layer } = map.world;

    await map.destroy();

    expect(map.root.parent).toBeNull();
    expect(camera.camera!.layers).not.toContain(layer.id);
  });
});

describe('CollisionOverlay.destroy', () => {
  it('frees the entity, then the material it drew with, then the container', async () => {
    const containers: StandInResource[] = [];
    standIn(app, 'container', containers);
    const fs = await searchPathOf(mapFiles('room'));
    const before = counts();
    const overlay = await loadCollisionOverlay(app, fs, 'room', true);
    const render = overlay.entity.findComponents('render')[0] as RenderComponent;
    const material = render.meshInstances[0].material!;
    // The material goes after the instance drawing with it, or that instance draws in the
    // engine's default material instead.
    let entityGone = false;
    const freed = vi.spyOn(material, 'destroy').mockImplementation(() => {
      entityGone = overlay.entity.parent === null;
    });

    overlay.destroy();

    expect(freed).toHaveBeenCalledOnce();
    expect(entityGone).toBe(true);
    expect(containers[0].destroy).toHaveBeenCalledOnce();
    expect(counts()).toEqual(before);
  });
});

describe('loadCollisionOverlay', () => {
  it('names the mesh it could not find, which the app only warns of', async () => {
    const fs = await searchPathOf({ 'maps/room.sog': new Uint8Array(1) });
    await expect(loadCollisionOverlay(app, fs, 'room', false)).rejects.toThrow(
      'maps/room.collision.glb not found'
    );
  });
});
