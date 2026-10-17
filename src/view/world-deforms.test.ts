import { describe, expect, it } from 'vitest';

import type { Deform, Wave, WaveFunc } from '../formats/shader-script';
import { fillNoise, noise4 } from './noise';
import {
  Tess,
  WORLD_ENTITY,
  anglesToAxes,
  deformTess,
  type Axes,
  type DeformEntity,
  type DeformScene
} from './world-deforms';
import { SHADER_MAX_INDEXES, SHADER_MAX_VERTEXES } from './world-batches';

const f = Math.fround;

/** Microsoft's `rand` after `srand(seed)`, as `rand() / (float)RAND_MAX`. */
function msRand(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 214013) + 2531011) >>> 0;
    return f(((state >>> 16) & 0x7fff) / 32767);
  };
}

/** The seeded inputs, as the twin makes them: exact floats, a 256th of a unit apart. */
function inputs() {
  let state = 12345;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 8;
  };
  const coordinate = () => f(((next() % 2000001) - 1000000) / 256);
  const component = () => f(((next() % 513) - 256) / 256);
  return { next, coordinate, component };
}

/** The batch the twin deforms, and the noise it reads, from one seeded stream in its order. */
function twinBatch() {
  const { next, coordinate, component } = inputs();
  const noise = fillNoise(msRand(7));
  let noiseSum = 0;
  for (let i = 0; i < 64; i++) {
    const x = f(coordinate() / 64);
    const y = f(coordinate() / 64);
    const z = f(coordinate() / 64);
    const t = coordinate() / 1024;
    noiseSum += f(noise4(x, y, z, t, noise) * (i + 1));
  }
  const tess = new Tess();
  const n = SHADER_MAX_VERTEXES;
  const xyz = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const st = new Float32Array(n * 2);
  const lightmap = new Float32Array(n * 2);
  const colors = new Uint32Array(n);
  const indexes = new Uint32Array(SHADER_MAX_INDEXES);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) xyz[i * 3 + k] = coordinate() / 4;
    for (let k = 0; k < 3; k++) normal[i * 3 + k] = component();
    st[i * 2] = component() * 4;
    st[i * 2 + 1] = component() * 4;
    lightmap[i * 2] = component();
    lightmap[i * 2 + 1] = component();
    const bytes = [next() & 255, next() & 255, next() & 255, next() & 255];
    colors[i] = bytes[0] + bytes[1] * 0x100 + bytes[2] * 0x10000 + bytes[3] * 0x1000000;
  }
  for (let i = 0; i < SHADER_MAX_INDEXES / 4; i++) indexes[i] = Math.floor(i / 6) * 4 + (next() % 4);
  /** The batch back in the tessellator, every slot, so what a deform reads past its count is too. */
  const load = (numVertexes: number, numIndexes: number) => {
    tess.xyz.set(xyz);
    tess.normal.set(normal);
    tess.st.set(st);
    tess.lightmap.set(lightmap);
    tess.colors.set(colors);
    tess.indexes.set(indexes);
    tess.numVertexes = numVertexes;
    tess.numIndexes = numIndexes;
  };
  return { tess, noise, noiseSum, load };
}

/** What the twin prints of a batch: its counts, its sums, and its first vertex. */
function report(tess: Tess) {
  let xyz = 0;
  let normal = 0;
  let st = 0;
  let colors = 0;
  let indexes = 0;
  for (let i = 0; i < tess.numVertexes; i++) {
    xyz += tess.xyz[i * 3] + 3 * tess.xyz[i * 3 + 1] + 5 * tess.xyz[i * 3 + 2];
    normal += tess.normal[i * 3] + 3 * tess.normal[i * 3 + 1] + 5 * tess.normal[i * 3 + 2];
    st += tess.st[i * 2] + 3 * tess.st[i * 2 + 1] + 5 * tess.lightmap[i * 2] + 7 * tess.lightmap[i * 2 + 1];
    colors += (i + 1) * tess.colors[i];
  }
  for (let i = 0; i < tess.numIndexes; i++) indexes += (i + 1) * tess.indexes[i];
  return [
    tess.numVertexes,
    tess.numIndexes,
    xyz,
    normal,
    st,
    colors,
    indexes,
    Array.from(tess.xyz.subarray(0, 3)),
    Array.from(tess.normal.subarray(0, 3))
  ];
}

/** A row of the twin's output, its floats taken back to floats. */
function pinned(
  counts: [number, number],
  sums: [number, number, number, number, number],
  first: [number, number, number],
  normal: [number, number, number]
) {
  return [...counts, ...sums, first.map(f), normal.map(f)];
}

/** `AnglesToAxis` as the twin prints it: the view at (23.5, −141.25, 7.75)... */
const VIEW: Axes = [
  [-0.71520102, -0.574009359, -0.398749083].map(f),
  [0.578270435, -0.806418002, 0.123666391].map(f),
  [-0.392544091, -0.142138466, 0.908683538].map(f)
];

/** ...and a brush model at (−12.5, 63, 4.25), set at (100, −50.5, 64.25). */
const MODEL: DeformEntity = {
  world: false,
  origin: [100, -50.5, 64.25],
  axis: [
    [0.443229139, 0.8698861, 0.21643962].map(f),
    [-0.895838439, 0.438450366, 0.0723518208].map(f),
    [-0.0319601819, -0.225963354, 0.973611414].map(f)
  ],
  lightDir: [0.25, -0.5, 0.375],
  shadowPlane: 12
};

const wave = (func: WaveFunc, base: number, amplitude: number, phase: number, frequency: number): Wave => ({
  func,
  base: f(base),
  amplitude: f(amplitude),
  phase: f(phase),
  frequency: f(frequency)
});

/** `deformVertexes wave`, its spread `1 / div` in a float as `ParseDeform` stores it. */
const waveDeform = (div: number, ...rest: Parameters<typeof wave>): Deform => ({
  type: 'wave',
  spread: f(1 / div),
  wave: wave(...rest)
});

describe('the twin of ioquake3', () => {
  const { tess, noise, noiseSum, load } = twinBatch();
  const texts = ['', '', 'Hi, Q3! \x80\xff', '', '', '', '', ''];
  const scene = (entity: DeformEntity = WORLD_ENTITY, words = texts): DeformScene => ({
    shaderTime: 54321 * 0.001,
    time: 54321,
    view: VIEW,
    entity,
    texts: words,
    noise,
    shader: 'test'
  });
  const run = (deforms: Deform[], numVertexes: number, numIndexes: number, at = scene()) => {
    load(numVertexes, numIndexes);
    deformTess(deforms, tess, at);
    return report(tess);
  };

  it('turns angles into axes as AnglesToAxis does, in its floats', () => {
    const axes = () => [new Float32Array(3), new Float32Array(3), new Float32Array(3)] as const;
    const rows = (out: readonly Float32Array[]) => out.map((row) => Array.from(row));
    expect(rows(anglesToAxes(23.5, -141.25, 7.75, axes()))).toEqual(VIEW);
    expect(rows(anglesToAxes(-12.5, 63, 4.25, axes()))).toEqual(MODEL.axis);
  });

  it("fills the noise as R_NoiseInit does, and reads it as R_NoiseGet4f does, in C's floats", () => {
    expect([noise.table[0], noise.perm[0], noise.table[1], noise.perm[1]]).toEqual([
      f(-0.996276736),
      135,
      f(-0.0713217854),
      54
    ]);
    expect([noise.table[255], noise.perm[255]]).toEqual([f(0.95123148), 96]);
    expect(noiseSum).toBe(100.57682566344738);
  });

  it('pushes every vertex along its normal by a wave, each table read at its step', () => {
    expect(run([waveDeform(100, 'sin', 3, 5, 0.25, 0)], 999, 0)).toEqual(
      pinned(
        [999, 0],
        [-266305.12885379791, 57.015625, 555.74609375, 1066600160795230, 0],
        [912.323242, -80.0839844, -813.788086],
        [0.5859375, -0.2265625, -0.36328125]
      )
    );
    const rippled: [Deform, number, [number, number, number]][] = [
      [waveDeform(64, 'triangle', 2, 7, 0.125, 1.5), -266218.99108886719, [907.077271, -78.055542, -810.535583]],
      // Each vertex's phase rounded to a float, as C adds it: at this phase and time the rounding
      // moves about one vertex in thirteen onto the next step.
      [waveDeform(3, 'sin', 0, 2.5, 0.22, 0.3), -267112.03053498268, [906.320618, -77.7629623, -810.066467]],
      [waveDeform(17, 'square', -1, 3, 0.5, 2), -267028.52734375, [908.807617, -78.7246094, -811.608398]],
      [waveDeform(250, 'sawtooth', 0.5, 4, 0, 0.7), -266551.86064147949, [908.157593, -78.4732666, -811.205383]],
      [
        waveDeform(9, 'inversesawtooth', 1, -2, 0.375, 1.25),
        -266906.37953186035,
        [907.435486, -78.194046, -810.75769]
      ]
    ];
    for (const [deform, sum, first] of rippled) {
      const [, , xyz, , , , , at] = run([deform], 999, 0);
      expect([xyz, at]).toEqual([sum, first.map(f)]);
    }
  });

  it('bends the normals by the noise and makes them unit by Q_rsqrt', () => {
    expect(run([{ type: 'normal', amplitude: 0.5, frequency: 3 }], 999, 0)).toEqual(
      pinned(
        [999, 0],
        [-266761.25390625, 275.39253382052993, 555.74609375, 1066600160795230, 0],
        [907.635742, -78.2714844, -810.881836],
        [0.794021368, -0.503984153, -0.337310702]
      )
    );
  });

  it("bulges along the texture's first coordinate by the refdef's clock", () => {
    const [, , xyz, , , , , first] = run([{ type: 'bulge', width: 2.5, height: 7, speed: 1.75 }], 999, 0);
    expect([xyz, first]).toEqual([-266920.38099884987, [911.237122, -79.6640091, -813.114685].map(f)]);
  });

  it('moves every vertex along the vector by a wave', () => {
    const move: Deform = { type: 'move', vector: [1.5, -2, 3], wave: wave('sin', 0, 5, 0.1, 0.2) };
    const [, , xyz, , , , , first] = run([move], 999, 0);
    expect([xyz, first]).toEqual([-278263.59585666656, [905.990906, -76.0783691, -814.171509].map(f)]);
  });

  it("flattens the world's batch onto z = 0, and casts a lit model's along its light", () => {
    const shadow: Deform[] = [{ type: 'projectionShadow' }];
    const [, , world, , , , , onFloor] = run(shadow, 999, 0);
    expect([world, onFloor]).toEqual([-131009.3544921875, [907.635742, -78.2714844, 0].map(f)]);
    const [, , cast, , , , , first] = run(shadow, 999, 0, scene(MODEL));
    expect([cast, first]).toEqual([-308857.71858978271, [1208.52686, -615.471558, -276.591431].map(f)]);
    // A light standing steeper than half is cast along as it is.
    const steep = { ...MODEL, lightDir: [0.25, -0.5, 0.875] };
    const [, , down, , , , , under] = run(shadow, 999, 0, scene(steep));
    expect([down, under]).toEqual([-327494.63341903687, [1064.68933, -392.378754, -261.194092].map(f)]);
  });

  it("stamps each quad as a square facing the view, the batch's triangles its squares'", () => {
    const sprite: Deform[] = [{ type: 'autosprite' }];
    expect(run(sprite, 996, 1494)).toEqual(
      pinned(
        [996, 1494],
        [-266435.98285102844, 4413.2506152391434, 7968, 1104394739379186, 741033960],
        [769.35022, -627.930969, 413.339478],
        [0.71520102, 0.574009359, 0.398749083]
      )
    );
    // A last group of two reads the two past it, and is stamped whole.
    expect(run(sprite, 998, 1494)).toEqual(
      pinned(
        [1000, 1500],
        [-266797.75155830383, 4430.9745132923126, 8000, 1106641441810864, 749998000],
        [769.35022, -627.930969, 413.339478],
        [0.71520102, 0.574009359, 0.398749083]
      )
    );
    // In a model, the view's axes are taken into its frame; the normal stays the world's.
    const [, , xyz, normal, , , , first] = run(sprite, 996, 1494, scene(MODEL));
    expect([xyz, normal, first]).toEqual([
      -266435.97191810608,
      4413.2506152391434,
      [404.721313, -399.890686, 507.023132].map(f)
    ]);
  });

  it('turns each quad about its long axis, each end the way its triangles name it', () => {
    const sprite: Deform[] = [{ type: 'autosprite2' }];
    expect(run(sprite, 996, 1494)).toEqual(
      pinned(
        [996, 1494],
        [-254502.42106246948, 52.859375, 530.03515625, 1060441049276479, 740821942],
        [334.424011, 39.414093, -186.746002],
        [0.5859375, -0.2265625, -0.36328125]
      )
    );
    const [, , xyz, , , , , first] = run(sprite, 996, 1494, scene(MODEL));
    expect([xyz, first]).toEqual([-255390.61763954163, [760.985901, 107.831604, -43.0155334].map(f)]);
  });

  it("rebuilds the batch as the scene's text, and as nothing for none", () => {
    const text: Deform[] = [{ type: 'text', index: 2 }];
    expect(run(text, 999, 0)).toEqual(
      pinned(
        [32, 48],
        [-16949.720550537109, 141.791184425354, 202, 2267742731760, 24512],
        [-186.075912, -2359.94287, 385.231689],
        [0.71520102, 0.574009359, 0.398749083]
      )
    );
    const [vertexes, indexes] = run(text, 999, 0, scene(WORLD_ENTITY, texts.map(() => '')));
    expect([vertexes, indexes]).toEqual([0, 0]);
  });

  it("runs a shader's deforms in their slots' order", () => {
    const rippled = waveDeform(64, 'sin', 0, 4, 0, 0.5);
    const bent: Deform = { type: 'normal', amplitude: 0.25, frequency: 1 };
    expect(run([rippled, bent, { type: 'autosprite2' }], 996, 1494)).toEqual(
      pinned(
        [996, 1494],
        [-253968.05176591873, 157.48058637039503, 530.03515625, 1060441049276479, 740821942],
        [335.672791, 39.5863037, -186.343155],
        [0.83260107, -0.366521388, -0.414991617]
      )
    );
    const [, , xyz, normal, , , indexes, first] = run(
      [rippled, { type: 'autosprite' }, { type: 'autosprite2' }],
      996,
      1494
    );
    expect([xyz, normal, indexes, first]).toEqual([
      -280036.88776397705,
      4413.2506152391434,
      741033960,
      [470.439575, -210.716797, 350.683716].map(f)
    ]);
    // A slot left unset deforms nothing.
    expect(run([{ type: 'none' }], 999, 0)).toEqual(run([], 999, 0));
  });

  it("drops the map for a wave with no table, in TableForFunc's words", () => {
    expect(() => run([waveDeform(1, 'noise', 0, 1, 0, 1)], 999, 0)).toThrow(
      "TableForFunc called with invalid function '6' in shader 'test'"
    );
    const move: Deform = { type: 'move', vector: [0, 0, 1], wave: wave('none', 0, 1, 0, 1) };
    expect(() => run([move], 999, 0)).toThrow("invalid function '0'");
  });
});
