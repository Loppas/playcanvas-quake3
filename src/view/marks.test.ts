import { describe, expect, it } from 'vitest';

import { MAX_MARK_POLYS, Marks, type MarkScene } from './marks';
import type { PolyVerts } from './scene-polys';

type Vec3 = [number, number, number];

/** A poly as the scene was handed it. */
interface Added {
  shader: string;
  xyz: Vec3[];
  st: [number, number][];
  modulate: number[][];
}

/**
 * A renderer that cuts each polygon into the fragments it is given, or into the polygon itself,
 * and keeps what it is asked and handed.
 */
class Scene implements MarkScene<string> {
  fragments: Vec3[][] | null = null;
  readonly thrown: { points: number[]; projection: number[] }[] = [];
  readonly added: Added[] = [];

  markFragments(
    numPoints: number,
    points: ArrayLike<number>,
    projection: ArrayLike<number>,
    _maxPoints: number,
    pointBuffer: Float32Array,
    _maxFragments: number,
    fragmentBuffer: Int32Array
  ): number {
    const polygon = Array.from(points).slice(0, numPoints * 3);
    this.thrown.push({ points: polygon, projection: Array.from(projection) });
    const fragments = this.fragments ?? [
      Array.from({ length: numPoints }, (_, i) => polygon.slice(i * 3, i * 3 + 3) as Vec3)
    ];
    let at = 0;
    fragments.forEach((fragment, i) => {
      fragmentBuffer[i * 2] = at;
      fragmentBuffer[i * 2 + 1] = fragment.length;
      for (const point of fragment) pointBuffer.set(point, 3 * at++);
    });
    return fragments.length;
  }

  addPoly(shader: string, numVerts: number, verts: PolyVerts, first: number): void {
    const range = (n: number) => Array.from({ length: numVerts }, (_, i) => n * (first + i));
    this.added.push({
      shader,
      xyz: range(3).map((at) => [verts.xyz[at], verts.xyz[at + 1], verts.xyz[at + 2]]),
      st: range(2).map((at) => [verts.st[at], verts.st[at + 1]]),
      modulate: range(4).map((at) => Array.from(verts.modulate.subarray(at, at + 4)))
    });
  }

  /** What the scene was handed since last asked. */
  take(): Added[] {
    return this.added.splice(0);
  }
}

const UP = [0, 0, 1];

/** A mark of `radius` about the origin on a floor, unturned, in `shader`. */
function mark(
  marks: Marks<string>,
  time: number,
  { shader = 'burn', color = [1, 1, 1, 1], alphaFade = false, radius = 16, temporary = false } = {}
): void {
  const [red, green, blue, alpha] = color;
  const at = [0, 0, 0];
  marks.impactMark(shader, at, UP, 0, red, green, blue, alpha, alphaFade, radius, temporary, time);
}

describe('Marks, cg_marks.c', () => {
  it("throws a square of its radius about the impact, 20 units back along the normal", () => {
    const scene = new Scene();
    mark(new Marks(scene, 'energy'), 1000);
    // `VectorScale(dir, -20, …)`: −20 times 0 is −0.
    expect(scene.thrown).toEqual([
      { points: [-16, -16, 0, -16, 16, 0, 16, 16, 0, 16, -16, 0], projection: [-0, -0, -20] }
    ]);
  });

  it('keeps each fragment as a mark, its texture laid across the square, in its colour', () => {
    const scene = new Scene();
    const marks = new Marks(scene, 'energy');
    mark(marks, 1000, { color: [1, 0.5, 0, 1] });
    expect(marks.count).toBe(1);
    expect(scene.take()).toEqual([]);
    marks.addMarks(1000);
    const [added] = scene.take();
    expect(added.st).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1]
    ]);
    // 127.5 truncated, as C stores a float in a byte.
    expect(added.modulate[0]).toEqual([255, 127, 0, 255]);
  });

  it('hands a temporary mark, a shadow, to the scene at once, and keeps none of it', () => {
    const scene = new Scene();
    const marks = new Marks(scene, 'energy');
    mark(marks, 1000, { shader: 'shadow', temporary: true });
    expect(scene.take().map(({ shader }) => shader)).toEqual(['shadow']);
    expect(marks.count).toBe(0);
    marks.addMarks(1000);
    expect(scene.take()).toEqual([]);
  });

  it('keeps the first 10 points of a fragment', () => {
    const scene = new Scene();
    scene.fragments = [Array.from({ length: 12 }, (_, i): Vec3 => [i, 0, 0])];
    const marks = new Marks(scene, 'energy');
    mark(marks, 1000);
    marks.addMarks(1000);
    expect(scene.take()[0].xyz.map(([x]) => x)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('makes and adds nothing without cg_marks, the shadows among them', () => {
    const scene = new Scene();
    const marks = new Marks(scene, 'energy');
    mark(marks, 1000);
    marks.enabled = false;
    mark(marks, 1000);
    mark(marks, 1000, { temporary: true });
    marks.addMarks(1000);
    expect([scene.thrown.length, scene.take().length]).toEqual([1, 0]);
  });

  it('refuses a radius of 0 or less, in cgame\'s words', () => {
    expect(() => mark(new Marks(new Scene(), 'energy'), 1000, { radius: 0 })).toThrow(
      'CG_ImpactMark called with <= 0 radius'
    );
  });

  it('adds its marks newest first', () => {
    const scene = new Scene();
    const marks = new Marks(scene, 'energy');
    mark(marks, 1000, { shader: 'a' });
    mark(marks, 2000, { shader: 'b' });
    marks.addMarks(2000);
    expect(scene.take().map(({ shader }) => shader)).toEqual(['b', 'a']);
  });

  it('fades a mark over its last second, its colour or its alpha, and frees it past 10 s', () => {
    const scene = new Scene();
    const marks = new Marks(scene, 'energy');
    mark(marks, 1000, { shader: 'burn' });
    mark(marks, 1000, { shader: 'blood', alphaFade: true });
    marks.addMarks(10500);
    expect(scene.take().map(({ modulate }) => modulate[0])).toEqual([
      [255, 255, 255, 127],
      [127, 127, 127, 255]
    ]);
    // At its last moment it is still added, black or clear; a moment later it is gone.
    marks.addMarks(11000);
    expect(scene.take().map(({ modulate }) => modulate[0])).toEqual([
      [255, 255, 255, 0],
      [0, 0, 0, 255]
    ]);
    marks.addMarks(11001);
    expect([scene.take().length, marks.count]).toEqual([0, 0]);
  });

  it("cools an energy mark from 1.3 s to black at 3 s, while its first point's red holds", () => {
    const scene = new Scene();
    const marks = new Marks(scene, 'energy');
    mark(marks, 1000, { shader: 'energy', alphaFade: true });
    // A blue rail's: no red, so it never cools.
    mark(marks, 1000, { shader: 'energy', alphaFade: true, color: [0, 0, 1, 1] });
    const reds = (time: number) => {
      marks.addMarks(time);
      return scene.take().map(({ modulate }) => modulate[0]);
    };
    expect(reds(2000)).toEqual([
      [0, 0, 255, 255],
      [255, 255, 255, 255]
    ]);
    expect(reds(2500)[1]).toEqual([225, 225, 225, 255]);
    expect(reds(3000)[1]).toEqual([150, 150, 150, 255]);
    expect(reds(4000)[1]).toEqual([0, 0, 0, 255]);
    expect(reds(4500)).toEqual([
      [0, 0, 255, 255],
      [0, 0, 0, 255]
    ]);
  });

  it('frees every mark made at the oldest time once all 256 are kept', () => {
    const scene = new Scene();
    scene.fragments = [
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0]
      ],
      [
        [0, 0, 1],
        [1, 0, 1],
        [0, 1, 1]
      ]
    ];
    const marks = new Marks(scene, 'energy');
    for (let time = 1; time <= MAX_MARK_POLYS / 2; time++) mark(marks, time, { shader: `${time}` });
    expect(marks.count).toBe(MAX_MARK_POLYS);
    scene.fragments = [scene.fragments[0]];
    mark(marks, 1000, { shader: 'new' });
    expect(marks.count).toBe(MAX_MARK_POLYS - 1);
    marks.addMarks(1000);
    const shaders = scene.take().map(({ shader }) => shader);
    expect(shaders.slice(0, 3)).toEqual(['new', '128', '128']);
    expect(shaders.slice(-2)).toEqual(['2', '2']);
  });

  it('lets every mark go, as a map or a restart starts', () => {
    const marks = new Marks(new Scene(), 'energy');
    mark(marks, 1000);
    marks.clear();
    expect(marks.count).toBe(0);
  });
});
