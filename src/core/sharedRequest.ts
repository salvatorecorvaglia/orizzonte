interface Flight<T> {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
  settled: boolean;
}

/** Shares work, not cancellation: each subscriber owns only its own wait. */
export class SharedRequests<T> {
  private readonly flights = new Map<string, Flight<T>>();

  run(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return load(controller.signal);
      });
      flight = { controller, promise, subscribers: 0, settled: false };
      this.flights.set(key, flight);
      const entry = flight;
      const finished = () => {
        entry.settled = true;
        if (this.flights.get(key) === entry) this.flights.delete(key);
      };
      void promise.then(finished, finished);
    }
    const entry = flight;
    entry.subscribers++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error: unknown, value?: T, failed = false) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        entry.subscribers--;
        if (!entry.settled && entry.subscribers === 0) {
          // A superseding search subscribes in the same turn. Let it inherit
          // the download before cancelling work that truly has no listeners.
          queueMicrotask(() => {
            if (entry.subscribers === 0 && !entry.settled) {
              if (this.flights.get(key) === entry) this.flights.delete(key);
              entry.controller.abort();
            }
          });
        }
        if (failed) reject(error);
        else resolve(value as T);
      };
      const onAbort = () => finish(signal?.reason, undefined, true);
      signal?.addEventListener('abort', onAbort, { once: true });
      void entry.promise.then(
        (value) => finish(undefined, value),
        (error) => finish(error, undefined, true),
      );
    });
  }
}
