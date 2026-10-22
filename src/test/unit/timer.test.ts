import * as assert from 'assert';
import {
  applyBreakNow,
  applyPause,
  applyTick,
  formatStatusText,
  freshState,
  isCounting,
  MAX_DELTA_MS,
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
      assert.strictEqual(normalizeCatCount(0), 1);
      assert.strictEqual(normalizeCatCount(undefined), 8);
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
