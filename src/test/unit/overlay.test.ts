import * as assert from 'assert';
import {
  catsPerEditor,
  holdPeak,
  charWidthPx,
  lineColumns,
  overlayWidthPx,
  shouldCap,
  widestColumns,
  widestLinePx,
  WIDEST_BUCKET_PX,
  SCROLL_BEYOND_COLUMNS,
  computeLayout,
  columnFractions,
  computeLineHeight,
  EDITOR_CHROME_PX,
  estimateWidthPx,
  MIN_WIDTH_PX,
  SIDE_ALLOWANCE_PX,
  widthCapCss,
  widthFractionFor,
  MAX_CATS_PER_EDITOR,
  MAX_CATS_TOTAL,
  MIN_ROWS,
  overlayStyle,
  scaleForHeight
} from '../../overlayLayout';
import { NOTICE_BUTTON, NOTICE_MESSAGE, shouldPauseForNotice } from '../../notice';
import { BREAK_STATUS_TEXT, formatStatusText, freshState, SharedState } from '../../timer';

describe('overlay layout', () => {
  it('computes the editor line height like VS Code', () => {
    assert.strictEqual(computeLineHeight(14, 0, true), 21);
    assert.strictEqual(computeLineHeight(14, 0, false), 19);
    assert.strictEqual(computeLineHeight(12, 0, true), 18);
    assert.strictEqual(computeLineHeight(14, 1.5, true), 21, 'values below 8 multiply the font size');
    assert.strictEqual(computeLineHeight(14, 24, true), 24);
    assert.strictEqual(computeLineHeight(NaN, NaN, true), 21, 'bad values fall back to defaults');
    assert.ok(computeLineHeight(1, 0, false) >= 8);
  });

  it('anchors a long visible range to its last line and grows upward', () => {
    const l = computeLayout([{ start: 100, end: 139 }], 20)!;
    assert.strictEqual(l.rows, 40);
    assert.strictEqual(l.anchor, 'bottom');
    assert.strictEqual(l.anchorLine, 139);
    assert.strictEqual(l.heightRows, 40);
    assert.strictEqual(l.heightPx, 800);
    assert.strictEqual(l.scale, 4);
  });

  it('anchors a short range (short file, end of file) to its first line and grows downward', () => {
    const l = computeLayout([{ start: 64, end: 69 }], 20)!;
    assert.strictEqual(l.rows, 6);
    assert.strictEqual(l.anchor, 'top');
    assert.strictEqual(l.anchorLine, 64);
    assert.strictEqual(l.heightRows, Math.ceil(MIN_ROWS / 4) * 4);
    assert.ok(l.heightRows >= MIN_ROWS);
  });

  it('counts folded editors as several ranges and rounds the height up to a bucket', () => {
    const l = computeLayout([{ start: 0, end: 9 }, { start: 30, end: 44 }], 20)!;
    assert.strictEqual(l.rows, 25);
    assert.strictEqual(l.anchorLine, 44, 'last visible line, after the fold');
    assert.strictEqual(l.heightRows, 28);
  });

  it('returns nothing when nothing is visible', () => {
    assert.strictEqual(computeLayout([], 20), undefined);
  });

  it('picks the sprite scale from the overlay height', () => {
    assert.strictEqual(scaleForHeight(200), 3);
    assert.strictEqual(scaleForHeight(480), 4);
    assert.strictEqual(scaleForHeight(1200), 5);
  });

  it('caps cats per editor and in total', () => {
    assert.strictEqual(catsPerEditor(8, 1), 8);
    assert.strictEqual(catsPerEditor(30, 1), MAX_CATS_PER_EDITOR);
    assert.strictEqual(catsPerEditor(30, 2), MAX_CATS_TOTAL / 2);
    assert.strictEqual(catsPerEditor(30, 4), MAX_CATS_TOTAL / 4);
    assert.strictEqual(catsPerEditor(30, 100), 1);
    assert.strictEqual(catsPerEditor(1, 3), 1);
    assert.strictEqual(catsPerEditor(0, 1), 1);
    assert.ok(catsPerEditor(30, 3) * 3 <= MAX_CATS_TOTAL);
  });

  it('builds the click-through, layered, full-width overlay style', () => {
    const bottom = overlayStyle(computeLayout([{ start: 0, end: 39 }], 20)!, 20, 'data:image/svg+xml,x');
    assert.ok(bottom.startsWith('transparent; '), 'starts with a valid background-color value');
    assert.ok(bottom.includes('pointer-events:none'));
    assert.ok(bottom.includes('position:absolute'));
    assert.ok(bottom.includes('bottom:10px !important') && bottom.includes('top:auto !important'));
    assert.ok(bottom.includes('height:800px !important'), 'beats the inline height of the whole-line div');
    assert.ok(bottom.includes('z-index:1 !important'), 'above the text, below the cursor');
    assert.ok(bottom.includes('will-change:transform'), 'own compositor layer');
    assert.ok(bottom.includes('background-image:url("data:image/svg+xml,x")'));
    assert.ok(bottom.includes('background-size:100% 100%'));
    assert.ok(/(^|;\s*)width:min\(100%, max\(max\(120px/.test(bottom) && bottom.includes(') !important'), 'width decided in CSS: capped only when the widest line is wider than the estimate');
    assert.ok(!/left:|right:/.test(bottom));
    const split = overlayStyle(computeLayout([{ start: 0, end: 39 }], 20)!, 20, 'data:x', 0.5);
    assert.ok(split.includes('calc((100vw - 560px) * 0.5 - 180px)'));
    assert.ok(overlayStyle(computeLayout([{ start: 0, end: 39 }], 20)!, 20, 'data:x', 0.5, 880).includes('- 880px)'), 'the widest line is baked in');
    const top = overlayStyle(computeLayout([{ start: 0, end: 3 }], 20)!, 20, 'data:x');
    assert.ok(top.includes('top:0 !important') && !top.includes('bottom:'));
  });
});

describe('visible width estimate', () => {
  it('estimates a share of the window minus allowances, never below the minimum', () => {
    assert.strictEqual(estimateWidthPx(1440, 1), 1440 - SIDE_ALLOWANCE_PX - EDITOR_CHROME_PX);
    assert.strictEqual(estimateWidthPx(1440, 0.5), (1440 - SIDE_ALLOWANCE_PX) * 0.5 - EDITOR_CHROME_PX);
    assert.strictEqual(estimateWidthPx(1920, 1 / 3), (1920 - SIDE_ALLOWANCE_PX) / 3 - EDITOR_CHROME_PX);
    assert.strictEqual(MIN_WIDTH_PX, 120);
    assert.strictEqual(estimateWidthPx(800, 0.25), MIN_WIDTH_PX, 'a tiny window still gets room for cats');
    assert.strictEqual(estimateWidthPx(1440, NaN), estimateWidthPx(1440, 1), 'bad input counts as one column');
    assert.strictEqual(estimateWidthPx(1440, 3), estimateWidthPx(1440, 1), 'shares above one are clamped');
  });

  it('is smaller for narrower columns and errs on the small side', () => {
    const w = [1, 0.5, 0.25].map((f) => estimateWidthPx(1600, f));
    assert.ok(w[0] > w[1] && w[1] > w[2]);
    // A typical 1440px laptop with one editor: the text area is about 940px; the estimate stays below it.
    assert.ok(estimateWidthPx(1440, 1) < 940);
    // Two editors: each text area is about 350px at least; the estimate is below that too.
    assert.ok(estimateWidthPx(1440, 0.5) < 350);
  });

  it('writes the same maths as CSS: min(100%, max(floor, calc on 100vw))', () => {
    const est = (f: number): string => `max(120px, calc((100vw - 560px) * ${f} - 180px))`;
    assert.strictEqual(widthCapCss(1, 500), `min(100%, max(${est(1)}, calc((${est(1)} - 500px) * 1000000)))`);
    assert.strictEqual(widthCapCss(0.5, 0), `min(100%, max(${est(0.5)}, calc((${est(0.5)} - 0px) * 1000000)))`);
    assert.strictEqual(widthCapCss(1 / 3, 880), `min(100%, max(${est(0.333)}, calc((${est(0.333)} - 880px) * 1000000)))`);
    assert.strictEqual(widthCapCss(NaN), widthCapCss(1));
    assert.strictEqual(widthCapCss(-1), widthCapCss(1));
  });

  it('reads column width shares from the editor layout tree', () => {
    assert.deepStrictEqual(columnFractions(undefined), []);
    assert.deepStrictEqual(columnFractions({ orientation: 0, groups: [{}] }), [1]);
    assert.deepStrictEqual(columnFractions({ orientation: 0, groups: [{ size: 0.5 }, { size: 0.5 }] }), [0.5, 0.5]);
    assert.deepStrictEqual(columnFractions({ orientation: 0, groups: [{ size: 1 }, { size: 3 }] }), [0.25, 0.75]);
    assert.deepStrictEqual(columnFractions({ orientation: 0, groups: [{}, {}, {}] }).map((f) => Math.round(f * 100)), [33, 33, 33]);
    // Stacked groups (orientation 1) keep the full width; a nested level alternates the direction.
    assert.deepStrictEqual(columnFractions({ orientation: 1, groups: [{ size: 0.5 }, { size: 0.5 }] }), [1, 1]);
    assert.deepStrictEqual(
      columnFractions({
        orientation: 0,
        groups: [
          { size: 0.5, groups: [{ size: 0.5 }, { size: 0.5 }] },
          { size: 0.5 }
        ]
      }),
      [0.5, 0.5, 0.5],
      'left column split into two rows keeps half the width each'
    );
    assert.deepStrictEqual(
      columnFractions({ orientation: 1, groups: [{ size: 0.5, groups: [{ size: 0.4 }, { size: 0.6 }] }, { size: 0.5 }] }),
      [0.4, 0.6, 1]
    );
  });

  it('maps a view column to its share, with an even-split fallback', () => {
    assert.strictEqual(widthFractionFor([0.25, 0.75], 2, 2), 0.75);
    assert.strictEqual(widthFractionFor([0.25, 0.75], 1, 2), 0.25);
    assert.strictEqual(widthFractionFor([], 1, 4), 0.25, 'no layout known: split evenly over the visible editors');
    assert.strictEqual(widthFractionFor([0.5, 0.5], undefined, 2), 0.5);
    assert.strictEqual(widthFractionFor([0.5, 0.5], 9, 2), 0.5, 'unknown column');
    assert.strictEqual(widthFractionFor([], undefined, 0), 1);
  });
});

describe('widest line and the decision to cap', () => {
  it('measures a character from the font size and letter spacing', () => {
    assert.strictEqual(charWidthPx(14), 8.4);
    assert.ok(Math.abs(charWidthPx(12, 0.5) - 7.7) < 1e-9);
    assert.strictEqual(charWidthPx(NaN), 8.4, 'bad size falls back to 14px');
    assert.ok(charWidthPx(0.1, -5) >= 1);
  });

  it('expands tabs to the next tab stop', () => {
    assert.strictEqual(lineColumns('abc', 4), 3);
    assert.strictEqual(lineColumns('\tx', 4), 5);
    assert.strictEqual(lineColumns('ab\tx', 4), 5, 'a tab after two characters reaches column 4');
    assert.strictEqual(lineColumns('abcd\tx', 4), 9);
    assert.strictEqual(lineColumns('\t\t\tx', 2), 7);
    assert.strictEqual(lineColumns('\tx', 8), 9);
    assert.strictEqual(lineColumns('\tx', 0), 5, 'bad tab size counts as 4');
  });

  it('finds the widest line of a document, counting tabs at their expanded width', () => {
    assert.strictEqual(widestColumns([], 4), 0);
    assert.strictEqual(widestColumns(['a', 'abcdef', 'xyz'], 4), 6);
    assert.strictEqual(widestColumns(['abcdef', '\t\tx'], 4), 9, 'two tabs and a character beat six plain characters');
    assert.strictEqual(widestColumns(['\tab', 'abcdefghij'], 8), 10);
    assert.strictEqual(widestColumns(['\t\t\tab', 'abcdefghij'], 8), 26);
  });

  it('turns columns into the width Monaco gives the layer, rounded up to a bucket', () => {
    const cw = charWidthPx(14);
    assert.strictEqual(widestLinePx(0, cw) % WIDEST_BUCKET_PX, 0);
    assert.ok(widestLinePx(100, cw) >= (100 + SCROLL_BEYOND_COLUMNS) * cw);
    assert.ok(widestLinePx(100, cw) < (100 + SCROLL_BEYOND_COLUMNS) * cw + WIDEST_BUCKET_PX);
    assert.strictEqual(widestLinePx(20, cw), widestLinePx(21, cw), 'typing one more character usually keeps the bucket');
    assert.ok(widestLinePx(10, cw) < widestLinePx(200, cw));
    assert.strictEqual(widestLinePx(-5, cw), widestLinePx(0, cw));
  });

  it('only ever grows during a break: Monaco never shrinks its layer, so deleting the wide line must not uncap', () => {
    assert.strictEqual(holdPeak(undefined, 200), 200);
    assert.strictEqual(holdPeak(200, 3800), 3800, 'a long line was typed');
    assert.strictEqual(holdPeak(3800, 200), 3800, 'it was undone: the peak stays');
    assert.strictEqual(holdPeak(3800, 3800), 3800);
    assert.strictEqual(holdPeak(3800, 4000), 4000);
    // The decision keeps the cap after the undo: the widest line is still the peak.
    const peaks = [200, 3800, 200, 120].reduce<number[]>((acc, w) => [...acc, holdPeak(acc[acc.length - 1], w)], []);
    assert.deepStrictEqual(peaks, [200, 3800, 3800, 3800]);
    assert.ok(peaks.every((p, i) => i === 0 || p >= peaks[i - 1]));
    assert.strictEqual(shouldCap(peaks[3], 1440, 1), true);
  });

  it('caps only when the widest line is wider than the estimated visible width', () => {
    const vw = 1440;
    const est1 = estimateWidthPx(vw, 1);
    assert.strictEqual(shouldCap(est1 - 1, vw, 1), false);
    assert.strictEqual(shouldCap(est1, vw, 1), false);
    assert.strictEqual(shouldCap(est1 + 1, vw, 1), true);
    assert.strictEqual(shouldCap(200, vw, 1), false, 'short lines: never capped, whatever the sidebar state');
    assert.strictEqual(shouldCap(600, vw, 1), false);
    assert.strictEqual(shouldCap(600, vw, 0.5), true, 'the same line fits one wide editor but overflows a narrow split');
  });

  it('gives the plain scroll width when nothing overflows and the estimate when something does', () => {
    assert.strictEqual(overlayWidthPx(1026, 120, 1440, 1), 1026, 'short lines, sidebar hidden: the whole 1026px text area');
    assert.strictEqual(overlayWidthPx(916, 920, 1440, 0.5), estimateWidthPx(1440, 0.5), 'a long line in a narrow split');
    assert.strictEqual(overlayWidthPx(100, 920, 1440, 1), 100, 'the estimate never makes the overlay wider than the layer');
  });

  it('the CSS computes exactly what the functions say (evaluated numerically)', () => {
    const evalCss = (css: string, scrollWidth: number, vw: number): number => {
      const js = css
        .replace(/min\(/g, 'Math.min(')
        .replace(/max\(/g, 'Math.max(')
        .replace(/calc\(/g, '(')
        .replace(/100vw/g, String(vw))
        .replace(/100%/g, String(scrollWidth))
        .replace(/(\d+(?:\.\d+)?)px/g, '$1');
      return new Function(`return ${js}`)() as number;
    };
    for (const vw of [800, 1000, 1440, 1920, 2560]) {
      for (const f of [1, 0.5, 0.333, 0.25]) {
        for (const widest of [40, 200, 600, 900, 1500]) {
          for (const scroll of [Math.max(widest, 300), 1026, 150]) {
            const fromCss = evalCss(widthCapCss(f, widest), scroll, vw);
            const expected = overlayWidthPx(scroll, widest, vw, f);
            assert.ok(Math.abs(fromCss - expected) < 0.01, `vw ${vw} f ${f} widest ${widest} scroll ${scroll}: css ${fromCss} vs ${expected}`);
          }
        }
      }
    }
  });
});

describe('break notification', () => {
  const base = (over: Partial<SharedState>): SharedState => ({ ...freshState(1000), ...over });

  it('has the exact texts', () => {
    assert.strictEqual(NOTICE_MESSAGE, 'Time for a break 🐱');
    assert.strictEqual(NOTICE_BUTTON, 'I took a break ⏸');
  });

  it('the status bar reads like the notification button during a break', () => {
    assert.strictEqual(BREAK_STATUS_TEXT, `🐱 ${NOTICE_BUTTON}`);
    assert.strictEqual(formatStatusText(base({ breakActive: true }), 50 * 60000), BREAK_STATUS_TEXT);
    assert.strictEqual(formatStatusText(base({ breakActive: false, activeMs: 8 * 60000 }), 50 * 60000), '🐱 42m');
  });

  it('a result pauses only the break it was shown for', () => {
    assert.strictEqual(shouldPauseForNotice(3, base({ breakActive: true, breakId: 3 })), true);
  });

  it('is ignored once that break is over', () => {
    assert.strictEqual(shouldPauseForNotice(3, base({ breakActive: false, breakId: 3, activeMs: 5000 })), false);
  });

  it('is ignored when a newer break is running', () => {
    assert.strictEqual(shouldPauseForNotice(3, base({ breakActive: true, breakId: 4 })), false);
  });

  it('is ignored for any other mismatch', () => {
    assert.strictEqual(shouldPauseForNotice(3, base({ breakActive: false, breakId: 7 })), false);
    assert.strictEqual(shouldPauseForNotice(0, base({ breakActive: true, breakId: 1 })), false);
  });
});
