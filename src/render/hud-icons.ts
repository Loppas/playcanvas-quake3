import {
  Entity,
  GAMMA_SRGB,
  Layer,
  SORTMODE_MANUAL,
  TONEMAP_LINEAR,
  Vec4,
  type AppBase
} from 'playcanvas';

import { UNITS_PER_METRE } from '../coords';
import type { AssetLibrary } from '../formats/asset-library';
import { AMMO_MODELS, playerModelDir } from '../formats/asset-manifest';
import type { Md3Surface } from '../formats/md3';
import { parseSkin } from '../formats/skin';
import { ARMOR_TIER, findItemForArmorTier } from '../sim/items';
import type { WeaponId } from '../sim/weapons/constants';
import { anglesToAxis } from '../view/hand-pose';
import { AMMO_ANCHOR, BAR_ANCHOR, type IconModel, type StatusBar } from '../view/hud';
import { headFraming } from '../view/hud-head';
import { screenRect, type HudAnchor, type HudRect } from '../view/hud-layout';
import { AMMO_X, ARMOR_X, iconRect } from '../view/hud-status';
import type { Rgb } from '../view/player-color';
import type { Placement } from '../view/player-pose';
import { applyQuakeTransform } from './md3-mesh';
import type { SkinStage } from './skin-material';
import {
  buildStagedModel,
  drawStagedModel,
  playStagedStages,
  tintStagedModel,
  type StagedModel
} from './staged-model';
import type { ResourceScope, TextureCache } from './texture-cache';
import { showHidden, type Warmed } from './warm-up';

/**
 * The HUD's 3D icons: the held weapon's ammo box and the armor, spinning beside
 * their numbers, and the player's head, looking around. The armour is the one its tier's item
 * is drawn as, which for the yellow is Q3's own `armorModel`. Each is drawn as `CG_Draw3DModel` draws it
 * (`cg_draw.c:267–303`): a scene of one model, seen through a 30° view looking along +X, over the
 * icon's box on screen.
 *
 * Each view is a camera of its own over a layer of its own, with the box as its viewport. It
 * clears depth there and not colour, so the model lands straight on the world, its additive stages
 * and all, as Q3's does. The cameras come after the view weapon's and before the 2D HUD's, as Q3
 * draws the 3D icons before the numbers beside them.
 *
 * Every stage of a model's shaders draws, lit by the entity light as a body is, and played
 * on the game clock, which is the view's `refdef.time`. A stage that shines or mirrors does so by
 * where the icon's camera is.
 */

/** The icons' cameras, after the eye's: the view weapon's is +1 and the 2D HUD's +3. */
export const ICON_CAMERA_PRIORITY = 2;

/** `CG_Draw3DModel`'s `fov_x` and `fov_y`: the views are square, so the vertical serves. */
const ICON_FOV = 30;

/**
 * `r_znear`, and the far plane `R_SetFarClip` gives a scene with no world (`RDF_NOWORLDMODEL`),
 * in metres.
 */
const ICON_NEAR_CLIP = 4 / UNITS_PER_METRE;
const ICON_FAR_CLIP = 2048 / UNITS_PER_METRE;

/** A model an icon can show, and its stages that change over time. */
interface IconSubject {
  staged: StagedModel;
  animated: SkinStage[];
  /** Multiplies its every stage, for a model drawn in another's colours. */
  tint?: Rgb;
}

/** Scratch for a camera's viewport, which the engine copies. */
const viewport = new Vec4();

/** One icon's view: its layer, the camera drawing it, and the models it can show. */
class IconView {
  readonly layer: Layer;
  private readonly app: AppBase;
  private readonly camera: Entity;
  /** Quake units, Z-up: `CG_Draw3DModel`'s scene, which the camera looks along +X of. */
  private readonly root: Entity;
  private shown: IconSubject | null = null;

  constructor(app: AppBase, name: string, priority: number) {
    this.app = app;
    // Drawn in the order the draws were made, surface by surface and stage by stage, as Q3
    // draws a model's shaders in turn.
    this.layer = new Layer({
      name,
      opaqueSortMode: SORTMODE_MANUAL,
      transparentSortMode: SORTMODE_MANUAL
    });
    app.scene.layers.push(this.layer);

    this.camera = new Entity(`${name}-camera`);
    this.camera.addComponent('camera', {
      layers: [this.layer.id],
      // `RB_BeginDrawingView` clears depth alone for a scene with no world.
      clearColorBuffer: false,
      clearDepthBuffer: true,
      priority,
      fov: ICON_FOV,
      nearClip: ICON_NEAR_CLIP,
      farClip: ICON_FAR_CLIP,
      // Encoded as the eye's is, so the models blend over the world as it shows.
      gammaCorrection: GAMMA_SRGB,
      toneMapping: TONEMAP_LINEAR
    });
    this.camera.enabled = false;
    app.root.addChild(this.camera);
    // `AxisClear( refdef.viewaxis )`: along Quake's +X, which the root turns to the world's.
    this.camera.lookAt(1, 0, 0);

    this.root = new Entity(`${name}-models`);
    applyQuakeTransform(this.root);
    app.root.addChild(this.root);
  }

  /** Hang a model in the view, hidden until it is drawn. */
  add(subject: IconSubject): void {
    subject.staged.entity.enabled = false;
    this.root.addChild(subject.staged.entity);
  }

  /** Take a model out of the view and destroy it, its meshes with it. */
  remove(subject: IconSubject): void {
    if (this.shown === subject) this.shown = null;
    subject.staged.entity.destroy();
  }

  /**
   * Draw a model placed as `icon` says, over `rect` in pixels, y down from the top; or draw
   * nothing, for no model.
   *
   * @param seconds - The clock its stages play on.
   */
  draw(subject: IconSubject | null, icon: IconModel | null, rect: HudRect, seconds: number): void {
    if (this.shown !== subject) {
      if (this.shown) this.shown.staged.entity.enabled = false;
      this.shown = subject;
    }
    const { width, height } = this.app.graphicsDevice;
    // A canvas with no area has no box to draw in, and a rect over it is NaN, which WebGPU
    // refuses at every frame's viewport.
    if (!subject || !icon || !(width > 0 && height > 0)) {
      this.camera.enabled = false;
      return;
    }
    subject.staged.entity.enabled = true;
    this.camera.enabled = true;
    // The camera's viewport is a fraction of the screen, y up from the bottom. A box on the
    // bottom edge, as the head's is while it flinches, can sum a hair past the height, which the
    // engine floors to a pixel below the canvas: a scissor WebGPU refuses, losing the frame.
    this.camera.camera!.rect = viewport.set(
      rect.x / width,
      Math.max(0, 1 - (rect.y + rect.h) / height),
      rect.w / width,
      rect.h / height
    );
    const [pitch, yaw, roll] = icon.angles;
    const [x, y, z] = icon.origin;
    const place: Placement = { origin: [x, y, z], axis: anglesToAxis(pitch, yaw, roll) };
    // `CG_Draw3DModel`'s entity is cleared, so it shows frame 0.
    drawStagedModel(
      subject.staged,
      { ...place, frame: 0, oldFrame: 0, backlerp: 0 },
      seconds,
      this.camera
    );
    playStagedStages(subject.animated, seconds, undefined, subject.tint);
  }

  /**
   * Show every model in the view, through its camera over the middle of the screen, until the
   * function returned puts the models and the camera back. A box short of the whole screen, as the
   * view's always is: the engine clears part of a target with a draw of its own, which a clear of
   * the whole does without.
   */
  showAll(): () => void {
    const camera = this.camera.camera!;
    const enabled = this.camera.enabled;
    const rect = camera.rect.clone();
    const shown = showHidden(this.root);
    camera.rect = viewport.set(0.25, 0.25, 0.5, 0.5);
    this.camera.enabled = true;
    return () => {
      shown();
      camera.rect = rect;
      this.camera.enabled = enabled;
    };
  }

  destroy(): void {
    this.shown = null;
    this.root.destroy();
    this.camera.destroy();
    this.app.scene.layers.remove(this.layer);
  }
}

/** The ammo box, the head and the armor, as the status bar draws them in 3D. */
export class HudIcons {
  private readonly app: AppBase;
  private readonly library: AssetLibrary;
  private readonly cache: TextureCache;
  /** What the ammo boxes and the armor hold. */
  private readonly scope: ResourceScope;
  // The views, in the order `CG_DrawStatusBar` draws them.
  private readonly ammoView: IconView;
  private readonly headView: IconView;
  private readonly armorView: IconView;
  private readonly ammoModels: Map<WeaponId, IconSubject>;
  /** By tier. */
  private readonly armorModels: (IconSubject | null)[];
  /** The player's head, what holds its textures, and where it stands in its view. */
  private player: {
    subject: IconSubject;
    scope: ResourceScope;
    origin: readonly [number, number, number];
  } | null = null;
  /** Counts {@link setPlayerModel}'s calls, so the last asked for wins. */
  private headRequests = 0;
  private destroyed = false;

  private constructor(
    app: AppBase,
    library: AssetLibrary,
    cache: TextureCache,
    scope: ResourceScope,
    views: { ammo: IconView; head: IconView; armor: IconView },
    ammoModels: Map<WeaponId, IconSubject>,
    armorModels: (IconSubject | null)[]
  ) {
    this.app = app;
    this.library = library;
    this.cache = cache;
    this.scope = scope;
    this.ammoView = views.ammo;
    this.headView = views.head;
    this.armorView = views.armor;
    this.ammoModels = ammoModels;
    this.armorModels = armorModels;
  }

  /**
   * Put up the views and build the ammo boxes and the armor, as `CG_RegisterGraphics` and
   * `CG_RegisterItemVisuals` register them. A model the install lacks is left out, and its icon
   * draws nothing. The head waits for {@link setPlayerModel}.
   *
   * @param eye - The camera the world is seen through; the icons draw after it.
   * @param cache - Where the textures are counted.
   */
  static async create(
    app: AppBase,
    library: AssetLibrary,
    eye: Entity,
    cache: TextureCache
  ): Promise<HudIcons> {
    const priority = eye.camera!.priority + ICON_CAMERA_PRIORITY;
    const views = {
      ammo: new IconView(app, 'hud-ammo', priority),
      head: new IconView(app, 'hud-head', priority),
      armor: new IconView(app, 'hud-armor', priority)
    };
    const scope = cache.scope();
    try {
      // An item has no skin: each surface draws the shader it names.
      const build = async (
        view: IconView,
        path: string,
        name = path,
        tint?: Rgb
      ): Promise<IconSubject | null> => {
        if (!library.read(path)) return null;
        const animated: SkinStage[] = [];
        const staged = await buildStagedModel(
          app,
          library,
          scope,
          name,
          library.model(path),
          (surface) => surface.shaders[0] ?? '',
          { layers: [view.layer.id] },
          animated
        );
        if (tint) tintStagedModel(staged, tint);
        const subject = { staged, animated, tint };
        view.add(subject);
        return subject;
      };
      const ammoModels = new Map<WeaponId, IconSubject>();
      for (const [weapon, path] of AMMO_MODELS) {
        const subject = await build(views.ammo, path);
        if (subject) ammoModels.set(weapon, subject);
      }
      const armorModels: (IconSubject | null)[] = [];
      for (const tier of Object.values(ARMOR_TIER)) {
        const item = findItemForArmorTier(tier)!;
        const path = item.worldModel[0]!;
        armorModels[tier] = await build(views.armor, path, item.classname, item.tint);
      }
      return new HudIcons(app, library, cache, scope, views, ammoModels, armorModels);
    } catch (error) {
      for (const view of Object.values(views)) view.destroy();
      scope.dispose();
      throw error;
    }
  }

  /**
   * Show a model's head, with one of its skins: `head.md3` and `head_<skin>.skin`, as the body
   * draws them, which must be in the library. It stands where `CG_DrawHead` puts it, from its
   * frame-0 bounds and the model's `headoffset` (`cg_draw.c:327–339`). The last head is given
   * back.
   *
   * @param headOffset - `animation.cfg`'s `headoffset`.
   * @returns once the head is built, or superseded
   * @throws for a model with no head or no such skin, which leaves the last head up
   */
  async setPlayerModel(
    model: string,
    skin = 'default',
    headOffset: readonly number[] = [0, 0, 0]
  ): Promise<void> {
    const request = ++this.headRequests;
    const dir = playerModelDir(model);
    const skinPath = `${dir}head_${skin}.skin`;
    const skinBytes = this.library.read(skinPath);
    if (!skinBytes) throw new Error(`${model}/${skin}: no ${skinPath}`);
    const pairs = parseSkin(new TextDecoder().decode(skinBytes));
    const head = this.library.model(`${dir}head.md3`);
    // Surface names are lowercased on both sides (`tr_mesh.c:362–368`).
    const shaderOf = (surface: Md3Surface) =>
      pairs.find((pair) => pair.surface === surface.name)?.shader ?? '';

    const scope = this.cache.scope();
    const animated: SkinStage[] = [];
    let staged: StagedModel;
    try {
      staged = await buildStagedModel(
        this.app,
        this.library,
        scope,
        'head',
        head,
        shaderOf,
        { layers: [this.headView.layer.id] },
        animated
      );
    } catch (error) {
      scope.dispose();
      throw error;
    }
    if (this.destroyed || request !== this.headRequests) {
      staged.entity.destroy();
      scope.dispose();
      return;
    }

    const previous = this.player;
    const [first] = head.frames;
    const subject = { staged, animated };
    this.headView.add(subject);
    this.player = { subject, scope, origin: headFraming(first.mins, first.maxs, headOffset) };
    if (previous) {
      // Its meshes go with its entity; then nothing draws with its materials.
      this.headView.remove(previous.subject);
      previous.scope.dispose();
    }
  }

  /**
   * Draw this frame's icons from the status bar the 2D HUD drew, or none, for none.
   *
   * @param time - Game time in milliseconds, which `cg.time` counts whole.
   */
  update(bar: StatusBar | null, time: number): void {
    if (this.destroyed) return;
    const { width, height } = this.app.graphicsDevice;
    const seconds = Math.floor(time) / 1000;
    const onScreen = (rect: HudRect, anchor: HudAnchor) =>
      screenRect(rect, anchor, width, height);

    const ammo = bar?.ammoModel ?? null;
    this.ammoView.draw(
      ammo ? (this.ammoModels.get(ammo.weapon) ?? null) : null,
      ammo,
      onScreen(iconRect(AMMO_X), AMMO_ANCHOR),
      seconds
    );

    // `CG_DrawHead` draws nothing for a model with no head.
    const head = bar?.head;
    const player = head?.model ? this.player : null;
    this.headView.draw(
      player?.subject ?? null,
      head && player ? { origin: player.origin, angles: [head.pitch, head.yaw, 0] } : null,
      onScreen(
        { x: head?.x ?? 0, y: head?.y ?? 0, w: head?.size ?? 0, h: head?.size ?? 0 },
        BAR_ANCHOR
      ),
      seconds
    );

    const armor = bar?.armorModel ?? null;
    this.armorView.draw(
      armor ? (this.armorModels[bar!.armorTier] ?? null) : null,
      armor,
      onScreen(iconRect(ARMOR_X), BAR_ANCHOR),
      seconds
    );
  }

  /**
   * Every model the icons can show, for the warm-up (`warm-up.ts`): the ammo boxes, the armor and
   * the head, each through its view's own camera, played on the game clock.
   */
  warm(): Warmed {
    const subjects = [
      ...this.ammoModels.values(),
      ...this.armorModels.filter((subject): subject is IconSubject => subject !== null),
      ...(this.player ? [this.player.subject] : [])
    ];
    let hide: (() => void) | null = null;
    return {
      at: (seconds) => {
        if (this.destroyed) return;
        if (!hide) {
          const views = [this.ammoView, this.headView, this.armorView];
          const shown = views.map((view) => view.showAll());
          hide = () => {
            for (const put of shown) put();
          };
        }
        for (const { animated, tint } of subjects) {
          playStagedStages(animated, seconds, undefined, tint);
        }
      },
      end: () => {
        hide?.();
        hide = null;
      }
    };
  }

  /** Take the views away and give back every model's textures and materials. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // The models go with their views; then nothing draws with the materials.
    this.ammoView.destroy();
    this.headView.destroy();
    this.armorView.destroy();
    this.scope.dispose();
    this.player?.scope.dispose();
    this.player = null;
  }
}
