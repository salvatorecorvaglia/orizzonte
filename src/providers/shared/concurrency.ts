/**
 * Bounded-concurrency iteration, shared by every provider that fetches one
 * package at a time.
 *
 * Registries differ in how much parallelism they tolerate, so the limit is the
 * caller's decision — crates.io wants one request per second, npm is happy with
 * eight in flight.
 */

/**
 * Runs `worker` over `items` with a bounded number in flight, and returns what
 * each one produced.
 *
 * Results are written into a slot rather than pushed, so the output order is
 * the input order regardless of which worker finishes first — callers that
 * label results by position would otherwise get them shuffled by timing.
 * Workers that return nothing simply yield an array of `undefined`, which is
 * what the fetch-and-mutate callers have always done with it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
