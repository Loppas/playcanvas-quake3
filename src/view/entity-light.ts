import type { Vec3 } from '../sim/vec3';
import type { DynamicLight } from './dynamic-lights';
import { normalize, sampleLightGrid, type LightGrid } from './light-grid';
import { identityLight, overbrightFactor, rendererStyle, type RendererStyle } from './overbright';

/**
 * Quake 3's per-entity diffuse lighting — `R_SetupEntityLighting` (`renderer/tr_light.c`) and
 * `RB_CalcDiffuseColor` (`tr_shader_calc.c`).
 *
 * Q3's weapons are **not** fullbright. A texture with no shader script gets a default shader
 * whose only stage is `rgbGen CGEN_LIGHTING_DIFFUSE` (`R_FindShader`), so the skin is
 * modulated by a per-vertex `ambient + directed · (N·L)` term. Without it a model keeps its
 * silhouette and its skin but loses all relief — which is exactly what made an inverted cull
 * mode read as a texture fault rather than as inside-out geometry.
 *
 * The light is worked out in Quake 3's floats, each operation rounded as the C rounds it, so that
 * a model's bytes are Quake 3's (`light-grid.ts`).
 *
 * Engine-free like the rest of `src/view/`: this is arithmetic on a normal and a direction.
 * The renderer's only job is to say which frame the light direction is expressed in. The shades and
 * the highlight here, per vertex and per pixel, are the arithmetic's definition: the model chunks
 * (`render/model-chunks.ts`) do the same on the GPU, and tests hold them to these.
 */

const f = Math.fround;

/**
 * Ambient and directed intensity when the scene has **no light grid**: a scene with no world, as
 * the HUD's models and the menu's are (`RDF_NOWORLDMODEL`), and a world with no grid, as a splat
 * map is and a map whose grid is missing or does not match it.
 */
export const ENTITY_AMBIENT = 150;
export const ENTITY_DIRECTED = 150;

/**
 * The "fixed minimum add" every entity receives.
 *
 * The comment in `tr_light.c` says bonus items and view weapons, and the condition is
 * `if ( 1 || !r_dynamiclight->integer || ent->e.renderfx & RF_MINLIGHT )` — a hard-wired
 * `1`, so in practice it applies to everything. Kept as its own constant because it is a
 * quirk, not a design: the view weapon would qualify anyway through `RF_MINLIGHT`.
 */
export const ENTITY_MIN_LIGHT = 32;

/**
 * `tr.sunDirection`'s default, in Quake's frame — up and slightly forward-left — made unit in
 * floats as `RE_LoadWorldMap` makes it (`tr_bsp.c:1806-1810`).
 */
export const SUN_DIRECTION: readonly [number, number, number] = ((): [number, number, number] => {
  const sun: [number, number, number] = [0, 0, 0];
  normalize(f(0.45), f(0.3), f(0.9), sun);
  return sun;
})();

/** `tr.sunDirection`: what lights a model where the scene has no light grid. */
let sun: readonly [number, number, number] = SUN_DIRECTION;

/**
 * Set the sun for every scene from here on, as a map's load sets `tr.sunDirection`: the default,
 * then the last `q3map_sun` among the shaders it parsed. The HUD's models and the menu's take it
 * too, so it holds until the next map.
 *
 * @param direction - The map's `q3map_sun`, unit; the default where it has none.
 */
export function setSunDirection(direction: readonly [number, number, number] | undefined): void {
  sun = direction ?? SUN_DIRECTION;
}

/** `tr.sunDirection`, as the last map's load set it. */
export function sunDirection(): readonly [number, number, number] {
  return sun;
}

/**
 * How much brighter than its texture a lit surface can show. Its vertex colours hold half its
 * shade on screen, and its material doubles them back, so a byte carries a shade up to twice
 * the texture under any renderer. In classic Q3 the bytes then come out as Q3's own
 * framebuffer bytes.
 */
export const LIGHT_HEADROOM = 2;

/**
 * What `R_SetupEntityLighting` leaves on an entity for its lit surfaces to be shaded by
 * (`trRefEntity_t`'s `ambientLight`, `directedLight` and `lightDir`): the per-model light, the
 * same for every vertex of the model. The GPU path takes it as it is.
 *
 * Both colours are Q3's own: 0–255 a channel, with `tr.identityLight` already in them.
 */
export interface EntityLight {
  /** What every vertex takes, whichever way it faces; the minimum add included. */
  readonly ambient: readonly [number, number, number];
  /** What a vertex takes by how squarely it faces the light, times `N·L`. */
  readonly directed: readonly [number, number, number];
  /**
   * Unit, towards the light: in the world's frame from {@link entityLightAt}, and in the entity's
   * own once taken there by {@link lightInEntityFrame}. Nothing where nothing lights the entity.
   */
  readonly direction: readonly [number, number, number];
}

/** An {@link EntityLight} its holder keeps, written again each frame in place. */
export interface KeptEntityLight extends EntityLight {
  readonly ambient: [number, number, number];
  readonly directed: [number, number, number];
  readonly direction: [number, number, number];
}

/** A light for a holder to keep, unlit until written. */
export function keptEntityLight(): KeptEntityLight {
  return { ambient: [0, 0, 0], directed: [0, 0, 0], direction: [0, 0, 0] };
}

/** What a scene lights its entities by, beside the renderer's style and the sun. */
export interface LightingScene {
  /**
   * `tr.world`'s light grid, which lights every entity in a scene with a world; none in a scene
   * with no world (`RDF_NOWORLDMODEL`), or whose world has no grid.
   */
  readonly grid: LightGrid | null;
  /** The scene's dynamic lights. */
  readonly lights: readonly DynamicLight[];
  /** `r_ambientScale`, which the grid's ambient light is scaled by. */
  readonly ambientScale: number;
  /** `r_directedScale`, which the grid's directed light is scaled by. */
  readonly directedScale: number;
  /**
   * The renderer its entities are lit as: a map's scene's is `opengl1`'s under either style, as its
   * world is drawn. The style set at load where absent.
   */
  readonly style?: RendererStyle;
}

/** A scene with no world and no lights, as the HUD's models and the menu's are. */
export const NO_WORLD: LightingScene = {
  grid: null,
  lights: [],
  ambientScale: 0.6,
  directedScale: 1
};

/** Where {@link entityLight} lights its entity: nowhere in particular, as nothing reaches it. */
const NOWHERE: Readonly<Vec3> = { x: 0, y: 0, z: 0 };

/**
 * {@link entityLightAt} in a scene with no world and no lights, as the HUD's models and the menu's
 * are lit: the fixed 150s from the sun, plus the minimum add, each at `identityLight`. Neither
 * renderer's clamp is met: 182 is short of a byte.
 *
 * @param style - As for {@link diffuseShade}.
 * @param out - Where it is written; a new light by default.
 */
export function entityLight(
  style: RendererStyle = rendererStyle(),
  out: KeptEntityLight = keptEntityLight()
): KeptEntityLight {
  return entityLightAt(NOWHERE, NO_WORLD, style, out);
}

/** `DLIGHT_AT_RADIUS` (`tr_light.c:26`): what a dynamic light adds to a model its radius away. */
export const DLIGHT_AT_RADIUS = 16;

/**
 * `DLIGHT_MINIMUM_RADIUS` (`tr_light.c:29`): a light nearer a model than this counts as this far,
 * "to prevent huge light numbers".
 */
export const DLIGHT_MINIMUM_RADIUS = 16;

/**
 * `R_SetupEntityLighting` (`tr_light.c:288-378`) whole but its last step, in the world's frame:
 *
 * 1. The light where the entity stands: the scene's grid's (`light-grid.ts`), or with none the
 *    fixed 150s from the sun, each at `identityLight`.
 * 2. The minimum add, `identityLight` × 32, to the ambient light. Quake 3 means it for
 *    `RF_MINLIGHT`, and gives it to every entity (`:327-333`).
 * 3. The scene's dynamic lights folded in, and each renderer's clamp ({@link foldDynamicLights}).
 *
 * Its last step, the direction in the entity's own frame, is {@link lightInEntityFrame}'s.
 *
 * @param origin - The entity's light origin, in Quake's world frame: `lightingOrigin` for every
 *   part of a player and what it holds, and the model's own origin otherwise.
 * @param scene - What the scene lights it by.
 * @param style - As for {@link diffuseShade}; the scene's where absent.
 * @param out - Where it is written; a new light by default.
 */
export function entityLightAt(
  origin: Readonly<Vec3>,
  scene: LightingScene,
  style: RendererStyle = scene.style ?? rendererStyle(),
  out: KeptEntityLight = keptEntityLight()
): KeptEntityLight {
  const light = f(identityLight(style));
  const { ambient, directed, direction } = out;
  if (scene.grid) {
    sampleLightGrid(scene.grid, origin, scene.ambientScale, scene.directedScale, out);
  } else {
    ambient.fill(f(light * ENTITY_AMBIENT));
    directed.fill(f(light * ENTITY_DIRECTED));
    direction[0] = sun[0];
    direction[1] = sun[1];
    direction[2] = sun[2];
  }
  const least = f(light * ENTITY_MIN_LIGHT);
  for (let i = 0; i < 3; i++) ambient[i] = f(ambient[i] + least);
  return foldDynamicLights(out, origin, scene.lights, style);
}

/** Scratch for a dynamic light's direction from the entity. */
const towardLight: [number, number, number] = [0, 0, 0];

/**
 * The end of `R_SetupEntityLighting` (`tr_light.c:335–377`), from the light its first half found,
 * in place: the scene's dynamic lights folded in at the entity's light origin, then each
 * renderer's clamp, and the direction made unit.
 * - Each light adds `16·R²/max(d, 16)²` times its colour to the directed light. It reaches every
 *   model in the scene, near or far: nothing stops it at its radius.
 * - It bends the direction toward itself by as much. The light's own direction weighs what the
 *   directed light's length was before any of them. A light at the origin itself has no direction,
 *   and bends nothing.
 *
 * Then each renderer's clamp:
 * - **`opengl1`** holds each channel of the ambient to `identityLightByte` (`:356–361`), and leaves
 *   the directed light as it is: the shade clamps at 255 per vertex.
 * - **`opengl2`** scales each of the two down, keeping its colour, until its brightest channel is
 *   255 (`renderergl2/tr_light.c:387–420`).
 *
 * A light grid's ambient meets `opengl1`'s clamp where it is bright; on a map with no grid only the
 * dynamic lights' directed light can meet `opengl2`'s.
 *
 * @param light - What the entity is lit by before the dynamic lights, its direction in the world's
 *   frame; written over.
 */
export function foldDynamicLights(
  light: KeptEntityLight,
  origin: Readonly<Vec3>,
  lights: readonly DynamicLight[],
  style: RendererStyle = rendererStyle()
): KeptEntityLight {
  const { ambient, directed, direction } = light;
  const red = directed[0];
  const green = directed[1];
  const blue = directed[2];
  // `VectorLength`, the square root taken in double.
  const weight = f(Math.sqrt(f(f(f(red * red) + f(green * green)) + f(blue * blue))));
  let x = f(direction[0] * weight);
  let y = f(direction[1] * weight);
  let z = f(direction[2] * weight);
  for (let n = 0; n < lights.length; n++) {
    const { origin: at, radius, color } = lights[n];
    // `VectorNormalize` leaves a vector with no length as it is.
    let distance = normalize(
      f(f(at.x) - f(origin.x)),
      f(f(at.y) - f(origin.y)),
      f(f(at.z) - f(origin.z)),
      towardLight
    );
    const reach = f(radius);
    const power = f(DLIGHT_AT_RADIUS * f(reach * reach));
    if (distance < DLIGHT_MINIMUM_RADIUS) distance = DLIGHT_MINIMUM_RADIUS;
    const add = f(power / f(distance * distance));
    for (let i = 0; i < 3; i++) directed[i] = f(directed[i] + f(f(color[i]) * add));
    x = f(x + f(towardLight[0] * add));
    y = f(y + f(towardLight[1] * add));
    z = f(z + f(towardLight[2] * add));
  }
  if (style.renderer === 'opengl1') {
    // An `int`, so 127 at `r_overBrightBits 1`.
    const most = Math.trunc(255 * identityLight(style));
    for (let i = 0; i < 3; i++) if (ambient[i] > most) ambient[i] = most;
  } else {
    holdKeepingColor(ambient);
    holdKeepingColor(directed);
  }
  normalize(x, y, z, direction);
  return light;
}

/** Scale a colour down, as it is, until its brightest channel is 255 at most. */
function holdKeepingColor(color: [number, number, number]): void {
  const brightest = Math.max(color[0], color[1], color[2]);
  if (brightest <= 255) return;
  const scale = f(255 / brightest);
  for (let i = 0; i < 3; i++) color[i] = f(color[i] * scale);
}

/**
 * How a lit stage is shaded, by the renderer the port draws like and whether its shader deforms,
 * each after ioq3's own program for it:
 *
 * - **`opengl1`**: per vertex, into the framebuffer's bytes (`RB_CalcDiffuseColor`): see
 *   {@link diffuseShade} and {@link shadeVertices}.
 * - **`lightall`**: `opengl2`'s per-pixel program, with `r_normalMapping` or `r_specularMapping`
 *   on, as ioq3 has them by default: {@link lightallShade}.
 * - **`fastLight`**: the same program with both off, per vertex (`USE_FAST_LIGHT`,
 *   `lightall_vp.glsl:245–250`): {@link diffuseShade}.
 * - **`generic`**: a stage of a shader with any deform. `opengl2` leaves such a shader's stages to
 *   its generic program (`tr_shader.c:2347–2351`, `2626`), which shades per vertex and clamps:
 *   {@link genericShade}.
 */
export type LitPath = 'opengl1' | 'lightall' | 'fastLight' | 'generic';

/** The way a lit stage is shaded, as {@link LitPath} tells them apart. */
export function litPath(style: RendererStyle, deformed: boolean): LitPath {
  if (style.renderer === 'opengl1') return 'opengl1';
  if (deformed) return 'generic';
  return (style.normalMapping ?? true) || (style.specularMapping ?? true) ? 'lightall' : 'fastLight';
}

/**
 * The multiplier `CGEN_LIGHTING_DIFFUSE` puts on one channel of a vertex's texture **on screen**,
 * in Quake's gamma space, under the renderer the port draws like. Both of ioq3's renderers sum
 * `ambient + (N·L) · directed`, with ambient alone for a vertex facing away, and spend
 * `r_overBrightBits` on it differently:
 *
 * - **`opengl1`**: `RB_CalcDiffuseColor` writes the sum into the framebuffer as a byte
 *   ({@link diffuseByte}), and the gamma ramp multiplies it back. At `r_overBrightBits 1` the
 *   splat map's light runs **0.714 to 1.302**: the clamp is never met, so the sunlit side of a
 *   model shows up to 30% brighter than its texture. At 0, Q3 in a window, the same sum stops at
 *   1.0 once `N·L` reaches 0.49.
 * - **`opengl2`**, lighting per vertex (`fastLight`): the overbright factor multiplies the sum
 *   back and nothing clamps it, so it runs 0.714 to 1.302 at any setting.
 *
 * Q3's weapons are lit, but gently — this shades form, it does not silhouette.
 *
 * @param incoming `N·L` with both vectors unit length and in the same frame.
 * @param ambient - The channel's {@link EntityLight.ambient}.
 * @param directed - The channel's {@link EntityLight.directed}.
 * @param style - The renderer to light like; the one set at load unless a test says otherwise.
 */
export function diffuseShade(
  incoming: number,
  ambient: number,
  directed: number,
  style: RendererStyle = rendererStyle()
): number {
  const drawn =
    style.renderer === 'opengl1'
      ? diffuseByte(incoming, ambient, directed)
      : ambient + Math.max(0, incoming) * directed;
  return (overbrightFactor(style) * drawn) / 255;
}

/**
 * The byte `RB_CalcDiffuseColor` writes for one channel of a vertex (`tr_shade_calc.c:1082-1129`),
 * in floats: the ambient light's byte on the side turned away, and the sum's on the lit side,
 * 255 at most. Each is truncated, as ioquake3's `ri.ftol` truncates on x86-64 (`cvttss2si`).
 *
 * @param incoming - `N·L`, as the C works it out in floats.
 */
export function diffuseByte(incoming: number, ambient: number, directed: number): number {
  if (incoming <= 0) return Math.trunc(ambient);
  const light = Math.trunc(f(ambient + f(incoming * directed)));
  return light > 255 ? 255 : light;
}

/** `DotProduct` in floats: each product rounded, then each sum. */
export function dotFloats(
  x: number,
  y: number,
  z: number,
  toward: readonly number[]
): number {
  return f(f(f(x * toward[0]) + f(y * toward[1])) + f(z * toward[2]));
}

/**
 * The shade `opengl2`'s generic program gives a lit stage of a shader that deforms, 0–1 a channel
 * (`CalcColor`, `generic_vp.glsl:181–185`): the sum clamped at 1, and no overbright factor, since
 * it replaces the base colour that carries one.
 *
 * @param incoming - `N·L` as that program takes it: the normal as morphed, which `opengl2` never
 *   makes unit again, and the light's direction in the entity's frame (`u_ModelLightDir`).
 */
export function genericShade(incoming: number, ambient: number, directed: number): number {
  const facing = Math.min(1, Math.max(0, incoming));
  return Math.min(1, Math.max(0, (ambient + facing * directed) / 255));
}

// What `lightall` reads for a stage with no normal or specular map, as every one of baseq3's is:
// a white map for each (`tr_shade.c:1484–1507`), and each stage's default scales
// (`tr_shader.c:3028–3039`). The normal map's scale is 0, so the normal is the surface's own.

/** `r_baseSpecular`: the specular reflectance at normal incidence, taken off the diffuse. */
export const LIGHTALL_SPECULAR = 0.04;
/** `r_baseGloss` 0.3 read as smoothness, as `r_glossType` 1 has it (`GLOSS_IS_SMOOTHNESS`). */
export const LIGHTALL_ROUGHNESS = 1 - 0.3;
/** `r_deluxeSpecular`: how much of the highlight an entity's light gives. */
export const LIGHTALL_DELUXE_SPECULAR = 0.3;

/** `CalcSpecular` (`lightall_fp.glsl:201–209`) at {@link LIGHTALL_SPECULAR}. */
export function calcSpecular(NH: number, EH: number, roughness: number = LIGHTALL_ROUGHNESS): number {
  const rr = roughness * roughness;
  const rrrr = rr * rr;
  const d = NH * NH * (rrrr - 1) + 1;
  const v = EH * EH * (roughness + 0.5) + 0.00000001;
  return LIGHTALL_SPECULAR * (rrrr / (4 * d * d * v));
}

/** A triple made unit, or left as it is if it has no length. */
function unit(v: readonly number[]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [v[0], v[1], v[2]];
}

/** The dot product of two triples, clamped to 0–1. */
function facing(a: readonly number[], b: readonly number[]): number {
  return Math.min(1, Math.max(0, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
}

/**
 * One pixel of a lit stage under `opengl2`'s `lightall` (`lightall_fp.glsl:260–437`), lit by an
 * entity's light: the texture, less the 4% given to the highlight, lit by `N·L` and the ambient,
 * and a faint highlight added where the light mirrors toward the viewer. Nothing clamps it. In
 * display space, as the port blends.
 *
 * @param texel - The stage's texture at the pixel, 0–1 a channel.
 * @param normal - The surface's normal there, on the side the viewer sees: `lightall` turns it
 *   round on a two-sided stage's other face (`:267`). Any length.
 * @param toViewer - From the pixel to the viewer; any length.
 * @param light - The entity's light, its direction in the same frame; any length.
 * @param overbright - The stage's base colour: the style's overbright factor, or 1 for a stage that
 *   multiplies colour, which `ComputeShaderColors` never brightens (`tr_shade.c:572–581`).
 * @returns The colour on screen, a channel each.
 */
export function lightallShade(
  texel: readonly [number, number, number],
  normal: readonly number[],
  toViewer: readonly number[],
  light: EntityLight,
  overbright: number
): [number, number, number] {
  const N = unit(normal);
  const L = unit(light.direction);
  const E = unit(toViewer);
  const H = unit([L[0] + E[0], L[1] + E[1], L[2] + E[2]]);
  const NL = facing(N, L);
  const highlight = calcSpecular(facing(N, H), facing(E, H)) * LIGHTALL_DELUXE_SPECULAR;
  const channel = (i: number): number => {
    const diffuse = texel[i] * (1 - LIGHTALL_SPECULAR);
    const directed = (overbright * light.directed[i]) / 255;
    const ambient = (overbright * light.ambient[i]) / 255;
    return directed * (diffuse + highlight) * NL + ambient * diffuse;
  };
  return [channel(0), channel(1), channel(2)];
}

/**
 * Shade a whole surface into a `Uint8Array` of RGBA vertex colours: half of
 * {@link diffuseShade}, for the surface's material to double (see {@link LIGHT_HEADROOM}).
 *
 * @param normals `numVerts * 3` unit normals, in the same frame as the light's direction.
 * @param light - The entity's light, its direction in the normals' frame.
 * @param out `numVerts * 4` bytes, overwritten.
 * @param style - As for {@link diffuseShade}.
 */
export function shadeVertices(
  normals: Float32Array,
  light: EntityLight,
  out: Uint8Array,
  style: RendererStyle = rendererStyle()
): void {
  const { ambient, directed, direction } = light;
  const count = normals.length / 3;
  for (let i = 0; i < count; i++) {
    const incoming = dotFloats(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2], direction);
    for (let channel = 0; channel < 3; channel++) {
      const shade = diffuseShade(incoming, ambient[channel], directed[channel], style);
      // A byte holds up to LIGHT_HEADROOM, so a brighter light stops there rather than wrap.
      out[i * 4 + channel] = Math.min(255, Math.round((shade * 255) / LIGHT_HEADROOM));
    }
    out[i * 4 + 3] = 255;
  }
}

/**
 * An entity's light with its direction taken into the entity's own frame, as
 * `R_SetupEntityLighting` ends: dotted with each of the entity's axis rows, in floats
 * (`tr_light.c:375–377`). Shading then compares it with the model's own normals, so a model
 * shades by how it is turned under a light that stays put. An axis scaled, as a weapon lying on
 * the floor is drawn at 1.5, scales the direction with it, and the model is lit harder.
 *
 * @param axis - The entity's forward, left and up rows, in the frame the light is given in.
 * @param light - The light, in that frame; the splat map's by default.
 * @param out - Where it is written, which may be `light`; a new light by default.
 */
export function lightInEntityFrame(
  axis: readonly ArrayLike<number>[],
  light: EntityLight = entityLight(),
  out: KeptEntityLight = keptEntityLight()
): KeptEntityLight {
  const x = light.direction[0];
  const y = light.direction[1];
  const z = light.direction[2];
  for (let i = 0; i < 3; i++) {
    out.ambient[i] = light.ambient[i];
    out.directed[i] = light.directed[i];
  }
  for (let k = 0; k < 3; k++) {
    const row = axis[k];
    out.direction[k] = f(f(f(x * f(row[0])) + f(y * f(row[1]))) + f(z * f(row[2])));
  }
  return out;
}

/**
 * `lightOrigin` (`tr_shade_calc.c:1023`): where `alphaGen lightingSpecular`'s light is, in each
 * entity's own frame, so it turns with the entity. Q3 marks it to be tracked one day; it never was.
 */
export const SPECULAR_LIGHT_ORIGIN: readonly [number, number, number] = [-960, 1980, 96];

/**
 * How squarely a vertex's viewer sees the light from {@link SPECULAR_LIGHT_ORIGIN} mirrored in its
 * normal: 1 head on, below 0 facing away. What `RB_CalcSpecularAlpha` (`tr_shade_calc.c:1025–1073`)
 * and `opengl2`'s `CalcColor` (`generic_vp.glsl:190–198`) both raise to the fourth power.
 *
 * @param position - In the entity's own frame.
 * @param normal - Its normal, as the renderer has it.
 * @param viewer - Where the viewer is, in the same frame.
 */
export function mirroredLight(
  position: ArrayLike<number>,
  normal: ArrayLike<number>,
  viewer: ArrayLike<number>
): number {
  const [x, y, z] = [position[0], position[1], position[2]];
  const [nx, ny, nz] = [normal[0], normal[1], normal[2]];
  const towards = Math.hypot(SPECULAR_LIGHT_ORIGIN[0] - x, SPECULAR_LIGHT_ORIGIN[1] - y, SPECULAR_LIGHT_ORIGIN[2] - z) || 1;
  const lx = (SPECULAR_LIGHT_ORIGIN[0] - x) / towards;
  const ly = (SPECULAR_LIGHT_ORIGIN[1] - y) / towards;
  const lz = (SPECULAR_LIGHT_ORIGIN[2] - z) / towards;
  // Mirrored in the normal even where the light is behind the face, as Q3 leaves it, "since
  // this tends to cause visual artifacts such as faceted snapping" otherwise.
  const d = nx * lx + ny * ly + nz * lz;
  const rx = nx * 2 * d - lx;
  const ry = ny * 2 * d - ly;
  const rz = nz * 2 * d - lz;
  const vx = viewer[0] - x;
  const vy = viewer[1] - y;
  const vz = viewer[2] - z;
  const seen = Math.hypot(vx, vy, vz);
  return seen > 0 ? (rx * vx + ry * vy + rz * vz) / seen : 0;
}

/**
 * A vertex's highlight, 0–1, from its {@link mirroredLight}, under the renderer the port draws
 * like: `opengl1` truncates it to a byte, as a C cast does, and `opengl2` keeps it whole.
 */
export function specularAlpha(mirrored: number, style: RendererStyle = rendererStyle()): number {
  if (mirrored < 0) return 0;
  if (style.renderer === 'opengl1') return Math.min(255, Math.trunc(mirrored ** 4 * 255)) / 255;
  return Math.min(1, mirrored) ** 4;
}

/**
 * `RB_CalcSpecularAlpha` (`tr_shade_calc.c:1025–1073`): each vertex's alpha, its
 * {@link mirroredLight} to the fourth power, in `opengl1`'s bytes. Only the alpha bytes are
 * written.
 *
 * @param positions - `numVerts * 3` positions, in the entity's own frame.
 * @param normals - Their unit normals.
 * @param viewer - Where the viewer is, in the same frame.
 * @param out - `numVerts * 4` RGBA bytes, whose alphas are overwritten.
 */
export function specularAlphas(
  positions: Float32Array,
  normals: Float32Array,
  viewer: readonly [number, number, number],
  out: Uint8Array
): void {
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    const l = mirroredLight(positions.subarray(i * 3, i * 3 + 3), normals.subarray(i * 3, i * 3 + 3), viewer);
    // A C cast truncates.
    out[i * 4 + 3] = l < 0 ? 0 : Math.min(255, Math.trunc(l ** 4 * 255));
  }
}
