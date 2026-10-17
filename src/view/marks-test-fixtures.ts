import type { Bsp } from '../formats/bsp';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { newTrace, type ClipMap } from '../sim/cm/cm-local';
import { boxTrace } from '../sim/cm/cm-trace';
import { angleVectors, f } from '../sim/cm/q-math';
import { MASK } from '../sim/constants';
import { byteToDir, dirToByte } from '../sim/dir-byte';
import { vec3 } from '../sim/vec3';
import { Marks, type MarkScene } from './marks';
import { ScenePolys } from './scene-polys';
import type { PatchGrid } from './world-curves';
import { WorldMarks } from './world-marks';
import type { WorldShaders } from './world-shaders';

/**
 * The marks' corpus over a map: seeded impacts and shadows found by the map's own traces, made and
 * added frame by frame as the twin of ioquake3's own `tr_marks.c`, `RE_AddPolyToScene` and
 * `cg_marks.c` makes them, every fragment and every frame's polys digested as the twin digests
 * them. The twin reads the events this writes ({@link markInputs}) and traces nothing.
 */

/** The corpus's frames. */
const STEPS = 200;

/** Every so many frames, one crowded with shadows, some of them wide, to reach the scene's caps. */
const CROWDED = 10;

/** What an event does, as the twin numbers it. */
export const EVENT = { impact: 0, frame: 1, shadow: 2, add: 3 } as const;

/** The marks' shaders' handles, as the twin numbers them. */
export const MARK = { bullet: 1, burn: 2, hole: 3, energy: 4, shadow: 5, blood: 6 } as const;

/** `CG_MissileHitWall`'s marks, weapon by weapon: a shader and a radius (`cg_weapons.c:1768`). */
const WEAPON_MARKS: readonly (readonly [number, number])[] = [
  [MARK.burn, 64], // the grenade launcher's
  [MARK.burn, 64], // the rocket launcher's
  [MARK.energy, 24], // the railgun's, tinted
  [MARK.energy, 16], // the plasma gun's
  [MARK.burn, 32], // the BFG's
  [MARK.bullet, 4], // the shotgun's
  [MARK.bullet, 8], // the machinegun's
  [MARK.hole, 12] // the lightning gun's, and the hook's
];

/** One step of the corpus, as the twin reads it: four ints, then twelve floats. */
export interface MarkEvent {
  type: number;
  time: number;
  shader: number;
  /** 1: the mark fades its alpha; 2: `r_marksOnTriangleMeshes` for its cut. */
  flags: number;
  origin: [number, number, number];
  dir: [number, number, number];
  orientation: number;
  radius: number;
  color: [number, number, number, number];
}

/** A map's corpus: what its impacts cut and its frames added, and their digests. */
export interface MarksCorpus {
  impacts: number;
  fragments: number;
  points: number;
  /** Impacts that cut 128 fragments, and walks that listed 64 surfaces. */
  full: number;
  listed64: number;
  polys: number;
  dropped: number;
  fragmentDigest: string;
  polyDigest: string;
}

/** The twin's `pick`: a number below `n`, from the high bits. */
function pick(random: Seeded, n: number): number {
  return (random.next() >>> 8) % n;
}

/**
 * A map's events: each step's impacts traced from seeded points along seeded directions, as a
 * missile's or a gib's, then a frame with seeded shadows under seeded points above the floor, and
 * the frame's marks added.
 */
export function markEvents(bsp: Bsp, cm: ClipMap): MarkEvent[] {
  const random = new Seeded(41);
  const { mins, maxs } = bsp.models[0];
  const point = () =>
    [0, 1, 2].map((a) => {
      const span = Math.trunc(f(maxs[a] - mins[a])) + 1;
      return f(mins[a] + pick(random, span * 256) / 256);
    }) as [number, number, number];
  const trace = newTrace();
  const forward = [0, 0, 0];
  const events: MarkEvent[] = [];
  const event = (type: number, time: number): MarkEvent => ({
    type,
    time,
    shader: 0,
    flags: 0,
    origin: [0, 0, 0],
    dir: [0, 0, 0],
    orientation: 0,
    radius: 0,
    color: [0, 0, 0, 0]
  });
  let time = 1000;
  for (let step = 0; step < STEPS; step++) {
    time += 50 + pick(random, 400);
    const impacts = pick(random, 6);
    for (let i = 0; i < impacts; i++) {
      const start = point();
      const angles = [pick(random, 180 * 256) / 256 - 90, pick(random, 360 * 256) / 256, 0];
      const blood = pick(random, 4) === 3;
      const [shader, weaponRadius] = WEAPON_MARKS[pick(random, WEAPON_MARKS.length)];
      const big = pick(random, 8) === 0;
      const bigRadius = 256 + pick(random, 768);
      const bloodRadius = 16 + pick(random, 32);
      const orientation = pick(random, 360 * 256) / 256;
      const tint = [0, 1, 2].map(() => f(pick(random, 256) / 255));
      const flags = pick(random, 5) === 0 ? 2 : 0;
      angleVectors(angles, forward, null, null);
      const end = start.map((s, a) => f(s + f(forward[a] * 8192)));
      boxTrace(cm, trace, start, end, null, null, 0, MASK.SHOT);
      if (trace.allsolid || trace.startsolid || trace.fraction === 1) continue;
      const hit = event(EVENT.impact, time);
      const { endpos, plane } = trace;
      if (blood) {
        hit.shader = MARK.blood;
        hit.radius = bloodRadius;
        hit.flags = flags | 1;
        hit.origin = [endpos[0], endpos[1], endpos[2]];
        hit.dir = [plane.normal[0], plane.normal[1], plane.normal[2]];
        hit.color = [1, 1, 1, 1];
      } else {
        // As the game snaps an impact towards its start, and sends its normal as a byte.
        hit.shader = shader;
        hit.radius = big ? bigRadius : weaponRadius;
        hit.flags = flags | (shader === MARK.energy ? 1 : 0);
        hit.origin = [0, 1, 2].map((a) =>
          start[a] <= endpos[a] ? Math.floor(endpos[a]) : Math.ceil(endpos[a])
        ) as [number, number, number];
        const dir = byteToDir(dirToByte(vec3(plane.normal[0], plane.normal[1], plane.normal[2])));
        hit.dir = [f(dir.x), f(dir.y), f(dir.z)];
        hit.color = weaponRadius === 24 ? [tint[0], tint[1], tint[2], 1] : [1, 1, 1, 1];
      }
      hit.orientation = f(orientation);
      events.push(hit);
    }

    events.push(event(EVENT.frame, time));
    const shadows = step % CROWDED === CROWDED - 1 ? 24 : pick(random, 3);
    for (let i = 0; i < shadows; i++) {
      const start = point();
      const height = 1 + pick(random, 160);
      const yaw = pick(random, 360 * 256) / 256;
      const flags = pick(random, 5) === 0 ? 2 : 0;
      const wide = pick(random, 4) === 0 ? 64 + pick(random, 448) : 24;
      const floor = [start[0], start[1], f(start[2] - 8192)];
      boxTrace(cm, trace, start, floor, null, null, 0, MASK.PLAYERSOLID);
      if (trace.allsolid || trace.startsolid || trace.fraction === 1) continue;
      const above = [trace.endpos[0], trace.endpos[1], f(trace.endpos[2] + height)];
      const below = [above[0], above[1], f(above[2] - 128)];
      boxTrace(cm, trace, above, below, [-15, -15, 0], [15, 15, 2], 0, MASK.PLAYERSOLID);
      if (trace.fraction === 1 || trace.startsolid || trace.allsolid) continue;
      const alpha = f(1 - trace.fraction);
      const shadow = event(EVENT.shadow, time);
      shadow.shader = MARK.shadow;
      shadow.flags = flags;
      shadow.origin = [trace.endpos[0], trace.endpos[1], trace.endpos[2]];
      shadow.dir = [trace.plane.normal[0], trace.plane.normal[1], trace.plane.normal[2]];
      shadow.orientation = f(yaw);
      shadow.radius = wide;
      shadow.color = [alpha, alpha, alpha, 1];
      events.push(shadow);
    }
    events.push(event(EVENT.add, time));
  }
  return events;
}

/** Each surface's marks flags as the twin reads them: 1 `noimpact`, 2 `nomarks`, 4 `fog`. */
function surfaceFlags(
  shaders: Pick<WorldShaders, 'shaders' | 'surfaceShaders'>,
  s: number
): number {
  const parms = shaders.shaders[shaders.surfaceShaders[s]]?.script?.surfaceParms ?? [];
  return (
    (parms.includes('noimpact') ? 1 : 0) |
    (parms.includes('nomarks') ? 2 : 0) |
    (parms.includes('fog') ? 4 : 0)
  );
}

/** The twin's `marks/<map>.bin`: the surfaces' flags, then the events. */
export function markInputs(
  bsp: Bsp,
  shaders: Pick<WorldShaders, 'shaders' | 'surfaceShaders'>,
  events: readonly MarkEvent[]
): Uint8Array {
  const n = bsp.surfaces.length;
  const bytes = new Uint8Array(4 + n + 4 + events.length * 64);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, n, true);
  for (let s = 0; s < n; s++) bytes[4 + s] = surfaceFlags(shaders, s);
  let at = 4 + n;
  view.setInt32(at, events.length, true);
  at += 4;
  for (const e of events) {
    for (const value of [e.type, e.time, e.shader, e.flags]) {
      view.setInt32(at, value, true);
      at += 4;
    }
    for (const value of [...e.origin, ...e.dir, e.orientation, e.radius, ...e.color]) {
      view.setFloat32(at, value, true);
      at += 4;
    }
  }
  return bytes;
}

/**
 * A map's marks corpus: its events made and added as the twin's main loop makes them.
 *
 * @param grids - Each surface's curve, as the map's load made it.
 */
export function marksCorpus(
  bsp: Bsp,
  shaders: Pick<WorldShaders, 'shaders' | 'surfaceShaders' | 'fogs'>,
  grids: readonly (PatchGrid | null)[],
  events: readonly MarkEvent[]
): MarksCorpus {
  const world = new WorldMarks(bsp, shaders, grids);
  const polys = new ScenePolys<number>(() => {});
  polys.inWorld(shaders.fogs);
  const fragmentDigest = new Digest();
  const polyDigest = new Digest();
  const corpus = { impacts: 0, fragments: 0, points: 0, full: 0, listed64: 0 };
  const counts = { polys: 0, dropped: 0 };
  const scene: MarkScene<number> = {
    markFragments(numPoints, points, projection, maxPoints, pointBuffer, maxFragments, buffer) {
      const n = world.markFragments(
        numPoints,
        points,
        projection,
        maxPoints,
        pointBuffer,
        maxFragments,
        buffer
      );
      fragmentDigest.int(world.listed).int(n);
      for (let i = 0; i < n; i++) {
        const [first, count] = [buffer[i * 2], buffer[i * 2 + 1]];
        fragmentDigest.int(first).int(count);
        for (let j = 0; j < count * 3; j++) fragmentDigest.float(pointBuffer[first * 3 + j]);
        corpus.points += count;
      }
      corpus.impacts++;
      corpus.fragments += n;
      if (n === maxFragments) corpus.full++;
      if (world.listed === 64) corpus.listed64++;
      return n;
    },
    addPoly: (shader, numVerts, verts, first) => polys.add(shader, numVerts, verts, first)
  };
  const marks = new Marks<number>(scene, MARK.energy);
  for (const e of events) {
    world.onTriangleMeshes = (e.flags & 2) !== 0;
    switch (e.type) {
      case EVENT.frame:
        polys.begin();
        break;
      case EVENT.impact:
      case EVENT.shadow: {
        const [red, green, blue, alpha] = e.color;
        const alphaFade = (e.flags & 1) !== 0;
        const temporary = e.type === EVENT.shadow;
        const { shader, origin, dir, orientation, radius, time } = e;
        marks.impactMark(
          shader,
          origin,
          dir,
          orientation,
          red,
          green,
          blue,
          alpha,
          alphaFade,
          radius,
          temporary,
          time
        );
        break;
      }
      case EVENT.add: {
        marks.addMarks(e.time);
        polyDigest.int(polys.count).int(polys.dropped);
        const { xyz, st, modulate } = polys.verts;
        for (let i = 0; i < polys.count; i++) {
          polyDigest.int(polys.shaders[i]!).int(polys.sizes[i]).int(polys.fogs[i]);
          for (let j = polys.firsts[i]; j < polys.firsts[i] + polys.sizes[i]; j++) {
            polyDigest.float(xyz[j * 3]).float(xyz[j * 3 + 1]).float(xyz[j * 3 + 2]);
            polyDigest.float(st[j * 2]).float(st[j * 2 + 1]).uint8s(modulate, j * 4, 4);
          }
        }
        counts.polys += polys.count;
        counts.dropped += polys.dropped;
        break;
      }
    }
  }
  return {
    ...corpus,
    ...counts,
    fragmentDigest: fragmentDigest.hex(),
    polyDigest: polyDigest.hex()
  };
}
