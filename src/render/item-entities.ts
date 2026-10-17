import { Entity, type AppBase, type GraphNode } from 'playcanvas';

import { WEAPON_ASSETS, weaponModelPath } from '../formats/asset-manifest';
import type { AssetLibrary } from '../formats/asset-library';
import { findTag, type Md3Frame } from '../formats/md3';
import { EF_NODRAW } from '../sim/constants';
import { IT, ITEMS, NUM_ITEMS } from '../sim/items';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import {
  NO_WORLD,
  keptEntityLight,
  lightInEntityFrame,
  type KeptEntityLight,
  type LightingScene
} from '../view/entity-light';
import { anglesToAxis, type Axis } from '../view/hand-pose';
import type { ItemCentity } from '../view/player-view';
import type { Rgb } from '../view/player-color';
import { packetEntity } from '../view/scene-sort';
import { applyQuakeTransform } from './md3-mesh';
import type { SceneDraws } from './scene-draws';
import type { SkinStage } from './skin-material';
import {
  FIRST_FRAME,
  buildStagedModel,
  copyStagedModel,
  drawPlacedModel,
  lightAtEntity,
  lightInEntity,
  ownShader,
  place,
  playStagedStages,
  tagRotation,
  tintStagedModel,
  writeStagedTexMods,
  type StagedModel
} from './staged-model';
import type { ResourceScope, TextureCache } from './texture-cache';
import { showHidden, type Warmed } from './warm-up';

/**
 * The items on the map, drawn as `CG_Item` draws them (`cg_ents.c:227–405`).
 *
 * An item is not animated by the server: it is a still entity whose whole look is decided on the
 * client. It bobs on a cosine of the game clock, spins about the world's up — health twice as fast
 * as everything else — and, for a second after it comes back, grows from nothing to its size. A
 * weapon is drawn bigger and lifted so that it turns about its own middle rather than the origin
 * its model is authored around; a health or a powerup brings a second model with it, the sphere or
 * the ring, and a weapon's barrel rides on a tag.
 *
 * Each item is built once, as `CG_RegisterItemVisuals` registers it (`cg_weapons.c:827–862`): every
 * item the gamestate lists in `CS_ITEMS` as the client loads, and any other when it is first seen.
 * Every entity of an item draws a copy of that build, which shares its meshes and materials, so the
 * item's stages play once a frame for all of them. A copy is kept per entity number for as long as
 * the match holds it, since an item that is picked up leaves the snapshot and comes back; a number
 * that comes back wearing another item takes a copy of that item.
 */

/** `ITEM_SCALEUP_TIME` (`cg_local.h:48`): how long a respawned item takes to grow to full. */
export const ITEM_SCALEUP_TIME = 1000;

/** `VectorScale( ent.axis, 1.5 )` (`cg_ents.c:330–334`): how much bigger a presented weapon is. */
const WEAPON_ITEM_SCALE = 1.5;

/** The two spins, `CG_AddPacketEntities` (`cg_ents.c:1070–1080`): a full turn per period. */
const SLOW_SPIN_MSEC = 2048;
const FAST_SPIN_MSEC = 1024;

/**
 * The table slots `CS_ITEMS` lists, in order: a `1` for each item the level uses
 * (`cg_main.c:1014–1022`). Slot 0 is the table's placeholder, and never built.
 *
 * @param items - The configstring, one character per table slot.
 */
export function listedItems(items: string): number[] {
  const slots: number[] = [];
  for (let slot = 1; slot < NUM_ITEMS; slot++) if (items[slot] === '1') slots.push(slot);
  return slots;
}

/** One item entity's models, placed together and taken away together. */
interface ItemModels {
  /** The table slot they draw. */
  slot: number;
  /** The item itself, at the item's place. */
  container: Entity;
  /** The table's first model. */
  main: StagedModel;
  /** The health's sphere or the powerup's ring, where the item has one. */
  second: StagedModel | null;
  /** The weapon's barrel, riding the main model's `tag_barrel`. */
  barrel: StagedModel | null;
}

/** An item's one build, which every entity of it copies: `cg_items`' entry. */
interface ItemPrototype extends ItemModels {
  /** Each model's stages that change over time, or take the entity's colour. */
  mainStages: SkinStage[];
  secondStages: SkinStage[];
  barrelStages: SkinStage[];
  /** Holds the models' materials and textures, to be given back when they go. */
  scope: ResourceScope;
}

/** What the renderer needs of the world beyond the items themselves. */
export interface ItemEntitiesOptions {
  /**
   * Layers for the stages that write no depth. A powerup's ring draws over the world like an
   * effect, and follows the world's own depth, as the players' blended surfaces do.
   */
  blendedLayers?: number[];
  /**
   * The scene's light, its grid and its lights, which light each model of an item where it is; a
   * scene with no world when absent.
   */
  lights?: LightingScene;
  /** The scene the items are placed in, where a map's world is drawn. */
  scene?: SceneDraws;
}

export class ItemEntities {
  private readonly app: AppBase;
  private readonly library: AssetLibrary;
  private readonly textures: TextureCache;
  private readonly blendedLayers: number[] | undefined;
  private readonly lights: LightingScene | undefined;
  private readonly scene: SceneDraws | undefined;
  /** A model's light where it stands, then in its own frame, written for each model drawn. */
  private readonly standing = keptEntityLight();
  private readonly framed: KeptEntityLight = keptEntityLight();
  /** An item's axis scaled as it is drawn, for its light. */
  private readonly scaledAxis: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  /** Quake-space root: everything here is in units, Z-up, as the models store it. */
  private readonly root: Entity;
  /** Each item's build, by table slot, or `null` where the install lacks its models. */
  private readonly prototypes = new Map<number, ItemPrototype | null>();
  /** The copies drawn for each item entity number. */
  private readonly models = new Map<number, ItemModels>();
  /** The builds running for this match, by table slot, so a slot is built once. */
  private readonly building = new Map<number, Promise<void>>();
  /** Builds still running for a match that has gone, which land freed. */
  private readonly leaving = new Set<Promise<void>>();
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
    this.lights = lights;
    this.scene = scene;
    this.root = new Entity('world-items');
    applyQuakeTransform(this.root);
    app.root.addChild(this.root);
  }

  /** Set up the item renderer. Nothing is built until an item is registered or first seen. */
  static create(
    app: AppBase,
    library: AssetLibrary,
    textures: TextureCache,
    options: ItemEntitiesOptions = {}
  ): ItemEntities {
    const { blendedLayers, lights, scene } = options;
    return new ItemEntities(app, library, textures, blendedLayers, lights, scene);
  }

  /**
   * `CG_RegisterItemVisuals` for each item the server says the level uses, one after another
   * (`cg_main.c:1014–1022`), so that every entity of them is drawn from its first snapshot.
   *
   * @param slots - The table slots to build, as {@link listedItems} reads them.
   * @param loading - Told of each item as its build starts, as `CG_LoadingItem` names it.
   */
  async register(
    slots: readonly number[],
    loading?: (slot: number, at: number) => void
  ): Promise<void> {
    const generation = this.generation;
    for (const [at, slot] of slots.entries()) {
      if (this.destroyed || generation !== this.generation) return;
      loading?.(slot, at);
      if (this.prototypes.has(slot)) continue;
      this.build(slot);
      await this.building.get(slot);
    }
  }

  /** Draw every item the snapshot carried, or take its model out of the world where there is none. */
  update(items: readonly ItemCentity[], time: number, viewer?: GraphNode, color?: Rgb): void {
    if (this.destroyed) return;
    const seconds = time / 1000;
    const present = new Set<number>();
    const played = new Set<ItemPrototype>();

    for (const item of items) {
      const slot = item.state.modelindex;
      if (slot >= NUM_ITEMS) throw new Error(`Bad item index ${slot} on entity`);
      // Slot 0 is the table's placeholder, and a held-back item says so itself.
      if (!slot || item.state.eFlags & EF_NODRAW) continue;

      const prototype = this.prototypes.get(slot);
      // An item the gamestate did not list is built as it is first seen: a frame that arrives
      // first draws nothing.
      if (prototype === undefined) {
        this.build(slot);
        continue;
      }
      if (!prototype) continue;

      const number = item.state.number;
      present.add(number);
      let built = this.models.get(number);
      if (built?.slot !== slot) {
        built?.container.destroy();
        built = this.copy(prototype);
        this.models.set(number, built);
      }
      // `CG_Item`'s refEntities: the item, its barrel, then its ring or sphere.
      built.main.order.value = packetEntity(number, 0);
      if (built.barrel) built.barrel.order.value = packetEntity(number, 1);
      if (built.second) built.second.order.value = packetEntity(number, 2);
      this.drawItem(built, item, time, seconds, viewer);
      if (!played.has(prototype)) {
        played.add(prototype);
        this.play(prototype, seconds, color);
      }
    }

    for (const [number, built] of this.models) {
      if (!present.has(number)) built.container.enabled = false;
    }
  }

  /**
   * Wait for every build and teardown under way. A frame can draw nothing for an item whose models
   * are still being built; the next one draws them.
   */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.building.values(), ...this.leaving]);
  }

  /** The container drawn for an item entity number, or `null`; for the app and its tests. */
  drawn(number: number): Entity | null {
    return this.models.get(number)?.container ?? null;
  }

  /**
   * Every item's build shown for the warm-up's frames (`warm-up.ts`), its stages played at each
   * time they draw at.
   */
  warm(): Warmed {
    let hide: (() => void) | null = null;
    return {
      at: (seconds) => {
        hide ??= showHidden(this.root);
        for (const prototype of this.prototypes.values()) {
          if (prototype) this.play(prototype, seconds, undefined);
        }
      },
      end: () => {
        hide?.();
        hide = null;
      }
    };
  }

  /**
   * Take every model away and give back its textures, as the match that placed the items goes. The
   * next match's items are built anew.
   */
  clear(): void {
    this.generation++;
    for (const work of this.building.values()) this.leaving.add(work);
    this.building.clear();
    for (const built of this.models.values()) built.container.destroy();
    this.models.clear();
    // The copies go first: a material destroyed under a draw hands it the default.
    for (const prototype of this.prototypes.values()) {
      if (!prototype) continue;
      prototype.container.destroy();
      prototype.scope.dispose();
    }
    this.prototypes.clear();
  }

  /** Take every model away and give back its textures. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.settled();
    this.clear();
    this.root.destroy();
  }

  /**
   * Build one item, in the background. One whose models fail to build is drawn as nothing, as Q3
   * draws an item whose model would not register.
   */
  private build(slot: number): void {
    if (this.building.has(slot)) return;
    const generation = this.generation;
    const work = this.buildPrototype(slot)
      .then(
        (built) => {
          if (this.destroyed || generation !== this.generation) {
            built?.container.destroy();
            built?.scope.dispose();
            return;
          }
          this.prototypes.set(slot, built);
        },
        (error: unknown) => {
          console.warn(`item: no model for ${ITEMS[slot].classname}`, error);
          if (!this.destroyed && generation === this.generation) this.prototypes.set(slot, null);
        }
      )
      .finally(() => {
        if (this.building.get(slot) === work) this.building.delete(slot);
        this.leaving.delete(work);
      });
    this.building.set(slot, work);
  }

  /** One item's build, or `null` where the install has not the models it draws with. */
  private async buildPrototype(slot: number): Promise<ItemPrototype | null> {
    const item = ITEMS[slot];
    const path = item.worldModel[0];
    if (!path || !this.library.read(path)) return null;

    const scope = this.textures.scope();
    const container = new Entity(`item-${item.classname}`);
    container.enabled = false;
    this.root.addChild(container);
    try {
      const mainStages: SkinStage[] = [];
      const main = await this.staged(scope, 'main', path, mainStages);
      container.addChild(main.entity);

      let second: StagedModel | null = null;
      const secondStages: SkinStage[] = [];
      const secondPath = item.worldModel[1];
      if (
        secondPath &&
        (item.giType === IT.HEALTH || item.giType === IT.POWERUP) &&
        this.library.read(secondPath)
      ) {
        second = await this.staged(scope, 'second', secondPath, secondStages);
        container.addChild(second.entity);
      }

      let barrel: StagedModel | null = null;
      const barrelStages: SkinStage[] = [];
      if (item.giType === IT.WEAPON) {
        const asset = WEAPON_ASSETS.find((candidate) => candidate.id === item.giTag);
        const barrelPath = asset?.hasBarrel ? weaponModelPath(asset.dir, '_barrel') : null;
        const tag = barrelPath ? findTag(main.model, 'tag_barrel') : null;
        if (barrelPath && tag && this.library.read(barrelPath)) {
          barrel = await this.staged(scope, 'barrel', barrelPath, barrelStages);
          barrel.entity.setLocalPosition(tag.origin[0], tag.origin[1], tag.origin[2]);
          barrel.entity.setLocalRotation(tagRotation(tag));
          main.entity.addChild(barrel.entity);
        }
      }

      if (item.tint) {
        for (const part of [main, second, barrel]) if (part) tintStagedModel(part, item.tint);
      }
      return {
        slot,
        container,
        main,
        mainStages,
        second,
        secondStages,
        barrel,
        barrelStages,
        scope
      };
    } catch (error) {
      container.destroy();
      scope.dispose();
      throw error;
    }
  }

  /** One model of an item, hung under the renderer's root until its container takes it. */
  private staged(
    scope: ResourceScope,
    name: string,
    path: string,
    animated: SkinStage[]
  ): Promise<StagedModel> {
    return buildStagedModel(
      this.app,
      this.library,
      scope,
      name,
      this.library.model(path),
      ownShader,
      {
        ...(this.blendedLayers ? { blendedLayers: this.blendedLayers } : {}),
        ...(this.scene ? { scene: { draws: this.scene, group: 'models' as const } } : {})
      },
      animated
    );
  }

  /** An entity's copy of its item's build, put together as the build is and hidden until drawn. */
  private copy(prototype: ItemPrototype): ItemModels {
    const container = new Entity(prototype.container.name);
    container.enabled = false;
    const main = copyStagedModel(prototype.main);
    container.addChild(main.entity);
    let barrel: StagedModel | null = null;
    if (prototype.barrel) {
      barrel = copyStagedModel(prototype.barrel);
      barrel.entity.setLocalPosition(prototype.barrel.entity.getLocalPosition());
      barrel.entity.setLocalRotation(prototype.barrel.entity.getLocalRotation());
      main.entity.addChild(barrel.entity);
    }
    const second = prototype.second && copyStagedModel(prototype.second);
    if (second) container.addChild(second.entity);
    this.root.addChild(container);
    return { slot: prototype.slot, container, main, second, barrel };
  }

  /**
   * Play an item's stages, which its every entity shares: the railgun's tint and the item's own.
   * `rgbGen entity` takes the colour the item is given: color1 for the railgun, on ioq3's line
   * (`cg_ents.c:298–301`), and white for everything else, as no other item draws such a stage.
   */
  private play(prototype: ItemPrototype, seconds: number, color: Rgb | undefined): void {
    const table = ITEMS[prototype.slot];
    const railgun = table.giType === IT.WEAPON && table.giTag === WP.RAILGUN ? color : undefined;
    playStagedStages(prototype.mainStages, seconds, railgun, table.tint);
    playStagedStages(prototype.barrelStages, seconds, undefined, table.tint);
    playStagedStages(prototype.secondStages, seconds, undefined, table.tint);
    // The stages' affine `tcMod` transforms are the models' own uniforms, written here so a
    // warm-up that plays them before they are drawn moves them too.
    writeStagedTexMods(prototype.main, seconds);
    if (prototype.barrel) writeStagedTexMods(prototype.barrel, seconds);
    if (prototype.second) writeStagedTexMods(prototype.second, seconds);
  }

  /**
   * Place and draw one item: the bob, the spin, the weapon's lift and size, the scale-up after a
   * respawn, and the second model. Each model is lit where it is drawn: no part of an item has a
   * lighting origin (`cg_ents.c:227–404`).
   */
  private drawItem(
    built: ItemModels,
    item: ItemCentity,
    time: number,
    seconds: number,
    viewer: GraphNode | undefined
  ): void {
    const { state, origin, respawnTime } = item;
    const table = ITEMS[built.slot];
    const { container } = built;
    container.enabled = true;

    // "items bob up and down continuously" (`cg_ents.c:262–263`).
    const bobScale = 0.005 + state.number * 0.00001;
    container.setLocalPosition(
      origin.x,
      origin.y,
      origin.z + 4 + Math.cos((time + 1000) * bobScale) * 4
    );

    // "if just respawned, slowly scale up" (`cg_ents.c:310–320`): a second from nothing to full.
    const msec = time - respawnTime;
    const frac = msec >= 0 && msec < ITEM_SCALEUP_TIME ? msec / ITEM_SCALEUP_TIME : 1;

    // "autorotate at one of two speeds" (`cg_ents.c:267–274`): health turns twice as fast.
    const spin = table.giType === IT.HEALTH ? FAST_SPIN_MSEC : SLOW_SPIN_MSEC;
    const axis = anglesToAxis(0, ((time % spin) * 360) / spin, 0);

    // "the weapons have their origin where they attatch to player models, so we need to offset
    // them or they will rotate eccentricly" (`cg_ents.c:277–296`): their model's own middle, and
    // an extra eight units up.
    let offset: [number, number, number] = [0, 0, 0];
    let scale = frac;
    if (table.giType === IT.WEAPON) {
      offset = liftOffsets(built.main.model.frames[0], axis);
      scale = frac * WEAPON_ITEM_SCALE;
    }
    place(built.main.entity, { origin: offset, axis });
    built.main.entity.setLocalScale(scale, scale, scale);
    // Its axis scaled with it, so a weapon on the floor is lit harder and an item coming back in
    // softer, as their light's direction is dotted with it (`tr_light.c:375-377`).
    const scene = this.lights ?? NO_WORLD;
    const { standing, framed } = this;
    lightAtEntity(built.main.entity, scene, standing);
    lightInEntityFrame(this.scaled(axis, scale), standing, framed);
    drawPlacedModel(built.main, FIRST_FRAME, framed, seconds, viewer);
    if (built.barrel) {
      // On the gun's tag, its axis scaled with the gun's.
      lightAtEntity(built.barrel.entity, scene, standing);
      lightInEntity(built.barrel.entity, standing, framed);
      for (let k = 0; k < 3; k++) framed.direction[k] *= scale;
      drawPlacedModel(built.barrel, FIRST_FRAME, framed, seconds, viewer);
    }

    // "accompanying rings / spheres for powerups" (`cg_ents.c:376–404`): the ring turns the other
    // way at the fast rate, twelve units above a powerup, and grows with the item.
    if (built.second) {
      const ringAxis = anglesToAxis(0, -((time % FAST_SPIN_MSEC) * 360) / FAST_SPIN_MSEC, 0);
      const rise = table.giType === IT.POWERUP ? 12 : 0;
      place(built.second.entity, { origin: [0, 0, rise], axis: ringAxis });
      built.second.entity.setLocalScale(frac, frac, frac);
      lightAtEntity(built.second.entity, scene, standing);
      lightInEntityFrame(this.scaled(ringAxis, frac), standing, framed);
      drawPlacedModel(built.second, FIRST_FRAME, framed, seconds, viewer);
    }
  }

  /** An axis with each row scaled, written into {@link scaledAxis}. */
  private scaled(axis: Axis, scale: number): readonly (readonly number[])[] {
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < 3; i++) this.scaledAxis[k][i] = axis[k][i] * scale;
    }
    return this.scaledAxis;
  }
}

/**
 * Where a weapon item's model sits about its source origin: back along the spin axis by its own
 * middle, as `CG_Item` moves the origin, and eight units up (`cg_ents.c:282–295`).
 *
 * A model's middle is the centre of its frame-0 bounds, which is what `CG_RegisterWeapon` works
 * out once and keeps as `weaponMidpoint` (`cg_weapons.c:640–644`).
 */
function liftOffsets(frame: Md3Frame, axis: Axis): [number, number, number] {
  const middle = vec3(
    frame.mins[0] + 0.5 * (frame.maxs[0] - frame.mins[0]),
    frame.mins[1] + 0.5 * (frame.maxs[1] - frame.mins[1]),
    frame.mins[2] + 0.5 * (frame.maxs[2] - frame.mins[2])
  );
  const along = (index: 0 | 1 | 2): number =>
    -(middle.x * axis[0][index] + middle.y * axis[1][index] + middle.z * axis[2][index]);
  return [along(0), along(1), along(2) + 8];
}
