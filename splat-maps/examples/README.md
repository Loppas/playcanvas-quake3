# The examples

Two maps made from one capture, ["Garage - High Detail Test"](https://superspl.at/scene/8f4d8e05),
each in a folder of its parts with a README of the commands that rebuild it:

| Example | The player | The garage, against life size | Spawn spots |
|---|---|---|---|
| [`garage_cats/`](garage_cats/) | 0.5 m | 3.5× | 4 |
| [`garage_rats/`](garage_rats/) | 0.1 m | 17.5× | 9 |

The game's player stays 1.75 m tall, so a smaller player is a bigger garage around it. Both start
from `garage-aligned.sog`, below.

## The aligned garage

`garage-aligned.sog` is the garage at life size: levelled, its walls squared to the axes, its
floor at 0, in metres, with the capture's licence inside. It is the capture through the polish
once, with no player height, and each example's polish scales it for its player.

Download the capture from its page on [superspl.at](https://superspl.at/scene/8f4d8e05), as
`data\garage\garage.sog`. Then, from `splat-maps\`, with `nvm use 24` run once:

```bat
splat-maps polish data\garage\garage.sog data\garage\garage-aligned.sog 3.0 --up-hint "0,-1,0"
```

The capture is upside down in its file, hence `--up-hint`. `garage-aligned.polish.json` here is
what the polish recorded: its transform, its verify and the capture's licence. A rerun makes the
same record, and the same splat but for its spherical harmonics, which each polish encodes
afresh.

The garage needs no cleaning beyond the polish. The capture is the room: 99.97% of its splats lie
within 0.25 m of the room's walls, floor and ceiling.
