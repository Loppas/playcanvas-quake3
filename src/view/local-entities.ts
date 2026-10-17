/**
 * cgame's local entities as one pool (`cg_localents.c:29–100`): every effect the client makes and
 * lets go of itself takes a place in it, and one made while every place is held frees the oldest,
 * of whatever kind.
 *
 * Each kind keeps its own list, oldest first, with a place for each entry. A place the pool frees
 * is marked, and its kind drops the entry at its next walk. Engine-free.
 */

/** `MAX_LOCAL_ENTITIES` (`cg_localents.c:29`). */
export const MAX_LOCAL_ENTITIES = 512;

/** A local entity's place in the pool. */
export interface LocalEntity {
  /** Given back, or freed by the pool for a newer one: its kind drops it at its next walk. */
  readonly freed: boolean;
  /** How many were made before it: its place in the order cgame adds them to a scene. */
  readonly serial: number;
}

/** A place, linked in the order the places were taken. */
interface Place extends LocalEntity {
  freed: boolean;
  older: Place | null;
  newer: Place | null;
}

export class LocalEntities {
  private oldest: Place | null = null;
  private newest: Place | null = null;
  private held = 0;
  private made = 0;

  /** How many places are held. */
  get count(): number {
    return this.held;
  }

  /** `CG_AllocLocalEntity`: a place for a new one, freeing the oldest if every place is held. */
  alloc(): LocalEntity {
    if (this.held >= MAX_LOCAL_ENTITIES && this.oldest) this.free(this.oldest);
    const place: Place = { freed: false, serial: this.made++, older: this.newest, newer: null };
    if (this.newest) this.newest.newer = place;
    else this.oldest = place;
    this.newest = place;
    this.held++;
    return place;
  }

  /** `CG_FreeLocalEntity`: give a place back. One already freed is left as it is. */
  free(entity: LocalEntity): void {
    const place = entity as Place;
    if (place.freed) return;
    place.freed = true;
    if (place.older) place.older.newer = place.newer;
    else this.oldest = place.newer;
    if (place.newer) place.newer.older = place.older;
    else this.newest = place.older;
    place.older = null;
    place.newer = null;
    this.held--;
  }

  /** `CG_InitLocalEntities`, which a restart runs: every place freed. */
  clear(): void {
    while (this.oldest) this.free(this.oldest);
  }
}
