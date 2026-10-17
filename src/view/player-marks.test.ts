import { describe, expect, it, vi } from 'vitest';

import { ENTITYNUM_NONE } from '../net/protocol';
import { CONTENTS, MASK } from '../sim/constants';
import { PW } from '../sim/items';
import type { TraceFn, TraceResult } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { LEMT } from './fragments';
import type { Marks } from './marks';
import {
  MARK_SHADERS,
  fragmentBounceMark,
  impactMark,
  markMedia,
  playerShadow,
  playerSplash
} from './player-marks';
import type { PolyVerts } from './scene-polys';

const media = markMedia((name) => name);

/** A mark pool that keeps each `impactMark` call's arguments. */
function recording() {
  const impactMark = vi.fn();
  return { marks: { impactMark } as unknown as Marks<string>, impactMark };
}

/** A trace that stops at `fraction` of the way, at `endpos`, on a floor. */
function stopping(fraction: number, endpos: Vec3, fields: Partial<TraceResult> = {}) {
  return vi.fn<TraceFn>(() => ({
    allsolid: false,
    startsolid: false,
    fraction,
    endpos,
    normal: vec3(0, 0, 1),
    contents: CONTENTS.SOLID,
    surfaceFlags: 0,
    entityNum: 0,
    ...fields
  }));
}

describe("CG_MissileHitWall's mark", () => {
  it.each([
    [WP.GRENADE_LAUNCHER, MARK_SHADERS.burn, 64, false],
    [WP.ROCKET_LAUNCHER, MARK_SHADERS.burn, 64, false],
    [WP.PLASMAGUN, MARK_SHADERS.energy, 16, true],
    [WP.BFG, MARK_SHADERS.burn, 32, false],
    [WP.SHOTGUN, MARK_SHADERS.bullet, 4, false],
    [WP.MACHINEGUN, MARK_SHADERS.bullet, 8, false],
    [WP.LIGHTNING, MARK_SHADERS.hole, 12, false],
    // The `default` case falls into the lightning gun's.
    [WP.GRAPPLING_HOOK, MARK_SHADERS.hole, 12, false]
  ])('of weapon %i is %s, %i across, its alpha faded: %s', (weapon, shader, radius, alphaFade) => {
    const { marks, impactMark: made } = recording();
    const impact = { weapon, origin: vec3(1, 2, 3), normal: vec3(0, 0, 1) };
    impactMark(marks, media, impact, () => 0.25, 1000);
    expect(made).toHaveBeenCalledWith(
      shader,
      [1, 2, 3],
      [0, 0, 1],
      90,
      1,
      1,
      1,
      1,
      alphaFade,
      radius,
      false,
      1000
    );
  });

  it("tints the rail's in its shooter's color1, and fades its alpha", () => {
    const { marks, impactMark: made } = recording();
    const color = [0, 0.5, 1] as const;
    const impact = { weapon: WP.RAILGUN, origin: vec3(), normal: vec3(1, 0, 0), color };
    impactMark(marks, media, impact, () => 0, 1000);
    expect(made.mock.calls[0].slice(0, 11)).toEqual([
      MARK_SHADERS.energy,
      [0, 0, 0],
      [1, 0, 0],
      0,
      0,
      0.5,
      1,
      1,
      true,
      24,
      false
    ]);
  });
});

describe('CG_FragmentBounceMark', () => {
  it("leaves blood 16 to 47 across, fading its alpha, turned at random; a burn's 8 to 23", () => {
    const { marks, impactMark: made } = recording();
    const at = vec3(5, 6, 7);
    const up = vec3(0, 0, 1);
    fragmentBounceMark(marks, media, LEMT.BLOOD, at, up, () => 0.5, 2000);
    fragmentBounceMark(marks, media, LEMT.BURN, at, up, () => 0.5, 2000);
    fragmentBounceMark(marks, media, LEMT.NONE, at, up, () => 0.5, 2000);
    expect(made.mock.calls).toEqual([
      [MARK_SHADERS.blood, [5, 6, 7], [0, 0, 1], 180, 1, 1, 1, 1, true, 32, false, 2000],
      [MARK_SHADERS.burn, [5, 6, 7], [0, 0, 1], 180, 1, 1, 1, 1, true, 16, false, 2000]
    ]);
  });
});

describe('CG_PlayerShadow', () => {
  const origin = vec3(10, 20, 100);

  it('traces the world 128 down in a 30-unit box, and marks the ground there for the frame', () => {
    const { marks, impactMark: made } = recording();
    const trace = stopping(0.25, vec3(10, 20, 68));
    playerShadow(origin, 0, 45.5, 1, trace, marks, 'shadow', 3000);
    expect(trace).toHaveBeenCalledWith(
      origin,
      vec3(-15, -15, 0),
      vec3(15, 15, 2),
      vec3(10, 20, -28),
      ENTITYNUM_NONE,
      MASK.PLAYERSOLID
    );
    // Darker the nearer, turned as the legs are, 24 across and not kept.
    expect(made).toHaveBeenCalledWith(
      'shadow',
      [10, 20, 68],
      [0, 0, 1],
      45.5,
      0.75,
      0.75,
      0.75,
      1,
      false,
      24,
      true,
      3000
    );
  });

  it('marks nothing too high, in a wall, invisible, or without cg_shadows 1', () => {
    const { marks, impactMark: made } = recording();
    playerShadow(origin, 0, 0, 1, stopping(1, origin), marks, 'shadow', 0);
    playerShadow(origin, 0, 0, 1, stopping(0, origin, { startsolid: true }), marks, 'shadow', 0);
    playerShadow(origin, 0, 0, 1, stopping(0, origin, { allsolid: true }), marks, 'shadow', 0);
    playerShadow(origin, 1 << PW.INVIS, 0, 1, stopping(0.5, origin), marks, 'shadow', 0);
    // Q3's stencil and planar shadows, which are not drawn, and none at all.
    playerShadow(origin, 0, 0, 2, stopping(0.5, origin), marks, 'shadow', 0);
    const untraced = stopping(0.5, origin);
    playerShadow(origin, 0, 0, 0, untraced, marks, 'shadow', 0);
    expect(made).not.toHaveBeenCalled();
    expect(untraced).not.toHaveBeenCalled();
  });
});

describe('CG_PlayerSplash', () => {
  const origin = vec3(10, 20, 100);
  /** Water below z 90, and air above. */
  const contents = (point: Vec3) => (point.z < 90 ? CONTENTS.WATER : 0);

  it("lays a wake 64 across on the water's face, where the feet are in it and the head out", () => {
    const added: { shader: string; xyz: number[]; st: number[]; modulate: number[] }[] = [];
    const add = (shader: string, numVerts: number, verts: PolyVerts, first: number) =>
      added.push({
        shader,
        xyz: Array.from(verts.xyz.subarray(first * 3, (first + numVerts) * 3)),
        st: Array.from(verts.st.subarray(first * 2, (first + numVerts) * 2)),
        modulate: Array.from(verts.modulate.subarray(first * 4, (first + numVerts) * 4))
      });
    const trace = stopping(0.5, vec3(10, 20, 90));
    playerSplash(origin, 1, contents, trace, add, 'wake');
    expect(trace).toHaveBeenCalledWith(
      vec3(10, 20, 132),
      vec3(),
      vec3(),
      vec3(10, 20, 76),
      ENTITYNUM_NONE,
      CONTENTS.WATER | CONTENTS.SLIME | CONTENTS.LAVA
    );
    expect(added).toEqual([
      {
        shader: 'wake',
        xyz: [-22, -12, 90, -22, 52, 90, 42, 52, 90, 42, -12, 90],
        st: [0, 0, 0, 1, 1, 1, 1, 0],
        modulate: new Array(16).fill(255)
      }
    ]);
  });

  it('lays none for dry feet, a head under or walled, a trace meeting nothing, or 0', () => {
    const add = vi.fn();
    playerSplash(vec3(10, 20, 200), 1, contents, stopping(0.5, origin), add, 'wake');
    playerSplash(vec3(10, 20, 50), 1, contents, stopping(0.5, origin), add, 'wake');
    const walled = () => CONTENTS.WATER | CONTENTS.SOLID;
    playerSplash(origin, 1, walled, stopping(0.5, origin), add, 'wake');
    playerSplash(origin, 1, contents, stopping(1, origin), add, 'wake');
    playerSplash(origin, 0, contents, stopping(0.5, origin), add, 'wake');
    expect(add).not.toHaveBeenCalled();
  });
});
