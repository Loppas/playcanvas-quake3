import { createTrajectory } from '../net/protocol';
import { NO_CONTENTS, NO_INLINE_MODELS, type TraceFn } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import type { ClientWorld, SolidEntity } from './client-trace';

/** A client's world of a map's trace alone, with no contents and no inline models. */
export function mapAlone(trace: TraceFn): ClientWorld {
  return { trace, pointContents: NO_CONTENTS, inlineModels: NO_INLINE_MODELS, physicsTime: 0 };
}

/** An entity that is a box, `solid` as linking packed it, drawn at `origin`. */
export function boxSolid(number: number, solid: number, origin: Vec3): SolidEntity {
  return { number, solid, modelindex: 0, pos: createTrajectory(), origin, angles: vec3() };
}
