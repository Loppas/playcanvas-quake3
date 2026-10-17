# Simulation and view

**Dependencies point into the sim, never out of it.** `view/look.ts` takes its pitch limit from
`sim/constants.ts` for exactly this reason. Neither `sim/` nor `view/` imports PlayCanvas, so the
whole input-to-camera path runs headless.

**The sim and the view must agree on what counts as motion.** A step-up is a teleport, not
movement, and interpolating through it replays the pop the glide exists to remove — doubled,
because the glide has already subtracted the full step. That made the first camera-feel layer
measurably *worse than none at all* (a 14.7-unit one-frame eye drop against the 12.9-unit pop it
was removing). So a step is excluded from vertical interpolation.

**Q3's own architecture explains its numbers.** It never meets that pop because it re-predicts
the local player every frame rather than interpolating snapshots. When a port behaves oddly, check what the
original did structurally before inventing a fix.

**Q3 adds an angle offset to the view's angles, then builds one axis from the sum.** The weapon's
sway, like the view's run and bob tilts, is pitch, yaw and roll added to `refdefViewAngles` and
fed to `AnglesToAxis`, not a turn in the view's frame. The two agree with the view level and part
once it pitches: Q3's yaw always turns about the world's up, so looking down, part of a yaw offset
becomes a roll. Build the sum and one axis (`view/hand-pose.ts`) rather than turning a node under
the camera by the offset. Turn about the point Q3 turns about, too: the hand's origin, after the
fov drop, not the eye.
