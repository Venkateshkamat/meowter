import { StateIo } from './sharedState';
import { applyBreakNow, applyDelta, applyPause, applyTick, DEFAULT_BREAK_INTERVAL_MINUTES, MS_PER_MINUTE, SharedState } from './timer';

/** How often accumulated active time is written to the shared file while it keeps growing. */
export const FLUSH_INTERVAL_MS = 15_000;
/** How long to wait before trying again after a failed write of a break or pause. */
export const RETRY_MS = 5000;

export interface CountInput {
  now: number;
  /** Whether this window should add time right now (focused, not idle). */
  counting: boolean;
  intervalMs: number;
}

/** A local transition (break or pause) that has to reach the shared file. */
type Unsaved = 'break' | 'pause' | undefined;

/**
 * The shared timer as one window sees it. No `vscode` import, so it is unit tested in plain Node.
 *
 * The shared file is the truth; this class keeps a copy and only the focused window adds to it:
 *  - `base` is the last state known to be in the file.
 *  - `pending` is active time counted here that is not in the file yet. Counting a second costs no I/O.
 *  - `inflight` is the part of it that is being written right now (still shown, so the countdown never dips).
 *
 * Writing is delta based, never absolute: a flush re-reads the file right before it writes
 * `file.activeMs + pending`, inside one serialized operation. Whatever other windows wrote in the meantime
 * is therefore kept, and a window can never overwrite the file with a stale total. Time is flushed every
 * FLUSH_INTERVAL_MS, when the window loses focus, when a break starts, and on shutdown.
 *
 * Known and accepted: two windows that both read the file and then rename their temp file within the same
 * millisecond would lose one of the two deltas (at most FLUSH_INTERVAL_MS of one window's time). It needs two
 * windows flushing at once, but only the focused window counts and it flushes when it loses focus, so the
 * windows take turns and this is very rare. A file lock would cost more than the loss it prevents.
 *
 * A file that cannot be read (permissions, a busy disk) is not "no state": reads reject, a refresh then changes
 * nothing, and a flush keeps its time and tries again later instead of overwriting the file.
 *
 * Changes from other windows arrive through `refresh()`. A break, pause or reset made elsewhere discards
 * `pending` (it belonged to a cycle that no longer exists).
 */
export class SharedTimer {
  private base: SharedState;
  private pending = 0;
  private inflight = 0;
  private unsaved: Unsaved;
  /** Changes with every local break or pause, so an older write cannot overrule a newer one. */
  private seq = 0;
  private unsavedAt = 0;
  private breakAttempts = 0;
  private retryAt = 0;
  private intervalMs = DEFAULT_BREAK_INTERVAL_MINUTES * MS_PER_MINUTE;
  private lastTickAt: number | undefined;
  private lastFlushAt: number;
  /** Operations (flush, refresh, pause...) queued or running. */
  private busy = 0;
  /** A flush is queued and has not started: another one would add nothing. */
  private flushQueued = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly io: StateIo,
    initial: SharedState,
    private readonly clock: () => number = Date.now,
    private readonly flushIntervalMs = FLUSH_INTERVAL_MS
  ) {
    this.base = initial;
    this.lastFlushAt = clock();
  }

  /** The state to show: the file's state plus the time not yet written. */
  get view(): SharedState {
    const unwritten = this.pending + this.inflight;
    if (this.base.breakActive || unwritten === 0) {
      return this.base;
    }
    return { ...this.base, activeMs: this.base.activeMs + unwritten };
  }

  /** Active time counted here and not in the file yet (including what is being written). */
  get pendingMs(): number {
    return this.pending + this.inflight;
  }

  /**
   * True while a break this window started is not in the file yet. Its id is a guess until then (another window
   * may have started breaks meanwhile), so nothing that names the break (the notification) should be shown yet.
   */
  get breakPending(): boolean {
    return this.unsaved === 'break' && this.breakAttempts === 0;
  }

  /** Forget the last tick time (after a pause, or when ticking restarts): the next tick adds nothing for the gap. */
  resetClock(now?: number): void {
    this.lastTickAt = now;
  }

  /** One timer tick. Pure memory work: no I/O. */
  count(input: CountInput): { breakTriggered: boolean } {
    this.intervalMs = input.intervalMs;
    const before = this.view;
    const r = applyTick(before, {
      now: input.now,
      lastTickAt: this.lastTickAt,
      counting: input.counting,
      intervalMs: input.intervalMs
    });
    this.lastTickAt = input.now;
    if (!r.changed) {
      return { breakTriggered: false };
    }
    if (r.breakTriggered) {
      // Optimistic: the break shows at once; flush() writes it (or adopts one another window started first).
      this.base = r.state;
      this.pending = 0;
      this.inflight = 0;
      this.markUnsaved('break', input.now);
      return { breakTriggered: true };
    }
    if (this.pending === 0 && this.inflight === 0) {
      this.lastFlushAt = input.now; // the flush interval counts from the first unwritten second
    }
    this.pending += r.state.activeMs - before.activeMs;
    return { breakTriggered: false };
  }

  /** Whether flush() should run now. Never piles a second flush up behind one that is queued or slow. */
  flushDue(now: number): boolean {
    if (this.flushQueued) {
      return false;
    }
    if (this.breakPending) {
      return true; // a break goes out at once, even behind a running flush
    }
    if (this.busy > 0) {
      return false;
    }
    if (this.unsaved) {
      return now >= this.retryAt;
    }
    return this.pending > 0 && now - this.lastFlushAt >= this.flushIntervalMs;
  }

  /**
   * Writes accumulated time and any local break or pause that is not in the file yet. No-op when there is nothing
   * to write. Rejects when the write fails; what was not written is kept and tried again by the next flush.
   */
  flush(intervalMs: number = this.intervalMs): Promise<void> {
    this.intervalMs = intervalMs;
    this.flushQueued = true;
    return this.enqueue(async () => {
      this.flushQueued = false;
      const kind = this.unsaved;
      if (kind) {
        return this.writeLocalTransition(kind);
      }
      const delta = this.pending;
      if (delta === 0) {
        return;
      }
      this.pending = 0;
      this.inflight = delta;
      this.lastFlushAt = this.clock();
      try {
        const file = await this.io.read();
        const r = applyDelta(file, delta, this.intervalMs, this.clock());
        if (r.changed) {
          await this.io.write(r.state);
        }
        this.inflight = 0;
        this.adopt(r.state);
      } catch (err) {
        this.pending += this.inflight;
        this.inflight = 0;
        throw err;
      }
    });
  }

  private async writeLocalTransition(kind: 'break' | 'pause'): Promise<void> {
    const seq = this.seq;
    try {
      const file = await this.io.read();
      let next: SharedState;
      if (kind === 'pause') {
        next = applyPause(file, this.unsavedAt);
        await this.io.write(next);
      } else if (file.breakActive) {
        next = file; // another window started the break first: adopt it, start no second one
      } else {
        next = { ...this.base, breakActive: true, breakId: file.breakId + 1, updatedAt: this.unsavedAt };
        await this.io.write(next);
      }
      if (this.seq === seq) {
        // (a newer local break or pause would have replaced `base` and `unsaved` and is written after this one)
        this.unsaved = undefined;
        this.breakAttempts = 0;
        this.adopt(next, kind === 'pause');
      }
    } catch (err) {
      if (this.seq === seq) {
        this.retryAt = this.clock() + RETRY_MS;
        this.breakAttempts++;
      }
      throw err;
    }
  }

  /**
   * Re-reads the shared file and takes over what other windows did. Resolves true when the displayed state
   * changed. Skipped while a local break or pause is still waiting to be written. Rejects if the file cannot
   * be read, leaving the state as it is.
   */
  refresh(): Promise<boolean> {
    return this.enqueue(async () => {
      const file = await this.io.read();
      if (this.unsaved) {
        return false;
      }
      const before = this.view;
      this.adopt(file);
      const after = this.view;
      return (
        before.activeMs !== after.activeMs || before.breakActive !== after.breakActive || before.breakId !== after.breakId
      );
    });
  }

  /**
   * Ends the break and restarts the timer, whatever the state is. Shown at once; resolves once it is in the file.
   * If the write fails it rejects, and the pause stays queued for the next flush.
   */
  pause(now: number = this.clock()): Promise<void> {
    this.base = applyPause(this.base, now);
    this.pending = 0;
    this.inflight = 0;
    this.lastTickAt = undefined;
    this.markUnsaved('pause', now);
    return this.flush();
  }

  /** Starts a break now (no-op when one is running). Resolves once it is in the file. */
  breakNow(intervalMs: number, now: number = this.clock()): Promise<void> {
    this.intervalMs = intervalMs;
    if (this.base.breakActive) {
      return Promise.resolve();
    }
    this.base = applyBreakNow(this.view, intervalMs, now);
    this.pending = 0;
    this.inflight = 0;
    this.markUnsaved('break', now);
    return this.flush();
  }

  private markUnsaved(kind: 'break' | 'pause', now: number): void {
    this.unsaved = kind;
    this.unsavedAt = now;
    this.seq++;
    this.breakAttempts = 0;
    this.retryAt = 0;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    this.busy++;
    const run = this.chain.then(op, op);
    this.chain = run.then(
      () => {
        this.busy--;
      },
      () => {
        this.busy--;
      }
    );
    return run;
  }

  /** Takes the file's state as the new base; time counted for a cycle that is gone is discarded. */
  private adopt(file: SharedState, keepPending = false): void {
    const reset =
      file.breakActive || file.breakId !== this.base.breakId || file.activeMs < this.base.activeMs;
    if (reset && !keepPending) {
      this.pending = 0;
    }
    this.base = file;
  }
}
