import { GT } from '../sim/constants';
import { IT, ITEMS } from '../sim/items';
import { WP } from '../sim/weapons/constants';
import {
  LIGHTMAP_2D,
  LIGHTMAP_NONE,
  type WorldShader,
  type WorldShaders
} from './world-shaders';

/**
 * Every shader a map's scene draws, in the one order Quake 3 sorts them by.
 *
 * Q3 keeps its shaders sorted by their sort, and among one sort by when each was made
 * (`SortNewShader`, `tr_shader.c:2005-2027`). A map's load starts the list again: the world's
 * shaders first (`R_LoadShaders`), then cgame's, as `CG_RegisterGraphics` registers its media, the
 * map's items and their weapons, the server's models, then `CG_RegisterClients` the players'
 * looks (`cg_main.c:822-1150`), and later whatever is registered as it is first needed: a weapon
 * not on the map when it is first drawn (`CG_RegisterWeapon`), a player's look at their info. So
 * two effects of one sort overlap as they were registered, never by distance.
 *
 * Here cgame's registrations join the world's own registry (`world-shaders.ts`), for their places
 * alone: the port draws them from its own stages. A draw holds a {@link SortedShader} for the name
 * and lightmap index it was registered at, which finds its shader in the map's registry the first
 * time the draw is keyed there, registering it then as a first use does. A shader cgame registers
 * through `trap_R_RegisterShader` is made at `LIGHTMAP_2D`, and a model's or a skin's at
 * `LIGHTMAP_NONE` (`tr_shader.c`, `tr_model.c:485`), so one name can be two shaders, each with its
 * own place.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** A shader a draw draws, found in each map's registry by its name and lightmap index. */
export interface SortedShader {
  readonly name: string;
  readonly lightmapIndex: number;
  /** Its shader in the registry it was last found in. */
  shader: WorldShader | null;
  /** Which binding it was found in: a later one finds it again. */
  bound: number;
}

/** Where the registrations read the shaders a model or a skin names. */
export interface SceneShaderSources {
  /** The shaders an MD3's surfaces name, surface by surface, or none where the file is missing. */
  modelShaders(path: string): Promise<readonly string[] | null>;
  /** The shaders a `.skin` names, pair by pair, or none where the file is missing. */
  skinShaders(path: string): Promise<readonly string[] | null>;
}

/** What `CG_RegisterGraphics` reads from the gamestate. */
export interface GraphicsState {
  /** `cgs.gametype`. */
  gametype: number;
  /** `CS_ITEMS`: a `1` at each table slot the level uses. */
  items: string;
  /** `CS_MODELS` from the first: the models the server registered, inline ones as `*<n>`. */
  models: readonly string[];
}

/** The model files a client's look is made of, in the order `CG_RegisterClientModelname` reads. */
export interface LookFiles {
  /** Its legs', torso's and head's MD3s. */
  models: readonly string[];
  /** Its legs', torso's and head's skins. */
  skins: readonly string[];
}

/** `MD3_MAX_LODS` (`qfiles.h:203`). */
const MD3_MAX_LODS = 3;

/** `sb_nums` (`cg_main.c:826-838`). */
const NUMBER_SHADERS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'minus'
].map((digit) => `gfx/2d/numbers/${digit}_32b`);

/** `NUM_CROSSHAIRS` (`cg_local.h:46`). */
const NUM_CROSSHAIRS = 10;

/** A registration in `CG_RegisterGraphics`' list: a shader by its name, or a model's file. */
type Registration = readonly ['shader' | 'model', string];

const shader = (name: string): Registration => ['shader', name];
const model = (path: string): Registration => ['model', path];

/** `CG_RegisterGraphics`' media, up to the flags (`cg_main.c:861-901`), baseq3's build. */
const MEDIA: readonly Registration[] = [
  ...NUMBER_SHADERS.map(shader),
  ...[1, 2, 3, 4, 5].map((skill) => shader(`menu/art/skill${skill}.tga`)),
  shader('viewBloodBlend'),
  shader('gfx/2d/defer.tga'),
  shader('menu/tab/name.tga'),
  shader('menu/tab/ping.tga'),
  shader('menu/tab/score.tga'),
  shader('menu/tab/time.tga'),
  shader('smokePuff'),
  shader('smokePuffRagePro'),
  shader('shotgunSmokePuff'),
  shader('sprites/plasma1'),
  shader('bloodTrail'),
  shader('lagometer'),
  shader('disconnected'),
  shader('waterBubble'),
  shader('gfx/misc/tracer'),
  shader('gfx/2d/select'),
  ...Array.from({ length: NUM_CROSSHAIRS }, (_, i) =>
    shader(`gfx/2d/crosshair${String.fromCharCode(97 + i)}`)
  ),
  shader('gfx/2d/backtile'),
  shader('icons/noammo'),
  shader('powerups/quad'),
  shader('powerups/quadWeapon'),
  shader('powerups/battleSuit'),
  shader('powerups/battleWeapon'),
  shader('powerups/invisibility'),
  shader('powerups/regen'),
  shader('hasteSmokePuff')
];

/** Capture the Flag's flags and their icons (`cg_main.c:903-913`). */
const FLAGS: readonly Registration[] = [
  model('models/flags/r_flag.md3'),
  model('models/flags/b_flag.md3'),
  ...['red1', 'red2', 'red3', 'blu1', 'blu2', 'blu3'].map((icon) => shader(`icons/iconf_${icon}`))
];

/** A team game's (`cg_main.c:953-960`). */
const TEAM: readonly Registration[] = [
  shader('sprites/foe'),
  shader('powerups/blueflag'),
  shader('gfx/2d/colorbar.tga')
];

/** The rest of the media, up to the items (`cg_main.c:962-1006`). */
const MORE_MEDIA: readonly Registration[] = [
  model('models/powerups/armor/armor_yel.md3'),
  shader('icons/iconr_yellow'),
  model('models/weapons2/shells/m_shell.md3'),
  model('models/weapons2/shells/s_shell.md3'),
  ...[
    'abdomen',
    'arm',
    'chest',
    'fist',
    'foot',
    'forearm',
    'intestine',
    'leg',
    'skull',
    'brain'
  ].map((piece) => model(`models/gibs/${piece}.md3`)),
  model('models/weapons2/shells/s_shell.md3'),
  shader('sprites/balloon3'),
  shader('bloodExplosion'),
  model('models/weaphits/bullet.md3'),
  model('models/weaphits/ring02.md3'),
  model('models/weaphits/boom01.md3'),
  model('models/misc/telep.md3'),
  shader('teleportEffect'),
  ...['impressive', 'excellent', 'gauntlet', 'defend', 'assist', 'capture'].map((medal) =>
    shader(`medal_${medal}`)
  )
];

/** The wall marks, after the items (`cg_main.c:1024-1031`). */
const MARKS: readonly Registration[] = [
  'gfx/damage/bullet_mrk',
  'gfx/damage/burn_med_mrk',
  'gfx/damage/hole_lg_mrk',
  'gfx/damage/plasma_mrk',
  'markShadow',
  'wake',
  'bloodMark'
].map(shader);

/** `CG_RegisterWeapon`'s own media, weapon by weapon, after its models (`cg_weapons.c:653-814`). */
const WEAPON_MEDIA: ReadonlyMap<number, readonly Registration[]> = new Map([
  [WP.LIGHTNING, [shader('lightningBoltNew'), model('models/weaphits/crackle.md3')]],
  [WP.GRAPPLING_HOOK, [model('models/ammo/rocket/rocket.md3'), shader('lightningBoltNew')]],
  [WP.MACHINEGUN, [shader('bulletExplosion')]],
  [WP.ROCKET_LAUNCHER, [model('models/ammo/rocket/rocket.md3'), shader('rocketExplosion')]],
  [WP.GRENADE_LAUNCHER, [model('models/ammo/grenade1.md3'), shader('grenadeExplosion')]],
  [WP.PLASMAGUN, [shader('plasmaExplosion'), shader('railDisc')]],
  [WP.RAILGUN, [shader('railExplosion'), shader('railDisc'), shader('railCore')]],
  [WP.BFG, [shader('bfgExplosion'), model('models/weaphits/bfg.md3')]]
]);

/** The hand a weapon without one of its own is held by (`cg_weapons.c:704-706`). */
const DEFAULT_HAND = 'models/weapons2/shotgun/shotgun_hand.md3';

/** A name as `R_FindShader` compares it: its extension stripped, in lower case. */
function shaderKey(name: string, lightmapIndex: number): string {
  const dot = name.lastIndexOf('.');
  const slash = name.lastIndexOf('/');
  const stripped = dot > slash ? name.slice(0, dot) : name;
  return `${stripped.toLowerCase()}@${lightmapIndex}`;
}

/** A path without its extension, as `COM_StripExtension` leaves it. */
function stripExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
}

/** The shaders of a map's scene, in Q3's order: the world's, cgame's, and those first drawn. */
export class SceneShaders {
  private registry: WorldShaders | null = null;
  /** Counts the registries bound, so a shader found in an earlier one is found again. */
  private binding = 0;
  private readonly handles = new Map<string, SortedShader>();
  /** `itemInfo->registered` and `weaponInfo->registered`, for the registry bound. */
  private readonly items = new Set<number>();
  private readonly weapons = new Set<number>();

  /**
   * The shaders' registry for a map's load, its world's alone in it: cgame's registrations start
   * again, as a new `CG_Init`'s do. None while no map's world is drawn.
   */
  bind(registry: WorldShaders | null): void {
    this.registry = registry;
    this.binding++;
    this.items.clear();
    this.weapons.clear();
  }

  /** Counts the times a place may have moved: a registry bound, or a shader sorted into it. */
  get generation(): number {
    return this.binding * 2 ** 20 + (this.registry?.generation ?? 0);
  }

  /**
   * The shader a draw draws, by its name and the lightmap index it is registered at: a model's or a
   * skin's at `LIGHTMAP_NONE`, one cgame registers by name at `LIGHTMAP_2D`. One handle a name and
   * index, for every draw of it.
   */
  handle(name: string, lightmapIndex = LIGHTMAP_NONE): SortedShader {
    const key = shaderKey(name, lightmapIndex);
    let found = this.handles.get(key);
    if (!found) {
      found = { name, lightmapIndex, shader: null, bound: 0 };
      this.handles.set(key, found);
    }
    return found;
  }

  /**
   * A shader's place in the order, its `sortedIndex`: registered now where the map's registry has
   * not yet seen it, as a shader first drawn is. 0 with no registry bound.
   */
  place(handle: SortedShader): number {
    const { registry } = this;
    if (!registry) return 0;
    if (handle.bound !== this.binding || !handle.shader) {
      handle.shader = registry.register(handle.name, handle.lightmapIndex, true);
      handle.bound = this.binding;
    }
    return handle.shader.sortedIndex;
  }

  /** `trap_R_RegisterShader`, at `LIGHTMAP_2D`. */
  registerShader(name: string): void {
    this.registry?.register(name, LIGHTMAP_2D, true);
  }

  /**
   * `RE_RegisterModel` for an MD3: each level of detail's file it finds, the coarsest first, as
   * `R_RegisterMD3` reads them (`tr_model.c:131-207`), each surface's shaders registered in turn.
   *
   * @returns whether it found a file
   */
  async registerModel(path: string, sources: SceneShaderSources): Promise<boolean> {
    if (!this.registry || path === '' || path.startsWith('*')) return false;
    let found = false;
    const base = stripExtension(path);
    const extension = path.slice(base.length);
    for (let lod = MD3_MAX_LODS - 1; lod >= 0; lod--) {
      const file = lod > 0 ? `${base}_${lod}${extension}` : path;
      const shaders = await sources.modelShaders(file);
      if (!shaders) continue;
      found = true;
      for (const name of shaders) this.registry?.register(name, LIGHTMAP_NONE, true);
    }
    return found;
  }

  /** `RE_RegisterSkin`: its shaders in the file's order (`tr_image.c:1562-1611`). */
  async registerSkin(path: string, sources: SceneShaderSources): Promise<void> {
    if (!this.registry) return;
    if (!path.toLowerCase().endsWith('.skin')) {
      this.registry.register(path, LIGHTMAP_NONE, true);
      return;
    }
    for (const name of (await sources.skinShaders(path)) ?? []) {
      this.registry?.register(name, LIGHTMAP_NONE, true);
    }
  }

  /**
   * `CG_RegisterGraphics` after the world: its media, the flags and the team's in the games that
   * have them, the items the level uses with their weapons, the marks, and the server's models.
   */
  async registerGraphics(state: GraphicsState, sources: SceneShaderSources): Promise<void> {
    const { gametype } = state;
    await this.registerAll(MEDIA, sources);
    if (gametype === GT.CTF) await this.registerAll(FLAGS, sources);
    if (gametype >= GT.TEAM) await this.registerAll(TEAM, sources);
    await this.registerAll(MORE_MEDIA, sources);
    for (let slot = 1; slot < ITEMS.length; slot++) {
      if (state.items[slot] === '1') await this.registerItemVisuals(slot, sources);
    }
    await this.registerAll(MARKS, sources);
    for (const path of state.models) await this.registerModel(path, sources);
  }

  /** `CG_RegisterItemVisuals` (`cg_weapons.c:827-862`), once a map for each item. */
  async registerItemVisuals(slot: number, sources: SceneShaderSources): Promise<void> {
    if (this.items.has(slot) || !ITEMS[slot]) return;
    this.items.add(slot);
    const item = ITEMS[slot];
    await this.registerModel(item.worldModel[0] ?? '', sources);
    this.registerShader(item.icon);
    if (item.giType === IT.WEAPON) await this.registerWeapon(item.giTag, sources);
    const second = item.worldModel[1];
    const accompanied =
      item.giType === IT.POWERUP ||
      item.giType === IT.HEALTH ||
      item.giType === IT.ARMOR ||
      item.giType === IT.HOLDABLE;
    if (accompanied && second) await this.registerModel(second, sources);
  }

  /**
   * `CG_RegisterWeapon` (`cg_weapons.c:606-815`), once a map for each weapon: its item's visuals,
   * its models, its ammo's, its flash, barrel and hand, then its own media.
   */
  async registerWeapon(weapon: number, sources: SceneShaderSources): Promise<void> {
    if (weapon === WP.NONE || this.weapons.has(weapon)) return;
    this.weapons.add(weapon);
    const slot = ITEMS.findIndex(
      (item, i) => i > 0 && item.giType === IT.WEAPON && item.giTag === weapon
    );
    if (slot < 0) return;
    await this.registerItemVisuals(slot, sources);
    const item = ITEMS[slot];
    const path = item.worldModel[0] ?? '';
    await this.registerModel(path, sources);
    this.registerShader(item.icon);
    this.registerShader(item.icon);
    const ammo = ITEMS.find((it, i) => i > 0 && it.giType === IT.AMMO && it.giTag === weapon);
    if (ammo?.worldModel[0]) await this.registerModel(ammo.worldModel[0], sources);
    const base = stripExtension(path);
    await this.registerModel(`${base}_flash.md3`, sources);
    await this.registerModel(`${base}_barrel.md3`, sources);
    if (!(await this.registerModel(`${base}_hand.md3`, sources))) {
      await this.registerModel(DEFAULT_HAND, sources);
    }
    await this.registerAll(WEAPON_MEDIA.get(weapon) ?? [], sources);
  }

  /**
   * `CG_RegisterClientModelname` (`cg_players.c:522-614`) for a look: its legs', torso's and
   * head's models, then their skins.
   */
  async registerLook(files: LookFiles, sources: SceneShaderSources): Promise<void> {
    for (const path of files.models) await this.registerModel(path, sources);
    for (const path of files.skins) await this.registerSkin(path, sources);
  }

  private async registerAll(
    registrations: readonly Registration[],
    sources: SceneShaderSources
  ): Promise<void> {
    for (const [kind, name] of registrations) {
      if (kind === 'shader') this.registerShader(name);
      else await this.registerModel(name, sources);
    }
  }
}
