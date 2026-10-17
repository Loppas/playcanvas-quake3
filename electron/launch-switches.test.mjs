import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UNPACED_SWITCHES, configVsync, launchSwitches, launchVsync } from './launch-switches.mjs';

describe('configVsync', () => {
  it('reads r_swapInterval as the page does: the last set, any whole number but 0 on', () => {
    expect(configVsync('seta r_swapInterval "0"\n')).toBe(false);
    expect(configVsync('seta r_swapInterval "0"\nseta r_swapInterval "2"\n')).toBe(true);
    expect(configVsync('set R_SWAPINTERVAL 0')).toBe(false);
    expect(configVsync('r_swapInterval 0')).toBe(false);
    expect(configVsync('seta cg_fov "100"; r_swapInterval "0" // off')).toBe(false);
  });

  it('is on, the default, where nothing sets it', () => {
    expect(configVsync('')).toBe(true);
    expect(configVsync('seta r_swapIntervals "0"\n// seta r_swapInterval "0"\n')).toBe(true);
    // A name alone only prints the value.
    expect(configVsync('seta r_swapInterval\nr_swapInterval')).toBe(true);
  });

  it('refuses what is not a whole number, as the page does, and keeps the value before', () => {
    expect(configVsync('seta r_swapInterval "0"\nseta r_swapInterval "off"')).toBe(false);
    expect(configVsync('seta r_swapInterval "0.5"')).toBe(true);
    expect(configVsync('seta r_swapInterval ""')).toBe(true);
  });
});

describe('launchVsync', () => {
  let home;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pcq-launch-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads fs_homepath's q3config.cfg, and is on before there is one", () => {
    expect(launchVsync(join(home, 'none'))).toBe(true);
    mkdirSync(join(home, 'game'));
    writeFileSync(join(home, 'game', 'q3config.cfg'), 'unbindall\nseta r_swapInterval "0"\n');
    expect(launchVsync(join(home, 'game'))).toBe(false);
  });
});

describe('launchSwitches', () => {
  it("lifts Chromium's pace with vertical sync off, and leaves it with it on", () => {
    expect(launchSwitches(false)).toEqual(['disable-frame-rate-limit', 'disable-gpu-vsync']);
    expect(launchSwitches(false)).toBe(UNPACED_SWITCHES);
    expect(launchSwitches(true)).toEqual([]);
  });
});
