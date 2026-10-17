import { describe, expect, it } from 'vitest';

import { anglesToAxis } from './hand-pose';
import {
  FOG_S,
  FOG_T,
  WORLD_FRAME,
  fogColor,
  fogFactor,
  fogImage,
  fogTexCoords,
  fogVectors,
  loadFogs,
  modelFogNum,
  polyFogNum,
  spriteFogNum,
  type FogFrame,
  type WorldFog
} from './world-fog';
import type { WorldFogParms } from './world-shaders';
import { fogParts, testBsp, type TestFog } from './world-test-fixtures';
import { Seeded } from '../sim/cm/collision-test-fixtures';

const f = Math.fround;

/** A map of these fog volumes. */
const fogMap = (...fogs: TestFog[]) => testBsp(fogParts(fogs));

/** Each fog's shader by its name, with these `fogParms`, or none for a name not listed. */
const shadersWith =
  (parms: Record<string, WorldFogParms>) =>
  (name: string) => ({ fogParms: parms[name] });

/** A box of fog 8 units across, its corner at the origin. */
const box = (shader: string, visibleSide?: number): TestFog => ({
  mins: [0, 0, 0],
  maxs: [8, 8, 8],
  shader,
  visibleSide
});

describe('loadFogs', () => {
  it("takes each fog's bounds from its brush's first six sides, and its face's plane", () => {
    const bsp = fogMap(
      { mins: [-64, 0, -32], maxs: [64, 128, 16], shader: 'textures/f/top' },
      { mins: [-64, 0, -32], maxs: [64, 128, 16], shader: 'textures/f/side', visibleSide: 1 },
      { mins: [-64, 0, -32], maxs: [64, 128, 16], shader: 'textures/f/none', visibleSide: -1 }
    );
    const fogs = loadFogs(bsp, shadersWith({}));
    expect(fogs.map((fog) => fog.bounds)).toEqual([
      [
        [-64, 0, -32],
        [64, 128, 16]
      ],
      [
        [-64, 0, -32],
        [64, 128, 16]
      ],
      [
        [-64, 0, -32],
        [64, 128, 16]
      ]
    ]);
    expect(fogs.map((fog) => fog.brushNum)).toEqual([0, 1, 2]);
    // Turned to face into the fog, its zeros positive as `VectorSubtract` from the origin leaves
    // them.
    expect(fogs[0].surface).toEqual([0, 0, -1, -16]);
    expect(fogs[1].surface).toEqual([-1, 0, 0, -64]);
    expect(fogs[2].surface).toBeUndefined();
  });

  it("finds each fog's shader in lump order, and takes its fogParms, or none as zeros", () => {
    const asked: string[] = [];
    const red: WorldFogParms = { color: [1, 0, 0], depthForOpaque: 300 };
    const fogs = loadFogs(fogMap(box('textures/f/red'), box('textures/f/plain')), (name) => {
      asked.push(name);
      return shadersWith({ 'textures/f/red': red })(name);
    });
    expect(asked).toEqual(['textures/f/red', 'textures/f/plain']);
    expect(fogs.map((fog) => fog.parms)).toEqual([red, { color: [0, 0, 0], depthForOpaque: 0 }]);
    // A copy, as Q3 copies the shader's.
    expect(fogs[0].parms).not.toBe(red);
    expect(fogs[0].parms.color).not.toBe(red.color);
  });

  it('scales its fog by its depth, taken as 1 below that', () => {
    const scale = (depthForOpaque: number) =>
      loadFogs(fogMap(box('fog')), shadersWith({ fog: { color: [0, 0, 0], depthForOpaque } }))[0]
        .tcScale;
    expect(scale(0)).toBe(0.125);
    expect(scale(0.5)).toBe(0.125);
    expect(scale(-8)).toBe(0.125);
    expect(scale(1.5)).toBe(f(1 / 12));
    expect(scale(300)).toBe(f(1 / 2400));
  });

  it("throws in Q3's words for a brush or its sides out of range, compared unsigned", () => {
    const load = (bsp: ReturnType<typeof fogMap>) => () => loadFogs(bsp, shadersWith({}));
    const withBrush = (brushNum: number) => {
      const bsp = fogMap(box('fog'));
      bsp.fogs[0].brushNum = brushNum;
      return bsp;
    };
    expect(load(withBrush(1))).toThrow(new Error('fog brushNumber out of range'));
    expect(load(withBrush(-1))).toThrow(new Error('fog brushNumber out of range'));
    expect(load(withBrush(0))).not.toThrow();
    const withFirstSide = (firstSide: number) => {
      const bsp = fogMap(box('fog'), box('fog'));
      bsp.brushes[0].firstSide = firstSide;
      return bsp;
    };
    // Twelve sides, so the last six start at 6.
    expect(load(withFirstSide(6))).not.toThrow();
    expect(load(withFirstSide(7))).toThrow(new Error('fog brush sideNumber out of range'));
    expect(load(withFirstSide(-1))).toThrow(new Error('fog brush sideNumber out of range'));
  });

  it("throws in the port's words where Q3 reads past a lump", () => {
    // Under six sides in all, Q3's check passes, its bound turned unsigned.
    const few = fogMap(box('fog'));
    few.brushSides.length = 5;
    expect(() => loadFogs(few, shadersWith({}))).toThrow(
      new Error("R_LoadFogs: fog 0's side 5 lies outside the brush sides")
    );
    const planeless = fogMap(box('fog'));
    planeless.brushSides[3].planeNum = 99;
    expect(() => loadFogs(planeless, shadersWith({}))).toThrow(
      new Error("R_LoadFogs: brush side 3's plane 99 lies outside the planes")
    );
    // Q3 reads the face's side without checking it.
    expect(() => loadFogs(fogMap(box('fog', 6)), shadersWith({}))).toThrow(
      new Error("R_LoadFogs: fog 0's side 6 lies outside the brush sides")
    );
  });
});

describe('fogColor', () => {
  it('packs each channel at identityLight, truncated to a byte, with an alpha of 255', () => {
    const parms = { color: [1, 0.5, f(0.2)] as [number, number, number], depthForOpaque: 0 };
    expect(fogColor(parms, 1)).toEqual([255, 127, 51, 255]);
    expect(fogColor(parms, 0.5)).toEqual([127, 63, 25, 255]);
    expect(fogColor(parms, 0.25)).toEqual([63, 31, 12, 255]);
  });

  it('keeps the low eight bits of a channel past a byte', () => {
    expect(fogColor({ color: [2, -0.5, 1], depthForOpaque: 0 }, 1)).toEqual([254, 129, 255, 255]);
  });
});

describe('fogFactor', () => {
  it('is nothing within 1/512 along the view, or a thirty-second under the face', () => {
    expect(fogFactor(1 / 512, 1)).toBe(0);
    expect(fogFactor(0, 1)).toBe(0);
    expect(fogFactor(0.1, 1 / 32 - 1e-6)).toBe(0);
    expect(fogFactor(0.5, 0.02)).toBe(0);
    expect(fogFactor(0.5, -0.5)).toBe(0);
    expect(fogFactor(0.1, 1 / 32)).toBe(0);
  });

  it('reads its table deep in the fog, full past an eighth', () => {
    // The table is `pow(i / 255, 0.5)`, each in a float.
    expect(fogFactor(0.002688419073820114, 1)).toBe(0.06262242794036865);
    expect(fogFactor(0.064453125, 1)).toBe(0.7057189345359802);
    expect(fogFactor(1 / 512 + 1 / 8, 1)).toBe(1);
    expect(fogFactor(10, 31 / 32)).toBe(1);
  });

  it("matches Q3's float arithmetic where it thins toward the face", () => {
    // From a float32 oracle written from the C. A reckoning in doubles picks the next entry of
    // the table, up or down, at each.
    const points = [
      [0.08155994862318039, 0.6662642955780029, 0.6537973284721375],
      [0.15421654284000397, 0.5715047121047974, 0.8378310203552246],
      [0.139997199177742, 0.806924045085907, 0.955889880657196],
      [0.07687892019748688, 0.8040734529495239, 0.7029350399971008],
      [0.13675431907176971, 0.6414896249771118, 0.835487425327301],
      [0.12431211024522781, 0.8237288594245911, 0.9096433520317078],
      [0.1248311996459961, 0.8166411519050598, 0.9074852466583252],
      [0.13250184059143066, 0.8514587879180908, 0.955889880657196],
      [0.11941473931074142, 0.5124772787094116, 0.6945163607597351],
      [0.05786982551217079, 0.9106436967849731, 0.647771418094635],
      [0.113441601395607, 0.9587066769599915, 0.9393364191055298],
      [0.11940311640501022, 0.9429333806037903, 0.955889880657196]
    ];
    expect(points.map(([s, t]) => fogFactor(s, t))).toEqual(points.map(([, , factor]) => factor));
  });
});

describe('fogImage', () => {
  const image = fogImage();
  const alpha = (x: number, y: number) => image[(y * FOG_S + x) * 4 + 3];

  it('is white, 256 along the view by 32 down from the face', () => {
    expect(image).toHaveLength(256 * 32 * 4);
    expect([FOG_S, FOG_T]).toEqual([256, 32]);
    expect(image.filter((_, i) => i % 4 !== 3).every((channel) => channel === 255)).toBe(true);
  });

  it("has each texel's alpha as the oracle has it", () => {
    // Its first row is within a thirty-second of the face, and its first column within 1/512.
    expect(Array.from({ length: FOG_S }, (_, x) => alpha(x, 0)).every((a) => a === 0)).toBe(true);
    expect(Array.from({ length: FOG_T }, (_, y) => alpha(0, y)).every((a) => a === 0)).toBe(true);
    const texels = [alpha(255, 1), alpha(128, 1), alpha(128, 3), alpha(64, 16)];
    expect(texels).toEqual([91, 65, 147, 255]);
    expect([1, 2, 10, 30, 31, 32].map((x) => alpha(x, 31))).toEqual([42, 61, 141, 246, 250, 255]);
    // Thinner a texel above the last row.
    expect(alpha(7, 30)).toBe(117);
    expect(alpha(7, 31)).toBe(118);
    // Every texel, by an FNV-1a of the alphas row by row, and their sum.
    let hash = 0x811c9dc5;
    let sum = 0;
    for (let i = 0; i < FOG_S * FOG_T; i++) {
      hash = Math.imul(hash ^ image[i * 4 + 3], 0x01000193) >>> 0;
      sum += image[i * 4 + 3];
    }
    expect([hash.toString(16), sum]).toEqual(['f2d747e9', 1709140]);
  });
});

type Vec3 = [number, number, number];

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** `myGlMultMatrix` (`tr_main.c:249-261`). */
function multMatrix(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 4; k++) out[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
    }
  }
  return out;
}

/**
 * `RB_CalcFogTexCoords` as the C has it, from the orientation `R_RotateForViewer` and
 * `R_RotateForEntity` set up (`tr_main.c:249-378`): the model matrix, flipped to OpenGL's axes,
 * and the eye in the entity's frame. The twin the port's own reckoning is checked against.
 *
 * @param view - The view's forward, left and up.
 * @param entity - A brush model's frame, or the world's for none.
 */
function calcFogTexCoords(
  fog: WorldFog,
  eye: Vec3,
  view: readonly Vec3[],
  entity: FogFrame | null,
  points: Vec3[]
): number[][] {
  const viewer = new Array<number>(16).fill(0);
  for (let r = 0; r < 3; r++) {
    [viewer[r], viewer[4 + r], viewer[8 + r]] = view[r];
    viewer[12 + r] = -eye[0] * viewer[r] - eye[1] * viewer[4 + r] - eye[2] * viewer[8 + r];
  }
  viewer[15] = 1;
  const flip = [0, 0, -1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  let or = {
    origin: [0, 0, 0],
    axis: WORLD_FRAME.axis,
    viewOrigin: eye,
    modelMatrix: multMatrix(viewer, flip)
  };
  if (entity) {
    const { origin, axis } = entity;
    const glMatrix = [...axis[0], 0, ...axis[1], 0, ...axis[2], 0, ...origin, 1];
    const delta = [0, 1, 2].map((i) => eye[i] - origin[i]);
    let axisLength = 1;
    if (entity.nonNormalizedAxes) {
      axisLength = Math.hypot(...axis[0]);
      axisLength = axisLength === 0 ? 0 : 1 / axisLength;
    }
    or = {
      origin: [...origin],
      axis,
      viewOrigin: axis.map((along) => dot(delta, along) * axisLength) as Vec3,
      modelMatrix: multMatrix(glMatrix, or.modelMatrix)
    };
  }
  const local = [0, 1, 2].map((i) => or.origin[i] - eye[i]);
  const m = or.modelMatrix;
  const distance = [-m[2], -m[6], -m[10], dot(local, view[0])].map((x) => x * fog.tcScale);
  let depth = [0, 0, 0, 0];
  let eyeT = 1;
  if (fog.surface) {
    const surface = fog.surface;
    depth = [...or.axis.map((along) => dot(surface, along)), -surface[3] + dot(or.origin, surface)];
    eyeT = dot(or.viewOrigin, depth) + depth[3];
  }
  distance[3] += 1 / 512;
  return points.map((v) => {
    const s = dot(v, distance) + distance[3];
    let t = dot(v, depth) + depth[3];
    if (eyeT < 0) {
      t = t < 1.0 ? 1.0 / 32 : 1.0 / 32 + ((30.0 / 32) * t) / (t - eyeT);
    } else {
      t = t < 0 ? 1.0 / 32 : 31.0 / 32;
    }
    return [s, t];
  });
}

describe('fogVectors and fogTexCoords', () => {
  /** A fog 256 deep for opaque, its top at height 24 and showing, or showing nothing. */
  const pool = (visibleSide?: number) =>
    loadFogs(
      fogMap({ mins: [-512, -512, -256], maxs: [512, 512, 24], shader: 'pool', visibleSide }),
      shadersWith({ pool: { color: [1, 0, 0], depthForOpaque: 256 } })
    )[0];
  const points: Vec3[] = [
    [0, 0, 29],
    [100, 0, 23.5],
    [100, 20, 14],
    [400, -30, -176],
    [-50, 10, 23]
  ];
  /** Each point's coordinates as the port works them out, in the world's frame. */
  const ported = (fog: WorldFog, eye: Vec3, angles: Vec3, frame?: FogFrame, at = points) => {
    const [forward] = anglesToAxis(...angles);
    const vectors = fogVectors(fog, eye, forward, frame);
    return at.map((v) => fogTexCoords(vectors, v));
  };
  /** Axes scaled alike. */
  const scaledAxis = (axis: readonly Vec3[], scale: number): FogFrame['axis'] => {
    const [a, b, c] = axis.map((along) => along.map((x) => x * scale) as Vec3);
    return [a, b, c];
  };
  const close = (actual: number[][], expected: number[][]) =>
    actual.forEach((st, i) => {
      expect(st[0], `s ${i}`).toBeCloseTo(expected[i][0], 12);
      expect(st[1], `t ${i}`).toBeCloseTo(expected[i][1], 12);
    });

  it('puts a point under the face at 31/32 and one above at 1/32, with the eye in the fog', () => {
    const fog = pool();
    const eye: Vec3 = [0, 0, -26];
    const angles: Vec3 = [20, 30, 0];
    const st = ported(fog, eye, angles);
    expect(st.map(([, t]) => t)).toEqual([1 / 32, 31 / 32, 31 / 32, 31 / 32, 31 / 32]);
    close(st, calcFogTexCoords(fog, eye, anglesToAxis(...angles), null, points));
    // s: the depth along the view, an eighth of the fog's depth for opaque to 1.
    const ahead = ported(fog, [0, 0, -26], [0, 0, 0], undefined, [[1024, 0, -26]]);
    expect(ahead[0][0]).toBeCloseTo(1024 / (256 * 8) + 1 / 512, 12);
  });

  it('cuts the distance at the face with the eye above it, less than a unit under out', () => {
    const fog = pool();
    const eye: Vec3 = [0, 0, 64];
    const angles: Vec3 = [45, -10, 0];
    const st = ported(fog, eye, angles);
    expect(st.map(([, t]) => t)).toEqual([
      1 / 32,
      1 / 32,
      1 / 32 + ((30 / 32) * 10) / (10 + 40),
      1 / 32 + ((30 / 32) * 200) / (200 + 40),
      1 / 32 + ((30 / 32) * 1) / (1 + 40)
    ]);
    close(st, calcFogTexCoords(fog, eye, anglesToAxis(...angles), null, points));
    // On the face, the eye counts as in the fog.
    const onFace = fogVectors(fog, [0, 0, 24], [1, 0, 0]);
    expect(onFace.eyeT).toBe(0);
    expect(fogTexCoords(onFace, [0, 0, 23.5])[1]).toBe(31 / 32);
  });

  it('counts the eye in a fog with no face wherever it is, and every point in it', () => {
    const fog = pool(-1);
    for (const eye of [
      [0, 0, 64],
      [0, 0, -26]
    ] as Vec3[]) {
      const st = ported(fog, eye, [10, 80, 0]);
      expect(st.every(([, t]) => t === 31 / 32)).toBe(true);
      close(st, calcFogTexCoords(fog, eye, anglesToAxis(10, 80, 0), null, points));
    }
    expect(fogVectors(fog, [0, 0, 64], [1, 0, 0])).toMatchObject({ depth: [0, 0, 0, 0], eyeT: 1 });
  });

  it("gives a brush model's points in its own frame the numbers its world's places have", () => {
    const fog = pool();
    const frame: FogFrame = { origin: [100, -20, 30], axis: anglesToAxis(10, 70, 5) };
    const { origin, axis } = frame;
    const toWorld = (v: Vec3) =>
      [0, 1, 2].map(
        (i) => origin[i] + v[0] * axis[0][i] + v[1] * axis[1][i] + v[2] * axis[2][i]
      ) as Vec3;
    for (const eye of [
      [0, 0, 64],
      [0, 0, -26]
    ] as Vec3[]) {
      const angles: Vec3 = [-15, 200, 0];
      const own = ported(fog, eye, angles, frame);
      close(own, ported(fog, eye, angles, undefined, points.map(toWorld)));
      close(own, calcFogTexCoords(fog, eye, anglesToAxis(...angles), frame, points));
    }
  });

  it("measures the eye in a scaled entity's frame by its first axis, as Q3's twin does", () => {
    const fog = pool();
    const random = new Seeded(0x6d6);
    const coord = (range: number) => random.coord(range * 256);
    for (let n = 0; n < 200; n++) {
      const scale = n % 4 === 0 ? 1 : 0.25 + (random.next() % 1024) / 512;
      const turn = anglesToAxis(coord(180), coord(180), coord(180));
      const frame: FogFrame = {
        origin: [coord(600), coord(600), coord(300)],
        axis: scaledAxis(turn, scale),
        nonNormalizedAxes: scale !== 1
      };
      const eye: Vec3 = [coord(600), coord(600), coord(300)];
      const angles: Vec3 = [coord(90), coord(180), 0];
      const at = [0, 1, 2, 3].map(() => [coord(64), coord(64), coord(64)] as Vec3);
      const twin = calcFogTexCoords(fog, eye, anglesToAxis(...angles), frame, at);
      close(ported(fog, eye, angles, frame, at), twin);
    }
    // Doubled, the eye 40 above the frame's origin, 64 under the face, counts 80 above it, not 40,
    // and 160 unflagged.
    const scaled: FogFrame = {
      origin: [0, 0, -40],
      axis: scaledAxis(anglesToAxis(0, 0, 0), 2),
      nonNormalizedAxes: true
    };
    expect(fogVectors(fog, [0, 0, 0], [1, 0, 0], scaled).eyeT).toBeCloseTo(64 - 80, 12);
    const unflagged = { ...scaled, nonNormalizedAxes: false };
    expect(fogVectors(fog, [0, 0, 0], [1, 0, 0], unflagged).eyeT).toBeCloseTo(64 - 160, 12);
  });
});

describe('modelFogNum, spriteFogNum and polyFogNum', () => {
  const fogs = loadFogs(
    fogMap(
      { mins: [0, 0, 0], maxs: [64, 64, 64], shader: 'a' },
      { mins: [32, 0, 0], maxs: [128, 64, 64], shader: 'b' },
      { mins: [2 ** 24, 0, 0], maxs: [2 ** 24 + 4, 64, 64], shader: 'far' }
    ),
    shadersWith({})
  );

  it("finds an MD3's fog by its frame's sphere, its local origin unturned, touching out", () => {
    // Overlapping both, the first is taken.
    expect(modelFogNum(fogs, [40, 32, 32], [0, 0, 0], 4)).toBe(1);
    expect(modelFogNum(fogs, [100, 32, 32], [0, 0, 0], 4)).toBe(2);
    // The frame's local origin moves the sphere: here out past the second's far side.
    expect(modelFogNum(fogs, [100, 32, 32], [60, 0, 0], 4)).toBe(0);
    // Touching from outside, on either side of an axis, is out.
    expect(modelFogNum(fogs, [-8, 32, 32], [0, 0, 0], 8)).toBe(0);
    expect(modelFogNum(fogs, [32, 32, 72], [0, 0, 0], 8)).toBe(0);
    expect(modelFogNum(fogs, [32, 32, 72], [0, 0, 0], 8.5)).toBe(1);
    expect(modelFogNum([], [32, 32, 32], [0, 0, 0], 8)).toBe(0);
  });

  it('adds the origin in floats, as Q3 does', () => {
    // 2^24 + 1 rounds to 2^24 in a float, which only touches the far fog; in doubles it is in.
    expect(modelFogNum(fogs, [2 ** 24, 32, 32], [1, 0, 0], 0)).toBe(0);
    expect(modelFogNum(fogs, [2 ** 24, 32, 32], [2, 0, 0], 0)).toBe(3);
    expect(f(2 ** 24 + 1)).toBe(2 ** 24);
    // The sum rounded before the radius is added: 2^24 + 1 is 2^24, and that plus 1 still touches;
    // the sum and the radius taken whole reach 2^24 + 2, inside.
    expect(modelFogNum(fogs, [2 ** 24, 32, 32], [1, 0, 0], 1)).toBe(0);
  });

  it("finds a sprite's fog by its radius about its origin, touching not counted", () => {
    expect(spriteFogNum(fogs, [96, 32, 32], 0)).toBe(2);
    expect(spriteFogNum(fogs, [64, 32, 32], 0)).toBe(2);
    expect(spriteFogNum(fogs, [128, 32, 32], 0)).toBe(0);
    expect(spriteFogNum(fogs, [136, 32, 32], 8)).toBe(0);
    expect(spriteFogNum(fogs, [136, 32, 32], 8.25)).toBe(2);
  });

  it("finds a poly's fog by its points' box, touching counted", () => {
    expect(polyFogNum(fogs, [[128, 0, 0], [140, 10, 0], [130, 0, 5]])).toBe(2);
    expect(polyFogNum(fogs, [[-10, -10, 64], [0, 0, 70]])).toBe(1);
    expect(polyFogNum(fogs, [[129, 0, 0], [140, 10, 0]])).toBe(0);
    expect(polyFogNum([], [[32, 32, 32]])).toBe(0);
  });
});
