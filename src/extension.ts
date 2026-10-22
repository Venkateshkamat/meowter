import * as vscode from 'vscode';
import { ActivityTracker } from './activity';
import { BreakPanel, WebviewReport } from './breakPanel';
import { CatOverlay, OverlayState } from './catOverlay';
import { Notifier, NOTICE_BUTTON, NOTICE_MESSAGE, shouldPauseForNotice } from './notice';
import { SharedStateStore } from './sharedState';
import {
  applyBreakNow,
  applyPause,
  canPause,
  applyTick,
  DEFAULT_BREAK_INTERVAL_MINUTES,
  DEFAULT_IDLE_THRESHOLD_MINUTES,
  formatStatusText,
  isCounting,
  MS_PER_MINUTE,
  normalizeCatCount,
  normalizeMinutes,
  parseIntervalInput,
  remainingMinutes,
  SharedState,
  validateIntervalInput
} from './timer';

const TICK_MS = 1000;

export interface MeowterTestApi {
  getState(): SharedState;
  getStateFilePath(): string;
  startBreakNow(): Promise<void>;
  pause(): Promise<void>;
  tickNow(): Promise<void>;
  isBreakPanelOpen(): boolean;
  getStatusBarText(): string;
  getBreakPanelForTest(): vscode.WebviewPanel | undefined;
  getWebviewReport(): WebviewReport;
  /** Decorations currently drawn over the visible editors. */
  getOverlayState(): OverlayState;
  /** Replaces the break notification UI (tests); pass undefined to restore the real one. */
  setNotifier(notifier: Notifier | undefined): void;
  /** How this window shows the current break: cats over the editors, or the fallback cat tab. */
  getBreakMode(): 'overlay' | 'tab' | undefined;
  /** Command run when the status bar item is clicked (the pause command during a break, else the settings). */
  getStatusBarCommand(): string | undefined;
  getStatusBarTooltip(): string;
}

export const PAUSE_COMMAND = 'meowter.pause';
const SETTINGS_COMMAND = {
  title: 'Meowter settings',
  command: 'workbench.action.openSettings',
  arguments: ['meowter.breakIntervalMinutes']
};

const vscodeNotifier: Notifier = {
  show: (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons)
};

interface Settings {
  intervalMs: number;
  idleMs: number;
  catCount: number;
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('meowter');
  return {
    intervalMs:
      normalizeMinutes(cfg.get('breakIntervalMinutes'), DEFAULT_BREAK_INTERVAL_MINUTES) * MS_PER_MINUTE,
    idleMs: normalizeMinutes(cfg.get('idleThresholdMinutes'), DEFAULT_IDLE_THRESHOLD_MINUTES) * MS_PER_MINUTE,
    catCount: normalizeCatCount(cfg.get('catCount'))
  };
}

export function activate(context: vscode.ExtensionContext): MeowterTestApi {
  const store = new SharedStateStore(context.globalStorageUri.fsPath);
  const activity = new ActivityTracker();
  const breakPanel = new BreakPanel(context.extensionUri);
  const overlay = new CatOverlay();
  let notifier: Notifier = vscodeNotifier;
  let breakMode: 'overlay' | 'tab' | undefined;
  let noticedBreakId: number | undefined;
  let noEditorTimer: ReturnType<typeof setTimeout> | undefined;
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = SETTINGS_COMMAND;

  let lastTickAt: number | undefined;
  let lastState: SharedState = store.read();
  // Serializes panel open/close so ticks and pause requests cannot interleave.
  let queue: Promise<void> = Promise.resolve();

  const safeWrite = (state: SharedState): void => {
    try {
      store.write(state);
    } catch (err) {
      console.error('Meowter: failed to write shared state', err);
    }
  };

  const updateStatusBar = (state: SharedState): void => {
    const { intervalMs } = readSettings();
    statusBar.text = formatStatusText(state, intervalMs);
    if (state.breakActive) {
      // During a break the item is a pause button too: notifications auto-hide, the status bar stays.
      statusBar.command = { title: NOTICE_BUTTON, command: PAUSE_COMMAND };
      statusBar.tooltip = `Meowter: time for a break! Click "${NOTICE_BUTTON}" to send the cats away and restart the timer.`;
    } else {
      statusBar.command = SETTINGS_COMMAND;
      statusBar.tooltip =
        `Meowter: ${remainingMinutes(state.activeMs, intervalMs)} min of active IDE use until your next break. ` +
        'Click to change the break interval.';
    }
  };

  // The break notification is the pause control. Its result (button or dismissal) pauses, but only
  // while the break it was shown for is still the current one: a stale notification is ignored.
  const showNotice = (breakId: number): void => {
    if (noticedBreakId === breakId) {
      return;
    }
    noticedBreakId = breakId;
    const onResult = (): void => {
      if (shouldPauseForNotice(breakId, store.read())) {
        void pause();
      }
    };
    try {
      Promise.resolve(notifier.show(NOTICE_MESSAGE, NOTICE_BUTTON)).then(onResult, (err) =>
        console.error('Meowter: break notification failed', err)
      );
    } catch (err) {
      console.error('Meowter: break notification failed', err);
    }
  };

  // Brings this window's UI in line with the shared file.
  const reconcileNow = async (): Promise<void> => {
    const state = store.read();
    lastState = state;
    updateStatusBar(state);
    if (state.breakActive) {
      showNotice(state.breakId);
      if (!breakMode) {
        // Cats over the visible editors, or the cat tab when none is visible.
        breakMode = CatOverlay.candidates().length > 0 ? 'overlay' : 'tab';
      } else if (breakMode === 'overlay' && CatOverlay.candidates().length === 0) {
        // Every text editor was closed during the break: nothing is left to draw on, so use the cat tab.
        // It stays even if an editor becomes visible again (no flip-flopping between the two surfaces).
        overlay.stop();
        breakMode = 'tab';
      }
      if (breakMode === 'overlay') {
        overlay.start(() => readSettings().catCount);
      } else if (!breakPanel.isOpen) {
        await breakPanel.show(readSettings().catCount);
      }
    } else {
      breakMode = undefined;
      overlay.stop();
      if (breakPanel.isOpen) {
        await breakPanel.close();
      }
    }
  };
  const reconcile = (): Promise<void> => {
    queue = queue.then(reconcileNow).catch((err) => console.error('Meowter: reconcile failed', err));
    return queue;
  };

  const tick = async (): Promise<void> => {
    const now = Date.now();
    const { intervalMs, idleMs } = readSettings();
    const win = vscode.window.state;
    if (win.focused && win.active) {
      activity.touch(now);
    }
    const state = store.read(now);
    const counting = isCounting({
      focused: win.focused,
      windowActive: win.active,
      lastActivityAt: activity.lastActivityAt,
      now,
      idleMs,
      breakActive: state.breakActive
    });
    const result = applyTick(state, { now, lastTickAt, counting, intervalMs });
    lastTickAt = now;
    if (result.changed) {
      safeWrite(result.state);
    }
    await reconcile();
  };

  // Ends the break and restarts the timer, whatever the state is.
  const resetNow = async (): Promise<void> => {
    safeWrite(applyPause(store.read(), Date.now()));
    lastTickAt = undefined;
    // Close even if another reconcile is queued; close() is idempotent.
    queue = queue
      .then(async () => {
        overlay.stop();
        await breakPanel.close();
      })
      .catch((err) => console.error('Meowter: close failed', err));
    await queue;
    await reconcile();
  };

  // A user pause (command, status bar, notification, cat tab): a no-op unless a break is running. The shared
  // file is re-read now, so a stale status bar item, a keybinding or another extension can never zero the timer,
  // and a click after another window already paused does nothing.
  const pause = async (): Promise<void> => {
    if (!canPause(store.read())) {
      return;
    }
    await resetNow();
  };

  const startBreakNow = async (): Promise<void> => {
    safeWrite(applyBreakNow(store.read(), readSettings().intervalMs, Date.now()));
    await reconcile();
  };

  context.subscriptions.push(
    activity,
    breakPanel,
    overlay,
    statusBar,
    breakPanel.onDidRequestPause(() => void pause()),
    vscode.commands.registerCommand(PAUSE_COMMAND, () => pause()),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      if (breakMode !== 'overlay' || noEditorTimer) {
        return;
      }
      // Re-check shortly: closing one tab and opening another can briefly show no editor.
      noEditorTimer = setTimeout(() => {
        noEditorTimer = undefined;
        if (breakMode === 'overlay' && CatOverlay.candidates().length === 0) {
          void reconcile();
        }
      }, 300);
    }),
    { dispose: () => noEditorTimer && clearTimeout(noEditorTimer) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('meowter')) {
        updateStatusBar(lastState);
      }
    }),
    vscode.commands.registerCommand('meowter.setBreakInterval', async () => {
      const current = readSettings().intervalMs / MS_PER_MINUTE;
      const input = await vscode.window.showInputBox({
        title: 'Meowter: Set Break Interval',
        prompt: 'Minutes of active IDE use before a break',
        value: String(current),
        validateInput: validateIntervalInput
      });
      if (input === undefined) {
        return;
      }
      const minutes = parseIntervalInput(input);
      if (minutes === undefined) {
        return;
      }
      await vscode.workspace
        .getConfiguration('meowter')
        .update('breakIntervalMinutes', minutes, vscode.ConfigurationTarget.Global);
      updateStatusBar(lastState);
    })
  );

  updateStatusBar(lastState);
  statusBar.show();
  const timer = setInterval(() => void tick(), TICK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void tick();

  return {
    getState: () => store.read(),
    getStateFilePath: () => store.filePath,
    startBreakNow,
    // Tests use this to reset the timer from any state; real pause paths use the guarded `pause`.
    pause: resetNow,
    tickNow: tick,
    isBreakPanelOpen: () => breakPanel.isOpen,
    getStatusBarText: () => statusBar.text,
    getBreakPanelForTest: () => breakPanel.webviewPanel,
    getWebviewReport: () => breakPanel.webviewReport,
    getOverlayState: () => overlay.getState(),
    setNotifier: (n) => {
      notifier = n ?? vscodeNotifier;
    },
    getBreakMode: () => breakMode,
    getStatusBarCommand: () => (typeof statusBar.command === 'string' ? statusBar.command : statusBar.command?.command),
    getStatusBarTooltip: () => String(statusBar.tooltip ?? '')
  };
}

export function deactivate(): void {
  // Disposables registered in context.subscriptions are cleaned up by the host.
}
