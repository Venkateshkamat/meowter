import * as vscode from 'vscode';
import { ActivityTracker } from './activity';
import { BreakPanel, WebviewReport } from './breakPanel';
import { SharedStateStore } from './sharedState';
import {
  applyBreakNow,
  applyPause,
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
}

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
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = {
    title: 'Meowter settings',
    command: 'workbench.action.openSettings',
    arguments: ['meowter.breakIntervalMinutes']
  };

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
    statusBar.tooltip = state.breakActive
      ? 'Meowter: time for a break! Click the button in the cat tab to resume.'
      : `Meowter: ${remainingMinutes(state.activeMs, intervalMs)} min of active IDE use until your next break. ` +
        'Click to change the break interval.';
  };

  // Brings this window's UI in line with the shared file.
  const reconcileNow = async (): Promise<void> => {
    const state = store.read();
    lastState = state;
    updateStatusBar(state);
    if (state.breakActive && !breakPanel.isOpen) {
      await breakPanel.show(readSettings().catCount);
    } else if (!state.breakActive && breakPanel.isOpen) {
      await breakPanel.close();
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

  const pause = async (): Promise<void> => {
    safeWrite(applyPause(store.read(), Date.now()));
    lastTickAt = undefined;
    // Close even if another reconcile is queued; close() is idempotent.
    queue = queue.then(() => breakPanel.close()).catch((err) => console.error('Meowter: close failed', err));
    await queue;
    await reconcile();
  };

  const startBreakNow = async (): Promise<void> => {
    safeWrite(applyBreakNow(store.read(), readSettings().intervalMs, Date.now()));
    await reconcile();
  };

  context.subscriptions.push(
    activity,
    breakPanel,
    statusBar,
    breakPanel.onDidRequestPause(() => void pause()),
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
    pause,
    tickNow: tick,
    isBreakPanelOpen: () => breakPanel.isOpen,
    getStatusBarText: () => statusBar.text,
    getBreakPanelForTest: () => breakPanel.webviewPanel,
    getWebviewReport: () => breakPanel.webviewReport
  };
}

export function deactivate(): void {
  // Disposables registered in context.subscriptions are cleaned up by the host.
}
