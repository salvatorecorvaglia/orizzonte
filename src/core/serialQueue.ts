/**
 * Runs tasks one after another, never two at once.
 *
 * The integrated terminal is a single shared resource: it is reused between
 * commands, and recreated whenever the working directory changes. Two commands
 * in flight at once therefore interleave their command lines, or one disposes
 * the terminal the other is still writing to — which is what a bulk update did
 * before the host learned to send one message instead of one per package.
 *
 * Serialising at the terminal makes that unrepresentable regardless of what any
 * caller does, so the invariant does not depend on every future caller
 * remembering it.
 *
 * Kept free of `vscode` so the ordering rule can be tested directly, for the
 * same reason `scanQueue.ts` is.
 */
export class SerialQueue {
  /** Resolves when everything accepted so far has settled. */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Queues `task` behind everything already accepted, and resolves with its
   * result.
   *
   * A task that throws rejects its own caller and nothing else: the queue
   * continues with the next task, because one failed install is not a reason to
   * wedge every command after it.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
