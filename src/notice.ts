import { SharedState } from './timer';

export const NOTICE_MESSAGE = 'Time for a break 🐱';
export const NOTICE_BUTTON = 'I took a break ⏸';

/** Shows the break notification. The promise resolves with the clicked button, or undefined when dismissed. */
export interface Notifier {
  show(message: string, ...buttons: string[]): PromiseLike<string | undefined>;
}

/**
 * Whether a notification result (button or dismissal) should pause the timer.
 * The notification belongs to one break (`noticeBreakId`); once that break is over, or a newer break
 * has started, the notification is stale and must never reset the timer.
 */
export function shouldPauseForNotice(noticeBreakId: number, current: SharedState): boolean {
  return current.breakActive && current.breakId === noticeBreakId;
}
