import * as assert from 'assert';
import {
  catsPerEditor,
  computeLayout,
  computeLineHeight,
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
    assert.ok(!/(^|;\s*)width:/.test(bottom) && !/left:|right:/.test(bottom), 'the width is the editor\'s own');
    const top = overlayStyle(computeLayout([{ start: 0, end: 3 }], 20)!, 20, 'data:x');
    assert.ok(top.includes('top:0 !important') && !top.includes('bottom:'));
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
