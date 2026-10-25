"""Re-measure a finished splat map pk3 against the format's lint rules, changing nothing.

The rules are `map-format.md` §10's, L1 to L29, each checked on the package itself: the zip,
its names, the splat inside it, the octree decoded as the port decodes it, the entity text read
by Q3's rules, the spawn spots placed in the octree, the arena, the levelshot and the readme.
**E** refuses the package and **W** reports and passes it.

Usage:
    splat-maps lint <dir>/map-<stem>.pk3

Exits 1 if any rule fails at E.
"""

import argparse
import json
import math
import os
import re
import sys
import zipfile

from . import splat_map as sm

REQUIRED = ("maps/{n}.sog", "maps/{n}.voxel.json", "maps/{n}.voxel.bin", "maps/{n}.ent", "{n}.txt")
OPTIONAL = ("maps/{n}.collision.glb", "scripts/{n}.arena", "levelshots/{n}.tga")

#: The `_pcq_*` keys of §7 that `package_map` writes into every worldspawn; `_pcq_filter` it
#: writes only for a map whose bake filtered the splat.
PCQ_KEYS = ("_pcq_format", "_pcq_source", "_pcq_license", "_pcq_polish", "_pcq_scale",
            "_pcq_bake", "_pcq_splat_transform", "_pcq_pipeline")
KNOWN_FORMATS = ("1",)

#: An absolute path: a drive letter not inside a word (so not the "s:/" of "https://"), a UNC
#: share, or a leading slash.
ABSOLUTE = re.compile(r"(?<![A-Za-z])[A-Za-z]:[\\/]|^\\\\|^/")


class Report:
    def __init__(self):
        self.rows = []

    def check(self, rule, level, ok, detail=""):
        self.rows.append((rule, level, bool(ok), detail))
        return ok

    def errors(self):
        return [r for r in self.rows if not r[2] and r[1] == "E"]

    def warnings(self):
        return [r for r in self.rows if not r[2] and r[1] == "W"]


def flag_value(flags, name):
    """The value after `name` in a flag string such as `_pcq_bake`'s."""
    parts = flags.split()
    return parts[parts.index(name) + 1] if name in parts[:-1] else None


def main(argv=None, prog=None):
    ap = argparse.ArgumentParser(prog=prog, description="Lint a splat map pk3.")
    ap.add_argument("pk3")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    rep = Report()
    pk3 = args.pk3
    base = os.path.basename(pk3)

    # ---------------------------------------------------------------- container and names
    with open(pk3, "rb") as fh:
        raw = fh.read()
    try:
        z = zipfile.ZipFile(pk3)
    except zipfile.BadZipFile as e:
        rep.check("L1", "E", False, f"not a zip: {e}")
        return finish(rep, pk3)
    infos = z.infolist()
    names = [i.filename for i in infos]

    # The stem is the map's, named by its one splat. The pk3 is map-<stem>.pk3, or, for a later
    # release, map-<stem>_<tag>.pk3, which sorts after it and so wins (section 9).
    sogs = [m.group(1) for m in (re.match(r"^maps/([^/]+)\.sog$", x) for x in names) if m]
    n = sogs[0] if len(sogs) == 1 else ""
    rep.check("L4", "E", n and sm.STEM_RE.match(n),
              f"one maps/<stem>.sog, whose stem is [a-z0-9_]{{1,44}}: {sogs or 'none'}")
    named = n and (base == f"map-{n}.pk3"
                   or re.match(rf"^map-{re.escape(n)}_[a-z0-9]+\.pk3$", base))
    rep.check("L4", "E", named, f"{base} is map-<stem>.pk3 or map-<stem>_<tag>.pk3")
    if not n:
        return finish(rep, pk3)
    zip64 = b"PK\x06\x06" in raw[-65536:] or b"PK\x06\x07" in raw[-65536:] or any(
        _has_zip64_extra(i.extra) for i in infos)
    rep.check("L1", "E", not zip64, "no zip64 records")
    rep.check("L1", "E", len(names) == len(set(names)), "no duplicate entry names")
    bad_methods = [i.filename for i in infos if i.compress_type not in (0, 8)]
    rep.check("L1", "E", not bad_methods, f"only methods 0 and 8: {bad_methods or 'yes'}")
    unshaped = [x for x in names if x != x.lower() or "\\" in x]
    rep.check("L3", "E", not unshaped, f"lowercase paths with forward slashes: {unshaped or 'yes'}")
    tree = {p.format(n=n) for p in REQUIRED + OPTIONAL}
    extra = [x for x in names if x not in tree and not x.startswith(("music/", "sound/"))
             and not x.endswith("/")]
    rep.check("L3", "W", not extra, f"nothing outside the tree: {extra or 'yes'}")
    foreign = [x for x in names if x.startswith(("maps/", "scripts/", "levelshots/"))
               and not x.endswith("/") and x not in tree]
    rep.check("L4", "E", not foreign, f"every per-map file named by the stem: {foreign or 'yes'}")
    missing = [p.format(n=n) for p in REQUIRED if p.format(n=n) not in names]
    rep.check("L5", "E", not missing, f"required files present: {missing or 'yes'}")
    if missing:
        return finish(rep, pk3)
    read = lambda p: z.read(p.format(n=n))  # noqa: E731

    # ---------------------------------------------------------------- the splat and the octree
    sog_info = z.getinfo(f"maps/{n}.sog")
    rep.check("L2", "E", sog_info.compress_type == zipfile.ZIP_STORED, "the .sog is stored")
    sog_generator = None
    try:
        with z.open(sog_info) as fh, zipfile.ZipFile(fh) as sog:
            meta = json.loads(sog.read("meta.json"))
        sog_generator = meta.get("asset", {}).get("generator")
        rep.check("L6", "E", meta.get("version") == 2 and meta.get("count", 0) > 0,
                  f"meta.json version {meta.get('version')}, count {meta.get('count', 0):,}")
    except (zipfile.BadZipFile, KeyError, ValueError) as e:
        rep.check("L6", "E", False, f"the .sog does not open as a SOG bundle: {e}")

    octree = None
    header = {}
    try:
        header = json.loads(read("maps/{n}.voxel.json"))
        octree = sm.Octree.from_bytes(header, read("maps/{n}.voxel.bin"))
        stats = octree.validate()
        rep.check("L7", "E", not stats["problems"],
                  "; ".join(stats["problems"]) or f"{header['nodeCount']:,} nodes, each reached "
                  "once, counts as the header says")
    except (sm.FormatError, KeyError, ValueError) as e:
        rep.check("L7", "E", False, f"the octree does not load as the port loads it: {e}")
    if octree:
        try:
            octree.cells_from_origin()
            rep.check("L8", "E", True, "gridBounds.min lies on a whole cell")
        except sm.FormatError as e:
            rep.check("L8", "E", False, str(e))
            octree = None
    if "voxelResolution" in header:
        u = float(header["voxelResolution"]) * sm.UNITS_PER_METRE
        rep.check("L9", "E", abs(u - round(u)) < 1e-9 and 1 <= round(u) <= sm.MAX_VOXEL_UNITS,
                  f"the voxel is {u:g} units")

    # ---------------------------------------------------------------- the entity text
    ent_raw = read("maps/{n}.ent")
    entities = None
    try:
        entities, tok = sm.parse_entities(ent_raw)
        first = entities[0].classname
        rep.check("L11", "E", first.lower() == "worldspawn", f"block 0 is {first!r}")
        rep.check("L11", "E", not tok.truncated,
                  f"no token over 1023 bytes: {tok.truncated or 'yes'}")
        dups = [(e.line, k) for e in entities for k in _duplicates(e)]
        rep.check("L11", "E", not dups, f"no duplicate keys in a block: {dups or 'yes'}")
    except sm.FormatError as e:
        rep.check("L11", "E", False, str(e))
    printable = all(b in (9, 10, 13) or 32 <= b < 127 for b in ent_raw)
    rep.check("L12", "E", printable, "printable ASCII")
    if entities is None:
        return finish(rep, pk3)
    quoted = [(e.line, k) for e in entities for k, v in e.pairs if '"' in k or '"' in v]
    rep.check("L12", "E", not quoted, f"no quote inside a key or value: {quoted or 'yes'}")
    brush = [(e.line, e.classname) for e in entities if e.classname in sm.BRUSH_CLASSNAMES
             or (e.get("model") or "").startswith("*")]
    rep.check("L13", "E", not brush, f"no brush entities: {brush or 'yes'}")

    arena = None
    if f"scripts/{n}.arena" in names:
        try:
            blocks = sm.parse_arena(read("scripts/{n}.arena"))
            arena = blocks
        except sm.FormatError as e:
            rep.check("L25", "E", False, f"the arena does not parse: {e}")
    arena_pairs = dict((k.lower(), v) for k, v in arena[0]) if arena else {}
    types = [t.lower() for t in arena_pairs.get("type", "").split()]
    gametypes = sorted({sm.ARENA_GAMETYPES[t] for t in types if t in sm.ARENA_GAMETYPES}) or [0]
    spots = sm.spawn_spots(entities)
    for gt in gametypes:
        alive = [s for s in spots if sm.survives(s, gt)]
        rep.check("L14", "E", alive, f"{len(alive)} spawn spot(s) in {sm.GAMETYPE_NAMES[gt]}")
    points = [e for e in entities if e.classname == "info_player_intermission"]
    rep.check("L15", "E", len(points) == 1, f"{len(points)} info_player_intermission")
    names_t = {e.get("targetname") for e in entities if e.get("targetname")}
    dangling = [(e.line, e.get("target")) for e in entities
                if e.get("target") and e.get("target") not in names_t]
    rep.check("L16", "E", not dangling, f"every target names a targetname: {dangling or 'yes'}")
    unknown = sorted({e.classname for e in entities if e.classname not in sm.Q3_CLASSNAMES})
    rep.check("L17", "W", not unknown, f"classnames Q3 knows: {unknown or 'yes'}")
    freed = sorted({e.classname for e in entities if e.classname in ("misc_model", "light")})
    rep.check("L18", "W", not freed,
              f"no misc_model or light, which do nothing here: {freed or 'yes'}")

    world = entities[0]
    absent = [k for k in PCQ_KEYS if world.get(k) is None]
    rep.check("L19", "E", not absent, f"every _pcq_* key present: {absent or 'yes'}")
    rep.check("L19", "E", world.get("_pcq_format") in KNOWN_FORMATS,
              f"_pcq_format {world.get('_pcq_format')!r} is known")
    paths = [k for k, v in world.pairs if k.lower().startswith("_pcq_") and ABSOLUTE.search(v)]
    rep.check("L19", "E", not paths, f"no absolute path in a _pcq_* value: {paths or 'yes'}")
    st = world.get("_pcq_splat_transform")
    vox_generator = header.get("asset", {}).get("generator")
    records = {"the .sog": sog_generator, "the octree": vox_generator}
    mismatched = [w for w, g in records.items() if not (g and st and g.split()[-1] == f"v{st}")]
    rep.check("L19", "E", not mismatched,
              f"_pcq_splat_transform {st} against the generators {records}")

    bake = world.get("_pcq_bake") or ""
    carve, size = flag_value(bake, "--voxel-carve"), flag_value(bake, "--voxel-size")
    if carve and size:
        h, r = (float(x) for x in carve.split(","))
        box = sm.carve_box_units(h, r, float(size))
        rep.check("L10", "E",
                  box[0] <= sm.CARVE_LIMIT_UNITS[0] and box[1] <= sm.CARVE_LIMIT_UNITS[1],
                  f"--voxel-carve {carve} at --voxel-size {size} is a {box[0]:g} x {box[1]:g} box")
        if octree:
            rep.check("L10", "E", abs(float(size) - octree.vr) < 1e-12,
                      f"_pcq_bake's --voxel-size {size} is the octree's {octree.vr:g}")
    else:
        rep.check("L10", "E", False, "_pcq_bake gives no --voxel-carve and --voxel-size")

    # ---------------------------------------------------------------- placement
    if octree:
        for sp in sm.judge_spawns(octree, entities):
            where = " ".join(sm.fmt_num(c) for c in sp["origin"])
            rep.check("L20", "E", sp["solid_voxels"] == 0,
                      f"spawn ({where}): {sp['solid_voxels']} solid voxels in its box")
            if sp["solid_voxels"] == 0:
                level = "W" if sp["landing"] == "thuds" else "E"
                rep.check("L21", level, sp["landing"] == "silent",
                          f"spawn ({where}): drops {sp['drop']} units, landing {sp['landing']}")
        for p in points[:1]:
            o = p.vector("origin")
            s = octree.voxel_units()
            cell = octree.sim_voxel_to_cell(*(math.floor(c / s) for c in o))
            rep.check("L22", "E", not octree.is_solid_cell(*cell),
                      f"intermission origin ({' '.join(sm.fmt_num(c) for c in o)}) is open")
        overlaps = []
        for i, a in enumerate(spots):
            for b in spots[i + 1:]:
                oa, ob = a.vector("origin"), b.vector("origin")
                if all(oa[k] + sm.PLAYER_MINS[k] < ob[k] + sm.PLAYER_MAXS[k]
                       and ob[k] + sm.PLAYER_MINS[k] < oa[k] + sm.PLAYER_MAXS[k] for k in range(3)):
                    overlaps.append((a.line, b.line))
        rep.check("L23", "W", not overlaps, f"no two spawn boxes overlap: {overlaps or 'yes'}")
        if spots:
            o = spots[0].vector("origin")
            foot = (o[0] + sm.PLAYER_MINS[0], o[1] + sm.PLAYER_MINS[1],
                    o[2] + sm.SPAWN_RAISE + sm.PLAYER_MINS[2])
            reach = octree.player_reach(foot, 48)
            under = reach["under"] if reach else 0
            rep.check("L24", "W", under == 0,
                      f"the crouched player's box reaches {under:,} positions with its feet more "
                      f"than 48 units under the floor" + (f", the lowest at {reach['feet'][0]:g}"
                                                          if under else ""))

    # ---------------------------------------------------------------- arena, levelshot, readme
    if arena is not None:
        ok = (len(arena) == 1 and arena_pairs.get("map") == n and arena_pairs.get("longname")
              and arena_pairs.get("type"))
        rep.check("L25", "E", ok,
                  f"one block, map {arena_pairs.get('map')!r}, longname and type set")
        odd = [t for t in types if t not in sm.ARENA_GAMETYPES]
        rep.check("L26", "W", not odd, f"type tokens the menus know: {odd or 'yes'}")
        rep.check("L27", "W", arena_pairs.get("longname") == world.get("message"),
                  f"longname {arena_pairs.get('longname')!r}, message {world.get('message')!r}")
    if f"levelshots/{n}.tga" in names:
        tga = read("levelshots/{n}.tga")
        head = bytearray(18)
        head[2], head[12], head[14], head[16] = 2, 128, 128, 24
        rep.check("L28", "E", len(tga) == 18 + 128 * 128 * 3 and tga[:18] == bytes(head),
                  f"{len(tga):,} bytes, R_LevelShot's header: {tga[:18] == bytes(head)}")

    readme = read("{n}.txt").decode("utf-8", errors="replace")
    src = re.match(r"^(.*) by (.*), (\S+)$", world.get("_pcq_source") or "")
    lic = world.get("_pcq_license") or ""
    needs = {}
    if src:
        needs = {"the source": src.group(1), "its creator": src.group(2), "its link": src.group(3)}
    needs["its licence"] = lic
    cc = re.match(r"^CC-([A-Z-]+)-(\d+\.\d+)$", lic)
    link = f"creativecommons.org/licenses/{cc.group(1).lower()}/{cc.group(2)}" if cc else "http"
    needs["the licence's link"] = link
    spoken = f"CC {cc.group(1)} {cc.group(2)}" if cc else lic
    lacking = [what for what, text in needs.items()
               if not text or (text not in readme
                               and not (what == "its licence" and spoken in readme))]
    rep.check("L29", "E", src and not lacking, f"the readme names {', '.join(needs)}: "
              f"{('missing ' + ', '.join(lacking)) if lacking else 'yes'}")

    return finish(rep, pk3)


def _has_zip64_extra(extra):
    """Whether a zip entry's extra field holds a zip64 block (header id 0x0001)."""
    i = 0
    while i + 4 <= len(extra):
        hid = int.from_bytes(extra[i:i + 2], "little")
        size = int.from_bytes(extra[i + 2:i + 4], "little")
        if hid == 1:
            return True
        i += 4 + size
    return False


def _duplicates(ent):
    seen, dups = set(), []
    for k, _ in ent.pairs:
        if k.lower() in seen:
            dups.append(k)
        seen.add(k.lower())
    return dups


def finish(rep, pk3):
    print(f"=== lint {pk3}")
    for rule, level, ok, detail in sorted(rep.rows, key=lambda r: int(r[0][1:])):
        mark = "ok  " if ok else ("ERR " if level == "E" else "warn")
        print(f"  {mark} {rule:4s} {detail}")
    e, w = rep.errors(), rep.warnings()
    print(f"  {len(e)} error(s), {len(w)} warning(s): "
          f"{'REFUSED' if e else 'passes'}")
    sys.exit(1 if e else 0)


if __name__ == "__main__":
    main()
