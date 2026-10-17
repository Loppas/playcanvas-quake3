/**
 * Quake 3's draw order for a map's whole scene, as one number a draw sorts by.
 *
 * Q3 sorts every surface of a view by one key (`R_AddDrawSurf`, `tr_main.c:1100-1113`): its
 * shader's place among the sorted shaders, then the entity it was added for, then its fog and
 * whether a dynamic light touches it. ioquake3's radix sort is stable, so equal keys keep the order
 * they were added in, and a run of one key is drawn stage by stage over all its surfaces
 * (`RB_RenderDrawSurfList`, `tr_backend.c:503-681`). Depth plays no part.
 *
 * Here the key is a whole number below 2^53, which a double holds exactly, so a layer that sorts by
 * hand orders the scene by it: the place, the entity, the fog and the dlight bit in Q3's order, and
 * below them a draw's step within its key, where Q3 has the order its batch draws in.
 *
 * Q3 numbers an entity as it is added (`RE_AddRefEntityToScene`), in the order cgame adds them
 * (`CG_DrawActiveFrame`, `cg_view.c:812-822`): the damage blob, the predicted player, the
 * snapshot's entities by number, the local entities oldest first, then the view weapon. The world's
 * surfaces and the polys are `REFENTITYNUM_WORLD`, after every entity. Here an entity's number is
 * made from what orders it, wide enough that one entity's parts keep their order: two draws compare
 * by entity only where their shader is the same, so only the order matters.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `MAX_SHADERS` (`tr_local.h:813`): the places a shader can take. */
export const MAX_SHADER_PLACES = 1 << 14;

/** Bits of each field, from the top: the place, the entity, the fog, the dlight bit, the step. */
const ENTITY_BITS = 17;
const FOG_BITS = 5;
const STEP_BITS = 16;

const ENTITY_SPAN = 2 ** ENTITY_BITS;
const FOG_SPAN = 2 ** (FOG_BITS + 1);
const STEP_SPAN = 2 ** STEP_BITS;

/** The last step a key holds. */
export const MAX_STEP = STEP_SPAN - 1;

/** How many parts an entity's number leaves room for: its models, shells and sprites, in order. */
export const ENTITY_PARTS = 32;

/** `CG_DamageBlendBlob`'s sprite, the first entity a view adds. */
export const BLOB_ENTITY = 0;

/** Where the local entities start: after the predicted player and every entity a snapshot holds. */
export const LOCAL_ENTITY_BASE = (1024 + 2) * ENTITY_PARTS;
/** How many local entities keep their order before their numbers come round again. */
const LOCAL_SERIALS = 1 << 14;
/** A local entity's parts. */
const LOCAL_PARTS = 4;
/** Where the view weapon's parts start: after every local entity. */
const VIEW_WEAPON_BASE = LOCAL_ENTITY_BASE + LOCAL_SERIALS * LOCAL_PARTS;

/** `REFENTITYNUM_WORLD`: the world's surfaces and the polys, after every entity. */
export const WORLD_ENTITY = ENTITY_SPAN - 1;

/**
 * The place the screen's own passes take, after every shader: the hyperspace grey, then the ramp.
 */
const SCREEN_PLACE = MAX_SHADER_PLACES - 1;

/**
 * A snapshot's entity, or the predicted player, as cgame adds its parts.
 *
 * @param number - Its entity number; the predicted player, which `CG_AddPacketEntities` adds
 *   before them all, is -1.
 * @param part - Which of the entity's refEntities, in the order cgame adds them.
 */
export function packetEntity(number: number, part = 0): number {
  return (number + 2) * ENTITY_PARTS + Math.min(part, ENTITY_PARTS - 1);
}

/** The predicted player, which `CG_AddPacketEntities` adds first (`cg_ents.c:1055-1061`). */
export function predictedEntity(part = 0): number {
  return packetEntity(-1, part);
}

/**
 * A local entity, by when it was made: `CG_AddLocalEntities` adds the oldest first
 * (`cg_localents.c:807-813`). Its serial comes round every {@link LOCAL_SERIALS}, and for a frame
 * two entities either side of that turn draw in the other order.
 *
 * @param serial - A count of the local entities made, this one's.
 * @param part - Which of its refEntities.
 */
export function localEntity(serial: number, part = 0): number {
  const at = (serial % LOCAL_SERIALS) * LOCAL_PARTS;
  return LOCAL_ENTITY_BASE + at + Math.min(part, LOCAL_PARTS - 1);
}

/**
 * A player's parts, as `CG_Player` adds them (`cg_players.c:2285-2416`): the sprite over their head
 * first, then the legs, the torso and the head, each followed by its shells
 * (`CG_AddRefEntityWithPowerups`: the quad's, regeneration's and the battle suit's, a part each),
 * the gun, its barrel and its flash, each followed by theirs (`CG_AddWeaponWithPowerups`), the
 * lightning with its crackle, and the flag they carry.
 */
export const PLAYER_PART = {
  sprite: 0,
  legs: 1,
  torso: 5,
  head: 9,
  gun: 13,
  barrel: 16,
  flash: 19,
  bolt: 20,
  crackle: 21,
  flag: 22,
  hook: 23
} as const;

/** The view weapon's own parts (`CG_AddViewWeapon`, `cg_weapons.c:1362-1452`), shells as above. */
export const VIEW_WEAPON_PART = { gun: 0, barrel: 3, flash: 6, bolt: 7, crackle: 8 } as const;

/** The view weapon's parts, which `CG_AddViewWeapon` adds last of all (`cg_view.c:822`). */
export function viewWeaponEntity(part = 0): number {
  return VIEW_WEAPON_BASE + Math.min(part, ENTITY_PARTS - 1);
}

/**
 * A draw's key: where Q3's sort puts it, and its step within the key.
 *
 * @param place - Its shader's `sortedIndex`.
 * @param entity - Its entity's number, as made above, or {@link WORLD_ENTITY}.
 * @param fog - Its fog as the key holds it: 0 for none, else the fog's number plus one.
 * @param dlight - Whether a dynamic light touches it, as the key's last bit.
 * @param step - Its place among the draws of its key.
 */
export function sceneKey(
  place: number,
  entity: number,
  fog: number,
  dlight: boolean,
  step: number
): number {
  const shader = Math.min(place, SCREEN_PLACE - 1);
  const keyed = (shader * ENTITY_SPAN + entity) * FOG_SPAN + fog * 2 + (dlight ? 1 : 0);
  return keyed * STEP_SPAN + step;
}

/** A key after every shader's: the screen's own passes, by `slot` and `step`. */
function screenKey(slot: number, step: number): number {
  return (SCREEN_PLACE * ENTITY_SPAN + slot) * FOG_SPAN * STEP_SPAN + step;
}

/** The hyperspace grey: after the scene, under the ramp. */
export const HYPERSPACE_KEY = screenKey(0, 0);

/**
 * A view weapon's draw on a hyperspace frame, which Q3 draws over the grey as it draws nothing
 * else: after the grey, in the order its key would have had among the gun's draws.
 *
 * @param place - Its shader's `sortedIndex`.
 * @param part - Its part of the view weapon.
 * @param step - Its step among its part's draws of its shader.
 */
export function overHyperspaceKey(place: number, part: number, step: number): number {
  return screenKey(1 + Math.min(place, SCREEN_PLACE - 1), part * 512 + Math.min(step, 511));
}

/** The ramp's passes, the `pass`th of them: the last of the scene's draws. */
export function rampKey(pass: number): number {
  return screenKey(ENTITY_SPAN - 1, pass);
}

/** A view weapon's part, from its entity's number. */
export function viewWeaponPart(entity: number): number {
  return entity - VIEW_WEAPON_BASE;
}

/**
 * A draw's step within its key, for a model: its stage, then its surface, so one entity's surfaces
 * of a shader draw stage by stage, as one batch of them does.
 *
 * @param stage - The stage's place in its shader.
 * @param surface - The surface's place in its model.
 */
export function modelStep(stage: number, surface: number): number {
  return stage * 64 + Math.min(surface, 63);
}
