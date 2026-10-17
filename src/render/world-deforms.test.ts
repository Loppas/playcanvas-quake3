// @vitest-environment jsdom
import { NullGraphicsDevice, type GraphicsDevice } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Deform } from '../formats/shader-script';
import type { WorldRun } from '../view/world-batches';
import { WORLD_ENTITY, anglesToAxes } from '../view/world-deforms';
import { WorldIndexes, type SeenSurfaces } from '../view/world-indexes';
import { surface, testBsp } from '../view/world-test-fixtures';
import { worldVertexFormat } from './bsp-world';
import { DeformedRuns, type DeformedRunOptions, type WorldVertexData } from './world-deforms';

/** A run of the world's, of these surfaces. */
const run = (surfaces: number[]): WorldRun => ({ shader: 0, entity: 0, model: 0, fog: 0, surfaces });

/** `deformVertexes move 0 0 4 sin 2 0 0 0`: every vertex up by 8, whatever the time. */
const UP: Deform = {
  type: 'move',
  vector: [0, 0, 4],
  wave: { func: 'sin', base: 2, amplitude: 0, phase: 0, frequency: 0 }
};

/** What a view added: these surfaces, all by the world's tree. */
const seen = (surfaces: number[]): SeenSurfaces => ({
  surfaces: Int32Array.from(surfaces),
  count: surfaces.length,
  worldCount: surfaces.length
});

describe('DeformedRuns', () => {
  let device: GraphicsDevice;

  beforeEach(() => {
    device = new NullGraphicsDevice(document.createElement('canvas'));
  });

  afterEach(() => {
    device.destroy();
  });

  /**
   * Faces of these points, each its own after the one before, their indexes in turn, cut in these
   * runs, those given deforms tessellated. Each vertex's normal is up, its colour its number.
   */
  function deformed(
    numVerts: number[],
    runs: number[][],
    deforms: (Deform[] | null)[],
    clampTime = 0,
    timeOffset = 0,
    stamps?: boolean
  ) {
    let firstVert = 0;
    const bsp = testBsp({
      surfaces: numVerts.map((n, i) => {
        const face = surface({ numVerts: n, numIndexes: 3, firstVert, firstIndex: 3 * i });
        firstVert += n;
        return face;
      })
    });
    const count = firstVert;
    const data: WorldVertexData = {
      xyz: bsp.drawVerts.xyz,
      normal: new Float32Array(count * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)),
      st: new Float32Array(count * 2).map((_, i) => i / 8),
      lightmap: new Float32Array(count * 2),
      color: new Uint8Array(new Uint32Array(count).map((_, i) => i).buffer)
    };
    const tessellated = deforms.map((own) => own !== null);
    const detail = new WorldIndexes(bsp, runs.map(run), [], new Map(), [], tessellated);
    const options: DeformedRunOptions[] = [];
    deforms.forEach((own, r) => {
      if (!own) return;
      const shader = { deforms: own, shader: 'test', clampTime, timeOffset };
      options.push({ run: r, ...shader, entity: WORLD_ENTITY, ...(stamps ? { stamps } : {}) });
    });
    const runsDeformed = new DeformedRuns(device, worldVertexFormat(device), data, detail, options);
    return { detail, runs: runsDeformed };
  }

  /** The vertexes written, each its place and its colour's word. */
  function vertexes(runs: DeformedRuns, count: number): number[][] {
    const storage = runs.vertices.lock() as ArrayBuffer;
    const floats = new Float32Array(storage);
    const words = new Uint32Array(storage);
    return Array.from({ length: count }, (_, v) => [...floats.subarray(v * 11, v * 11 + 3), words[v * 11 + 10]]);
  }

  /** The indexes written. */
  const indexes = (runs: DeformedRuns, count: number) =>
    Array.from(new Uint32Array(runs.indexes.lock() as ArrayBuffer, 0, count));

  /** A mesh's range of the indexes. */
  const placed = (runs: DeformedRuns, r: number, k = 0) => {
    const [{ base, count }] = runs.meshes(r)![k].primitive;
    return [base, count];
  };

  it('lays each batch a view draws out after the one before, deformed, and places its meshes', () => {
    const { runs } = deformed([3, 3, 3], [[0, 1], [2]], [[UP], [UP]]);
    runs.deform(1000);
    // Each vertex up 8 from (i, 2i, 3i), in the tessellator's order, the second run's after.
    expect(vertexes(runs, 9)).toEqual(Array.from({ length: 9 }, (_, i) => [i, 2 * i, 3 * i + 8, i]));
    expect(indexes(runs, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect([placed(runs, 0), placed(runs, 1)]).toEqual([
      [0, 6],
      [6, 3]
    ]);
    // Each frame from the copy, so the deforms never gather.
    runs.deform(2000);
    expect(vertexes(runs, 1)).toEqual([[0, 0, 8, 0]]);
    expect(runs.meshes(0)![0].vertexBuffer).toBe(runs.vertices);
    expect(runs.meshes(0)![0].indexBuffer[0]).toBe(runs.indexes);
  });

  it('writes nothing of a run the view has not seen, and uploads what it wrote', () => {
    const { detail, runs } = deformed([3, 3, 3], [[0, 1], [2]], [[UP], [UP]]);
    detail.view(seen([2, 0]), { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 250, () => {});
    const uploads = vi.spyOn(runs.vertices, 'unlock');
    const indexUploads = vi.spyOn(runs.indexes, 'unlock');
    runs.deform(0);
    // The first run's first face, then the second run's.
    expect(vertexes(runs, 6).map(([x]) => x)).toEqual([0, 1, 2, 6, 7, 8]);
    expect([placed(runs, 0), placed(runs, 1)]).toEqual([
      [0, 3],
      [3, 3]
    ]);
    expect(uploads).toHaveBeenCalledWith(0, 6 * 44);
    expect(indexUploads).toHaveBeenCalledWith(0, 6 * 4);
    // A view that sees none of them writes nothing.
    detail.view(seen([]), { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 250, () => {});
    uploads.mockClear();
    runs.deform(0);
    expect(uploads).not.toHaveBeenCalled();
  });

  it('draws the squares autosprite stamps, with their own triangles, facing the view', () => {
    // Two quads of four points, each face with a triangle of its own: each square two.
    const { runs } = deformed([4, 4], [[0, 1]], [[{ type: 'autosprite' }]]);
    anglesToAxes(0, 90, 0, runs.view);
    runs.deform(0);
    expect(indexes(runs, 12)).toEqual([0, 1, 3, 3, 1, 2, 4, 5, 7, 7, 5, 6]);
    expect(placed(runs, 0)).toEqual([0, 12]);
    // Each square about its quad's middle, across the view's left, along x as it looks along y;
    // its colour its first point's.
    const [first, second, , fourth] = vertexes(runs, 4);
    expect(first[1]).toBeCloseTo(second[1]);
    expect(first[0]).not.toBeCloseTo(second[0]);
    expect([first[3], second[3], fourth[3]]).toEqual([0, 0, 0]);
    expect(vertexes(runs, 8)[4][3]).toBe(4);
  });

  it('has room for every run cut whole at once, and the squares a batch can be stamped into', () => {
    const { detail, runs } = deformed([5, 2], [[0, 1]], [[{ type: 'autosprite' }]]);
    // Seven points, two squares, the second read past them: twelve indexes where the faces had six.
    runs.deform(0);
    expect(placed(runs, 0)).toEqual([0, 12]);
    expect(detail.runs[0].batches[0].count).toBe(6);
    expect(runs.vertices.numVertices).toBeGreaterThanOrEqual(8);
    expect(runs.indexes.numIndices).toBeGreaterThanOrEqual(12);
  });

  it("deforms at the shader's time, held at its clampTime", () => {
    // Up by the sawtooth's 1/4 a second, held at 1 s: a quarter at 1 s and after.
    const rising: Deform = {
      type: 'move',
      vector: [0, 0, 16],
      wave: { func: 'sawtooth', base: 0, amplitude: 1, phase: 0, frequency: 0.25 }
    };
    const { runs } = deformed([3], [[0]], [[rising]], 1);
    const height = (time: number) => {
      runs.deform(time);
      return vertexes(runs, 1)[0][2];
    };
    expect([height(500), height(1000), height(3000)]).toEqual([2, 4, 4]);
  });

  it("deforms a run as the shader it draws now deforms it, on that shader's clock", () => {
    const rising: Deform = {
      type: 'move',
      vector: [0, 0, 16],
      wave: { func: 'sawtooth', base: 0, amplitude: 1, phase: 0, frequency: 0.25 }
    };
    // From a swap at 0.5 s: the sawtooth at 0 then.
    const { runs } = deformed([3], [[0]], [[rising]], 0, 0.5);
    const height = (time: number) => {
      runs.deform(time);
      return vertexes(runs, 1)[0][2];
    };
    expect([height(500), height(1500)]).toEqual([0, 4]);

    // Swapped again from 1 s, and held at 0.5 s on.
    runs.drawWith(0, { deforms: [rising], shader: 'again', clampTime: 0, timeOffset: 1 });
    expect(height(1500)).toBe(2);
    runs.drawWith(0, { deforms: [rising], shader: 'held', clampTime: 0.25, timeOffset: 1 });
    expect(height(1500)).toBe(1);
    runs.drawWith(0, { deforms: [UP], shader: 'other', clampTime: 0, timeOffset: 0 });
    expect(height(1500)).toBe(8);
    // A shader that deforms nothing draws the run as it is.
    runs.drawWith(0, { deforms: [], shader: 'plain', clampTime: 0, timeOffset: 0 });
    expect(height(1500)).toBe(0);
  });

  it('has room for the squares a shader the run may draw instead stamps', () => {
    const { runs } = deformed([5, 2], [[0, 1]], [[UP]], 0, 0, true);
    const sprite = { shader: 'sprite', clampTime: 0, timeOffset: 0 };
    runs.drawWith(0, { deforms: [{ type: 'autosprite' }], ...sprite });
    runs.deform(0);
    expect(placed(runs, 0)).toEqual([0, 12]);
    expect(runs.indexes.numIndices).toBeGreaterThanOrEqual(12);
  });
});
