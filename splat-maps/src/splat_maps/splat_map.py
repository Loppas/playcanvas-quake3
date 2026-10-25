"""The splat map format's shared pieces, for the scripts that write and check one.

A splat map is a Quake 3 map pk3 with its BSP swapped out: the splat, the collision octree and
the entity text sit where the BSP stood. The contract is `docs/map-format.md`; section numbers
below (§3.1 and so on) are its own. Citations are ioquake3 at 5883936 (`file:line` under
`code/`), splat-transform 3.1.6's `dist/cli.mjs`, or the port these scripts sit in (`src/...`).

What is here:
  - Q3's constants the format leans on, each with its source;
  - the tokenizer, entity text and arena block, read by Q3's own rules;
  - the four frames and the conversions between them;
  - the bake's sizes, chosen in Quake units and rounded as splat-transform rounds them;
  - a reader for the collision octree, answering in the sim's own voxels as the port does;
  - the splat-transform these scripts are pinned to: found, its version checked, and installed
    with npm when it is missing;
  - the splat a map draws, and the licence its bundle keeps.

Requires numpy (present in the `gsplat` conda env).
"""

import json
import math
import os
import re
import shutil
import subprocess
import zipfile

import numpy as np

# ------------------------------------------------------------------------------ constants

#: Quake units per metre, the port's scale (`src/coords.ts`).
UNITS_PER_METRE = 32

#: The player's box (`playerMins`, `playerMaxs`, g_client.c:27-28).
PLAYER_MINS = (-15, -15, -24)
PLAYER_MAXS = (15, 15, 32)

#: Crouched, the box's top drops to 16 (`CROUCH_HEIGHT`, bg_public.h:53); its foot stays at
#: -24 (`MINS_Z`, bg_public.h:50). The carve's box is never larger than this (§6.1).
CROUCH_MAXS_Z = 16
CARVE_LIMIT_UNITS = (PLAYER_MAXS[0] - PLAYER_MINS[0], CROUCH_MAXS_Z - PLAYER_MINS[2])  # 30 x 40

#: The highest rise the player steps up without jumping (`STEPSIZE`, bg_local.h:27).
STEPSIZE = 18

#: A rise of this much or less raises no step event; more raises EV_STEP_4..16
#: (`PM_StepSlideMove`, bg_slidemove.c:319-329), which the view smooths over 200 ms
#: (cg_event.c:619-646, cg_view.c:299-306).
STEP_EVENT_MIN = 2

#: The player spawns this far above a spot's origin (`SelectSpawnPoint`, g_client.c:246, :255).
SPAWN_RAISE = 9

#: The view stands this far above the origin (`DEFAULT_VIEWHEIGHT`, bg_public.h:52).
DEFAULT_VIEWHEIGHT = 26

#: The largest voxel the bake may use, in units (§6.1): the carve's box is at least three
#: voxels tall and must fit under the crouched player's 40.
MAX_VOXEL_UNITS = 13

#: Token and entity limits (q_shared.h:235, :237, :246; g_local.h:326-327).
MAX_TOKEN_CHARS = 1024
MAX_INFO_STRING = 1024
MAX_QPATH = 64
MAX_SPAWN_VARS = 64
MAX_SPAWN_VARS_CHARS = 4096

#: The stem: lowercase letters, digits and underscores, at most 44 characters, so that the
#: longest path, `maps/<n>.collision.glb`, fits `MAX_QPATH` with its NUL (§2.3).
STEM_RE = re.compile(r"^[a-z0-9_]{1,44}$")

#: The splat-transform version these scripts' frame calibration and bake sizing were measured on
#: (`docs/conventions.md`, "Current answer"). Anything else is refused, so moving the pin means
#: re-running calibrate_transform and re-measuring a bake first.
SPLAT_TRANSFORM_VERSION = "3.1.6"

#: Twelve classnames that bind an inline model, which a splat map does not have (§3.3):
#: `g_mover.c:978-1610`, and `InitTrigger` (g_trigger.c:26-33).
BRUSH_CLASSNAMES = frozenset((
    "func_door", "func_plat", "func_button", "func_train", "func_static", "func_rotating",
    "func_bobbing", "func_pendulum",
    "trigger_multiple", "trigger_push", "trigger_teleport", "trigger_hurt",
))

SPAWN_CLASSNAMES = ("info_player_deathmatch", "info_player_start")

#: Every classname baseq3's game knows: its spawn table (g_spawn.c:184-258) and item list
#: (bg_misc.c:44-921), as built without MISSIONPACK, and worldspawn, which has its own spawn
#: function (g_spawn.c:564). Matched exactly, since `G_CallSpawn` uses strcmp.
Q3_CLASSNAMES = frozenset((
    "worldspawn",
    "info_player_start", "info_player_deathmatch", "info_player_intermission", "info_null",
    "info_notnull", "info_camp", "func_plat", "func_button", "func_door", "func_static",
    "func_rotating", "func_bobbing", "func_pendulum", "func_train", "func_group", "func_timer",
    "trigger_always", "trigger_multiple", "trigger_push", "trigger_teleport", "trigger_hurt",
    "target_give", "target_remove_powerups", "target_delay", "target_speaker", "target_print",
    "target_laser", "target_score", "target_teleporter", "target_relay", "target_kill",
    "target_position", "target_location", "target_push", "light", "path_corner",
    "misc_teleporter_dest", "misc_model", "misc_portal_surface", "misc_portal_camera",
    "shooter_rocket", "shooter_grenade", "shooter_plasma", "team_CTF_redplayer",
    "team_CTF_blueplayer", "team_CTF_redspawn", "team_CTF_bluespawn", "item_botroam",
    "item_armor_shard", "item_armor_combat", "item_armor_body", "item_health_small",
    "item_health", "item_health_large", "item_health_mega", "weapon_gauntlet", "weapon_shotgun",
    "weapon_machinegun", "weapon_grenadelauncher", "weapon_rocketlauncher", "weapon_lightning",
    "weapon_railgun", "weapon_plasmagun", "weapon_bfg", "weapon_grapplinghook", "ammo_shells",
    "ammo_bullets", "ammo_grenades", "ammo_cells", "ammo_lightning", "ammo_rockets",
    "ammo_slugs", "ammo_bfg", "holdable_teleporter", "holdable_medkit", "item_quad",
    "item_enviro", "item_haste", "item_invis", "item_regen", "item_flight", "team_CTF_redflag",
    "team_CTF_blueflag",
))

#: g_gametype's values for the arena's `type` tokens, which the menus match ignoring case
#: (`GametypeBits`, ui_startserver.c:113-151). `clanarena` is the port's, for CPMA's Clan Arena,
#: which the port numbers 8.
ARENA_GAMETYPES = {"ffa": 0, "tourney": 1, "single": 2, "team": 3, "ctf": 4, "clanarena": 8}
GT_SINGLE_PLAYER, GT_TEAM = 2, 3

#: The names an entity's `gametype` key is searched for, by g_gametype (g_spawn.c:401). The port
#: reads the key as `team` in Clan Arena, which has no name of its own there.
GAMETYPE_NAMES = ("ffa", "tournament", "single", "team", "ctf", "oneflag", "obelisk", "harvester",
                  "team")


class FormatError(Exception):
    """Something Q3 itself would refuse, with Q3's own message where it has one."""


# ------------------------------------------------------------------------------ tokenizer


class Tokenizer:
    """Q3's `COM_ParseExt` over bytes (q_shared.c:461-570), one token at a time.

    Whitespace is every byte up to ' '. `char` is signed on x86, so Q3 also treats bytes of
    0x80 and above as whitespace; this follows it, and the lint refuses such bytes anyway.
    `//` and `/* */` comments are skipped. A quoted token runs to the next quote, across
    newlines, with no escapes. A token longer than 1023 bytes is cut short without a word; this
    records that in `truncated` so a checker can say so.
    """

    def __init__(self, data):
        self.data = data if isinstance(data, bytes) else data.encode("latin-1")
        self.pos = 0
        self.line = 1
        self.truncated = []

    @staticmethod
    def _space(c):
        return c <= 32 or c >= 128

    def _skip_whitespace(self):
        """SkipWhitespace: returns (at_end, crossed_newline)."""
        crossed = False
        d = self.data
        while self.pos < len(d) and self._space(d[self.pos]):
            if d[self.pos] == 0:
                return True, crossed
            if d[self.pos] == 10:
                self.line += 1
                crossed = True
            self.pos += 1
        return self.pos >= len(d), crossed

    def next(self, allow_line_breaks=True):
        """The next token, "" when a line break is hit and not allowed, or None at the end."""
        d = self.data
        while True:
            at_end, crossed = self._skip_whitespace()
            if at_end:
                return None
            if crossed and not allow_line_breaks:
                return ""
            c = d[self.pos]
            if c == 0x2F and d[self.pos + 1:self.pos + 2] == b"/":
                self.pos += 2
                while self.pos < len(d) and d[self.pos] != 10:
                    self.pos += 1
            elif c == 0x2F and d[self.pos + 1:self.pos + 2] == b"*":
                self.pos += 2
                while self.pos < len(d) and not (d[self.pos] == 0x2A
                                                 and d[self.pos + 1:self.pos + 2] == b"/"):
                    if d[self.pos] == 10:
                        self.line += 1
                    self.pos += 1
                if self.pos < len(d):
                    self.pos += 2
            else:
                break

        start_line = self.line
        out = bytearray()
        if c == 0x22:  # a quoted string
            self.pos += 1
            while self.pos < len(d):
                c = d[self.pos]
                self.pos += 1
                if c == 0x22 or c == 0:
                    break
                if c == 10:
                    self.line += 1
                out.append(c)
        else:
            while self.pos < len(d):
                c = d[self.pos]
                if c <= 32 or c >= 128:
                    break
                out.append(c)
                self.pos += 1
        if len(out) > MAX_TOKEN_CHARS - 1:
            self.truncated.append((start_line, len(out)))
            out = out[:MAX_TOKEN_CHARS - 1]
        return out.decode("latin-1")


# ------------------------------------------------------------------------------ entities


class Entity:
    """One `{ }` block: its key/value pairs in file order, and where it began."""

    def __init__(self, pairs, line):
        self.pairs = pairs
        self.line = line

    def get(self, key, default=None):
        """The first value for `key`, ignoring case, as `G_SpawnString` finds it
        (g_spawn.c:34-39)."""
        k = key.lower()
        for name, value in self.pairs:
            if name.lower() == k:
                return value
        return default

    @property
    def classname(self):
        return self.get("classname", "")

    def vector(self, key, default=(0.0, 0.0, 0.0)):
        """`G_SpawnVector`: "%f %f %f", with unread components left at the default
        (g_spawn.c:63-70)."""
        out = list(default)
        text = self.get(key)
        if text is None:
            return tuple(out)
        for i, part in enumerate(text.split()[:3]):
            out[i] = _atof(part)
        return tuple(out)

    def yaw(self):
        """The facing as `SP_info_player_deathmatch` reads it: `angles` is a vector, and `angle`
        overwrites it with (0, v, 0) (g_spawn.c:370-375). Only the yaw matters to a spawn."""
        angles = self.vector("angles")
        a = self.get("angle")
        if a is not None:
            angles = (0.0, _atof(a), 0.0)
        return angles[1]


def _atof(text):
    """C's `atof`: the longest leading number, and 0 for anything unreadable."""
    m = re.match(r"\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", text)
    return float(m.group(0)) if m else 0.0


def parse_entities(data):
    """The entity text as `G_SpawnEntitiesFromString` reads it (g_spawn.c:509-553, :623-642).

    Raises FormatError with Q3's message on a missing `{`, the end of the file inside a block,
    a `}` where a value should be, and past either per-entity limit. Returns the blocks and the
    tokenizer, whose `truncated` lists any token Q3 would have cut short.
    """
    tok = Tokenizer(data)
    entities = []
    while True:
        t = tok.next()
        if t is None:
            break
        if not t.startswith("{"):
            raise FormatError(f"G_ParseSpawnVars: found {t} when expecting {{ (line {tok.line})")
        line = tok.line
        pairs = []
        chars = 0
        while True:
            key = tok.next()
            if key is None:
                raise FormatError("G_ParseSpawnVars: EOF without closing brace")
            if key.startswith("}"):
                break
            value = tok.next()
            if value is None:
                raise FormatError("G_ParseSpawnVars: EOF without closing brace")
            if value.startswith("}"):
                raise FormatError(f"G_ParseSpawnVars: closing brace without data (line {tok.line})")
            if len(pairs) == MAX_SPAWN_VARS:
                raise FormatError(f"G_ParseSpawnVars: MAX_SPAWN_VARS (entity at line {line})")
            chars += len(key) + 1 + len(value) + 1
            if chars > MAX_SPAWN_VARS_CHARS:
                raise FormatError(
                    f"G_AddSpawnVarToken: MAX_SPAWN_VARS_CHARS (entity at line {line})")
            pairs.append((key, value))
        entities.append(Entity(pairs, line))
    if not entities:
        raise FormatError("SpawnEntities: no entities")
    return entities, tok


def format_entities(entities, notes=None):
    """Entity text in the layout q3map2 and NetRadiant write: a `// entity N` line, then one
    quoted pair per line. `notes` may give a comment for each entity's heading line."""
    lines = []
    for i, ent in enumerate(entities):
        pairs = ent.pairs if isinstance(ent, Entity) else ent
        note = notes[i] if notes and i < len(notes) and notes[i] else ""
        lines.append(f"// entity {i}" + (f": {note}" if note else ""))
        lines.append("{")
        for k, v in pairs:
            if '"' in k or '"' in v:
                raise FormatError(f'a quote cannot be written inside a token: "{k}" "{v}"')
            lines.append(f'"{k}" "{v}"')
        lines.append("}")
    return "\n".join(lines) + "\n"


def spawn_spots(entities):
    """The entities a player can spawn at, in file order (g_client.c:37-56)."""
    return [e for e in entities if e.classname in SPAWN_CLASSNAMES]


def _atoi(text):
    """C's `atoi`: the leading integer, and 0 for anything unreadable."""
    m = re.match(r"\s*[+-]?\d+", text or "")
    return int(m.group(0)) if m else 0


def survives(ent, gametype):
    """Whether Q3 keeps `ent` in `gametype`, a g_gametype value
    (`G_SpawnGEntityFromSpawnVars`, g_spawn.c:410-463). baseq3 reads `notq3a`, not `notta`."""
    if gametype == GT_SINGLE_PLAYER and _atoi(ent.get("notsingle", "0")):
        return False
    if gametype >= GT_TEAM:
        if _atoi(ent.get("notteam", "0")):
            return False
    elif _atoi(ent.get("notfree", "0")):
        return False
    if _atoi(ent.get("notq3a", "0")):
        return False
    value = ent.get("gametype")
    if value is not None and GAMETYPE_NAMES[gametype] not in value:
        return False
    return True


def judge_spawns(octree, entities):
    """Each spawn spot as the bake and the lint both judge it (`map-format.md` L20, L21): the
    spawned box's solid voxels, its drop, and how Q3 grades the landing at the map's gravity.
    `PM_CrashLand` grades an impact by 0.0002 g h (bg_pmove.c:954-992): over 7 thuds, and over 40
    hurts (g_active.c:556-567)."""
    g = _atof(entities[0].get("gravity", "800"))
    out = []
    for e in spawn_spots(entities):
        o = e.vector("origin")
        z = o[2] + SPAWN_RAISE
        mins = (o[0] + PLAYER_MINS[0], o[1] + PLAYER_MINS[1], z + PLAYER_MINS[2])
        maxs = (o[0] + PLAYER_MAXS[0], o[1] + PLAYER_MAXS[1], z + PLAYER_MAXS[2])
        solid = octree.sim_box_solid_cells(mins, maxs)
        drop = octree.sim_drop(mins, maxs) if not solid else None
        if drop is None:
            landing = "never" if not solid else "n/a"
        else:
            delta = 0.0002 * g * drop
            landing = "hurts" if delta > 40 else ("thuds" if delta > 7 else "silent")
        out.append({"origin": list(o), "solid_voxels": solid, "drop": drop, "landing": landing})
    return out


# ------------------------------------------------------------------------------ arena block


def parse_arena(data):
    """The arena file as `G_ParseInfos` reads it (g_bot.c:68-110): a list of blocks, each a list
    of (key, value) pairs in order.

    A value is read without crossing a line break, so one missing from its key's line becomes
    `<NULL>`. `Info_SetValueForKey` refuses `\\`, `;` and `"` (q_shared.c:1330-1345); this raises
    on them rather than dropping the pair as Q3 does.
    """
    tok = Tokenizer(data)
    blocks = []
    while True:
        t = tok.next()
        if not t:
            break
        if t != "{":
            raise FormatError("Missing { in info file")
        pairs = []
        while True:
            key = tok.next()
            if not key:
                raise FormatError("Unexpected end of info file")
            if key == "}":
                break
            value = tok.next(allow_line_breaks=False)
            if not value:
                value = "<NULL>"
            for text in (key, value):
                if any(ch in text for ch in '\\;"'):
                    raise FormatError(f"Can't use keys or values with a \\ ; or \": {text}")
            pairs.append((key, value))
        size = sum(len(k) + len(v) + 2 for k, v in pairs)
        if size >= MAX_INFO_STRING:
            raise FormatError(f"Info string length exceeded ({size} bytes)")
        blocks.append(pairs)
    return blocks


def format_arena(pairs):
    """One arena block as retail writes it: keys bare, values quoted, one pair per line."""
    lines = ["{"]
    for k, v in pairs:
        if any(ch in k + v for ch in '\\;"') or any(ch.isspace() for ch in k):
            raise FormatError(f"not a valid arena pair: {k} {v}")
        lines.append(f'{k} "{v}"')
    lines.append("}")
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------------------ frames
#
# sim: Q3 units, +Z up. world: metres, +Y up (the .sog). octree: world under splat-transform's
# ST_FRAME = diag(-1, -1, 1). These are the port's `src/coords.ts`, unchanged (§6).


def sim_to_world(p):
    x, y, z = p
    return (x / UNITS_PER_METRE, z / UNITS_PER_METRE, -y / UNITS_PER_METRE)


def world_to_sim(p):
    x, y, z = p
    return (x * UNITS_PER_METRE, -z * UNITS_PER_METRE, y * UNITS_PER_METRE)


def sim_to_octree(p):
    x, y, z = p
    return (-x / UNITS_PER_METRE, -z / UNITS_PER_METRE, -y / UNITS_PER_METRE)


def octree_to_sim(p):
    x, y, z = p
    return (-x * UNITS_PER_METRE, -z * UNITS_PER_METRE, -y * UNITS_PER_METRE)


def fmt_num(v):
    """A number as a flag or key wants it: no exponent, no trailing zeros."""
    s = f"{v:.10f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


# ------------------------------------------------------------------------------ bake sizes (§6.1)


def carve_voxels(h_m, r_m, v_m):
    """The carve's half-extents in voxels, exactly as splat-transform rounds them:
    `kernelR = ceil(r / v)` and `yHalfExtent = ceil(h / (2v))` (`carve`, cli.mjs). Python's
    floats are IEEE doubles, as JavaScript's are, so the rounding is the same."""
    return math.ceil(r_m / v_m), math.ceil(h_m / (2 * v_m))


def carve_box_units(h_m, r_m, v_m):
    """The box a `--voxel-carve h,r` at `--voxel-size v` really is, in units: `2k+1` voxels wide
    and `2j+1` tall, centred on one cell (`carve` and `gpuDilate3`, cli.mjs)."""
    k, j = carve_voxels(h_m, r_m, v_m)
    v_u = v_m * UNITS_PER_METRE
    return (2 * k + 1) * v_u, (2 * j + 1) * v_u


def bake_sizes(voxel_units, fill_units):
    """The bake's flags for a voxel of `voxel_units`, per §6.1.

    The carve's box is the largest that fits the crouched player, 30 x 40:
    k = floor((30/v - 1)/2) and j = floor((40/v - 1)/2). Each flag sits half a voxel inside its
    rounding boundary, so floating point cannot tip it: r = (k - 1/2)v (0 when k is 0) and
    h = (2j - 1)v. The external fill's dilation is ceil(fill/v) voxels, passed the same way.
    Returns the flags in metres and what they round to.
    """
    v = int(voxel_units)
    if v != voxel_units or not 1 <= v <= MAX_VOXEL_UNITS:
        raise FormatError(f"the voxel must be a whole number of units from 1 to "
                          f"{MAX_VOXEL_UNITS} (map-format.md section 6.1), not {voxel_units}")
    w_lim, h_lim = CARVE_LIMIT_UNITS
    # floor((30/v - 1)/2) and floor((40/v - 1)/2), in integers so nothing rounds
    k = (w_lim - v) // (2 * v)
    j = (h_lim - v) // (2 * v)
    if j < 1:
        raise FormatError(f"a {v}-unit voxel leaves no carve box under {h_lim} units")
    v_m = v / UNITS_PER_METRE
    r_m = (k - 0.5) * v / UNITS_PER_METRE if k > 0 else 0.0
    h_m = (2 * j - 1) * v / UNITS_PER_METRE
    kf = math.ceil(fill_units / v)
    fill_m = (kf - 0.5) * v / UNITS_PER_METRE
    if carve_voxels(h_m, r_m, v_m) != (k, j) or math.ceil(fill_m / v_m) != kf:
        raise FormatError("the derived flags do not round back to their boxes")
    box = carve_box_units(h_m, r_m, v_m)
    if box[0] > w_lim or box[1] > h_lim:
        raise FormatError(f"carve box {box} is larger than the crouched player {CARVE_LIMIT_UNITS}")
    return {
        "voxel_m": v_m, "carve_h_m": h_m, "carve_r_m": r_m, "fill_m": fill_m,
        "carve_voxels": (k, j), "carve_box_units": box,
        "fill_voxels": kf, "fill_seals_under_units": 2 * kf * v,
    }


# ------------------------------------------------------------------------------ octree

SOLID_LEAF_MARKER = 0xFF000000
LEAF_SIZE = 4


class Octree:
    """splat-transform's collision octree, `.voxel.json` + `.voxel.bin`, read as the port reads
    it (`src/sim/voxel-svo.ts`). Cells are indexed from `gridBounds.min` in the octree's own
    frame; everything outside the grid is solid."""

    def __init__(self, header, nodes, leaf_data):
        self.header = header
        self.nodes = nodes
        self.leaf_data = leaf_data
        self.vr = float(header["voxelResolution"])
        self.depth = int(header["treeDepth"])
        self.gmin = np.array(header["gridBounds"]["min"], dtype=np.float64)
        self.gmax = np.array(header["gridBounds"]["max"], dtype=np.float64)
        block = LEAF_SIZE * self.vr
        self.blocks = tuple(int(round((self.gmax[i] - self.gmin[i]) / block)) for i in range(3))
        self.shape = tuple(b * LEAF_SIZE for b in self.blocks)
        self._dense = None

    @classmethod
    def load(cls, json_path):
        """Read and check a bake: the lengths `SparseVoxelOctree.fromBuffers` checks
        (`src/sim/voxel-svo.ts`), and a `leafSize` of 4. Raises FormatError on a mismatch."""
        with open(json_path, encoding="utf-8") as fh:
            header = json.load(fh)
        bin_path = json_path[:-len(".json")] + ".bin"
        with open(bin_path, "rb") as fh:
            raw = fh.read()
        return cls.from_bytes(header, raw)

    @classmethod
    def from_bytes(cls, header, raw):
        expected = (header["nodeCount"] + header["leafDataCount"]) * 4
        if len(raw) != expected:
            raise FormatError(f"voxel.bin size {len(raw)} != header (nodeCount + leafDataCount) "
                              f"* 4 = {expected}")
        if header["leafDataCount"] != header["numMixedLeaves"] * 2:
            raise FormatError(f"header leafDataCount {header['leafDataCount']} != 2 * "
                              f"numMixedLeaves {header['numMixedLeaves'] * 2}")
        if header.get("leafSize") != LEAF_SIZE:
            raise FormatError(f"leafSize {header.get('leafSize')} != {LEAF_SIZE}")
        words = np.frombuffer(raw, dtype="<u4")
        nodes = words[:header["nodeCount"]]
        leaf = words[header["nodeCount"]:]
        return cls(header, nodes, leaf)

    # -- structure

    def validate(self):
        """Walk the tree from the root and tally it, as `validate()` does (voxel-svo.ts). A
        correct read reaches every node once and matches the header's counts."""
        stats = {"interior": 0, "mixed": 0, "solid": 0, "visited": 0, "duplicates": 0}
        if len(self.nodes) == 0:
            return stats
        seen = np.zeros(len(self.nodes), dtype=bool)
        pairs = set()
        stack = [0]
        nodes = self.nodes
        while stack:
            idx = stack.pop()
            if seen[idx]:
                stats["duplicates"] += 1
                continue
            seen[idx] = True
            stats["visited"] += 1
            node = int(nodes[idx])
            if node == SOLID_LEAF_MARKER:
                stats["solid"] += 1
            elif node >> 24:
                stats["interior"] += 1
                mask, first = node >> 24, node & 0xFFFFFF
                n = bin(mask).count("1")
                stack.extend(range(first, first + n))
            else:
                stats["mixed"] += 1
                pairs.add(node)
        stats["leaf_pairs"] = len(pairs)
        h = self.header
        problems = []
        if stats["interior"] != h["numInteriorNodes"]:
            problems.append(f"interior nodes {stats['interior']} != header {h['numInteriorNodes']}")
        if stats["mixed"] != h["numMixedLeaves"]:
            problems.append(f"mixed leaves {stats['mixed']} != header {h['numMixedLeaves']}")
        if stats["visited"] != h["nodeCount"] or stats["duplicates"]:
            problems.append(f"reached {stats['visited']} of {h['nodeCount']} nodes, "
                            f"{stats['duplicates']} twice")
        stats["problems"] = problems
        return stats

    def cells_from_origin(self):
        """`gridBounds.min` in whole cells. The port asserts it lies on a whole cell, in
        `SvoVoxelGrid`'s constructor (`src/svo-voxel-grid.ts`); this raises the same way."""
        out = []
        for axis, m in zip("xyz", self.gmin):
            c = m / self.vr
            if abs(c - round(c)) > 1e-9:
                raise FormatError(f"gridBounds.min {axis}={m} is not a whole multiple of "
                                  f"voxelResolution {self.vr}")
            out.append(int(round(c)))
        return tuple(out)

    def voxel_units(self):
        return self.vr * UNITS_PER_METRE

    # -- dense decode

    def dense(self):
        """The whole grid as a bool array indexed [ix, iy, iz], True for solid. Built once."""
        if self._dense is not None:
            return self._dense
        nbx, nby, nbz = self.blocks
        grid = np.zeros(self.shape, dtype=bool)
        if len(self.nodes) == 0:
            self._dense = grid
            return grid
        nodes = self.nodes
        mixed_idx, mixed_b = [], []
        # (node index, level, block x/y/z of the subtree's lowest corner)
        stack = [(0, self.depth, 0, 0, 0)]
        while stack:
            idx, level, bx, by, bz = stack.pop()
            node = int(nodes[idx])
            if node == SOLID_LEAF_MARKER:
                span = 1 << level
                x0, y0, z0 = bx * 4, by * 4, bz * 4
                grid[x0:min(x0 + span * 4, self.shape[0]),
                     y0:min(y0 + span * 4, self.shape[1]),
                     z0:min(z0 + span * 4, self.shape[2])] = True
                continue
            if level == 0:
                mixed_idx.append(node)
                mixed_b.append((bx, by, bz))
                continue
            mask, first = node >> 24, node & 0xFFFFFF
            rank = 0
            half = 1 << (level - 1)
            for oct_ in range(8):
                if mask & (1 << oct_):
                    stack.append((first + rank, level - 1,
                                  bx + (half if oct_ & 1 else 0),
                                  by + (half if oct_ & 2 else 0),
                                  bz + (half if oct_ & 4 else 0)))
                    rank += 1
        all_idx = np.asarray(mixed_idx, dtype=np.int64)
        all_b = np.asarray(mixed_b, dtype=np.int64).reshape(-1, 3) * 4
        ar = np.arange(4)
        for c0 in range(0, len(all_idx), 100_000):  # in chunks, to bound the temporaries
            li = all_idx[c0:c0 + 100_000]
            b = all_b[c0:c0 + 100_000]
            lo = self.leaf_data[2 * li].astype(np.uint64)
            hi = self.leaf_data[2 * li + 1].astype(np.uint64)
            masks = lo | (hi << np.uint64(32))
            bits = ((masks[:, None] >> np.arange(64, dtype=np.uint64)) & np.uint64(1)).astype(bool)
            # bit lx + 4*ly + 16*lz, so reshaped [lz][ly][lx], then turned to [lx][ly][lz]
            bits = bits.reshape(-1, 4, 4, 4).transpose(0, 3, 2, 1)
            ix = (b[:, 0, None] + ar)[:, :, None, None]
            iy = (b[:, 1, None] + ar)[:, None, :, None]
            iz = (b[:, 2, None] + ar)[:, None, None, :]
            ix, iy, iz = np.broadcast_arrays(ix, iy, iz)
            keep = (ix < self.shape[0]) & (iy < self.shape[1]) & (iz < self.shape[2])
            grid[ix[keep], iy[keep], iz[keep]] = bits[keep]
        self._dense = grid
        return grid

    def is_solid_cell(self, ix, iy, iz):
        if not (0 <= ix < self.shape[0] and 0 <= iy < self.shape[1] and 0 <= iz < self.shape[2]):
            return True
        return bool(self.dense()[ix, iy, iz])

    # -- the sim's view, as the port's trace sees it

    def sim_voxel_to_cell(self, vx, vy, vz):
        """The octree cell holding sim voxel (vx, vy, vz): `SvoVoxelGrid.isSolid`'s exact map
        (`src/svo-voxel-grid.ts`). Sim voxel vx covers sim x in [vx*s, (vx+1)*s)."""
        gx, gy, gz = self.cells_from_origin()
        return -vx - gx - 1, -vz - gy - 1, -vy - gz - 1

    def sim_box_solid_cells(self, mins, maxs):
        """How many solid voxels the open box (mins, maxs), in sim units, overlaps. A box that
        only touches a voxel's face does not overlap it."""
        s = self.voxel_units()
        lo = [math.floor(m / s) for m in mins]
        hi = [math.ceil(m / s) - 1 for m in maxs]
        vx = np.arange(lo[0], hi[0] + 1)
        vy = np.arange(lo[1], hi[1] + 1)
        vz = np.arange(lo[2], hi[2] + 1)
        gx, gy, gz = self.cells_from_origin()
        cx = (-vx - gx - 1)[:, None, None]
        cz = (-vy - gz - 1)[None, :, None]
        cy = (-vz - gy - 1)[None, None, :]
        cx, cy, cz = np.broadcast_arrays(cx, cy, cz)
        inside = ((cx >= 0) & (cx < self.shape[0]) & (cy >= 0) & (cy < self.shape[1])
                  & (cz >= 0) & (cz < self.shape[2]))
        g = self.dense()
        solid = ~inside
        solid[inside] = g[cx[inside], cy[inside], cz[inside]]
        return int(solid.sum())

    def sim_open(self):
        """The grid's open space in sim axes: a bool array indexed [x, y, z], each index rising
        with its sim coordinate, and the sim voxel index of element (0, 0, 0)."""
        g = self.dense()
        sim = np.transpose(g, (0, 2, 1))[::-1, ::-1, ::-1]
        gx, gy, gz = self.cells_from_origin()
        nx, ny, nz = sim.shape
        # octree cell c = -v - g0 - 1 and array index a = n - 1 - c, so v = a - (n - 1) - g0 - 1
        v0 = (-(nx - 1) - gx - 1, -(ny - 1) - gz - 1, -(nz - 1) - gy - 1)
        return ~sim, v0

    def player_reach(self, foot, below, height=CROUCH_MAXS_Z - PLAYER_MINS[2]):
        """Where the player's box can go from the box whose lowest corner is `foot`, in sim units.

        The box is the player's, 30 wide and `height` tall (crouched by default), on the voxel
        lattice: it fits wherever ceil(30/s) x ceil(30/s) x ceil(height/s) voxels are open,
        which is the smallest run of voxels a 30-unit box can stand in. Two fits one voxel
        apart are joined, since the box slides between them through their union. This is what
        a player could reach with any amount of jumping, so it bounds where they can fall to.
        Returns the reachable positions' count, feet heights and footprint in units, and how
        many have their feet more than `below` units under the polished floor (z = 0). Summed
        by reductions rather than listed, since a fine bake has hundreds of millions.
        """
        from scipy import ndimage as ndi

        s = self.voxel_units()
        open_, v0 = self.sim_open()
        w = int(math.ceil((PLAYER_MAXS[0] - PLAYER_MINS[0]) / s))
        h = int(math.ceil(height / s))
        fit = open_.view(np.uint8)
        for axis, n in ((0, w), (1, w), (2, h)):
            # origin -(n // 2) anchors each window at its low end: fit[i] covers [i, i + n),
            # and the grid's outside counts as closed
            fit = ndi.minimum_filter1d(fit, n, axis=axis, origin=-(n // 2), mode="constant", cval=0)
        fit = fit.astype(bool)
        del open_
        lab, _ = ndi.label(fit)
        del fit
        a = [int(math.floor(foot[i] / s)) - v0[i] for i in range(3)]
        found = 0
        for d in range(0, 2 * h):
            sl = tuple(slice(max(0, a[i] - d), max(0, a[i] + d + 1)) for i in range(3))
            ids = lab[sl]
            ids = ids[ids > 0]
            if ids.size:
                found = int(np.bincount(ids).argmax())
                break
        if not found:
            return None
        mask = lab == found
        del lab

        def extent(axis):
            other = tuple(i for i in range(3) if i != axis)
            hit = np.flatnonzero(mask.any(axis=other))
            return float((hit[0] + v0[axis]) * s), float((hit[-1] + v0[axis]) * s)

        zc = max(0, int(math.ceil(-below / s - v0[2])))
        return {"positions": int(np.count_nonzero(mask)), "box_voxels": (w, w, h),
                "x": extent(0), "y": extent(1), "feet": extent(2),
                "under": int(np.count_nonzero(mask[:, :, :zc]))}

    def sim_drop(self, mins, maxs, limit=4096):
        """How far the box can fall straight down, in units, before it rests on a solid voxel:
        the gap between its foot and the highest solid voxel top under its footprint. None when
        nothing solid lies within `limit`."""
        s = self.voxel_units()
        foot = mins[2]
        lo_x, hi_x = math.floor(mins[0] / s), math.ceil(maxs[0] / s) - 1
        lo_y, hi_y = math.floor(mins[1] / s), math.ceil(maxs[1] / s) - 1
        top = math.ceil(foot / s) - 1  # the voxel layer just under the foot
        for vz in range(top, top - int(limit / s) - 1, -1):
            probe_min = (lo_x * s + 0.5, lo_y * s + 0.5, vz * s + 0.5)
            probe_max = ((hi_x + 1) * s - 0.5, (hi_y + 1) * s - 0.5, (vz + 1) * s - 0.5)
            if self.sim_box_solid_cells(probe_min, probe_max):
                return foot - (vz + 1) * s
        return None


# ------------------------------------------------------------------------------ splat-transform


def _npm_command(name):
    """The command npm put on PATH as `name`, in the form a subprocess can start, or None.

    On Windows npm writes a `.cmd` beside a bare shell script, which CreateProcess cannot run
    (WinError 2) and which some Pythons' `shutil.which` finds first, so the `.cmd` is asked for.
    """
    return shutil.which(f"{name}.cmd" if os.name == "nt" else name)


def find_splat_transform():
    """splat-transform on PATH, whatever its version, or None."""
    return _npm_command("splat-transform")


def splat_transform_version(exe):
    """The version `exe --version` prints, e.g. "3.1.6", or None."""
    run = subprocess.run([exe, "--version"], capture_output=True, text=True)
    m = re.search(r"v(\d+\.\d+\.\d+)", run.stdout + run.stderr)
    return m.group(1) if m else None


def require_splat_transform():
    """The pinned splat-transform, installed with npm if none is on PATH. A FormatError if
    another version is, or if npm cannot install it."""
    package = f"@playcanvas/splat-transform@{SPLAT_TRANSFORM_VERSION}"
    exe = find_splat_transform()
    if not exe:
        npm = _npm_command("npm")
        if not npm:
            raise FormatError(f"splat-transform is not on PATH, and nor is npm to install "
                              f"{package}: put Node and its npm on PATH")
        print(f"  splat-transform is not on PATH: npm install -g {package}", flush=True)
        if subprocess.run([npm, "install", "-g", package]).returncode != 0:
            raise FormatError(f"npm could not install {package}")
        exe = find_splat_transform()
        if not exe:
            raise FormatError(f"npm installed {package}, but not into a folder on PATH")
    got = splat_transform_version(exe)
    if got != SPLAT_TRANSFORM_VERSION:
        raise FormatError(f"splat-transform {got} is on PATH, but these scripts are calibrated "
                          f"for {SPLAT_TRANSFORM_VERSION}. Install it with `npm install -g "
                          f"{package}`, or re-run calibrate_transform and re-measure the bake "
                          "before moving the pin")
    return exe


def stem_of(path, suffix):
    """`dir/garage_rats.voxel.json` -> `garage_rats` for suffix `.voxel.json`."""
    base = os.path.basename(path)
    if not base.lower().endswith(suffix):
        raise FormatError(f"{base} does not end in {suffix}")
    return base[:-len(suffix)]


# ------------------------------------------------------------------------------ the drawn splat

#: The splat the bake filters out of the polished `<stem>.sog`, beside it.
DRAWN_SUFFIX = ".drawn.sog"


def drawn_splat(sog):
    """The splat the map at `sog` draws: the one the bake record beside it names, which the bake
    filtered from `sog` and baked its collision from, or else `sog` itself. A FormatError if the
    record names a file that is not there."""
    here = os.path.dirname(os.path.abspath(sog))
    record = os.path.join(here, stem_of(sog, ".sog") + ".bake.json")
    drawn = None
    if os.path.exists(record):
        with open(record, encoding="utf-8") as fh:
            drawn = json.load(fh).get("drawn")
    if not drawn:
        return sog
    path = os.path.join(here, drawn)
    if not os.path.exists(path):
        raise FormatError(f"the bake record names the drawn splat {drawn}, which is missing: "
                          "bake again")
    return path


def put_license(sog, lic_bytes):
    """`lic_bytes` into the SOG bundle `sog` as its `license.txt`, stored, as superspl.at's
    bundles hold it, unless it holds one already: `splat-transform -w` drops a bundle's. Returns
    what reading it back finds wrong."""
    with zipfile.ZipFile(sog) as z:
        has = "license.txt" in z.namelist()
    if not has:
        with zipfile.ZipFile(sog, "a", compression=zipfile.ZIP_STORED) as z:
            z.writestr("license.txt", lic_bytes)
    problems = []
    with zipfile.ZipFile(sog) as z:
        bad = z.testzip()
        if bad:
            problems.append(f"{os.path.basename(sog)} fails its CRC check at {bad}")
        if z.read("license.txt") != lic_bytes:
            problems.append(f"license.txt in {os.path.basename(sog)} differs from the one it "
                            "was given")
    return problems
