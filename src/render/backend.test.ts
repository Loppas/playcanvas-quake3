import { DEVICETYPE_WEBGL2, DEVICETYPE_WEBGPU } from 'playcanvas';
import { describe, expect, it } from 'vitest';

import { deviceTypes } from './backend';

describe('deviceTypes', () => {
  it('asks for WebGPU, leaving WebGL2 to the engine as its fallback', () => {
    expect(deviceTypes('webgpu')).toEqual([DEVICETYPE_WEBGPU]);
  });

  it('asks for WebGL2 alone', () => {
    expect(deviceTypes('webgl2')).toEqual([DEVICETYPE_WEBGL2]);
  });

  it('hands out a new list each time, for the engine to append its fallbacks to', () => {
    const first = deviceTypes('webgpu');
    first.push(DEVICETYPE_WEBGL2);
    expect(deviceTypes('webgpu')).toEqual([DEVICETYPE_WEBGPU]);
  });
});
