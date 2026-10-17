import { describe, expect, it } from 'vitest';

import { Digest, Seeded } from './collision-test-fixtures';
import {
  PLANE_NON_AXIAL,
  PLANE_Y,
  angleVectors,
  boxOnPlaneSide,
  crossProduct,
  dotProduct,
  f,
  matrixMultiply,
  perpendicularVector,
  planeTypeForNormal,
  projectPointOnPlane,
  qvmRotatePointAroundVector,
  signbitsForNormal,
  vec3f,
  vectorAdd,
  vectorClear,
  vectorLength,
  vectorMA,
  vectorNegate,
  vectorNormalize,
  vectorNormalize2,
  vectorScale,
  vectorSubtract,
  type Matrix3f,
  type Vec3f
} from './q-math';

/**
 * The twin's digests (scratchpad `m0/twin.c`, `qmath`): ioquake3's own `q_shared.h` and
 * `q_math.c`, compiled, over the inputs `Seeded` makes from each seed. `M_PI` is `math.h`'s
 * double, as a gcc or clang build has it; MSVC has no `M_PI` unasked, and takes `q_shared.h`'s
 * float instead, which turns angles differently.
 */
const TWIN = {
  dot: '0b926f65',
  cross: '56606915',
  normalize: 'e844e878',
  ma: '78b500ff',
  angles: '58fbe78d',
  box: '42acc3b5'
};

/** Adds three floats to a digest. */
function vec(digest: Digest, v: ArrayLike<number>): void {
  digest.float(v[0]).float(v[1]).float(v[2]);
}

describe("collision's float arithmetic, against the twin", () => {
  it('takes dot products as C does, each product and sum a float', () => {
    const r = new Seeded(1);
    const digest = new Digest();
    for (let i = 0; i < 4000; i++) {
      const a = r.vec(1 << 20);
      const b = r.vec(1 << 20);
      digest.float(dotProduct(a, b));
    }
    expect(digest.hex()).toBe(TWIN.dot);
  });

  it('takes cross products as C does', () => {
    const r = new Seeded(2);
    const digest = new Digest();
    const c = vec3f();
    for (let i = 0; i < 4000; i++) {
      crossProduct(r.vec(1 << 20), r.vec(1 << 20), c);
      vec(digest, c);
    }
    expect(digest.hex()).toBe(TWIN.cross);
  });

  it("normalizes as ioquake3 does, by the inverse root, and measures as C does", () => {
    const r = new Seeded(3);
    const digest = new Digest();
    for (let i = 0; i < 4000; i++) {
      let a = r.vec(1 << 18);
      if (i % 100 === 0) vectorClear(a);
      digest.float(vectorNormalize(a));
      vec(digest, a);
      a = r.vec(1 << 18);
      if (i % 100 === 0) vectorClear(a);
      const b = vec3f(7, 7, 7);
      digest.float(vectorNormalize2(a, b));
      vec(digest, b);
      digest.float(vectorLength(a));
    }
    expect(digest.hex()).toBe(TWIN.normalize);
  });

  it('scales, adds and subtracts as C does', () => {
    const r = new Seeded(4);
    const digest = new Digest();
    const c = vec3f();
    for (let i = 0; i < 4000; i++) {
      const a = r.vec(1 << 20);
      const b = r.vec(1 << 16);
      const s = r.coord(1 << 12);
      vectorMA(a, s, b, c);
      vec(digest, c);
      vectorScale(b, s, c);
      vec(digest, c);
      vectorSubtract(a, b, c);
      vec(digest, c);
      vectorAdd(a, b, c);
      vec(digest, c);
    }
    expect(digest.hex()).toBe(TWIN.ma);
  });

  it('turns angles into axes as C does, roll included', () => {
    const r = new Seeded(5);
    const digest = new Digest();
    const forward = vec3f();
    const right = vec3f();
    const up = vec3f();
    for (let i = 0; i < 4000; i++) {
      const pitch = r.coord(360 * 16) * 16;
      const yaw = r.coord(360 * 16) * 16;
      const roll = i & 1 ? 0 : r.coord(360 * 16) * 16;
      angleVectors([pitch, yaw, roll], forward, right, up);
      vec(digest, forward);
      vec(digest, right);
      vec(digest, up);
    }
    expect(digest.hex()).toBe(TWIN.angles);
  });

  it("puts a box on a plane's sides as C does, axial and slanted", () => {
    const r = new Seeded(6);
    const digest = new Digest();
    for (let i = 0; i < 4000; i++) {
      let normal: Vec3f;
      if (i % 4 === 0) {
        normal = vec3f();
        normal[i % 3] = 1;
      } else {
        normal = r.vec(1 << 16);
        vectorNormalize(normal);
      }
      const dist = r.coord(1 << 18);
      const plane = {
        normal,
        dist,
        type: planeTypeForNormal(normal),
        signbits: signbitsForNormal(normal)
      };
      const a = r.vec(1 << 18);
      const b = r.vec(1 << 18);
      const mins = [0, 1, 2].map((k) => Math.min(a[k], b[k]));
      const maxs = [0, 1, 2].map((k) => Math.max(a[k], b[k]));
      digest.int(boxOnPlaneSide(mins, maxs, plane));
    }
    expect(digest.hex()).toBe(TWIN.box);
  });
});

describe("collision's float arithmetic, read", () => {
  it('rounds each operation to a float, where doubles would not', () => {
    // 2^24 + 1 is not a float: the product rounds before the sum.
    expect(dotProduct([4097, 0, 1], [4097, 0, 0])).toBe(f(4097 * 4097));
    expect(dotProduct([4097, 0, 1], [4097, 0, 0])).not.toBe(4097 * 4097);
  });

  it('types a plane axial only for a normal of exactly +1', () => {
    expect(planeTypeForNormal([0, 1, 0])).toBe(PLANE_Y);
    expect(planeTypeForNormal([0, -1, 0])).toBe(PLANE_NON_AXIAL);
    expect(planeTypeForNormal([0, f(0.99999994), 0])).toBe(PLANE_NON_AXIAL);
    expect(signbitsForNormal([-1, 0, -0.5])).toBe(5);
    expect(signbitsForNormal([-0, 0, 0])).toBe(0);
  });

  it('negates to −0, where subtracting from zero gives +0', () => {
    const negated = vec3f();
    vectorNegate([0, 1, 0], negated);
    expect(Object.is(negated[0], -0)).toBe(true);
    const subtracted = vec3f();
    vectorSubtract([0, 0, 0], [0, 1, 0], subtracted);
    expect(Object.is(subtracted[0], 0)).toBe(true);
  });

  it('leaves a zero vector as it is, its length 0', () => {
    const v = vec3f();
    expect(vectorNormalize(v)).toBe(0);
    expect(v).toEqual([0, 0, 0]);
  });

  it("counts a box touching an axial plane as on the plane's side it lies", () => {
    const plane = { normal: [0, 0, 1], dist: 10, type: 2, signbits: 0 };
    expect(boxOnPlaneSide([0, 0, 10], [1, 1, 20], plane)).toBe(1);
    expect(boxOnPlaneSide([0, 0, 0], [1, 1, 10], plane)).toBe(2);
    expect(boxOnPlaneSide([0, 0, 0], [1, 1, 11], plane)).toBe(3);
  });

  it("counts a box touching a slanted plane as in front, by its corners' distances", () => {
    // The box hull's −x plane is typed slanted: its nearest corner, at x = −10, is on it.
    const minusX = { normal: [-1, 0, 0], dist: 10, type: 3, signbits: 1 };
    expect(boxOnPlaneSide([-10, 0, 0], [-5, 1, 1], minusX)).toBe(3);
    expect(boxOnPlaneSide([-15, 0, 0], [-10, 1, 1], minusX)).toBe(1);
  });
});

describe('PerpendicularVector, against the twin of the QVM', () => {
  // Scratchpad `m3c/twin.c`: ioquake3's `q_math.c` in q3lcc's floats, compiled and printed.
  it.each([
    [[1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 0, -1], [1, 0, 0], [-0, 1, 0]],
    [[f(0.6), f(0.8), 0], [0, 0, 1], [-0.80000001192092896, 0.60000002384185791, 0]],
    [
      [f(0.267261), f(-0.534522), f(0.801784)],
      [0.96362411975860596, 0.14824964106082916, -0.22237473726272583],
      [0, -0.83205044269561768, -0.55469965934753418]
    ]
  ])('of %j is %j, and its cross product with it %j', (src, up, right) => {
    const perpendicular = vec3f();
    perpendicularVector(perpendicular, src);
    expect(perpendicular).toEqual(up);
    const across = vec3f();
    crossProduct(perpendicular, src, across);
    expect(across.map((v) => (Object.is(v, -0) ? 'minus zero' : v))).toEqual(
      right.map((v) => (Object.is(v, -0) ? 'minus zero' : v))
    );
  });

  it('projects onto the plane of a unit normal, and wrongly for any other length', () => {
    const projected = vec3f();
    projectPointOnPlane(projected, [1, 0, 0], [1, 0, 0]);
    expect(projected).toEqual([0, 0, 0]);
    projectPointOnPlane(projected, [0, 1, 0], [1, 0, 0]);
    expect(projected).toEqual([0, 1, 0]);
    // The projection would be 0; C's takes off a quarter of it.
    projectPointOnPlane(projected, [1, 0, 0], [2, 0, 0]);
    expect(projected).toEqual([0.75, 0, 0]);
  });
});

describe('RotatePointAroundVector, against the twin of the QVM', () => {
  // Scratchpad `m6f/c_twin/rot.c`: ioquake3's `q_math.c` with q_shared.h's float `M_PI`, as
  // cgame's QVM folds `DEG2RAD`, against the native build's double, printed where the two part.
  const axis = vec3f();
  vectorNormalize2([1, 2, 3], axis);
  const point = vec3f();
  perpendicularVector(point, axis);

  it('turns a point about an axis by the QVM’s float π', () => {
    expect(axis).toEqual([f(0.267261237), f(0.534522474), f(0.801783681)]);
    expect(point).toEqual([f(0.96362412), f(-0.148249879), f(-0.222374842)]);
    const turned = vec3f();
    // Where the native build's double π puts y at −0.00151363667.
    qvmRotatePointAroundVector(turned, axis, point, 10);
    expect(turned).toEqual([f(0.948984444), f(-0.00151362177), f(-0.31531921)]);
    qvmRotatePointAroundVector(turned, axis, point, 17);
    expect(turned).toEqual([f(0.921518326), f(0.101495899), f(-0.374836802)]);
  });

  it('multiplies matrices in floats, each row by each column in order', () => {
    const out: Matrix3f = [vec3f(), vec3f(), vec3f()];
    matrixMultiply(
      [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9]
      ],
      [
        [1, 0, 0],
        [0, 0.1, 0],
        [0, 0, 1]
      ],
      out
    );
    expect(out).toEqual([
      [1, f(2 * f(0.1)), 3],
      [4, f(5 * f(0.1)), 6],
      [7, f(8 * f(0.1)), 9]
    ]);
  });
});
