import * as vscode from 'vscode';
import { planScene, sceneDataUri } from './catScene';
import { assignStyles, CatStyle, distributeStyles } from './catStyles';
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
  viewportRowsFrom,
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
  /** The movement style of each cat on this editor. */
  styles: CatStyle[];
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

/** What the overlay draws: how many cats, and which movement styles are enabled (they are dealt out round-robin). */
export interface OverlayConfig {
  catCount: number;
  styles: readonly CatStyle[];
}

/** A visible text editor cats can be drawn on. */
export interface Surface {
  editor: vscode.TextEditor;
  /** The editor group it is shown in. */
  column: number | undefined;
  /** Share of its group's width: 0.5 for each side of a side-by-side diff, else 1. */
  share: number;
}

interface Entry {
  type: vscode.TextEditorDecorationType;
  key: string;
  /** Where the decoration is set: `line:hasText` (an empty line needs an empty range). */
  at: string;
  state: OverlayEditorState;
}

/** One editor's cats for the whole break: the seed stays, so a re-planned scene keeps the same cats. */
interface Scene {
  seed: number;
  key: string;
  uri: string;
}

/** Re-anchoring after a scroll: about a frame, so the cats do not travel with the text for long. */
const REFRESH_DEBOUNCE_MS = 16;
const DOC_DEBOUNCE_MS = 300;
/** Upper bound of lines scanned for the widest one (keeps huge files cheap). */
const MAX_SCANNED_LINES = 200000;

/**
 * Draws animated pixel cats over every visible text editor using editor decorations.
 *
 * The extension API has no overlay, so each editor gets ONE decoration (on the first character of a line) whose
 * CSS rule (injected through `backgroundColor`, see overlayStyle) makes it an absolutely positioned, click-through
 * box as wide as the editor's visible text area, showing a self-animating SVG scene (see catScene.ts). The box is
 * attached to a line of the editor, so it is re-anchored whenever the visible range changes. Its height is the
 * editor's viewport height (learnt from the visible ranges, see viewportRowsFrom) and the cats' size follows the line
 * height only, so the cats look the same wherever the editor is scrolled.
 */
export class CatOverlay implements vscode.Disposable {
  private readonly entries = new Map<vscode.TextEditor, Entry>();
  private readonly scenes = new Map<vscode.TextEditor, Scene>();
  /** Viewport rows learnt per editor (kept between breaks: an editor's height rarely changes). */
  private readonly viewportRows = new WeakMap<vscode.TextEditor, number>();
  private readonly listeners: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private seed = (Date.now() % 100000) | 0;
  private created = 0;
  private disposedTypes = 0;
  private config: () => OverlayConfig = () => ({ catCount: 1, styles: assignStyles(1) });
  private fractions: number[] = [];
  private readonly widest = new Map<string, { version: number; columns: number }>();
  /** Widest-line width seen per document during this break; it never shrinks (Monaco's layer does not either). */
  private readonly peaks = new Map<string, number>();
  private docTimer: ReturnType<typeof setTimeout> | undefined;
  /** Re-reads of the group layout scheduled after a start or an editor/group change (the layout settles late). */
  private layoutTimers: Array<ReturnType<typeof setTimeout>> = [];
  /** Which editors (and columns) the layout was last read for; see checkLayout. */
  private layoutSignature = '';

  /** Editors that can show cats: real editor tabs (not panel/output editors, not notebook cells). */
  static candidates(): vscode.TextEditor[] {
    return CatOverlay.surfaces().map((s) => s.editor);
  }

  /**
   * The editors cats are drawn on: editors in an editor group, and both sides of the diff shown in a group. (Cursor
   * gives the two sides of a diff no view column, so they are matched to the group whose active tab is that diff.)
   */
  static surfaces(): Surface[] {
    const diffColumns = new Map<string, number>();
    for (const group of vscode.window.tabGroups.all) {
      const input = group.activeTab?.input;
      if (input instanceof vscode.TabInputTextDiff) {
        diffColumns.set(input.original.toString(), group.viewColumn);
        diffColumns.set(input.modified.toString(), group.viewColumn);
      }
    }
    const surfaces: Surface[] = [];
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme === 'vscode-notebook-cell') {
        continue;
      }
      const diffColumn = diffColumns.get(editor.document.uri.toString());
      if (editor.viewColumn !== undefined) {
        surfaces.push({ editor, column: editor.viewColumn, share: diffColumn === editor.viewColumn ? 0.5 : 1 });
      } else if (diffColumn !== undefined) {
        surfaces.push({ editor, column: diffColumn, share: 0.5 });
      }
    }
    return surfaces;
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

  /** Starts (or re-applies) the overlay. `config` is read on every refresh, so a changed setting applies live. */
  start(config: () => OverlayConfig): void {
    this.config = config;
    const first = !this.running;
    if (first) {
      this.running = true;
      this.listeners.push(
        vscode.window.onDidChangeVisibleTextEditors(() => {
          void this.updateGroupLayout();
          this.recheckLayoutSoon();
          this.refresh();
        }),
        vscode.window.tabGroups.onDidChangeTabGroups(() => {
          void this.updateGroupLayout();
          this.recheckLayoutSoon();
        }),
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
    // The editor groups are often still being laid out when a break starts: look again a few times.
    if (first) {
      this.recheckLayoutSoon([250, 1000, 2500]);
    }
  }

  /** Re-reads the group layout after the given delays (default: once, shortly). */
  private recheckLayoutSoon(delays: number[] = [300]): void {
    for (const ms of delays) {
      const timer = setTimeout(() => {
        this.layoutTimers = this.layoutTimers.filter((t) => t !== timer);
        if (this.running) {
          void this.updateGroupLayout();
        }
      }, ms);
      this.layoutTimers.push(timer);
    }
  }

  /**
   * Cheap, synchronous check meant for a once-a-second break tick: when the set of visible editors or their columns
   * differs from the last time the layout was read, read it again. Does nothing otherwise.
   */
  checkLayout(): void {
    if (!this.running) {
      return;
    }
    const signature = CatOverlay.surfaces()
      .map((s) => `${s.column}:${s.share}:${s.editor.document.uri.toString()}`)
      .join('|');
    if (signature !== this.layoutSignature) {
      this.layoutSignature = signature;
      void this.updateGroupLayout();
    }
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
    for (const t of this.layoutTimers.splice(0)) {
      clearTimeout(t);
    }
    // The next break may start in a different layout: do not trust this one until it is read again.
    this.fractions = [];
    this.layoutSignature = '';
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
    this.scenes.clear();
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
    const surfaces = CatOverlay.surfaces();
    const candidates = surfaces.map((s) => s.editor);
    const columns = new Set(surfaces.map((s) => s.column)).size;
    for (const [editor, entry] of [...this.entries]) {
      if (!candidates.includes(editor)) {
        this.disposeType(entry);
        this.entries.delete(editor);
        this.scenes.delete(editor);
      }
    }
    const { catCount, styles } = this.config();
    const perEditor = catsPerEditor(catCount, candidates.length);
    // Styles are dealt out over ALL the cats of all editors, so a small count still gets one of each style first.
    // A fighting pair stays together on one editor (see distributeStyles).
    const assignment = distributeStyles(assignStyles(perEditor * candidates.length, styles), perEditor, candidates.length);
    for (const [index, surface] of surfaces.entries()) {
      try {
        this.apply(surface, columns, perEditor, assignment[index]);
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

  /** `columns`: how many editor groups show cats (the width share used until the real layout is read). */
  private apply(surface: Surface, columns: number, cats: number, catStyles: CatStyle[]): void {
    const { editor } = surface;
    const doc = editor.document;
    const lh = this.lineHeightFor(editor);
    const ranges = editor.visibleRanges.map((r) => ({ start: r.start.line, end: r.end.line }));
    if (ranges.length === 0) {
      return;
    }
    const rows = ranges.reduce((n, r) => n + r.end - r.start + 1, 0);
    const cfg = vscode.workspace.getConfiguration('editor', { uri: doc.uri, languageId: doc.languageId });
    const endVisible = ranges[ranges.length - 1].end >= doc.lineCount - 1;
    const wordWrap = cfg.get<string>('wordWrap', 'off');
    const wraps = wordWrap !== 'off';
    const viewportRows = viewportRowsFrom(this.viewportRows.get(editor), rows, !endVisible && !wraps);
    this.viewportRows.set(editor, viewportRows);
    const layout: Layout | undefined = computeLayout(ranges, lh, { lineCount: doc.lineCount, viewportRows, wraps });
    if (!layout) {
      return;
    }
    const fraction = Math.round(widthFractionFor(this.fractions, surface.column, columns) * surface.share * 1000) / 1000;
    const charWidth = charWidthPx(cfg.get<number>('fontSize', 14), cfg.get<number>('letterSpacing', 0));
    const docKey = doc.uri.toString();
    // Wrapped at the editor's width ('on', 'bounded'), no line is wider than the editor: nothing to cap.
    const fitsWidth = wordWrap === 'on' || wordWrap === 'bounded';
    const widestPx = fitsWidth ? 0 : holdPeak(this.peaks.get(docKey), widestLinePx(this.widestColumnsOf(editor), charWidth));
    if (!fitsWidth) {
      this.peaks.set(docKey, widestPx);
    }
    // The scene (the cats and their moves) is planned once per editor and only again when what it depends on
    // changes; the seed stays for the whole break, so scrolling never swaps the cats for new ones.
    const sceneKey = `${layout.scale}|${layout.planHeightPx}|${cats}|${catStyles.join(',')}`;
    let scene = this.scenes.get(editor);
    if (!scene || scene.key !== sceneKey) {
      const seed = scene?.seed ?? (this.seed += 7919);
      const plans = planScene({ scale: layout.scale, heightPx: layout.planHeightPx, cats, styles: catStyles, seed });
      scene = { seed, key: sceneKey, uri: sceneDataUri(plans, layout.scale) };
      this.scenes.set(editor, scene);
    }
    const key = `${sceneKey}|${layout.heightPx}|${layout.anchor}|${lh}|${fraction}|${widestPx}`;
    let entry = this.entries.get(editor);
    // A changed overlay gets a new decoration type; the old one goes only once the new one is set, so the cats never
    // blink out in between.
    const replaced = entry && entry.key !== key ? entry : undefined;
    if (replaced) {
      entry = undefined;
    }
    const state: OverlayEditorState = {
      uri: docKey,
      viewColumn: surface.column,
      anchorLine: layout.anchorLine,
      anchor: layout.anchor,
      rows: layout.rows,
      heightPx: layout.heightPx,
      scale: layout.scale,
      cats,
      styles: catStyles,
      widthFraction: fraction,
      widestPx,
      widthCss: widthCapCss(fraction, widestPx)
    };
    if (!entry) {
      const css = overlayStyle(layout, lh, scene.uri, fraction, widestPx);
      const type = vscode.window.createTextEditorDecorationType({ backgroundColor: css });
      this.created++;
      entry = { type, key, at: '', state };
      this.entries.set(editor, entry);
    }
    entry.state = state;
    // One character, so a word-wrapped line still shows a single box (on its first row). An empty line has no
    // character: its empty range is drawn as a box at the start of the line just the same.
    const line = Math.min(layout.anchorLine, Math.max(0, doc.lineCount - 1));
    const hasText = doc.lineAt(line).text.length > 0;
    const at = `${line}:${hasText}`;
    if (entry.at !== at) {
      editor.setDecorations(entry.type, [new vscode.Range(line, 0, line, hasText ? 1 : 0)]);
      entry.at = at;
    }
    if (replaced) {
      this.disposeType(replaced);
    }
  }
}
