import { atoi } from '../formats/c-scan';

/**
 * How often a server sends a client snapshots: what the server holds them apart by, and the gap
 * that comes of it, which the server and the game module both need and a client works out too.
 */

/**
 * `sv_fps`'s default, the port's own where Quake 3's is 20 (`sv_init.c:667`): game frames of 8 ms,
 * the move's own step, and up to 125 snapshots a second.
 */
export const SV_FPS = 125;

/**
 * `SV_Frame`'s `frameMsec` (`sv_main.c:1082–1093`): one game frame, `1000 / sv_fps`. Quake 3
 * makes up a frame under 1 ms with `timescale`, which the port has not, so the frame is held at 1.
 *
 * @param svFps - `sv_fps`, 1 or more.
 */
export function frameMsec(svFps: number): number {
  return Math.max(1, Math.trunc(1000 / svFps));
}

/**
 * `SV_UserinfoChanged`'s `snapshotMsec` (`sv_client.c:1440–1455`): a thousand over the `snaps` a
 * client's userinfo asks for, held to at least 1 and at most `sv_fps`, or 50 for a client that
 * asks for none.
 *
 * @param snaps - The userinfo's `snaps`, as it came.
 * @param svFps - `sv_fps`.
 */
export function snapshotMsec(snaps: string, svFps: number): number {
  if (snaps === '') return 50;
  let rate = atoi(snaps);
  if (rate < 1) rate = 1;
  else if (rate > svFps) rate = svFps;
  return Math.trunc(1000 / rate);
}

/**
 * The gap between a client's snapshots as they really go: a snapshot leaves only at a frame's end,
 * so it is the interval rounded up to whole frames. 56 ms at an interval of 50 and a frame of 8.
 *
 * @param msec - The client's interval, from {@link snapshotMsec}.
 * @param frameMsec - The server's frame; at 0 or less, the interval itself.
 */
export function snapshotGap(msec: number, frameMsec: number): number {
  return frameMsec > 0 ? Math.ceil(msec / frameMsec) * frameMsec : msec;
}
