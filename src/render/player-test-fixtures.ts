import type { Entity } from 'playcanvas';

import { AssetLibrary } from '../formats/asset-library';
import { buildMd3 } from '../formats/md3-test-fixtures';
import { ANIM } from '../sim/animations';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import type { PlayerRig, PlayerRigState } from './player-rig';

/**
 * A synthetic player model and what it is drawn from, for tests of the bodies on the null device.
 */

/** A 2×2 white TGA, top-left origin. */
export function whiteTga(): Uint8Array {
  const header = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 32, 0x28];
  return new Uint8Array([...header, ...new Array(2 * 2 * 4).fill(255)]);
}

/** A text file's bytes. */
export const encode = (text: string) => new TextEncoder().encode(text);

/**
 * Two scripted skin shaders in the shapes the retail skins use: a lit white base under a blended,
 * scrolling texture, as xaero's; and a rippling layer under a lit, blended skin, as krusade's.
 * The machinegun's flash moves up and down by a deform and pivots to face the viewer, which no
 * retail flash does.
 */
const SHADERS = `
models/players/test/glow
{
  { map $whiteimage rgbGen lightingDiffuse }
  { map models/players/test/skin.tga blendFunc blend tcMod scroll 0.5 0
    }
}
models/players/test/fire
{
  { map models/players/test/skin.tga tcMod turb 0 0.25 0 0.5
    }
  { map models/players/test/skin.tga blendFunc blend rgbGen lightingDiffuse }
}
models/weapons2/machinegun/flash
{
  deformVertexes move 0 0 1 sin 0 1 0 1
  deformVertexes autoSprite2
  { map models/weapons2/machinegun/flash.tga blendFunc add }
}
models/weapons2/railgun/rail
{
  { map models/weapons2/railgun/rail.tga rgbGen lightingDiffuse }
  { map models/weapons2/railgun/rail.tga blendfunc add rgbGen entity }
  { map models/weapons2/railgun/rail.tga blendfunc add tcGen environment }
}
powerups/quad
{
  deformVertexes wave 100 sin 3 0 0 0
  { map models/players/test/skin.tga blendfunc add tcGen environment tcMod rotate 30
    }
}
powerups/quadWeapon
{
  deformVertexes wave 100 sin 0.5 0 0 0
  { map models/players/test/skin.tga blendfunc add tcGen environment tcMod scroll 1 0.1
    }
}
powerups/battleSuit
{
  { map models/players/test/skin.tga blendfunc add tcGen environment }
}
powerups/battleWeapon
{
  { map models/players/test/skin.tga blendfunc add tcGen environment }
}
powerups/regen
{
  { map models/players/test/skin.tga blendfunc add tcGen environment }
}
powerups/invisibility
{
  { map models/players/test/skin.tga blendfunc add tcGen environment }
}
powerups/blueflag
{
  { map models/players/test/skin.tga blendfunc add tcGen environment }
}
`;

/**
 * Every row two frames at 20 fps, from frame 0: no skip, and every part plays 0 to 1. Its feet are
 * boots, which are not the default set.
 */
const ROWS = Array.from({ length: 25 }, () => '0\t2\t2\t20').join('\n');
const CONFIG = `sex m\nfootsteps boot\n${ROWS}\n`;

/**
 * A model named `test` with one skin, `default`: legs whose tag_torso rises from 10 to 12, a torso
 * with its head 16 above it and the weapon 6 ahead, and a head named in capitals, as a custom
 * model might, which the skin names in lower case. And a machinegun, with its barrel, its flash and
 * the hand that holds it on screen; and a railgun, with its hand, whose one surface draws three
 * stages as the railgun's and the BFG's do: lit, in the entity's colour, and mirroring.
 *
 * @param models - The models the library holds, each built as `test` is under its own name and
 *   wearing `test`'s textures and shaders. `test` alone by default.
 */
export function playerLibrary(models: readonly string[] = ['test']): AssetLibrary {
  const dir = 'models/players/test/';
  const gun = 'models/weapons2/machinegun/';
  const rail = 'models/weapons2/railgun/';
  return new AssetLibrary(
    new Map([
      ['scripts/test.shader', encode(SHADERS)],
      [`${dir}band.tga`, whiteTga()],
      [`${dir}skin.tga`, whiteTga()],
      ...models.flatMap((model) => modelFiles(`models/players/${model}/`, dir)),
      [`${gun}mg.tga`, whiteTga()],
      [`${gun}flash.tga`, whiteTga()],
      [
        `${gun}machinegun.md3`,
        buildMd3({
          tags: { tag_barrel: [{ origin: [8, 0, 0] }], tag_flash: [{ origin: [20, 0, 1] }] },
          surfaces: [{ name: 'w_mg', shader: `${gun}mg.tga` }]
        })
      ],
      [`${gun}machinegun_barrel.md3`, buildMd3({ surfaces: [{ name: 'b_mg', shader: `${gun}mg.tga` }] })],
      [`${gun}machinegun_flash.md3`, buildMd3({ surfaces: [{ name: 'f_mg', shader: `${gun}flash` }] })],
      [`${gun}machinegun_hand.md3`, buildMd3({ tags: { tag_weapon: [{ origin: [-10, -5, -9] }] } })],
      [`${rail}rail.tga`, whiteTga()],
      [
        `${rail}railgun.md3`,
        buildMd3({
          tags: { tag_flash: [{ origin: [24, 0, 2] }] },
          surfaces: [{ name: 'w_rail', shader: `${rail}rail.tga` }]
        })
      ],
      [`${rail}railgun_hand.md3`, buildMd3({ tags: { tag_weapon: [{ origin: [-10, -5, -9] }] } })]
    ])
  );
}

/**
 * A library that has `test` and `sarge` already and reads `grunt` from the paks when asked, as the
 * boot brings the chosen model and sarge and leaves every other to be read when it is named.
 */
export function fetchingPlayerLibrary(): { library: AssetLibrary; fetched: string[] } {
  const full = playerLibrary(['test', 'sarge', 'grunt']);
  const inFolder = (model: string) => ([path]: [string, Uint8Array]) =>
    path.startsWith(`models/players/${model}/`);
  const fetched: string[] = [];
  const library = new AssetLibrary(
    new Map([...full.files].filter((entry) => !inFolder('grunt')(entry))),
    {
      fetchPlayerModel: async (model) => {
        fetched.push(model);
        return { files: new Map([...full.files].filter(inFolder(model))), missing: [] };
      }
    }
  );
  return { library, fetched };
}

/**
 * One model's own files: its parts, its `default` skins and its `animation.cfg`.
 *
 * @param dir - The model's folder.
 * @param art - The folder its skins take their textures and shaders from.
 */
function modelFiles(dir: string, art: string): [string, Uint8Array][] {
  return [
    [`${dir}animation.cfg`, encode(CONFIG)],
    [
      `${dir}lower.md3`,
      buildMd3({
        frames: 2,
        tags: { tag_torso: [{ origin: [0, 0, 10] }, { origin: [0, 0, 12] }] },
        surfaces: [{ name: 'l_legs' }]
      })
    ],
    [
      `${dir}upper.md3`,
      buildMd3({
        frames: 2,
        tags: {
          tag_head: [{ origin: [0, 0, 16] }, { origin: [0, 0, 16] }],
          tag_weapon: [{ origin: [6, -4, 0] }, { origin: [6, -4, 0] }]
        },
        surfaces: [{ name: 'u_torso' }]
      })
    ],
    [`${dir}head.md3`, buildMd3({ surfaces: [{ name: 'H_Head' }] })],
    [`${dir}lower_default.skin`, encode(`tag_torso,\nl_legs,${art}band.tga\n`)],
    [`${dir}upper_default.skin`, encode(`tag_head,\ntag_weapon,\nu_torso,${art}glow\n`)],
    [`${dir}head_default.skin`, encode(`h_head,${art}fire\n`)]
  ];
}

/** Standing idle at the origin, looking along +X, 1.05 s in. */
export function rigState(overrides: Partial<PlayerRigState> = {}): PlayerRigState {
  return {
    origin: vec3(),
    angles: vec3(),
    legsAnim: ANIM.LEGS_IDLE,
    torsoAnim: ANIM.TORSO_STAND,
    movementDir: 0,
    velocity: vec3(),
    dead: false,
    weapon: WP.NONE,
    firing: false,
    lastFireTime: Number.NEGATIVE_INFINITY,
    time: 1050,
    ...overrides
  };
}

/**
 * The powerup shells a body shows, by name, sorted, once for each shown. Every shell hangs on the
 * body's root, named `<shader>/<piece>`, so each gun's are named alike.
 */
export function shownShells(rig: PlayerRig): string[] {
  return rig.root
    .find((node) => node.name.startsWith('powerups/') && (node as Entity).enabled)
    .map((node) => node.name)
    .sort();
}
