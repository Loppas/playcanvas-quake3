import { describe, expect, it } from 'vitest';
import { ENTITYNUM_NONE } from '../../net/protocol';
import { createFlatWorldTrace } from '../box-world';
import { vec3, dot, length, normalize, scale, sub, type Vec3 } from '../vec3';
import { BULLET_RANGE, SHOTGUN_COUNT, SHOTGUN_SPREAD } from './constants';
import {
  ID_SHOTGUN,
  Q3Random,
  beamEndpoint,
  bulletEndpoint,
  calcMuzzlePoint,
  firingSolution,
  perpendicularVector,
  shotgunPattern,
  shotgunPatternOnView,
  shotgunWire,
  traceShot,
  truncVector
} from './hitscan';

describe('truncVector', () => {
  it('truncates toward zero, unlike the velocity snap which rounds', () => {
    // The distinction that matters: `snapVector` (velocity) would give 1, 2, -2 here.
    expect(truncVector(vec3(1.9, 2.5, -2.5))).toEqual(vec3(1, 2, -2));
  });

  it('leaves integers alone', () => {
    expect(truncVector(vec3(-3, 0, 7))).toEqual(vec3(-3, 0, 7));
  });
});

describe('Q3Random', () => {
  it('reproduces the LCG recurrence exactly', () => {
    // seed = 69069 * seed + 1, in unsigned 32-bit.
    const random = new Q3Random(1);
    expect(random.rand()).toBe(69070);
    expect(random.rand()).toBe((69069 * 69070 + 1) >>> 0);
  });

  it('wraps at 32 bits rather than losing precision', () => {
    // A plain JS multiply would exceed 2^53 within a few steps and start returning even
    // numbers forever; Math.imul is what keeps the sequence faithful.
    const random = new Q3Random(0xdeadbeef);
    for (let i = 0; i < 100; i++) {
      const value = random.rand();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    }
  });

  it('produces random() in [0, 1) and crandom() in [-1, 1)', () => {
    const random = new Q3Random(12345);
    for (let i = 0; i < 500; i++) {
      const uniform = random.random();
      expect(uniform).toBeGreaterThanOrEqual(0);
      expect(uniform).toBeLessThan(1);
    }
    const centred = new Q3Random(999);
    for (let i = 0; i < 500; i++) {
      const value = centred.crandom();
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThan(1);
    }
  });

  it('is deterministic from its seed', () => {
    const first = new Q3Random(77);
    const second = new Q3Random(77);
    for (let i = 0; i < 20; i++) expect(first.random()).toBe(second.random());
  });
});

describe('calcMuzzlePoint', () => {
  it('adds the eye height and 14 units of reach, then truncates', () => {
    // Facing +X from the origin: 0 + 14 forward, z = 0 + 26 viewheight.
    expect(calcMuzzlePoint(vec3(0, 0, 0), vec3(1, 0, 0), 26)).toEqual(vec3(14, 0, 26));
  });

  it('truncates the result, so the muzzle sits on integer coordinates', () => {
    const muzzle = calcMuzzlePoint(vec3(0.5, 0.5, 0), normalize(vec3(1, 1, 0)), 26);
    expect(muzzle.x).toBe(Math.trunc(muzzle.x));
    expect(muzzle.y).toBe(Math.trunc(muzzle.y));
    expect(muzzle.z).toBe(26);
  });

  it('follows the crouched eye height', () => {
    expect(calcMuzzlePoint(vec3(0, 0, 0), vec3(1, 0, 0), 12).z).toBe(12);
  });

  it("leaves CPMA's 1 unit ahead of the eye, where it is not truncated", () => {
    const origin = vec3(0.25, 0.5, 0);
    expect(calcMuzzlePoint(origin, vec3(1, 0, 0), 26, 1, false)).toEqual(vec3(1.25, 0.5, 26));
    expect(calcMuzzlePoint(origin, vec3(1, 0, 0), 26)).toEqual(vec3(14, 0, 26));
  });
});

describe('perpendicularVector', () => {
  it('returns a unit vector at right angles to its input', () => {
    for (const v of [vec3(1, 0, 0), vec3(0, 0, 1), normalize(vec3(1, 2, 3))]) {
      const perpendicular = perpendicularVector(v);
      expect(length(perpendicular)).toBeCloseTo(1, 6);
      expect(dot(perpendicular, v)).toBeCloseTo(0, 6);
    }
  });

  it('picks the axis the input leans on least', () => {
    // Forward is mostly +X, so the seed axis is X's opposite — this specific choice is what
    // makes the shotgun pattern match id's.
    expect(perpendicularVector(vec3(0, 0, 1))).toEqual(vec3(1, 0, 0));
  });
});

describe('shotgunPattern', () => {
  const muzzle = vec3(0, 0, 26);
  const forward = vec3(1, 0, 0);

  it('produces exactly eleven pellets', () => {
    expect(shotgunPattern(muzzle, forward, 42)).toHaveLength(SHOTGUN_COUNT);
  });

  it('is deterministic from the seed', () => {
    expect(shotgunPattern(muzzle, forward, 42)).toEqual(shotgunPattern(muzzle, forward, 42));
  });

  it('gives a different pattern for a different seed', () => {
    expect(shotgunPattern(muzzle, forward, 42)).not.toEqual(shotgunPattern(muzzle, forward, 43));
  });

  it('matches the golden pattern for seed 0', () => {
    // Measured from the port and pinned. These are the lateral and vertical offsets, in
    // units, at the 8192*16 endpoint — the whole pattern in one readable form. A change
    // here means the LCG, the basis or the ordering of the two crandom draws has moved.
    const pattern = shotgunPattern(muzzle, forward, 0);
    const offsets = pattern.map((end) => [Math.round(end.y), Math.round(end.z - 26)]);
    expect(offsets).toEqual([
      [-11200, -9992],
      [347, -6318],
      [-10293, -10721],
      [1811, -7495],
      [-2759, -2284],
      [-4971, -2481],
      [-8546, 2369],
      [-9151, -7027],
      [-8405, 7087],
      [-5477, 2317],
      [-11086, 10121]
    ]);
  });

  it('scatters into a square, not a disc', () => {
    // Right and up use independent uniform draws, so the corners are reachable — visibly
    // different from a polar cone at range, and a Quake 3 shotgun quirk.
    const limit = SHOTGUN_SPREAD * 16;
    let maxRadius = 0;
    for (let seed = 0; seed < 60; seed++) {
      for (const end of shotgunPattern(muzzle, forward, seed)) {
        const y = end.y;
        const z = end.z - 26;
        expect(Math.abs(y)).toBeLessThanOrEqual(limit);
        expect(Math.abs(z)).toBeLessThanOrEqual(limit);
        maxRadius = Math.max(maxRadius, Math.hypot(y, z));
      }
    }
    // A disc would cap at the limit; a square reaches past it toward the corners.
    expect(maxRadius).toBeGreaterThan(limit * 1.1);
  });

  it('is built from the aim as the wire carries it, not from the original', () => {
    // `weapon_supershotgun_fire` sends SnapVector(forward * 4096) and both sides generate the
    // pattern from what was sent — so a slightly off-axis shot quantizes, identically at each
    // end. That is what lets one event stand for eleven rays.
    const aim = normalize(vec3(1, 0.0001, 0));
    const pattern = shotgunPattern(muzzle, shotgunWire(aim), 7);
    // 0.0001 * 4096 truncates to 0, making this identical to firing straight down +X.
    expect(pattern).toEqual(shotgunPattern(muzzle, shotgunWire(vec3(1, 0, 0)), 7));
  });
});

describe("the shotgun's rules", () => {
  /** Looking down +X from a muzzle at (14, 0, 26), where the view's right is -Y. */
  const level = firingSolution(vec3(0, 0, 0), vec3(0, 0, 0), 26);
  /** One of CPMA's fixed patterns. */
  const fixed = (pattern: number, pellets = 16) => ({ pattern, pellets, spread: SHOTGUN_SPREAD });
  /** A point's coordinates to a thousandth, with -0 read as 0. */
  const at = (point: Vec3) =>
    [point.x, point.y, point.z].map((c) => Math.round(c * 1000) / 1000 + 0);
  /** Points in an order of their own, to compare them as sets. */
  const asSet = (points: Vec3[]) =>
    points.map(at).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  /** Each pellet's right and up offsets, where the view's right is -Y and the muzzle is 26 up. */
  const offsets = (ends: Vec3[]) => ends.map((end) => [-end.y + 0, end.z - 26 + 0]);

  it("lays CPMA's fixed pattern on the view's axes, from the muzzle, at 8192 units", () => {
    const ends = shotgunPatternOnView(level, fixed(1));
    expect(at(ends[0])).toEqual([8206, -250, 126]);
    expect(ends.every((end) => end.x === 8206)).toBe(true);
    // As CPMA 1.48's qagame and cgame both hold it, times 1000.
    expect(offsets(ends)).toEqual([
      [250, 100], [100, 250], [700, 300], [300, 700],
      [-250, 100], [-100, 250], [-700, 300], [-300, 700],
      [250, -100], [100, -250], [700, -300], [300, -700],
      [-250, -100], [-100, -250], [-700, -300], [-300, -700]
    ]);
  });

  it("takes CQ3's wider one as the second", () => {
    expect(offsets(shotgunPatternOnView(level, fixed(2)))).toEqual([
      [300, 150], [150, 300], [700, 350], [350, 700],
      [-300, 150], [-150, 300], [-700, 350], [-350, 700],
      [300, -150], [150, -300], [700, -350], [350, -700],
      [-300, -150], [-150, -300], [-700, -350], [-350, -700]
    ]);
  });

  it('goes round its table past sixteen pellets, and takes the first of it below', () => {
    const sixteen = shotgunPatternOnView(level, fixed(1));
    expect(shotgunPatternOnView(level, fixed(1, 20))).toEqual([...sixteen, ...sixteen.slice(0, 4)]);
    expect(shotgunPatternOnView(level, fixed(1, 11))).toEqual(sixteen.slice(0, 11));
  });

  it("reads id's random pattern's pellets and spread from the rules", () => {
    const muzzle = vec3(0, 0, 26);
    const wire = shotgunWire(vec3(1, 0, 0));
    const ids = shotgunPattern(muzzle, wire, 0);
    expect(shotgunPattern(muzzle, wire, 0, ID_SHOTGUN)).toEqual(ids);
    expect(shotgunPattern(muzzle, wire, 0, { ...ID_SHOTGUN, pellets: 3 })).toEqual(ids.slice(0, 3));
    // Half the spread is half of every offset, at the same range.
    const half = shotgunPattern(muzzle, wire, 0, { ...ID_SHOTGUN, spread: 350 });
    half.forEach((end, i) => {
      expect(end.x).toBe(ids[i].x);
      expect(end.y).toBeCloseTo(ids[i].y / 2, 6);
      expect(end.z - 26).toBeCloseTo((ids[i].z - 26) / 2, 6);
    });
  });

  it("draws CPMA's pattern on the aim's axes, which on a level aim are the hits'", () => {
    const hits = shotgunPatternOnView(level, fixed(1));
    const drawn = shotgunPattern(level.muzzle, shotgunWire(level.forward), 0, fixed(1));
    // Mirrored pellet by pellet, which the pattern does not show.
    expect(at(drawn[0])).toEqual([8206, 250, 126]);
    expect(asSet(drawn)).toEqual(asSet(hits));
  });

  it('draws the hits turned about the aim where the aim is steep', () => {
    // Up at 60 degrees and 30 round from +X, the aim leans least on Y, so the drawn axes are built
    // from Y and stand at no quarter turn to the view's.
    const steep = firingSolution(vec3(0, 0, 0), vec3(-60, 30, 0), 26, 1, false);
    const hits = shotgunPatternOnView(steep, fixed(1));
    const drawn = shotgunPattern(steep.muzzle, shotgunWire(steep.forward), 0, fixed(1));
    const offAim = (end: Vec3) => {
      const out = sub(end, steep.muzzle);
      return length(sub(out, scale(steep.forward, dot(out, steep.forward))));
    };
    // Each as far off the aim as a hit, to the wire's rounding, but somewhere else round it.
    const drawnOff = drawn.map(offAim).sort((a, b) => a - b);
    hits
      .map(offAim)
      .sort((a, b) => a - b)
      .forEach((off, i) => expect(Math.abs(drawnOff[i] - off)).toBeLessThan(2));
    const nearestHit = (end: Vec3) => Math.min(...hits.map((hit) => length(sub(end, hit))));
    expect(Math.max(...drawn.map(nearestHit))).toBeGreaterThan(50);
  });
});

describe('bulletEndpoint', () => {
  const solution = firingSolution(vec3(0, 0, 0), vec3(0, 0, 0), 26);

  it("keeps the cone's angle at CPMA's range, the spread being given at 8192 units", () => {
    const draws = () => {
      const values = [0.3, 0.9, 0.1];
      let i = 0;
      return () => values[i++];
    };
    const far = bulletEndpoint(solution, draws(), 200);
    const near = bulletEndpoint(solution, draws(), 200, 8192);
    expect(near.x).toBeCloseTo(solution.muzzle.x + 8192, 6);
    expect(near.y).toBeCloseTo(far.y / 16, 9);
    expect(near.z - solution.muzzle.z).toBeCloseTo((far.z - solution.muzzle.z) / 16, 9);
  });

  it('fires dead straight when the spread draws are centred', () => {
    // random() = 0.5 makes crandom() zero, so both offsets vanish.
    const end = bulletEndpoint(solution, () => 0.5);
    expect(end.y).toBeCloseTo(0, 6);
    expect(end.z).toBeCloseTo(solution.muzzle.z, 6);
    expect(end.x).toBeCloseTo(solution.muzzle.x + BULLET_RANGE, 6);
  });

  it('stays inside the spread cone', () => {
    // Polar offsets, so unlike the shotgun this really is bounded by a radius.
    const limit = 200 * 16;
    let random = 0;
    const sequence = () => {
      random = (random + 0.137) % 1;
      return random;
    };
    for (let i = 0; i < 200; i++) {
      const end = bulletEndpoint(solution, sequence);
      expect(Math.hypot(end.y, end.z - solution.muzzle.z)).toBeLessThanOrEqual(limit + 1e-6);
    }
  });
});

describe('traceShot', () => {
  // Nothing but flat ground at z = 0, so a downward shot has an unambiguous answer.
  const trace = createFlatWorldTrace();

  it('reports a clean miss at full range', () => {
    const result = traceShot(trace, vec3(0, 0, 64), vec3(0, 0, 200), ENTITYNUM_NONE);
    expect(result.hit).toBe(false);
    expect(result.distance).toBeCloseTo(136, 4);
  });

  it('stops at the floor and reports its normal', () => {
    const result = traceShot(trace, vec3(0, 0, 64), vec3(0, 0, -64), ENTITYNUM_NONE);
    expect(result.hit).toBe(true);
    expect(result.normal.z).toBeCloseTo(1, 6);
    // Just above the surface, never inside it: the trace backs off by an epsilon, which is
    // exactly the contract `TraceFn` promises so callers never start a sweep in solid.
    expect(result.endpos.z).toBeGreaterThan(0);
    expect(result.endpos.z).toBeLessThan(0.5);
  });
});

describe('beamEndpoint', () => {
  it('reaches exactly the weapon range', () => {
    const solution = firingSolution(vec3(0, 0, 0), vec3(0, 0, 0), 26);
    expect(length(sub(beamEndpoint(solution, 768), solution.muzzle))).toBeCloseTo(768, 6);
  });
});
