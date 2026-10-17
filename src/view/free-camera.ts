import type { KeyMove } from '../settings/client-input';
import { DEFAULT_SPEED, PITCH_LIMIT_DEGREES } from '../sim/constants';
import { angleVectors, type ViewBasis } from '../sim/pmove-math';
import { vec3, type Vec3 } from '../sim/vec3';
import type { FirstPersonView } from './camera-feel';
import { mouseLook, type LookAngles, type MouseSettings } from './look';

/**
 * The fly camera: out of the player's eyes, flown free while the game waits.
 * The keys move it through the binds, as they make the player's move (`+forward`, `+moveleft`,
 * `+moveup` and the rest), and the mouse turns it as it turns the player.
 *
 * It flies as Q3's noclip does (`PM_NoclipMove`, `bg_pmove.c:841`): along the view, with the up
 * move added straight up (`bg_pmove.c:884`), at `g_speed` for a full move and no faster on a
 * diagonal (`PM_CmdScale`, `bg_pmove.c:289`). Noclip's friction and acceleration are left out, so
 * it starts and stops at once. Engine-free: `App.ts` places the camera from its view.
 */

/** `CL_KeyMove`'s full move, with `cl_run` on (`cl_input.c:326–332`). */
const FULL_MOVE = 127;

export class FreeCamera {
  private origin: Vec3 = vec3();
  private readonly look: LookAngles = { yaw: 0, pitch: 0 };
  /** What {@link view} gives, written again at each asking. */
  private readonly current: FirstPersonView = { origin: vec3(), angles: vec3() };
  /** The view's angles and axes as a frame flies along them, written again each frame. */
  private readonly angles: Vec3 = vec3();
  private readonly basis: ViewBasis = { forward: vec3(), right: vec3(), up: vec3() };

  /** Take off from a view: where it was, looking where it looked. */
  start(view: FirstPersonView): void {
    this.origin = { ...view.origin };
    this.look.yaw = view.angles.y;
    this.look.pitch = -view.angles.x;
  }

  /**
   * Fly a frame: turn by the mouse, then move along the view by the keys. It makes nothing.
   *
   * @param seconds - How long the frame is.
   */
  fly(
    move: Readonly<KeyMove>,
    mouse: { readonly dx: number; readonly dy: number },
    settings: MouseSettings,
    seconds: number
  ): void {
    const look = mouseLook(this.look, mouse.dx, mouse.dy, settings, PITCH_LIMIT_DEGREES, this.look);
    const angles = this.angles;
    angles.x = -look.pitch;
    angles.y = look.yaw;
    const { forward, right } = angleVectors(angles, this.basis);
    const wishX = forward.x * move.forwardmove + right.x * move.rightmove;
    const wishY = forward.y * move.forwardmove + right.y * move.rightmove;
    const wishZ = forward.z * move.forwardmove + right.z * move.rightmove + move.upmove;
    const size = Math.sqrt(wishX * wishX + wishY * wishY + wishZ * wishZ);
    if (size === 0) return;
    const full = Math.max(Math.abs(move.forwardmove), Math.abs(move.rightmove), Math.abs(move.upmove));
    const speed = (DEFAULT_SPEED * full) / FULL_MOVE;
    const step = (speed * seconds) / size;
    this.origin.x += wishX * step;
    this.origin.y += wishY * step;
    this.origin.z += wishZ * step;
  }

  /**
   * Where the camera is and which way it looks, in Q3's angles, pitch positive looking down: the
   * same object each time, written again, so a frame asking makes nothing.
   */
  view(): FirstPersonView {
    const { origin, angles } = this.current;
    origin.x = this.origin.x;
    origin.y = this.origin.y;
    origin.z = this.origin.z;
    angles.x = -this.look.pitch;
    angles.y = this.look.yaw;
    angles.z = 0;
    return this.current;
  }
}
