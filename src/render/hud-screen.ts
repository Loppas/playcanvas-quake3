import {
  BLEND_NORMAL,
  CULLFACE_NONE,
  Entity,
  GAMMA_SRGB,
  LAYERID_UI,
  PROJECTION_ORTHOGRAPHIC,
  StandardMaterial,
  TONEMAP_LINEAR,
  type AppBase,
  type Texture
} from 'playcanvas';

import type { AssetLibrary } from '../formats/asset-library';
import {
  DEFER_SHADER,
  LAGOMETER_SHADER,
  MEDAL_SHADERS,
  NET_SHADER,
  WEAPON_ASSETS,
  playerModelDir
} from '../formats/asset-manifest';
import { findShader, type ShaderStage } from '../formats/shader-script';
import { ITEMS } from '../sim/items';
import {
  createHudState,
  hudFrame,
  type HudFrame,
  type HudInput,
  type HudSettings,
  type HudState
} from '../view/hud';
import {
  CHARSET_SHADER,
  NO_AMMO_SHADER,
  NUMBER_SHADERS,
  SELECT_SHADER,
  WHITE_SHADER,
  drawHud,
  drawNotify,
  type PicShader,
  type PicWriter
} from '../view/hud-draw';
import { anchorOrigin, hudScale, type HudAnchor } from '../view/hud-layout';
import type { Rgba } from '../view/hud-status';
import type { NotifyRow } from '../view/notify-lines';
import { stageGain } from '../view/overbright';
import { createTexture, loadTexture, type GammaVertexColorMaterial } from './md3-mesh';
import { QuadBatch } from './quad-batch';
import type { ResourceScope, TextureCache } from './texture-cache';
import type { Warmed } from './warm-up';

/**
 * The HUD's 2D half: what `CG_Draw2D` draws, as quads.
 *
 * `src/view/hud.ts` decides what draws, and `src/view/hud-draw.ts` writes it as Q3's pictures, in
 * Q3's order, on Q3's 640×480 grid. Here each picture is kept to its group's edge, scaled by the
 * height (`hud-layout.ts`), and written into one buffer, and each run of them in one shader is one
 * draw (`QuadBatch`), as Q3's backend merges them.
 *
 * Each shader draws with a material of its own, made as the HUD loads: its stage's image at the
 * stage's brightness on screen, times the colour the list gives the picture. The colour is decoded
 * as the image is, so the two multiply on screen as Q3's do, and the picture blends in display
 * space, as Q3's 2D does.
 *
 * The quads draw in `LAYERID_UI`, from a camera of their own after the view weapon's, so the HUD
 * lies over everything, as Q3's 2D does.
 *
 * The console's notify lines draw here too, last and over the rest, though they are the client's
 * and not cgame's: this is the one 2D screen the port has.
 */

/** The HUD's camera, after the eye's: the view weapon's is +1 and the 3D icons' +2. */
export const HUD_CAMERA_PRIORITY = 3;

/** The image Q3 builds for itself (`tr_image.c:1232–1234`), which the `white` shader maps. */
const WHITE_IMAGE = '*white';

/** `redFlagShader` and `blueFlagShader`, the six a flag's status is drawn with (`cg_main.c:898–903`). */
const FLAG_SHADERS = [
  'icons/iconf_red1',
  'icons/iconf_red2',
  'icons/iconf_red3',
  'icons/iconf_blu1',
  'icons/iconf_blu2',
  'icons/iconf_blu3'
];

/** Every shader the HUD's list can name but the player's icon, each loaded with the HUD. */
const HUD_SHADERS: readonly string[] = [
  ...new Set([
    WHITE_SHADER,
    CHARSET_SHADER,
    SELECT_SHADER,
    NO_AMMO_SHADER,
    ...NUMBER_SHADERS,
    ...[...'abcdefghij'].map((letter) => `gfx/2d/crosshair${letter}`),
    ...WEAPON_ASSETS.map((asset) => asset.icon),
    // `CG_RegisterItemVisuals` registers an item's icon the first time it is drawn; the port loads
    // them with the rest of the HUD's art.
    ...ITEMS.slice(1).map((item) => item.icon),
    ...FLAG_SHADERS,
    ...Object.values(MEDAL_SHADERS),
    LAGOMETER_SHADER,
    // `CG_DrawDisconnect` registers it as it draws; the port loads it with the rest.
    NET_SHADER,
    DEFER_SHADER
  ])
];

const ANCHORS: readonly HudAnchor[] = ['left', 'centre', 'right'];

const WHITE: Rgba = [1, 1, 1, 1];

/** A HUD shader's first stage with an image, as `RE_RegisterShader` finds it. */
interface PicStage extends PicShader {
  texture: Texture;
  /** Its brightness on screen. */
  gain: number;
}

/** One of the HUD's shaders, and the material its pictures draw with. */
interface HudPic extends PicStage {
  material: StandardMaterial;
}

/**
 * Q3's shader for an image with no script, in 2D (`tr_shader.c:2622–2630`): alpha-blended, and
 * coloured and faded by the vertex.
 */
function implicitStage(image: string): ShaderStage {
  return {
    maps: [image],
    animFps: 0,
    blend: 'blend',
    depthWrite: false,
    clamp: false,
    texMods: [],
    rgbGen: 'vertex',
    alphaGen: 'vertex'
  };
}

/** Load a HUD shader's stage, or `null` for one with no image, which draws nothing. */
async function loadStage(
  app: AppBase,
  library: AssetLibrary,
  name: string,
  scope: ResourceScope,
  white: Texture
): Promise<PicStage | null> {
  const shader = findShader(library.shaders, name);
  const stage =
    shader?.stages.find((candidate) => candidate.maps.some((map) => !map.startsWith('$'))) ??
    implicitStage(name);
  const map = stage.maps.find((candidate) => !candidate.startsWith('$'));
  let texture: Texture | null = null;
  if (map === WHITE_IMAGE) {
    texture = white;
  } else {
    const path = map ? library.resolveImage(map) : undefined;
    const bytes = path ? library.read(path) : undefined;
    if (path && bytes) {
      texture = await loadTexture(app, path, bytes, stage.clamp, !shader?.noMipMaps, scope);
    }
  }
  if (!texture) return null;
  return {
    texture,
    gain: stageGain(stage, 0),
    tinted: stage.rgbGen === 'vertex' || stage.rgbGen === 'exactVertex',
    faded: stage.alphaGen === 'vertex'
  };
}

/** Give a HUD material a stage's image and brightness. */
function paint(material: StandardMaterial, stage: PicStage): void {
  material.emissive.set(stage.gain, stage.gain, stage.gain);
  material.emissiveMap = stage.texture;
  material.opacityMap = stage.texture;
  material.update();
}

/**
 * A HUD shader's material: its image, times the vertex colour decoded as the image is, blended over
 * the screen with no depth test and both faces drawn, as `RB_SetGL2D` sets Q3's 2D
 * (`tr_backend.c:698–720`).
 */
function picMaterial(stage: PicStage): StandardMaterial {
  const material = new StandardMaterial();
  material.useLighting = false;
  material.useTonemap = false;
  material.useFog = false;
  material.useSkybox = false;
  material.diffuse.set(0, 0, 0);
  material.emissiveVertexColor = true;
  material.opacityVertexColor = true;
  (material as GammaVertexColorMaterial).vertexColorGamma = true;
  material.opacityMapChannel = 'a';
  material.blendType = BLEND_NORMAL;
  material.depthTest = false;
  material.depthWrite = false;
  material.cull = CULLFACE_NONE;
  paint(material, stage);
  return material;
}

/** The HUD's quads, and the camera that draws them. */
export class HudScreen {
  private readonly app: AppBase;
  private readonly library: AssetLibrary;
  private readonly cache: TextureCache;
  private readonly eye: Entity;
  private readonly camera: Entity;
  /** The space the quads are written in: the canvas's pixels, down from its top left. */
  private readonly node: Entity;
  private readonly batch: QuadBatch;
  private readonly settings: HudSettings;
  private readonly state: HudState;
  private readonly scope: ResourceScope;
  /** `*white`, which no pak holds. */
  private readonly white: Texture;
  /** Every shader the list can name that has an image. */
  private readonly pics: Map<string, HudPic>;
  /**
   * The player's model icon, for the head in 2D (`cg_draw3dIcons 0`): one material for good, given
   * each icon's image in turn, and what holds the image.
   */
  private readonly head: HudPic;
  private headScope: ResourceScope | null = null;
  /** The HUD's art as the list asks after it. */
  private readonly art: { shader(name: string): PicShader | undefined; playerIcon: string | null } = {
    shader: (name) => this.pic(name),
    playerIcon: null
  };
  /** The list's pictures, from Q3's grid into the canvas's pixels and into the batch. */
  private readonly writer: PicWriter = {
    stretchPic: (shader, x, y, w, h, anchor, s1, t1, s2, t2, color) => {
      const pic = this.pic(shader);
      if (!pic) return;
      const { scale } = this;
      const across = this.origins[anchor] + x * scale;
      this.batch.stretchPic(pic.material, across, y * scale, w * scale, h * scale, s1, t1, s2, t2, color);
    }
  };
  /** The canvas the camera is fitted to, its pixels to a unit of the grid, and each anchor's origin. */
  private width = 0;
  private height = 0;
  private scale = 1;
  private readonly origins: Record<HudAnchor, number> = { left: 0, centre: 0, right: 0 };
  private destroyed = false;

  private constructor(
    app: AppBase,
    library: AssetLibrary,
    cache: TextureCache,
    eye: Entity,
    settings: HudSettings,
    state: HudState,
    scope: ResourceScope,
    white: Texture,
    pics: Map<string, HudPic>
  ) {
    this.app = app;
    this.library = library;
    this.cache = cache;
    this.eye = eye;
    this.settings = settings;
    this.state = state;
    this.scope = scope;
    this.white = white;
    this.pics = pics;
    this.head = { ...this.blank(), material: picMaterial(this.blank()) };

    const eyeCamera = eye.camera!;
    this.camera = new Entity('hud-camera');
    this.camera.addComponent('camera', {
      layers: [LAYERID_UI],
      clearColorBuffer: false,
      clearDepthBuffer: false,
      priority: eyeCamera.priority + HUD_CAMERA_PRIORITY,
      // `RB_SetGL2D`'s projection, fitted to the canvas each frame (`tr_backend.c:706`).
      projection: PROJECTION_ORTHOGRAPHIC,
      // Encoded as the eye's is, so the HUD blends in display space too.
      gammaCorrection: GAMMA_SRGB,
      toneMapping: TONEMAP_LINEAR
    });
    app.root.addChild(this.camera);
    // The eye draws no HUD of its own, or the view weapon would cover it.
    eyeCamera.layers = eyeCamera.layers.filter((id) => id !== LAYERID_UI);

    this.node = new Entity('hud');
    // y down the canvas, as Q3's 2D has it.
    this.node.setLocalScale(1, -1, 1);
    app.root.addChild(this.node);
    this.batch = new QuadBatch(app.graphicsDevice, this.node, [
      app.scene.layers.getLayerById(LAYERID_UI)!
    ]);
  }

  /**
   * Load the HUD's art and put up its camera, as `CG_RegisterGraphics` registers it.
   *
   * @param eye - The camera the world is seen through; the HUD draws after it.
   * @param cache - Where the textures are counted.
   * @param random - `random()`, for the head's look-around.
   */
  static async create(
    app: AppBase,
    library: AssetLibrary,
    eye: Entity,
    cache: TextureCache,
    settings: HudSettings,
    random: () => number = Math.random
  ): Promise<HudScreen> {
    const scope = cache.scope();
    const white = createTexture(
      app.graphicsDevice,
      WHITE_IMAGE,
      { width: 1, height: 1, pixels: new Uint8ClampedArray([255, 255, 255, 255]) },
      false,
      false
    );
    const stages = await Promise.all(
      HUD_SHADERS.map(async (name) => [name, await loadStage(app, library, name, scope, white)] as const)
    );
    const pics = new Map<string, HudPic>();
    for (const [name, stage] of stages) {
      if (stage) pics.set(name, { ...stage, material: picMaterial(stage) });
    }
    const state = createHudState(random);
    return new HudScreen(app, library, cache, eye, settings, state, scope, white, pics);
  }

  /**
   * Show a model's icon for the head in 2D (`cg_draw3dIcons 0`): `icon_<skin>`
   * (`cg_players.c:602–607`). The last icon's texture is given back.
   */
  async setPlayerIcon(model: string, skin = 'default'): Promise<void> {
    const name = `${playerModelDir(model)}icon_${skin}`;
    const scope = this.cache.scope();
    const stage = await loadStage(this.app, this.library, name, scope, this.white);
    if (this.destroyed) {
      scope.dispose();
      return;
    }
    // The material lets go of the last texture before it goes.
    Object.assign(this.head, stage ?? this.blank());
    paint(this.head.material, this.head);
    this.art.playerIcon = stage ? name : null;
    this.headScope?.dispose();
    this.headScope = scope;
  }

  /**
   * One of the HUD's pictures by its shader's name, for the menu to draw: a crosshair, as Game
   * options shows it (`Crosshair_Draw`, `ui_preferences.c:173–214`). `null` for one it lacks.
   */
  image(name: string): Texture | null {
    return this.pics.get(name)?.texture ?? null;
  }

  /**
   * Draw this frame's HUD, then `Con_DrawNotify`'s lines over it: the client's own, after cgame's
   * 2D and whatever `cg_draw2D` says.
   *
   * @param notify - The notify lines, in the canvas's own pixels.
   * @returns the frame drawn, whose status bar the 3D icons follow
   */
  update(input: HudInput, notify: readonly NotifyRow[]): HudFrame {
    const frame = hudFrame(this.state, input, this.settings);
    this.fit();
    this.batch.begin();
    drawHud(frame, this.state.speeds, this.scale, this.art, this.writer);
    drawNotify(notify, this.scale, this.art, this.writer);
    this.batch.end();
    return frame;
  }

  /**
   * A picture in each of the HUD's materials, the head's among them, drawn through its camera for
   * the warm-up (`warm-up.ts`), whether the HUD is up or not.
   */
  warm(): Warmed {
    const shown = this.shown;
    return {
      at: () => {
        this.shown = true;
        this.fit();
        this.batch.begin();
        for (const pic of [...this.pics.values(), this.head]) {
          this.batch.stretchPic(pic.material, 0, 0, 1, 1, 0, 0, 1, 1, WHITE);
        }
        this.batch.end();
      },
      end: () => {
        this.batch.begin();
        this.batch.end();
        this.shown = shown;
      }
    };
  }

  /**
   * Whether the HUD is on the screen, the notify lines with it: not while no match runs, as no
   * cgame is there to draw it.
   */
  get shown(): boolean {
    return this.camera.enabled;
  }

  set shown(shown: boolean) {
    this.camera.enabled = shown;
  }

  /**
   * Forget what the last match's frames left, as the match goes: the head's look-around, the
   * speed graph, the countdown. A fresh cgame's `cg` starts with none of them.
   */
  clear(): void {
    Object.assign(this.state, createHudState(this.state.random));
  }

  /** Take the HUD off the screen and give back its textures. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.batch.destroy();
    this.node.destroy();
    this.camera.destroy();
    const eyeCamera = this.eye.camera;
    if (eyeCamera && !eyeCamera.layers.includes(LAYERID_UI)) {
      eyeCamera.layers = [...eyeCamera.layers, LAYERID_UI];
    }
    for (const pic of this.pics.values()) pic.material.destroy();
    this.head.material.destroy();
    this.white.destroy();
    this.scope.dispose();
    this.headScope?.dispose();
  }

  /** A shader the list names, the player's icon among them, or `undefined` for one with no image. */
  private pic(name: string): HudPic | undefined {
    return name === this.art.playerIcon ? this.head : this.pics.get(name);
  }

  /** The head's stage while it has no icon: white, so it holds no texture of a scope's. */
  private blank(): PicStage {
    return { texture: this.white, gain: 1, tinted: true, faded: true };
  }

  /**
   * Fit the camera and the quads' space to the canvas, as `RB_SetGL2D` sets Q3's 2D to the video
   * mode: an orthographic view of its pixels, a unit in front of the camera.
   */
  private fit(): void {
    const { width, height } = this.app.graphicsDevice;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.camera.camera!.orthoHeight = height / 2;
    this.node.setLocalPosition(-width / 2, height / 2, -1);
    this.scale = hudScale(height);
    for (const anchor of ANCHORS) this.origins[anchor] = anchorOrigin(anchor, width, height);
  }
}
