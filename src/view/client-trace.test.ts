import { describe, expect, it } from 'vitest';

import {
  createEntityState,
  createTrajectory,
  ENTITYNUM_WORLD,
  TR,
  type EntityState
} from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import {
  createClipInlineModels,
  createClipPointContents,
  createClipTrace
} from '../sim/clip-trace';
import { boxesBsp, Seeded } from '../sim/cm/collision-test-fixtures';
import { loadMap } from '../sim/cm/cm-load';
import { CONTENTS, MASK, SURFACE_CLIP_EPSILON } from '../sim/constants';
import { packSolid, SOLID_BMODEL } from '../sim/entity-solid';
import { ET } from '../sim/game-entity';
import { NO_CONTENTS, NO_INLINE_MODELS, playerBounds, type TraceFn } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import {
  buildSolidList,
  clientPointContents,
  clientTrace,
  type ClientWorld,
  type SolidEntity
} from './client-trace';

/** A standing player's box, as linking packs it. */
const STANDING = (() => {
  const { mins, maxs } = playerBounds(false);
  return packSolid({ bmodel: false, contents: CONTENTS.BODY, mins, maxs });
})();

/** A crouching player's. */
const CROUCHED = (() => {
  const { mins, maxs } = playerBounds(true);
  return packSolid({ bmodel: false, contents: CONTENTS.BODY, mins, maxs });
})();

/** A standing player, entity `number`, at `origin`. */
function player(number: number, origin: Vec3, solid = STANDING): SolidEntity {
  return { number, solid, modelindex: 0, pos: createTrajectory(), origin, angles: vec3() };
}

const POINT = vec3();

/** An open world with a wall across +x whose near face is at x = 300. */
const WALL = createFlatWorldTrace([box(300, -512, 0, 316, 512, 512)]);

/** A client's world of a map's trace alone, as a splat map's is. */
function mapAlone(trace: TraceFn = WALL): ClientWorld {
  return { trace, pointContents: NO_CONTENTS, inlineModels: NO_INLINE_MODELS, physicsTime: 0 };
}

/** A point traced along +x at eye height, out to 400. */
function shot(solids: SolidEntity[], skip = -1, mask: number = MASK.SHOT, world = mapAlone()) {
  return clientTrace(world, solids)(vec3(0, 0, 50), POINT, POINT, vec3(400, 0, 50), skip, mask);
}

describe('buildSolidList', () => {
  /** An entity of a type, with a box or without. */
  function entity(number: number, eType: number, solid: number): EntityState {
    return Object.assign(createEntityState(), { number, eType, solid });
  }

  /** A snapshot's entities by number. */
  function slots(entities: EntityState[]) {
    return { byNumber: new Map(entities.map((state) => [state.number, state])) };
  }

  /** The two lists built from `entities`, with the current and next snapshots given. */
  function lists(
    entities: EntityState[],
    current = slots(entities),
    next: ReturnType<typeof slots> | null = null
  ) {
    const triggers: number[] = [99];
    const solids: number[] = [99];
    buildSolidList(entities, current, next, triggers, solids);
    return { triggers, solids };
  }

  it('lists a box and a brush model as solid, and an item, pad or teleporter as touched', () => {
    const entities = [
      entity(1, ET.PLAYER, STANDING),
      entity(2, ET.PLAYER, 0),
      entity(3, ET.MISSILE, 0),
      entity(4, ET.ITEM, STANDING),
      entity(5, ET.PUSH_TRIGGER, SOLID_BMODEL),
      entity(6, ET.TELEPORT_TRIGGER, SOLID_BMODEL),
      entity(7, ET.MOVER, SOLID_BMODEL),
      // A door's trigger: sent, with nothing packed.
      entity(8, ET.GENERAL, 0)
    ];
    expect(lists(entities)).toEqual({ triggers: [4, 5, 6], solids: [1, 7] });
  });

  it("touches by the current state's type, and stops by the next state's box", () => {
    const next = [entity(3, ET.GENERAL, STANDING), entity(4, ET.PLAYER, STANDING)];
    const current = slots([entity(3, ET.ITEM, 0), entity(4, ET.PLAYER, 0)]);
    expect(lists(next, current, slots(next))).toEqual({ triggers: [3], solids: [4] });
  });

  it('judges a number the current snapshot has not got by the state it is listed with', () => {
    const next = [entity(5, ET.ITEM, 0), entity(6, ET.MOVER, SOLID_BMODEL)];
    expect(lists(next, slots([]), slots(next))).toEqual({ triggers: [5], solids: [6] });
  });

  it("built from the current snapshot, reads the next's box where the next has the number", () => {
    // A teleport keeps the list on the current snapshot: one in both is solid as the next has
    // it, and one the next has not got as it is now.
    const current = [entity(1, ET.PLAYER, 0), entity(2, ET.PLAYER, STANDING)];
    const next = slots([entity(1, ET.PLAYER, STANDING), entity(2, ET.PLAYER, 0)]);
    expect(lists(current, slots(current), next)).toEqual({ triggers: [], solids: [1] });
    expect(lists(current, slots(current), slots([]))).toEqual({ triggers: [], solids: [2] });
  });
});

describe('clientTrace', () => {
  it('stops at a player in the way, an epsilon short of their box, and names them', () => {
    const trace = shot([player(1, vec3(100, 0, 24))]);
    expect(trace.fraction).toBeLessThan(1);
    expect(trace.endpos.x).toBeCloseTo(100 - 15 - SURFACE_CLIP_EPSILON, 6);
    expect(trace.entityNum).toBe(1);
    expect(trace.contents).toBe(CONTENTS.BODY);
    expect(trace.normal).toEqual(vec3(-1, 0, 0));
  });

  it('stops at the nearest of the world and everyone', () => {
    // The wall first, then someone behind it, then someone in front of both.
    expect(shot([player(1, vec3(350, 0, 24))]).entityNum).toBe(ENTITYNUM_WORLD);
    const nearest = shot([player(1, vec3(250, 0, 24)), player(2, vec3(150, 0, 24))]);
    expect(nearest.entityNum).toBe(2);
  });

  it('puts the box where it is given, which is where the player is drawn', () => {
    expect(shot([player(1, vec3(123.5, 0, 24))]).endpos.x).toBeCloseTo(
      123.5 - 15 - SURFACE_CLIP_EPSILON,
      6
    );
  });

  it('passes the one it skips, and nobody else for them', () => {
    // No owner and no owner's owner, as the server's trace has: the number alone.
    const trace = shot([player(1, vec3(100, 0, 24)), player(2, vec3(200, 0, 24))], 1);
    expect(trace.entityNum).toBe(2);
  });

  it('goes through everyone for a mask without the body in it', () => {
    // The third-person camera's and a gib's: `CM_TempBoxModel` is `CONTENTS_BODY`.
    const trace = shot([player(1, vec3(100, 0, 24))], -1, MASK.SOLID);
    expect(trace.entityNum).toBe(ENTITYNUM_WORLD);
    expect(trace.endpos.x).toBeCloseTo(300, 0);
  });

  it("goes over a crouching player's lower box", () => {
    // Eye height is 50 over a floor at 0; a crouching box stops at 24 + 16.
    const trace = shot([player(1, vec3(100, 0, 24), CROUCHED)]);
    expect(trace.entityNum).toBe(ENTITYNUM_WORLD);
  });

  it('is not stopped by a player it starts in and gets out of, and says so', () => {
    const trace = shot([player(1, vec3(0, 0, 24))]);
    expect(trace.startsolid).toBe(true);
    expect(trace.allsolid).toBe(false);
    expect(trace.entityNum).toBe(ENTITYNUM_WORLD);
  });

  it('forgets a start inside one when another stops it sooner', () => {
    // `CG_ClipMoveToEntities` takes the nearer trace whole, where the server's keeps the start.
    const trace = shot([player(1, vec3(0, 0, 24)), player(2, vec3(100, 0, 24))]);
    expect(trace.entityNum).toBe(2);
    expect(trace.startsolid).toBe(false);
  });

  it('ends at a box that holds the whole sweep, and looks no further', () => {
    const solids = [player(1, vec3(0, 0, 24)), player(2, vec3(0, 0, 24))];
    const trace = clientTrace(mapAlone(), solids)(
      vec3(0, 0, 30),
      POINT,
      POINT,
      vec3(4, 0, 30),
      -1,
      MASK.SHOT
    );
    expect(trace.allsolid).toBe(true);
    expect(trace.fraction).toBe(0);
    expect(trace.entityNum).toBe(1);
  });

  it('takes a box that holds the whole sweep over a stop where the sweep began', () => {
    // The sweep starts a sixteenth short of the first box's face, inside the clip epsilon, so
    // that box stops it at 0 without starting inside. The second holds all of it.
    const solids = [player(1, vec3(100, 0, 24)), player(2, vec3(80, 0, 24))];
    const trace = clientTrace(mapAlone(), solids)(
      vec3(85 - 1 / 16, 0, 50),
      POINT,
      POINT,
      vec3(90, 0, 50),
      -1,
      MASK.SHOT
    );
    expect(trace.allsolid).toBe(true);
    expect(trace.entityNum).toBe(2);
  });

  it('is the world alone with nobody in it', () => {
    const trace = shot([]);
    expect(trace).toEqual(WALL(vec3(0, 0, 50), POINT, POINT, vec3(400, 0, 50), -1, MASK.SHOT));
  });

  it("refuses a brush model on a map with none, in CM_InlineModel's words", () => {
    expect(() => shot([brush(7, 1, vec3(100, 0, 0))])).toThrow('CM_InlineModel: bad number');
  });
});

/**
 * A map with a floor at z 0 and two inline models: `*1` a pillar 32 wide and 64 high on its base,
 * and `*2` a plank 128 long in x, 16 wide and 64 high.
 */
const cm = loadMap(
  boxesBsp([
    [
      [-16, -16, 0],
      [16, 16, 64]
    ],
    [
      [-64, -8, 0],
      [64, 8, 64]
    ]
  ]),
  'maps/test.bsp'
);

/** The map's client world, its brush models placed at `physicsTime`. */
function mapWorld(physicsTime = 0): ClientWorld {
  return {
    trace: createClipTrace(cm),
    pointContents: createClipPointContents(cm),
    inlineModels: createClipInlineModels(cm),
    physicsTime
  };
}

/**
 * A brush model sent as entity `number`, standing still at `at`, drawn at `origin` and turned by
 * `angles`.
 */
function brush(
  number: number,
  modelindex: number,
  at: Vec3,
  origin = at,
  angles = vec3()
): SolidEntity {
  const pos = createTrajectory();
  pos.trBase = vec3(at.x, at.y, at.z);
  return { number, solid: SOLID_BMODEL, modelindex, pos, origin, angles };
}

describe("clientTrace's brush models", () => {
  it('stops at a brush model by its own brushes, and names it', () => {
    const trace = shot([brush(40, 1, vec3(100, 0, 0))], -1, MASK.SHOT, mapWorld());
    expect(trace.entityNum).toBe(40);
    expect(trace.endpos.x).toBeCloseTo(100 - 16 - SURFACE_CLIP_EPSILON, 4);
    expect(trace.contents).toBe(CONTENTS.SOLID);
    expect(trace.normal).toEqual(vec3(-1, 0, 0));
  });

  it("stands one where its trajectory has it at cg.physicsTime, not where it's drawn", () => {
    const sliding = brush(40, 1, vec3(100, 0, 0), vec3(250, 0, 0));
    sliding.pos.trType = TR.LINEAR;
    sliding.pos.trDelta = vec3(100, 0, 0);
    // At 500 ms its trajectory has it at x 150.
    const trace = shot([sliding], -1, MASK.SHOT, mapWorld(500));
    expect(trace.endpos.x).toBeCloseTo(150 - 16 - SURFACE_CLIP_EPSILON, 4);
  });

  it('reads cg.physicsTime as each trace is made', () => {
    const sliding = brush(40, 1, vec3(100, 0, 0));
    sliding.pos.trType = TR.LINEAR;
    sliding.pos.trDelta = vec3(100, 0, 0);
    const world = { ...mapWorld(), physicsTime: 0 };
    const trace = clientTrace(world, [sliding]);
    const at = () => trace(vec3(0, 0, 50), POINT, POINT, vec3(400, 0, 50), -1, MASK.SHOT).endpos.x;
    expect(at()).toBeCloseTo(84 - SURFACE_CLIP_EPSILON, 4);
    world.physicsTime = 1000;
    expect(at()).toBeCloseTo(184 - SURFACE_CLIP_EPSILON, 4);
  });

  it("stands one where cgame's floats have it at cg.physicsTime, which doubles miss", () => {
    // q3dm19's *1's bob, on the pillar: at 605 s the floats put its top at 537.774, and doubles
    // at 537.762.
    const bobbing = brush(40, 1, vec3());
    Object.assign(bobbing.pos, {
      trType: TR.SINE,
      trTime: 4000,
      trDuration: 8000,
      trDelta: vec3(0, 0, 670)
    });
    const down = clientTrace(mapWorld(605000), [bobbing]);
    const trace = down(vec3(0, 0, 1000), POINT, POINT, vec3(0, 0, 100), -1, MASK.SHOT);
    expect(trace.endpos.z).toBeCloseTo(473.773987 + 64 + SURFACE_CLIP_EPSILON, 4);
  });

  it('turns one by the angles it is drawn at', () => {
    // The plank turned a quarter about z lies across the shot, 8 deep where it is 64 unturned.
    const unturned = brush(41, 2, vec3(200, 0, 0));
    expect(shot([unturned], -1, MASK.SHOT, mapWorld()).endpos.x).toBeCloseTo(136 - 0.125, 3);
    const turned = brush(41, 2, vec3(200, 0, 0), vec3(200, 0, 0), vec3(0, 90, 0));
    expect(shot([turned], -1, MASK.SHOT, mapWorld()).endpos.x).toBeCloseTo(192 - 0.125, 3);
  });

  it('passes the one it skips, and a mask its brushes are not in', () => {
    const solids = [brush(40, 1, vec3(100, 0, 0))];
    expect(shot(solids, 40, MASK.SHOT, mapWorld()).fraction).toBe(1);
    expect(shot(solids, -1, CONTENTS.WATER, mapWorld()).fraction).toBe(1);
  });

  it('stops at the nearer of a box and a brush model', () => {
    const solids = [brush(40, 1, vec3(200, 0, 0)), player(1, vec3(100, 0, 24))];
    expect(shot(solids, -1, MASK.SHOT, mapWorld()).entityNum).toBe(1);
    expect(shot(solids, 1, MASK.SHOT, mapWorld()).entityNum).toBe(40);
  });
});

describe("the brush models out of a sweep's reach", () => {
  /** Seeded sweeps and points about the plank, `*2`, standing at (100, 0, 0) turned or not. */
  function corpus(seed: number, count: number) {
    const random = new Seeded(seed);
    const pick = (n: number) => (random.next() >>> 8) % n;
    const near = (spread: number) => {
      const x = 100 + random.coord(spread);
      const y = random.coord(spread);
      return vec3(x, y, 32 + random.coord(spread));
    };
    const cases = [];
    for (let n = 0; n < count; n++) {
      const kind = pick(3);
      const angles =
        kind === 0
          ? vec3()
          : kind === 1
            ? vec3(0, random.coord(46080), 0)
            : vec3(random.coord(23040), random.coord(46080), random.coord(46080));
      const half = pick(2) === 0 ? vec3() : vec3(15, 15, 24 + pick(9));
      const mins = vec3(-half.x, -half.y, -half.z);
      const maxs = vec3(half.x, half.y, 8 + pick(25));
      // Sweeps from anywhere about the plank, and short ones that end at or near its faces.
      const start = near(pick(2) === 0 ? 51200 : 12800);
      const end = pick(2) === 0 ? near(51200) : vec3(start.x + random.coord(512), start.y, start.z);
      cases.push({ angles, mins, maxs, start, end });
    }
    return cases;
  }

  it("answers every sweep as tracing every model would, turned or not", () => {
    const world = mapWorld();
    const models = world.inlineModels;
    let met = 0;
    for (const { angles, mins, maxs, start, end } of corpus(5, 4000)) {
      const plank = brush(41, 2, vec3(100, 0, 0), vec3(100, 0, 0), angles);
      const got = clientTrace(world, [plank])(start, mins, maxs, end, -1, MASK.SHOT);
      // `CG_ClipMoveToEntities` asking the plank whatever its reach.
      const map = world.trace(start, mins, maxs, end, -1, MASK.SHOT);
      const at = vec3(100, 0, 0);
      const model = models.transformedBoxTrace(2, start, mins, maxs, end, MASK.SHOT, at, angles);
      if (model.fraction < 1 || model.startsolid) met++;
      const want =
        model.allsolid || model.fraction < map.fraction
          ? { ...model, entityNum: 41 }
          : { ...map, startsolid: map.startsolid || model.startsolid };
      expect(got).toEqual(want);
    }
    // Enough of them meet the plank for the rest to be near misses.
    expect(met).toBeGreaterThan(800);
  });

  it("meets a turned model with a box whose turn swings a corner past the box's reach", () => {
    // Found by search: the swept box, turned in the model's frame, pokes past its unturned bounds,
    // and further than half its turned radius, into the plank and the pillar.
    const cases = [
      {
        model: 2,
        angles: vec3(58.913, -120.467, 14.532),
        at: vec3(89.648, -12.605, 111.619),
        half: vec3(36, 36, 8),
        top: 5
      },
      {
        model: 1,
        angles: vec3(75.791, -160.947, -142.402),
        at: vec3(201.801, -9.543, 0.424),
        half: vec3(19, 19, 42),
        top: 41
      }
    ];
    const world = mapWorld();
    for (const { model, angles, at, half, top } of cases) {
      const mins = vec3(-half.x, -half.y, -half.z);
      const maxs = vec3(half.x, half.y, top);
      const origin = vec3(100, 0, 0);
      const direct = world.inlineModels.transformedBoxTrace(
        model,
        at,
        mins,
        maxs,
        at,
        MASK.SHOT,
        origin,
        angles
      );
      expect(direct.startsolid).toBe(true);
      const solid = brush(41, model, origin, origin, angles);
      const got = clientTrace(world, [solid])(at, mins, maxs, at, -1, MASK.SHOT);
      expect(got).toEqual({ ...direct, entityNum: 41 });
    }
  });

  it('answers every point as asking every model would', () => {
    const world = mapWorld();
    const models = world.inlineModels;
    for (const { angles, start } of corpus(9, 4000)) {
      const plank = brush(41, 2, vec3(100, 0, 0), vec3(100, 0, 0), angles);
      const got = clientPointContents(world, [plank])(start, -1);
      const at = vec3(100, 0, 0);
      const want =
        world.pointContents(start, -1) | models.transformedPointContents(start, 2, at, angles);
      expect(got).toBe(want);
    }
  });
});

describe('clientPointContents', () => {
  const INSIDE = vec3(100, 0, 16);

  it("is the map's alone with nothing sent", () => {
    const contents = clientPointContents(mapWorld(), []);
    expect(contents(INSIDE, -1)).toBe(0);
    expect(contents(vec3(0, 0, -8), -1)).toBe(CONTENTS.SOLID);
  });

  it("adds a brush model's brushes where it is drawn, not where its trajectory stands it", () => {
    const drawn = brush(40, 1, vec3(500, 0, 0), vec3(100, 0, 0));
    const contents = clientPointContents(mapWorld(), [drawn]);
    expect(contents(INSIDE, -1)).toBe(CONTENTS.SOLID);
    expect(contents(vec3(500, 0, 16), -1)).toBe(0);
  });

  it('turns it by the angles it is drawn at', () => {
    const across = vec3(200, 40, 16);
    const contents = (angles: Vec3) =>
      clientPointContents(mapWorld(), [brush(41, 2, vec3(200, 0, 0), vec3(200, 0, 0), angles)]);
    expect(contents(vec3())(across, -1)).toBe(0);
    expect(contents(vec3(0, 90, 0))(across, -1)).toBe(CONTENTS.SOLID);
  });

  it('passes the one it is asked to, and anybody who is a box', () => {
    const solids = [brush(40, 1, vec3(100, 0, 0)), player(1, vec3(300, 0, 24))];
    const contents = clientPointContents(mapWorld(), solids);
    expect(contents(INSIDE, 40)).toBe(0);
    expect(contents(vec3(300, 0, 24), -1)).toBe(0);
  });

  it('passes over a brush model sent as the world, model 0', () => {
    const contents = clientPointContents(mapWorld(), [brush(40, 0, vec3(0, 0, 100))]);
    // Model 0 placed 100 up would hold this point in its floor.
    expect(contents(vec3(0, 0, 90), -1)).toBe(0);
  });
});
