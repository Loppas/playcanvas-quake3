import type { AppBase } from 'playcanvas';

import type { AssetLibrary } from '../formats/asset-library';
import { DEFAULT_MODEL } from '../formats/asset-manifest';
import { EF_DEAD, EF_FIRING } from '../sim/constants';
import type { Vec3 } from '../sim/vec3';
import type { WeaponId } from '../sim/weapons/constants';
import type { ClientInfo } from '../view/client-info';
import { rendererStyle } from '../view/overbright';
import { DEFAULT_LOOK, sameLook, type PlayerLook, type Voice } from '../view/player-model';
import type { PlayerCentity } from '../view/player-view';
import { packetEntity } from '../view/scene-sort';
import { warmLookKinds } from './look-kinds';
import { PlayerRig, loadLook, type PlayerRigOptions } from './player-rig';
import type { TextureCache } from './texture-cache';
import type { Warmed } from './warm-up';

/**
 * Everyone else's bodies: `CG_Player` for every `ET_PLAYER` a snapshot carries
 * (`cg_players.c:2241–2594`) — the other players, living and dead, and every corpse in the body
 * queue, the player's own among them.
 *
 * Each is dressed in the look of the client its `s.clientNum` names, which is what lets a corpse
 * in the queue wear its owner's look, and is drawn not at all while that slot is empty
 * (`cg_players.c:2259–2272`). That look is the client's own or, while theirs is put off
 * (`cg_deferPlayers`), a loaded client's. A model the install has not got is drawn as sarge, as
 * `CG_LoadClientInfo` falls back (`cg_players.c:672–694`).
 *
 * Quake 3 draws every entity of a client, a corpse among them, from the one registration of their
 * look. A body here is posed by the entity it draws, so each look keeps bodies of it, hidden while
 * free: built as the look is registered, and a body more wherever more are drawn at once than it
 * has. An entity takes a free body of its look as it arrives, and gives it back, its clocks
 * cleared, when it stops coming. One whose wearer's look changes is dressed again, and drawn in the
 * last look until a body of the next is in; one brought into view afresh, as a corpse handed round
 * is, is somebody new, and is not.
 *
 * What its events left is drawn on it: its gun's flash, its railgun's glow and its pain's twitch.
 * And what it was built of is what it sounds like: its model's own sounds, sarge's for a look that
 * failed, and its model's footsteps.
 */

/** What one frame draws. */
export interface PlayerEntitiesInput {
  /** Every player the snapshot carried, placed for this frame. */
  players: readonly PlayerCentity[];
  /** `cgs.clientinfo`: who is in a slot, or `null` for a slot nobody is in. */
  clientInfo: (clientNum: number) => ClientInfo | null;
  /** Game time in milliseconds. */
  time: number;
}

/** A body built, and what it sounds like. */
interface Dressed {
  rig: PlayerRig;
  voice: Voice;
}

/** A look's bodies, kept while the match lasts, as Q3 keeps a clientinfo's models. */
interface Pool {
  /** The look, as the clients wearing it name it. */
  look: PlayerLook;
  /**
   * What its bodies are built of once the first is in: the look, or sarge's where it failed;
   * `null` before that, and where even sarge's did.
   */
  wears: PlayerLook | null;
  /** Whether it has been registered, rather than first built for an entity drawn in it. */
  registered: boolean;
  /** Every body built for it, in or building: `null` for one that could not be. */
  bodies: Promise<Dressed | null>[];
  /** Its bodies drawing nothing, hidden. */
  free: Dressed[];
  /** The entities waiting for one of its bodies still building, the first to come served first. */
  waiting: Body[];
  /** How many of its bodies are still building. */
  building: number;
}

/** One entity's body. */
interface Body {
  /** The look it was dressed for. */
  look: PlayerLook;
  /** The look's bodies, which it came from and goes back to. */
  pool: Pool;
  /** The body drawing it; `null` while it waits for one, and where none could be built. */
  dressed: Dressed | null;
  /** Whether it has its body, or will get none. */
  ready: boolean;
}

/** A look's models and skins, as one key. */
function lookKey({ body, head }: PlayerLook): string {
  return `${body.model}/${body.skin}/${head.model}/${head.skin}`;
}

export class PlayerEntities {
  private readonly app: AppBase;
  private readonly library: AssetLibrary;
  private readonly cache: TextureCache;
  private readonly options: PlayerRigOptions;
  /**
   * Each body by the entity number it arrived under: a client's slot, or one of the body queue's.
   * The number rather than the state, because a state is a message and comes again in every
   * snapshot as a different object.
   */
  private readonly bodies = new Map<number, Body>();
  /** The body each entity is being dressed in again, while it waits and the last one draws. */
  private readonly dressing = new Map<number, Body>();
  /** Each look's bodies, by {@link lookKey}. */
  private pools = new Map<string, Pool>();
  /** Bodies being taken away. */
  private readonly leaving = new Set<Promise<unknown>>();
  /** The bodies placed this frame, to be drawn. */
  private readonly posed: PlayerRig[] = [];
  /** The settings the warm-up's stand-in for every kind of the paks' looks has been drawn in. */
  private readonly kindsDrawn = new Set<string>();
  private destroyed = false;

  /**
   * @param cache - Where the textures are counted, shared with every other body.
   * @param options - Where the bodies draw, and what faces the viewer.
   */
  constructor(
    app: AppBase,
    library: AssetLibrary,
    cache: TextureCache,
    options: PlayerRigOptions = {}
  ) {
    this.app = app;
    this.library = library;
    this.cache = cache;
    this.options = options;
  }

  /**
   * The body drawing an entity, or `null` while it waits for one or when nothing of that number is
   * drawn.
   *
   * @param number - The entity number it arrived under.
   */
  body(number: number): PlayerRig | null {
    return this.bodies.get(number)?.dressed?.rig ?? null;
  }

  /**
   * What the body drawing an entity sounds like, or `null` while it waits for one or when nothing
   * of that number is drawn.
   *
   * @param number - The entity number it arrived under.
   */
  voice(number: number): Voice | null {
    return this.bodies.get(number)?.dressed?.voice ?? null;
  }

  /**
   * `CG_LoadClientInfo`'s registration (`cg_players.c:652–734`): read the look's models now, and
   * build bodies of them, one for each client drawn in it and one for a corpse, so that the
   * entities wearing it take a body already built and drawn as {@link warm} has drawn it once.
   *
   * It is worth the trouble because the halves cost so differently: reading a model out of the
   * paks is around 150 ms and building a body of one already read is a couple. Unread, those
   * milliseconds are a body's first frames — a bot spawns bodiless, and is silent until its sounds
   * follow.
   *
   * @param wearers - How many clients are drawn in the look; a look already registered gains
   *   bodies to match, and never loses any.
   * @returns once its bodies are built — sarge's for a look the install has not got, or none where
   *   even sarge's fails — whether this is the look's first registration
   */
  async register(look: PlayerLook, wearers = 1): Promise<boolean> {
    const pool = this.pool(look);
    const first = !pool.registered;
    pool.registered = true;
    while (pool.bodies.length <= wearers) this.grow(pool);
    await Promise.all(pool.bodies);
    return first;
  }

  /**
   * The bodies built, for the warm-up (`warm-up.ts`): every look's, or the looks given. Each of
   * them, so that each body's first frame in play draws with what is made already, and their parts
   * only, as the player's own body warms the shells and the weapons every body shares.
   */
  async warm(looks?: readonly PlayerLook[]): Promise<Warmed> {
    const pools = looks
      ? looks.map((look) => this.pools.get(lookKey(look)))
      : [...this.pools.values()];
    const built = await Promise.all(pools.flatMap((pool) => pool?.bodies ?? []));
    const parts = await Promise.all(
      built.flatMap((dressed) => (dressed ? [dressed.rig.warm(false)] : []))
    );
    return {
      at: (seconds) => {
        for (const part of parts) part.at(seconds);
      },
      end: () => {
        for (const part of parts) part.end();
      }
    };
  }

  /**
   * A stand-in for every kind of stage the paks' looks draw, for the warm-up (`look-kinds.ts`), so
   * that a look's first join draws with what the device has made. The device keeps what it makes,
   * so the stand-in is drawn once in each setting a body can be drawn in: a map's scene or none,
   * with fogs or none, in the renderer's style. Nothing, where it has been.
   *
   * @param shaders - Every shader the paks' skins name.
   * @param hasImage - Whether the paks hold an image.
   */
  async warmKinds(
    shaders: Iterable<string>,
    hasImage: (name: string) => boolean
  ): Promise<Warmed | undefined> {
    const { app, library, cache, options } = this;
    const { scene } = options;
    const setting = JSON.stringify([
      scene?.inScene ?? false,
      (scene?.fog.fogs.length ?? 0) > 0,
      rendererStyle()
    ]);
    if (this.kindsDrawn.has(setting)) return undefined;
    const warmed = await warmLookKinds(app, library.shaders, cache, shaders, hasImage, options);
    return {
      at: (seconds) => warmed.at(seconds),
      end: () => {
        warmed.end();
        this.kindsDrawn.add(setting);
      }
    };
  }

  /** Draw this frame: {@link pose}, then {@link draw}. */
  update(input: PlayerEntitiesInput): Vec3[] {
    const puffs = this.pose(input);
    this.draw();
    return puffs;
  }

  /** Draw each body {@link pose} placed this frame, lit by the frame's lights. */
  draw(): void {
    for (let i = 0; i < this.posed.length; i++) this.posed[i].draw();
    this.posed.length = 0;
  }

  /**
   * Place this frame's bodies, giving back the gone and dressing the new: nothing is lit or drawn
   * until {@link draw}, once each body's flash has given its light.
   */
  pose(input: PlayerEntitiesInput): Vec3[] {
    this.posed.length = 0;
    // "It is possible to see corpses from disconnected players that may not have valid
    // clientinfo" (`cg_players.c:2268–2272`).
    const present = new Set<number>();
    for (const { state } of input.players) {
      if (input.clientInfo(state.clientNum)) present.add(state.number);
    }
    // First, so that an entity arriving this frame can take what one leaving gives back.
    for (const [number, body] of this.bodies) {
      if (!present.has(number)) this.letGo(number, body);
    }

    const puffs: Vec3[] = [];
    /** The entities still drawn in their last look while they wait for their next. */
    const waiting = new Set<number>();
    for (const player of input.players) {
      const { state } = player;
      const info = input.clientInfo(state.clientNum);
      if (!info) continue;

      let body = this.bodies.get(state.number);
      if (body && !sameLook(body.look, info.look)) {
        body = this.redress(state.number, body, info.look, player.reset);
        if (this.dressing.has(state.number)) waiting.add(state.number);
      }
      body ??= this.place(state.number, info.look);
      const rig = body.dressed?.rig;
      if (!rig) continue;

      if (player.reset) rig.reset();
      this.posed.push(rig);
      const puff = rig.pose({
        origin: player.origin,
        angles: player.angles,
        legsAnim: state.legsAnim,
        torsoAnim: state.torsoAnim,
        // `BG_PlayerStateToEntityState` carries the move's direction in `angles2`'s yaw.
        movementDir: state.angles2.y,
        velocity: state.pos.trDelta,
        dead: (state.eFlags & EF_DEAD) !== 0,
        weapon: state.weapon as WeaponId,
        firing: (state.eFlags & EF_FIRING) !== 0,
        lastFireTime: player.flashTime,
        railFireTime: player.railFireTime,
        painTime: player.pain.time,
        painDirection: player.pain.direction,
        time: input.time,
        color: info.color1,
        // The entity's own mask is what cgame reads (`cent->currentState.powerups`).
        powerups: state.powerups,
        team: info.team,
        entity: packetEntity(state.number)
      });
      if (puff) puffs.push(puff);
    }

    for (const [number, next] of this.dressing) {
      if (waiting.has(number)) continue;
      this.dressing.delete(number);
      this.giveBack(next);
    }
    return puffs;
  }

  /** @returns once every body begun is built, and every one taken away is gone */
  async settled(): Promise<void> {
    await Promise.allSettled([
      ...[...this.pools.values()].flatMap((pool) => pool.bodies),
      ...this.leaving
    ]);
  }

  /** Take every body away as the match that placed them goes, giving back all they hold. */
  clear(): void {
    this.bodies.clear();
    this.dressing.clear();
    const pools = this.pools;
    this.pools = new Map();
    for (const pool of pools.values()) {
      for (const built of pool.bodies) this.track(built.then((dressed) => dressed?.rig.destroy()));
    }
  }

  /** Take every body away, giving back all they hold. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
    await Promise.allSettled([...this.leaving]);
  }

  /** Dress an entity in a look; it draws from the first frame it has a body. */
  private place(number: number, look: PlayerLook): Body {
    const body = this.take(look);
    this.bodies.set(number, body);
    return body;
  }

  /** A body in a look: a free one, or else the next of the look's to be built. */
  private take(look: PlayerLook): Body {
    const pool = this.pool(look);
    const dressed = pool.free.pop();
    const body: Body = { look, pool, dressed: dressed ?? null, ready: dressed !== undefined };
    if (body.ready) return body;
    pool.waiting.push(body);
    if (pool.waiting.length > pool.building) this.grow(pool);
    return body;
  }

  /**
   * The body to draw for an entity whose wearer's look has changed: the last one until the next is
   * in, unless the entity is brought into view afresh, and then the next.
   */
  private redress(number: number, body: Body, look: PlayerLook, afresh: boolean): Body {
    let next = this.dressing.get(number);
    if (next && !sameLook(next.look, look)) {
      this.dressing.delete(number);
      this.giveBack(next);
      next = undefined;
    }
    if (!next) {
      next = this.take(look);
      this.dressing.set(number, next);
    }
    if (!next.ready && !afresh && body.dressed) return body;
    this.dressing.delete(number);
    this.letGo(number, body);
    this.bodies.set(number, next);
    return next;
  }

  /** Stop drawing an entity's body, and give it back to its look's. */
  private letGo(number: number, body: Body): void {
    this.bodies.delete(number);
    this.giveBack(body);
  }

  /**
   * Give a body back to its look's, hidden, with every clock its entity ran it on cleared, so the
   * next to take it brings it into view afresh. One still waiting waits no more, and the body it
   * waited for is kept free as it lands.
   */
  private giveBack(body: Body): void {
    const { pool, dressed } = body;
    if (!body.ready) {
      pool.waiting.splice(pool.waiting.indexOf(body), 1);
      return;
    }
    if (!dressed) return;
    dressed.rig.clear();
    dressed.rig.root.enabled = false;
    pool.free.push(dressed);
  }

  /** Count a body as leaving until it has gone. */
  private track(gone: Promise<unknown>): void {
    this.leaving.add(gone);
    const forget = () => this.leaving.delete(gone);
    gone.then(forget, forget);
  }

  /** A look's bodies, begun with none where it has none yet. */
  private pool(look: PlayerLook): Pool {
    const key = lookKey(look);
    let pool = this.pools.get(key);
    if (!pool) {
      pool = {
        look,
        wears: null,
        registered: false,
        bodies: [],
        free: [],
        waiting: [],
        building: 0
      };
      this.pools.set(key, pool);
    }
    return pool;
  }

  /**
   * Build a body more of a look, hidden, for the first entity waiting or else kept free: the first
   * reads the look, and the rest are built of what it was built of. One whose match goes while it
   * builds is given back as it lands ({@link clear}).
   */
  private grow(pool: Pool): void {
    const first = pool.bodies[0];
    const built = first ? first.then(() => this.again(pool)) : this.dress(pool);
    pool.bodies.push(built);
    pool.building++;
    void built.then((dressed) => {
      pool.building--;
      if (dressed) dressed.rig.root.enabled = false;
      const body = pool.waiting.shift();
      if (body) {
        body.dressed = dressed;
        body.ready = true;
      } else if (dressed) {
        pool.free.push(dressed);
      }
    });
  }

  /**
   * A look's first body, in the look or in sarge's where it fails (`CG_LoadClientInfo`,
   * `cg_players.c:672–694`), saying so; `null` where even sarge's fails.
   */
  private async dress(pool: Pool): Promise<Dressed | null> {
    try {
      return this.wear(pool, pool.look, await this.rig(pool.look));
    } catch (error) {
      console.warn(`player: ${pool.look.body.model} unavailable; wearing ${DEFAULT_MODEL}:`, error);
    }
    try {
      return this.wear(pool, DEFAULT_LOOK, await this.rig(DEFAULT_LOOK));
    } catch (error) {
      console.warn(`player: no body for ${DEFAULT_MODEL}`, error);
      return null;
    }
  }

  /** A body more of what a look's first was built of, which is read and warmed by now. */
  private async again(pool: Pool): Promise<Dressed | null> {
    const { wears } = pool;
    if (!wears) return null;
    try {
      return this.wear(pool, wears, await this.rig(wears));
    } catch (error) {
      console.warn(`player: no body for ${wears.body.model}`, error);
      return null;
    }
  }

  /** A body of a pool's, built of a look, which its sounds are that look's model's. */
  private wear(pool: Pool, look: PlayerLook, rig: PlayerRig): Dressed {
    pool.wears = look;
    return { rig, voice: { model: look.body.model, footsteps: rig.config.footsteps } };
  }

  /** A body of a look, its models read first. */
  private async rig(look: PlayerLook): Promise<PlayerRig> {
    await loadLook(this.library, look);
    return PlayerRig.create(
      this.app,
      this.library,
      this.cache,
      look.body.model,
      look.body.skin,
      this.options,
      look.head
    );
  }
}
