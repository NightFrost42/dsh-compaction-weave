// Timing only: no draft text, reasoning content, credentials or token estimates.
// Uses a monotonic clock. Observations come from the assembler's accepted changes,
// so empty deltas, metadata and ignored post-finalization deltas are not progress.
export class SummaryProgress {
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.startedAt = clock();
    this.firstChunkMs = null;
    this.lastChunkMs = null;
    this.firstTextMs = null;
    this.lastTextMs = null;
    this.firstProgressMs = null;
    this.lastProgressMs = null;
    this.maxProgressGapMs = 0;
  }

  elapsed() {
    return Math.max(0, Math.floor(this.clock() - this.startedAt));
  }

  observe(change) {
    if (!change) return;
    const at = this.elapsed();
    this.firstChunkMs ??= at;
    this.lastChunkMs = at;
    if (change.textChanged) {
      this.firstTextMs ??= at;
      this.lastTextMs = at;
    }
    if (!change.textChanged && !change.reasoningChanged) return;
    this.firstProgressMs ??= at;
    if (this.lastProgressMs !== null) {
      this.maxProgressGapMs = Math.max(this.maxProgressGapMs, at - this.lastProgressMs);
    }
    this.lastProgressMs = at;
  }

  snapshot() {
    const elapsedMs = this.elapsed();
    const idleMs = elapsedMs - (this.lastProgressMs ?? 0);
    return {
      elapsedMs,
      firstChunkMs: this.firstChunkMs,
      lastChunkMs: this.lastChunkMs,
      firstTextMs: this.firstTextMs,
      lastTextMs: this.lastTextMs,
      firstProgressMs: this.firstProgressMs,
      lastProgressMs: this.lastProgressMs,
      idleMs,
      textIdleMs: elapsedMs - (this.lastTextMs ?? 0),
      // First-response latency has its own field; this is the largest gap
      // after content began, including any unfinished gap at snapshot time.
      maxProgressGapMs: this.lastProgressMs === null ? null : Math.max(this.maxProgressGapMs, idleMs),
    };
  }
}
