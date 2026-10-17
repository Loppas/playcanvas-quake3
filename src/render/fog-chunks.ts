import { FOG_TABLE_SIZE } from '../view/world-fog';

/**
 * A fog's arithmetic in GLSL and WGSL, for every draw a fog reaches: the world's (`bsp-fog.ts`) and
 * the models' (`model-chunks.ts`). Each vertex finds its place on the fog image as
 * `RB_CalcFogTexCoords` finds it (`view/world-fog.ts`), from its fog's vectors in its draw's frame:
 * `q3_fog`, an array of the port's own, written at each view. Whether the eye is in the fog is read
 * from it too, so flying into one makes no shader.
 */

/** The array a fogged draw reads its fog's vectors from: s's, t's, and the eye's t, a vec4 each. */
export const FOG_UNIFORM = 'q3_fog[0]';

/** `FOG_TABLE_SIZE − 1`: the last entry of the fog's table, as a shader literal. */
const TABLE_END = `${FOG_TABLE_SIZE - 1}.0`;

/** `RB_CalcFogTexCoords` for one vertex, in its draw's frame. */
export const FOG_COORDS = {
  glsl: `
uniform vec4 q3_fog[3];
vec2 q3FogTexCoords(vec3 v) {
	float s = dot(v, q3_fog[0].xyz) + q3_fog[0].w;
	float t = dot(v, q3_fog[1].xyz) + q3_fog[1].w;
	float eyeT = q3_fog[2].x;
	if (eyeT < 0.0) {
		if (t < 1.0) {
			t = 1.0 / 32.0;
		} else {
			t = 1.0 / 32.0 + 30.0 / 32.0 * t / (t - eyeT);
		}
	} else if (t < 0.0) {
		t = 1.0 / 32.0;
	} else {
		t = 31.0 / 32.0;
	}
	return vec2(s, t);
}
`,
  wgsl: `
uniform q3_fog: array<vec4f, 3>;
fn q3FogTexCoords(v: vec3f) -> vec2f {
	let s = dot(v, uniform.q3_fog[0].xyz) + uniform.q3_fog[0].w;
	var t = dot(v, uniform.q3_fog[1].xyz) + uniform.q3_fog[1].w;
	let eyeT = uniform.q3_fog[2].x;
	if (eyeT < 0.0) {
		if (t < 1.0) {
			t = 1.0 / 32.0;
		} else {
			t = 1.0 / 32.0 + 30.0 / 32.0 * t / (t - eyeT);
		}
	} else if (t < 0.0) {
		t = 1.0 / 32.0;
	} else {
		t = 31.0 / 32.0;
	}
	return vec2f(s, t);
}
`
};

/** `R_FogFactor`, its table's entry the square root it holds. */
export const FOG_FACTOR = {
  glsl: `
float q3FogFactor(vec2 st) {
	float d = st.x - 1.0 / 512.0;
	if (d < 0.0) return 0.0;
	float depth = st.y;
	if (depth < 1.0 / 32.0) return 0.0;
	if (depth < 31.0 / 32.0) d *= (depth - 1.0 / 32.0) / (30.0 / 32.0);
	d = min(d * 8.0, 1.0);
	return sqrt(floor(d * ${TABLE_END}) / ${TABLE_END});
}
`,
  wgsl: `
fn q3FogFactor(st: vec2f) -> f32 {
	var d = st.x - 1.0 / 512.0;
	if (d < 0.0) {
		return 0.0;
	}
	let depth = st.y;
	if (depth < 1.0 / 32.0) {
		return 0.0;
	}
	if (depth < 31.0 / 32.0) {
		d = d * ((depth - 1.0 / 32.0) / (30.0 / 32.0));
	}
	d = min(d * 8.0, 1.0);
	return sqrt(floor(d * ${TABLE_END}) / ${TABLE_END});
}
`
};

/**
 * A dimmed stage's ending: what it writes multiplied by how much of it the pixel keeps, its colour
 * (`Q3_FOG_RGB`) or its alpha (`Q3_FOG_ALPHA`).
 */
export const FOG_END = {
  glsl: `
	#ifdef Q3_FOG_RGB
	gl_FragColor.rgb *= q3FogKeep;
	#endif
	#ifdef Q3_FOG_ALPHA
	gl_FragColor.a *= q3FogKeep;
	#endif
`,
  wgsl: `
	#ifdef Q3_FOG_RGB
	output.color = vec4f(output.color.rgb * q3FogKeep, output.color.a);
	#endif
	#ifdef Q3_FOG_ALPHA
	output.color.a = output.color.a * q3FogKeep;
	#endif
`
};
