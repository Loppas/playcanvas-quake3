import { describe, expect, it } from 'vitest';

import { MAX_GENTITIES } from '../net/protocol';
import { loadMap } from './cm/cm-load';
import type { ClipMap } from './cm/cm-local';
import {
  cubeBsp,
  Digest,
  Seeded,
  STRIP_WIDTH,
  stripsBsp,
  type Strip
} from './cm/collision-test-fixtures';
import { CONTENTS } from './constants';
import { SOLID_BMODEL } from './entity-solid';
import { createGameEntity, type GameEntity } from './game-entity';
import { MAX_ENT_CLUSTERS, radiusFromBounds, ServerWorld, type WorldMap } from './server-world';
import { clearTrace, NO_CONTENTS } from './types';
import { vec3, type Vec3 } from './vec3';

const f = Math.fround;

/** q3dm11's model 0, as its BSP has it before collision spreads it by a unit. */
const Q3DM11_MINS: [number, number, number] = [-3552, -3040, -736];
const Q3DM11_MAXS: [number, number, number] = [1344, 752, 912];

/** A model 0 whose midpoints round in floats. */
const ODD_MINS: [number, number, number] = [f(-1000.3), f(-77.7), f(-10.1)];
const ODD_MAXS: [number, number, number] = [f(999.9), f(3000.1), f(10.3)];

/** A world over a map whose model 0 has these bounds, or over a splat map's. */
function worldOver(bounds?: [[number, number, number], [number, number, number]]) {
  if (!bounds) return worldOn();
  const cube = cubeBsp();
  const [mins, maxs] = bounds;
  return worldOn(
    loadMap(
      cubeBsp({ models: [{ ...cube.models[0], mins, maxs }, ...cube.models.slice(1)] }),
      'maps/test.bsp'
    )
  );
}

/** A world over this clip map, or over a splat map's. */
function worldOn(clipMap?: ClipMap) {
  const entities: GameEntity[] = Array.from({ length: MAX_GENTITIES }, (_, number) => {
    const entity = createGameEntity();
    entity.s.number = number;
    return entity;
  });
  const map: WorldMap = {
    trace: (_start, _mins, _maxs, end) => clearTrace(end),
    pointContents: NO_CONTENTS,
    clipMap
  };
  return { world: new ServerWorld((number) => entities[number], map), entities };
}

/** A cube of an entity, `size` each way about where it is, linked there. */
function place(
  world: ServerWorld,
  entity: GameEntity,
  x: number,
  y: number,
  z: number,
  size = 15
): void {
  entity.r.currentOrigin = vec3(x, y, z);
  entity.r.mins = vec3(-size, -size, -size);
  entity.r.maxs = vec3(size, size, size);
  world.link(entity);
}

const everywhere = [vec3(-1000, -1000, -1000), vec3(1000, 1000, 1000)] as const;

// Every list below is the twin's own, from its `hand` mode.
describe("SV_AreaEntities' order", () => {
  /** A splat map's world, every sector splitting y at 0, with six cubes up and down y. */
  function splat() {
    const { world, entities } = worldOver();
    for (const [number, y] of [
      [8, 100],
      [9, -100],
      [10, 0],
      [11, 200],
      [12, -200],
      [13, 10]
    ]) {
      place(world, entities[number], 0, y, 0);
    }
    return { world, entities };
  }

  it('lists what crosses a split before what is past it, then what is short of it', () => {
    const { world } = splat();
    expect(world.areaEntities(...everywhere)).toEqual([13, 10, 11, 8, 12, 9]);
  });

  it('lists the newest link first, so a link again goes to the head of its list', () => {
    const { world, entities } = splat();
    place(world, entities[8], 0, 100, 0);
    expect(world.areaEntities(...everywhere)).toEqual([13, 10, 8, 11, 12, 9]);
  });

  it('drops what is unlinked', () => {
    const { world, entities } = splat();
    place(world, entities[8], 0, 100, 0);
    world.unlink(entities[11]);
    expect(entities[11].r.linked).toBe(false);
    expect(world.areaEntities(...everywhere)).toEqual([13, 10, 8, 12, 9]);
  });

  it('does not go past a split a box ends on, and counts a box touching edge to edge', () => {
    const { world, entities } = splat();
    place(world, entities[8], 0, 100, 0);
    world.unlink(entities[11]);
    expect(world.areaEntities(vec3(-1000, 0, -1000), vec3(1000, 1000, 1000))).toEqual([13, 10, 8]);
    // Cube 8's box, padded, reaches y = 116.
    expect(world.areaEntities(vec3(-1000, 116, -1000), vec3(1000, 1000, 1000))).toEqual([8]);
  });

  it('takes the box it is asked for as floats, as a vec3_t holds it', () => {
    const { world } = splat();
    // Cube 8's padded box starts at y = 84, which is the float nearest 83.999999.
    expect(world.areaEntities(vec3(-1000, 70, -1000), vec3(1000, 83.999999, 1000))).toEqual([8]);
  });

  it('keeps a box touching a split above it, from either side', () => {
    const { world, entities } = splat();
    world.unlink(entities[11]);
    place(world, entities[8], 0, 100, 0);
    // Its padded box's bottom is on the split, y = 0.
    place(world, entities[14], 0, 16, 0);
    expect(world.areaEntities(...everywhere)).toEqual([14, 13, 10, 8, 12, 9]);
    // And this one's top.
    place(world, entities[15], 0, -16, 0);
    expect(world.areaEntities(...everywhere)).toEqual([15, 14, 13, 10, 8, 12, 9]);
  });

  it('hands each search a list of its own', () => {
    const { world } = splat();
    const all = world.areaEntities(...everywhere);
    world.areaEntities(vec3(-1000, 116, -1000), vec3(1000, 1000, 1000));
    world.pointContents(vec3(0, 100, 0), -1);
    expect(all).toEqual([13, 10, 11, 8, 12, 9]);
  });

  it('splits at the midpoint in floats', () => {
    const { world, entities } = worldOver([ODD_MINS, ODD_MAXS]);
    // Its padded box's bottom is on the first split, y = 1461.2000732421875, which in doubles
    // would be 1461.200050354004, and the box past it.
    place(world, entities[30], 0, 1477.2000732421875, 0);
    place(world, entities[31], 0, 2000, 0);
    expect(world.areaEntities(vec3(-2000, -2000, -2000), vec3(4000, 4000, 4000))).toEqual([30, 31]);
  });

  it("walks q3dm11's sectors, which split x first", () => {
    const { world, entities } = worldOver([Q3DM11_MINS, Q3DM11_MAXS]);
    place(world, entities[8], 1000, 0, 0);
    place(world, entities[9], -3000, -2000, 0);
    // On the first split, x = −1104, so it stays at the top.
    place(world, entities[10], -1104, 0, 0);
    place(world, entities[11], 500, 400, 0);
    place(world, entities[12], -3000, 500, 0);
    const all = world.areaEntities(vec3(-3553, -3041, -737), vec3(1345, 753, 913));
    expect(all).toEqual([10, 11, 8, 12, 9]);
    expect(world.areaEntities(vec3(0, -3041, -737), vec3(1345, 753, 913))).toEqual([11, 8]);
  });
});

describe("SV_LinkEntity's box", () => {
  /** A door 128 wide and 16 deep, about an origin that is not a whole unit. */
  function door() {
    const { world, entities } = worldOver();
    const entity = entities[20];
    entity.r.bmodel = true;
    entity.r.mins = vec3(-64, -8, -64);
    entity.r.maxs = vec3(64, 8, 64);
    entity.r.currentOrigin = vec3(f(100.5), f(0.1), f(3000.3));
    return { world, entity };
  }

  it("is a turned brush model's radius each way about its origin, in floats", () => {
    const { world, entity } = door();
    entity.r.currentAngles = vec3(0, 90, 0);
    world.link(entity);
    expect(radiusFromBounds(entity.r.mins, entity.r.maxs)).toBe(f(90.8625336));
    expect(entity.r.absmin).toEqual(vec3(f(8.63746643), f(-91.7625351), f(2908.4375)));
    expect(entity.r.absmax).toEqual(vec3(f(192.362534), f(91.962532), f(3092.1626)));
    expect(entity.s.solid).toBe(SOLID_BMODEL);
  });

  it('is its bounds about its origin when no angle is set, −0 among them', () => {
    const { world, entity } = door();
    entity.r.currentAngles = vec3(0, -0, 0);
    world.link(entity);
    expect(entity.r.absmin).toEqual(vec3(f(35.5), f(-8.89999962), f(2935.30005)));
    expect(entity.r.absmax).toEqual(vec3(f(165.5), f(9.10000038), f(3065.30005)));
  });

  it('sums its corners in floats before the pad, which can take them into a finer binade', () => {
    const { world, entities } = worldOver();
    const entity = entities[21];
    entity.r.currentOrigin = vec3(f(1100.01), f(-1100.01), 0);
    entity.r.mins = vec3(f(-75.04), -15, -15);
    entity.r.maxs = vec3(15, f(75.04), 15);
    world.link(entity);
    // In doubles, rounded only after the pad, each corner would be 1023.97003.
    expect(entity.r.absmin).toEqual(vec3(f(1023.96997), f(-1116.01001), -16));
    expect(entity.r.absmax).toEqual(vec3(f(1116.01001), f(-1023.96997), 16));
  });

  it('is its bounds whatever its angles when it is a box', () => {
    const { world, entity } = door();
    entity.r.bmodel = false;
    entity.r.currentAngles = vec3(0, 90, 0);
    world.link(entity);
    expect(entity.r.absmin).toEqual(vec3(f(35.5), f(-8.89999962), f(2935.30005)));
  });

  it('counts each link', () => {
    const { world, entity } = door();
    world.link(entity);
    world.link(entity);
    expect(entity.r.linkcount).toBe(2);
    expect(entity.r.linked).toBe(true);
  });
});

/** A leaf of a row with a cluster and an area. */
const room = (cluster: number, area: number): Strip => ({ cluster, area });
/** A solid leaf. */
const SOLID = room(-1, -1);

/** A world over a row of leaves, with these rows of visibility or none. */
function stripsWorld(strips: readonly Strip[], visibility: Uint8Array | null = null) {
  const vis = visibility && {
    numClusters: visibility.length,
    clusterBytes: 1,
    data: visibility
  };
  const cm = loadMap(stripsBsp(strips, [], vis), 'maps/test.bsp');
  return { ...worldOn(cm), cm };
}

/** An entity linked over leaves `first` to `last` of a row, its box 8 inside each end. */
function across(world: ServerWorld, entity: GameEntity, first: number, last: number): void {
  entity.r.currentOrigin = vec3();
  entity.r.mins = vec3(STRIP_WIDTH * first + 8, -8, -8);
  entity.r.maxs = vec3(STRIP_WIDTH * (last + 1) - 8, 8, 8);
  world.link(entity);
}

/** The middle of leaf `k` of a row. */
function at(k: number): Vec3 {
  return vec3(STRIP_WIDTH * k + STRIP_WIDTH / 2, 0, 0);
}

/** What the world keeps of where an entity was linked. */
function filed(world: ServerWorld, number: number) {
  const first = number * MAX_ENT_CLUSTERS;
  return {
    areanum: world.areanum[number],
    areanum2: world.areanum2[number],
    clusters: Array.from(world.clusternums.subarray(first, first + world.numClusters[number])),
    lastCluster: world.lastCluster[number]
  };
}

describe("SV_LinkEntity's areas and clusters", () => {
  it('files a box over a portal in both its areas, and in both its clusters', () => {
    const { world, entities } = stripsWorld([room(0, 0), room(1, 1), SOLID]);
    across(world, entities[70], 0, 1);
    expect(filed(world, 70)).toEqual({ areanum: 0, areanum2: 1, clusters: [0, 1], lastCluster: 0 });
    // A solid leaf after them is in no area.
    across(world, entities[70], 0, 2);
    expect(filed(world, 70)).toEqual({ areanum: 0, areanum2: 1, clusters: [0, 1], lastCluster: 0 });
  });

  it('keeps the first area of a box in three, and the last other one met', () => {
    const { world, entities } = stripsWorld([room(0, 0), room(1, 1), room(2, 2), room(3, 1)]);
    across(world, entities[70], 0, 2);
    expect(filed(world, 70)).toMatchObject({ areanum: 0, areanum2: 2 });
    across(world, entities[70], 0, 3);
    expect(filed(world, 70)).toMatchObject({ areanum: 0, areanum2: 1 });
  });

  it('files a box wholly in solid in no area and no cluster, and still links it', () => {
    const { world, entities } = stripsWorld([SOLID, room(0, 3), SOLID]);
    across(world, entities[70], 0, 2);
    expect(filed(world, 70)).toEqual({ areanum: 3, areanum2: -1, clusters: [0], lastCluster: 0 });
    across(world, entities[70], 2, 2);
    expect(filed(world, 70)).toEqual({ areanum: -1, areanum2: -1, clusters: [], lastCluster: 0 });
    expect(entities[70].r.linked).toBe(true);
    expect(entities[70].r.linkcount).toBe(2);
  });

  it("keeps the clusters in the leaves' order, one as often as its leaves are met", () => {
    const { world, entities } = stripsWorld([
      room(4, 0),
      room(4, 0),
      SOLID,
      room(2, 0),
      room(4, 0)
    ]);
    across(world, entities[70], 0, 4);
    expect(filed(world, 70)).toMatchObject({ areanum: 0, areanum2: -1, clusters: [4, 4, 2, 4] });
  });

  it('keeps sixteen clusters, and a last one once they fill, even on the last leaf', () => {
    const strips = Array.from({ length: 18 }, (_, i) => room(10 + i, 0));
    strips[17] = SOLID;
    const { world, entities } = stripsWorld(strips);
    const sixteen = Array.from({ length: 16 }, (_, i) => 10 + i);

    across(world, entities[70], 1, 15);
    expect(filed(world, 70)).toMatchObject({ clusters: sixteen.slice(1), lastCluster: 0 });
    // The sixteenth on the last leaf: the loop stops short of the end, so a last one is kept.
    across(world, entities[70], 0, 15);
    expect(filed(world, 70)).toMatchObject({ clusters: sixteen, lastCluster: 25 });
    across(world, entities[70], 0, 16);
    expect(filed(world, 70)).toMatchObject({ clusters: sixteen, lastCluster: 26 });
    // A solid leaf last: the last leaf with a cluster.
    across(world, entities[70], 0, 17);
    expect(filed(world, 70)).toMatchObject({ clusters: sixteen, lastCluster: 26 });
    // Linked again short of sixteen, it has none.
    across(world, entities[70], 1, 15);
    expect(filed(world, 70).lastCluster).toBe(0);
  });

  it('reads the first 128 leaves, but the last leaf with a cluster of them all', () => {
    const strips = Array.from({ length: 130 }, () => SOLID);
    strips[0] = room(0, 0);
    strips[100] = room(3, 4);
    strips[128] = room(1, 1);
    strips[129] = room(2, 2);
    const { world, entities } = stripsWorld(strips);
    across(world, entities[70], 0, 129);
    expect(filed(world, 70)).toEqual({ areanum: 0, areanum2: 4, clusters: [0, 3], lastCluster: 0 });

    for (let i = 0; i < 16; i++) strips[i] = room(10 + i, 0);
    const full = stripsWorld(strips);
    across(full.world, full.entities[70], 0, 129);
    expect(filed(full.world, 70).lastCluster).toBe(2);
  });

  it('files everything in area 0 and cluster 0 in a world without a clip map', () => {
    const { world, entities } = worldOn();
    across(world, entities[70], 0, 100);
    expect(filed(world, 70)).toEqual({ areanum: 0, areanum2: -1, clusters: [0], lastCluster: 0 });
  });

  it('leaves them as they were at an unlink, and zeroes them with the world', () => {
    const strips = Array.from({ length: 17 }, (_, i) => room(10 + i, i < 8 ? 1 : 2));
    const { world, entities, cm } = stripsWorld(strips);
    across(world, entities[70], 0, 16);
    world.unlink(entities[70]);
    expect(filed(world, 70)).toMatchObject({ areanum: 1, areanum2: 2, lastCluster: 26 });
    expect(filed(world, 70).clusters).toHaveLength(16);
    world.clear({
      trace: (_start, _mins, _maxs, end) => clearTrace(end),
      pointContents: NO_CONTENTS,
      clipMap: cm
    });
    expect(filed(world, 70)).toEqual({ areanum: 0, areanum2: 0, clusters: [], lastCluster: 0 });
  });
});

describe('SV_AdjustAreaPortalState', () => {
  it('opens and closes the portal an entity was last linked across, counting each', () => {
    const { world, entities, cm } = stripsWorld([room(0, 0), room(1, 1)]);
    const door = entities[70];
    across(world, door, 0, 1);
    world.adjustAreaPortalState(door, true);
    world.adjustAreaPortalState(door, true);
    expect(Array.from(cm.areaPortals)).toEqual([0, 2, 2, 0]);
    // Unlinked, it still stands where it was last linked.
    world.unlink(door);
    world.adjustAreaPortalState(door, false);
    world.adjustAreaPortalState(door, false);
    expect(Array.from(cm.areaPortals)).toEqual([0, 0, 0, 0]);
    expect(() => world.adjustAreaPortalState(door, false)).toThrow(
      'CM_AdjustAreaPortalState: negative reference count'
    );
  });

  it('changes nothing for an entity in one area, or in a world without a clip map', () => {
    const { world, entities, cm } = stripsWorld([room(0, 0), room(1, 1)]);
    across(world, entities[70], 1, 1);
    world.adjustAreaPortalState(entities[70], true);
    expect(Array.from(cm.areaPortals)).toEqual([0, 0, 0, 0]);

    // Linked, or never linked and so in area 0 and area 0.
    const splat = worldOn();
    across(splat.world, splat.entities[70], 0, 1);
    expect(() => splat.world.adjustAreaPortalState(splat.entities[70], false)).not.toThrow();
    expect(() => splat.world.adjustAreaPortalState(splat.entities[71], false)).not.toThrow();
  });
});

describe('SV_inPVS', () => {
  /**
   * Clusters 0, 1 and 2 in areas 0, 1 and 1, then solid, with a portal over the first boundary:
   * cluster 0 sees 0 and 1, 1 sees all three, and 2 sees 1 and 2. Cluster 0's row has its last
   * bit set, past the clusters, as the byte before cluster 1's.
   */
  function rooms() {
    const fixture = stripsWorld(
      [room(0, 0), room(1, 1), room(2, 1), SOLID],
      Uint8Array.of(0b1000_0011, 0b111, 0b110)
    );
    const door = fixture.entities[70];
    across(fixture.world, door, 0, 1);
    return { ...fixture, door };
  }

  it('sees into a cluster the eye’s can see, through no shut door', () => {
    const { world, door } = rooms();
    expect(world.inPVS(at(1), at(2))).toBe(true);
    expect(world.inPVS(at(0), at(1))).toBe(false);
    world.adjustAreaPortalState(door, true);
    expect(world.inPVS(at(0), at(1))).toBe(true);
    expect(world.inPVS(at(1), at(0))).toBe(true);
    // Through the open door, but into a cluster the eye's cannot see.
    expect(world.inPVS(at(0), at(2))).toBe(false);
  });

  it('sees into solid and from it only under cm_noAreas, by the byte before a row', () => {
    const { world, cm } = rooms();
    expect(world.inPVS(at(1), at(3))).toBe(false);
    expect(world.inPVS(at(3), at(1))).toBe(false);
    cm.cvars.noAreas = 1;
    expect(world.inPVS(at(0), at(1))).toBe(true);
    // Solid's bit is the last of the byte before the eye's row, and before the first there is none.
    expect(world.inPVS(at(1), at(3))).toBe(true);
    expect(world.inPVS(at(2), at(3))).toBe(false);
    expect(world.inPVS(at(0), at(3))).toBe(false);
    expect(world.inPVS(at(3), at(1))).toBe(true);
    expect(world.inPVS(at(3), at(2))).toBe(false);
  });

  it('sees every cluster of a map without visibility, and everything without a clip map', () => {
    const { world } = stripsWorld([room(0, 0), room(1, 0), room(2, 1)]);
    expect(world.inPVS(at(0), at(1))).toBe(true);
    expect(world.inPVS(at(0), at(2))).toBe(false);
    expect(worldOn().world.inPVS(at(0), at(9))).toBe(true);
  });
});

/**
 * The twin's `corpus` mode: seeded links, unlinks and searches, each digested as the twin digests
 * it. Every value is made in floats as the twin's C makes it.
 */
function corpus(
  seed: number,
  ops: number,
  bounds?: [[number, number, number], [number, number, number]]
) {
  const { world, entities } = worldOver(bounds);
  const worldMins = bounds ? bounds[0].map((v) => f(v - 1)) : [0, 0, 0];
  const worldMaxs = bounds ? bounds[1].map((v) => f(v + 1)) : [0, 0, 0];
  const random = new Seeded(seed);
  const pick = (n: number) => (random.next() >>> 8) % n;
  const uniformIn = (lo: number, hi: number) => {
    const t = ((random.next() >>> 8) % 65536) / 65536;
    return f(lo + f(f(hi - lo) * t));
  };
  const randomPoint = () => {
    const x = uniformIn(f(worldMins[0] - 256), f(worldMaxs[0] + 256));
    const y = uniformIn(f(worldMins[1] - 256), f(worldMaxs[1] + 256));
    const z = uniformIn(f(worldMins[2] - 256), f(worldMaxs[2] + 256));
    return vec3(x, y, z);
  };
  const randomAngle = () => {
    const kind = pick(4);
    if (kind === 0) return 0;
    if (kind === 1) return -0;
    return uniformIn(-360, 360);
  };
  const box = (lo: number, hi: number) => {
    const x = uniformIn(lo, hi);
    const y = uniformIn(lo, hi);
    const z = uniformIn(lo, hi);
    return vec3(x, y, z);
  };
  const randomBounds = (entity: GameEntity) => {
    const kind = pick(5);
    if (kind === 0) {
      entity.r.mins = vec3(-15, -15, -24);
      entity.r.maxs = vec3(15, 15, 32);
    } else if (kind === 1) {
      entity.r.mins = vec3(-15, -15, -15);
      entity.r.maxs = vec3(15, 15, 15);
    } else if (kind === 2) {
      entity.r.mins = vec3();
      entity.r.maxs = vec3();
    } else if (kind === 3) {
      entity.r.mins = box(-256, 0);
      entity.r.maxs = box(0, 256);
    } else {
      entity.r.mins = box(-600, 0);
      entity.r.maxs = box(0, 600);
    }
  };
  const contents = [CONTENTS.SOLID, CONTENTS.BODY, CONTENTS.TRIGGER];

  const links = new Digest();
  const queries = new Digest();
  let linkCount = 0;
  let queryCount = 0;
  for (let op = 0; op < ops; op++) {
    const kind = pick(8);
    if (kind < 4) {
      const entity = entities[pick(48) * 21];
      if (pick(4)) {
        entity.r.currentOrigin = randomPoint();
        randomBounds(entity);
        entity.r.bmodel = pick(3) === 0;
        if (pick(2)) {
          const x = randomAngle();
          const y = randomAngle();
          const z = randomAngle();
          entity.r.currentAngles = vec3(x, y, z);
        } else {
          entity.r.currentAngles = vec3();
        }
        entity.r.contents = contents[pick(3)];
      }
      world.link(entity);
      linkCount++;
      const { absmin, absmax } = entity.r;
      links.int(entity.s.number);
      links.float(absmin.x).float(absmin.y).float(absmin.z);
      links.float(absmax.x).float(absmax.y).float(absmax.z);
      links.int(entity.s.solid).int(entity.r.linkcount);
    } else if (kind === 4) {
      world.unlink(entities[pick(48) * 21]);
    } else {
      let mins = vec3();
      let maxs = vec3();
      const shape = pick(4);
      if (shape === 0) {
        mins = randomPoint();
        maxs = mins;
      } else if (shape === 1) {
        const p = randomPoint();
        for (const axis of ['x', 'y', 'z'] as const) {
          const half = uniformIn(0, 300);
          mins[axis] = f(p[axis] - half);
          maxs[axis] = f(p[axis] + half);
        }
      } else if (shape === 2) {
        mins = randomPoint();
        for (const axis of ['x', 'y', 'z'] as const) {
          maxs[axis] = f(mins[axis] + uniformIn(0, 2000));
        }
      } else {
        mins = vec3(worldMins[0], worldMins[1], worldMins[2]);
        maxs = vec3(worldMaxs[0], worldMaxs[1], worldMaxs[2]);
      }
      const found = world.areaEntities(mins, maxs);
      queryCount++;
      queries.int(found.length);
      for (const number of found) queries.int(number);
    }
  }
  return {
    links: { count: linkCount, digest: links.hex() },
    queries: { count: queryCount, digest: queries.hex() }
  };
}

describe("sv_world.c's sectors, held to a twin of ioquake3's", () => {
  it("files, finds and turns as ioquake3 does on q3dm11's world", () => {
    expect(corpus(1, 20000, [Q3DM11_MINS, Q3DM11_MAXS])).toEqual({
      links: { count: 10519, digest: '3dffc5b4' },
      queries: { count: 7458, digest: 'd480da85' }
    });
  });

  it("files, finds and turns as ioquake3 does on a splat map's", () => {
    expect(corpus(2, 20000)).toEqual({
      links: { count: 10505, digest: 'af75217c' },
      queries: { count: 7430, digest: '2d9f9a0e' }
    });
  });

  it('files, finds and turns as ioquake3 does on a world whose midpoints round', () => {
    expect(corpus(3, 20000, [ODD_MINS, ODD_MAXS])).toEqual({
      links: { count: 10606, digest: 'c2ad5a78' },
      queries: { count: 7407, digest: '5999865b' }
    });
  });
});

describe('SV_SvEntityForGentity', () => {
  it('refuses an entity whose number is no slot, in Quake 3’s words', () => {
    const { world } = worldOver();
    const entity = createGameEntity();
    entity.s.number = MAX_GENTITIES;
    expect(() => world.link(entity)).toThrow('SV_SvEntityForGentity: bad gEnt');
    entity.s.number = -1;
    expect(() => world.unlink(entity)).toThrow('SV_SvEntityForGentity: bad gEnt');
  });
});
