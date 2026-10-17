import {
  Entity,
  GAMMA_SRGB,
  Layer,
  SORTMODE_MANUAL,
  TONEMAP_LINEAR,
  Vec4,
  type AppBase,
  type CameraComponent,
  type Mat4
} from 'playcanvas';

import { UNITS_PER_METRE } from '../coords';
import type { AssetLibrary } from '../formats/asset-library';
import { ANIM } from '../sim/animations';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { sameLook, type PlayerLook } from '../view/player-model';
import { PREVIEW_YAW, previewFraming, previewTime } from '../view/player-preview';
import type { PreviewView } from './menu-screen';
import { PlayerRig } from './player-rig';
import type { TextureCache } from './texture-cache';

/**
 * The player's model beside a menu page, as `UI_DrawPlayer` draws it (`ui_players.c:714–858`):
 * idle, with the machinegun, turned three quarters toward the viewer, on q3_ui's clock.
 *
 * It is a scene of one model, as each of the HUD's 3D icons is: a camera of its own over a layer
 * of its own, with the page's box as its viewport. It clears depth there and not colour, after the
 * menu's camera, so the model stands over the page.
 *
 * A skin the model lacks falls back to the model's default skin. A model that can't be built draws
 * nothing (`UI_RegisterClientModelname`, `ui_players.c:1111–1175`).
 */

/** The preview's camera, after the eye's: the menu's is +4. */
export const PREVIEW_CAMERA_PRIORITY = 5;

/** `r_znear`, and the far plane of a scene with no world (`RDF_NOWORLDMODEL`), in metres. */
const NEAR_CLIP = 4 / UNITS_PER_METRE;
const FAR_CLIP = 2048 / UNITS_PER_METRE;

/** Scratch for the camera's viewport, which the engine copies. */
const viewport = new Vec4();

/** The player's model on the menu. */
export class PlayerPreview {
  private readonly app: AppBase;
  private readonly library: AssetLibrary;
  private readonly cache: TextureCache;
  private readonly layer: Layer;
  private readonly camera: Entity;
  private rig: PlayerRig | null = null;
  /** The look asked for: shown, being built, or failed. */
  private look: PlayerLook | null = null;
  /** Bumped by every new look and every drop, so a build that has been superseded is let go. */
  private generation = 0;
  private destroyed = false;

  /**
   * @param cache - Where the textures are counted, shared with every other body.
   * @param eye - The camera the world is seen through; the preview draws after it.
   */
  constructor(app: AppBase, library: AssetLibrary, cache: TextureCache, eye: Entity) {
    this.app = app;
    this.library = library;
    this.cache = cache;
    // Drawn in the order the draws were made, as Q3 draws a model's shaders in turn.
    this.layer = new Layer({
      name: 'menu-preview',
      opaqueSortMode: SORTMODE_MANUAL,
      transparentSortMode: SORTMODE_MANUAL
    });
    app.scene.layers.push(this.layer);

    this.camera = new Entity('menu-preview-camera');
    this.camera.addComponent('camera', {
      layers: [this.layer.id],
      // `RB_BeginDrawingView` clears depth alone for a scene with no world.
      clearColorBuffer: false,
      clearDepthBuffer: true,
      priority: eye.camera!.priority + PREVIEW_CAMERA_PRIORITY,
      nearClip: NEAR_CLIP,
      farClip: FAR_CLIP,
      // Encoded as the eye's is, so the model blends over the page as it shows.
      gammaCorrection: GAMMA_SRGB,
      toneMapping: TONEMAP_LINEAR
    });
    this.camera.enabled = false;
    app.root.addChild(this.camera);
    // `UI_DrawPlayer`'s view axis is cleared: along Quake's +X, which the rig's root turns to the world's.
    this.camera.lookAt(1, 0, 0);
  }

  /** The body shown, if any. */
  get current(): PlayerRig | null {
    return this.rig;
  }

  /**
   * Draw this frame's preview, or none, building a look the first time it is asked for. The last
   * body stays up until the next is built.
   *
   * @param realTime - The real time in milliseconds, which q3_ui's clock follows.
   */
  update(view: PreviewView | null, realTime: number): void {
    if (this.destroyed) return;
    if (!view) {
      this.camera.enabled = false;
      if (this.look) this.drop();
      return;
    }
    if (!this.look || !sameLook(this.look, view.look)) this.dress(view.look);
    const rig = this.rig;
    this.camera.enabled = rig !== null;
    if (!rig) return;

    const framing = previewFraming(view.width, view.height);
    const camera = this.camera.camera!;
    camera.rect = viewport.set(...view.rect);
    camera.fov = framing.fovY;
    this.offAxis(view, framing.fovY);
    const [x, y, z] = framing.origin;
    rig.update({
      origin: vec3(x, y, z),
      angles: vec3(0, PREVIEW_YAW, 0),
      legsAnim: ANIM.LEGS_IDLE,
      torsoAnim: ANIM.TORSO_STAND,
      movementDir: 0,
      velocity: vec3(),
      dead: false,
      weapon: WP.MACHINEGUN,
      firing: false,
      lastFireTime: Number.NEGATIVE_INFINITY,
      time: previewTime(realTime)
    });
  }

  /**
   * Where only part of the page's box is on the screen, frame the model by the whole box and draw
   * the part: the whole box's frustum, cut to the window its viewport shows. The box's aspect is
   * its size on the grid, which the viewport keeps.
   */
  private offAxis(view: PreviewView, fovY: number): void {
    const camera = this.camera.camera!;
    const window = view.window;
    if (!window) {
      // The engine's own projection again, which it takes up when the callback is null; its
      // declaration leaves the null out.
      camera.calculateProjection = null as unknown as CameraComponent['calculateProjection'];
      return;
    }
    const [left, bottom, right, top] = window;
    const halfHeight = NEAR_CLIP * Math.tan((fovY * Math.PI) / 360);
    const halfWidth = halfHeight * (view.width / view.height);
    const along = (from: number, half: number) => -half + 2 * half * from;
    camera.calculateProjection = (matrix: Mat4) =>
      matrix.setFrustum(
        along(left, halfWidth),
        along(right, halfWidth),
        along(bottom, halfHeight),
        along(top, halfHeight),
        NEAR_CLIP,
        FAR_CLIP
      );
  }

  /** Take the preview away, and give back what its body held. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.drop();
    this.camera.destroy();
    this.app.scene.layers.remove(this.layer);
  }

  /** Build a look, and put it on in place of the last once it is built; or put nothing on for one that fails. */
  private dress(look: PlayerLook): void {
    this.look = look;
    const generation = ++this.generation;
    const wear = async (rig: PlayerRig | null): Promise<void> => {
      if (generation !== this.generation) {
        await rig?.destroy();
        return;
      }
      const worn = this.rig;
      this.rig = rig;
      await worn?.destroy();
    };
    this.build(look).then(wear, (err: unknown) => {
      console.warn('Menu preview unavailable:', err);
      return wear(null);
    });
  }

  /**
   * A look's body, in its skin's default where its skin fails (`ui_players.c:1159–1165`), holding
   * the machinegun.
   *
   * @throws for a model the install lacks, or one that can't be built in either skin
   */
  private async build(look: PlayerLook): Promise<PlayerRig> {
    for (const model of new Set([look.body.model, look.head.model])) {
      if (!(await this.library.loadPlayerModel(model))) throw new Error(`${model}: not in the install`);
    }
    const options = { layers: [this.layer.id], blendedLayers: [this.layer.id], camera: this.camera };
    const create = ({ body, head }: PlayerLook) =>
      PlayerRig.create(this.app, this.library, this.cache, body.model, body.skin, options, head);
    const fallback: PlayerLook = {
      body: { ...look.body, skin: 'default' },
      head: { ...look.head, skin: 'default' }
    };
    const rig = await create(look).catch((err: unknown) => {
      if (sameLook(fallback, look)) throw err;
      return create(fallback);
    });
    await rig.selectWeapon(WP.MACHINEGUN);
    return rig;
  }

  /** Take the body away, and let a build in flight go. */
  private drop(): void {
    this.look = null;
    this.generation++;
    const rig = this.rig;
    this.rig = null;
    void rig?.destroy();
  }
}
