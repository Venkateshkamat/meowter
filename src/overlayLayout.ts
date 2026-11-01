/**
 * Pure layout maths for the cat overlay drawn over a text editor (no vscode import).
 *
 * The overlay is an absolutely positioned decoration anchored to one line of the editor. Its width
 * is 100% of the editor's text area; its height and anchor are derived from the visible lines.
 */

/** Fewest rows the overlay covers, so cats have room even in short files or at the end of a file. */
export const MIN_ROWS = 14;
/** The height the cats' moves are planned for is rounded down to a multiple of this many rows (limits re-planning). */
export const ROW_BUCKET = 4;

const GOLDEN_RATIO_MAC = 1.5;
const GOLDEN_RATIO_OTHER = 1.35;

/** VS Code's `editor.lineHeight` rules: 0 = automatic, below 8 = multiplier of the font size. */
export function computeLineHeight(fontSize: number, lineHeight: number, isMac: boolean): number {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14;
  const lh = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 0;
  let px: number;
  if (lh === 0) {
    px = Math.round((isMac ? GOLDEN_RATIO_MAC : GOLDEN_RATIO_OTHER) * size);
  } else if (lh < 8) {
    px = Math.round(lh * size);
  } else {
    px = Math.round(lh);
  }
  return Math.max(8, px);
}

export interface LineRange {
  start: number;
  end: number;
}

export type AnchorMode = 'top' | 'bottom';

export interface Layout {
  /** Number of visible rows (lines). */
  rows: number;
  /** Line the decoration is attached to. */
  anchorLine: number;
  anchor: AnchorMode;
  /** Overlay height in rows and px. */
  heightRows: number;
  heightPx: number;
  /** Height the cats' moves are planned for: the overlay height rounded down to a bucket (limits re-planning). */
  planHeightPx: number;
  /** Pixels per sprite pixel. */
  scale: number;
}

/**
 * Pixels per sprite pixel, from the editor's line height only: the cats keep one size wherever the editor is
 * scrolled (21px lines, the default, give 4).
 */
export function scaleForLineHeight(lineHeight: number): number {
  return Math.min(5, Math.max(3, Math.round(lineHeight / 5)));
}

/**
 * How many rows the editor's viewport shows, learnt from its visible ranges (the extension API has no pixel height).
 * The number of visible lines is the viewport height only when every line takes one row and the end of the
 * document is not in view. Otherwise it is a lower bound and the largest one seen is kept: with the end in view (a
 * short file, or scrolled to the bottom) the lines stop above the bottom of the editor, and with word wrap on a long
 * line takes several rows. A change of one row is the partly visible line at an edge coming and going while
 * scrolling, and is ignored.
 */
export function viewportRowsFrom(previous: number | undefined, rows: number, exact: boolean): number {
  if (!exact) {
    return Math.max(previous ?? 0, rows);
  }
  if (previous !== undefined && Math.abs(rows - previous) <= 1) {
    return previous;
  }
  return rows;
}

/**
 * Chooses where the overlay is attached and how tall it is. The height is the viewport's (`viewportRows`, see
 * viewportRowsFrom), not the number of lines in view, so the cats keep their room wherever the editor is scrolled.
 *  - Normally: attach to the LAST visible line and grow upward, so the floor is the bottom of the visible text.
 *  - When the visible lines stop above the bottom of the editor (end of the file in view) or are very few: attach
 *    to the FIRST visible line and grow downward into the empty space under the text.
 * Returns undefined when nothing is visible.
 */
export function computeLayout(
  ranges: readonly LineRange[],
  lineHeight: number,
  view: { lineCount?: number; viewportRows?: number; wraps?: boolean } = {}
): Layout | undefined {
  if (ranges.length === 0) {
    return undefined;
  }
  let rows = 0;
  for (const r of ranges) {
    rows += Math.max(0, r.end - r.start) + 1;
  }
  const first = ranges[0].start;
  const last = ranges[ranges.length - 1].end;
  const viewportRows = Math.max(rows, view.viewportRows ?? rows);
  const endVisible = view.lineCount !== undefined && last >= view.lineCount - 1;
  const anchor: AnchorMode = rows < MIN_ROWS || (endVisible && rows < viewportRows - 1) ? 'top' : 'bottom';
  // The decoration is drawn on the first row of its line. With word wrap on, the first visible line may be scrolled
  // half out of view with its first row above the editor, where Monaco draws nothing: the top anchor then uses the
  // next line, which always starts in view, and the overlay is a row shorter.
  const second = ranges[0].end > first ? first + 1 : ranges[1]?.start;
  const skipFirst = anchor === 'top' && view.wraps === true && second !== undefined && first > 0;
  // (the count includes the partly visible lines at the edges)
  const heightRows = Math.max(MIN_ROWS, viewportRows - 1 - (skipFirst ? 1 : 0));
  const heightPx = heightRows * lineHeight;
  return {
    rows,
    anchorLine: anchor === 'bottom' ? last : skipFirst ? (second as number) : first,
    anchor,
    heightRows,
    heightPx,
    planHeightPx: Math.max(MIN_ROWS, Math.floor(heightRows / ROW_BUCKET) * ROW_BUCKET) * lineHeight,
    scale: scaleForLineHeight(lineHeight)
  };
}

/**
 * How many cats each editor of a window gets: the setting is the number of cats in the window, shared out as evenly
 * as possible over its visible editors (the first editors get one more when it does not divide). With more editors
 * than cats, the editors at the end get none.
 */
export function catsForEditors(catCount: number, editors: number): number[] {
  const total = Math.max(1, Math.round(Number.isFinite(catCount) ? catCount : 1));
  const n = Math.max(0, Math.floor(editors));
  const base = n > 0 ? Math.floor(total / n) : 0;
  return Array.from({ length: n }, (_, i) => base + (i < total - base * n ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Estimating the visible width
// ---------------------------------------------------------------------------------------------

/**
 * Monaco makes the whole-line overlay as wide as the editor's SCROLL width: the visible text area, or the widest
 * line when a line is wider than the editor. Extensions cannot read the visible width, so the overlay is capped
 * with an ESTIMATE of it, `min(100%, estimate)`: when no line overflows, 100% is smaller and stays exact.
 *
 * estimate = (window width - SIDE_ALLOWANCE) * (share of the editor area this editor's column has) - EDITOR_CHROME
 * where the window width is the CSS `100vw`. The allowances err on the SMALL side: a cat domain slightly narrower
 * than the visible text is fine, one wider than it puts cats out of view.
 */
export const SIDE_ALLOWANCE_PX = 560;
/** Gutter (line numbers, glyph margin, folding), minimap and scrollbar of one editor. */
export const EDITOR_CHROME_PX = 180;
/** Never narrower than this: the cats need room. */
export const MIN_WIDTH_PX = 120;

/** The estimated visible text width in px, for a window of `viewportWidth` px (the same maths as the CSS). */
export function estimateWidthPx(viewportWidth: number, widthFraction: number): number {
  const f = Number.isFinite(widthFraction) && widthFraction > 0 ? Math.min(1, widthFraction) : 1;
  return Math.max(MIN_WIDTH_PX, (viewportWidth - SIDE_ALLOWANCE_PX) * f - EDITOR_CHROME_PX);
}

/** Monaco adds this many columns of scroll room after the widest line (`editor.scrollBeyondLastColumn`). */
export const SCROLL_BEYOND_COLUMNS = 4;
/** Share of the font size taken by one character of a monospace font. */
export const CHAR_WIDTH_RATIO = 0.6;
/** Widest-line widths are rounded up to this many px so typing does not rebuild the decoration on every key. */
export const WIDEST_BUCKET_PX = 40;

/** Width of one character in px, from `editor.fontSize` and `editor.letterSpacing`. */
export function charWidthPx(fontSize: number, letterSpacing = 0): number {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14;
  const spacing = Number.isFinite(letterSpacing) ? letterSpacing : 0;
  return Math.max(1, size * CHAR_WIDTH_RATIO + spacing);
}

/** Length of a line in columns, expanding every tab to the next multiple of `tabSize`. */
export function lineColumns(text: string, tabSize: number): number {
  if (text.indexOf('\t') < 0) {
    return text.length;
  }
  const tab = Number.isFinite(tabSize) && tabSize >= 1 ? Math.floor(tabSize) : 4;
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    col += text.charCodeAt(i) === 9 ? tab - (col % tab) : 1;
  }
  return col;
}

/** Widest line in columns over the given lines (tabs expanded). */
export function widestColumns(lines: Iterable<string>, tabSize: number): number {
  let widest = 0;
  for (const text of lines) {
    const cols = text.length > widest || text.indexOf('\t') >= 0 ? lineColumns(text, tabSize) : 0;
    if (cols > widest) {
      widest = cols;
    }
  }
  return widest;
}

/** The width Monaco will give a layer for a document: widest line plus its scroll room, rounded up to a bucket. */
export function widestLinePx(columns: number, charWidth: number): number {
  const px = (Math.max(0, columns) + SCROLL_BEYOND_COLUMNS) * charWidth;
  return Math.ceil(px / WIDEST_BUCKET_PX) * WIDEST_BUCKET_PX;
}

/**
 * Monaco's layer never shrinks once a wide line has been shown (deleting or undoing the line keeps the scroll
 * width), so the widest-line width only ever grows during a break.
 */
export function holdPeak(previousPeak: number | undefined, current: number): number {
  return Math.max(previousPeak ?? 0, current);
}

/** Whether the cap is needed: only a document with a line wider than the estimated visible width can overflow. */
export function shouldCap(widestPx: number, viewportWidth: number, widthFraction: number): boolean {
  return widestPx > estimateWidthPx(viewportWidth, widthFraction);
}

/** The overlay width the browser ends up with, given Monaco's own scroll width (what the CSS below computes). */
export function overlayWidthPx(scrollWidth: number, widestPx: number, viewportWidth: number, widthFraction: number): number {
  return shouldCap(widestPx, viewportWidth, widthFraction) ? Math.min(scrollWidth, estimateWidthPx(viewportWidth, widthFraction)) : scrollWidth;
}

/**
 * CSS `width` value. When no line of the document is wider than the estimate it is plain `100%` (exact for any
 * sidebar state and window); otherwise `min(100%, estimate)`. The decision is made in CSS, with the real window
 * width: `max(estimate, (estimate - widest) * 1000000)` is huge when the widest line fits (so `min` keeps 100%)
 * and negative otherwise (so `max` keeps the estimate).
 */
export function widthCapCss(widthFraction: number, widestPx = 0): string {
  const f = Number.isFinite(widthFraction) && widthFraction > 0 ? Math.min(1, widthFraction) : 1;
  const share = Math.round(f * 1000) / 1000;
  const estimate = `max(${MIN_WIDTH_PX}px, calc((100vw - ${SIDE_ALLOWANCE_PX}px) * ${share} - ${EDITOR_CHROME_PX}px))`;
  const widest = Math.max(0, Math.round(widestPx));
  return `min(100%, max(${estimate}, calc((${estimate} - ${widest}px) * 1000000)))`;
}

/** The part of the layout returned by the internal `vscode.getEditorLayout` command that matters here. */
export interface EditorLayoutNode {
  /** Only set on the root: 0 = groups side by side, 1 = stacked. Nested levels alternate. */
  orientation?: number;
  groups?: EditorLayoutNode[];
  /** Relative size among siblings. */
  size?: number;
}

/**
 * Share of the editor area's WIDTH of every editor group, in group order (ViewColumn One first), from the layout
 * tree: side-by-side splits divide the width, stacked splits keep it.
 */
export function columnFractions(layout: EditorLayoutNode | undefined): number[] {
  if (!layout) {
    return [];
  }
  const walk = (node: EditorLayoutNode, horizontal: boolean, width: number): number[] => {
    const kids = node.groups;
    if (!kids || kids.length === 0) {
      return [width];
    }
    const total = kids.reduce((sum, k) => sum + (k.size && k.size > 0 ? k.size : 1), 0);
    return kids.flatMap((k) => walk(k, !horizontal, horizontal ? (width * (k.size && k.size > 0 ? k.size : 1)) / total : width));
  };
  return walk(layout, (layout.orientation ?? 0) === 0, 1);
}

/** Width share of the group in `viewColumn` (1-based), falling back to an even split over `fallbackColumns`. */
export function widthFractionFor(fractions: readonly number[], viewColumn: number | undefined, fallbackColumns: number): number {
  const f = viewColumn !== undefined ? fractions[viewColumn - 1] : undefined;
  if (f !== undefined && f > 0) {
    return f;
  }
  return 1 / Math.max(1, fractions.length || fallbackColumns);
}

/** Above the text (Cursor paints each line's text at z-index 4) and the cursor; below hovers and suggestions (1000). */
export const OVERLAY_Z_INDEX = 10;

/**
 * The CSS that turns a decoration on ONE character of the anchor line into the cat overlay. It is injected through
 * the decoration's `backgroundColor` (the raw text lands in the decoration's CSS rule), so the first token is a
 * valid colour.
 *
 * The decoration covers only the first character of the line: a whole-line decoration is drawn once per wrapped
 * row of its line, which showed the cats two or three times over when the anchor line was word-wrapped. Its box is
 * an absolutely positioned div inside Monaco's `.view-overlays`, moved to the start of the line (`left:0`) and made
 * as wide as the editor's text area. Its z-index makes it paint above the text (Monaco's `.lines-content` is the
 * stacking context), `pointer-events:none` keeps typing and clicking working, and `will-change:transform` gives it
 * its own compositor layer so repainting the animation does not repaint the code underneath.
 */
export function overlayStyle(layout: Layout, lineHeight: number, imageUri: string, widthFraction = 1, widestPx = 0): string {
  // Bottom anchor: grow upward from the last visible line, lifted half a line so feet are not clipped when
  // that line is only partly visible. Top anchor: grow downward from the first visible line.
  const edge = layout.anchor === 'bottom' ? `bottom:${Math.round(lineHeight / 2)}px !important; top:auto !important` : 'top:0 !important';
  return [
    'transparent',
    'pointer-events:none',
    'position:absolute',
    'left:0 !important',
    edge,
    `height:${layout.heightPx}px !important`,
    `width:${widthCapCss(widthFraction, widestPx)} !important`,
    `z-index:${OVERLAY_Z_INDEX} !important`,
    `background-image:url("${imageUri}")`,
    'background-repeat:no-repeat',
    'background-size:100% 100%',
    'will-change:transform'
  ].join('; ');
}
