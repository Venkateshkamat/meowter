/**
 * Pure, side-effect-free timer logic. No `vscode` or `fs` imports so it can be
 * unit tested in plain Node.
 */

export const STATE_VERSION = 1;
/** Maximum time a single tick may add, so sleep/suspend does not add time. */
export const MAX_DELTA_MS = 2000;
export const MS_PER_MINUTE = 60_000;

export const DEFAULT_BREAK_INTERVAL_MINUTES = 50;
export const DEFAULT_IDLE_THRESHOLD_MINUTES = 5;
/** Six cats = one of each style (four singles and one fighting pair). */
export const DEFAULT_CAT_COUNT = 6;
/** Two, so that a fighting pair always works. */
export const MIN_CAT_COUNT = 2;
export const MAX_CAT_COUNT = 30;

export interface SharedState {
  version: number;
  /** Milliseconds of active IDE use since the last pause. */
  activeMs: number;
  breakActive: boolean;
  /** Incremented every time a break starts. */
  breakId: number;
  /** Epoch ms of the last write. */
  updatedAt: number;
  /**
   * The local calendar day (see dayKey) the counted time belongs to. The timer starts over when the day changes.
   * Files written before this field existed have none: their day is the day of `updatedAt` (see stateDay).
   */
  day?: string;
}

/** The local calendar day of an epoch ms time, as `YYYY-MM-DD` (the timer resets at 12 am local time). */
export function dayKey(time: number): string {
  const d = new Date(time);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The day a state's counted time belongs to. */
export function stateDay(state: SharedState): string {
  return state.day ?? dayKey(state.updatedAt);
}

/** Whether `state` was counted on an earlier (or any other) day than `now`: the timer must start over. */
export function isNewDay(state: SharedState, now: number): boolean {
  return stateDay(state) !== dayKey(now);
}

/**
 * The state for a new day: the countdown starts over and a running break ends (breakId is kept). Returns `state`
 * itself when it already belongs to the day of `now`.
 */
export function applyNewDay(state: SharedState, now: number): SharedState {
  return isNewDay(state, now) ? applyPause(state, now) : state;
}

/** Epoch ms of the next local midnight after `now`. */
export function nextMidnight(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export function freshState(now: number = Date.now()): SharedState {
  return { version: STATE_VERSION, activeMs: 0, breakActive: false, breakId: 0, updatedAt: now, day: dayKey(now) };
}

/** Turns arbitrary parsed JSON into a valid state; anything unusable becomes fresh state. */
export function sanitizeState(raw: unknown, now: number = Date.now()): SharedState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return freshState(now);
  }
  const r = raw as Record<string, unknown>;
  const activeMs = typeof r.activeMs === 'number' && Number.isFinite(r.activeMs) && r.activeMs >= 0 ? r.activeMs : 0;
  const breakActive = r.breakActive === true;
  const breakId =
    typeof r.breakId === 'number' && Number.isInteger(r.breakId) && r.breakId >= 0 ? r.breakId : 0;
  const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : now;
  const day = typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day) ? r.day : dayKey(updatedAt);
  return { version: STATE_VERSION, activeMs, breakActive, breakId, updatedAt, day };
}

/** Returns a positive number >= min, or the fallback. */
export function normalizeMinutes(value: unknown, fallback: number, min = 1): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

export function normalizeCatCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CAT_COUNT;
  }
  return Math.min(MAX_CAT_COUNT, Math.max(MIN_CAT_COUNT, Math.round(value)));
}

export interface CountingInput {
  /** Is this IDE window focused? */
  focused: boolean;
  /** Is the window considered active by the IDE (recent interaction)? */
  windowActive: boolean;
  /** Epoch ms of the last activity signal seen by this window. */
  lastActivityAt: number;
  now: number;
  idleMs: number;
  breakActive: boolean;
}

/** Whether this window should add time on this tick. */
export function isCounting(input: CountingInput): boolean {
  if (input.breakActive) {
    return false;
  }
  if (!input.focused) {
    return false;
  }
  // A window the IDE itself reports as focused+active counts as activity.
  const lastActivityAt = input.windowActive ? Math.max(input.lastActivityAt, input.now) : input.lastActivityAt;
  return input.now - lastActivityAt < input.idleMs;
}

export interface TickInput {
  now: number;
  /** When this window last ticked; undefined on the first tick. */
  lastTickAt: number | undefined;
  counting: boolean;
  intervalMs: number;
}

export interface TickResult {
  state: SharedState;
  /** True when the state differs from the input and should be written. */
  changed: boolean;
  /** True when this tick started a break. */
  breakTriggered: boolean;
}

export function applyTick(state: SharedState, input: TickInput): TickResult {
  let delta = 0;
  if (input.counting && input.lastTickAt !== undefined) {
    delta = Math.min(Math.max(input.now - input.lastTickAt, 0), MAX_DELTA_MS);
  }
  return applyDelta(state, delta, input.intervalMs, input.now);
}

/**
 * Adds `delta` ms of active time to `state` and starts a break when the interval is reached.
 * Does nothing during a break (time accumulated elsewhere meanwhile is dropped).
 */
export function applyDelta(state: SharedState, delta: number, intervalMs: number, now: number): TickResult {
  if (state.breakActive) {
    return { state, changed: false, breakTriggered: false };
  }
  let activeMs = state.activeMs + delta;
  let breakActive = false;
  let breakId = state.breakId;
  let breakTriggered = false;
  if (activeMs >= intervalMs) {
    activeMs = intervalMs;
    breakActive = true;
    breakId += 1;
    breakTriggered = true;
  }
  if (delta === 0 && !breakTriggered) {
    return { state, changed: false, breakTriggered: false };
  }
  return {
    // (the day stays the cycle's day: time added here never makes an old day's total count as today's)
    state: { version: STATE_VERSION, activeMs, breakActive, breakId, updatedAt: now, day: stateDay(state) },
    changed: true,
    breakTriggered
  };
}

/** State after a pause: timer restarts (counting for the day of `now`), break ends. breakId is kept. */
export function applyPause(state: SharedState, now: number): SharedState {
  return { version: STATE_VERSION, activeMs: 0, breakActive: false, breakId: state.breakId, updatedAt: now, day: dayKey(now) };
}

/** A user pause (status bar, command, notification, cat tab) only means something during a break. */
export function canPause(state: SharedState): boolean {
  return state.breakActive;
}

/** State when a break is forced to start now. */
export function applyBreakNow(state: SharedState, intervalMs: number, now: number): SharedState {
  if (state.breakActive) {
    return state;
  }
  return {
    version: STATE_VERSION,
    activeMs: Math.max(state.activeMs, intervalMs),
    breakActive: true,
    breakId: state.breakId + 1,
    updatedAt: now,
    day: stateDay(state)
  };
}

/** How much more active use a lowered interval still allows when the time already counted has reached it. */
export const INTERVAL_GRACE_MS = MS_PER_MINUTE;

/**
 * A lowered break interval that the time already counted has reached does not start a break on the spot: the break
 * comes after INTERVAL_GRACE_MS more of active use. Typing a new value in the Settings editor saves every
 * intermediate value (typing "30" saves "3" first), and a break starting mid-typing would take the editor away.
 * `fromActiveMs` and `breakId` tie the grace to the current cycle: a pause or a break ends it.
 */
export interface IntervalGrace {
  breakId: number;
  fromActiveMs: number;
  untilMs: number;
}

/** The grace a change of the interval to `intervalMs` needs in `state`, or undefined when the interval is not reached. */
export function graceForInterval(state: SharedState, intervalMs: number, graceMs = INTERVAL_GRACE_MS): IntervalGrace | undefined {
  if (state.breakActive || state.activeMs < intervalMs) {
    return undefined;
  }
  return { breakId: state.breakId, fromActiveMs: state.activeMs, untilMs: state.activeMs + graceMs };
}

/** The interval to count against: the setting, held off by a grace that still applies to this cycle. */
export function effectiveIntervalMs(intervalMs: number, grace: IntervalGrace | undefined, state: SharedState): number {
  if (!grace || state.breakActive || state.breakId !== grace.breakId || state.activeMs < grace.fromActiveMs) {
    return intervalMs;
  }
  return Math.max(intervalMs, grace.untilMs);
}

/** Minutes left until the break, rounded up, never negative. */
export function remainingMinutes(activeMs: number, intervalMs: number): number {
  const remainingMs = intervalMs - activeMs;
  return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / MS_PER_MINUTE);
}

/** The status bar item during a break: it is also a pause button, labelled like the notification's. */
export const BREAK_STATUS_TEXT = '🐱 I took a break ⏸';

export function formatStatusText(state: SharedState, intervalMs: number): string {
  if (state.breakActive) {
    return BREAK_STATUS_TEXT;
  }
  return `🐱 ${remainingMinutes(state.activeMs, intervalMs)}m`;
}

/** Parses the Set Break Interval input; returns undefined when invalid. */
export function parseIntervalInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/** InputBox validator: returns an error message, or undefined when valid. */
export function validateIntervalInput(value: string): string | undefined {
  return parseIntervalInput(value) === undefined ? 'Enter a number of minutes, 1 or greater.' : undefined;
}
