import type { PakFileSystem } from '../pak/vfs';
import { vec3, type Vec3 } from '../sim/vec3';
import { atof, atoi, scanFloats } from './c-scan';
import { comParse, parseCursor, textOfBytes } from './com-parse';
import { splatMapFiles } from './splat-map';

/**
 * A map's entities as text: Quake 3's entity lump, which a BSP carries as its lump 0 and a splat
 * map carries beside its splat as `maps/<n>.ent` (`splat-maps/docs/map-format.md` §3).
 *
 * Each entity is a block of key/value pairs between braces, the first of them `worldspawn`. What
 * the pairs mean is the game module's business, and this reads only what Q3 checks while it
 * reads: the braces, the pairs and the limits (`G_ParseSpawnVars`, `g_spawn.c:509–553`). The
 * game module pulls the tokens one at a time, as `trap_GetEntityToken` hands them over, so that
 * an entity is spawned before the next one is read.
 *
 * Engine-free, like the other readers.
 */

/** `MAX_SPAWN_VARS` (`g_local.h:326`): the pairs one entity may hold. */
export const MAX_SPAWN_VARS = 64;

/**
 * `MAX_SPAWN_VARS_CHARS` (`g_local.h:327`): the bytes one entity's keys and values may take,
 * each with its NUL.
 */
export const MAX_SPAWN_VARS_CHARS = 4096;

/** One key and its value. */
export type SpawnVar = readonly [key: string, value: string];

/** One entity's pairs in the text's order: `level.spawnVars`. */
export type SpawnVars = readonly SpawnVar[];

/**
 * A splat map's entity text, read through the search path from `maps/<n>.ent`, where `CM_LoadMap`
 * reads a BSP's lump 0 (`cm_load.c:612`, `:646`).
 *
 * A map with none does not start. Q3 checks for the BSP before it changes anything, and says
 * `Can't find map` with the path it looked for (`SV_Map_f`, `sv_ccmds.c:165–171`).
 *
 * @param fs - The search path.
 * @param name - The map's name, as `map <n>` takes it.
 * @returns the text, a byte to a character
 */
export async function readEntityText(
  fs: Pick<PakFileSystem, 'read'>,
  name: string
): Promise<string> {
  const path = splatMapFiles(name).entities;
  const bytes = await fs.read(path);
  if (!bytes) throw new Error(`Can't find map ${path}`);
  return textOfBytes(bytes);
}

/**
 * `trap_GetEntityToken`: the next token of the entity text, or `null` once it has run out.
 *
 * An empty quoted string is a token, not the end: the end is when the tokenizer found nothing at
 * all (`SV_GameSystemCalls`, `sv_game.c:408–419`).
 */
export type EntityTokens = () => string | null;

/**
 * The tokens of an entity text, from the start, as `sv.entityParsePoint` hands them over: the
 * host starts it again on every map load and every `map_restart` (`sv_game.c:879`).
 *
 * @param text - The entity text, a byte to a character.
 */
export function entityTokens(text: string): EntityTokens {
  const cursor = parseCursor(text);
  return () => {
    const token = comParse(cursor);
    return cursor.at === null && token === '' ? null : token;
  };
}

/**
 * `G_ParseSpawnVars` (`g_spawn.c:509–553`): the next entity's pairs.
 *
 * Only a token's first character is looked at for a brace, as Q3 looks, so `{x` opens a block and
 * a key of `}x` closes one.
 *
 * @param next - Where the tokens come from.
 * @returns the pairs, or `null` when there are no more entities
 * @throws with Q3's `G_Error` for a block that does not open with a brace, one the text ends in, a
 *   brace where a value should be, and an entity past either limit
 */
export function parseSpawnVars(next: EntityTokens): SpawnVar[] | null {
  const open = next();
  if (open === null) return null;
  if (open[0] !== '{') throw new Error(`G_ParseSpawnVars: found ${open} when expecting {`);

  const vars: SpawnVar[] = [];
  let chars = 0;
  // `G_AddSpawnVarToken` (`g_spawn.c:482–497`): a key or value, and its NUL, into the entity's
  // buffer.
  const add = (token: string) => {
    chars += token.length + 1;
    if (chars > MAX_SPAWN_VARS_CHARS) {
      throw new Error('G_AddSpawnVarToken: MAX_SPAWN_VARS_CHARS');
    }
  };

  for (;;) {
    const key = next();
    if (key === null) throw new Error('G_ParseSpawnVars: EOF without closing brace');
    if (key[0] === '}') break;

    const value = next();
    if (value === null) throw new Error('G_ParseSpawnVars: EOF without closing brace');
    if (value[0] === '}') throw new Error('G_ParseSpawnVars: closing brace without data');
    if (vars.length === MAX_SPAWN_VARS) throw new Error('G_ParseSpawnVars: MAX_SPAWN_VARS');

    add(key);
    add(value);
    vars.push([key, value]);
  }
  return vars;
}

/**
 * Every entity of a text, in order: the reading half of `G_SpawnEntitiesFromString`, for what
 * reads a map's entities without spawning them.
 *
 * @throws as {@link parseSpawnVars} does
 */
export function readEntities(text: string): SpawnVar[][] {
  const next = entityTokens(text);
  const entities: SpawnVar[][] = [];
  for (let vars = parseSpawnVars(next); vars; vars = parseSpawnVars(next)) entities.push(vars);
  return entities;
}

/**
 * `G_SpawnString` (`g_spawn.c:26–43`): a key's value, the first of them if it is there twice,
 * matched without regard to case.
 *
 * @returns the value, or `fallback` for a key that is not there
 */
export function spawnString(vars: SpawnVars, key: string, fallback: string): string {
  return spawnVar(vars, key) ?? fallback;
}

/** `G_SpawnInt` (`g_spawn.c:54–61`): {@link spawnString} read by `atoi`. */
export function spawnInt(vars: SpawnVars, key: string, fallback: string): number {
  return atoi(spawnString(vars, key, fallback));
}

/**
 * `G_SpawnFloat` (`g_spawn.c:45–52`): {@link spawnString} read by `atof` into a C float, so
 * `"0.7"` is 0.699999988.
 */
export function spawnFloat(vars: SpawnVars, key: string, fallback: string): number {
  return Math.fround(atof(spawnString(vars, key, fallback)));
}

/**
 * `G_SpawnVector` (`g_spawn.c:63–70`): {@link spawnString} read by `sscanf`'s `"%f %f %f"`.
 * A component the value does not give keeps what `into` held.
 *
 * @param into - The vector to write, in place.
 * @returns whether the key was there
 */
export function spawnVector(vars: SpawnVars, key: string, fallback: string, into: Vec3): boolean {
  const value = spawnVar(vars, key);
  scanVector(value ?? fallback, into);
  return value !== undefined;
}

/**
 * A vector as `G_SpawnVector` reads one: `"%f %f %f"` into a `vec3_t`, so each component a C
 * float, with a component the text does not give left as it was.
 *
 * @param into - The vector to write, in place.
 */
export function scanVector(text: string, into: Vec3): Vec3 {
  const [x, y, z] = scanFloats(text);
  if (x !== undefined) into.x = Math.fround(x);
  if (y !== undefined) into.y = Math.fround(y);
  if (z !== undefined) into.z = Math.fround(z);
  return into;
}

/**
 * A vector as `G_ParseField`'s `F_VECTOR` reads one, the components the text does not give 0.
 * Q3 reads into a local it never clears (`g_spawn.c:347`), so it leaves them undefined, and 0 is
 * the port's answer.
 */
export function parseVector(text: string): Vec3 {
  return scanVector(text, vec3());
}

/**
 * A key's value, the first of them if it is there twice, matched without regard to case: what
 * `G_SpawnString` finds, with `undefined` telling a missing key from an empty one.
 */
export function spawnVar(vars: SpawnVars, key: string): string | undefined {
  const wanted = key.toLowerCase();
  return vars.find(([name]) => name.toLowerCase() === wanted)?.[1];
}
