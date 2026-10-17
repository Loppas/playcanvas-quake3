import type { GraphicsDevice } from 'playcanvas';

/**
 * PlayCanvas's mesh instance storage, kept only where the browser's WebGPU can carry it.
 *
 * On WebGPU, PlayCanvas keeps each mesh instance's matrices in one storage buffer and hands each
 * draw its slot as `firstInstance`, which the vertex shader reads as `@builtin(instance_index)`
 * through a helper that copies the entry point's inputs to private globals. Firefox 148's WebGPU
 * loses `firstInstance` there, though not in the entry point itself, so every draw reads the first
 * slot's matrix and the menu draws every item in one place. A probe draws that pattern twice and
 * reads it back, and where it fails the device goes back to a uniform per draw, as on WebGL2.
 */

/** A vertex shader in PlayCanvas's pattern: the instance index read through a helper. */
const PROBE_WGSL = /* wgsl */ `
struct Input {
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
};
struct Output {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) seen: f32,
};
var<private> instanceIndex: u32;
fn copyInputs(input: Input) {
  instanceIndex = input.instanceIndex;
}
@vertex fn vertexMain(input: Input) -> Output {
  copyInputs(input);
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: Output;
  output.position = vec4f(corners[input.vertexIndex], 0.0, 1.0);
  output.seen = f32(instanceIndex);
  return output;
}
@fragment fn fragmentMain(input: Output) -> @location(0) vec4f {
  return vec4f(input.seen, 0.0, 0.0, 1.0);
}
`;

/**
 * WebGPU's flags the probe uses, whose namespaces TypeScript's DOM library leaves out
 * (https://www.w3.org/TR/webgpu/#typedefdef-gpubufferusageflags).
 */
const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const BUFFER_MAP_READ = 0x01;
const BUFFER_COPY_DST = 0x08;
const MAP_MODE_READ = 0x01;

/** What each of the probe's two draws saw: the red byte of its texel. */
export type ProbeTexels = [number, number];

/**
 * Draw the pattern twice into a texel each, the second draw's `firstInstance` 1, and read back
 * what each draw's helper saw.
 */
export async function probeInstanceIndex(gpu: GPUDevice): Promise<ProbeTexels> {
  const module = gpu.createShaderModule({ code: PROBE_WGSL });
  const pipeline = gpu.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertexMain' },
    fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' }
  });
  const target = gpu.createTexture({
    size: [2, 1],
    format: 'rgba8unorm',
    usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SRC
  });
  // A copy's rows are 256 bytes apart at the least.
  const read = gpu.createBuffer({ size: 256, usage: BUFFER_COPY_DST | BUFFER_MAP_READ });
  try {
    const encoder = gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0]
        }
      ]
    });
    pass.setPipeline(pipeline);
    for (const instance of [0, 1]) {
      // The viewport, not the shader, puts each draw in its texel.
      pass.setViewport(instance, 0, 1, 1, 0, 1);
      pass.draw(3, 1, 0, instance);
    }
    pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: 256 }, [2, 1]);
    gpu.queue.submit([encoder.finish()]);
    await read.mapAsync(MAP_MODE_READ);
    const texels = new Uint8Array(read.getMappedRange(0, 8));
    const seen: ProbeTexels = [texels[0], texels[4]];
    read.unmap();
    return seen;
  } finally {
    target.destroy();
    read.destroy();
  }
}

/** Whether each draw's helper saw its own `firstInstance`: 0 for the first, 1 for the second. */
export function firstInstanceReached(seen: ProbeTexels): boolean {
  return seen[0] === 0 && seen[1] === 255;
}

/** PlayCanvas's WebGPU device: its browser device and its storage, which its typings leave out. */
interface StoringDevice {
  wgpu?: GPUDevice | null;
  supportsMeshInstanceStorage: boolean;
  meshInstanceStorage: { destroy(): void } | null;
}

/**
 * Turn the mesh instance storage off where the device's WebGPU does not carry `firstInstance`
 * into a helper, or cannot be probed. Run before any shader is made: a shader takes the storage
 * as it is made.
 *
 * @param probe - The probe; a test's stands in for the browser's GPU.
 * @returns whether it was turned off
 */
export async function guardMeshInstanceStorage(
  device: GraphicsDevice,
  probe: (gpu: GPUDevice) => Promise<ProbeTexels> = probeInstanceIndex
): Promise<boolean> {
  const storing = device as unknown as StoringDevice;
  const gpu = storing.wgpu;
  if (!gpu || !storing.supportsMeshInstanceStorage) return false;
  try {
    const seen = await probe(gpu);
    if (firstInstanceReached(seen)) return false;
    console.warn(
      `WebGPU loses a draw's firstInstance in a shader's helper (saw ${seen.join(', ')}): ` +
        'mesh instance storage off'
    );
  } catch (err) {
    console.warn('WebGPU firstInstance probe failed, mesh instance storage off:', err);
  }
  storing.supportsMeshInstanceStorage = false;
  storing.meshInstanceStorage?.destroy();
  storing.meshInstanceStorage = null;
  return true;
}
