import * as vscode from 'vscode';
import { planScene, sceneDataUri } from './catScene';
import {
  AnchorMode,
  catsPerEditor,
  columnFractions,
  computeLayout,
  computeLineHeight,
  charWidthPx,
  EditorLayoutNode,
  holdPeak,
  Layout,
  overlayStyle,
  widestColumns,
  widestLinePx,
  widthCapCss,
  widthFractionFor
} from './overlayLayout';

export interface OverlayEditorState {
  uri: string;
  viewColumn: number | undefined;
  anchorLine: number;
  anchor: AnchorMode;
  rows: number;
  heightPx: number;
  scale: number;
  cats: number;
  /** Share of the editor area's width this editor's column has (drives the width cap). */
  widthFraction: number;
  /** Widest line of the document in px (tabs expanded, plus Monaco's scroll room), rounded up to a bucket. */
  widestPx: number;
  /** The CSS `width` applied to the overlay. */
  widthCss: string;
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
const DOC_DEBOUNCE_MS = 300;
/** Upper bound of lines scanned for the widest one (keeps huge files cheap). */
const MAX_SCANNED_LINES = 200000;

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
  private fractions: number[] = [];
  private readonly widest = new Map<string, { version: number; columns: number }>();
  /** Widest-line width seen per document during this break; it never shrinks (Monaco's layer does not either). */
  private readonly peaks = new Map<string, number>();
  private docTimer: ReturnType<typeof setTimeout> | undefined;

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
        vscode.window.onDidChangeVisibleTextEditors(() => {
          void this.updateGroupLayout();
          this.refresh();
        }),
        vscode.window.tabGroups.onDidChangeTabGroups(() => void this.updateGroupLayout()),
        vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.contentChanges.length > 0 && [...this.entries.keys()].some((ed) => ed.document === e.document)) {
            this.scheduleDocRefresh();
          }
        }),
        vscode.window.onDidChangeTextEditorVisibleRanges(() => this.schedule()),
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration('editor') || e.affectsConfiguration('meowter')) {
            this.refresh();
          }
        })
      );
    }
    this.refresh();
    void this.updateGroupLayout();
  }

  /**
   * Reads how the editor groups are laid out (the internal `vscode.getEditorLayout` command) to know each
   * editor's share of the width; re-applies when that changed.
   */
  private async updateGroupLayout(): Promise<void> {
    try {
      const layout = await vscode.commands.executeCommand<EditorLayoutNode | undefined>('vscode.getEditorLayout');
      const next = columnFractions(layout);
      const changed = next.length !== this.fractions.length || next.some((f, i) => Math.abs(f - this.fractions[i]) > 0.005);
      this.fractions = next;
      if (changed && this.running) {
        this.refresh();
      }
    } catch (err) {
      console.error('Meowter: could not read the editor layout', err);
    }
  }

  /** Removes every decoration. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.docTimer) {
      clearTimeout(this.docTimer);
      this.docTimer = undefined;
    }
    this.widest.clear();
    this.peaks.clear();
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

  /** Typing can make a line wider than the editor: re-check the cap, debounced. */
  private scheduleDocRefresh(): void {
    if (!this.running || this.docTimer) {
      return;
    }
    this.docTimer = setTimeout(() => {
      this.docTimer = undefined;
      this.refresh();
    }, DOC_DEBOUNCE_MS);
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

  /** Widest line of the whole document in columns (Monaco's layer follows it, not just the visible lines). */
  private widestColumnsOf(editor: vscode.TextEditor): number {
    const doc = editor.document;
    const key = doc.uri.toString();
    const cached = this.widest.get(key);
    if (cached && cached.version === doc.version) {
      return cached.columns;
    }
    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
    const n = Math.min(doc.lineCount, MAX_SCANNED_LINES);
    let columns = 0;
    for (let i = 0; i < n; i++) {
      const text = doc.lineAt(i).text;
      if (text.length > columns || text.indexOf('\t') >= 0) {
        columns = Math.max(columns, widestColumns([text], tabSize));
      }
    }
    this.widest.set(key, { version: doc.version, columns });
    return columns;
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
    const fraction = Math.round(widthFractionFor(this.fractions, editor.viewColumn, CatOverlay.candidates().length) * 1000) / 1000;
    const cfg = vscode.workspace.getConfiguration('editor', { uri: editor.document.uri, languageId: editor.document.languageId });
    const charWidth = charWidthPx(cfg.get<number>('fontSize', 14), cfg.get<number>('letterSpacing', 0));
    const docKey = editor.document.uri.toString();
    const widestPx = holdPeak(this.peaks.get(docKey), widestLinePx(this.widestColumnsOf(editor), charWidth));
    this.peaks.set(docKey, widestPx);
    const key = `${layout.scale}|${layout.heightPx}|${layout.anchor}|${cats}|${lh}|${fraction}|${widestPx}`;
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
      cats,
      widthFraction: fraction,
      widestPx,
      widthCss: widthCapCss(fraction, widestPx)
    };
    if (!entry) {
      const plans = planScene({ scale: layout.scale, heightPx: layout.heightPx, cats, seed: (this.seed += 7919) });
      const css = overlayStyle(layout, lh, sceneDataUri(plans, layout.scale), fraction, widestPx);
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
