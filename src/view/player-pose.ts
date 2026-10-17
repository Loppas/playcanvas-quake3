import { lerpTag, type Md3Model } from '../formats/md3';
import { anglesToAxis, type Axis } from './hand-pose';
import type { FrameBlend, PlayerAxes } from './player-animation';
import { IDENTITY_AXIS, matrixMultiply } from './q-math';

/**
 * Where each piece of a player hangs: the tag chain of `CG_Player` and `CG_AddPlayerWeapon`
 * (`cg_players.c:2319–2590`, `cg_weapons.c:1251–1334`).
 *
 * The legs sit at the entity's origin. The torso hangs on their `tag_torso`, the head and the
 * weapon on the torso's `tag_head` and `tag_weapon`, and the barrel and flash on the weapon's own
 * tags. Every tag is read between its parent's two frames, so a child follows its parent's
 * animation blend. Everything here is in Quake units, in the frame the legs are placed in; the rig
 * turns each result into one entity's transform.
 */

/** A model's place: Q3's `refEntity_t` origin and axis. */
export interface Placement {
  origin: [number, number, number];
  axis: Axis;
}

/** A placed model and the frames it shows, so whatever hangs off its tags follows its animation. */
export interface PosedModel extends Placement, FrameBlend {
  model: Md3Model;
}

/**
 * The parent's tag between its two frames, as both tag helpers read it: `R_LerpTag` at
 * `1 − backlerp`. A tag the model lacks is the identity at the origin (`tr_model.c:1046–1050`).
 */
function tagOf(parent: PosedModel, tagName: string): Placement {
  return (
    lerpTag(parent.model, tagName, parent.oldFrame, parent.frame, 1 - parent.backlerp) ?? {
      origin: [0, 0, 0],
      axis: IDENTITY_AXIS
    }
  );
}

/** The parent's origin moved along its own axes by the tag's offset (`cg_ents.c:46–49`). */
function originOn(parent: Placement, offset: readonly number[]): [number, number, number] {
  const { origin, axis } = parent;
  return [0, 1, 2].map(
    (i) => origin[i] + offset[0] * axis[0][i] + offset[1] * axis[1][i] + offset[2] * axis[2][i]
  ) as [number, number, number];
}

/**
 * `CG_PositionEntityOnTag` (`cg_ents.c:36–54`): at the parent's tag, turned as the tag is. The
 * world weapon is placed by the same arithmetic (`cg_weapons.c:1251–1265`).
 */
export function positionEntityOnTag(parent: PosedModel, tagName: string): Placement {
  const tag = tagOf(parent, tagName);
  return { origin: originOn(parent, tag.origin), axis: matrixMultiply(tag.axis, parent.axis) };
}

/**
 * `CG_PositionRotatedEntityOnTag` (`cg_ents.c:65–85`): at the parent's tag, with the child's own
 * turn applied inside the tag's frame: `child × tag × parent`.
 *
 * @param axis - The child's own axis, measured in the tag's frame.
 */
export function positionRotatedEntityOnTag(
  axis: Axis,
  parent: PosedModel,
  tagName: string
): Placement {
  const tag = tagOf(parent, tagName);
  return {
    origin: originOn(parent, tag.origin),
    axis: matrixMultiply(matrixMultiply(axis, tag.axis), parent.axis)
  };
}

/** A player model's three parts. */
export interface PlayerModels {
  lower: Md3Model;
  upper: Md3Model;
  head: Md3Model;
}

/** A player's three parts, placed. */
export interface PlayerPose {
  legs: PosedModel;
  torso: PosedModel;
  head: PosedModel;
}

/**
 * Hang the three parts as `CG_Player` does (`cg_players.c:2319–2579`).
 *
 * @param origin - `cent->lerpOrigin`: the player's origin, 24 units above the feet.
 * @param axes - From `playerAngles`.
 * @param frames - From `playerAnimation`. The head always shows its frame 0.
 */
export function posePlayer(
  models: PlayerModels,
  origin: readonly [number, number, number],
  axes: PlayerAxes,
  frames: { legs: FrameBlend; torso: FrameBlend }
): PlayerPose {
  const legs: PosedModel = { model: models.lower, origin: [...origin], axis: axes.legs, ...frames.legs };
  const torso: PosedModel = {
    model: models.upper,
    ...positionRotatedEntityOnTag(axes.torso, legs, 'tag_torso'),
    ...frames.torso
  };
  const head: PosedModel = {
    model: models.head,
    ...positionRotatedEntityOnTag(axes.head, torso, 'tag_head'),
    oldFrame: 0,
    frame: 0,
    backlerp: 0
  };
  return { legs, torso, head };
}

/** The world weapon and what hangs off it. */
export interface WeaponPose {
  /** Frame 0 of the weapon, carrying the torso's `backlerp` as Q3 copies it. */
  gun: PosedModel;
  barrel: Placement | null;
  flash: Placement | null;
}

/**
 * Hang the world weapon on the torso as `CG_AddPlayerWeapon` does for a body seen from outside
 * (`cg_weapons.c:1251–1334`): the gun on `tag_weapon`, the barrel on the gun's `tag_barrel`
 * rolled by its spin, and the flash on its `tag_flash` rolled at random.
 *
 * @param barrelRoll - The barrel's spin in degrees, or `null` for a weapon with no barrel.
 * @param flashRoll - The flash's roll in degrees, or `null` while no flash shows.
 */
export function poseWeapon(
  torso: PosedModel,
  weapon: Md3Model,
  barrelRoll: number | null,
  flashRoll: number | null
): WeaponPose {
  const gun: PosedModel = {
    model: weapon,
    ...positionEntityOnTag(torso, 'tag_weapon'),
    oldFrame: 0,
    frame: 0,
    backlerp: torso.backlerp
  };
  const rolled = (roll: number | null, tag: string) =>
    roll === null ? null : positionRotatedEntityOnTag(anglesToAxis(0, 0, roll), gun, tag);
  return { gun, barrel: rolled(barrelRoll, 'tag_barrel'), flash: rolled(flashRoll, 'tag_flash') };
}
