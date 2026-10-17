import { describe, expect, it } from 'vitest';

import { MAX_POLYS, MAX_POLYVERTS, ScenePolys, polyVerts } from './scene-polys';

/** `n` points, each at (i, 0, 0), its coordinates (i, 2i) and its colour i a byte. */
function points(n: number) {
  const verts = polyVerts(n);
  for (let i = 0; i < n; i++) {
    verts.xyz[i * 3] = i;
    verts.st.set([i, 2 * i], i * 2);
    verts.modulate.fill(i, i * 4, i * 4 + 4);
  }
  return verts;
}

describe('ScenePolys, RE_AddPolyToScene', () => {
  it('copies each poly in, in the order added, its points one after another', () => {
    const polys = new ScenePolys<string>(() => {});
    const verts = points(6);
    polys.add('a', 3, verts, 0);
    polys.add('b', 3, verts, 3);
    expect([polys.count, polys.points]).toEqual([2, 6]);
    expect(polys.shaders.slice(0, 2)).toEqual(['a', 'b']);
    expect([...polys.firsts.subarray(0, 2)]).toEqual([0, 3]);
    expect([...polys.sizes.subarray(0, 2)]).toEqual([3, 3]);
    expect([...polys.verts.xyz.subarray(9, 12)]).toEqual([3, 0, 0]);
    expect([...polys.verts.st.subarray(6, 8)]).toEqual([3, 6]);
    expect([...polys.verts.modulate.subarray(12, 16)]).toEqual([3, 3, 3, 3]);
  });

  it('takes 600 polys a frame, and drops the rest until the next', () => {
    const polys = new ScenePolys<string>(() => {});
    const verts = points(3);
    for (let i = 0; i <= MAX_POLYS; i++) polys.add('a', 3, verts, 0);
    expect([polys.count, polys.dropped]).toEqual([MAX_POLYS, 1]);
    polys.begin();
    expect([polys.count, polys.points, polys.dropped]).toEqual([0, 0, 0]);
    polys.add('a', 3, verts, 0);
    expect(polys.count).toBe(1);
  });

  it('takes 3,000 points a frame, dropping a poly that would pass them', () => {
    const polys = new ScenePolys<string>(() => {});
    const verts = points(10);
    for (let i = 0; i < MAX_POLYVERTS / 10; i++) polys.add('a', 10, verts, 0);
    expect(polys.points).toBe(MAX_POLYVERTS);
    polys.add('a', 1, verts, 0);
    expect([polys.count, polys.dropped]).toEqual([MAX_POLYVERTS / 10, 1]);
  });

  it('warns of a poly with no shader, and takes it nowhere', () => {
    const warnings: string[] = [];
    const polys = new ScenePolys<string>((text) => warnings.push(text));
    polys.add(null, 3, points(3), 0);
    expect(polys.count).toBe(0);
    expect(warnings).toEqual(['WARNING: RE_AddPolyToScene: NULL poly shader\n']);
  });

  it("finds each poly's fog by its points' box, one only touching a fog's in it", () => {
    const polys = new ScenePolys<string>(() => {});
    const verts = points(4);
    // Points 0 to 3 along x.
    polys.add('a', 4, verts, 0);
    expect(polys.fogs[0]).toBe(0);
    polys.inWorld([
      { bounds: [[10, -1, -1], [20, 1, 1]] },
      { bounds: [[3, -1, -1], [5, 1, 1]] }
    ]);
    polys.add('a', 4, verts, 0);
    polys.add('a', 2, verts, 0);
    expect([...polys.fogs.subarray(1, 3)]).toEqual([2, 0]);
  });
});
