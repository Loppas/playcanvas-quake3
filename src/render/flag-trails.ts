import { Entity, type AppBase, type GraphNode } from 'playcanvas';

import type { AssetLibrary } from '../formats/asset-library';
import { GT } from '../sim/constants';
import { ITEMS, IT, PW } from '../sim/items';
import {
  NO_WORLD,
  keptEntityLight,
  lightInEntityFrame,
  type LightingScene
} from '../view/entity-light';
import type { FlagTrails as TrailPlaces, TrailPlace } from '../view/flag-trail';
import { applyQuakeTransform } from './md3-mesh';
import type { SceneDraws } from './scene-draws';
import type { SkinStage } from './skin-material';
import {
  FIRST_FRAME,
  buildStagedModel,
  drawPlacedModel,
  lightAtEntity,
  ownShader,
  place,
  playStagedStages,
  type StagedModel
} from './staged-model';
import type { ResourceScope, TextureCache } from './texture-cache';
import { showHidden, type Warmed } from './warm-up';

/**
 * The flags carried on players' backs: `CG_TrailItem`'s model, which `CG_PlayerPowerups` adds for
 * whoever holds each flag (`cg_players.c:1627–1645`, `:1862–1881`), and the port's only way of
 * drawing one.
 *
 * The model is the flag item's own world model — `models/flags/r_flag.md3` and `b_flag.md3`, the
 * same two the flags on their stands are drawn with. It is added as a cleared `refEntity_t`: no
 * skin, first frame, no `RF_` flag of any kind, so it is lit where it is drawn and shows in first
 * person too — behind the camera, where the carrier's own eyes never find it.
 *
 * One model a side, built at the load of a Capture the Flag match: that game has one flag each and
 * one carrier a flag, as [`flag-trail.ts`](../view/flag-trail.ts) says.
 */

/** One side's flag, and the stages of it that change over time. */
interface TrailModel {
  staged: StagedModel;
  animated: SkinStage[];
}

/** Both sides' flags as a match registered them, and what they hold. */
interface Registered {
  scope: ResourceScope;
  red: TrailModel | null;
  blue: TrailModel | null;
}

export interface FlagTrailsOptions {
  /** Layers for stages that write no depth, as a player's blended surfaces take. */
  blendedLayers?: number[];
  /**
   * The scene's light, its grid and its lights, which light each flag where it flies; a scene with
   * no world when absent.
   */
  lights?: LightingScene;
  /** The scene the flags are placed in, where a map's world is drawn. */
  scene?: SceneDraws;
}

export class FlagTrails {
  private readonly app: AppBase;
  private readonly library: AssetLibrary;
  private readonly textures: TextureCache;
  private readonly blendedLayers: number[] | undefined;
  private readonly lights: LightingScene | undefined;
  private readonly scene: SceneDraws | undefined;
  /** A flag's light where it stands, then in its own frame, written for each flag drawn. */
  private readonly standing = keptEntityLight();
  private readonly framed = keptEntityLight();
  private readonly root: Entity;
  /** The flags this match registered, or `null` while it has none. */
  private registered: Registered | null = null;
  /** The build running for this match, so the flags are built once. */
  private building: Promise<void> | null = null;
  /** Bumped by each {@link clear}, so that a build still running for the last match lands freed. */
  private generation = 0;
  private destroyed = false;

  private constructor(
    app: AppBase,
    library: AssetLibrary,
    textures: TextureCache,
    blendedLayers: number[] | undefined,
    lights: LightingScene | undefined,
    scene: SceneDraws | undefined
  ) {
    this.app = app;
    this.library = library;
    this.textures = textures;
    this.blendedLayers = blendedLayers;
    this.scene = scene;
    this.lights = lights;
    this.root = new Entity('flag-trails');
    applyQuakeTransform(this.root);
    app.root.addChild(this.root);
  }

  /** Set up the flags' renderer. Nothing is built until a match registers them. */
  static create(
    app: AppBase,
    library: AssetLibrary,
    textures: TextureCache,
    options: FlagTrailsOptions = {}
  ): FlagTrails {
    const { blendedLayers, lights, scene } = options;
    return new FlagTrails(app, library, textures, blendedLayers, lights, scene);
  }

  /**
   * `CG_RegisterGraphics`' flag models, which it registers only for Capture the Flag
   * (`cg_main.c:892–897`): both sides' built for a match of that game, and nothing for any other.
   *
   * A side whose model the install has not got, or will not build, is simply not drawn, as a
   * refEntity with no model draws nothing: the match is still playable without the art.
   *
   * @param gametype - The match's `g_gametype`, as its serverinfo has it.
   */
  async register(gametype: number): Promise<void> {
    if (this.destroyed || gametype !== GT.CTF) return;
    this.building ??= this.build();
    await this.building;
  }

  /** Draw whichever flags are being carried this frame, and hide the ones that are not. */
  update(trails: TrailPlaces, time: number, viewer?: GraphNode): void {
    if (this.destroyed || !this.registered) return;
    const seconds = time / 1000;
    this.draw(this.registered.red, trails.red, seconds, viewer);
    this.draw(this.registered.blue, trails.blue, seconds, viewer);
  }

  /** The entity a side's flag is drawn as, or `null` where there is none; for the tests. */
  drawn(team: 'red' | 'blue'): Entity | null {
    const model = team === 'red' ? this.registered?.red : this.registered?.blue;
    return model?.staged.entity ?? null;
  }

  /** Both flags, for the warm-up (`warm-up.ts`), played on the game clock. */
  warm(): Warmed {
    let hide: (() => void) | null = null;
    return {
      at: (seconds) => {
        if (this.destroyed) return;
        hide ??= showHidden(this.root);
        for (const model of [this.registered?.red, this.registered?.blue]) {
          if (model) playStagedStages(model.animated, seconds);
        }
      },
      end: () => {
        hide?.();
        hide = null;
      }
    };
  }

  /**
   * Take both models away and give back their textures, as the match that registered them goes.
   * The next match registers its own.
   */
  clear(): void {
    this.generation++;
    this.building = null;
    const registered = this.registered;
    this.registered = null;
    if (!registered) return;
    // The entities go first: a material destroyed under a draw hands it the default.
    registered.red?.staged.entity.destroy();
    registered.blue?.staged.entity.destroy();
    registered.scope.dispose();
  }

  /** Take both models away and give back their textures. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
    this.root.destroy();
  }

  /** Build both sides' flags, kept unless their match has gone by the time they are done. */
  private async build(): Promise<void> {
    const generation = this.generation;
    const scope = this.textures.scope();
    const red = await this.buildSide(scope, PW.REDFLAG, 'flag-trail-red');
    const blue = await this.buildSide(scope, PW.BLUEFLAG, 'flag-trail-blue');
    if (this.destroyed || generation !== this.generation) {
      red?.staged.entity.destroy();
      blue?.staged.entity.destroy();
      scope.dispose();
      return;
    }
    if (red) this.root.addChild(red.staged.entity);
    if (blue) this.root.addChild(blue.staged.entity);
    this.registered = { scope, red, blue };
  }

  /** One side's flag, the flag item's own world model, hidden; `null` where there is none. */
  private async buildSide(
    scope: ResourceScope,
    powerup: number,
    name: string
  ): Promise<TrailModel | null> {
    const path = ITEMS.find((item) => item.giType === IT.TEAM && item.giTag === powerup)
      ?.worldModel[0];
    if (!path || !this.library.read(path)) return null;
    const layers = {
      ...(this.blendedLayers ? { blendedLayers: this.blendedLayers } : {}),
      ...(this.scene ? { scene: { draws: this.scene, group: 'models' as const } } : {})
    };
    const animated: SkinStage[] = [];
    try {
      const staged = await buildStagedModel(
        this.app,
        this.library,
        scope,
        name,
        this.library.model(path),
        ownShader,
        layers,
        animated
      );
      staged.entity.enabled = false;
      return { staged, animated };
    } catch (error) {
      console.warn(`flag trail: no model for ${path}`, error);
      return null;
    }
  }

  /** One flag where its carrier has it, lit where it flies, or hidden for a flag nobody holds. */
  private draw(
    model: TrailModel | null,
    at: TrailPlace | null,
    seconds: number,
    viewer: GraphNode | undefined
  ): void {
    if (!model) return;
    model.staged.entity.enabled = at !== null;
    if (!at) return;
    model.staged.order.value = at.order;
    // Placed before it is lit, so the light is read where the flag flies and not where it flew.
    place(model.staged.entity, at);
    lightAtEntity(model.staged.entity, this.lights ?? NO_WORLD, this.standing);
    const light = lightInEntityFrame(at.axis, this.standing, this.framed);
    drawPlacedModel(model.staged, FIRST_FRAME, light, seconds, viewer);
    playStagedStages(model.animated, seconds);
  }
}
