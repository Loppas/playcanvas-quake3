import { Preprocessor } from 'playcanvas/build/playcanvas/src/core/preprocessor.js';
import { describe, expect, it } from 'vitest';

import { COORDINATES_LENGTH } from '../view/stage-motion';
import { COORDINATE_HELPERS, coordinatesGlsl, coordinatesWgsl } from './stage-coordinates';
import { STAGE_COORDINATE_CHUNKS, VERTEX_COLOR_CHUNKS } from './world-stages';

describe('the coordinates chunks', () => {
  it('declare a texture\'s pieces as writeCoordinates lays them out, and step the sine table', () => {
    expect(coordinatesGlsl('q3_tc0', 'q3Coordinates0')).toContain(
      `uniform vec4 q3_tc0[${COORDINATES_LENGTH / 4}];`
    );
    expect(coordinatesWgsl('q3_tc0', 'q3Coordinates0')).toContain(
      `uniform q3_tc0: array<vec4f, ${COORDINATES_LENGTH / 4}>;`
    );
    // A period of 1,023 steps, as tr.sinTable has, and the cast's truncation towards zero.
    for (const helper of [COORDINATE_HELPERS.glsl, COORDINATE_HELPERS.wgsl]) {
      expect(helper).toContain(`${(2 * Math.PI) / 1023}`);
      expect(helper).toMatch(/floor\(scaled\)/);
      expect(helper).toMatch(/ceil\(scaled\)/);
    }
  });

  it('read the pieces where writeCoordinates writes them, as coordinatesAt reads them', () => {
    // The count, the first piece, each turb and the piece after it, by vec4.
    for (const code of [coordinatesGlsl('q3_tc0', 'f'), coordinatesWgsl('q3_tc0', 'f')]) {
      for (const part of ['q3_tc0[0].x', 'q3_tc0[1].xyz', 'q3_tc0[1 + 1].xyz', 'q3_tc0[3 + 3 * j]', 'q3_tc0[4 + 3 * j].xyz', 'q3_tc0[4 + 3 * j + 1].xyz']) {
        expect(code, part).toContain(part);
      }
      // s by x + z, t by y, each times the amplitude.
      expect(code).toMatch(/q3TurbStep\(xyz\.x \+ xyz\.z, turb\), q3TurbStep\(xyz\.y, turb\)\) \* turb\.x/);
    }
    // The phase's fraction in steps, and the side its whole periods put the sum on.
    for (const helper of [COORDINATE_HELPERS.glsl, COORDINATE_HELPERS.wgsl]) {
      expect(helper).toContain('sum + turb.y * 1024.0');
      expect(helper).toContain('scaled >= -1024.0 * turb.z');
      expect(helper).toContain('whole - 1024.0 * floor(whole / 1024.0)');
    }
  });

  it("preprocess a world stage's cleanly under every combination of its defines", () => {
    const names = ['UV0', 'Q3_SKY_POINTS'];
    for (const k of [0, 1]) {
      names.push(`Q3_TC${k}`, `Q3_TC${k}_LIGHTMAP`, `Q3_TC${k}_ENVIRONMENT`, `Q3_TC${k}_VECTOR`);
    }
    for (const language of ['glsl', 'wgsl'] as const) {
      const source = [...STAGE_COORDINATE_CHUNKS[language].values()].join('\n');
      for (let mask = 0; mask < 1 << names.length; mask++) {
        const on = (name: string) => (mask & (1 << names.indexOf(name))) !== 0;
        const defines = names.filter(on).map((name) => `#define ${name}\n`);
        const out = Preprocessor.run(defines.join('') + source, new Map(), { stripDefines: true });
        const label = `${language} ${mask}`;
        expect(out, label).not.toBeNull();
        expect(out, label).not.toContain('#');
        // getUv0 only where uv set 0 is declared; getUv1 always, where forceUv1 declares set 1.
        expect(/getUv0\(\)/.test(out!), label).toBe(on('UV0'));
        expect(out!.includes('getUv1()'), label).toBe(true);
        expect(out!.includes('st = q3Coordinates0('), label).toBe(on('UV0') && on('Q3_TC0'));
        expect(out!.includes('st = q3Coordinates1('), label).toBe(on('Q3_TC1'));
        expect(out!.includes('q3_sky.w'), label).toBe(on('Q3_SKY_POINTS'));
        // Each texture's vectors are declared only where it reads them.
        expect(/uniform (vec4 )?q3_tcv0/.test(out!), label).toBe(on('Q3_TC0_VECTOR'));
        expect(/uniform (vec4 )?q3_tcv1/.test(out!), label).toBe(on('Q3_TC1_VECTOR'));
        // Each texture's coordinates are made as its tcGen makes them.
        const reads = (fn: string) => {
          const body = out!.slice(out!.indexOf(fn), out!.indexOf('return st', out!.indexOf(fn)));
          return body.match(/st = (vertex_texCoord\d|q3Environment\(q3Position\(\), q3Normal\(\)\)|vec2f?\(dot\(q3Position\(\), (?:uniform\.)?q3_tcv\d)/)?.[1];
        };
        const madeFrom = (k: number) =>
          on(`Q3_TC${k}_ENVIRONMENT`)
            ? 'q3Environment(q3Position(), q3Normal())'
            : on(`Q3_TC${k}_VECTOR`)
              ? `${language === 'glsl' ? 'vec2' : 'vec2f'}(dot(q3Position(), ${language === 'glsl' ? '' : 'uniform.'}q3_tcv${k}`
              : on(`Q3_TC${k}_LIGHTMAP`)
                ? 'vertex_texCoord1'
                : 'vertex_texCoord0';
        if (on('UV0')) expect(reads('getUv0()'), label).toBe(madeFrom(0));
        expect(reads('getUv1()'), label).toBe(madeFrom(1));
      }
    }
  });

  it("preprocess the vertex colours' inverses and the view's alphas cleanly, each only under its define", () => {
    const names = [
      'VERTEX_COLOR',
      'Q3_ONE_MINUS_VERTEX_RGB',
      'Q3_ONE_MINUS_VERTEX_ALPHA',
      'Q3_SPECULAR_ALPHA',
      'Q3_PORTAL_ALPHA',
      'Q3_LIGHTING_DIFFUSE'
    ];
    for (const language of ['glsl', 'wgsl'] as const) {
      for (let mask = 0; mask < 1 << names.length; mask++) {
        const on = (name: string) => (mask & (1 << names.indexOf(name))) !== 0;
        const defines = names.filter(on).map((name) => `#define ${name}\n`);
        const out = Preprocessor.run(defines.join('') + VERTEX_COLOR_CHUNKS[language], new Map(), {
          stripDefines: true
        })!;
        const label = `${language} ${mask}`;
        const colored = on('VERTEX_COLOR');
        expect(out, label).not.toContain('#');
        expect(out.includes('1.0 - vertex_color.rgb'), label).toBe(colored && on('Q3_ONE_MINUS_VERTEX_RGB'));
        // The inverse of the bytes, decoded once interpolated, in the stage's emission.
        expect(out, label).not.toContain('pow(');
        expect(out.includes('1.0 - vertex_color.a'), label).toBe(colored && on('Q3_ONE_MINUS_VERTEX_ALPHA'));
        expect(out.includes('.a = q3SpecularAlpha(q3Position(), q3Normal());'), label).toBe(
          colored && on('Q3_SPECULAR_ALPHA')
        );
        expect(out.includes('.a = q3PortalAlpha(q3Position());'), label).toBe(colored && on('Q3_PORTAL_ALPHA'));
        expect(out.includes('VertexColor = q3LightingDiffuse(q3Normal());'), label).toBe(
          colored && on('Q3_LIGHTING_DIFFUSE')
        );
      }
    }
  });
});
