import * as vscode from 'vscode';
import { planScene, sceneDataUri } from './catScene';
import { AnchorMode, catsPerEditor, computeLayout, computeLineHeight, Layout, overlayStyle } from './overlayLayout';

export interface OverlayEditorState {
  uri: string;
  viewColumn: number | undefined;
  anchorLine: number;
  anchor: AnchorMode;
  rows: number;
  heightPx: number;
  scale: number;
  cats: number;
}

export interface OverlayState {
  active: boolean;
  editors: OverlayEditorState[];
  /** Decoration types created / disposed so far (to check that nothing leaks). */
  typesCreated: number;
  typesDisposed: number;
}

interface Entry {
  type: vscode.TextEditorDecorationType;
  key: string;
  line: number;
  state: OverlayEditorState;
}

const REFRESH_DEBOUNCE_MS = 60;

/**
 * Draws animated pixel cats over every visible text editor using editor decorations.
 *
 * The extension API has no overlay, so each editor gets ONE whole-line decoration whose CSS rule (injected
 * through `backgroundColor`, see overlayStyle) makes it an absolutely positioned, click-through box as wide as
 * the editor's visible text area, showing a self-animating SVG scene (see catScene.ts). The box is attached to
 * a line of the editor, so it is re-anchored whenever the visible range changes.
 */
export class CatOverlay implements vscode.Disposable {
  private readonly entries = new Map<vscode.TextEditor, Entry>();
  private readonly listeners: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private seed = (Date.now() % 100000) | 0;
  private created = 0;
  private disposedTypes = 0;
  private catCount: () => number = () => 1;

  /** Editors that can show cats: real editor tabs (not panel/output editors, not notebook cells). */
  static candidates(): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter(
      (e) => e.viewColumn !== undefined && e.document.uri.scheme !== 'vscode-notebook-cell'
    );
  }

  get active(): boolean {
    return this.running;
  }

  getState(): OverlayState {
    return {
      active: this.running,
      editors: [...this.entries.values()].map((e) => ({ ...e.state })),
      typesCreated: this.created,
      typesDisposed: this.disposedTypes
    };
  }

  /** Starts (or re-applies) the overlay. `catCount` is read on every refresh. */
  start(catCount: () => number): void {
    this.catCount = catCount;
    if (!this.running) {
      this.running = true;
      this.listeners.push(
        vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
        vscode.window.onDidChangeTextEditorVisibleRanges(() => this.schedule()),
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration('editor') || e.affectsConfiguration('meowter')) {
            this.refresh();
          }
        })
      );
    }
    this.refresh();
  }

  /** Removes every decoration. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const l of this.listeners.splice(0)) {
      l.dispose();
    }
    for (const entry of this.entries.values()) {
      this.disposeType(entry);
    }
    this.entries.clear();
  }

  dispose(): void {
    this.stop();
  }

  private schedule(): void {
    if (!this.running || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private disposeType(entry: Entry): void {
    try {
      entry.type.dispose();
    } finally {
      this.disposedTypes++;
    }
  }

  /** Brings the decorations in line with the visible editors, their visible lines and the settings. */
  refresh(): void {
    if (!this.running) {
      return;
    }
    const candidates = CatOverlay.candidates();
    for (const [editor, entry] of [...this.entries]) {
      if (!candidates.includes(editor)) {
        this.disposeType(entry);
        this.entries.delete(editor);
      }
    }
    const perEditor = catsPerEditor(this.catCount(), candidates.length);
    for (const editor of candidates) {
      try {
        this.apply(editor, perEditor);
      } catch (err) {
        console.error('Meowter: failed to decorate an editor', err);
      }
    }
  }

  private lineHeightFor(editor: vscode.TextEditor): number {
    const cfg = vscode.workspace.getConfiguration('editor', { uri: editor.document.uri, languageId: editor.document.languageId });
    return computeLineHeight(cfg.get<number>('fontSize', 14), cfg.get<number>('lineHeight', 0), process.platform === 'darwin');
  }

  private apply(editor: vscode.TextEditor, cats: number): void {
    const lh = this.lineHeightFor(editor);
    const layout: Layout | undefined = computeLayout(
      editor.visibleRanges.map((r) => ({ start: r.start.line, end: r.end.line })),
      lh
    );
    if (!layout) {
      return;
    }
    const key = `${layout.scale}|${layout.heightPx}|${layout.anchor}|${cats}|${lh}`;
    let entry = this.entries.get(editor);
    if (entry && entry.key !== key) {
      this.disposeType(entry);
      this.entries.delete(editor);
      entry = undefined;
    }
    const state: OverlayEditorState = {
      uri: editor.document.uri.toString(),
      viewColumn: editor.viewColumn,
      anchorLine: layout.anchorLine,
      anchor: layout.anchor,
      rows: layout.rows,
      heightPx: layout.heightPx,
      scale: layout.scale,
      cats
    };
    if (!entry) {
      const plans = planScene({ scale: layout.scale, heightPx: layout.heightPx, cats, seed: (this.seed += 7919) });
      const css = overlayStyle(layout, lh, sceneDataUri(plans, layout.scale));
      const type = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: css });
      this.created++;
      entry = { type, key, line: -1, state };
      this.entries.set(editor, entry);
    }
    entry.state = state;
    if (entry.line !== layout.anchorLine) {
      const line = Math.min(layout.anchorLine, Math.max(0, editor.document.lineCount - 1));
      editor.setDecorations(entry.type, [new vscode.Range(line, 0, line, 0)]);
      entry.line = layout.anchorLine;
    }
  }
}
