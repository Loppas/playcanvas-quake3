import { describe, expect, it, vi } from 'vitest';

import {
  MST_FLARE,
  MST_PATCH,
  MST_TRIANGLE_SOUP,
  type Bsp,
  type BspLeaf,
  type BspNode,
  type BspSurface
} from '../formats/bsp';
import { vec3 } from '../sim/vec3';
import type { FirstPersonView } from './camera-feel';
import type { DynamicLight } from './dynamic-lights';
import { model, surface, testBsp, testSources } from './world-test-fixtures';
import { loadWorldShaders } from './world-shaders';
import { OPEN_AREAS, WorldVis, type VisModel, type VisSwitches } from './world-vis';

type Vec3 = [number, number, number];

const SCRIPTS = `
  textures/t/front { { map t.tga } }
  textures/t/back { cull back { map t.tga } }
  textures/t/twosided { cull none { map t.tga } }
`;
const FRONT = 0;
const BACK = 1;
const TWO_SIDED = 2;

const SWITCHES: VisSwitches = {
  novis: false,
  nocull: false,
  lockpvs: false,
  showcluster: false,
  facePlaneCull: true,
  entities: true
};

const node = (planeNum: number, front: number, back: number, mins: Vec3, maxs: Vec3): BspNode => ({
  planeNum,
  children: [front, back],
  mins,
  maxs
});

const leaf = (
  cluster: number,
  first: number,
  num: number,
  mins: Vec3,
  maxs: Vec3,
  area = 0
): BspLeaf => ({
  cluster,
  area,
  mins,
  maxs,
  firstLeafSurface: first,
  numLeafSurfaces: num,
  firstLeafBrush: 0,
  numLeafBrushes: 0
});

/** A face of one triangle in a shader, its vertices from `firstVert`, facing along `normal`. */
const face = (shaderNum: number, firstVert: number, normal: Vec3 = [0, 0, 1]): BspSurface =>
  surface({ shaderNum, firstVert, lightmapVecs: [[0, 0, 0], [0, 0, 0], normal] });

/** A view from `origin` at yaw and pitch, 90° across and up unless said. */
function at(origin: Vec3, yaw = 0, pitch = 0): FirstPersonView {
  return { origin: vec3(...origin), angles: vec3(pitch, yaw, 0) };
}

type Grids = ConstructorParameters<typeof WorldVis>[2];

function visOf(
  bsp: Bsp,
  { grids = [], models = [], print = () => {} }: { grids?: Grids; models?: VisModel[]; print?: (text: string) => void } = {}
): WorldVis {
  const shaders = loadWorldShaders(bsp, testSources(SCRIPTS, ['t.tga']));
  return new WorldVis(bsp, shaders, grids, models, print);
}

/** What a view adds, in order, with no area closed unless an areamask says. */
function seen(
  vis: WorldVis,
  view: FirstPersonView,
  switches: Partial<VisSwitches> = {},
  areamask: Uint8Array = OPEN_AREAS
): number[] {
  vis.view(view, 90, 90, { ...SWITCHES, ...switches }, areamask);
  return Array.from(vis.surfaces.subarray(0, vis.count));
}

/** An areamask closing the areas given. */
function closing(...areas: number[]): Uint8Array {
  const mask = new Uint8Array(32);
  for (const area of areas) mask[area >> 3] |= 1 << (area & 7);
  return mask;
}

/**
 * Three leafs in a row along x, split at 0 and 100, and a solid one past −100:
 * - leaf 0, x −100 to 0, cluster 0, which sees every cluster;
 * - leaf 1, x 0 to 100, cluster 1, which sees 0 and 1;
 * - leaf 2, x 100 to 200, cluster 2, which sees 1 and 2;
 * - leaf 3, past −100, in no cluster.
 *
 * Surface `n` is in leaf `n`, and surface 3 in leafs 1 and 2. All are two-sided.
 */
function row(): Bsp {
  const lo = -50;
  const hi = 50;
  return testBsp({
    shaders: ['textures/t/front', 'textures/t/back', 'textures/t/twosided'],
    surfaces: [0, 1, 2, 3].map((i) => face(TWO_SIDED, i * 3)),
    planes: [
      { normal: [1, 0, 0], dist: 0 },
      { normal: [1, 0, 0], dist: 100 },
      { normal: [1, 0, 0], dist: -100 }
    ],
    nodes: [
      node(0, 1, 2, [-200, lo, lo], [200, hi, hi]),
      node(1, -3, -2, [0, lo, lo], [200, hi, hi]),
      node(2, -1, -4, [-200, lo, lo], [0, hi, hi])
    ],
    leafs: [
      leaf(0, 0, 1, [-100, lo, lo], [0, hi, hi]),
      leaf(1, 1, 2, [0, lo, lo], [100, hi, hi]),
      leaf(2, 3, 2, [100, lo, lo], [200, hi, hi]),
      leaf(-1, 0, 0, [-200, lo, lo], [-100, hi, hi])
    ],
    leafSurfaces: [0, 1, 3, 2, 3],
    visibility: { numClusters: 3, clusterBytes: 1, data: Uint8Array.from([0b111, 0b011, 0b110]) }
  });
}

/**
 * One leaf holding the world's surfaces, a box 2,000 across about the origin, in cluster 0, and a
 * solid one past x 5,000.
 */
function open(surfaces: BspSurface[], xyz: number[], parts: Parameters<typeof testBsp>[0] = {}): Bsp {
  const big: Vec3 = [1000, 1000, 1000];
  const small: Vec3 = [-1000, -1000, -1000];
  const world = parts.models?.[0].numSurfaces ?? surfaces.length;
  return testBsp({
    shaders: ['textures/t/front', 'textures/t/back', 'textures/t/twosided'],
    surfaces,
    xyz,
    planes: [{ normal: [1, 0, 0], dist: 5000 }],
    nodes: [node(0, -2, -1, small, big)],
    leafs: [leaf(0, 0, world, small, big), leaf(-1, 0, 0, [5000, 0, 0], [6000, 0, 0])],
    ...parts
  });
}

describe('WorldVis', () => {
  describe('the marks', () => {
    it('puts a point on a plane behind it', () => {
      const vis = visOf(row());
      expect(vis.pointInLeaf(0, 0, 0)).toBe(0);
      expect(vis.pointInLeaf(0.5, 0, 0)).toBe(1);
      expect(vis.pointInLeaf(100, 0, 0)).toBe(1);
      expect(vis.pointInLeaf(100.5, 0, 0)).toBe(2);
      expect(vis.pointInLeaf(-100, 0, 0)).toBe(3);
    });

    it('marks the leafs the eye’s cluster sees, and their parents', () => {
      const vis = visOf(row());
      // From cluster 1, which sees 0 and 1: leaf 2 is left, and its surface with it.
      expect(seen(vis, at([50, 0, 0]), { nocull: true })).toEqual([1, 3, 0]);
      expect(vis.viewCluster).toBe(1);
      // From cluster 2, which sees 1 and 2.
      expect(seen(vis, at([150, 0, 0]), { nocull: true })).toEqual([2, 3, 1]);
    });

    it('marks again only when the eye’s cluster changes, so r_novis waits for it', () => {
      const vis = visOf(row());
      expect(seen(vis, at([50, 0, 0]), { nocull: true })).toEqual([1, 3, 0]);
      expect(seen(vis, at([60, 0, 0]), { nocull: true, novis: true })).toEqual([1, 3, 0]);
      expect(seen(vis, at([150, 0, 0]), { nocull: true, novis: true })).toEqual([2, 3, 1, 0]);
      expect(seen(vis, at([50, 0, 0]), { nocull: true })).toEqual([1, 3, 0]);
    });

    it('keeps the marks under r_lockpvs, wherever the eye goes', () => {
      const vis = visOf(row());
      seen(vis, at([50, 0, 0]), { nocull: true });
      expect(seen(vis, at([-50, 0, 0]), { nocull: true, lockpvs: true })).toEqual([1, 3, 0]);
      expect(vis.viewCluster).toBe(1);
      expect(seen(vis, at([-50, 0, 0]), { nocull: true })).toEqual([2, 3, 1, 0]);
    });

    it('marks every leaf from no cluster', () => {
      const vis = visOf(row());
      seen(vis, at([50, 0, 0]), { nocull: true });
      expect(seen(vis, at([-150, 0, 0]), { nocull: true })).toEqual([2, 3, 1, 0]);
      expect(vis.viewCluster).toBe(-1);
      // The solid leaf among them.
      expect(vis.leafs).toBe(4);
    });

    it('marks every leaf of a map with no visibility', () => {
      const bsp = row();
      bsp.visibility = null;
      expect(seen(visOf(bsp), at([50, 0, 0]), { nocull: true })).toEqual([2, 3, 1, 0]);
    });

    it('prints the cluster under r_showcluster, and marks again when it is turned on', () => {
      const print = vi.fn();
      const vis = visOf(row(), { print });
      seen(vis, at([50, 0, 0]), { nocull: true });
      seen(vis, at([60, 0, 0]), { nocull: true, novis: true });
      expect(print).not.toHaveBeenCalled();
      // Turned on, it marks the same cluster again, and so takes `r_novis`.
      const marked = seen(vis, at([60, 0, 0]), { nocull: true, novis: true, showcluster: true });
      expect(marked).toEqual([2, 3, 1, 0]);
      expect(print).toHaveBeenCalledWith('cluster:1  area:0\n');
      seen(vis, at([60, 0, 0]), { nocull: true, showcluster: true });
      expect(print).toHaveBeenCalledTimes(1);
      seen(vis, at([150, 0, 0]), { nocull: true, showcluster: true });
      expect(print).toHaveBeenLastCalledWith('cluster:2  area:0\n');
    });
  });

  describe('the areas', () => {
    /** {@link row}, its leafs in areas 0, 1 and 2, and the solid one in none. */
    function areas(): Bsp {
      const bsp = row();
      bsp.leafs.forEach((leaf, l) => (leaf.area = l < 3 ? l : -1));
      return bsp;
    }

    it("leaves out a closed area's leafs and their surfaces, the eye's own among them", () => {
      // From cluster 0, which sees every cluster.
      expect(seen(visOf(areas()), at([-50, 0, 0]), { nocull: true })).toEqual([2, 3, 1, 0]);
      expect(seen(visOf(areas()), at([-50, 0, 0]), { nocull: true }, closing(1))).toEqual([
        2, 3, 0
      ]);
      const vis = visOf(areas());
      expect(seen(vis, at([-50, 0, 0]), { nocull: true }, closing(1, 2))).toEqual([0]);
      expect(vis.leafs).toBe(1);
      // In area 1, closed: what the cluster sees of the rest, and its own leaf not.
      expect(seen(visOf(areas()), at([50, 0, 0]), { nocull: true }, closing(1))).toEqual([0]);
      // Out of the cluster's sight, an open area stays out.
      expect(seen(visOf(areas()), at([50, 0, 0]), { nocull: true }, closing(0))).toEqual([1, 3]);
    });

    it('marks again in the same cluster when the mask changes, and only then', () => {
      const vis = visOf(areas());
      expect(seen(vis, at([-50, 0, 0]), { nocull: true })).toEqual([2, 3, 1, 0]);
      expect(seen(vis, at([-60, 0, 0]), { nocull: true }, closing(2))).toEqual([1, 3, 0]);
      // Unchanged, the marks are kept, so r_novis waits.
      expect(seen(vis, at([-70, 0, 0]), { nocull: true, novis: true }, closing(2))).toEqual([
        1, 3, 0
      ]);
      // Changed, they are made again, and r_novis marks every leaf whatever the mask says.
      expect(seen(vis, at([-70, 0, 0]), { nocull: true, novis: true }, closing(1, 2))).toEqual([
        2, 3, 1, 0
      ]);
    });

    it('compares each view with the last, so a mask taken under r_lockpvs is never news', () => {
      const vis = visOf(areas());
      expect(seen(vis, at([50, 0, 0]), { nocull: true })).toEqual([1, 3, 0]);
      expect(seen(vis, at([50, 0, 0]), { nocull: true, lockpvs: true }, closing(0))).toEqual([
        1, 3, 0
      ]);
      // Unlocked in the same cluster, the mask is the last view's: area 0 is drawn closed.
      expect(seen(vis, at([50, 0, 0]), { nocull: true }, closing(0))).toEqual([1, 3, 0]);
      // Until the cluster changes.
      expect(seen(vis, at([150, 0, 0]), { nocull: true }, closing(0))).toEqual([2, 3, 1]);
    });

    it('marks every leaf from no cluster, whatever the mask', () => {
      const vis = visOf(areas());
      expect(seen(vis, at([-150, 0, 0]), { nocull: true }, closing(0, 1, 2))).toEqual([2, 3, 1, 0]);
    });

    it('never hides a leaf in no area', () => {
      const bsp = areas();
      bsp.leafs[1].area = -1;
      const every = new Uint8Array(32).fill(0xff);
      expect(seen(visOf(bsp), at([50, 0, 0]), { nocull: true }, every)).toEqual([1, 3]);
    });

    it('brings the far plane in to the leafs of the areas still open', () => {
      const vis = visOf(areas());
      seen(vis, at([-50, 0, 0]));
      expect(vis.zFar).toBeCloseTo(Math.hypot(250, 50, 50), 2);
      seen(vis, at([-50, 0, 0]), {}, closing(2));
      expect(vis.zFar).toBeCloseTo(Math.hypot(150, 50, 50), 2);
    });
  });

  describe('the walk', () => {
    it('takes the front child first, and each surface at the first leaf that holds it', () => {
      const vis = visOf(row());
      expect(seen(vis, at([-50, 0, 0]), { nocull: true })).toEqual([2, 3, 1, 0]);
      expect(vis.leafs).toBe(3);
    });

    it('leaves a node behind a plane of the frustum', () => {
      const vis = visOf(row());
      // From cluster 0, looking along −x: leafs 1 and 2 are behind the eye.
      expect(seen(vis, at([-60, 0, 0], 180))).toEqual([0]);
      expect(vis.leafs).toBe(1);
      expect(seen(vis, at([-60, 0, 0], 0))).toEqual([2, 3, 1, 0]);
    });

    it('stops trying a plane below a node wholly in front of it', () => {
      const behind: Vec3[] = [
        [-20, -1, -1],
        [-10, 1, 1]
      ];
      const ahead: Vec3[] = [
        [10, -1, -1],
        [20, 1, 1]
      ];
      // A node wholly ahead whose leaf is behind the eye, which no map could hold: reached.
      const bsp = (root: Vec3[]) =>
        testBsp({
          shaders: ['textures/t/twosided'],
          surfaces: [face(0, 0)],
          nodes: [node(0, -1, -2, root[0], root[1])],
          leafs: [leaf(0, 0, 1, behind[0], behind[1]), leaf(0, 0, 0, behind[0], behind[1])]
        });
      expect(seen(visOf(bsp(ahead)), at([0, 0, 0]))).toEqual([0]);
      expect(seen(visOf(bsp(behind)), at([0, 0, 0]))).toEqual([]);
    });
  });

  describe('the culls', () => {
    /** A face whose first point is at x 100, facing +x, in each shader. */
    const faces = () =>
      open(
        [face(FRONT, 0, [1, 0, 0]), face(BACK, 3, [1, 0, 0]), face(TWO_SIDED, 6, [1, 0, 0])],
        [100, 0, 0, 100, 1, 0, 100, 0, 1, 100, 0, 0, 100, 1, 0, 100, 0, 1, 100, 0, 0, 100, 1, 0, 100, 0, 1]
      );

    it('culls a face more than 8 units behind its plane, or in front for a back-sided shader', () => {
      const vis = visOf(faces());
      expect(seen(vis, at([91, 0, 0]))).toEqual([BACK, TWO_SIDED]);
      expect(seen(vis, at([92, 0, 0]))).toEqual([FRONT, BACK, TWO_SIDED]);
      expect(seen(vis, at([108, 0, 0]))).toEqual([FRONT, BACK, TWO_SIDED]);
      expect(seen(vis, at([109, 0, 0]))).toEqual([FRONT, TWO_SIDED]);
    });

    it('culls no face under r_facePlaneCull 0 or r_nocull', () => {
      const vis = visOf(faces());
      expect(seen(vis, at([0, 0, 0]), { facePlaneCull: false })).toEqual([0, 1, 2]);
      expect(seen(vis, at([200, 0, 0]), { nocull: true })).toEqual([0, 1, 2]);
    });

    it('takes no second look at a surface culled where it was first reached', () => {
      const bsp = row();
      // Facing +x at x 150, behind the eye's back; leafs 2 and 1 both hold it.
      bsp.surfaces[3] = face(FRONT, 9, [1, 0, 0]);
      bsp.drawVerts.xyz.set([150, 0, 0], 9 * 3);
      expect(seen(visOf(bsp), at([40, 0, 0]), { nocull: true, facePlaneCull: true })).toEqual([
        1, 3, 0
      ]);
      expect(seen(visOf(bsp), at([40, 0, 0]), { novis: true })).toEqual([2, 1, 0]);
    });

    it('culls a triangle soup by its bounds', () => {
      const soup = (x: number) =>
        open([surface({ surfaceType: MST_TRIANGLE_SOUP })], [x, 0, 0, x, 1, 0, x, 0, 1]);
      expect(seen(visOf(soup(50)), at([0, 0, 0]))).toEqual([0]);
      expect(seen(visOf(soup(-50)), at([0, 0, 0]))).toEqual([]);
    });

    it('culls a curve by its sphere, then by its box where the sphere is across a plane', () => {
      const bsp = open([surface({ surfaceType: MST_PATCH })], [0, 0, 0]);
      const grid = (mins: Vec3, maxs: Vec3) => {
        const origin: Vec3 = [0, 1, 2].map((j) => (mins[j] + maxs[j]) / 2) as Vec3;
        const radius = Math.hypot(...[0, 1, 2].map((j) => maxs[j] - origin[j]));
        return { meshBounds: [mins, maxs] as [Vec3, Vec3], localOrigin: origin, meshRadius: radius };
      };
      // Facing 45° round, the left plane is y = 0, facing +y.
      const view = at([0, 0, 0], 45);
      const culled = (g: ReturnType<typeof grid>) => seen(visOf(bsp, { grids: [g] }), view).length === 0;
      expect(culled(grid([99, 99, -1], [101, 101, 1]))).toBe(false);
      expect(culled(grid([99, -51, -1], [101, -49, 1]))).toBe(true);
      // Its sphere across the plane, its box wholly behind it.
      expect(culled(grid([0, -12, -1], [200, -8, 1]))).toBe(true);
      expect(culled(grid([0, -2, -1], [200, 2, 1]))).toBe(false);
      // Q3 skips a curve it made no grid for, and so culls nothing of it.
      expect(culled(null as never)).toBe(false);
    });

    it('never culls a flare', () => {
      const bsp = open([surface({ surfaceType: MST_FLARE })], [0, 0, -500]);
      expect(seen(visOf(bsp), at([0, 0, 0]))).toEqual([0]);
    });
  });

  describe('the brush models', () => {
    /** The world's one face, then a model's: a face at its origin facing +x. */
    const bsp = () =>
      open(
        [face(TWO_SIDED, 0), face(FRONT, 3, [1, 0, 0])],
        [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1],
        { models: [model(0, 1), { ...model(1, 1), mins: [-10, -10, -10], maxs: [10, 10, 10] }] }
      );
    const place = (origin: Vec3, yaw = 0): VisModel => ({ model: 1, origin, angles: [0, yaw, 0] });

    it('adds a model’s surfaces after the world’s, where its bounds are in view', () => {
      const view = at([0, 0, 0], 45);
      expect(seen(visOf(bsp(), { models: [place([100, 100, 0], 180)] }), view)).toEqual([0, 1]);
      expect(seen(visOf(bsp(), { models: [place([100, -50, 0], 180)] }), view)).toEqual([0]);
      expect(seen(visOf(bsp(), { models: [place([100, 100, 0], 180)] }), view, { entities: false })).toEqual([0]);
      // `r_nocull` keeps a model out of view.
      expect(seen(visOf(bsp(), { models: [place([100, -50, 0], 180)] }), view, { nocull: true })).toEqual([0, 1]);
    });

    it('adds a model in a closed area, as only its bounds decide', () => {
      const view = at([0, 0, 0], 45);
      const vis = visOf(bsp(), { models: [place([100, 100, 0], 180)] });
      // The world's one leaf is in area 0.
      expect(seen(vis, view, {}, closing(0))).toEqual([1]);
    });

    it('culls a model’s face with the eye in the model’s frame', () => {
      const view = at([0, 0, 0], 45);
      // Its face looks back at the eye only turned round.
      expect(seen(visOf(bsp(), { models: [place([100, 100, 0], 180)] }), view)).toEqual([0, 1]);
      expect(seen(visOf(bsp(), { models: [place([100, 100, 0], 0)] }), view)).toEqual([0]);
    });
  });

  describe('the dynamic lights', () => {
    /** A white light of this radius. */
    const light = (origin: Vec3, radius: number): DynamicLight => ({
      origin: vec3(...origin),
      radius,
      color: [1, 1, 1],
      additive: false
    });
    /** What a view lit by these lights adds, each surface with its key's light bit. */
    function lit(
      vis: WorldVis,
      view: FirstPersonView,
      lights: DynamicLight[],
      switches: Partial<VisSwitches> = {}
    ): number[][] {
      vis.view(view, 90, 90, { ...SWITCHES, ...switches }, OPEN_AREAS, lights);
      return Array.from(vis.surfaces.subarray(0, vis.count), (s, i) => [s, vis.lit[i]]);
    }
    const everything = { novis: true, nocull: true };
    const middle = at([50, 0, 0]);

    it('hands a light down the sides of the planes it reaches, then to a face by its plane', () => {
      // Faces 1 to 3 are in the leafs right of x 0 and face 0 left of it; face n's plane is z 9n.
      const vis = visOf(row());
      // Across x 100 and short of x 0, level with face 1's plane.
      expect(lit(vis, middle, [light([150, 0, 9], 60)], everything)).toEqual([
        [2, 1],
        [3, 1],
        [1, 1],
        [0, 0]
      ]);
      expect(Array.from(vis.dlightBits)).toEqual([0, 1, 1, 1]);
      expect([vis.dlightSurfaces, vis.dlightSurfacesCulled]).toEqual([3, 0]);
      // 61 above face 1's plane, and within reach of the others'.
      expect(lit(vis, middle, [light([150, 0, 70], 60)], everything)).toEqual([
        [2, 1],
        [3, 1],
        [1, 0],
        [0, 0]
      ]);
      expect(Array.from(vis.dlightBits)).toEqual([0, 0, 1, 1]);
      expect([vis.dlightSurfaces, vis.dlightSurfacesCulled]).toEqual([2, 1]);
    });

    it('hands a light down only the sides its radius reaches, keeping one just reaching', () => {
      // Its radius off x 0's plane, on its far side: not behind it, so not to face 0's leaf.
      const right = visOf(row());
      lit(right, middle, [light([60, 0, 0], 60)], everything);
      expect(right.dlightBits[0]).toBe(0);
      // Its radius off it on the near side: not in front of it, so not to the others' leafs.
      const left = visOf(row());
      lit(left, middle, [light([-60, 0, 0], 60)], everything);
      expect(Array.from(left.dlightBits)).toEqual([1, 0, 0, 0]);
      // Its radius off face 1's plane: kept, as a light past it is not.
      const level = visOf(row());
      lit(level, middle, [light([150, 0, 69], 60)], everything);
      expect(level.dlightBits[1]).toBe(1);
    });

    it('keeps the bits of a surface no light reaches the first leaf of, untested', () => {
      const vis = visOf(row());
      lit(vis, middle, [light([150, 0, 9], 60)], everything);
      // Left of x 0 alone: the faces right of it keep what the last view left them, keyed unlit.
      expect(lit(vis, middle, [light([-50, 0, 0], 40)], everything)).toEqual([
        [2, 0],
        [3, 0],
        [1, 0],
        [0, 1]
      ]);
      expect(Array.from(vis.dlightBits)).toEqual([1, 1, 1, 1]);
      expect(vis.dlightSurfaces).toBe(1);
    });

    it('takes 32 lights, every bit of the mask, and no more', () => {
      const vis = visOf(row());
      const lights = Array.from({ length: 33 }, () => light([150, 0, 9], 60));
      lit(vis, middle, lights, everything);
      expect(vis.numLights).toBe(32);
      expect(vis.dlightBits[2]).toBe(-1);
      lit(vis, middle, lights.slice(0, 31), everything);
      expect(vis.dlightBits[2]).toBe(0x7fffffff);
    });

    it('takes each light in floats, as the scene keeps it', () => {
      const vis = visOf(row());
      lit(vis, middle, [light([150.1, 0, 9], 60.1)], everything);
      expect(Array.from(vis.lights.subarray(0, 4))).toEqual(
        [150.1, 0, 9, 60.1].map(Math.fround)
      );
    });

    it('tests a curve by its bounds, and keeps every light on a soup, which no test culls', () => {
      const soup = surface({ surfaceType: MST_TRIANGLE_SOUP, firstVert: 3 });
      const bsp = open([surface({ surfaceType: MST_PATCH }), soup], [0, 0, 0]);
      const grid = {
        meshBounds: [
          [0, 0, 0],
          [10, 10, 10]
        ] as [Vec3, Vec3],
        localOrigin: [5, 5, 5] as Vec3,
        meshRadius: 9
      };
      const vis = visOf(bsp, { grids: [grid, null] });
      // One reaching the curve's box at its edge, one half a unit short.
      lit(vis, at([0, 0, 0]), [light([20, 5, 5], 10), light([20, 5, 5], 9.5)], { nocull: true });
      expect(Array.from(vis.dlightBits)).toEqual([0b01, 0b11]);
      expect([vis.dlightSurfaces, vis.dlightSurfacesCulled]).toEqual([2, 0]);
      expect(lit(vis, at([0, 0, 0]), [light([20, 5, 5], 9.5)], { nocull: true })).toEqual([
        [0, 0],
        [1, 1]
      ]);
      expect([vis.dlightSurfaces, vis.dlightSurfacesCulled]).toEqual([1, 1]);
    });

    describe('a brush model', () => {
      /** The world's face, its plane z 0, then a model's facing +x, its plane x 0 in its frame. */
      const bsp = () =>
        open(
          [face(TWO_SIDED, 0), face(FRONT, 3, [1, 0, 0])],
          [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1],
          { models: [model(0, 1), { ...model(1, 1), mins: [-10, -10, -10], maxs: [10, 10, 10] }] }
        );
      /** At (100, 100, 0), turned to face the eye. */
      const placed = (): VisModel => ({ model: 1, origin: [100, 100, 0], angles: [0, 180, 0] });

      it("takes the lights about its bounds, then tests its faces by the first alone", () => {
        const vis = visOf(bsp(), { models: [placed()] });
        // The first light far off, though its plane is the model's face's; the second at it.
        const lights = [light([0, 0, 0], 50), light([100, 100, 0], 50)];
        expect(lit(vis, at([0, 0, 0], 45), lights)).toEqual([
          [0, 1],
          [1, 1]
        ]);
        expect(vis.dlightBits[1]).toBe(1);
        // Each light in the model's frame, for its passes, through its axes in floats.
        const frame = (l: number) =>
          Array.from(vis.modelLights.subarray((32 + l) * 3, (32 + l) * 3 + 3), (v) => v.toFixed(4));
        expect(frame(0)).toEqual(['100.0000', '100.0000', '0.0000']);
        expect(frame(1)).toEqual(['0.0000', '0.0000', '0.0000']);
      });

      it('takes a light whose radius just reaches its bounds', () => {
        const vis = visOf(bsp(), { models: [{ model: 1, origin: [0, 0, 0], angles: [0, 0, 0] }] });
        // 50 off its bounds' side at y 10, level with its face's plane, x 0.
        expect(lit(vis, at([0, 0, 0], 45), [light([0, 60, 0], 50)])[1]).toEqual([1, 1]);
      });

      it('takes none of a light at it while the first does not reach its faces', () => {
        const vis = visOf(bsp(), { models: [placed()] });
        const lights = [light([200, 0, 0], 50), light([100, 100, 0], 50)];
        expect(lit(vis, at([0, 0, 0], 45), lights)).toEqual([
          [0, 1],
          [1, 0]
        ]);
        expect(vis.dlightBits[1]).toBe(0);
        // No light near it: its faces' bits are all cleared, tested or not.
        vis.dlightBits[1] = 0b10;
        expect(lit(vis, at([0, 0, 0], 45), [light([0, 0, 500], 50)])).toEqual([
          [0, 0],
          [1, 0]
        ]);
        expect(vis.dlightBits[1]).toBe(0);
      });
    });
  });

  describe('the far plane', () => {
    it('is the farthest corner of the leafs reached', () => {
      const vis = visOf(open([face(TWO_SIDED, 0)], [0, 0, 0]));
      seen(vis, at([0, 0, 0]));
      expect(vis.zFar).toBeCloseTo(Math.sqrt(3) * 1000, 2);
      seen(vis, at([500, 0, 0]));
      expect(vis.zFar).toBeCloseTo(Math.hypot(1500, 1000, 1000), 2);
    });

    it('is the cleared bounds’ farthest corner where no leaf is reached', () => {
      const vis = visOf(row());
      // Past the map's end, looking away from it: the whole tree is behind the eye.
      expect(seen(vis, at([300, 0, 0]))).toEqual([]);
      expect(vis.leafs).toBe(0);
      expect(vis.zFar).toBeCloseTo(Math.hypot(99999 + 300, 99999, 99999), 0);
    });
  });
});
