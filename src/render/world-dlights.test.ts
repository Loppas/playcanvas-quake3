// @vitest-environment jsdom
import {
  ADDRESS_CLAMP_TO_EDGE,
  BLENDMODE_DST_COLOR,
  BLENDMODE_ONE,
  BLENDMODE_ZERO,
  CULLFACE_BACK,
  FILTER_LINEAR,
  FUNC_EQUAL,
  GraphNode,
  Layer,
  TEXTURELOCK_READ,
  VertexBuffer,
  type AppBase
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dlightTexel, projectLight, projectedLight } from '../view/dynamic-lights';
import { worldVertexFormat } from './bsp-world';
import { assembledShaders, createTestApp, expectInOrder, uniform } from './engine-test-fixtures';
import { TextureCache } from './texture-cache';
import { DLIGHT_UNIFORM, WorldDlights, dlightImage, dlightPassMaterial } from './world-dlights';

describe("the world's light passes", () => {
  let app: AppBase;
  let cache: TextureCache;

  beforeEach(() => {
    ({ app } = createTestApp());
    cache = new TextureCache(app.graphicsDevice);
  });

  afterEach(() => {
    app.destroy();
  });

  it("makes R_CreateDlightImage's image once a device, filtered and clamped, unmipped", () => {
    const image = dlightImage(app.graphicsDevice);
    expect(dlightImage(app.graphicsDevice)).toBe(image);
    expect([image.width, image.height, image.mipmaps]).toEqual([16, 16, false]);
    expect([image.minFilter, image.magFilter]).toEqual([FILTER_LINEAR, FILTER_LINEAR]);
    expect([image.addressU, image.addressV]).toEqual(new Array(2).fill(ADDRESS_CLAMP_TO_EDGE));
    const texels = image.lock({ mode: TEXTURELOCK_READ }) as Uint8Array;
    image.unlock();
    for (const [x, y] of [
      [0, 0],
      [7, 7],
      [7, 3],
      [12, 9]
    ]) {
      const at = (y * 16 + x) * 4;
      const b = dlightTexel(x, y);
      expect([...texels.subarray(at, at + 4)]).toEqual([b, b, b, 255]);
    }
  });

  it('blends what is there by the light, at the depth already drawn, writing none', () => {
    const material = dlightPassMaterial(app.graphicsDevice, CULLFACE_BACK, false, cache.scope());
    const { blendState } = material;
    expect([blendState.colorSrcFactor, blendState.colorDstFactor]).toEqual([
      BLENDMODE_DST_COLOR,
      BLENDMODE_ONE
    ]);
    // The framebuffer's alpha kept.
    expect([blendState.alphaSrcFactor, blendState.alphaDstFactor]).toEqual([
      BLENDMODE_ZERO,
      BLENDMODE_ONE
    ]);
    expect([material.depthFunc, material.depthWrite, material.cull]).toEqual([
      FUNC_EQUAL,
      false,
      CULLFACE_BACK
    ]);
    expect(material.emissiveMap).toBe(dlightImage(app.graphicsDevice));
  });

  for (const language of ['glsl', 'wgsl'] as const) {
    it(`works each vertex's place on the image and its colour in ${language}`, () => {
      const material = dlightPassMaterial(app.graphicsDevice, CULLFACE_BACK, false, cache.scope());
      const { vertex, fragment } = assembledShaders(app, material, language, {
        [DLIGHT_UNIFORM]: new Float32Array(8)
      });
      const glsl = language === 'glsl';
      const dlight = glsl ? 'q3_dlight' : 'uniform.q3_dlight';
      expectInOrder(vertex, [
        `return 0.5 + (${dlight}[0].xy - v.xy) * ${dlight}[1].w;`,
        'q3DlightTexCoords(vertex_position.xyz)',
        `${dlight}[0].z - vertex_position.z`,
        glsl ? 'q3Modulate = q3Up < q3Radius * 0.5 ? 1.0' : 'q3Modulate = select(',
        glsl
          ? 'mod(floor(q3_dlight[1].xyz * q3Modulate), 256.0) / 255.0'
          : '% vec3f(256.0)) / 255.0'
      ]);
      expect(fragment).toContain(
        glsl
          ? 'gl_FragColor.rgb *= q3DlightColor;'
          : 'output.color = vec4f(output.color.rgb * q3DlightColor, output.color.a);'
      );
    });
  }

  describe('WorldDlights', () => {
    /** A frame's passes over a vertex buffer of the world's format. */
    function passes() {
      const layer = new Layer({ name: 'world' });
      const device = app.graphicsDevice;
      const vertices = new VertexBuffer(device, worldVertexFormat(device), 3);
      const pulled: unknown[] = [];
      const dlights = new WorldDlights(device, layer, cache.scope(), (material) =>
        pulled.push(material)
      );
      const light = projectLight(
        { origin: { x: 1, y: 2, z: 3 }, radius: 100, color: [1, 0.5, 0], additive: false },
        1,
        2,
        3,
        projectedLight()
      );
      return { layer, vertices, dlights, light, pulled };
    }

    it('gives a pass a draw over the indexes last written, and hides the rest at the end', () => {
      const { layer, vertices, dlights, light } = passes();
      const material = dlights.material(CULLFACE_BACK, false, false);
      const node = new GraphNode('node');
      dlights.begin();
      dlights.room(6).set([0, 1, 2, 2, 1, 0], dlights.written);
      const first = dlights.draw(material, 3, vertices, node, light);
      const second = dlights.draw(material, 3, vertices, node, light);
      dlights.end();
      expect([first.mesh.primitive[0].base, second.mesh.primitive[0].base]).toEqual([0, 3]);
      expect(dlights.written).toBe(6);
      expect(dlights.given.slice(0, dlights.count)).toEqual([first, second]);
      const data = [1, 2, 3, 100, 255, 127.5, 0, 0.01].map(Math.fround);
      expect(uniform(first.instance, DLIGHT_UNIFORM)).toEqual(data);
      expect(layer.meshInstances).toEqual([first.instance, second.instance]);
      // The next frame gives the first out again, and hides the second.
      dlights.begin();
      dlights.room(3);
      expect(dlights.draw(material, 3, vertices, node, light)).toBe(first);
      dlights.end();
      expect([first.instance.visible, second.instance.visible]).toEqual([true, false]);
    });

    it('makes a material once for each cull, pull and blend, and pulls a pulled one', () => {
      const { dlights, pulled } = passes();
      const back = dlights.material(CULLFACE_BACK, false, false);
      expect(dlights.material(CULLFACE_BACK, false, false)).toBe(back);
      const pulledMaterial = dlights.material(CULLFACE_BACK, true, false);
      const additive = dlights.material(CULLFACE_BACK, false, true);
      expect(new Set([back, pulledMaterial, additive]).size).toBe(3);
      expect(pulled).toEqual([pulledMaterial]);
      expect(additive.blendState.colorSrcFactor).toBe(BLENDMODE_ONE);
      expect(dlights.made).toEqual([back, pulledMaterial, additive]);
    });

    it("makes room for a frame's indexes as it needs, every draw reading the new buffer", () => {
      const { vertices, dlights, light } = passes();
      const material = dlights.material(CULLFACE_BACK, false, false);
      const node = new GraphNode('node');
      dlights.begin();
      dlights.room(3).set([7, 8, 9], 0);
      const first = dlights.draw(material, 3, vertices, node, light);
      const before = first.mesh.indexBuffer[0];
      const grown = dlights.room(1 << 17);
      expect(grown.length).toBeGreaterThanOrEqual(3 + (1 << 17));
      // What was written is kept, and every draw reads the new buffer.
      expect([...grown.subarray(0, 3)]).toEqual([7, 8, 9]);
      expect(first.mesh.indexBuffer[0]).not.toBe(before);
      expect(first.mesh.indexBuffer[0].storage).toBe(grown.buffer);
    });

    it('takes every draw out of its layer as it goes', () => {
      const { layer, vertices, dlights, light } = passes();
      const material = dlights.material(CULLFACE_BACK, false, false);
      dlights.begin();
      dlights.room(3);
      dlights.draw(material, 3, vertices, new GraphNode('node'), light);
      dlights.end();
      dlights.destroy();
      expect(layer.meshInstances).toEqual([]);
    });
  });
});
