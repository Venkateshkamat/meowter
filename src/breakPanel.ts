import * as vscode from 'vscode';
import { buildBreakHtml, makeNonce } from './html';

const REFOCUS_MIN_GAP_MS = 250;

export const BREAK_VIEW_TYPE = 'meowter.break';

export interface WebviewReport {
  ready: boolean;
  cats: number;
}

/**
 * Owns the cat webview lifecycle for one window.
 *
 * Events:
 *  - onDidRequestPause: the user closed the cat tab (the tab has no button).
 *    Programmatic closes (close()) never fire it.
 */
export class BreakPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  /** Set right before a programmatic dispose so it is not treated as a user close. */
  private programmatic = new WeakSet<vscode.WebviewPanel>();
  private report: WebviewReport = { ready: false, cats: 0 };
  private readonly pauseEmitter = new vscode.EventEmitter<void>();
  readonly onDidRequestPause = this.pauseEmitter.event;

  private refocusTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRefocusAt = 0;
  private readonly windowListener: vscode.Disposable;

  constructor(private readonly extensionUri: vscode.Uri) {
    // Re-check when the window regains focus.
    this.windowListener = vscode.window.onDidChangeWindowState((s) => {
      if (s.focused && this.panel && !this.panel.active) {
        this.scheduleRefocus(this.panel);
      }
    });
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  get webviewPanel(): vscode.WebviewPanel | undefined {
    return this.panel;
  }

  get webviewReport(): WebviewReport {
    return this.report;
  }

  async show(catCount: number): Promise<void> {
    if (this.panel) {
      return;
    }
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const scriptRoot = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview');
    const panel = vscode.window.createWebviewPanel(
      BREAK_VIEW_TYPE,
      'Meowter: Break time 🐱',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot, scriptRoot]
      }
    );
    this.panel = panel;
    this.report = { ready: false, cats: 0 };

    panel.webview.html = buildBreakHtml({
      cspSource: panel.webview.cspSource,
      nonce: makeNonce(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(scriptRoot, 'cats.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'cats.css')).toString(),
      catCount
    });

    panel.webview.onDidReceiveMessage((msg: { type?: string; cats?: number }) => {
      if (msg?.type === 'ready') {
        this.report = { ready: true, cats: typeof msg.cats === 'number' ? msg.cats : 0 };
      }
    });

    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
      if (!this.programmatic.has(panel)) {
        // The user closed the cat tab: same as clicking the pause button.
        this.pauseEmitter.fire();
      }
    });
    panel.onDidChangeViewState((e) => {
      if (!e.webviewPanel.active) {
        this.scheduleRefocus(panel);
      }
    });

    panel.reveal(vscode.ViewColumn.Active, false);
  }

  /** Brings the cat tab back to the front when the user switches away during a break. */
  private scheduleRefocus(panel: vscode.WebviewPanel): void {
    if (this.refocusTimer) {
      return;
    }
    const wait = Math.max(0, REFOCUS_MIN_GAP_MS - (Date.now() - this.lastRefocusAt));
    this.refocusTimer = setTimeout(() => {
      this.refocusTimer = undefined;
      this.refocusIfNeeded(panel);
    }, Math.max(wait, 50));
  }

  private refocusIfNeeded(panel: vscode.WebviewPanel): void {
    // Only for the open (not being closed) break panel, and never fight an unfocused window.
    if (this.panel !== panel || panel.active || !vscode.window.state.focused) {
      return;
    }
    this.lastRefocusAt = Date.now();
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
  }

  /** Closes the panel without signalling a pause. Idempotent. */
  async close(): Promise<void> {
    const panel = this.panel;
    this.clearRefocus();
    if (panel) {
      this.programmatic.add(panel);
      this.panel = undefined;
      panel.dispose();
    }
  }

  private clearRefocus(): void {
    if (this.refocusTimer) {
      clearTimeout(this.refocusTimer);
      this.refocusTimer = undefined;
    }
  }

  dispose(): void {
    this.clearRefocus();
    this.windowListener.dispose();
    if (this.panel) {
      this.programmatic.add(this.panel);
      this.panel.dispose();
    }
    this.panel = undefined;
    this.pauseEmitter.dispose();
  }
}
