import * as assert from 'assert';
import {
  assignStyles,
  CatStyle,
  distributeStyles,
  enabledStyles,
  FALLBACK_STYLE,
  formatStyleList,
  parseStyleList,
  STYLE_NAMES
} from '../../catStyles';

const ALL = [...STYLE_NAMES];
const NO_FIGHTERS = enabledStyles({ fighters: false });
const ONLY_FIGHTERS = enabledStyles({ wanderer: false, climber: false, bouncer: false, yarnChaser: false });
const count = (list: readonly CatStyle[], style: CatStyle): number => list.filter((s) => s === style).length;

describe('cat styles', () => {
  it('has the five styles in the fixed order', () => {
    assert.deepStrictEqual(ALL, ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters']);
  });

  describe('enabledStyles (the meowter.styles setting)', () => {
    it('enables everything by default and for a missing or odd setting', () => {
      assert.deepStrictEqual(enabledStyles(undefined), ALL);
      assert.deepStrictEqual(enabledStyles(null), ALL);
      assert.deepStrictEqual(enabledStyles('climber'), ALL);
      assert.deepStrictEqual(enabledStyles([false, false]), ALL);
      assert.deepStrictEqual(enabledStyles({}), ALL);
      assert.deepStrictEqual(enabledStyles({ wanderer: true, climber: true, bouncer: true, yarnChaser: true, fighters: true }), ALL);
    });
    it('a setting saved before Fighters existed keeps Fighters on', () => {
      assert.deepStrictEqual(enabledStyles({ wanderer: true, climber: false, bouncer: true, yarnChaser: true }), ['wanderer', 'bouncer', 'yarnChaser', 'fighters']);
    });
    it('drops styles set to false, keeping the fixed order', () => {
      assert.deepStrictEqual(enabledStyles({ climber: false }), ['wanderer', 'bouncer', 'yarnChaser', 'fighters']);
      assert.deepStrictEqual(enabledStyles({ wanderer: false, yarnChaser: false }), ['climber', 'bouncer', 'fighters']);
    });
    it('only a real false disables a style; a missing or non-boolean value keeps the default', () => {
      assert.deepStrictEqual(enabledStyles({ wanderer: 0, climber: 'no', bouncer: null }), ALL);
      assert.deepStrictEqual(enabledStyles({ unknownStyle: false }), ALL);
    });
    it('falls back to the Wanderer when every style is switched off', () => {
      assert.deepStrictEqual(enabledStyles({ wanderer: false, climber: false, bouncer: false, yarnChaser: false, fighters: false }), [FALLBACK_STYLE]);
      assert.strictEqual(FALLBACK_STYLE, 'wanderer');
    });
  });

  describe('assignStyles (round-robin, Fighters in pairs)', () => {
    it('six cats (the default) are one of each style: four singles and a fighting pair', () => {
      assert.deepStrictEqual(assignStyles(6), ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters', 'fighters']);
    });
    it('deals the cats out in the fixed style order, Fighters taking two at a time', () => {
      assert.deepStrictEqual(assignStyles(8), ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters', 'fighters', 'wanderer', 'climber']);
      assert.deepStrictEqual(assignStyles(12), [
        'wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters', 'fighters',
        'wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters', 'fighters'
      ]);
    });
    it('gives a count smaller than the number of styles one of each, first styles first', () => {
      assert.deepStrictEqual(assignStyles(1), ['wanderer']);
      assert.deepStrictEqual(assignStyles(2), ['wanderer', 'climber']);
      assert.deepStrictEqual(assignStyles(3), ['wanderer', 'climber', 'bouncer']);
      assert.deepStrictEqual(assignStyles(4), ['wanderer', 'climber', 'bouncer', 'yarnChaser']);
    });
    it('skips the Fighters when fewer than two cats are left, and the next style takes the cat', () => {
      // 5 cats: w c b y, then the Fighters' turn with one cat left: skipped, the Wanderer takes it.
      assert.deepStrictEqual(assignStyles(5), ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'wanderer']);
      assert.deepStrictEqual(assignStyles(11), [
        'wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters', 'fighters',
        'wanderer', 'climber', 'bouncer', 'yarnChaser', 'wanderer'
      ]);
      // With the Wanderer off the skipped turn goes to the next enabled style.
      assert.deepStrictEqual(assignStyles(2, enabledStyles({ wanderer: false, climber: false, bouncer: false })), ['yarnChaser', 'yarnChaser']);
      assert.deepStrictEqual(assignStyles(3, enabledStyles({ wanderer: false, climber: false, bouncer: false })), ['yarnChaser', 'fighters', 'fighters']);
    });
    it('a pair is always two Fighters side by side; the number of Fighters is always even', () => {
      for (let n = 1; n <= 30; n++) {
        const list = assignStyles(n);
        assert.strictEqual(list.length, n);
        assert.strictEqual(count(list, 'fighters') % 2, 0, `${n} cats`);
        for (let i = 0; i < list.length; i++) {
          if (list[i] === 'fighters') {
            assert.strictEqual(list[i + 1], 'fighters', `pair at ${i} of ${n}`);
            i++;
          }
        }
      }
    });
    it('Fighters only: pairs, and an odd extra cat becomes a Wanderer even though the Wanderer is off', () => {
      assert.deepStrictEqual(assignStyles(2, ONLY_FIGHTERS), ['fighters', 'fighters']);
      assert.deepStrictEqual(assignStyles(4, ONLY_FIGHTERS), ['fighters', 'fighters', 'fighters', 'fighters']);
      assert.deepStrictEqual(assignStyles(3, ONLY_FIGHTERS), ['fighters', 'fighters', 'wanderer']);
      assert.deepStrictEqual(assignStyles(7, ONLY_FIGHTERS), [...Array(6).fill('fighters'), 'wanderer']);
      assert.deepStrictEqual(assignStyles(1, ONLY_FIGHTERS), ['wanderer'], 'a lone cat cannot fight');
    });
    it('skips disabled styles and keeps the order of the enabled ones', () => {
      assert.deepStrictEqual(assignStyles(5, enabledStyles({ climber: false })), ['wanderer', 'bouncer', 'yarnChaser', 'fighters', 'fighters']);
      assert.deepStrictEqual(assignStyles(3, enabledStyles({ wanderer: false, bouncer: false, fighters: false })), ['climber', 'yarnChaser', 'climber']);
      assert.deepStrictEqual(assignStyles(1, enabledStyles({ wanderer: false })), ['climber']);
      assert.deepStrictEqual(assignStyles(6, NO_FIGHTERS), ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'wanderer', 'climber']);
    });
    it('uses only the Wanderer when all styles are disabled', () => {
      const none = enabledStyles({ wanderer: false, climber: false, bouncer: false, yarnChaser: false, fighters: false });
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
    it('shares the cats out evenly: no single style gets more than a round more than another', () => {
      for (const n of [5, 9, 13, 30]) {
        const singles = new Map<CatStyle, number>();
        assignStyles(n, NO_FIGHTERS).forEach((s) => singles.set(s, (singles.get(s) ?? 0) + 1));
        const values = [...singles.values()];
        assert.ok(Math.max(...values) - Math.min(...values) <= 1, `${n} cats: ${JSON.stringify([...singles])}`);
      }
    });
    it('an empty enabled list falls back to the Wanderer', () => {
      assert.deepStrictEqual(assignStyles(2, []), ['wanderer', 'wanderer']);
    });
  });

  describe('distributeStyles (cats over several editors)', () => {
    const flat = (lists: CatStyle[][]): CatStyle[] => lists.flat();
    it('slices the assignment in order when no pair is in the way', () => {
      // 4 cats per editor, 2 editors: w c b y | f f w c
      assert.deepStrictEqual(distributeStyles(assignStyles(8), 4, 2), [
        ['wanderer', 'climber', 'bouncer', 'yarnChaser'],
        ['fighters', 'fighters', 'wanderer', 'climber']
      ]);
      assert.deepStrictEqual(distributeStyles(assignStyles(12), 6, 2), [assignStyles(6), assignStyles(6)]);
    });
    it('never splits a pair across two editors: a single cat from further down takes the slot', () => {
      // 5 per editor, 2 editors: w c b y [f f] w c b y -> the pair does not fit the first editor's last slot.
      const lists = distributeStyles(assignStyles(10), 5, 2);
      assert.deepStrictEqual(lists[0], ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'wanderer']);
      assert.deepStrictEqual(lists[1], ['fighters', 'fighters', 'climber', 'bouncer', 'yarnChaser']);
      for (const list of lists) assert.strictEqual(list.length, 5);
      assert.deepStrictEqual(flat(lists).sort(), assignStyles(10).sort(), 'the same cats, only the order moved');
    });
    it('every editor gets a whole number of pairs and exactly its share of cats', () => {
      for (let editors = 1; editors <= 4; editors++) {
        for (let per = 1; per <= 8; per++) {
          const total = per * editors;
          if (total > 16) continue;
          const lists = distributeStyles(assignStyles(total), per, editors);
          assert.strictEqual(lists.length, editors);
          for (const list of lists) {
            assert.strictEqual(list.length, per, `${editors} editors x ${per}`);
            assert.strictEqual(count(list, 'fighters') % 2, 0, `no pair is split (${editors} x ${per}: ${list})`);
          }
          assert.strictEqual(flat(lists).filter((s) => s === 'fighters').length % 2, 0);
        }
      }
    });
    it('Fighters only: a pair that does not fit leaves a Wanderer in the spare slot', () => {
      const lists = distributeStyles(assignStyles(6, ONLY_FIGHTERS), 3, 2);
      assert.deepStrictEqual(lists, [
        ['fighters', 'fighters', 'wanderer'],
        ['fighters', 'fighters', 'wanderer']
      ]);
    });
    it('an editor with room for one cat never gets a Fighter', () => {
      const lists = distributeStyles(assignStyles(4, ONLY_FIGHTERS), 1, 4);
      assert.ok(flat(lists).every((s) => s === 'wanderer'));
    });
    it('a lone Fighter (which assignStyles never makes) is treated as a Wanderer', () => {
      assert.deepStrictEqual(distributeStyles(['fighters', 'climber'], 2, 1), [['wanderer', 'climber']]);
    });
  });

  describe('handing the styles to the webview', () => {
    it('round-trips a style list', () => {
      assert.strictEqual(formatStyleList(['climber', 'bouncer']), 'climber,bouncer');
      assert.deepStrictEqual(parseStyleList('climber,bouncer'), ['climber', 'bouncer']);
      assert.deepStrictEqual(parseStyleList(' yarnChaser , wanderer '), ['wanderer', 'yarnChaser'], 'fixed order');
      assert.deepStrictEqual(parseStyleList('fighters,climber'), ['climber', 'fighters']);
    });
    it('ignores unknown names and means all styles when nothing valid is given', () => {
      assert.deepStrictEqual(parseStyleList('nonsense,climber'), ['climber']);
      assert.deepStrictEqual(parseStyleList(''), ALL);
      assert.deepStrictEqual(parseStyleList(undefined), ALL);
      assert.deepStrictEqual(parseStyleList('nonsense'), ALL);
    });
  });
});
