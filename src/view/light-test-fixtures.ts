import type { Bsp } from '../formats/bsp';
import { scanFloats } from '../formats/c-scan';
import { comParse, parseCursor } from '../formats/com-parse';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import type { DynamicLight } from './dynamic-lights';
import {
  diffuseByte,
  dotFloats,
  entityLightAt,
  keptEntityLight,
  lightInEntityFrame,
  type LightingScene
} from './entity-light';
import {
  loadLightGrid,
  normalize,
  sampleLightGrid,
  worldGridSize,
  type LightGrid
} from './light-grid';
import { anglesToAxes } from './world-deforms';

/**
 * The light's corpus over a map: the grid as the map's load leaves it, then each item and spawn
 * point, seeded points and the hand cases sampled, lit with seeded lights and turned, and shaded at
 * seeded normals, the same draws the twin of ioquake3's own `tr_light.c` makes, each kind digested
 * as the twin digests it. Every value is made in floats as the twin's C makes it.
 */

const f = Math.fround;

/** Each kind's digest at one `r_overBrightBits`, as the twin prints them. */
export interface LightDigests {
  grid: string;
  sample: string;
  light: string;
  diffuse: string;
  noworld: string;
  nodiffuse: string;
}

/** A map's corpus: how many items and spawn points, how many points, and the digests. */
export interface LightCorpus {
  spots: number;
  points: number;
  ob1: LightDigests;
  ob0: LightDigests;
}

/** The normals each entity is shaded at. */
const NORMALS = 8;
/** The seeded points a map gets, past its items and spawn points. */
const SEEDED = 2000;
/** The points lit again in a scene with no world. */
const NOWORLD = 64;
/** The classnames whose origins are taken, by their start. */
const SPOTS = ['item_', 'weapon_', 'ammo_', 'holdable_', 'info_player_', 'team_CTF_'];

/** The twin's `pick`: a number below `n`, from the high bits. */
function pick(random: Seeded, n: number): number {
  return (random.next() >>> 8) % n;
}

/** Every item's and spawn point's origin, and 24 units above it, as the twin's `addSpots`. */
function spots(text: string): { points: number[][]; spots: number } {
  const points: number[][] = [];
  let count = 0;
  const cursor = parseCursor(text);
  for (;;) {
    const open = comParse(cursor);
    if (open === '' || open[0] !== '{') break;
    let classname = '';
    let origin = '';
    for (;;) {
      const key = comParse(cursor);
      if (key === '' || key[0] === '}') break;
      const value = comParse(cursor);
      if (value === '') break;
      if (key === 'classname') classname = value;
      if (key === 'origin') origin = value;
    }
    if (!SPOTS.some((prefix) => classname.startsWith(prefix))) continue;
    const v = scanFloats(origin).map(f);
    if (v.length !== 3) continue;
    points.push(v, [v[0], v[1], f(v[2] + 24)]);
    count++;
  }
  return { points, spots: count };
}

/** The twin's `addSeeded`: through the world and 64 past it, a quarter on a grid plane. */
function seeded(random: Seeded, bsp: Bsp, grid: LightGrid, size: number[]): number[][] {
  const { mins, maxs } = bsp.models[0];
  const points: number[][] = [];
  for (let k = 0; k < SEEDED; k++) {
    const v = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      if (pick(random, 4) === 0) {
        const n = pick(random, grid.bounds[a] + 2) - 1;
        v[a] = f(grid.origin[a] + f(size[a] * n));
      } else {
        const span = Math.trunc(f(maxs[a] - mins[a])) + 128;
        v[a] = f(f(mins[a] - 64) + f(pick(random, span * 256) / 256));
      }
    }
    points.push(v);
  }
  return points;
}

/**
 * The twin's `addHand`: below the grid, past its top, the first cell wholly in a wall, and the
 * first with a corner lit by its directed light alone.
 */
function hand(grid: LightGrid, size: number[]): number[][] {
  const { origin, bounds, data } = grid;
  const at = (k: number[]) => k.map((v, a) => f(origin[a] + f(size[a] * f(v + 0.5))));
  const points = [
    [0, 1, 2].map((a) => f(origin[a] - f(size[a] * 1.5))),
    at([bounds[0], bounds[1], bounds[2]])
  ];
  let wall = false;
  let directed = false;
  for (let z = 0; z < bounds[2] - 1; z++) {
    for (let y = 0; y < bounds[1] - 1; y++) {
      for (let x = 0; x < bounds[0] - 1; x++) {
        let walls = 0;
        let directedOnly = 0;
        for (let i = 0; i < 8; i++) {
          const row = (z + ((i >> 2) & 1)) * bounds[1] + y + ((i >> 1) & 1);
          const d = (row * bounds[0] + x + (i & 1)) * 8;
          if (data[d] + data[d + 1] + data[d + 2] !== 0) continue;
          walls++;
          if (data[d + 3] + data[d + 4] + data[d + 5] !== 0) directedOnly++;
        }
        if (!wall && walls === 8) {
          wall = true;
          points.push(at([x, y, z]));
        }
        if (!directed && directedOnly > 0 && walls < 8) {
          directed = true;
          points.push(at([x, y, z]));
        }
      }
    }
  }
  return points;
}

/**
 * The twin's `lightOne`: an entity at a point, turned by seeded angles, lit by up to three seeded
 * lights about it, and shaded at eight seeded normals, each value digested in turn.
 */
function lightOne(
  random: Seeded,
  at: number[],
  grid: LightGrid | null,
  overBrightBits: number,
  light: Digest,
  diffuse: Digest
): void {
  const angles = random.vec(360 * 256);
  const axis = anglesToAxes(angles[0], angles[1], angles[2], [
    new Float32Array(3),
    new Float32Array(3),
    new Float32Array(3)
  ]);
  const lights: DynamicLight[] = [];
  const count = pick(random, 4);
  for (let i = 0; i < count; i++) {
    const offset = random.vec(512 * 256);
    const origin = { x: f(at[0] + offset[0]), y: f(at[1] + offset[1]), z: f(at[2] + offset[2]) };
    const radius = 50 + pick(random, 400);
    const color = [0, 1, 2].map(() => f(pick(random, 256) / 255)) as [number, number, number];
    lights.push({ origin, radius, color, additive: false });
  }
  const normals: [number, number, number][] = [];
  for (let i = 0; i < NORMALS; i++) {
    const [x, y, z] = random.vec(256);
    const normal: [number, number, number] = [x, y, z];
    normalize(x, y, z, normal);
    normals.push(normal);
  }
  const scene: LightingScene = { grid, lights, ambientScale: 0.6, directedScale: 1 };
  const style = { renderer: 'opengl1', overBrightBits } as const;
  const lit = entityLightAt({ x: at[0], y: at[1], z: at[2] }, scene, style, keptEntityLight());
  lightInEntityFrame(axis, lit, lit);
  const { ambient, directed, direction } = lit;
  for (const value of ambient) light.float(value);
  for (const value of directed) light.float(value);
  const bytes = ambient.map((value) => Math.trunc(value));
  light.int(bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (0xff << 24));
  for (const value of direction) light.float(value);
  const colors = new Uint8Array(NORMALS * 4);
  normals.forEach(([x, y, z], i) => {
    const incoming = dotFloats(x, y, z, direction);
    for (let c = 0; c < 3; c++) colors[i * 4 + c] = diffuseByte(incoming, ambient[c], directed[c]);
    colors[i * 4 + 3] = 255;
  });
  diffuse.uint8s(colors, 0, colors.length);
}

/** One `r_overBrightBits`' digests, as the twin's main loop makes them. */
function digests(
  bsp: Bsp,
  overBrightBits: number
): { digests: LightDigests; spots: number; points: number } {
  const size = worldGridSize(bsp.entityString, () => {});
  const { mins, maxs } = bsp.models[0];
  const grid = loadLightGrid(bsp.lightGrid, mins, maxs, size, 2 - overBrightBits, () => {});
  if (!grid) throw new Error('no grid');
  const gridDigest = new Digest();
  for (const value of size) gridDigest.float(value);
  for (const value of grid.origin) gridDigest.float(value);
  for (const value of grid.bounds) gridDigest.int(value);
  gridDigest.uint8s(grid.data, 0, grid.data.length);

  const random = new Seeded(6);
  const found = spots(bsp.entityString);
  const points = [...found.points, ...seeded(random, bsp, grid, size), ...hand(grid, size)];
  const sample = new Digest();
  const light = new Digest();
  const diffuse = new Digest();
  const out = keptEntityLight();
  for (const point of points) {
    sampleLightGrid(grid, { x: point[0], y: point[1], z: point[2] }, 0.6, 1, out);
    for (const value of [...out.ambient, ...out.directed, ...out.direction]) sample.float(value);
    lightOne(random, point, grid, overBrightBits, light, diffuse);
  }
  const noworld = new Digest();
  const nodiffuse = new Digest();
  for (const point of points.slice(0, NOWORLD)) {
    lightOne(random, point, null, overBrightBits, noworld, nodiffuse);
  }
  return {
    digests: {
      grid: gridDigest.hex(),
      sample: sample.hex(),
      light: light.hex(),
      diffuse: diffuse.hex(),
      noworld: noworld.hex(),
      nodiffuse: nodiffuse.hex()
    },
    spots: found.spots,
    points: points.length
  };
}

/** A map's light corpus, at `r_overBrightBits` 1 and 0, `r_mapOverBrightBits` 2. */
export function lightCorpus(bsp: Bsp): LightCorpus {
  const ob1 = digests(bsp, 1);
  const ob0 = digests(bsp, 0);
  return { spots: ob1.spots, points: ob1.points, ob1: ob1.digests, ob0: ob0.digests };
}
