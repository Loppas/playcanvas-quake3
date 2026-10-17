/**
 * MD3 model parser (`qcommon/qfiles.h:65-169`).
 *
 * Everything the weapon layer draws is an MD3: the weapon, its muzzle flash, its spinning
 * barrel, the projectile models and the explosion "flash" models. Of those only `_hand.md3` is
 * animated, and it holds **no geometry at all** — so there multi-frame *tag*
 * data is what matters; every mesh in the weapon set is a single frame. A player's three parts
 * animate their vertices too: every frame of every surface is kept, for the rig to morph between.
 *
 * Positions stay in **Quake units, Z-up** — the render adapter carries the basis change and
 * the 32 u/m scale as an entity transform.
 */

/** "IDP3", little-endian. */
const MD3_IDENT = 0x33504449;
const MD3_VERSION = 15;

/** Vertex shorts are 1/64 of a Quake unit (`MD3_XYZ_SCALE`). */
const XYZ_SCALE = 1 / 64;

/** `MAX_QPATH` — the fixed width of every name field in the format. */
const MAX_QPATH = 64;

const HEADER_SIZE = 108;
const FRAME_SIZE = 56;
const TAG_SIZE = 112;
const SURFACE_HEADER_SIZE = 108;
const SHADER_SIZE = MAX_QPATH + 4;
const XYZ_NORMAL_SIZE = 8;

/** A tag: the named coordinate frame a child model attaches to. */
export interface Md3Tag {
  name: string;
  /** Tag origin in Quake units, unscaled. */
  origin: [number, number, number];
  /** Rotation rows — forward, left, up — as stored. */
  axis: [[number, number, number], [number, number, number], [number, number, number]];
}

/** Per-frame vertex data for one surface — one morph target. */
export interface Md3SurfaceFrame {
  /** `numVerts * 3` positions in Quake units. */
  positions: Float32Array;
  /** `numVerts * 3` unit normals, unpacked from the lat/lng byte pair. */
  normals: Float32Array;
}

/** One drawable surface: a mesh plus the shader names its skin resolves through. */
export interface Md3Surface {
  /** As the renderer keeps it, for skins to match: see {@link normalizeSurfaceName}. */
  name: string;
  /**
   * Shader names embedded in the surface. Weapons ship no `.skin` files, so this *is* the
   * material reference; resolve against the shader scripts,
   * else treat as a bare texture path.
   */
  shaders: string[];
  numVerts: number;
  /** Triangle indices, `numTriangles * 3`. */
  indices: Uint32Array;
  /** `numVerts * 2` texture coordinates, exactly as stored. */
  uvs: Float32Array;
  /** One entry per model frame; length always equals the model's `numFrames`. */
  frames: Md3SurfaceFrame[];
}

/** Model-level per-frame bounds, used for culling and for the flash offset. */
export interface Md3Frame {
  mins: [number, number, number];
  maxs: [number, number, number];
  localOrigin: [number, number, number];
  radius: number;
  name: string;
}

/** A parsed MD3. */
export interface Md3Model {
  /** Internal name recorded in the file, e.g. `models/weapons2/rocketl/rocketl`. */
  name: string;
  numFrames: number;
  frames: Md3Frame[];
  /** Tag names in file order; the same for every frame. */
  tagNames: string[];
  /**
   * Tags indexed `[frame][tag]`. The file stores them frame-major
   * (`numFrames × numTags`), which is why an animated hand's `tag_weapon` can move.
   */
  tags: Md3Tag[][];
  surfaces: Md3Surface[];
}

/** Read a fixed-width, NUL-padded name field. */
function readName(bytes: Uint8Array, at: number, width = MAX_QPATH): string {
  const field = bytes.subarray(at, at + width);
  const end = field.indexOf(0);
  return new TextDecoder('latin1').decode(end === -1 ? field : field.subarray(0, end));
}

/**
 * Unpack MD3's spherical normal encoding into a unit vector.
 *
 * `lat` and `lng` are bytes covering a full turn each (`qcommon/qfiles.h`); at the poles
 * `sin(lng)` is 0 and the latitude term drops out, which is why a whole band of encodings
 * collapses onto ±Z.
 */
function unpackNormal(packed: number, out: Float32Array, at: number): void {
  const lat = (((packed >> 8) & 0xff) * 2 * Math.PI) / 256;
  const lng = ((packed & 0xff) * 2 * Math.PI) / 256;
  const sinLng = Math.sin(lng);
  out[at] = Math.cos(lat) * sinLng;
  out[at + 1] = Math.sin(lat) * sinLng;
  out[at + 2] = Math.cos(lng);
}

/**
 * A surface name as the renderer keeps it, so a skin can match it (`R_LoadMD3`,
 * `tr_model.c:470–478`): lowercased, with any two-character `_x` ending cut, "a crutch for q3data
 * being a mess" that lets a LOD's `l_legs_1` match the skin's `l_legs`. Q3 cuts any such ending,
 * not only `_1` and `_2`. No retail model, weapon or player, has a surface it changes.
 */
export function normalizeSurfaceName(name: string): string {
  // `Q_strlwr` is C's `tolower`: ASCII only.
  const lower = name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return lower.length > 2 && lower[lower.length - 2] === '_' ? lower.slice(0, -2) : lower;
}

/**
 * Parse an MD3 from pak bytes.
 *
 * @param bytes the file contents
 * @param label path or name, used in error messages
 * @throws if the magic, version or internal offsets do not check out
 */
export function parseMd3(bytes: Uint8Array, label = 'md3'): Md3Model {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.byteLength < HEADER_SIZE) throw new Error(`${label}: too short to be an MD3`);
  if (view.getUint32(0, true) !== MD3_IDENT) throw new Error(`${label}: not an MD3 (bad ident)`);
  const version = view.getInt32(4, true);
  if (version !== MD3_VERSION) throw new Error(`${label}: MD3 version ${version}, expected 15`);

  const name = readName(bytes, 8);
  const numFrames = view.getInt32(76, true);
  const numTags = view.getInt32(80, true);
  const numSurfaces = view.getInt32(84, true);
  const ofsFrames = view.getInt32(92, true);
  const ofsTags = view.getInt32(96, true);
  const ofsSurfaces = view.getInt32(100, true);

  if (numFrames < 1) throw new Error(`${label}: MD3 has no frames`);

  const frames: Md3Frame[] = [];
  for (let i = 0; i < numFrames; i++) {
    const at = ofsFrames + i * FRAME_SIZE;
    if (at + FRAME_SIZE > bytes.byteLength) throw new Error(`${label}: frame ${i} out of bounds`);
    frames.push({
      mins: [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)],
      maxs: [
        view.getFloat32(at + 12, true),
        view.getFloat32(at + 16, true),
        view.getFloat32(at + 20, true)
      ],
      localOrigin: [
        view.getFloat32(at + 24, true),
        view.getFloat32(at + 28, true),
        view.getFloat32(at + 32, true)
      ],
      radius: view.getFloat32(at + 36, true),
      name: readName(bytes, at + 40, 16)
    });
  }

  const tags: Md3Tag[][] = [];
  const tagNames: string[] = [];
  for (let frame = 0; frame < numFrames; frame++) {
    const perFrame: Md3Tag[] = [];
    for (let tag = 0; tag < numTags; tag++) {
      const at = ofsTags + (frame * numTags + tag) * TAG_SIZE;
      if (at + TAG_SIZE > bytes.byteLength) throw new Error(`${label}: tag ${tag} out of bounds`);
      const tagName = readName(bytes, at);
      if (frame === 0) tagNames.push(tagName);
      const f = (offset: number) => view.getFloat32(at + offset, true);
      perFrame.push({
        name: tagName,
        origin: [f(64), f(68), f(72)],
        axis: [
          [f(76), f(80), f(84)],
          [f(88), f(92), f(96)],
          [f(100), f(104), f(108)]
        ]
      });
    }
    tags.push(perFrame);
  }

  const surfaces: Md3Surface[] = [];
  let surfaceAt = ofsSurfaces;
  for (let i = 0; i < numSurfaces; i++) {
    if (surfaceAt + SURFACE_HEADER_SIZE > bytes.byteLength) {
      throw new Error(`${label}: surface ${i} out of bounds`);
    }
    const s = (offset: number) => view.getInt32(surfaceAt + offset, true);

    const surfaceName = normalizeSurfaceName(readName(bytes, surfaceAt + 4));
    const surfaceFrames = s(72);
    const numShaders = s(76);
    const numVerts = s(80);
    const numTriangles = s(84);
    const ofsTriangles = s(88);
    const ofsShaders = s(92);
    const ofsSt = s(96);
    const ofsXyzNormals = s(100);
    const ofsEnd = s(104);

    // A surface animating on its own schedule would break the shared-frame assumption the
    // whole viewmodel rig rests on, so refuse rather than silently mis-index.
    if (surfaceFrames !== numFrames) {
      throw new Error(
        `${label}: surface "${surfaceName}" has ${surfaceFrames} frames, model has ${numFrames}`
      );
    }

    const shaders: string[] = [];
    for (let j = 0; j < numShaders; j++) {
      shaders.push(readName(bytes, surfaceAt + ofsShaders + j * SHADER_SIZE));
    }

    const indices = new Uint32Array(numTriangles * 3);
    for (let j = 0; j < numTriangles * 3; j++) {
      indices[j] = view.getInt32(surfaceAt + ofsTriangles + j * 4, true);
    }

    const uvs = new Float32Array(numVerts * 2);
    for (let j = 0; j < numVerts * 2; j++) {
      uvs[j] = view.getFloat32(surfaceAt + ofsSt + j * 4, true);
    }

    const vertexFrames: Md3SurfaceFrame[] = [];
    for (let frame = 0; frame < numFrames; frame++) {
      const positions = new Float32Array(numVerts * 3);
      const normals = new Float32Array(numVerts * 3);
      const base = surfaceAt + ofsXyzNormals + frame * numVerts * XYZ_NORMAL_SIZE;
      if (base + numVerts * XYZ_NORMAL_SIZE > bytes.byteLength) {
        throw new Error(`${label}: surface "${surfaceName}" vertex data out of bounds`);
      }
      for (let v = 0; v < numVerts; v++) {
        const at = base + v * XYZ_NORMAL_SIZE;
        positions[v * 3] = view.getInt16(at, true) * XYZ_SCALE;
        positions[v * 3 + 1] = view.getInt16(at + 2, true) * XYZ_SCALE;
        positions[v * 3 + 2] = view.getInt16(at + 4, true) * XYZ_SCALE;
        unpackNormal(view.getUint16(at + 6, true), normals, v * 3);
      }
      vertexFrames.push({ positions, normals });
    }

    surfaces.push({
      name: surfaceName,
      shaders,
      numVerts,
      indices,
      uvs,
      frames: vertexFrames
    });

    surfaceAt += ofsEnd;
  }

  return { name, numFrames, frames, tagNames, tags, surfaces };
}

/** Find a tag by name in a given frame, or `undefined` if the model has no such tag. */
export function findTag(model: Md3Model, name: string, frame = 0): Md3Tag | undefined {
  const index = model.tagNames.indexOf(name);
  if (index === -1) return undefined;
  return model.tags[Math.min(frame, model.numFrames - 1)][index];
}

/**
 * Interpolate a tag between two frames, as `R_LerpTag` (`renderer/tr_model.c`) does:
 * component-wise lerp of the origin and all three axis rows, then re-normalize each row.
 *
 * The re-normalization is the whole reason this is not a plain lerp — averaging two rotation
 * rows shortens them, and an unnormalized axis would shrink every model hanging off the tag.
 * Slerp would be more correct still, but Q3's own wrong-but-cheap version is what produces
 * the motion players recognise.
 *
 * @param frac 0 gives `startFrame`, 1 gives `endFrame`
 */
export function lerpTag(
  model: Md3Model,
  name: string,
  startFrame: number,
  endFrame: number,
  frac: number
): Md3Tag | undefined {
  const index = model.tagNames.indexOf(name);
  if (index === -1) return undefined;

  const last = model.numFrames - 1;
  const start = model.tags[Math.min(Math.max(startFrame, 0), last)][index];
  const end = model.tags[Math.min(Math.max(endFrame, 0), last)][index];
  const front = frac;
  const back = 1 - frac;

  const lerp3 = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    a[0] * back + b[0] * front,
    a[1] * back + b[1] * front,
    a[2] * back + b[2] * front
  ];
  const normalize = (v: [number, number, number]): [number, number, number] => {
    const length = Math.hypot(v[0], v[1], v[2]);
    return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : v;
  };

  return {
    name,
    origin: lerp3(start.origin, end.origin),
    axis: [
      normalize(lerp3(start.axis[0], end.axis[0])),
      normalize(lerp3(start.axis[1], end.axis[1])),
      normalize(lerp3(start.axis[2], end.axis[2]))
    ]
  };
}
