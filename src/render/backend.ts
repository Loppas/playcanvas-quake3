import { DEVICETYPE_WEBGL2, DEVICETYPE_WEBGPU } from 'playcanvas';

/** The graphics backend the page asks for: `r_glDriver`. */
export type Backend = 'webgpu' | 'webgl2';

/**
 * The device types `createGraphicsDevice` is asked for: WebGPU, which the engine follows with
 * WebGL2 where there is none, or WebGL2 alone. A fresh list each time, since the engine appends
 * its fallbacks to the one it is given.
 */
export function deviceTypes(backend: Backend): string[] {
  return backend === 'webgl2' ? [DEVICETYPE_WEBGL2] : [DEVICETYPE_WEBGPU];
}
