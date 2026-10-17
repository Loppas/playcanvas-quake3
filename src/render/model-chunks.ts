import {
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  type MeshInstance,
  type StandardMaterial,
  type Texture
} from 'playcanvas';

import type { Md3Surface } from '../formats/md3';
import { isSpriteDeform, type Deform, type Wave, type WaveFunc } from '../formats/shader-script';
import {
  LIGHTALL_DELUXE_SPECULAR,
  LIGHTALL_ROUGHNESS,
  LIGHTALL_SPECULAR,
  LIGHT_HEADROOM,
  SPECULAR_LIGHT_ORIGIN,
  litPath,
  type EntityLight
} from '../view/entity-light';
import { NOISE_PERM, NOISE_SIZE, NOISE_TABLE } from '../view/noise';
import { overbrightFactor, rendererStyle, type RendererStyle } from '../view/overbright';
import type { FrameBlend } from '../view/player-animation';
import { evalWave, tableForFunc } from '../view/shader-animation';
import { QUAD_EDGES, type DeformView } from '../view/vertex-deform';
import { drawnFrames } from '../view/vertex-morph';
import type { FogAdjustment } from '../view/world-shaders';
import { FOG_COORDS, FOG_END, FOG_FACTOR, FOG_UNIFORM } from './fog-chunks';
import { quadReach } from './model-frames';
import { COORDINATE_HELPERS, coordinatesGlsl, coordinatesWgsl } from './stage-coordinates';

/**
 * An MD3's per-vertex work, on the GPU: chunks set on each of a model's stage materials, in
 * GLSL and WGSL, reading the surface's frames from its texture (`model-frames.ts`) and a few
 * uniforms per mesh instance. What they do, in Q3's order (`RB_BeginSurface` onwards):
 *
 * 1. **The frame lerp** (`transformCoreVS`'s `getLocalPosition`): the two frames' positions and
 *    normals, blended, and under `opengl1` the normal made unit again: `lerpMeshVertexes`.
 * 2. **The deforms**, each of the shader's slots in turn: `deformVertexes`
 *    (`view/vertex-deform.ts`). A sprite reads its quad's other three vertices from the frames,
 *    each morphed and moved by the slots before it.
 * 3. **The coordinates** (`uv0VS`): `tcGen environment`, `environmentUvs`, then the stage's
 *    `tcMod`s as `writeCoordinates` pieces them (`view/stage-motion.ts`), `turb` in its place
 *    (`stage-coordinates.ts`).
 * 4. **The colours** (`litUserMainEndVS`): `rgbGen lightingDiffuse` and
 *    `alphaGen lightingSpecular`, written over the vertex colour as the port's lit materials read
 *    it: half the shade, gamma-decoded as the colour stream is. Each lit stage is shaded the way
 *    its renderer's program shades it (`litPath`): in `opengl1`'s bytes (`shadeVertices`,
 *    `specularAlphas`), or as `opengl2`'s `fastLight` (`diffuseShade`) or generic program
 *    (`genericShade`, `specularAlpha`) shades it.
 * 5. **Per pixel** (`emissivePS`), for a lit stage `opengl2`'s `lightall` draws: the morphed normal
 *    and position carried to each pixel, and the stage's texture lit there (`lightallShade`).
 * 6. **The depth hack** (`litUserMainEndVS`, `Q3_DEPTH_HACK`): the view weapon's depth squeezed
 *    into the front of the range, as `RF_DEPTHHACK`'s `qglDepthRange( 0, 0.3 )` squeezes it
 *    (`tr_backend.c:605-650`): in WGSL's clip space, whose depth runs from 0, its depth scaled;
 *    in GLSL's, whose runs from -1, the same worked through its far end.
 * 7. **The fog** (`Q3_FOG_*`, `fog-chunks.ts`): a blended stage's colour or alpha dimmed by its
 *    draw's fog, worked out at each morphed vertex as `RB_CalcModulateColorsByFog` and its kin
 *    work it out, or the fog pass's coordinates on the fog image in place of a stage's.
 *
 * The TypeScript functions named are the arithmetic's definition, with their tests; these chunks
 * mirror them line for line. Every pass runs the same vertex shader (PlayCanvas's `litMainVS`),
 * so a shadow, a prepass or a pick sees the morphed shape too. Nothing is compiled here: the
 * engine builds each variant when it first draws.
 */

/** `RF_DEPTHHACK`'s depth range: the front 30% of it. */
const DEPTH_HACK = literal(0.3);
/** The shift WebGL's clip space needs for it: `0.3 z - 0.7 w` puts -1 at -1 and 1 at -0.4. */
const DEPTH_HACK_SHIFT = literal(0.7);

/** The chunk API these overrides are written against: PlayCanvas's `CHUNKAPI_2_8`. */
export const MODEL_CHUNKS_VERSION = '2.8';

/** The deform slots a shader keeps (`MAX_SHADER_DEFORMS`), two vec4s each in `q3_deform`. */
export const DEFORM_SLOTS = 3;

/** What a deform slot holds in its first vec4's x: none, or the kind of `deformVertexes`. */
export const DEFORM_NONE = 0;
export const DEFORM_WAVE = 1;
export const DEFORM_NORMAL = 2;
export const DEFORM_BULGE = 3;
export const DEFORM_MOVE = 4;
export const DEFORM_AUTOSPRITE = 5;
export const DEFORM_AUTOSPRITE2 = 6;

/** A wave's function as the chunks number it. */
const WAVE_FUNCS: readonly WaveFunc[] = ['sin', 'square', 'triangle', 'sawtooth', 'inversesawtooth'];

/** A float as a shader literal: always with a point, which GLSL and WGSL both need for a float. */
function literal(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

/**
 * Q3's noise table and bytes as the chunks' arrays hold them, the table's floats to nine digits,
 * which read back as the same floats. WGSL's are private variables, not `const`: a `const` array is
 * rebuilt at each index taken at run time, and the noise's hundreds of lookups took Chrome's shader
 * compiler seconds.
 */
const NOISE_VALUES = Array.from(NOISE_TABLE, (value) => value.toPrecision(9)).join(', ');
const NOISE_BYTES = Array.from(NOISE_PERM).join(', ');
const NOISE_MASK = NOISE_SIZE - 1;

/** A quad's edges, `QUAD_EDGES`, as the chunks' constant arrays hold them. */
const EDGES_GLSL = QUAD_EDGES.map(([a, b]) => `ivec2(${a}, ${b})`).join(', ');
const EDGES_WGSL = QUAD_EDGES.map(([a, b]) => `vec2i(${a}, ${b})`).join(', ');

/** A wave's phase at `seconds`, reduced to one period in double precision, for a float uniform. */
export function phaseNow(wave: Wave, seconds: number): number {
  const phase = wave.phase + seconds * wave.frequency;
  return phase - Math.floor(phase);
}

/** `q3_anim`: the older frame, the newer, how much of the older is left, and the vertex count. */
export function writeAnim(
  numFrames: number,
  numVerts: number,
  frames: FrameBlend,
  out: Float32Array
): void {
  const [oldFrame, frame] = drawnFrames(numFrames, frames.oldFrame, frames.frame);
  out[0] = oldFrame;
  out[1] = frame;
  out[2] = frames.backlerp;
  out[3] = numVerts;
}

/**
 * What a lit stage's shade's bytes are scaled by into its vertex colours under `opengl1`: on screen
 * by the ramp's factor, then halved for the material to double back ({@link LIGHT_HEADROOM}); in a
 * map's scene, where the framebuffer holds the bytes themselves, by nothing.
 *
 * @param framebuffer - Whether the model draws in a map's scene.
 */
export function shadeScale(framebuffer: boolean, style: RendererStyle = rendererStyle()): number {
  return framebuffer ? 1 : overbrightFactor(style) / LIGHT_HEADROOM;
}

/**
 * `q3_light[0..2]`: the ambient, the directed light and its direction, one vec4 each, and the
 * directed light's w the scale its shade's bytes take ({@link shadeScale}).
 */
export function writeLight(
  light: EntityLight,
  out: Float32Array,
  scale: number = shadeScale(false)
): void {
  out.set(light.ambient, 0);
  out.set(light.directed, 4);
  out[7] = scale;
  out.set(light.direction, 8);
}

/** `q3_viewer`: where the viewer is in the model's own frame, its w 1; all 0 with no viewer. */
export function writeViewer(viewer: readonly [number, number, number] | null, out: Float32Array): void {
  if (!viewer) {
    out.fill(0);
    return;
  }
  out.set(viewer, 0);
  out[3] = 1;
}

/**
 * `q3_view[0..3]`: where the viewer looks, for the sprites, one vec4 each: its forward, left and
 * up in the model's frame, and a stamped square's normal. The forward's w is 1; all 0 with no
 * view, which draws no sprite, as `deformVertexes` draws none without one.
 */
export function writeView(view: DeformView | null, out: Float32Array): void {
  out.fill(0);
  if (!view) return;
  out.set(view.forward, 0);
  out[3] = 1;
  out.set(view.left, 4);
  out.set(view.up, 8);
  out.set(view.normal, 12);
}

/** `x` reduced to `[0, period)`, in double precision, for a float uniform. */
function reduced(x: number, period: number): number {
  return x - Math.floor(x / period) * period;
}

/**
 * `q3_deform[0..5]`: two vec4s a slot, its kind first. What each kind holds, the second vec4
 * reduced on the CPU in double precision so the shader's floats keep their precision all level:
 *
 * - `wave`: its function and spread, then its base, amplitude and phase now. A wave with no
 *   frequency pushes every vertex alike, so it gets no spread (`tr_shade_calc.c:130–142`).
 * - `normal`: its amplitude, and the noise's time, `shaderTime · frequency`, within the lattice's
 *   period: the noise repeats every 256 along it.
 * - `bulge`: its width and height, and its angle now, `t · speed` within a turn.
 * - `move`: its offset now, as `moveOffset` gives it.
 * - `autosprite` and `autosprite2`: nothing more; they read the view ({@link writeView}).
 *
 * Empty slots are zero, which draws no deform.
 */
export function writeDeforms(deforms: readonly Deform[], seconds: number, out: Float32Array): void {
  out.fill(0);
  const slots = Math.min(deforms.length, DEFORM_SLOTS);
  for (let slot = 0; slot < slots; slot++) {
    const deform = deforms[slot];
    const at = slot * 8;
    switch (deform.type) {
      case 'wave': {
        const { spread, wave } = deform;
        tableForFunc(wave.func);
        out[at] = DEFORM_WAVE;
        out[at + 1] = WAVE_FUNCS.indexOf(wave.func);
        out[at + 2] = wave.frequency === 0 ? 0 : spread;
        out[at + 4] = wave.base;
        out[at + 5] = wave.amplitude;
        out[at + 6] = phaseNow(wave, seconds);
        break;
      }
      case 'normal':
        out[at] = DEFORM_NORMAL;
        out[at + 4] = deform.amplitude;
        out[at + 5] = reduced(seconds * deform.frequency, NOISE_SIZE);
        break;
      case 'bulge':
        out[at] = DEFORM_BULGE;
        out[at + 4] = deform.width;
        out[at + 5] = deform.height;
        out[at + 6] = reduced(seconds * deform.speed, 2 * Math.PI);
        break;
      case 'move': {
        // `moveOffset`, written in place.
        const scale = evalWave(deform.wave, seconds);
        out[at] = DEFORM_MOVE;
        out[at + 4] = deform.vector[0] * scale;
        out[at + 5] = deform.vector[1] * scale;
        out[at + 6] = deform.vector[2] * scale;
        break;
      }
      case 'autosprite':
        out[at] = DEFORM_AUTOSPRITE;
        break;
      case 'autosprite2':
        out[at] = DEFORM_AUTOSPRITE2;
        break;
    }
  }
}

/**
 * How far a surface's deforms can move a vertex from where the morph put it, for its bounds: each
 * wave's base and amplitude at their largest, a bulge's height, and a move's vector at its wave's
 * largest. `normal` moves none. A sprite puts a corner no further from its quad's middle than the
 * quad's farthest vertex stood (`quadReach`); the slots before it may have moved both that vertex
 * and the middle, so what they reach counts three times.
 */
export function deformReach(deforms: readonly Deform[], surface: Md3Surface): number {
  const largest = (wave: Wave) => Math.abs(wave.base) + Math.abs(wave.amplitude);
  return deforms.slice(0, DEFORM_SLOTS).reduce((reach, deform) => {
    switch (deform.type) {
      case 'wave':
        return reach + largest(deform.wave);
      case 'bulge':
        return reach + Math.abs(deform.height);
      case 'move':
        return reach + Math.hypot(...deform.vector) * largest(deform.wave);
      case 'autosprite':
      case 'autosprite2':
        return 3 * reach + quadReach(surface);
      default:
        return reach;
    }
  }, 0);
}

/** The arrays one draw's uniforms read, each written by the function its field names. */
export interface ModelUniforms {
  /** `q3_anim`, by {@link writeAnim}. */
  anim: Float32Array;
  /** `q3_light[0..2]`, by {@link writeLight}. */
  light: Float32Array;
  /** `q3_viewer`, by {@link writeViewer}. */
  viewer: Float32Array;
  /** `q3_deform[0..5]`, by {@link writeDeforms}. */
  deforms: Float32Array;
  /** `q3_coords[0..14]`, by `writeCoordinates` (`view/stage-motion.ts`). */
  coordinates: Float32Array;
  /** `q3_view[0..3]`, by {@link writeView}. */
  view: Float32Array;
  /** `q3_fog[0..2]`, its entity's fog's vectors, which the scene writes (`scene-draws.ts`). */
  fog: Float32Array;
}

/**
 * Give a draw its surface's frames and the arrays its uniforms read. A draw keeps what it is given
 * and reads it afresh each time it draws, so writing the arrays is all a frame takes, and draws
 * given the same array share it.
 */
export function bindModelUniforms(
  instance: MeshInstance,
  frames: Texture,
  uniforms: ModelUniforms
): void {
  instance.setParameter('q3_frames', frames);
  instance.setParameter('q3_anim', uniforms.anim);
  instance.setParameter('q3_light[0]', uniforms.light);
  instance.setParameter('q3_viewer', uniforms.viewer);
  instance.setParameter('q3_deform[0]', uniforms.deforms);
  instance.setParameter('q3_coords[0]', uniforms.coordinates);
  instance.setParameter('q3_view[0]', uniforms.view);
  instance.setParameter(FOG_UNIFORM, uniforms.fog);
}

/**
 * The chunks' text for one renderer style. The style is latched, so its rules and numbers go
 * in as they are:
 *
 * - `opengl1` makes a morphed normal unit again, shades in the framebuffer's bytes, truncated and
 *   clamped, at the scale the model's light carries ({@link shadeScale}), as `shadeVertices` writes
 *   it on screen, and truncates a highlight to a byte.
 * - `opengl2` leaves a morphed normal as it is, shades as its `fastLight` or its generic program
 *   does, and keeps a highlight whole. Its overbright factor, and `lightall`'s constants, go in
 *   for the per-pixel stages.
 */
export function modelChunks(style: RendererStyle): {
  glsl: Map<string, string>;
  wgsl: Map<string, string>;
} {
  const classic = style.renderer === 'opengl1';
  const overbright = literal(overbrightFactor(style));
  const headroom = literal(LIGHT_HEADROOM);
  const [lx, ly, lz] = SPECULAR_LIGHT_ORIGIN.map(literal);
  const tau = '6.283185307179586';
  const roughness = literal(LIGHTALL_ROUGHNESS);
  const baseSpecular = literal(LIGHTALL_SPECULAR);
  const deluxe = literal(LIGHTALL_DELUXE_SPECULAR);

  const glsl = new Map<string, string>([
    [
      'transformCoreVS',
      `
attribute vec4 vertex_position;
uniform mat4 matrix_viewProjection;
uniform mat4 matrix_model;
mat4 getModelMatrix() {
	return matrix_model;
}
uniform highp sampler2D q3_frames;
uniform vec4 q3_anim;
uniform vec4 q3_light[3];
uniform vec4 q3_viewer;
uniform vec4 q3_deform[${DEFORM_SLOTS * 2}];
uniform vec4 q3_view[4];
struct Q3Vertex {
	vec3 position;
	vec3 normal;
	vec2 st;
};
vec3 q3Position;
vec3 q3Normal;
vec2 q3Uv;
vec4 q3Texel(int index) {
	int width = textureSize(q3_frames, 0).x;
	return texelFetch(q3_frames, ivec2(index % width, index / width), 0);
}
float q3WaveFunc(float shape, float x) {
	float f = fract(x);
	if (shape < 0.5) return sin(${tau} * f);
	if (shape < 1.5) return f < 0.5 ? 1.0 : -1.0;
	if (shape < 2.5) {
		float h = f < 0.5 ? f : f - 0.5;
		float rise = h < 0.25 ? 4.0 * h : 2.0 - 4.0 * h;
		return f < 0.5 ? rise : -rise;
	}
	if (shape < 3.5) return f;
	return 1.0 - f;
}
Q3Vertex q3Morph(int v) {
	int numVerts = int(q3_anim.w);
	int newer = numVerts + (int(q3_anim.y) * numVerts + v) * 2;
	Q3Vertex vert;
	vert.position = q3Texel(newer).xyz;
	vert.normal = q3Texel(newer + 1).xyz;
	vert.st = q3Texel(v).xy;
	float backlerp = q3_anim.z;
	if (backlerp != 0.0) {
		int older = numVerts + (int(q3_anim.x) * numVerts + v) * 2;
		vert.position = q3Texel(older).xyz * backlerp + vert.position * (1.0 - backlerp);
		vec3 normal = q3Texel(older + 1).xyz * backlerp + vert.normal * (1.0 - backlerp);
		${classic ? 'float len = length(normal);\n\t\tvert.normal = len > 0.0 ? normal / len : normal;' : 'vert.normal = normal;'}
	}
	return vert;
}
#ifdef Q3_DEFORM_NOISE
const float q3NoiseTable[${NOISE_SIZE}] = float[${NOISE_SIZE}](${NOISE_VALUES});
const int q3NoisePerm[${NOISE_SIZE}] = int[${NOISE_SIZE}](${NOISE_BYTES});
float q3LatticeNoise(int x, int y, int z, int t) {
	return q3NoiseTable[q3NoisePerm[(x + q3NoisePerm[(y + q3NoisePerm[(z + q3NoisePerm[t & ${NOISE_MASK}]) & ${NOISE_MASK}]) & ${NOISE_MASK}]) & ${NOISE_MASK}]];
}
float q3Lerp(float a, float b, float w) {
	return a * (1.0 - w) + b * w;
}
float q3NoiseSlice(ivec3 i, vec3 f, int t) {
	float front = q3Lerp(
		q3Lerp(q3LatticeNoise(i.x, i.y, i.z, t), q3LatticeNoise(i.x + 1, i.y, i.z, t), f.x),
		q3Lerp(q3LatticeNoise(i.x, i.y + 1, i.z, t), q3LatticeNoise(i.x + 1, i.y + 1, i.z, t), f.x),
		f.y
	);
	float back = q3Lerp(
		q3Lerp(q3LatticeNoise(i.x, i.y, i.z + 1, t), q3LatticeNoise(i.x + 1, i.y, i.z + 1, t), f.x),
		q3Lerp(q3LatticeNoise(i.x, i.y + 1, i.z + 1, t), q3LatticeNoise(i.x + 1, i.y + 1, i.z + 1, t), f.x),
		f.y
	);
	return q3Lerp(front, back, f.z);
}
float q3Noise4(vec3 p, float t) {
	vec3 cell = floor(p);
	float moment = floor(t);
	ivec3 i = ivec3(cell);
	int it = int(moment);
	return q3Lerp(q3NoiseSlice(i, p - cell, it), q3NoiseSlice(i, p - cell, it + 1), t - moment);
}
vec3 q3NormalDeform(vec3 position, vec3 normal, float amplitude, float t) {
	vec3 p = position * 0.98;
	vec3 bent = normal + amplitude * vec3(
		q3Noise4(p, t),
		q3Noise4(vec3(100.0 + p.x, p.yz), t),
		q3Noise4(vec3(200.0 + p.x, p.yz), t)
	);
	float len = length(bent);
	return len > 0.0 ? bent / len : bent;
}
#endif
Q3Vertex q3Bend(Q3Vertex vert, int slot) {
	vec4 kind = q3_deform[slot * 2];
	vec4 args = q3_deform[slot * 2 + 1];
	if (kind.x == ${literal(DEFORM_WAVE)}) {
		float off = (vert.position.x + vert.position.y + vert.position.z) * kind.z;
		vert.position += vert.normal * (args.x + args.y * q3WaveFunc(kind.y, args.z + off));
	}
	#ifdef Q3_DEFORM_NOISE
	if (kind.x == ${literal(DEFORM_NORMAL)}) vert.normal = q3NormalDeform(vert.position, vert.normal, args.x, args.y);
	#endif
	if (kind.x == ${literal(DEFORM_BULGE)}) vert.position += vert.normal * (sin(vert.st.x * args.x + args.z) * args.y);
	if (kind.x == ${literal(DEFORM_MOVE)}) vert.position += args.xyz;
	return vert;
}
#ifdef Q3_DEFORM_SPRITE
Q3Vertex q3Corner(int v, int slots) {
	Q3Vertex vert = q3Morph(v);
	for (int slot = 0; slot < slots; slot++) vert = q3Bend(vert, slot);
	return vert;
}
Q3Vertex q3Autosprite(Q3Vertex vert, int v, int slots) {
	int first = v - v % 4;
	if (first + 3 >= int(q3_anim.w)) return vert;
	vec3 p0 = q3Corner(first, slots).position;
	vec3 mid = 0.25 * (p0 + q3Corner(first + 1, slots).position + q3Corner(first + 2, slots).position + q3Corner(first + 3, slots).position);
	float radius = length(p0 - mid) * 0.707;
	int corner = v - first;
	float l = corner == 0 || corner == 3 ? 1.0 : -1.0;
	float u = corner < 2 ? 1.0 : -1.0;
	vert.position = mid + l * (q3_view[1].xyz * radius) + u * (q3_view[2].xyz * radius);
	vert.normal = q3_view[3].xyz;
	vert.st = vec2(corner == 1 || corner == 2 ? 1.0 : 0.0, corner < 2 ? 0.0 : 1.0);
	return vert;
}
const ivec2 q3QuadEdges[6] = ivec2[6](${EDGES_GLSL});
Q3Vertex q3Autosprite2(Q3Vertex vert, int v, int slots) {
	int first = v - v % 4;
	if (first + 3 >= int(q3_anim.w)) return vert;
	vec3 corners[4];
	for (int k = 0; k < 4; k++) corners[k] = q3Corner(first + k, slots).position;
	ivec2 nums = ivec2(0);
	vec2 lengths = vec2(999999.0);
	for (int e = 0; e < 6; e++) {
		vec3 edge = corners[q3QuadEdges[e].x] - corners[q3QuadEdges[e].y];
		float l = dot(edge, edge);
		if (l < lengths.x) {
			nums.y = nums.x;
			lengths.y = lengths.x;
			nums.x = e;
			lengths.x = l;
		} else if (l < lengths.y) {
			nums.y = e;
			lengths.y = l;
		}
	}
	ivec2 end0 = q3QuadEdges[nums.x];
	ivec2 end1 = q3QuadEdges[nums.y];
	vec3 mid0 = 0.5 * (corners[end0.x] + corners[end0.y]);
	vec3 mid1 = 0.5 * (corners[end1.x] + corners[end1.y]);
	vec3 minor = cross(mid1 - mid0, q3_view[0].xyz);
	float len = length(minor);
	if (len > 0.0) minor /= len;
	int orders = int(q3Texel(first).z);
	int corner = v - first;
	for (int j = 0; j < 2; j++) {
		ivec2 end = j == 0 ? end0 : end1;
		vec3 mid = j == 0 ? mid0 : mid1;
		float span = 0.5 * sqrt(j == 0 ? lengths.x : lengths.y);
		float toward = ((orders >> (j == 0 ? nums.x : nums.y)) & 1) != 0 ? -1.0 : 1.0;
		if (corner == end.x) vert.position = mid + toward * span * minor;
		if (corner == end.y) vert.position = mid - toward * span * minor;
	}
	return vert;
}
Q3Vertex q3Sprite(Q3Vertex vert, int v, int slot) {
	if (q3_view[0].w == 0.0) return vert;
	float kind = q3_deform[slot * 2].x;
	if (kind == ${literal(DEFORM_AUTOSPRITE)}) return q3Autosprite(vert, v, slot);
	if (kind == ${literal(DEFORM_AUTOSPRITE2)}) return q3Autosprite2(vert, v, slot);
	return vert;
}
#endif
vec3 getLocalPosition(vec3 vertexPosition) {
	Q3Vertex vert = q3Morph(gl_VertexID);
	for (int slot = 0; slot < ${DEFORM_SLOTS}; slot++) {
		#ifdef Q3_DEFORM_SPRITE
		vert = q3Sprite(vert, gl_VertexID, slot);
		#endif
		vert = q3Bend(vert, slot);
	}
	q3Position = vert.position;
	q3Normal = vert.normal;
	q3Uv = vert.st;
	return vert.position;
}
`
    ],
    [
      'uv0VS',
      `
#ifdef Q3_TCMOD
${COORDINATE_HELPERS.glsl}${coordinatesGlsl('q3_coords', 'q3Coordinates')}
#endif
vec2 getUv0() {
	#ifdef Q3_FOG_PASS
	return q3FogTexCoords(q3Position);
	#else
	vec2 uv = q3Uv;
	#ifdef Q3_TCGEN_ENV
	if (q3_viewer.w > 0.0) {
		vec3 toViewer = q3_viewer.xyz - q3Position;
		float len = length(toViewer);
		if (len > 0.0) toViewer /= len;
		float d = dot(q3Normal, toViewer);
		uv = vec2(0.5 + (q3Normal.y * 2.0 * d - toViewer.y) * 0.5, 0.5 - (q3Normal.z * 2.0 * d - toViewer.z) * 0.5);
	}
	#endif
	#ifdef Q3_TCMOD
	uv = q3Coordinates(uv, q3Position);
	#endif
	return uv;
	#endif
}
`
    ],
    [
      'litUserDeclarationVS',
      `
#ifdef Q3_LIGHTALL
varying vec3 q3LitNormal;
varying vec3 q3LitPosition;
#endif
#ifdef Q3_FOG_COORDS
${FOG_COORDS.glsl}
#endif
#ifdef Q3_FOG_KEEP
${FOG_FACTOR.glsl}
varying float q3FogKeep;
#endif
`
    ],
    [
      'litUserCodeVS',
      `
${
  classic
    ? `vec3 q3Shade(vec3 normal) {
	float incoming = max(dot(normal, q3_light[2].xyz), 0.0);
	vec3 light = floor(q3_light[0].rgb + incoming * q3_light[1].rgb);
	light = min(light, vec3(255.0));
	return min(floor(light * q3_light[1].w + 0.5), vec3(255.0)) / 255.0;
}`
    : `#ifdef Q3_LIT_MULTIPLIES
const float q3Overbright = 1.0;
#else
const float q3Overbright = ${overbright};
#endif
vec3 q3Shade(vec3 normal) {
	#ifdef Q3_LIT_GENERIC
	float incoming = clamp(dot(normal, q3_light[2].xyz), 0.0, 1.0);
	return clamp((q3_light[0].rgb + incoming * q3_light[1].rgb) / 255.0, 0.0, 1.0) / ${headroom};
	#else
	vec3 toLight = q3_light[2].xyz;
	float incoming = clamp(dot(normalize(normal), toLight) / length(toLight), 0.0, 1.0);
	return q3Overbright * (q3_light[0].rgb + incoming * q3_light[1].rgb) / 255.0 / ${headroom};
	#endif
}`
}
float q3SpecularAlpha(vec3 position, vec3 normal) {
	if (q3_viewer.w == 0.0) return 0.0;
	vec3 toLight = vec3(${lx}, ${ly}, ${lz}) - position;
	float towards = length(toLight);
	toLight /= towards > 0.0 ? towards : 1.0;
	float d = dot(normal, toLight);
	vec3 reflected = normal * 2.0 * d - toLight;
	vec3 toViewer = q3_viewer.xyz - position;
	float seen = length(toViewer);
	float l = seen > 0.0 ? dot(reflected, toViewer) / seen : 0.0;
	if (l < 0.0) return 0.0;
	${classic ? 'return min(255.0, floor(l * l * l * l * 255.0)) / 255.0;' : 'float c = min(l, 1.0);\n\treturn c * c * c * c;'}
}
`
    ],
    [
      'litUserMainEndVS',
      `
	#ifdef VERTEX_COLOR
		#ifdef Q3_LIT
			vVertexColor.rgb = pow(q3Shade(q3Normal), vec3(2.2));
		#endif
		#ifdef Q3_SPECULAR
			vVertexColor.a = q3SpecularAlpha(q3Position, q3Normal);
		#endif
	#endif
	#ifdef Q3_LIGHTALL
		q3LitNormal = q3Normal;
		q3LitPosition = q3Position;
	#endif
	#ifdef Q3_FOG_KEEP
		q3FogKeep = 1.0 - q3FogFactor(q3FogTexCoords(q3Position));
	#endif
	#ifdef Q3_DEPTH_HACK
		gl_Position.z = ${DEPTH_HACK} * gl_Position.z - ${DEPTH_HACK_SHIFT} * gl_Position.w;
	#endif
`
    ],
    [
      'litUserDeclarationPS',
      `
#ifdef Q3_LIGHTALL
varying vec3 q3LitNormal;
varying vec3 q3LitPosition;
uniform vec4 q3_light[3];
uniform vec4 q3_viewer;
#endif
#ifdef Q3_FOG_KEEP
varying float q3FogKeep;
#endif
`
    ],
    [
      'emissivePS',
      `
uniform vec3 material_emissive;
uniform float material_emissiveIntensity;
#ifdef Q3_LIGHTALL
#ifdef Q3_LIT_MULTIPLIES
const float q3Overbright = 1.0;
#else
const float q3Overbright = ${overbright};
#endif
float q3CalcSpecular(float NH, float EH) {
	float rr = ${roughness} * ${roughness};
	float rrrr = rr * rr;
	float d = NH * NH * (rrrr - 1.0) + 1.0;
	float v = EH * EH * (${roughness} + 0.5) + 0.00000001;
	return ${baseSpecular} * (rrrr / (4.0 * d * d * v));
}
vec3 q3Lightall(vec3 texel) {
	vec3 N = normalize(gl_FrontFacing ? -q3LitNormal : q3LitNormal);
	vec3 L = normalize(q3_light[2].xyz);
	vec3 E = q3_viewer.w > 0.0 ? normalize(q3_viewer.xyz - q3LitPosition) : N;
	vec3 H = normalize(L + E);
	float NL = clamp(dot(N, L), 0.0, 1.0);
	float highlight = q3CalcSpecular(clamp(dot(N, H), 0.0, 1.0), clamp(dot(E, H), 0.0, 1.0)) * ${deluxe};
	vec3 diffuse = texel * (1.0 - ${baseSpecular});
	return q3Overbright * (q3_light[1].rgb * (diffuse + highlight) * NL + q3_light[0].rgb * diffuse) / 255.0;
}
#endif
void getEmission() {
	dEmission = material_emissive * material_emissiveIntensity;
	#ifdef Q3_LIGHTALL
	vec3 texel = vec3(1.0);
	#ifdef STD_EMISSIVE_TEXTURE
	texel = texture2DBias({STD_EMISSIVE_TEXTURE_NAME}, {STD_EMISSIVE_TEXTURE_UV}, {STD_TEXTURE_BIAS}).{STD_EMISSIVE_TEXTURE_CHANNEL};
	#endif
	dEmission *= pow(q3Lightall(texel) / ${headroom}, vec3(2.2));
	#else
	#ifdef STD_EMISSIVE_TEXTURE
	dEmission *= {STD_EMISSIVE_TEXTURE_DECODE}(texture2DBias({STD_EMISSIVE_TEXTURE_NAME}, {STD_EMISSIVE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).{STD_EMISSIVE_TEXTURE_CHANNEL};
	#endif
	#ifdef STD_EMISSIVE_VERTEX
	dEmission *= saturate(vVertexColor.{STD_EMISSIVE_VERTEX_CHANNEL});
	#endif
	#endif
}
`
    ]
  ]);

  const wgsl = new Map<string, string>([
    [
      'transformCoreVS',
      `
attribute vertex_position: vec4f;
uniform matrix_viewProjection: mat4x4f;
uniform matrix_model: mat4x4f;
fn getModelMatrix() -> mat4x4f {
	return uniform.matrix_model;
}
var q3_frames: texture_2d<uff>;
uniform q3_anim: vec4f;
uniform q3_light: array<vec4f, 3>;
uniform q3_viewer: vec4f;
uniform q3_deform: array<vec4f, ${DEFORM_SLOTS * 2}>;
uniform q3_view: array<vec4f, 4>;
struct Q3Vertex {
	position: vec3f,
	normal: vec3f,
	st: vec2f,
};
var<private> q3Position: vec3f;
var<private> q3Normal: vec3f;
var<private> q3Uv: vec2f;
fn q3Texel(index: i32) -> vec4f {
	let width = i32(textureDimensions(q3_frames).x);
	return textureLoad(q3_frames, vec2i(index % width, index / width), 0);
}
fn q3WaveFunc(shape: f32, x: f32) -> f32 {
	let f = fract(x);
	if (shape < 0.5) { return sin(${tau} * f); }
	if (shape < 1.5) { return select(-1.0, 1.0, f < 0.5); }
	if (shape < 2.5) {
		let h = select(f - 0.5, f, f < 0.5);
		let rise = select(2.0 - 4.0 * h, 4.0 * h, h < 0.25);
		return select(-rise, rise, f < 0.5);
	}
	if (shape < 3.5) { return f; }
	return 1.0 - f;
}
fn q3Morph(v: i32) -> Q3Vertex {
	let numVerts = i32(uniform.q3_anim.w);
	let newer = numVerts + (i32(uniform.q3_anim.y) * numVerts + v) * 2;
	var vert: Q3Vertex;
	vert.position = q3Texel(newer).xyz;
	vert.normal = q3Texel(newer + 1).xyz;
	vert.st = q3Texel(v).xy;
	let backlerp = uniform.q3_anim.z;
	if (backlerp != 0.0) {
		let older = numVerts + (i32(uniform.q3_anim.x) * numVerts + v) * 2;
		vert.position = q3Texel(older).xyz * backlerp + vert.position * (1.0 - backlerp);
		let normal = q3Texel(older + 1).xyz * backlerp + vert.normal * (1.0 - backlerp);
		${classic ? 'let len = length(normal);\n\t\tvert.normal = select(normal, normal / len, len > 0.0);' : 'vert.normal = normal;'}
	}
	return vert;
}
#ifdef Q3_DEFORM_NOISE
var<private> q3NoiseTable: array<f32, ${NOISE_SIZE}> = array<f32, ${NOISE_SIZE}>(${NOISE_VALUES});
var<private> q3NoisePerm: array<i32, ${NOISE_SIZE}> = array<i32, ${NOISE_SIZE}>(${NOISE_BYTES});
fn q3LatticeNoise(x: i32, y: i32, z: i32, t: i32) -> f32 {
	return q3NoiseTable[q3NoisePerm[(x + q3NoisePerm[(y + q3NoisePerm[(z + q3NoisePerm[t & ${NOISE_MASK}]) & ${NOISE_MASK}]) & ${NOISE_MASK}]) & ${NOISE_MASK}]];
}
fn q3Lerp(a: f32, b: f32, w: f32) -> f32 {
	return a * (1.0 - w) + b * w;
}
fn q3NoiseSlice(i: vec3i, f: vec3f, t: i32) -> f32 {
	let front = q3Lerp(
		q3Lerp(q3LatticeNoise(i.x, i.y, i.z, t), q3LatticeNoise(i.x + 1, i.y, i.z, t), f.x),
		q3Lerp(q3LatticeNoise(i.x, i.y + 1, i.z, t), q3LatticeNoise(i.x + 1, i.y + 1, i.z, t), f.x),
		f.y
	);
	let back = q3Lerp(
		q3Lerp(q3LatticeNoise(i.x, i.y, i.z + 1, t), q3LatticeNoise(i.x + 1, i.y, i.z + 1, t), f.x),
		q3Lerp(q3LatticeNoise(i.x, i.y + 1, i.z + 1, t), q3LatticeNoise(i.x + 1, i.y + 1, i.z + 1, t), f.x),
		f.y
	);
	return q3Lerp(front, back, f.z);
}
fn q3Noise4(p: vec3f, t: f32) -> f32 {
	let cell = floor(p);
	let moment = floor(t);
	let i = vec3i(cell);
	let it = i32(moment);
	return q3Lerp(q3NoiseSlice(i, p - cell, it), q3NoiseSlice(i, p - cell, it + 1), t - moment);
}
fn q3NormalDeform(position: vec3f, normal: vec3f, amplitude: f32, t: f32) -> vec3f {
	let p = position * 0.98;
	let bent = normal + amplitude * vec3f(
		q3Noise4(p, t),
		q3Noise4(vec3f(100.0 + p.x, p.yz), t),
		q3Noise4(vec3f(200.0 + p.x, p.yz), t)
	);
	let len = length(bent);
	return select(bent, bent / len, len > 0.0);
}
#endif
fn q3Bend(given: Q3Vertex, slot: i32) -> Q3Vertex {
	var vert = given;
	let kind = uniform.q3_deform[slot * 2];
	let args = uniform.q3_deform[slot * 2 + 1];
	if (kind.x == ${literal(DEFORM_WAVE)}) {
		let off = (vert.position.x + vert.position.y + vert.position.z) * kind.z;
		vert.position = vert.position + vert.normal * (args.x + args.y * q3WaveFunc(kind.y, args.z + off));
	}
	#ifdef Q3_DEFORM_NOISE
	if (kind.x == ${literal(DEFORM_NORMAL)}) { vert.normal = q3NormalDeform(vert.position, vert.normal, args.x, args.y); }
	#endif
	if (kind.x == ${literal(DEFORM_BULGE)}) { vert.position = vert.position + vert.normal * (sin(vert.st.x * args.x + args.z) * args.y); }
	if (kind.x == ${literal(DEFORM_MOVE)}) { vert.position = vert.position + args.xyz; }
	return vert;
}
#ifdef Q3_DEFORM_SPRITE
fn q3Corner(v: i32, slots: i32) -> Q3Vertex {
	var vert = q3Morph(v);
	for (var slot = 0; slot < slots; slot++) { vert = q3Bend(vert, slot); }
	return vert;
}
fn q3Autosprite(given: Q3Vertex, v: i32, slots: i32) -> Q3Vertex {
	var vert = given;
	let first = v - v % 4;
	if (first + 3 >= i32(uniform.q3_anim.w)) { return vert; }
	let p0 = q3Corner(first, slots).position;
	let mid = 0.25 * (p0 + q3Corner(first + 1, slots).position + q3Corner(first + 2, slots).position + q3Corner(first + 3, slots).position);
	let radius = length(p0 - mid) * 0.707;
	let corner = v - first;
	let l = select(-1.0, 1.0, corner == 0 || corner == 3);
	let u = select(-1.0, 1.0, corner < 2);
	vert.position = mid + l * (uniform.q3_view[1].xyz * radius) + u * (uniform.q3_view[2].xyz * radius);
	vert.normal = uniform.q3_view[3].xyz;
	vert.st = vec2f(select(0.0, 1.0, corner == 1 || corner == 2), select(1.0, 0.0, corner < 2));
	return vert;
}
const q3QuadEdges = array<vec2i, 6>(${EDGES_WGSL});
fn q3Autosprite2(given: Q3Vertex, v: i32, slots: i32) -> Q3Vertex {
	var vert = given;
	let first = v - v % 4;
	if (first + 3 >= i32(uniform.q3_anim.w)) { return vert; }
	var corners: array<vec3f, 4>;
	for (var k = 0; k < 4; k++) { corners[k] = q3Corner(first + k, slots).position; }
	var nums = vec2i(0);
	var lengths = vec2f(999999.0);
	for (var e = 0; e < 6; e++) {
		let edge = corners[q3QuadEdges[e].x] - corners[q3QuadEdges[e].y];
		let l = dot(edge, edge);
		if (l < lengths.x) {
			nums.y = nums.x;
			lengths.y = lengths.x;
			nums.x = e;
			lengths.x = l;
		} else if (l < lengths.y) {
			nums.y = e;
			lengths.y = l;
		}
	}
	let end0 = q3QuadEdges[nums.x];
	let end1 = q3QuadEdges[nums.y];
	let mid0 = 0.5 * (corners[end0.x] + corners[end0.y]);
	let mid1 = 0.5 * (corners[end1.x] + corners[end1.y]);
	var minor = cross(mid1 - mid0, uniform.q3_view[0].xyz);
	let len = length(minor);
	if (len > 0.0) { minor = minor / len; }
	let orders = i32(q3Texel(first).z);
	let corner = v - first;
	for (var j = 0; j < 2; j++) {
		let end = select(end1, end0, j == 0);
		let mid = select(mid1, mid0, j == 0);
		let span = 0.5 * sqrt(select(lengths.y, lengths.x, j == 0));
		let toward = select(1.0, -1.0, ((orders >> u32(select(nums.y, nums.x, j == 0))) & 1) != 0);
		if (corner == end.x) { vert.position = mid + toward * span * minor; }
		if (corner == end.y) { vert.position = mid - toward * span * minor; }
	}
	return vert;
}
fn q3Sprite(given: Q3Vertex, v: i32, slot: i32) -> Q3Vertex {
	if (uniform.q3_view[0].w == 0.0) { return given; }
	let kind = uniform.q3_deform[slot * 2].x;
	if (kind == ${literal(DEFORM_AUTOSPRITE)}) { return q3Autosprite(given, v, slot); }
	if (kind == ${literal(DEFORM_AUTOSPRITE2)}) { return q3Autosprite2(given, v, slot); }
	return given;
}
#endif
fn getLocalPosition(vertexPosition: vec3f) -> vec3f {
	var vert = q3Morph(i32(pcVertexIndex));
	for (var slot = 0; slot < ${DEFORM_SLOTS}; slot++) {
		#ifdef Q3_DEFORM_SPRITE
		vert = q3Sprite(vert, i32(pcVertexIndex), slot);
		#endif
		vert = q3Bend(vert, slot);
	}
	q3Position = vert.position;
	q3Normal = vert.normal;
	q3Uv = vert.st;
	return vert.position;
}
`
    ],
    [
      'uv0VS',
      `
#ifdef Q3_TCMOD
${COORDINATE_HELPERS.wgsl}${coordinatesWgsl('q3_coords', 'q3Coordinates')}
#endif
fn getUv0() -> vec2f {
	#ifdef Q3_FOG_PASS
	return q3FogTexCoords(q3Position);
	#else
	var uv = q3Uv;
	#ifdef Q3_TCGEN_ENV
	if (uniform.q3_viewer.w > 0.0) {
		var toViewer = uniform.q3_viewer.xyz - q3Position;
		let len = length(toViewer);
		if (len > 0.0) { toViewer = toViewer / len; }
		let d = dot(q3Normal, toViewer);
		uv = vec2f(0.5 + (q3Normal.y * 2.0 * d - toViewer.y) * 0.5, 0.5 - (q3Normal.z * 2.0 * d - toViewer.z) * 0.5);
	}
	#endif
	#ifdef Q3_TCMOD
	uv = q3Coordinates(uv, q3Position);
	#endif
	return uv;
	#endif
}
`
    ],
    [
      'litUserDeclarationVS',
      `
#ifdef Q3_LIGHTALL
varying q3LitNormal: vec3f;
varying q3LitPosition: vec3f;
#endif
#ifdef Q3_FOG_COORDS
${FOG_COORDS.wgsl}
#endif
#ifdef Q3_FOG_KEEP
${FOG_FACTOR.wgsl}
varying q3FogKeep: f32;
#endif
`
    ],
    [
      'litUserCodeVS',
      `
${
  classic
    ? `fn q3Shade(normal: vec3f) -> vec3f {
	let incoming = max(dot(normal, uniform.q3_light[2].xyz), 0.0);
	var light = floor(uniform.q3_light[0].rgb + incoming * uniform.q3_light[1].rgb);
	light = min(light, vec3f(255.0));
	return min(floor(light * uniform.q3_light[1].w + 0.5), vec3f(255.0)) / 255.0;
}`
    : `#ifdef Q3_LIT_MULTIPLIES
const q3Overbright: f32 = 1.0;
#else
const q3Overbright: f32 = ${overbright};
#endif
fn q3Shade(normal: vec3f) -> vec3f {
	#ifdef Q3_LIT_GENERIC
	let incoming = clamp(dot(normal, uniform.q3_light[2].xyz), 0.0, 1.0);
	return clamp((uniform.q3_light[0].rgb + incoming * uniform.q3_light[1].rgb) / 255.0, vec3f(0.0), vec3f(1.0)) / ${headroom};
	#else
	let toLight = uniform.q3_light[2].xyz;
	let incoming = clamp(dot(normalize(normal), toLight) / length(toLight), 0.0, 1.0);
	return q3Overbright * (uniform.q3_light[0].rgb + incoming * uniform.q3_light[1].rgb) / 255.0 / ${headroom};
	#endif
}`
}
fn q3SpecularAlpha(position: vec3f, normal: vec3f) -> f32 {
	if (uniform.q3_viewer.w == 0.0) { return 0.0; }
	var toLight = vec3f(${lx}, ${ly}, ${lz}) - position;
	let towards = length(toLight);
	toLight = toLight / select(1.0, towards, towards > 0.0);
	let d = dot(normal, toLight);
	let reflected = normal * 2.0 * d - toLight;
	let toViewer = uniform.q3_viewer.xyz - position;
	let seen = length(toViewer);
	let l = select(0.0, dot(reflected, toViewer) / seen, seen > 0.0);
	if (l < 0.0) { return 0.0; }
	${classic ? 'return min(255.0, floor(l * l * l * l * 255.0)) / 255.0;' : 'let c = min(l, 1.0);\n\treturn c * c * c * c;'}
}
`
    ],
    [
      'litUserMainEndVS',
      `
	#ifdef VERTEX_COLOR
		#ifdef Q3_LIT
			output.vVertexColor = vec4f(pow(q3Shade(q3Normal), vec3f(2.2)), output.vVertexColor.a);
		#endif
		#ifdef Q3_SPECULAR
			output.vVertexColor.a = q3SpecularAlpha(q3Position, q3Normal);
		#endif
	#endif
	#ifdef Q3_LIGHTALL
		output.q3LitNormal = q3Normal;
		output.q3LitPosition = q3Position;
	#endif
	#ifdef Q3_FOG_KEEP
		output.q3FogKeep = 1.0 - q3FogFactor(q3FogTexCoords(q3Position));
	#endif
	#ifdef Q3_DEPTH_HACK
		output.position.z = ${DEPTH_HACK} * output.position.z;
	#endif
`
    ],
    [
      'litUserDeclarationPS',
      `
#ifdef Q3_LIGHTALL
varying q3LitNormal: vec3f;
varying q3LitPosition: vec3f;
uniform q3_light: array<vec4f, 3>;
uniform q3_viewer: vec4f;
#endif
#ifdef Q3_FOG_KEEP
varying q3FogKeep: f32;
#endif
`
    ],
    [
      'emissivePS',
      `
uniform material_emissive: vec3f;
uniform material_emissiveIntensity: f32;
#ifdef Q3_LIGHTALL
#ifdef Q3_LIT_MULTIPLIES
const q3Overbright: f32 = 1.0;
#else
const q3Overbright: f32 = ${overbright};
#endif
fn q3CalcSpecular(NH: f32, EH: f32) -> f32 {
	let rr = ${roughness} * ${roughness};
	let rrrr = rr * rr;
	let d = NH * NH * (rrrr - 1.0) + 1.0;
	let v = EH * EH * (${roughness} + 0.5) + 0.00000001;
	return ${baseSpecular} * (rrrr / (4.0 * d * d * v));
}
fn q3Lightall(texel: vec3f) -> vec3f {
	let N = normalize(select(q3LitNormal, -q3LitNormal, pcFrontFacing));
	let L = normalize(uniform.q3_light[2].xyz);
	var E = N;
	if (uniform.q3_viewer.w > 0.0) { E = normalize(uniform.q3_viewer.xyz - q3LitPosition); }
	let H = normalize(L + E);
	let NL = clamp(dot(N, L), 0.0, 1.0);
	let highlight = q3CalcSpecular(clamp(dot(N, H), 0.0, 1.0), clamp(dot(E, H), 0.0, 1.0)) * ${deluxe};
	let diffuse = texel * (1.0 - ${baseSpecular});
	return q3Overbright * (uniform.q3_light[1].rgb * (diffuse + highlight) * NL + uniform.q3_light[0].rgb * diffuse) / 255.0;
}
#endif
fn getEmission() {
	dEmission = uniform.material_emissive * uniform.material_emissiveIntensity;
	#ifdef Q3_LIGHTALL
	var texel = vec3f(1.0);
	#ifdef STD_EMISSIVE_TEXTURE
	texel = textureSampleBias({STD_EMISSIVE_TEXTURE_NAME}, {STD_EMISSIVE_TEXTURE_NAME}Sampler, {STD_EMISSIVE_TEXTURE_UV}, {STD_TEXTURE_BIAS}).{STD_EMISSIVE_TEXTURE_CHANNEL};
	#endif
	dEmission = dEmission * pow(q3Lightall(texel) / ${headroom}, vec3f(2.2));
	#else
	#ifdef STD_EMISSIVE_TEXTURE
	dEmission *= {STD_EMISSIVE_TEXTURE_DECODE}(textureSampleBias({STD_EMISSIVE_TEXTURE_NAME}, {STD_EMISSIVE_TEXTURE_NAME}Sampler, {STD_EMISSIVE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).{STD_EMISSIVE_TEXTURE_CHANNEL};
	#endif
	#ifdef STD_EMISSIVE_VERTEX
	dEmission = dEmission * saturate(vVertexColor.{STD_EMISSIVE_VERTEX_CHANNEL});
	#endif
	#endif
}
`
    ]
  ]);

  return { glsl, wgsl };
}

/** What a stage's material draws, which picks the chunks' parts. */
export interface ModelStage {
  /** `rgbGen lightingDiffuse`. */
  lit: boolean;
  /** `alphaGen lightingSpecular`. */
  specular: boolean;
  /** `tcGen environment`. */
  environment: boolean;
  /**
   * Its `tcMod`s move its coordinates through the port's own uniform (`q3_coords`), not the
   * engine's map transform: all of a staged model's, or an effect model's `turb` alone.
   */
  coordinates: boolean;
  /**
   * Its shader's deforms: a `normal` among them brings the noise in, and a sprite the sprites.
   * Any at all puts a lit stage in `opengl2`'s generic program.
   */
  deforms: readonly Deform[];
  /**
   * Its blend multiplies colour by colour, so `opengl2` lights it with no overbright factor
   * (`ComputeShaderColors`, `tr_shade.c:572–581`); none where absent.
   */
  multiplies?: boolean;
  /**
   * How a fog reaches it: a blended stage's colour or alpha dimmed by it, as its shader's
   * `adjustColorsForFog` says, or the fog's own pass over the surface (`RB_FogPass`); none where
   * absent. A dimmed stage reads its draw's `q3_fog`, and keeps its colour whole where that says no
   * distance along the view, as a draw in no fog does.
   */
  fog?: Exclude<FogAdjustment, 'none'> | 'pass';
}

/**
 * The defines a stage's material takes under a style, each on or off. A lit stage takes one way to
 * be shaded, by `litPath`: per vertex (`Q3_LIT`, with `Q3_LIT_GENERIC` for the generic program),
 * or per pixel (`Q3_LIGHTALL`). `lightall` draws no highlight, with its per-vertex `fastLight`
 * too, so a lit stage it draws keeps its texture's alpha (`tr_shade.c:717–721`).
 */
function stageDefines(stage: ModelStage, style: RendererStyle): [string, boolean][] {
  const path = litPath(style, stage.deforms.length > 0);
  // `lightall`'s program, per pixel or as `fastLight`.
  const inLightall = stage.lit && (path === 'lightall' || path === 'fastLight');
  const { fog } = stage;
  const dimmed = fog !== undefined && fog !== 'pass';
  return [
    ['Q3_FOG_COORDS', fog !== undefined],
    ['Q3_FOG_PASS', fog === 'pass'],
    ['Q3_FOG_KEEP', dimmed],
    ['Q3_FOG_RGB', dimmed && fog !== 'alpha'],
    ['Q3_FOG_ALPHA', dimmed && fog !== 'rgb'],
    ['Q3_LIT', stage.lit && path !== 'lightall'],
    ['Q3_LIT_GENERIC', stage.lit && path === 'generic'],
    ['Q3_LIT_MULTIPLIES', inLightall && stage.multiplies === true],
    ['Q3_LIGHTALL', stage.lit && path === 'lightall'],
    ['Q3_SPECULAR', stage.specular && !inLightall],
    ['Q3_TCGEN_ENV', stage.environment],
    ['Q3_TCMOD', stage.coordinates],
    ['Q3_DEFORM_NOISE', stage.deforms.some((deform) => deform.type === 'normal')],
    ['Q3_DEFORM_SPRITE', stage.deforms.some(isSpriteDeform)]
  ];
}

/**
 * Whether a stage's draw reads `q3_viewer`, so its model has to be told where the viewer is each
 * frame: it shines, it mirrors, or `lightall` lights it per pixel.
 *
 * @param style - The renderer to draw like; the one set at load unless a test says otherwise.
 */
export function readsViewer(stage: ModelStage, style: RendererStyle = rendererStyle()): boolean {
  const defines = new Map(stageDefines(stage, style));
  return defines.get('Q3_SPECULAR')! || defines.get('Q3_TCGEN_ENV')! || defines.get('Q3_LIGHTALL')!;
}

/** A dimmed stage's ending, by language: what it writes, times how much the fog leaves it. */
const MODEL_FOG_END = {
  [SHADERLANGUAGE_GLSL]: `\n#ifdef Q3_FOG_KEEP${FOG_END.glsl}#endif\n`,
  [SHADERLANGUAGE_WGSL]: `\n#ifdef Q3_FOG_KEEP${FOG_END.wgsl}#endif\n`
};

/** Each material's stage as its chunks were set for it, to set them again in another style. */
const chunkedStages = new WeakMap<StandardMaterial, ModelStage>();

/**
 * Set a material's model chunks again in another style, as a map's scene draws every model in
 * `opengl1`'s; one with none is left as it is.
 */
export function restyleModelChunks(material: StandardMaterial, style: RendererStyle): void {
  const stage = chunkedStages.get(material);
  if (stage) applyModelChunks(material, stage, style);
}

/**
 * Set the model chunks on a stage's material, in both languages, with the defines its stage
 * needs. The material keeps drawing as it did: its colour, blend and maps are untouched.
 *
 * @param style - The renderer to draw like; the one set at load unless a test says otherwise.
 */
export function applyModelChunks(
  material: StandardMaterial,
  stage: ModelStage,
  style: RendererStyle = rendererStyle()
): void {
  chunkedStages.set(material, stage);
  const { glsl, wgsl } = modelChunks(style);
  for (const [language, chunks] of [
    [SHADERLANGUAGE_GLSL, glsl],
    [SHADERLANGUAGE_WGSL, wgsl]
  ] as const) {
    const own = material.getShaderChunks(language);
    for (const [name, code] of chunks) own.set(name, code);
    // The dimming first, before a merged stage's second texture: Q3 dims the stage's colour.
    const ending = own.get('litUserMainEndPS') ?? '';
    const dimming = MODEL_FOG_END[language];
    if (!ending.startsWith(dimming)) own.set('litUserMainEndPS', dimming + ending);
  }
  material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
  for (const [name, on] of stageDefines(stage, style)) material.setDefine(name, on);
  material.update();
}
