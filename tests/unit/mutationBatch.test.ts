import { describe, expect, it, vi } from 'vitest';
import { runMutationBatch } from '../../src/core/mutationBatch.js';

describe('mutation batch outcomes', () => {
  it('reports pending and every unattempted item without dispatching more work', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce('applied')
      .mockResolvedValueOnce('pending');
    const result = await runMutationBatch(['a', 'b', 'c', 'd'], run);
    expect(result.map((entry) => entry.outcome)).toEqual([
      'applied',
      'pending',
      'notAttempted',
      'notAttempted',
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('continues after errors and preserves unsupported results', async () => {
    const error = new Error('manager failed');
    const run = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('unsupported')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('applied');
    const result = await runMutationBatch(['a', 'b', 'c', 'd'], run);
    expect(result.map((entry) => entry.outcome)).toEqual([
      'failed',
      'unsupported',
      'failed',
      'applied',
    ]);
    expect(result[0].error).toBe(error);
  });
});
