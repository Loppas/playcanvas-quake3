import type { AppBase } from 'playcanvas';

import type { Md3Model, Md3Surface } from '../formats/md3';
import type { ShaderScript, ShaderStage } from '../formats/shader-script';
import { fogAdjustment } from '../view/world-shaders';
import { bodyPlacement, type PlayerRigOptions } from './player-rig';
import { skinShaderStages, type SkinSource } from './skin-material';
import { buildStagedModel } from './staged-model';
import type { TextureCache } from './texture-cache';
import type { Warmed } from './warm-up';
import { WHITE_IMAGE_PATH, whiteImageTga } from './white-image';

/**
 * Every kind of stage the paks' player looks draw, for the warm-up (`warm-up.ts`), so that a look's
 * first join makes nothing. Quake 3 loads a look as it joins (`CG_LoadClientInfo`,
 * `cg_players.c:652-734`), reading its files and uploading its images, but `opengl1` has no program
 * to compile for it.
 *
 * Two stages are of a kind where the device makes one shader and one pipeline for both: the same
 * blend factors, alpha test and depth write, lit or not, shining or not, mirroring or not, moved by
 * `tcMod`s or not, with an image or none, dimmed by a fog alike, under the same cull and deforms.
 * Their images, numbers and colours only feed those. A stand-in draws a surface of one shader of
 * each kind, its images all white.
 */

/**
 * A skin's stage's kind, as a key.
 *
 * @param shader - Its script; none for Q3's default shader.
 * @param hasImage - Whether the paks hold an image, as a stage with none draws its colour alone.
 */
export function stageKind(
  shader: ShaderScript | undefined,
  stage: ShaderStage,
  hasImage: (name: string) => boolean
): string {
  const image = stage.maps.some((map) => map.toLowerCase() === '$whiteimage' || hasImage(map));
  return JSON.stringify([
    stage.blendFactors ?? null,
    stage.alphaFunc ?? null,
    stage.depthWrite,
    image,
    stage.rgbGen === 'lightingDiffuse',
    stage.alphaGen === 'lightingSpecular',
    stage.tcGen === 'environment',
    stage.texMods.length > 0,
    shader ? fogAdjustment(stage, shader.stages[0]) : 'none',
    shader?.cull ?? 'front',
    shader?.deforms.map((deform) => deform.type) ?? []
  ]);
}

/**
 * The shaders among `names` that draw every kind of stage any of them draws
 * ({@link stageKind}): each the first to draw a kind, in the order given.
 */
export function kindShaders(
  shaders: SkinSource['shaders'],
  names: Iterable<string>,
  hasImage: (name: string) => boolean
): string[] {
  const kinds = new Set<string>();
  const picked: string[] = [];
  for (const name of names) {
    const { shader, stages } = skinShaderStages(shaders, name);
    const fresh = stages
      .map((stage) => stageKind(shader, stage, hasImage))
      .filter((kind) => !kinds.has(kind));
    if (fresh.length === 0) continue;
    for (const kind of fresh) kinds.add(kind);
    picked.push(name);
  }
  return picked;
}

/** A square a unit a side, facing up, as one of the stand-in's surfaces. */
function standInSurface(index: number): Md3Surface {
  return {
    name: `kind${index}`,
    shaders: [],
    numVerts: 4,
    indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
    uvs: Float32Array.of(0, 0, 1, 0, 1, 1, 0, 1),
    frames: [
      {
        positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0),
        normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1)
      }
    ]
  };
}

/** The stand-in: `count` squares. */
function standInModel(count: number): Md3Model {
  return {
    name: 'look-kinds',
    numFrames: 1,
    frames: [{ mins: [0, 0, 0], maxs: [1, 1, 0], localOrigin: [0, 0, 0], radius: 1, name: '' }],
    tagNames: [],
    tags: [[]],
    surfaces: Array.from({ length: count }, (_, index) => standInSurface(index))
  };
}

/**
 * The warm-up's stand-in for every kind of stage `names` draw: a surface of each of
 * {@link kindShaders}, built hidden where a body draws, shown for the warm-up, then let go.
 *
 * It sorts as Q3's default shader, so none of its shaders is registered in the map's order before
 * cgame registers it with its look.
 *
 * @param names - Every shader the paks' skins name.
 * @param hasImage - Whether the paks hold an image.
 * @param options - Where a body draws.
 */
export async function warmLookKinds(
  app: AppBase,
  shaders: SkinSource['shaders'],
  cache: TextureCache,
  names: Iterable<string>,
  hasImage: (name: string) => boolean,
  options: PlayerRigOptions
): Promise<Warmed> {
  const picked = kindShaders(shaders, names, hasImage);
  const source: SkinSource = {
    shaders,
    resolveImage: (reference) => (hasImage(reference) ? WHITE_IMAGE_PATH : undefined),
    read: () => whiteImageTga()
  };
  const model = standInModel(picked.length);
  const shaderOf = (surface: Md3Surface) => picked[model.surfaces.indexOf(surface)];
  const scope = cache.scope();
  let built;
  try {
    const layers = bodyPlacement(options, '');
    built = await buildStagedModel(app, source, scope, model.name, model, shaderOf, layers, []);
  } catch (error) {
    scope.dispose();
    throw error;
  }
  const { entity } = built;
  entity.enabled = false;
  app.root.addChild(entity);
  return {
    at: () => {
      entity.enabled = true;
    },
    end: () => {
      entity.destroy();
      scope.dispose();
    }
  };
}
