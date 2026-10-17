import { SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL, type StandardMaterial } from 'playcanvas';

import type { AlphaFunc } from '../formats/shader-script';
import { MODEL_CHUNKS_VERSION } from './model-chunks';

/**
 * Where each test discards, as a condition on the alpha `a` (`GL_State`, `tr_backend.c:346-363`):
 * at 0 or below, at 0.5 or above, or below 0.5. PlayCanvas' own test is `GE128`'s, against its
 * reference of 0.5, which these keep declared as its uniforms expect.
 */
const DISCARDS: Readonly<Record<AlphaFunc, { glsl: string; wgsl: string }>> = {
  GT0: { glsl: 'a <= 0.0', wgsl: 'a <= 0.0' },
  LT128: { glsl: 'a >= alpha_ref', wgsl: 'a >= uniform.alpha_ref' },
  GE128: { glsl: 'a < alpha_ref', wgsl: 'a < uniform.alpha_ref' }
};

/** Statements scaling the alpha `a` before it is tested, in each language. */
export interface AlphaFactor {
  glsl: string;
  wgsl: string;
}

/** An `alphaTestPS` chunk in each language, testing as `func` does after any `factor`. */
function alphaTestChunks(func: AlphaFunc, factor?: AlphaFactor): { glsl: string; wgsl: string } {
  const discards = DISCARDS[func];
  // A WGSL parameter can't be written to.
  const wgslStart = factor
    ? `fn alphaTest(alpha: f32) {\n\tvar a = alpha;\n${factor.wgsl}`
    : 'fn alphaTest(a: f32) {\n';
  return {
    glsl: `
uniform float alpha_ref;
void alphaTest(float a) {
${factor?.glsl ?? ''}	if (${discards.glsl}) discard;
}
`,
    wgsl: `
uniform alpha_ref: f32;
${wgslStart}	if (${discards.wgsl}) {
		discard;
	}
}
`
  };
}

/**
 * Give a material a stage's `alphaFunc`, as `GL_State` sets it: drawn where its alpha is above 0,
 * below 0.5, or at least 0.5.
 *
 * @param factor - What the alpha is multiplied by first, as a merged stage's second texture's
 *   alpha multiplies it.
 */
export function applyAlphaFunc(
  material: StandardMaterial,
  func: AlphaFunc | undefined,
  factor?: AlphaFactor
): void {
  if (!func) return;
  material.alphaTest = 0.5;
  if (func === 'GE128' && !factor) return;
  const { glsl, wgsl } = alphaTestChunks(func, factor);
  material.getShaderChunks(SHADERLANGUAGE_GLSL).set('alphaTestPS', glsl);
  material.getShaderChunks(SHADERLANGUAGE_WGSL).set('alphaTestPS', wgsl);
  material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
}
