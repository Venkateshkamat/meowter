import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SharedStateStore, StateIo } from '../../sharedState';
import { FLUSH_INTERVAL_MS, RETRY_MS, SharedTimer } from '../../stateSync';
import { freshState, SharedState } from '../../timer';

const MIN = 60_000;
const INTERVAL = 10_000;

/** An in-memory stand-in for the shared file, with call counters and failure injection. */
class MemoryFile implements StateIo {
  state: SharedState = freshState(0);
  reads = 0;
  writes = 0;
  failWrites = 0;
  failReads = 0;
  /** When set, writes wait for it (a slow disk). */
  gate: Promise<void> | undefined;
  async read(): Promise<SharedState> {
    this.reads++;
    if (this.failReads > 0) {
      this.failReads--;
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return { ...this.state };
  }
  async write(state: SharedState): Promise<void> {
    await this.gate;
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error('disk full');
    }
    this.writes++;
    this.state = { ...state };
  }
}

/** One window: its own SharedTimer on the shared file, driven by a manual clock. */
function windowOn(file: MemoryFile, clock: { now: number }): SharedTimer {
  return new SharedTimer(file, { ...file.state }, () => clock.now);
}

/** Counts `seconds` one-second ticks in a focused, active window (the first tick only sets the clock). */
function countSeconds(w: SharedTimer, clock: { now: number }, seconds: number, counting = true): boolean {
  let broke = false;
  for (let i = 0; i < seconds; i++) {
    clock.now += 1000;
    broke = w.count({ now: clock.now, counting, intervalMs: INTERVAL * 100 }).breakTriggered || broke;
  }
  return broke;
}

describe('SharedTimer', () => {
  let file: MemoryFile;
  let clock: { now: number };

  beforeEach(() => {
    file = new MemoryFile();
    clock = { now: 1_000_000 };
  });

  describe('counting', () => {
    it('does no I/O while counting and shows the time in the view', () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 12);
      assert.strictEqual(file.reads + file.writes, 0);
      assert.strictEqual(w.pendingMs, 12_000);
      assert.strictEqual(w.view.activeMs, 12_000);
      assert.strictEqual(file.state.activeMs, 0, 'the file has not been written yet');
    });

    it('adds nothing while not counting (unfocused or idle)', () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 30, false);
      assert.strictEqual(w.pendingMs, 0);
      assert.strictEqual(w.flushDue(clock.now), false);
    });

    it('adds nothing for the gap on the first tick, and caps a long gap (sleep)', () => {
      const w = windowOn(file, clock);
      w.count({ now: clock.now, counting: true, intervalMs: INTERVAL * 100 });
      assert.strictEqual(w.pendingMs, 0);
      clock.now += 3 * 60 * MIN;
      w.count({ now: clock.now, counting: true, intervalMs: INTERVAL * 100 });
      assert.strictEqual(w.pendingMs, 2000);
    });
  });

  describe('flushing', () => {
    it('is due only FLUSH_INTERVAL_MS after the first unwritten second', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 1); // the first unwritten second
      countSeconds(w, clock, FLUSH_INTERVAL_MS / 1000 - 1);
      assert.strictEqual(w.flushDue(clock.now), false, 'one second short');
      countSeconds(w, clock, 1);
      assert.strictEqual(w.flushDue(clock.now), true);
      await w.flush(INTERVAL * 100);
      assert.strictEqual(w.flushDue(clock.now), false);
    });

    it('writes the accumulated time with one read and one write', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 15);
      await w.flush(INTERVAL * 100);
      assert.deepStrictEqual([file.reads, file.writes], [1, 1]);
      assert.strictEqual(file.state.activeMs, 15_000);
      assert.strictEqual(w.pendingMs, 0);
      assert.strictEqual(w.view.activeMs, 15_000);
    });

    it('writes nothing when there is nothing to write', async () => {
      const w = windowOn(file, clock);
      await w.flush(INTERVAL);
      assert.deepStrictEqual([file.reads, file.writes], [0, 0]);
    });

    it('writes about 4 times a minute while counting, with no reads in between', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      for (let s = 0; s < 600; s++) {
        countSeconds(w, clock, 1);
        if (w.flushDue(clock.now)) {
          await w.flush(INTERVAL * 100);
        }
      }
      assert.ok(file.writes <= 10 * 4 + 1, `writes in 10 minutes: ${file.writes}`);
      assert.strictEqual(file.reads, file.writes, 'one read per write, none per tick');
      assert.ok(file.state.activeMs >= 600_000 - FLUSH_INTERVAL_MS);
    });

    it('keeps the time counted while a flush is in flight', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 15);
      let release!: () => void;
      file.gate = new Promise<void>((r) => (release = r));
      const flushing = w.flush(INTERVAL * 100);
      await new Promise((r) => setImmediate(r)); // the flush is now waiting for the slow disk
      countSeconds(w, clock, 3);
      release();
      await flushing;
      assert.strictEqual(file.state.activeMs, 15_000);
      assert.strictEqual(w.pendingMs, 3000);
      assert.strictEqual(w.view.activeMs, 18_000);
    });

    it('runs concurrent flushes one after the other without counting time twice', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 20);
      await Promise.all([w.flush(INTERVAL * 100), w.flush(INTERVAL * 100), w.flush(INTERVAL * 100)]);
      assert.strictEqual(file.state.activeMs, 20_000);
      assert.strictEqual(file.writes, 1);
    });

    it('keeps the pending time when the write fails and writes it next time', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 15);
      file.failWrites = 1;
      await assert.rejects(w.flush(INTERVAL * 100));
      assert.strictEqual(w.pendingMs, 15_000);
      assert.strictEqual(file.state.activeMs, 0);
      await w.flush(INTERVAL * 100);
      assert.strictEqual(file.state.activeMs, 15_000);
    });
  });

  describe('several windows', () => {
    it('adds the delta to what other windows wrote (no lost update)', async () => {
      const a = windowOn(file, clock);
      a.resetClock(clock.now);
      countSeconds(a, clock, 5);
      // Window B was focused meanwhile and flushed 7 s straight into the file.
      file.state = { ...file.state, activeMs: file.state.activeMs + 7000 };
      await a.flush(INTERVAL * 100);
      assert.strictEqual(file.state.activeMs, 12_000);
    });

    it('shares time across focus switches: blur flushes, the other window refreshes and goes on', async () => {
      const a = windowOn(file, clock);
      const b = windowOn(file, clock);
      a.resetClock(clock.now);
      countSeconds(a, clock, 20);
      await a.flush(INTERVAL * 100); // A loses focus
      assert.strictEqual(await b.refresh(), true);
      assert.strictEqual(b.view.activeMs, 20_000);
      b.resetClock(clock.now);
      countSeconds(b, clock, 30);
      await b.flush(INTERVAL * 100); // B loses focus
      assert.strictEqual(file.state.activeMs, 50_000);
      assert.strictEqual(await a.refresh(), true);
      assert.strictEqual(a.view.activeMs, 50_000);
      assert.strictEqual(await a.refresh(), false, 'nothing new');
    });

    it('triggers the break at the right time even when the file is behind', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      let brokeAt = 0;
      for (let s = 1; s <= 12; s++) {
        clock.now += 1000;
        if (w.count({ now: clock.now, counting: true, intervalMs: INTERVAL }).breakTriggered) {
          brokeAt = s;
          break;
        }
      }
      assert.strictEqual(brokeAt, 10, 'after exactly the interval of counted time');
      assert.strictEqual(w.view.breakActive, true, 'shown at once');
      assert.strictEqual(w.flushDue(clock.now), true, 'and flushed at once');
      assert.strictEqual(file.state.breakActive, false);
      await w.flush(INTERVAL);
      assert.strictEqual(file.state.breakActive, true);
      assert.strictEqual(file.state.breakId, 1);
      assert.strictEqual(file.state.activeMs, INTERVAL);
    });

    it('counts time from other windows towards the break when flushing', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 6);
      file.state = { ...file.state, activeMs: 7000 }; // another window's flushed time
      await w.flush(INTERVAL);
      assert.strictEqual(file.state.breakActive, true, '7 s + 6 s reached the 10 s interval');
      assert.strictEqual(file.state.breakId, 1);
      assert.strictEqual(w.view.breakActive, true);
    });

    it('adopts a break another window started first instead of starting a second one', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      let broke = false;
      for (let s = 0; s < 10; s++) {
        clock.now += 1000;
        broke = w.count({ now: clock.now, counting: true, intervalMs: INTERVAL }).breakTriggered || broke;
      }
      assert.ok(broke);
      file.state = { version: 1, activeMs: INTERVAL, breakActive: true, breakId: 5, updatedAt: clock.now };
      await w.flush(INTERVAL);
      assert.strictEqual(file.writes, 0, 'nothing written');
      assert.strictEqual(w.view.breakId, 5);
      assert.strictEqual(w.view.breakActive, true);
    });

    it('drops pending time when another window started a break', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 5);
      file.state = { version: 1, activeMs: INTERVAL, breakActive: true, breakId: 1, updatedAt: clock.now };
      assert.strictEqual(await w.refresh(), true);
      assert.strictEqual(w.pendingMs, 0);
      assert.strictEqual(w.view.breakActive, true);
      await w.flush(INTERVAL);
      assert.strictEqual(file.writes, 0);
    });

    it('picks up a pause written by another window and drops its stale pending time', async () => {
      const w = windowOn(file, clock);
      file.state = { version: 1, activeMs: 4000, breakActive: false, breakId: 3, updatedAt: 1 };
      await w.refresh();
      w.resetClock(clock.now);
      countSeconds(w, clock, 5);
      // Another window reset the timer (pause): activeMs back to 0, same break id.
      file.state = { version: 1, activeMs: 0, breakActive: false, breakId: 3, updatedAt: clock.now };
      assert.strictEqual(await w.refresh(), true);
      assert.strictEqual(w.view.activeMs, 0);
      assert.strictEqual(w.pendingMs, 0);
    });

    it('sees another window ending the break', async () => {
      const w = windowOn(file, clock);
      await w.breakNow(INTERVAL);
      assert.strictEqual(w.view.breakActive, true);
      file.state = { version: 1, activeMs: 0, breakActive: false, breakId: file.state.breakId, updatedAt: clock.now };
      assert.strictEqual(await w.refresh(), true);
      assert.strictEqual(w.view.breakActive, false);
    });

    it('does not let a refresh undo a break or pause that is still being written', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      for (let s = 0; s < 10; s++) {
        clock.now += 1000;
        w.count({ now: clock.now, counting: true, intervalMs: INTERVAL });
      }
      assert.strictEqual(w.view.breakActive, true);
      assert.strictEqual(await w.refresh(), false, 'the file does not have the break yet');
      assert.strictEqual(w.view.breakActive, true);
      await w.flush(INTERVAL);
      assert.strictEqual(file.state.breakActive, true);
    });
  });

  describe('pause and break now', () => {
    it('pause resets the timer, keeps the break id and discards pending time', async () => {
      const w = windowOn(file, clock);
      file.state = { version: 1, activeMs: INTERVAL, breakActive: true, breakId: 7, updatedAt: 1 };
      await w.refresh();
      const p = w.pause(clock.now);
      assert.strictEqual(w.view.breakActive, false, 'applied in memory at once');
      await p;
      assert.deepStrictEqual(
        [file.state.activeMs, file.state.breakActive, file.state.breakId],
        [0, false, 7]
      );
      assert.strictEqual(w.pendingMs, 0);
    });

    it('pause uses the file as it is now for the break id', async () => {
      const w = windowOn(file, clock);
      file.state = { version: 1, activeMs: INTERVAL, breakActive: true, breakId: 9, updatedAt: 1 };
      await w.pause(clock.now);
      assert.strictEqual(file.state.breakId, 9);
    });

    it('breakNow starts a break once and is a no-op during one', async () => {
      const w = windowOn(file, clock);
      await w.breakNow(INTERVAL, clock.now);
      assert.deepStrictEqual([file.state.breakActive, file.state.breakId, file.state.activeMs], [true, 1, INTERVAL]);
      const writes = file.writes;
      await w.breakNow(INTERVAL, clock.now);
      assert.strictEqual(file.writes, writes);
      assert.strictEqual(file.state.breakId, 1);
    });

    it('keeps a pause whose write failed and writes it on the retry (the file is not left in the break)', async () => {
      const w = windowOn(file, clock);
      file.state = { version: 1, activeMs: INTERVAL, breakActive: true, breakId: 2, updatedAt: 1 };
      await w.refresh();
      file.failWrites = 1;
      await assert.rejects(w.pause(clock.now));
      assert.strictEqual(w.view.breakActive, false, 'still shown as paused');
      assert.strictEqual(file.state.breakActive, true, 'the file still says break');
      assert.strictEqual(await w.refresh(), false, 'a refresh does not undo the unsaved pause');
      assert.strictEqual(w.view.breakActive, false);
      assert.strictEqual(w.flushDue(clock.now), false, 'not retried at once');
      clock.now += RETRY_MS;
      assert.strictEqual(w.flushDue(clock.now), true);
      await w.flush(INTERVAL);
      assert.deepStrictEqual([file.state.breakActive, file.state.activeMs, file.state.breakId], [false, 0, 2]);
      assert.strictEqual(w.flushDue(clock.now), false);
    });
  });

  describe('when the file cannot be read', () => {
    it('a refresh rejects and changes nothing (no reset to fresh state)', async () => {
      const w = windowOn(file, clock);
      file.state = { version: 1, activeMs: 16_000, breakActive: true, breakId: 4, updatedAt: 1 };
      await w.refresh();
      w.resetClock(clock.now);
      file.failReads = 1;
      await assert.rejects(w.refresh());
      assert.deepStrictEqual([w.view.breakActive, w.view.breakId, w.view.activeMs], [true, 4, 16_000]);
    });

    it('a flush keeps its time, writes nothing and does not clobber the file, then succeeds later', async () => {
      const w = windowOn(file, clock);
      file.state = { version: 1, activeMs: 30_000, breakActive: false, breakId: 4, updatedAt: 1 };
      await w.refresh();
      w.resetClock(clock.now);
      countSeconds(w, clock, 15);
      file.failReads = 2;
      await assert.rejects(w.flush(INTERVAL * 100));
      assert.strictEqual(file.writes, 0, 'nothing was written over the unreadable file');
      assert.strictEqual(w.pendingMs, 15_000);
      assert.strictEqual(w.view.activeMs, 45_000);
      await assert.rejects(w.flush(INTERVAL * 100));
      await w.flush(INTERVAL * 100);
      assert.deepStrictEqual([file.state.activeMs, file.state.breakId], [45_000, 4]);
    });

    it('a pause or break waits for the file instead of writing guesses', async () => {
      const w = windowOn(file, clock);
      file.state = { version: 1, activeMs: INTERVAL, breakActive: true, breakId: 6, updatedAt: 1 };
      await w.refresh();
      file.failReads = 1;
      await assert.rejects(w.pause(clock.now));
      assert.strictEqual(file.writes, 0);
      clock.now += RETRY_MS;
      await w.flush(INTERVAL);
      assert.deepStrictEqual([file.state.breakActive, file.state.breakId], [false, 6], 'the real break id survived');
    });
  });

  describe('break announcements and flushing details', () => {
    it('knows its break is only a guess until it is written, and takes the id from the file', async () => {
      const w = windowOn(file, clock);
      file.state = { version: 1, activeMs: 0, breakActive: false, breakId: 3, updatedAt: 1 };
      await w.refresh();
      w.resetClock(clock.now);
      for (let s = 0; s < 10; s++) {
        clock.now += 1000;
        w.count({ now: clock.now, counting: true, intervalMs: INTERVAL });
      }
      assert.strictEqual(w.view.breakActive, true);
      assert.strictEqual(w.view.breakId, 4, 'optimistic id');
      assert.strictEqual(w.breakPending, true);
      // Other windows started and ended breaks meanwhile: the file is at id 5.
      file.state = { version: 1, activeMs: 0, breakActive: false, breakId: 5, updatedAt: 2 };
      await w.flush(INTERVAL);
      assert.strictEqual(w.breakPending, false);
      assert.strictEqual(file.state.breakId, 6);
      assert.strictEqual(w.view.breakId, 6, 'the id shown is the id written');
    });

    it('breakNow also resolves with the written id', async () => {
      const w = windowOn(file, clock);
      file.state = { version: 1, activeMs: 0, breakActive: false, breakId: 8, updatedAt: 1 };
      await w.breakNow(INTERVAL, clock.now);
      assert.strictEqual(w.view.breakId, 9);
      assert.strictEqual(w.breakPending, false);
    });

    it('does not let the countdown dip while a flush is in flight', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 15);
      assert.strictEqual(w.view.activeMs, 15_000);
      let release!: () => void;
      file.gate = new Promise<void>((r) => (release = r));
      const flushing = w.flush(INTERVAL * 100);
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(w.view.activeMs, 15_000, 'no dip to zero while writing');
      }
      countSeconds(w, clock, 2);
      assert.strictEqual(w.view.activeMs, 17_000);
      release();
      await flushing;
      assert.strictEqual(w.view.activeMs, 17_000, 'and none after the write');
      assert.strictEqual(file.state.activeMs, 15_000);
    });

    it('does not queue a second flush behind a queued or slow one', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      countSeconds(w, clock, 16);
      assert.strictEqual(w.flushDue(clock.now), true);
      let release!: () => void;
      file.gate = new Promise<void>((r) => (release = r));
      const flushing = w.flush(INTERVAL * 100);
      assert.strictEqual(w.flushDue(clock.now), false, 'queued');
      await new Promise((r) => setImmediate(r));
      countSeconds(w, clock, 20);
      assert.strictEqual(w.flushDue(clock.now), false, 'the slow one is still running');
      release();
      await flushing;
      assert.strictEqual(w.flushDue(clock.now), true, 'now the next batch is due');
    });

    it('still sends a break at once behind a slow flush', async () => {
      const w = windowOn(file, clock);
      w.resetClock(clock.now);
      for (let s = 0; s < 5; s++) {
        clock.now += 1000;
        w.count({ now: clock.now, counting: true, intervalMs: INTERVAL });
      }
      let release!: () => void;
      file.gate = new Promise<void>((r) => (release = r));
      const slow = w.flush(INTERVAL);
      await new Promise((r) => setImmediate(r));
      for (let s = 0; s < 5; s++) {
        clock.now += 1000;
        w.count({ now: clock.now, counting: true, intervalMs: INTERVAL });
      }
      assert.strictEqual(w.view.breakActive, true);
      assert.strictEqual(w.flushDue(clock.now), true);
      const brk = w.flush(INTERVAL);
      release();
      await Promise.all([slow, brk]);
      assert.deepStrictEqual([file.state.breakActive, file.state.breakId], [true, 1]);
    });
  });

  describe('with the real state file', () => {
    it('two windows taking turns share one timer through the file', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meowter-sync-'));
      try {
        const storeA = new SharedStateStore(dir);
        const storeB = new SharedStateStore(dir);
        const a = new SharedTimer(storeA, await storeA.read(), () => clock.now);
        const b = new SharedTimer(storeB, await storeB.read(), () => clock.now);
        a.resetClock(clock.now);
        countSeconds(a, clock, 40);
        await a.flush(INTERVAL * 100); // A loses focus
        await b.refresh(); // B gains focus
        b.resetClock(clock.now);
        countSeconds(b, clock, 25);
        await b.flush(INTERVAL * 100);
        await a.refresh();
        assert.strictEqual(a.view.activeMs, 65_000);
        assert.strictEqual(b.view.activeMs, 65_000);
        assert.strictEqual((await storeA.read()).activeMs, 65_000);
        // A pause in B reaches A.
        await b.breakNow(INTERVAL);
        await a.refresh();
        assert.strictEqual(a.view.breakActive, true);
        await b.pause();
        assert.strictEqual(await a.refresh(), true);
        assert.deepStrictEqual([a.view.breakActive, a.view.activeMs], [false, 0]);
        assert.deepStrictEqual(fs.readdirSync(dir), ['state.json']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
