import { atof } from '../formats/c-scan';
import type { SpawnVar } from '../formats/entity-text';
import type { ShaderSwap, WorldShader, WorldShaders } from './world-shaders';

/** `MAX_QPATH` less its NUL: what cgame cuts a swap's names to. */
const NAME_LENGTH = 63;

/**
 * The swaps a map's entities can make: each entity's `targetShaderName` and `targetShaderNewName`,
 * where it has both, the last of each key as the game reads them, cut as cgame cuts them.
 */
export function shaderSwaps(entities: readonly (readonly SpawnVar[])[]): ShaderSwap[] {
  const swaps: ShaderSwap[] = [];
  for (const vars of entities) {
    let oldShader: string | undefined;
    let newShader: string | undefined;
    for (const [key, value] of vars) {
      const name = key.toLowerCase();
      if (name === 'targetshadername') oldShader = value;
      if (name === 'targetshadernewname') newShader = value;
    }
    if (oldShader === undefined || newShader === undefined) continue;
    swaps.push({
      oldShader: oldShader.slice(0, NAME_LENGTH),
      newShader: newShader.slice(0, NAME_LENGTH)
    });
  }
  return swaps;
}

/**
 * `R_RemapShader` (`tr_shader.c:68-111`): a shader swapped for another, as cgame asks for each
 * swap in `CS_SHADERSTATE`.
 *
 * Each name is found as it was registered last, at any lightmap index, or else registered at
 * lightmap 0: a swap to a shader the map never drew samples page 0 wherever it draws a lightmap.
 * Then every shader of the old name, at every index, draws the new one, which keeps its own
 * lightmap. A swap back to the old name draws its last registered shader, which draws itself.
 *
 * A surface keeps its own shader's place in the draw order; what it draws there is the new
 * shader's stages, cull, deforms and fog pass, on a clock that starts at the swap's time.
 *
 * @param timeOffset - The swap's time in seconds, as written.
 * @param warn - Where `ri.Printf`'s warnings go.
 * @throws a shader's `ERR_DROP`, as its parse gives it when it is registered
 */
export function remapShader(
  shaders: WorldShaders,
  shaderName: string,
  newShaderName: string,
  timeOffset: string,
  warn: (text: string) => void
): void {
  const fallback = shaders.shaders[0];
  const found = (name: string): WorldShader => {
    const shader = shaders.findByName(name);
    return shader === fallback ? shaders.register(name, 0) : shader;
  };

  const sh = found(shaderName);
  if (sh === fallback) {
    warn(`WARNING: R_RemapShader: shader ${shaderName} not found\n`);
    return;
  }
  const sh2 = found(newShaderName);
  if (sh2 === fallback) {
    warn(`WARNING: R_RemapShader: new shader ${newShaderName} not found\n`);
    return;
  }

  for (const shader of shaders.variants(shaderName)) {
    shader.remappedShader = shader === sh2 ? null : sh2;
  }
  sh2.timeOffset = Math.fround(atof(timeOffset));
}

/** The shader a surface of this one draws with: `RB_BeginSurface`'s (`tr_shade.c:321`). */
export function drawnShader(shader: WorldShader): WorldShader {
  return shader.remappedShader ?? shader;
}
