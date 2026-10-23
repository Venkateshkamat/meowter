/**
 * Cat movement styles and how cats are dealt out to them. Pure (no vscode, no DOM), and shared by both renderers:
 * the over-code overlay scene (catScene.ts) and the fallback cat tab (bundled into the webview script, see
 * scripts/bundle-webview.js).
 */

/**
 * The styles, in the fixed order cats are assigned in. Keep the names in step with the `meowter.styles`
 * properties in package.json.
 */
export const STYLE_NAMES = ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters'] as const;

export type CatStyle = (typeof STYLE_NAMES)[number];

/** Used when the user turns every style off. */
export const FALLBACK_STYLE: CatStyle = 'wanderer';

export function isStyle(value: unknown): value is CatStyle {
  return typeof value === 'string' && (STYLE_NAMES as readonly string[]).includes(value);
}

/**
 * The enabled styles, in the fixed style order, from the `meowter.styles` setting value.
 * A style that is missing from the object (or not a boolean) keeps its default, enabled. A missing or non-object
 * setting enables all. If every style is switched off the result is the fallback style only.
 */
export function enabledStyles(setting: unknown): CatStyle[] {
  const obj = typeof setting === 'object' && setting !== null && !Array.isArray(setting) ? (setting as Record<string, unknown>) : {};
  const list = STYLE_NAMES.filter((name) => obj[name] !== false);
  return list.length > 0 ? list : [FALLBACK_STYLE];
}

/** Fighters always come as a pair: these two cats fight each other. */
export const FIGHTER_PAIR = 2;

/**
 * Deals `count` cats out to the enabled styles round-robin, in the fixed style order, so a small count gets
 * one of each style first. The list is the style of cat 0, 1, 2...; its length is `count` (at least 1).
 *
 * Fighters take TWO cats at a time (the two entries are next to each other in the list). When it is the
 * Fighters' turn and fewer than two cats are left, they are skipped and the next enabled style gets the cat.
 * If Fighters is the only enabled style and the count is odd, the extra cat is a Wanderer (even though the
 * Wanderer is switched off), and a single cat can never fight, so it is a Wanderer too.
 */
export function assignStyles(count: number, enabled: readonly CatStyle[] = STYLE_NAMES): CatStyle[] {
  const styles = enabled.length > 0 ? STYLE_NAMES.filter((s) => enabled.includes(s)) : [FALLBACK_STYLE];
  const total = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  const out: CatStyle[] = [];
  let turn = 0;
  while (out.length < total) {
    const left = total - out.length;
    const style = styles[turn % styles.length];
    turn++;
    if (style !== 'fighters') {
      out.push(style);
    } else if (left >= FIGHTER_PAIR) {
      out.push('fighters', 'fighters');
    } else if (styles.length === 1) {
      out.push(FALLBACK_STYLE); // only Fighters is on and one cat is left over
    }
    // else: fewer than two cats left: the Fighters are skipped, the next style takes the cat
  }
  return out;
}

/** A group of cats that is placed together: a single cat, or a fighting pair (never split across editors). */
function unitsOf(styles: readonly CatStyle[]): CatStyle[][] {
  const units: CatStyle[][] = [];
  for (let i = 0; i < styles.length; i++) {
    if (styles[i] === 'fighters' && styles[i + 1] === 'fighters') {
      units.push(['fighters', 'fighters']);
      i++;
    } else {
      units.push([styles[i] === 'fighters' ? FALLBACK_STYLE : styles[i]]);
    }
  }
  return units;
}

/**
 * Shares one list of styles (from assignStyles) out over editors that get `perEditor` cats each, in order,
 * without ever splitting a fighting pair across two editors. When the next unit is a pair and only one slot is
 * left in the editor, the first single cat further down the list takes the slot; if there is none, that slot is
 * a Wanderer. The cats of one editor are therefore always exactly `perEditor`, and the total number of cats is
 * unchanged (only the order moves).
 */
export function distributeStyles(styles: readonly CatStyle[], perEditor: number, editors: number): CatStyle[][] {
  const queue = unitsOf(styles);
  const result: CatStyle[][] = [];
  for (let e = 0; e < editors; e++) {
    const mine: CatStyle[] = [];
    while (mine.length < perEditor) {
      const room = perEditor - mine.length;
      if (queue.length === 0) {
        mine.push(FALLBACK_STYLE);
      } else if (queue[0].length <= room) {
        mine.push(...(queue.shift() as CatStyle[]));
      } else {
        // The next unit is a pair and one slot is left.
        const at = queue.findIndex((u) => u.length === 1);
        mine.push(...(at >= 0 ? queue.splice(at, 1)[0] : [FALLBACK_STYLE]));
      }
    }
    result.push(mine);
  }
  return result;
}

/** For handing the enabled styles to the webview as one HTML attribute. */
export function formatStyleList(list: readonly CatStyle[]): string {
  return list.join(',');
}

/** The inverse of formatStyleList; unknown names are dropped and an empty result means all styles. */
export function parseStyleList(text: string | undefined): CatStyle[] {
  const list = (text ?? '').split(',').map((s) => s.trim()).filter(isStyle);
  return list.length > 0 ? STYLE_NAMES.filter((s) => list.includes(s)) : [...STYLE_NAMES];
}

/** The part of the width a fighting pair keeps to (fractions of the free width), so pairs do not crowd each other. */
export type Band = readonly [number, number];

const BAND_EDGE = 0.03;
/** A band is never narrower than this (with many pairs the bands overlap a little). */
const MIN_BAND = 0.4;

/**
 * The band of fighting pair `index` of `total` pairs: one pair gets the whole width, more pairs get bands spread
 * from the left edge to the right edge (two pairs: left half and right half). Both renderers use it.
 */
export function pairBand(index: number, total: number): Band {
  const usable = 1 - 2 * BAND_EDGE;
  if (total <= 1) {
    return [BAND_EDGE, 1 - BAND_EDGE];
  }
  const width = Math.max(usable / total, MIN_BAND);
  const lo = BAND_EDGE + (Math.min(Math.max(index, 0), total - 1) * (usable - width)) / (total - 1);
  return [lo, lo + width];
}
