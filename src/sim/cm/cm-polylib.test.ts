import { describe, expect, it } from 'vitest';

import { Digest, Seeded } from './collision-test-fixtures';
import {
  baseWindingForPlane,
  chopWindingInPlace,
  copyWinding,
  windingBounds,
  type Winding
} from './cm-polylib';
import { f, vec3f, vectorClear, vectorNormalize } from './q-math';

/**
 * The twin's digest (scratchpad `m0/twin.c`, `qmath`, seed 7): ioquake3's own `cm_polylib.c`,
 * a base winding on each of 2,000 planes, a fifth of them axial, chopped by another plane, a
 * seventh of those axial, and the bounds of what was left.
 */
const TWIN_WINDINGS = 'faaa5f3b';

/** Adds a winding's points to a digest. */
function addWinding(digest: Digest, w: Winding): void {
  digest.int(w.numpoints);
  for (let i = 0; i < w.numpoints; i++) digest.float(w.p[i][0]).float(w.p[i][1]).float(w.p[i][2]);
}

describe("the polylib's windings", () => {
  it('makes and chops windings as C does, to the bit', () => {
    const r = new Seeded(7);
    const digest = new Digest();
    for (let i = 0; i < 2000; i++) {
      const normal = r.vec(1 << 16);
      if (i % 5 === 0) {
        vectorClear(normal);
        normal[i % 3] = i & 8 ? -1 : 1;
      }
      vectorNormalize(normal);
      const dist = r.coord(1 << 18);
      const base = baseWindingForPlane(normal, dist);
      addWinding(digest, base);

      const n2 = r.vec(1 << 16);
      if (i % 7 === 0) {
        vectorClear(n2);
        n2[(i + 1) % 3] = i & 16 ? -1 : 1;
      }
      vectorNormalize(n2);
      const w = chopWindingInPlace(base, n2, r.coord(1 << 18), f(0.1));
      if (!w) {
        digest.int(-1);
        continue;
      }
      addWinding(digest, w);
      const mins = vec3f();
      const maxs = vec3f();
      windingBounds(w, mins, maxs);
      for (const v of [...mins, ...maxs]) digest.float(v);
    }
    expect(digest.hex()).toBe(TWIN_WINDINGS);
  });

  it('makes a square on the plane, 65535 from its middle to each side', () => {
    const w = baseWindingForPlane([0, 0, 1], 16);
    expect(w.numpoints).toBe(4);
    expect(w.p).toEqual([
      [65535, 65535, 16],
      [65535, -65535, 16],
      [-65535, -65535, 16],
      [-65535, 65535, 16]
    ]);
  });

  it("keeps a winding wholly in front, drops one wholly behind, and splits one across", () => {
    const square = () => baseWindingForPlane([0, 0, 1], 0);
    const front = square();
    expect(chopWindingInPlace(front, [1, 0, 0], -70000, f(0.1))).toBe(front);
    expect(chopWindingInPlace(square(), [1, 0, 0], 70000, f(0.1))).toBeNull();

    const half = chopWindingInPlace(square(), [1, 0, 0], 100, f(0.1))!;
    expect(half.p.slice(0, half.numpoints)).toEqual([
      [65535, 65535, 0],
      [65535, -65535, 0],
      [100, -65535, 0],
      [100, 65535, 0]
    ]);
  });

  it('takes a point exactly the epsilon in front as on the plane, not in front of it', () => {
    const tri: Winding = {
      numpoints: 3,
      p: [vec3f(0, f(0.1), 0), vec3f(5, -10, 0), vec3f(10, 10, 0)]
    };
    // On, behind, in front: one split, between the second point and the third.
    const chopped = chopWindingInPlace(copyWinding(tri), [0, 1, 0], 0, f(0.1))!;
    expect(chopped.numpoints).toBe(3);
    expect(chopped.p[0]).toEqual([0, f(0.1), 0]);
    expect(chopped.p[2]).toEqual([10, 10, 0]);
  });

  it('keeps a point within the epsilon of the plane where it is, and splits nothing at it', () => {
    const diamond: Winding = {
      numpoints: 4,
      p: [vec3f(0, 0, 0), vec3f(5, -10, 0), vec3f(10, f(0.05), 0), vec3f(5, 10, 0)]
    };
    const kept = chopWindingInPlace(copyWinding(diamond), [0, 1, 0], 0, f(0.1))!;
    expect(kept.p.slice(0, kept.numpoints)).toEqual([
      [0, 0, 0],
      [10, f(0.05), 0],
      [5, 10, 0]
    ]);
  });
});
