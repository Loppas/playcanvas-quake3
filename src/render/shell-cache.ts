import type { Md3Model } from '../formats/md3';
import type { SkinStage } from './skin-material';
import type { StagedModel } from './staged-model';

/**
 * A piece of a model drawn again with a powerup's shader — a shell: `CG_AddRefEntityWithPowerups`
 * (`cg_players.c:2150–2187`) for a body's part, `CG_AddWeaponWithPowerups`
 * (`cg_weapons.c:1169–1186`) for a gun, the body's or the view's. Built on first use and kept, as a
 * weapon is.
 */
export interface Shell {
  model: StagedModel;
  /** The shell's stages that animate, played while it draws. */
  stages: SkinStage[];
}

/**
 * Builds one shell: the piece's model again, every surface of it under the powerup's shader, hung
 * where its owner draws it.
 *
 * @param key - `<shader>/<piece>`, which names the shell's entity.
 * @param piece - Which of the owner's pieces it covers: `legs`, `gun`, `barrel`.
 */
export type ShellBuilder = (
  key: string,
  shader: string,
  model: Md3Model,
  piece: string
) => Promise<Shell>;

/**
 * One owner's shells — a body's parts, or a gun and its barrel — keyed by `<shader>/<piece>`. Each
 * is built the first time it is asked for and kept, so a shell costs nothing until it is worn and
 * nothing again once it is not.
 */
export class ShellCache {
  private readonly shells = new Map<string, Shell>();
  private readonly builds = new Map<string, Promise<void>>();
  /** What {@link show} has shown since {@link hideUnshown} last ran. */
  private readonly shown = new Set<Shell>();
  private readonly owner: string;
  private readonly build: ShellBuilder;

  /**
   * @param owner - Named in the warning a failed build gives.
   * @param build - How a shell is made and hung.
   */
  constructor(owner: string, build: ShellBuilder) {
    this.owner = owner;
    this.build = build;
  }

  /**
   * Hide every shell not shown since this last ran: what a powerup no longer held does not draw.
   * A frame calls it after its shows, so a shell worn from frame to frame stays in its layer
   * rather than leaving it and joining it again.
   */
  hideUnshown(): void {
    for (const shell of this.shells.values()) {
      if (!this.shown.has(shell)) shell.model.entity.enabled = false;
    }
    this.shown.clear();
  }

  /** Hide every shell, for an owner drawn no more. */
  hide(): void {
    for (const shell of this.shells.values()) shell.model.entity.enabled = false;
  }

  /**
   * The shell for a piece under a shader, shown for this frame; `null` while it builds, which the
   * first asking starts. A shell still building shows from the frame it lands.
   */
  show(shader: string, piece: string, model: Md3Model): Shell | null {
    const key = `${shader}/${piece}`;
    const shell = this.shells.get(key);
    if (shell) {
      shell.model.entity.enabled = true;
      this.shown.add(shell);
      return shell;
    }
    this.request(key, shader, model, piece);
    return null;
  }

  /**
   * Build a piece's shells under each of `shaders` ahead of their use, hidden, where they are not
   * built already.
   *
   * @returns once each has landed
   */
  async prepare(shaders: readonly string[], piece: string, model: Md3Model): Promise<void> {
    for (const shader of shaders) this.request(`${shader}/${piece}`, shader, model, piece);
    await this.settled();
  }

  /** Every shell built so far. */
  built(): Shell[] {
    return [...this.shells.values()];
  }

  /** @returns once every build still in flight has landed */
  async settled(): Promise<void> {
    await Promise.allSettled(this.builds.values());
  }

  /** Start a shell's build, unless it has been started already. */
  private request(key: string, shader: string, model: Md3Model, piece: string): void {
    if (this.builds.has(key)) return;
    const build = this.build(key, shader, model, piece)
      .then((built) => {
        this.shells.set(key, built);
      })
      .catch((error: unknown) => {
        console.warn(`${this.owner}: no ${shader} shell for ${piece}`, error);
      });
    this.builds.set(key, build);
  }
}
