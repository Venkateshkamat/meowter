import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { CONTENT_MAX_COL, CONTENT_MIN_COL, FEET_ROWS, FRAME_SIZE } from '../../catArt';

interface FakeEl {
  tag: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  className: string;
  width: number;
  height: number;
  removed?: boolean;
  puts: number;
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
  const posted: Array<{ type: string; cats?: number }> = [];
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
          putImageData() {
            if (e.throwOnPut) {
              throw new Error('boom');
            }
            e.puts++;
          }
        };
      }
    } as unknown as FakeEl & Record<string, unknown>;
    els.push(e);
    return e;
  };
  const stage = mk('div');
  const pause = mk('button');
  const body = mk('body');
  body.dataset.catCount = String(catCount);
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
    document: { getElementById: (id: string) => (id === 'stage' ? stage : pause), createElement: mk, body },
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
    acquireVsCodeApi: () => ({ postMessage: (m: { type: string; cats?: number }) => posted.push(m) }),
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

function run(width: number, height: number, catCount: number, seconds: number) {
  const b = boot(width, height, catCount);
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
    assert.strictEqual(JSON.stringify(posted), JSON.stringify([{ type: 'ready', cats: 8 }]));
    for (const c of cats) {
      assert.strictEqual(c.width, FRAME_SIZE);
      assert.strictEqual(c.height, FRAME_SIZE);
      assert.ok(c.puts >= 1, 'a sprite frame was drawn');
      assert.match(c.style.width, /^\d+px$/);
      assert.ok(parseInt(c.style.width, 10) >= FRAME_SIZE * 4, 'sprites are scaled up clearly');
    }
  });

  it('clamps the cat count to 1..30', () => {
    assert.strictEqual(run(900, 600, 100, 1).cats.length, 30);
    assert.strictEqual(run(900, 600, 0, 1).cats.length, 1);
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
    const lone = run(1000, H, 1, 30);
    assert.ok(lone.track[0].minY < floor * 0.7, 'a single cat still bounces');
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
