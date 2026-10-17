import {
  AppBase,
  AppOptions,
  CameraComponentSystem,
  ElementComponentSystem,
  ElementInput,
  Entity,
  EventHandler,
  GSplatComponentSystem,
  Mesh,
  MeshInstance,
  NullGraphicsDevice,
  RenderComponentSystem,
  ScreenComponentSystem,
  Texture,
  type Shader,
  type StandardMaterial
} from 'playcanvas';
import { expect } from 'vitest';

import type { EntityLight } from '../view/entity-light';
import type { MenuFont } from './menu-font';
import { writeLight } from './model-chunks';

/**
 * A real PlayCanvas app on the engine's own null device, for tests that need layers, draw
 * order and render events but no pixels. It needs a DOM, so files using it opt into jsdom.
 *
 * `app.render()` runs the whole frame — composition, culling, every layer's render step and
 * the scene's layer events — with only the device calls stubbed out, so draw order measured
 * here is the engine's own.
 *
 * @returns The app, and a camera entity drawing the default layers.
 */
export function createTestApp(): { app: AppBase; camera: Entity } {
  const canvas = document.createElement('canvas');
  const options = new AppOptions();
  options.graphicsDevice = new NullGraphicsDevice(canvas);
  // `App.ts`'s element input, which the menu's items take the pointer through.
  options.elementInput = new ElementInput(canvas);
  // `App.ts`'s component systems. No resource handlers: nothing here loads an asset.
  options.componentSystems = [
    CameraComponentSystem,
    GSplatComponentSystem,
    RenderComponentSystem,
    ScreenComponentSystem,
    ElementComponentSystem
  ];

  const app = new AppBase(canvas);
  app.init(options);

  const camera = new Entity('camera');
  camera.addComponent('camera');
  app.root.addChild(camera);
  return { app, camera };
}

/**
 * The shaders the engine assembles for a material on a triangle in front of the camera, in WGSL
 * where the device is told it is WebGPU; nothing is compiled. The app draws a frame to make them.
 *
 * @param parameters - Uniforms the draw holds.
 */
export function assembledShaders(
  app: AppBase,
  material: StandardMaterial,
  language: 'glsl' | 'wgsl',
  parameters: Record<string, Float32Array> = {}
): { vertex: string; fragment: string } {
  const device = app.graphicsDevice as unknown as { isWebGPU: boolean };
  if (language === 'wgsl') device.isWebGPU = true;
  const mesh = new Mesh(app.graphicsDevice);
  mesh.setPositions([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  mesh.setUvs(0, [0, 0, 1, 0, 0, 1]);
  mesh.setUvs(1, [0, 0, 1, 0, 0, 1]);
  mesh.setIndices([0, 1, 2]);
  mesh.update();
  const instance = new MeshInstance(mesh, material);
  for (const [name, data] of Object.entries(parameters)) instance.setParameter(name, data);
  const entity = new Entity('assembled');
  entity.addComponent('render', { meshInstances: [instance] });
  entity.setPosition(0, 0, -2);
  app.root.addChild(entity);
  app.render();
  const made = material as unknown as { variants: Map<number, Shader> };
  const variants = [...made.variants.values()];
  expect(variants.map((shader) => shader.definition.shaderLanguage)).toEqual([language]);
  const { vshader, fshader } = variants[0].definition;
  return { vertex: vshader as string, fragment: fshader as string };
}

/** Expect `text` to hold each of `parts`, each after the one before. */
export function expectInOrder(text: string, parts: string[]): void {
  let from = 0;
  for (const part of parts) {
    const place = text.indexOf(part, from);
    expect(place, `${part}, after ${from}`).toBeGreaterThan(-1);
    from = place + part.length;
  }
}

/** What a draw holds for a uniform, as `setParameter` gave it; `undefined` for none. */
export function held(instance: MeshInstance, name: string): unknown {
  return (instance.getParameter(name) as { data: unknown } | undefined)?.data;
}

/** One affine piece of `q3_coords` that moves nothing: its two rows. */
export const IDENTITY_PIECE = [1, 0, 0, 0, 0, 1, 0, 0];

/** A uniform array a draw holds, as it stands. */
export function uniform(instance: MeshInstance, name: string): number[] {
  return [...(held(instance, name) as Float32Array)];
}

/** `q3_light` as a draw holds it for `light`. */
export function lightUniform(light: EntityLight): number[] {
  const out = new Float32Array(12);
  writeLight(light, out);
  return [...out];
}

/** Expect each of `actual` close to the same of `expected`. */
export function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], 5);
}

/**
 * A font of square glyphs, each as wide as the size it is drawn at, with capitals `capitals` of
 * that size: jsdom has no canvas to draw a face on, and a fitted bar needs its texts' widths.
 */
export function squareFont(app: AppBase, capitals: number): MenuFont {
  const chars: Record<string, object> = {};
  for (let code = 32; code < 127; code++) {
    const letter = String.fromCharCode(code);
    chars[letter] = {
      id: code,
      letter,
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      xadvance: 32,
      xoffset: 0,
      yoffset: 0,
      scale: 1,
      range: 1,
      map: 0,
      bounds: [0, 0, 32, 32]
    };
  }
  const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
  return Object.assign(new EventHandler(), {
    type: 'bitmap',
    em: 1,
    data: {
      version: 3,
      intensity: 0,
      info: { face: 'square', width: 32, height: 32, maps: [{ width: 32, height: 32 }] },
      chars
    },
    textures: [texture],
    capitals,
    // Each glyph's cell is as high as the size.
    cell: 1,
    destroy: () => texture.destroy()
  }) as unknown as MenuFont;
}
