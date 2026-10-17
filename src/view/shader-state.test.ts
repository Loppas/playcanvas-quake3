import { describe, expect, it } from 'vitest';

import { parseShaderState } from './shader-state';

describe('parseShaderState', () => {
  it('reads each swap in order, its time as written', () => {
    expect(
      parseShaderState('textures/a/ghost=textures/a/scared: 1.24@textures/a/cherry=x:12.35@')
    ).toEqual([
      { oldShader: 'textures/a/ghost', newShader: 'textures/a/scared', timeOffset: ' 1.24' },
      { oldShader: 'textures/a/cherry', newShader: 'x', timeOffset: '12.35' }
    ]);
  });

  it('reads nothing of an empty state', () => {
    expect(parseShaderState('')).toEqual([]);
  });

  it("stops at a swap with no '=' or ':', and hands on none with no '@' after it", () => {
    expect(parseShaderState('a=b: 0.30@c')).toHaveLength(1);
    expect(parseShaderState('a=b: 0.30@c=d')).toHaveLength(1);
    expect(parseShaderState('a=b: 0.30@c=d: 0.40')).toHaveLength(1);
    // Each mark is looked for from the last, wherever it is.
    expect(parseShaderState('a:b=c:d@')).toEqual([
      { oldShader: 'a:b', newShader: 'c', timeOffset: 'd' }
    ]);
  });

  it("cuts each name to 63 characters and the time to 15, as cgame's buffers hold them", () => {
    const long = 'n'.repeat(70);
    const [swap] = parseShaderState(`${long}=${long}:${'1'.repeat(20)}@`);
    expect(swap).toEqual({
      oldShader: 'n'.repeat(63),
      newShader: 'n'.repeat(63),
      timeOffset: '1'.repeat(15)
    });
  });
});
