/**
 * `CG_ShaderStateChanged` (`cg_servercmds.c:238–281`): the shader swaps `CS_SHADERSTATE` lists,
 * each `old=new:time@`, which cgame hands to the renderer one by one, every swap again each time
 * the string changes and once more at the end of its load.
 */

/** One swap as cgame hands it on: the time as written, which the renderer reads. */
export interface ShaderStateEntry {
  oldShader: string;
  newShader: string;
  timeOffset: string;
}

/** The buffers each part is cut to fit with its NUL: `MAX_QPATH` for a name, 16 for the time. */
const NAME_SIZE = 64;
const TIME_SIZE = 16;

/**
 * The swaps of a `CS_SHADERSTATE`, in order. Reading stops at an entry with no `=` or `:`, and an
 * entry with no `@` after it is not handed on.
 */
export function parseShaderState(state: string): ShaderStateEntry[] {
  const entries: ShaderStateEntry[] = [];
  let at = 0;
  while (at < state.length) {
    const equals = state.indexOf('=', at);
    if (equals < 0) break;
    const colon = state.indexOf(':', equals + 1);
    if (colon < 0) break;
    const end = state.indexOf('@', colon + 1);
    if (end < 0) break;
    entries.push({
      oldShader: state.slice(at, Math.min(equals, at + NAME_SIZE - 1)),
      newShader: state.slice(equals + 1, Math.min(colon, equals + NAME_SIZE)),
      timeOffset: state.slice(colon + 1, Math.min(end, colon + TIME_SIZE))
    });
    at = end + 1;
  }
  return entries;
}
