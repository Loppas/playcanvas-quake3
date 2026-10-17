import { atoi } from '../formats/c-scan';
import type { CvarStore } from '../net/cvar';
import { ENTITYNUM_NONE, ENTITYNUM_WORLD, type EntityState } from '../net/protocol';
import { emptyClipMap, inlineModel, modelBounds, tempBoxModel } from './cm/cm-load';
import { newTrace, type ClipMap, type Trace } from './cm/cm-local';
import { pointContents, transformedPointContents } from './cm/cm-test';
import { boxTrace, transformedBoxTrace } from './cm/cm-trace';
import type { EntityShared } from './game-entity';
import type { InlineModels, PointContentsFn, TraceFn, TraceResult } from './types';
import { vec3, type Vec3 } from './vec3';

/**
 * The sim's traces over Quake 3's collision (`src/sim/cm`): a BSP map's, as the world half of
 * `SV_Trace` and `CG_Trace` runs `CM_BoxTrace` on model 0 (`sv_world.c:610-611`,
 * `cg_predict.c:149-150`), and an entity's box, as their other half sweeps the temp box.
 *
 * The answer is collision's `trace_t` as Q3's callers read it, not the octree's conventions: a
 * trace that meets no plane keeps the zero normal collision leaves, and one that starts in solid
 * and gets out keeps collision's fraction.
 */

/** A vector as collision takes one. */
type Floats = [number, number, number];

/** Scratch for one clip map's traces, as `CM_BoxTrace` takes its vectors. */
interface ClipScratch {
  start: Floats;
  end: Floats;
  mins: Floats;
  maxs: Floats;
}

/**
 * A clip map's swept-box trace through the world, model 0.
 *
 * Each trace's vectors go to collision through scratch of the map's own, and its result through
 * one `trace_t`, so collision makes nothing; the result handed back is made per trace, as the
 * octree's is.
 *
 * @param cm - The clip map.
 * @param cvars - Where `cm_noAreas`, `cm_noCurves` and `cm_playerCurveClip` are read, as collision
 *   reads them at each use; without one, the clip map's own stand.
 */
export function createClipTrace(cm: ClipMap, cvars?: CvarStore): TraceFn {
  const scratch = clipScratch();
  const results = newTrace();
  const sync = cvars ? clipCvarsSync(cm, cvars) : null;
  return (start, mins, maxs, end, _passEntityNum, contentmask) => {
    sync?.();
    boxTrace(
      cm,
      results,
      into(scratch.start, start),
      into(scratch.end, end),
      into(scratch.mins, mins),
      into(scratch.maxs, maxs),
      0,
      contentmask
    );
    // `SV_Trace`'s and `CG_Trace`'s naming of what the world stopped.
    return traceResult(results, results.fraction !== 1 ? ENTITYNUM_WORLD : ENTITYNUM_NONE);
  };
}

/**
 * A clip map's point contents in the world, model 0, as the world half of `SV_PointContents` and
 * `CG_PointContents` asks (`sv_world.c:662`, `cg_predict.c:169`). The world has nothing to pass.
 *
 * @param cm - The clip map.
 */
export function createClipPointContents(cm: ClipMap): PointContentsFn {
  const point = floats();
  return (p) => pointContents(cm, into(point, p), 0);
}

/**
 * A clip map's inline models as cgame reaches them, by `trap_CM_InlineModel`, a box trace on one,
 * and the transformed trace and contents of one where an entity stands, each test's vectors
 * through scratch of the map's own.
 *
 * @param cm - The clip map.
 * @param cvars - Where collision's cvars are read, as {@link createClipTrace} reads them.
 */
export function createClipInlineModels(cm: ClipMap, cvars?: CvarStore): InlineModels {
  const scratch = { ...clipScratch(), origin: floats(), angles: floats() };
  const results = newTrace();
  const sync = cvars ? clipCvarsSync(cm, cvars) : null;
  return {
    inlineModel: (index) => inlineModel(cm, index),
    contact: (model, origin, mins, maxs) => {
      sync?.();
      const at = into(scratch.start, origin);
      boxTrace(cm, results, at, at, into(scratch.mins, mins), into(scratch.maxs, maxs), model, -1);
      return results.startsolid;
    },
    transformedBoxTrace: (model, start, mins, maxs, end, contentmask, origin, angles) => {
      sync?.();
      transformedBoxTrace(
        cm,
        results,
        into(scratch.start, start),
        into(scratch.end, end),
        into(scratch.mins, mins),
        into(scratch.maxs, maxs),
        model,
        contentmask,
        into(scratch.origin, origin),
        into(scratch.angles, angles)
      );
      return traceResult(results, ENTITYNUM_NONE);
    },
    transformedPointContents: (point, model, origin, angles) =>
      transformedPointContents(
        cm,
        into(scratch.start, point),
        model,
        into(scratch.origin, origin),
        into(scratch.angles, angles)
      ),
    modelBounds: (model, mins, maxs) => {
      modelBounds(cm, model, scratch.mins, scratch.maxs);
      [mins.x, mins.y, mins.z] = scratch.mins;
      [maxs.x, maxs.y, maxs.z] = scratch.maxs;
    }
  };
}

/**
 * The temp box's clip map: `CM_LoadMap`'s map of no name, with the box hull. The box reads
 * nothing of a map but the hull set up past its arrays, so this one answers for every map, as the
 * one clip map of Q3's process does. It has no inline models, so it is also the answer of a map
 * with no clip map of its own, a splat map, to any `*N`.
 */
const boxMap = emptyClipMap();
const boxScratch = {
  ...clipScratch(),
  boxMins: floats(),
  boxMaxs: floats(),
  origin: floats(),
  angles: floats()
};
const boxResults = newTrace();
/** `vec3_origin`: a box's angles, as "boxes don't rotate" (`sv_world.c:559`), and a contact's. */
const VEC3_ORIGIN = floats();

/**
 * What `SV_ClipHandleForEntity` and the server's clips through it read of an entity: whether it
 * is a brush model, which one, its box, and where it stands.
 */
export interface ClipEntity {
  s: Pick<EntityState, 'modelindex'>;
  r: Pick<EntityShared, 'bmodel' | 'mins' | 'maxs' | 'currentOrigin' | 'currentAngles'>;
}

/** `SV_ClipHandleForEntity`'s answer: a clip handle, and the clip map it is one of. */
const entityClip = { cm: boxMap, handle: 0 };

/**
 * `SV_ClipHandleForEntity` (`sv_world.c:35-47`), into {@link entityClip}: a brush model's own
 * inline model on the map's clip map, else the temp box set to the entity's bounds. Q3's capsule
 * is for `SVF_CAPSULE`, which nothing the port runs sets.
 *
 * @param cm - The map's clip map, or none for a map without one.
 * @throws `CM_InlineModel`'s error for a model the map has not got
 */
function clipHandleForEntity(cm: ClipMap | undefined, entity: ClipEntity): void {
  const s = boxScratch;
  if (entity.r.bmodel) {
    entityClip.cm = cm ?? boxMap;
    entityClip.handle = inlineModel(entityClip.cm, entity.s.modelindex);
    return;
  }
  entityClip.cm = boxMap;
  entityClip.handle = tempBoxModel(
    boxMap,
    into(s.boxMins, entity.r.mins),
    into(s.boxMaxs, entity.r.maxs)
  );
}

/**
 * `SV_SetBrushModel` (`sv_game.c:111-135`): make an entity one of the map's inline models, `*N`,
 * with its bounds, every content (as "we don't know exactly what is in the brushes"), and linked.
 *
 * @param cm - The map's clip map, or none for a map without one, where no `*N` is a model.
 * @param name - The entity's `model` key, or null for an entity without one.
 * @param link - `SV_LinkEntity`, which the server's own setting of a brush model ends with.
 * @throws in Q3's words for no name, a name that is not a brush model's, and a model the map has
 *   not got
 */
export function setBrushModel<T extends ClipEntity & { r: Pick<EntityShared, 'contents'> }>(
  cm: ClipMap | undefined,
  entity: T,
  name: string | null,
  link: (entity: T) => void
): void {
  if (name === null) throw new Error('SV_SetBrushModel: NULL');
  if (name[0] !== '*') throw new Error(`SV_SetBrushModel: ${name} isn't a brush model`);

  entity.s.modelindex = atoi(name.slice(1));
  const map = cm ?? boxMap;
  const handle = inlineModel(map, entity.s.modelindex);
  const s = boxScratch;
  modelBounds(map, handle, s.boxMins, s.boxMaxs);
  entity.r.mins = vec3(s.boxMins[0], s.boxMins[1], s.boxMins[2]);
  entity.r.maxs = vec3(s.boxMaxs[0], s.boxMaxs[1], s.boxMaxs[2]);
  entity.r.bmodel = true;
  entity.r.contents = -1;
  link(entity);
}

/**
 * `SV_ClipMoveToEntities`' exact clip of one entity (`sv_world.c:552-564`): a sweep through its
 * clip handle where it stands, a brush model turned by its angles and a box not.
 *
 * The result names no entity: which one it was is the caller's to say.
 *
 * @param cm - The map's clip map, or none for a map without one.
 * @param contentmask - `CONTENTS_*` the sweep stops at.
 */
export function traceEntity(
  cm: ClipMap | undefined,
  entity: ClipEntity,
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  contentmask: number
): TraceResult {
  clipHandleForEntity(cm, entity);
  const s = boxScratch;
  transformedBoxTrace(
    entityClip.cm,
    boxResults,
    into(s.start, start),
    into(s.end, end),
    into(s.mins, mins),
    into(s.maxs, maxs),
    entityClip.handle,
    contentmask,
    into(s.origin, entity.r.currentOrigin),
    entity.r.bmodel ? into(s.angles, entity.r.currentAngles) : VEC3_ORIGIN
  );
  return traceResult(boxResults, ENTITYNUM_NONE);
}

/**
 * `SV_PointContents`' ask of one entity (`sv_world.c:671-681`): a brush model's own brushes'
 * contents at the point, where it stands and turned, or `CONTENTS_BODY` inside a box entity or on
 * its faces, whatever either is made of.
 *
 * @param cm - The map's clip map, or none for a map without one.
 */
export function entityPointContents(
  cm: ClipMap | undefined,
  entity: ClipEntity,
  point: Vec3
): number {
  clipHandleForEntity(cm, entity);
  const s = boxScratch;
  return transformedPointContents(
    entityClip.cm,
    into(s.start, point),
    entityClip.handle,
    into(s.origin, entity.r.currentOrigin),
    entity.r.bmodel ? into(s.angles, entity.r.currentAngles) : VEC3_ORIGIN
  );
}

/**
 * `SV_EntityContact` (`sv_game.c:217-231`): whether a box in the world is in an entity at all, by
 * a zero-length trace of it through the entity's clip handle, every content counting and edges
 * too. A brush model's brushes are its shape, a box entity's bounds are its.
 *
 * @param cm - The map's clip map, or none for a map without one.
 * @param mins - The box's lower corner, in the world.
 * @param maxs - Its upper corner.
 */
export function entityContact(
  cm: ClipMap | undefined,
  entity: ClipEntity,
  mins: Vec3,
  maxs: Vec3
): boolean {
  clipHandleForEntity(cm, entity);
  const s = boxScratch;
  transformedBoxTrace(
    entityClip.cm,
    boxResults,
    VEC3_ORIGIN,
    VEC3_ORIGIN,
    into(s.mins, mins),
    into(s.maxs, maxs),
    entityClip.handle,
    -1,
    into(s.origin, entity.r.currentOrigin),
    into(s.angles, entity.r.currentAngles)
  );
  return boxResults.startsolid;
}

/**
 * `CM_TransformedBoxTrace` through `CM_TempBoxModel` (`cm_load.c:801-827`): a box swept through
 * an entity that is not a brush model, as `SV_ClipMoveToEntities` and `CG_ClipMoveToEntities`
 * sweep one (`sv_world.c:552-564`, `cg_predict.c:108-126`). The entity's box is made a brush of
 * six axial sides, `CONTENTS_BODY` whatever the entity is made of, at its origin and unturned, and
 * the sweep stops at it as at any brush of a map's.
 *
 * The result names no entity: which one it was is the caller's to say.
 *
 * @param start - Sweep start.
 * @param mins - The moving box's lower corner, about the sweep.
 * @param maxs - Its upper corner.
 * @param end - Sweep end.
 * @param boxMins - The box in the way's lower corner, about its origin.
 * @param boxMaxs - Its upper corner.
 * @param origin - Where the box in the way is.
 * @param contentmask - `CONTENTS_*` the sweep stops at. The box is `CONTENTS_BODY`, so a mask
 *   without that goes through it.
 */
export function traceTempBox(
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  boxMins: Vec3,
  boxMaxs: Vec3,
  origin: Vec3,
  contentmask: number
): TraceResult {
  const s = boxScratch;
  const handle = tempBoxModel(boxMap, into(s.boxMins, boxMins), into(s.boxMaxs, boxMaxs));
  transformedBoxTrace(
    boxMap,
    boxResults,
    into(s.start, start),
    into(s.end, end),
    into(s.mins, mins),
    into(s.maxs, maxs),
    handle,
    contentmask,
    into(s.origin, origin),
    VEC3_ORIGIN
  );
  return traceResult(boxResults, ENTITYNUM_NONE);
}

/**
 * `CM_TransformedPointContents` through `CM_TempBoxModel`: what a point is inside of an entity
 * that is not a brush model, as `SV_PointContents` asks of each (`sv_world.c:671-681`). That is
 * `CONTENTS_BODY` inside the box or on its faces, whatever the entity is made of, and 0 outside.
 *
 * @param point - Where to look.
 * @param boxMins - The box's lower corner, about its origin.
 * @param boxMaxs - Its upper corner.
 * @param origin - Where the box is.
 */
export function tempBoxPointContents(
  point: Vec3,
  boxMins: Vec3,
  boxMaxs: Vec3,
  origin: Vec3
): number {
  const s = boxScratch;
  const handle = tempBoxModel(boxMap, into(s.boxMins, boxMins), into(s.boxMaxs, boxMaxs));
  return transformedPointContents(
    boxMap,
    into(s.start, point),
    handle,
    into(s.origin, origin),
    VEC3_ORIGIN
  );
}

/** Collision's `trace_t` as the sim's result, which names what it stopped at as the caller says. */
function traceResult(results: Trace, entityNum: number): TraceResult {
  const { endpos, plane } = results;
  return {
    allsolid: results.allsolid,
    startsolid: results.startsolid,
    fraction: results.fraction,
    endpos: vec3(endpos[0], endpos[1], endpos[2]),
    normal: vec3(plane.normal[0], plane.normal[1], plane.normal[2]),
    contents: results.contents,
    surfaceFlags: results.surfaceFlags,
    entityNum
  };
}

/** A vector of zeros. */
function floats(): Floats {
  return [0, 0, 0];
}

/** Scratch of zeros. */
function clipScratch(): ClipScratch {
  return { start: floats(), end: floats(), mins: floats(), maxs: floats() };
}

/** A vector into a scratch array, which collision rounds to floats at its door. */
function into(out: Floats, v: Vec3): Floats {
  out[0] = v.x;
  out[1] = v.y;
  out[2] = v.z;
  return out;
}

/**
 * Keep a clip map's cvars at a store's values, each by its `integer` as collision reads it. The
 * store is asked again only once its count of changes has moved. A cvar the store has never been
 * given reads as `CM_LoadMap` registers it (`cm_load.c:584-586`).
 *
 * @param cm - The clip map, whose `cvars` are written.
 * @param store - The cvars.
 * @returns what brings the clip map up to the store, run before each use
 */
export function clipCvarsSync(cm: ClipMap, store: CvarStore): () => void {
  let seen = Number.NaN;
  const integer = (name: string, fallback: number) => {
    const value = store.get(name);
    return value === '' ? fallback : atoi(value);
  };
  return () => {
    const total = store.totalModifications();
    if (total === seen) return;
    seen = total;
    cm.cvars.noAreas = integer('cm_noAreas', 0);
    cm.cvars.noCurves = integer('cm_noCurves', 0);
    cm.cvars.playerCurveClip = integer('cm_playerCurveClip', 1);
  };
}
