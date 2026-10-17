// @vitest-environment jsdom
import {
  BLEND_PREMULTIPLIED,
  Entity,
  LAYERID_WORLD,
  Mesh,
  MeshInstance,
  SHADER_PREPASS,
  StandardMaterial,
  version,
  type AppBase,
  type Material,
  type ShaderMaterial
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EFFECTS_LAYER_NAME,
  EffectsLayer,
  SPLAT_DEPTH_VERIFIED_ENGINE,
  findSplatMeshInstance
} from './effects-layer';
import { createTestApp } from './engine-test-fixtures';

/**
 * The effects layer's two guarantees, measured on a real app: effects
 * draw after the splat map, and the map's depth is laid down in between.
 *
 * The unified splat renderer needs a GPU, so the map here is a stand-in — a blended,
 * depthless instance in World — and the gsplat system hands out its material the way it
 * hands out the real map's. That lookup is the one mocked seam.
 */

/** One step of a rendered frame, with the watched material's state as it ran. */
interface Step {
  /** `<layer>:<opaque|blended>`, or `instances` for an explicit instance list. */
  name: string;
  shaderPass: number;
  instances?: MeshInstance[];
  depthWrite: boolean;
  colourWrite: boolean;
}

/** A stand-in for the splat map: blended, writing no depth, in World. */
function addStandInMap(app: AppBase): MeshInstance {
  const mesh = new Mesh(app.graphicsDevice);
  mesh.setPositions([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  mesh.setNormals([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  mesh.setIndices([0, 1, 2]);
  mesh.update();

  const material = new StandardMaterial();
  material.blendType = BLEND_PREMULTIPLIED;
  material.depthWrite = false;
  material.update();

  const instance = new MeshInstance(mesh, material);
  const entity = new Entity('map');
  entity.addComponent('render', { meshInstances: [instance] });
  app.root.addChild(entity);
  vi.spyOn(app.systems.gsplat!, 'getMaterial').mockReturnValue(
    material as unknown as ShaderMaterial
  );
  return instance;
}

/** Render one frame and list its steps, reading `watched`'s write masks as each one ran. */
function renderSteps(app: AppBase, watched: Material): Step[] {
  const steps: Step[] = [];
  const renderer = app.renderer;
  const render = renderer.renderForwardLayer.bind(renderer);
  const spy = vi
    .spyOn(renderer, 'renderForwardLayer')
    .mockImplementation((camera, target, layer, transparent, shaderPass, options) => {
      steps.push({
        name: layer ? `${layer.name}:${transparent ? 'blended' : 'opaque'}` : 'instances',
        shaderPass,
        instances: options?.meshInstances,
        depthWrite: watched.depthWrite,
        colourWrite:
          watched.redWrite || watched.greenWrite || watched.blueWrite || watched.alphaWrite
      });
      render(camera, target, layer, transparent, shaderPass, options);
    });
  app.render();
  spy.mockRestore();
  return steps;
}

/** Just the step names of one rendered frame. */
function renderNames(app: AppBase, watched: Material): string[] {
  return renderSteps(app, watched).map((step) => step.name);
}

let app: AppBase;
let camera: Entity;

beforeEach(() => {
  ({ app, camera } = createTestApp());
});

afterEach(() => {
  vi.restoreAllMocks();
  app.destroy();
});

describe('EffectsLayer', () => {
  it("composes its blended half straight after World's, for the eye to draw", () => {
    const effects = new EffectsLayer(app, camera);
    const composition = app.scene.layers;
    const world = composition.getLayerById(LAYERID_WORLD)!;

    expect(effects.layer.name).toBe(EFFECTS_LAYER_NAME);
    expect(composition.getTransparentIndex(effects.layer)).toBe(
      composition.getTransparentIndex(world) + 1
    );
    // Everything in it is blended, so its opaque half is never composed.
    expect(composition.getOpaqueIndex(effects.layer)).toBe(-1);
    expect(camera.camera!.layers).toContain(effects.layer.id);
  });

  it("draws the splats' depth once per frame, between World's blended pass and the effects", () => {
    const splats = addStandInMap(app);
    new EffectsLayer(app, camera);

    for (let frame = 0; frame < 2; frame++) {
      const names = renderNames(app, splats.material!);
      const world = names.indexOf('World:blended');
      expect(names.slice(world, world + 3)).toEqual([
        'World:blended',
        'instances',
        `${EFFECTS_LAYER_NAME}:blended`
      ]);
      expect(names.filter((name) => name === 'instances')).toHaveLength(1);
    }
  });

  it('draws them depth-only through their prepass variant, then restores the material', () => {
    const splats = addStandInMap(app);
    new EffectsLayer(app, camera);
    const steps = renderSteps(app, splats.material!);

    // The map's own draw is untouched.
    const map = steps.find((step) => step.name === 'World:blended')!;
    expect(map).toMatchObject({ depthWrite: false, colourWrite: true });

    const depth = steps.find((step) => step.name === 'instances')!;
    expect(depth.instances).toHaveLength(1);
    expect(depth.instances![0]).toBe(splats);
    expect(depth).toMatchObject({ shaderPass: SHADER_PREPASS, depthWrite: true, colourWrite: false });

    const material = splats.material!;
    expect(material.depthWrite).toBe(false);
    expect([material.redWrite, material.greenWrite, material.blueWrite, material.alphaWrite]).toEqual(
      [true, true, true, true]
    );
    expect(material.blendType).toBe(BLEND_PREMULTIPLIED);
  });

  it("leaves every other camera's World pass alone", () => {
    const splats = addStandInMap(app);
    new EffectsLayer(app, camera);
    const other = new Entity('other-camera');
    other.addComponent('camera');
    app.root.addChild(other);

    const names = renderNames(app, splats.material!);
    expect(names.filter((name) => name === 'World:blended')).toHaveLength(2);
    expect(names.filter((name) => name === 'instances')).toHaveLength(1);
  });

  it('adds no draw while there is no map', () => {
    new EffectsLayer(app, camera);
    const names = renderNames(app, new StandardMaterial());
    expect(names).toContain(`${EFFECTS_LAYER_NAME}:blended`);
    expect(names).not.toContain('instances');
  });

  it('adds no draw while the splat instance is hidden', () => {
    const splats = addStandInMap(app);
    new EffectsLayer(app, camera);
    splats.visible = false;
    expect(renderNames(app, splats.material!)).not.toContain('instances');
  });

  it('leaves the composition and the camera, and stops drawing, when destroyed', () => {
    const splats = addStandInMap(app);
    const effects = new EffectsLayer(app, camera);
    effects.destroy();

    expect(app.scene.layers.getTransparentIndex(effects.layer)).toBe(-1);
    expect(camera.camera!.layers).not.toContain(effects.layer.id);
    expect(renderNames(app, splats.material!)).not.toContain('instances');
  });
});

describe('findSplatMeshInstance', () => {
  const world = () => app.scene.layers.getLayerById(LAYERID_WORLD)!;

  it("finds the instance in the layer that carries the map's material", () => {
    const splats = addStandInMap(app);
    expect(findSplatMeshInstance(app, camera.camera!.camera, world())).toBe(splats);
  });

  it('is null while the map has no material', () => {
    expect(findSplatMeshInstance(app, camera.camera!.camera, world())).toBeNull();
  });

  it('reports once, loudly, when no instance carries the material', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(app.systems.gsplat!, 'getMaterial').mockReturnValue(
      new StandardMaterial() as unknown as ShaderMaterial
    );

    expect(findSplatMeshInstance(app, camera.camera!.camera, world())).toBeNull();
    expect(findSplatMeshInstance(app, camera.camera!.camera, world())).toBeNull();
    expect(errors).toHaveBeenCalledOnce();
  });

  it('was verified against the installed engine', () => {
    expect(
      version,
      'PlayCanvas changed. Check the unified splat renderer still draws one instance, carrying ' +
        "getMaterial's material, from the layer's own list; read pixels back with the map " +
        "shown, to see an effect past the map's sort point still draw and the depth draw leave " +
        'its pixels unchanged; then move SPLAT_DEPTH_VERIFIED_ENGINE forward.'
    ).toBe(SPLAT_DEPTH_VERIFIED_ENGINE);
  });
});
