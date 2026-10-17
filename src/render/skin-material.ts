import type { AppBase, StandardMaterial } from 'playcanvas';

import type { AssetLibrary } from '../formats/asset-library';
import { findShader, type ShaderScript, type ShaderStage } from '../formats/shader-script';
import { fogAdjustment } from '../view/world-shaders';
import { createStage, type EffectStage, type ImageSource } from './effect-material';
import { setGain } from './stage-gain';
import { q3CullMode } from './md3-mesh';
import type { ResourceScope } from './texture-cache';
import { withWhiteImage } from './white-image';

/**
 * The materials a player's skin draws with, and a weapon's.
 *
 * A skin names a shader for each surface, and Q3 draws every stage of it as a pass of its own
 * over the surface: here one material each, drawn in declaration order, as the effects draw
 * theirs. A weapon draws the shaders its MD3 names the same way. What sets these stages
 * apart from an effect's:
 * - A stage with `rgbGen lightingDiffuse` is lit: its vertex colours carry half the entity light's
 *   shade, and its material doubles them.
 * - A `$whiteimage` stage draws the white image, as Q3 binds it. Several skins lay a lit white
 *   base under a blended texture, xaero's and tankjr's among them; without it they would be
 *   see-through.
 * - A stage with `alphaGen lightingSpecular` shines: its vertex colours' alpha carries a highlight,
 *   by where the viewer is. Several skins multiply their white base by their texture with
 *   `GL_DST_COLOR GL_SRC_ALPHA`, which adds that highlight where the texture's alpha lets it.
 * - A stage with `tcGen environment` mirrors: it reads coordinates its model makes every frame,
 *   from the view mirrored in each vertex's normal. razor's goggles and crash's suit are drawn so.
 *
 * A name with no script draws Q3's default shader for that image (`R_FindShader`): one stage,
 * opaque and lit.
 */

/** One stage of a skin's shader, ready to draw over a surface. */
export interface SkinStage extends EffectStage {
  /** `rgbGen lightingDiffuse`: drawn with the entity light's shade in its vertex colours. */
  lit: boolean;
  /** `alphaGen lightingSpecular`: drawn with a highlight in its vertex colours' alpha. */
  specular: boolean;
  /**
   * Writes depth, so it draws with the surface in World; a stage that does not draws over what
   * is there, with the effects.
   */
  depthWrite: boolean;
}

/**
 * `vertexColorGamma` is installed at runtime but missing from the engine's typings; see
 * `createSurfaceMaterial`.
 */
type GammaVertexColorMaterial = StandardMaterial & { vertexColorGamma: boolean };

/** The stage `R_FindShader` makes for an image with no script: the image, opaque, lit. */
function defaultStage(image: string): ShaderStage {
  return {
    maps: [image],
    animFps: 0,
    blend: 'opaque',
    depthWrite: true,
    clamp: false,
    texMods: [],
    rgbGen: 'lightingDiffuse'
  };
}

/** Where a skin's stages are read from: the shader scripts, and the images. */
export type SkinSource = ImageSource & Pick<AssetLibrary, 'shaders'>;

/**
 * The shader a skin, or a weapon's MD3, names for one surface, and the stages of it drawn.
 *
 * A stage drawing only `$lightmap` is left out: a model has no lightmap. A script with no stages
 * draws nothing, as Q3 draws it into depth alone. A surface the skin names nothing for gets Q3's
 * default shader, which the port draws as a plain lit stage with no image.
 *
 * @param shaderName - As the `.skin` names it, extension and all; `''` for none.
 */
export function skinShaderStages(
  shaders: SkinSource['shaders'],
  shaderName: string
): { shader: ShaderScript | undefined; stages: ShaderStage[] } {
  const shader = shaderName ? findShader(shaders, shaderName) : undefined;
  const stages = shader
    ? shader.stages.filter((stage) => stage.maps.some((map) => map !== '$lightmap'))
    : [defaultStage(shaderName)];
  return { shader, stages };
}

/**
 * Build every stage of the shader a skin, or a weapon's MD3, names for one surface
 * ({@link skinShaderStages}).
 *
 * @param shaderName - As the `.skin` names it, extension and all; `''` for none.
 * @param scope - Holds the materials and textures, given back with the model; without one they
 *   are made for good.
 */
export async function createSkinStages(
  app: AppBase,
  library: SkinSource,
  shaderName: string,
  scope?: ResourceScope
): Promise<SkinStage[]> {
  const { shader, stages } = skinShaderStages(library.shaders, shaderName);
  const cull = q3CullMode(shader?.cull);
  const mipmaps = !shader?.noMipMaps;
  const images = withWhiteImage(library);

  const built: SkinStage[] = [];
  for (const stage of stages) {
    const effect = await createStage(app, images, stage, cull, mipmaps, scope);
    const { material } = effect;
    const lit = stage.rgbGen === 'lightingDiffuse';
    if (lit) {
      // On screen its vertex colours hold half the shade, and this doubles them back at the
      // stage's gain, as playing it does: 1, but under `opengl1` a stage that multiplies colour is
      // never brightened by the ramp, as one that adds is.
      material.emissiveVertexColor = true;
      (material as GammaVertexColorMaterial).vertexColorGamma = true;
      setGain(material, stage, { lit: true });
    }
    material.update();
    const specular = stage.alphaGen === 'lightingSpecular';
    const fog = shader ? fogAdjustment(stage, shader.stages[0]) : 'none';
    built.push({ ...effect, lit, specular, depthWrite: stage.depthWrite, fog });
  }
  return built;
}
