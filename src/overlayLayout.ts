/**
 * Pure layout maths for the cat overlay drawn over a text editor (no vscode import).
 *
 * The overlay is an absolutely positioned decoration anchored to one line of the editor. Its width
 * is 100% of the editor's text area; its height and anchor are derived from the visible lines.
 */

/** Fewest rows the overlay covers, so cats have room even in short files or at the end of a file. */
export const MIN_ROWS = 14;
/** Overlay heights are rounded up to a multiple of this many rows (limits decoration churn). */
export const ROW_BUCKET = 4;
export const MAX_CATS_PER_EDITOR = 8;
export const MAX_CATS_TOTAL = 16;

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
  /** Pixels per sprite pixel. */
  scale: number;
}

export function scaleForHeight(heightPx: number): number {
  if (heightPx < 320) return 3;
  if (heightPx < 900) return 4;
  return 5;
}

/**
 * Chooses where the overlay is attached and how tall it is.
 *  - Enough visible rows: attach to the LAST visible line and grow upward, so the floor is the bottom
 *    of the visible text no matter how lines wrap.
 *  - Few rows (short file, or the end of a file scrolled up): attach to the FIRST visible line and
 *    grow downward into the empty space under the text.
 * Returns undefined when nothing is visible.
 */
export function computeLayout(ranges: readonly LineRange[], lineHeight: number): Layout | undefined {
  if (ranges.length === 0) {
    return undefined;
  }
  let rows = 0;
  for (const r of ranges) {
    rows += Math.max(0, r.end - r.start) + 1;
  }
  const first = ranges[0].start;
  const last = ranges[ranges.length - 1].end;
  const heightRows = Math.ceil(Math.max(rows, MIN_ROWS) / ROW_BUCKET) * ROW_BUCKET;
  const heightPx = heightRows * lineHeight;
  const anchor: AnchorMode = rows >= MIN_ROWS ? 'bottom' : 'top';
  return {
    rows,
    anchorLine: anchor === 'bottom' ? last : first,
    anchor,
    heightRows,
    heightPx,
    scale: scaleForHeight(heightPx)
  };
}

/** How many cats one editor gets, given the setting and how many editors show cats. */
export function catsPerEditor(catCount: number, editors: number): number {
  const share = Math.max(1, Math.floor(MAX_CATS_TOTAL / Math.max(1, editors)));
  return Math.max(1, Math.min(Math.round(catCount), MAX_CATS_PER_EDITOR, share));
}

/**
 * The CSS that turns a WHOLE-LINE decoration into the cat overlay. It is injected through the decoration's
 * `backgroundColor` (the raw text lands in the decoration's CSS rule), so the first token is a valid colour.
 *
 * Why a whole-line decoration: it is rendered as an absolutely positioned div as wide as the editor's visible
 * text area (inside Monaco's `.view-overlays`), unlike an inline `::before`, whose containing block is the text
 * of one line. Its z-index makes it paint above the text (Monaco's `.lines-content` is the stacking context),
 * `pointer-events:none` keeps typing and clicking working, and `will-change:transform` gives it its own
 * compositor layer so repainting the animation does not repaint the code underneath.
 */
export function overlayStyle(layout: Layout, lineHeight: number, imageUri: string): string {
  // Bottom anchor: grow upward from the last visible line, lifted half a line so feet are not clipped when
  // that line is only partly visible. Top anchor: grow downward from the first visible line.
  const edge = layout.anchor === 'bottom' ? `bottom:${Math.round(lineHeight / 2)}px !important; top:auto !important` : 'top:0 !important';
  return [
    'transparent',
    'pointer-events:none',
    'position:absolute',
    edge,
    `height:${layout.heightPx}px !important`,
    'z-index:1 !important',
    `background-image:url("${imageUri}")`,
    'background-repeat:no-repeat',
    'background-size:100% 100%',
    'will-change:transform'
  ].join('; ');
}
