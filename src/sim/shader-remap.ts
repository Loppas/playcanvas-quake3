import { MAX_STRING_CHARS } from '../net/msg';
import { f } from './cm/q-math';

/**
 * `G_UseTargets`' shader swap (`g_utils.c:27–68`): the shaders a level's entities have swapped,
 * which every client is sent as `CS_SHADERSTATE`. A client's renderer draws each swapped shader's
 * surfaces with its replacement from then on, its animation starting at the swap.
 */

/** `MAX_SHADER_REMAPS` (`g_utils.c:33`): how many swaps a level keeps. */
export const MAX_SHADER_REMAPS = 128;

/** `MAX_QPATH` (`q_shared.h:246`). */
const MAX_QPATH = 64;

/** The size of the buffer each swap is written into (`g_utils.c:59`). */
export const REMAP_OUT_SIZE = MAX_QPATH * 2 + 5;

/** The size of the buffer the whole state is built in (`g_utils.c:58`). */
export const SHADER_STATE_SIZE = MAX_STRING_CHARS * 4;

/** One swap: the shader swapped, what for, and when, in seconds. */
export interface ShaderRemap {
  oldShader: string;
  newShader: string;
  /** The level's time at the swap, in seconds, a float. */
  timeOffset: number;
}

/**
 * `AddRemap` (`g_utils.c:38–55`): a swap made again, of a shader found by its name in any case,
 * takes its place in the list; a new one goes at the end, unless the list is full.
 */
export function addRemap(
  remaps: ShaderRemap[],
  oldShader: string,
  newShader: string,
  timeOffset: number
): void {
  const key = oldShader.toLowerCase();
  const found = remaps.find((remap) => remap.oldShader.toLowerCase() === key);
  if (found) {
    found.newShader = newShader;
    found.timeOffset = timeOffset;
  } else if (remaps.length < MAX_SHADER_REMAPS) {
    remaps.push({ oldShader, newShader, timeOffset });
  }
}

/*
 * formatShaderTime translates part of fmtfp, which carries this notice:
 *
 * Copyright Patrick Powell 1995
 * This code is based on code written by Patrick Powell (papowell@astart.com)
 * It may be used for any purpose as long as this notice remains intact
 * on all source code distributions
 */

/**
 * `%5.2f` as ioquake3's game QVM writes it (`fmtfp`, `bg_lib.c:1915–2052`), in its floats: the
 * whole part, and the hundredths rounded half up from what is left, a hundred of them carried.
 * id's 1.32 cut the hundredths off instead.
 */
export function formatShaderTime(seconds: number): string {
  const magnitude = Math.abs(seconds);
  let whole = Math.trunc(magnitude);
  const scaled = f(100 * f(magnitude - whole));
  let hundredths = Math.trunc(scaled);
  if (f(scaled - hundredths) >= 0.5) hundredths++;
  if (hundredths >= 100) {
    whole++;
    hundredths -= 100;
  }
  const sign = seconds < 0 ? '-' : '';
  return `${sign}${whole}.${String(hundredths).padStart(2, '0')}`.padStart(5);
}

/**
 * `BuildShaderStateConfig` (`g_utils.c:57–68`): each swap as `old=new:time@`, one after another.
 * A swap too long for its buffer is cut, with `Com_sprintf`'s line, and the whole is cut to its
 * own buffer.
 *
 * @param print - Where `Com_Printf` goes.
 */
export function buildShaderStateConfig(
  remaps: readonly ShaderRemap[],
  print: (text: string) => void
): string {
  let state = '';
  for (const { oldShader, newShader, timeOffset } of remaps) {
    let out = `${oldShader}=${newShader}:${formatShaderTime(timeOffset)}@`;
    if (out.length >= REMAP_OUT_SIZE) {
      const size = REMAP_OUT_SIZE;
      print(`Com_sprintf: Output length ${size} too short, require ${out.length + 1} bytes.`);
      out = out.slice(0, REMAP_OUT_SIZE - 1);
    }
    state = (state + out).slice(0, SHADER_STATE_SIZE - 1);
  }
  return state;
}
