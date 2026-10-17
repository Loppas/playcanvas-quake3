/**
 * Cvars, as everything that reads one sees them — `qcommon/cvar.c` from the outside.
 *
 * A cvar is the one thing in Quake 3 that the server, the game module and the console all write
 * and all read, which is why it is here rather than on either side of the seam: the host asks for
 * `sv_maxclients` and `nextmap`, and the game module asks for the rest. The store itself belongs
 * to whoever is running the port — in the app it is `settings/cvars.ts`.
 */
export interface CvarStore {
  /**
   * `Cvar_VariableString`, which the game module reaches through
   * `trap_Cvar_VariableStringBuffer`: the cvar's value, or `''` if it has never been set.
   */
  get(name: string): string;
  /** `Cvar_Set`. */
  set(name: string, value: string): void;
  /**
   * `Cvar_SetSafe` (`cvar.c:628–652`): a server's own set of a cvar it sent in its systeminfo,
   * which `CL_SystemInfoChanged` applies (`cl_parse.c:388–430`). A key the client has never held
   * is created read-only; a key the client holds and the server may not set is refused. Whether
   * the value was taken.
   */
  setServer(name: string, value: string): boolean;
  /**
   * `vmCvar_t.modificationCount`, which `trap_Cvar_Update` refreshes: how many times this cvar
   * has been given a value different from the one it had.
   *
   * Setting a cvar to what it already holds is not a modification, so a caller comparing this
   * against a remembered copy learns exactly what Quake 3 learns — that somebody changed it.
   */
  modificationCount(name: string): number;
  /**
   * `cvar_modifiedFlags`' news as a count: how many times any cvar has been given a value
   * different from the one it had. A reader that remembers it learns whether anything has changed
   * since it last looked, as Q3's frame does from the flags, before it asks which by name.
   */
  totalModifications(): number;
}
