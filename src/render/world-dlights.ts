import {
  ADDRESS_CLAMP_TO_EDGE,
  BLENDEQUATION_ADD,
  BLENDMODE_DST_COLOR,
  BLENDMODE_ONE,
  BLENDMODE_ZERO,
  BUFFER_DYNAMIC,
  BlendState,
  FILTER_LINEAR,
  FUNC_EQUAL,
  INDEXFORMAT_UINT32,
  IndexBuffer,
  Mesh,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  PRIMITIVE_TRIANGLES,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  StandardMaterial,
  Texture,
  type GraphNode,
  type GraphicsDevice,
  type Layer,
  type VertexBuffer
} from 'playcanvas';

import { DLIGHT_SIZE, dlightTexel, type ProjectedLight } from '../view/dynamic-lights';
import { MODEL_CHUNKS_VERSION } from './model-chunks';
import type { ResourceScope } from './texture-cache';

/**
 * The world's dynamic lights as opengl1 draws them: each batch a light reaches drawn again after
 * its stages, once for each light, with the light's image projected down the batch's z and its
 * colour fading with height (`ProjectDlightTexture`, `tr_shade.c:407-557`). The triangles a pass
 * draws are those the light reaches (`view/world-dlights.ts`), written each frame into one index
 * buffer; each vertex's place on the image and its colour's bytes are worked out in the vertex
 * code, from the batch's own vertexes, so its depths are the stages' to the bit and `GL_EQUAL`
 * meets them.
 */

/** A pass's light: its origin in the batch's frame and its radius, then its colour × 255 and 1/r.
 */
export const DLIGHT_UNIFORM = 'q3_dlight[0]';

/** `ProjectDlightTexture`'s vertex arithmetic (`view/dynamic-lights.ts`' `dlightVertex`). */
const DLIGHT_VS = {
  glsl: `
uniform vec4 q3_dlight[2];
varying vec3 q3DlightColor;
vec2 q3DlightTexCoords(vec3 v) {
	return 0.5 + (q3_dlight[0].xy - v.xy) * q3_dlight[1].w;
}
`,
  wgsl: `
uniform q3_dlight: array<vec4f, 2>;
varying q3DlightColor: vec3f;
fn q3DlightTexCoords(v: vec3f) -> vec2f {
	return 0.5 + (uniform.q3_dlight[0].xy - v.xy) * uniform.q3_dlight[1].w;
}
`
};

/** The colour: what reaches the vertex's height, its bytes truncated and wrapped as a long's. */
const DLIGHT_COLOR = {
  glsl: `
	float q3Height = q3_dlight[0].z - vertex_position.z;
	float q3Radius = q3_dlight[0].w;
	float q3Modulate = 0.0;
	if (q3Height <= q3Radius && q3Height >= -q3Radius) {
		float q3Up = abs(q3Height);
		q3Modulate = q3Up < q3Radius * 0.5 ? 1.0 : 2.0 * (q3Radius - q3Up) * q3_dlight[1].w;
	}
	q3DlightColor = mod(floor(q3_dlight[1].xyz * q3Modulate), 256.0) / 255.0;
`,
  wgsl: `
	let q3Height = uniform.q3_dlight[0].z - vertex_position.z;
	let q3Radius = uniform.q3_dlight[0].w;
	var q3Modulate = 0.0;
	if (q3Height <= q3Radius && q3Height >= -q3Radius) {
		let q3Up = abs(q3Height);
		q3Modulate = select(2.0 * (q3Radius - q3Up) * uniform.q3_dlight[1].w, 1.0, q3Up < q3Radius * 0.5);
	}
	output.q3DlightColor = (floor(uniform.q3_dlight[1].xyz * q3Modulate) % vec3f(256.0)) / 255.0;
`
};

/**
 * The pass's chunks: the image's coordinates in place of the vertexes' own, and its texel
 * modulated by the colour's bytes, as `GL_MODULATE` does, in what it writes.
 */
export const DLIGHT_PASS_CHUNKS = {
  glsl: new Map([
    ['litUserDeclarationVS', DLIGHT_VS.glsl],
    ['uv0VS', '\nvec2 getUv0() {\n\treturn q3DlightTexCoords(vertex_position.xyz);\n}\n'],
    ['litUserMainEndVS', DLIGHT_COLOR.glsl],
    ['litUserDeclarationPS', '\nvarying vec3 q3DlightColor;\n'],
    ['litUserMainEndPS', '\n\tgl_FragColor.rgb *= q3DlightColor;\n']
  ]),
  wgsl: new Map([
    ['litUserDeclarationVS', DLIGHT_VS.wgsl],
    ['uv0VS', '\nfn getUv0() -> vec2f {\n\treturn q3DlightTexCoords(vertex_position.xyz);\n}\n'],
    ['litUserMainEndVS', DLIGHT_COLOR.wgsl],
    ['litUserDeclarationPS', '\nvarying q3DlightColor: vec3f;\n'],
    [
      'litUserMainEndPS',
      '\n\toutput.color = vec4f(output.color.rgb * q3DlightColor, output.color.a);\n'
    ]
  ])
};

/**
 * How a light's pass blends: `GL_DST_COLOR GL_ONE`, what is there times one and the light, or
 * `GL_ONE GL_ONE` for a light that adds; the framebuffer's alpha kept, as the stages keep it.
 */
const DLIGHT_BLEND = new BlendState(
  true,
  BLENDEQUATION_ADD,
  BLENDMODE_DST_COLOR,
  BLENDMODE_ONE,
  BLENDEQUATION_ADD,
  BLENDMODE_ZERO,
  BLENDMODE_ONE
);
const ADDITIVE_BLEND = new BlendState(
  true,
  BLENDEQUATION_ADD,
  BLENDMODE_ONE,
  BLENDMODE_ONE,
  BLENDEQUATION_ADD,
  BLENDMODE_ZERO,
  BLENDMODE_ONE
);

/** `tr.dlightImage`, made once a device. */
const dlightImages = new WeakMap<GraphicsDevice, Texture>();

/**
 * `R_CreateDlightImage` (`tr_image.c:1073-1099`): 16 texels a side, unmipped, filtered and clamped
 * to its edge.
 */
export function dlightImage(device: GraphicsDevice): Texture {
  let image = dlightImages.get(device);
  if (!image) {
    image = new Texture(device, {
      name: '*dlight',
      width: DLIGHT_SIZE,
      height: DLIGHT_SIZE,
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: FILTER_LINEAR,
      magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE
    });
    const texels = image.lock() as Uint8Array;
    for (let y = 0; y < DLIGHT_SIZE; y++) {
      for (let x = 0; x < DLIGHT_SIZE; x++) {
        const at = (y * DLIGHT_SIZE + x) * 4;
        texels.fill(dlightTexel(x, y), at, at + 3);
        texels[at + 3] = 255;
      }
    }
    image.unlock();
    dlightImages.set(device, image);
  }
  return image;
}

/**
 * A light's pass as `ProjectDlightTexture` draws it: the light's image, white at its texels'
 * bytes, times the colour each vertex works out, over what the batch's stages drew. It writes no
 * depth and tests it equal, so an alpha-tested hole takes no light.
 *
 * @param cull - The batch's shader's, as `q3CullMode` maps it.
 * @param additive - A light that adds (`GL_ONE GL_ONE`), which baseq3 never makes.
 */
export function dlightPassMaterial(
  device: GraphicsDevice,
  cull: number,
  additive: boolean,
  scope: ResourceScope
): StandardMaterial {
  const material = scope.own(new StandardMaterial());
  material.useLighting = false;
  material.diffuse.set(0, 0, 0);
  material.emissive.set(1, 1, 1);
  material.emissiveMap = dlightImage(device);
  material.emissiveMapUv = 0;
  material.blendState = additive ? ADDITIVE_BLEND : DLIGHT_BLEND;
  material.depthWrite = false;
  material.depthFunc = FUNC_EQUAL;
  material.cull = cull;
  const glsl = material.getShaderChunks(SHADERLANGUAGE_GLSL);
  const wgsl = material.getShaderChunks(SHADERLANGUAGE_WGSL);
  for (const [name, code] of DLIGHT_PASS_CHUNKS.glsl) glsl.set(name, code);
  for (const [name, code] of DLIGHT_PASS_CHUNKS.wgsl) wgsl.set(name, code);
  material.shaderChunksVersion = MODEL_CHUNKS_VERSION;
  material.setParameter(DLIGHT_UNIFORM, new Float32Array(8));
  material.update();
  return material;
}

/** A pass's light as its draw reads it ({@link DLIGHT_UNIFORM}). */
export function writeDlight(light: ProjectedLight, data: Float32Array): void {
  data[0] = light.origin[0];
  data[1] = light.origin[1];
  data[2] = light.origin[2];
  data[3] = light.radius;
  data[4] = light.color[0];
  data[5] = light.color[1];
  data[6] = light.color[2];
  data[7] = light.scale;
}

/** One of a material's pass draws, given a batch and a light each frame it is used. */
export interface PassDraw {
  readonly instance: MeshInstance;
  readonly mesh: Mesh;
  readonly data: Float32Array;
  /** What it draws this frame, for its key: its run, its batch and its light. */
  run: number;
  batch: number;
  light: number;
}

/** A material's draws, and how many of them the frame has given out. */
interface Pool {
  draws: PassDraw[];
  used: number;
}

/** The first room the frame's indexes are made with; it doubles as a frame needs more. */
const FIRST_ROOM = 1 << 16;

/** The world's light passes: a pool of draws for each material, and the frame's indexes. */
export class WorldDlights {
  private readonly device: GraphicsDevice;
  private readonly layer: Layer;
  private readonly scope: ResourceScope;
  /** Each material, by its cull, whether it is pulled toward the viewer, and its blend. */
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly pools = new Map<StandardMaterial, Pool>();
  /** Pulls a `polygonOffset` shader's pass as its stages are pulled. */
  private readonly pull: (material: StandardMaterial) => void;
  private storage = new Uint32Array(FIRST_ROOM);
  private indexes: IndexBuffer;
  /** How many of the frame's indexes are written. */
  private used = 0;
  /** The draws given out this frame, the first {@link count} of them, in the order given. */
  readonly given: PassDraw[] = [];
  count = 0;

  constructor(
    device: GraphicsDevice,
    layer: Layer,
    scope: ResourceScope,
    pull: (material: StandardMaterial) => void
  ) {
    this.device = device;
    this.layer = layer;
    this.scope = scope;
    this.pull = pull;
    this.indexes = this.indexBuffer();
  }

  /** The material for passes over a shader drawn so, made at its first asking. */
  material(cull: number, pulled: boolean, additive: boolean): StandardMaterial {
    const key = `${cull} ${pulled} ${additive}`;
    let made = this.materials.get(key);
    if (!made) {
      made = dlightPassMaterial(this.device, cull, additive, this.scope);
      if (pulled) {
        this.pull(made);
        made.update();
      }
      this.materials.set(key, made);
      this.pools.set(made, { draws: [], used: 0 });
    }
    return made;
  }

  /** Every material made, for the warm-up. */
  get made(): readonly StandardMaterial[] {
    return [...this.materials.values()];
  }

  /** A frame's passes begin: none given out, no index written. */
  begin(): void {
    this.used = 0;
    this.count = 0;
    for (const pool of this.pools.values()) pool.used = 0;
  }

  /**
   * Room for `count` more of the frame's indexes, made if the frame needs more than it has.
   *
   * @returns The indexes' storage, to write from {@link written} on.
   */
  room(count: number): Uint32Array {
    const need = this.used + count;
    if (need <= this.storage.length) return this.storage;
    let length = this.storage.length;
    while (length < need) length *= 2;
    const storage = new Uint32Array(length);
    storage.set(this.storage.subarray(0, this.used));
    this.storage = storage;
    this.indexes.destroy();
    this.indexes = this.indexBuffer();
    for (const pool of this.pools.values()) {
      for (const draw of pool.draws) draw.mesh.indexBuffer[0] = this.indexes;
    }
    return storage;
  }

  /** How many of the frame's indexes are written. */
  get written(): number {
    return this.used;
  }

  /**
   * A pass drawn this frame over the `count` indexes last written from {@link written}.
   *
   * @param vertices - The buffer the indexes number: the world's, or the deformed runs'.
   * @param node - The batch's: the world's, or its brush model's.
   */
  draw(
    material: StandardMaterial,
    count: number,
    vertices: VertexBuffer,
    node: GraphNode,
    light: ProjectedLight
  ): PassDraw {
    const pool = this.pools.get(material)!;
    const draw = pool.draws[pool.used] ?? this.make(material, pool);
    pool.used++;
    const { instance, mesh } = draw;
    mesh.vertexBuffer = vertices;
    const primitive = mesh.primitive[0];
    primitive.base = this.used;
    primitive.count = count;
    this.used += count;
    if (instance.node !== node) instance.node = node;
    writeDlight(light, draw.data);
    instance.visible = true;
    this.given[this.count++] = draw;
    return draw;
  }

  /** The frame's passes all given: their indexes uploaded, and the draws not given hidden. */
  end(): void {
    if (this.used > 0) this.indexes.unlock(0, this.used * 4);
    for (const pool of this.pools.values()) {
      for (let i = pool.used; i < pool.draws.length; i++) pool.draws[i].instance.visible = false;
    }
  }

  /** Take every draw out of the layer and free them, and the frame's indexes. */
  destroy(): void {
    for (const pool of this.pools.values()) {
      const instances = pool.draws.map((draw) => draw.instance);
      this.layer.removeMeshInstances(instances, true);
      for (const instance of instances) instance.destroy();
    }
    this.pools.clear();
    this.indexes.destroy();
  }

  /** A material's next draw, made and put in the layer. */
  private make(material: StandardMaterial, pool: Pool): PassDraw {
    const mesh = new Mesh(this.device);
    mesh.indexBuffer[0] = this.indexes;
    mesh.primitive[0] = {
      type: PRIMITIVE_TRIANGLES,
      base: 0,
      baseVertex: 0,
      count: 0,
      indexed: true
    };
    // Held here too: releasing the draw would otherwise free the shared buffers.
    mesh.incRefCount();
    const instance = new MeshInstance(mesh, material);
    // What it draws is what the light reaches of what the view sees: nothing to cull.
    instance.cull = false;
    const data = new Float32Array(8);
    instance.setParameter(DLIGHT_UNIFORM, data);
    this.layer.addMeshInstances([instance], true);
    const draw: PassDraw = { instance, mesh, data, run: -1, batch: -1, light: -1 };
    pool.draws.push(draw);
    return draw;
  }

  private indexBuffer(): IndexBuffer {
    return new IndexBuffer(
      this.device,
      INDEXFORMAT_UINT32,
      this.storage.length,
      BUFFER_DYNAMIC,
      this.storage.buffer
    );
  }
}
