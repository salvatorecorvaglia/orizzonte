/** Shared outcomes for serialized dependency mutations. */
export type MutationResult = 'applied' | 'unsupported' | 'failed' | 'pending';
export interface BatchEntry<T> {
  item: T;
  outcome: MutationResult | 'notAttempted';
  error?: unknown;
}

/** Unknown completion stops the batch; ordinary failures leave later entries eligible. */
export async function runMutationBatch<T>(
  items: readonly T[],
  run: (item: T) => Promise<MutationResult>,
): Promise<BatchEntry<T>[]> {
  const results: BatchEntry<T>[] = [];
  let pending = false;
  for (const item of items) {
    if (pending) {
      results.push({ item, outcome: 'notAttempted' });
      continue;
    }
    try {
      const outcome = await run(item);
      results.push({ item, outcome });
      pending = outcome === 'pending';
    } catch (error) {
      results.push({ item, outcome: 'failed', error });
    }
  }
  return results;
}
