import { describe, expect, it } from 'vitest';

import { dot, length, vec3, type Vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import {
  BEAM_TEXTURE_LENGTH,
  EXPLOSION_SURFACE_OFFSET,
  GRAPPLE_FLARE_PULL,
  LASER_RADIUS,
  LASER_SIDES,
  LIGHTNING_BLADES,
  LIGHTNING_BLADE_STEP_DEGREES,
  LIGHTNING_HALF_WIDTH,
  RAIL_CORE_HALF_WIDTH,
  RAIL_TRAIL_MS,
  TRAIL_MIN_RADIUS,
  TRAIL_STEP_MS,
  TRAIL_STYLES,
  animFrame,
  beamSide,
  smokeAlpha,
  explosionRadius,
  grappleFlarePosition,
  grappleFlareRadius,
  laserFrame,
  missileAxis,
  missileSpinAngle,
  perpendicularVector,
  rotatePointAroundVector,
  smokeRadius
} from './effects';

/** Assert a basis is orthonormal and right-handed, which every axis triple here must be. */
function expectOrthonormal({ forward, left, up }: ReturnType<typeof missileAxis>): void {
  for (const axis of [forward, left, up]) expect(length(axis)).toBeCloseTo(1, 10);
  expect(dot(forward, left)).toBeCloseTo(0, 10);
  expect(dot(forward, up)).toBeCloseTo(0, 10);
  expect(dot(left, up)).toBeCloseTo(0, 10);
}

describe('perpendicularVector', () => {
  it('is perpendicular and unit length, whichever way the input points', () => {
    const inputs: Vec3[] = [
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, 0, 1),
      vec3(-0.3, 0.9, 0.31),
      vec3(0.577, 0.577, 0.577)
    ];
    for (const input of inputs) {
      const perpendicular = perpendicularVector(input);
      expect(length(perpendicular), `${JSON.stringify(input)}`).toBeCloseTo(1, 10);
      expect(dot(perpendicular, input)).toBeCloseTo(0, 10);
    }
  });

  it('starts from the axis the input leans on least, so the projection cannot collapse', () => {
    // Along +X the chosen seed is +Y, which survives projection intact.
    expect(perpendicularVector(vec3(1, 0, 0))).toEqual(vec3(0, 1, 0));
  });
});

describe('rotatePointAroundVector', () => {
  it('turns a right angle about an axis', () => {
    const rotated = rotatePointAroundVector(vec3(1, 0, 0), vec3(0, 0, 1), 90);
    expect(rotated.x).toBeCloseTo(0, 10);
    expect(rotated.y).toBeCloseTo(1, 10);
    expect(rotated.z).toBeCloseTo(0, 10);
  });

  it('leaves a point on the axis alone', () => {
    const rotated = rotatePointAroundVector(vec3(0, 0, 3), vec3(0, 0, 1), 137);
    expect(rotated.z).toBeCloseTo(3, 10);
    expect(Math.hypot(rotated.x, rotated.y)).toBeCloseTo(0, 10);
  });

  it('preserves length, so a rotated basis stays a basis', () => {
    const rotated = rotatePointAroundVector(vec3(0.6, -0.8, 0), vec3(0, 0, 1), 33);
    expect(length(rotated)).toBeCloseTo(1, 10);
  });
});

describe('laserFrame', () => {
  it('lies along the beam, its length the beam’s, from where the laser stands', () => {
    const frame = laserFrame(vec3(10, 20, 30), vec3(10, 20, 330))!;
    expect(frame.length).toBe(300);
    expect(frame.basis.forward).toEqual(vec3(0, 0, 1));
    expectOrthonormal(frame.basis);
  });

  it("puts the corners where RB_SurfaceBeam's turns put them, each 60° on from the last", () => {
    const start = vec3(10, 20, 30);
    const end = vec3(-40, 120, 7);
    const { basis } = laserFrame(start, end)!;
    const { forward, left, up } = basis;
    expect(left).toEqual(perpendicularVector(forward));
    const out = vec3(left.x * LASER_RADIUS, left.y * LASER_RADIUS, left.z * LASER_RADIUS);
    for (let i = 0; i < LASER_SIDES; i++) {
      const angle = (2 * Math.PI * i) / LASER_SIDES;
      const turned = rotatePointAroundVector(out, forward, (360 / LASER_SIDES) * i);
      const c = Math.cos(angle) * LASER_RADIUS;
      const s = Math.sin(angle) * LASER_RADIUS;
      expect(turned.x).toBeCloseTo(left.x * c + up.x * s, 10);
      expect(turned.y).toBeCloseTo(left.y * c + up.y * s, 10);
      expect(turned.z).toBeCloseTo(left.z * c + up.z * s, 10);
    }
  });

  it('is none for a beam of no length, which Quake 3 does not draw', () => {
    expect(laserFrame(vec3(1, 2, 3), vec3(1, 2, 3))).toBeNull();
  });
});

describe('missileAxis', () => {
  it('points a projectile along its own velocity', () => {
    const axis = missileAxis(vec3(0, 900, 0), 0);
    expect(axis.forward).toEqual(vec3(0, 1, 0));
    expectOrthonormal(axis);
  });

  it('stays a valid frame at every roll angle and every heading', () => {
    for (const delta of [vec3(900, 0, 0), vec3(0, 0, -700), vec3(-120, 340, 55)]) {
      for (let spin = 0; spin < 360; spin += 45) {
        expectOrthonormal(missileAxis(delta, spin));
      }
    }
  });

  it('rolls about the direction of travel without disturbing it', () => {
    const straight = missileAxis(vec3(900, 0, 0), 0);
    const rolled = missileAxis(vec3(900, 0, 0), 90);
    expect(rolled.forward).toEqual(straight.forward);
    // The roll is real: the other two axes have actually moved.
    expect(dot(rolled.left, straight.left)).toBeCloseTo(0, 10);
  });

  it('points a stationary projectile up rather than producing a degenerate frame', () => {
    // `CG_Missile` does exactly this — a rested grenade still has to be drawn.
    const axis = missileAxis(vec3(), 0);
    expect(axis.forward).toEqual(vec3(0, 0, 1));
    expectOrthonormal(axis);
  });
});

describe('missileSpinAngle', () => {
  it('turns a quarter of a degree per millisecond', () => {
    expect(missileSpinAngle(4000)).toBe(1000);
    // 90 degrees a second — a readable spin, not a blur.
    expect(missileSpinAngle(1000) - missileSpinAngle(0)).toBe(250);
  });
});

describe('the explosion curve', () => {
  it('grows from 30 to 72 units', () => {
    expect(explosionRadius(0)).toBe(30);
    expect(explosionRadius(1)).toBe(72);
    expect(explosionRadius(0.5)).toBe(51);
  });

  it('holds still outside its own lifetime rather than inverting', () => {
    expect(explosionRadius(-1)).toBe(30);
    expect(explosionRadius(2)).toBe(72);
  });

  it('lifts the sprite clear of the surface it struck', () => {
    // Without the offset half the fireball is buried in the wall.
    expect(EXPLOSION_SURFACE_OFFSET).toBe(16);
  });
});

describe('the smoke fade', () => {
  it('starts at a third of opaque and fades out, holding at nothing past its life', () => {
    // A byte, cut down as Q3 stores it: 255 × 0.33 is 84.15, and half that 42.075.
    expect(smokeAlpha(0)).toBe(84 / 255);
    expect(smokeAlpha(0.5)).toBe(42 / 255);
    expect(smokeAlpha(0.5, 1)).toBe(127 / 255);
    expect(smokeAlpha(1)).toBe(0);
    expect(smokeAlpha(2)).toBe(0);
  });
});

describe('animFrame', () => {
  it('walks the sheet at the shaderrate and loops', () => {
    // An eight-frame sheet at 8 fps is one frame per 125 ms.
    expect(animFrame(0, 8, 8)).toBe(0);
    expect(animFrame(124, 8, 8)).toBe(0);
    expect(animFrame(125, 8, 8)).toBe(1);
    expect(animFrame(1000, 8, 8)).toBe(0);
  });

  it('holds frame zero for a single-image stage', () => {
    expect(animFrame(9999, 0, 1)).toBe(0);
    expect(animFrame(9999, 8, 1)).toBe(0);
  });
});

describe('beamSide', () => {
  const eye = vec3(0, 0, 0);

  it('is perpendicular to the beam, so the quad spans it squarely', () => {
    const start = vec3(100, -50, 0);
    const end = vec3(400, -50, 0);
    const side = beamSide(start, end, eye);
    expect(length(side)).toBeCloseTo(1, 10);
    expect(dot(side, vec3(end.x - start.x, end.y - start.y, end.z - start.z))).toBeCloseTo(0, 8);
  });

  it('is perpendicular to the line of sight too — that is what faces it at the viewer', () => {
    const start = vec3(100, -50, 10);
    const end = vec3(400, 20, -30);
    const side = beamSide(start, end, eye);
    // Normal to the plane through the eye and the beam, so it is normal to both sight lines.
    expect(dot(side, start)).toBeCloseTo(0, 8);
    expect(dot(side, end)).toBeCloseTo(0, 8);
  });

  it('still returns a usable axis when the beam points straight at the viewer', () => {
    // The plane is undefined here; any perpendicular will do, because the beam is a dot.
    const side = beamSide(vec3(100, 0, 0), vec3(500, 0, 0), eye);
    expect(length(side)).toBeCloseTo(1, 10);
    expect(dot(side, vec3(1, 0, 0))).toBeCloseTo(0, 10);
  });

  it('flips as the viewer crosses the beam, rather than degenerating', () => {
    const start = vec3(100, 0, 0);
    const end = vec3(400, 0, 0);
    const above = beamSide(start, end, vec3(250, 0, 100));
    const below = beamSide(start, end, vec3(250, 0, -100));
    expect(length(above)).toBeCloseTo(1, 10);
    expect(dot(above, below)).toBeCloseTo(-1, 8);
  });
});

describe('beam constants', () => {
  it('are half-widths, as DoRailCore treats them', () => {
    // Vertices go at +spanWidth and -spanWidth, so a rail core is 12 units across.
    expect(RAIL_CORE_HALF_WIDTH).toBe(6);
    expect(LIGHTNING_HALF_WIDTH).toBe(8);
  });

  it('cover a full turn with four lightning blades', () => {
    // Four double-sided quads 45 degrees apart span 180, which is every orientation.
    expect(LIGHTNING_BLADES * LIGHTNING_BLADE_STEP_DEGREES).toBe(180);
  });

  it('tile the beam texture every 256 units', () => {
    expect(BEAM_TEXTURE_LENGTH).toBe(256);
    expect(RAIL_TRAIL_MS).toBe(400);
  });
});

describe('smoke trails', () => {
  const rocket = TRAIL_STYLES[WP.ROCKET_LAUNCHER]!;
  const grenade = TRAIL_STYLES[WP.GRENADE_LAUNCHER]!;

  it('lays a puff every 50 ms of flight', () => {
    expect(TRAIL_STEP_MS).toBe(50);
  });

  it('grows rather than shrinks, from the 8-unit floor', () => {
    expect(smokeRadius(rocket, 0)).toBe(TRAIL_MIN_RADIUS);
    expect(smokeRadius(rocket, 1)).toBe(rocket.radius + TRAIL_MIN_RADIUS);
    expect(smokeRadius(rocket, 0.5)).toBe(40);
  });

  it('gives the rocket a bigger, longer-lived trail than the grenade', () => {
    // Twice the size, nearly three times the life — a rocket reads as smoke, a grenade as a
    // wisp.
    expect(rocket.radius).toBe(grenade.radius * 2);
    expect(rocket.lifetimeMs).toBe(2000);
    expect(grenade.lifetimeMs).toBe(700);
  });

  it('leaves no trail behind the weapons that have none', () => {
    expect(TRAIL_STYLES[WP.PLASMAGUN]).toBeUndefined();
    expect(TRAIL_STYLES[WP.BFG]).toBeUndefined();
  });
});

describe('the grapple flare', () => {
  it('sits 16 units in front of the hook, toward the viewer', () => {
    // So the wall the hook caught does not cut the sprite in half.
    const at = grappleFlarePosition(vec3(512, 0, 44), vec3(0, 0, 44));
    expect(GRAPPLE_FLARE_PULL).toBe(16);
    expect(at.x).toBeCloseTo(496, 9);
    expect(at.y).toBeCloseTo(0, 9);
    expect(at.z).toBeCloseTo(44, 9);
  });

  it('shimmers between a radius of 9 and 11, re-rolled each frame', () => {
    expect(grappleFlareRadius(() => 0)).toBe(9);
    expect(grappleFlareRadius(() => 0.5)).toBe(10);
    expect(grappleFlareRadius(() => 1)).toBe(11);
  });
});
