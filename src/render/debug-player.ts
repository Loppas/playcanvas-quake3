import type { AppBase } from 'playcanvas';

import type { AssetLibrary } from '../formats/asset-library';
import { DEFAULT_MODEL } from '../formats/asset-manifest';
import { ANIM } from '../sim/animations';
import { vec3, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { PlayerRig, type PlayerRigOptions } from './player-rig';
import type { TextureCache } from './texture-cache';

/**
 * A player model standing in the world to be looked at: a debug view, for any model. It stands
 * idle with the machinegun, as the model page shows a model. Dev only; the console's `pcqPlayer`
 * drives it.
 */
export class DebugPlayer {
  private readonly app: AppBase;
  private readonly library: AssetLibrary;
  private readonly cache: TextureCache;
  private readonly options: PlayerRigOptions;
  private rig: PlayerRig | null = null;
  private origin: Vec3 = vec3();
  private yaw = 0;
  /** Bumped by every show and hide, so a slow build that has been superseded is dropped. */
  private generation = 0;

  constructor(app: AppBase, library: AssetLibrary, cache: TextureCache, options: PlayerRigOptions) {
    this.app = app;
    this.library = library;
    this.cache = cache;
    this.options = options;
  }

  /** The body shown, if any. */
  get current(): PlayerRig | null {
    return this.rig;
  }

  /**
   * Stand a model at `origin`, facing along `yaw`, in place of whatever stood there. A model not
   * in the library is read from the install first, in dev.
   *
   * @throws for a model the install lacks, or one Q3 would fail
   */
  async show(origin: Vec3, yaw: number, model = DEFAULT_MODEL, skin = 'default'): Promise<PlayerRig> {
    const generation = ++this.generation;
    await this.dropRig();
    if (!(await this.library.loadPlayerModel(model))) {
      throw new Error(`${model}: not in the install`);
    }
    const rig = await PlayerRig.create(this.app, this.library, this.cache, model, skin, this.options);
    if (generation !== this.generation) {
      await rig.destroy();
      throw new Error(`${model}/${skin}: superseded while loading`);
    }
    this.rig = rig;
    this.origin = { ...origin };
    this.yaw = yaw;
    await rig.selectWeapon(WP.MACHINEGUN);
    return rig;
  }

  /** Draw this frame, on the game clock. */
  update(time: number): void {
    this.rig?.update({
      origin: this.origin,
      angles: vec3(0, this.yaw, 0),
      legsAnim: ANIM.LEGS_IDLE,
      torsoAnim: ANIM.TORSO_STAND,
      movementDir: 0,
      velocity: vec3(),
      dead: false,
      weapon: WP.MACHINEGUN,
      firing: false,
      lastFireTime: Number.NEGATIVE_INFINITY,
      time
    });
  }

  /** Take the body away, freeing what it held. */
  async hide(): Promise<void> {
    this.generation++;
    await this.dropRig();
  }

  private async dropRig(): Promise<void> {
    const rig = this.rig;
    this.rig = null;
    await rig?.destroy();
  }
}
