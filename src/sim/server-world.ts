import { ENTITYNUM_NONE, MAX_GENTITIES } from '../net/protocol';
import { entityPointContents, traceEntity } from './clip-trace';
import { inlineModel, leafArea, leafCluster, modelBounds } from './cm/cm-load';
import type { ClipMap } from './cm/cm-local';
import {
  adjustAreaPortalState,
  areasConnected,
  boxLeafnums,
  clusterPVS,
  pointLeafnum
} from './cm/cm-test';
import { packSolid } from './entity-solid';
import type { GameEntity } from './game-entity';
import type { PointContentsFn, TraceFn, TraceResult } from './types';
import type { Vec3 } from './vec3';

/**
 * The server's world (`sv_world.c`): where each linked entity is filed, the areas and clusters it
 * is in, and the half of the server's trace and point contents that meets entities rather than
 * the map.
 *
 * Quake 3 carves the map's bounds into a tree of sectors and files each entity at the first
 * sector its box crosses, newest first, so a search walks a few lists rather than every slot. The
 * order it lists entities in is play: which of two blockers a door meets, the order of a blast's
 * deaths and of a frame's touches, and which of two flush movers a player stands on.
 *
 * It is the server's, and lives in the sim because a level running without a host keeps one of
 * its own and answers its traces, its portals and its sight through it, as the host answers the
 * game's.
 */

const f = Math.fround;

/** `AREA_DEPTH` (`sv_world.c:71`): the tree is four deep. */
const AREA_DEPTH = 4;
/** The sectors a tree that deep has, 16 of them leaves, of the 64 `AREA_NODES` Q3 keeps. */
const NUM_SECTORS = (2 << AREA_DEPTH) - 1;

/** `MAX_TOTAL_ENT_LEAFS` (`sv_world.c:204`): the leaves a link reads areas and clusters from. */
const MAX_TOTAL_ENT_LEAFS = 128;

/** `MAX_ENT_CLUSTERS` (`server.h:34`): the clusters an entity is filed in by number. */
export const MAX_ENT_CLUSTERS = 16;

/** None, as a sector or an entity in a list. */
const NONE = -1;

const AXES = ['x', 'y', 'z'] as const;

/** `worldSector_t` (`sv_world.c:64-69`). */
interface Sector {
  /** The axis it splits, 0 for x and 1 for y, or {@link NONE} for a leaf. */
  axis: number;
  /** Where it splits, in floats. */
  dist: number;
  /** `children[0]`, the sector past the split. */
  high: number;
  /** `children[1]`, the sector short of it. */
  low: number;
  /** The entity linked here last, which heads the list. */
  head: number;
}

/**
 * What the world is cleared over: the map, with the trace through it and the contents in it that
 * the server asks before any entity.
 */
export interface WorldMap {
  /** A BSP's collision, whose model 0 the sectors carve. Without one the map is Q3's of no name. */
  clipMap?: ClipMap;
  trace: TraceFn;
  pointContents: PointContentsFn;
}

/**
 * `RadiusFromBounds` (`q_math.c:699-711`): the distance from the origin to a box's furthest
 * corner, in floats.
 */
export function radiusFromBounds(mins: Vec3, maxs: Vec3): number {
  const x = Math.max(Math.abs(f(mins.x)), Math.abs(f(maxs.x)));
  const y = Math.max(Math.abs(f(mins.y)), Math.abs(f(maxs.y)));
  const z = Math.max(Math.abs(f(mins.z)), Math.abs(f(maxs.z)));
  return f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
}

/** A box's corner on a sector's axis: x for 0, y for 1. */
function onAxis(v: Vec3, axis: number): number {
  return axis === 0 ? v.x : v.y;
}

export class ServerWorld {
  private readonly entityAt: (number: number) => GameEntity;
  private readonly sectors: Sector[] = Array.from({ length: NUM_SECTORS }, () => ({
    axis: NONE,
    dist: 0,
    high: NONE,
    low: NONE,
    head: NONE
  }));
  private numSectors = 0;
  /** `svEntity_t.worldSector`: the sector each entity is listed in. */
  private readonly sectorOf = new Int32Array(MAX_GENTITIES).fill(NONE);
  /** `svEntity_t.nextEntityInWorldSector`: the entity after each in its sector's list. */
  private readonly nextInSector = new Int32Array(MAX_GENTITIES).fill(NONE);
  private map: WorldMap;

  /*
   * `svEntity_t`'s areas and clusters (`server.h:51-60`), by entity number: where each was last
   * linked, for the snapshot and the portals. An unlink leaves them as they were.
   */
  /** `areanum`: the first area an entity's box reaches, or −1 for none. */
  readonly areanum = new Int32Array(MAX_GENTITIES);
  /** `areanum2`: the last other area it reaches, or −1. */
  readonly areanum2 = new Int32Array(MAX_GENTITIES);
  /** `numClusters`: how many of an entity's {@link clusternums} there are. */
  readonly numClusters = new Int32Array(MAX_GENTITIES);
  /**
   * `clusternums`: each entity's clusters in its leaves' order, duplicates kept,
   * {@link MAX_ENT_CLUSTERS} from `number * MAX_ENT_CLUSTERS`.
   */
  readonly clusternums = new Int32Array(MAX_GENTITIES * MAX_ENT_CLUSTERS);
  /**
   * `lastCluster`: the cluster of the last leaf with one that an entity's box reaches, where its
   * clusters filled before its leaves ran out, and 0 otherwise.
   */
  readonly lastCluster = new Int32Array(MAX_GENTITIES);

  /** A link's leaves and the last of them with a cluster, kept between links. */
  private readonly leafs = new Int32Array(MAX_TOTAL_ENT_LEAFS);
  private readonly lastLeaf = { value: 0 };
  /** A link's box and a sight's point, as the `vec3_t`s collision takes. */
  private readonly leafMins = new Float32Array(3);
  private readonly leafMaxs = new Float32Array(3);
  private readonly point = new Float32Array(3);

  /** The box a search is for, `const vec3_t`s as the server takes them. */
  private readonly query = new Float32Array(6);
  /** The entities a trace or a point is tried against, kept between searches. */
  private readonly touch: number[] = [];
  private readonly boxMins = { x: 0, y: 0, z: 0 };
  private readonly boxMaxs = { x: 0, y: 0, z: 0 };

  /**
   * @param entityAt - The entity with a given number.
   * @param map - The map to clear the world over, as {@link clear} takes it.
   */
  constructor(entityAt: (number: number) => GameEntity, map: WorldMap) {
    this.entityAt = entityAt;
    this.map = map;
    this.clear(map);
  }

  /**
   * `SV_ClearWorld` (`sv_world.c:147-158`): a new map's sectors, over its model 0, with nothing
   * linked in them, and every entity's areas and clusters zeroed, as a map load's `SV_ClearServer`
   * zeroes `svEntity_t`.
   *
   * Each sector halves the longer of x and y, y on a tie, at its midpoint in floats. A map without
   * a clip map is Q3's map of no name, whose one model is a point at the origin, so every sector
   * splits y at 0.
   */
  clear(map: WorldMap): void {
    this.map = map;
    this.sectorOf.fill(NONE);
    this.nextInSector.fill(NONE);
    this.areanum.fill(0);
    this.areanum2.fill(0);
    this.numClusters.fill(0);
    this.clusternums.fill(0);
    this.lastCluster.fill(0);
    this.numSectors = 0;
    const mins = [0, 0, 0];
    const maxs = [0, 0, 0];
    if (map.clipMap) modelBounds(map.clipMap, inlineModel(map.clipMap, 0), mins, maxs);
    this.createSector(0, mins, maxs);
  }

  /** `SV_CreateworldSector` (`sv_world.c:106-139`): a sector and those under it, high first. */
  private createSector(depth: number, mins: number[], maxs: number[]): number {
    const index = this.numSectors++;
    const sector = this.sectors[index];
    sector.head = NONE;
    if (depth === AREA_DEPTH) {
      sector.axis = NONE;
      sector.high = sector.low = NONE;
      return index;
    }

    const axis = f(maxs[0] - mins[0]) > f(maxs[1] - mins[1]) ? 0 : 1;
    sector.axis = axis;
    sector.dist = f(f(maxs[axis] + mins[axis]) * 0.5);
    const above = [...mins];
    const below = [...maxs];
    above[axis] = below[axis] = sector.dist;
    sector.high = this.createSector(depth + 1, above, maxs);
    sector.low = this.createSector(depth + 1, mins, below);
    return index;
  }

  /**
   * `SV_LinkEntity` (`sv_world.c:205-355`): file an entity where its box is, in the areas and
   * clusters of the leaves it reaches and at the head of its sector's list, out of wherever it was
   * before.
   *
   * Its box packs into `s.solid` for the clients. In the world it is its bounds about its origin,
   * or, for a brush model turned at all, a cube of its radius about its origin, which holds it
   * however it turns. Either is padded a unit each way, "because movement is clipped an epsilon
   * away from an actual edge", all in floats.
   *
   * A box that reaches no leaf is left out of the world, its link uncounted; no map's does.
   */
  link(entity: GameEntity): void {
    const number = this.slot(entity);
    // "Unlink from old position."
    if (this.sectorOf[number] !== NONE) this.unlink(entity);

    const { r } = entity;
    entity.s.solid = packSolid(r);

    const origin = r.currentOrigin;
    const angles = r.currentAngles;
    const { absmin, absmax } = r;
    if (r.bmodel && (f(angles.x) !== 0 || f(angles.y) !== 0 || f(angles.z) !== 0)) {
      // "Expand for rotation."
      const max = radiusFromBounds(r.mins, r.maxs);
      absmin.x = f(f(origin.x) - max);
      absmin.y = f(f(origin.y) - max);
      absmin.z = f(f(origin.z) - max);
      absmax.x = f(f(origin.x) + max);
      absmax.y = f(f(origin.y) + max);
      absmax.z = f(f(origin.z) + max);
    } else {
      absmin.x = f(f(origin.x) + f(r.mins.x));
      absmin.y = f(f(origin.y) + f(r.mins.y));
      absmin.z = f(f(origin.z) + f(r.mins.z));
      absmax.x = f(f(origin.x) + f(r.maxs.x));
      absmax.y = f(f(origin.y) + f(r.maxs.y));
      absmax.z = f(f(origin.z) + f(r.maxs.z));
    }
    absmin.x = f(absmin.x - 1);
    absmin.y = f(absmin.y - 1);
    absmin.z = f(absmin.z - 1);
    absmax.x = f(absmax.x + 1);
    absmax.y = f(absmax.y + 1);
    absmax.z = f(absmax.z + 1);

    // "If none of the leafs were inside the map, the entity is outside the world and can be
    // considered unlinked."
    if (!this.linkLeafs(number, absmin, absmax)) return;

    r.linkcount++;

    // "Find the first world sector node that the ent's box crosses": a box touching a split stays
    // above it.
    let node = 0;
    for (;;) {
      const { axis, dist, high, low } = this.sectors[node];
      if (axis === NONE) break;
      if (onAxis(absmin, axis) > dist) node = high;
      else if (onAxis(absmax, axis) < dist) node = low;
      else break;
    }

    this.sectorOf[number] = node;
    this.nextInSector[number] = this.sectors[node].head;
    this.sectors[node].head = number;
    r.linked = true;
  }

  /**
   * `SV_LinkEntity`'s leaves (`sv_world.c:281-331`): the areas and clusters of the leaves a linked
   * box reaches, solid ones included, the first {@link MAX_TOTAL_ENT_LEAFS} of them.
   *
   * The first area met is `areanum` and the last other one `areanum2`, so a box in three keeps the
   * first and the last; Q3's print of it is `developer`'s. The clusters are kept in the leaves'
   * order to {@link MAX_ENT_CLUSTERS}, and when they fill before the leaves run out, `lastCluster`
   * is the last leaf's with a cluster, stored or not. A world without a clip map is one area and
   * one cluster, 0 each, which everything is in.
   *
   * @returns Whether the box reached a leaf
   */
  private linkLeafs(number: number, absmin: Vec3, absmax: Vec3): boolean {
    this.numClusters[number] = 0;
    this.lastCluster[number] = 0;
    this.areanum[number] = -1;
    this.areanum2[number] = -1;

    const cm = this.map.clipMap;
    if (!cm) {
      this.areanum[number] = 0;
      this.clusternums[number * MAX_ENT_CLUSTERS] = 0;
      this.numClusters[number] = 1;
      return true;
    }

    const mins = this.leafMins;
    const maxs = this.leafMaxs;
    mins[0] = absmin.x;
    mins[1] = absmin.y;
    mins[2] = absmin.z;
    maxs[0] = absmax.x;
    maxs[1] = absmax.y;
    maxs[2] = absmax.z;
    const { leafs } = this;
    const numLeafs = boxLeafnums(cm, mins, maxs, leafs, MAX_TOTAL_ENT_LEAFS, this.lastLeaf);
    if (!numLeafs) return false;

    // "Set areas, even from clusters that don't fit in the entity array."
    for (let i = 0; i < numLeafs; i++) {
      const area = leafArea(cm, leafs[i]);
      if (area === -1) continue;
      if (this.areanum[number] !== -1 && this.areanum[number] !== area) {
        this.areanum2[number] = area;
      } else {
        this.areanum[number] = area;
      }
    }

    // "Store as many explicit clusters as we can."
    const first = number * MAX_ENT_CLUSTERS;
    let count = 0;
    let i = 0;
    for (; i < numLeafs; i++) {
      const cluster = leafCluster(cm, leafs[i]);
      if (cluster !== -1) {
        this.clusternums[first + count++] = cluster;
        if (count === MAX_ENT_CLUSTERS) break;
      }
    }
    this.numClusters[number] = count;

    // "Store off a last cluster if we need to."
    if (i !== numLeafs) this.lastCluster[number] = leafCluster(cm, this.lastLeaf.value);
    return true;
  }

  /** `SV_UnlinkEntity` (`sv_world.c:167-195`): take an entity out of its sector's list. */
  unlink(entity: GameEntity): void {
    const number = this.slot(entity);
    entity.r.linked = false;

    const sector = this.sectorOf[number];
    // "Not linked in anywhere."
    if (sector === NONE) return;
    this.sectorOf[number] = NONE;

    const ws = this.sectors[sector];
    if (ws.head === number) {
      ws.head = this.nextInSector[number];
      return;
    }
    for (let scan = ws.head; scan !== NONE; scan = this.nextInSector[scan]) {
      if (this.nextInSector[scan] === number) {
        this.nextInSector[scan] = this.nextInSector[number];
        return;
      }
    }
  }

  /**
   * `SV_AreaEntities` (`sv_world.c:381-438`): the number of every linked entity whose box touches
   * this one, edges included, in the sectors' order: each sector's list, newest link first, then
   * the sectors past its split and then those short of it. A box ending exactly on a split does
   * not cross it.
   *
   * @param mins - The box's lower corner, in the world.
   * @param maxs - Its upper corner.
   */
  areaEntities(mins: Vec3, maxs: Vec3): number[] {
    this.collect(mins, maxs);
    return [...this.touch];
  }

  /** {@link areaEntities} into {@link touch}. Q3's count is its caller's, never reached. */
  private collect(mins: Vec3, maxs: Vec3): void {
    const q = this.query;
    q[0] = mins.x;
    q[1] = mins.y;
    q[2] = mins.z;
    q[3] = maxs.x;
    q[4] = maxs.y;
    q[5] = maxs.z;
    this.touch.length = 0;
    this.walk(0);
  }

  /** `SV_AreaEntities_r` (`sv_world.c:381-419`). */
  private walk(node: number): void {
    const q = this.query;
    const { axis, dist, high, low, head } = this.sectors[node];
    for (let check = head; check !== NONE; check = this.nextInSector[check]) {
      const { absmin, absmax } = this.entityAt(check).r;
      if (
        absmin.x > q[3] ||
        absmin.y > q[4] ||
        absmin.z > q[5] ||
        absmax.x < q[0] ||
        absmax.y < q[1] ||
        absmax.z < q[2]
      ) {
        continue;
      }
      this.touch.push(check);
    }

    // "Terminal node."
    if (axis === NONE) return;
    // "Recurse down both sides."
    if (q[3 + axis] > dist) this.walk(high);
    if (q[axis] < dist) this.walk(low);
  }

  /**
   * `SV_Trace` (`sv_world.c:596-644`): the map's collision, then every entity in the way.
   *
   * The map answers first, naming the world as what it hit, and a sweep the map stops at once is
   * over. Otherwise every entity near the whole sweep is tried against the whole sweep, not just
   * the part the map left, and the nearest stop of all wins.
   */
  trace(
    start: Vec3,
    mins: Vec3,
    maxs: Vec3,
    end: Vec3,
    passEntityNum: number,
    contentmask: number
  ): TraceResult {
    const world = this.map.trace(start, mins, maxs, end, passEntityNum, contentmask);
    // "Blocked immediately by the world."
    if (world.fraction === 0) return world;
    return this.clipMoveToEntities(world, start, mins, maxs, end, passEntityNum, contentmask);
  }

  /**
   * `SV_ClipMoveToEntities` (`sv_world.c:506-585`): try the sweep against each entity whose box
   * the sweep's own box touches, and keep the nearest stop.
   *
   * An entity is passed over when it is the pass entity, when the pass entity owns it, or when
   * the pass entity's owner owns it too — so a rocket misses the player who fired it and every
   * other rocket they fired. Then when it is made of nothing the mask names. What is left is swept
   * through by its clip handle: a brush model's brushes, turned as it is, or a box.
   *
   * A sweep that starts in an entity and gets out is not stopped by it; it only says so, by
   * `startsolid`. One that never gets out is `allsolid`, and ends the search. Of two stops at the
   * same fraction the entity listed first is named, and the world over any entity.
   *
   * @param clip - What the map answered.
   */
  private clipMoveToEntities(
    clip: TraceResult,
    start: Vec3,
    mins: Vec3,
    maxs: Vec3,
    end: Vec3,
    passEntityNum: number,
    contentmask: number
  ): TraceResult {
    // "The bounding box of the entire move", a unit bigger each way, in floats
    // (`sv_world.c:630-638`).
    const boxmins = this.boxMins;
    const boxmaxs = this.boxMaxs;
    for (const axis of AXES) {
      const from = f(start[axis]);
      const to = f(end[axis]);
      const forward = to > from;
      boxmins[axis] = f(f((forward ? from : to) + f(mins[axis])) - 1);
      boxmaxs[axis] = f(f((forward ? to : from) + f(maxs[axis])) + 1);
    }
    this.collect(boxmins, boxmaxs);

    let passOwnerNum = -1;
    if (passEntityNum !== ENTITYNUM_NONE) {
      const owner = this.entityAt(passEntityNum).r.ownerNum;
      if (owner !== ENTITYNUM_NONE) passOwnerNum = owner;
    }

    let result = clip;
    for (const number of this.touch) {
      if (result.allsolid) return result;
      const touch = this.entityAt(number);

      if (passEntityNum !== ENTITYNUM_NONE) {
        if (number === passEntityNum) continue; // "don't clip against the pass entity"
        if (touch.r.ownerNum === passEntityNum) continue; // "don't clip against own missiles"
        // "Don't clip against other missiles from our owner."
        if (touch.r.ownerNum === passOwnerNum) continue;
      }
      if (!(contentmask & touch.r.contents)) continue;

      const trace = traceEntity(this.map.clipMap, touch, start, mins, maxs, end, contentmask);

      if (trace.allsolid) {
        result.allsolid = true;
        trace.entityNum = touch.s.number;
      } else if (trace.startsolid) {
        result.startsolid = true;
        trace.entityNum = touch.s.number;
      }

      if (trace.fraction < result.fraction) {
        // "Make sure we keep a startsolid from a previous trace."
        const oldStart = result.startsolid;
        trace.entityNum = touch.s.number;
        result = trace;
        result.startsolid ||= oldStart;
      }
    }
    return result;
  }

  /**
   * `SV_PointContents` (`sv_world.c:653-685`): what the map holds at a point, OR'd with every
   * entity whose box holds it but the pass entity.
   *
   * Each entity is asked by its clip handle, whatever its own contents say: a brush model by its
   * brushes, where it stands and turned, so a point in a trigger's reads them, `CONTENTS_SOLID` as
   * q3map makes them; and a player or an item as a box, `CONTENTS_BODY`.
   */
  pointContents(point: Vec3, passEntityNum: number): number {
    let contents = this.map.pointContents(point, passEntityNum);
    this.collect(point, point);
    for (const number of this.touch) {
      if (number === passEntityNum) continue;
      contents |= entityPointContents(this.map.clipMap, this.entityAt(number), point);
    }
    return contents;
  }

  /**
   * `SV_AdjustAreaPortalState` (`sv_game.c:201-209`): open or close the portal between the two
   * areas an entity was last linked across, counted in the clip map, so two doors over one portal
   * keep it open until both close. One linked in a single area stands in no portal, and a world
   * without a clip map has none.
   *
   * @throws in Q3's words for a portal closed more often than opened
   */
  adjustAreaPortalState(entity: GameEntity, open: boolean): void {
    const number = this.slot(entity);
    if (this.areanum2[number] === -1) return;
    const cm = this.map.clipMap;
    if (cm) adjustAreaPortalState(cm, this.areanum[number], this.areanum2[number], open);
  }

  /**
   * `SV_inPVS` (`sv_game.c:146-166`): whether `p2` is in a cluster `p1`'s can see, and in an area
   * the open portals join to `p1`'s, which "checks portalareas so that doors block sight".
   *
   * A `p1` in solid is in no cluster, and reads the first cluster's row. A `p2` in solid is in
   * none either, and its bit is read from the byte before the row, which decides only under
   * `cm_noAreas`, as no area is joined to −1. Before the first row that byte is no map's, and
   * the port reads it as 0. A world without a clip map is one cluster and one area, so each point
   * sees every other.
   */
  inPVS(p1: Vec3, p2: Vec3): boolean {
    const cm = this.map.clipMap;
    if (!cm) return true;

    const { point } = this;
    point[0] = p1.x;
    point[1] = p1.y;
    point[2] = p1.z;
    let leafnum = pointLeafnum(cm, point);
    let cluster = leafCluster(cm, leafnum);
    const area1 = leafArea(cm, leafnum);
    const mask = clusterPVS(cm, cluster);

    point[0] = p2.x;
    point[1] = p2.y;
    point[2] = p2.z;
    leafnum = pointLeafnum(cm, point);
    cluster = leafCluster(cm, leafnum);
    const area2 = leafArea(cm, leafnum);
    const at = mask + (cluster >> 3);
    const bits = at < 0 ? 0 : cm.visibility[at];
    if (!(bits & (1 << (cluster & 7)))) return false;
    // "A door blocks sight."
    return areasConnected(cm, area1, area2);
  }

  /** `SV_SvEntityForGentity` (`sv_game.c:56-61`): an entity's slot in the world, by its number. */
  private slot(entity: GameEntity): number {
    const { number } = entity.s;
    if (number < 0 || number >= MAX_GENTITIES) {
      throw new Error('SV_SvEntityForGentity: bad gEnt');
    }
    return number;
  }
}
