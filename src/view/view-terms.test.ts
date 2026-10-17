import { describe, expect, it } from 'vitest';

import { MST_PATCH, MST_PLANAR, MST_TRIANGLE_SOUP } from '../formats/bsp';
import {
  batchNormals,
  environmentCoordinates,
  eyeInFrame,
  portalAlphaByte,
  qRsqrt,
  specularAlphaByte,
  vectorCoordinates
} from './view-terms';
import { surface, testBsp } from './world-test-fixtures';

/*
 * The expected values are ioquake3's own: its functions, copied from renderergl1 and q_math.c and
 * compiled for x64, run over the same inputs.
 */

const f = Math.fround;

/** The twin's seeded inputs: a linear congruential generator, its floats a 256th of a unit apart. */
function seeded() {
  let state = 12345;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 8;
  };
  return {
    coordinate: () => ((next() % 2000001) - 1000000) / 256,
    component: () => ((next() % 513) - 256) / 256
  };
}

/** The twin's batch: 4,096 vertexes and normals, the eye, and the portal's eye beside the first. */
function seededBatch() {
  const { coordinate, component } = seeded();
  const n = 4096;
  const xyz: number[][] = [];
  const normals: number[][] = [];
  for (let i = 0; i < n; i++) {
    xyz.push([coordinate() / 4, coordinate() / 4, coordinate() / 4]);
    normals.push([component(), component(), component()]);
  }
  const eye = [coordinate() / 4, coordinate() / 4, coordinate() / 4];
  const portalEye = [f(xyz[0][0] + 100), xyz[0][1], xyz[0][2]];
  // The portal's vertexes about its eye, which the vector's coordinates read too.
  const around = Array.from({ length: n }, () => portalEye.map((axis) => f(axis + f(component() * 300))));
  return { xyz, normals, eye, portalEye, around };
}

describe('qRsqrt (Q_rsqrt)', () => {
  it("is the float's bits' guess with one step of Newton's method, a little under the root", () => {
    expect([1, 4, 2, 0.01, 1e6].map((x) => qRsqrt(f(x)))).toEqual(
      [0.998307168, 0.499153584, 0.706930041, 9.98252201, 0.000998304575].map(f)
    );
  });
});

describe("the view's terms, against ioquake3's", () => {
  const batch = seededBatch();

  it('reflects the eye in the normal for tcGen environment, reading its y and z', () => {
    const st = batch.xyz.map((xyz, i) => environmentCoordinates(xyz, batch.normals[i], batch.eye));
    expect(st.slice(0, 3)).toEqual(
      [
        [0.343975782, 0.139664054],
        [0.486843079, 0.944769681],
        [0.189042509, 0.480446875]
      ].map((pair) => pair.map(f))
    );
    expect(st.reduce((sum, [s, t]) => sum + s + 3 * t, 0)).toBe(8926.8010454773903);
  });

  it("takes the fixed light's highlight to the fourth power as a byte, Q_rsqrt's", () => {
    const bytes = batch.xyz.map((xyz, i) => specularAlphaByte(xyz, batch.normals[i], batch.eye));
    expect(bytes.reduce((sum, b) => sum + b, 0)).toBe(106907);
    expect(bytes.filter((b) => b > 0)).toHaveLength(891);
    expect([15, 17, 19, 26].map((i) => bytes[i])).toEqual([60, 2, 13, 87]);
    // Where an exact root gives 77, 172, 213 and 250.
    expect([37, 44, 100, 190].map((i) => bytes[i])).toEqual([76, 171, 211, 248]);
  });

  it("takes a portal's alpha from the distance over its range, 255 beyond it", () => {
    const bytes = batch.around.map((xyz) => portalAlphaByte(xyz, batch.portalEye, 256));
    expect(bytes.reduce((sum, b) => sum + b, 0)).toBe(960647);
    expect(bytes.filter((b) => b > 0 && b < 255)).toHaveLength(1311);
  });

  it("dots the vertex with each of tcGen vector's vectors", () => {
    const vectors = [
      [0.125, -0.5, 0.0078125],
      [0, 0.25, -0.375]
    ] as const;
    const sum = batch.around.reduce((total, xyz) => {
      const [s, t] = vectorCoordinates(xyz, vectors);
      return total + s + 3 * t;
    }, 0);
    expect(sum).toBe(-1508569.7638397217);
  });

  it.each([
    [[0, 0, 0], [0, 0, 1], [100, 50, 200], [0.390917122, 0.0636684895], 0, 228],
    [[512, -256, 64], [1, 0, 0], [640, -200, 90], [0.30299294, 0.591467559], 0, 141],
    [[-960, 1900, 0], [0, 0.70710678, 0.70710678], [-900, 1700, 300], [0.910228908, 0.773485899], 0, 255],
    [[1000, 1000, 100], [0, -1, 0], [1000, 900, 120], [0.0105632544, 0.597887337], 0, 101],
    [[37.5, -12.25, 8], [0.6, 0, 0.8], [400, 60, 300], [0.423310101, 0.0438303351], 0, 255],
    [[-300, 2000, 96], [1, 0, 0], [300, 1980, 96], [0.516644061, 0.5], 0, 255]
  ])('at %j, normal %j, eye %j', (xyz, normal, eye, st, specular, portal) => {
    const [p, n, e] = [xyz, normal, eye].map((v) => v.map(f));
    expect(environmentCoordinates(p, n, e)).toEqual(st.map(f));
    expect(specularAlphaByte(p, n, e)).toBe(specular);
    expect(portalAlphaByte(p, e, 256)).toBe(portal);
  });

  it("finds the eye in a brush model's frame along its axes", () => {
    const out = [0, 0, 0];
    const frame = {
      origin: [64, -32, 16],
      axis: [
        [0, 1, 0],
        [-1, 0, 0],
        [0, 0, 1]
      ]
    } as const;
    eyeInFrame([300.5, 200.25, 50], frame, out);
    expect(out).toEqual([232.25, -236.5, 34]);
  });
});

describe('batchNormals', () => {
  it("gives a planar face's vertexes its plane, and every other vertex its own", () => {
    const own = [0, 0.6, 0.8];
    const bsp = testBsp({
      surfaces: [
        surface({ surfaceType: MST_PLANAR, firstVert: 0, numVerts: 3, lightmapVecs: [[0, 0, 0], [0, 0, 0], [1, 0, 0]] }),
        surface({ surfaceType: MST_TRIANGLE_SOUP, firstVert: 3, numVerts: 3 }),
        surface({ surfaceType: MST_PATCH, firstVert: 6, numVerts: 3 })
      ]
    });
    bsp.drawVerts.normal.set(Array.from({ length: 9 }, () => own).flat());
    const normals = batchNormals(bsp);
    expect([...normals.subarray(0, 9)]).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    expect([...normals.subarray(9)]).toEqual([...bsp.drawVerts.normal.subarray(9)]);
    // The BSP's own are left as they are.
    expect([...bsp.drawVerts.normal.subarray(0, 3)]).toEqual(own.map(f));
  });
});
