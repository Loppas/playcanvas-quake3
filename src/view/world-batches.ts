import { MST_PATCH, MST_PLANAR, MST_TRIANGLE_SOUP, type Bsp } from '../formats/bsp';
import type { GridTables, PatchGrid } from './world-curves';
import type { WorldShaders } from './world-shaders';

/**
 * The world's draws, in the order opengl1 draws them, and cut where it cuts them.
 *
 * Each frame Q3 gathers the surfaces it can see: the world's by walking its tree
 * (`R_RecursiveWorldNode`, `tr_world.c:425-497`), each brush model's in its own order
 * (`R_AddBrushModelSurfaces`, `:318-339`). It sorts them by a key, stably (`R_AddDrawSurf`,
 * `tr_main.c:1100-1113`), and draws each run of one key as batches. A face or a triangle soup
 * flushes the batch when it would overflow the tessellator (`RB_CheckOverflow`,
 * `tr_surface.c:48-64`); a curve adds its rows as they fit, and may be cut across batches
 * (`RB_SurfaceGrid`, `:914-1009`). Each batch is drawn stage by stage (`RB_IterateStagesGeneric`,
 * `tr_shade.c:928-982`).
 *
 * Here the runs are found once, from every surface the world can draw, in the order Q3 draws them
 * when it sees everything. Each view, a run draws the surfaces of it the view sees, in the order
 * the view added them, cut by the rows its curves keep (`world-indexes.ts`).
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `SHADER_MAX_VERTEXES` and `SHADER_MAX_INDEXES` (`qfiles.h:31-32`): the tessellator's room. */
export const SHADER_MAX_VERTEXES = 1000;
export const SHADER_MAX_INDEXES = 6000;

/** A surface as a batch draws it. */
export interface BatchPiece {
  /** By its index in the BSP. */
  surface: number;
  /**
   * For a curve, the rows of its grid drawn here: `count` of the rows it keeps, from `first`. The
   * first is the last row of the piece before, where the grid is cut. A face or a triangle soup
   * is drawn whole, and has none.
   */
  rows?: { first: number; count: number };
}

/** The surfaces of one key, in the order they draw: one shader, one entity, one fog. */
export interface WorldRun {
  /** The shader, by its index in `WorldShaders.shaders`. */
  shader: number;
  /** Which brush model of those asked for, by its place among them; the world comes after. */
  entity: number;
  /** The BSP's inline model the surfaces are from: 0 for the world. */
  model: number;
  /** The fog, as Q3 numbers it in the key: 0 for none, else the fog's number plus one. */
  fog: number;
  /** By their indexes in the BSP. */
  surfaces: number[];
}

/** Surfaces drawn as one, in one shader, for one entity, in one fog. */
export interface WorldBatch extends Omit<WorldRun, 'surfaces'> {
  /** What it draws, in order. */
  pieces: BatchPiece[];
  numVerts: number;
  numIndexes: number;
}

/**
 * Every surface the world's tree reaches, in the order `R_RecursiveWorldNode` adds them: the front
 * child first, each leaf's surfaces in its own order, each surface at the first leaf that holds it
 * (`tr_world.c:284-288, 445-450`). A surface in no leaf the tree reaches is never drawn.
 */
export function treeOrder(bsp: Bsp): number[] {
  const seen = new Uint8Array(bsp.surfaces.length);
  const order: number[] = [];
  const walk = (start: number) => {
    let node = start;
    while (node >= 0) {
      walk(bsp.nodes[node].children[0]);
      node = bsp.nodes[node].children[1];
    }
    const { firstLeafSurface, numLeafSurfaces } = bsp.leafs[-1 - node];
    for (let i = firstLeafSurface; i < firstLeafSurface + numLeafSurfaces; i++) {
      const surface = bsp.leafSurfaces[i];
      if (seen[surface]) continue;
      seen[surface] = 1;
      order.push(surface);
    }
  };
  walk(0);
  return order;
}

/** The grids a batch is cut by: a curve's size, or `null` where a surface has none. */
type Grids = readonly (Pick<PatchGrid, 'width' | 'height'> | null)[];

/**
 * Whether a surface is batched as the world's are: a face, a triangle soup or a curve with a grid,
 * whose shader has stages, is a sky's or has a fog pass. A nodraw curve has no grid, and flares
 * draw by passes of their own. A sky's batches find the blocks of its box their triangles cover
 * (`world-sky.ts`), and draw none of the triangles themselves. A fog's face with no stages draws
 * its fog's pass alone, and nothing out of a fog.
 */
function drawsHere(bsp: Bsp, shaders: WorldShaders, grids: Grids, surface: number): boolean {
  const { surfaceType } = bsp.surfaces[surface];
  const drawable =
    surfaceType === MST_PLANAR ||
    surfaceType === MST_TRIANGLE_SOUP ||
    (surfaceType === MST_PATCH && grids[surface] !== null);
  if (!drawable) return false;
  const shader = shaders.shaders[shaders.surfaceShaders[surface]];
  return shader.stages.length > 0 || shader.sky !== undefined || shader.fogPass !== 'none';
}

/**
 * The world's runs in the order they draw: by shader in the draw order, then by entity, the brush
 * models in the order given and the world last, then by fog. Within a run, surfaces stay in the
 * order they were gathered.
 *
 * @param brushModels - The inline models drawn as entities, in the order the scene adds them: by
 *   entity number.
 * @param grids - Each surface's grid, by its index in the BSP (`world-curves.ts`).
 */
export function worldRuns(
  bsp: Bsp,
  shaders: WorldShaders,
  brushModels: readonly number[],
  grids: Grids
): WorldRun[] {
  interface Gathered {
    surface: number;
    entity: number;
    model: number;
  }
  const gathered: Gathered[] = [];
  const gather = (surfaces: Iterable<number>, entity: number, model: number) => {
    for (const surface of surfaces) {
      if (drawsHere(bsp, shaders, grids, surface)) gathered.push({ surface, entity, model });
    }
  };
  brushModels.forEach((model, entity) => {
    const { firstSurface, numSurfaces } = bsp.models[model];
    gather(
      Array.from({ length: numSurfaces }, (_, i) => firstSurface + i),
      entity,
      model
    );
  });
  gather(treeOrder(bsp), brushModels.length, 0);

  const shaderOf = (g: Gathered) => shaders.surfaceShaders[g.surface];
  const sortedIndex = (g: Gathered) => shaders.shaders[shaderOf(g)].sortedIndex;
  const fog = (g: Gathered) => bsp.surfaces[g.surface].fogNum + 1;
  // Stable, as `R_RadixSort` is.
  gathered.sort(
    (a, b) => sortedIndex(a) - sortedIndex(b) || a.entity - b.entity || fog(a) - fog(b)
  );

  const runs: WorldRun[] = [];
  let run: WorldRun | undefined;
  for (const g of gathered) {
    if (!run || run.shader !== shaderOf(g) || run.entity !== g.entity || run.fog !== fog(g)) {
      run = { shader: shaderOf(g), entity: g.entity, model: g.model, fog: fog(g), surfaces: [] };
      runs.push(run);
    }
    run.surfaces.push(g.surface);
  }
  return runs;
}

/** How a curve is cut: the columns and rows it keeps. */
export type GridSize = Pick<GridTables, 'lodWidth' | 'lodHeight'>;

/** What a run's cut is told, in order. */
export interface Cut {
  /** A batch begins: `RB_BeginSurface`. */
  begin(): void;
  /** The run's surface at `at` goes in the batch whole. */
  surface(at: number): void;
  /** `count` of the kept rows of the run's curve at `at` go in the batch, from `first`. */
  rows(at: number, first: number, count: number): void;
  /**
   * A kept row of the run's curve at `at` goes in the batch alone, where only one fits: its
   * vertexes take room, and it draws nothing.
   */
  row?(at: number, row: number): void;
  /**
   * The run's surface at `at` ORs its light bits into the batch being made, where its surface
   * function ORs them into `tess.dlightBits`: a face's after it is found to fit
   * (`RB_SurfaceFace`), a soup's before (`RB_SurfaceTriangles`, so one that does not fit gives its
   * bits to the batch before it), and a curve's before its rows (`RB_SurfaceGrid`, so its rows past
   * a cut take none).
   */
  light?(at: number): void;
  /** The batch ends, holding as many vertexes and indexes as the tessellator counts. */
  end(numVerts: number, numIndexes: number): void;
}

/**
 * A run cut into batches where the tessellator would overflow. A face or a triangle soup goes in
 * whole, and a curve adds as many of its rows as fit, cut across batches as `RB_SurfaceGrid` cuts
 * it: one row's room kept spare, a batch begun when not one strip fits, and the last row drawn
 * again where the grid is cut.
 *
 * @param surfaces - The run's surfaces, those from `from` up to `count` cut.
 * @param sizes - The run's curves as they are cut, each at its place in `surfaces`; `null` for a
 *   face or a soup.
 * @param cut - Told each batch and what goes in it, as the cut is made.
 * @param from - Where in `surfaces` the cut starts.
 * @throws `RB_CheckOverflow`'s words for a surface too large for a batch of its own
 */
export function cutRun(
  bsp: Bsp,
  surfaces: ArrayLike<number>,
  count: number,
  sizes: ArrayLike<GridSize | null>,
  cut: Cut,
  from = 0
): void {
  let numVerts = 0;
  let numIndexes = 0;
  cut.begin();
  for (let at = from; at < count; at++) {
    const size = sizes[at];
    if (size) {
      cut.light?.(at);
      const { lodWidth, lodHeight } = size;
      let used = 0;
      while (used < lodHeight - 1) {
        let vrows: number;
        let irows: number;
        for (;;) {
          vrows = Math.trunc((SHADER_MAX_VERTEXES - numVerts) / lodWidth);
          irows = Math.trunc((SHADER_MAX_INDEXES - numIndexes) / (lodWidth * 6));
          if (vrows >= 2 && irows >= 1) break;
          cut.end(numVerts, numIndexes);
          cut.begin();
          numVerts = 0;
          numIndexes = 0;
        }
        let rows = irows;
        if (vrows < irows + 1) rows = vrows - 1;
        if (used + rows > lodHeight) rows = lodHeight - used;
        if (rows > 1) cut.rows(at, used, rows);
        else cut.row?.(at, used);
        numVerts += rows * lodWidth;
        numIndexes += (rows - 1) * (lodWidth - 1) * 6;
        used += rows - 1;
      }
      continue;
    }

    const surface = bsp.surfaces[surfaces[at]];
    const soup = surface.surfaceType === MST_TRIANGLE_SOUP;
    if (soup) cut.light?.(at);
    if (
      numVerts + surface.numVerts >= SHADER_MAX_VERTEXES ||
      numIndexes + surface.numIndexes >= SHADER_MAX_INDEXES
    ) {
      if (surface.numVerts >= SHADER_MAX_VERTEXES) {
        throw new Error(
          `RB_CheckOverflow: verts > MAX (${surface.numVerts} > ${SHADER_MAX_VERTEXES})`
        );
      }
      if (surface.numIndexes >= SHADER_MAX_INDEXES) {
        throw new Error(
          `RB_CheckOverflow: indices > MAX (${surface.numIndexes} > ${SHADER_MAX_INDEXES})`
        );
      }
      cut.end(numVerts, numIndexes);
      cut.begin();
      numVerts = 0;
      numIndexes = 0;
    }
    if (!soup) cut.light?.(at);
    cut.surface(at);
    numVerts += surface.numVerts;
    numIndexes += surface.numIndexes;
  }
  cut.end(numVerts, numIndexes);
}

/**
 * The most batches {@link cutRun} can cut a run's surfaces into: any of them, in any order, each
 * curve at any level of detail.
 *
 * A batch ends only when what comes next does not fit, so any two batches in a row hold more than
 * one batch's room of vertexes or of indexes. A curve cut across them falls short of that by a
 * row: the row drawn on both sides of the cut, or one left unused before it. So two batches hold
 * at least a batch's vertexes less a row of the widest curve at each end, or its indexes less a
 * quad's, and there are at most twice as many as the run's whole holds that, and one.
 *
 * @param grids - Each surface's grid, by its index in the BSP (`world-curves.ts`).
 */
export function batchBound(bsp: Bsp, surfaces: readonly number[], grids: Grids): number {
  let numVerts = 0;
  let numIndexes = 0;
  let widest = 0;
  for (const surface of surfaces) {
    const grid = grids[surface];
    if (grid) {
      numVerts += grid.width * grid.height;
      numIndexes += (grid.width - 1) * (grid.height - 1) * 6;
      widest = Math.max(widest, grid.width);
    } else {
      numVerts += bsp.surfaces[surface].numVerts;
      numIndexes += bsp.surfaces[surface].numIndexes;
    }
  }
  const pairs =
    Math.floor(numVerts / (SHADER_MAX_VERTEXES - 2 * widest)) +
    Math.floor(numIndexes / (SHADER_MAX_INDEXES - (widest > 0 ? 6 : 0)));
  return 2 * pairs + 1;
}

/**
 * The world's batches in the order they draw: each run of {@link worldRuns} cut by
 * {@link cutRun}, every curve whole.
 *
 * @param brushModels - The inline models drawn as entities, in the order the scene adds them: by
 *   entity number.
 * @param grids - Each surface's grid, by its index in the BSP (`world-curves.ts`).
 * @throws `RB_CheckOverflow`'s words for a surface too large for a batch of its own
 */
export function worldBatches(
  bsp: Bsp,
  shaders: WorldShaders,
  brushModels: readonly number[],
  grids: Grids
): WorldBatch[] {
  const batches: WorldBatch[] = [];
  for (const { surfaces, ...key } of worldRuns(bsp, shaders, brushModels, grids)) {
    const sizes = surfaces.map((surface) => {
      const grid = grids[surface];
      return grid && { lodWidth: grid.width, lodHeight: grid.height };
    });
    let batch: WorldBatch;
    cutRun(bsp, surfaces, surfaces.length, sizes, {
      begin: () => {
        batch = { ...key, pieces: [], numVerts: 0, numIndexes: 0 };
        batches.push(batch);
      },
      surface: (at) => batch.pieces.push({ surface: surfaces[at] }),
      rows: (at, first, count) =>
        batch.pieces.push({ surface: surfaces[at], rows: { first, count } }),
      end: (numVerts, numIndexes) => {
        batch.numVerts = numVerts;
        batch.numIndexes = numIndexes;
      }
    });
  }
  return batches;
}
