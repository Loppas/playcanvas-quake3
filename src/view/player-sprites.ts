import { MEDAL_SHADERS, SPRITE_SHADERS } from '../formats/asset-manifest';
import {
  EF_AWARD_ASSIST,
  EF_AWARD_CAP,
  EF_AWARD_DEFEND,
  EF_AWARD_EXCELLENT,
  EF_AWARD_GAUNTLET,
  EF_AWARD_IMPRESSIVE,
  EF_CONNECTION,
  EF_DEAD,
  EF_TALK,
  GT
} from '../sim/constants';
import { vec3, type Vec3 } from '../sim/vec3';
import type { Rgba } from './hud-status';

/**
 * `CG_PlayerSprites` (`cg_players.c:1941–1993`): the one sprite floating over a player's head —
 * connection trouble, the talk balloon, an award's medal, or a teammate's marker. Engine-free.
 */

/** A sprite in the world, turned to face the view: an `RT_SPRITE` refEntity. */
export interface FloatSprite {
  shader: string;
  /** Its middle, in Quake units. */
  origin: Vec3;
  /** Half its width, which is Q3's `radius`. */
  radius: number;
  /** `shaderRGBA`, which only a stage that takes the vertex colour reads. */
  color: Rgba;
  /** Its entity's number in a map's scene (`scene-sort.ts`), as cgame adds it. */
  order: number;
}

/** `CG_PlayerFloatSprite` (`cg_players.c:1908–1929`): 48 units over the origin, radius 10. */
export const PLAYER_SPRITE_HEIGHT = 48;
export const PLAYER_SPRITE_RADIUS = 10;

const WHITE: Rgba = [1, 1, 1, 1];

/** The awards in the order `CG_PlayerSprites` asks after them, the first found being drawn. */
const AWARDS: readonly (readonly [number, string])[] = [
  [EF_AWARD_IMPRESSIVE, MEDAL_SHADERS.impressive],
  [EF_AWARD_EXCELLENT, MEDAL_SHADERS.excellent],
  [EF_AWARD_GAUNTLET, MEDAL_SHADERS.gauntlet],
  [EF_AWARD_DEFEND, MEDAL_SHADERS.defend],
  [EF_AWARD_ASSIST, MEDAL_SHADERS.assist],
  [EF_AWARD_CAP, MEDAL_SHADERS.capture]
];

/** What the viewer brings to the choice: their side, the mode, and `cg_drawFriend`. */
export interface SpriteViewer {
  /** `cg.snap->ps.persistant[PERS_TEAM]`. */
  team: number;
  gametype: number;
  drawFriend: boolean;
}

/**
 * The sprite over one player's head, or `null` for none.
 *
 * @param eFlags - The player's entity flags, as their entity state carries them.
 * @param team - Their side, from their clientinfo.
 */
export function playerSprite(eFlags: number, team: number, viewer: SpriteViewer): string | null {
  if (eFlags & EF_CONNECTION) return SPRITE_SHADERS.connection;
  if (eFlags & EF_TALK) return SPRITE_SHADERS.talk;
  for (const [award, shader] of AWARDS) {
    if (eFlags & award) return shader;
  }
  // A teammate who is alive, in a team game — which the viewer's own body is too, seen from behind.
  if (!(eFlags & EF_DEAD) && viewer.team === team && viewer.gametype >= GT.TEAM) {
    return viewer.drawFriend ? SPRITE_SHADERS.friend : null;
  }
  return null;
}

/** `CG_PlayerFloatSprite`: the sprite placed over a player drawn at `origin`. */
export function playerFloatSprite(shader: string, origin: Vec3, order: number): FloatSprite {
  return {
    shader,
    origin: vec3(origin.x, origin.y, origin.z + PLAYER_SPRITE_HEIGHT),
    radius: PLAYER_SPRITE_RADIUS,
    color: WHITE,
    order
  };
}
