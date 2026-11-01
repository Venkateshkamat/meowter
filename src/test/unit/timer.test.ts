import * as assert from 'assert';
import {
  applyBreakNow,
  applyDelta,
  applyPause,
  applyTick,
  DEFAULT_CAT_COUNT,
  MIN_CAT_COUNT,
  applyNewDay,
  canPause,
  dayKey,
  effectiveIntervalMs,
  formatStatusText,
  graceForInterval,
  INTERVAL_GRACE_MS,
  freshState,
  isCounting,
  isNewDay,
  MAX_DELTA_MS,
  nextMidnight,
  normalizeCatCount,
  normalizeMinutes,
  parseIntervalInput,
  remainingMinutes,
  sanitizeState,
  validateIntervalInput
} from '../../timer';

const MIN = 60_000;

describe('timer', () => {
  describe('isCounting', () => {
    const base = { focused: true, windowActive: false, lastActivityAt: 1000, now: 2000, idleMs: 5 * MIN, breakActive: false };

    it('counts when focused and recently active', () => {
      assert.strictEqual(isCounting(base), true);
    });
    it('does not count when unfocused', () => {
      assert.strictEqual(isCounting({ ...base, focused: false }), false);
      assert.strictEqual(isCounting({ ...base, focused: false, windowActive: true }), false);
    });
    it('stops counting after the idle threshold', () => {
      assert.strictEqual(isCounting({ ...base, now: 1000 + 5 * MIN - 1 }), true);
      assert.strictEqual(isCounting({ ...base, now: 1000 + 5 * MIN }), false);
    });
    it('treats focused+active window state as activity', () => {
      assert.strictEqual(isCounting({ ...base, now: 1000 + 60 * MIN, windowActive: true }), true);
    });
    it('never counts during a break', () => {
      assert.strictEqual(isCounting({ ...base, breakActive: true }), false);
    });
  });

  describe('applyDelta', () => {
    const interval = 50 * MIN;

    it('adds the delta and keeps the break id', () => {
      const r = applyDelta({ ...freshState(0), activeMs: 1000, breakId: 3 }, 5000, interval, 9);
      assert.deepStrictEqual([r.state.activeMs, r.state.breakId, r.changed, r.breakTriggered], [6000, 3, true, false]);
    });
    it('starts a break when the delta reaches the interval', () => {
      const r = applyDelta({ ...freshState(0), activeMs: interval - 1000, breakId: 3 }, 4000, interval, 9);
      assert.deepStrictEqual(
        [r.state.activeMs, r.state.breakActive, r.state.breakId, r.breakTriggered],
        [interval, true, 4, true]
      );
    });
    it('drops the delta during a break', () => {
      const s = { ...freshState(0), breakActive: true, activeMs: interval, breakId: 2 };
      const r = applyDelta(s, 4000, interval, 9);
      assert.strictEqual(r.state, s);
      assert.strictEqual(r.changed, false);
    });
    it('changes nothing for a zero delta', () => {
      const s = freshState(0);
      assert.strictEqual(applyDelta(s, 0, interval, 9).state, s);
    });
  });

  describe('applyTick', () => {
    const interval = 50 * MIN;

    it('adds elapsed time while counting', () => {
      const r = applyTick(freshState(0), { now: 11_000, lastTickAt: 10_000, counting: true, intervalMs: interval });
      assert.strictEqual(r.state.activeMs, 1000);
      assert.strictEqual(r.changed, true);
      assert.strictEqual(r.breakTriggered, false);
    });
    it('adds nothing while not counting', () => {
      const s = freshState(0);
      const r = applyTick(s, { now: 11_000, lastTickAt: 10_000, counting: false, intervalMs: interval });
      assert.strictEqual(r.state, s);
      assert.strictEqual(r.changed, false);
    });
    it('adds nothing on the first tick', () => {
      const r = applyTick(freshState(0), { now: 11_000, lastTickAt: undefined, counting: true, intervalMs: interval });
      assert.strictEqual(r.state.activeMs, 0);
      assert.strictEqual(r.changed, false);
    });
    it('caps the delta (sleep/suspend)', () => {
      const r = applyTick(freshState(0), { now: 10 * MIN, lastTickAt: 0, counting: true, intervalMs: interval });
      assert.strictEqual(r.state.activeMs, MAX_DELTA_MS);
    });
    it('ignores a negative delta (clock moved back)', () => {
      const r = applyTick(freshState(0), { now: 5000, lastTickAt: 9000, counting: true, intervalMs: interval });
      assert.strictEqual(r.state.activeMs, 0);
    });
    it('triggers a break at the interval and increments breakId', () => {
      const s = { ...freshState(0), activeMs: interval - 500, breakId: 3 };
      const r = applyTick(s, { now: 2000, lastTickAt: 1000, counting: true, intervalMs: interval });
      assert.strictEqual(r.breakTriggered, true);
      assert.strictEqual(r.state.breakActive, true);
      assert.strictEqual(r.state.breakId, 4);
      assert.strictEqual(r.state.activeMs, interval);
    });
    it('triggers when the interval was lowered below activeMs, even if not counting', () => {
      const s = { ...freshState(0), activeMs: 10 * MIN };
      const r = applyTick(s, { now: 2000, lastTickAt: 1000, counting: false, intervalMs: 5 * MIN });
      assert.strictEqual(r.state.breakActive, true);
    });
    it('never counts during a break', () => {
      const s = { ...freshState(0), breakActive: true, activeMs: interval, breakId: 1 };
      const r = applyTick(s, { now: 2000, lastTickAt: 1000, counting: true, intervalMs: interval });
      assert.strictEqual(r.state, s);
      assert.strictEqual(r.changed, false);
    });
  });

  describe('pause / break now', () => {
    it('applyPause resets time and ends the break, keeping breakId', () => {
      const s = { ...freshState(0), activeMs: 99, breakActive: true, breakId: 7 };
      const r = applyPause(s, 5);
      assert.deepStrictEqual([r.activeMs, r.breakActive, r.breakId, r.updatedAt], [0, false, 7, 5]);
    });
    it('applyBreakNow starts a break once', () => {
      const s = freshState(0);
      const r = applyBreakNow(s, 50 * MIN, 5);
      assert.strictEqual(r.breakActive, true);
      assert.strictEqual(r.breakId, 1);
      assert.strictEqual(applyBreakNow(r, 50 * MIN, 6), r);
    });
  });

  describe('daily reset at 12 am local time', () => {
    const at = (d: number, h: number, m = 0, sec = 0): number => new Date(2026, 10, d, h, m, sec).getTime();

    it('names the local calendar day', () => {
      assert.strictEqual(dayKey(at(1, 0)), '2026-11-01');
      assert.strictEqual(dayKey(at(1, 23, 59, 59)), '2026-11-01');
      assert.strictEqual(dayKey(at(2, 0)), '2026-11-02');
      assert.strictEqual(dayKey(new Date(2026, 0, 5, 12).getTime()), '2026-01-05');
    });
    it('finds the next local midnight', () => {
      assert.strictEqual(nextMidnight(at(1, 15, 30)), at(2, 0));
      assert.strictEqual(nextMidnight(at(1, 0)), at(2, 0));
      assert.strictEqual(nextMidnight(new Date(2026, 11, 31, 22).getTime()), new Date(2027, 0, 1).getTime());
    });
    it('a state from an earlier day starts over: countdown reset, break ended, break id kept', () => {
      const yesterday = { ...applyDelta(freshState(at(1, 9)), 30 * MIN, 50 * MIN, at(1, 23, 50)).state };
      assert.strictEqual(isNewDay(yesterday, at(1, 23, 59, 59)), false);
      assert.strictEqual(isNewDay(yesterday, at(2, 0, 0, 1)), true);
      const next = applyNewDay(yesterday, at(2, 0, 0, 1));
      assert.deepStrictEqual([next.activeMs, next.breakActive, next.breakId, next.day], [0, false, 0, '2026-11-02']);
      const inBreak = applyBreakNow(yesterday, 50 * MIN, at(1, 23, 55));
      const ended = applyNewDay(inBreak, at(2, 7));
      assert.deepStrictEqual([ended.activeMs, ended.breakActive, ended.breakId], [0, false, inBreak.breakId]);
    });
    it('the same day is left alone (the very same object)', () => {
      const s = applyDelta(freshState(at(1, 9)), 10 * MIN, 50 * MIN, at(1, 10)).state;
      assert.strictEqual(applyNewDay(s, at(1, 23, 59)), s);
    });
    it('time added after midnight to an old day keeps the old day, so it is still reset', () => {
      const s = applyDelta(freshState(at(1, 9)), 10 * MIN, 50 * MIN, at(2, 0, 0, 5)).state;
      assert.strictEqual(s.day, '2026-11-01');
      assert.strictEqual(isNewDay(s, at(2, 0, 0, 6)), true);
    });
    it('files written before the day was stored use the day of their last write', () => {
      const old = sanitizeState({ version: 1, activeMs: 5 * MIN, breakActive: false, breakId: 3, updatedAt: at(1, 18) });
      assert.strictEqual(old.day, '2026-11-01');
      assert.strictEqual(isNewDay(old, at(2, 8)), true);
      assert.strictEqual(sanitizeState({ updatedAt: at(1, 18), day: 'garbage' }).day, '2026-11-01');
      assert.strictEqual(sanitizeState({ updatedAt: at(1, 18), day: '2026-10-31' }).day, '2026-10-31');
    });
  });

  describe('lowering the interval below the time counted', () => {
    const counted = (activeMs: number, breakId = 2): ReturnType<typeof freshState> => ({ ...freshState(1000), activeMs, breakId });

    it('needs no grace when the new interval is still ahead, or during a break', () => {
      assert.strictEqual(graceForInterval(counted(10 * MIN), 30 * MIN), undefined);
      assert.strictEqual(graceForInterval({ ...counted(10 * MIN), breakActive: true }, 3 * MIN), undefined);
    });
    it('typing "30" passes through "3": the break waits a minute of active use instead of starting at once', () => {
      const s = counted(10 * MIN);
      const grace = graceForInterval(s, 3 * MIN);
      assert.ok(grace);
      assert.strictEqual(effectiveIntervalMs(3 * MIN, grace, s), 10 * MIN + INTERVAL_GRACE_MS);
      assert.strictEqual(applyDelta(s, 1000, effectiveIntervalMs(3 * MIN, grace, s), 2000).breakTriggered, false);
      // Still a minute later the break is due.
      const later = { ...s, activeMs: 10 * MIN + INTERVAL_GRACE_MS };
      assert.strictEqual(applyDelta(later, 1000, effectiveIntervalMs(3 * MIN, grace, later), 2000).breakTriggered, true);
      // A larger setting than the grace wins.
      assert.strictEqual(effectiveIntervalMs(50 * MIN, grace, s), 50 * MIN);
    });
    it('the grace ends with the cycle: a pause, a break or a new break id', () => {
      const s = counted(10 * MIN);
      const grace = graceForInterval(s, 3 * MIN);
      assert.strictEqual(effectiveIntervalMs(3 * MIN, grace, { ...s, activeMs: 0 }), 3 * MIN);
      assert.strictEqual(effectiveIntervalMs(3 * MIN, grace, { ...s, breakActive: true }), 3 * MIN);
      assert.strictEqual(effectiveIntervalMs(3 * MIN, grace, { ...s, breakId: 3 }), 3 * MIN);
      assert.strictEqual(effectiveIntervalMs(3 * MIN, undefined, s), 3 * MIN);
    });
  });

  describe('canPause', () => {
    it('is only true during a break', () => {
      assert.strictEqual(canPause({ ...freshState(0), breakActive: true, activeMs: 50 * MIN }), true);
      assert.strictEqual(canPause({ ...freshState(0), breakActive: false, activeMs: 10 * MIN }), false);
      assert.strictEqual(canPause(freshState(0)), false);
    });

    it('is false again once the break was ended (stale click after another window paused)', () => {
      const during = { ...freshState(0), breakActive: true, activeMs: 50 * MIN, breakId: 3 };
      assert.strictEqual(canPause(during), true);
      const after = applyPause(during, 1000);
      assert.strictEqual(canPause(after), false);
      assert.strictEqual(after.breakId, 3);
    });
  });

  describe('remainingMinutes / status text', () => {
    it('rounds up and is never negative', () => {
      assert.strictEqual(remainingMinutes(0, 50 * MIN), 50);
      assert.strictEqual(remainingMinutes(1, 50 * MIN), 50);
      assert.strictEqual(remainingMinutes(8 * MIN, 50 * MIN), 42);
      assert.strictEqual(remainingMinutes(8 * MIN + 1, 50 * MIN), 42);
      assert.strictEqual(remainingMinutes(50 * MIN - 1, 50 * MIN), 1);
      assert.strictEqual(remainingMinutes(60 * MIN, 50 * MIN), 0);
    });
    it('formats the status text', () => {
      assert.strictEqual(formatStatusText({ ...freshState(0), activeMs: 8 * MIN }, 50 * MIN), '🐱 42m');
      assert.strictEqual(formatStatusText({ ...freshState(0), breakActive: true }, 50 * MIN), '🐱 I took a break ⏸');
    });
  });

  describe('sanitizing and input', () => {
    it('sanitizeState recovers from garbage', () => {
      for (const bad of [null, 5, 'x', [], undefined]) {
        const s = sanitizeState(bad, 42);
        assert.deepStrictEqual([s.activeMs, s.breakActive, s.breakId, s.updatedAt], [0, false, 0, 42]);
      }
      const s = sanitizeState({ activeMs: -5, breakActive: 'yes', breakId: 1.5 }, 1);
      assert.deepStrictEqual([s.activeMs, s.breakActive, s.breakId], [0, false, 0]);
    });
    it('sanitizeState keeps valid values', () => {
      const s = sanitizeState({ version: 1, activeMs: 10, breakActive: true, breakId: 2, updatedAt: 9 }, 1);
      assert.deepStrictEqual([s.activeMs, s.breakActive, s.breakId, s.updatedAt], [10, true, 2, 9]);
    });
    it('normalizes minutes and cat count', () => {
      assert.strictEqual(normalizeMinutes(0, 50), 50);
      assert.strictEqual(normalizeMinutes('5', 50), 50);
      assert.strictEqual(normalizeMinutes(2.5, 50), 2.5);
      assert.strictEqual(normalizeCatCount(100), 30);
      assert.strictEqual(normalizeCatCount(0), 2, 'the minimum is two, so a fighting pair always works');
      assert.strictEqual(normalizeCatCount(1), 2);
      assert.strictEqual(normalizeCatCount(-5), 2);
      assert.strictEqual(normalizeCatCount(2), 2);
      assert.strictEqual(normalizeCatCount(2.4), 2);
      assert.strictEqual(normalizeCatCount(2.6), 3);
      assert.strictEqual(normalizeCatCount(30), 30);
      assert.strictEqual(normalizeCatCount(NaN), 6);
      assert.strictEqual(normalizeCatCount('8'), 6);
      assert.strictEqual(normalizeCatCount(undefined), 6, 'the default is six: one of each style');
      assert.strictEqual(DEFAULT_CAT_COUNT, 6);
      assert.strictEqual(MIN_CAT_COUNT, 2);
    });
    it('validates interval input', () => {
      assert.strictEqual(parseIntervalInput(' 45 '), 45);
      assert.strictEqual(parseIntervalInput('1'), 1);
      assert.strictEqual(parseIntervalInput('0.5'), undefined);
      assert.strictEqual(parseIntervalInput('abc'), undefined);
      assert.strictEqual(parseIntervalInput(''), undefined);
      assert.strictEqual(parseIntervalInput('-3'), undefined);
      assert.strictEqual(validateIntervalInput('30'), undefined);
      assert.ok(validateIntervalInput('nope'));
    });
  });
});
