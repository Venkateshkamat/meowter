import * as vscode from 'vscode';
import { ActivityTracker } from './activity';
import { BreakPanel, WebviewReport } from './breakPanel';
import { CatOverlay, OverlayState } from './catOverlay';
import { Notifier, NOTICE_BUTTON, NOTICE_MESSAGE, shouldPauseForNotice } from './notice';
import { SharedStateStore, StateWatcher } from './sharedState';
import { SharedTimer } from './stateSync';
import {
  canPause,
  DEFAULT_BREAK_INTERVAL_MINUTES,
  DEFAULT_IDLE_THRESHOLD_MINUTES,
  formatStatusText,
  isCounting,
  MS_PER_MINUTE,
  normalizeCatCount,
  normalizeMinutes,
  parseIntervalInput,
  remainingMinutes,
  freshState,
  SharedState,
  validateIntervalInput
} from './timer';

/** One counting tick per second, only while this window is focused or a break is showing. */
const TICK_MS = 1000;
/** Other windows' writes arrive as file-system events; this is only a cheap safety net (a stat, no read). */
const SAFETY_POLL_MS = 60_000;
/** Used instead when the directory cannot be watched. */
const FALLBACK_POLL_MS = 1000;
/** Coalesces the burst of events one atomic write produces. */
const WATCH_DEBOUNCE_MS = 30;

export interface MeowterTestApi {
  getState(): SharedState;
  getStateFilePath(): string;
  startBreakNow(): Promise<void>;
  pause(): Promise<void>;
  /** Re-reads the shared file (as a file-system event would), then runs one tick. */
  tickNow(): Promise<void>;
  /** One tick from memory only: no disk access unless a flush falls due. */
  tickMemory(): Promise<void>;
  /** Writes the active time counted in this window to the shared file now. */
  flushNow(): Promise<void>;
  /** Active time counted in this window that the shared file does not have yet. */
  getPendingMs(): number;
  /** File reads and writes made by this window so far. */
  getIoStats(): { reads: number; writes: number };
  /** Whether the 1 s tick is running (only while focused or during a break). */
  isTicking(): boolean;
  /** Whether the state directory is watched (otherwise it is polled). */
  isWatching(): boolean;
  /** Kills the file watcher, as if it had died; other windows must still be noticed. */
  stopWatchingForTest(): void;
  startWatchingForTest(): void;
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

let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<MeowterTestApi> {
  const store = new SharedStateStore(context.globalStorageUri.fsPath);
  await store.ensureDir();
  // A file that cannot be read now is not "no state": start fresh in memory and let the first refresh adopt the real one.
  const core = new SharedTimer(
    store,
    await store.read().catch((err) => {
      console.error('Meowter: could not read shared state', err);
      return freshState();
    })
  );
  // Settings are read once and again only when they change, not on every tick.
  let settings = readSettings();
  const activity = new ActivityTracker();
  const breakPanel = new BreakPanel(context.extensionUri);
  const overlay = new CatOverlay();
  let notifier: Notifier = vscodeNotifier;
  let breakMode: 'overlay' | 'tab' | undefined;
  let noticedBreakId: number | undefined;
  let noEditorTimer: ReturnType<typeof setTimeout> | undefined;
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = SETTINGS_COMMAND;

  // Serializes panel open/close so ticks and pause requests cannot interleave.
  let queue: Promise<void> = Promise.resolve();

  // The status bar is only touched when what it shows changes (each assignment is a message to the UI process).
  let shownText: string | undefined;
  let shownBreak: boolean | undefined;
  let shownTooltip: string | undefined;
  const updateStatusBar = (state: SharedState): void => {
    const { intervalMs } = settings;
    const text = formatStatusText(state, intervalMs);
    if (text !== shownText) {
      shownText = text;
      statusBar.text = text;
    }
    if (state.breakActive !== shownBreak) {
      shownBreak = state.breakActive;
      // During a break the item is a pause button too: notifications auto-hide, the status bar stays.
      statusBar.command = state.breakActive ? { title: NOTICE_BUTTON, command: PAUSE_COMMAND } : SETTINGS_COMMAND;
    }
    const tooltip = state.breakActive
      ? `Meowter: time for a break! Click "${NOTICE_BUTTON}" to send the cats away and restart the timer.`
      : `Meowter: ${remainingMinutes(state.activeMs, intervalMs)} min of active IDE use until your next break. ` +
        'Click to change the break interval.';
    if (tooltip !== shownTooltip) {
      shownTooltip = tooltip;
      statusBar.tooltip = tooltip;
    }
  };

  // The break notification is the pause control. Its result (button or dismissal) pauses, but only
  // while the break it was shown for is still the current one: a stale notification is ignored.
  const showNotice = (breakId: number): void => {
    if (noticedBreakId === breakId) {
      return;
    }
    noticedBreakId = breakId;
    const onResult = async (): Promise<void> => {
      // Judge by the shared file as it is now, not by what this window last saw.
      await core.refresh().catch(() => false);
      if (shouldPauseForNotice(breakId, core.view)) {
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
    const state = core.view;
    reconciledKey = stateKey(state);
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
        overlay.start(() => settings.catCount);
      } else if (!breakPanel.isOpen) {
        await breakPanel.show(settings.catCount);
      }
    } else {
      breakMode = undefined;
      // Break ids can start over (the file was deleted): the next break must be announced even with an id seen before.
      noticedBreakId = undefined;
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

  // Reconcile only when the break state changed or this window's surfaces are not what the state calls for.
  let reconciledKey = '';
  const stateKey = (s: SharedState): string => `${s.breakActive}:${s.breakId}`;
  const surfacesHealthy = (s: SharedState): boolean => {
    if (!s.breakActive) {
      return breakMode === undefined && !overlay.active && !breakPanel.isOpen;
    }
    if (breakMode === 'overlay') {
      // (No editor left to draw on is handled by the debounced onDidChangeVisibleTextEditors check, which waits
      // out the moment between closing one tab and opening another.)
      return overlay.active;
    }
    return breakMode === 'tab' && breakPanel.isOpen;
  };

  // The tick runs only while this window is focused (it may count) or a break is showing (it keeps the surfaces
  // right). An unfocused window with no break does nothing: file events and window-state events wake it.
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  const syncTicking = (): void => {
    const want = vscode.window.state.focused || core.view.breakActive;
    if (want && !tickTimer) {
      core.resetClock(Date.now());
      tickTimer = setInterval(() => void tick(), TICK_MS);
    } else if (!want && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };

  // Brings status bar, surfaces and the tick in line with the in-memory state.
  const sync = async (): Promise<void> => {
    const view = core.view;
    updateStatusBar(view);
    if (core.breakPending) {
      // A break this window just started is a guess until it is in the file (its id may change when another
      // window started one first): show the surfaces and the notification once it is written.
      syncTicking();
      return;
    }
    if (stateKey(view) !== reconciledKey || !surfacesHealthy(view)) {
      await reconcile();
    }
    syncTicking();
  };

  const flush = async (): Promise<void> => {
    try {
      await core.flush(settings.intervalMs);
    } catch (err) {
      console.error('Meowter: failed to write shared state', err);
    }
    await sync();
  };

  const countTick = (): void => {
    const now = Date.now();
    const win = vscode.window.state;
    if (win.focused && win.active) {
      activity.touch(now);
    }
    const counting = isCounting({
      focused: win.focused,
      windowActive: win.active,
      lastActivityAt: activity.lastActivityAt,
      now,
      idleMs: settings.idleMs,
      breakActive: core.view.breakActive
    });
    core.count({ now, counting, intervalMs: settings.intervalMs });
    if (core.flushDue(now)) {
      void flush();
    }
  };

  const tick = async (): Promise<void> => {
    countTick();
    if (core.view.breakActive) {
      // The tick runs during a break anyway: one stat per second notices a pause written by another window even
      // if a file event was missed or the watcher died (no file is read unless the stat shows a change).
      const sig = await store.signature();
      if (sig !== lastSignature) {
        await externalRefresh();
      }
      overlay.checkLayout();
    }
    await sync();
  };

  // Another window changed the shared file (file event or safety poll): take it over.
  let lastSignature: string | undefined;
  let readFailureLogged = false;
  const externalRefresh = async (): Promise<void> => {
    try {
      const sig = await store.signature();
      const changed = await core.refresh();
      lastSignature = sig; // only after a successful read: a file that could not be read is looked at again
      readFailureLogged = false;
      if (changed) {
        await sync();
      }
    } catch (err) {
      if (!readFailureLogged) {
        readFailureLogged = true;
        console.error('Meowter: failed to read shared state', err);
      }
    }
  };

  let watchDebounce: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const startPolling = (everyMs: number): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    pollTimer = setInterval(() => {
      void store.signature().then((sig) => {
        if (sig !== lastSignature) {
          void externalRefresh();
        }
      });
    }, everyMs);
  };
  let watcher: StateWatcher | undefined;
  const startWatching = (): void => {
    watcher?.close();
    watcher = store.watch(
      () => {
        if (!watchDebounce) {
          watchDebounce = setTimeout(() => {
            watchDebounce = undefined;
            void externalRefresh();
          }, WATCH_DEBOUNCE_MS);
        }
      },
      () => {
        watcher = undefined;
        startPolling(FALLBACK_POLL_MS);
      }
    );
  };
  startWatching();
  lastSignature = await store.signature();
  startPolling(watcher ? SAFETY_POLL_MS : FALLBACK_POLL_MS);

  // Ends the break and restarts the timer, whatever the state is.
  const resetNow = async (): Promise<void> => {
    try {
      await core.pause(Date.now());
    } catch (err) {
      console.error('Meowter: failed to write shared state', err);
    }
    // Close even if another reconcile is queued; close() is idempotent.
    queue = queue
      .then(async () => {
        overlay.stop();
        await breakPanel.close();
      })
      .catch((err) => console.error('Meowter: close failed', err));
    await queue;
    await reconcile();
    await sync();
  };

  // A user pause (command, status bar, notification, cat tab): a no-op unless a break is running. The shared
  // file is re-read now, so a stale status bar item, a keybinding or another extension can never zero the timer,
  // and a click after another window already paused does nothing.
  const pause = async (): Promise<void> => {
    await core.refresh().catch(() => false);
    if (!canPause(core.view)) {
      await sync();
      return;
    }
    await resetNow();
  };

  const startBreakNow = async (): Promise<void> => {
    try {
      await core.breakNow(settings.intervalMs, Date.now());
    } catch (err) {
      console.error('Meowter: failed to write shared state', err);
    }
    await reconcile();
    await sync();
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
        settings = readSettings();
        void tick(); // a lower interval may already be reached
      }
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        // Pick up what other windows did meanwhile, then start counting.
        void externalRefresh().then(sync);
        syncTicking();
      } else {
        // Do not hold time back while in the background: other windows must see it.
        void flush();
        syncTicking();
      }
    }),
    {
      dispose: () => {
        clearInterval(tickTimer);
        clearInterval(pollTimer);
        clearTimeout(watchDebounce);
        watcher?.close();
      }
    },
    vscode.commands.registerCommand('meowter.setBreakInterval', async () => {
      const current = settings.intervalMs / MS_PER_MINUTE;
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
      settings = readSettings();
      updateStatusBar(core.view);
    })
  );

  shutdown = async () => {
    clearInterval(tickTimer);
    tickTimer = undefined;
    clearInterval(pollTimer);
    clearTimeout(watchDebounce);
    watchDebounce = undefined;
    watcher?.close();
    try {
      await core.flush(settings.intervalMs);
    } catch (err) {
      console.error('Meowter: failed to write shared state on shutdown', err);
    }
  };

  statusBar.show();
  await tick();

  return {
    getState: () => core.view,
    getStateFilePath: () => store.filePath,
    startBreakNow,
    // Tests use this to reset the timer from any state; real pause paths use the guarded `pause`.
    pause: resetNow,
    tickNow: async () => {
      await externalRefresh();
      await tick();
    },
    tickMemory: tick,
    flushNow: flush,
    getPendingMs: () => core.pendingMs,
    getIoStats: () => ({ ...store.stats }),
    isTicking: () => tickTimer !== undefined,
    isWatching: () => watcher !== undefined,
    stopWatchingForTest: () => {
      watcher?.close();
      watcher = undefined;
    },
    startWatchingForTest: startWatching,
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

export function deactivate(): Promise<void> | undefined {
  // The time counted since the last flush must reach the shared file before the host goes away.
  // Disposables registered in context.subscriptions are cleaned up by the host.
  return shutdown?.();
}
