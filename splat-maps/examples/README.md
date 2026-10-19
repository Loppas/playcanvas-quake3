# The examples

Two maps made from one capture, ["Garage - High Detail Test"](https://superspl.at/scene/8f4d8e05),
each in a folder of its parts with a README that rebuilds it:

| Example | The player | The garage, against life size | Spawn spots |
|---|---|---|---|
| [`garage_cats/`](garage_cats/) | 0.5 m | 3.5× | 4 |
| [`garage_rats/`](garage_rats/) | 0.1 m | 17.5× | 9 |

The game's player stays 1.75 m tall, so a smaller player is a bigger garage around it.

## The aligned garage

Both maps start from `garage-aligned.sog`, the garage at life size: levelled, its walls squared to
the axes, its floor at 0, in metres, with the capture's licence inside.
[The splat-maps quick start](../README.md#a-first-map-from-the-garage)'s steps 1 and 2 make it from
the capture, and each example's polish scales it for its player. `garage-aligned.polish.json` here
is what that polish recorded.

The garage needs no cleaning: 99.97% of its splats lie within 0.25 m of the room's walls, floor and
ceiling.

## A rebuild

A rebuild matches its map's pk3 on
[the release](https://github.com/Loppas/playcanvas-quake3/releases/tag/splat-maps-v0.1.0) where it
can:

- the arena and the polish's records come out as they are here, byte for byte, and the bake's
  record differs only in its timings and peak memory;
- the octree and the mesh come out as the pk3 has them, in `maps/`;
- each polish encodes the splat's spherical harmonics afresh, so about one in eight of the
  levelshot's pixels may differ, by a level or two.
