# Drawing a Quake 3 world

How the port draws a BSP map as `opengl1` draws it. PlayCanvas's own traps are
[`engine.md`](engine.md)'s; how a picture is judged against Quake 3's is
[`testing.md`](../testing.md)'s reference capture.

**The 3D scene draws Quake 3's framebuffer values, and a ramp pass doubles them after.** opengl1
draws at `identityLight` and lets the display's gamma ramp double the whole screen, so
a lightmap times a texture keeps its light past half. A gain applied stage by stage clamps each
stage at white before the next multiplies it. Each stage of the world, a model, an effect and the
gun draws the value opengl1 writes, and a full-screen quad blended `GL_DST_COLOR GL_ONE` follows the
scene's last draw, once for each overbright bit, as the ramp's `i << 1` does in 8 bits.
The HUD, its icons, the scoreboard and the menus draw after it at on-screen values. The gun draws
at its shaders' places, its depth squeezed into [0, 0.3] in its vertex shader as `RF_DEPTHHACK`'s
depth range squeezes it, so a wall a few units before the eye can cover it, as in Quake 3.

**Quake 3's draw order is one list, sorted by hand.** PlayCanvas draws opaque and blended draws in
two passes and sorts the blended by their bounds, and either breaks Q3's sort key: split, two
coplanar surfaces come out as the product of both textures, where Q3 shows the later one's. Every
world stage is blended, an opaque one as `GL_ONE GL_ZERO`, in one transparent sub-layer sorted
`SORTMODE_MANUAL` by `drawOrder`. Where the port culls as Q3 culls, the engine's cull is off.
Every draw of a BSP map's scene joins that list, keyed as Quake 3's sort key is: the
shader's place, as `SortNewShader` gives it when the port registers the shader where cgame does,
then the entity, the fog and the dlight bit, then the stage, one whole number under 2^53. So an
explosion seen through water draws over it untinted, as in Quake 3.

**A depth-equal pass draws only where it rasterises the first stage's depths to the bit.** So it
reads the same vertex buffer through the same transform: q3dm9's fogged batches drawn with their
fog passes depth-equal and less-or-equal give the same picture to the pixel, on WebGPU and WebGL2.
A deform is worked on the CPU into one buffer that every stage and the fog pass read, not
carried in each pass's shader, where one rounding apart leaves the pass undrawn. A
dynamic light's pass reads the same buffer and node too, only its triangles its own.

**The world's batches are opengl1's, cut each frame from what the view sees.** A shader's surfaces
are taken in the order `R_RecursiveWorldNode` adds them and cut where `RB_CHECKOVERFLOW` cuts
them, so Q3's draw order and its `r_speeds` counts come out the same. Only a run whose
surfaces or curve rows changed is cut again, its indexes rewritten in place, and the frame makes
nothing of the port's. cgame's polys (marks, shadows, wakes) are batched the same way as the
world's entity, in the order added, and drawn with the world's stages for their shader from one
buffer a frame.
