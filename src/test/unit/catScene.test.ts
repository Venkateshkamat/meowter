import * as assert from 'assert';
import { assignStyles, CatStyle, enabledStyles, pairBand, STYLE_NAMES } from '../../catStyles';
import { ANIMATIONS, CONTENT_MAX_COL, CONTENT_MIN_COL, COATS, FEET_ROWS, FRAME_SIZE, frameNames, SCENE_TICK_HZ } from '../../catArt';
import { buildSceneSvg, CatPlan, FIGHT_ROLL_SPEED, HOP_MAX_ROWS, MAX_ARC_SPEED, planPair, SPEED, cellTimeline, cycleTicks, mulberry32, planCat, planCells, planScene, positionAt, sceneDataUri, sceneMetrics, stepKeys } from '../../catScene';

function checkXml(rawXml: string): Map<string, number> {
  const xml = rawXml.replace(/<style>[^<]*<\/style>/g, '<style></style>');
  const tagRe = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  const tags = new Map<string, number>();
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    assert.strictEqual(xml.slice(pos, m.index).trim(), '', `text outside tags at ${pos}`);
    pos = tagRe.lastIndex;
    const [, closing, name, attrs, selfClosing] = m;
    if (closing) {
      assert.strictEqual(stack.pop(), name);
      continue;
    }
    const seen = new Set<string>();
    for (const a of attrs.matchAll(/([\w:-]+)="/g)) {
      assert.ok(!seen.has(a[1]), `duplicate attribute ${a[1]}`);
      seen.add(a[1]);
    }
    tags.set(name, (tags.get(name) ?? 0) + 1);
    if (!selfClosing) stack.push(name);
  }
  assert.deepStrictEqual(stack, []);
  return tags;
}

const BASE = { scale: 4, heightPx: 480 };

function checkPlan(plan: CatPlan, scale: number, heightPx: number): void {
  assert.ok(plan.duration > 10, 'a cycle is a good while long');
  assert.ok(plan.keys.length >= 2 && plan.segs.length >= 2);
  // Keyframes: ascending time from 0 to the full duration, positions in range, never underground.
  assert.strictEqual(plan.keys[0].t, 0);
  assert.ok(Math.abs(plan.keys[plan.keys.length - 1].t - plan.duration) < 1e-6);
  for (let i = 0; i < plan.keys.length; i++) {
    const k = plan.keys[i];
    assert.ok(k.p >= -1e-9 && k.p <= 1 + 1e-9, `p ${k.p}`);
    assert.ok(k.y >= -1e-9, `y ${k.y}`);
    assert.ok(k.y <= heightPx, `y ${k.y} fits the overlay`);
    if (i > 0) assert.ok(k.t >= plan.keys[i - 1].t, 'time is monotonic');
  }
  // Segments tile the cycle without gaps.
  assert.strictEqual(plan.segs[0].t0, 0);
  for (let i = 1; i < plan.segs.length; i++) {
    assert.ok(Math.abs(plan.segs[i].t0 - plan.segs[i - 1].t1) < 1e-6, `gap before segment ${i}`);
  }
  assert.ok(Math.abs(plan.segs[plan.segs.length - 1].t1 - plan.duration) < 1e-6);
  // Seamless loop: it ends where it starts, on the floor.
  assert.ok(Math.abs(plan.keys[0].p - plan.keys[plan.keys.length - 1].p) < 1e-6, 'returns to the start position');
  assert.strictEqual(plan.keys[plan.keys.length - 1].y, 0);
  assert.strictEqual(plan.segs[0].flip, plan.segs[plan.segs.length - 1].flip, 'same facing at the loop point');
  void scale;
}

describe('catScene planning', () => {
  it('is deterministic for a seed and varies between seeds', () => {
    const a = planScene({ ...BASE, cats: 6, seed: 1 });
    const b = planScene({ ...BASE, cats: 6, seed: 1 });
    const c = planScene({ ...BASE, cats: 6, seed: 2 });
    assert.deepStrictEqual(a, b);
    assert.notDeepStrictEqual(a, c);
  });

  it('plans valid looping cycles for every cat count', () => {
    for (const cats of [1, 2, 3, 8, 16]) {
      const plans = planScene({ ...BASE, cats, seed: 5 + cats });
      assert.strictEqual(plans.length, cats);
      plans.forEach((p) => checkPlan(p, BASE.scale, BASE.heightPx));
      assert.ok(new Set(plans.map((p) => p.coat)).size >= Math.min(cats, COATS.length), 'varied coats');
    }
  });

  it('deals the styles out round-robin and records each plan\'s style (a fighting pair takes two cats)', () => {
    const plans = planScene({ ...BASE, cats: 8, seed: 11 });
    assert.deepStrictEqual(plans.map((p) => p.style), ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters', 'fighters', 'wanderer', 'climber']);
    const two = planScene({ ...BASE, cats: 2, seed: 11 });
    assert.deepStrictEqual(two.map((p) => p.style), ['wanderer', 'climber'], 'a small count gets one of each first');
    const six = planScene({ ...BASE, cats: 6, seed: 11 });
    assert.deepStrictEqual(six.map((p) => p.style), ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters', 'fighters'], 'six cats: one of each');
  });

  it('honours an explicit per-cat style list (disabled styles, all disabled)', () => {
    const plans = planScene({ ...BASE, cats: 99, seed: 2, styles: assignStyles(5, enabledStyles({ climber: false, yarnChaser: false, fighters: false })) });
    assert.deepStrictEqual(plans.map((p) => p.style), ['wanderer', 'bouncer', 'wanderer', 'bouncer', 'wanderer']);
    const fallback = planScene({ ...BASE, cats: 3, seed: 2, styles: assignStyles(3, enabledStyles({ wanderer: false, climber: false, bouncer: false, yarnChaser: false, fighters: false })) });
    assert.ok(fallback.every((p) => p.style === 'wanderer'));
    fallback.forEach((p) => checkPlan(p, BASE.scale, BASE.heightPx));
  });

  it('varies coats across cats of every style', () => {
    const plans = planScene({ ...BASE, cats: COATS.length, seed: 4 });
    assert.strictEqual(new Set(plans.map((p) => p.coat)).size, COATS.length);
  });

  it('uses the whole mix of behaviours across many cats: floor, walls, hops, chase, sleep', () => {
    const variants = new Set<string>();
    for (let seed = 1; seed < 30; seed++) {
      for (const p of planScene({ ...BASE, cats: 8, seed })) p.segs.forEach((s) => variants.add(s.variant));
    }
    for (const v of ['walk', 'run', 'sit', 'idle', 'lie', 'sleep', 'swipe', 'jump', 'fall', 'land', 'climb', 'grab', 'chase']) {
      assert.ok(variants.has(v), `no ${v} segment planned`);
    }
  });

  it('wall climbers hug a wall and face it; facing follows the direction of travel', () => {
    for (let seed = 1; seed < 20; seed++) {
      for (const p of planScene({ ...BASE, cats: 8, seed })) {
        p.segs.forEach((seg) => {
          const at = (t: number): number => {
            const i = p.keys.findIndex((k) => k.t >= t - 1e-9);
            return p.keys[Math.max(0, i)].p;
          };
          if (seg.variant === 'climb' || seg.variant === 'grab') {
            const x = at(seg.t0 + 1e-6);
            assert.ok(x === 0 || x === 1, `climbing at the wall (p=${x})`);
            assert.strictEqual(seg.flip, x === 0, 'faces the wall');
          }
          if (p.style !== 'fighters' && (seg.variant === 'walk' || seg.variant === 'run' || seg.variant === 'chase')) {
            const i0 = p.keys.findIndex((k) => Math.abs(k.t - seg.t0) < 1e-9);
            const i1 = p.keys.findIndex((k) => Math.abs(k.t - seg.t1) < 1e-9);
            const dp = p.keys[i1].p - p.keys[i0].p;
            if (Math.abs(dp) > 1e-6) assert.strictEqual(seg.flip, dp < 0, `${seg.variant} faces its direction`);
          }
        });
      }
    }
  });

  it('keeps cats low when there is little room', () => {
    const plans = planScene({ scale: 3, heightPx: 14 * 20, cats: 8, seed: 4 });
    plans.forEach((p) => checkPlan(p, 3, 14 * 20));
  });

  it('planCat honours an explicit target length and style', () => {
    const p = planCat(mulberry32(9), { ...BASE, style: 'bouncer', coat: 2, target: 20 });
    assert.ok(p.style === 'bouncer' && p.duration >= 20 && p.duration < 60);
    assert.strictEqual(p.coat, 2);
  });
});

describe('catScene stepping and cells', () => {
  const plans = planScene({ ...BASE, cats: 8, seed: 21 });

  it('steps positions on the shared clock and holds equal samples', () => {
    for (const p of plans) {
      const ticks = cycleTicks(p);
      const steps = stepKeys(p.keys, ticks);
      assert.strictEqual(steps[0].t, 0);
      for (let i = 1; i < steps.length; i++) {
        assert.ok(steps[i].t > steps[i - 1].t);
        const tick = steps[i].t * SCENE_TICK_HZ;
        assert.ok(Math.abs(tick - Math.round(tick)) < 1e-9, 'on the clock');
        assert.ok(steps[i].p !== steps[i - 1].p || steps[i].y !== steps[i - 1].y || (steps[i].dx ?? 0) !== (steps[i - 1].dx ?? 0), 'no duplicate samples');
      }
      assert.ok(steps[steps.length - 1].t < ticks / SCENE_TICK_HZ);
      const mid = positionAt(p.keys, p.duration / 2);
      assert.ok(mid.p >= 0 && mid.p <= 1);
    }
  });

  it('shows one valid cell per tick, with animation frames advancing at their frame rate', () => {
    const names = new Set(frameNames());
    for (const p of plans) {
      const tl = cellTimeline(p);
      assert.strictEqual(tl.length, cycleTicks(p));
      for (const c of tl) assert.ok(names.has(c.name) || /^chase[0-3]$/.test(c.name), c.name);
    }
    // A walking cat steps through its walk frames (4 fps on an 8 Hz clock = a new frame every 2 ticks).
    // (A walk that starts between two ticks rounds down for its frame count and would show the previous pose first.)
    const startsOnTick = (s: { variant: string; t0: number }): boolean =>
      s.variant === 'walk' && Math.round(s.t0 * SCENE_TICK_HZ) >= Math.ceil(s.t0 * SCENE_TICK_HZ - 1e-9);
    const walker = plans.find((p) => p.segs.some(startsOnTick));
    assert.ok(walker);
    const seg = walker.segs.find(startsOnTick)!;
    const tl = cellTimeline(walker);
    const t0 = Math.round(seg.t0 * SCENE_TICK_HZ);
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) => tl[t0 + i].name),
      ['walk0', 'walk0', 'walk1', 'walk1', 'walk2', 'walk2', 'walk3', 'walk3']
    );
    // Facing follows the segment.
    for (const p of plans) {
      cellTimeline(p).forEach((c, i) => {
        const seg2 = p.segs.find((s) => i / SCENE_TICK_HZ >= s.t0 - 1e-9 && i / SCENE_TICK_HZ < s.t1 - 1e-9);
        if (seg2) assert.strictEqual(c.flip, seg2.flip);
      });
    }
  });

  it('collects exactly the cells the plans use', () => {
    const cells = planCells(plans);
    const used = new Set<string>();
    plans.forEach((p) => cellTimeline(p).forEach((c) => used.add(c.name)));
    assert.deepStrictEqual([...cells].sort(), [...used].sort());
    assert.ok(cells.size >= 8);
  });
});

describe('catScene SVG', () => {
  const plans = planScene({ ...BASE, cats: 8, seed: 21 });
  const svg = buildSceneSvg(plans, BASE.scale);

  it('is a valid, percent-sized SVG with no scripts or external references', () => {
    const tags = checkXml(svg);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"'));
    assert.ok(!/<script|<image|<foreignObject|onload=|javascript:/i.test(svg));
    assert.ok(!svg.replace('xmlns="http://www.w3.org/2000/svg"', '').includes('http'));
    assert.ok(!/<rect[^>]*width="100%"/.test(svg), 'no background');
    assert.strictEqual(tags.get('svg'), 1 + plans.length, 'one window per cat');
    for (const m of svg.matchAll(/href="#([^"]+)"/g)) {
      assert.ok(svg.includes(`id="${m[1]}"`), `missing definition ${m[1]}`);
    }
  });

  it('animates with CSS only, exactly two animations per cat (position and frame strip)', () => {
    assert.ok(!/<animate/.test(svg), 'no SMIL');
    const rules = [...svg.matchAll(/\.([mf])(\d+)\{animation:([mf]\d+) ([\d.]+)s step-end (-?[\d.]+)s infinite\}/g)];
    assert.strictEqual(rules.length, plans.length * 2);
    for (const r of rules) assert.strictEqual(`${r[1]}${r[2]}`, r[3]);
    plans.forEach((p, i) => {
      for (const kind of ['m', 'f']) {
        const kf = new RegExp(`@keyframes ${kind}${i}\\{(.*?)\\}(?=\\.${kind}${i}\\{|@|<)`).exec(svg);
        assert.ok(kf, `keyframes ${kind}${i}`);
        const offsets = [...kf[1].matchAll(/([\d.]+)%\{/g)].map((m) => parseFloat(m[1]));
        assert.strictEqual(offsets[0], 0, 'starts at 0%');
        offsets.forEach((o, j) => j > 0 && assert.ok(o > offsets[j - 1] && o < 100, 'ascending'));
        const D = cycleTicks(p) / SCENE_TICK_HZ;
        offsets.forEach((o) => {
          const tick = (o / 100) * D * SCENE_TICK_HZ;
          assert.ok(Math.abs(tick - Math.round(tick)) < 0.01, `${kind}${i} change at ${o}% is on the 12 Hz clock`);
        });
      }
    });
  });

  it('positions cats by percent plus a pixel correction so walls are touched exactly', () => {
    const { c0, span } = sceneMetrics(BASE.scale);
    assert.strictEqual(c0, CONTENT_MIN_COL * BASE.scale);
    assert.strictEqual(span, (CONTENT_MAX_COL + 1 - CONTENT_MIN_COL) * BASE.scale);
    const one = planScene({ ...BASE, cats: 1, seed: 8 });
    const s = buildSceneSvg(one, BASE.scale);
    const kf = /@keyframes m0\{(.*?)\}\.m0\{/.exec(s)![1];
    const steps = stepKeys(one[0].keys, cycleTicks(one[0]));
    const frames = [...kf.matchAll(/\{transform:translate\(calc\(([\d.-]+)% - ([\d.-]+)px\),calc\(100% - ([\d.-]+)px\)\)\}/g)];
    assert.strictEqual(frames.length, steps.length);
    steps.forEach((k, i) => {
      assert.ok(Math.abs(parseFloat(frames[i][1]) - k.p * 100) < 0.01);
      assert.ok(Math.abs(parseFloat(frames[i][2]) - (c0 + k.p * span)) < 0.01);
      assert.ok(Math.abs(parseFloat(frames[i][3]) - (k.y + FEET_ROWS * BASE.scale)) < 0.01);
    });
  });

  it('the strip window shows exactly one cell: window size, one column per distinct cell and facing', () => {
    const box = FRAME_SIZE * BASE.scale;
    assert.ok(svg.includes(`<svg width="${box}" height="${box}" style="--`));
    plans.forEach((p, i) => {
      const cols = new Set(cellTimeline(p).map((c) => `${c.name}|${c.flip}`));
      const kf = new RegExp(`@keyframes f${i}\\{(.*?)\\}(?=\\.f${i}\\{)`).exec(svg)!;
      const shifts = [...kf[1].matchAll(/translate\((-?[\d.]+)px,0\)/g)].map((m) => Math.round(-parseFloat(m[1]) / box));
      assert.ok(shifts.every((c) => c >= 0 && c < cols.size), 'offsets address real columns');
      assert.strictEqual(new Set(shifts).size, cols.size, 'every column is shown at some point');
    });
  });

  it('cats start mid-cycle (negative delay on the clock) so they do not all pose alike', () => {
    const delays = [...svg.matchAll(/step-end (-[\d.]+)s infinite/g)].map((m) => m[1]);
    assert.ok(new Set(delays).size >= plans.length - 1);
    for (const d of delays) {
      const tick = Math.abs(parseFloat(d)) * SCENE_TICK_HZ;
      assert.ok(Math.abs(tick - Math.round(tick)) < 0.01, 'delay on the clock');
    }
  });

  it('stays a reasonable size for a decoration', () => {
    assert.ok(svg.length < 260000, `scene is ${svg.length} bytes`);
    const uri = sceneDataUri(plans, BASE.scale);
    assert.ok(uri.startsWith('data:image/svg+xml;charset=utf-8,'));
    assert.ok(!/["\\;{}<>]/.test(uri.slice(uri.indexOf(',') + 1)));
    assert.ok(uri.length < 420000, `data uri is ${uri.length} bytes`);
  });
});

describe('movement styles (over-code scene)', () => {
  const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
  const plansOf = (style: CatStyle, seeds = SEEDS): CatPlan[] =>
    seeds.map((seed) => planCat(mulberry32(seed), { ...BASE, style, coat: seed % COATS.length }));
  const variantsOf = (plans: CatPlan[]): Set<string> => new Set(plans.flatMap((p) => p.segs.map((s) => s.variant)));
  const maxYOf = (p: CatPlan): number => Math.max(...p.keys.map((k) => k.y));
  const topRoom = BASE.heightPx - 24 * BASE.scale;

  it('every single-cat style plans valid, seamless looping cycles (also in a low box)', () => {
    for (const style of STYLE_NAMES.filter((n) => n !== 'fighters')) {
      plansOf(style).forEach((p) => {
        assert.strictEqual(p.style, style);
        checkPlan(p, BASE.scale, BASE.heightPx);
      });
      for (const seed of [1, 2, 3]) checkPlan(planCat(mulberry32(seed), { scale: 3, heightPx: 14 * 20, style, coat: 0 }), 3, 14 * 20);
    }
  });

  it('wanderer: walks, runs, sits, idles, lies, sleeps, swipes and hops, and stays on the floor', () => {
    const plans = plansOf('wanderer');
    const v = variantsOf(plans);
    for (const want of ['walk', 'run', 'sit', 'idle', 'lie', 'sleep', 'swipe', 'jump', 'fall', 'land']) {
      assert.ok(v.has(want), `a wanderer ${want}s`);
    }
    for (const never of ['climb', 'grab', 'chase']) assert.ok(!v.has(never), `a wanderer never uses ${never}`);
    for (const p of plans) {
      assert.ok(maxYOf(p) <= HOP_MAX_ROWS * BASE.scale + 1, `only hops leave the floor (${maxYOf(p)})`);
      assert.ok(p.keys.every((k) => k.p > 0 && k.p < 1) , 'never goes to a wall');
    }
  });

  it('climber: runs to a wall, climbs, hangs, comes down or drops, with floor moves in between', () => {
    const plans = plansOf('climber');
    for (const p of plans) {
      const kinds = p.segs.map((s) => s.variant);
      assert.ok(kinds.includes('climb') && kinds.includes('grab'), 'every climber climbs and hangs');
      assert.ok(maxYOf(p) > 0.2 * topRoom, `reaches up the wall (${maxYOf(p)})`);
      p.segs.forEach((seg) => {
        if (seg.variant === 'climb' || seg.variant === 'grab') {
          const key = p.keys.find((k) => k.t >= seg.t0 - 1e-9)!;
          assert.ok(key.p === 0 || key.p === 1, 'on a side wall');
          assert.strictEqual(seg.flip, key.p === 0, 'faces the wall');
        }
      });
    }
    const v = variantsOf(plans);
    for (const want of ['walk', 'run', 'fall', 'land']) assert.ok(v.has(want), `climbers also ${want}`);
    assert.ok(plans.some((p) => p.segs.filter((s) => s.variant === 'climb').length >= 3), 'some climbs have several stages');
    assert.ok(plans.some((p) => p.segs.some((s) => s.variant === 'fall' && s.t1 - s.t0 > 0.3)), 'some climbers drop');
    assert.ok(new Set(plans.map((p) => p.segs.length)).size >= 8, 'climbers do not all follow the same script');
    assert.ok(['sit', 'idle', 'swipe', 'lie'].some((k) => v.has(k)), 'and they rest between climbs');
  });

  it('bouncer: big bouncing arcs across the middle of the screen', () => {
    const plans = plansOf('bouncer');
    for (const p of plans) {
      assert.ok(maxYOf(p) > 0.25 * BASE.heightPx, `reaches the middle (${maxYOf(p)})`);
      assert.ok(p.segs.every((s) => ['jump', 'fall', 'land'].includes(s.variant)), 'only bounces');
      assert.ok(p.segs.filter((s) => s.variant === 'jump').length >= 5, 'bounces again and again');
    }
  });

  it('yarn chaser: chases a ball of yarn along the floor, with short rests', () => {
    const plans = plansOf('yarnChaser');
    for (const p of plans) {
      assert.ok(p.segs.some((s) => s.variant === 'chase'), 'has a ball to chase');
      assert.strictEqual(maxYOf(p), 0, 'stays on the floor');
      const chase = p.segs.filter((s) => s.variant === 'chase');
      assert.ok(chase.length >= 2, 'chases more than once per cycle');
    }
    const v = variantsOf(plans);
    for (const never of ['climb', 'grab', 'jump']) assert.ok(!v.has(never), `a chaser never uses ${never}`);
    assert.ok(['idle', 'sit', 'swipe'].some((k) => v.has(k)), 'rests between chases');
    // Rests are short: no nap longer than a few seconds.
    for (const p of plans) {
      for (const s of p.segs) {
        if (['sit', 'idle', 'swipe', 'lie'].includes(s.variant)) assert.ok(s.t1 - s.t0 <= 3.1 || s === p.segs[0] || s === p.segs[p.segs.length - 1], `short rest (${s.variant} ${s.t1 - s.t0})`);
        assert.notStrictEqual(s.variant, 'sleep');
      }
    }
  });

  it('chasing runs the way the cat faces and in both directions across plans', () => {
    const dirs = new Set<boolean>();
    for (const p of plansOf('yarnChaser')) p.segs.filter((s) => s.variant === 'chase').forEach((s) => dirs.add(s.flip));
    assert.strictEqual(dirs.size, 2);
  });

  /** Horizontal speed of a segment in widths per second (the arc halves 'jump' and 'fall' each cover half of it). */
  const speedOf = (p: CatPlan, seg: CatPlan['segs'][number]): number => {
    const ks = p.keys.filter((k) => k.t >= seg.t0 - 1e-9 && k.t <= seg.t1 + 1e-9);
    return seg.t1 > seg.t0 ? Math.abs(ks[ks.length - 1].p - ks[0].p) / (seg.t1 - seg.t0) : 0;
  };

  it('nothing moves sideways faster than its normal speed, loop closure included (no cross-screen teleport hops)', () => {
    const limit: Record<string, number> = {
      walk: SPEED.walk,
      run: SPEED.run,
      chase: SPEED.chase,
      jump: MAX_ARC_SPEED,
      fall: MAX_ARC_SPEED
    };
    for (const style of STYLE_NAMES.filter((n) => n !== 'fighters')) {
      for (const [scale, heightPx] of [[4, 480], [3, 280], [4, 140]] as const) {
        for (let seed = 1; seed <= 150; seed++) {
          const p = planCat(mulberry32(seed), { scale, heightPx, style, coat: 0 });
          for (const seg of p.segs) {
            const max = limit[seg.variant];
            const v = speedOf(p, seg);
            if (max === undefined) {
              assert.ok(v < 1e-9, `${style} ${seg.variant} stands still`);
            } else {
              assert.ok(v <= max * 1.05, `${style} ${seg.variant} speed ${v.toFixed(3)} > ${max} (seed ${seed}, ${heightPx}px)`);
            }
          }
        }
      }
    }
  });

  it('a bouncer closes its loop with ordinary arcs: the last arcs are not longer than the others', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const p = planCat(mulberry32(seed), { ...BASE, style: 'bouncer', coat: 0 });
      const jumps = p.segs.filter((s) => s.variant === 'jump');
      for (const j of jumps) {
        const ks = p.keys.filter((k) => k.t >= j.t0 - 1e-9);
        const a = ks[0];
        const land = p.keys.find((k) => k.t >= j.t1 + (j.t1 - j.t0) - 1e-9)!; // end of the matching fall
        assert.ok(Math.abs(land.p - a.p) <= 0.16 + 1e-9, `one arc covers ${Math.abs(land.p - a.p).toFixed(3)} of the width (seed ${seed})`);
      }
    }
  });

  it('climbers in one scene spread out over the walls and heights instead of stacking', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const plans = planScene({ ...BASE, cats: 6, seed, styles: Array<CatStyle>(6).fill('climber') });
      const firstClimbs = plans.map((p) => {
        const grab = p.segs.find((s) => s.variant === 'grab')!;
        const k = p.keys.find((key) => key.t >= grab.t0 - 1e-9)!;
        return { wall: k.p, y: k.y };
      });
      assert.deepStrictEqual(new Set(firstClimbs.map((c) => c.wall)), new Set([0, 1]), 'both walls are used');
      for (let i = 0; i < firstClimbs.length; i++) {
        for (let j = i + 1; j < firstClimbs.length; j++) {
          if (firstClimbs[i].wall === firstClimbs[j].wall) {
            assert.ok(Math.abs(firstClimbs[i].y - firstClimbs[j].y) >= 3, `two climbers at the same spot of wall ${firstClimbs[i].wall} (seed ${seed})`);
          }
        }
      }
    }
  });

  it('the scene SVG of each style is valid and animated', () => {
    for (const style of STYLE_NAMES.filter((n) => n !== 'fighters')) {
      const plans = [planCat(mulberry32(3), { ...BASE, style, coat: 0 })];
      const svg = buildSceneSvg(plans, BASE.scale);
      checkXml(svg);
      assert.ok(svg.includes('@keyframes m0'));
    }
  });
});

describe('Fighters (a fighting pair, over the code)', () => {
  const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
  const pair = (seed: number, scale = 4, heightPx = 480): [CatPlan, CatPlan] =>
    planPair(mulberry32(seed), { scale, heightPx, coats: [seed % COATS.length, (seed + 1) % COATS.length] });
  const at = (p: CatPlan, t: number): number => positionAt(p.keys, t).p;
  const kinds = (p: CatPlan): string[] => p.segs.map((s) => s.variant);

  it('are two cats of style fighters on one shared timeline, in step', () => {
    for (const seed of SEEDS) {
      const [a, b] = pair(seed);
      assert.strictEqual(a.style, 'fighters');
      assert.strictEqual(b.style, 'fighters');
      assert.strictEqual(a.duration, b.duration);
      assert.strictEqual(a.phase, b.phase, 'they start the cycle together');
      assert.strictEqual(a.segs.length, b.segs.length);
      a.segs.forEach((seg, i) => {
        assert.ok(Math.abs(seg.t0 - b.segs[i].t0) < 1e-6 && Math.abs(seg.t1 - b.segs[i].t1) < 1e-6, `segment ${i} is in step`);
      });
      assert.notStrictEqual(a.coat, b.coat, 'two different coats');
    }
  });

  it('plan valid, continuous looping cycles (also in a low box)', () => {
    for (const seed of SEEDS) {
      pair(seed).forEach((p) => checkPlan(p, 4, 480));
      pair(seed, 3, 14 * 20).forEach((p) => checkPlan(p, 3, 14 * 20));
    }
  });

  it('the loop closes smoothly: both end where they started, facing each other as at the start', () => {
    for (const seed of SEEDS) {
      const [a, b] = pair(seed);
      for (const p of [a, b]) {
        assert.ok(Math.abs(p.keys[0].p - p.keys[p.keys.length - 1].p) < 1e-6);
        assert.strictEqual(p.segs[0].flip, p.segs[p.segs.length - 1].flip);
      }
      assert.strictEqual(a.segs[0].flip, a.keys[0].p > b.keys[0].p, 'cat A looks at cat B at the start');
      assert.strictEqual(b.segs[0].flip, b.keys[0].p > a.keys[0].p);
      assert.deepStrictEqual(kinds(a)[0], 'idle');
      assert.deepStrictEqual(kinds(a)[a.segs.length - 1], 'idle');
    }
  });

  it('do the whole show: stalk, hiss, swat, fight cloud, break apart, back off or chase', () => {
    const seen = new Set<string>();
    let clouds = 0;
    for (const seed of SEEDS) {
      const [a, b] = pair(seed);
      kinds(a).forEach((k) => seen.add(k));
      kinds(b).forEach((k) => seen.add(k));
      const n = kinds(a).filter((k) => k === 'fight').length;
      assert.ok(n >= 1, `seed ${seed} has a fight cloud`);
      clouds += n;
    }
    for (const want of ['walk', 'hiss', 'swipe', 'run', 'fight', 'jump', 'fall', 'land', 'idle', 'sit']) {
      assert.ok(seen.has(want), `a fight includes ${want}`);
    }
    assert.ok(clouds >= SEEDS.length);
  });

  it('both cats stay on the floor; only the break-apart hop leaves it, and only a little', () => {
    for (const seed of SEEDS) {
      for (const p of pair(seed)) {
        for (const seg of p.segs) {
          const ys = p.keys.filter((k) => k.t >= seg.t0 - 1e-9 && k.t <= seg.t1 + 1e-9).map((k) => k.y);
          if (seg.variant === 'jump' || seg.variant === 'fall') {
            assert.ok(Math.max(...ys) <= 0.8 * (480 - 24 * 4) + 1e-6, 'a hop, not a flight');
          } else {
            assert.ok(Math.max(...ys) < 1e-9, `${seg.variant} is on the floor`);
          }
        }
      }
    }
  });

  /** Content left edge of a cat in px in an editor of width `w` (what the scene's CSS does with p and dx). */
  const xAt = (p: CatPlan, t: number, w: number, scale: number): number => {
    const pos = positionAt(p.keys, t);
    return pos.p * (w - sceneMetrics(scale).span) + pos.dx;
  };

  it('face each other while hissing, swatting and fighting: A is the left cat and looks right, B looks left', () => {
    for (const seed of SEEDS) {
      const [a, b] = pair(seed);
      a.segs.forEach((seg, i) => {
        if (!['hiss', 'swipe', 'fight', 'idle', 'sit'].includes(seg.variant)) return;
        assert.strictEqual(seg.flip, false, `A looks right during ${seg.variant}`);
        assert.strictEqual(b.segs[i].flip, true, `B looks left during ${seg.variant}`);
        const t = (seg.t0 + seg.t1) / 2;
        assert.ok(xAt(a, t, 800, 4) <= xAt(b, t, 800, 4) + 1e-6, 'A stands left of B');
      });
    }
  });

  it('in a face-off the two sprites never overlap and the snouts do not touch, at any editor width and scale', () => {
    for (const scale of [3, 4, 5]) {
      const { span } = sceneMetrics(scale);
      for (const w of [340, 400, 480, 600, 720, 900, 1280, 1920, 2560]) {
        for (const seed of SEEDS) {
          const [a, b] = planPair(mulberry32(seed), { scale, heightPx: 480, coats: [0, 1] });
          a.segs.forEach((seg, i) => {
            if (seg.variant !== 'hiss' && seg.variant !== 'swipe') return;
            const t = (seg.t0 + seg.t1) / 2;
            const faceOff = (positionAt(a.keys, t).dx ?? 0) !== 0; // (the hiss after a fight happens a little apart, not face to face: at most a sliver of overlap at 600px or more)
            if (!faceOff && w < 600) return;
            const gap = xAt(b, t, w, scale) - xAt(a, t, w, scale);
            assert.ok(gap >= span * (faceOff ? 1.15 : 0.9) - 1e-6, `${seg.variant} at ${w}px, scale ${scale}: boxes ${gap.toFixed(1)}px apart, sprites are ${span}px wide`);
            void b.segs[i];
          });
        }
      }
    }
  });

  it('both cats stay inside the editor in a face-off (the pixel offsets never push one out)', () => {
    for (const scale of [3, 4, 5]) {
      const { span } = sceneMetrics(scale);
      for (const w of [420, 600, 900, 1600].filter((x) => x >= 4.2 * span)) {
        for (const seed of SEEDS) {
          for (const p of planPair(mulberry32(seed), { scale, heightPx: 480, coats: [0, 1] })) {
            for (let tt = 0; tt < p.duration; tt += 0.25) {
              const x = xAt(p, tt, w, scale);
              assert.ok(x >= -1 && x <= w - span + 1, `x ${x.toFixed(1)} in ${w}px at scale ${scale}`);
            }
          }
        }
      }
    }
  });

  it('pairs keep to their own band of the width, spread from left to right', () => {
    for (const [pairsCount, cats] of [[2, 4], [3, 6]] as const) {
      for (let seed = 1; seed <= 12; seed++) {
        const plans = planScene({ ...BASE, cats, seed, styles: Array<CatStyle>(cats).fill('fighters') });
        assert.strictEqual(plans.length, cats);
        const centres: number[] = [];
        for (let k = 0; k < pairsCount; k++) {
          const [lo, hi] = pairBand(k, pairsCount);
          const mine = [plans[2 * k], plans[2 * k + 1]];
          for (const p of mine) {
            for (const key of p.keys) assert.ok(key.p >= lo - 1e-9 && key.p <= hi + 1e-9, `pair ${k} of ${pairsCount} left its band [${lo}, ${hi}]: ${key.p}`);
          }
          const all = mine.flatMap((p) => p.keys.map((key) => key.p));
          centres.push(all.reduce((x, y) => x + y, 0) / all.length);
        }
        for (let k = 1; k < centres.length; k++) assert.ok(centres[k] > centres[k - 1] + 0.1, `pairs are spread out: ${centres}`);
      }
    }
  });

  it('a lone pair gets the whole width', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) pair(seed)[0].keys.forEach((k) => seen.add(Math.floor(k.p * 4)));
    assert.ok(seen.size >= 4, 'it uses all of the width over time');
  });

  it('after the cloud bursts the two cats are visibly apart within 0.3 s of the jump', () => {
    for (const seed of SEEDS) {
      const [a, b] = pair(seed);
      a.segs.forEach((seg, i) => {
        if (seg.variant !== 'jump') return;
        const t = seg.t0 + 0.3;
        const gap = xAt(b, t, 800, 4) - xAt(a, t, 800, 4);
        assert.ok(gap >= sceneMetrics(4).span * 0.9, `seed ${seed}: ${gap.toFixed(0)}px apart 0.3s into the jump (sprite is ${sceneMetrics(4).span}px)`);
        void b.segs[i];
      });
    }
  });

  it('the cats never cross: A stays left of B except inside the cloud', () => {
    for (const seed of SEEDS) {
      const [a, b] = pair(seed);
      for (let t = 0; t < a.duration; t += 0.25) {
        assert.ok(at(a, t) <= at(b, t) + 1e-9, `seed ${seed} t=${t}`);
      }
    }
  });

  it('keep the normal speed limits, loop closure included', () => {
    const limit: Record<string, number> = {
      walk: SPEED.walk,
      run: SPEED.run,
      chase: SPEED.chase,
      jump: MAX_ARC_SPEED,
      fall: MAX_ARC_SPEED,
      fight: FIGHT_ROLL_SPEED
    };
    for (const [scale, heightPx] of [[4, 480], [3, 280], [4, 140]] as const) {
      for (const seed of SEEDS.concat(Array.from({ length: 80 }, (_, i) => 100 + i))) {
        for (const p of pair(seed, scale, heightPx)) {
          for (const seg of p.segs) {
            const ks = p.keys.filter((k) => k.t >= seg.t0 - 1e-9 && k.t <= seg.t1 + 1e-9);
            const v = seg.t1 > seg.t0 ? Math.abs(ks[ks.length - 1].p - ks[0].p) / (seg.t1 - seg.t0) : 0;
            const max = limit[seg.variant];
            if (max === undefined) assert.ok(v < 1e-9, `${seg.variant} stands still`);
            else assert.ok(v <= max * 1.05, `${seg.variant} speed ${v.toFixed(3)} > ${max} (seed ${seed}, ${heightPx}px)`);
          }
        }
      }
    }
  });

  it('show the new frames: hiss (arched back) and the fight cloud', () => {
    const [a] = pair(3);
    const cells = new Set(cellTimeline(a).map((c) => c.name));
    assert.ok(cells.has('hiss0') && cells.has('hiss1'), 'both hiss frames are shown');
    for (const f of ['fight0', 'fight1', 'fight2', 'fight3']) assert.ok(cells.has(f), `${f} is shown`);
    assert.ok(cells.has('walk0') && cells.has('jumpLand'));
  });

  it('are drawn in the scene SVG like any other cat (two animations each, valid markup)', () => {
    const plans = planScene({ ...BASE, cats: 6, seed: 9 });
    const svg = buildSceneSvg(plans, BASE.scale);
    const tags = checkXml(svg);
    assert.strictEqual(tags.get('svg'), 1 + plans.length);
    assert.ok(svg.includes('id="cell-fight0"') && svg.includes('id="cell-hiss0"'));
    assert.strictEqual((svg.match(/animation:/g) ?? []).length, plans.length * 2, 'exactly two animations per cat');
    // The pair is in step: the same cycle length and start delay.
    const pairPlans = plans.filter((p) => p.style === 'fighters');
    assert.strictEqual(pairPlans.length, 2);
    assert.strictEqual(cycleTicks(pairPlans[0]), cycleTicks(pairPlans[1]));
    assert.strictEqual(pairPlans[0].phase, pairPlans[1].phase);
  });

  it('differ from seed to seed (not the same fight every time)', () => {
    const scripts = new Set(SEEDS.map((seed) => kinds(pair(seed)[0]).join(' ')));
    assert.ok(scripts.size >= 20, `${scripts.size} different scripts`);
  });
});
