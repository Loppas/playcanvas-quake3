import { Preprocessor } from 'playcanvas/build/playcanvas/src/core/preprocessor.js';
import { describe, expect, it } from 'vitest';

import { WORLD_FRAME } from '../view/world-fog';
import { EyeUniforms, VIEW_TERM_DECLARATIONS } from './view-term-chunks';

describe("the view's terms' declarations", () => {
  it.each(['glsl', 'wgsl'] as const)('preprocess cleanly in %s, the portal only under its define', (language) => {
    for (const where of ['world', 'sky'] as const) {
      for (const portal of [false, true]) {
        const defines = portal ? '#define Q3_PORTAL_ALPHA\n' : '';
        const out = Preprocessor.run(defines + VIEW_TERM_DECLARATIONS[language][where], new Map(), {
          stripDefines: true
        })!;
        const label = `${where} ${portal}`;
        expect(out, label).not.toContain('#');
        expect(out.includes('q3PortalAlpha'), label).toBe(portal);
        // A cloud's points have no normal, so its stage declares no attribute for one.
        expect(out.includes('vertex_normal'), label).toBe(where === 'world');
        for (const part of ['q3Rsqrt', 'q3Environment', 'q3SpecularAlpha', 'q3Normal']) {
          expect(out, `${label} ${part}`).toContain(part);
        }
      }
    }
  });

  it("take Q_rsqrt from the float's bits, and the light where Q3 fixes it", () => {
    const { glsl, wgsl } = VIEW_TERM_DECLARATIONS;
    expect(glsl.world).toContain('intBitsToFloat(0x5f3759df - (floatBitsToInt(number) >> 1))');
    expect(wgsl.world).toContain('bitcast<f32>(0x5f3759df - (bitcast<i32>(number) >> 1u))');
    for (const code of [glsl.world, wgsl.world]) {
      expect(code).toContain('return y * (1.5 - x2 * y * y);');
      expect(code).toContain('-960.0, 1980.0, 96.0');
      // Each alpha truncated to a byte, as a C cast truncates.
      expect(code).toContain('return min(floor(l * 255.0), 255.0) / 255.0;');
      expect(code).toContain('return floor(len * 255.0) / 255.0;');
      // The environment reads the eye in the draw's frame, and the portal the eye in the world's.
      expect(code).toMatch(/q3Towards\((uniform\.)?q3_eye\[0\]\.xyz, xyz\)/);
      expect(code).toMatch(/length\(xyz - (uniform\.)?q3_eye\[1\]\.xyz\)/);
      expect(code).toContain('vec2(0.5 + reflected.y * 0.5, 0.5 - reflected.z * 0.5)'.replace('vec2(', code === wgsl.world ? 'vec2f(' : 'vec2('));
    }
  });
});

describe('EyeUniforms', () => {
  it("gives each frame's draws one array, and writes the eye in it and in the world's at each view", () => {
    const eyes = new EyeUniforms();
    const turned = {
      origin: [64, -32, 16],
      axis: [
        [0, 1, 0],
        [-1, 0, 0],
        [0, 0, 1]
      ]
    } as const;
    const world = eyes.data(2, WORLD_FRAME);
    const model = eyes.data(0, turned);
    expect(eyes.data(2, WORLD_FRAME)).toBe(world);
    eyes.view([300.5, 200.25, 50]);
    expect([...world]).toEqual([300.5, 200.25, 50, 0, 300.5, 200.25, 50, 0]);
    expect([...model]).toEqual([232.25, -236.5, 34, 0, 300.5, 200.25, 50, 0]);
  });
});
