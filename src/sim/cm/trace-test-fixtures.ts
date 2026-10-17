import { CONTENTS, MASK } from '../constants';
import { newTrace, type ClipMap, type Trace } from './cm-local';
import { leafArea, leafCluster, tempBoxModel } from './cm-load';
import { boxTrace, transformedBoxTrace } from './cm-trace';
import {
  adjustAreaPortalState,
  areasConnected,
  boxLeafnums,
  clusterPVS,
  pointContents,
  pointLeafnum,
  transformedPointContents,
  writeAreaBits
} from './cm-test';
import { Digest, Seeded } from './collision-test-fixtures';
import { vec3f, type Vec3f } from './q-math';

/**
 * Collision's corpus: seeded traces, contents, leaves and areas over a map, the same draws the
 * twin's `corpus` mode makes over ioquake3's own `cm_*.c`, each kind digested as the twin digests
 * it. Every value is made in floats as the twin's C makes it, so both sides trace the same bits.
 */

const f = Math.fround;

/** A kind's count of what it digested, and its digest, as the twin prints them. */
export interface CorpusKind {
  count: number;
  digest: string;
}

/** The masks a trace draws from: Q3's, and the contents nothing solid has. */
const MASKS = [
  MASK.PLAYERSOLID,
  MASK.SHOT,
  MASK.SOLID,
  MASK.WATER,
  MASK.ALL,
  MASK.DEADSOLID,
  MASK.OPAQUE,
  CONTENTS.NODROP | CONTENTS.TRIGGER | CONTENTS.FOG
];

const PLAYER_MINS: Vec3f = [-15, -15, -24];
const PLAYER_MAXS: Vec3f = [15, 15, 32];
const CROUCH_MAXS: Vec3f = [15, 15, 16];

/** A number at the start of `text`, as `strtod` reads one, with what it took. */
const NUMBER = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

/** Every entity's `origin`, as the twin's `parseOrigins` reads them with `strtod`. */
function parseOrigins(text: string): Vec3f[] {
  const key = '"origin" "';
  const origins: Vec3f[] = [];
  let at = text.indexOf(key);
  while (origins.length < 1024 && at >= 0) {
    let rest = text.slice(at + key.length);
    const origin: number[] = [];
    for (let i = 0; i < 3; i++) {
      const match = NUMBER.exec(rest);
      if (!match) break;
      origin.push(f(Number(match[0])));
      rest = rest.slice(match[0].length);
    }
    if (origin.length === 3) origins.push(origin as Vec3f);
    at = text.indexOf(key, at + key.length);
  }
  return origins;
}

/** One kind's run: the clip map, its seeded draws, and what it digests into. */
class Run {
  readonly digest = new Digest();
  count = 0;
  readonly cm: ClipMap;
  readonly random: Seeded;
  readonly origins: Vec3f[];
  private readonly trace = newTrace();

  constructor(cm: ClipMap, random: Seeded, origins: Vec3f[]) {
    this.cm = cm;
    this.random = random;
    this.origins = origins;
  }

  /** The twin's `pick`: a number below `n`, from the high bits, as an LCG's low bits cycle. */
  pick(n: number): number {
    return (this.random.next() >>> 8) % n;
  }

  /** The twin's `uniformIn`: a float from `lo` to `hi`, a 65536th of the way at a time. */
  uniformIn(lo: number, hi: number): number {
    const t = ((this.random.next() >>> 8) % 65536) / 65536;
    return f(lo + f(f(hi - lo) * t));
  }

  randomIn(mins: ArrayLike<number>, maxs: ArrayLike<number>): Vec3f {
    const x = this.uniformIn(mins[0], maxs[0]);
    const y = this.uniformIn(mins[1], maxs[1]);
    const z = this.uniformIn(mins[2], maxs[2]);
    return [x, y, z];
  }

  /** The twin's `randomPoint`: near an entity three times in four, else anywhere in the world. */
  randomPoint(): Vec3f {
    if (this.pick(4) !== 0 && this.origins.length) {
      const o = this.origins[this.pick(this.origins.length)];
      return add(o, this.random.vec(48 * 256));
    }
    return this.randomIn(this.cm.cmodels[0].mins, this.cm.cmodels[0].maxs);
  }

  /** The twin's `randomBox`: none, a player's, a crouching player's, or one of its own. */
  randomBox(): [Vec3f, Vec3f] | null {
    const kind = this.pick(4);
    if (kind === 0) return null;
    if (kind === 1 || kind === 2) return [PLAYER_MINS, kind === 1 ? PLAYER_MAXS : CROUCH_MAXS];
    const mins = vec3f();
    const maxs = vec3f();
    for (let i = 0; i < 3; i++) mins[i] = -((this.random.next() >>> 8) % 384) / 8;
    for (let i = 0; i < 3; i++) maxs[i] = ((this.random.next() >>> 8) % 384) / 8;
    return [mins, maxs];
  }

  randomAngles(): Vec3f {
    return this.random.vec(360 * 256);
  }

  mask(): number {
    return MASKS[this.pick(8)];
  }

  boxTrace(start: Vec3f, end: Vec3f, box: [Vec3f, Vec3f] | null, model: number, mask: number) {
    boxTrace(this.cm, this.trace, start, end, box?.[0] ?? null, box?.[1] ?? null, model, mask);
    this.digestTrace(this.trace);
  }

  transformedBoxTrace(
    start: Vec3f,
    end: Vec3f,
    box: [Vec3f, Vec3f] | null,
    model: number,
    mask: number,
    origin: Vec3f,
    angles: Vec3f
  ) {
    transformedBoxTrace(
      this.cm,
      this.trace,
      start,
      end,
      box?.[0] ?? null,
      box?.[1] ?? null,
      model,
      mask,
      origin,
      angles
    );
    this.digestTrace(this.trace);
  }

  /** The twin's `digestTrace`: every field of the result, in `trace_t`'s order. */
  digestTrace(t: Trace): void {
    this.count++;
    const d = this.digest;
    d.int(t.allsolid ? 1 : 0).int(t.startsolid ? 1 : 0);
    d.float(t.fraction);
    for (const v of t.endpos) d.float(v);
    for (const v of t.plane.normal) d.float(v);
    d.float(t.plane.dist).int(t.plane.type).int(t.plane.signbits);
    d.int(t.surfaceFlags).int(t.contents).int(t.entityNum);
  }
}

/** `a + b`, in floats. */
function add(a: ArrayLike<number>, b: ArrayLike<number>): Vec3f {
  return [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])];
}

/** `a − b`, in floats. */
function sub(a: ArrayLike<number>, b: ArrayLike<number>): Vec3f {
  return [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
}

function corpusWorld(run: Run): void {
  for (let n = 0; n < 3000; n++) {
    const start = run.randomPoint();
    const r = run.pick(10);
    let end: Vec3f;
    if (r === 0) {
      end = [...start];
    } else if (r < 4) {
      end = add(start, run.random.vec(128 * 256));
    } else {
      end = add(start, run.random.vec(2048 * 256));
    }
    const box = run.randomBox();
    run.boxTrace(start, end, box, 0, run.mask());
  }
}

/** Six traces into each patch's bounds, the last a position test, of the first `limit`. */
function corpusPatches(run: Run, limit: number): void {
  let done = 0;
  for (const patch of run.cm.surfaces) {
    if (done >= limit) break;
    if (!patch) continue;
    done++;
    for (let j = 0; j < 6; j++) {
      const end = run.randomIn(patch.pc.bounds[0], patch.pc.bounds[1]);
      const start: Vec3f = j === 5 ? [...end] : add(end, run.random.vec(96 * 256));
      const box = run.randomBox();
      run.boxTrace(start, end, box, 0, run.mask());
    }
  }
}

function corpusContents(run: Run): void {
  const cm = run.cm;
  for (let n = 0; n < 2000; n++) {
    const p = run.randomPoint();
    run.digest.int(pointContents(cm, p, 0));
    const leaf = pointLeafnum(cm, p);
    run.digest.int(leaf);
    const cluster = leafCluster(cm, leaf);
    run.digest.int(cluster);
    run.digest.int(leafArea(cm, leaf));
    run.digest.uint8s(cm.visibility, clusterPVS(cm, cluster), cm.clusterBytes);
    run.count++;
  }
}

function corpusModels(run: Run): void {
  const cm = run.cm;
  for (let m = 1; m < cm.numSubModels; m++) {
    const cmod = cm.cmodels[m];
    const center = vec3f();
    for (let j = 0; j < 3; j++) center[j] = f(f(cmod.mins[j] + cmod.maxs[j]) * 0.5);
    const origin = run.random.vec(256 * 256);
    const angles = run.pick(2) ? run.randomAngles() : vec3f();
    for (let j = 0; j < 8; j++) {
      const target = add(add(center, run.random.vec(64 * 256)), origin);
      const start = add(target, run.random.vec(160 * 256));
      const end: Vec3f = j === 7 ? [...start] : add(target, run.random.vec(16 * 256));
      const box = run.randomBox();
      const mask = run.mask();
      run.transformedBoxTrace(start, end, box, m, mask, origin, angles);
      const s2 = sub(start, origin);
      const e2 = sub(end, origin);
      run.boxTrace(s2, e2, box, m, mask);
      run.digest.int(transformedPointContents(cm, target, m, origin, angles));
      run.digest.int(pointContents(cm, e2, m));
    }
  }
}

function corpusBox(run: Run): void {
  const cm = run.cm;
  for (let n = 0; n < 600; n++) {
    const c = run.randomPoint();
    const bmins = vec3f();
    const bmaxs = vec3f();
    for (let i = 0; i < 3; i++) bmins[i] = f(c[i] - (1 + ((run.random.next() >>> 8) % 48)));
    for (let i = 0; i < 3; i++) bmaxs[i] = f(c[i] + (1 + ((run.random.next() >>> 8) % 48)));
    const h = tempBoxModel(cm, bmins, bmaxs);
    const start = add(c, run.random.vec(128 * 256));
    const end: Vec3f = n % 7 === 0 ? [...start] : add(c, run.random.vec(32 * 256));
    const box = run.randomBox();
    const mask = run.mask();
    run.boxTrace(start, end, box, h, mask);
    const origin = run.random.vec(16 * 256);
    const angles = n & 1 ? vec3f() : run.randomAngles();
    run.transformedBoxTrace(start, end, box, h, mask, origin, angles);
    const p = add(c, run.random.vec(56 * 256));
    run.digest.int(pointContents(cm, p, h));
    run.digest.int(transformedPointContents(cm, p, h, origin, angles));
  }
}

function corpusLeaves(run: Run): void {
  const list = new Int32Array(64);
  const lastLeaf = { value: 0 };
  for (let n = 0; n < 600; n++) {
    const mins = run.randomPoint();
    const maxs = vec3f();
    for (let i = 0; i < 3; i++) maxs[i] = f(mins[i] + ((run.random.next() >>> 8) % 4096) / 8);
    const count = boxLeafnums(run.cm, mins, maxs, list, n % 5 === 0 ? 4 : 64, lastLeaf);
    run.digest.int(count).int(lastLeaf.value);
    for (let i = 0; i < count; i++) run.digest.int(list[i]);
    run.count++;
  }
}

function corpusAreaBits(run: Run, area: number): void {
  const bits = new Uint8Array(64);
  run.digest.int(writeAreaBits(run.cm, bits, area));
  run.digest.uint8s(bits, 0, (run.cm.numAreas + 7) >> 3);
}

function corpusAreas(run: Run): void {
  const cm = run.cm;
  if (!cm.numAreas) return;
  const opened: [number, number][] = [];
  const floods = () => {
    for (let i = 0; i < cm.numAreas; i++) run.digest.int(cm.areas[i].floodnum);
  };
  for (let n = 0; n < 32; n++) {
    const a1 = run.pick(cm.numAreas);
    const a2 = run.pick(cm.numAreas);
    opened.push([a1, a2]);
    adjustAreaPortalState(cm, a1, a2, true);
    floods();
    for (let i = 0; i < 4; i++) {
      const b1 = run.pick(cm.numAreas);
      const b2 = run.pick(cm.numAreas);
      run.digest.int(areasConnected(cm, b1, b2) ? 1 : 0);
    }
    corpusAreaBits(run, run.pick(cm.numAreas + 1) - 1);
    run.count++;
  }
  for (let n = 31; n >= 0; n--) {
    adjustAreaPortalState(cm, opened[n][0], opened[n][1], false);
    floods();
    run.count++;
  }
  cm.cvars.noAreas = 1;
  run.digest.int(areasConnected(cm, 0, cm.numAreas - 1) ? 1 : 0);
  corpusAreaBits(run, 0);
  cm.cvars.noAreas = 0;
}

/** The kinds, in the twin's order, each seeded by its place. */
const KINDS: [string, (run: Run) => void][] = [
  ['world', corpusWorld],
  ['patches', (run) => corpusPatches(run, 1 << 30)],
  [
    'nocurves',
    (run) => {
      run.cm.cvars.noCurves = 1;
      corpusPatches(run, 48);
      run.cm.cvars.noCurves = 0;
    }
  ],
  [
    'noclip',
    (run) => {
      run.cm.cvars.playerCurveClip = 0;
      corpusPatches(run, 48);
      run.cm.cvars.playerCurveClip = 1;
    }
  ],
  ['contents', corpusContents],
  ['models', corpusModels],
  ['box', corpusBox],
  ['leaves', corpusLeaves],
  ['areas', corpusAreas]
];

/** A map's entity origins and each kind of the corpus, as the twin's `corpus` mode prints them. */
export function traceCorpus(cm: ClipMap, name: string): Record<string, CorpusKind | number> {
  const base = new Digest().uint8s(Uint8Array.from(name, (c) => c.charCodeAt(0)), 0, name.length);
  const origins = parseOrigins(cm.entityString);
  const out: Record<string, CorpusKind | number> = { origins: origins.length };
  KINDS.forEach(([label, kind], index) => {
    const seed = (parseInt(base.hex(), 16) + index * 7919) >>> 0;
    const run = new Run(cm, new Seeded(seed), origins);
    kind(run);
    out[label] = { count: run.count, digest: run.digest.hex() };
  });
  return out;
}
