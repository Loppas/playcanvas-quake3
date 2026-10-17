import type { Bsp } from '../formats/bsp';
import type { Vec3 as ViewVector } from '../sim/vec3';
import type { BrushModelPose } from './brush-models';
import { anglesToAxis } from './hand-pose';
import {
  SHADER_MAX_INDEXES,
  SHADER_MAX_VERTEXES,
  batchBound,
  cutRun,
  type Cut,
  type WorldRun
} from './world-batches';
import {
  gridIndexes,
  lodErrorForVolume,
  lodTables,
  wholeGrid,
  type GridTables,
  type Orientation,
  type PatchGrid
} from './world-curves';

/**
 * The world's indexes, every batch's in one array as the index buffer holds them: each run's of
 * the surfaces a view sees, each curve's at the rows the view keeps.
 *
 * Q3 sorts the surfaces a view adds by their key, stably (`R_SortDrawSurfs`,
 * `tr_main.c:1133-1148`), so a run draws those it sees in the order they were added. It chooses a
 * curve's rows each time it draws it (`RB_SurfaceGrid`, `tr_surface.c:870-1009`), and with them
 * where its run is cut into batches. Here a run is cut again, and its indexes written again in its
 * place, only when its surfaces or its curves' rows change.
 *
 * A run has room for the indexes of all its surfaces with every curve whole, which is the most it
 * ever needs, and for as many batches as any of them can be cut into (`batchBound`).
 *
 * A tessellated run is drawn from vertexes laid out batch by batch as Q3's tessellator holds them,
 * which its deforms move (`world-deforms.ts`): its indexes number them so, and its cut lists them.
 *
 * A dynamic light's bit is the key's last (`R_AddDrawSurf`), so the surfaces a light touches
 * leave their run's batches for batches of their own after them: a run draws those it sees
 * untouched, in the order they were added, then the touched ones, each part cut on its own. Each
 * batch keeps the surfaces whose light bits its surface functions OR into it, for the bits a frame
 * gives them ({@link WorldIndexes.dlightBits}).
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** A batch's place among the world's indexes. */
export interface BatchRange {
  base: number;
  /** How many indexes it has: 0 for one its run has no use for in this view. */
  count: number;
}

/** A run's batch, with the vertexes Q3's tessellator would hold for it (`tess.numVertexes`). */
export interface RunBatch extends BatchRange {
  vertexes: number;
  /** For a tessellated run, where its vertexes start in the run's {@link RunIndexes.tess}. */
  first: number;
  /**
   * The surfaces whose light bits it takes: from here in its run's {@link RunIndexes.lighting},
   * {@link lightCount} of them.
   */
  lightFirst: number;
  lightCount: number;
}

/** A run's place among the world's indexes, the surfaces it draws, and its batches. */
export interface RunIndexes {
  /**
   * For a tessellated run, each batch's vertexes in the order Q3's tessellator holds them, by
   * their places among the world's vertices, one batch after another from each one's
   * {@link RunBatch.first}; `null` for any other run.
   */
  readonly tess: Int32Array | null;
  /** Where its indexes start. */
  readonly base: number;
  /** How many indexes its latest cut wrote. */
  readonly used: number;
  /**
   * The surfaces it draws, the first {@link count}, in the order they draw: the first
   * {@link unlit} with no light's bit in their key, then those with it.
   */
  readonly surfaces: Int32Array;
  readonly count: number;
  readonly unlit: number;
  /**
   * As many as its surfaces can be cut into. Those it draws in this view come first, in order,
   * and the rest have no indexes.
   */
  readonly batches: readonly RunBatch[];
  /** The first of its {@link batches} whose surfaces have the light's bit in their key. */
  readonly litBatch: number;
  /** The surfaces each batch takes light bits from, batch after batch, by their BSP indexes. */
  readonly lighting: Int32Array;
}

/** What a view adds (`world-vis.ts`): the world's surfaces, then the brush models'. */
export interface SeenSurfaces {
  /** By their indexes in the BSP, the first `count` of them. */
  readonly surfaces: Int32Array;
  readonly count: number;
  /** How many of them the world's tree added. */
  readonly worldCount: number;
  /** Whether a light touches each, as its key's bit: 1 or 0. None where no light could. */
  readonly lit?: Uint8Array;
}

/** A curve, and the columns and rows it keeps. */
interface Curve {
  grid: PatchGrid;
  /** Where its points start among the world's vertices. */
  base: number;
  /** The allowance its rows were last chosen at; `NaN` until a view chooses them. */
  lodError: number;
  tables: GridTables;
}

interface RunState extends RunIndexes {
  base: number;
  used: number;
  count: number;
  unlit: number;
  batches: RunBatch[];
  litBatch: number;
  /** Where the cut being made puts the next surface a batch takes light bits from. */
  lighted: number;
  /** Every surface it has, in the order the whole tree draws them. */
  all: readonly number[];
  /** The entity's, or `null` for the world's. */
  orientation: Orientation | null;
  /** Each curve's tables as the cut takes them, at its place in `surfaces`; `null` for a face. */
  sizes: (GridTables | null)[];
  /** How many of its surfaces the view being taken has added so far, and whether any moved. */
  filled: number;
  moved: boolean;
}

const f = Math.fround;

/**
 * The most vertexes a tessellated run can hold over its batches, in any cut: each of its surfaces
 * whole, a curve's row again in the batch after each cut, and a batch full of rows alone for each
 * batch whose indexes come within two strips of the tessellator's room, as only those take one
 * (`RB_SurfaceGrid`, `tr_surface.c:914-938`). Never more than every batch full.
 *
 * @param whole - Its surfaces' vertexes, every curve whole.
 * @param indexes - Their indexes.
 * @param widest - Its widest curve's columns; 0 for none.
 * @param batches - The most batches it can be cut into.
 */
function tessRoom(whole: number, indexes: number, widest: number, batches: number): number {
  const full = SHADER_MAX_VERTEXES - 1;
  const alone = widest > 0 ? Math.floor(indexes / (SHADER_MAX_INDEXES - 12 * widest)) : 0;
  return Math.min(batches * full, whole + (batches - 1) * widest + alone * full);
}

/**
 * A curve's triangles over `count` rows of `lodWidth` points, as `RB_SurfaceGrid` numbers them in
 * its batch (`tr_surface.c:974-1004`): two a quad, in Q3's order and winding, its points from
 * `held` on, after those the batch already holds.
 *
 * @returns Where the next index goes.
 */
function heldGridIndexes(
  lodWidth: number,
  count: number,
  held: number,
  out: Uint32Array,
  at: number
): number {
  for (let i = 0; i < count - 1; i++) {
    for (let j = 0; j < lodWidth - 1; j++) {
      const v1 = held + i * lodWidth + j + 1;
      const v2 = v1 - 1;
      const v3 = v2 + lodWidth;
      const v4 = v3 + 1;
      out[at++] = v2;
      out[at++] = v3;
      out[at++] = v1;
      out[at++] = v1;
      out[at++] = v3;
      out[at++] = v4;
    }
  }
  return at;
}

/**
 * Where each drawn grid's points start among the world's vertices: after the map's own, one grid
 * after another in lump order.
 *
 * @param grids - Each surface's grid, by its index in the BSP.
 * @param drawn - The surfaces the world draws.
 * @returns each drawn grid's first point, by its surface, in lump order
 */
export function gridBases(
  bsp: Bsp,
  grids: readonly (PatchGrid | null)[],
  drawn: ReadonlySet<number>
): Map<number, number> {
  const bases = new Map<number, number>();
  let count = bsp.drawVerts.xyz.length / 3;
  grids.forEach((grid, surface) => {
    if (!grid || !drawn.has(surface)) return;
    bases.set(surface, count);
    count += grid.width * grid.height;
  });
  return bases;
}

/**
 * Every vertex's x, y and z, numbered as the world's indexes number them: the map's own, then each
 * drawn grid's points from its base.
 *
 * @param grids - Each surface's grid, by its index in the BSP.
 * @param bases - Where each drawn grid's points start, by its surface ({@link gridBases}).
 */
export function worldPositions(
  bsp: Bsp,
  grids: readonly (PatchGrid | null)[],
  bases: ReadonlyMap<number, number>
): Float32Array {
  let count = bsp.drawVerts.xyz.length / 3;
  for (const [surface] of bases) count += grids[surface]!.width * grids[surface]!.height;
  const xyz = new Float32Array(count * 3);
  xyz.set(bsp.drawVerts.xyz);
  for (const [surface, base] of bases) xyz.set(grids[surface]!.verts.xyz, base * 3);
  return xyz;
}

/** Where a brush model is placed: its origin and angles. */
type Placed = Pick<BrushModelPose, 'origin' | 'angles'>;

/**
 * A brush model's place as Q3 draws it, written into `out`: its origin and the axes its angles
 * give, in floats.
 */
function orient(pose: Placed, out: Orientation): void {
  const [pitch, yaw, roll] = pose.angles;
  const axis = anglesToAxis(pitch, yaw, roll, out.axis);
  for (let j = 0; j < 3; j++) {
    out.origin[j] = f(pose.origin[j]);
    for (let k = 0; k < 3; k++) axis[k][j] = f(axis[k][j]);
  }
}

/** A brush model's place at `pose`. */
function orientationOf(pose: Placed): Orientation {
  const orientation: Orientation = {
    origin: [0, 0, 0],
    axis: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]
  };
  orient(pose, orientation);
  return orientation;
}

export class WorldIndexes {
  /** Every run's indexes, each at its place: what the index buffer holds. */
  readonly indexes: Uint32Array<ArrayBuffer>;
  /** The runs, in the order they draw. */
  readonly runs: readonly RunIndexes[];

  private readonly bsp: Bsp;
  private readonly states: RunState[];
  /** Each brush model's place, by entity, which its runs share. */
  private readonly orientations: Orientation[];
  /** Each surface's curve, by its index in the BSP; `null` for a face or a soup. */
  private readonly curves: (Curve | null)[];
  /** The run each surface draws in when the world's tree adds it, and when a brush model does. */
  private readonly worldRuns: Int32Array;
  private readonly modelRuns: Int32Array;
  /**
   * The cut being made: its run, the batch it is on, where the next index goes, and, for a
   * tessellated run, where the next vertex goes in its list.
   */
  private run!: RunState;
  private batch = 0;
  private at = 0;
  private vertex = 0;
  private readonly writer: Cut = {
    begin: () => this.begin(),
    surface: (at) => this.surface(at),
    rows: (at, first, count) => this.rows(at, first, count),
    row: (at, row) => this.row(at, row),
    light: (at) => this.light(at),
    end: (numVerts) => this.end(numVerts)
  };

  /**
   * Every run cut with all its surfaces, in the order the whole tree draws them, every curve
   * whole.
   *
   * @param grids - Each surface's grid, by its index in the BSP.
   * @param gridBases - Where each drawn grid's points start among the world's vertices.
   * @param poses - The brush models drawn as entities, by entity number, where each stands until
   *   {@link orient} places it again.
   * @param tessellated - Which runs, by their places, are drawn from vertexes of their own laid
   *   out as Q3's tessellator holds each batch: their indexes number each batch's vertexes from
   *   its first, as `tess.indexes` does, and their vertexes are listed in {@link RunIndexes.tess}.
   */
  constructor(
    bsp: Bsp,
    runs: readonly WorldRun[],
    grids: readonly (PatchGrid | null)[],
    gridBases: ReadonlyMap<number, number>,
    poses: readonly BrushModelPose[],
    tessellated: readonly boolean[] = []
  ) {
    this.bsp = bsp;
    this.orientations = poses.map(orientationOf);
    const n = bsp.surfaces.length;
    this.curves = new Array<Curve | null>(n).fill(null);
    this.worldRuns = new Int32Array(n).fill(-1);
    this.modelRuns = new Int32Array(n).fill(-1);
    let total = 0;
    this.states = runs.map((run, r) => {
      const entity = run.entity < poses.length;
      const owners = entity ? this.modelRuns : this.worldRuns;
      let room = 0;
      let whole = 0;
      let widest = 0;
      for (const surface of run.surfaces) {
        // A brush model placed twice adds its surfaces once a view, by the first entity.
        if (owners[surface] < 0) owners[surface] = r;
        const grid = grids[surface];
        if (!grid) {
          room += bsp.surfaces[surface].numIndexes;
          whole += bsp.surfaces[surface].numVerts;
          continue;
        }
        room += (grid.width - 1) * (grid.height - 1) * 6;
        whole += grid.width * grid.height;
        widest = Math.max(widest, grid.width);
        this.curves[surface] ??= {
          grid,
          base: gridBases.get(surface)!,
          lodError: NaN,
          tables: wholeGrid(grid)
        };
      }
      const base = total;
      total += room;
      // One more for its lit surfaces, cut on their own: two cuts each within the bound of their
      // own surfaces, which together are within the whole's.
      const bound = batchBound(bsp, run.surfaces, grids) + 1;
      const batch = (): RunBatch => ({
        base,
        count: 0,
        vertexes: 0,
        first: 0,
        lightFirst: 0,
        lightCount: 0
      });
      return {
        base,
        used: 0,
        tess: tessellated[r] ? new Int32Array(tessRoom(whole, room, widest, bound)) : null,
        surfaces: Int32Array.from(run.surfaces),
        count: run.surfaces.length,
        unlit: run.surfaces.length,
        batches: Array.from({ length: bound }, batch),
        litBatch: bound,
        lighting: new Int32Array(run.surfaces.length),
        lighted: 0,
        all: run.surfaces,
        orientation: entity ? this.orientations[run.entity] : null,
        sizes: new Array<GridTables | null>(run.surfaces.length).fill(null),
        filled: 0,
        moved: false
      };
    });
    this.runs = this.states;
    this.indexes = new Uint32Array(Math.max(1, total));
    for (const state of this.states) this.cut(state);
  }

  /**
   * A brush model placed again, as an entity moves it: the next view chooses its curves' rows from
   * where it stands now.
   *
   * @param entity - The brush model, by its entity number among those it was made with.
   */
  orient(entity: number, pose: Placed): void {
    orient(pose, this.orientations[entity]);
  }

  /**
   * Take a view: each run's surfaces as the view added them, each seen curve's rows chosen, and
   * each run cut again whose surfaces or rows changed.
   *
   * @param seen - What the view added.
   * @param eye - Where the view is.
   * @param forward - The way it looks, of unit length.
   * @param lodCurveError - `r_lodCurveError`.
   * @param rewritten - Told each run cut again, by its place among the runs, once its indexes and
   *   batches are written.
   */
  view(
    seen: SeenSurfaces,
    eye: Readonly<ViewVector>,
    forward: Readonly<ViewVector>,
    lodCurveError: number,
    rewritten: (run: number) => void
  ): void {
    const states = this.states;
    for (let r = 0; r < states.length; r++) {
      states[r].filled = 0;
      states[r].moved = false;
    }
    // The untouched surfaces first, then, where a light touches any, the touched ones.
    const { lit } = seen;
    this.fill(seen, lit ? 0 : -1);
    for (let r = 0; r < states.length; r++) {
      const state = states[r];
      if (state.filled !== state.unlit) state.moved = true;
      state.unlit = state.filled;
    }
    if (lit) this.fill(seen, 1);
    for (let r = 0; r < states.length; r++) {
      const state = states[r];
      let changed = state.moved || state.filled !== state.count;
      state.count = state.filled;
      for (let k = 0; k < state.count; k++) {
        const curve = this.curves[state.surfaces[k]];
        if (!curve) continue;
        if (this.choose(curve, state.orientation, eye, forward, lodCurveError)) changed = true;
      }
      if (changed) {
        this.cut(state);
        rewritten(r);
      }
    }
  }

  /**
   * A view's surfaces put in their runs after those already there, in the order it added them:
   * those whose key's light bit is `bit`, or every one for −1.
   */
  private fill(seen: SeenSurfaces, bit: number): void {
    const { surfaces, count, worldCount, lit } = seen;
    const states = this.states;
    for (let i = 0; i < count; i++) {
      if (bit >= 0 && lit![i] !== bit) continue;
      const surface = surfaces[i];
      const r = i < worldCount ? this.worldRuns[surface] : this.modelRuns[surface];
      if (r < 0) continue;
      const state = states[r];
      if (state.surfaces[state.filled] !== surface) {
        state.surfaces[state.filled] = surface;
        state.moved = true;
      }
      state.filled++;
    }
  }

  /**
   * A batch's light bits for a frame, as its surface functions OR them into `tess.dlightBits`: of
   * every surface it takes them from, by the bits each keeps.
   *
   * @param bits - Each surface's light bits, by its index in the BSP (`WorldVis.dlightBits`).
   */
  dlightBits(run: number, batch: number, bits: Int32Array): number {
    const { batches, lighting } = this.states[run];
    const { lightFirst, lightCount } = batches[batch];
    let or = 0;
    for (let i = lightFirst; i < lightFirst + lightCount; i++) or |= bits[lighting[i]];
    return or;
  }

  /**
   * Put every run back to all its surfaces, in the order the whole tree draws them, every curve
   * whole, and cut again each run that was not. The next view takes its surfaces, and chooses
   * every curve's rows, afresh.
   *
   * @param rewritten - Told each run cut again, as {@link WorldIndexes.view} tells it.
   */
  whole(rewritten: (run: number) => void): void {
    for (let r = 0; r < this.states.length; r++) {
      const state = this.states[r];
      const { all, surfaces } = state;
      let changed = state.count !== all.length || state.unlit !== all.length;
      state.count = all.length;
      state.unlit = all.length;
      for (let k = 0; k < all.length; k++) {
        if (surfaces[k] !== all[k]) {
          surfaces[k] = all[k];
          changed = true;
        }
        const curve = this.curves[all[k]];
        if (!curve) continue;
        curve.lodError = NaN;
        const { grid, tables } = curve;
        if (tables.lodWidth === grid.width && tables.lodHeight === grid.height) continue;
        wholeGrid(grid, tables);
        changed = true;
      }
      if (changed) {
        this.cut(state);
        rewritten(r);
      }
    }
  }

  /** Choose a curve's rows for a view: whether it keeps other columns or rows than it did. */
  private choose(
    curve: Curve,
    orientation: Orientation | null,
    eye: Readonly<ViewVector>,
    forward: Readonly<ViewVector>,
    lodCurveError: number
  ): boolean {
    const lodError = lodErrorForVolume(curve.grid, orientation, eye, forward, lodCurveError);
    if (lodError === curve.lodError) return false;
    curve.lodError = lodError;
    const { lodWidth, lodHeight } = curve.tables;
    lodTables(curve.grid, lodError, curve.tables);
    return curve.tables.lodWidth !== lodWidth || curve.tables.lodHeight !== lodHeight;
  }

  /**
   * Cut a run's surfaces by the rows its curves keep, writing its indexes from its place: those
   * untouched by a light, then, in batches of their own, those touched.
   */
  private cut(state: RunState): void {
    for (let k = 0; k < state.count; k++) {
      state.sizes[k] = this.curves[state.surfaces[k]]?.tables ?? null;
    }
    this.run = state;
    this.batch = -1;
    this.at = state.base;
    this.vertex = 0;
    state.lighted = 0;
    const { unlit, count } = state;
    if (unlit > 0 || count === 0) {
      cutRun(this.bsp, state.surfaces, unlit, state.sizes, this.writer);
    }
    state.litBatch = this.batch + 1;
    if (count > unlit) cutRun(this.bsp, state.surfaces, count, state.sizes, this.writer, unlit);
    state.used = this.at - state.base;
    for (let k = this.batch + 1; k < state.batches.length; k++) {
      const batch = state.batches[k];
      batch.count = 0;
      batch.vertexes = 0;
      batch.first = this.vertex;
      batch.lightFirst = state.lighted;
      batch.lightCount = 0;
    }
  }

  private begin(): void {
    const { batches } = this.run;
    this.batch++;
    if (this.batch === batches.length) {
      throw new Error('A run was cut into more batches than next-fit can need');
    }
    const batch = batches[this.batch];
    batch.base = this.at;
    batch.first = this.vertex;
    batch.lightFirst = this.run.lighted;
    batch.lightCount = 0;
  }

  /** A surface's light bits taken by the batch being cut. */
  private light(at: number): void {
    const run = this.run;
    run.lighting[run.lighted++] = run.surfaces[at];
    run.batches[this.batch].lightCount++;
  }

  /** How many vertexes a tessellated run's batch being cut holds so far. */
  private held(): number {
    return this.vertex - this.run.batches[this.batch].first;
  }

  private surface(at: number): void {
    const { drawIndexes, surfaces } = this.bsp;
    const { firstIndex, numIndexes, firstVert, numVerts } = surfaces[this.run.surfaces[at]];
    const { tess } = this.run;
    // `RB_SurfaceFace` and `RB_SurfaceTriangles` number a surface's vertexes from where they go.
    const offset = tess ? this.held() : firstVert;
    for (let i = 0; i < numIndexes; i++) {
      this.indexes[this.at++] = drawIndexes[firstIndex + i] + offset;
    }
    if (!tess) return;
    for (let k = 0; k < numVerts; k++) tess[this.vertex++] = firstVert + k;
  }

  private rows(at: number, first: number, count: number): void {
    const { grid, tables, base } = this.curves[this.run.surfaces[at]]!;
    if (!this.run.tess) {
      this.at = gridIndexes(grid, tables, first, count, base, this.indexes, this.at);
      return;
    }
    this.at = heldGridIndexes(tables.lodWidth, count, this.held(), this.indexes, this.at);
    this.list(grid, tables, base, first, count);
  }

  private row(at: number, row: number): void {
    if (!this.run.tess) return;
    const { grid, tables, base } = this.curves[this.run.surfaces[at]]!;
    this.list(grid, tables, base, row, 1);
  }

  /** A tessellated run's curve's kept rows listed, as `RB_SurfaceGrid` copies their points. */
  private list(
    grid: PatchGrid,
    tables: GridTables,
    base: number,
    first: number,
    count: number
  ): void {
    const tess = this.run.tess!;
    const { widthTable, heightTable, lodWidth } = tables;
    for (let i = 0; i < count; i++) {
      const row = base + heightTable[first + i] * grid.width;
      for (let j = 0; j < lodWidth; j++) tess[this.vertex++] = row + widthTable[j];
    }
  }

  private end(numVerts: number): void {
    const batch = this.run.batches[this.batch];
    batch.count = this.at - batch.base;
    batch.vertexes = numVerts;
  }
}

/** What `r_speeds 1` prints of a view, and `r_speeds 5`, by Q3's counters. */
export interface ViewSpeeds {
  /** `c_shaders`: the batches drawn. */
  shaders: number;
  /** `c_surfaces`: the surfaces the view added. */
  surfaces: number;
  /** `c_leafs`: the leafs the walk reached. */
  leafs: number;
  /** `c_vertexes`: the batches' vertexes. */
  vertexes: number;
  /** `c_indexes / 3`: their triangles. */
  triangles: number;
  /** `c_totalIndexes / 3`: their triangles once for each of their shader's passes. */
  passTriangles: number;
  /** `tr.viewParms.zFar`, as `r_speeds 5` prints it: rounded to a unit. */
  zFar: number;
}

/**
 * A view's counts as `R_PerformanceCounters` prints them (`tr_cmds.c:37-41, 58-61`). A batch is
 * counted where it has indexes (`RB_EndSurface`, `tr_shade.c:1293-1320`); a sky's batches are
 * counted as any other's, before its box and clouds are drawn.
 *
 * @param view - What the view added and reached (`world-vis.ts`).
 * @param passes - Each run's shader's passes, `numUnfoggedPasses`: its stages, its fog's pass
 *   apart.
 * @param dlightIndexes - The indexes the frame's light passes drew, which `c_totalIndexes` counts
 *   too (`tr_shade.c:554`).
 */
export function viewSpeeds(
  view: { readonly count: number; readonly leafs: number; readonly zFar: number },
  runs: readonly RunIndexes[],
  passes: ArrayLike<number>,
  dlightIndexes = 0
): ViewSpeeds {
  let shaders = 0;
  let vertexes = 0;
  let indexes = 0;
  let passIndexes = dlightIndexes;
  runs.forEach(({ batches }, r) => {
    for (const { count, vertexes: held } of batches) {
      if (count === 0) continue;
      shaders++;
      vertexes += held;
      indexes += count;
      passIndexes += count * passes[r];
    }
  });
  return {
    shaders,
    surfaces: view.count,
    leafs: view.leafs,
    vertexes,
    triangles: indexes / 3,
    passTriangles: passIndexes / 3,
    zFar: Math.round(view.zFar)
  };
}
