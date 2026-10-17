import { describe, expect, it } from 'vitest';

import { vec3 } from '../sim/vec3';
import { isViewpos, viewpos } from './viewpos';

describe('viewpos', () => {
  it('prints the view origin and the yaw as CG_Viewpos_f does', () => {
    expect(viewpos({ origin: vec3(-4, -4, 69), angles: vec3(10, 90, 0) })).toBe('(-4 -4 69) : 90');
  });

  it('truncates towards zero, as a cast to int does', () => {
    const reading = viewpos({ origin: vec3(1056.9, -2016.9, 0.5), angles: vec3(0, 241.99, 0) });
    expect(reading).toBe('(1056 -2016 0) : 241');
  });

  it('prints a small negative as 0, not -0', () => {
    expect(viewpos({ origin: vec3(-0.4, -0.9, 0), angles: vec3(0, -0.5, 0) })).toBe('(0 0 0) : 0');
  });

  it('prints the yaw as the view holds it, unwrapped', () => {
    // Q3 prints `refdefViewAngles[YAW]` as it is, and a map's `angle` takes any number of turns.
    expect(viewpos({ origin: vec3(), angles: vec3(0, -90, 0) })).toBe('(0 0 0) : -90');
    expect(viewpos({ origin: vec3(), angles: vec3(0, 450, 0) })).toBe('(0 0 0) : 450');
  });
});

describe('isViewpos', () => {
  it('matches the name without regard to case, and nothing else', () => {
    expect(isViewpos(['viewpos'])).toBe(true);
    expect(isViewpos(['ViewPos'])).toBe(true);
    expect(isViewpos(['viewposition'])).toBe(false);
    expect(isViewpos([])).toBe(false);
  });
});
