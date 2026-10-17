import type {
  BulgeDeform,
  Deform,
  MoveDeform,
  NormalDeform,
  WaveDeform
} from '../formats/shader-script';
import type { NoiseTable } from './noise';
import { noise4 } from './noise';
import { FUNCTABLE_SIZE, SIN_TABLE, functionTableFor, tableStep, waveValue } from './stage-motion';
import { qRsqrt } from './view-terms';
import { SHADER_MAX_INDEXES, SHADER_MAX_VERTEXES } from './world-batches';

/**
 * The world's deforms as opengl1 runs them over a batch before any stage draws it
 * (`RB_DeformTessGeometry`, `tr_shade_calc.c:538-581`), in its floats: each of a shader's deforms in
 * turn, over the vertexes Q3's tessellator holds for the batch, moving them, turning their normals,
 * or rebuilding them as squares that face the eye.
 *
 * These are the arithmetic's definition, held to ioquake3's own functions by their tests. The
 * world's deformed batches run through them each frame (`render/world-deforms.ts`). The models'
 * deforms are `vertex-deform.ts`'s.
 *
 * Engine-free, like the rest of `src/view/`. Nothing here makes anything a frame.
 */

/** One float operation's result, as C rounds it. */
const f = Math.fround;

type Vec3 = ArrayLike<number>;

/** Three directions as rows: forward, left and up. */
export type Axes = readonly [Vec3, Vec3, Vec3];

/**
 * The tessellator's arrays for one batch (`shaderCommands_t`, `tr_local.h:1170-1199`), those the
 * deforms read and write, each as tightly packed as its kind allows.
 */
export class Tess {
  /** `tess.xyz`, three floats a vertex. */
  readonly xyz = new Float32Array(SHADER_MAX_VERTEXES * 3);
  /** `tess.normal`. */
  readonly normal = new Float32Array(SHADER_MAX_VERTEXES * 3);
  /** `tess.texCoords[i][0]`, the texture's coordinates. */
  readonly st = new Float32Array(SHADER_MAX_VERTEXES * 2);
  /** `tess.texCoords[i][1]`, the lightmap's. */
  readonly lightmap = new Float32Array(SHADER_MAX_VERTEXES * 2);
  /** `tess.vertexColors`, each vertex's four bytes as one word. */
  readonly colors = new Uint32Array(SHADER_MAX_VERTEXES);
  /** `tess.indexes`, each a vertex's place in the batch. */
  readonly indexes = new Uint32Array(SHADER_MAX_INDEXES);
  numVertexes = 0;
  numIndexes = 0;
}

/** The entity a batch is drawn for, as the deforms read `backEnd.currentEntity` and `backEnd.or`. */
export interface DeformEntity {
  /** Whether it is `tr.worldEntity`, whose view's axes need no turning into its frame. */
  world: boolean;
  /** `backEnd.or.origin`. */
  origin: Vec3;
  /** `backEnd.or.axis`. A brush model's are never scaled. */
  axis: Axes;
  /** `lightDir`, in its own frame, which `projectionShadow` casts along. */
  lightDir: Vec3;
  /** `e.shadowPlane`, the height `projectionShadow` casts onto. */
  shadowPlane: number;
}

/**
 * `tr.worldEntity`, which Q3 never fills (`tr_init.c:1181`): at the world's origin, along its axes,
 * with no light and its shadow cast onto the floor at 0.
 */
export const WORLD_ENTITY: DeformEntity = {
  world: true,
  origin: [0, 0, 0],
  axis: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ],
  lightDir: [0, 0, 0],
  shadowPlane: 0
};

/** What a batch's deforms read besides its vertexes. */
export interface DeformScene {
  /** `tess.shaderTime`: the clock in seconds, a double, held at the shader's `clampTime`. */
  shaderTime: number;
  /** `backEnd.refdef.time`, in whole milliseconds, which `bulge` reads. */
  time: number;
  /** `backEnd.viewParms.or.axis`: the view's forward, left and up, in the world's frame. */
  view: Axes;
  entity: DeformEntity;
  /** `backEnd.refdef.text`: the scene's eight strings, which `text0` to `text7` draw. */
  texts: readonly string[];
  noise: NoiseTable;
  /** The shader's name, which `TableForFunc`'s drop prints. */
  shader: string;
}

/** Scratch for one deform's vectors, so a frame makes nothing. */
const leftDir = new Float32Array(3);
const upDir = new Float32Array(3);
const forward = new Float32Array(3);
const back = new Float32Array(3);
const mid = new Float32Array(3);
const left = new Float32Array(3);
const up = new Float32Array(3);
const ends = new Float32Array(6);
const lengths = new Float32Array(2);
const nums = new Int32Array(2);
const minor = new Float32Array(3);
const width = new Float32Array(3);
const origin = new Float32Array(3);

/** `DotProduct` of two vertexes' or vectors' triples, from their places, in floats in its order. */
function dot(a: Vec3, i: number, b: Vec3, j: number): number {
  return f(f(f(a[i] * b[j]) + f(a[i + 1] * b[j + 1])) + f(a[i + 2] * b[j + 2]));
}

/**
 * `GlobalVectorToLocal` (`tr_shade_calc.c:335-339`): a world direction along an entity's axes,
 * written into `out`.
 */
export function globalVectorToLocal(v: Vec3, axis: Axes, out: Float32Array): Float32Array {
  out[0] = dot(v, 0, axis[0], 0);
  out[1] = dot(v, 0, axis[1], 0);
  out[2] = dot(v, 0, axis[2], 0);
  return out;
}

/** A view axis as the deforms take it: in the entity's frame, or as it is for the world's. */
function viewAxis(scene: DeformScene, k: number, out: Float32Array): void {
  if (scene.entity.world) out.set(scene.view[k] as ArrayLike<number>);
  else globalVectorToLocal(scene.view[k], scene.entity.axis, out);
}

/**
 * `AnglesToAxis` (`q_math.c:421-427`) through `AngleVectors` (`:932-965`), in their floats: the
 * forward, left and up of pitch, yaw and roll in degrees, written into `out`. It gives the view's
 * axes as the refdef holds them, and an entity's from its angles.
 */
export function anglesToAxes(
  pitch: number,
  yaw: number,
  roll: number,
  out: readonly [Float32Array, Float32Array, Float32Array]
): readonly [Float32Array, Float32Array, Float32Array] {
  const toRadians = (Math.PI * 2) / 360;
  const y = f(f(yaw) * toRadians);
  const p = f(f(pitch) * toRadians);
  const r = f(f(roll) * toRadians);
  const sy = f(Math.sin(y));
  const cy = f(Math.cos(y));
  const sp = f(Math.sin(p));
  const cp = f(Math.cos(p));
  const sr = f(Math.sin(r));
  const cr = f(Math.cos(r));
  const ahead = out[0];
  const leftward = out[1];
  const upward = out[2];
  ahead[0] = f(cp * cy);
  ahead[1] = f(cp * sy);
  ahead[2] = -sp;
  // `right`, negated into the axis's left: `vec3_origin − right`.
  const rightX = f(f(f(f(-1 * sr) * sp) * cy) + f(f(-1 * cr) * -sy));
  const rightY = f(f(f(f(-1 * sr) * sp) * sy) + f(f(-1 * cr) * cy));
  const rightZ = f(f(-1 * sr) * cp);
  leftward[0] = f(0 - rightX);
  leftward[1] = f(0 - rightY);
  leftward[2] = f(0 - rightZ);
  upward[0] = f(f(f(cr * sp) * cy) + f(-sr * -sy));
  upward[1] = f(f(f(cr * sp) * sy) + f(-sr * cy));
  upward[2] = f(cr * cp);
  return out;
}

/** Each vertex pushed along its normal by `scale`: `VectorScale`, then the sum, in floats. */
function push(tess: Tess, v: number, scale: number): void {
  const { xyz, normal } = tess;
  const p = v * 3;
  xyz[p] = f(xyz[p] + f(normal[p] * scale));
  xyz[p + 1] = f(xyz[p + 1] + f(normal[p + 1] * scale));
  xyz[p + 2] = f(xyz[p + 2] + f(normal[p + 2] * scale));
}

/**
 * `RB_CalcDeformVertexes` (`:118-160`): each vertex pushed along its normal by the wave. With no
 * frequency every vertex is pushed alike; with one, each vertex's phase is moved on by
 * `(x + y + z) · spread`, a float added to the wave's, so the push ripples across the surface.
 *
 * @throws `TableForFunc`'s drop for a wave with no table
 */
export function deformWave(deform: WaveDeform, tess: Tess, scene: DeformScene): void {
  const { wave, spread } = deform;
  if (wave.frequency === 0) {
    const scale = waveValue(wave, scene.shaderTime, scene.shader);
    for (let v = 0; v < tess.numVertexes; v++) push(tess, v, scale);
    return;
  }
  const table = functionTableFor(wave.func, scene.shader);
  const { xyz } = tess;
  for (let v = 0; v < tess.numVertexes; v++) {
    const p = v * 3;
    const off = f(f(f(xyz[p] + xyz[p + 1]) + xyz[p + 2]) * spread);
    const phase = f(wave.phase + off);
    const sample = table[tableStep(phase + scene.shaderTime * wave.frequency)];
    push(tess, v, f(wave.base + f(sample * wave.amplitude)));
  }
}

/**
 * `RB_CalcDeformNormals` (`:169-193`): each axis of each normal moved on by the amplitude times the
 * noise at the vertex's place scaled by 0.98, at the shader's time times the frequency; y's noise
 * read 100 units further along x, and z's 200. Then the normal is made unit again by `Q_rsqrt`'s
 * guess (`VectorNormalizeFast`). The vertexes stay where they are.
 */
export function deformNormals(deform: NormalDeform, tess: Tess, scene: DeformScene): void {
  const { xyz, normal } = tess;
  const { amplitude } = deform;
  const t = scene.shaderTime * deform.frequency;
  const scale = f(0.98);
  for (let v = 0; v < tess.numVertexes; v++) {
    const p = v * 3;
    const x = f(xyz[p] * scale);
    const y = f(xyz[p + 1] * scale);
    const z = f(xyz[p + 2] * scale);
    normal[p] = f(normal[p] + f(amplitude * noise4(x, y, z, t, scene.noise)));
    normal[p + 1] = f(normal[p + 1] + f(amplitude * noise4(f(100 + x), y, z, t, scene.noise)));
    normal[p + 2] = f(normal[p + 2] + f(amplitude * noise4(f(200 + x), y, z, t, scene.noise)));
    const ilength = qRsqrt(dot(normal, p, normal, p));
    normal[p] = f(normal[p] * ilength);
    normal[p + 1] = f(normal[p + 1] * ilength);
    normal[p + 2] = f(normal[p + 2] * ilength);
  }
}

/** `(float)(FUNCTABLE_SIZE / (M_PI*2))`: the sine table's steps in a radian. */
const STEPS_PER_RADIAN = f(FUNCTABLE_SIZE / (Math.PI * 2));

/**
 * `RB_CalcBulgeVertexes` (`:201-222`): each vertex pushed along its normal by the sine table at its
 * texture's first coordinate times the width, plus the time times the speed, times the height. It
 * reads the refdef's clock, which no `clampTime` holds, not the shader's.
 */
export function deformBulge(deform: BulgeDeform, tess: Tess, scene: DeformScene): void {
  const now = scene.time * 0.001 * deform.speed;
  const { st } = tess;
  for (let v = 0; v < tess.numVertexes; v++) {
    const off = Math.trunc(STEPS_PER_RADIAN * (f(st[v * 2] * deform.width) + now));
    const step = ((off % FUNCTABLE_SIZE) + FUNCTABLE_SIZE) % FUNCTABLE_SIZE;
    push(tess, v, f(SIN_TABLE[step] * deform.height));
  }
}

/**
 * `RB_CalcMoveVertexes` (`:232-252`): every vertex moved along the vector, scaled by the wave.
 *
 * @throws `TableForFunc`'s drop for a wave with no table
 */
export function deformMove(deform: MoveDeform, tess: Tess, scene: DeformScene): void {
  const scale = waveValue(deform.wave, scene.shaderTime, scene.shader);
  const x = f(deform.vector[0] * scale);
  const y = f(deform.vector[1] * scale);
  const z = f(deform.vector[2] * scale);
  const { xyz } = tess;
  for (let p = 0; p < tess.numVertexes * 3; p += 3) {
    xyz[p] = f(xyz[p] + x);
    xyz[p + 1] = f(xyz[p + 1] + y);
    xyz[p + 2] = f(xyz[p + 2] + z);
  }
}

/**
 * `RB_ProjectionShadowDeform` (`tr_shadows.c:281-319`): every vertex cast along the entity's light
 * onto the plane its shadow falls on, the light leant towards the ground where it lies flatter than
 * half. On the world's entity, with no light, that is straight down onto z = 0.
 */
export function projectionShadow(tess: Tess, scene: DeformScene): void {
  const { axis, origin, lightDir, shadowPlane } = scene.entity;
  const gx = axis[0][2];
  const gy = axis[1][2];
  const gz = axis[2][2];
  const groundDist = f(origin[2] - shadowPlane);
  let lx = f(lightDir[0]);
  let ly = f(lightDir[1]);
  let lz = f(lightDir[2]);
  let d = f(f(f(lx * gx) + f(ly * gy)) + f(lz * gz));
  if (d < 0.5) {
    // `VectorMA` by a double.
    const s = 0.5 - d;
    lx = f(lx + gx * s);
    ly = f(ly + gy * s);
    lz = f(lz + gz * s);
    d = f(f(f(lx * gx) + f(ly * gy)) + f(lz * gz));
  }
  d = f(1 / d);
  const x = f(lx * d);
  const y = f(ly * d);
  const z = f(lz * d);
  const { xyz } = tess;
  for (let p = 0; p < tess.numVertexes * 3; p += 3) {
    const h = f(f(f(f(xyz[p] * gx) + f(xyz[p + 1] * gy)) + f(xyz[p + 2] * gz)) + groundDist);
    xyz[p] = f(xyz[p] - f(x * h));
    xyz[p + 1] = f(xyz[p + 1] - f(y * h));
    xyz[p + 2] = f(xyz[p + 2] - f(z * h));
  }
}

/**
 * A stamped square's coordinates, corner by corner: `(s1, t1)`, `(s2, t1)`, `(s2, t2)` and
 * `(s1, t2)`.
 */
function stampCoordinates(
  coords: Float32Array,
  ndx: number,
  s1: number,
  t1: number,
  s2: number,
  t2: number
): void {
  const q = ndx * 2;
  coords[q] = s1;
  coords[q + 1] = t1;
  coords[q + 2] = s2;
  coords[q + 3] = t1;
  coords[q + 4] = s2;
  coords[q + 5] = t2;
  coords[q + 6] = s1;
  coords[q + 7] = t2;
}

/**
 * `RB_AddQuadStampExt` (`tr_surface.c:72-137`): a square added to the batch about `centre`, its
 * corners at `centre ± left ± up`, its two triangles, the view's back as every corner's normal,
 * both textures' coordinates from `(s1, t1)` to `(s2, t2)`, and one colour.
 *
 * Q3 flushes the batch first where a square would fill the tessellator (`RB_CHECKOVERFLOW`), and
 * draws the squares before it on their own. A batch of whole quads never comes so near; the port
 * draws every square of a batch together.
 */
export function addQuadStamp(
  tess: Tess,
  centre: Vec3,
  side: Vec3,
  rise: Vec3,
  color: number,
  normal: Vec3,
  s1: number,
  t1: number,
  s2: number,
  t2: number
): void {
  const ndx = tess.numVertexes;
  const { xyz, indexes, st, lightmap, colors } = tess;
  const i = tess.numIndexes;
  indexes[i] = ndx;
  indexes[i + 1] = ndx + 1;
  indexes[i + 2] = ndx + 3;
  indexes[i + 3] = ndx + 3;
  indexes[i + 4] = ndx + 1;
  indexes[i + 5] = ndx + 2;
  const p = ndx * 3;
  for (let k = 0; k < 3; k++) {
    xyz[p + k] = f(f(centre[k] + side[k]) + rise[k]);
    xyz[p + 3 + k] = f(f(centre[k] - side[k]) + rise[k]);
    xyz[p + 6 + k] = f(f(centre[k] - side[k]) - rise[k]);
    xyz[p + 9 + k] = f(f(centre[k] + side[k]) - rise[k]);
    for (let corner = 0; corner < 4; corner++) tess.normal[p + corner * 3 + k] = normal[k];
  }
  stampCoordinates(st, ndx, s1, t1, s2, t2);
  stampCoordinates(lightmap, ndx, s1, t1, s2, t2);
  colors[ndx] = color;
  colors[ndx + 1] = color;
  colors[ndx + 2] = color;
  colors[ndx + 3] = color;
  tess.numVertexes += 4;
  tess.numIndexes += 6;
}

/** `vec3_origin − backEnd.viewParms.or.axis[0]`: the stamps' normal, in the world's frame. */
function viewBack(scene: DeformScene): Float32Array {
  const ahead = scene.view[0];
  back[0] = f(0 - ahead[0]);
  back[1] = f(0 - ahead[1]);
  back[2] = f(0 - ahead[2]);
  return back;
}

/**
 * `AutospriteDeform` (`:349-410`): every four vertexes, taken as a quad, rebuilt as a square facing
 * the view about their midpoint, with `RB_AddQuadStamp`: its half-side the first vertex's distance
 * from the midpoint times 0.707, along the view's left and up in the entity's frame, its colour
 * the first vertex's, and the batch's triangles the squares'. A last group of fewer than four reads
 * past the batch's vertexes, as Q3's does.
 */
export function autosprite(tess: Tess, scene: DeformScene): void {
  viewAxis(scene, 1, leftDir);
  viewAxis(scene, 2, upDir);
  const normal = viewBack(scene);
  const oldVerts = tess.numVertexes;
  tess.numVertexes = 0;
  tess.numIndexes = 0;
  const { xyz } = tess;
  for (let i = 0; i < oldVerts; i += 4) {
    const p = i * 3;
    for (let k = 0; k < 3; k++) {
      mid[k] = f(0.25 * f(f(f(xyz[p + k] + xyz[p + 3 + k]) + xyz[p + 6 + k]) + xyz[p + 9 + k]));
    }
    const dx = f(xyz[p] - mid[0]);
    const dy = f(xyz[p + 1] - mid[1]);
    const dz = f(xyz[p + 2] - mid[2]);
    const length = f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz))));
    const radius = f(length * f(0.707));
    for (let k = 0; k < 3; k++) {
      left[k] = f(leftDir[k] * radius);
      up[k] = f(upDir[k] * radius);
    }
    addQuadStamp(tess, mid, left, up, tess.colors[i], normal, 0, 0, 1, 1);
  }
}

/** `edgeVerts` (`:420-427`): a quad's six edges, by its vertexes' places in it. */
const EDGE_VERTS = [0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3] as const;

/**
 * `Autosprite2Deform` (`:429-529`): each quad, a long strip, turned about its long axis to face the
 * view. Its two shortest edges are its ends; the long axis runs between their midpoints, and the
 * minor axis is square to it and to the view's forward. Each end's vertexes go either side of its
 * midpoint along the minor axis, the way round its triangles name them in: Q3 reads six indexes
 * a quad from the batch's start, wherever the quad's own are.
 */
export function autosprite2(tess: Tess, scene: DeformScene): void {
  viewAxis(scene, 0, forward);
  const { xyz, indexes } = tess;
  for (let i = 0, at = 0; i < tess.numVertexes; i += 4, at += 6) {
    const p = i * 3;
    nums[0] = 0;
    nums[1] = 0;
    lengths[0] = 999999;
    lengths[1] = 999999;
    for (let j = 0; j < 6; j++) {
      const a = p + EDGE_VERTS[j * 2] * 3;
      const b = p + EDGE_VERTS[j * 2 + 1] * 3;
      const x = f(xyz[a] - xyz[b]);
      const y = f(xyz[a + 1] - xyz[b + 1]);
      const z = f(xyz[a + 2] - xyz[b + 2]);
      const l = f(f(f(x * x) + f(y * y)) + f(z * z));
      if (l < lengths[0]) {
        nums[1] = nums[0];
        lengths[1] = lengths[0];
        nums[0] = j;
        lengths[0] = l;
      } else if (l < lengths[1]) {
        nums[1] = j;
        lengths[1] = l;
      }
    }
    for (let j = 0; j < 2; j++) {
      const a = p + EDGE_VERTS[nums[j] * 2] * 3;
      const b = p + EDGE_VERTS[nums[j] * 2 + 1] * 3;
      for (let k = 0; k < 3; k++) ends[j * 3 + k] = f(0.5 * f(xyz[a + k] + xyz[b + k]));
    }
    const mx = f(ends[3] - ends[0]);
    const my = f(ends[4] - ends[1]);
    const mz = f(ends[5] - ends[2]);
    minor[0] = f(f(my * forward[2]) - f(mz * forward[1]));
    minor[1] = f(f(mz * forward[0]) - f(mx * forward[2]));
    minor[2] = f(f(mx * forward[1]) - f(my * forward[0]));
    // `VectorNormalize` (`q_math.c:790-807`) leaves a zero vector as it is.
    const length = dot(minor, 0, minor, 0);
    if (length) {
      const ilength = f(1 / f(Math.sqrt(length)));
      minor[0] = f(minor[0] * ilength);
      minor[1] = f(minor[1] * ilength);
      minor[2] = f(minor[2] * ilength);
    }
    for (let j = 0; j < 2; j++) {
      const first = EDGE_VERTS[nums[j] * 2];
      const second = EDGE_VERTS[nums[j] * 2 + 1];
      const l = f(0.5 * Math.sqrt(lengths[j]));
      let k = 0;
      for (; k < 5; k++) {
        if (indexes[at + k] === i + first && indexes[at + k + 1] === i + second) break;
      }
      const toward = k === 5 ? l : -l;
      const a = p + first * 3;
      const b = p + second * 3;
      for (let axis = 0; axis < 3; axis++) {
        xyz[a + axis] = f(ends[j * 3 + axis] + f(minor[axis] * toward));
        xyz[b + axis] = f(ends[j * 3 + axis] + f(minor[axis] * -toward));
      }
    }
  }
}

/** A character's cell in the font, a 16th of its image each way. */
const CELL = f(0.0625);

/** A text's squares' colour: every byte 255. */
const WHITE = 0xffffffff;

/**
 * `DeformText` (`:262-328`): the batch's first four vertexes taken as a box, and the batch rebuilt
 * as the text across it, a square a character from the font's 16 by 16 cells, from the box's
 * middle back along its width. A space is a step and no square. The empty text leaves nothing.
 */
export function deformText(tess: Tess, text: string, scene: DeformScene): void {
  const { xyz, normal } = tess;
  // `CrossProduct( tess.normal[0], (0, 0, −1) )`.
  width[0] = f(f(normal[1] * -1) - f(normal[2] * 0));
  width[1] = f(f(normal[2] * 0) - f(normal[0] * -1));
  width[2] = f(f(normal[0] * 0) - f(normal[1] * 0));
  mid[0] = 0;
  mid[1] = 0;
  mid[2] = 0;
  let bottom = 999999;
  let top = -999999;
  for (let i = 0; i < 4; i++) {
    const p = i * 3;
    mid[0] = f(xyz[p] + mid[0]);
    mid[1] = f(xyz[p + 1] + mid[1]);
    mid[2] = f(xyz[p + 2] + mid[2]);
    if (xyz[p + 2] < bottom) bottom = xyz[p + 2];
    if (xyz[p + 2] > top) top = xyz[p + 2];
  }
  for (let k = 0; k < 3; k++) origin[k] = f(mid[k] * f(0.25));
  up[0] = 0;
  up[1] = 0;
  up[2] = f(f(top - bottom) * 0.5);
  const scale = f(up[2] * f(-0.75));
  for (let k = 0; k < 3; k++) width[k] = f(width[k] * scale);
  const len = text.length;
  for (let k = 0; k < 3; k++) origin[k] = f(origin[k] + f(width[k] * (len - 1)));
  tess.numIndexes = 0;
  tess.numVertexes = 0;
  const normalBack = viewBack(scene);
  for (let i = 0; i < len; i++) {
    const ch = text.charCodeAt(i) & 255;
    if (ch !== 32) {
      const frow = f((ch >> 4) * CELL);
      const fcol = f((ch & 15) * CELL);
      const s2 = f(fcol + CELL);
      const t2 = f(frow + CELL);
      addQuadStamp(tess, origin, width, up, WHITE, normalBack, fcol, frow, s2, t2);
    }
    for (let k = 0; k < 3; k++) origin[k] = f(origin[k] + f(width[k] * -2));
  }
}

/**
 * `RB_DeformTessGeometry` (`:538-581`): a shader's deforms over its batch, in their slots' order.
 *
 * @throws `TableForFunc`'s drop for a `wave` or `move` with no table
 */
export function deformTess(deforms: readonly Deform[], tess: Tess, scene: DeformScene): void {
  for (let i = 0; i < deforms.length; i++) {
    const deform = deforms[i];
    switch (deform.type) {
      case 'normal':
        deformNormals(deform, tess, scene);
        break;
      case 'wave':
        deformWave(deform, tess, scene);
        break;
      case 'bulge':
        deformBulge(deform, tess, scene);
        break;
      case 'move':
        deformMove(deform, tess, scene);
        break;
      case 'projectionShadow':
        projectionShadow(tess, scene);
        break;
      case 'autosprite':
        autosprite(tess, scene);
        break;
      case 'autosprite2':
        autosprite2(tess, scene);
        break;
      case 'text':
        deformText(tess, scene.texts[deform.index] ?? '', scene);
        break;
      case 'none':
        break;
    }
  }
}
