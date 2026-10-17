import { describe, expect, it } from 'vitest';

import { CONFIGSTRING } from '../net/commands';
import type { GameEntity } from './game-entity';
import type { Level } from './level';
import {
  MAX_SHADER_REMAPS,
  REMAP_OUT_SIZE,
  SHADER_STATE_SIZE,
  addRemap,
  buildShaderStateConfig,
  formatShaderTime,
  type ShaderRemap
} from './shader-remap';
import { useTargets } from './targets';
import {
  newRecord,
  recordingLevel,
  runUntil,
  spawnedLevel,
  useRecorder,
  type LevelRecord
} from './trigger-test-fixtures';

/**
 * `level.time` and the time a swap at it is sent with, as a twin of ioquake3's game QVM writes
 * `level.time * 0.001` at `%5.2f` in q3lcc's floats (scratchpad `m3d/twin.c`). At 505, 565, 4395,
 * 8665 and 8915 doubles would write a hundredth less.
 */
const TWIN: readonly (readonly [number, string])[] = [
  [0, ' 0.00'],
  [1, ' 0.00'],
  [5, ' 0.01'],
  [8, ' 0.01'],
  [300, ' 0.30'],
  [304, ' 0.30'],
  [400, ' 0.40'],
  [505, ' 0.51'],
  [565, ' 0.57'],
  [4395, ' 4.40'],
  [8665, ' 8.67'],
  [8915, ' 8.92'],
  [999, ' 1.00'],
  [1000, ' 1.00'],
  [1005, ' 1.00'],
  [1234, ' 1.23'],
  [1235, ' 1.24'],
  [1236, ' 1.24'],
  [1995, ' 2.00'],
  [1999, ' 2.00'],
  [2005, ' 2.01'],
  [9995, '10.00'],
  [9999, '10.00'],
  [12345, '12.35'],
  [65535, '65.54'],
  [99995, '100.00'],
  [99999, '100.00'],
  [100000, '100.00'],
  [123456, '123.46'],
  [1234567, '1234.57'],
  [16777215, '16777.21'],
  [16777217, '16777.22'],
  [123456789, '123456.80'],
  [2147483000, '2147483.00']
];

/** An entity of `level`'s carrying a swap, and a target if given. */
function swapper(
  level: Level,
  oldShader: string | null,
  newShader: string | null,
  target: string | null = null
): GameEntity {
  const entity = level.spawnEntity();
  entity.classname = 'test_swapper';
  entity.targetShaderName = oldShader;
  entity.targetShaderNewName = newShader;
  entity.target = target;
  return entity;
}

/** The shader state `record`'s level last set. */
const state = (record: LevelRecord) => record.configstrings.get(CONFIGSTRING.SHADERSTATE);

describe("G_UseTargets' shader swap", () => {
  it("sends the level's time as ioquake3's game QVM writes it", () => {
    for (const [time, written] of TWIN) {
      const record = newRecord();
      const level = recordingLevel(record);
      level.time = time;
      const entity = swapper(level, 'textures/a/old', 'textures/a/new');

      useTargets(level, entity, entity, () => {});

      expect(state(record), `at ${time}`).toBe(`textures/a/old=textures/a/new:${written}@`);
    }
  });

  it('swaps before it fires anything, and with no target at all', () => {
    const record = newRecord();
    const level = recordingLevel(record);
    const seen: (string | undefined)[] = [];
    const target = level.spawnEntity();
    target.targetname = 't';
    target.use = () => seen.push(state(record));
    const entity = swapper(level, 'a', 'b', 't');

    useTargets(level, entity, entity, () => {});
    expect(seen).toEqual(['a=b: 0.00@']);

    const untargeted = swapper(level, 'c', 'd');
    useTargets(level, untargeted, untargeted, () => {});
    expect(state(record)).toBe('a=b: 0.00@c=d: 0.00@');
  });

  it('swaps nothing for an entity with one name of the two', () => {
    const record = newRecord();
    const level = recordingLevel(record);
    for (const entity of [swapper(level, 'a', null), swapper(level, null, 'b')]) {
      useTargets(level, entity, entity, () => {});
    }
    expect(state(record)).toBeUndefined();
    expect(level.shaderRemaps).toEqual([]);
  });

  it("swaps as a trigger_always fires, in Quake 3's fourth settle frame", () => {
    const record = newRecord();
    const level = spawnedLevel(
      [
        {
          classname: 'trigger_always',
          targetShaderName: 'gfx/2d/numbers/zero_32b',
          targetShaderNewName: 'textures/tig_gng/_zero_32b'
        }
      ],
      record
    );
    runUntil(level, 296);
    expect(state(record)).toBeUndefined();

    runUntil(level, 304);
    expect(state(record)).toBe('gfx/2d/numbers/zero_32b=textures/tig_gng/_zero_32b: 0.30@');
  });

  it("starts each level with none of the last one's swaps", () => {
    const record = newRecord();
    const before = recordingLevel(record);
    const first = swapper(before, 'a', 'b');
    useTargets(before, first, first, () => {});

    // A `map_restart` builds the level again, and the host keeps the configstring until the next
    // swap writes the new level's.
    const after = recordingLevel(record);
    const second = swapper(after, 'c', 'd');
    useTargets(after, second, second, () => {});

    expect(state(record)).toBe('c=d: 0.00@');
  });

  it('fires the targets as ever after swapping', () => {
    const level = recordingLevel();
    const fired = useRecorder(level, 't');
    const entity = swapper(level, 'a', 'b', 't');

    useTargets(level, entity, entity, () => {});

    expect(fired).toEqual([{ other: entity.s.number, activator: entity.s.number }]);
  });
});

describe('addRemap', () => {
  it('puts a swap made again in its place, found by its name in any case', () => {
    const remaps: ShaderRemap[] = [];
    addRemap(remaps, 'textures/A/ghost', 'textures/a/scared', 1);
    addRemap(remaps, 'textures/a/cherry', 'textures/a/nocherry', 2);
    addRemap(remaps, 'TEXTURES/a/GHOST', 'textures/a/fade', 3);

    expect(remaps).toEqual([
      { oldShader: 'textures/A/ghost', newShader: 'textures/a/fade', timeOffset: 3 },
      { oldShader: 'textures/a/cherry', newShader: 'textures/a/nocherry', timeOffset: 2 }
    ]);
  });

  it('keeps 128 swaps, and drops a new one past them', () => {
    expect(MAX_SHADER_REMAPS).toBe(128);
    const remaps: ShaderRemap[] = [];
    for (let i = 0; i <= 128; i++) addRemap(remaps, `old${i}`, 'new', 0);
    expect(remaps).toHaveLength(128);
    expect(remaps.at(-1)!.oldShader).toBe('old127');

    // One already there is still swapped again.
    addRemap(remaps, 'old0', 'other', 5);
    expect(remaps[0]).toEqual({ oldShader: 'old0', newShader: 'other', timeOffset: 5 });
  });
});

describe('formatShaderTime', () => {
  it('rounds the hundredths half up and carries a hundred of them, padded to five', () => {
    expect(formatShaderTime(Math.fround(0.995))).toBe(' 1.00');
    expect(formatShaderTime(Math.fround(0.125))).toBe(' 0.13');
    expect(formatShaderTime(Math.fround(0.004))).toBe(' 0.00');
    expect(formatShaderTime(Math.fround(-1.5))).toBe('-1.50');
    expect(formatShaderTime(Math.fround(12345.5))).toBe('12345.50');
  });
});

describe('buildShaderStateConfig', () => {
  it("cuts a swap too long for its buffer, with Com_sprintf's line", () => {
    const prints: string[] = [];
    const name = 'n'.repeat(63);
    const remaps = [{ oldShader: name, newShader: name, timeOffset: Math.fround(0.3) }];

    const built = buildShaderStateConfig(remaps, (text) => prints.push(text));

    // 63 + 1 + 63 + 1 + 5 + 1 characters, and the buffer holds one less than its size.
    expect(prints).toEqual([
      `Com_sprintf: Output length ${REMAP_OUT_SIZE} too short, require 135 bytes.`
    ]);
    expect(built).toBe(`${name}=${name}: 0.3`);
    expect(built).toHaveLength(REMAP_OUT_SIZE - 1);

    // One character shorter is a character too long still: its NUL has no room.
    prints.length = 0;
    const shorter = [{ ...remaps[0], oldShader: name.slice(1) }];
    expect(buildShaderStateConfig(shorter, (text) => prints.push(text))).toHaveLength(132);
    expect(prints).toEqual([
      `Com_sprintf: Output length ${REMAP_OUT_SIZE} too short, require 134 bytes.`
    ]);
  });

  it('cuts the whole to its own buffer', () => {
    const remaps = Array.from({ length: 100 }, (_, i) => ({
      oldShader: `textures/map/old_shader_${String(i).padStart(2, '0')}`,
      newShader: `textures/map/new_shader_${String(i).padStart(2, '0')}`,
      timeOffset: 0
    }));

    const built = buildShaderStateConfig(remaps, () => {});

    expect(built).toHaveLength(SHADER_STATE_SIZE - 1);
    expect(built.startsWith('textures/map/old_shader_00=textures/map/new_shader_00: 0.00@')).toBe(
      true
    );
  });
});
