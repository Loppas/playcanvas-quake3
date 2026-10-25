{title}
{underline}

Map name       {stem}   (start it with: map {stem})
File           map-{stem}.pk3
Author         {author}
Description    A Quake 3 map made from a Gaussian-splat capture, for
               playcanvas-quake3. The splat is the map's surfaces and lighting,
               and a voxel octree baked from it is the map's collision.

Play information
----------------
Game types     {gametypes}
Bot play       no: a splat map has no .aas
New sounds     no
New graphics   the splat, maps/{stem}.sog
New music      no
Needs          playcanvas-quake3, which reads a splat map. Stock ioquake3
               cannot load it, since it has no BSP.

Construction
------------
Base           {base}
Built with     playcanvas-quake3 {pipeline}, splat-transform {splat_transform}
Polish         {polish}
               scaled {scale}x, to metres at 32 Quake units each
Collision      {bake}
Filters        {filters}
Entities       {entities}
Levelshot      {levelshot}
Known bugs     {known}

Credits
-------
This map is built on "{source_title}" by {source_author}
({source_author_url}), {source_url}.
It is licensed under {source_license} ({source_license_url}).

The capture was changed: levelled and squared, scaled {scale}x,
{filtered}baked into a voxel collision octree, and given Quake 3 entities.

Distribution and copyright
--------------------------
This map is licensed under {license}, as its source is:
{license_url}
Credit the source as the Credits section does, and say what you changed.
