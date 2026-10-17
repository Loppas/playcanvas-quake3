import type { TraceFn } from './types';

/** Who one trace was asked to pass, and what it was asked to stop at. */
export interface TraceAsk {
  passEntityNum: number;
  contentmask: number;
}

/**
 * A trace that answers as `world` does and remembers what each call asked for, for a test of the
 * arguments a caller passes rather than of the answer it gets.
 *
 * @param world - What answers.
 */
export function recordingTrace(world: TraceFn): { trace: TraceFn; asked: TraceAsk[] } {
  const asked: TraceAsk[] = [];
  return {
    asked,
    trace: (start, mins, maxs, end, passEntityNum, contentmask) => {
      asked.push({ passEntityNum, contentmask });
      return world(start, mins, maxs, end, passEntityNum, contentmask);
    }
  };
}

/**
 * The different things asked, each once, which a caller that always passes the same is one of.
 *
 * @param asked - What a {@link recordingTrace} was asked.
 */
export function distinctAsks(asked: readonly TraceAsk[]): TraceAsk[] {
  const seen = new Map<string, TraceAsk>();
  for (const ask of asked) seen.set(`${ask.passEntityNum} ${ask.contentmask}`, ask);
  return [...seen.values()];
}
