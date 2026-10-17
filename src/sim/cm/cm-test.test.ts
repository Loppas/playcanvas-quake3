import { describe, expect, it } from 'vitest';

import { CONTENTS } from '../constants';
import { clipBsp } from './collision-test-fixtures';
import { BOX_MODEL_HANDLE } from './cm-local';
import { loadMap, tempBoxModel } from './cm-load';
import {
  adjustAreaPortalState,
  areasConnected,
  boundsIntersect,
  boundsIntersectPoint,
  boxLeafnums,
  clusterPVS,
  floodAreaConnections,
  pointContents,
  pointLeafnum,
  transformedPointContents,
  writeAreaBits
} from './cm-test';

/** The test map's clip map: three areas, 0, 1 and 2, no portal open. */
function threeAreas() {
  return loadMap(clipBsp(), 'maps/test.bsp');
}

/** The test map with its node's two sides leaf 2 and leaf 1, so a leaf with a cluster is first. */
function frontCluster() {
  const node = { ...clipBsp().nodes[0], children: [-3, -2] as [number, number] };
  return loadMap(clipBsp({ nodes: [node] }), 'maps/test.bsp');
}

describe('the leaves', () => {
  it("finds a point's leaf down the tree, a point on a plane in front of it", () => {
    const cm = threeAreas();
    expect(pointLeafnum(cm, [0, 0, 100])).toBe(0);
    expect(pointLeafnum(cm, [0, 0, 64])).toBe(0);
    expect(pointLeafnum(cm, [0, 0, 64 - 1e-12])).toBe(0);
    expect(pointLeafnum(cm, [0, 0, 63.99])).toBe(1);
  });

  it('lists the leaves a box touches, front first, and the last of them with a cluster', () => {
    const list = new Int32Array(4).fill(-9);
    const lastLeaf = { value: -9 };
    const cm = threeAreas();
    expect(boxLeafnums(cm, [0, 0, 60], [0, 0, 70], list, 4, lastLeaf)).toBe(2);
    expect(Array.from(list)).toEqual([0, 1, -9, -9]);
    expect(lastLeaf.value).toBe(0);
    expect(boxLeafnums(cm, [0, 0, 0], [0, 0, 64], list, 4, lastLeaf)).toBe(1);
    expect(list[0]).toBe(1);
    expect(lastLeaf.value).toBe(0);
  });

  it('keeps the last leaf with a cluster when the list is full', () => {
    const cm = frontCluster();
    const lastLeaf = { value: -9 };
    expect(boxLeafnums(cm, [0, 0, 60], [0, 0, 70], new Int32Array(0), 0, lastLeaf)).toBe(0);
    expect(lastLeaf.value).toBe(2);
    expect(cm.leafList.overflowed).toBe(true);
  });

  it("refuses a list shorter than the room it is said to have, in the port's words", () => {
    expect(() =>
      boxLeafnums(threeAreas(), [0, 0, 0], [0, 0, 1], new Int32Array(1), 2, { value: 0 })
    ).toThrow('CM_BoxLeafnums: a list of 1 given room for 2');
  });

  it("gives a cluster's row of the visibility, and the first row for any other", () => {
    const data = Uint8Array.of(0b01, 0b11);
    const cm = loadMap(
      clipBsp({ visibility: { numClusters: 2, clusterBytes: 1, data } }),
      'maps/test.bsp'
    );
    expect([clusterPVS(cm, 0), clusterPVS(cm, 1)]).toEqual([0, 1]);
    expect([clusterPVS(cm, -1), clusterPVS(cm, 2)]).toEqual([0, 0]);
    expect(clusterPVS(threeAreas(), 1)).toBe(0);
  });
});

describe('the contents at a point', () => {
  it("OR's the contents of each brush of the point's leaf that holds it, its sides included", () => {
    const cm = threeAreas();
    expect(pointContents(cm, [0, 0, 64], 0)).toBe(CONTENTS.SOLID);
    expect(pointContents(cm, [64, 64, 64], 0)).toBe(CONTENTS.SOLID);
    expect(pointContents(cm, [0, 0, 64.0625], 0)).toBe(0);
    // Leaf 1, below, lists no brush.
    expect(pointContents(cm, [0, 0, 0], 0)).toBe(0);
  });

  it("takes a model's own leaf, its patches left out", () => {
    const cm = threeAreas();
    expect(pointContents(cm, [16, 16, 0], 1)).toBe(CONTENTS.WATER);
    expect(pointContents(cm, [16, 16, 100], 1)).toBe(0);
    tempBoxModel(cm, [-8, -8, -8], [8, 8, 8]);
    expect(pointContents(cm, [8, 0, 0], BOX_MODEL_HANDLE)).toBe(CONTENTS.BODY);
  });

  it('takes the point into a moved and turned model, the box never turned', () => {
    const cm = threeAreas();
    expect(transformedPointContents(cm, [1100, 0, 0], 1, [1000, 0, 0], [0, 0, 0])).toBe(0);
    expect(transformedPointContents(cm, [1060, 0, 0], 1, [1000, 0, 0], [0, 0, 0])).toBe(
      CONTENTS.WATER
    );
    // Turned 45°, the cube's corner reaches 90 along x.
    expect(transformedPointContents(cm, [1080, 0, 0], 1, [1000, 0, 0], [0, 45, 0])).toBe(
      CONTENTS.WATER
    );
    tempBoxModel(cm, [-8, -8, -8], [8, 8, 8]);
    expect(transformedPointContents(cm, [11, 0, 0], BOX_MODEL_HANDLE, [0, 0, 0], [0, 45, 0])).toBe(
      0
    );
  });
});

describe('the slack bounds tests', () => {
  it('count boxes and points within SURFACE_CLIP_EPSILON as touching, on each side of each axis', () => {
    const lo = [0, 0, 0];
    const hi = [8, 8, 8];
    for (let axis = 0; axis < 3; axis++) {
      const at = (v: number, rest: number) => [0, 1, 2].map((i) => (i === axis ? v : rest));
      // A box past the far side, then one before the near side.
      expect(boundsIntersect(lo, hi, at(8.125, 0), at(9, 8))).toBe(true);
      expect(boundsIntersect(lo, hi, at(8.25, 0), at(9, 8))).toBe(false);
      expect(boundsIntersect(lo, hi, at(-9, 0), at(-0.125, 8))).toBe(true);
      expect(boundsIntersect(lo, hi, at(-9, 0), at(-0.25, 8))).toBe(false);
      expect(boundsIntersectPoint(lo, hi, at(8.125, 4))).toBe(true);
      expect(boundsIntersectPoint(lo, hi, at(8.25, 4))).toBe(false);
      expect(boundsIntersectPoint(lo, hi, at(-0.125, 4))).toBe(true);
      expect(boundsIntersectPoint(lo, hi, at(-0.25, 4))).toBe(false);
    }
  });
});

describe('the area portals', () => {
  it('joins two areas while the portal between them is open', () => {
    const cm = threeAreas();
    expect(areasConnected(cm, 0, 2)).toBe(false);
    adjustAreaPortalState(cm, 0, 2, true);
    expect(areasConnected(cm, 0, 2)).toBe(true);
    expect(areasConnected(cm, 2, 0)).toBe(true);
    expect(areasConnected(cm, 0, 1)).toBe(false);
    adjustAreaPortalState(cm, 0, 2, false);
    expect(areasConnected(cm, 0, 2)).toBe(false);
  });

  it('keeps a portal open until it is closed as often as it was opened', () => {
    const cm = threeAreas();
    adjustAreaPortalState(cm, 1, 2, true);
    adjustAreaPortalState(cm, 1, 2, true);
    adjustAreaPortalState(cm, 1, 2, false);
    expect(areasConnected(cm, 1, 2)).toBe(true);
    adjustAreaPortalState(cm, 1, 2, false);
    expect(areasConnected(cm, 1, 2)).toBe(false);
  });

  it('joins areas through a chain of open portals, each flood numbered in area order', () => {
    const cm = threeAreas();
    adjustAreaPortalState(cm, 0, 1, true);
    adjustAreaPortalState(cm, 1, 2, true);
    expect(areasConnected(cm, 0, 2)).toBe(true);
    expect(cm.areas.map((area) => area.floodnum)).toEqual([1, 1, 1]);
    adjustAreaPortalState(cm, 0, 1, false);
    expect(cm.areas.map((area) => area.floodnum)).toEqual([1, 2, 2]);
    expect(cm.floodvalid).toBe(4);
  });

  it('leaves an area of −1, outside the world, out', () => {
    const cm = threeAreas();
    adjustAreaPortalState(cm, -1, 0, true);
    adjustAreaPortalState(cm, 0, -1, true);
    expect(cm.floodvalid).toBe(1);
    expect(Array.from(cm.areaPortals)).toEqual(new Array(9).fill(0));
    expect(areasConnected(cm, -1, 0)).toBe(false);
    expect(areasConnected(cm, 0, -1)).toBe(false);
  });

  it("refuses a portal closed more than opened, and an area the map has not got, in Q3's words", () => {
    const cm = threeAreas();
    expect(() => adjustAreaPortalState(cm, 0, 1, false)).toThrow(
      'CM_AdjustAreaPortalState: negative reference count'
    );
    expect(() => adjustAreaPortalState(cm, 0, 3, true)).toThrow(
      'CM_ChangeAreaPortalState: bad area number'
    );
    expect(() => areasConnected(cm, 3, 0)).toThrow('area >= cm.numAreas');
  });

  it("refuses an area a flood reaches that another flood already took, in Q3's words", () => {
    // Only a portal open one way round can do it, which adjustAreaPortalState never leaves.
    const cm = threeAreas();
    cm.areaPortals[2 * 3 + 1] = 1;
    expect(() => floodAreaConnections(cm)).toThrow('FloodArea_r: reflooded');
  });

  it("OR's a bit into the buffer for each area in the area's flood", () => {
    const cm = threeAreas();
    adjustAreaPortalState(cm, 0, 2, true);
    const buffer = Uint8Array.of(0b010, 0x40);
    expect(writeAreaBits(cm, buffer, 0)).toBe(1);
    expect(Array.from(buffer)).toEqual([0b111, 0x40]);
    expect(Array.from(writeBits(cm, 1))).toEqual([0b010, 0]);
  });

  it('sets every bit, and only the bytes the areas take, for an area of −1', () => {
    const nine = loadMap(
      clipBsp({ leafs: [{ ...clipBsp().leafs[0], area: 8 }, ...clipBsp().leafs.slice(1)] }),
      'maps/test.bsp'
    );
    expect(nine.numAreas).toBe(9);
    const buffer = new Uint8Array(3);
    expect(writeAreaBits(nine, buffer, -1)).toBe(2);
    expect(Array.from(buffer)).toEqual([255, 255, 0]);
  });

  it('takes a byte for each eight areas, rounding up', () => {
    const eight = loadMap(
      clipBsp({ leafs: [{ ...clipBsp().leafs[0], area: 7 }, ...clipBsp().leafs.slice(1)] }),
      'maps/test.bsp'
    );
    expect(eight.numAreas).toBe(8);
    const buffer = new Uint8Array(2);
    expect(writeAreaBits(eight, buffer, -1)).toBe(1);
    expect(Array.from(buffer)).toEqual([255, 0]);
  });

  it("refuses an area the map has not got, in the port's words", () => {
    expect(() => writeAreaBits(threeAreas(), new Uint8Array(1), 3)).toThrow(
      "CM_WriteAreaBits: area 3 is not one of the map's 3"
    );
  });

  it('joins every area under cm_noAreas, and sets every bit', () => {
    const cm = threeAreas();
    cm.cvars.noAreas = 1;
    expect(areasConnected(cm, 0, 1)).toBe(true);
    expect(areasConnected(cm, -1, 2)).toBe(true);
    expect(Array.from(writeBits(cm, 0))).toEqual([255, 0]);
    expect(Array.from(writeBits(cm, 7))).toEqual([255, 0]);
  });
});

/** An area's bits, written into a fresh two-byte buffer. */
function writeBits(cm: ReturnType<typeof threeAreas>, area: number): Uint8Array {
  const buffer = new Uint8Array(2);
  writeAreaBits(cm, buffer, area);
  return buffer;
}
