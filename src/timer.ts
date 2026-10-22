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
export const DEFAULT_CAT_COUNT = 8;
export const MIN_CAT_COUNT = 1;
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
}

export function freshState(now: number = Date.now()): SharedState {
  return { version: STATE_VERSION, activeMs: 0, breakActive: false, breakId: 0, updatedAt: now };
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
  return { version: STATE_VERSION, activeMs, breakActive, breakId, updatedAt };
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
  if (state.breakActive) {
    return { state, changed: false, breakTriggered: false };
  }
  let delta = 0;
  if (input.counting && input.lastTickAt !== undefined) {
    delta = Math.min(Math.max(input.now - input.lastTickAt, 0), MAX_DELTA_MS);
  }
  let activeMs = state.activeMs + delta;
  let breakActive = false;
  let breakId = state.breakId;
  let breakTriggered = false;
  if (activeMs >= input.intervalMs) {
    activeMs = input.intervalMs;
    breakActive = true;
    breakId += 1;
    breakTriggered = true;
  }
  if (delta === 0 && !breakTriggered) {
    return { state, changed: false, breakTriggered: false };
  }
  return {
    state: { version: STATE_VERSION, activeMs, breakActive, breakId, updatedAt: input.now },
    changed: true,
    breakTriggered
  };
}

/** State after a pause: timer restarts, break ends. breakId is kept. */
export function applyPause(state: SharedState, now: number): SharedState {
  return { version: STATE_VERSION, activeMs: 0, breakActive: false, breakId: state.breakId, updatedAt: now };
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
    updatedAt: now
  };
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
