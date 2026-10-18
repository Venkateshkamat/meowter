import * as vscode from 'vscode';

/** Tracks the last time the user was seen active in this window. */
export class ActivityTracker implements vscode.Disposable {
  private last: number;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly clock: () => number = Date.now) {
    this.last = clock();
    const touch = () => this.touch();
    const w = vscode.window;
    this.disposables.push(
      w.onDidChangeWindowState((s) => {
        if (s.active || s.focused) {
          this.touch();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (w.visibleTextEditors.some((ed) => ed.document === e.document)) {
          this.touch();
        }
      }),
      w.onDidChangeTextEditorSelection(touch),
      w.onDidChangeTextEditorVisibleRanges(touch),
      w.onDidChangeActiveTextEditor(touch),
      w.onDidChangeActiveTerminal(touch),
      w.onDidChangeActiveNotebookEditor(touch),
      w.onDidChangeNotebookEditorSelection(touch),
      w.onDidChangeNotebookEditorVisibleRanges(touch)
    );
  }

  touch(now: number = this.clock()): void {
    this.last = now;
  }

  get lastActivityAt(): number {
    return this.last;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
