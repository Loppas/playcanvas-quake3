import {
  EVENT_POSTRENDER_LAYER,
  LAYERID_WORLD,
  Layer,
  SHADER_PREPASS,
  type AppBase,
  type Camera,
  type CameraComponent,
  type Entity,
  type Material,
  type MeshInstance
} from 'playcanvas';

/** Name of the layer projectile effects draw in. */
export const EFFECTS_LAYER_NAME = 'world-effects';

/**
 * PlayCanvas release {@link findSplatMeshInstance} was verified against.
 *
 * The lookup leans on how the unified splat renderer is put together, not only on its public
 * surface, so an engine upgrade has to re-check it and move this forward. A test compares it
 * with the installed engine, so an upgrade cannot slip past unnoticed.
 */
export const SPLAT_DEPTH_VERIFIED_ENGINE = '2.23.0';

/** Splat materials already reported without a mesh instance, so each is reported once. */
const reported = new WeakSet<Material>();

/**
 * The splat map's mesh instance for one camera in one layer, or `null` while there is none.
 *
 * Both halves are public API — the gsplat system's `getMaterial` and the layer's own instance
 * list — but that the instance the unified renderer draws carries exactly that material, in
 * exactly that list, is how the engine happens to be built. A map with a material and no
 * instance carrying it means an upgrade has moved the draw; that is logged once, loudly, and
 * the depth draw stands down rather than guess.
 *
 * @param camera - The scene camera, as the gsplat system keys it.
 */
export function findSplatMeshInstance(
  app: AppBase,
  camera: Camera,
  layer: Layer
): MeshInstance | null {
  const material = app.systems.gsplat?.getMaterial(camera, layer);
  if (!material) return null;

  const instance = layer.meshInstances.find((candidate) => candidate.material === material);
  if (!instance && !reported.has(material)) {
    reported.add(material);
    console.error(
      `effects layer: the splat map has a material in layer "${layer.name}" but no mesh ` +
        'instance there carries it, so effects cannot be depth-tested against the map. ' +
        `Re-verify findSplatMeshInstance (last verified on PlayCanvas ${SPLAT_DEPTH_VERIFIED_ENGINE}).`
    );
  }
  return instance ?? null;
}

/**
 * The layer projectile effects draw in, and the splat depth they are tested against.
 *
 * The splat map is one blended draw that writes no depth, sorted against the World layer's
 * other blended draws by a single point, the centre of its bounds. An effect farther along the
 * view than that point is drawn first and painted over; the opaque bodies survive only because
 * they wrote depth. So effects get a layer of their own, composed straight after World's
 * blended pass: the composition, not a sort key, puts them after the map.
 *
 * Drawn after depthless splats they would also show through splats in front of them, so
 * between the two the splat mesh instance is drawn again, **depth only**, through its own
 * prepass variant — alpha-clipped, each splat at its centre's depth. The effects then
 * depth-test against the visible map per pixel, the way the bodies already do.
 *
 * Only the layer's transparent half is composed. Everything in it is blended; an opaque draw
 * put here would never be drawn.
 */
export class EffectsLayer {
  readonly layer: Layer;
  private readonly app: AppBase;
  /** The eye: the one camera whose World pass gets the depth draw. */
  private readonly camera: CameraComponent;
  private readonly world: Layer;

  /**
   * @param app - The running app.
   * @param camera - Camera that draws the world; the layer is added to its list.
   */
  constructor(app: AppBase, camera: Entity) {
    this.app = app;
    this.camera = camera.camera!;
    const composition = app.scene.layers;
    this.world = composition.getLayerById(LAYERID_WORLD)!;

    this.layer = new Layer({ name: EFFECTS_LAYER_NAME });
    composition.insertTransparent(this.layer, composition.getTransparentIndex(this.world) + 1);
    // A camera draws only the layers it lists, and its default list predates this one.
    this.camera.layers = [...this.camera.layers, this.layer.id];

    app.scene.on(EVENT_POSTRENDER_LAYER, this.afterLayer, this);
  }

  /** Take the layer out of the composition and stop the depth draw. */
  destroy(): void {
    this.app.scene.off(EVENT_POSTRENDER_LAYER, this.afterLayer, this);
    this.camera.layers = this.camera.layers.filter((id) => id !== this.layer.id);
    this.app.scene.layers.remove(this.layer);
  }

  /** Right after the eye's World blended pass, lay the splats' depth down for the effects. */
  private afterLayer(camera: CameraComponent, layer: Layer, transparent: boolean): void {
    if (camera !== this.camera || layer !== this.world || !transparent) return;
    const splats = findSplatMeshInstance(this.app, camera.camera, layer);
    if (splats?.visible) this.drawDepthOnly(camera, splats);
  }

  /**
   * Draw the splats into the depth buffer alone.
   *
   * The material is the map's own, shared with the draw that just finished, so colour writes
   * go off and depth writes on for this one draw and come straight back. `blendType` is left
   * alone: changing it would flip the instance's `transparent` flag, and with it the pass the
   * engine files the map under.
   */
  private drawDepthOnly(camera: CameraComponent, splats: MeshInstance): void {
    const material = splats.material;
    if (!material) return;
    const { depthWrite, redWrite, greenWrite, blueWrite, alphaWrite } = material;
    material.depthWrite = true;
    material.redWrite = false;
    material.greenWrite = false;
    material.blueWrite = false;
    material.alphaWrite = false;
    try {
      const target = camera.renderTarget ?? this.app.graphicsDevice.backBuffer ?? undefined;
      // A null layer with an explicit instance list is how the engine draws a chosen set
      // itself (`RenderPassPrepass`); the typings only admit the per-layer form.
      this.app.renderer.renderForwardLayer(camera.camera, target, null!, true, SHADER_PREPASS, {
        meshInstances: [splats]
      });
    } finally {
      material.depthWrite = depthWrite;
      material.redWrite = redWrite;
      material.greenWrite = greenWrite;
      material.blueWrite = blueWrite;
      material.alphaWrite = alphaWrite;
    }
  }
}
