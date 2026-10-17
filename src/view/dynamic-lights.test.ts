import { describe, expect, it } from 'vitest';
import {
  DLIGHT_SIZE,
  MAX_DLIGHTS,
  SceneLights,
  dlightClip,
  dlightImage,
  dlightModulate,
  dlightTexel,
  dlightVertex,
  lightWorld,
  projectLight,
  projectedLight,
  worldLightSource,
  type DynamicLight
} from './dynamic-lights';

const ORIGIN = { x: 1, y: 2, z: 3 };
const BLUE = [0.2, 0.2, 1] as const;
const CLASSIC = { renderer: 'opengl1', overBrightBits: 1 } as const;
const MODERN = { renderer: 'opengl2', overBrightBits: 1 } as const;

/** A light as the scene holds one. */
function light(origin: DynamicLight['origin'], radius: number, color: DynamicLight['color'], additive = false): DynamicLight {
  return { origin, radius, color, additive };
}

describe('SceneLights (RE_AddDynamicLightToScene)', () => {
  it('keeps each light as it was added, in order', () => {
    const scene = new SceneLights();
    scene.add(ORIGIN, 216, BLUE);
    scene.add({ x: 4, y: 5, z: 6 }, 300, [1, 0.75, 0], true);
    expect(scene.lights).toEqual([
      { origin: ORIGIN, radius: 216, color: [0.2, 0.2, 1], additive: false },
      { origin: { x: 4, y: 5, z: 6 }, radius: 300, color: [1, 0.75, 0], additive: true }
    ]);
  });

  it('copies what it is given, so a source moving on later moves no light', () => {
    const scene = new SceneLights();
    const origin = { ...ORIGIN };
    const color: [number, number, number] = [0.2, 0.2, 1];
    scene.add(origin, 216, color);
    origin.x = 99;
    color[0] = 99;
    expect(scene.lights[0].origin.x).toBe(1);
    expect(scene.lights[0].color[0]).toBe(0.2);
  });

  it('keeps the first 32 and drops every later one', () => {
    const scene = new SceneLights();
    for (let i = 0; i < MAX_DLIGHTS + 3; i++) scene.add({ x: i, y: 0, z: 0 }, 100, BLUE);
    expect(scene.lights).toHaveLength(32);
    expect(scene.lights[31].origin.x).toBe(31);
  });

  it('drops a light with no reach', () => {
    const scene = new SceneLights();
    scene.add(ORIGIN, 0, BLUE);
    scene.add(ORIGIN, -5, BLUE);
    expect(scene.lights).toEqual([]);
  });

  it('starts each frame empty', () => {
    const scene = new SceneLights();
    scene.add(ORIGIN, 216, BLUE);
    scene.clear();
    expect(scene.lights).toEqual([]);
  });

  it('gives none while r_dynamiclight is 0, and every one again once it is back', () => {
    const scene = new SceneLights();
    scene.add(ORIGIN, 216, BLUE);
    scene.enabled = false;
    expect(scene.lights).toEqual([]);
    scene.enabled = true;
    expect(scene.lights).toHaveLength(1);
  });
});

describe("the light's image (R_CreateDlightImage)", () => {
  it('is 4000 over the squared distance from its middle, 255 at most and nothing under 75', () => {
    // Along a row through the middle: its four middle texels at 255, and its edge at nothing.
    const row = Array.from({ length: DLIGHT_SIZE }, (_, x) => dlightTexel(x, 7));
    expect(row).toEqual([0, 94, 131, 195, 255, 255, 255, 255, 255, 255, 255, 255, 195, 131, 94, 0]);
    // 4000 / (5.5² + 0.5²) is 131.1, cut to an int; 4000 / (4.5² + 3.5²) is 123.
    expect(dlightTexel(2, 8)).toBe(131);
    expect(dlightTexel(3, 4)).toBe(123);
    expect(dlightTexel(0, 0)).toBe(0);
    expect(dlightTexel(15, 15)).toBe(0);
  });

  it('falls off sideways as `ProjectDlightTexture` works it, either way along either axis', () => {
    // T at each offset from the light, in radii, worked from `tr_shade.c:432-461`.
    const table = [
      [0, 1],
      [0.2, 1],
      [0.25, 0.88],
      [0.3, 0.69],
      [0.35, 0.5],
      [0.4, 0.38],
      [0.44, 0.17],
      [0.47, 0],
      [0.5, 0],
      [0.75, 0],
      [1, 0]
    ];
    for (const [offset, expected] of table) {
      for (const [s, t] of [
        [0.5 + offset, 0.5],
        [0.5 - offset, 0.5],
        [0.5, 0.5 + offset],
        [0.5, 0.5 - offset]
      ]) {
        expect(dlightImage(s, t), `${offset} at (${s}, ${t})`).toBeCloseTo(expected, 2);
      }
    }
  });

  it('samples between texels as GL_LINEAR does, and holds to its zero edge past it', () => {
    // Halfway between texel 2 (131) and texel 3 (195) of the middle row, which is itself halfway
    // between rows 7 and 8, both alike.
    const s = (2.5 + 0.5) / DLIGHT_SIZE;
    expect(dlightImage(s, 0.5)).toBeCloseTo((131 + 195) / 2 / 255, 12);
    expect(dlightImage(-3, 0.5)).toBe(0);
    expect(dlightImage(0.5, 4)).toBe(0);
  });
});

describe("a light's reach up and down (ProjectDlightTexture's modulate)", () => {
  it('is whole within half the radius, then less in a line, to nothing at the radius', () => {
    expect(dlightModulate(0, 200)).toBe(1);
    expect(dlightModulate(99, 200)).toBe(1);
    expect(dlightModulate(100, 200)).toBe(1);
    expect(dlightModulate(150, 200)).toBe(0.5);
    expect(dlightModulate(-150, 200)).toBe(0.5);
    expect(dlightModulate(200, 200)).toBe(0);
    expect(dlightModulate(201, 200)).toBe(0);
  });
});

describe("the world's light (ProjectDlightTexture)", () => {
  const QUAD = light({ x: 100, y: -40, z: 64 }, 200, BLUE);

  it('under the quad, lights blue twice over and red and green a fifth again', () => {
    const floor = { x: 100, y: -40, z: 24 };
    for (const style of [CLASSIC, MODERN]) {
      const lit = lightWorld([0.25, 0.25, 0.25], floor, [QUAD], style);
      expect(lit[0], style.renderer).toBeCloseTo(0.3, 12);
      expect(lit[1], style.renderer).toBeCloseTo(0.3, 12);
      expect(lit[2], style.renderer).toBeCloseTo(0.5, 12);
    }
  });

  it('reaches about 0.47 of its radius to the side, down z, and its radius up and down', () => {
    expect(worldLightSource(QUAD, { x: 100 + 0.47 * 200, y: -40, z: 64 }, CLASSIC)).toEqual([0, 0, 0]);
    expect(worldLightSource(QUAD, { x: 100, y: -40 - 0.47 * 200, z: 64 }, CLASSIC)).toEqual([0, 0, 0]);
    // A light's own reach sideways, 0.44 of it, is at the image's; along z it is not the image.
    expect(worldLightSource(QUAD, { x: 100, y: -40 + 0.44 * 200, z: 64 }, MODERN)[2]).toBeCloseTo(0.17, 2);
    expect(worldLightSource(QUAD, { x: 100, y: -40, z: 64 - 0.47 * 200 }, MODERN)[2]).toBe(1);
    expect(worldLightSource(QUAD, { x: 100, y: -40, z: 64 - 201 }, CLASSIC)).toEqual([0, 0, 0]);
  });

  it("writes the colour's share as a truncated byte in opengl1, and whole in opengl2", () => {
    // 0.6 of the radius below: 0.8 of the light, and 255 · 0.2 · 0.8 is 40.8, which ioq3's ri.ftol
    // truncates to 40 where id's myftol rounds it to 41.
    const below = { x: 100, y: -40, z: 64 - 120 };
    expect(worldLightSource(QUAD, below, CLASSIC)[0]).toBeCloseTo(40 / 255, 12);
    expect(worldLightSource(QUAD, below, MODERN)[0]).toBeCloseTo(0.16, 12);
    expect(worldLightSource(QUAD, below, CLASSIC)[2]).toBeCloseTo(204 / 255, 12);
  });

  it('multiplies by each light in turn, adds an additive one, and cannot light black', () => {
    const point = { x: 100, y: -40, z: 24 };
    const rocket = light({ x: 110, y: -40, z: 40 }, 200, [1, 0.75, 0]);
    const glow = light({ x: 100, y: -30, z: 24 }, 100, [0.5, 0, 0], true);
    const [q, r, g] = [QUAD, rocket, glow].map((one) => worldLightSource(one, point, MODERN));
    const lit = lightWorld([0.25, 0.5, 0.125], point, [QUAD, rocket, glow], MODERN);
    [0.25, 0.5, 0.125].forEach((start, i) => {
      expect(lit[i], `${i}`).toBeCloseTo(start * (1 + q[i]) * (1 + r[i]) + g[i], 12);
    });
    expect(g[0]).toBeGreaterThan(0);
    expect(lightWorld([0, 0, 0], point, [QUAD, rocket], MODERN)).toEqual([0, 0, 0]);
    expect(lightWorld([0, 0, 0], point, [glow], MODERN)[0]).toBeCloseTo(g[0], 12);
    expect(lightWorld([0.25, 0.5, 0.125], point, [], MODERN)).toEqual([0.25, 0.5, 0.125]);
  });
});

describe("a batch's pass (ProjectDlightTexture)", () => {
  const f = Math.fround;
  /** A light at the origin of the batch's frame, of radius 100, in the rocket's colour. */
  const rocket = () => projectLight(light(ORIGIN, 100, [1, 0.75, 0]), 0, 0, 0, projectedLight());

  it('takes the light in floats: its radius, one over it, and its colour times 255', () => {
    const flash = light(ORIGIN, 300.1, [0.6, 0.6, 1]);
    const projected = projectLight(flash, 1.5, -2, 3, projectedLight());
    expect(Array.from(projected.origin)).toEqual([1.5, -2, 3]);
    expect(projected.radius).toBe(f(300.1));
    expect(projected.scale).toBe(f(1 / f(300.1)));
    expect(Array.from(projected.color)).toEqual([f(f(0.6) * 255), f(f(0.6) * 255), 255]);
    expect(projected.additive).toBe(false);
  });

  it('clips a vertex past each edge of the image, and past the radius above or below', () => {
    const projected = rocket();
    const clip = (x: number, y: number, z: number) => dlightClip(projected, x, y, z);
    expect(clip(0, 0, 0)).toBe(0);
    // The image spans half the radius each way, down the frame's z.
    const edges = [clip(60, 0, 0), clip(-60, 0, 0), clip(0, 60, 0), clip(0, -60, 0)];
    expect(edges).toEqual([1, 2, 4, 8]);
    // On its edge is in.
    expect([clip(50, 0, 0), clip(0, -50, 0)]).toEqual([0, 0]);
    expect([clip(0, 0, -101), clip(0, 0, 101), clip(0, 0, 100)]).toEqual([16, 32, 0]);
    expect(clip(60, 60, -101)).toBe(1 | 4 | 16);
  });

  it("places a vertex on the image, and gives it the colour's bytes at its height", () => {
    const projected = rocket();
    const vertex = { s: 0, t: 0, color: new Uint8Array(3) };
    dlightVertex(projected, 25, -10, 0, vertex);
    const scale = f(1 / 100);
    expect([vertex.s, vertex.t]).toEqual([f(0.5 + f(-25 * scale)), f(0.5 + f(10 * scale))]);
    expect(Array.from(vertex.color)).toEqual([255, 191, 0]);
    // 75 below: half of it, 127.5 and 95.625 cut down.
    expect(Array.from(dlightVertex(projected, 0, 0, -75, vertex).color)).toEqual([127, 95, 0]);
    expect(Array.from(dlightVertex(projected, 0, 0, 100, vertex).color)).toEqual([0, 0, 0]);
    expect(Array.from(dlightVertex(projected, 0, 0, -101, vertex).color)).toEqual([0, 0, 0]);
  });

  it("gives a vertex half the radius off the falling share, which Q3's floats keep under 1", () => {
    // 41 × f(1/41) rounds to just under 1: 254, where the whole share would give 255.
    const projected = projectLight(light(ORIGIN, 41, [1, 1, 1]), 0, 0, 0, projectedLight());
    const vertex = dlightVertex(projected, 0, 0, -20.5, { s: 0, t: 0, color: new Uint8Array(3) });
    expect(Array.from(vertex.color)).toEqual([254, 254, 254]);
  });

  it('wraps a colour over 1 as a long stored in a byte', () => {
    const bright = projectLight(light(ORIGIN, 100, [2, 1, 0]), 0, 0, 0, projectedLight());
    const vertex = dlightVertex(bright, 0, 0, 0, { s: 0, t: 0, color: new Uint8Array(3) });
    expect(Array.from(vertex.color)).toEqual([510 & 255, 255, 0]);
  });
});
