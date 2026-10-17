/**
 * Map over `items` with at most `limit` calls in flight, keeping the results in input order.
 *
 * Opening 248 pk3s or reading 200 manifest entries one at a time would serialise every round
 * trip to the dev server; starting them all at once would queue hundreds of requests behind the
 * browser's connection limit and hold every buffer at once. A small bound gets the overlap
 * without the pile-up.
 *
 * Rejects with the first rejection; calls already started are left to finish.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
