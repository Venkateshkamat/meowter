import * as assert from 'assert';
import { assignStyles, CatStyle, enabledStyles, FALLBACK_STYLE, formatStyleList, parseStyleList, STYLE_NAMES } from '../../catStyles';

describe('cat styles', () => {
  describe('enabledStyles (the meowter.styles setting)', () => {
    it('enables everything by default and for a missing or odd setting', () => {
      const all = [...STYLE_NAMES];
      assert.deepStrictEqual(enabledStyles(undefined), all);
      assert.deepStrictEqual(enabledStyles(null), all);
      assert.deepStrictEqual(enabledStyles('climber'), all);
      assert.deepStrictEqual(enabledStyles([false, false]), all);
      assert.deepStrictEqual(enabledStyles({}), all);
      assert.deepStrictEqual(enabledStyles({ wanderer: true, climber: true, bouncer: true, yarnChaser: true }), all);
    });
    it('drops styles set to false, keeping the fixed order', () => {
      assert.deepStrictEqual(enabledStyles({ climber: false }), ['wanderer', 'bouncer', 'yarnChaser']);
      assert.deepStrictEqual(enabledStyles({ wanderer: false, yarnChaser: false }), ['climber', 'bouncer']);
    });
    it('only a real false disables a style; a missing or non-boolean value keeps the default', () => {
      assert.deepStrictEqual(enabledStyles({ wanderer: 0, climber: 'no', bouncer: null }), [...STYLE_NAMES]);
      assert.deepStrictEqual(enabledStyles({ unknownStyle: false }), [...STYLE_NAMES]);
    });
    it('falls back to the Wanderer when every style is switched off', () => {
      assert.deepStrictEqual(enabledStyles({ wanderer: false, climber: false, bouncer: false, yarnChaser: false }), [FALLBACK_STYLE]);
      assert.strictEqual(FALLBACK_STYLE, 'wanderer');
    });
  });

  describe('assignStyles (round-robin)', () => {
    it('deals the cats out in the fixed style order', () => {
      assert.deepStrictEqual(assignStyles(8), [
        'wanderer', 'climber', 'bouncer', 'yarnChaser',
        'wanderer', 'climber', 'bouncer', 'yarnChaser'
      ]);
      assert.deepStrictEqual(assignStyles(6, ['wanderer', 'climber', 'bouncer', 'yarnChaser']).slice(4), ['wanderer', 'climber']);
    });
    it('gives a count smaller than the number of styles one of each, first styles first', () => {
      assert.deepStrictEqual(assignStyles(1), ['wanderer']);
      assert.deepStrictEqual(assignStyles(2), ['wanderer', 'climber']);
      assert.deepStrictEqual(assignStyles(3), ['wanderer', 'climber', 'bouncer']);
      assert.deepStrictEqual(assignStyles(4), [...STYLE_NAMES]);
    });
    it('skips disabled styles and keeps the order of the enabled ones', () => {
      assert.deepStrictEqual(assignStyles(5, enabledStyles({ climber: false })), ['wanderer', 'bouncer', 'yarnChaser', 'wanderer', 'bouncer']);
      assert.deepStrictEqual(assignStyles(3, enabledStyles({ wanderer: false, bouncer: false })), ['climber', 'yarnChaser', 'climber']);
      assert.deepStrictEqual(assignStyles(1, enabledStyles({ wanderer: false })), ['climber']);
    });
    it('uses only the Wanderer when all styles are disabled', () => {
      const none = enabledStyles({ wanderer: false, climber: false, bouncer: false, yarnChaser: false });
      assert.deepStrictEqual(assignStyles(5, none), Array(5).fill('wanderer'));
    });
    it('keeps the total: the list is as long as the count, at least one', () => {
      for (const n of [1, 2, 3, 7, 8, 16, 30]) {
        assert.strictEqual(assignStyles(n).length, n);
      }
      assert.strictEqual(assignStyles(0).length, 1);
      assert.strictEqual(assignStyles(-3).length, 1);
      assert.strictEqual(assignStyles(NaN).length, 1);
      assert.strictEqual(assignStyles(3.9).length, 3);
    });
    it('shares the cats out evenly: no style gets more than one cat over any other', () => {
      for (const n of [5, 9, 13, 30]) {
        const counts = new Map<CatStyle, number>();
        assignStyles(n).forEach((s) => counts.set(s, (counts.get(s) ?? 0) + 1));
        const values = [...counts.values()];
        assert.ok(Math.max(...values) - Math.min(...values) <= 1, `${n} cats: ${JSON.stringify([...counts])}`);
      }
    });
    it('an empty enabled list falls back to the Wanderer', () => {
      assert.deepStrictEqual(assignStyles(2, []), ['wanderer', 'wanderer']);
    });
  });

  describe('handing the styles to the webview', () => {
    it('round-trips a style list', () => {
      assert.strictEqual(formatStyleList(['climber', 'bouncer']), 'climber,bouncer');
      assert.deepStrictEqual(parseStyleList('climber,bouncer'), ['climber', 'bouncer']);
      assert.deepStrictEqual(parseStyleList(' yarnChaser , wanderer '), ['wanderer', 'yarnChaser'], 'fixed order');
    });
    it('ignores unknown names and means all styles when nothing valid is given', () => {
      assert.deepStrictEqual(parseStyleList('fighters,climber'), ['climber']);
      assert.deepStrictEqual(parseStyleList(''), [...STYLE_NAMES]);
      assert.deepStrictEqual(parseStyleList(undefined), [...STYLE_NAMES]);
      assert.deepStrictEqual(parseStyleList('nonsense'), [...STYLE_NAMES]);
    });
  });
});
