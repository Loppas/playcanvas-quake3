import {
  crossProduct,
  dotProduct,
  f,
  perpendicularVector,
  qvmRotatePointAroundVector,
  vectorNormalize2
} from '../sim/cm/q-math';
import { polyVerts, type PolyVerts } from './scene-polys';

/**
 * cgame's wall marks (`cg_marks.c`): a polygon thrown onto the world where something hit it, cut
 * by the renderer into fragments along the surfaces it lands on (`R_MarkFragments`), each kept as a
 * mark of up to {@link MAX_VERTS_ON_POLY} points for {@link MARK_TOTAL_TIME}, its last second
 * faded out, and handed to the scene as a poly each frame. A plasma or rail mark cools to black
 * first. A temporary mark, a player's shadow, goes to the scene at once and is not kept.
 *
 * The 256 marks are one pool: when it is full, every mark made at the oldest one's time goes
 * together, as an impact's fragments are made at one time.
 *
 * The arithmetic is cgame's QVM's floats, in Q3's order.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `MAX_MARK_POLYS` (`cg_local.h:61`). */
export const MAX_MARK_POLYS = 256;

/** `MAX_VERTS_ON_POLY` (`cg_local.h:60`): the points a mark keeps of a fragment. */
export const MAX_VERTS_ON_POLY = 10;

/** `MAX_MARK_FRAGMENTS` and `MAX_MARK_POINTS` (`cg_marks.c:127-128`): what one impact may cut. */
export const MAX_MARK_FRAGMENTS = 128;
export const MAX_MARK_POINTS = 384;

/** `MARK_TOTAL_TIME` and `MARK_FADE_TIME` (`cg_marks.c:230-231`), in milliseconds. */
export const MARK_TOTAL_TIME = 10000;
export const MARK_FADE_TIME = 1000;

/** What a mark is thrown on, and where its fragments go: the renderer, through cgame's traps. */
export interface MarkScene<Shader> {
  /** `trap_CM_MarkFragments`: `R_MarkFragments` (`world-marks.ts`); 0 where there is no world. */
  markFragments(
    numPoints: number,
    points: ArrayLike<number>,
    projection: ArrayLike<number>,
    maxPoints: number,
    pointBuffer: Float32Array,
    maxFragments: number,
    fragmentBuffer: Int32Array
  ): number;
  /** `trap_R_AddPolyToScene`: `numVerts` points from the `first`th of `verts`. */
  addPoly(shader: Shader, numVerts: number, verts: PolyVerts, first: number): void;
}

/** The sentinel of the active list (`cg_activeMarkPolys`), after the pool's marks. */
const ACTIVE = MAX_MARK_POLYS;
/** The free list's end. */
const NONE = -1;

/** A colour's byte, as C stores a float in a `byte`: truncated, the low eight bits kept. */
function colorByte(value: number): number {
  return Math.trunc(value) & 255;
}

/** cgame's marks: the pool, made once, and its lists. */
export class Marks<Shader> {
  /** `cg_marks`: no mark is made or added without it, read at each call. */
  enabled = true;

  private readonly scene: MarkScene<Shader>;
  /** `cgs.media.energyMarkShader`, whose marks cool. */
  private readonly energy: Shader;
  /** The doubly linked active list, newest first, and the singly linked free list. */
  private readonly next = new Int32Array(MAX_MARK_POLYS + 1);
  private readonly prev = new Int32Array(MAX_MARK_POLYS + 1);
  private free = 0;
  /** Each mark's `time`, shader, `alphaFade`, `color` and points. */
  private readonly times = new Int32Array(MAX_MARK_POLYS + 1);
  private readonly shaders: (Shader | null)[] = new Array<Shader | null>(MAX_MARK_POLYS).fill(null);
  private readonly alphaFades = new Uint8Array(MAX_MARK_POLYS);
  private readonly colors = new Float32Array(MAX_MARK_POLYS * 4);
  private readonly numVerts = new Int32Array(MAX_MARK_POLYS);
  private readonly verts = polyVerts(MAX_MARK_POLYS * MAX_VERTS_ON_POLY);

  /** An impact's polygon, its frame, and what the renderer cuts it into. */
  private readonly axis = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  private readonly originalPoints = new Float32Array(4 * 3);
  private readonly projection = [0, 0, 0];
  private readonly delta = [0, 0, 0];
  private readonly markPoints = new Float32Array(MAX_MARK_POINTS * 3);
  private readonly markFragments = new Int32Array(MAX_MARK_FRAGMENTS * 2);
  /** A fragment's points as an impact makes them, which a temporary mark hands on. */
  private readonly fragment = polyVerts(MAX_VERTS_ON_POLY);

  constructor(scene: MarkScene<Shader>, energy: Shader) {
    this.scene = scene;
    this.energy = energy;
    this.clear();
  }

  /** `CG_InitMarkPolys` (`cg_marks.c:48-59`): every mark free, as a map or a restart starts. */
  clear(): void {
    this.next[ACTIVE] = ACTIVE;
    this.prev[ACTIVE] = ACTIVE;
    this.times[ACTIVE] = 0;
    for (let i = 0; i < MAX_MARK_POLYS; i++) {
      this.next[i] = i < MAX_MARK_POLYS - 1 ? i + 1 : NONE;
      this.shaders[i] = null;
    }
    this.free = 0;
  }

  /** How many marks are kept. */
  get count(): number {
    let count = 0;
    for (let mark = this.next[ACTIVE]; mark !== ACTIVE; mark = this.next[mark]) count++;
    return count;
  }

  /** `CG_FreeMarkPoly` (`cg_marks.c:67-79`): out of the active list, onto the free list. */
  private freeMark(mark: number): void {
    const { next, prev } = this;
    next[prev[mark]] = next[mark];
    prev[next[mark]] = prev[mark];
    next[mark] = this.free;
    this.free = mark;
  }

  /**
   * `CG_AllocMark` (`cg_marks.c:88-112`): a free mark, cleared, at the head of the active list.
   * With none free, every mark made at the oldest one's time is freed first.
   */
  private allocMark(): number {
    const { next, prev, times } = this;
    if (this.free === NONE) {
      const time = times[prev[ACTIVE]];
      while (prev[ACTIVE] !== ACTIVE && times[prev[ACTIVE]] === time) this.freeMark(prev[ACTIVE]);
    }
    const mark = this.free;
    this.free = next[mark];
    times[mark] = 0;
    this.alphaFades[mark] = 0;
    this.colors.fill(0, mark * 4, mark * 4 + 4);
    this.numVerts[mark] = 0;
    next[mark] = next[ACTIVE];
    prev[mark] = ACTIVE;
    prev[next[ACTIVE]] = mark;
    next[ACTIVE] = mark;
    return mark;
  }

  /**
   * `CG_ImpactMark` (`cg_marks.c:130-222`): a square of `radius` about `origin`, turned
   * `orientation` degrees about `dir`, thrown 20 units back along `dir` onto the world. Each
   * fragment the renderer cuts is kept as a mark of its first 10 points, its texture laid across
   * the square, in `red`, `green`, `blue` and `alpha` as bytes; a temporary one goes to the scene
   * now.
   *
   * @param dir - The plane's normal, out of it; a unit vector for the square's own size.
   * @param alphaFade - Its last second fades its alpha, and not its colour.
   * @param time - `cg.time`.
   * @throws in Q3's words for a radius of 0 or less
   */
  impactMark(
    shader: Shader,
    origin: ArrayLike<number>,
    dir: ArrayLike<number>,
    orientation: number,
    red: number,
    green: number,
    blue: number,
    alpha: number,
    alphaFade: boolean,
    radius: number,
    temporary: boolean,
    time: number
  ): void {
    if (!this.enabled) return;
    if (radius <= 0) throw new Error('CG_ImpactMark called with <= 0 radius');
    const { axis, originalPoints, projection, markPoints, markFragments, fragment } = this;
    vectorNormalize2(dir, axis[0]);
    perpendicularVector(axis[1], axis[0]);
    qvmRotatePointAroundVector(axis[2], axis[0], axis[1], orientation);
    crossProduct(axis[0], axis[2], axis[1]);
    const texCoordScale = f(0.5 / radius);
    for (let i = 0; i < 3; i++) {
      const across = f(radius * axis[1][i]);
      const up = f(radius * axis[2][i]);
      originalPoints[i] = f(f(origin[i] - across) - up);
      originalPoints[3 + i] = f(f(origin[i] + across) - up);
      originalPoints[6 + i] = f(f(origin[i] + across) + up);
      originalPoints[9 + i] = f(f(origin[i] - across) + up);
    }
    for (let i = 0; i < 3; i++) projection[i] = f(dir[i] * -20);
    const numFragments = this.scene.markFragments(
      4,
      originalPoints,
      projection,
      MAX_MARK_POINTS,
      markPoints,
      MAX_MARK_FRAGMENTS,
      markFragments
    );
    const r = colorByte(f(red * 255));
    const g = colorByte(f(green * 255));
    const b = colorByte(f(blue * 255));
    const a = colorByte(f(alpha * 255));
    const { delta } = this;
    for (let i = 0; i < numFragments; i++) {
      const firstPoint = markFragments[i * 2];
      const numPoints = Math.min(markFragments[i * 2 + 1], MAX_VERTS_ON_POLY);
      for (let j = 0; j < numPoints; j++) {
        const at = (firstPoint + j) * 3;
        for (let k = 0; k < 3; k++) {
          fragment.xyz[j * 3 + k] = markPoints[at + k];
          delta[k] = f(markPoints[at + k] - origin[k]);
        }
        fragment.st[j * 2] = f(0.5 + f(dotProduct(delta, axis[1]) * texCoordScale));
        fragment.st[j * 2 + 1] = f(0.5 + f(dotProduct(delta, axis[2]) * texCoordScale));
        fragment.modulate[j * 4] = r;
        fragment.modulate[j * 4 + 1] = g;
        fragment.modulate[j * 4 + 2] = b;
        fragment.modulate[j * 4 + 3] = a;
      }
      if (temporary) {
        this.scene.addPoly(shader, numPoints, fragment, 0);
        continue;
      }
      const mark = this.allocMark();
      this.times[mark] = time;
      this.alphaFades[mark] = alphaFade ? 1 : 0;
      this.shaders[mark] = shader;
      this.numVerts[mark] = numPoints;
      this.colors[mark * 4] = red;
      this.colors[mark * 4 + 1] = green;
      this.colors[mark * 4 + 2] = blue;
      this.colors[mark * 4 + 3] = alpha;
      const at = mark * MAX_VERTS_ON_POLY;
      const { xyz, st, modulate } = this.verts;
      for (let k = 0; k < numPoints * 3; k++) xyz[at * 3 + k] = fragment.xyz[k];
      for (let k = 0; k < numPoints * 2; k++) st[at * 2 + k] = fragment.st[k];
      for (let k = 0; k < numPoints * 4; k++) modulate[at * 4 + k] = fragment.modulate[k];
    }
  }

  /**
   * `CG_AddMarks` (`cg_marks.c:233-293`): each mark, newest first, to the scene, but those past
   * their time, which are freed. A plasma or rail mark's colour cools from 1.3 s to black at 3 s,
   * until its first point's red is gone, and each mark's last second fades its alpha or its colour.
   *
   * @param time - `cg.time`.
   */
  addMarks(time: number): void {
    if (!this.enabled) return;
    const { next, times, numVerts } = this;
    const { modulate } = this.verts;
    let mark = next[ACTIVE];
    while (mark !== ACTIVE) {
      const following = next[mark];
      if (time > times[mark] + MARK_TOTAL_TIME) {
        this.freeMark(mark);
        mark = following;
        continue;
      }
      const at = mark * MAX_VERTS_ON_POLY;
      const count = numVerts[mark];
      if (this.shaders[mark] === this.energy) {
        let fade = Math.trunc(f(450 - f(450 * f(f(time - times[mark]) / 3000))));
        if (fade < 255) {
          if (fade < 0) fade = 0;
          if (modulate[at * 4] !== 0) this.fadeColor(mark, fade);
        }
      }
      const t = times[mark] + MARK_TOTAL_TIME - time;
      if (t < MARK_FADE_TIME) {
        const fade = Math.trunc((255 * t) / MARK_FADE_TIME);
        if (this.alphaFades[mark]) {
          for (let j = 0; j < count; j++) modulate[(at + j) * 4 + 3] = fade;
        } else {
          this.fadeColor(mark, fade);
        }
      }
      this.scene.addPoly(this.shaders[mark]!, count, this.verts, at);
      mark = following;
    }
  }

  /** A mark's colour scaled by `fade`, each point's red, green and blue. */
  private fadeColor(mark: number, fade: number): void {
    const { modulate } = this.verts;
    const at = mark * MAX_VERTS_ON_POLY;
    for (let j = 0; j < this.numVerts[mark]; j++) {
      for (let k = 0; k < 3; k++) {
        modulate[(at + j) * 4 + k] = colorByte(f(this.colors[mark * 4 + k] * fade));
      }
    }
  }
}
