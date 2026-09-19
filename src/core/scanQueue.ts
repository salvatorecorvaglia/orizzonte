/**
 * Coalescing for scan requests.
 *
 * Several things ask for a refresh — activation, the file watcher, the periodic
 * timer, three commands and the webview — and they can easily overlap. Running
 * a scan per request would walk the workspace several times over; dropping the
 * extra requests would leave a caller with a stale view.
 *
 * The subtlety this exists to capture: two scans are not interchangeable. An
 * offline scan cannot answer a request for registry data, so handing one back
 * to "Check for Updates" makes the command appear to do nothing at all.
 *
 * Kept free of `vscode` so that rule can be tested directly.
 */

export interface ScanRequest {
  /** Whether the caller needs registry data, not just manifests on disk. */
  checkUpdates: boolean;
  audit?: boolean;
}

export class ScanQueue<T> {
  private inFlight: Promise<T> | undefined;
  /** What the in-flight scan was asked for, so we can tell if it suffices. */
  private inFlightCheckedUpdates = false;
  private inFlightAudited = false;

  constructor(private readonly run: (request: ScanRequest) => Promise<T>) {}

  /**
   * Returns the in-flight scan when it answers the question being asked, and
   * otherwise queues a stronger one behind it.
   *
   * Deliberately *behind* rather than alongside: two scans over the same files
   * at once would compete for the same file handles and registry rate limits to
   * produce one answer.
   *
   * Both `checkUpdates` and `audit` are compared: a plain update check does
   * not satisfy a request that also needs vulnerability data, or the caller
   * would be handed a result it believes was audited but wasn't.
   */
  request(request: ScanRequest): Promise<T> {
    if (this.inFlight) {
      const satisfied =
        (!request.checkUpdates || this.inFlightCheckedUpdates) &&
        (!request.audit || this.inFlightAudited);
      if (satisfied) {
        return this.inFlight;
      }
      /*
       * Both settlements run the queued request, which is why this is
       * `.then(run, run)` rather than a plain `.then`.
       *
       * A caller queued behind a *failed* scan is still waiting for an answer
       * to its own question, and the previous scan's failure is not that
       * answer. With a success-only handler its promise rejected with an error
       * belonging to a request it never made, and the stronger scan it asked
       * for never ran at all.
       */
      const run = () => this.request(request);
      return this.inFlight.then(run, run);
    }

    this.inFlightCheckedUpdates = request.checkUpdates;
    this.inFlightAudited = request.audit ?? false;
    this.inFlight = this.run(request).finally(() => {
      this.inFlight = undefined;
      this.inFlightCheckedUpdates = false;
      this.inFlightAudited = false;
    });
    return this.inFlight;
  }

  /** Resolves once nothing is running. Used before reading a settled result. */
  async settled(): Promise<void> {
    await this.inFlight?.catch(() => undefined);
  }
}
