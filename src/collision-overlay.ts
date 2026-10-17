import {
  BLEND_NORMAL,
  Color,
  CULLFACE_NONE,
  StandardMaterial,
  type AppBase,
  type ContainerResource,
  type Entity,
  type RenderComponent
} from 'playcanvas';

import { splatMapFiles } from './formats/splat-map';
import { loadFromBytes } from './game-map';
import type { PakFileSystem } from './pak/vfs';

/**
 * A translucent render of a map's `maps/<n>.collision.glb` laid over the splats, so the baked
 * collider can be checked against what the player sees (the mesh is a debug
 * overlay only; the trace runs on the voxel octree, never this).
 */
export interface CollisionOverlay {
  readonly entity: Entity;
  visible: boolean;
  /** @param value - Show (true) or hide (false) the overlay. */
  setVisible(value: boolean): void;
  /** @returns The new visibility. */
  toggle(): boolean;
  /**
   * Take the overlay out of the scene and free it: the entity and its mesh instances, then the
   * material they drew with, then the mesh's container, in the order the engine needs
   * (`Material.destroy` hands a live instance the default material).
   */
  destroy(): void;
}

/**
 * Load the map's collision mesh through the search path and add it to the scene, aligned to the
 * polished map. It is optional (`map-format.md` §2.2), so a map without one says so and loads.
 *
 * splat-transform bakes the mesh in its internal `ST_FRAME = diag(-1, -1, 1)`. That matrix has
 * determinant +1 — it is a 180-degree rotation about Z, not a reflection — so rotating the
 * overlay 180 degrees about Z returns it to the polished map's world frame and it registers
 * with the splats.
 *
 * @param app - The running app.
 * @param fs - The search path.
 * @param name - The map's name.
 * @param startVisible - Whether the overlay is shown once loaded.
 */
export async function loadCollisionOverlay(
  app: AppBase,
  fs: Pick<PakFileSystem, 'read'>,
  name: string,
  startVisible: boolean
): Promise<CollisionOverlay> {
  const path = splatMapFiles(name).collisionMesh;
  const bytes = await fs.read(path);
  if (!bytes) throw new Error(`${path} not found`);
  const asset = await loadFromBytes(app, path, 'container', bytes);
  const resource = asset.resource as ContainerResource;
  const entity = resource.instantiateRenderEntity();

  // Undo splat-transform's ST_FRAME (see above).
  entity.setLocalEulerAngles(0, 0, 180);

  const material = new StandardMaterial();
  material.useLighting = false; // flat, so the collider reads as a wash of one colour
  material.emissive = new Color(0.1, 1.0, 0.4);
  material.diffuse = new Color(0, 0, 0);
  material.opacity = 0.35;
  material.blendType = BLEND_NORMAL;
  material.depthWrite = false; // let the splats show through the haze
  material.cull = CULLFACE_NONE; // the collider shell is one-sided; show both faces
  material.update();

  for (const render of entity.findComponents('render') as RenderComponent[]) {
    for (const meshInstance of render.meshInstances) {
      meshInstance.material = material;
    }
  }

  app.root.addChild(entity);

  const overlay: CollisionOverlay = {
    entity,
    visible: startVisible,
    setVisible(value: boolean) {
      this.visible = value;
      entity.enabled = value;
    },
    toggle() {
      this.setVisible(!this.visible);
      return this.visible;
    },
    destroy() {
      entity.destroy();
      material.destroy();
      // `remove` alone frees nothing, and `unload` is what frees the container's own assets. The
      // engine's container resource does the two in this order (`glb-container-resource.js`).
      app.assets.remove(asset);
      asset.unload();
    }
  };
  overlay.setVisible(startVisible);
  return overlay;
}
