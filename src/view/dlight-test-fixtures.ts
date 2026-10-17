import { MST_PATCH, MST_PLANAR, MST_TRIANGLE_SOUP, type Bsp } from '../formats/bsp';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { vec3 } from '../sim/vec3';
import {
  MAX_DLIGHTS,
  dlightClip,
  dlightVertex,
  projectLight,
  projectedLight,
  type DynamicLight
} from './dynamic-lights';
import type { PatchGrid } from './world-curves';
import { ClipCache, keptTriangles } from './world-dlights';
import type { WorldShaders } from './world-shaders';
import { OPEN_AREAS, WorldVis, type VisModel, type VisSwitches } from './world-vis';

/**
 * The world's dynamic light corpus over a map: seeded views, each with seeded lights about the eye
 * and the brush models placed about it, walked as the twin of ioquake3's own `tr_world.c`,
 * `tr_light.c` and `ProjectDlightTexture` walks them, and each surface a light was left on
 * projected by each of its lights, every value digested as the twin digests it.
 */

const f = Math.fround;

/** The views a map gets. */
const VIEWS = 24;

/** A map's corpus: what its views added, lit and projected, and the walk's and passes' digests. */
export interface DlightCorpus {
  /** The surfaces the views added, and those keyed lit. */
  added: number;
  lit: number;
  /** The surfaces projected, a light at a time, and the triangles the passes kept. */
  projected: number;
  kept: number;
  walk: string;
  project: string;
}

/** The twin's `pick`: a number below `n`, from the high bits. */
function pick(random: Seeded, n: number): number {
  return (random.next() >>> 8) % n;
}

/** A surface's points and triangles as its surface function puts them in a batch, rows whole. */
interface Tessellated {
  xyz: Float32Array;
  stride: number;
  indexes: Uint32Array;
}

/**
 * A surface as `RB_SurfaceFace`, `RB_SurfaceTriangles` or a whole `RB_SurfaceGrid` lays it out, or
 * none for one `R_DlightSurface` gives no light.
 */
function tessellate(bsp: Bsp, grids: readonly (PatchGrid | null)[], s: number): Tessellated | null {
  const { surfaceType, firstVert, numVerts, firstIndex, numIndexes } = bsp.surfaces[s];
  if (surfaceType === MST_PLANAR || surfaceType === MST_TRIANGLE_SOUP) {
    return {
      xyz: bsp.drawVerts.xyz.subarray(firstVert * 3, (firstVert + numVerts) * 3),
      stride: 3,
      indexes: Uint32Array.from(bsp.drawIndexes.subarray(firstIndex, firstIndex + numIndexes))
    };
  }
  const grid = grids[s];
  if (surfaceType !== MST_PATCH || !grid) return null;
  const { width, height } = grid;
  const indexes: number[] = [];
  for (let i = 0; i < height - 1; i++) {
    for (let j = 0; j < width - 1; j++) {
      const v1 = i * width + j + 1;
      const v2 = v1 - 1;
      const v3 = v2 + width;
      const v4 = v3 + 1;
      indexes.push(v2, v3, v1, v1, v3, v4);
    }
  }
  return { xyz: grid.verts.xyz, stride: 3, indexes: Uint32Array.from(indexes) };
}

/**
 * A map's dlight corpus: its views walked and projected as the twin's main loop makes them.
 *
 * @param grids - Each surface's curve, as the map's load made it.
 */
export function dlightCorpus(
  bsp: Bsp,
  shaders: Pick<WorldShaders, 'shaders' | 'surfaceShaders'>,
  grids: readonly (PatchGrid | null)[]
): DlightCorpus {
  const random = new Seeded(31);
  const models: VisModel[] = [];
  const vis = new WorldVis(bsp, shaders, grids, models, () => {});
  const walk = new Digest();
  const project = new Digest();
  const corpus = { added: 0, lit: 0, projected: 0, kept: 0 };
  const { mins, maxs } = bsp.models[0];
  const projected = projectedLight();
  const vertex = { s: 0, t: 0, color: new Uint8Array(3) };
  const tessellated = new Map<number, Tessellated | null>();
  const caches = new Map<number, ClipCache>();
  for (let v = 0; v < VIEWS; v++) {
    const eye = [0, 1, 2].map((a) => {
      const span = Math.trunc(f(maxs[a] - mins[a])) + 1;
      return f(mins[a] + pick(random, span * 256) / 256);
    });
    const pitch = pick(random, 180 * 256) / 256 - 90;
    const yaw = pick(random, 360 * 256) / 256;
    const roll = v % 4 === 3 ? pick(random, 360 * 256) / 256 : 0;
    const fovX = 60 + pick(random, 70);
    const fovY = 40 + pick(random, 60);
    const switches: VisSwitches = {
      novis: v % 8 === 6,
      nocull: v % 8 === 7,
      lockpvs: false,
      showcluster: false,
      facePlaneCull: v % 5 !== 4,
      entities: true
    };
    const count = v % 4 === 0 ? MAX_DLIGHTS : pick(random, 13);
    const lights: DynamicLight[] = [];
    for (let i = 0; i < count; i++) {
      const [x, y, z] = eye.map((e) => f(e + random.coord(768 * 256)));
      const radius = f((32 * 256 + pick(random, 512 * 256)) / 256);
      const color = [0, 1, 2].map(() => f(pick(random, 300) / 255)) as [number, number, number];
      lights.push({ origin: { x, y, z }, radius, color, additive: false });
    }
    models.length = 0;
    for (let m = 1; m < bsp.models.length; m++) {
      if (pick(random, 3) === 0) continue;
      const origin = eye.map((e) => f(e + random.coord(512 * 256))) as [number, number, number];
      const angles = [0, 1, 2].map(() => pick(random, 360 * 256) / 256) as [number, number, number];
      models.push({ model: m, origin, angles });
    }
    vis.view(
      { origin: vec3(eye[0], eye[1], eye[2]), angles: vec3(pitch, yaw, roll) },
      fovX,
      fovY,
      switches,
      OPEN_AREAS,
      lights
    );

    walk.int(vis.count);
    for (let i = 0; i < vis.count; i++) {
      walk.int(vis.surfaces[i]);
      walk.int(vis.lit[i]);
      corpus.lit += vis.lit[i];
    }
    corpus.added += vis.count;
    walk.int(vis.numLights).int(vis.dlightSurfaces).int(vis.dlightSurfacesCulled);
    for (const bits of vis.dlightBits) walk.int(bits);

    for (let i = 0; i < vis.count; i++) {
      const s = vis.surfaces[i];
      const bits = vis.dlightBits[s];
      if (bits === 0) continue;
      if (!tessellated.has(s)) tessellated.set(s, tessellate(bsp, grids, s));
      const tess = tessellated.get(s);
      if (!tess) continue;
      // A brush model's surface in the frame of the first placed model it is in.
      const owner =
        i < vis.worldCount
          ? undefined
          : models.find(({ model }) => {
              const { firstSurface, numSurfaces } = bsp.models[model];
              return s >= firstSurface && s < firstSurface + numSurfaces;
            });
      const vertexes = tess.xyz.length / 3;
      let cache = caches.get(vertexes);
      if (!cache) caches.set(vertexes, (cache = new ClipCache(vertexes)));
      const out = new Uint32Array(tess.indexes.length);
      for (let l = 0; l < vis.numLights; l++) {
        if (!(bits & (1 << l))) continue;
        const at = owner ? (owner.model * MAX_DLIGHTS + l) * 3 : l * 4;
        const origins = owner ? vis.modelLights : vis.lights;
        projectLight(lights[l], origins[at], origins[at + 1], origins[at + 2], projected);
        project.int(s).int(l);
        for (let k = 0; k < vertexes; k++) {
          const [x, y, z] = [tess.xyz[k * 3], tess.xyz[k * 3 + 1], tess.xyz[k * 3 + 2]];
          dlightVertex(projected, x, y, z, vertex);
          project.float(vertex.s).float(vertex.t).int(dlightClip(projected, x, y, z));
          project.uint8s(vertex.color, 0, 3);
        }
        const kept = keptTriangles(
          projected,
          tess.xyz,
          tess.stride,
          0,
          tess.indexes,
          0,
          tess.indexes.length,
          out,
          0,
          cache
        );
        project.int(kept);
        for (let k = 0; k < kept; k++) project.int(out[k]);
        corpus.projected++;
        corpus.kept += kept / 3;
      }
    }
  }
  return { ...corpus, walk: walk.hex(), project: project.hex() };
}
