import {
  BLEND_NONE,
  CULLFACE_NONE,
  GraphNode,
  Layer,
  Mesh,
  MeshInstance,
  StandardMaterial,
  type AppBase,
  type CameraComponent,
  type Entity
} from 'playcanvas';

import { overbrightFactor, rendererStyle, type RendererStyle } from '../view/overbright';
import { HYPERSPACE_KEY } from '../view/scene-sort';
import type { LayeredDraws, SceneDraws } from './scene-draws';
import type { Warmed } from './warm-up';
import { OPAQUE_BLEND } from './world-stages';

/**
 * What a frame inside a teleporter shows for the world: `RDF_HYPERSPACE` (`cg_view.c:688–690`,
 * `tr_backend.c:383–395`). Quake 3 draws no world, no entity and no effect that frame, and clears
 * the screen to a grey that climbs from black to white every 256 ms, with the gun and the 2D
 * drawn over it.
 *
 * The port covers the eye's view instead: one opaque quad over the whole screen, in a layer the
 * eye draws last, which the gun's and the 2D's cameras then draw over. What is beneath it still
 * renders, and nothing on screen shows it. In a map's scene the quad is the grey Q3 clears its
 * framebuffer to, under the ramp, and the gun's draws key after it (`scene-draws.ts`).
 */

/** Name of the layer the grey draws in. */
export const HYPERSPACE_LAYER_NAME = 'hyperspace';

/**
 * The grey on screen at `time`: `(refdef.time & 255) / 255`, the clear's, through the display's
 * gamma ramp where the renderer has one. Classic Q3's ramp multiplies the whole screen, the clear
 * with it; `opengl2` clears to the grey as it is.
 *
 * @param time - `cg.time`, in milliseconds, which the refdef takes whole.
 */
export function hyperspaceGrey(time: number, style: RendererStyle = rendererStyle()): number {
  const grey = (Math.floor(time) & 255) / 255;
  const ramp = style.renderer === 'opengl1' ? overbrightFactor(style) : 1;
  return Math.min(1, grey * ramp);
}

/** The grey as Q3 clears its framebuffer to it, before the ramp: a map's scene's. */
export function hyperspaceClear(time: number): number {
  return (Math.floor(time) & 255) / 255;
}

/** The grey over the eye's view, shown on a hyperspace frame and hidden on any other. */
export class HyperspaceScreen implements LayeredDraws {
  private readonly app: AppBase;
  private readonly camera: CameraComponent;
  private readonly layer: Layer;
  /** The layers the quad is in: its own, or a map's scene's. */
  private layers: readonly Layer[];
  private readonly material: StandardMaterial;
  private readonly instance: MeshInstance;
  /** The grey last drawn, so a frame showing the same leaves the material alone. */
  private grey = Number.NaN;

  /**
   * @param app - The running app.
   * @param camera - The eye, which the layer is added to, after every layer it already draws.
   * @param scene - The scene the quad is placed in, where a map's world is drawn.
   */
  constructor(app: AppBase, camera: Entity, scene?: SceneDraws) {
    this.app = app;
    this.camera = camera.camera!;
    this.layer = new Layer({ name: HYPERSPACE_LAYER_NAME });
    app.scene.layers.pushOpaque(this.layer);
    this.camera.layers = [...this.camera.layers, this.layer.id];

    const mesh = new Mesh(app.graphicsDevice);
    mesh.setPositions([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    // Present but unused: a mesh built without a NORMAL stream draws nothing at all.
    mesh.setNormals([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    mesh.setIndices([0, 1, 2, 0, 2, 3]);
    mesh.update();
    this.material = new StandardMaterial();
    this.material.useLighting = false;
    this.material.diffuse.set(0, 0, 0);
    this.material.blendType = BLEND_NONE;
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.cull = CULLFACE_NONE;
    this.material.update();
    this.instance = new MeshInstance(mesh, this.material, new GraphNode(HYPERSPACE_LAYER_NAME));
    // Placed by its vertices alone, so it covers the screen wherever the camera looks.
    this.instance.screenSpace = true;
    this.instance.cull = false;
    this.instance.visible = false;
    this.layer.addMeshInstances([this.instance]);
    this.layers = [this.layer];
    scene?.keepOwn('screen', [this.layer]);
    scene?.placeBatch(this, 'screen');
  }

  /**
   * Draw in other layers from now on: a map's scene's, where the quad is the framebuffer's grey,
   * blended `GL_ONE GL_ZERO` to sit in its one list, or its own.
   */
  setLayers(layers: readonly Layer[]): void {
    for (const layer of this.layers) layer.removeMeshInstances([this.instance]);
    this.layers = layers;
    for (const layer of layers) layer.addMeshInstances([this.instance]);
    if (this.inScene) {
      this.material.blendState = OPAQUE_BLEND;
      this.instance.drawOrder = HYPERSPACE_KEY;
    } else {
      this.material.blendType = BLEND_NONE;
    }
    this.grey = Number.NaN;
    this.material.update();
  }

  /** Whether the quad is in a map's scene. */
  private get inScene(): boolean {
    return this.layers[0] !== this.layer;
  }

  /**
   * Draw this frame's grey, or nothing.
   *
   * @param time - `cg.time` on a hyperspace frame, or null on any other.
   */
  show(time: number | null): void {
    this.instance.visible = time !== null;
    if (time === null) return;
    const grey = this.inScene ? hyperspaceClear(time) : hyperspaceGrey(time);
    if (grey === this.grey) return;
    this.grey = grey;
    this.material.emissive.set(grey, grey, grey);
    this.material.update();
  }

  /** Whether the grey is drawn. */
  get shown(): boolean {
    return this.instance.visible;
  }

  /** The grey drawn for the warm-up, so the first teleport compiles nothing, and hidden after. */
  warm(): Warmed {
    return {
      at: (seconds) => this.show(seconds * 1000),
      end: () => this.show(null)
    };
  }

  /** Take the layer out of the eye and the composition. */
  destroy(): void {
    for (const layer of this.layers) layer.removeMeshInstances([this.instance]);
    this.camera.layers = this.camera.layers.filter((id) => id !== this.layer.id);
    this.app.scene.layers.remove(this.layer);
    this.instance.destroy();
    this.material.destroy();
  }
}
