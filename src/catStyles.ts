/**
 * Cat movement styles and how cats are dealt out to them. Pure (no vscode, no DOM), and shared by both renderers:
 * the over-code overlay scene (catScene.ts) and the fallback cat tab (bundled into the webview script, see
 * scripts/bundle-webview.js).
 */

/**
 * The styles, in the fixed order cats are assigned in. Keep the names in step with the `meowter.styles`
 * properties in package.json.
 */
export const STYLE_NAMES = ['wanderer', 'climber', 'bouncer', 'yarnChaser'] as const;

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

/**
 * Deals `count` cats out to the enabled styles round-robin, in the fixed style order, so a small count gets
 * one of each style first. The list is the style of cat 0, 1, 2...; its length is `count` (at least 1).
 */
export function assignStyles(count: number, enabled: readonly CatStyle[] = STYLE_NAMES): CatStyle[] {
  const styles = enabled.length > 0 ? STYLE_NAMES.filter((s) => enabled.includes(s)) : [FALLBACK_STYLE];
  const n = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  return Array.from({ length: n }, (_, i) => styles[i % styles.length]);
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
