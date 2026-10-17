// @vitest-environment jsdom
import { SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL, ShaderMaterial, type AppBase, type Material } from 'playcanvas';
import engineGlsl from 'playcanvas/build/playcanvas/src/scene/shader-lib/glsl/chunks/gsplat/vert/gsplatModify.js';
import engineWgsl from 'playcanvas/build/playcanvas/src/scene/shader-lib/wgsl/chunks/gsplat/vert/gsplatModify.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { simToWorld } from '../coords';
import type { Vec3 } from '../sim/vec3';
import { MAX_DLIGHTS, lightWorld, type DynamicLight } from '../view/dynamic-lights';
import type { RendererStyle } from '../view/overbright';
import { createTestApp, expectClose } from './engine-test-fixtures';
import { MODEL_CHUNKS_VERSION } from './model-chunks';
import {
  SPLAT_LIGHT_COLORS,
  SPLAT_LIGHT_COUNT,
  SPLAT_LIGHT_POSITIONS,
  SplatLights,
  packSplatLights,
  splatLightUniforms,
  splatLightsGlsl,
  splatLightsWgsl,
  type SplatLightUniforms
} from './splat-lights';

const CLASSIC = { renderer: 'opengl1', overBrightBits: 1 } as const;
const MODERN = { renderer: 'opengl2', overBrightBits: 1 } as const;

function light(origin: Vec3, radius: number, color: DynamicLight['color'], additive = false): DynamicLight {
  return { origin, radius, color, additive };
}

/** A quad on a player standing on a floor at z 0, a rocket over it, and something additive. */
const LIGHTS = [
  light({ x: 100, y: -40, z: 24 }, 216, [0.2, 0.2, 1]),
  light({ x: 150, y: -10, z: 60 }, 200, [1, 0.75, 0]),
  light({ x: 60, y: -80, z: 8 }, 300, [0.5, 0.1, 0.3], true)
];

/** The hook's `q3DlightTexel` and `q3DlightImage`, line for line. */
function hookImage(s: number, t: number): number {
  const texel = (x: number, y: number): number => {
    const b = Math.floor(4000 / ((7.5 - x) ** 2 + (7.5 - y) ** 2));
    return b > 255 ? 255 : b < 75 ? 0 : b;
  };
  const clampEdge = (value: number) => Math.min(15, Math.max(0, value));
  const [u, v] = [s * 16 - 0.5, t * 16 - 0.5];
  const [fx, fy] = [Math.floor(u), Math.floor(v)];
  const [wx, wy] = [u - fx, v - fy];
  const [x0, y0, x1, y1] = [clampEdge(fx), clampEdge(fy), clampEdge(fx + 1), clampEdge(fy + 1)];
  const mix = (a: number, b: number, w: number) => a * (1 - w) + b * w;
  const top = mix(texel(x0, y0), texel(x1, y0), wx);
  const bottom = mix(texel(x0, y1), texel(x1, y1), wx);
  return mix(top, bottom, wy) / 255;
}

/**
 * What the hook's `modifySplatColor` does to one splat, in double precision: the twin of its
 * code, reading the packed uniforms in the world's frame, to hold them to `lightWorld`'s.
 */
function hook(
  uniforms: SplatLightUniforms,
  center: readonly number[],
  color: readonly number[],
  style: RendererStyle
): number[] {
  const rgb = [...color];
  const count = Math.min(Math.trunc(uniforms.count), MAX_DLIGHTS);
  for (let i = 0; i < count; i++) {
    const [x, y, z, radius] = uniforms.positions.subarray(i * 4, i * 4 + 4);
    const d = [x - center[0], y - center[1], z - center[2]];
    const h = Math.abs(d[1]);
    if (h > radius || Math.abs(d[0]) > 0.5 * radius || Math.abs(d[2]) > 0.5 * radius) continue;
    const reach = h < 0.5 * radius ? 1 : (2 * (radius - h)) / radius;
    const tint = uniforms.colors.subarray(i * 4, i * 4 + 4);
    const image = hookImage(0.5 + d[0] / radius, 0.5 + d[2] / radius);
    for (let k = 0; k < 3; k++) {
      const vertex =
        style.renderer === 'opengl1' ? Math.floor(255 * tint[k] * reach) / 255 : tint[k] * reach;
      const source = image * vertex;
      rgb[k] = tint[3] > 0.5 ? rgb[k] + source : rgb[k] * (1 + source);
    }
  }
  return rgb;
}

/** Points about each light: across its image, on its diagonals, and up and down its reach. */
function pointsAbout(lights: readonly DynamicLight[]): Vec3[] {
  const points: Vec3[] = [];
  const steps = [-0.6, -0.45, -0.37, -0.29, -0.21, -0.13, -0.05, 0, 0.08, 0.16, 0.24, 0.33, 0.41, 0.52];
  for (const { origin, radius } of lights) {
    for (const a of steps) {
      for (const b of steps) {
        for (const c of [-1.1, -0.83, -0.61, -0.3, 0, 0.4, 0.58, 0.9]) {
          points.push({ x: origin.x + a * radius, y: origin.y + b * radius, z: origin.z + c * radius });
        }
      }
    }
  }
  return points;
}

describe('the hook against its twin', () => {
  it('lights a splat where lightWorld lights its point, in the world frame, under either renderer', () => {
    const uniforms = splatLightUniforms();
    packSplatLights(LIGHTS, uniforms);
    const color = [0.25, 0.5, 0.125];
    let lit = 0;
    for (const style of [CLASSIC, MODERN]) {
      for (const point of pointsAbout(LIGHTS)) {
        const expected = lightWorld([0.25, 0.5, 0.125], point, LIGHTS, style);
        const drawn = hook(uniforms, simToWorld(point), color, style);
        expectClose(drawn, expected);
        if (expected.some((value, i) => value !== color[i])) lit++;
      }
    }
    // Most of the points are lit, so the comparison is not of nothing twice.
    expect(lit).toBeGreaterThan(pointsAbout(LIGHTS).length);
  });

  it("truncates opengl1's vertex colour and keeps opengl2's, as the twin does", () => {
    const uniforms = splatLightUniforms();
    const quad = light({ x: 0, y: 0, z: 0 }, 200, [0.2, 0.2, 1]);
    packSplatLights([quad], uniforms);
    // 0.6 of the radius below: 255 · 0.2 · 0.8 is 40.8, which ioq3's ri.ftol truncates to 40.
    const below = simToWorld({ x: 0, y: 0, z: -120 });
    expect(hook(uniforms, below, [1, 1, 1], CLASSIC)[0]).toBeCloseTo(1 + 40 / 255, 6);
    expect(hook(uniforms, below, [1, 1, 1], MODERN)[0]).toBeCloseTo(1.16, 6);
  });

  it('reads only the lights counted, whatever the slots past them still hold', () => {
    const uniforms = splatLightUniforms();
    packSplatLights(LIGHTS, uniforms);
    packSplatLights(LIGHTS.slice(0, 1), uniforms);
    const point = { x: 150, y: -10, z: 30 };
    const drawn = hook(uniforms, simToWorld(point), [0.5, 0.5, 0.5], MODERN);
    expectClose(drawn, lightWorld([0.5, 0.5, 0.5], point, LIGHTS.slice(0, 1), MODERN));
    expect(drawn).not.toEqual(hook({ ...uniforms, count: 2 }, simToWorld(point), [0.5, 0.5, 0.5], MODERN));
  });
});

describe('packSplatLights', () => {
  it('writes each light in world metres, Y up, its radius in metres, and 1 for one that adds', () => {
    const uniforms = splatLightUniforms();
    packSplatLights(LIGHTS, uniforms);
    expect(uniforms.count).toBe(3);
    expect([...uniforms.positions.subarray(0, 12)]).toEqual([
      ...[100 / 32, 24 / 32, 40 / 32, 216 / 32],
      ...[150 / 32, 60 / 32, 10 / 32, 200 / 32],
      ...[60 / 32, 8 / 32, 80 / 32, 300 / 32]
    ]);
    expect([...uniforms.colors.subarray(0, 12)]).toEqual([
      ...Float32Array.from([0.2, 0.2, 1, 0]),
      ...Float32Array.from([1, 0.75, 0, 0]),
      ...Float32Array.from([0.5, 0.1, 0.3, 1])
    ]);
  });

  it('holds 32 and counts no more', () => {
    const uniforms = splatLightUniforms();
    const many = Array.from({ length: MAX_DLIGHTS + 1 }, (_, i) => light({ x: 32 * i, y: 0, z: 0 }, 100, [1, 1, 1]));
    packSplatLights(many, uniforms);
    expect(uniforms.count).toBe(MAX_DLIGHTS);
    expect(uniforms.positions).toHaveLength(MAX_DLIGHTS * 4);
    expect(uniforms.positions[(MAX_DLIGHTS - 1) * 4]).toBe(MAX_DLIGHTS - 1);
    packSplatLights([], uniforms);
    expect(uniforms.count).toBe(0);
  });
});

/** Each function a chunk defines, by the line that opens it. */
function signatures(chunk: string): string[] {
  return chunk.match(/^(?:void|fn) \w+\(.*\{$/gm) ?? [];
}

describe('the hook', () => {
  it("defines each of the engine's gsplatModifyVS functions with the engine's own signature", () => {
    for (const style of [CLASSIC, MODERN]) {
      for (const [ours, engine] of [
        [splatLightsGlsl(style), engineGlsl],
        [splatLightsWgsl(style), engineWgsl]
      ]) {
        expect(signatures(engine)).toHaveLength(3);
        for (const line of signatures(engine)) expect(ours).toContain(line);
      }
    }
  });

  it("writes opengl1's byte into the vertex colour, and opengl2's whole, in either language", () => {
    for (const chunk of [splatLightsGlsl(CLASSIC), splatLightsWgsl(CLASSIC)]) {
      expect(chunk).toContain('floor(255.0 * (tint.rgb * reach)) / 255.0');
    }
    for (const chunk of [splatLightsGlsl(MODERN), splatLightsWgsl(MODERN)]) {
      expect(chunk).not.toContain('255.0 * (tint.rgb');
      expect(chunk).toContain('q3DlightImage(0.5 + d.xz / radius) * (tint.rgb * reach);');
    }
  });

  it("declares the lights as 32 of each, the WGSL reading them through the engine's uniform block", () => {
    const glsl = splatLightsGlsl(CLASSIC);
    const wgsl = splatLightsWgsl(CLASSIC);
    expect(glsl).toContain(`uniform vec4 ${SPLAT_LIGHT_POSITIONS}[32];`);
    expect(glsl).toContain(`uniform vec4 ${SPLAT_LIGHT_COLORS}[32];`);
    expect(glsl).toContain(`uniform float ${SPLAT_LIGHT_COUNT};`);
    expect(wgsl).toContain(`uniform ${SPLAT_LIGHT_POSITIONS}: array<vec4f, 32>;`);
    expect(wgsl).toContain(`uniform ${SPLAT_LIGHT_COLORS}: array<vec4f, 32>;`);
    expect(wgsl).toContain(`uniform ${SPLAT_LIGHT_COUNT}: f32;`);
    for (const name of [SPLAT_LIGHT_POSITIONS, SPLAT_LIGHT_COLORS, SPLAT_LIGHT_COUNT]) {
      expect(wgsl.match(new RegExp(`(?<!uniform\\.)${name}\\b`, 'g')), name).toHaveLength(1);
    }
  });

  it('holds, in either language, each line the twin mirrors', () => {
    // GLSL and WGSL, and the twin's reading of each: the light's offset, its height along the
    // world's y, the cut at its radius, the reach, the image across x and z, and the blend.
    const lines: [string, string][] = [
      ['vec3 d = light.xyz - center;', 'let d = light.xyz - center;'],
      ['float h = abs(d.y);', 'let h = abs(d.y);'],
      ['if (h > radius || abs(d.x) > 0.5 * radius || abs(d.z) > 0.5 * radius) continue;',
        'if (h > radius || abs(d.x) > 0.5 * radius || abs(d.z) > 0.5 * radius) {'],
      ['float reach = h < 0.5 * radius ? 1.0 : 2.0 * (radius - h) / radius;',
        'let reach = select(2.0 * (radius - h) / radius, 1.0, h < 0.5 * radius);'],
      ['q3DlightImage(0.5 + d.xz / radius) *', 'q3DlightImage(0.5 + d.xz / radius) *'],
      ['if (tint.w > 0.5) {', 'if (tint.w > 0.5) {'],
      ['color.rgb += source;', 'rgb = rgb + source;'],
      ['color.rgb *= 1.0 + source;', 'rgb = rgb * (1.0 + source);'],
      [`int count = min(int(${SPLAT_LIGHT_COUNT}), 32);`, `let count = min(i32(uniform.${SPLAT_LIGHT_COUNT}), 32);`]
    ];
    for (const style of [CLASSIC, MODERN]) {
      const [glsl, wgsl] = [splatLightsGlsl(style), splatLightsWgsl(style)];
      for (const [inGlsl, inWgsl] of lines) {
        expect(glsl, inGlsl).toContain(inGlsl);
        expect(wgsl, inWgsl).toContain(inWgsl);
      }
    }
  });

  it("samples a 16-texel image about its middle, clamped to its edge, as the twin's", () => {
    for (const chunk of [splatLightsGlsl(CLASSIC), splatLightsWgsl(CLASSIC)]) {
      expect(chunk).toMatch(/vec2f?\(7\.5\) - t/);
      expect(chunk).toContain('floor(4000.0 / dot(d, d))');
      expect(chunk).toContain('st * 16.0 - 0.5');
      expect(chunk).toMatch(/clamp\(f, (vec2f\()?0\.0\)?, (vec2f\()?15\.0\)?\)/);
    }
  });
});

/** What a material holds for a uniform, as `setParameter` gave it. */
function parameter(material: Material, name: string): unknown {
  return (material.getParameter(name) as { data: unknown } | undefined)?.data;
}

describe('SplatLights', () => {
  let app: AppBase;
  beforeEach(() => {
    ({ app } = createTestApp());
  });
  afterEach(() => {
    app.destroy();
  });

  it('puts the hook in both languages on the material every splat draws with', () => {
    const { material } = app.scene.gsplat;
    new SplatLights(material, MODERN);
    expect(material.getShaderChunks(SHADERLANGUAGE_GLSL).get('gsplatModifyVS')).toBe(splatLightsGlsl(MODERN));
    expect(material.getShaderChunks(SHADERLANGUAGE_WGSL).get('gsplatModifyVS')).toBe(splatLightsWgsl(MODERN));
    expect(material.shaderChunksVersion).toBe(MODEL_CHUNKS_VERSION);
    expect(parameter(material, SPLAT_LIGHT_COUNT)).toBe(0);
  });

  it("hands the hook each frame's lights, packed, and marks the material for the draw to copy", () => {
    const material = new ShaderMaterial();
    const lights = new SplatLights(material, CLASSIC);
    const version = material.updateVersion;
    lights.write(LIGHTS);
    const expected = splatLightUniforms();
    packSplatLights(LIGHTS, expected);
    expect(parameter(material, `${SPLAT_LIGHT_POSITIONS}[0]`)).toEqual(expected.positions);
    expect(parameter(material, `${SPLAT_LIGHT_COLORS}[0]`)).toEqual(expected.colors);
    expect(parameter(material, SPLAT_LIGHT_COUNT)).toBe(3);
    expect(material.updateVersion).toBeGreaterThan(version);
    lights.write([]);
    expect(parameter(material, SPLAT_LIGHT_COUNT)).toBe(0);
  });
});
