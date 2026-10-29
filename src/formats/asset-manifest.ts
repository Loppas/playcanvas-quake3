import { mapConcurrent } from '../pak/concurrency';
import { BOTS_FILE } from '../sim/bots';
import { IT, ITEMS } from '../sim/items';
import { WP, type WeaponId } from '../sim/weapons/constants';
import { ARENAS_FILE } from './arena';
import { parseSkin } from './skin';

/**
 * The declarative asset manifest.
 *
 * `CG_RegisterWeapon` (`cgame/cg_weapons.c:606`) derives most of this from `bg_itemlist`
 * plus filename suffixes; we write it out instead, because the point of the manifest is to
 * be a *closed list*: the exact subset extracted from the paks, and the subset the browser keeps
 * of them, so a later visit needs no pk3 but its own.
 *
 * It names the weapons, the HUD's art, the gibs, and the player, menu and announcer sounds, and what
 * the skirmish pages read. The player models are the one part not written out: they are whatever
 * the paks hold, listed as q3_ui lists them, and each brings the files its skins name.
 *
 * Every path here was verified present in the retail pak set before being written down.
 */

/** Model, icon and sound paths for one weapon. */
export interface WeaponAssetSet {
  id: WeaponId;
  /** Directory stem under `models/weapons2/`, and the model file's own name. */
  dir: string;
  /** Icon under `icons/`, which does **not** always match {@link WeaponAssetSet.dir}. */
  icon: string;
  /** True when the weapon ships a `_barrel.md3` — only three do. */
  hasBarrel: boolean;
  /**
   * Fire sounds; one is chosen at random per shot. The machinegun has four, the grapple
   * has none (it fires silently), everything else has one.
   */
  fireSounds: string[];
  /**
   * Looping sounds — `readySound` and `firingSound` in `CG_RegisterWeapon`. The ready sound
   * loops while the weapon is held; the firing sound plays in its place while `EF_FIRING` is
   * set, for the two weapons that have one: the lightning gun, and the gauntlet, which has
   * no ready sound. The grapple has neither.
   */
  readySound?: string;
  firingSound?: string;
  /** Model the projectile draws as, for the weapons that fire one. */
  missileModel?: string;
  /** Looping sound attached to the projectile in flight. */
  missileFlySound?: string;
  /** Impact sounds, chosen at random. */
  impactSounds?: string[];
  /** Shader driving the impact effect, resolved against the shader scripts. */
  explosionShader?: string;
  /** Model drawn at the impact point alongside the explosion shader. */
  explosionModel?: string;
}

/** `models/weapons2/<dir>/<dir>.md3` and its siblings. */
export function weaponModelPath(dir: string, suffix = ''): string {
  return `models/weapons2/${dir}/${dir}${suffix}.md3`;
}

/**
 * Per-weapon assets, from the registration cases in `cg_weapons.c` and the media table in
 * `cg_main.c`.
 */
export const WEAPON_ASSETS: WeaponAssetSet[] = [
  {
    id: WP.GAUNTLET,
    dir: 'gauntlet',
    icon: 'icons/iconw_gauntlet',
    hasBarrel: true,
    fireSounds: ['sound/weapons/melee/fstatck.wav'],
    // `fstrun` while it attacks, and no ready sound, so no hum in the hand.
    firingSound: 'sound/weapons/melee/fstrun.wav'
  },
  {
    id: WP.MACHINEGUN,
    dir: 'machinegun',
    icon: 'icons/iconw_machinegun',
    hasBarrel: true,
    fireSounds: [
      'sound/weapons/machinegun/machgf1b.wav',
      'sound/weapons/machinegun/machgf2b.wav',
      'sound/weapons/machinegun/machgf3b.wav',
      'sound/weapons/machinegun/machgf4b.wav'
    ],
    impactSounds: [
      'sound/weapons/machinegun/ric1.wav',
      'sound/weapons/machinegun/ric2.wav',
      'sound/weapons/machinegun/ric3.wav'
    ],
    explosionShader: 'bulletExplosion',
    explosionModel: 'models/weaphits/bullet.md3'
  },
  {
    id: WP.SHOTGUN,
    dir: 'shotgun',
    icon: 'icons/iconw_shotgun',
    hasBarrel: false,
    fireSounds: ['sound/weapons/shotgun/sshotf1b.wav'],
    explosionShader: 'bulletExplosion',
    explosionModel: 'models/weaphits/bullet.md3'
  },
  {
    id: WP.GRENADE_LAUNCHER,
    dir: 'grenadel',
    icon: 'icons/iconw_grenade',
    hasBarrel: false,
    fireSounds: ['sound/weapons/grenade/grenlf1a.wav'],
    missileModel: 'models/ammo/grenade1.md3',
    impactSounds: ['sound/weapons/grenade/hgrenb1a.wav', 'sound/weapons/grenade/hgrenb2a.wav'],
    explosionShader: 'grenadeExplosion',
    explosionModel: 'models/weaphits/boom01.md3'
  },
  {
    id: WP.ROCKET_LAUNCHER,
    dir: 'rocketl',
    icon: 'icons/iconw_rocket',
    hasBarrel: false,
    fireSounds: ['sound/weapons/rocket/rocklf1a.wav'],
    missileModel: 'models/ammo/rocket/rocket.md3',
    missileFlySound: 'sound/weapons/rocket/rockfly.wav',
    impactSounds: ['sound/weapons/rocket/rocklx1a.wav'],
    explosionShader: 'rocketExplosion',
    explosionModel: 'models/weaphits/boom01.md3'
  },
  {
    id: WP.LIGHTNING,
    dir: 'lightning',
    icon: 'icons/iconw_lightning',
    hasBarrel: false,
    fireSounds: ['sound/weapons/lightning/lg_fire.wav'],
    // `fsthum` in the hand and `lg_hum` while firing — not the other way round.
    readySound: 'sound/weapons/melee/fsthum.wav',
    firingSound: 'sound/weapons/lightning/lg_hum.wav',
    impactSounds: [
      'sound/weapons/lightning/lg_hit.wav',
      'sound/weapons/lightning/lg_hit2.wav',
      'sound/weapons/lightning/lg_hit3.wav'
    ],
    explosionModel: 'models/weaphits/crackle.md3'
  },
  {
    id: WP.RAILGUN,
    dir: 'railgun',
    icon: 'icons/iconw_railgun',
    hasBarrel: false,
    fireSounds: ['sound/weapons/railgun/railgf1a.wav'],
    readySound: 'sound/weapons/railgun/rg_hum.wav',
    impactSounds: ['sound/weapons/plasma/plasmx1a.wav'],
    explosionShader: 'railExplosion',
    explosionModel: 'models/weaphits/ring02.md3'
  },
  {
    id: WP.PLASMAGUN,
    dir: 'plasma',
    icon: 'icons/iconw_plasma',
    hasBarrel: false,
    fireSounds: ['sound/weapons/plasma/hyprbf1a.wav'],
    // No missile model: the plasma ball is a pure sprite (`sprites/plasma1`, radius 16).
    missileFlySound: 'sound/weapons/plasma/lasfly.wav',
    impactSounds: ['sound/weapons/plasma/plasmx1a.wav'],
    explosionShader: 'plasmaExplosion',
    explosionModel: 'models/weaphits/ring02.md3'
  },
  {
    id: WP.BFG,
    dir: 'bfg',
    icon: 'icons/iconw_bfg',
    hasBarrel: true,
    fireSounds: ['sound/weapons/bfg/bfg_fire.wav'],
    readySound: 'sound/weapons/bfg/bfg_hum.wav',
    missileModel: 'models/weaphits/bfg.md3',
    missileFlySound: 'sound/weapons/rocket/rockfly.wav',
    impactSounds: ['sound/weapons/rocket/rocklx1a.wav'],
    explosionShader: 'bfgExplosion',
    explosionModel: 'models/weaphits/boom01.md3'
  },
  {
    id: WP.GRAPPLING_HOOK,
    dir: 'grapple',
    icon: 'icons/iconw_grapple',
    hasBarrel: false,
    // Silent, as CorkScrew's is: its `CG_RegisterWeapon` gives the hook no flash, ready
    // or firing sound. Vanilla's gives it the gauntlet's `fsthum` and `fstrun`, which only ever
    // play for a hook in the hand.
    fireSounds: []
    // No missile model: the hook is drawn as CorkScrew draws it, a rail-core pointer with a
    // flare at its end.
  }
];

/**
 * The sprites `CG_PlayerSprites` floats over a head besides the medals (`cg_main.c:861, 947, 974`):
 * connection trouble, the talk balloon, and a teammate's marker.
 */
export const SPRITE_SHADERS = {
  connection: 'disconnected',
  talk: 'sprites/balloon3',
  friend: 'sprites/foe'
} as const;

/** Media shared across weapons, rather than owned by any one of them. */
export const SHARED_ASSETS = {
  sounds: [
    'sound/weapons/change.wav',
    'sound/weapons/noammo.wav',
    // The jump pad's boing (`cgs.media.jumpPadSound`, `cg_main.c:612`).
    'sound/world/jumppad.wav',
    // A teleport's two ends (`cgs.media.teleInSound` and `teleOutSound`, `cg_main.c:640–641`).
    'sound/world/telein.wav',
    'sound/world/teleout.wav'
  ],
  /**
   * Models drawn in a shader of their own, which are files rather than models to the walk: their
   * surfaces name no shader to bring. The teleport's effect (`cg_main.c:984`).
   */
  models: ['models/misc/telep.md3'],
  /** Effect shaders the renderers ask for by name. */
  shaders: [
    'lightningBoltNew',
    'railCore',
    'railDisc',
    'gfx/misc/tracer',
    'sprites/plasma1',
    'smokePuff',
    // The bubbles a shot leaves under water (`cg_main.c:863`).
    'waterBubble',
    // Haste's trail (`cg_main.c:882`).
    'hasteSmokePuff',
    'shotgunSmokePuff',
    // The blood where a shot struck someone (`cg_main.c:976`).
    'bloodExplosion',
    // A teleport's effect, over its model (`cg_main.c:985`).
    'teleportEffect',
    // The grappling hook's flare, borrowed from the grate lamp as CorkScrew does.
    'models/mapobjects/gratelamp/gratelamp_flare',
    // The shells a held powerup draws over a body and its gun (`CG_AddRefEntityWithPowerups`,
    // `cg_main.c:876–881`); the red team's quad is the flag shader (`cg_main.c:948`).
    'powerups/quad',
    'powerups/quadWeapon',
    'powerups/battleSuit',
    'powerups/battleWeapon',
    'powerups/invisibility',
    'powerups/regen',
    'powerups/blueflag',
    ...Object.values(SPRITE_SHADERS)
  ]
} as const;

/** The status bar's digits, `sb_nums` (`cg_main.c:807–834`), 0 to 9 and then the minus sign. */
export const NUMBER_NAMES = [
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
];

/**
 * The ammo box the status bar spins in 3D for each gun, from `bg_itemlist` (`bg_misc.c:359–471`).
 */
export const AMMO_MODELS: ReadonlyMap<WeaponId, string> = new Map<WeaponId, string>(
  (
    [
      [WP.MACHINEGUN, 'machinegunam'],
      [WP.SHOTGUN, 'shotgunam'],
      [WP.GRENADE_LAUNCHER, 'grenadeam'],
      [WP.ROCKET_LAUNCHER, 'rocketam'],
      [WP.LIGHTNING, 'lightningam'],
      [WP.RAILGUN, 'railgunam'],
      [WP.PLASMAGUN, 'plasmaam'],
      [WP.BFG, 'bfgam']
    ] as const
  ).map(([weapon, name]) => [weapon, `models/powerups/ammo/${name}.md3`])
);

/** The armor the status bar spins in 3D (`cg_main.c:955`). */
export const ARMOR_MODEL = 'models/powerups/armor/armor_yel.md3';

/**
 * The items' own world models, as `CG_RegisterItemVisuals` registers them (`cg_main.c:1000–1012`).
 *
 * Every item's first model is what `CG_Item` draws; the second — the health's sphere and the
 * powerup's ring — is drawn only for those two kinds (`cg_ents.c:383–404`), so nothing else's
 * second model is needed. A weapon's first model is already loaded as its held model.
 */
export const ITEM_ASSETS = {
  models: [
    ...new Set(
      ITEMS.slice(1)
        .flatMap((item) => [
          item.worldModel[0],
          item.giType === IT.HEALTH || item.giType === IT.POWERUP ? item.worldModel[1] : null
        ])
        .filter((path): path is string => path !== null)
    )
  ],
  /** The 2D icons a pickup, a timer or the holdable draws (`CG_RegisterItemVisuals`). */
  shaders: ITEMS.slice(1).map((item) => item.icon),
  /**
   * The sounds an item makes: each table entry's own pickup sound, and the ones the client
   * supplies itself - an item's respawn, a powerup's arrival, a powerup's wear-off tick, the
   * three effects a held powerup makes (`cg_main.c:729, 757-758`), and the two a holdable's use
   * makes (`cg_main.c:617, 728`).
   */
  sounds: [
    ...new Set(
      ITEMS.slice(1)
        .map((item) => item.pickupSound)
        .filter((path): path is string => path !== null)
    ),
    'sound/items/respawn1.wav',
    'sound/items/wearoff.wav',
    'sound/items/poweruprespawn.wav',
    'sound/items/damage3.wav',
    'sound/items/protect3.wav',
    'sound/items/regen.wav',
    'sound/items/use_nothing.wav',
    'sound/items/use_medkit.wav'
  ]
};

/**
 * The six medals, by the shaders cgame registers them as (`cg_main.c:1003–1008`): the reward's
 * row at the top of the screen, and the sprite over an awarded head.
 */
export const MEDAL_SHADERS = {
  impressive: 'medal_impressive',
  excellent: 'medal_excellent',
  gauntlet: 'medal_gauntlet',
  defend: 'medal_defend',
  assist: 'medal_assist',
  capture: 'medal_capture'
} as const;

/**
 * The phone jack an interrupted connection blinks, which cgame registers by its image's name
 * (`cg_draw.c:1622`): no script names it, so it draws as any unscripted picture does.
 */
export const NET_SHADER = 'gfx/2d/net';

/** `lagometerShader` (`cg_main.c:860`): the lagometer's background, which its script names. */
export const LAGOMETER_SHADER = 'lagometer';

/**
 * `deferShader` (`cg_main.c:844`): the cross over the head of a client drawn in another's look,
 * which cgame registers by its image's name.
 */
export const DEFER_SHADER = 'gfx/2d/defer';

/**
 * `teamStatusBar` (`cg_main.c:949`): the band under the team chat box, drawn in a team's colour.
 */
export const TEAM_STATUS_BAR_SHADER = 'gfx/2d/colorbar.tga';

/**
 * The HUD's own art. Each 2D name is registered as `CG_RegisterGraphics` does,
 * scripted or not, so it brings whatever its script draws, or else the image of that name.
 */
export const HUD_ASSETS = {
  shaders: [
    ...NUMBER_NAMES.map((name) => `gfx/2d/numbers/${name}_32b`),
    // Crosshairs a–j, for `cg_drawCrosshair` (`cg_main.c:868–870`).
    ...[...'abcdefghij'].map((letter) => `gfx/2d/crosshair${letter}`),
    // The weapon bar's marker, and the characters the bar's weapon name, the fps counter
    // and the ammo warning are drawn in (`cg_main.c:866, 1862`).
    'gfx/2d/select',
    'gfx/2d/bigchars',
    'icons/noammo',
    // The 2D armor icon and the damage blend (`cg_main.c:842, 956`).
    'icons/iconr_yellow',
    'viewBloodBlend',
    // `redFlagShader` and `blueFlagShader` (`cg_main.c:898–903`): where each flag is, over its
    // score box. The first of each is the flag item's own icon and comes with the items; the
    // other two are the HUD's alone.
    ...['red2', 'red3', 'blu2', 'blu3'].map((name) => `icons/iconf_${name}`),
    ...Object.values(MEDAL_SHADERS),
    NET_SHADER,
    LAGOMETER_SHADER,
    DEFER_SHADER,
    TEAM_STATUS_BAR_SHADER
  ],
  /** The 3D icons: the armor (`cg_main.c:955`) and the eight ammo boxes. */
  models: [ARMOR_MODEL, ...AMMO_MODELS.values()]
};

/** `CG_GibPlayer`'s pieces (`cg_main.c:961–970`). */
const GIB_PIECES = [
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
];

/** The gibs: the pieces, the blood trail they leave, and their sounds (`cg_main.c:618–621`). */
export const GIB_ASSETS = {
  models: GIB_PIECES.map((piece) => `models/gibs/${piece}.md3`),
  shaders: ['bloodTrail'],
  sounds: [
    'sound/player/gibsplt1.wav',
    'sound/player/gibimp1.wav',
    'sound/player/gibimp2.wav',
    'sound/player/gibimp3.wav'
  ]
};

/**
 * The footstep sets, by the stem of their files (`footstep_t`, `cg_local.h:95–105`;
 * `cg_main.c:683–704`). An `animation.cfg` names one of the first five; a metal floor and the
 * water pick the last two, whatever the model.
 */
export const FOOTSTEP_SETS = {
  normal: 'step',
  boot: 'boot',
  flesh: 'flesh',
  mech: 'mech',
  energy: 'energy',
  metal: 'clank',
  splash: 'splash'
} as const;

/**
 * The player sounds no model owns: four of each footstep set, the short fall's land, the water's
 * three (`cg_main.c:677–679`), the two gurgles of a player hurt under water
 * (`cg_event.c:497–502`), and the fry in lava or slime, which every match names (`g_main.c:428`).
 */
export const PLAYER_SOUNDS = [
  ...Object.values(FOOTSTEP_SETS).flatMap((stem) =>
    [1, 2, 3, 4].map((i) => `sound/player/footsteps/${stem}${i}.wav`)
  ),
  'sound/player/land1.wav',
  'sound/player/watr_in.wav',
  'sound/player/watr_out.wav',
  'sound/player/watr_un.wav',
  'sound/player/gurp1.wav',
  'sound/player/gurp2.wav',
  'sound/player/fry.wav'
];

/** The menu's four sounds by their cues (`ui_qmenu.c:1764–1767`). */
export const MENU_SOUND_FILES = {
  in: 'sound/misc/menu1.wav',
  move: 'sound/misc/menu2.wav',
  out: 'sound/misc/menu3.wav',
  buzz: 'sound/misc/menu4.wav'
} as const;

/** The menu's four, in order: in, move, out and buzz. */
export const MENU_SOUNDS: string[] = Object.values(MENU_SOUND_FILES);

/**
 * The match's voices, the rewards', the hit beeps and chat's talk sound, as `CG_RegisterSounds`
 * registers them (`cg_main.c:550–610, 646–669`), each under the name cgame's media keeps it by.
 * All of them are played as local sounds: unplaced, at full volume, under `s_volume`. The capture's
 * reward is the same file as the team's capture news.
 *
 * `flagtaken_yourteam` and `flagtaken_opponent` are registered too, and never played.
 */
export const ANNOUNCER_SOUNDS = {
  oneMinute: 'sound/feedback/1_minute.wav',
  fiveMinute: 'sound/feedback/5_minute.wav',
  suddenDeath: 'sound/feedback/sudden_death.wav',
  oneFrag: 'sound/feedback/1_frag.wav',
  twoFrag: 'sound/feedback/2_frags.wav',
  threeFrag: 'sound/feedback/3_frags.wav',
  count3: 'sound/feedback/three.wav',
  count2: 'sound/feedback/two.wav',
  count1: 'sound/feedback/one.wav',
  countFight: 'sound/feedback/fight.wav',
  countPrepare: 'sound/feedback/prepare.wav',
  redLeads: 'sound/feedback/redleads.wav',
  blueLeads: 'sound/feedback/blueleads.wav',
  teamsTied: 'sound/feedback/teamstied.wav',
  hitTeam: 'sound/feedback/hit_teammate.wav',
  redScored: 'sound/teamplay/voc_red_scores.wav',
  blueScored: 'sound/teamplay/voc_blue_scores.wav',
  captureYourTeam: 'sound/teamplay/flagcapture_yourteam.wav',
  captureOpponent: 'sound/teamplay/flagcapture_opponent.wav',
  returnYourTeam: 'sound/teamplay/flagreturn_yourteam.wav',
  returnOpponent: 'sound/teamplay/flagreturn_opponent.wav',
  redFlagReturned: 'sound/teamplay/voc_red_returned.wav',
  blueFlagReturned: 'sound/teamplay/voc_blue_returned.wav',
  enemyTookYourFlag: 'sound/teamplay/voc_enemy_flag.wav',
  yourTeamTookEnemyFlag: 'sound/teamplay/voc_team_flag.wav',
  youHaveFlag: 'sound/teamplay/voc_you_flag.wav',
  talk: 'sound/player/talk.wav',
  hit: 'sound/feedback/hit.wav',
  takenLead: 'sound/feedback/takenlead.wav',
  tiedLead: 'sound/feedback/tiedlead.wav',
  lostLead: 'sound/feedback/lostlead.wav',
  captureAward: 'sound/teamplay/flagcapture_yourteam.wav',
  impressive: 'sound/feedback/impressive.wav',
  excellent: 'sound/feedback/excellent.wav',
  humiliation: 'sound/feedback/humiliation.wav',
  defend: 'sound/feedback/defense.wav',
  assist: 'sound/feedback/assist.wav',
  denied: 'sound/feedback/denied.wav',
  holyShit: 'sound/feedback/voc_holyshit.wav'
} as const;

/** The picture for a map with no levelshot (`GAMESERVER_UNKNOWNMAP`, `ui_startserver.c:45`). */
export const UNKNOWN_MAP = 'menu/art/unknownmap';

/**
 * What the skirmish pages read besides the game's assets:
 * - the arena and bot files, each kind as one file read first, then every
 *   `scripts/*<extension>` (`ui_gameinfo.c:168–198`, `g_bot.c:932–965`);
 * - each arena's levelshot, under this folder;
 * - the picture for a map with none.
 */
export const MENU_FILES = {
  infos: [
    { file: ARENAS_FILE, extension: '.arena' },
    { file: BOTS_FILE, extension: '.bot' }
  ],
  levelshots: 'levelshots/',
  unknownMap: UNKNOWN_MAP
} as const;

/** Q3's default model, and the fallback for a model that fails and for missing sounds. */
export const DEFAULT_MODEL = 'sarge';

/** A player model's parts (`cg_players.c:533–570`). Their LODs are left out. */
export const PLAYER_PARTS = ['lower', 'upper', 'head'] as const;

/** `cg_customSoundNames` (`cg_players.c:26–40`): a model's own sounds, sarge's where it lacks one. */
export const CUSTOM_SOUNDS = [
  'death1',
  'death2',
  'death3',
  'jump1',
  'pain25_1',
  'pain50_1',
  'pain75_1',
  'pain100_1',
  'falling1',
  'gasp',
  'drown',
  'fall1',
  'taunt'
] as const;

/** `MAX_PLAYERMODELS` (`ui_playermodel.c:57`): the model page lists no more than this. */
export const MAX_PLAYERMODELS = 256;

/** A model and one of its skins, as the model page lists them. */
export interface PlayerModelSkin {
  model: string;
  skin: string;
}

/** A model's folder: `models/players/<model>/`. */
export function playerModelDir(model: string): string {
  return `models/players/${model}/`;
}

/**
 * Each folder under `models/players/`, with the skins its icons name: every `icon_<skin>.tga`
 * directly inside it, as q3_ui's `PlayerModel_BuildList` looks for them
 * (`ui_playermodel.c:388–449`). A skin with no icon, such as pak2's `tim/red`, has no entry;
 * cgame refuses it too (`cg_players.c:602–611`).
 *
 * q3_ui finds the folders by their directory entries, which the port's paks do not keep, so a
 * folder takes the place of its first file instead. Both come in search order. q3_ui's
 * 2048-byte listing buffers are not reproduced.
 *
 * @param names every path under `models/players/`, in search order
 */
export function playerModelFolders(names: readonly string[]): Map<string, string[]> {
  const folders = new Map<string, string[]>();
  for (const name of names) {
    const [top, players, model, file, ...deeper] = name.split('/');
    if (top !== 'models' || players !== 'players' || !model || !file || deeper.length) continue;
    let skins = folders.get(model);
    if (!skins) folders.set(model, (skins = []));
    if (file.startsWith('icon_') && file.endsWith('.tga')) {
      skins.push(file.slice('icon_'.length, -'.tga'.length));
    }
  }
  return folders;
}

/**
 * The models and skins the model page offers: {@link playerModelFolders}, flattened, and
 * stopped at {@link MAX_PLAYERMODELS} as q3_ui's list stops. The cap is the menu's alone; cgame
 * loads any model by name.
 *
 * @param names every path under `models/players/`, in search order
 */
export function listPlayerModels(names: readonly string[]): PlayerModelSkin[] {
  const list: PlayerModelSkin[] = [];
  for (const [model, skins] of playerModelFolders(names)) {
    for (const skin of skins) list.push({ model, skin });
  }
  return list.slice(0, MAX_PLAYERMODELS);
}

/** Everything the manifest resolved, plus anything it could not find. */
export interface ManifestResolution {
  /** Pak paths to extract, deduplicated and sorted. */
  files: string[];
  /** Manifest entries with no matching pak file — a broken or partial install. */
  missing: string[];
}

/**
 * What {@link resolveManifest} uses of a mounted file system: lookups by name, which are
 * immediate, and reads, which are not. `PakFileSystem` fits it as it is; the narrow shape lets
 * extraction put a memo in front of the reads.
 */
export interface ManifestFiles {
  has(path: string): boolean;
  list(prefix: string, extension?: string): string[];
  resolveImage(reference: string): string | undefined;
  read(path: string): Promise<Uint8Array | undefined>;
}

/** What the manifest walk asks for, one callback per kind of requirement. */
interface ManifestVisitor {
  /** A file that must exist as named: a sound. */
  file(path: string): void;
  /** An image, found through the extension fallback: an icon. */
  image(reference: string): void;
  /** A model, which brings in every texture its surfaces name. */
  model(path: string): void;
  /** An effect shader, which brings in every image its stages draw. */
  shader(name: string): void;
}

/** Walk the manifest in its fixed order, reporting each requirement to `visit`. */
function walkManifest(visit: ManifestVisitor): void {
  for (const weapon of WEAPON_ASSETS) {
    visit.model(weaponModelPath(weapon.dir));
    visit.model(weaponModelPath(weapon.dir, '_flash'));
    // The hand rig is tags only but still has to be loaded — it drives the viewmodel.
    visit.model(weaponModelPath(weapon.dir, '_hand'));
    if (weapon.hasBarrel) visit.model(weaponModelPath(weapon.dir, '_barrel'));

    visit.image(weapon.icon);
    for (const sound of weapon.fireSounds) visit.file(sound);
    for (const sound of weapon.impactSounds ?? []) visit.file(sound);
    if (weapon.readySound) visit.file(weapon.readySound);
    if (weapon.firingSound) visit.file(weapon.firingSound);
    if (weapon.missileFlySound) visit.file(weapon.missileFlySound);
    if (weapon.missileModel) visit.model(weapon.missileModel);
    if (weapon.explosionModel) visit.model(weapon.explosionModel);
    if (weapon.explosionShader) visit.shader(weapon.explosionShader);
  }

  for (const sound of SHARED_ASSETS.sounds) visit.file(sound);
  for (const model of SHARED_ASSETS.models) visit.file(model);
  for (const shader of SHARED_ASSETS.shaders) visit.shader(shader);

  for (const shader of HUD_ASSETS.shaders) visit.shader(shader);
  for (const model of HUD_ASSETS.models) visit.model(model);

  for (const model of ITEM_ASSETS.models) visit.model(model);
  for (const shader of ITEM_ASSETS.shaders) visit.shader(shader);
  for (const sound of ITEM_ASSETS.sounds) visit.file(sound);

  for (const model of GIB_ASSETS.models) visit.model(model);
  for (const shader of GIB_ASSETS.shaders) visit.shader(shader);
  for (const sound of GIB_ASSETS.sounds) visit.file(sound);

  for (const sound of PLAYER_SOUNDS) visit.file(sound);
  for (const sound of MENU_SOUNDS) visit.file(sound);
  for (const sound of Object.values(ANNOUNCER_SOUNDS)) visit.file(sound);
}

/**
 * Walk the manifest against a mounted file system and produce the exact extraction list:
 * every model, every texture those models reference, every icon and every sound.
 *
 * Textures come from two places — the shader names embedded in each MD3 surface, and the
 * stages of the effect shaders — and both go through the pak's extension fallback, because
 * a great many are named `.tga` but ship as `.jpg`.
 *
 * Only the models are read, for their surfaces' shader names, and they are read first, several
 * at a time; the rest of the walk only asks what exists.
 *
 * @param fs the mounted paks
 * @param parseMd3Shaders pulls surface shader names out of an MD3; injected so this module
 *   stays free of the parser and can be tested with a stub
 * @param resolveShaderMaps returns the texture references an effect shader draws
 * @param players the player models and skins to bring as well ({@link resolvePlayerModels})
 * @param concurrency reads in flight at once
 */
export async function resolveManifest(
  fs: ManifestFiles,
  parseMd3Shaders: (bytes: Uint8Array, label: string) => string[],
  resolveShaderMaps: (shaderName: string) => string[],
  players: readonly PlayerModelSkin[] = [],
  concurrency = 8
): Promise<ManifestResolution> {
  const models: string[] = [];
  walkManifest({ file() {}, image() {}, model: (path) => models.push(path), shader() {} });
  const toRead = [...new Set(models)].filter((path) => fs.has(path));
  const modelBytes = new Map(
    (await mapConcurrent(toRead, concurrency, (path) => fs.read(path))).map((bytes, i) => [
      toRead[i],
      bytes
    ])
  );

  const files = new Set<string>();
  const missing: string[] = [];

  /** Add an image by reference, following the tga->jpg fallback. */
  const requireImage = (reference: string) => {
    const resolved = fs.resolveImage(reference);
    if (resolved) files.add(resolved);
    else missing.push(reference);
  };

  // Shader scripts are small and are needed in full: the renderer resolves names against
  // the whole pool, exactly as R_FindShader does.
  for (const script of fs.list('scripts/', 'shader')) files.add(script);

  walkManifest({
    // Add a pak path if it exists, else record it as missing.
    file(path) {
      if (fs.has(path)) files.add(path.toLowerCase());
      else missing.push(path);
    },
    image: requireImage,
    // Add a model and every texture its surfaces name.
    model(path) {
      const bytes = modelBytes.get(path);
      if (!bytes) {
        missing.push(path);
        return;
      }
      files.add(path.toLowerCase());
      for (const shaderName of parseMd3Shaders(bytes, path)) {
        for (const map of resolveShaderMaps(shaderName)) requireImage(map);
      }
    },
    shader(name) {
      for (const map of resolveShaderMaps(name)) requireImage(map);
    }
  });

  const bodies = await resolvePlayerModels(fs, players, resolveShaderMaps, concurrency);
  for (const path of bodies.files) files.add(path);
  return { files: [...files].sort(), missing: [...new Set([...missing, ...bodies.missing])] };
}

/**
 * The files some player models need: each model's parts, `animation.cfg` and own sounds,
 * and for each of its skins the three `.skin` files, the icon, and every texture the skins name,
 * found through the shader scripts as `R_FindShader` finds them. A sound the model lacks is not
 * missing: sarge's stands in (`cg_players.c:705–722`).
 *
 * The skins are read, several at a time; everything else is only looked up.
 *
 * @param players the models and skins to bring, from {@link listPlayerModels}
 * @param resolveShaderMaps returns the texture references a shader draws
 * @param concurrency reads in flight at once
 */
export async function resolvePlayerModels(
  fs: ManifestFiles,
  players: readonly PlayerModelSkin[],
  resolveShaderMaps: (shaderName: string) => string[],
  concurrency = 8
): Promise<ManifestResolution> {
  const skinPaths = [
    ...new Set(
      players.flatMap(({ model, skin }) =>
        PLAYER_PARTS.map((part) => `${playerModelDir(model)}${part}_${skin}.skin`)
      )
    )
  ].filter((path) => fs.has(path));
  const skinTexts = new Map<string, string | undefined>(
    (await mapConcurrent(skinPaths, concurrency, (path) => fs.read(path))).map((bytes, i) => [
      skinPaths[i],
      bytes && new TextDecoder().decode(bytes)
    ])
  );

  const files = new Set<string>();
  const missing: string[] = [];
  const requireFile = (path: string) => {
    if (fs.has(path)) files.add(path.toLowerCase());
    else missing.push(path);
  };
  const requireImage = (reference: string) => {
    const resolved = fs.resolveImage(reference);
    if (resolved) files.add(resolved);
    else missing.push(reference);
  };

  const models = new Set<string>();
  for (const { model, skin } of players) {
    const dir = playerModelDir(model);
    if (!models.has(model)) {
      models.add(model);
      for (const part of PLAYER_PARTS) requireFile(`${dir}${part}.md3`);
      requireFile(`${dir}animation.cfg`);
      for (const sound of CUSTOM_SOUNDS) {
        const path = `sound/player/${model}/${sound}.wav`;
        if (fs.has(path)) files.add(path);
      }
    }
    requireFile(`${dir}icon_${skin}.tga`);
    for (const part of PLAYER_PARTS) {
      const path = `${dir}${part}_${skin}.skin`;
      const text = skinTexts.get(path);
      if (text === undefined) {
        missing.push(path);
        continue;
      }
      files.add(path);
      for (const { shader } of parseSkin(text)) {
        // An empty name draws the default shader, which has nothing to extract.
        if (shader) for (const map of resolveShaderMaps(shader)) requireImage(map);
      }
    }
  }
  return { files: [...files].sort(), missing: [...new Set(missing)] };
}
