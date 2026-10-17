import { Color, type StandardMaterial } from 'playcanvas';

import type { ShaderStage } from '../formats/shader-script';
import { LIGHT_HEADROOM } from '../view/entity-light';
import { framebufferGain, overbrightFactor, rendererStyle, stageGain } from '../view/overbright';

/**
 * The colour a model's or an effect's stage is drawn at, in the basis its material draws in: its
 * brightness on screen (`stageGain`), or in a map's scene what `opengl1` writes into its
 * framebuffer (`framebufferGain`), which the ramp then multiplies with the world's. A material's
 * colour is kept as it was last given, so a change of basis, at a map's load, gives it again.
 */

/** What a stage's colour depends on. */
type GainStage = Pick<ShaderStage, 'rgbGen' | 'rgbWave' | 'blend' | 'blendFactors'>;

const WHITE = [1, 1, 1] as const;

/**
 * The materials drawn in a map's scene, which draw what `opengl1` writes into its framebuffer
 * (`framebufferGain`) for the ramp to multiply back up, where every other draws its brightness on
 * screen (`stageGain`).
 */
const inFramebuffer = new WeakSet<StandardMaterial>();

/** How a material's colour was last given, for a change of basis to give it again. */
interface GainRecipe {
  /** The stage it plays; none for a colour of the port's own, which shows as given on screen. */
  animation: GainStage | null;
  seconds: number;
  brightness: number;
  lit: boolean;
  color: [number, number, number];
}
const recipes = new WeakMap<StandardMaterial, GainRecipe>();

/** Scratch for a colour a recipe gives. */
const recipeColor = new Color();

/** Whether a material draws in a map's scene, at the framebuffer's values. */
export function drawsInFramebuffer(material: StandardMaterial): boolean {
  return inFramebuffer.has(material);
}

/**
 * Draw a material at the framebuffer's values, in a map's scene, or at its brightness on screen,
 * and give it its colour again in that basis, as it was last given.
 */
export function setFramebuffer(material: StandardMaterial, drawn: boolean): void {
  if (drawn === inFramebuffer.has(material)) return;
  if (drawn) inFramebuffer.add(material);
  else inFramebuffer.delete(material);
  const recipe = recipes.get(material);
  if (!recipe) return;
  material.emissive = recipeColor.set(...recipeGain(material, recipe));
  material.update();
}

/** Scratch for {@link recipeGain}. */
const gained: [number, number, number] = [0, 0, 0];

/** A recipe's colour in the basis its material draws in. */
function recipeGain(material: StandardMaterial, recipe: GainRecipe): [number, number, number] {
  const framebuffer = inFramebuffer.has(material);
  const { animation, seconds, brightness, lit, color } = recipe;
  let gain: number;
  if (!animation) gain = framebuffer ? 1 / overbrightFactor(rendererStyle()) : 1;
  else if (framebuffer) gain = framebufferGain(animation, seconds);
  else gain = stageGain(animation, seconds) * (lit ? LIGHT_HEADROOM : 1);
  gain *= brightness;
  gained[0] = gain * color[0];
  gained[1] = gain * color[1];
  gained[2] = gain * color[2];
  return gained;
}

/** Write how a material's colour is given into its recipe, made the first time. */
function record(
  material: StandardMaterial,
  animation: GainRecipe['animation'],
  seconds: number,
  brightness: number,
  lit: boolean,
  color: readonly [number, number, number]
): GainRecipe {
  let recipe = recipes.get(material);
  if (!recipe) {
    recipe = { animation, seconds, brightness, lit, color: [color[0], color[1], color[2]] };
    recipes.set(material, recipe);
    return recipe;
  }
  recipe.animation = animation;
  recipe.seconds = seconds;
  recipe.brightness = brightness;
  recipe.lit = lit;
  recipe.color[0] = color[0];
  recipe.color[1] = color[1];
  recipe.color[2] = color[2];
  return recipe;
}

/** What multiplies a stage's colour, as a play gives it. */
export interface GainOptions {
  /** Scales the colour. */
  brightness?: number;
  /** Its colour is its vertex colours, the entity's shade. */
  lit?: boolean;
  /** Multiplies it channel by channel. */
  color?: readonly [number, number, number];
}

/**
 * The colour a play gives a material at `seconds`, in the basis it draws in, kept as its colour
 * last given. The array is scratch, overwritten by the next call.
 */
export function gainOf(
  material: StandardMaterial,
  animation: GainStage,
  seconds: number,
  brightness: number,
  lit: boolean,
  color: readonly [number, number, number]
): readonly [number, number, number] {
  return recipeGain(material, record(material, animation, seconds, brightness, lit, color));
}

/**
 * Give a material a stage's colour that stays as given: its brightness, in the basis it draws in,
 * times `brightness` and `color`, as `animateEffect` gives one that plays. Kept, so a change
 * of basis gives it again.
 *
 * @param animation - The stage; none for a colour of the port's own, which shows on screen as it
 *   is given.
 */
export function setGain(
  material: StandardMaterial,
  animation: GainRecipe['animation'],
  { brightness = 1, lit = false, color = WHITE }: GainOptions = {}
): void {
  const recipe = record(material, animation, 0, brightness, lit, color);
  material.emissive = recipeColor.set(...recipeGain(material, recipe));
}

/**
 * A copy of a material, to play apart from it, its colour given as the material's was: a drawing's
 * own clone of a stage.
 */
export function cloneMaterial(material: StandardMaterial): StandardMaterial {
  const clone = material.clone();
  const recipe = recipes.get(material);
  if (recipe) {
    const [r, g, b] = recipe.color;
    recipes.set(clone, { ...recipe, color: [r, g, b] });
  }
  return clone;
}

/**
 * Multiply the colour a material was given by `tint`, for a model drawn in another's colours, as it
 * is kept for a change of basis.
 */
export function tintGain(
  material: StandardMaterial,
  tint: readonly [number, number, number]
): void {
  const recipe = recipes.get(material);
  if (!recipe) {
    const { r, g, b } = material.emissive;
    material.emissive = recipeColor.set(r * tint[0], g * tint[1], b * tint[2]);
    return;
  }
  for (let i = 0; i < 3; i++) recipe.color[i] *= tint[i];
  material.emissive = recipeColor.set(...recipeGain(material, recipe));
}
