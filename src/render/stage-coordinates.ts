import { COORDINATES_LENGTH, FUNCTABLE_SIZE, MAX_TURBS } from '../view/stage-motion';

/**
 * A texture's coordinates moved on the GPU from the pieces `writeCoordinates` writes
 * (`view/stage-motion.ts`): each affine piece applied in turn, and between them each `turb`, which
 * adds the sine table's step at the vertex's place, as `RB_CalcTurbulentTexCoords` does
 * (`tr_shade_calc.c:917-932`). The world's stages and the models' share it, in GLSL and WGSL.
 */

/** The vec4s of a texture's coordinates, as its uniform array holds them. */
const VEC4S = COORDINATES_LENGTH / 4;

/** One step of `tr.sinTable`, whose period is 1,023 steps (`tr_init.c:1200`), as a literal. */
const SIN_STEP = `${(2 * Math.PI) / (FUNCTABLE_SIZE - 1)}`;

/** The steps of a table, as a float literal. */
const STEPS = `${FUNCTABLE_SIZE}.0`;

/**
 * `tr.sinTable` at a `turb`'s step for one coordinate: `(int64_t)((sum / 1024 + now) · 1024) & 1023`,
 * from the fraction of the phase now (`turb.y`) and its whole periods (`turb.z`), so the cast
 * truncates towards zero on the side the whole sum falls.
 */
const TURB_STEP_GLSL = `
float q3TurbStep(float sum, vec4 turb) {
	float scaled = sum + turb.y * ${STEPS};
	float whole = scaled >= -${STEPS} * turb.z ? floor(scaled) : ceil(scaled);
	return sin((whole - ${STEPS} * floor(whole / ${STEPS})) * ${SIN_STEP});
}
`;
const TURB_STEP_WGSL = `
fn q3TurbStep(sum: f32, turb: vec4f) -> f32 {
	let scaled = sum + turb.y * ${STEPS};
	let whole = select(ceil(scaled), floor(scaled), scaled >= -${STEPS} * turb.z);
	return sin((whole - ${STEPS} * floor(whole / ${STEPS})) * ${SIN_STEP});
}
`;

/** The helpers every texture's coordinates share, declared once before them. */
export const COORDINATE_HELPERS = { glsl: TURB_STEP_GLSL, wgsl: TURB_STEP_WGSL };

/**
 * A texture's coordinates: the uniform array `uniform` and a function `fn(st, xyz)` moving the
 * coordinates `st` of a vertex at `xyz` through it. Needs {@link COORDINATE_HELPERS} before it.
 */
export function coordinatesGlsl(uniform: string, fn: string): string {
  const affine = (at: string) =>
    `vec2(dot(vec3(st, 1.0), ${uniform}[${at}].xyz), dot(vec3(st, 1.0), ${uniform}[${at} + 1].xyz))`;
  return `
uniform vec4 ${uniform}[${VEC4S}];
vec2 ${fn}(vec2 st, vec3 xyz) {
	st = ${affine('1')};
	int turbs = int(${uniform}[0].x);
	for (int j = 0; j < ${MAX_TURBS}; j++) {
		if (j >= turbs) break;
		vec4 turb = ${uniform}[3 + 3 * j];
		st += vec2(q3TurbStep(xyz.x + xyz.z, turb), q3TurbStep(xyz.y, turb)) * turb.x;
		st = ${affine('4 + 3 * j')};
	}
	return st;
}
`;
}

/** {@link coordinatesGlsl} in WGSL. */
export function coordinatesWgsl(uniform: string, fn: string): string {
  const affine = (at: string) =>
    `vec2f(dot(vec3f(st, 1.0), uniform.${uniform}[${at}].xyz), dot(vec3f(st, 1.0), uniform.${uniform}[${at} + 1].xyz))`;
  return `
uniform ${uniform}: array<vec4f, ${VEC4S}>;
fn ${fn}(given: vec2f, xyz: vec3f) -> vec2f {
	var st = given;
	st = ${affine('1')};
	let turbs = i32(uniform.${uniform}[0].x);
	for (var j = 0; j < ${MAX_TURBS}; j++) {
		if (j >= turbs) {
			break;
		}
		let turb = uniform.${uniform}[3 + 3 * j];
		st = st + vec2f(q3TurbStep(xyz.x + xyz.z, turb), q3TurbStep(xyz.y, turb)) * turb.x;
		st = ${affine('4 + 3 * j')};
	}
	return st;
}
`;
}
