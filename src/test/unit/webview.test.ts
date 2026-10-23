import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { pairBand } from '../../catStyles';
import { COATS, CONTENT_MAX_COL, CONTENT_MIN_COL, FEET_ROWS, FRAME_SIZE, frameRgba } from '../../catArt';

interface FakeEl {
  tag: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  className: string;
  width: number;
  height: number;
  removed?: boolean;
  puts: number;
  /** Checksums of every image this element was given, and of the latest one. */
  shown: Set<string>;
  current: string;
  throwOnPut?: boolean;
  children: FakeEl[];
}

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Track {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  dirs: Set<string>;
}

interface BootOpts {
  /** performance.now() at script load. */
  loadTime?: number;
  /** Timestamp of the first requestAnimationFrame callback (can precede loadTime, as in a real webview). */
  firstFrame?: number;
  /** The enabled styles, as the page passes them in data-styles (all styles when omitted). */
  styles?: string;
}

/** A checksum of pixel data, to tell which sprite frame an element is showing. */
function checksum(data: ArrayLike<number>): string {
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) {
    h = Math.imul(h ^ data[i], 16777619);
  }
  return String(h >>> 0);
}

/** Checksums of a frame in every coat, so a cat's frame can be recognised whatever its coat. */
function frameChecksums(...names: string[]): Set<string> {
  const out = new Set<string>();
  for (let coat = 0; coat < COATS.length; coat++) {
    for (const name of names) out.add(checksum(frameRgba(coat, name).data));
  }
  return out;
}

const TRANSFORM = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scaleX\((-?1)\)/;

/** Boots the bundled webview script (out/webview/cats.js) against a tiny fake DOM and drives its rAF loop. */
function boot(width: number, height: number, catCount: number, opts: BootOpts = {}) {
  const code = fs.readFileSync(path.resolve(__dirname, '../../../out/webview/cats.js'), 'utf8');
  const loadTime = opts.loadTime ?? 0;
  let perfNow = loadTime;
  let frameTime = opts.firstFrame ?? loadTime;
  let raf: ((t: number) => void) | undefined;
  let resizeListener: (() => void) | undefined;
  const els: FakeEl[] = [];
  const posted: Array<{ type: string; cats?: number; styles?: string[] }> = [];
  const errors: unknown[] = [];
  const mk = (tag: string): FakeEl & Record<string, unknown> => {
    const e = {
      tag,
      style: {},
      dataset: {},
      className: '',
      width: 0,
      height: 0,
      puts: 0,
      shown: new Set<string>(),
      current: '',
      throwOnPut: false,
      children: [] as FakeEl[],
      appendChild(c: FakeEl) {
        e.children.push(c);
      },
      remove() {
        e.removed = true;
      },
      addEventListener() {},
      getContext() {
        return {
          putImageData(img: { data: Uint8ClampedArray }) {
            if (e.throwOnPut) {
              throw new Error('boom');
            }
            e.puts++;
            e.current = checksum(img.data);
            e.shown.add(e.current);
          }
        };
      }
    } as unknown as FakeEl & Record<string, unknown>;
    els.push(e);
    return e;
  };
  const stage = mk('div');
  const body = mk('body');
  body.dataset.catCount = String(catCount);
  if (opts.styles !== undefined) body.dataset.styles = opts.styles;
  const math = Object.create(Math) as Math;
  math.random = seeded(42);
  const win = {
    innerWidth: width,
    innerHeight: height,
    addEventListener(type: string, fn: () => void) {
      if (type === 'resize') resizeListener = fn;
    }
  };
  const sandbox = {
    document: { getElementById: (id: string) => (id === 'stage' ? stage : null), createElement: mk, body },
    window: win,
    performance: { now: () => perfNow },
    requestAnimationFrame: (cb: (t: number) => void) => {
      raf = cb;
    },
    console: { error: (...a: unknown[]) => errors.push(a), log() {} },
    ImageData: class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number
      ) {}
    },
    acquireVsCodeApi: () => ({ postMessage: (m: { type: string; cats?: number; styles?: string[] }) => posted.push(m) }),
    Math: math,
    Map,
    Set,
    WeakSet,
    Array,
    Number,
    parseInt,
    String,
    Object
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const cats = els.filter((e) => e.className === 'cat');
  const track: Track[] = cats.map(() => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, dirs: new Set<string>() }));

  const pos = (c: FakeEl): { x: number; y: number; dir: number } | undefined => {
    const m = TRANSFORM.exec(c.style.transform ?? '');
    return m ? { x: +m[1], y: +m[2], dir: +m[3] } : undefined;
  };

  function advance(seconds: number): void {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      const cb = raf;
      raf = undefined;
      assert.ok(cb, 'the animation loop keeps requesting frames');
      // The very first callback gets exactly `firstFrame` (which may precede loadTime).
      cb(frameTime);
      perfNow += 1000 / 60;
      frameTime += 1000 / 60;
      cats.forEach((c, k) => {
        const p = pos(c);
        assert.ok(p, 'cat has a transform');
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'finite position');
        const t = track[k];
        t.minX = Math.min(t.minX, p.x);
        t.maxX = Math.max(t.maxX, p.x);
        t.minY = Math.min(t.minY, p.y);
        t.maxY = Math.max(t.maxY, p.y);
        t.dirs.add(String(p.dir));
      });
    }
  }

  function resize(w: number, h: number): void {
    win.innerWidth = w;
    win.innerHeight = h;
    assert.ok(resizeListener, 'resize listener registered');
    resizeListener();
  }

  return { cats, track, posted, els, errors, advance, resize, pos };
}

function run(width: number, height: number, catCount: number, seconds: number, styles?: string) {
  const b = boot(width, height, catCount, { styles });
  b.advance(seconds);
  return b;
}

describe('bundled webview script', () => {
  it('bundles the shared cat art and the engine into one classic script', () => {
    const code = fs.readFileSync(path.resolve(__dirname, '../../../out/webview/cats.js'), 'utf8');
    assert.ok(code.includes('var CatArt = (function'));
    assert.ok(!/^\s*(import|export) /m.test(code));
    assert.ok(!/\brequire\(/.test(code));
  });

  it('creates the requested number of pixel-art cats and reports ready', () => {
    const { cats, posted } = run(1000, 700, 8, 1);
    assert.strictEqual(cats.length, 8);
    assert.strictEqual(JSON.stringify(posted), JSON.stringify([{ type: 'ready', cats: 8, styles: ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters', 'fighters', 'wanderer', 'climber'] }]));
    for (const c of cats) {
      assert.strictEqual(c.width, FRAME_SIZE);
      assert.strictEqual(c.height, FRAME_SIZE);
      assert.ok(c.puts >= 1, 'a sprite frame was drawn');
      assert.match(c.style.width, /^\d+px$/);
      assert.ok(parseInt(c.style.width, 10) >= FRAME_SIZE * 4, 'sprites are scaled up clearly');
    }
  });

  it('has no pause button: the script neither creates one nor posts a pause message', () => {
    const code = fs.readFileSync(path.resolve(__dirname, '../../../out/webview/cats.js'), 'utf8');
    assert.ok(!/getElementById\(['"]pause['"]\)/.test(code));
    assert.ok(!/['"]pause['"]/.test(code));
    const { els, posted } = run(1000, 700, 8, 1);
    assert.ok(!els.some((e) => e.tag === 'button'));
    assert.ok(posted.every((m) => m.type === 'ready'));
  });

  it('clamps the cat count to 2..30 (two, so a fighting pair always works)', () => {
    assert.strictEqual(run(900, 600, 100, 1).cats.length, 30);
    assert.strictEqual(run(900, 600, 0, 1).cats.length, 2);
    assert.strictEqual(run(900, 600, 1, 1).cats.length, 2);
  });

  it('keeps every cat inside the pane, on the floor or above it, and they all move', () => {
    const W = 1000;
    const H = 700;
    const { cats, track } = run(W, H, 12, 90);
    const scale = parseInt(cats[0].style.width, 10) / FRAME_SIZE;
    const floor = H - FEET_ROWS * scale;
    for (const t of track) {
      assert.ok(t.minX >= -CONTENT_MIN_COL * scale - 1, `left bound ${t.minX}`);
      assert.ok(t.maxX <= W - (CONTENT_MAX_COL + 1) * scale + 1, `right bound ${t.maxX}`);
      assert.ok(t.maxY <= floor + 1, `floor ${t.maxY}`);
      assert.ok(t.minY >= -1, `top ${t.minY}`);
    }
    const moved = track.filter((t) => t.maxX - t.minX > 50 || t.maxY - t.minY > 50);
    assert.ok(moved.length >= 10, 'most cats move around');
  });

  it('about a quarter of the cats (at least one) bounce across the middle of the screen', () => {
    const H = 700;
    const { cats, track } = run(1000, H, 8, 60);
    const scale = parseInt(cats[0].style.width, 10) / FRAME_SIZE;
    const floor = H - FEET_ROWS * scale;
    const high = track.filter((t) => t.minY < floor * 0.5);
    assert.ok(high.length >= 2, `bouncers reach the middle of the screen (${high.length})`);
    assert.ok(high.length <= 6, 'most cats stay near the floor and walls');
    const lone = run(1000, H, 1, 30, 'bouncer');
    assert.ok(lone.track[0].minY < floor * 0.7, 'a single Bouncer still bounces');
  });

  it('flips the sprite for both directions of travel', () => {
    const { track } = run(1000, 700, 8, 60);
    assert.ok(track.some((t) => t.dirs.size === 2), 'a cat faced both ways');
  });

  it('creates and removes yarn balls while chasing, and some cat climbs a wall', () => {
    const { els, cats, track } = run(1000, 700, 12, 180);
    const balls = els.filter((e) => e.className === 'ball');
    assert.ok(balls.length >= 1, 'yarn balls appeared');
    assert.ok(balls.every((b) => b.puts >= 1));
    assert.ok(balls.some((b) => b.removed), 'balls are cleaned up after the chase');
    const scale = parseInt(cats[0].style.width, 10) / FRAME_SIZE;
    const floor = 700 - FEET_ROWS * scale;
    const maxX = 1000 - (CONTENT_MAX_COL + 1) * scale;
    const climbers = track.filter((t) => t.minY < floor * 0.8 && (t.minX <= -CONTENT_MIN_COL * scale + 1 || t.maxX >= maxX - 1));
    assert.ok(climbers.length >= 1, 'wall climbing happened');
  });

  describe('movement styles (fallback cat tab)', () => {
    const H = 700;
    const W = 1000;
    const geometry = (cats: ReturnType<typeof run>['cats']) => {
      const scale = parseInt(cats[0].style.width, 10) / FRAME_SIZE;
      return { scale, floor: H - FEET_ROWS * scale, maxX: W - (CONTENT_MAX_COL + 1) * scale, minX: -CONTENT_MIN_COL * scale };
    };

    it('deals the cats out to the enabled styles like the over-code scene: round-robin, fixed order', () => {
      // Two enabled styles, four cats: climber, bouncer, climber, bouncer. Bouncers leave the floor early and often.
      const { cats, track } = run(W, H, 4, 40, 'climber,bouncer');
      const { floor } = geometry(cats);
      const flying = track.filter((t) => t.minY < floor * 0.5);
      assert.ok(flying.length >= 2, `the bouncers (cats 1 and 3) fly (${flying.length})`);
      assert.ok(track[1].minY < floor * 0.5 && track[3].minY < floor * 0.5, 'cats 1 and 3 are the bouncers');
    });

    it('a small count gets one of each style first: 2 cats are a Wanderer and a Climber (no bouncing)', () => {
      const { cats, track } = run(W, H, 2, 60);
      const { floor, scale } = geometry(cats);
      assert.ok(track[0].minY > floor - 40 * scale, 'cat 0, the Wanderer, stays near the floor');
    });

    it('wanderer: stays on the floor (hops only), never climbs, never has a yarn ball', () => {
      const { cats, track, els } = run(W, H, 8, 240, 'wanderer');
      const { floor, scale } = geometry(cats);
      for (const t of track) {
        assert.ok(t.minY > floor - 36 * scale, `only hops leave the floor (${floor - t.minY}px up)`);
      }
      assert.strictEqual(els.filter((e) => e.className === 'ball').length, 0, 'no yarn');
      assert.ok(track.filter((t) => t.maxX - t.minX > 100).length >= 4, 'wanderers walk about');
      assert.ok(track.some((t) => t.maxY - t.minY > 10), 'and hop');
    });

    it('climber: reaches a wall and climbs it, and also walks on the floor', () => {
      const { cats, track } = run(W, H, 6, 120, 'climber');
      const { floor, minX, maxX } = geometry(cats);
      const climbers = track.filter((t) => t.minY < floor * 0.8 && (t.minX <= minX + 1 || t.maxX >= maxX - 1));
      assert.ok(climbers.length >= 4, `most climbers climbed a wall (${climbers.length} of 6)`);
      assert.ok(track.every((t) => t.maxX - t.minX > 50), 'all of them also move on the floor');
    });

    it('climbers use both walls and different heights instead of stacking up', () => {
      const { cats, track } = run(W, H, 4, 40, 'climber');
      const { floor, minX, maxX } = geometry(cats);
      assert.ok(track.some((t) => t.minX <= minX + 1), 'someone climbs the left wall');
      assert.ok(track.some((t) => t.maxX >= maxX - 1), 'someone climbs the right wall');
      const heights = new Set(track.map((t) => Math.round(t.minY / 30)));
      assert.ok(heights.size >= 3 && track.every((t) => t.minY < floor * 0.85), `heights ${[...heights]}`);
    });

    it('the default six cats are one of each style: four singles and a fighting pair', () => {
      const { posted } = run(W, H, 6, 1);
      assert.deepStrictEqual(Array.from(posted[0].styles ?? []), ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters', 'fighters']);
    });

    it('Fighters only: pairs, and an odd extra cat is a Wanderer', () => {
      const { posted, cats } = run(W, H, 5, 1, 'fighters');
      assert.deepStrictEqual(Array.from(posted[0].styles ?? []), ['fighters', 'fighters', 'fighters', 'fighters', 'wanderer']);
      assert.strictEqual(cats.length, 5);
    });

    describe('fighting pair', () => {
      const hiss = frameChecksums('hiss0', 'hiss1');
      const cloud = frameChecksums('fight0', 'fight1', 'fight2', 'fight3');
      const swipe = frameChecksums('swipe0', 'swipe1', 'swipe2');
      const walk = frameChecksums('walk0', 'walk1', 'walk2', 'walk3');
      const land = frameChecksums('jumpLand');

      /** Plays a 2-cat Fighters tab for `seconds`, sampling both cats every 0.1 s. */
      function watch(seconds: number) {
        const b = boot(W, H, 2, { styles: 'fighters' });
        const samples: Array<{ a: ReturnType<typeof b.pos>; b: ReturnType<typeof b.pos>; fa: string; fb: string }> = [];
        for (let i = 0; i < seconds * 10; i++) {
          b.advance(0.1);
          samples.push({ a: b.pos(b.cats[0]), b: b.pos(b.cats[1]), fa: b.cats[0].current, fb: b.cats[1].current });
        }
        return { ...b, samples };
      }

      it('squares up, hisses, swats, brawls in a cloud, breaks apart and starts again', () => {
        const { cats, samples, errors } = watch(120);
        assert.strictEqual(errors.length, 0, JSON.stringify(errors));
        for (const cat of cats) {
          const shown = [...cat.shown];
          const saw = (set: Set<string>): boolean => shown.some((h) => set.has(h));
          assert.ok(saw(walk), 'stalks');
          assert.ok(saw(hiss), 'hisses with an arched back');
          assert.ok(saw(swipe), 'swats');
          assert.ok(saw(cloud), 'is in the fight cloud');
          assert.ok(saw(land), 'breaks apart and lands');
        }
        const cloudRounds = samples.filter((x) => cloud.has(x.fa) && cloud.has(x.fb)).length;
        assert.ok(cloudRounds >= 20, `the cloud lasts a few seconds (${cloudRounds / 10}s)`);
        // Another round after the first one: the fight cloud comes and goes.
        let changes = 0;
        for (let i = 1; i < samples.length; i++) {
          if (cloud.has(samples[i].fa) !== cloud.has(samples[i - 1].fa)) changes++;
        }
        assert.ok(changes >= 4, `the brawl starts and stops again and again (${changes})`);
      });

      it('both stay on the floor (only the break-apart hop leaves it) and inside the pane', () => {
        const { cats, samples } = watch(90);
        const scale = parseInt(cats[0].style.width, 10) / FRAME_SIZE;
        const floor = H - FEET_ROWS * scale;
        for (const x of samples) {
          for (const p of [x.a, x.b]) {
            assert.ok(p, 'positioned');
            assert.ok(p.y >= floor - 31 * scale && p.y <= floor + 1, `near the floor (${floor - p.y}px up)`);
            assert.ok(p.x >= -CONTENT_MIN_COL * scale - 1 && p.x <= W - (CONTENT_MAX_COL + 1) * scale + 1, 'inside the pane');
          }
        }
      });

      it('face each other while hissing and fighting; they come together in the cloud and then move apart', () => {
        const { samples } = watch(120);
        let hissing = 0;
        let together = 0;
        let apart = 0;
        for (const x of samples) {
          if (!x.a || !x.b) continue;
          if (hiss.has(x.fa) && hiss.has(x.fb)) {
            hissing++;
            const rightOf = x.b.x > x.a.x;
            assert.strictEqual(x.a.dir, rightOf ? 1 : -1, 'A looks at B');
            assert.strictEqual(x.b.dir, rightOf ? -1 : 1, 'B looks at A');
          }
          if (cloud.has(x.fa) && cloud.has(x.fb)) {
            // (at the very end the cloud bursts and the two pull out of it a little way apart)
            if (Math.abs(x.a.x - x.b.x) < 3) together++;
            else assert.ok(Math.abs(x.a.x - x.b.x) < 0.12 * W, 'a burst, not a flight');
            assert.strictEqual(x.a.dir * x.b.dir, -1, 'mirrored, so paws and tails stick out on both sides');
          }
          if (Math.abs(x.a.x - x.b.x) > 150) apart++;
        }
        assert.ok(hissing >= 20 && together >= 20 && apart >= 50, `hiss ${hissing}, cloud ${together}, apart ${apart}`);
      });

      it('some rounds end with one cat chasing the other a short way', () => {
        // Over several pairs and a long time: both run in the same direction at once at least once.
        const b = boot(W, H, 8, { styles: 'fighters' });
        let chases = 0;
        let prev: Array<number | undefined> = [];
        for (let i = 0; i < 1500; i++) {
          b.advance(0.1);
          const xs = b.cats.map((c) => b.pos(c)?.x);
          for (let k = 0; k < 8; k += 2) {
            const [x0, x1] = [xs[k], xs[k + 1]];
            const [p0, p1] = [prev[k], prev[k + 1]];
            if (x0 !== undefined && x1 !== undefined && p0 !== undefined && p1 !== undefined) {
              const d0 = x0 - p0;
              const d1 = x1 - p1;
              if (Math.abs(d0) > 3 && Math.abs(d1) > 3 && Math.sign(d0) === Math.sign(d1)) chases++;
            }
          }
          prev = xs;
        }
        assert.ok(chases >= 3, `a chase happened (${chases} samples)`);
      });

      it('in a face-off the two sprites never overlap (snouts do not touch), at any pane width', () => {
        for (const width of [420, 600, 1000, 1600]) {
          const b = boot(width, H, 2, { styles: 'fighters' });
          const scale = parseInt(b.cats[0].style.width, 10) / FRAME_SIZE;
          const content = (CONTENT_MAX_COL - CONTENT_MIN_COL + 1) * scale;
          let faceOffs = 0;
          for (let i = 0; i < 1200; i++) {
            b.advance(0.1);
            const [pa, pb] = [b.pos(b.cats[0]), b.pos(b.cats[1])];
            if (pa && pb && hiss.has(b.cats[0].current) && hiss.has(b.cats[1].current)) {
              faceOffs++;
              assert.ok(Math.abs(pb.x - pa.x) >= content * 1.1, `width ${width}: boxes ${Math.abs(pb.x - pa.x).toFixed(1)}px apart, sprites ${content}px wide`);
            }
          }
          assert.ok(faceOffs > 20, `hissing happened at ${width}px`);
        }
      });

      it('after a cloud the cats are clear of each other soon after the jump', () => {
        const b = boot(W, H, 2, { styles: 'fighters' });
        const scale = parseInt(b.cats[0].style.width, 10) / FRAME_SIZE;
        const content = (CONTENT_MAX_COL - CONTENT_MIN_COL + 1) * scale;
        let prevCloud = false;
        let sinceCloud = -1;
        let checked = 0;
        for (let i = 0; i < 2400; i++) {
          b.advance(0.05);
          const inCloud = cloud.has(b.cats[0].current);
          if (prevCloud && !inCloud) sinceCloud = 0;
          else if (sinceCloud >= 0) sinceCloud += 0.05;
          prevCloud = inCloud;
          const [pa, pb] = [b.pos(b.cats[0]), b.pos(b.cats[1])];
          if (pa && pb && sinceCloud >= 0.7 && sinceCloud < 0.8) {
            checked++;
            assert.ok(Math.abs(pb.x - pa.x) >= content * 0.9, `${(Math.abs(pb.x - pa.x)).toFixed(0)}px apart 0.7s after the cloud (sprites ${content}px wide)`);
          }
        }
        assert.ok(checked >= 3, `checked ${checked} breaks`);
      });

      it('two pairs keep to their own halves of the pane (no crowding), the cloud included', () => {
        const b = boot(W, H, 4, { styles: 'fighters' });
        const scale = parseInt(b.cats[0].style.width, 10) / FRAME_SIZE;
        const minX = -CONTENT_MIN_COL * scale;
        const maxX = W - (CONTENT_MAX_COL + 1) * scale;
        const span = maxX - minX;
        const bands = [pairBand(0, 2), pairBand(1, 2)];
        for (let i = 0; i < 1200; i++) {
          b.advance(0.1);
          b.cats.forEach((c, k) => {
            const p = b.pos(c);
            assert.ok(p, 'positioned');
            const [lo, hi] = bands[k < 2 ? 0 : 1];
            assert.ok(p.x >= minX + lo * span - 1 && p.x <= minX + hi * span + 1, `cat ${k} at ${p.x.toFixed(0)}px left its half`);
          });
        }
        // They really were fighting there, both pairs.
        for (const c of b.cats) assert.ok([...c.shown].some((h) => cloud.has(h)));
      });

      it('four Fighters are two independent pairs', () => {
        const b = boot(W, H, 4, { styles: 'fighters' });
        b.advance(120);
        for (const c of b.cats) {
          assert.ok([...c.shown].some((h) => cloud.has(h)), 'every cat has been in a brawl');
        }
        assert.strictEqual(b.errors.length, 0);
      });
    });

    it('bouncer: every cat bounces up to the middle of the screen', () => {
      const { cats, track } = run(W, H, 5, 60, 'bouncer');
      const { floor } = geometry(cats);
      assert.ok(track.every((t) => t.minY < floor * 0.5), 'all reach mid-height');
    });

    it('yarn chaser: has a ball, stays on the floor, never climbs', () => {
      const { cats, track, els } = run(W, H, 4, 120, 'yarnChaser');
      const { floor, scale } = geometry(cats);
      const balls = els.filter((e) => e.className === 'ball');
      assert.ok(balls.length >= 4, `every chaser got a ball (${balls.length})`);
      assert.ok(balls.every((b) => b.puts >= 1), 'balls are drawn');
      assert.ok(balls.some((b) => b.removed), 'and cleaned up between chases');
      for (const t of track) {
        assert.ok(t.minY >= floor - 1, `stays on the floor (${floor - t.minY}px up)`);
        assert.ok(t.maxX - t.minX > 100 * (scale / 4), 'covers ground chasing');
      }
    });

    it('an unknown or empty style list in the page still gives a working scene (all styles)', () => {
      for (const styles of ['', 'nonsense,fighters']) {
        const { cats, errors } = run(W, H, 8, 30, styles);
        assert.strictEqual(cats.length, 8);
        assert.strictEqual(errors.length, 0);
      }
    });

    it('cats of one style differ from each other (not robotic)', () => {
      const { track } = run(W, H, 12, 25, 'climber');
      const heights = new Set(track.map((t) => Math.round(t.minY / 40)));
      assert.ok(heights.size >= 3, `the climbs reach different heights (${heights.size})`);
    });
  });

  describe('animation loop robustness', () => {
    it('survives a first frame timestamp earlier than performance.now() at load', () => {
      // Measured in a real webview: first rAF 14.70 while performance.now() was 21.00 at load.
      const b = boot(1000, 700, 8, { loadTime: 21, firstFrame: 14.7 });
      b.advance(0.02);
      assert.strictEqual(b.errors.length, 0, 'no error on the very first frame');
      b.advance(20);
      assert.strictEqual(b.errors.length, 0, `errors: ${JSON.stringify(b.errors)}`);
      for (const c of b.cats) {
        assert.ok(b.pos(c), 'every cat is positioned');
        assert.ok(c.puts >= 1, 'every cat is drawn');
      }
      const moved = b.track.filter((t) => t.maxX - t.minX > 30 || t.maxY - t.minY > 30);
      assert.ok(moved.length >= 6, `cats move (${moved.length} of 8)`);
    });

    it('positions and draws every cat even before the first frame runs', () => {
      const b = boot(1000, 700, 8, { loadTime: 21, firstFrame: 14.7 });
      for (const c of b.cats) {
        assert.ok(b.pos(c), 'positioned at load');
        assert.ok(c.puts >= 1, 'drawn at load');
      }
    });

    it('also copes with a frozen, huge or non-monotonic clock', () => {
      const b = boot(900, 600, 6, { loadTime: 5000, firstFrame: 0 });
      b.advance(3);
      assert.strictEqual(b.errors.length, 0);
      assert.ok(b.cats.every((c) => b.pos(c)));
    });

    it('a cat that throws does not freeze the others, and the error is logged once', () => {
      const b = boot(1000, 700, 8);
      b.advance(1);
      const victim = b.cats[0];
      victim.throwOnPut = true;
      const before = b.track.map((t) => ({ ...t }));
      b.advance(20);
      assert.ok(b.errors.length >= 1, 'the failure was logged');
      assert.ok(b.errors.length <= 2, `logged once (and no loop death): ${b.errors.length}`);
      const others = b.track.slice(1).filter((t, i) => t.maxX - t.minX > before[i + 1].maxX - before[i + 1].minX || t.maxY !== before[i + 1].maxY);
      assert.ok(others.length >= 4, 'the other cats kept moving');
    });
  });

  describe('resize', () => {
    it('re-snaps wall climbers and floor cats to the new pane size', () => {
      const W = 1000;
      const H = 700;
      const geo = (w: number, h: number): { scale: number; floor: number; minX: number; maxX: number } => {
        const scale = Math.max(4, Math.min(6, Math.floor(Math.min(w / 170, h / 115))));
        return {
          scale,
          floor: h - FEET_ROWS * scale,
          minX: -CONTENT_MIN_COL * scale,
          maxX: w - (CONTENT_MAX_COL + 1) * scale
        };
      };
      const g0 = geo(W, H);
      for (const [w, h] of [[700, 500], [1300, 900], [1000, 400]] as const) {
        // Fresh (seeded, so identical) run each time: advance until a cat hangs on a wall.
        const b = boot(W, H, 12);
        let climber = -1;
        const onWall = (c: FakeEl): boolean => {
          const p = b.pos(c);
          return !!p && (p.x === Math.round(g0.minX) || p.x === Math.round(g0.maxX)) && p.y < g0.floor - 60;
        };
        for (let step = 0; step < 4000 && climber < 0; step++) {
          // Clinging means staying on the wall column for several samples (a falling cat leaves it at once).
          const seen = b.cats.map(onWall);
          for (let k = 0; k < 3; k++) {
            b.advance(0.1);
          }
          climber = b.cats.findIndex((c, i) => seen[i] && onWall(c));
        }
        assert.ok(climber >= 0, 'a cat climbed a wall');
        const side = b.pos(b.cats[climber])!.x === Math.round(g0.maxX) ? 'right' : 'left';

        b.resize(w, h);
        const g = geo(w, h);
        assert.strictEqual(parseInt(b.cats[0].style.width, 10), FRAME_SIZE * g.scale, 'sprites rescale');
        const p = b.pos(b.cats[climber])!;
        assert.strictEqual(p.x, Math.round(side === 'right' ? g.maxX : g.minX), `climber stays glued to the ${side} wall at ${w}x${h}`);
        assert.ok(p.y <= g.floor, 'climber is not below the new floor');
        for (const c of b.cats) {
          const q = b.pos(c)!;
          assert.ok(q.x >= g.minX - 1 && q.x <= g.maxX + 1, `inside new width (${q.x})`);
          assert.ok(q.y <= g.floor + 1, `above new floor (${q.y} > ${g.floor})`);
        }
        b.advance(5);
        assert.strictEqual(b.errors.length, 0);
      }
    });

    it('moves floor-standing cats onto the new floor line', () => {
      const b = boot(1000, 700, 8);
      b.advance(2);
      b.resize(1000, 400);
      const scale = parseInt(b.cats[0].style.width, 10) / FRAME_SIZE;
      const floor = 400 - FEET_ROWS * scale;
      const onFloor = b.cats.filter((c) => b.pos(c)!.y === Math.round(floor));
      assert.ok(onFloor.length >= 3, `grounded cats sit on the new floor (${onFloor.length})`);
      assert.ok(b.cats.every((c) => b.pos(c)!.y <= floor + 1));
    });
  });
});
