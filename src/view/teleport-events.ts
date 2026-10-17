/**
 * What a teleport looks and sounds like to every client: `CG_EntityEvent`'s
 * `EV_PLAYER_TELEPORT_IN` and `OUT` (`cg_event.c:885–895`). Each end plays its sound from the
 * event and spawns `CG_SpawnEffect`'s model (`cg_effects.c:172–202`): a shape of light fading out
 * over half a second, a little below where the player was or now is. A spawn into the world and a
 * departure from the game raise the same two.
 */

/** `cgs.media.teleInSound` (`cg_main.c:640`): a player arriving. */
export const TELE_IN_SOUND = 'sound/world/telein.wav';

/** `cgs.media.teleOutSound` (`cg_main.c:641`): a player leaving. */
export const TELE_OUT_SOUND = 'sound/world/teleout.wav';

/** `cgs.media.teleportEffectModel` (`cg_main.c:984`). */
export const TELEPORT_EFFECT_MODEL = 'models/misc/telep.md3';

/** `cgs.media.teleportEffectShader` (`cg_main.c:985`), which every surface of the model draws. */
export const TELEPORT_EFFECT_SHADER = 'teleportEffect';

/** How long the effect is drawn, in milliseconds (`cg_effects.c:180`). */
export const TELEPORT_EFFECT_MS = 500;

/** How far below the event the model stands, in units (`cg_effects.c:200`). */
export const TELEPORT_EFFECT_DROP = 24;

/**
 * `LE_FADE_RGB` (`CG_AddFadeRGB`, `cg_localents.c`): the effect's colour at `elapsed` ms, from
 * white down to black, which its additive shader takes as a fade.
 */
export function teleportEffectFade(elapsed: number): number {
  return (TELEPORT_EFFECT_MS - elapsed) / TELEPORT_EFFECT_MS;
}
