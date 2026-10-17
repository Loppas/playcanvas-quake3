// @vitest-environment jsdom
import {
  BLEND_NORMAL,
  Entity,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  StandardMaterial,
  Texture,
  type AppBase,
  type Shader
} from 'playcanvas';
import { Preprocessor } from 'playcanvas/build/playcanvas/src/core/preprocessor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Md3Surface } from '../formats/md3';
import type { Deform, TexMod, WaveDeform } from '../formats/shader-script';
import {
  LIGHT_HEADROOM,
  SPECULAR_LIGHT_ORIGIN,
  diffuseShade,
  genericShade,
  lightallShade,
  mirroredLight,
  shadeVertices,
  specularAlpha,
  specularAlphas,
  type EntityLight
} from '../view/entity-light';
import { NOISE_PERM, NOISE_TABLE, noise4 } from '../view/noise';
import { overbrightFactor, type RendererStyle } from '../view/overbright';
import { environmentUvs } from '../view/shader-animation';
import { COORDINATES_LENGTH, coordinatesAt, writeCoordinates } from '../view/stage-motion';
import { QUAD_EDGES, deformVertexes, type DeformView } from '../view/vertex-deform';
import { drawnFrames, lerpMeshVertexes } from '../view/vertex-morph';
import {
  assembledShaders as assembledMaterial,
  createTestApp,
  expectClose
} from './engine-test-fixtures';
import {
  DEFORM_AUTOSPRITE,
  DEFORM_AUTOSPRITE2,
  DEFORM_BULGE,
  DEFORM_MOVE,
  DEFORM_NORMAL,
  DEFORM_WAVE,
  MODEL_CHUNKS_VERSION,
  applyModelChunks,
  deformReach,
  modelChunks,
  phaseNow,
  readsViewer,
  shadeScale,
  writeAnim,
  writeDeforms,
  writeLight,
  writeView,
  writeViewer
} from './model-chunks';
import { frameTexture, packFrames, surfaceMesh, vertexTexel } from './model-frames';

const CLASSIC = { renderer: 'opengl1', overBrightBits: 1 } as const;
/** A stage that is neither lit, shines, mirrors, moves nor deforms. */
const PLAIN_STAGE = {
  lit: false,
  specular: false,
  environment: false,
  coordinates: false,
  deforms: []
};
const MODERN = { renderer: 'opengl2', overBrightBits: 1 } as const;

/**
 * Two strips 8 wide and 64 tall, the first drawn by the stamps' triangles and the second, tilted,
 * as a fan, then a vertex short of a third quad. Their normals and coordinates differ by quad.
 */
function strips(): Md3Surface {
  const positions = [
    [-4, 0, 0, 4, 0, 0, 4, 0, 64, -4, 0, 64],
    [10, -4, 5, 10, 4, 5, 12, 4, 69, 12, -4, 69],
    [50, 1, 2]
  ].flat();
  const normals = [
    [0, -1, 0],
    [0.6, 0, 0.8],
    [0, 0, 1]
  ].flatMap((normal, quad) => (quad < 2 ? [normal, normal, normal, normal] : [normal]).flat());
  return {
    name: 'strips',
    shaders: [],
    numVerts: 9,
    indices: Uint32Array.from([0, 1, 3, 3, 1, 2, 4, 5, 6, 4, 6, 7]),
    uvs: Float32Array.from({ length: 18 }, (_, i) => i / 20),
    frames: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals) }]
  };
}

/** A view looking along (0.6, 0.8, 0), its up +z, and a stamp's normal of its own. */
const VIEW: DeformView = {
  forward: [0.6, 0.8, 0],
  left: [-0.8, 0.6, 0],
  up: [0, 0, 1],
  normal: [0.36, -0.48, 0.8]
};

describe('the uniforms', () => {
  it('names the frames to draw, as R_AddMD3Surfaces checks them, and the vertex count', () => {
    const out = new Float32Array(4);
    writeAnim(10, 300, { oldFrame: 3, frame: 4, backlerp: 0.25 }, out);
    expect([...out]).toEqual([3, 4, 0.25, 300]);
    // A frame past the model's last draws frame 0 for both (`tr_mesh.c:307–316`).
    writeAnim(10, 300, { oldFrame: 3, frame: 12, backlerp: 0.25 }, out);
    expect([...out]).toEqual([0, 0, 0.25, 300]);
  });

  it("carries the entity light as three vec4s, the shade's scale in the directed light's w", () => {
    const out = new Float32Array(12);
    const light = {
      ambient: [91, 40, 10],
      directed: [75, 150, 0],
      direction: [0, 0.6, 0.8]
    } as const;
    writeLight(light, out);
    const [y, z] = [Math.fround(0.6), Math.fround(0.8)];
    expect([...out]).toEqual([91, 40, 10, 0, 75, 150, 0, 1, 0, y, z, 0]);
    writeLight(light, out, 0.5);
    expect(out[7]).toBe(0.5);
  });

  it("scales a shade's bytes by the ramp's factor over the headroom, by none in a scene", () => {
    expect(shadeScale(false, CLASSIC)).toBe(1);
    expect(shadeScale(false, { renderer: 'opengl1', overBrightBits: 0 })).toBe(0.5);
    expect(shadeScale(false, { renderer: 'opengl1', overBrightBits: 2 })).toBe(2);
    expect(shadeScale(true, { renderer: 'opengl1', overBrightBits: 2 })).toBe(1);
    expect(shadeScale(true, { renderer: 'opengl1', overBrightBits: 0 })).toBe(1);
  });

  it('marks whether there is a viewer', () => {
    const out = new Float32Array(4);
    writeViewer([1, 2, 3], out);
    expect([...out]).toEqual([1, 2, 3, 1]);
    writeViewer(null, out);
    expect([...out]).toEqual([0, 0, 0, 0]);
  });

  it("carries where the viewer looks as four vec4s, marked by the forward's w", () => {
    const out = new Float32Array(16);
    writeView(VIEW, out);
    expect([...out]).toEqual(
      [...VIEW.forward, 1, ...VIEW.left, 0, ...VIEW.up, 0, ...VIEW.normal, 0].map(Math.fround)
    );
    writeView(null, out);
    expect([...out]).toEqual(new Array(16).fill(0));
  });

});

/** A vertex as the chunks carry it. */
interface Vert {
  position: number[];
  normal: number[];
  st: number[];
}

/**
 * What the chunks' `q3Bend` does with one packed slot, in double precision: the twin of their
 * code, to check the packing against the deforms' own.
 */
function bend(packed: Float32Array, slot: number, given: Vert): Vert {
  const position = [...given.position];
  let normal = [...given.normal];
  const [kind, shape, spread] = packed.subarray(slot * 8, slot * 8 + 3);
  const args = [...packed.subarray(slot * 8 + 4, slot * 8 + 8)];
  if (kind === DEFORM_WAVE) {
    const [base, amplitude, phase] = args;
    const f = (phase + (position[0] + position[1] + position[2]) * spread) % 1;
    const x = f < 0 ? f + 1 : f;
    const value = [Math.sin(2 * Math.PI * x), x < 0.5 ? 1 : -1, NaN, x, 1 - x][shape];
    for (let i = 0; i < 3; i++) position[i] += normal[i] * (base + amplitude * value);
  } else if (kind === DEFORM_NORMAL) {
    const [amplitude, t] = args;
    const [x, y, z] = position.map((value) => value * 0.98);
    const bent = [
      normal[0] + amplitude * noise4(x, y, z, t),
      normal[1] + amplitude * noise4(100 + x, y, z, t),
      normal[2] + amplitude * noise4(200 + x, y, z, t)
    ];
    const length = Math.hypot(...bent);
    normal = bent.map((value) => value / length);
  } else if (kind === DEFORM_BULGE) {
    const [width, height, angle] = args;
    const scale = Math.sin(given.st[0] * width + angle) * height;
    for (let i = 0; i < 3; i++) position[i] += normal[i] * scale;
  } else if (kind === DEFORM_MOVE) {
    for (let i = 0; i < 3; i++) position[i] += args[i];
  }
  return { position, normal, st: given.st };
}

/**
 * What the chunks' `q3Sprite` does with one packed slot for vertex `v`, in double precision:
 * each vertex finds its quad's four corners afresh, each morphed and bent by the slots before,
 * and takes its own place in the stamp or the pivot.
 *
 * @param view - `q3_view`, as {@link writeView} packs it.
 * @param texels - The surface's frame texels, for its quads' edge orders.
 * @param starts - Every vertex as the morph leaves it.
 */
function sprite(
  packed: Float32Array,
  view: Float32Array,
  texels: Float32Array,
  starts: Vert[],
  slot: number,
  v: number,
  given: Vert
): Vert {
  const kind = packed[slot * 8];
  const first = v - (v % 4);
  const isSprite = kind === DEFORM_AUTOSPRITE || kind === DEFORM_AUTOSPRITE2;
  if (view[3] === 0 || !isSprite || first + 3 >= starts.length) return given;
  const corners = [0, 1, 2, 3].map((k) => {
    let vert = starts[first + k];
    for (let before = 0; before < slot; before++) vert = bend(packed, before, vert);
    return vert.position;
  });
  const axis = (row: number) => [...view.subarray(row * 4, row * 4 + 3)];
  const corner = v - first;
  if (kind === DEFORM_AUTOSPRITE) {
    const mid = [0, 1, 2].map((i) => 0.25 * (corners[0][i] + corners[1][i] + corners[2][i] + corners[3][i]));
    const radius = Math.hypot(...corners[0].map((value, i) => value - mid[i])) * 0.707;
    const l = corner === 0 || corner === 3 ? 1 : -1;
    const u = corner < 2 ? 1 : -1;
    const [left, up] = [axis(1), axis(2)];
    return {
      position: mid.map((value, i) => value + l * left[i] * radius + u * up[i] * radius),
      normal: axis(3),
      st: [corner === 1 || corner === 2 ? 1 : 0, corner < 2 ? 0 : 1]
    };
  }
  const nums = [0, 0];
  const lengths = [999999, 999999];
  QUAD_EDGES.forEach(([a, b], e) => {
    const l = corners[a].reduce((sum, value, i) => sum + (value - corners[b][i]) ** 2, 0);
    if (l < lengths[0]) {
      [nums[1], lengths[1], nums[0], lengths[0]] = [nums[0], lengths[0], e, l];
    } else if (l < lengths[1]) {
      [nums[1], lengths[1]] = [e, l];
    }
  });
  const mids = nums.map((e) => {
    const [a, b] = QUAD_EDGES[e];
    return corners[a].map((value, i) => 0.5 * (value + corners[b][i]));
  });
  const major = mids[1].map((value, i) => value - mids[0][i]);
  const forward = axis(0);
  const cross = [
    major[1] * forward[2] - major[2] * forward[1],
    major[2] * forward[0] - major[0] * forward[2],
    major[0] * forward[1] - major[1] * forward[0]
  ];
  const length = Math.hypot(...cross);
  const minor = cross.map((value) => (length > 0 ? value / length : value));
  const orders = texels[vertexTexel(first) * 4 + 2];
  let { position } = given;
  nums.forEach((e, j) => {
    const [a, b] = QUAD_EDGES[e];
    const span = 0.5 * Math.sqrt(lengths[j]);
    const toward = (orders >> e) & 1 ? -1 : 1;
    if (corner === a) position = mids[j].map((value, i) => value + toward * span * minor[i]);
    if (corner === b) position = mids[j].map((value, i) => value - toward * span * minor[i]);
  });
  return { ...given, position };
}

describe('writeDeforms', () => {
  /** What the chunks do with the packed slots for one vertex, with no sprite. */
  function drawn(packed: Float32Array, start: Vert): Vert {
    let vert = start;
    for (let slot = 0; slot < 3; slot++) vert = bend(packed, slot, vert);
    return vert;
  }

  const ripple: WaveDeform = {
    type: 'wave',
    spread: 1 / 100,
    wave: { func: 'sin', base: 0, amplitude: 2, phase: 0.1, frequency: 0.5 }
  };
  const swell: WaveDeform = {
    type: 'wave',
    spread: 1 / 100,
    wave: { func: 'sawtooth', base: 3, amplitude: 1, phase: 0, frequency: 0 }
  };
  /** pak0's flags', its hologram's rise, and a bulge. */
  const shimmer: Deform = { type: 'normal', amplitude: 0.3, frequency: 0.2 };
  const rise: Deform = {
    type: 'move',
    vector: [0, 0, 0.7],
    wave: { func: 'sin', base: 0, amplitude: 5, phase: 0, frequency: 0.2 }
  };
  const swelling: Deform = { type: 'bulge', width: 3, height: 10, speed: 1 };

  it('moves a vertex where deformVertexes does, a day into the level', () => {
    // A float's clock would have lost every phase by now; the uniform holds each reduced.
    const seconds = 86_400 + 0.37;
    const start = { position: [10, -20, 30], normal: [0, 0.6, 0.8], st: [0.3, 0.9] };
    for (const deforms of [
      [ripple, swell],
      [shimmer, swelling, rise],
      [rise, ripple, shimmer]
    ]) {
      const out = new Float32Array(24);
      writeDeforms(deforms, seconds, out);
      const expected = {
        positions: Float32Array.from(start.position),
        normals: Float32Array.from(start.normal),
        uvs: Float32Array.from(start.st),
        indices: [0]
      };
      deformVertexes(deforms, expected, seconds, null);
      const actual = drawn(out, start);
      const kinds = deforms.map((deform) => deform.type).join(', ');
      for (let i = 0; i < 3; i++) {
        expect(actual.position[i], `${kinds}: position ${i}`).toBeCloseTo(expected.positions[i], 3);
        expect(actual.normal[i], `${kinds}: normal ${i}`).toBeCloseTo(expected.normals[i], 4);
      }
    }
  });

  it('turns sprites where deformVertexes does, each vertex finding its quad afresh', () => {
    const seconds = 86_400 + 0.37;
    const surface = strips();
    const { positions, normals } = surface.frames[0];
    const starts: Vert[] = Array.from({ length: surface.numVerts }, (_, v) => ({
      position: [...positions.subarray(v * 3, v * 3 + 3)],
      normal: [...normals.subarray(v * 3, v * 3 + 3)],
      st: [...surface.uvs.subarray(v * 2, v * 2 + 2)]
    }));
    const texels = packFrames(surface).data;
    const view = new Float32Array(16);
    writeView(VIEW, view);
    const lift: Deform = { type: 'move', vector: [0, 0, 1], wave: { func: 'sin', base: 10, amplitude: 0, phase: 0, frequency: 0 } };
    /** The jets' `wave 100 sin 0 1 0 9`, after their `autoSprite2`. */
    const flicker: Deform = { type: 'wave', spread: 1 / 100, wave: { func: 'sin', base: 0, amplitude: 1, phase: 0, frequency: 9 } };
    for (const deforms of [
      [{ type: 'autosprite' }],
      [lift, { type: 'autosprite' }, ripple],
      [{ type: 'autosprite2' }, flicker],
      [ripple, { type: 'autosprite2' }]
    ] as Deform[][]) {
      const packed = new Float32Array(24);
      writeDeforms(deforms, seconds, packed);
      const expected = {
        positions: Float32Array.from(positions),
        normals: Float32Array.from(normals),
        uvs: Float32Array.from(surface.uvs),
        indices: surface.indices
      };
      deformVertexes(deforms, expected, seconds, VIEW);
      const kinds = deforms.map((deform) => deform.type).join(', ');
      starts.forEach((start, v) => {
        let vert = start;
        for (let slot = 0; slot < 3; slot++) {
          vert = bend(packed, slot, sprite(packed, view, texels, starts, slot, v, vert));
        }
        for (let i = 0; i < 3; i++) {
          expect(vert.position[i], `${kinds}: ${v} position ${i}`).toBeCloseTo(expected.positions[v * 3 + i], 3);
          expect(vert.normal[i], `${kinds}: ${v} normal ${i}`).toBeCloseTo(expected.normals[v * 3 + i], 5);
        }
        expect(vert.st, `${kinds}: ${v} st`).toEqual([...expected.uvs.subarray(v * 2, v * 2 + 2)]);
      });
    }
  });

  it("gives a wave with no frequency no spread, since it pushes every vertex alike", () => {
    const out = new Float32Array(24);
    writeDeforms([swell], 5, out);
    expect([...out.subarray(0, 8)]).toEqual([DEFORM_WAVE, 3, 0, 0, 3, 1, 0, 0]);
    // The rest are empty.
    expect(out.subarray(8).every((value) => value === 0)).toBe(true);
  });

  it("packs each other kind's arguments, and its moment within a period", () => {
    const out = new Float32Array(24);
    // At 1.25 s the flag's shimmer is 0.25 along the noise's time, the bulge 1.25 radians round,
    // and the hologram has risen its whole 3.5.
    writeDeforms([shimmer, swelling, rise], 1.25, out);
    expect([...out.subarray(0, 4)]).toEqual([DEFORM_NORMAL, 0, 0, 0]);
    expect(out[4]).toBeCloseTo(0.3, 6);
    expect(out[5]).toBeCloseTo(0.25, 6);
    expect([...out.subarray(8, 12)]).toEqual([DEFORM_BULGE, 0, 0, 0]);
    expect([out[12], out[13]]).toEqual([3, 10]);
    expect(out[14]).toBeCloseTo(1.25, 6);
    expect([...out.subarray(16, 20)]).toEqual([DEFORM_MOVE, 0, 0, 0]);
    expect([out[20], out[21]]).toEqual([0, 0]);
    expect(out[22]).toBeCloseTo(3.5, 5);
    // A day on, each moment is still within its period.
    writeDeforms([shimmer, swelling], 86_400 + 1.25, out);
    expect(out[5]).toBeCloseTo((86_401.25 * 0.2) % 256, 3);
    expect(out[14]).toBeCloseTo(86_401.25 % (2 * Math.PI), 4);
  });

  it('reaches as far as each kind can move a vertex', () => {
    // The swell's 3 + 1, the bulge's 10, and the rise's 0.7 · 5; the shimmer moves none.
    expect(deformReach([swell, swelling, rise], strips())).toBeCloseTo(4 + 10 + 3.5, 6);
    expect(deformReach([shimmer], strips())).toBe(0);
    // A sprite as far as the strips' farthest corner from its middle, (10, −4, 5) from
    // (11, 0, 37); what came before it counts three times, and what comes after once.
    const corner = Math.hypot(1, 4, 32);
    expect(deformReach([{ type: 'autosprite' }], strips())).toBeCloseTo(corner, 5);
    expect(deformReach([ripple, { type: 'autosprite2' }, ripple], strips())).toBeCloseTo(3 * 2 + corner + 2, 5);
  });

  it('marks a sprite slot by its kind alone, the rest in their slots', () => {
    const out = new Float32Array(24);
    writeDeforms([{ type: 'autosprite' }, swell, { type: 'autosprite2' }], 5, out);
    expect([...out.subarray(0, 8)]).toEqual([DEFORM_AUTOSPRITE, 0, 0, 0, 0, 0, 0, 0]);
    expect(out[8]).toBe(DEFORM_WAVE);
    expect([...out.subarray(16, 24)]).toEqual([DEFORM_AUTOSPRITE2, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('keeps three slots, as MAX_SHADER_DEFORMS does', () => {
    const out = new Float32Array(24);
    writeDeforms([ripple, ripple, ripple, ripple], 0, out);
    expect([out[0], out[8], out[16]]).toEqual([DEFORM_WAVE, DEFORM_WAVE, DEFORM_WAVE]);
  });

  it('leaves a slot empty that deforms nothing, and draws none of the kinds the chunks lack', () => {
    const out = new Float32Array(24).fill(9);
    writeDeforms([{ type: 'none' }, { type: 'projectionShadow' }, { type: 'text', index: 2 }], 0, out);
    expect(out.every((value) => value === 0)).toBe(true);
  });

  it('drops the map for a wave Q3 has no table for, as TableForFunc does', () => {
    const noise: Deform = { type: 'wave', spread: 0.01, wave: { ...ripple.wave, func: 'noise' } };
    expect(() => writeDeforms([noise], 0, new Float32Array(24))).toThrow(
      new Error("TableForFunc called with invalid function '6'")
    );
  });

  it('reduces a phase in double precision', () => {
    expect(phaseNow({ func: 'sin', base: 0, amplitude: 1, phase: 0.25, frequency: 3 }, 1e6 + 0.5)).toBeCloseTo(
      0.75,
      9
    );
  });
});

/** The dot product of two triples. */
function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Three vertices over two frames, moved and turned between them. */
function moving(): Md3Surface {
  return {
    name: 'moving',
    shaders: [],
    numVerts: 3,
    indices: Uint32Array.from([0, 1, 2]),
    uvs: Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
    frames: [
      {
        positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 5]),
        normals: Float32Array.from([0, 0, 1, 1, 0, 0, 0, 0.6, 0.8])
      },
      {
        positions: Float32Array.from([2, 1, 0, 12, -3, 4, 1, 9, 8]),
        normals: Float32Array.from([0, 1, 0, 0, 0, 1, 0.8, 0, 0.6])
      }
    ]
  };
}

/** Vertex `v` of a frame, as the chunks carry it. */
function vertexOf(surface: Md3Surface, frame: number, v: number): Vert {
  const { positions, normals } = surface.frames[frame];
  return {
    position: [...positions.subarray(v * 3, v * 3 + 3)],
    normal: [...normals.subarray(v * 3, v * 3 + 3)],
    st: [...surface.uvs.subarray(v * 2, v * 2 + 2)]
  };
}

/**
 * What the chunks' `q3Morph` gives vertex `v`, in double precision, from the frames' texels and
 * `q3_anim` as {@link writeAnim} packs it: the twin of their code. `opengl1`'s makes a blended
 * normal unit again.
 */
function morph(texels: Float32Array, anim: Float32Array, v: number, style: RendererStyle = CLASSIC): Vert {
  const texel = (index: number) => [...texels.subarray(index * 4, index * 4 + 3)];
  const numVerts = anim[3];
  const newer = numVerts + (anim[1] * numVerts + v) * 2;
  let position = texel(newer);
  let normal = texel(newer + 1);
  const backlerp = anim[2];
  if (backlerp !== 0) {
    const older = numVerts + (anim[0] * numVerts + v) * 2;
    position = texel(older).map((value, i) => value * backlerp + position[i] * (1 - backlerp));
    const blended = texel(older + 1).map((value, i) => value * backlerp + normal[i] * (1 - backlerp));
    const length = Math.hypot(...blended);
    normal = style.renderer === 'opengl1' && length > 0 ? blended.map((value) => value / length) : blended;
  }
  return { position, normal, st: texel(v).slice(0, 2) };
}

/**
 * What `stage-coordinates.ts`' `q3Coordinates` gives coordinates at a place from its pieces: each
 * piece in turn, and each turb between them adding the sine at the step its place reaches.
 */
function coordinates(uv: number[], position: readonly number[], pieces: Float32Array): number[] {
  const affine = (at: number) => [
    uv[0] * pieces[at * 4] + uv[1] * pieces[at * 4 + 1] + pieces[at * 4 + 2],
    uv[0] * pieces[at * 4 + 4] + uv[1] * pieces[at * 4 + 5] + pieces[at * 4 + 6]
  ];
  uv = affine(1);
  const turbs = Math.trunc(pieces[0]);
  for (let j = 0; j < 4; j++) {
    if (j >= turbs) break;
    const turb = pieces.subarray((3 + 3 * j) * 4, (4 + 3 * j) * 4);
    const step = (sum: number) => {
      const scaled = sum + turb[1] * 1024;
      const whole = scaled >= -1024 * turb[2] ? Math.floor(scaled) : Math.ceil(scaled);
      return Math.sin((whole - 1024 * Math.floor(whole / 1024)) * ((2 * Math.PI) / 1023));
    };
    uv = [uv[0] + step(position[0] + position[2]) * turb[0], uv[1] + step(position[1]) * turb[0]];
    uv = affine(4 + 3 * j);
  }
  return uv;
}

/**
 * What the chunks' `getUv0` gives a vertex, under a stage's `Q3_TCGEN_ENV` and `Q3_TCMOD`, from
 * `q3_viewer` and `q3_coords`.
 */
function uv0(vert: Vert, viewer: Float32Array, environment: boolean, pieces: Float32Array | null = null): number[] {
  let uv = [...vert.st];
  if (environment && viewer[3] > 0) {
    let toViewer = [0, 1, 2].map((i) => viewer[i] - vert.position[i]);
    const length = Math.hypot(...toViewer);
    if (length > 0) toViewer = toViewer.map((value) => value / length);
    const d = dot(vert.normal, toViewer);
    uv = [
      0.5 + (vert.normal[1] * 2 * d - toViewer[1]) * 0.5,
      0.5 - (vert.normal[2] * 2 * d - toViewer[2]) * 0.5
    ];
  }
  if (pieces) uv = coordinates(uv, vert.position, pieces);
  return uv;
}

/** What `opengl1`'s `q3Shade` gives a normal from `q3_light`, as the byte before it is scaled to 1. */
function shade(normal: readonly number[], light: Float32Array, style: RendererStyle): number[] {
  const scale = overbrightFactor(style) / LIGHT_HEADROOM;
  const incoming = Math.max(dot(normal, [...light.subarray(8, 11)]), 0);
  return [0, 1, 2].map((i) => {
    const lit = Math.min(Math.floor(light[i] + incoming * light[4 + i]), 255);
    return Math.min(Math.floor(lit * scale + 0.5), 255);
  });
}

/**
 * What `opengl2`'s `q3Shade` gives a normal from `q3_light`: as the generic program shades it, or as
 * `fastLight` does at `overbright`.
 */
function modernShade(normal: readonly number[], light: Float32Array, generic: boolean, overbright: number): number[] {
  const toLight = [...light.subarray(8, 11)];
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  if (generic) {
    const incoming = clamp(dot(normal, toLight));
    return [0, 1, 2].map((i) => clamp((light[i] + incoming * light[4 + i]) / 255) / LIGHT_HEADROOM);
  }
  const incoming = clamp(dot(normal, toLight) / Math.hypot(...normal) / Math.hypot(...toLight));
  return [0, 1, 2].map((i) => (overbright * (light[i] + incoming * light[4 + i])) / 255 / LIGHT_HEADROOM);
}

/**
 * What the per-pixel `q3Lightall` gives a pixel from its texel, the normal and position carried
 * to it, which face it is, `q3_light` and `q3_viewer`.
 */
function lightall(
  texel: readonly [number, number, number],
  carried: Vert,
  frontFacing: boolean,
  light: Float32Array,
  viewer: Float32Array,
  overbright: number
): number[] {
  const unit = (v: number[]) => v.map((value) => value / Math.hypot(...v));
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const N = unit(carried.normal.map((value) => (frontFacing ? -value : value)));
  const L = unit([...light.subarray(8, 11)]);
  const E = viewer[3] > 0 ? unit([0, 1, 2].map((i) => viewer[i] - carried.position[i])) : N;
  const H = unit([0, 1, 2].map((i) => L[i] + E[i]));
  const NL = clamp(dot(N, L));
  const [NH, EH] = [clamp(dot(N, H)), clamp(dot(E, H))];
  const rr = 0.7 * 0.7;
  const rrrr = rr * rr;
  const d = NH * NH * (rrrr - 1) + 1;
  const v = EH * EH * (0.7 + 0.5) + 0.00000001;
  const highlight = 0.04 * (rrrr / (4 * d * d * v)) * 0.3;
  return [0, 1, 2].map((i) => {
    const diffuse = texel[i] * (1 - 0.04);
    return (overbright * (light[4 + i] * (diffuse + highlight) * NL + light[i] * diffuse)) / 255;
  });
}

/** What the chunks' `q3SpecularAlpha` gives a vertex from `q3_viewer`: `opengl1`'s as a byte. */
function specular(vert: Vert, viewer: Float32Array, style: RendererStyle = CLASSIC): number {
  if (viewer[3] === 0) return 0;
  let toLight = SPECULAR_LIGHT_ORIGIN.map((value, i) => value - vert.position[i]);
  const towards = Math.hypot(...toLight);
  toLight = toLight.map((value) => value / (towards > 0 ? towards : 1));
  const d = dot(vert.normal, toLight);
  const reflected = vert.normal.map((value, i) => value * 2 * d - toLight[i]);
  const toViewer = [0, 1, 2].map((i) => viewer[i] - vert.position[i]);
  const seen = Math.hypot(...toViewer);
  const l = seen > 0 ? dot(reflected, toViewer) / seen : 0;
  if (l < 0) return 0;
  if (style.renderer === 'opengl2') return Math.min(l, 1) ** 4;
  return Math.min(255, Math.floor(l * l * l * l * 255));
}

describe('the chunks against their twins', () => {
  it('morphs a vertex where lerpMeshVertexes does, and draws frame 0 for a frame the model lacks', () => {
    const surface = moving();
    const texels = packFrames(surface).data;
    const anim = new Float32Array(4);
    for (const blend of [
      { oldFrame: 0, frame: 1, backlerp: 0.3 },
      { oldFrame: 1, frame: 0, backlerp: 0 },
      { oldFrame: 1, frame: 5, backlerp: 0.5 }
    ]) {
      writeAnim(surface.frames.length, surface.numVerts, blend, anim);
      const [oldFrame, frame] = drawnFrames(surface.frames.length, blend.oldFrame, blend.frame);
      for (const style of [CLASSIC, MODERN]) {
        const positions = new Float32Array(9);
        const normals = new Float32Array(9);
        lerpMeshVertexes(surface, oldFrame, frame, blend.backlerp, positions, normals, style);
        for (let v = 0; v < 3; v++) {
          const vert = morph(texels, anim, v, style);
          expectClose(vert.position, positions.subarray(v * 3, v * 3 + 3));
          expectClose(vert.normal, normals.subarray(v * 3, v * 3 + 3));
          expectClose(vert.st, surface.uvs.subarray(v * 2, v * 2 + 2));
        }
      }
    }
    // Blended, opengl2's normal is short of unit, so the comparison is not of one rule twice.
    writeAnim(2, 3, { oldFrame: 0, frame: 1, backlerp: 0.3 }, anim);
    expect(Math.hypot(...morph(texels, anim, 0, MODERN).normal)).toBeLessThan(0.99);
  });

  it('mirrors coordinates where environmentUvs does, and moves them after, a day into the level', () => {
    const seconds = 86_400 + 0.37;
    const surface = moving();
    const { positions, normals } = surface.frames[1];
    const at = [40, -30, 20] as const;
    const ripple: TexMod = { type: 'turb', wave: { func: 'sin', base: 0, amplitude: 0.25, phase: 0.1, frequency: 1.6 } };
    const pieces = new Float32Array(COORDINATES_LENGTH);
    writeCoordinates([ripple], seconds, pieces);
    const viewer = new Float32Array(4);
    for (const [environment, rippled, seen] of [
      [true, false, true],
      [false, true, true],
      [true, true, true],
      [true, true, false]
    ] as const) {
      writeViewer(seen ? at : null, viewer);
      // With no viewer, a mirror keeps the surface's own, as the ripple then moves.
      let expected: ArrayLike<number> = Float32Array.from(surface.uvs);
      if (environment && seen) expected = environmentUvs(positions, normals, at, new Float32Array(6));
      for (let v = 0; v < 3; v++) {
        let want = [expected[v * 2], expected[v * 2 + 1]];
        if (rippled) {
          const [x, y, z] = positions.subarray(v * 3, v * 3 + 3);
          want = coordinatesAt(pieces, want[0], want[1], x, y, z, [0, 0]);
        }
        const drawn = uv0(vertexOf(surface, 1, v), viewer, environment, rippled ? pieces : null);
        expectClose(drawn, want);
      }
    }
  });

  it('moves coordinates where coordinatesAt does, a turb after a scale in its place', () => {
    const surface = moving();
    const mods: TexMod[] = [
      { type: 'stretch', wave: { func: 'triangle', base: 0.6, amplitude: 0.1, phase: 0, frequency: 8 } },
      { type: 'scale', s: 3.5, t: 1 },
      { type: 'turb', wave: { func: 'sin', base: 0, amplitude: 0.25, phase: 0.1, frequency: 1.6 } },
      { type: 'rotate', degreesPerSecond: 999 }
    ];
    const viewer = Float32Array.from([0, 0, 0, 0]);
    for (const seconds of [0.37, 1234.5]) {
      const pieces = new Float32Array(COORDINATES_LENGTH);
      writeCoordinates(mods, seconds, pieces);
      for (let v = 0; v < 3; v++) {
        const vert = vertexOf(surface, 1, v);
        const [x, y, z] = vert.position;
        const expected = coordinatesAt(pieces, vert.st[0], vert.st[1], x, y, z, [0, 0]);
        expectClose(uv0(vert, viewer, false, pieces), expected);
      }
    }
  });

  it("shades a vertex where shadeVertices does under opengl1, in a window and past the sun's light", () => {
    const surface = moving();
    const { normals } = surface.frames[1];
    const packed = new Float32Array(12);
    const styles: RendererStyle[] = [CLASSIC, { renderer: 'opengl1', overBrightBits: 0 }];
    const lights: EntityLight[] = [
      { ambient: [91, 40, 10], directed: [75, 150, 0], direction: [0, 0.6, 0.8] },
      // Brighter than the sun: `opengl1` stops at 255, and the byte at the headroom.
      { ambient: [200, 200, 200], directed: [255, 160, 40], direction: [0.6, 0, 0.8] }
    ];
    for (const style of styles) {
      for (const light of lights) {
        writeLight(light, packed);
        const expected = new Uint8Array(12);
        shadeVertices(normals, light, expected, style);
        for (let v = 0; v < 3; v++) {
          const drawn = shade([...normals.subarray(v * 3, v * 3 + 3)], packed, style);
          expect(drawn, `${style.renderer} ${style.overBrightBits}: ${v}`).toEqual([...expected.subarray(v * 4, v * 4 + 3)]);
        }
      }
    }
  });

  it('lights a highlight where specularAlphas does, and none with no viewer', () => {
    const surface = moving();
    const { positions, normals } = surface.frames[1];
    // Near where the light mirrors off the first vertex, which shines almost fully, and off to one
    // side.
    const first = vertexOf(surface, 1, 0);
    const toLight = SPECULAR_LIGHT_ORIGIN.map((value, i) => value - first.position[i]);
    const towards = Math.hypot(...toLight);
    const d = dot(first.normal, toLight) / towards;
    const mirrored = first.normal.map((value, i) => value * 2 * d - toLight[i] / towards);
    const near = [0, 1, 2].map((i) => first.position[i] + mirrored[i] * 64 + (i === 0 ? 3 : 0));
    const viewer = new Float32Array(4);
    for (const at of [near, [40, -30, 20]]) {
      writeViewer([at[0], at[1], at[2]], viewer);
      const expected = new Uint8Array(12);
      specularAlphas(positions, normals, [at[0], at[1], at[2]], expected);
      for (let v = 0; v < 3; v++) {
        expect(specular(vertexOf(surface, 1, v), viewer), `${v}`).toBe(expected[v * 4 + 3]);
      }
    }
    expect(specular(first, viewer.fill(0))).toBe(0);
    // The near viewer does see a highlight, so the comparison is not of zeros.
    writeViewer([near[0], near[1], near[2]], viewer);
    expect(specular(first, viewer)).toBeGreaterThan(200);
    // opengl2's is whole, where specularAlpha keeps it so.
    for (let v = 0; v < 3; v++) {
      const vert = vertexOf(surface, 1, v);
      const l = mirroredLight(vert.position, vert.normal, near);
      expect(specular(vert, viewer, MODERN), `${v}`).toBeCloseTo(specularAlpha(l, MODERN), 7);
    }
    expect(specular(first, viewer, MODERN) * 255 % 1).not.toBe(0);
  });

  /** Lights as the chunks read them: the sun's, and a coloured one past it. */
  const LIGHTS: EntityLight[] = [
    { ambient: [91, 40, 10], directed: [75, 150, 0], direction: [0, 0.6, 0.8] },
    { ambient: [200, 200, 200], directed: [255, 160, 40], direction: [0.6, 0, 0.8] }
  ];

  it("shades a vertex as opengl2's fastLight and generic programs do, from the normal as morphed", () => {
    const surface = moving();
    const texels = packFrames(surface).data;
    const anim = new Float32Array(4);
    writeAnim(2, 3, { oldFrame: 0, frame: 1, backlerp: 0.3 }, anim);
    const packed = new Float32Array(12);
    for (const light of LIGHTS) {
      writeLight(light, packed);
      for (let v = 0; v < 3; v++) {
        // The normal the morph leaves under opengl2, short of unit.
        const { normal } = morph(texels, anim, v, MODERN);
        const unit = normal.map((value) => value / Math.hypot(...normal));
        const fast = modernShade(normal, packed, false, 2);
        const generic = modernShade(normal, packed, true, 2);
        for (let i = 0; i < 3; i++) {
          const expectedFast = diffuseShade(dot(unit, light.direction), light.ambient[i], light.directed[i], MODERN);
          expect(fast[i] * LIGHT_HEADROOM, `fast ${v} ${i}`).toBeCloseTo(expectedFast, 6);
          const expectedGeneric = genericShade(dot(normal, light.direction), light.ambient[i], light.directed[i]);
          expect(generic[i] * LIGHT_HEADROOM, `generic ${v} ${i}`).toBeCloseTo(expectedGeneric, 6);
        }
      }
    }
    // A stage that multiplies takes no overbright factor.
    writeLight(LIGHTS[0], packed);
    expect(modernShade([0, 0, 1], packed, false, 1)[0] * 2).toBeCloseTo(modernShade([0, 0, 1], packed, false, 2)[0], 12);
  });

  it('lights a pixel where lightallShade does, on either face and with no viewer', () => {
    const packed = new Float32Array(12);
    const viewer = new Float32Array(4);
    const texel = [0.8, 0.5, 0.2] as const;
    // Carried to the pixel: a normal short of unit, as opengl2's morph leaves it.
    const carried: Vert = { position: [4, -2, 10], normal: [0.1, 0.5, 0.7], st: [0, 0] };
    const at = [40, -30, 60] as const;
    for (const light of LIGHTS) {
      writeLight(light, packed);
      for (const seen of [true, false]) {
        writeViewer(seen ? at : null, viewer);
        for (const frontFacing of [false, true]) {
          for (const overbright of [2, 1]) {
            const facing = carried.normal.map((value) => (frontFacing ? -value : value));
            const toViewer = seen ? at.map((value, i) => value - carried.position[i]) : facing;
            const expected = lightallShade(texel, facing, toViewer, light, overbright);
            const drawn = lightall(texel, carried, frontFacing, packed, viewer, overbright);
            expectClose(drawn, expected);
          }
        }
      }
    }
    // Seen, the highlight shows, so the comparison is of more than the diffuse.
    writeLight({ ...LIGHTS[0], direction: [0, 0, 1] }, packed);
    writeViewer([4, -2, 50], viewer);
    const up: Vert = { position: [4, -2, 10], normal: [0, 0, 1], st: [0, 0] };
    const shining = lightall([0, 0, 0], up, false, packed, viewer, 2)[0];
    expect(shining).toBeGreaterThan(0);
  });
});

describe('modelChunks', () => {
  it("squeezes a depth-hacked draw's depth into the range's front 30%, in each clip space", () => {
    const chunks = modelChunks(CLASSIC);
    // WGSL's depth runs from 0 to 1, GLSL's from -1 to 1: either way 0.3 of the way.
    expect(chunks.wgsl.get('litUserMainEndVS')).toContain(
      '#ifdef Q3_DEPTH_HACK\n\t\toutput.position.z = 0.3 * output.position.z;'
    );
    expect(chunks.glsl.get('litUserMainEndVS')).toContain(
      '#ifdef Q3_DEPTH_HACK\n\t\tgl_Position.z = 0.3 * gl_Position.z - 0.7 * gl_Position.w;'
    );
    // GLSL's near plane stays at depth 0, and its far one comes to 0.3.
    const depth = (z: number) => ((0.3 * z - 0.7) / 1 + 1) / 2;
    expect(depth(-1)).toBe(0);
    expect(depth(1)).toBeCloseTo(0.3, 12);
  });

  it("writes the style's numbers in: opengl1's clamp, and the shade scaled by the light", () => {
    const classic = modelChunks(CLASSIC);
    const modern = modelChunks({ renderer: 'opengl2', overBrightBits: 1 });
    for (const language of ['glsl', 'wgsl'] as const) {
      expect(classic[language].get('litUserCodeVS'), language).toMatch(/light = min\(light, vec3f?\(255\.0\)\);/);
      // The framebuffer's byte truncated before it is held, as `diffuseByte` cuts it.
      const at = language === 'glsl' ? '' : 'uniform.';
      expect(classic[language].get('litUserCodeVS'), language).toContain(
        `light = floor(${at}q3_light[0].rgb + incoming * ${at}q3_light[1].rgb);`
      );
      expect(modern[language].get('litUserCodeVS'), language).not.toMatch(/light = min\(light/);
      expect(classic[language].get('litUserCodeVS'), language).toContain(
        `light * ${at}q3_light[1].w + 0.5`
      );
      const [x, y, z] = SPECULAR_LIGHT_ORIGIN;
      expect(classic[language].get('litUserCodeVS'), language).toContain(`(${x}.0, ${y}.0, ${z}.0)`);
    }
  });

  it("writes opengl2's rules in: no renormalising, fastLight and generic, a whole highlight, and lightall's numbers", () => {
    const classic = modelChunks(CLASSIC);
    const modern = modelChunks({ renderer: 'opengl2', overBrightBits: 2 });
    for (const language of ['glsl', 'wgsl'] as const) {
      expect(classic[language].get('transformCoreVS'), language).toContain('normal / len');
      expect(modern[language].get('transformCoreVS'), language).not.toContain('normal / len');
      expect(modern[language].get('transformCoreVS'), language).toContain('vert.normal = normal;');
      expect(classic[language].get('litUserCodeVS'), language).toContain('floor(l * l * l * l * 255.0)');
      expect(modern[language].get('litUserCodeVS'), language).toContain('return c * c * c * c;');
      expect(modern[language].get('litUserCodeVS'), language).toContain('#ifdef Q3_LIT_GENERIC');
      expect(classic[language].get('litUserCodeVS'), language).not.toContain('Q3_LIT_GENERIC');
      // The overbright factor, 4 at two bits, per vertex and per pixel.
      expect(modern[language].get('litUserCodeVS'), language).toMatch(/q3Overbright(: f32)? = 4\.0;/);
      expect(modern[language].get('emissivePS'), language).toMatch(/q3Overbright(: f32)? = 4\.0;/);
      const pixel = modern[language].get('emissivePS')!;
      for (const part of ['0.7 * 0.7', '(0.7 + 0.5)', '0.04 * (rrrr', ') * 0.3;', '(1.0 - 0.04)', '/ 2.0, vec3']) {
        expect(pixel, `${language} ${part}`).toContain(part);
      }
    }
  });

  it('reads each vertex by its index, in either language', () => {
    const { glsl, wgsl } = modelChunks(CLASSIC);
    // Both frames, the newer and the older, at the vertex's own place in each, after every
    // vertex's own coordinates.
    for (const frame of ['y', 'x']) {
      expect(glsl.get('transformCoreVS')).toContain(`numVerts + (int(q3_anim.${frame}) * numVerts + v) * 2`);
      expect(wgsl.get('transformCoreVS')).toContain(`numVerts + (i32(uniform.q3_anim.${frame}) * numVerts + v) * 2`);
    }
    expect(glsl.get('transformCoreVS')).toContain('vert.st = q3Texel(v).xy;');
    expect(glsl.get('transformCoreVS')).toContain('Q3Vertex vert = q3Morph(gl_VertexID);');
    expect(wgsl.get('transformCoreVS')).toContain('var vert = q3Morph(i32(pcVertexIndex));');
    // An unfilterable float texture, as the engine's skinning reads its pose.
    expect(wgsl.get('transformCoreVS')).toContain('var q3_frames: texture_2d<uff>;');
  });

  it("holds Q3's noise table and bytes as the port fills them, to the float", () => {
    for (const [language, chunks] of Object.entries(modelChunks(CLASSIC))) {
      const text = chunks.get('transformCoreVS')!;
      const [values, bytes] = [/q3NoiseTable[^(]*\(([^)]*)\)/, /q3NoisePerm[^(]*\(([^)]*)\)/].map((pattern) =>
        text.match(pattern)![1].split(',').map(Number)
      );
      expect(Float32Array.from(values), language).toEqual(NOISE_TABLE);
      expect(Uint8Array.from(bytes), language).toEqual(NOISE_PERM);
    }
  });

  it("keeps WGSL's noise tables in private variables, where a const takes seconds to compile", () => {
    const text = modelChunks(CLASSIC).wgsl.get('transformCoreVS')!;
    expect(text).toContain('var<private> q3NoiseTable: array<f32, 256> = array<f32, 256>(');
    expect(text).toContain('var<private> q3NoisePerm: array<i32, 256> = array<i32, 256>(');
    expect(text).not.toMatch(/const q3Noise/);
  });

  it("preprocesses opengl2's lighting cleanly under every combination of its defines", () => {
    const names = [
      'VERTEX_COLOR',
      'Q3_LIT',
      'Q3_LIT_GENERIC',
      'Q3_LIT_MULTIPLIES',
      'Q3_LIGHTALL',
      'Q3_SPECULAR',
      'STD_EMISSIVE_TEXTURE',
      'STD_EMISSIVE_VERTEX'
    ];
    for (const [language, chunks] of Object.entries(modelChunks(MODERN))) {
      for (let mask = 0; mask < 1 << names.length; mask++) {
        const on = (name: string) => (mask & (1 << names.indexOf(name))) !== 0;
        const defines = names.filter(on).map((name) => `#define ${name}\n`);
        const source = defines.join('') + [...chunks.values()].join('\n');
        const out = Preprocessor.run(source, new Map(), { stripDefines: true });
        const label = `${language} ${mask}`;
        expect(out, label).not.toBeNull();
        expect(out, label).not.toContain('#');
        expect(out!.includes('q3Shade(q3Normal)'), label).toBe(on('VERTEX_COLOR') && on('Q3_LIT'));
        expect(out!.includes('clamp((q3_light[0]') || out!.includes('clamp((uniform.q3_light[0]'), label).toBe(on('Q3_LIT_GENERIC'));
        // Per pixel: carried to the pixel and lit there, in place of the engine's emission.
        expect(out!.includes('q3Lightall(texel)'), label).toBe(on('Q3_LIGHTALL'));
        expect(/q3LitNormal = q3Normal/.test(out!), label).toBe(on('Q3_LIGHTALL'));
        expect(out!.includes('{STD_EMISSIVE_TEXTURE_DECODE}('), label).toBe(!on('Q3_LIGHTALL') && on('STD_EMISSIVE_TEXTURE'));
        expect(out!.includes('saturate'), label).toBe(!on('Q3_LIGHTALL') && on('STD_EMISSIVE_VERTEX'));
        expect(out!.includes('q3Overbright: f32 = 1.0') || out!.includes('q3Overbright = 1.0'), label).toBe(on('Q3_LIT_MULTIPLIES'));
      }
    }
  });

  it('preprocesses cleanly under each way a fog reaches a stage, and its other parts', () => {
    const fogs = [
      [],
      ['Q3_FOG_COORDS', 'Q3_FOG_PASS'],
      ['Q3_FOG_COORDS', 'Q3_FOG_KEEP', 'Q3_FOG_RGB'],
      ['Q3_FOG_COORDS', 'Q3_FOG_KEEP', 'Q3_FOG_ALPHA'],
      ['Q3_FOG_COORDS', 'Q3_FOG_KEEP', 'Q3_FOG_RGB', 'Q3_FOG_ALPHA']
    ];
    const others = ['Q3_TCGEN_ENV', 'Q3_TCMOD', 'Q3_LIGHTALL', 'Q3_DEPTH_HACK'];
    for (const [language, chunks] of Object.entries(modelChunks(CLASSIC))) {
      const end = applied(language === 'glsl' ? SHADERLANGUAGE_GLSL : SHADERLANGUAGE_WGSL);
      for (const fog of fogs) {
        for (let mask = 0; mask < 1 << others.length; mask++) {
          const on = [...fog, ...others.filter((_, i) => mask & (1 << i))];
          const defines = on.map((name) => `#define ${name}\n`).join('');
          const source = defines + [...chunks.values(), end].join('\n');
          const label = `${language} ${on.join(' ')}`;
          const out = Preprocessor.run(source, new Map(), { stripDefines: true });
          expect(out, label).not.toBeNull();
          expect(out, label).not.toContain('#');
          const has = (text: string) => out!.includes(text);
          const pass = fog.includes('Q3_FOG_PASS');
          const keep = fog.includes('Q3_FOG_KEEP');
          expect(has('return q3FogTexCoords(q3Position);'), label).toBe(pass);
          expect(has('return uv;'), label).toBe(!pass);
          expect(has('q3FogFactor(q3FogTexCoords(q3Position))'), label).toBe(keep);
          expect(has('q3FogTexCoords(v'), label).toBe(fog.length > 0);
        }
      }
    }

    /** The ending a stage's material takes from `applyModelChunks`, in a language. */
    function applied(language: string): string {
      const material = new StandardMaterial();
      applyModelChunks(material, PLAIN_STAGE, CLASSIC);
      const chunks = material.getShaderChunks(language as typeof SHADERLANGUAGE_GLSL);
      return chunks.get('litUserMainEndPS')!;
    }
  });

  it('preprocesses cleanly under every combination of its defines', () => {
    const names = [
      'VERTEX_COLOR',
      'Q3_LIT',
      'Q3_SPECULAR',
      'Q3_TCGEN_ENV',
      'Q3_TCMOD',
      'Q3_DEFORM_NOISE',
      'Q3_DEFORM_SPRITE',
      'Q3_LIGHTALL'
    ];
    for (const [language, chunks] of Object.entries(modelChunks(CLASSIC))) {
      for (let mask = 0; mask < 1 << names.length; mask++) {
        const defines = names.filter((_, i) => mask & (1 << i)).map((name) => `#define ${name}\n`);
        const source = defines.join('') + [...chunks.values()].join('\n');
        const out = Preprocessor.run(source, new Map(), { stripDefines: true });
        expect(out, `${language} ${mask}`).not.toBeNull();
        expect(out, `${language} ${mask}`).not.toContain('#');
        const writesColor = mask & 1 && mask & 2;
        expect(out!.includes('q3Shade(q3Normal)'), `${language} ${mask}`).toBe(Boolean(writesColor));
        // The noise, and a normal deform, only where a shader has one; so too the sprites.
        expect(out!.includes('q3NormalDeform(vert.position'), `${language} ${mask}`).toBe(Boolean(mask & 32));
        expect(out!.includes('q3Autosprite2('), `${language} ${mask}`).toBe(Boolean(mask & 64));
        expect(out!.includes('vert = q3Sprite(vert,'), `${language} ${mask}`).toBe(Boolean(mask & 64));
      }
    }
  });
});

describe('applyModelChunks', () => {
  let app: AppBase;
  beforeEach(() => {
    ({ app } = createTestApp());
  });
  afterEach(() => {
    app.destroy();
  });

  it("sets a fog's defines by how it reaches the stage", () => {
    const names = ['Q3_FOG_COORDS', 'Q3_FOG_PASS', 'Q3_FOG_KEEP', 'Q3_FOG_RGB', 'Q3_FOG_ALPHA'];
    for (const [fog, on] of [
      [undefined, []],
      ['pass', ['Q3_FOG_COORDS', 'Q3_FOG_PASS']],
      ['rgb', ['Q3_FOG_COORDS', 'Q3_FOG_KEEP', 'Q3_FOG_RGB']],
      ['alpha', ['Q3_FOG_COORDS', 'Q3_FOG_KEEP', 'Q3_FOG_ALPHA']],
      ['rgba', ['Q3_FOG_COORDS', 'Q3_FOG_KEEP', 'Q3_FOG_RGB', 'Q3_FOG_ALPHA']]
    ] as const) {
      const material = new StandardMaterial();
      applyModelChunks(material, { ...PLAIN_STAGE, fog }, CLASSIC);
      expect(names.filter((name) => material.defines.has(name)), String(fog)).toEqual(on);
    }
  });

  it("dims what a stage writes first, once however often set, before a merged texture", () => {
    const material = new StandardMaterial();
    const second = '\n\tq3MergedTexture();\n';
    material.getShaderChunks(SHADERLANGUAGE_GLSL).set('litUserMainEndPS', second);
    applyModelChunks(material, { ...PLAIN_STAGE, fog: 'rgb' }, CLASSIC);
    applyModelChunks(material, { ...PLAIN_STAGE, fog: 'rgb' }, MODERN);
    const ending = material.getShaderChunks(SHADERLANGUAGE_GLSL).get('litUserMainEndPS')!;
    expect(ending.split('q3FogKeep').length - 1).toBe(2);
    expect(ending.indexOf('gl_FragColor.rgb *= q3FogKeep;')).toBeLessThan(ending.indexOf(second));
    expect(ending).toMatch(/^\n#ifdef Q3_FOG_KEEP/);
    expect(material.getShaderChunks(SHADERLANGUAGE_WGSL).get('litUserMainEndPS')).toContain(
      'output.color.rgb * q3FogKeep'
    );
  });

  it.each(['glsl', 'wgsl'] as const)(
    "draws a pass on the fog's coordinates at each morphed vertex, and dims a stage there, in %s",
    (language) => {
      const glsl = language === 'glsl';
      const assemble = (fog: 'pass' | 'alpha') => {
        const material = new StandardMaterial();
        material.useLighting = false;
        // Blended, so its alpha is read through its coordinates.
        material.blendType = BLEND_NORMAL;
        const size = { width: 1, height: 1, format: PIXELFORMAT_RGBA8 };
        material.opacityMap = new Texture(app.graphicsDevice, size);
        applyModelChunks(material, { ...PLAIN_STAGE, fog }, CLASSIC);
        return assembledMaterial(app, material, language, { 'q3_fog[0]': new Float32Array(12) });
      };
      const pass = assemble('pass');
      expect(pass.vertex).toContain('return q3FogTexCoords(q3Position);');
      expect(pass.vertex).not.toContain('q3FogKeep');
      const dimmed = assemble('alpha');
      expect(dimmed.vertex).toContain(
        glsl
          ? 'q3FogKeep = 1.0 - q3FogFactor(q3FogTexCoords(q3Position));'
          : 'output.q3FogKeep = 1.0 - q3FogFactor(q3FogTexCoords(q3Position));'
      );
      expect(dimmed.vertex).not.toContain('return q3FogTexCoords(q3Position);');
      const alpha = glsl ? 'gl_FragColor.a *= q3FogKeep;' : 'output.color.a * q3FogKeep';
      const rgb = glsl ? 'gl_FragColor.rgb *= q3FogKeep' : 'output.color.rgb * q3FogKeep';
      expect(dimmed.fragment).toContain(alpha);
      expect(dimmed.fragment).not.toContain(rgb);
    }
  );

  it('sets both languages and the stage its defines', () => {
    const material = new StandardMaterial();
    applyModelChunks(material, { lit: true, specular: false, environment: true, coordinates: false, deforms: [] }, CLASSIC);
    const { glsl, wgsl } = modelChunks(CLASSIC);
    for (const name of glsl.keys()) {
      expect(material.getShaderChunks(SHADERLANGUAGE_GLSL).get(name), name).toBe(glsl.get(name));
      expect(material.getShaderChunks(SHADERLANGUAGE_WGSL).get(name), name).toBe(wgsl.get(name));
    }
    expect(material.shaderChunksVersion).toBe(MODEL_CHUNKS_VERSION);
    expect(material.defines.get('Q3_LIT')).toBe(true);
    expect(material.defines.has('Q3_SPECULAR')).toBe(false);
    expect(material.defines.get('Q3_TCGEN_ENV')).toBe(true);
    expect(material.defines.has('Q3_TCMOD')).toBe(false);
    expect(material.defines.has('Q3_DEFORM_NOISE')).toBe(false);
    expect(material.defines.has('Q3_DEFORM_SPRITE')).toBe(false);
  });

  it("brings the noise in for a shader that bends its normals, and only then", () => {
    const material = new StandardMaterial();
    const stage = { lit: false, specular: false, environment: true, coordinates: false };
    const shimmer: Deform = { type: 'normal', amplitude: 0.3, frequency: 0.2 };
    applyModelChunks(material, { ...stage, deforms: [{ type: 'bulge', width: 1, height: 1, speed: 1 }, shimmer] }, CLASSIC);
    expect(material.defines.get('Q3_DEFORM_NOISE')).toBe(true);
    applyModelChunks(material, { ...stage, deforms: [{ type: 'bulge', width: 1, height: 1, speed: 1 }] }, CLASSIC);
    expect(material.defines.has('Q3_DEFORM_NOISE')).toBe(false);
  });

  it("lights a lit stage the way its renderer's program does, and drops a highlight lightall has none of", () => {
    const material = new StandardMaterial();
    const lit = { lit: true, specular: true, environment: false, coordinates: false, deforms: [] };
    const wave: Deform = { type: 'wave', spread: 0, wave: { func: 'sin', base: 0, amplitude: 1, phase: 0, frequency: 1 } };
    const fast = { ...MODERN, normalMapping: false, specularMapping: false };
    const on = () =>
      ['Q3_LIT', 'Q3_LIT_GENERIC', 'Q3_LIGHTALL', 'Q3_SPECULAR', 'Q3_LIT_MULTIPLIES'].filter((name) =>
        material.defines.get(name)
      );
    applyModelChunks(material, lit, CLASSIC);
    expect(on()).toEqual(['Q3_LIT', 'Q3_SPECULAR']);
    applyModelChunks(material, lit, MODERN);
    expect(on()).toEqual(['Q3_LIGHTALL']);
    applyModelChunks(material, lit, fast);
    expect(on()).toEqual(['Q3_LIT']);
    applyModelChunks(material, { ...lit, deforms: [wave] }, MODERN);
    expect(on()).toEqual(['Q3_LIT', 'Q3_LIT_GENERIC', 'Q3_SPECULAR']);
    // A stage that is not lit keeps its highlight under opengl2: the generic program draws it.
    applyModelChunks(material, { ...lit, lit: false }, MODERN);
    expect(on()).toEqual(['Q3_SPECULAR']);
    // One that multiplies colour takes no overbright factor in lightall's program, either way.
    applyModelChunks(material, { ...lit, multiplies: true }, MODERN);
    expect(on()).toEqual(['Q3_LIGHTALL', 'Q3_LIT_MULTIPLIES']);
    applyModelChunks(material, { ...lit, multiplies: true }, fast);
    expect(on()).toEqual(['Q3_LIT', 'Q3_LIT_MULTIPLIES']);
    applyModelChunks(material, { ...lit, multiplies: true, deforms: [wave] }, MODERN);
    expect(on()).toEqual(['Q3_LIT', 'Q3_LIT_GENERIC', 'Q3_SPECULAR']);
  });

  it('asks for the viewer where a stage shines, mirrors or is lit per pixel', () => {
    const plain = { lit: false, specular: false, environment: false, coordinates: true, deforms: [] };
    const fast = { ...MODERN, normalMapping: false, specularMapping: false };
    expect(readsViewer(plain, MODERN)).toBe(false);
    expect(readsViewer({ ...plain, specular: true }, MODERN)).toBe(true);
    expect(readsViewer({ ...plain, environment: true }, CLASSIC)).toBe(true);
    expect(readsViewer({ ...plain, lit: true }, CLASSIC)).toBe(false);
    expect(readsViewer({ ...plain, lit: true }, MODERN)).toBe(true);
    expect(readsViewer({ ...plain, lit: true }, fast)).toBe(false);
    // fastLight drops a lit stage's highlight, and with it the viewer.
    expect(readsViewer({ ...plain, lit: true, specular: true }, fast)).toBe(false);
  });

  it('brings the sprites in for a shader with either, and only then', () => {
    const material = new StandardMaterial();
    const stage = { lit: false, specular: false, environment: false, coordinates: false };
    for (const type of ['autosprite', 'autosprite2'] as const) {
      applyModelChunks(material, { ...stage, deforms: [{ type }] }, CLASSIC);
      expect(material.defines.get('Q3_DEFORM_SPRITE'), type).toBe(true);
    }
    applyModelChunks(material, { ...stage, deforms: [{ type: 'bulge', width: 1, height: 1, speed: 1 }] }, CLASSIC);
    expect(material.defines.has('Q3_DEFORM_SPRITE')).toBe(false);
  });

  /**
   * The vertex shader the engine assembles for a stage that is lit, shines, mirrors, ripples,
   * bends its normals and pivots, with a texture so it reads coordinates. The null device builds WGSL when it says it is
   * WebGPU; nothing is compiled in either language, so this checks the assembly, and a live
   * check the rest.
   */
  function assembled(language: 'glsl' | 'wgsl'): string {
    return assembledShaders(language, CLASSIC).vertex;
  }

  /**
   * Both shaders the engine assembles for {@link assembled}'s stage under `style`, its shader
   * deforming by `deforms`.
   */
  function assembledShaders(
    language: 'glsl' | 'wgsl',
    style: RendererStyle,
    deforms: Deform[] = [{ type: 'normal', amplitude: 0.3, frequency: 0.2 }, { type: 'autosprite2' }]
  ): { vertex: string; fragment: string } {
    if (language === 'wgsl') (app.graphicsDevice as unknown as { isWebGPU: boolean }).isWebGPU = true;
    const surface: Md3Surface = {
      name: 'tri',
      shaders: [],
      numVerts: 3,
      indices: Uint32Array.from([0, 1, 2]),
      uvs: new Float32Array(6),
      frames: [
        {
          positions: Float32Array.from([0, 0, 0, 0, 1, 0, 0, 0, 1]),
          normals: Float32Array.from([1, 0, 0, 1, 0, 0, 1, 0, 0])
        }
      ]
    };
    const material = new StandardMaterial();
    material.useLighting = false;
    material.emissiveMap = new Texture(app.graphicsDevice, { width: 1, height: 1, format: PIXELFORMAT_RGBA8 });
    material.emissiveVertexColor = true;
    (material as StandardMaterial & { vertexColorGamma: boolean }).vertexColorGamma = true;
    material.opacityVertexColor = true;
    material.opacityVertexColorChannel = 'a';
    applyModelChunks(material, { lit: true, specular: true, environment: true, coordinates: true, deforms }, style);
    const instance = new MeshInstance(surfaceMesh(app.graphicsDevice, surface), material);
    instance.setParameter('q3_frames', frameTexture(app.graphicsDevice, surface));
    const entity = new Entity('model');
    entity.addComponent('render', { meshInstances: [instance] });
    // In front of the camera, which culls by the mesh's bounding box.
    entity.setPosition(0, 0, -2);
    app.root.addChild(entity);
    app.render();

    const shaders = [...(material as unknown as { variants: Map<number, Shader> }).variants.values()];
    expect(shaders.map((shader) => shader.definition.shaderLanguage)).toEqual([language]);
    const { vshader, fshader } = shaders[0].definition;
    return { vertex: vshader as string, fragment: fshader as string };
  }

  /** Where each of `parts` first appears in `text`, which must hold them all. */
  function places(text: string, parts: string[]): number[] {
    return parts.map((part) => {
      const at = text.indexOf(part);
      expect(at, part).toBeGreaterThan(-1);
      return at;
    });
  }

  it("takes the engine's transform's place, and writes the colours after its gamma-decoded copy", () => {
    const vertex = assembled('glsl');
    const order = places(vertex, [
      'q3Texel(newer)',
      'float q3Noise4',
      'Q3Vertex q3Autosprite2',
      'float q3TurbStep(float sum, vec4 turb)',
      'vec2 q3Coordinates(vec2 st, vec3 xyz)',
      'vec2 getUv0()',
      'uv = q3Coordinates(uv, q3Position)',
      'float q3SpecularAlpha',
      'vVertexColor = gammaCorrectInput(vertex_color)',
      'vVertexColor.rgb = pow(q3Shade(q3Normal), vec3(2.2))',
      'vVertexColor.a = q3SpecularAlpha(q3Position, q3Normal)'
    ]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The engine's own morph path is gone with its transform.
    expect(vertex).not.toContain('getTextureMorphCoords');
  });

  it.each(['glsl', 'wgsl'] as const)(
    "carries a lit stage's normal and position to the pixel, and lights it there, in %s",
    (language) => {
      // With no deform, so lightall takes the stage.
      const { vertex, fragment } = assembledShaders(language, MODERN, []);
      const glsl = language === 'glsl';
      places(vertex, [glsl ? 'q3LitNormal = q3Normal;' : 'output.q3LitNormal = q3Normal;']);
      expect(vertex).not.toContain('q3Shade(q3Normal)');
      const order = places(fragment, [
        'q3LitNormal',
        glsl ? 'vec3 q3Lightall(vec3 texel)' : 'fn q3Lightall(texel: vec3f)',
        glsl ? 'gl_FrontFacing' : 'pcFrontFacing',
        'q3Lightall(texel) / 2.0'
      ]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // The engine's own emission, with its decode and vertex colour, is not drawn.
      expect(fragment).not.toMatch(/dEmission \*= saturate|saturate3\(vVertexColor/);
    }
  );

  it('does the same in WGSL', () => {
    const vertex = assembled('wgsl');
    const order = places(vertex, [
      'q3Texel(newer)',
      'fn q3Noise4',
      'fn q3Autosprite2',
      'fn q3TurbStep(sum: f32, turb: vec4f)',
      'fn q3Coordinates(given: vec2f, xyz: vec3f)',
      'fn getUv0()',
      'uv = q3Coordinates(uv, q3Position)',
      'fn q3SpecularAlpha',
      'output.vVertexColor = gammaCorrectInputVec4(vertex_color)',
      'output.vVertexColor = vec4f(pow(q3Shade(q3Normal), vec3f(2.2)), output.vVertexColor.a)',
      'output.vVertexColor.a = q3SpecularAlpha(q3Position, q3Normal)'
    ]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(vertex).not.toContain('getTextureMorphCoords');
  });
});
