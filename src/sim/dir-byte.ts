import { vec3, type Vec3 } from './vec3';

/**
 * A direction in one byte (`q_math.c:68–190`): the table Quake 3 quantises surface normals to,
 * and the two conversions either side of the wire.
 *
 * An impact carries the surface it struck, and a normal costs three floats. Quake 3 sends an
 * index into a fixed table of 162 directions instead, in the one byte `eventParm` already has, so
 * the event that says a rocket hit a wall costs nothing more than the event itself.
 *
 * The table is the icosahedral vertex-normal set Quake II used for its model normals, reused
 * here. Its directions are spread evenly over the sphere, about 15 degrees apart, which is close
 * enough for a scorch mark and a spark spray and is what every client in the world decodes.
 */

/** `NUMVERTEXNORMALS`: how many directions there are, and so what a byte may hold. */
export const NUM_VERTEX_NORMALS = 162;

/**
 * `bytedirs` (`q_math.c:68`), flat: three numbers per direction.
 *
 * Flat rather than a list of vectors so that nothing can hand a caller a reference into the
 * table and have it written through.
 */
const BYTE_DIRS: readonly number[] = [
  -0.525731, 0, 0.850651, -0.442863, 0.238856, 0.864188, -0.295242, 0, 0.955423,
  -0.309017, 0.5, 0.809017, -0.16246, 0.262866, 0.951056, 0, 0, 1,
  0, 0.850651, 0.525731, -0.147621, 0.716567, 0.681718, 0.147621, 0.716567, 0.681718,
  0, 0.525731, 0.850651, 0.309017, 0.5, 0.809017, 0.525731, 0, 0.850651,
  0.295242, 0, 0.955423, 0.442863, 0.238856, 0.864188, 0.16246, 0.262866, 0.951056,
  -0.681718, 0.147621, 0.716567, -0.809017, 0.309017, 0.5, -0.587785, 0.425325, 0.688191,
  -0.850651, 0.525731, 0, -0.864188, 0.442863, 0.238856, -0.716567, 0.681718, 0.147621,
  -0.688191, 0.587785, 0.425325, -0.5, 0.809017, 0.309017, -0.238856, 0.864188, 0.442863,
  -0.425325, 0.688191, 0.587785, -0.716567, 0.681718, -0.147621, -0.5, 0.809017, -0.309017,
  -0.525731, 0.850651, 0, 0, 0.850651, -0.525731, -0.238856, 0.864188, -0.442863,
  0, 0.955423, -0.295242, -0.262866, 0.951056, -0.16246, 0, 1, 0,
  0, 0.955423, 0.295242, -0.262866, 0.951056, 0.16246, 0.238856, 0.864188, 0.442863,
  0.262866, 0.951056, 0.16246, 0.5, 0.809017, 0.309017, 0.238856, 0.864188, -0.442863,
  0.262866, 0.951056, -0.16246, 0.5, 0.809017, -0.309017, 0.850651, 0.525731, 0,
  0.716567, 0.681718, 0.147621, 0.716567, 0.681718, -0.147621, 0.525731, 0.850651, 0,
  0.425325, 0.688191, 0.587785, 0.864188, 0.442863, 0.238856, 0.688191, 0.587785, 0.425325,
  0.809017, 0.309017, 0.5, 0.681718, 0.147621, 0.716567, 0.587785, 0.425325, 0.688191,
  0.955423, 0.295242, 0, 1, 0, 0, 0.951056, 0.16246, 0.262866,
  0.850651, -0.525731, 0, 0.955423, -0.295242, 0, 0.864188, -0.442863, 0.238856,
  0.951056, -0.16246, 0.262866, 0.809017, -0.309017, 0.5, 0.681718, -0.147621, 0.716567,
  0.850651, 0, 0.525731, 0.864188, 0.442863, -0.238856, 0.809017, 0.309017, -0.5,
  0.951056, 0.16246, -0.262866, 0.525731, 0, -0.850651, 0.681718, 0.147621, -0.716567,
  0.681718, -0.147621, -0.716567, 0.850651, 0, -0.525731, 0.809017, -0.309017, -0.5,
  0.864188, -0.442863, -0.238856, 0.951056, -0.16246, -0.262866, 0.147621, 0.716567, -0.681718,
  0.309017, 0.5, -0.809017, 0.425325, 0.688191, -0.587785, 0.442863, 0.238856, -0.864188,
  0.587785, 0.425325, -0.688191, 0.688191, 0.587785, -0.425325, -0.147621, 0.716567, -0.681718,
  -0.309017, 0.5, -0.809017, 0, 0.525731, -0.850651, -0.525731, 0, -0.850651,
  -0.442863, 0.238856, -0.864188, -0.295242, 0, -0.955423, -0.16246, 0.262866, -0.951056,
  0, 0, -1, 0.295242, 0, -0.955423, 0.16246, 0.262866, -0.951056,
  -0.442863, -0.238856, -0.864188, -0.309017, -0.5, -0.809017, -0.16246, -0.262866, -0.951056,
  0, -0.850651, -0.525731, -0.147621, -0.716567, -0.681718, 0.147621, -0.716567, -0.681718,
  0, -0.525731, -0.850651, 0.309017, -0.5, -0.809017, 0.442863, -0.238856, -0.864188,
  0.16246, -0.262866, -0.951056, 0.238856, -0.864188, -0.442863, 0.5, -0.809017, -0.309017,
  0.425325, -0.688191, -0.587785, 0.716567, -0.681718, -0.147621, 0.688191, -0.587785, -0.425325,
  0.587785, -0.425325, -0.688191, 0, -0.955423, -0.295242, 0, -1, 0,
  0.262866, -0.951056, -0.16246, 0, -0.850651, 0.525731, 0, -0.955423, 0.295242,
  0.238856, -0.864188, 0.442863, 0.262866, -0.951056, 0.16246, 0.5, -0.809017, 0.309017,
  0.716567, -0.681718, 0.147621, 0.525731, -0.850651, 0, -0.238856, -0.864188, -0.442863,
  -0.5, -0.809017, -0.309017, -0.262866, -0.951056, -0.16246, -0.850651, -0.525731, 0,
  -0.716567, -0.681718, -0.147621, -0.716567, -0.681718, 0.147621, -0.525731, -0.850651, 0,
  -0.5, -0.809017, 0.309017, -0.238856, -0.864188, 0.442863, -0.262866, -0.951056, 0.16246,
  -0.864188, -0.442863, 0.238856, -0.809017, -0.309017, 0.5, -0.688191, -0.587785, 0.425325,
  -0.681718, -0.147621, 0.716567, -0.442863, -0.238856, 0.864188, -0.587785, -0.425325, 0.688191,
  -0.309017, -0.5, 0.809017, -0.147621, -0.716567, 0.681718, -0.425325, -0.688191, 0.587785,
  -0.16246, -0.262866, 0.951056, 0.442863, -0.238856, 0.864188, 0.16246, -0.262866, 0.951056,
  0.309017, -0.5, 0.809017, 0.147621, -0.716567, 0.681718, 0, -0.525731, 0.850651,
  0.425325, -0.688191, 0.587785, 0.587785, -0.425325, 0.688191, 0.688191, -0.587785, 0.425325,
  -0.955423, 0.295242, 0, -0.951056, 0.16246, 0.262866, -1, 0, 0,
  -0.850651, 0, 0.525731, -0.955423, -0.295242, 0, -0.951056, -0.16246, 0.262866,
  -0.864188, 0.442863, -0.238856, -0.951056, 0.16246, -0.262866, -0.809017, 0.309017, -0.5,
  -0.864188, -0.442863, -0.238856, -0.951056, -0.16246, -0.262866, -0.809017, -0.309017, -0.5,
  -0.681718, 0.147621, -0.716567, -0.681718, -0.147621, -0.716567, -0.850651, 0, -0.525731,
  -0.688191, 0.587785, -0.425325, -0.587785, 0.425325, -0.688191, -0.425325, 0.688191, -0.587785,
  -0.425325, -0.688191, -0.587785, -0.587785, -0.425325, -0.688191, -0.688191, -0.587785, -0.425325];

/**
 * The byte an impact-less far end is sent as instead of a direction
 * (`weapon_railgun_fire`, `g_weapon.c:625`).
 *
 * Outside the table, so it cannot be read as a direction by mistake, and {@link byteToDir} gives
 * the zero vector for it.
 */
export const NO_IMPACT_DIR = 255;

/**
 * `DirToByte` (`q_math.c:192–214`): the table direction closest to this one.
 *
 * A linear search over all 162, as the original's own comment concedes ("this isn't a real cheap
 * function to call"). It runs once per impact, which is where Quake 3 leaves it.
 *
 * A direction pointing away from every entry — which only a zero vector does — gives 0, because
 * the search takes nothing whose dot product fails to beat zero.
 *
 * @param dir - The direction to quantise. Need not be a unit vector, since only the ordering of
 *   the dot products matters.
 */
export function dirToByte(dir: Vec3): number {
  let best = 0;
  let bestDot = 0;
  for (let i = 0; i < NUM_VERTEX_NORMALS; i++) {
    const d =
      dir.x * BYTE_DIRS[i * 3] + dir.y * BYTE_DIRS[i * 3 + 1] + dir.z * BYTE_DIRS[i * 3 + 2];
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  }
  return best;
}

/**
 * `ByteToDir` (`q_math.c:215–221`): the direction a byte stands for.
 *
 * An index outside the table gives the zero vector rather than throwing, as Quake 3's does: the
 * railgun sends 255 for "no impact at the far end", and a client that decoded it anyway would
 * rather have nothing than an exception.
 *
 * @param byte - An index into the table.
 */
export function byteToDir(byte: number): Vec3 {
  if (byte < 0 || byte >= NUM_VERTEX_NORMALS) return vec3();
  return vec3(BYTE_DIRS[byte * 3], BYTE_DIRS[byte * 3 + 1], BYTE_DIRS[byte * 3 + 2]);
}
