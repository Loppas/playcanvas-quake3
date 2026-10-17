import { describe, expect, it } from 'vitest';

import type { Deform, Wave } from '../formats/shader-script';
import { latticeNoise, noise4 } from './noise';
import {
  autosprite2Deform,
  autospriteDeform,
  bulgeDeform,
  deformVertexes,
  moveDeform,
  moveOffset,
  normalDeform,
  quadEdgeOrders,
  stampIndices,
  waveDeform,
  type DeformVertices,
  type DeformView
} from './vertex-deform';

/** A waveform, defaulting to Q3's unit shape: base 0, amplitude 1, phase 0, 1 Hz. */
function wave(func: Wave['func'], base = 0, amplitude = 1, phase = 0, frequency = 1): Wave {
  return { func, base, amplitude, phase, frequency };
}

/** Vertices at `positions`, every normal `normal` and every coordinate (0, 0), as one triangle list. */
function vertices(positions: number[], normal: number[] = [0, 0, 1]): DeformVertices {
  const count = positions.length / 3;
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from({ length: count * 3 }, (_, i) => normal[i % 3]),
    uvs: new Float32Array(count * 2),
    indices: Uint32Array.from({ length: count }, (_, i) => i)
  };
}

/** Each of `actual`'s numbers close to `expected`'s. */
function expectNear(actual: ArrayLike<number>, expected: number[], digits = 4): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, i) => expect(actual[i], `[${i}]`).toBeCloseTo(value, digits));
}

describe('waveDeform', () => {
  /** Two vertices: one at the origin facing up, one at (10, 20, 45) facing along +x. */
  const normals = [0, 0, 1, 1, 0, 0];
  const at = () => new Float32Array([0, 0, 0, 10, 20, 45]);

  it("pushes every vertex out along its normal by a still wave's value, as a shell swells", () => {
    // The quad's shell: `wave 100 sin 3 0 0 0`.
    const positions = at();
    waveDeform({ type: 'wave', spread: 0.01, wave: wave('sin', 3, 0, 0, 0) }, positions, normals, 12.3);
    expect([...positions]).toEqual([0, 0, 3, 13, 20, 45]);

    // A still wave with an amplitude reads its phase alone, the same for every vertex, whatever
    // the time: `EvalWaveForm` with no frequency.
    const tilted = at();
    waveDeform({ type: 'wave', spread: 0.01, wave: wave('sin', 0, 2, 0.25, 0) }, tilted, normals, 7);
    expect(tilted[2]).toBeCloseTo(2, 5);
    expect(tilted[3]).toBeCloseTo(12, 5);
  });

  it('phases a moving wave along the surface by (x + y + z) · spread, as the C does', () => {
    // `base + amplitude · sin(phase + (x + y + z) · spread + t · frequency)`, one turn a unit.
    const deform = { type: 'wave', spread: 1 / 300, wave: wave('sin', 1, 2, 0.1, 0.5) } as const;
    const t = 0.3;
    // A third vertex at (5, 5, 5), facing along +y.
    const positions = new Float32Array([...at(), 5, 5, 5]);
    waveDeform(deform, positions, [...normals, 0, 1, 0], t);
    const push = (sum: number) => 1 + 2 * Math.sin(2 * Math.PI * (0.1 + sum / 300 + t * 0.5));
    expect(positions[2]).toBeCloseTo(push(0), 5);
    // The second vertex sums to 75, a quarter turn further on.
    expect(positions[3]).toBeCloseTo(10 + push(75), 5);
    expect([positions[4], positions[5]]).toEqual([20, 45]);
    expect(positions[7]).toBeCloseTo(5 + push(15), 5);
    expect([positions[6], positions[8]]).toEqual([5, 5]);
  });
});

describe('normalDeform', () => {
  it("adds the noise at the vertex to each axis, y's 100 along x and z's 200, then makes it unit", () => {
    // pak0's flags: `deformVertexes normal .3 .2`. At the origin and a whole moment the noise is
    // the lattice's own value: t = 15 s · 0.2 = 3.
    const flag = vertices([0, 0, 0, 0, 0, 0], [0, 0, 1]);
    normalDeform({ type: 'normal', amplitude: 0.3, frequency: 0.2 }, flag.positions, flag.normals, 15);
    const bent = [
      0.3 * latticeNoise(0, 0, 0, 3),
      0.3 * latticeNoise(100, 0, 0, 3),
      1 + 0.3 * latticeNoise(200, 0, 0, 3)
    ];
    const length = Math.hypot(...bent);
    expectNear(flag.normals, [...bent, ...bent].map((value) => value / length), 6);
    // The vertices stay where they were.
    expect([...flag.positions]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('reads the noise at the position scaled by 0.98, drifting with time', () => {
    const positions = Float32Array.from([13, -40, 7]);
    const normals = Float32Array.from([1, 0, 0]);
    normalDeform({ type: 'normal', amplitude: 2, frequency: 1.5 }, positions, normals, 0.7);
    const [x, y, z] = [13 * 0.98, -40 * 0.98, 7 * 0.98];
    const t = 0.7 * 1.5;
    const bent = [1 + 2 * noise4(x, y, z, t), 2 * noise4(100 + x, y, z, t), 2 * noise4(200 + x, y, z, t)];
    const length = Math.hypot(...bent);
    expectNear(normals, bent.map((value) => value / length), 6);
  });
});

describe('bulgeDeform', () => {
  it('pushes along the normal by height · sin(s · width + t · speed), on the first coordinate', () => {
    // A quarter turn along s, and an eighth of a turn a second: at 2 s the first vertex is at the
    // crest and the second at the zero past it.
    const surface = vertices([0, 0, 0, 10, 0, 0], [0, 1, 0]);
    surface.uvs.set([0, 0.9, 0.25, 0.1]);
    bulgeDeform({ type: 'bulge', width: 2 * Math.PI, height: 4, speed: Math.PI / 4 }, surface, 2);
    expectNear(surface.positions, [0, 4, 0, 10, 0, 0], 5);
  });
});

describe('moveDeform', () => {
  it("moves the whole surface along its vector by the wave now: the hologram's rise", () => {
    // pak0's `models/mapobjects/bitch/hologirl`: `move 0 0 .7 sin 0 5 0 0.2`, a quarter turn in
    // at 1.25 s, where the sine is 1.
    const hologram = { type: 'move', vector: [0, 0, 0.7], wave: wave('sin', 0, 5, 0, 0.2) } as const;
    expectNear(moveOffset(hologram, 1.25), [0, 0, 3.5], 6);
    const positions = Float32Array.from([1, 2, 3, -4, 5, 6]);
    moveDeform(hologram, positions, 1.25);
    expectNear(positions, [1, 2, 6.5, -4, 5, 9.5], 5);
  });
});

/** A view looking along −x, as from +x at a model facing it: left is −y and up is +z. */
const FACING: DeformView = {
  forward: [-1, 0, 0],
  left: [0, -1, 0],
  up: [0, 0, 1],
  normal: [0.6, 0, 0.8]
};

describe('autospriteDeform', () => {
  it("stamps a square facing the view round each quad's middle, half-side |v₀ − mid| · 0.707", () => {
    // A 16-unit square in the y-z plane at (10, 20, 30), then a quad's worth short.
    const surface = vertices([
      10, 12, 22, 10, 28, 22, 10, 28, 38, 10, 12, 38,
      50, 0, 0, 50, 1, 1
    ]);
    autospriteDeform(surface, FACING);
    const r = Math.hypot(8, 8) * 0.707;
    // Top left, top right, bottom right, bottom left, as the viewer sees them: left is −y.
    expectNear(surface.positions.subarray(0, 12), [
      10, 20 - r, 30 + r,
      10, 20 + r, 30 + r,
      10, 20 + r, 30 - r,
      10, 20 - r, 30 - r
    ]);
    expect([...surface.uvs.subarray(0, 8)]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    // Every corner takes the view's back as its normal, as it is given.
    expectNear(surface.normals.subarray(0, 12), [0.6, 0, 0.8, 0.6, 0, 0.8, 0.6, 0, 0.8, 0.6, 0, 0.8]);
    // The two left over stay as they were.
    expect([...surface.positions.subarray(12)]).toEqual([50, 0, 0, 50, 1, 1]);
    expect([...surface.normals.subarray(12)]).toEqual([0, 0, 1, 0, 0, 1]);
  });

  it("draws each square by RB_AddQuadStampExt's triangles, and a short quad by none", () => {
    expect([...stampIndices(10)]).toEqual([0, 1, 3, 3, 1, 2, 4, 5, 7, 7, 5, 6]);
    expect([...stampIndices(3)]).toEqual([]);
  });
});

describe('autosprite2Deform', () => {
  /** A strip 8 wide and 64 tall in the x-z plane, drawn by the stamp's triangles. */
  const strip = () =>
    Float32Array.from([-4, 0, 0, 4, 0, 0, 4, 0, 64, -4, 0, 64]);

  it('marks which edges a quad names in order, as the C looks for them', () => {
    // 0 1 3 3 1 2: its neighbours are 0-1, 1-3, 3-3, 3-1 and 1-2, so edges 0, 4 and 3.
    // 4 6 5 4 7 6: 4-6, 6-5, 5-4, 4-7 and 7-6, so the second quad's 0-2 and 0-3.
    const orders = quadEdgeOrders([0, 1, 3, 3, 1, 2, 4, 6, 5, 4, 7, 6], 8);
    expect([...orders]).toEqual([0b11001, 0b110]);
    // Past the indices' end nothing matches: 0 1 3 names only edges 0 and 4.
    expect([...quadEdgeOrders([0, 1, 3], 4)]).toEqual([0b10001]);
    expect([...quadEdgeOrders([], 4)]).toEqual([0]);
  });

  it('turns a strip about its long axis to lie square to the view', () => {
    // Its ends, the shortest edges, are 0-1 (named in order) and 2-3 (not). Seen along +y, the
    // minor axis is (0, 0, 64) × (0, 1, 0), −x: vertex 0 goes to its end's middle less half the
    // end along it, and vertex 2 plus.
    const positions = strip();
    const orders = quadEdgeOrders(stampIndices(4), 4);
    autosprite2Deform(positions, orders, [0, 1, 0]);
    expectNear(positions, [4, 0, 0, -4, 0, 0, -4, 0, 64, 4, 0, 64]);

    // Seen along (1, 1, 0), it turns 45° to lie across the view.
    const turned = strip();
    autosprite2Deform(turned, orders, [Math.SQRT1_2, Math.SQRT1_2, 0]);
    const d = 4 * Math.SQRT1_2;
    expectNear(turned, [d, -d, 0, -d, d, 0, -d, d, 64, d, -d, 64]);
  });

  it('flips an end its triangles name in order, and leaves a short quad as it is', () => {
    // A fan names both ends in order, 0-1 and 2-3, so both first vertices go the same way.
    const positions = Float32Array.from([...strip(), 7, 7, 7]);
    autosprite2Deform(positions, quadEdgeOrders([0, 1, 2, 0, 2, 3], 5), [0, 1, 0]);
    expectNear(positions, [4, 0, 0, -4, 0, 0, 4, 0, 64, -4, 0, 64, 7, 7, 7]);
  });
});

describe('deformVertexes', () => {
  it("runs a shader's deforms in slot order, a sprite on what the ones before it left", () => {
    // Moved up 10, then stamped: the square's middle moves with it.
    const square = [10, 12, 22, 10, 28, 22, 10, 28, 38, 10, 12, 38];
    const surface = vertices(square);
    const deforms: Deform[] = [
      { type: 'move', vector: [0, 0, 1], wave: wave('sin', 10, 0, 0, 0) },
      { type: 'autosprite' },
      // And pushed out along the stamp's normal after.
      { type: 'wave', spread: 0, wave: wave('sin', 2, 0, 0, 0) }
    ];
    deformVertexes(deforms, surface, 0, FACING);
    const r = Math.hypot(8, 8) * 0.707;
    expectNear(surface.positions.subarray(0, 3), [10 + 1.2, 20 - r, 40 + r + 1.6]);
  });

  it('hands each kind to its own function', () => {
    const square = [10, 12, 22, 10, 28, 22, 10, 28, 38, 10, 12, 38];
    const deforms: Deform[] = [
      { type: 'normal', amplitude: 0.5, frequency: 2 },
      { type: 'bulge', width: 1, height: 3, speed: 2 },
      { type: 'autosprite2' }
    ];
    const surface = vertices(square, [1, 0, 0]);
    surface.uvs.set([0.1, 0, 0.4, 0, 0.7, 0, 0.9, 0]);
    deformVertexes(deforms, surface, 1.3, FACING);

    const expected = vertices(square, [1, 0, 0]);
    expected.uvs.set(surface.uvs);
    normalDeform({ type: 'normal', amplitude: 0.5, frequency: 2 }, expected.positions, expected.normals, 1.3);
    bulgeDeform({ type: 'bulge', width: 1, height: 3, speed: 2 }, expected, 1.3);
    autosprite2Deform(expected.positions, quadEdgeOrders(expected.indices, 4), FACING.forward);
    expect([...surface.positions]).toEqual([...expected.positions]);
    expect([...surface.normals]).toEqual([...expected.normals]);
  });

  it('draws no sprite without a view, and the rest still', () => {
    const surface = vertices([10, 12, 22, 10, 28, 22, 10, 28, 38, 10, 12, 38]);
    deformVertexes(
      [{ type: 'autosprite' }, { type: 'autosprite2' }, { type: 'move', vector: [1, 0, 0], wave: wave('sin', 1, 0, 0, 0) }],
      surface,
      0,
      null
    );
    expect([...surface.positions]).toEqual([11, 12, 22, 11, 28, 22, 11, 28, 38, 11, 12, 38]);
  });
});
