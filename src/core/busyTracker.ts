/**
 * Reference-counted "something is happening" state.
 *
 * The panel's busy flag has several independent writers — a scan, a package
 * manager command, a bulk action — and it used to be a plain boolean each of
 * them set directly. Whichever finished *first* wrote `false`, so a command
 * completing while a background scan was still running cleared the scan's
 * spinner and left the panel claiming to be idle for the rest of it.
 *
 * A count makes that unrepresentable: the state is busy while anything holds
 * it, and no holder can release another's claim. Callers get a release
 * function rather than a matching "stop" call, so the pairing is structural
 * rather than something each caller has to remember.
 *
 * Kept free of `vscode` so the counting rule can be tested directly, for the
 * same reason `scanQueue.ts` and `serialQueue.ts` are.
 */

interface Claim {
  label: string | undefined;
  released: boolean;
}

export class BusyTracker {
  /** Live claims in the order they were taken. */
  private readonly claims: Claim[] = [];
  private lastBusy = false;
  private lastLabel: string | undefined;

  /**
   * @param onChange Fires only when the reported state actually changes, so a
   *   second overlapping claim does not re-post an identical message to the
   *   webview.
   */
  constructor(
    private readonly onChange: (busy: boolean, label?: string) => void,
  ) {}

  get busy(): boolean {
    return this.claims.length > 0;
  }

  /**
   * The label currently worth showing: the most recent claim's.
   *
   * The newest is the one the user just triggered, so it is the one that
   * explains what they are waiting for. An older, broader claim ("Checking
   * registries…") is still counted; it is simply not what the label says while
   * something more specific is in flight.
   */
  get label(): string | undefined {
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (this.claims[i].label !== undefined) return this.claims[i].label;
    }
    return undefined;
  }

  /**
   * Takes a claim on the busy state and returns the release for it.
   *
   * Releasing twice is a no-op rather than an error: a `finally` that runs
   * after an early return is a normal shape, and a double release that
   * decremented would let one caller clear another's claim — the exact bug
   * this class exists to prevent.
   */
  begin(label?: string): () => void {
    const claim: Claim = { label, released: false };
    this.claims.push(claim);
    this.emit();

    return () => {
      if (claim.released) return;
      claim.released = true;
      const index = this.claims.indexOf(claim);
      if (index >= 0) this.claims.splice(index, 1);
      this.emit();
    };
  }

  /**
   * Drops every claim. For disposal, where the holders are going away
   * regardless and a leaked claim would strand the UI mid-spinner.
   */
  reset(): void {
    for (const claim of this.claims) claim.released = true;
    this.claims.length = 0;
    this.emit();
  }

  private emit(): void {
    const busy = this.busy;
    const label = this.label;
    if (busy === this.lastBusy && label === this.lastLabel) return;
    this.lastBusy = busy;
    this.lastLabel = label;
    this.onChange(busy, label);
  }
}
