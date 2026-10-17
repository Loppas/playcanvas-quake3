import { SPECULAR_LIGHT_ORIGIN } from '../view/entity-light';
import { eyeInFrame } from '../view/view-terms';
import type { FogFrame } from '../view/world-fog';

/**
 * The view's terms in a world stage's vertex code, mirroring `view/view-terms.ts` line for line:
 * `Q_rsqrt` from the float's bits, the environment's coordinates, the highlight's alpha and the
 * portal's, each alpha a byte. They read the eye from `q3_eye`, an array of the port's own written
 * at each view: the eye in the draw's frame, then in the world's. And the colour a brush model's
 * `lightingDiffuse` stage takes from its light at each vertex, as `diffuseByte` makes it.
 */

/** The array a draw reads the eye from: in its frame, then in the world's, a vec4 each. */
export const EYE_UNIFORM = 'q3_eye[0]';

/**
 * The array a `lightingDiffuse` stage's draw reads its entity's light from, as the models' chunks
 * have it (`writeLight`): the ambient light with its byte's alpha, 1 for a brush model and 0 for
 * the world entity, the directed light, and the direction in the entity's frame.
 */
export const LIGHT_UNIFORM = 'q3_light[0]';

/** `lightOrigin`, as a shader's literal. */
const LIGHT = SPECULAR_LIGHT_ORIGIN.map((axis) => `${axis}.0`).join(', ');

/**
 * Where a vertex's normal comes from: the world's vertices, or none for a cloud's points, which Q3
 * fills without one (`FillCloudySkySide`, `tr_sky.c:498-513`).
 */
const NORMAL = {
  glsl: {
    world: `attribute vec3 vertex_normal;
vec3 q3Normal() {
	return vertex_normal;
}`,
    sky: `vec3 q3Normal() {
	return vec3(0.0);
}`
  },
  wgsl: {
    world: `attribute vertex_normal: vec3f;
fn q3Normal() -> vec3f {
	return vertex_normal;
}`,
    sky: `fn q3Normal() -> vec3f {
	return vec3f(0.0);
}`
  }
};

const declarationsGlsl = (normal: string) => `
uniform vec4 q3_eye[2];
${normal}
float q3Rsqrt(float number) {
	float x2 = number * 0.5;
	float y = intBitsToFloat(0x5f3759df - (floatBitsToInt(number) >> 1));
	return y * (1.5 - x2 * y * y);
}
vec3 q3Towards(vec3 there, vec3 here) {
	vec3 v = there - here;
	return v * q3Rsqrt(dot(v, v));
}
vec2 q3Environment(vec3 xyz, vec3 normal) {
	vec3 viewer = q3Towards(q3_eye[0].xyz, xyz);
	vec3 reflected = normal * 2.0 * dot(normal, viewer) - viewer;
	return vec2(0.5 + reflected.y * 0.5, 0.5 - reflected.z * 0.5);
}
float q3SpecularAlpha(vec3 xyz, vec3 normal) {
	vec3 lightDir = q3Towards(vec3(${LIGHT}), xyz);
	vec3 reflected = normal * 2.0 * dot(normal, lightDir) - lightDir;
	vec3 viewer = q3_eye[0].xyz - xyz;
	float l = dot(reflected, viewer) * q3Rsqrt(dot(viewer, viewer));
	if (l < 0.0) return 0.0;
	l = l * l;
	l = l * l;
	return min(floor(l * 255.0), 255.0) / 255.0;
}
#ifdef Q3_PORTAL_ALPHA
uniform vec4 q3_portal;
float q3PortalAlpha(vec3 xyz) {
	float len = length(xyz - q3_eye[1].xyz) / q3_portal.x;
	if (len < 0.0) return 0.0;
	if (len > 1.0) return 1.0;
	return floor(len * 255.0) / 255.0;
}
#endif
#ifdef Q3_LIGHTING_DIFFUSE
uniform vec4 q3_light[3];
vec4 q3LightingDiffuse(vec3 normal) {
	float incoming = dot(normal, q3_light[2].xyz);
	if (incoming <= 0.0) return vec4(floor(q3_light[0].rgb), 255.0 * q3_light[0].a) / 255.0;
	vec3 light = min(floor(q3_light[0].rgb + incoming * q3_light[1].rgb), vec3(255.0));
	return vec4(light, 255.0) / 255.0;
}
#endif
`;

const declarationsWgsl = (normal: string) => `
uniform q3_eye: array<vec4f, 2>;
${normal}
fn q3Rsqrt(number: f32) -> f32 {
	let x2 = number * 0.5;
	let y = bitcast<f32>(0x5f3759df - (bitcast<i32>(number) >> 1u));
	return y * (1.5 - x2 * y * y);
}
fn q3Towards(there: vec3f, here: vec3f) -> vec3f {
	let v = there - here;
	return v * q3Rsqrt(dot(v, v));
}
fn q3Environment(xyz: vec3f, normal: vec3f) -> vec2f {
	let viewer = q3Towards(uniform.q3_eye[0].xyz, xyz);
	let reflected = normal * 2.0 * dot(normal, viewer) - viewer;
	return vec2f(0.5 + reflected.y * 0.5, 0.5 - reflected.z * 0.5);
}
fn q3SpecularAlpha(xyz: vec3f, normal: vec3f) -> f32 {
	let lightDir = q3Towards(vec3f(${LIGHT}), xyz);
	let reflected = normal * 2.0 * dot(normal, lightDir) - lightDir;
	let viewer = uniform.q3_eye[0].xyz - xyz;
	var l = dot(reflected, viewer) * q3Rsqrt(dot(viewer, viewer));
	if (l < 0.0) {
		return 0.0;
	}
	l = l * l;
	l = l * l;
	return min(floor(l * 255.0), 255.0) / 255.0;
}
#ifdef Q3_PORTAL_ALPHA
uniform q3_portal: vec4f;
fn q3PortalAlpha(xyz: vec3f) -> f32 {
	let len = length(xyz - uniform.q3_eye[1].xyz) / uniform.q3_portal.x;
	if (len < 0.0) {
		return 0.0;
	}
	if (len > 1.0) {
		return 1.0;
	}
	return floor(len * 255.0) / 255.0;
}
#endif
#ifdef Q3_LIGHTING_DIFFUSE
uniform q3_light: array<vec4f, 3>;
fn q3LightingDiffuse(normal: vec3f) -> vec4f {
	let incoming = dot(normal, uniform.q3_light[2].xyz);
	if (incoming <= 0.0) {
		return vec4f(floor(uniform.q3_light[0].rgb), 255.0 * uniform.q3_light[0].a) / 255.0;
	}
	let light = min(floor(uniform.q3_light[0].rgb + incoming * uniform.q3_light[1].rgb), vec3f(255.0));
	return vec4f(light, 255.0) / 255.0;
}
#endif
`;

/**
 * The view's terms' declarations, a stage's `litUserDeclarationVS`: for the world's stages, and for
 * a sky's clouds, whose vertices have no normal.
 */
export const VIEW_TERM_DECLARATIONS = {
  glsl: { world: declarationsGlsl(NORMAL.glsl.world), sky: declarationsGlsl(NORMAL.glsl.sky) },
  wgsl: { world: declarationsWgsl(NORMAL.wgsl.world), sky: declarationsWgsl(NORMAL.wgsl.sky) }
};

/** One frame's eye, and the array its draws read. */
interface EyeView {
  frame: FogFrame;
  data: Float32Array;
}

/**
 * The arrays the view's terms read: one for each frame their draws are placed in, the world's or a
 * brush model's, written again at each view.
 */
export class EyeUniforms {
  private readonly views = new Map<number, EyeView>();
  /** The same in a list, which a view goes through by index, making no iterator. */
  private readonly list: EyeView[] = [];

  /**
   * The array for the draws in a frame, made at the first asking.
   *
   * @param entity - Which frame, by a number the caller keeps for it.
   */
  data(entity: number, frame: FogFrame): Float32Array {
    let view = this.views.get(entity);
    if (!view) {
      view = { frame, data: new Float32Array(8) };
      this.views.set(entity, view);
      this.list.push(view);
    }
    return view.data;
  }

  /**
   * Write each array for a view.
   *
   * @param eye - The view's origin, in the world's frame.
   */
  view(eye: readonly [number, number, number]): void {
    for (let i = 0; i < this.list.length; i++) {
      const { frame, data } = this.list[i];
      eyeInFrame(eye, frame, data);
      data[4] = eye[0];
      data[5] = eye[1];
      data[6] = eye[2];
    }
  }
}
