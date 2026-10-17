import { describe, expect, it } from 'vitest';

import { testCvars } from '../net/net-test-fixtures';
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from '../net/protocol';
import {
  clipCvarsSync,
  createClipInlineModels,
  createClipPointContents,
  createClipTrace,
  entityContact,
  entityPointContents,
  setBrushModel,
  tempBoxPointContents,
  traceEntity,
  traceTempBox,
  type ClipEntity
} from './clip-trace';
import { cubeBsp, patchBsp, Seeded, triggerBsp } from './cm/collision-test-fixtures';
import { loadMap, tempBoxModel } from './cm/cm-load';
import { newTrace } from './cm/cm-local';
import { transformedBoxTrace } from './cm/cm-trace';
import { CONTENTS, MASK, SURF, SURFACE_CLIP_EPSILON } from './constants';
import { vec3, type Vec3 } from './vec3';

const f = Math.fround;

/** The flags of the small map's cube sides and its patch. */
const SIDES = SURF.SLICK | SURF.NOIMPACT;

/** A vector as collision takes one. */
function xyz(v: Vec3): [number, number, number] {
  return [v.x, v.y, v.z];
}

/** The collision tests' small map, its world the 128-unit cube about the origin. */
function cubeMap() {
  return loadMap(cubeBsp(), 'maps/test.bsp');
}

/** The same map, its world only the flat patch at z 0 over x and y from 0 to 64. */
function patchMap() {
  return loadMap(patchBsp(), 'maps/test.bsp');
}

const POINT = vec3();
const MINS = vec3(-15, -15, -24);
const MAXS = vec3(15, 15, 32);

describe('createClipTrace', () => {
  it("answers as SV_Trace does: the world on a hit, with the plane's normal", () => {
    const trace = createClipTrace(cubeMap());
    const hit = trace(vec3(0, 0, 100), POINT, POINT, vec3(0, 0, 0), ENTITYNUM_NONE, MASK.SOLID);
    expect(hit.fraction).toBe(f(35.875 / 100));
    expect(hit.endpos.z).toBeCloseTo(64.125, 5);
    expect(hit.normal).toEqual(vec3(0, 0, 1));
    expect(hit.contents).toBe(CONTENTS.SOLID);
    expect([hit.startsolid, hit.allsolid, hit.entityNum]).toEqual([false, false, ENTITYNUM_WORLD]);
  });

  it("names nothing on a miss, and keeps collision's zero normal there", () => {
    const trace = createClipTrace(cubeMap());
    const miss = trace(vec3(0, 0, 200), MINS, MAXS, vec3(0, 0, 100), ENTITYNUM_NONE, MASK.SOLID);
    expect(miss.fraction).toBe(1);
    expect(miss.endpos).toEqual(vec3(0, 0, 100));
    expect(miss.normal).toEqual(vec3(0, 0, 0));
    expect([miss.contents, miss.entityNum]).toEqual([0, ENTITYNUM_NONE]);
  });

  it("keeps collision's fraction for a start in solid that gets out, which names nothing", () => {
    const trace = createClipTrace(cubeMap());
    const out = trace(vec3(0, 0, 0), POINT, POINT, vec3(0, 0, 200), ENTITYNUM_NONE, MASK.SOLID);
    expect([out.startsolid, out.allsolid, out.fraction]).toEqual([true, false, 1]);
    expect(out.entityNum).toBe(ENTITYNUM_NONE);
    const stuck = trace(vec3(0, 0, 0), POINT, POINT, vec3(0, 0, 10), ENTITYNUM_NONE, MASK.SOLID);
    expect([stuck.startsolid, stuck.allsolid, stuck.fraction]).toEqual([true, true, 0]);
    expect(stuck.entityNum).toBe(ENTITYNUM_WORLD);
  });

  it("takes the sim's numbers as floats at collision's door, and a mask as given", () => {
    const trace = createClipTrace(cubeMap());
    const miss = trace(vec3(0.1, 0, 200), POINT, POINT, vec3(0.1, 0, 100), 0, MASK.SOLID);
    expect(miss.endpos.x).toBe(f(0.1));
    // The cube's brush is solid, which water's mask passes through.
    const through = trace(vec3(0, 0, 100), POINT, POINT, vec3(0, 0, 0), 0, MASK.WATER);
    expect(through.fraction).toBe(1);
  });

  it('makes a new result each trace, so a caller may keep one', () => {
    const trace = createClipTrace(cubeMap());
    const first = trace(vec3(0, 0, 100), POINT, POINT, vec3(0, 0, 0), 0, MASK.SOLID);
    const second = trace(vec3(0, 0, 200), POINT, POINT, vec3(0, 0, 100), 0, MASK.SOLID);
    expect(first.endpos).not.toBe(second.endpos);
    expect(first.fraction).toBe(f(35.875 / 100));
  });

  it('carries the surface flags of the side or the patch it stopped at, and none on a miss', () => {
    const cube = createClipTrace(cubeMap());
    const flags = (from: number, to: number) =>
      cube(vec3(0, 0, from), POINT, POINT, vec3(0, 0, to), 0, MASK.SOLID).surfaceFlags;
    expect(flags(100, 0)).toBe(SIDES);
    expect(flags(200, 100)).toBe(0);

    const patch = createClipTrace(patchMap());
    const down = patch(vec3(16, 16, 50), POINT, POINT, vec3(16, 16, -50), 0, MASK.SOLID);
    expect([down.fraction, down.surfaceFlags]).toEqual([f(49.875 / 100), SIDES]);

    const sides = cubeBsp().brushSides.map((side) => ({ ...side, shaderNum: 0 }));
    const plain = createClipTrace(loadMap(cubeBsp({ brushSides: sides }), 'maps/test.bsp'));
    const hit = plain(vec3(0, 0, 100), POINT, POINT, vec3(), 0, MASK.SOLID);
    expect([hit.fraction, hit.surfaceFlags]).toEqual([f(35.875 / 100), 0]);
  });
});

describe('createClipPointContents', () => {
  it("is what the world's brushes are made of at a point, a side's points inside", () => {
    const solid = createClipPointContents(cubeMap());
    expect(solid(vec3(0, 0, 0), ENTITYNUM_NONE)).toBe(CONTENTS.SOLID);
    expect(solid(vec3(64, 0, 64), ENTITYNUM_NONE)).toBe(CONTENTS.SOLID);
    expect(solid(vec3(0, 0, 64.25), ENTITYNUM_NONE)).toBe(0);

    // The world's leaf holding the water brush rather than the solid one.
    const pool = loadMap(cubeBsp({ leafBrushes: Int32Array.of(1) }), 'maps/test.bsp');
    expect(createClipPointContents(pool)(vec3(10, -20, 30), 0)).toBe(CONTENTS.WATER);
  });
});

describe('tempBoxPointContents', () => {
  const at = (point: Vec3) => tempBoxPointContents(point, MINS, MAXS, vec3(100, 0, 0));

  it("is a body inside an entity's box and on its faces", () => {
    expect(at(vec3(100, 0, 0))).toBe(CONTENTS.BODY);
    expect(at(vec3(115, -15, -24))).toBe(CONTENTS.BODY);
    expect(at(vec3(85, 15, 32))).toBe(CONTENTS.BODY);
  });

  it('is nothing past a face', () => {
    expect(at(vec3(115.125, 0, 0))).toBe(0);
    expect(at(vec3(100, -15.125, 0))).toBe(0);
    expect(at(vec3(100, 0, -24.125))).toBe(0);
    expect(at(vec3(100, 0, 32.125))).toBe(0);
    expect(at(vec3(0, 0, 0))).toBe(0);
  });
});

describe('traceTempBox', () => {
  /** A standing player at `origin`, in the way of a sweep from `start` to `end`. */
  function sweep(start: Vec3, end: Vec3, origin: Vec3, box = { mins: MINS, maxs: MAXS }) {
    return traceTempBox(start, box.mins, box.maxs, end, MINS, MAXS, origin, MASK.SHOT);
  }
  const point = { mins: POINT, maxs: POINT };

  it('stops a point an epsilon short of the face it goes in by, in floats', () => {
    const result = sweep(vec3(-100, 0, 0), vec3(100, 0, 0), vec3(), point);

    // The −x face is 85 from the start, over a 200 unit sweep.
    expect(result.fraction).toBe(f((85 - SURFACE_CLIP_EPSILON) / 200));
    expect(result.endpos).toEqual(vec3(-15 - SURFACE_CLIP_EPSILON, 0, 0));
    expect(result.normal).toEqual(vec3(-1, 0, 0));
    expect([result.contents, result.surfaceFlags]).toEqual([CONTENTS.BODY, 0]);
    expect(result.startsolid).toBe(false);
    // Which entity it was is the caller's to say.
    expect(result.entityNum).toBe(ENTITYNUM_NONE);
  });

  it('pushes the faces out by the moving box, so two players stop an epsilon apart', () => {
    const result = sweep(vec3(0, 0, 0), vec3(200, 0, 0), vec3(100, 0, 0));

    expect(result.endpos.x + MAXS.x).toBeCloseTo(100 + MINS.x - SURFACE_CLIP_EPSILON, 5);
  });

  it('measures height about the moving box, whose feet are further below it than its head', () => {
    // Coming down on a player's head: the feet are 24 below the origin, the head 32 above.
    const result = sweep(vec3(0, 0, 200), vec3(0, 0, 0), vec3());

    expect(result.endpos.z).toBeCloseTo(MAXS.z - MINS.z + SURFACE_CLIP_EPSILON, 5);
    expect(result.normal).toEqual(vec3(0, 0, 1));
  });

  it('misses a box it passes a unit to the side of', () => {
    const result = sweep(vec3(-100, 31, 0), vec3(100, 31, 0), vec3());

    expect(result.fraction).toBe(1);
    expect(result.contents).toBe(0);
  });

  it('lets a sweep that starts inside and gets out go, saying only that it started solid', () => {
    const result = sweep(vec3(0, 0, 0), vec3(100, 0, 0), vec3());

    expect(result).toMatchObject({ startsolid: true, allsolid: false, fraction: 1 });
  });

  it("holds one that never gets out, allsolid at no distance, with collision's zero normal", () => {
    const result = sweep(vec3(0, 0, 0), vec3(4, 0, 0), vec3());

    expect(result).toMatchObject({ startsolid: true, allsolid: true, fraction: 0 });
    expect(result.contents).toBe(CONTENTS.BODY);
    expect(result.endpos).toEqual(vec3());
    expect(result.normal).toEqual(vec3());
  });

  it('counts a box that does not move as inside when it only touches', () => {
    const touching = vec3(30, 0, 0);
    const apart = vec3(30.001, 0, 0);

    expect(sweep(touching, touching, vec3()).allsolid).toBe(true);
    expect(sweep(apart, apart, vec3()).allsolid).toBe(false);
  });

  it('goes through a box whose contents the mask does not name, which is CONTENTS_BODY', () => {
    const [from, to] = [vec3(-100, 0, 0), vec3(100, 0, 0)];
    const through = traceTempBox(from, MINS, MAXS, to, MINS, MAXS, POINT, CONTENTS.CORPSE);
    const inside = traceTempBox(POINT, MINS, MAXS, POINT, MINS, MAXS, POINT, CONTENTS.SOLID);

    expect(through.fraction).toBe(1);
    expect(inside.allsolid).toBe(false);
  });

  it('is stopped by the x face of an edge it meets square on, the first in the brush', () => {
    // Both faces are crossed at the same moment, and a later face takes over only from a
    // strictly later one.
    const result = sweep(vec3(-100, -100, 0), vec3(100, 100, 0), vec3(), point);

    expect(result.normal).toEqual(vec3(-1, 0, 0));
  });

  it("answers as a map's own temp box does, the box reading nothing of the map", () => {
    const cm = cubeMap();
    const results = newTrace();
    const random = new Seeded(7);
    // Coordinates within 80 units, and a box up to 20 about its origin across.
    const at = () => vec3(...random.vec(80 * 256));
    const half = () => random.vec(20 * 256).map(Math.abs);
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      // Through the box's origin and as far again, so that most sweeps meet it.
      const [start, origin] = [at(), at()];
      const end = vec3(2 * origin.x - start.x, 2 * origin.y - start.y, 2 * origin.z - start.z);
      const [low, high] = [half(), half()];
      const box = { mins: vec3(-low[0], -low[1], -low[2]), maxs: vec3(high[0], high[1], high[2]) };
      const { mins, maxs } = i % 2 ? point : { mins: MINS, maxs: MAXS };
      const ours = traceTempBox(start, mins, maxs, end, box.mins, box.maxs, origin, ~0);

      const handle = tempBoxModel(cm, xyz(box.mins), xyz(box.maxs));
      const ends = [xyz(start), xyz(end), xyz(mins), xyz(maxs)] as const;
      transformedBoxTrace(cm, results, ...ends, handle, ~0, xyz(origin), [0, 0, 0]);
      expect(ours).toEqual({
        allsolid: results.allsolid,
        startsolid: results.startsolid,
        fraction: results.fraction,
        endpos: vec3(...results.endpos),
        normal: vec3(...results.plane.normal),
        contents: results.contents,
        surfaceFlags: 0,
        entityNum: ENTITYNUM_NONE
      });
      if (results.fraction < 1) hits++;
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('moves its one box at each call, so each sweep meets the box it names', () => {
    const [start, end] = [vec3(-100, 0, 0), vec3(100, 0, 0)];
    const across = (x: number) =>
      traceTempBox(start, POINT, POINT, end, vec3(-x, -8, -8), vec3(x, 8, 8), POINT, MASK.SHOT);

    expect(across(50).endpos.x).toBe(-50.125);
    expect(across(5).endpos.x).toBe(-5.125);
    expect(across(50).endpos.x).toBe(-50.125);
  });
});

describe("the clip map's cvars", () => {
  const down = [vec3(16, 16, 50), vec3(16, 16, -50)] as const;

  it('are read from the store at each trace, as collision reads them at each use', () => {
    const cvars = testCvars();
    const trace = createClipTrace(patchMap(), cvars);
    const point = () => trace(down[0], POINT, POINT, down[1], 0, MASK.SOLID).fraction;
    const box = () => trace(down[0], MINS, MAXS, down[1], 0, MASK.SOLID).fraction;

    // A store that has never been given them reads them as `CM_LoadMap` registers them.
    expect(point()).toBe(f(49.875 / 100));
    cvars.set('cm_playerCurveClip', '0');
    expect(point()).toBe(1);
    expect(box()).toBeLessThan(1);
    cvars.set('cm_playerCurveClip', '1');
    cvars.set('cm_noCurves', '1');
    expect([point(), box()]).toEqual([1, 1]);
    cvars.set('cm_noCurves', '0');
    expect(point()).toBe(f(49.875 / 100));
  });

  it("are read by each one's integer, and only once the store's changes have moved", () => {
    const cm = patchMap();
    const cvars = testCvars({ cm_noAreas: '2x', cm_noCurves: 'yes', cm_playerCurveClip: '-1' });
    const sync = clipCvarsSync(cm, cvars);
    sync();
    expect(cm.cvars).toEqual({ noAreas: 2, noCurves: 0, playerCurveClip: -1 });
    cm.cvars.noAreas = 7;
    sync();
    expect(cm.cvars.noAreas).toBe(7);
    cvars.set('cm_noCurves', '1');
    sync();
    expect(cm.cvars).toEqual({ noAreas: 2, noCurves: 1, playerCurveClip: -1 });
  });
});

/** The trigger map: an empty world, and inline model 1 a solid brush with one corner cut off. */
function triggerMap() {
  return loadMap(triggerBsp(), 'maps/test.bsp');
}

/** An entity as the server's clips read one: unlinked, a point at the origin. */
function clipEntity(): ClipEntity & { r: { contents: number } } {
  return {
    s: { modelindex: 0 },
    r: {
      bmodel: false,
      mins: vec3(),
      maxs: vec3(),
      currentOrigin: vec3(),
      currentAngles: vec3(),
      contents: 0
    }
  };
}

/** The trigger map's brush as an entity, `*1`. */
function triggerEntity(cm = triggerMap()) {
  const entity = clipEntity();
  setBrushModel(cm, entity, '*1', () => {});
  return entity;
}

/** A standing player's box in the world, at `origin`. */
function playerBox(origin: Vec3): [Vec3, Vec3] {
  return [
    vec3(origin.x + MINS.x, origin.y + MINS.y, origin.z + MINS.z),
    vec3(origin.x + MAXS.x, origin.y + MAXS.y, origin.z + MAXS.z)
  ];
}

describe('setBrushModel', () => {
  it("makes an entity the inline model it names, with cm's bounds, every content, linked", () => {
    const entity = clipEntity();
    const linked: unknown[] = [];
    setBrushModel(triggerMap(), entity, '*1', (it) => linked.push(it));

    expect(entity.s.modelindex).toBe(1);
    // `CM_ModelBounds` hands back the BSP's bounds a unit bigger each way.
    expect(entity.r.mins).toEqual(vec3(-1, -1, -1));
    expect(entity.r.maxs).toEqual(vec3(65, 65, 17));
    expect(entity.r.bmodel).toBe(true);
    expect(entity.r.contents).toBe(-1);
    expect(linked).toEqual([entity]);
  });

  it("refuses no name, a name that is not a brush model's, and a model the map has not got", () => {
    const cm = triggerMap();
    const set = (name: string | null) => () => setBrushModel(cm, clipEntity(), name, () => {});
    expect(set(null)).toThrow('SV_SetBrushModel: NULL');
    expect(set('models/mapobjects/pad.md3')).toThrow(
      "SV_SetBrushModel: models/mapobjects/pad.md3 isn't a brush model"
    );
    expect(set('*2')).toThrow('CM_InlineModel: bad number');
  });

  it('finds no model at all on a map with no clip map, as a splat map has none', () => {
    expect(() => setBrushModel(undefined, clipEntity(), '*1', () => {})).toThrow(
      'CM_InlineModel: bad number'
    );
  });
});

describe('entityContact', () => {
  it("touches a brush by its own sides, not where its bounds reach into the cut corner", () => {
    const cm = triggerMap();
    const pad = triggerEntity(cm);
    // Both boxes reach into the model's bounds, x and y −1 to 65.
    expect(entityContact(cm, pad, ...playerBox(vec3(50, 50, 20)))).toBe(true);
    expect(entityContact(cm, pad, ...playerBox(vec3(75, 75, 20)))).toBe(false);
  });

  it('touches a brush along its square sides, past the cut', () => {
    const cm = triggerMap();
    const pad = triggerEntity(cm);
    expect(entityContact(cm, pad, ...playerBox(vec3(70, 20, 20)))).toBe(true);
    expect(entityContact(cm, pad, ...playerBox(vec3(80, 20, 20)))).toBe(false);
  });

  it('counts a box that only meets a box entity at a face, and not one an eighth away', () => {
    const entity = clipEntity();
    entity.r.mins = vec3(-32, -32, -16);
    entity.r.maxs = vec3(32, 32, 16);
    entity.r.currentOrigin = vec3(100, 0, 0);
    expect(entityContact(undefined, entity, ...playerBox(vec3(147, 0, 0)))).toBe(true);
    expect(entityContact(undefined, entity, ...playerBox(vec3(147.125, 0, 0)))).toBe(false);
  });
});

describe('entityPointContents', () => {
  it("is what a brush model's brushes are made of, a trigger's solid, nothing in the cut", () => {
    const cm = triggerMap();
    const pad = triggerEntity(cm);
    expect(entityPointContents(cm, pad, vec3(10, 10, 8))).toBe(CONTENTS.SOLID);
    expect(entityPointContents(cm, pad, vec3(60, 60, 8))).toBe(0);
  });

  it('is a body inside a box entity, whatever it is made of', () => {
    const entity = clipEntity();
    entity.r.mins = MINS;
    entity.r.maxs = MAXS;
    entity.r.contents = CONTENTS.TRIGGER;
    expect(entityPointContents(undefined, entity, vec3(0, 0, 0))).toBe(CONTENTS.BODY);
  });
});

describe('traceEntity', () => {
  it("stops a sweep at a brush model's side, an epsilon short, and not one the mask passes", () => {
    const cm = triggerMap();
    const pad = triggerEntity(cm);
    const sweep = (mask: number) =>
      traceEntity(cm, pad, vec3(100, 10, 8), POINT, POINT, vec3(-100, 10, 8), mask);
    const hit = sweep(MASK.SOLID);
    expect(hit.fraction).toBe(f(f(36 - SURFACE_CLIP_EPSILON) / 200));
    expect(hit.normal).toEqual(vec3(1, 0, 0));
    expect(hit.entityNum).toBe(ENTITYNUM_NONE);
    expect(sweep(CONTENTS.WATER).fraction).toBe(1);
  });

  it('sweeps a box entity as the temp box, as traceTempBox does', () => {
    const entity = clipEntity();
    entity.r.mins = MINS;
    entity.r.maxs = MAXS;
    entity.r.currentOrigin = vec3(100, 0, 0);
    const start = vec3(0, 0, 0);
    const end = vec3(200, 0, 0);
    expect(traceEntity(undefined, entity, start, MINS, MAXS, end, MASK.SOLID)).toEqual(
      traceTempBox(start, MINS, MAXS, end, MINS, MAXS, vec3(100, 0, 0), MASK.SOLID)
    );
  });
});

describe("a brush model's clips, turned and of other contents", () => {
  /** The trigger brush turned half round about its origin: x and y from −64 to 0. */
  function turned() {
    const cm = triggerMap();
    const pad = triggerEntity(cm);
    pad.r.currentAngles = vec3(0, 180, 0);
    return { cm, pad };
  }

  /** The trigger map with its brush made of player clip, as `q3dm11`'s teleporters are. */
  function clipBrushMap() {
    const shader = {
      shader: 'textures/common/clip',
      surfaceFlags: 0,
      contentFlags: CONTENTS.PLAYERCLIP
    };
    return loadMap(triggerBsp({ shaders: [shader] }), 'maps/test.bsp');
  }

  it('is turned by the entity\'s angles for a sweep, a point and a contact', () => {
    const { cm, pad } = turned();
    const sweep = traceEntity(cm, pad, vec3(-100, -10, 8), POINT, POINT, vec3(100, -10, 8), -1);
    expect(sweep.fraction).toBeCloseTo((36 - SURFACE_CLIP_EPSILON) / 200, 5);
    expect(entityPointContents(cm, pad, vec3(-10, -10, 8))).toBe(CONTENTS.SOLID);
    expect(entityContact(cm, pad, ...playerBox(vec3(-50, -50, 20)))).toBe(true);
  });

  it('touches every content, so a brush of player clip is touched as a solid one is', () => {
    const cm = clipBrushMap();
    const pad = triggerEntity(cm);
    expect(entityContact(cm, pad, ...playerBox(vec3(50, 50, 20)))).toBe(true);
    expect(entityPointContents(cm, pad, vec3(10, 10, 8))).toBe(CONTENTS.PLAYERCLIP);
    expect(createClipInlineModels(cm).contact(1, vec3(50, 50, 20), MINS, MAXS)).toBe(true);
  });
});

describe('createClipInlineModels', () => {
  it("is cgame's view of the inline models, refusing one the map has not got", () => {
    const models = createClipInlineModels(triggerMap());
    expect(models.inlineModel(0)).toBe(0);
    expect(models.inlineModel(1)).toBe(1);
    expect(() => models.inlineModel(2)).toThrow('CM_InlineModel: bad number');
  });

  it('tests a box on a model where it stands, by its sides', () => {
    const models = createClipInlineModels(triggerMap());
    expect(models.contact(1, vec3(50, 50, 20), MINS, MAXS)).toBe(true);
    expect(models.contact(1, vec3(75, 75, 20), MINS, MAXS)).toBe(false);
  });
});
