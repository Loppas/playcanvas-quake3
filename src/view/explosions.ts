import { madd, type Vec3 } from '../sim/vec3';
import type { WeaponId } from '../sim/weapons/constants';
import {
  EXPLOSION_SURFACE_OFFSET,
  ID_MISSILE_LOOKS,
  explosionScale,
  explosionStyle,
  type MissileLooks
} from './effects';
import type { WorldEffect } from './entity-events';
import { LocalEntities, type LocalEntity } from './local-entities';

/**
 * The impacts' explosions, as the cgame keeps them among its local entities: made where a shot
 * struck (`CG_MissileHitWall` into `CG_MakeExplosion`, `cg_effects.c:433–482`) and let go when
 * their time is up (`CG_AddLocalEntities`).
 *
 * One list, kept before anything is drawn or lit, so an explosion's age is defined once: the world
 * effects draw each from it (`render/world-effects.ts`), and the frame's lights take each one's
 * light from it (`light-sources.ts`). Engine-free like the rest of `src/view/`.
 */

/** `rand() & 63`: how far back an explosion's start is set, "so they aren't all in sync". */
export const EXPLOSION_SKEW_MS = 63;

/** One impact's explosion. */
export interface Explosion {
  readonly weapon: WeaponId;
  /** Where the shot struck. */
  readonly origin: Readonly<Vec3>;
  /** The struck surface's normal, out of it. */
  readonly normal: Readonly<Vec3>;
  /** `startTime`, set back by up to {@link EXPLOSION_SKEW_MS}: the game clock, in milliseconds. */
  readonly startTime: number;
  readonly durationMs: number;
  /** `isSprite`: a fireball facing the camera, off the surface, rather than a model on it. */
  readonly sprite: boolean;
  /** The weapon whose explosion shader it is drawn in: its own, but for CPMA's bare BFG. */
  readonly shaderOf: WeaponId;
  /** How large its model is drawn. */
  readonly scale: number;
  /** Its place's serial among the local entities, which orders it in a scene among them. */
  readonly serial: number;
}

/**
 * Where an explosion is drawn and lit: a sprite's 16 units out of the surface, lest half the
 * fireball be inside the wall, and a model's where the shot struck (`CG_MakeExplosion`).
 */
export function explosionOrigin(explosion: Explosion): Vec3 {
  return explosion.sprite
    ? madd(explosion.origin, EXPLOSION_SURFACE_OFFSET, explosion.normal)
    : { x: explosion.origin.x, y: explosion.origin.y, z: explosion.origin.z };
}

/** Every explosion playing, oldest first. */
export class Explosions {
  private readonly random: () => number;
  private readonly localEntities: LocalEntities;
  private readonly list: Explosion[] = [];
  /** Each explosion's place among the local entities, in step with {@link list}. */
  private readonly places: LocalEntity[] = [];

  /**
   * @param random - Uniform over [0, 1), for `rand()`; injectable so a test can pin it.
   * @param localEntities - The pool each explosion takes its place in.
   */
  constructor(random: () => number = Math.random, localEntities = new LocalEntities()) {
    this.random = random;
    this.localEntities = localEntities;
  }

  /** The explosions playing, oldest first: the order the cgame walks its local entities in. */
  get live(): readonly Explosion[] {
    return this.list;
  }

  /**
   * Start an explosion for every impact this frame that makes one, then let go of every one whose
   * time is up (`cg.time >= le->endTime`), that starts after now, as a clock set back leaves it, or
   * whose place the pool freed for a newer local entity.
   *
   * @param time - The game clock, in milliseconds.
   * @param looks - How the serverinfo's rules have the missiles drawn.
   */
  update(
    effects: readonly WorldEffect[],
    time: number,
    looks: MissileLooks = ID_MISSILE_LOOKS
  ): void {
    for (const effect of effects) {
      if (effect.type !== 'impact') continue;
      const style = explosionStyle(effect.weapon, looks);
      if (!style) continue;
      const skew = Math.floor(this.random() * (EXPLOSION_SKEW_MS + 1));
      const place = this.localEntities.alloc();
      this.list.push({
        weapon: effect.weapon,
        origin: { ...effect.origin },
        normal: { ...effect.normal },
        startTime: time - skew,
        durationMs: style.durationMs,
        sprite: style.sprite,
        shaderOf: style.shaderOf ?? effect.weapon,
        scale: explosionScale(effect.weapon, looks),
        serial: place.serial
      });
      this.places.push(place);
    }
    let kept = 0;
    for (let i = 0; i < this.list.length; i++) {
      const explosion = this.list[i];
      const place = this.places[i];
      const elapsed = time - explosion.startTime;
      if (place.freed || elapsed < 0 || elapsed >= explosion.durationMs) {
        this.localEntities.free(place);
        continue;
      }
      this.list[kept] = explosion;
      this.places[kept++] = place;
    }
    this.list.length = kept;
    this.places.length = kept;
  }

  /** Let every explosion go, as a restart does (`CG_MapRestart` clears the local entities). */
  clear(): void {
    for (const place of this.places) this.localEntities.free(place);
    this.list.length = 0;
    this.places.length = 0;
  }
}
