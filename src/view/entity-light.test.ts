import { afterEach, describe, expect, it } from 'vitest';
import {
  ENTITY_AMBIENT,
  ENTITY_DIRECTED,
  ENTITY_MIN_LIGHT,
  NO_WORLD,
  SPECULAR_LIGHT_ORIGIN,
  SUN_DIRECTION,
  calcSpecular,
  diffuseByte,
  entityLight,
  genericShade,
  keptEntityLight,
  lightallShade,
  lightInEntityFrame,
  litPath,
  diffuseShade,
  entityLightAt,
  foldDynamicLights,
  mirroredLight,
  setSunDirection,
  shadeVertices,
  specularAlpha,
  specularAlphas,
  sunDirection,
  type EntityLight,
  type KeptEntityLight,
  type LightingScene
} from './entity-light';
import type { DynamicLight } from './dynamic-lights';
import type { LightGrid } from './light-grid';
import type { RendererStyle } from './overbright';

/** One channel of the splat map's light, shaded at `incoming` under `style`. */
function shade(incoming: number, style?: RendererStyle): number {
  const { ambient, directed } = entityLight(style);
  return diffuseShade(incoming, ambient[0], directed[0], style);
}

/** The splat map's light for `style`, coming from `direction`. */
function toward(direction: readonly [number, number, number], style?: RendererStyle): EntityLight {
  return { ...entityLight(style), direction };
}

const CLASSIC = { renderer: 'opengl1', overBrightBits: 1 } as const;
const MODERN = { renderer: 'opengl2', overBrightBits: 1 } as const;

describe('entityLight (R_SetupEntityLighting, with no light grid)', () => {
  it('gives every channel the fixed 150s and the minimum add, at identityLight', () => {
    // Whole in a window, halved at r_overBrightBits 1 for the ramp or the shader to double.
    const cases = [
      [0, 182, 150],
      [1, 91, 75],
      [2, 45.5, 37.5]
    ] as const;
    for (const [overBrightBits, ambient, directed] of cases) {
      for (const renderer of ['opengl1', 'opengl2'] as const) {
        const light = entityLight({ renderer, overBrightBits });
        expect(light.ambient, `${renderer} ${overBrightBits}`).toEqual([ambient, ambient, ambient]);
        expect(light.directed, `${renderer} ${overBrightBits}`).toEqual([directed, directed, directed]);
      }
    }
  });

  it("comes from the sun, in the world's frame", () => {
    expectClose(entityLight().direction, SUN_DIRECTION);
  });

  it('writes into the light it is given, and makes none', () => {
    const kept = keptEntityLight();
    expect(entityLight(CLASSIC, kept)).toBe(kept);
    expect(kept.ambient).toEqual([91, 91, 91]);
  });
});

describe("the sun (tr.sunDirection)", () => {
  afterEach(() => setSunDirection(undefined));

  it("is the default until a map's shaders set one, and lights every model with no grid", () => {
    expect(sunDirection()).toBe(SUN_DIRECTION);
    setSunDirection([0, 0, 1]);
    expectClose(entityLight().direction, [0, 0, 1]);
    expectClose(entityLightAt(AT_ORIGIN, NO_WORLD).direction, [0, 0, 1]);
    setSunDirection(undefined);
    expect(sunDirection()).toBe(SUN_DIRECTION);
  });

  it('is made unit in floats from 0.45 0.3 0.9, as RE_LoadWorldMap makes it', () => {
    expect(SUN_DIRECTION.every((value) => Math.fround(value) === value)).toBe(true);
    expect(Math.hypot(...SUN_DIRECTION)).toBeCloseTo(1, 6);
  });
});

/** Each number to four places, as a float of a few hundred holds them. */
function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], 4);
}

/** A dynamic light, white unless given a colour. */
function dlight(
  x: number,
  y: number,
  z: number,
  radius: number,
  color: readonly [number, number, number] = [1, 1, 1]
): DynamicLight {
  return { origin: { x, y, z }, radius, color, additive: false };
}

const AT_ORIGIN = { x: 0, y: 0, z: 0 };

/** A scene with no world, lit by these lights. */
function lit(...lights: DynamicLight[]): LightingScene {
  return { ...NO_WORLD, lights };
}

describe('entityLightAt (R_SetupEntityLighting, with the dynamic lights)', () => {
  it('is the splat map light as it is with no lights', () => {
    expect(entityLightAt(AT_ORIGIN, NO_WORLD, CLASSIC)).toEqual(entityLight(CLASSIC));
    expect(entityLightAt(AT_ORIGIN, NO_WORLD, MODERN)).toEqual(entityLight(MODERN));
  });

  it("adds a quad's light on its holder to the directed light, 16·R²/16² of it, bending nothing", () => {
    // R 216: 2916 times (0.2, 0.2, 1) onto opengl1's 75s. The light sits at the light origin
    // itself, so it has no direction, and the sun's stands.
    const light = entityLightAt(AT_ORIGIN, lit(dlight(0, 0, 0, 216, [0.2, 0.2, 1])), CLASSIC);
    expectClose(light.directed, [75 + 583.2, 75 + 583.2, 75 + 2916]);
    expect(light.ambient).toEqual([91, 91, 91]);
    expectClose(light.direction, SUN_DIRECTION);
  });

  it('adds 16·R²/d² of a light d away, and bends the direction toward it by as much', () => {
    // A rocket 100 units along x: 16·200²/100² = 64 times (1, 0.75, 0). The sun's direction weighs
    // the directed light's length before it, 75√3.
    const light = entityLightAt(AT_ORIGIN, lit(dlight(100, 0, 0, 200, [1, 0.75, 0])), CLASSIC);
    expectClose(light.directed, [139, 123, 75]);
    const sun = 75 * Math.sqrt(3);
    const bent = [sun * SUN_DIRECTION[0] + 64, sun * SUN_DIRECTION[1], sun * SUN_DIRECTION[2]];
    const length = Math.hypot(bent[0], bent[1], bent[2]);
    expectClose(light.direction, [bent[0] / length, bent[1] / length, bent[2] / length]);
  });

  it('counts a light nearer than 16 units as 16 away', () => {
    const near = entityLightAt(AT_ORIGIN, lit(dlight(0, 0, 8, 100)), CLASSIC);
    const at16 = entityLightAt(AT_ORIGIN, lit(dlight(0, 0, 16, 100)), CLASSIC);
    expectClose(near.directed, at16.directed);
  });

  it('reaches past its radius: at four radii a light still adds 1 a channel', () => {
    const far = entityLightAt(AT_ORIGIN, lit(dlight(0, 800, 0, 200)), CLASSIC);
    expectClose(far.directed, [76, 76, 76]);
  });

  it('adds every light in the scene', () => {
    const scene = lit(dlight(100, 0, 0, 200), dlight(0, -100, 0, 100));
    const both = entityLightAt(AT_ORIGIN, scene, CLASSIC);
    expectClose(both.directed, [75 + 64 + 16, 75 + 64 + 16, 75 + 64 + 16]);
  });

  it("takes opengl2's clamp: the directed light scaled down, colour kept, to 255 at most", () => {
    const light = entityLightAt(AT_ORIGIN, lit(dlight(0, 0, 0, 216, [0.2, 0.2, 1])), MODERN);
    const scale = 255 / 2991;
    expectClose(light.directed, [658.2 * scale, 658.2 * scale, 255]);
    expect(light.ambient).toEqual([91, 91, 91]);
  });
});

/** A grid of 2×2×2 points, 64 units apart and 128 up, every one lit by these bytes. */
function evenGrid(bytes: readonly number[]): LightGrid {
  const data = new Uint8Array(8 * 8);
  for (let i = 0; i < 8; i++) data.set(bytes, i * 8);
  return { inverseSize: [1 / 64, 1 / 64, 1 / 128], origin: [0, 0, 0], bounds: [2, 2, 2], data };
}

describe('entityLightAt with a light grid', () => {
  // Lit from straight up: a longitude of 0.
  const scene = (bytes: readonly number[]): LightingScene => ({
    grid: evenGrid(bytes),
    lights: [],
    ambientScale: 0.6,
    directedScale: 1
  });
  const IN_GRID = { x: 20, y: 30, z: 40 };

  it('lights by the grid where the scene has one, scaled, and the minimum add after', () => {
    const light = entityLightAt(IN_GRID, scene([100, 120, 140, 50, 60, 70, 0, 0]), CLASSIC);
    // 0.6 of each, then 16: 76, 88, 100, as floats.
    expectClose(light.ambient, [76, 88, 100]);
    expectClose(light.directed, [50, 60, 70]);
    expectClose(light.direction, [0, 0, 1]);
  });

  it("meets opengl1's clamp at identityLightByte where the grid is bright", () => {
    const light = entityLightAt(IN_GRID, scene([250, 250, 250, 50, 50, 50, 0, 0]), CLASSIC);
    // 150 + 16 is past 127.
    expect(light.ambient).toEqual([127, 127, 127]);
    const window = { renderer: 'opengl1', overBrightBits: 0 } as const;
    expectClose(entityLightAt(IN_GRID, scene([250, 250, 250, 50, 50, 50, 0, 0]), window).ambient, [
      182, 182, 182
    ]);
  });

  it('is unlit but for the minimum add where every point about it is in a wall', () => {
    const light = entityLightAt(IN_GRID, scene([0, 0, 0, 90, 90, 90, 0, 0]), CLASSIC);
    expect(light.ambient).toEqual([16, 16, 16]);
    expect(light.directed).toEqual([0, 0, 0]);
    expect(light.direction).toEqual([0, 0, 0]);
  });

  it('takes the scales the scene reads live', () => {
    const light = entityLightAt(
      IN_GRID,
      { ...scene([100, 100, 100, 50, 50, 50, 0, 0]), ambientScale: 1, directedScale: 2 },
      CLASSIC
    );
    expectClose(light.ambient, [116, 116, 116]);
    expectClose(light.directed, [100, 100, 100]);
  });
});

describe('foldDynamicLights', () => {
  /** A light found before the dynamic lights, as a grid would find one. */
  const found = (
    ambient: [number, number, number],
    directed: [number, number, number]
  ): KeptEntityLight => ({
    ambient,
    directed,
    direction: [0, 0, 1]
  });

  it("holds opengl1's ambient to identityLightByte a channel, and leaves its directed light", () => {
    const cases = [
      [0, 255],
      [1, 127],
      [2, 63]
    ] as const;
    for (const [overBrightBits, most] of cases) {
      const style = { renderer: 'opengl1', overBrightBits } as const;
      const light = foldDynamicLights(found([300, 100, 60], [400, 0, 0]), AT_ORIGIN, [], style);
      expect(light.ambient, `r_overBrightBits ${overBrightBits}`).toEqual([most, Math.min(100, most), Math.min(60, most)]);
      expect(light.directed).toEqual([400, 0, 0]);
    }
  });

  it("scales opengl2's ambient and directed light each to 255 at most, colour kept", () => {
    const light = foldDynamicLights(found([300, 150, 30], [510, 255, 0]), AT_ORIGIN, [], MODERN);
    expectClose(light.ambient, [255, 127.5, 25.5]);
    expectClose(light.directed, [255, 127.5, 0]);
  });

  it('leaves a light with no directed light and no lights with no direction, as VectorNormalize does', () => {
    expect(foldDynamicLights(found([10, 10, 10], [0, 0, 0]), AT_ORIGIN, [], CLASSIC).direction).toEqual([0, 0, 0]);
  });
});

describe('diffuseShade', () => {
  it('never goes fully dark — a face turned away still gets the ambient term', () => {
    // 182/255: the framebuffer's 91, doubled. Q3 has no black side on a model; the minimum add
    // is what guarantees it.
    expect(shade(-1)).toBeCloseTo((ENTITY_AMBIENT + ENTITY_MIN_LIGHT) / 255, 10);
    expect(shade(0)).toBeCloseTo(shade(-1), 10);
  });

  it('climbs past the texture to 1.302 head-on, where a window would stop at 1', () => {
    // (182 + 150 x) / 255 reaches 1 at x = 0.4867 and keeps going: nothing clamps the
    // half-bright sum before the ramp doubles it. There the framebuffer's 127.5 is cut to 127.
    const unity = (255 - ENTITY_AMBIENT - ENTITY_MIN_LIGHT) / ENTITY_DIRECTED;
    expect(unity).toBeCloseTo(0.4867, 4);
    expect(shade(unity)).toBe((2 * 127) / 255);
    expect(shade(unity + 0.01)).toBeGreaterThan(1);
    expect(shade(1)).toBeCloseTo((ENTITY_AMBIENT + ENTITY_MIN_LIGHT + ENTITY_DIRECTED) / 255, 10);
    expect(shade(1)).toBeCloseTo(1.302, 3);
  });

  it('spans 0.714 to 1.302, rising all the way', () => {
    expect(shade(-1)).toBeCloseTo(0.7137, 4);
    let previous = shade(0);
    for (let incoming = 0.05; incoming <= 1; incoming += 0.05) {
      const next = shade(incoming);
      expect(next, `N.L=${incoming.toFixed(2)}`).toBeGreaterThan(previous);
      previous = next;
    }
  });

  it('stops at the texture in a window, where opengl1 never overbrights', () => {
    const window = { renderer: 'opengl1', overBrightBits: 0 } as const;
    const unity = (255 - ENTITY_AMBIENT - ENTITY_MIN_LIGHT) / ENTITY_DIRECTED;
    expect(shade(-1, window)).toBeCloseTo(0.7137, 4);
    expect(shade(unity, window)).toBeCloseTo(1, 6);
    expect(shade(1, window)).toBe(1);
  });

  it("reaches 1.302 in opengl2 at any setting, since fastLight clamps nothing", () => {
    for (const overBrightBits of [0, 1]) {
      const style = { renderer: 'opengl2', overBrightBits } as const;
      expect(shade(-1, style), `${overBrightBits}`).toBeCloseTo(0.7137, 4);
      expect(shade(1, style), `${overBrightBits}`).toBeCloseTo(1.302, 3);
    }
  });

  it("clamps a channel at the framebuffer's 255 in opengl1 alone", () => {
    // 200 + 150 is past a byte: opengl1's framebuffer holds 255, which its ramp doubles.
    expect(diffuseShade(1, 200, 150, CLASSIC)).toBe(2);
    expect(diffuseShade(1, 200, 150, MODERN)).toBeCloseTo(700 / 255, 10);
  });

  it("truncates opengl1's byte, as ioquake3's ri.ftol does, and keeps opengl2's whole", () => {
    expect(diffuseShade(0.5, 91.9, 75, CLASSIC)).toBe((2 * 129) / 255);
    expect(diffuseShade(0.5, 91.9, 75, MODERN)).toBeCloseTo((2 * 129.4) / 255, 10);
  });
});

describe('diffuseByte (RB_CalcDiffuseColor)', () => {
  it("gives a vertex turned away the ambient light's byte, truncated", () => {
    expect(diffuseByte(-0.5, 91.9, 75)).toBe(91);
    expect(diffuseByte(0, 91.9, 75)).toBe(91);
  });

  it("gives a lit vertex the sum's byte, in floats, truncated and held to 255", () => {
    expect(diffuseByte(0.5, 91.9, 75)).toBe(129);
    expect(diffuseByte(1, 200, 150)).toBe(255);
    // 0.1 is not a float: the sum is worked out in floats before it is cut.
    expect(diffuseByte(0.1, 0, 30)).toBe(Math.trunc(Math.fround(Math.fround(0.1) * 30)));
  });
});

describe('SUN_DIRECTION', () => {
  it('is a unit vector pointing mostly up', () => {
    expect(Math.hypot(...SUN_DIRECTION)).toBeCloseTo(1, 6);
    // Quake Z-up: the default sun is high and a little forward-left, so the tops of models
    // catch the light. A weapon held below the eye is lit from above, as in Q3.
    expect(SUN_DIRECTION[2]).toBeGreaterThan(SUN_DIRECTION[0]);
    expect(SUN_DIRECTION[0]).toBeGreaterThan(SUN_DIRECTION[1]);
  });
});

describe('shadeVertices', () => {
  it("writes Q3's half-bright framebuffer bytes, brightest where the normal faces the light", () => {
    const normals = new Float32Array([
      0, 0, 1, // straight at the light
      0, 0, -1, // straight away
      1, 0, 0 // edge on
    ]);
    const out = new Uint8Array(3 * 4);
    shadeVertices(normals, toward([0, 0, 1]), out);

    // 91 + 75 N·L, which the material doubles on screen as the ramp does.
    expect([...out.slice(0, 4)]).toEqual([166, 166, 166, 255]);
    expect([...out.slice(4, 8)]).toEqual([91, 91, 91, 255]);
    expect([...out.slice(8, 12)]).toEqual([91, 91, 91, 255]);
  });

  it('writes half the shade under any renderer, for the material to double', () => {
    const out = new Uint8Array(4);
    // 1.0 on screen, head-on in a window: half of 255.
    const window = { renderer: 'opengl1', overBrightBits: 0 } as const;
    shadeVertices(new Float32Array([0, 0, 1]), toward([0, 0, 1], window), out, window);
    expect([...out]).toEqual([128, 128, 128, 255]);
  });

  it('is a pure function of N dot L, so rotating both changes nothing', () => {
    // The renderer expresses the light in each entity's own frame precisely so this holds;
    // a mismatch there would show up as lighting that swims when the model rotates.
    const normals = new Float32Array([0.6, 0.8, 0]);
    const straight = new Uint8Array(4);
    const rotated = new Uint8Array(4);
    shadeVertices(normals, toward([1, 0, 0]), straight);
    // Same 0.6 dot product, arrived at from a different pair.
    shadeVertices(new Float32Array([0, 0.6, 0.8]), toward([0, 1, 0]), rotated);
    expect([...rotated]).toEqual([...straight]);
  });

  it('shades each channel by its own light, as RB_CalcDiffuseColor does', () => {
    const light = { ambient: [91, 40, 10], directed: [75, 150, 0], direction: [0, 0, 1] } as const;
    const out = new Uint8Array(2 * 4);
    shadeVertices(new Float32Array([0, 0, 1, 0, 0, -1]), light, out, CLASSIC);
    // Head-on, each channel's ambient plus its directed; turned away, its ambient alone.
    expect([...out.slice(0, 4)]).toEqual([166, 190, 10, 255]);
    expect([...out.slice(4, 8)]).toEqual([91, 40, 10, 255]);
  });

  it('stops a channel at twice its texture, all its byte can hold, rather than wrap', () => {
    // opengl2's red climbs to 350, 2.7 times its texture; a byte holds half of 2.
    const light = { ambient: [200, 91, 91], directed: [150, 75, 75], direction: [0, 0, 1] } as const;
    const out = new Uint8Array(4);
    shadeVertices(new Float32Array([0, 0, 1]), light, out, MODERN);
    expect([...out]).toEqual([255, 166, 166, 255]);
  });
});

describe('specularAlphas (RB_CalcSpecularAlpha)', () => {
  /** The light's direction from the origin, unit length. */
  const toLight = ((): [number, number, number] => {
    const [x, y, z] = SPECULAR_LIGHT_ORIGIN;
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
  })();
  const along = (direction: readonly number[], distance: number): [number, number, number] => [
    direction[0] * distance,
    direction[1] * distance,
    direction[2] * distance
  ];
  /** The alpha of a vertex at the origin with this normal, seen from `viewer`; its colour is kept. */
  function alphaAt(normal: readonly number[], viewer: [number, number, number]): number {
    const out = new Uint8Array([10, 20, 30, 40]);
    specularAlphas(new Float32Array([0, 0, 0]), new Float32Array(normal), viewer, out);
    expect([...out.slice(0, 3)]).toEqual([10, 20, 30]);
    return out[3];
  }

  /** Full: 255, or 254 where the product falls a hair short of 1, which the cast then cuts. */
  const FULL = 254;

  it('shines fully where the light mirrors straight at the viewer, and not at all behind', () => {
    // Facing the light, the light mirrors back along itself.
    expect(alphaAt(toLight, along(toLight, 64))).toBeGreaterThanOrEqual(FULL);
    expect(alphaAt(toLight, along(toLight, -64))).toBe(0);
  });

  it('falls off as the fourth power of the angle to the mirrored light', () => {
    // 60° off it: a half, to the fourth, is a sixteenth of 255, cut to 15.
    const [x, y] = toLight;
    const across = [-y, x, 0].map((v) => v / Math.hypot(x, y));
    const viewer = along(
      toLight.map((v, i) => 0.5 * v + (Math.sqrt(3) / 2) * across[i]),
      64
    );
    expect(alphaAt(toLight, viewer)).toBe(15);
  });

  it('mirrors a light behind the face too, as Q3 leaves it rather than facet the highlight', () => {
    expect(alphaAt(along(toLight, -1), along(toLight, 64))).toBeGreaterThanOrEqual(FULL);
  });
});

describe('lightInEntityFrame', () => {
  it("takes the light into an entity's frame through its axis rows (tr_light.c:375–377)", () => {
    // Turned 90° left, the entity's forward is the world's +Y, so a light along +Y is ahead of it.
    const turnedLeft = [
      [0, 1, 0],
      [-1, 0, 0],
      [0, 0, 1]
    ];
    const light = { ambient: [91, 40, 10], directed: [75, 150, 0], direction: [0, 1, 0] } as const;
    const turned = lightInEntityFrame(turnedLeft, light);
    expect(turned.direction).toEqual([1, 0, 0]);
    // Only the direction turns: the colours are the entity's whichever way it faces.
    expect(turned.ambient).toEqual(light.ambient);
    expect(turned.directed).toEqual(light.directed);
    // Unturned, the sun is where it is.
    const unturned = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ];
    expect(lightInEntityFrame(unturned)).toEqual(entityLight());
  });

  it('scales the direction by a scaled axis, so a model drawn larger is lit harder', () => {
    const half = { ambient: [91, 91, 91], directed: [75, 75, 75], direction: [0, 0, 1] } as const;
    const larger = [
      [1.5, 0, 0],
      [0, 1.5, 0],
      [0, 0, 1.5]
    ];
    expect(lightInEntityFrame(larger, half).direction).toEqual([0, 0, 1.5]);
  });

  it('writes into the light it is given, which may be the light itself', () => {
    const light = keptEntityLight();
    light.direction[1] = 1;
    const turnedLeft = [
      [0, 1, 0],
      [-1, 0, 0],
      [0, 0, 1]
    ];
    expect(lightInEntityFrame(turnedLeft, light, light)).toBe(light);
    expect(light.direction).toEqual([1, 0, 0]);
  });
});

describe('litPath', () => {
  it("shades every lit stage per vertex in opengl1's bytes, deforms or none", () => {
    expect(litPath(CLASSIC, false)).toBe('opengl1');
    expect(litPath({ ...CLASSIC, normalMapping: false, specularMapping: false }, true)).toBe('opengl1');
  });

  it("lights opengl2's per pixel while either mapping setting is on, as ioq3 has both", () => {
    expect(litPath(MODERN, false)).toBe('lightall');
    expect(litPath({ ...MODERN, normalMapping: false }, false)).toBe('lightall');
    expect(litPath({ ...MODERN, specularMapping: false }, false)).toBe('lightall');
    expect(litPath({ ...MODERN, normalMapping: false, specularMapping: false }, false)).toBe('fastLight');
  });

  it('gives a deforming shader to the generic program, whatever the settings', () => {
    expect(litPath(MODERN, true)).toBe('generic');
    expect(litPath({ ...MODERN, normalMapping: false, specularMapping: false }, true)).toBe('generic');
  });
});

describe("genericShade (generic_vp.glsl's CalcColor)", () => {
  it('sums the light over 255 with no overbright factor', () => {
    expect(genericShade(1, 91, 75)).toBeCloseTo(166 / 255, 12);
    expect(genericShade(0.6, 91, 75)).toBeCloseTo(136 / 255, 12);
    // Facing away: ambient alone.
    expect(genericShade(-0.5, 91, 75)).toBeCloseTo(91 / 255, 12);
  });

  it('holds N·L to 1 for a normal the morph left long, and the sum to 1', () => {
    expect(genericShade(1.3, 91, 75)).toBeCloseTo(166 / 255, 12);
    expect(genericShade(1, 200, 150)).toBe(1);
  });
});

describe("lightallShade (lightall_fp.glsl, a stage with no normal or specular map)", () => {
  const light: EntityLight = { ambient: [91, 91, 91], directed: [75, 75, 75], direction: [0, 0, 1] };
  const grey = [0.5, 0.5, 0.5] as const;

  it("takes CalcSpecular at 0.04, with r_baseGloss 0.3 as smoothness", () => {
    // roughness 0.7: rr = 0.49, rrrr = 0.2401. Head on, d = rrrr and v = 1.2.
    expect(calcSpecular(1, 1)).toBeCloseTo((0.04 * 0.2401) / (4 * 0.2401 ** 2 * 1.2), 9);
    // Across, d = 1.
    expect(calcSpecular(0, 1)).toBeCloseTo((0.04 * 0.2401) / (4 * 1.2), 9);
  });

  it('lights the texture, less 4%, by N·L and the ambient, and adds the highlight at 0.3', () => {
    const highlight = 0.3 * calcSpecular(1, 1);
    const lit = (2 * 75) / 255;
    const ambient = (2 * 91) / 255;
    // Lit head on, and seen head on.
    const expected = lit * (0.48 + highlight) + ambient * 0.48;
    for (const value of lightallShade(grey, [0, 0, 1], [0, 0, 64], light, 2)) {
      expect(value).toBeCloseTo(expected, 9);
    }
    // Facing away: the ambient alone, and no highlight.
    for (const value of lightallShade(grey, [0, 0, -1], [0, 0, -64], light, 2)) {
      expect(value).toBeCloseTo(ambient * 0.48, 9);
    }
  });

  it('makes the normal, the light and the way to the viewer unit, as the program does', () => {
    const long = lightallShade(grey, [0, 0, 3], [0, 0, 0.1], { ...light, direction: [0, 0, 5] }, 2);
    expect(long).toEqual(lightallShade(grey, [0, 0, 1], [0, 0, 64], light, 2));
  });

  it('shines less as the viewer moves off the mirrored light', () => {
    const head = lightallShade(grey, [0, 0, 1], [0, 0, 1], light, 2)[0];
    const off = lightallShade(grey, [0, 0, 1], [1, 0, 0.2], light, 2)[0];
    expect(off).toBeLessThan(head);
  });

  it('takes the base colour as given: 1 for a stage that multiplies, colour by channel', () => {
    const red: EntityLight = { ...light, ambient: [182, 0, 0], directed: [150, 0, 0] };
    const [r, g, b] = lightallShade([1, 1, 1], [0, 0, 1], [0, 0, 1], red, 1);
    expect(r).toBeCloseTo((150 / 255) * (0.96 + 0.3 * calcSpecular(1, 1)) + (182 / 255) * 0.96, 9);
    expect([g, b]).toEqual([0, 0]);
    // Nothing clamps it: at overbright 2 it passes 2.
    expect(lightallShade([1, 1, 1], [0, 0, 1], [0, 0, 1], red, 2)[0]).toBeGreaterThan(2);
  });
});

describe('specularAlpha', () => {
  it("truncates to opengl1's byte, and keeps opengl2's whole", () => {
    const l = 0.9;
    expect(specularAlpha(l, CLASSIC)).toBe(Math.trunc(0.9 ** 4 * 255) / 255);
    expect(specularAlpha(l, MODERN)).toBeCloseTo(0.9 ** 4, 12);
  });

  it('is 0 facing away and 1 past full, under either renderer', () => {
    for (const style of [CLASSIC, MODERN]) {
      expect(specularAlpha(-0.2, style)).toBe(0);
      expect(specularAlpha(1.2, style)).toBe(1);
    }
  });

  it("is specularAlphas' byte from mirroredLight under opengl1", () => {
    // Up, lit from high on the left: seen a little off where the light mirrors.
    const position = [0, 0, 0];
    const normal = [0, 0, 1];
    const viewer = [38, -57.5, 33] as [number, number, number];
    const out = new Uint8Array(4);
    specularAlphas(Float32Array.from(position), Float32Array.from(normal), viewer, out);
    const l = mirroredLight(Float32Array.from(position), Float32Array.from(normal), viewer);
    expect(Math.round(specularAlpha(l, CLASSIC) * 255)).toBe(out[3]);
    expect(out[3]).toBeGreaterThan(100);
    expect(out[3]).toBeLessThan(250);
  });
});
