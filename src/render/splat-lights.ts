import { SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL, type Material } from 'playcanvas';

import { UNITS_PER_METRE, simToWorld } from '../coords';
import { DLIGHT_SIZE, MAX_DLIGHTS, type DynamicLight } from '../view/dynamic-lights';
import { rendererStyle, type RendererStyle } from '../view/overbright';
import { MODEL_CHUNKS_VERSION } from './model-chunks';

/**
 * Q3's dynamic light on the splat map: each splat a light reaches has its colour
 * multiplied by `1 + light`, as `ProjectDlightTexture` multiplies a lit surface
 * (`renderergl1/tr_shade.c:407–556`), or added to, for an additive light.
 *
 * A splat's colour is the lit surface, since the capture holds what Q3 bakes, and Q3's world light
 * reads no normal and does no occlusion: a splat's centre is all it needs. It runs in the shared
 * splat material's colour hook, `gsplatModifyVS`, which every frame's draw runs anyway, so a light
 * that moves re-bakes nothing. WebGL2 runs the GLSL
 * in the splats' vertex shader, and WebGPU the WGSL in its projector's compute pass.
 *
 * Its twin is `lightWorld` (`view/dynamic-lights.ts`), in Quake's frame, which the tests hold the
 * hook to. Here the frame is the world's: metres, Y up. Q3's light projects down its z, the world's
 * y; the image is alike along its two other axes, so which is which does not matter.
 */

/** Each light's first vec4: where it is, in world metres, and its radius, in metres. */
export const SPLAT_LIGHT_POSITIONS = 'q3_dlight_position';
/** Each light's second: its colour, 0–1 a channel, and 1 for a light that adds. */
export const SPLAT_LIGHT_COLORS = 'q3_dlight_color';
/** How many of the {@link MAX_DLIGHTS} slots hold a light this frame. */
export const SPLAT_LIGHT_COUNT = 'q3_dlight_count';

/** The texel of the image's middle: its size less one, halved. */
const MIDDLE = `${DLIGHT_SIZE / 2 - 0.5}`;
const SIZE = `${DLIGHT_SIZE}.0`;
const EDGE = `${DLIGHT_SIZE - 1}.0`;

/**
 * The colour times the height's share, as a vertex takes it: `opengl1` writes it as a byte,
 * truncated as ioquake3's `ri.ftol` truncates, and `opengl2` keeps it whole.
 */
function vertexColor(style: RendererStyle, value: string): string {
  return style.renderer === 'opengl1' ? `floor(255.0 * ${value}) / 255.0` : value;
}

/** The hook in GLSL. */
export function splatLightsGlsl(style: RendererStyle = rendererStyle()): string {
  return /* glsl */ `
uniform vec4 ${SPLAT_LIGHT_POSITIONS}[${MAX_DLIGHTS}];
uniform vec4 ${SPLAT_LIGHT_COLORS}[${MAX_DLIGHTS}];
uniform float ${SPLAT_LIGHT_COUNT};

// One texel of Q3's light image: 4000 over its squared distance from the middle, 255 at most,
// nothing under 75.
float q3DlightTexel(vec2 t) {
    vec2 d = vec2(${MIDDLE}) - t;
    float b = floor(4000.0 / dot(d, d));
    return b > 255.0 ? 255.0 : (b < 75.0 ? 0.0 : b);
}

// The image as GL_LINEAR and GL_CLAMP_TO_EDGE sample it.
float q3DlightImage(vec2 st) {
    vec2 u = st * ${SIZE} - 0.5;
    vec2 f = floor(u);
    vec2 w = u - f;
    vec2 t0 = clamp(f, 0.0, ${EDGE});
    vec2 t1 = clamp(f + 1.0, 0.0, ${EDGE});
    float top = mix(q3DlightTexel(t0), q3DlightTexel(vec2(t1.x, t0.y)), w.x);
    float bottom = mix(q3DlightTexel(vec2(t0.x, t1.y)), q3DlightTexel(t1), w.x);
    return mix(top, bottom, w.y) / 255.0;
}

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

void modifySplatColor(vec3 center, inout vec4 color) {
    int count = min(int(${SPLAT_LIGHT_COUNT}), ${MAX_DLIGHTS});
    for (int i = 0; i < ${MAX_DLIGHTS}; i++) {
        if (i >= count) break;
        vec4 light = ${SPLAT_LIGHT_POSITIONS}[i];
        vec3 d = light.xyz - center;
        float radius = light.w;
        float h = abs(d.y);
        // Past these the image and the height give nothing.
        if (h > radius || abs(d.x) > 0.5 * radius || abs(d.z) > 0.5 * radius) continue;
        float reach = h < 0.5 * radius ? 1.0 : 2.0 * (radius - h) / radius;
        vec4 tint = ${SPLAT_LIGHT_COLORS}[i];
        vec3 source = q3DlightImage(0.5 + d.xz / radius) * ${vertexColor(style, '(tint.rgb * reach)')};
        if (tint.w > 0.5) {
            color.rgb += source;
        } else {
            color.rgb *= 1.0 + source;
        }
    }
}
`;
}

/** The hook in WGSL. */
export function splatLightsWgsl(style: RendererStyle = rendererStyle()): string {
  return /* wgsl */ `
uniform ${SPLAT_LIGHT_POSITIONS}: array<vec4f, ${MAX_DLIGHTS}>;
uniform ${SPLAT_LIGHT_COLORS}: array<vec4f, ${MAX_DLIGHTS}>;
uniform ${SPLAT_LIGHT_COUNT}: f32;

fn q3DlightTexel(t: vec2f) -> f32 {
    let d = vec2f(${MIDDLE}) - t;
    let b = floor(4000.0 / dot(d, d));
    return select(select(b, 0.0, b < 75.0), 255.0, b > 255.0);
}

fn q3DlightImage(st: vec2f) -> f32 {
    let u = st * ${SIZE} - 0.5;
    let f = floor(u);
    let w = u - f;
    let t0 = clamp(f, vec2f(0.0), vec2f(${EDGE}));
    let t1 = clamp(f + 1.0, vec2f(0.0), vec2f(${EDGE}));
    let top = mix(q3DlightTexel(t0), q3DlightTexel(vec2f(t1.x, t0.y)), w.x);
    let bottom = mix(q3DlightTexel(vec2f(t0.x, t1.y)), q3DlightTexel(t1), w.x);
    return mix(top, bottom, w.y) / 255.0;
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let count = min(i32(uniform.${SPLAT_LIGHT_COUNT}), ${MAX_DLIGHTS});
    var rgb = (*color).rgb;
    for (var i: i32 = 0; i < count; i++) {
        let light = uniform.${SPLAT_LIGHT_POSITIONS}[i];
        let d = light.xyz - center;
        let radius = light.w;
        let h = abs(d.y);
        if (h > radius || abs(d.x) > 0.5 * radius || abs(d.z) > 0.5 * radius) {
            continue;
        }
        let reach = select(2.0 * (radius - h) / radius, 1.0, h < 0.5 * radius);
        let tint = uniform.${SPLAT_LIGHT_COLORS}[i];
        let source = q3DlightImage(0.5 + d.xz / radius) * ${vertexColor(style, '(tint.rgb * reach)')};
        if (tint.w > 0.5) {
            rgb = rgb + source;
        } else {
            rgb = rgb * (1.0 + source);
        }
    }
    *color = vec4f(rgb, (*color).a);
}
`;
}

/** The frame's lights as the hook reads them, packed into its two arrays. */
export interface SplatLightUniforms {
  positions: Float32Array;
  colors: Float32Array;
  count: number;
}

/** Room for every light the frame can hold. */
export function splatLightUniforms(): SplatLightUniforms {
  return { positions: new Float32Array(MAX_DLIGHTS * 4), colors: new Float32Array(MAX_DLIGHTS * 4), count: 0 };
}

/** Pack the frame's lights into the world's frame, in metres, in the order they were added. */
export function packSplatLights(lights: readonly DynamicLight[], out: SplatLightUniforms): void {
  out.count = Math.min(lights.length, MAX_DLIGHTS);
  for (let i = 0; i < out.count; i++) {
    const { origin, radius, color, additive } = lights[i];
    out.positions.set([...simToWorld(origin), radius / UNITS_PER_METRE], i * 4);
    out.colors.set([color[0], color[1], color[2], additive ? 1 : 0], i * 4);
  }
}

/** The splat map's dynamic light: the hook on the shared splat material, and its lights each frame. */
export class SplatLights {
  private readonly material: Material;
  private readonly uniforms = splatLightUniforms();

  /**
   * Put the hook on the material every splat component draws with, `app.scene.gsplat.material`.
   *
   * @param style - Whose arithmetic the hook takes; latched, like the model chunks'.
   */
  constructor(material: Material, style: RendererStyle = rendererStyle()) {
    this.material = material;
    material.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatModifyVS', splatLightsGlsl(style));
    material.getShaderChunks(SHADERLANGUAGE_WGSL).set('gsplatModifyVS', splatLightsWgsl(style));
    material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
    this.write([]);
  }

  /**
   * Hand the hook this frame's lights. Setting the material's parameters marks only the material,
   * which the draw copies, so the splats' work buffer is never baked again for it.
   */
  write(lights: readonly DynamicLight[]): void {
    const { uniforms, material } = this;
    packSplatLights(lights, uniforms);
    material.setParameter(`${SPLAT_LIGHT_POSITIONS}[0]`, uniforms.positions);
    material.setParameter(`${SPLAT_LIGHT_COLORS}[0]`, uniforms.colors);
    material.setParameter(SPLAT_LIGHT_COUNT, uniforms.count);
    material.update();
  }
}
