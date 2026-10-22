/**
 * Cat "scenes": many pixel cats in ONE standalone, self-animating SVG whose size is expressed in
 * percentages, so it can be used as the background image of an overlay of any width.
 *
 * Everything is planned here (pure, seeded, no vscode/DOM) and played back by SMIL only:
 *  - a cat's horizontal position is an `x="…%"` animation plus a pixel correction, so a cat spans
 *    exactly the free width of whatever box the SVG is stretched over (walls included);
 *  - vertical motion (hops, bounces, wall climbs) is a pixel `translate` animation;
 *  - the pose (walk, sit, sleep, climb, ...) and facing are switched with discrete `display`
 *    animations on shared sprite definitions (`<use>`), recoloured per cat with CSS variables.
 */
import {
  ANIMATIONS,
  AnimName,
  cellMarkup,
  coatVars,
  COATS,
  CONTENT_MAX_COL,
  CONTENT_MIN_COL,
  FEET_ROWS,
  FRAME_SIZE,
  SCENE_FPS,
  SCENE_TICK_HZ,
  sceneStyle,
  svgToDataUri,
  YARN_COLORS,
  yarnVars
} from './catArt';

/** A pose shown by the plan: any animation, or running with a yarn ball in front. */
export type Variant = AnimName | 'chase';

export interface Keyframe {
  /** Seconds from the start of the cycle. */
  t: number;
  /** Horizontal position as a fraction (0..1) of the free width. */
  p: number;
  /** Height above the floor in px. */
  y: number;
}

export interface Segment {
  t0: number;
  t1: number;
  variant: Variant;
  /** Facing left. */
  flip: boolean;
}

export interface CatPlan {
  coat: number;
  yarn: number;
  duration: number;
  keys: Keyframe[];
  segs: Segment[];
  bouncer: boolean;
  /** Seconds the whole cycle is shifted by so cats do not all start in the same pose. */
  phase: number;
}

export interface SceneOptions {
  /** Pixels per sprite pixel. */
  scale: number;
  /** Height of the box in px (the floor is its bottom edge). */
  heightPx: number;
  cats: number;
  seed: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speeds as fractions of the free width per second. */
export const SPEED = { walk: 0.07, run: 0.26, chase: 0.22, hop: 0.9 } as const;

/** Cat sprite pixels above the floor that the head never exceeds when standing. */
const TOP_ROWS = 24;

interface Cursor {
  t: number;
  p: number;
  y: number;
  flip: boolean;
}

class Timeline {
  readonly keys: Keyframe[] = [];
  readonly segs: Segment[] = [];
  readonly cur: Cursor;

  constructor(p0: number, flip: boolean) {
    this.cur = { t: 0, p: p0, y: 0, flip };
    this.keys.push({ t: 0, p: p0, y: 0 });
  }

  private seg(variant: Variant, dur: number): void {
    this.segs.push({ t0: this.cur.t, t1: this.cur.t + dur, variant, flip: this.cur.flip });
  }

  private key(): void {
    this.keys.push({ t: this.cur.t, p: this.cur.p, y: this.cur.y });
  }

  hold(variant: Variant, dur: number): void {
    this.seg(variant, dur);
    this.cur.t += dur;
    this.key();
  }

  /** Straight horizontal move at the floor. */
  move(variant: Variant, p1: number, speed: number): void {
    const dist = Math.abs(p1 - this.cur.p);
    const dur = Math.max(0.2, dist / speed);
    if (p1 !== this.cur.p) this.cur.flip = p1 < this.cur.p;
    this.seg(variant, dur);
    this.cur.t += dur;
    this.cur.p = p1;
    this.key();
  }

  /** A parabolic hop/bounce of height `h` px landing at `p1` (rising = 'jump', falling = 'fall'). */
  arc(h: number, p1: number, gravity: number): void {
    const half = Math.sqrt((2 * h) / gravity);
    const p0 = this.cur.p;
    if (p1 !== p0) this.cur.flip = p1 < p0;
    const steps = 6;
    for (const [part, variant] of [['up', 'jump'], ['down', 'fall']] as const) {
      this.seg(variant, half);
      for (let i = 1; i <= steps; i++) {
        const u = i / steps;
        const tt = this.cur.t + half * u;
        const frac = part === 'up' ? u / 2 : 0.5 + u / 2;
        const y = part === 'up' ? h * (1 - (1 - u) * (1 - u)) : h * (1 - u * u);
        this.keys.push({ t: tt, p: p0 + (p1 - p0) * frac, y });
      }
      this.cur.t += half;
    }
    this.cur.p = p1;
    this.cur.y = 0;
  }

  /** Climb straight up/down a wall (p must already be at the wall). */
  climb(toY: number, pxPerSec: number): void {
    const dur = Math.max(0.3, Math.abs(toY - this.cur.y) / pxPerSec);
    this.seg('climb', dur);
    this.cur.t += dur;
    this.cur.y = toY;
    this.key();
  }

  /** Let go of the wall and drop to the floor, drifting a little away from it. */
  fall(driftP: number, gravity: number): void {
    const dur = Math.max(0.2, Math.sqrt((2 * this.cur.y) / gravity));
    this.seg('fall', dur);
    this.cur.t += dur;
    this.cur.p = Math.min(1, Math.max(0, this.cur.p + driftP));
    this.cur.y = 0;
    this.key();
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Plans one cat's looping cycle. */
export function planCat(rand: () => number, opts: { scale: number; heightPx: number; bouncer: boolean; coat: number; target?: number }): CatPlan {
  const { scale: s, heightPx: H } = opts;
  const gravity = 520 * s;
  const range = (a: number, b: number): number => a + rand() * (b - a);
  const topRoom = Math.max(0, H - TOP_ROWS * s);
  const p0 = range(0.08, 0.92);
  const tl = new Timeline(p0, rand() < 0.5);
  const target = opts.target ?? range(24, 40);
  tl.hold(opts.bouncer ? 'land' : 'sit', range(1, 3));

  const randomTarget = (maxDist: number): number => {
    const dir = rand() < 0.5 ? -1 : 1;
    let p = tl.cur.p + dir * range(0.08, maxDist);
    if (p < 0.02 || p > 0.98) p = tl.cur.p - dir * range(0.08, maxDist);
    return clamp(p, 0, 1);
  };

  if (opts.bouncer) {
    let dir: 1 | -1 = rand() < 0.5 ? -1 : 1;
    while (tl.cur.t < target) {
      const h = Math.max(20, range(0.3, 0.8) * topRoom);
      let p1 = tl.cur.p + dir * range(0.06, 0.16);
      if (p1 < 0 || p1 > 1) {
        dir = dir === 1 ? -1 : 1;
        p1 = clamp(tl.cur.p + dir * range(0.06, 0.16), 0, 1);
      }
      tl.arc(h, p1, gravity);
      tl.hold('land', 0.12);
    }
    // Close the loop: the last hop lands exactly where the cycle started.
    tl.arc(Math.max(20, range(0.3, 0.6) * topRoom), p0, gravity);
    tl.hold('land', 0.12);
  } else {
    while (tl.cur.t < target) {
      const r = rand();
      if (r < 0.18) {
        tl.hold('sit', range(3, 6));
      } else if (r < 0.26) {
        tl.hold('idle', range(2, 4.5));
      } else if (r < 0.38) {
        tl.hold('lie', range(3, 5));
        if (rand() < 0.65) tl.hold('sleep', range(6, 11));
      } else if (r < 0.46) {
        tl.hold('swipe', range(1.6, 3));
      } else if (r < 0.60) {
        tl.move('walk', randomTarget(0.35), SPEED.walk);
      } else if (r < 0.70) {
        tl.move('run', randomTarget(0.6), SPEED.run);
      } else if (r < 0.78) {
        const hops = 1 + Math.floor(rand() * 3);
        for (let i = 0; i < hops; i++) {
          tl.arc(Math.max(12, range(18, 34) * s), clamp(tl.cur.p + (rand() < 0.5 ? -1 : 1) * range(0.02, 0.08), 0, 1), gravity);
          tl.hold('land', 0.28);
        }
      } else if (r < 0.88) {
        // Chase a yarn ball: it rolls just ahead of the cat; keep room for it on the facing side.
        const dir = rand() < 0.5 ? -1 : 1;
        const startP = dir === 1 ? range(0.05, 0.4) : range(0.6, 0.95);
        if (Math.abs(startP - tl.cur.p) > 0.02) tl.move('run', startP, SPEED.run);
        const endP = clamp(startP + dir * range(0.25, 0.45), dir === 1 ? 0.2 : 0.15, dir === 1 ? 0.8 : 0.95);
        tl.cur.flip = dir === -1;
        tl.move('chase', endP, SPEED.chase);
        tl.hold('idle', range(1, 2));
      } else {
        // Run to the nearest wall, climb, hang there, then climb down or drop.
        const wall = tl.cur.p < 0.5 ? 0 : 1;
        if (Math.abs(wall - tl.cur.p) > 0.01) tl.move('run', wall, SPEED.run);
        tl.cur.flip = wall === 0;
        const top = Math.max(3 * s, range(0.25, 0.7) * topRoom);
        tl.climb(top, 22 * s);
        tl.hold('grab', range(1.6, 3.2));
        if (rand() < 0.5) {
          tl.climb(0, 22 * s);
        } else {
          tl.fall(wall === 0 ? 0.02 : -0.02, gravity);
        }
        tl.hold('land', 0.28);
        tl.move('walk', clamp(wall === 0 ? 0.12 : 0.88, 0, 1), SPEED.walk);
      }
    }
    // Close the loop: run back to where the cycle started.
    if (Math.abs(tl.cur.p - p0) > 0.01) tl.move('run', p0, SPEED.run);
    tl.hold('sit', range(1, 2));
  }
  // The cycle starts in the pose it ends in: same facing at the start position.
  tl.segs[0].flip = tl.cur.flip;
  const duration = tl.cur.t;
  return {
    coat: opts.coat,
    yarn: Math.floor(rand() * YARN_COLORS.length),
    duration,
    keys: tl.keys,
    segs: tl.segs,
    bouncer: opts.bouncer,
    phase: range(0, duration)
  };
}

/** Plans a scene: about a quarter of the cats (at least one) bounce, the rest live on floor and walls. */
export function planScene(o: SceneOptions): CatPlan[] {
  const rand = mulberry32(o.seed);
  const n = Math.max(1, Math.floor(o.cats));
  const bouncers = Math.max(1, Math.round(n / 4));
  const order = Array.from({ length: COATS.length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const isBouncer = new Set(Array.from({ length: n }, (_, i) => i).sort(() => rand() - 0.5).slice(0, bouncers));
  return Array.from({ length: n }, (_, i) =>
    planCat(rand, { scale: o.scale, heightPx: o.heightPx, bouncer: isBouncer.has(i), coat: order[i % order.length] })
  );
}

// ---------------------------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------------------------

const f = (v: number): string => String(Math.round(v * 1000) / 1000);

export function sceneMetrics(scale: number): { c0: number; span: number } {
  const c0 = CONTENT_MIN_COL * scale;
  const c1 = (CONTENT_MAX_COL + 1) * scale;
  return { c0, span: c1 - c0 };
}

/** Position of a plan at time t (linear between keyframes). */
export function positionAt(keys: readonly Keyframe[], t: number): { p: number; y: number } {
  if (t <= keys[0].t) return { p: keys[0].p, y: keys[0].y };
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      const u = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return { p: a.p + (b.p - a.p) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  const last = keys[keys.length - 1];
  return { p: last.p, y: last.y };
}

/**
 * Resamples keyframes on the scene clock for stepped playback. Samples equal to the previous one are dropped:
 * a stepped animation simply holds the value.
 */
export function stepKeys(keys: readonly Keyframe[], ticks: number, hz = SCENE_TICK_HZ): Keyframe[] {
  const out: Keyframe[] = [];
  for (let i = 0; i < ticks; i++) {
    const { p, y } = positionAt(keys, i / hz);
    const q = Math.round(p * 1000) / 1000;
    const h = Math.round(y);
    const prev = out[out.length - 1];
    if (!prev || prev.p !== q || prev.y !== h) out.push({ t: i / hz, p: q, y: h });
  }
  return out;
}

/** Cycle length in clock ticks (the plan is played as a whole number of ticks). */
export function cycleTicks(plan: CatPlan): number {
  return Math.max(2, Math.ceil(plan.duration * SCENE_TICK_HZ));
}

export interface Cell {
  /** Strip cell name (a frame name, or `chase0..3`). */
  name: string;
  flip: boolean;
}

/** The sprite cell shown at every tick of the cycle (pose animation frames advance with the clock). */
export function cellTimeline(plan: CatPlan): Cell[] {
  const ticks = cycleTicks(plan);
  const out: Cell[] = [];
  let si = 0;
  for (let i = 0; i < ticks; i++) {
    const t = i / SCENE_TICK_HZ;
    while (si < plan.segs.length - 1 && t >= plan.segs[si].t1 - 1e-9) si++;
    const seg = plan.segs[si];
    const local = Math.max(0, i - Math.round(seg.t0 * SCENE_TICK_HZ));
    const animName: AnimName = seg.variant === 'chase' ? 'run' : seg.variant;
    const anim = ANIMATIONS[animName];
    const idx = Math.floor((local * SCENE_FPS[animName]) / SCENE_TICK_HZ) % anim.frames.length;
    out.push({ name: seg.variant === 'chase' ? `chase${idx % 4}` : anim.frames[idx], flip: seg.flip });
  }
  return out;
}

/** Cell names a set of plans needs (for the shared definitions). */
export function planCells(plans: readonly CatPlan[]): Set<string> {
  const set = new Set<string>();
  for (const p of plans) for (const c of cellTimeline(p)) set.add(c.name);
  return set;
}

const pct = (v: number): string => String(Math.round(v * 100000) / 1000);

interface CatCss {
  markup: string;
  css: string;
}

/**
 * One cat as markup + CSS: exactly TWO animations. The outer group moves (translate with percent of the width plus
 * a pixel correction); inside it a clipped window shows one cell of the cat's sprite strip, and the strip slides
 * (step-end) to pick the frame and facing. Both advance on the shared 12 Hz clock, so the overlay repaints only
 * when something changes, and the renderer has two animations per cat to service instead of dozens.
 */
function catMarkup(plan: CatPlan, scale: number, idx: number): CatCss {
  const { c0, span } = sceneMetrics(scale);
  const ticks = cycleTicks(plan);
  const D = ticks / SCENE_TICK_HZ;
  const delay = -(Math.round(plan.phase * SCENE_TICK_HZ) / SCENE_TICK_HZ);
  const anim = (name: string): string => `animation:${name} ${f(D)}s step-end ${f(delay)}s infinite`;
  const box = FRAME_SIZE * scale;

  const move = stepKeys(plan.keys, ticks).map((k) => {
    const x = `calc(${f(k.p * 100)}% - ${f(c0 + k.p * span)}px)`;
    const y = `calc(100% - ${f(k.y + FEET_ROWS * scale)}px)`;
    return `${pct(k.t / D)}%{transform:translate(${x},${y})}`;
  });

  // Strip: one column per distinct (cell, facing) pair the cat shows.
  const timeline = cellTimeline(plan);
  const columns = new Map<string, number>();
  for (const c of timeline) {
    const key = `${c.name}|${c.flip}`;
    if (!columns.has(key)) columns.set(key, columns.size);
  }
  const slide: string[] = [];
  let prevCol = -1;
  timeline.forEach((c, i) => {
    const col = columns.get(`${c.name}|${c.flip}`) as number;
    if (col !== prevCol) {
      slide.push(`${pct(i / SCENE_TICK_HZ / D)}%{transform:translate(${f(-col * box)}px,0)}`);
      prevCol = col;
    }
  });
  const strip = [...columns.keys()]
    .map((key, col) => {
      const [name, flip] = key.split('|');
      const place = flip === 'true' ? `translate(${(col + 1) * FRAME_SIZE} 0) scale(-1 1)` : `translate(${col * FRAME_SIZE} 0)`;
      return `<use href="#cell-${name}" transform="${place}"/>`;
    })
    .join('');

  const css =
    `@keyframes m${idx}{${move.join('')}}.m${idx}{${anim(`m${idx}`)}}` +
    `@keyframes f${idx}{${slide.join('')}}.f${idx}{${anim(`f${idx}`)}}`;
  const vars = `${coatVars(plan.coat)};${yarnVars(plan.yarn)}`;
  const markup =
    `<g class="m${idx}"><svg width="${box}" height="${box}" style="${vars}"><g class="f${idx}">` +
    `<g transform="scale(${scale})">${strip}</g></g></svg></g>`;
  return { markup, css };
}

/**
 * One standalone SVG (`width="100%" height="100%"`) with all cats of the plan, animated by CSS only.
 * Cat positions are percentages of the width, so the scene fits any box it is stretched over.
 */
export function buildSceneSvg(plans: readonly CatPlan[], scale: number): string {
  const cells = [...planCells(plans)].sort();
  const defs = cells.map((c) => `<g id="cell-${c}">${cellMarkup(c)}</g>`).join('');
  const cats = plans.map((p, i) => catMarkup(p, scale, i));
  const style = sceneStyle().replace('</style>', `${cats.map((c) => c.css).join('')}</style>`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" shape-rendering="crispEdges">` +
    style +
    `<defs>${defs}</defs>` +
    cats.map((c) => c.markup).join('') +
    `</svg>`
  );
}

export function sceneDataUri(plans: readonly CatPlan[], scale: number): string {
  return svgToDataUri(buildSceneSvg(plans, scale));
}
