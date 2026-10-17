import type { Footsteps } from '../formats/animation-config';
import { DEFAULT_MODEL } from '../formats/asset-manifest';
import { GT, TEAM } from '../sim/constants';

/**
 * The player's look: the model their body wears and the one their head does,
 * each with one of its skins, as cgame reads `model` and `headmodel` into a client's info.
 * Engine-free.
 */

/** A model and one of its skins. */
export interface ModelSkin {
  model: string;
  skin: string;
}

/**
 * The body's model and skin, and the head's: `clientInfo_t`'s `modelName`, `skinName`,
 * `headModelName` and `headSkinName`.
 */
export interface PlayerLook {
  body: ModelSkin;
  head: ModelSkin;
}

/**
 * What a body sounds like, as `CG_LoadClientInfo` loads it (`cg_players.c:652–734`): its model's
 * own sounds, which are sarge's for a look that failed, and the footsteps that model's
 * `animation.cfg` names.
 */
export interface Voice {
  model: string;
  footsteps: Footsteps;
}

/** `CG_LoadClientInfo`'s look for one that fails: sarge's default skin, body and head (`cg_players.c:689`). */
export const DEFAULT_LOOK: PlayerLook = {
  body: { model: DEFAULT_MODEL, skin: 'default' },
  head: { model: DEFAULT_MODEL, skin: 'default' }
};

/**
 * `CG_NewClientInfo`'s reading of `model` or `hmodel` (`cg_players.c:981–991, 1025–1035`): the
 * model's name, then its skin after a slash, or "default" without one.
 */
export function readModel(value: string): ModelSkin {
  const slash = value.indexOf('/');
  return slash < 0
    ? { model: value, skin: 'default' }
    : { model: value.slice(0, slash), skin: value.slice(slash + 1) };
}

/**
 * The look `model` and `headmodel` give. A head with no model wears the body's, in the head's own
 * skin (`CG_RegisterClientModelname`, `cg_players.c:527–532`).
 */
export function playerLook(model: string, headModel: string): PlayerLook {
  const body = readModel(model);
  const head = readModel(headModel);
  return { body, head: head.model === '' ? { ...head, model: body.model } : head };
}

/**
 * The skin a side wears in a team game, as `CG_FindClientModelFile` and `CG_FindClientHeadFile`
 * pick one (`cg_players.c:317–331`, `:392–406`): blue for blue, and red for everyone else — a
 * spectator watching a team game among them, which is what Q3's `default:` leaves them.
 */
export function teamSkin(team: number): string {
  return team === TEAM.BLUE ? 'blue' : 'red';
}

/**
 * A look as a team game dresses it: the chosen models in the side's own colours.
 *
 * Quake 3 keeps the chosen skin on the client's info and swaps it in as each file is looked for,
 * trying `lower_<skin>_<team>.skin` before `lower_<team>.skin` (`cg_players.c:334–365`). No
 * retail model carries the first, so every one of them lands on the second — the plain `red` and
 * `blue` skins pak0 ships for each. The same goes for the head and for the icon the HUD and the
 * scoreboard draw, which are looked up the same way (`:602–607`).
 *
 * @param gametype - `cgs.gametype`; below `GT_TEAM` the look is worn as chosen.
 * @param team - the wearer's own side, `ci->team`.
 */
export function teamLook(look: PlayerLook, gametype: number, team: number): PlayerLook {
  if (gametype < GT.TEAM) return look;
  const skin = teamSkin(team);
  return { body: { ...look.body, skin }, head: { ...look.head, skin } };
}

/** Whether two looks wear the same models and skins. */
export function sameLook(a: PlayerLook, b: PlayerLook): boolean {
  return (
    a.body.model === b.body.model &&
    a.body.skin === b.body.skin &&
    a.head.model === b.head.model &&
    a.head.skin === b.head.skin
  );
}
