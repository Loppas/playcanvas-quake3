import { scanFloats } from '../formats/c-scan';
import { comParse, parseCursor } from '../formats/com-parse';
import type { Vec3 } from '../sim/vec3';
import type { KeptEntityLight } from './entity-light';
import { FUNCTABLE_SIZE, SIN_TABLE } from './stage-motion';
import { colorShiftLightingBytes } from './world-light';

/**
 * A map's light grid: the light q3map baked at points through the map's volume, which lights every
 * model on it (`R_LoadLightGrid`, `R_SetupEntityLightingGrid`). Worked in Quake 3's floats, each
 * operation rounded as the C rounds it: in doubles the light misses Quake 3's by an ulp at almost
 * half its points.
 *
 * Engine-free, like the rest of `src/view/`.
 */

const f = Math.fround;

/** `lightGridSize`'s default (`tr_bsp.c:1698-1700`): a point every 64 units across, 128 up. */
export const DEFAULT_GRID_SIZE: readonly [number, number, number] = [64, 64, 128];

/** A point's bytes: its ambient and directed colours, then its direction's longitude, latitude. */
const POINT_BYTES = 8;

/** A map's light grid, as `R_LoadLightGrid` leaves it in `world_t` (`tr_bsp.c:1646-1684`). */
export interface LightGrid {
  /** `lightGridInverseSize`. */
  readonly inverseSize: readonly [number, number, number];
  /** `lightGridOrigin`: where its first point stands. */
  readonly origin: readonly [number, number, number];
  /** `lightGridBounds`: its points along each axis. */
  readonly bounds: readonly [number, number, number];
  /** Its points, x fastest, then y: {@link POINT_BYTES} each, their colours shifted. */
  readonly data: Uint8Array;
}

/**
 * `R_LoadEntities`' read of the worldspawn (`tr_bsp.c:1691-1764`): its `gridsize`, `sscanf`'s
 * numbers over the defaults, the key in any case. Only the first entity is read, and a key or value
 * that is missing or starts with `}` ends it. A `remapshader` or `vertexremapshader` value with no
 * `;` ends it too, warned of.
 *
 * @param entityString - The map's entity text.
 * @param warn - Where `ri.Printf`'s warnings go.
 */
export function worldGridSize(
  entityString: string,
  warn: (text: string) => void
): [number, number, number] {
  const size: [number, number, number] = [...DEFAULT_GRID_SIZE];
  const cursor = parseCursor(entityString);
  const open = comParse(cursor);
  if (open === '' || open[0] !== '{') return size;
  for (;;) {
    const key = comParse(cursor);
    if (key === '' || key[0] === '}') break;
    const value = comParse(cursor);
    if (value === '' || value[0] === '}') break;
    // Each a prefix, in its own case (`Q_strncmp`). The swaps they name are not made.
    if (key.startsWith('vertexremapshader')) {
      if (value.includes(';')) continue;
      warn(`WARNING: no semi colon in vertexshaderremap '${value}'\n`);
      break;
    }
    if (key.startsWith('remapshader')) {
      if (value.includes(';')) continue;
      warn(`WARNING: no semi colon in shaderremap '${value}'\n`);
      break;
    }
    if (key.toLowerCase() === 'gridsize') {
      scanFloats(value).forEach((read, i) => (size[i] = f(read)));
    }
  }
  return size;
}

/**
 * `R_LoadLightGrid` (`tr_bsp.c:1646-1684`): the grid over the world model's bounds at `size`, each
 * point's two colours shifted as the lightmaps are. A lump of any other length than the points'
 * is Quake 3's "light grid mismatch", and no grid: every model is then lit as on a map with none.
 *
 * @param lump - The grid's lump, as stored.
 * @param mins - The world model's bounds.
 * @param size - The worldspawn's {@link worldGridSize}.
 * @param shift - What the map's light is shifted by (`world-light.ts`).
 * @param warn - Where `ri.Printf`'s warnings go.
 */
export function loadLightGrid(
  lump: Uint8Array,
  mins: readonly number[],
  maxs: readonly number[],
  size: readonly number[],
  shift: number,
  warn: (text: string) => void
): LightGrid | null {
  const inverseSize: [number, number, number] = [0, 0, 0];
  const origin: [number, number, number] = [0, 0, 0];
  const bounds: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    inverseSize[i] = f(1 / size[i]);
    // `ceil` and `floor` take doubles, and the product is a double until it is stored.
    origin[i] = f(size[i] * Math.ceil(f(mins[i] / size[i])));
    const top = f(size[i] * Math.floor(f(maxs[i] / size[i])));
    // A float stored in an `int`, truncated.
    bounds[i] = Math.trunc(f(f(f(top - origin[i]) / size[i]) + 1));
  }
  const points = bounds[0] * bounds[1] * bounds[2];
  if (lump.length !== points * POINT_BYTES) {
    warn('WARNING: light grid mismatch\n');
    return null;
  }
  const data = lump.slice();
  for (let i = 0; i < points; i++) {
    colorShiftLightingBytes(data, i * POINT_BYTES, data, i * POINT_BYTES, shift);
    colorShiftLightingBytes(data, i * POINT_BYTES + 3, data, i * POINT_BYTES + 3, shift);
  }
  return { inverseSize, origin, bounds, data };
}

/** `FUNCTABLE_MASK`. */
const FUNCTABLE_MASK = FUNCTABLE_SIZE - 1;

/** Scratch for a sample: the light origin, each axis's cell and how far into it. */
const lightOrigin = new Float32Array(3);
const cell = new Int32Array(3);
const frac = new Float32Array(3);
const step = new Int32Array(3);
const toward = new Float32Array(3);

/**
 * `R_SetupEntityLightingGrid` (`tr_light.c:126-248`): the light at a point, blended from the eight
 * points about it by how near each is. Each is weighed by its colours and its direction alike.
 *
 * - **Below the grid** a point's share of each point is taken before it is clamped to the first
 *   cell: 0.3 of a cell below, it takes the first point at 0.3 and the second at 0.7. **Above**
 *   it, the edge's points alone are taken, as ioquake3 skips the points past the grid (`:185-187`)
 *   that id's read past the row's end.
 * - **A point in a wall** is one with no ambient colour, whatever its directed one, and is skipped.
 *   Where those skipped leave less than 0.99 of the weight, the rest are weighed up to the whole.
 * - The colours are then scaled by `r_ambientScale` and `r_directedScale`, and the direction made
 *   unit, or left as nothing where no point was taken.
 *
 * @param origin - The entity's light origin, in Quake's world frame.
 * @param ambientScale - `r_ambientScale`.
 * @param directedScale - `r_directedScale`.
 * @param out - Where the light is written, its direction in the world's frame.
 */
export function sampleLightGrid(
  grid: LightGrid,
  origin: Readonly<Vec3>,
  ambientScale: number,
  directedScale: number,
  out: KeptEntityLight
): void {
  const { data, bounds, inverseSize } = grid;
  lightOrigin[0] = origin.x;
  lightOrigin[1] = origin.y;
  lightOrigin[2] = origin.z;
  for (let i = 0; i < 3; i++) {
    const v = f(f(lightOrigin[i] - grid.origin[i]) * inverseSize[i]);
    const pos = Math.floor(v);
    // Taken before the clamp.
    frac[i] = v - pos;
    cell[i] = pos < 0 ? 0 : pos > bounds[i] - 1 ? bounds[i] - 1 : pos;
  }
  const { ambient, directed, direction } = out;
  ambient.fill(0);
  directed.fill(0);
  toward.fill(0);
  step[0] = POINT_BYTES;
  step[1] = POINT_BYTES * bounds[0];
  step[2] = POINT_BYTES * bounds[0] * bounds[1];
  const base = cell[0] * step[0] + cell[1] * step[1] + cell[2] * step[2];
  let total = 0;
  for (let i = 0; i < 8; i++) {
    let factor = 1;
    let point = base;
    let j = 0;
    for (; j < 3; j++) {
      if (i & (1 << j)) {
        if (cell[j] + 1 > bounds[j] - 1) break;
        factor = f(factor * frac[j]);
        point += step[j];
      } else {
        factor = f(factor * f(1 - frac[j]));
      }
    }
    if (j !== 3) continue;
    if (data[point] + data[point + 1] + data[point + 2] === 0) continue;
    total = f(total + factor);
    for (let c = 0; c < 3; c++) {
      ambient[c] = f(ambient[c] + f(factor * data[point + c]));
      directed[c] = f(directed[c] + f(factor * data[point + 3 + c]));
    }
    const lat = data[point + 7] * (FUNCTABLE_SIZE / 256);
    const lng = data[point + 6] * (FUNCTABLE_SIZE / 256);
    const quarter = FUNCTABLE_SIZE / 4;
    const normalX = f(SIN_TABLE[(lat + quarter) & FUNCTABLE_MASK] * SIN_TABLE[lng]);
    const normalY = f(SIN_TABLE[lat] * SIN_TABLE[lng]);
    const normalZ = SIN_TABLE[(lng + quarter) & FUNCTABLE_MASK];
    toward[0] = f(toward[0] + f(normalX * factor));
    toward[1] = f(toward[1] + f(normalY * factor));
    toward[2] = f(toward[2] + f(normalZ * factor));
  }
  // The 0.99 is a double.
  if (total > 0 && total < 0.99) {
    const whole = f(1 / total);
    for (let c = 0; c < 3; c++) {
      ambient[c] = f(ambient[c] * whole);
      directed[c] = f(directed[c] * whole);
    }
  }
  const ambientBy = f(ambientScale);
  const directedBy = f(directedScale);
  for (let c = 0; c < 3; c++) {
    ambient[c] = f(ambient[c] * ambientBy);
    directed[c] = f(directed[c] * directedBy);
  }
  normalize(toward[0], toward[1], toward[2], direction, true);
}

/**
 * `VectorNormalize` (`q_math.c:790-807`) in floats: a triple made unit through the inverse of its
 * length. One with no length is left as it is, the signs of its zeros with it, which a dot product
 * with it then keeps.
 *
 * @param clear - As `VectorNormalize2` (`:809-829`) does instead: one with no length is written as
 *   nothing, every zero positive.
 * @returns its length, as the C works it out
 */
export function normalize(
  x: number,
  y: number,
  z: number,
  out: [number, number, number],
  clear = false
): number {
  let length = f(f(f(x * x) + f(y * y)) + f(z * z));
  if (length === 0) {
    out[0] = clear ? 0 : x;
    out[1] = clear ? 0 : y;
    out[2] = clear ? 0 : z;
    return 0;
  }
  const inverse = f(1 / f(Math.sqrt(length)));
  length = f(length * inverse);
  out[0] = f(x * inverse);
  out[1] = f(y * inverse);
  out[2] = f(z * inverse);
  return length;
}
