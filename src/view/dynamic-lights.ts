import type { Vec3 } from '../sim/vec3';
import type { LightingScene } from './entity-light';
import type { LightGrid } from './light-grid';
import { rendererStyle, type RendererStyle } from './overbright';

/**
 * The frame's dynamic lights, as Q3's renderer takes them from the cgame: the scene's list, which
 * `trap_R_AddLightToScene` fills each frame (`RE_AddDynamicLightToScene`, `tr_scene.c:232–255`),
 * and which every model's light reads (`entity-light.ts`) and the world's (below).
 *
 * Engine-free like the rest of `src/view/`. One list is gathered before anything is shaded
 * (`light-sources.ts`), so the gun, the body and the floor are lit by the same lights.
 */

/**
 * `MAX_DLIGHTS` (`tr_types.h:27`): "can't be increased, because bit flags are used on surfaces".
 * A light past it is dropped, silently, and the first come are kept.
 */
export const MAX_DLIGHTS = 32;

/** One dynamic light (`dlight_t`, `tr_local.h:54–61`). */
export interface DynamicLight {
  /** Where it is, in Quake's world frame. */
  readonly origin: Readonly<Vec3>;
  /** `intensity`, which is how far it reaches, in units. */
  readonly radius: number;
  /** 0–1 a channel. */
  readonly color: readonly [number, number, number];
  /**
   * Added to the world where a light otherwise multiplies it (`trap_R_AddAdditiveLightToScene`).
   * Models take it as any other. Nothing in baseq3 makes one.
   */
  readonly additive: boolean;
}

/**
 * The game view's light: its world's light grid, and the frame's dynamic lights
 * (`tr.refdef.dlights`), in the order they were added.
 */
export class SceneLights implements LightingScene {
  private readonly added: DynamicLight[] = [];
  /** The map's light grid, from its load to its unload; none on a map with none. */
  grid: LightGrid | null = null;
  /** `r_ambientScale` and `r_directedScale`, read live. */
  ambientScale = 0.6;
  directedScale = 1;
  /** The renderer the scene's entities are lit as: `opengl1`'s on a BSP map; the style's else. */
  style: RendererStyle | undefined = undefined;
  /**
   * `r_dynamiclight`: with it 0, the renderer takes none of the lights it was given, on the world
   * or on a model (`tr_scene.c:361–367`). They are still added, and still count against the cap.
   */
  enabled = true;

  /** What the renderer lights by: every light added this frame, or none while switched off. */
  get lights(): readonly DynamicLight[] {
    return this.enabled ? this.added : [];
  }

  /** Start a new frame's list, as `R_InitNextFrame` does. */
  clear(): void {
    this.added.length = 0;
  }

  /**
   * `RE_AddDynamicLightToScene`: a light with no reach is dropped, and so is one past
   * {@link MAX_DLIGHTS}.
   *
   * @param radius - `intensity`, in units.
   * @param color - 0–1 a channel.
   */
  add(origin: Readonly<Vec3>, radius: number, color: readonly [number, number, number], additive = false): void {
    if (this.added.length >= MAX_DLIGHTS || radius <= 0) return;
    this.added.push({
      origin: { x: origin.x, y: origin.y, z: origin.z },
      radius,
      color: [color[0], color[1], color[2]],
      additive
    });
  }
}

// How the world takes a light: Q3's projected pass, `ProjectDlightTexture`
// (`renderergl1/tr_shade.c:407–556`). The splat map's hook (`render/splat-lights.ts`) does the
// same per splat, and tests hold it to these.

/** `DLIGHT_SIZE` (`tr_image.c`): the light's image is 16 texels a side. */
export const DLIGHT_SIZE = 16;

/**
 * One texel of the light's image (`R_CreateDlightImage`, `tr_image.c:1073–1099`): 4000 over its
 * centre's squared distance from the image's middle, in texels, cut to an `int`; 255 at most, and
 * nothing under 75. 0–255.
 */
export function dlightTexel(x: number, y: number): number {
  const middle = DLIGHT_SIZE / 2 - 0.5;
  const b = Math.trunc(4000 / ((middle - x) * (middle - x) + (middle - y) * (middle - y)));
  return b > 255 ? 255 : b < 75 ? 0 : b;
}

/**
 * The image as `GL_LINEAR` and `GL_CLAMP_TO_EDGE` sample it at `(s, t)`, 0–1 a side: the four
 * texels about the point, each weighed by how near it is. Its edge texels are nothing, so past its
 * edge it gives nothing. 0–1.
 */
export function dlightImage(s: number, t: number): number {
  const u = s * DLIGHT_SIZE - 0.5;
  const v = t * DLIGHT_SIZE - 0.5;
  const x = Math.floor(u);
  const y = Math.floor(v);
  const across = u - x;
  const down = v - y;
  const at = (i: number, j: number): number => {
    const edge = DLIGHT_SIZE - 1;
    return dlightTexel(Math.min(edge, Math.max(0, i)), Math.min(edge, Math.max(0, j)));
  };
  const top = at(x, y) * (1 - across) + at(x + 1, y) * across;
  const bottom = at(x, y + 1) * (1 - across) + at(x + 1, y + 1) * across;
  return (top * (1 - down) + bottom * down) / 255;
}

/**
 * How much of a light reaches a surface this far above or below it, `ProjectDlightTexture`'s
 * `modulate`: all of it within half the radius, then less in a line, to nothing at the radius.
 */
export function dlightModulate(height: number, radius: number): number {
  const h = Math.abs(height);
  if (h > radius) return 0;
  if (h < radius / 2) return 1;
  return (2 * (radius - h)) / radius;
}

const f = Math.fround;

/**
 * A light as `ProjectDlightTexture` projects it on a batch (`tr_shade.c:432-461`), each number a
 * float as the C holds it: its origin in the batch's frame (`dl->transformed`), its radius, one
 * over it, and its colour a channel times 255.
 */
export interface ProjectedLight {
  readonly origin: Float32Array;
  radius: number;
  scale: number;
  readonly color: Float32Array;
  additive: boolean;
}

/** Room for a light projected, before {@link projectLight} fills it. */
export function projectedLight(): ProjectedLight {
  return {
    origin: new Float32Array(3),
    radius: 0,
    scale: 0,
    color: new Float32Array(3),
    additive: false
  };
}

/**
 * A light taken for a batch drawn in a frame, as `ProjectDlightTexture` takes it: `x`, `y` and `z`
 * its place in that frame, worked out by the caller as `R_TransformDlights` works it out.
 */
export function projectLight(
  light: DynamicLight,
  x: number,
  y: number,
  z: number,
  out: ProjectedLight
): ProjectedLight {
  out.origin[0] = x;
  out.origin[1] = y;
  out.origin[2] = z;
  out.radius = f(light.radius);
  out.scale = f(1 / out.radius);
  for (let c = 0; c < 3; c++) out.color[c] = f(f(light.color[c]) * 255);
  out.additive = light.additive;
  return out;
}

/**
 * A vertex's clip bits for a light, as `ProjectDlightTexture` sets them (`tr_shade.c:463-510`):
 * past the image's left or right edge 1 or 2, its bottom or top 4 or 8, more than the radius below
 * or above the light 16 or 32. A triangle whose three vertexes share a bit takes none of the light.
 * `r_dlightBacks` is 1, so no vertex is tested by its normal.
 */
export function dlightClip(light: ProjectedLight, x: number, y: number, z: number): number {
  const { origin, radius, scale } = light;
  const s = f(0.5 + f(f(origin[0] - x) * scale));
  const t = f(0.5 + f(f(origin[1] - y) * scale));
  const height = f(origin[2] - z);
  let clip = s < 0 ? 1 : s > 1 ? 2 : 0;
  if (t < 0) clip |= 4;
  else if (t > 1) clip |= 8;
  if (height > radius) clip |= 16;
  else if (height < -radius) clip |= 32;
  return clip;
}

/** A vertex as a light's pass draws it: its place on the image, and its colour's bytes. */
export interface DlightVertex {
  s: number;
  t: number;
  readonly color: Uint8Array;
}

/**
 * A vertex's place on the light's image and its colour, as `ProjectDlightTexture` works them out
 * in floats: the image straight down the frame's z, and the colour times how much reaches the
 * vertex's height, each channel truncated into a byte by `ri.ftol`. The pass's vertex code
 * works out the same (`render/world-dlights.ts`).
 */
export function dlightVertex(
  light: ProjectedLight,
  x: number,
  y: number,
  z: number,
  out: DlightVertex
): DlightVertex {
  const { origin, radius, scale, color } = light;
  out.s = f(0.5 + f(f(origin[0] - x) * scale));
  out.t = f(0.5 + f(f(origin[1] - y) * scale));
  const height = f(origin[2] - z);
  let modulate = 0;
  if (height <= radius && height >= -radius) {
    const h = Math.abs(height);
    modulate = h < f(radius * 0.5) ? 1 : f(f(2 * f(radius - h)) * scale);
  }
  // A long into a byte: what is past 255 wraps, as a colour over 1 would.
  for (let c = 0; c < 3; c++) out.color[c] = Math.trunc(f(color[c] * modulate));
  return out;
}

/**
 * What one light adds to a point of the world, a channel each, 0–1: the image projected down the
 * world's z, centred on the light and spanning half its radius each way, times the light's colour
 * and how much reaches the point's height. No normal is read and nothing stands in the way, as
 * none does in Q3.
 *
 * `opengl1` writes the colour times the height's share into each vertex as a byte, truncated, as
 * ioquake3's `ri.ftol` truncates on x86-64; `opengl2` keeps it whole
 * (`renderergl2/glsl/dlight_vp.glsl`). `opengl2` also lights only a face turned toward the light,
 * which a splat, having no normal, cannot tell.
 */
export function worldLightSource(
  light: DynamicLight,
  point: Readonly<Vec3>,
  style: RendererStyle = rendererStyle()
): [number, number, number] {
  const { origin, radius, color } = light;
  const s = 0.5 + (origin.x - point.x) / radius;
  const t = 0.5 + (origin.y - point.y) / radius;
  const image = dlightImage(s, t);
  const reach = dlightModulate(origin.z - point.z, radius);
  const vertex = (c: number): number =>
    style.renderer === 'opengl1' ? Math.trunc(255 * c * reach) / 255 : c * reach;
  return [image * vertex(color[0]), image * vertex(color[1]), image * vertex(color[2])];
}

/**
 * A point of the world lit by the frame's lights, in the order they were added: each light
 * multiplies what is there by `1 + light`, as its pass blends `GL_DST_COLOR, GL_ONE`, or adds to
 * it, blending `GL_ONE, GL_ONE`. A light can at most double what is there, and cannot light
 * black.
 *
 * Q3 holds each pass to the framebuffer's 1. Neither blend can bring a channel back below 1 once
 * it is there, so holding the sum to 1 once at the end, as the backbuffer does, comes out the same.
 *
 * @param color - What is there, lit already: 0–1 a channel.
 */
export function lightWorld(
  color: readonly [number, number, number],
  point: Readonly<Vec3>,
  lights: readonly DynamicLight[],
  style: RendererStyle = rendererStyle()
): [number, number, number] {
  const lit: [number, number, number] = [color[0], color[1], color[2]];
  for (const light of lights) {
    const source = worldLightSource(light, point, style);
    for (let i = 0; i < 3; i++) lit[i] = light.additive ? lit[i] + source[i] : lit[i] * (1 + source[i]);
  }
  return lit;
}
