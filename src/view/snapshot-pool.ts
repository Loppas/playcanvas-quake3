import { MAX_MAP_AREA_BYTES } from '../net/commands';
import { copyEntityState, copyPlayerState } from '../net/delta';
import {
  MAX_GENTITIES,
  createEntityState,
  createPlayerState,
  type EntityState,
  type PlayerState
} from '../net/protocol';
import type { SourceSnapshot } from './player-view';

/** `cg.snap` or `cg.nextSnap`: a snapshot in the view's own keeping. */
export interface ViewSnapshot {
  snapFlags: number;
  serverTime: number;
  serverCommandNum: number;
  /** The areas closed to the player's view, a bit each. */
  areamask: Uint8Array;
  ps: PlayerState;
  /** In increasing entity number. */
  entities: readonly EntityState[];
  /** The same entities, by number. */
  byNumber: Pick<ReadonlyMap<number, EntityState>, 'get'>;
}

/** A copy the pool owns, with every entity state it has been copied into, kept for the next. */
interface PooledSnapshot extends ViewSnapshot {
  entities: EntityState[];
  /** The states copied into, at least as many as {@link entities} holds. */
  readonly states: EntityState[];
  /** {@link byNumber}'s answers, by entity number. */
  readonly slots: (EntityState | undefined)[];
}

/**
 * The view's copies of the client's snapshots, each made in place in one nothing holds any more,
 * as cgame reads a snapshot into whichever of its two `cg.activeSnapshots` is not `cg.snap`
 * (`cg_snapshot.c:266–271`). The view holds more than two: a frame that passes several reads
 * several, and the last frame's pair is still read by this frame's early shots.
 */
export class SnapshotPool {
  private readonly free: PooledSnapshot[] = [];
  private readonly taken: PooledSnapshot[] = [];

  /**
   * A snapshot copied out of the client's ring, which the next 32 messages write over. It is
   * the view's until {@link release} is told it is no longer held.
   */
  copy(from: SourceSnapshot): ViewSnapshot {
    const into = this.free.pop() ?? emptySnapshot();
    this.taken.push(into);
    into.snapFlags = from.snapFlags;
    into.serverTime = from.serverTime;
    into.serverCommandNum = from.serverCommandNum;
    into.areamask.set(from.areamask);
    copyPlayerState(from.ps, into.ps);
    const { entities, states, slots } = into;
    for (const state of entities) slots[state.number] = undefined;
    from.entities.forEach((state, index) => {
      if (index === states.length) states.push(createEntityState());
      const copied = copyEntityState(state, states[index]);
      entities[index] = copied;
      slots[copied.number] = copied;
    });
    entities.length = from.entities.length;
    return into;
  }

  /**
   * Every copy but those still held is written over by the copies after it.
   *
   * @param held - The snapshots the view still reads, and nulls for those it has none of.
   */
  release(held: readonly (object | null | undefined)[]): void {
    let kept = 0;
    for (const snapshot of this.taken) {
      if (held.includes(snapshot)) this.taken[kept++] = snapshot;
      else this.free.push(snapshot);
    }
    this.taken.length = kept;
  }
}

function emptySnapshot(): PooledSnapshot {
  const slots = new Array<EntityState | undefined>(MAX_GENTITIES).fill(undefined);
  return {
    snapFlags: 0,
    serverTime: 0,
    serverCommandNum: 0,
    areamask: new Uint8Array(MAX_MAP_AREA_BYTES),
    ps: createPlayerState(),
    entities: [],
    states: [],
    slots,
    byNumber: { get: (number) => slots[number] }
  };
}
