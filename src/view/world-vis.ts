import { MST_PATCH, MST_PLANAR, MST_TRIANGLE_SOUP, type Bsp } from '../formats/bsp';
import { MAX_MAP_AREA_BYTES } from '../net/commands';
import type { FirstPersonView } from './camera-feel';
import { MAX_DLIGHTS, type DynamicLight } from './dynamic-lights';
import type { PatchGrid } from './world-curves';
import type { WorldShaders } from './world-shaders';

/**
 * What a view of a map's world can see, found each frame as opengl1 finds it: the leafs the eye's
 * cluster can see marked, but for those in an area the view's areamask closes (`R_MarkLeaves`,
 * `tr_world.c:567-637`), the tree walked through the view's frustum (`R_RecursiveWorldNode`,
 * `:356-493`), each surface in a leaf reached culled by its kind (`R_CullSurface`, `:113-159`), the
 * far plane set from the leafs reached (`R_SetFarClip`, `tr_main.c:384-443`), and then each brush
 * model culled by its bounds in its place, whatever area it stands in
 * (`R_AddBrushModelSurfaces`, `tr_world.c:318-339`).
 *
 * The frame's dynamic lights go down the walk with it, each kept on the side of a node's plane it
 * reaches (`:421-450`), every one of them as ioquake3's `1ULL` mask has it. A surface the walk adds
 * from a leaf some light reaches is tested against those (`R_DlightSurface`, `:162-274`), and keeps
 * what is left, whatever leaf or view next adds it untested. A brush model takes the lights about
 * its bounds and then, as both releases have it, tests only the scene's first
 * (`R_DlightBmodel`, `tr_light.c:61-105`; `tr_world.c:337`).
 *
 * The arithmetic is C's `float`'s, each operation rounded to single precision in Q3's order. A
 * view makes nothing: every array is made with the world.
 *
 * Engine-free, like the rest of `src/view/`.
 */

type Vec3 = [number, number, number];

/** A brush model drawn: the `N` of `*N`, and its origin and angles, as `CG_Mover` places it. */
export interface VisModel {
  model: number;
  origin: Vec3;
  angles: Vec3;
}

/** The cvars a view is found by. */
export interface VisSwitches {
  /** `r_novis`: every leaf marked, from the next time the eye's cluster changes. */
  novis: boolean;
  /** `r_nocull`: nothing culled by the frustum or by a surface's facing. */
  nocull: boolean;
  /** `r_lockpvs`: the marks kept as they are, wherever the eye goes. */
  lockpvs: boolean;
  /** `r_showcluster`: the eye's cluster and area printed each time the leafs are marked. */
  showcluster: boolean;
  /** `r_facePlaneCull`: faces turned away from the eye culled by their plane. */
  facePlaneCull: boolean;
  /** `r_drawentities`: the brush models added after the world. */
  entities: boolean;
}

/**
 * An areamask that closes no area, for a view with no snapshot to take one from: every leaf the
 * eye's cluster sees is marked. Never written.
 */
export const OPEN_AREAS = new Uint8Array(MAX_MAP_AREA_BYTES);

const f = Math.fround;

const CULL_IN = 0;
const CULL_CLIP = 1;
const CULL_OUT = 2;

/** How `R_DlightSurface` tests a surface, by its `surfaceType_t`. */
const NO_DLIGHT = 0;
const DLIGHT_FACE = 1;
const DLIGHT_GRID = 2;
const DLIGHT_SOUP = 3;

/** How a shader's faces are culled: `cullType_t` (`tr_local.h`). */
const CT_FRONT_SIDED = 0;
const CT_BACK_SIDED = 1;
const CT_TWO_SIDED = 2;

/** `ClearBounds`'s empty box (`q_math.c`), which a view reaching no leaf keeps. */
const CLEARED_BOUNDS = 99999;

/**
 * `r_zproj`'s default (`tr_init.c:1076`): the distance the frustum is worked out at
 * (`tr_main.c:1377`). The planes come out the same at any distance, but for rounding.
 */
const ZPROJ = 64;

/** How far past a face's plane the eye must be before the face is culled (`tr_world.c:145-155`). */
const FACE_CULL_EPSILON = 8;

/** `DEG2RAD`'s factor as `AngleVectors` writes it (`q_math.c:937`), in double precision. */
const DEGREES = (Math.PI * 2) / 360;

/** The view in single precision, and the frustum and the culls' place as opengl1 holds them. */
export class WorldVis {
  /** The surfaces the view adds, in the order Q3 adds them: the world's, then each brush model's. */
  readonly surfaces: Int32Array;
  /** Whether a light touches each of {@link surfaces}, as its key's last bit has it: 1 or 0. */
  readonly lit: Uint8Array;
  /**
   * Each surface's light bits, by its index in the BSP, as the last test of it left them
   * (`dlightBits` on a face, a curve or a soup); 0 for any other.
   */
  readonly dlightBits: Int32Array;
  /** How many of {@link surfaces} the last view added. */
  count = 0;
  /** The lights the last view took (`tr.refdef.num_dlights`). */
  numLights = 0;
  /**
   * Each light's origin in the world's frame, as the scene holds it in floats, then its radius:
   * four floats a light.
   */
  readonly lights = new Float32Array(MAX_DLIGHTS * 4);
  /**
   * Each light's origin in each brush model's frame as `R_TransformDlights` puts it for the last
   * view that placed the model, by its inline model's number: three floats a light.
   */
  readonly modelLights: Float32Array;
  /** `c_dlightSurfaces`: the surfaces a test left a light on. */
  dlightSurfaces = 0;
  /** `c_dlightSurfacesCulled`: the faces and curves a test left none on. */
  dlightSurfacesCulled = 0;
  /** How many of them the world's tree added; the brush models' follow. */
  worldCount = 0;
  /** The leafs the last view's walk reached (`c_leafs`). */
  leafs = 0;
  /** The far plane the last view set (`tr.viewParms.zFar`). */
  zFar = 0;
  /** The cluster the leafs were last marked from (`tr.viewCluster`), −1 before the first view. */
  viewCluster = -1;

  private readonly bsp: Bsp;
  private readonly grids: readonly (Pick<PatchGrid, 'meshBounds' | 'localOrigin' | 'meshRadius'> | null)[];
  private readonly models: readonly VisModel[];
  private readonly print: (text: string) => void;
  /** `tr.world->numClusters`: the visibility lump's, or else one past the highest leaf's. */
  private readonly numClusters: number;
  /** Each surface's cull: `CT_*` for a face, by its shader. */
  private readonly cullTypes: Uint8Array;
  /** A face's plane, as `ParseFace` makes it (`tr_bsp.c:358-363`): its normal and distance. */
  private readonly facePlanes: Float32Array;
  /** A triangle soup's bounds, as `ParseTriSurf` makes them (`tr_bsp.c:469-477`). */
  private readonly soupBounds: Float32Array;
  /** Each node's and leaf's parent node, or −1 for the root (`R_SetParent`, `tr_bsp.c`). */
  private readonly nodeParents: Int32Array;
  private readonly leafParents: Int32Array;
  /** Each node's and leaf's `visframe`: marked while it equals {@link visCount}. */
  private readonly nodeMarks: Int32Array;
  private readonly leafMarks: Int32Array;
  private visCount = 0;
  /** Each surface's `viewCount`: added, or culled, while it equals {@link viewCount}. */
  private readonly surfaceViews: Int32Array;
  private viewCount = 0;
  /** `r_showcluster` as last seen, and whether it has changed since the leafs were last marked. */
  private showcluster: boolean | null = null;
  private showclusterModified = false;
  /**
   * `tr.refdef.areamask`: the last view's areamask, a set bit an area closed to it, and whether
   * this view's differs from the one before (`areamaskModified`).
   */
  private readonly areamask = new Uint8Array(MAX_MAP_AREA_BYTES);
  private areamaskModified = false;

  /** The eye, and its forward, left and up (`tr.viewParms.or`). */
  private readonly origin = new Float64Array(3);
  private readonly axis = new Float64Array(9);
  /** The four planes' normals and distances, and which of each normal's parts are below 0. */
  private readonly frustum = new Float64Array(16);
  private readonly signbits = new Int32Array(4);
  /** `tr.viewParms.visBounds`: mins, then maxs. */
  private readonly visBounds = new Float64Array(6);
  /** `tr.or`: where the surfaces being added are placed, and the eye in their frame. */
  private readonly orOrigin = new Float64Array(3);
  private readonly orAxis = new Float64Array(9);
  private readonly orViewOrigin = new Float64Array(3);
  /** Scratch for the points a cull carries into the world. */
  private readonly corners = new Float64Array(24);
  private readonly point = new Float64Array(3);
  private readonly modelAxis = new Float64Array(9);

  /**
   * @param grids - Each surface's curve, or null for none or for one Q3 skips.
   * @param models - The brush models a view draws, in the order it adds them: read at each view,
   *   so its owner may fill it again between views as the scene places them.
   * @param print - Where `r_showcluster` prints, as `ri.Printf` does.
   */
  constructor(
    bsp: Bsp,
    shaders: Pick<WorldShaders, 'shaders' | 'surfaceShaders'>,
    grids: readonly (Pick<PatchGrid, 'meshBounds' | 'localOrigin' | 'meshRadius'> | null)[],
    models: readonly VisModel[],
    print: (text: string) => void
  ) {
    this.bsp = bsp;
    this.grids = grids;
    this.models = models;
    this.print = print;
    // `R_LoadNodesAndLeafs` raises the count past the highest leaf's, and `R_LoadVisibility`, which
    // comes after it, puts the lump's in its place (`tr_bsp.c:245, 1419-1421`).
    this.numClusters =
      bsp.visibility?.numClusters ?? bsp.leafs.reduce((n, leaf) => Math.max(n, leaf.cluster + 1), 0);

    const n = bsp.surfaces.length;
    this.surfaces = new Int32Array(n);
    this.lit = new Uint8Array(n);
    this.dlightBits = new Int32Array(n);
    this.modelLights = new Float32Array(bsp.models.length * MAX_DLIGHTS * 3);
    this.surfaceViews = new Int32Array(n);
    this.cullTypes = new Uint8Array(n);
    this.facePlanes = new Float32Array(n * 4);
    this.soupBounds = new Float32Array(n * 6);
    const xyz = bsp.drawVerts.xyz;
    bsp.surfaces.forEach((surface, s) => {
      const cull = shaders.shaders[shaders.surfaceShaders[s]]?.script?.cull ?? 'front';
      this.cullTypes[s] =
        cull === 'none' ? CT_TWO_SIDED : cull === 'back' ? CT_BACK_SIDED : CT_FRONT_SIDED;
      if (surface.surfaceType === MST_PLANAR) {
        const [nx, ny, nz] = surface.lightmapVecs[2];
        const v = surface.firstVert * 3;
        this.facePlanes.set([nx, ny, nz, dot(xyz[v], xyz[v + 1], xyz[v + 2], nx, ny, nz)], s * 4);
      } else if (surface.surfaceType === MST_TRIANGLE_SOUP) {
        const bounds = [CLEARED_BOUNDS, CLEARED_BOUNDS, CLEARED_BOUNDS];
        bounds.push(-CLEARED_BOUNDS, -CLEARED_BOUNDS, -CLEARED_BOUNDS);
        for (let v = surface.firstVert; v < surface.firstVert + surface.numVerts; v++) {
          for (let j = 0; j < 3; j++) {
            bounds[j] = Math.min(bounds[j], xyz[v * 3 + j]);
            bounds[3 + j] = Math.max(bounds[3 + j], xyz[v * 3 + j]);
          }
        }
        this.soupBounds.set(bounds, s * 6);
      }
    });

    this.nodeParents = new Int32Array(bsp.nodes.length).fill(-1);
    this.leafParents = new Int32Array(bsp.leafs.length).fill(-1);
    bsp.nodes.forEach(({ children }, parent) => {
      for (const child of children) {
        if (child >= 0) this.nodeParents[child] = parent;
        else this.leafParents[-1 - child] = parent;
      }
    });
    this.nodeMarks = new Int32Array(bsp.nodes.length);
    this.leafMarks = new Int32Array(bsp.leafs.length);
  }

  /**
   * Find what a view sees, as `R_RenderView` does up to its sort (`tr_main.c:1360-1392`): the
   * frustum, the world's surfaces, the far plane, then the brush models'.
   *
   * @param fovX - The view's horizontal angle, in degrees, as the refdef's `fov_x`.
   * @param fovY - Its vertical angle.
   * @param areamask - The refdef's areamask, all {@link MAX_MAP_AREA_BYTES} of it: a set bit is an
   *   area the view does not draw.
   * @param lights - The frame's dynamic lights, in the order cgame added them; the first
   *   {@link MAX_DLIGHTS} are taken.
   */
  view(
    view: FirstPersonView,
    fovX: number,
    fovY: number,
    switches: VisSwitches,
    areamask: Uint8Array,
    lights: readonly DynamicLight[] = []
  ): void {
    // `RE_RenderScene` (`tr_scene.c:324-342`): kept, and compared with the last view's, which a
    // door just opened or shut makes the leafs be marked again.
    let differ = 0;
    for (let i = 0; i < MAX_MAP_AREA_BYTES; i++) {
      differ |= this.areamask[i] ^ areamask[i];
      this.areamask[i] = areamask[i];
    }
    this.areamaskModified = differ !== 0;

    const { origin, angles } = view;
    this.origin[0] = f(origin.x);
    this.origin[1] = f(origin.y);
    this.origin[2] = f(origin.z);
    anglesToAxis(angles.x, angles.y, angles.z, this.axis);
    this.setupFrustum(f(fovX), f(fovY));
    this.viewCount++;
    this.count = 0;
    this.leafs = 0;
    this.dlightSurfaces = 0;
    this.dlightSurfacesCulled = 0;
    // `RE_AddDynamicLightToScene` keeps each in floats, and `R_AddWorldSurfaces` no more than 32.
    const numLights = Math.min(lights.length, MAX_DLIGHTS);
    this.numLights = numLights;
    for (let i = 0; i < numLights; i++) {
      const { origin: at, radius } = lights[i];
      this.lights[i * 4] = at.x;
      this.lights[i * 4 + 1] = at.y;
      this.lights[i * 4 + 2] = at.z;
      this.lights[i * 4 + 3] = radius;
    }

    // `R_AddWorldSurfaces` (`tr_world.c:645-668`), in the world's own frame.
    this.markLeaves(switches);
    const bounds = this.visBounds;
    bounds.fill(CLEARED_BOUNDS, 0, 3);
    bounds.fill(-CLEARED_BOUNDS, 3, 6);
    this.orOrigin.fill(0);
    this.orAxis.fill(0);
    this.orAxis[0] = this.orAxis[4] = this.orAxis[8] = 1;
    this.orViewOrigin.set(this.origin);
    // `( 1ULL << tr.refdef.num_dlights ) - 1`: all 32 bits for 32 lights, where id's `1 <<` gave
    // none.
    this.walk(0, 15, numLights >= 32 ? -1 : (1 << numLights) - 1, switches);
    this.worldCount = this.count;
    this.setFarClip();

    // `R_AddEntitySurfaces`' brush models (`tr_main.c:1170-1240`), each in its own frame.
    if (!switches.entities) return;
    for (let m = 0; m < this.models.length; m++) {
      const { model, origin: at, angles: turned } = this.models[m];
      this.rotateForEntity(at, turned);
      const { mins, maxs, firstSurface, numSurfaces } = this.bsp.models[model];
      if (this.cullLocalBox(mins, maxs, switches.nocull) === CULL_OUT) continue;
      const needDlights = this.dlightBmodel(model);
      for (let s = firstSurface; s < firstSurface + numSurfaces; s++) {
        this.addSurface(s, switches, needDlights);
      }
    }
  }

  /**
   * `R_DlightBmodel` (`tr_light.c:61-105`): the lights carried into a brush model's frame
   * (`R_TransformDlights`, `:42-52`), each kept that comes within its radius of the model's bounds
   * on every axis, and the bits written into every surface of the model. Then, as
   * `R_AddBrushModelSurfaces` hands on `needDlights` as the bits, each surface added is tested
   * against the scene's first light alone.
   *
   * @param model - Its inline model's number.
   * @returns `needDlights`: 1 where any light came near the model, else 0
   */
  private dlightBmodel(model: number): number {
    const { mins, maxs, firstSurface, numSurfaces } = this.bsp.models[model];
    const a = this.orAxis;
    const o = this.orOrigin;
    const out = this.modelLights;
    let mask = 0;
    for (let i = 0; i < this.numLights; i++) {
      const tx = f(this.lights[i * 4] - o[0]);
      const ty = f(this.lights[i * 4 + 1] - o[1]);
      const tz = f(this.lights[i * 4 + 2] - o[2]);
      const radius = this.lights[i * 4 + 3];
      const at = (model * MAX_DLIGHTS + i) * 3;
      let near = true;
      for (let j = 0; j < 3; j++) {
        const transformed = dot(tx, ty, tz, a[j * 3], a[j * 3 + 1], a[j * 3 + 2]);
        out[at + j] = transformed;
        if (near && (f(transformed - maxs[j]) > radius || f(mins[j] - transformed) > radius)) {
          near = false;
        }
      }
      if (near) mask |= 1 << i;
    }
    for (let s = firstSurface; s < firstSurface + numSurfaces; s++) {
      if (this.dlightKind(s) !== NO_DLIGHT) this.dlightBits[s] = mask;
    }
    return mask !== 0 ? 1 : 0;
  }

  /** How `R_DlightSurface` tests a surface: as a face, a curve, a soup, or not at all. */
  private dlightKind(s: number): number {
    const { surfaceType } = this.bsp.surfaces[s];
    if (surfaceType === MST_PLANAR) return DLIGHT_FACE;
    if (surfaceType === MST_TRIANGLE_SOUP) return DLIGHT_SOUP;
    // A curve the map flags nodraw is Q3's `skipData`, which takes no light.
    if (surfaceType === MST_PATCH && this.grids[s]) return DLIGHT_GRID;
    return NO_DLIGHT;
  }

  /**
   * `R_DlightSurface` (`tr_world.c:258-274`): a face keeps the lights whose radius reaches its
   * plane, a curve those whose box meets its bounds, and a soup every one; what is left is kept on
   * the surface. Each light is tested at its origin in the world's frame, whatever frame the
   * surface is drawn in.
   *
   * @returns the bits left
   */
  private dlightSurface(s: number, bits: number): number {
    const kind = this.dlightKind(s);
    if (kind === NO_DLIGHT) return 0;
    if (kind !== DLIGHT_SOUP) {
      const lights = this.lights;
      for (let i = 0; i < this.numLights; i++) {
        if (!(bits & (1 << i))) continue;
        const x = lights[i * 4];
        const y = lights[i * 4 + 1];
        const z = lights[i * 4 + 2];
        const radius = lights[i * 4 + 3];
        if (kind === DLIGHT_FACE) {
          // `R_DlightFace` (`:162-185`).
          const p = this.facePlanes;
          const d = f(dot(x, y, z, p[s * 4], p[s * 4 + 1], p[s * 4 + 2]) - p[s * 4 + 3]);
          if (d < -radius || d > radius) bits &= ~(1 << i);
        } else {
          // `R_DlightGrid` (`:187-213`).
          const [mins, maxs] = this.grids[s]!.meshBounds;
          if (
            f(x - radius) > maxs[0] ||
            f(x + radius) < mins[0] ||
            f(y - radius) > maxs[1] ||
            f(y + radius) < mins[1] ||
            f(z - radius) > maxs[2] ||
            f(z + radius) < mins[2]
          ) {
            bits &= ~(1 << i);
          }
        }
      }
      if (!bits) this.dlightSurfacesCulled++;
    }
    // `R_DlightTrisurf` (`:216-247`) keeps them all, its test left out.
    this.dlightBits[s] = bits;
    if (bits) this.dlightSurfaces++;
    return bits;
  }

  /** `R_PointInLeaf` (`tr_world.c:501-525`): a point on a plane is behind it. */
  pointInLeaf(x: number, y: number, z: number): number {
    const { nodes, planes } = this.bsp;
    let n = 0;
    while (n >= 0) {
      const { planeNum, children } = nodes[n];
      const { normal, dist } = planes[planeNum];
      n = f(dot(x, y, z, normal[0], normal[1], normal[2]) - dist) > 0 ? children[0] : children[1];
    }
    return -1 - n;
  }

  /** `R_MarkLeaves` (`tr_world.c:567-637`). */
  private markLeaves(switches: VisSwitches): void {
    if (switches.showcluster !== this.showcluster) {
      // A cvar is `modified` from its first registering, and again whenever it changes.
      this.showcluster = switches.showcluster;
      this.showclusterModified = true;
    }
    if (switches.lockpvs) return;
    const leafNum = this.pointInLeaf(this.origin[0], this.origin[1], this.origin[2]);
    const { cluster, area } = this.bsp.leafs[leafNum];
    // The same cluster keeps its marks, unless the areamask changed or `r_showcluster` was just
    // turned on.
    if (cluster === this.viewCluster && !this.areamaskModified && !this.showclusterModified) {
      return;
    }
    if (this.showclusterModified || switches.showcluster) {
      this.showclusterModified = false;
      if (switches.showcluster) this.print(`cluster:${cluster}  area:${area}\n`);
    }
    const count = ++this.visCount;
    this.viewCluster = cluster;

    if (switches.novis || cluster === -1) {
      // Q3's decision nodes and leafs alike; none of them is `CONTENTS_SOLID`.
      this.nodeMarks.fill(count);
      this.leafMarks.fill(count);
      return;
    }
    const vis = this.bsp.visibility;
    const seen = vis !== null && cluster >= 0 && cluster < this.numClusters;
    const row = seen ? cluster * vis.clusterBytes : 0;
    const { leafs } = this.bsp;
    const mask = this.areamask;
    for (let l = 0; l < leafs.length; l++) {
      const { cluster: c, area } = leafs[l];
      if (c < 0 || c >= this.numClusters) continue;
      // `R_ClusterPVS`: every cluster for a map with no lump or an eye in no cluster of it.
      if (seen && !(vis.data[row + (c >> 3)] & (1 << (c & 7)))) continue;
      // "check for door connection". C reads area −1's bit from the byte before the mask,
      // `rdflags`' highest, and never finds it set in a view of the world.
      if (area >= 0 && mask[area >> 3] & (1 << (area & 7))) continue;
      this.leafMarks[l] = count;
      for (let parent = this.leafParents[l]; parent >= 0; parent = this.nodeParents[parent]) {
        if (this.nodeMarks[parent] === count) break;
        this.nodeMarks[parent] = count;
      }
    }
  }

  /**
   * `R_RecursiveWorldNode` (`tr_world.c:356-493`): a node not marked or behind a plane is left;
   * a plane a node is wholly in front of is not tried again below it; the front child first, each
   * child with the lights that reach its side of the node's plane.
   *
   * @param n - A node's number, or a leaf's as `-(leaf + 1)`.
   * @param planeBits - The planes still to try, a bit each.
   * @param dlightBits - The lights that may reach it, a bit each.
   */
  private walk(n: number, planeBits: number, dlightBits: number, switches: VisSwitches): void {
    const { nodes, leafs, planes } = this.bsp;
    const lights = this.lights;
    for (;;) {
      const leaf = n < 0;
      if ((leaf ? this.leafMarks[-1 - n] : this.nodeMarks[n]) !== this.visCount) return;
      const { mins, maxs } = leaf ? leafs[-1 - n] : nodes[n];
      if (!switches.nocull) {
        for (let p = 0; p < 4; p++) {
          if (!(planeBits & (1 << p))) continue;
          const side = this.boxOnPlaneSide(mins, maxs, p);
          if (side === 2) return;
          if (side === 1) planeBits &= ~(1 << p);
        }
      }
      if (leaf) break;
      const { planeNum, children } = nodes[n];
      let front = 0;
      let back = 0;
      if (dlightBits) {
        const { normal, dist: planeDist } = planes[planeNum];
        for (let i = 0; i < this.numLights; i++) {
          if (!(dlightBits & (1 << i))) continue;
          const x = lights[i * 4];
          const y = lights[i * 4 + 1];
          const z = lights[i * 4 + 2];
          const radius = lights[i * 4 + 3];
          const dist = f(dot(x, y, z, normal[0], normal[1], normal[2]) - planeDist);
          if (dist > -radius) front |= 1 << i;
          if (dist < radius) back |= 1 << i;
        }
      }
      this.walk(children[0], planeBits, front, switches);
      n = children[1];
      dlightBits = back;
    }

    const { mins, maxs, firstLeafSurface, numLeafSurfaces } = leafs[-1 - n];
    this.leafs++;
    const bounds = this.visBounds;
    for (let j = 0; j < 3; j++) {
      if (mins[j] < bounds[j]) bounds[j] = mins[j];
      if (maxs[j] > bounds[3 + j]) bounds[3 + j] = maxs[j];
    }
    const marks = this.bsp.leafSurfaces;
    for (let i = firstLeafSurface; i < firstLeafSurface + numLeafSurfaces; i++) {
      this.addSurface(marks[i], switches, dlightBits);
    }
  }

  /**
   * `R_AddWorldSurface` (`tr_world.c:283-303`): a surface is taken once a view, at the first leaf
   * or model that holds it, and marked before it is culled; then, if any light may reach it, tested
   * against those, and keyed by whether one is left.
   *
   * @param dlightBits - The lights its leaf or model hands on.
   */
  private addSurface(s: number, switches: VisSwitches, dlightBits: number): void {
    if (this.surfaceViews[s] === this.viewCount) return;
    this.surfaceViews[s] = this.viewCount;
    if (this.cullSurface(s, switches)) return;
    this.lit[this.count] = dlightBits !== 0 && this.dlightSurface(s, dlightBits) !== 0 ? 1 : 0;
    this.surfaces[this.count++] = s;
  }

  /**
   * `R_CullSurface` (`tr_world.c:113-159`): a curve by its sphere and then its box, a soup by its
   * box, and a face by its plane unless its shader is two-sided. A flare is never culled, nor a
   * surface Q3 skips.
   */
  private cullSurface(s: number, switches: VisSwitches): boolean {
    if (switches.nocull) return false;
    const { surfaceType } = this.bsp.surfaces[s];
    if (surfaceType === MST_PATCH) {
      const grid = this.grids[s];
      return grid !== null && grid !== undefined && this.cullGrid(grid);
    }
    if (surfaceType === MST_TRIANGLE_SOUP) {
      const b = this.soupBounds;
      const at = s * 6;
      return (
        this.cullBox(b[at], b[at + 1], b[at + 2], b[at + 3], b[at + 4], b[at + 5]) === CULL_OUT
      );
    }
    if (surfaceType !== MST_PLANAR) return false;
    const cullType = this.cullTypes[s];
    if (cullType === CT_TWO_SIDED || !switches.facePlaneCull) return false;
    const p = this.facePlanes;
    const at = s * 4;
    const eye = this.orViewOrigin;
    const d = dot(eye[0], eye[1], eye[2], p[at], p[at + 1], p[at + 2]);
    // An epsilon either side of the plane, for the rounding between the compiler and the screen.
    return cullType === CT_FRONT_SIDED
      ? d < f(p[at + 3] - FACE_CULL_EPSILON)
      : d > f(p[at + 3] + FACE_CULL_EPSILON);
  }

  /**
   * `R_CullGrid` (`tr_world.c:53-100`): its sphere, carried into the world, then its box where the
   * sphere is across a plane.
   */
  private cullGrid(grid: Pick<PatchGrid, 'meshBounds' | 'localOrigin' | 'meshRadius'>): boolean {
    // By index: destructuring an array makes an iterator each call.
    const origin = grid.localOrigin;
    this.localPointToWorld(origin[0], origin[1], origin[2]);
    const sphere = this.cullPointAndRadius(this.point, grid.meshRadius);
    if (sphere === CULL_OUT) return true;
    if (sphere === CULL_IN) return false;
    const mins = grid.meshBounds[0];
    const maxs = grid.meshBounds[1];
    return this.cullBox(mins[0], mins[1], mins[2], maxs[0], maxs[1], maxs[2]) === CULL_OUT;
  }

  /** `R_CullLocalBox` (`tr_main.c:53-107`), for a model's bounds. */
  private cullLocalBox(mins: Vec3, maxs: Vec3, nocull: boolean): number {
    if (nocull) return CULL_CLIP;
    return this.cullBox(mins[0], mins[1], mins[2], maxs[0], maxs[1], maxs[2]);
  }

  /**
   * `R_CullLocalBox`'s test (`tr_main.c:66-106`): the box's corners carried into the world by
   * `tr.or`, out where every corner is behind one plane, and in where none is behind any.
   */
  private cullBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
    const corners = this.corners;
    const o = this.orOrigin;
    const a = this.orAxis;
    for (let i = 0; i < 8; i++) {
      const vx = i & 1 ? x1 : x0;
      const vy = (i >> 1) & 1 ? y1 : y0;
      const vz = (i >> 2) & 1 ? z1 : z0;
      for (let j = 0; j < 3; j++) {
        let t = f(o[j] + f(a[j] * vx));
        t = f(t + f(a[3 + j] * vy));
        corners[i * 3 + j] = f(t + f(a[6 + j] * vz));
      }
    }
    let anyBack = 0;
    const planes = this.frustum;
    for (let p = 0; p < 4; p++) {
      const nx = planes[p * 4];
      const ny = planes[p * 4 + 1];
      const nz = planes[p * 4 + 2];
      const dist = planes[p * 4 + 3];
      let front = 0;
      let back = 0;
      for (let j = 0; j < 8; j++) {
        if (dot(corners[j * 3], corners[j * 3 + 1], corners[j * 3 + 2], nx, ny, nz) > dist) {
          front = 1;
          if (back) break;
        } else {
          back = 1;
        }
      }
      if (!front) return CULL_OUT;
      anyBack |= back;
    }
    return anyBack ? CULL_CLIP : CULL_IN;
  }

  /** `R_CullPointAndRadius` (`tr_main.c:124-157`). */
  private cullPointAndRadius(point: Float64Array, radius: number): number {
    const planes = this.frustum;
    let clipped = false;
    for (let p = 0; p < 4; p++) {
      const at = p * 4;
      const d = dot(point[0], point[1], point[2], planes[at], planes[at + 1], planes[at + 2]);
      const dist = f(d - planes[at + 3]);
      if (dist < -radius) return CULL_OUT;
      if (dist <= radius) clipped = true;
    }
    return clipped ? CULL_CLIP : CULL_IN;
  }

  /** `R_LocalPointToWorld` (`tr_main.c:178-182`), into {@link point}. */
  private localPointToWorld(x: number, y: number, z: number): void {
    const a = this.orAxis;
    const o = this.orOrigin;
    for (let j = 0; j < 3; j++) {
      this.point[j] = f(f(f(f(x * a[j]) + f(y * a[3 + j])) + f(z * a[6 + j])) + o[j]);
    }
  }

  /** `BoxOnPlaneSide` (`q_math.c:657-691`) against a frustum plane: 1 in front, 2 behind, 3 across. */
  private boxOnPlaneSide(mins: Vec3, maxs: Vec3, p: number): number {
    const planes = this.frustum;
    const bits = this.signbits[p];
    // The nearest corner's distance and the farthest's, a part at a time.
    let near = 0;
    let far = 0;
    for (let i = 0; i < 3; i++) {
      const n = planes[p * 4 + i];
      if ((bits >> i) & 1) {
        far = f(far + f(n * mins[i]));
        near = f(near + f(n * maxs[i]));
      } else {
        far = f(far + f(n * maxs[i]));
        near = f(near + f(n * mins[i]));
      }
    }
    const dist = planes[p * 4 + 3];
    return (far >= dist ? 1 : 0) | (near < dist ? 2 : 0);
  }

  /**
   * `R_SetupProjection`'s frustum (`tr_main.c:453-506, 533-536`), symmetric: four planes through
   * the eye, each turned out from the view by half its angle. There is no near or far plane.
   */
  private setupFrustum(fovX: number, fovY: number): void {
    const xmax = f(ZPROJ * Math.tan((fovX * Math.PI) / 360));
    const ymax = f(ZPROJ * Math.tan((fovY * Math.PI) / 360));
    // Left and right of the view's forward, then above and below it.
    this.frustumPair(0, xmax, 3);
    this.frustumPair(2, ymax, 6);
    const planes = this.frustum;
    const eye = this.origin;
    for (let p = 0; p < 4; p++) {
      const at = p * 4;
      planes[at + 3] = dot(eye[0], eye[1], eye[2], planes[at], planes[at + 1], planes[at + 2]);
      // `SetPlaneSignbits`: which parts of the normal are below 0.
      this.signbits[p] =
        (planes[at] < 0 ? 1 : 0) | (planes[at + 1] < 0 ? 2 : 0) | (planes[at + 2] < 0 ? 4 : 0);
    }
  }

  /** Planes `p` and `p + 1`: the forward axis tipped toward the axis at `side`, and away. */
  private frustumPair(p: number, max: number, side: number): void {
    const length = f(Math.sqrt(f(f(max * max) + f(ZPROJ * ZPROJ))));
    const oppleg = f(max / length);
    const adjleg = f(ZPROJ / length);
    const axis = this.axis;
    const planes = this.frustum;
    for (let j = 0; j < 3; j++) {
      const scaled = f(axis[j] * oppleg);
      planes[p * 4 + j] = f(scaled + f(axis[side + j] * adjleg));
      planes[(p + 1) * 4 + j] = f(scaled + f(axis[side + j] * -adjleg));
    }
  }

  /** `R_SetFarClip` (`tr_main.c:384-443`): the farthest corner of the leafs the walk reached. */
  private setFarClip(): void {
    const bounds = this.visBounds;
    const eye = this.origin;
    let farthest = 0;
    for (let i = 0; i < 8; i++) {
      const x = f((i & 1 ? bounds[0] : bounds[3]) - eye[0]);
      const y = f((i & 2 ? bounds[1] : bounds[4]) - eye[1]);
      const z = f((i & 4 ? bounds[2] : bounds[5]) - eye[2]);
      const distance = dot(x, y, z, x, y, z);
      if (distance > farthest) farthest = distance;
    }
    this.zFar = f(Math.sqrt(farthest));
  }

  /**
   * `R_RotateForEntity` (`tr_main.c:272-330`): `tr.or` at a model's origin and axes, and the eye
   * in its frame.
   */
  private rotateForEntity(origin: Vec3, angles: Vec3): void {
    const axis = this.modelAxis;
    anglesToAxis(angles[0], angles[1], angles[2], axis);
    this.orAxis.set(axis);
    for (let j = 0; j < 3; j++) this.orOrigin[j] = f(origin[j]);
    const dx = f(this.origin[0] - this.orOrigin[0]);
    const dy = f(this.origin[1] - this.orOrigin[1]);
    const dz = f(this.origin[2] - this.orOrigin[2]);
    for (let i = 0; i < 3; i++) {
      this.orViewOrigin[i] = dot(dx, dy, dz, axis[i * 3], axis[i * 3 + 1], axis[i * 3 + 2]);
    }
  }
}

/** `DotProduct` in single precision, left to right. */
function dot(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return f(f(f(ax * bx) + f(ay * by)) + f(az * bz));
}

/**
 * `AnglesToAxis` (`q_math.c:150-156`) through `AngleVectors` (`q_math.c:932-965`), into
 * `axis` as forward, left and up.
 */
function anglesToAxis(pitch: number, yaw: number, roll: number, axis: Float64Array): void {
  let angle = f(f(yaw) * DEGREES);
  const sy = f(Math.sin(angle));
  const cy = f(Math.cos(angle));
  angle = f(f(pitch) * DEGREES);
  const sp = f(Math.sin(angle));
  const cp = f(Math.cos(angle));
  angle = f(f(roll) * DEGREES);
  const sr = f(Math.sin(angle));
  const cr = f(Math.cos(angle));
  axis[0] = f(cp * cy);
  axis[1] = f(cp * sy);
  axis[2] = -sp;
  // Left is right turned round: `VectorSubtract(vec3_origin, right, axis[1])`.
  axis[3] = f(0 - f(f(f(-sr * sp) * cy) + f(-cr * -sy)));
  axis[4] = f(0 - f(f(f(-sr * sp) * sy) + f(-cr * cy)));
  axis[5] = f(0 - f(-sr * cp));
  axis[6] = f(f(f(cr * sp) * cy) + f(-sr * -sy));
  axis[7] = f(f(f(cr * sp) * sy) + f(-sr * cy));
  axis[8] = f(cr * cp);
}
