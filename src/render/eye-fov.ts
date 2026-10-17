import { ASPECT_AUTO, ASPECT_MANUAL, type CameraComponent } from 'playcanvas';

import { fovAspect, underwaterWarp, verticalFov, viewFov } from '../view/fov';

/** What of a camera its angles are set through. */
export type Lens = Pick<CameraComponent, 'fov' | 'aspectRatioMode' | 'aspectRatio'>;

/**
 * Set the eye's angles as `CG_CalcFov` sets the refdef's (`cg_view.c:470–535`): `cg_fov`'s, on the
 * screen's aspect, and while the eye is in a liquid warped by a sine of the game clock, wider
 * across and narrower up and down. PlayCanvas's camera keeps one angle, the vertical, so a warped
 * view takes the other through an aspect of its own; an unwarped one resolves its aspect against
 * the screen, as before.
 *
 * @param cgFov - `cg_fov`.
 * @param aspect - The screen's width over its height.
 * @param contents - What the eye is in: `CG_PointContents( cg.refdef.vieworg, -1 )`.
 * @param time - `cg.time`, in milliseconds.
 */
export function setEyeFov(
  lens: Lens,
  cgFov: number,
  aspect: number,
  contents: number,
  time: number
): void {
  const warp = underwaterWarp(contents, time);
  if (warp === 0) {
    lens.fov = verticalFov(cgFov);
    lens.aspectRatioMode = ASPECT_AUTO;
    return;
  }
  const fov = viewFov(cgFov, aspect, warp);
  lens.fov = fov.y;
  lens.aspectRatioMode = ASPECT_MANUAL;
  lens.aspectRatio = fovAspect(fov);
}
