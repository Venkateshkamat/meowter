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
import { assignStyles, Band, CatStyle, pairBand } from './catStyles';

/** A pose shown by the plan: any animation, or running with a yarn ball in front. */
export type Variant = AnimName | 'chase';

export interface Keyframe {
  /** Seconds from the start of the cycle. */
  t: number;
  /** Horizontal position as a fraction (0..1) of the free width. */
  p: number;
  /** Height above the floor in px. */
  y: number;
  /** Extra horizontal offset in px (default 0), for things that must stay a fixed number of px apart whatever the width. */
  dx?: number;
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
  /** The movement style this cycle was planned for. */
  style: CatStyle;
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
  /** The style of each cat (its length is the number of cats). Default: `cats` cats round-robin over all styles. */
  styles?: readonly CatStyle[];
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

/**
 * The fastest a cat may travel sideways while in the air (fractions of the width per second). An arc's duration
 * only depends on its height, so its horizontal step is limited to this, whatever the height: a low box or a
 * long way to go makes more arcs, never a faster one.
 */
export const MAX_ARC_SPEED = 0.25;

/** The most a fight cloud rolls sideways (widths per second). */
export const FIGHT_ROLL_SPEED = 0.1;

/**
 * When two fighters face off their sprites are this many sprite widths apart (the boxes never overlap and the
 * snouts do not touch). It is kept in PIXELS (see Keyframe.dx), so it holds in an editor of any width.
 */
const FACE_OFF_SPANS = 1.15;

/** Cat sprite pixels above the floor that the head never exceeds when standing. */
const TOP_ROWS = 24;

interface Cursor {
  t: number;
  p: number;
  y: number;
  /** Horizontal offset in px on top of p. */
  dx: number;
  flip: boolean;
}

class Timeline {
  readonly keys: Keyframe[] = [];
  readonly segs: Segment[] = [];
  readonly cur: Cursor;

  constructor(p0: number, flip: boolean) {
    this.cur = { t: 0, p: p0, y: 0, dx: 0, flip };
    this.keys.push({ t: 0, p: p0, y: 0 });
  }

  private seg(variant: Variant, dur: number): void {
    this.segs.push({ t0: this.cur.t, t1: this.cur.t + dur, variant, flip: this.cur.flip });
  }

  private key(): void {
    const k: Keyframe = { t: this.cur.t, p: this.cur.p, y: this.cur.y };
    if (this.cur.dx !== 0) k.dx = this.cur.dx;
    this.keys.push(k);
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

  /** Like move(), but taking exactly `dur` seconds (the speed follows); `flip` forces the facing. */
  moveDur(variant: Variant, p1: number, dur: number, flip?: boolean, dx1?: number): void {
    if (flip !== undefined) this.cur.flip = flip;
    else if (p1 !== this.cur.p) this.cur.flip = p1 < this.cur.p;
    this.seg(variant, dur);
    this.cur.t += dur;
    this.cur.p = p1;
    if (dx1 !== undefined) this.cur.dx = dx1;
    this.key();
  }

  /** A parabolic hop/bounce of height `h` px landing at `p1` (rising = 'jump', falling = 'fall'). */
  arc(h: number, p1: number, gravity: number, flip?: boolean, easeOut = false): void {
    const half = Math.sqrt((2 * h) / gravity);
    const p0 = this.cur.p;
    if (flip !== undefined) this.cur.flip = flip;
    else if (p1 !== p0) this.cur.flip = p1 < p0;
    const steps = 6;
    for (const [part, variant] of [['up', 'jump'], ['down', 'fall']] as const) {
      this.seg(variant, half);
      for (let i = 1; i <= steps; i++) {
        const u = i / steps;
        const tt = this.cur.t + half * u;
        const lin = part === 'up' ? u / 2 : 0.5 + u / 2;
        // (easeOut: push off sideways fast and settle, so two cats leaving the same spot separate at once)
        const frac = easeOut ? 1 - (1 - lin) * (1 - lin) : lin;
        const y = part === 'up' ? h * (1 - (1 - u) * (1 - u)) : h * (1 - u * u);
        const k: Keyframe = { t: tt, p: p0 + (p1 - p0) * frac, y };
        if (this.cur.dx !== 0) k.dx = this.cur.dx;
        this.keys.push(k);
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

/** Hop height range (px per scale unit) of a floor hop; also the most a Wanderer ever leaves the floor. */
export const HOP_MAX_ROWS = 34;

/**
 * Plans one cat's looping cycle in the given movement style:
 *  - wanderer: walks, runs, sits, idles, lies down, sleeps, swipes and hops, always on the floor;
 *  - climber: runs to a side wall, climbs it, hangs and grabs, climbs down or drops, with floor moves in between;
 *  - bouncer: big bouncing arcs across the middle of the screen;
 *  - yarnChaser: chases and bats a ball of yarn along the floor, with short rests.
 */
export function planCat(
  rand: () => number,
  opts: { scale: number; heightPx: number; style: CatStyle; coat: number; target?: number; slot?: number }
): CatPlan {
  const { scale: s, heightPx: H } = opts;
  // (Fighters are planned in pairs by planPair; a lone one just wanders.)
  const style: CatStyle = opts.style === 'fighters' ? 'wanderer' : opts.style;
  const gravity = 520 * s;
  const range = (a: number, b: number): number => a + rand() * (b - a);
  const topRoom = Math.max(0, H - TOP_ROWS * s);
  const p0 = range(0.08, 0.92);
  const tl = new Timeline(p0, rand() < 0.5);
  const target = opts.target ?? range(24, 40);
  const slot = opts.slot ?? 0;
  let climbs = 0;
  tl.hold(style === 'bouncer' ? 'land' : 'sit', range(1, 3));

  const randomTarget = (maxDist: number): number => {
    const dir = rand() < 0.5 ? -1 : 1;
    let p = tl.cur.p + dir * range(0.08, maxDist);
    if (p < 0.02 || p > 0.98) p = tl.cur.p - dir * range(0.08, maxDist);
    return clamp(p, 0, 1);
  };

  /** Rest or play on the spot; `short` keeps the rests brief. */
  const rest = (short: boolean): void => {
    const r = rand();
    if (r < 0.4) tl.hold('sit', short ? range(1.2, 2.5) : range(3, 6));
    else if (r < 0.7) tl.hold('idle', short ? range(1, 2) : range(2, 4.5));
    else if (r < 0.88) tl.hold('swipe', short ? range(1.2, 2) : range(1.6, 3));
    else tl.hold('lie', short ? range(1.5, 2.5) : range(3, 5));
  };

  const hops = (): void => {
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const h = Math.max(12, range(18, HOP_MAX_ROWS) * s);
      const dir = rand() < 0.5 ? -1 : 1;
      tl.arc(h, clamp(tl.cur.p + dir * arcStep(h, range(0.02, 0.08)), 0, 1), gravity);
      tl.hold('land', 0.28);
    }
  };

  /** Seconds an arc of height h takes (up and down). */
  const arcSeconds = (h: number): number => 2 * Math.sqrt((2 * h) / gravity);
  /** The horizontal step an arc of height h may take: the wanted one, but never faster than MAX_ARC_SPEED. */
  const arcStep = (h: number, wanted: number): number => Math.min(wanted, MAX_ARC_SPEED * arcSeconds(h));

  /** One wanderer action. */
  let lastWander = '';
  const wanderStep = (): void => {
    let r = rand();
    // Not the same thing twice in a row, so the cat does not look stuck in a loop.
    const kindOf = (x: number): string =>
      x < 0.16 ? 'sit' : x < 0.24 ? 'idle' : x < 0.36 ? 'lie' : x < 0.44 ? 'swipe' : x < 0.64 ? 'walk' : x < 0.78 ? 'run' : 'hop';
    if (kindOf(r) === lastWander) r = rand();
    lastWander = kindOf(r);
    if (r < 0.16) {
      tl.hold('sit', range(3, 6));
    } else if (r < 0.24) {
      tl.hold('idle', range(2, 4.5));
    } else if (r < 0.36) {
      tl.hold('lie', range(3, 5));
      if (rand() < 0.65) tl.hold('sleep', range(6, 11));
    } else if (r < 0.44) {
      tl.hold('swipe', range(1.6, 3));
    } else if (r < 0.64) {
      tl.move('walk', randomTarget(0.35), SPEED.walk);
    } else if (r < 0.78) {
      tl.move('run', randomTarget(0.6), SPEED.run);
    } else {
      hops();
    }
  };

  /** Run to a wall, climb, hang, then climb down or drop. */
  const climbStep = (): void => {
    // Climbers share the walls out: by slot and climb number they alternate sides and spread over the height,
    // so several climbers do not pile up on the same spot (now and then a cat picks the other side anyway).
    const wall = ((slot + climbs) % 2 === 0) !== (rand() < 0.25) ? 0 : 1;
    const dist = Math.abs(wall - tl.cur.p);
    if (dist > 0.01) {
      const stroll = dist < 0.4 && rand() < 0.4; // a short way to the wall may be a stroll
      tl.move(stroll ? 'walk' : 'run', wall, stroll ? SPEED.walk : SPEED.run);
    }
    tl.cur.flip = wall === 0;
    const spread = (slot * 0.618 + climbs * 0.31 + range(0, 0.04)) % 1;
    tl.climb(Math.max(3 * s, (0.2 + 0.5 * spread) * topRoom), 22 * s);
    tl.hold('grab', range(1.6, 3.2));
    if (rand() < 0.3) {
      // Not done yet: a bit higher (or back down a bit), and hang again.
      const next = clamp(tl.cur.y + (rand() < 0.6 ? 1 : -1) * range(0.1, 0.25) * topRoom, 3 * s, Math.max(3 * s, 0.85 * topRoom));
      tl.climb(next, 22 * s);
      tl.hold('grab', range(1.2, 2.4));
    }
    if (rand() < 0.5) {
      tl.climb(0, 22 * s);
    } else {
      tl.fall(wall === 0 ? 0.02 : -0.02, gravity);
    }
    tl.hold('land', 0.28);
    tl.move('walk', clamp(wall === 0 ? range(0.1, 0.2) : range(0.8, 0.9), 0, 1), SPEED.walk);
  };

  /** Chase a yarn ball along the floor, bat it, and rest a moment. */
  const chaseStep = (): void => {
    // Head for the more open side, now and then the other way.
    let dir: 1 | -1 = tl.cur.p < 0.5 ? 1 : -1;
    if (rand() < 0.2) dir = dir === 1 ? -1 : 1;
    const room = dir === 1 ? 0.95 - tl.cur.p : tl.cur.p - 0.05;
    if (room < 0.25) {
      const startP = dir === 1 ? range(0.05, 0.25) : range(0.75, 0.95);
      tl.move('run', startP, SPEED.run);
    }
    const free = dir === 1 ? 0.95 - tl.cur.p : tl.cur.p - 0.05;
    const endP = clamp(tl.cur.p + dir * range(Math.min(0.25, free), Math.min(0.5, free)), 0.02, 0.98);
    tl.cur.flip = dir === -1;
    tl.move('chase', endP, SPEED.chase);
    tl.hold('idle', range(0.8, 1.6));
    if (rand() < 0.35) rest(true);
  };

  if (style === 'bouncer') {
    let dir: 1 | -1 = rand() < 0.5 ? -1 : 1;
    while (tl.cur.t < target) {
      const h = Math.max(20, range(0.3, 0.8) * topRoom);
      let p1 = tl.cur.p + dir * arcStep(h, range(0.06, 0.16));
      if (p1 < 0 || p1 > 1) {
        dir = dir === 1 ? -1 : 1;
        p1 = clamp(tl.cur.p + dir * arcStep(h, range(0.06, 0.16)), 0, 1);
      }
      tl.arc(h, p1, gravity);
      tl.hold('land', 0.12);
    }
    // Close the loop with the same kind of arcs, steered back to where the cycle started (never one huge fast
    // hop across the screen); the last one is a short arc that lands exactly on the start position.
    for (let guard = 0; guard < 60 && Math.abs(tl.cur.p - p0) > 1e-9; guard++) {
      const h = Math.max(20, range(0.3, 0.8) * topRoom);
      const left = p0 - tl.cur.p;
      const step = Math.min(Math.abs(left), arcStep(h, range(0.06, 0.16)));
      tl.arc(h, step >= Math.abs(left) - 1e-9 ? p0 : tl.cur.p + Math.sign(left) * step, gravity);
      tl.hold('land', 0.12);
    }
    if (Math.abs(tl.cur.p - p0) > 1e-9) {
      // (cannot happen with sane inputs; keeps the loop closed regardless)
      tl.move('run', p0, SPEED.run);
    }
  } else {
    let chases = 0;
    while (tl.cur.t < target || (style === 'climber' && climbs === 0) || (style === 'yarnChaser' && chases === 0)) {
      if (style === 'wanderer') {
        wanderStep();
      } else if (style === 'climber') {
        // Floor moves in between the climbs, so it is not all wall.
        if (climbs > 0 || rand() < 0.4) {
          const r = rand();
          if (r < 0.35) tl.move('walk', randomTarget(0.3), SPEED.walk);
          else if (r < 0.6) tl.move('run', randomTarget(0.5), SPEED.run);
          else rest(true);
        }
        climbStep();
        climbs++;
      } else {
        chaseStep();
        chases++;
      }
    }
    // Close the loop: run back to where the cycle started.
    if (Math.abs(tl.cur.p - p0) > 1e-9) tl.move('run', p0, SPEED.run);
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
    style,
    phase: range(0, duration)
  };
}

/**
 * Plans a fighting PAIR on the floor: two cats on one shared timeline (same length, same start, so they stay in
 * step while looping). They square up, hiss, swat at each other, rush together into a rolling fight cloud, burst
 * apart, back off or circle, now and then one chases the other a short way, and then it starts again.
 *
 * Cat A is always the left one (it looks right), cat B the right one. The pair keeps to its `band` of the width
 * (see pairBand), so several pairs do not crowd one spot. Every move of both cats takes the same time and respects
 * the normal speed limits, and the loop closes smoothly (back at the start positions, facing each other).
 *
 * The face-off distance is kept in pixels, not as a share of the width: the two cats meet at one point (p) and
 * are held `FACE_OFF_SPANS` sprite widths apart by opposite pixel offsets (Keyframe.dx), which brings them
 * together again (dx back to 0) when they rush into the cloud. So the sprites never overlap in a face-off,
 * however wide or narrow the editor is.
 */
export function planPair(
  rand: () => number,
  opts: { scale: number; heightPx: number; coats: readonly [number, number]; band?: Band; target?: number }
): [CatPlan, CatPlan] {
  const { scale: s, heightPx: H } = opts;
  const gravity = 520 * s;
  const range = (a: number, b: number): number => a + rand() * (b - a);
  const topRoom = Math.max(0, H - TOP_ROWS * s);
  const target = opts.target ?? range(18, 28);
  const [bLo, bHi] = opts.band ?? [0.03, 0.97];
  const bw = bHi - bLo;
  /** Pixels each cat stands off the meeting point in a face-off. */
  const faceOff = (FACE_OFF_SPANS * sceneMetrics(s).span) / 2;
  // Where the two meet: not too near the edges, so neither cat is pushed outside by its face-off offset.
  let meetLo = Math.max(bLo + 0.06, 0.2);
  let meetHi = Math.min(bHi - 0.06, 0.8);
  if (meetLo > meetHi) meetLo = meetHi = clamp((bLo + bHi) / 2, 0.2, 0.8);
  // The cloud and the burst stay this far from the band's edges.
  const margin = Math.min(0.08, bw / 4);
  const gap0 = clamp(range(0.5, 0.9) * bw, Math.min(0.2, bw), bw);
  const pa0 = bLo + range(0, bw - gap0);
  const pb0 = pa0 + gap0;
  const a = new Timeline(pa0, false);
  const b = new Timeline(pb0, true);
  const t = (): number => a.cur.t;
  const faceEachOther = (): void => {
    a.cur.flip = false; // A is the left cat and looks right, B the right cat and looks left
    b.cur.flip = true;
  };
  const hold = (va: Variant, vb: Variant, dur: number): void => {
    faceEachOther();
    a.hold(va, dur);
    b.hold(vb, dur);
  };
  /** Both cats move at the same time; the time is set by the one with the longer way, at `speed`. */
  const together = (va: Variant, vb: Variant, pa: number, pb: number, speed: number, facing: 'travel' | 'each', exact = false): void => {
    const da = Math.abs(pa - a.cur.p);
    const db = Math.abs(pb - b.cur.p);
    // (a short way is walked, not run; a cat that hardly moves stands and waits, looking at the other,
    // rather than walking on the spot)
    const still = exact ? 1e-9 : 0.004;
    const variantFor = (v: Variant, d: number): Variant => (v === 'run' && d < 0.03 ? 'walk' : v);
    const secondsFor = (v: Variant, d: number): number => (d < still ? 0 : d / (v === 'walk' ? Math.min(speed, SPEED.walk) : speed));
    const dur = Math.max(0.4, secondsFor(variantFor(va, da), da), secondsFor(variantFor(vb, db), db));
    if (da < still) {
      a.cur.flip = false;
      a.hold('idle', dur);
    } else {
      a.moveDur(variantFor(va, da), pa, dur, facing === 'each' ? false : undefined);
    }
    if (db < still) {
      b.cur.flip = true;
      b.hold('idle', dur);
    } else {
      b.moveDur(variantFor(vb, db), pb, dur, facing === 'each' ? true : undefined);
    }
  };
  let clouds = 0;

  /** Stalk towards each other until they stand face to face (the pixel offsets open up on the way). */
  const stalk = (): void => {
    const mid = clamp((a.cur.p + b.cur.p) / 2, meetLo, meetHi);
    const dist = Math.max(Math.abs(mid - a.cur.p), Math.abs(mid - b.cur.p));
    const dur = Math.max(0.9, dist / SPEED.walk);
    a.moveDur('walk', mid, dur, false, -faceOff);
    b.moveDur('walk', mid, dur, true, faceOff);
  };

  const fightCloud = (): void => {
    // Rush together into one spot...
    a.moveDur('run', a.cur.p, 0.5, false, 0);
    b.moveDur('run', b.cur.p, 0.5, true, 0);
    // ...and roll around in a cloud a while, inside the band.
    const mid = a.cur.p;
    const dur = range(2.6, 4.2);
    const maxDrift = Math.min(FIGHT_ROLL_SPEED * dur * 0.9, 0.14);
    const roomLeft = Math.max(0, mid - (bLo + margin));
    const roomRight = Math.max(0, bHi - margin - mid);
    const dir = roomLeft > roomRight ? (rand() < 0.75 ? -1 : 1) : rand() < 0.75 ? 1 : -1;
    const room = dir === -1 ? roomLeft : roomRight;
    const drift = room < 0.03 ? 0 : dir * range(0.03, Math.min(maxDrift, room));
    a.moveDur('fight', mid + drift, dur, false);
    b.moveDur('fight', mid + drift, dur, true);
    clouds++;
    // The cloud bursts: the cats pull out of it a little way apart (so they are not on top of each other)...
    const centre = a.cur.p;
    a.moveDur('fight', clamp(centre - 0.03, bLo, bHi), 0.35, false);
    b.moveDur('fight', clamp(centre + 0.03, bLo, bHi), 0.35, true);
    // ...and both jump back (same height, so they stay in step), landing facing each other. The sideways push is
    // front-loaded, so they are clear of each other within a moment.
    const h = clamp(range(0.35, 0.6) * topRoom, 12 * s, Math.max(12 * s, 0.8 * topRoom));
    const airSeconds = 2 * Math.sqrt((2 * h) / gravity);
    const stepMax = (MAX_ARC_SPEED * airSeconds) / 1.5; // (the front-loaded push is 1.5 times its average speed)
    const step = (): number => Math.min(range(0.1, 0.18), stepMax);
    a.arc(h, clamp(a.cur.p - step(), bLo, bHi), gravity, false, true);
    b.arc(h, clamp(b.cur.p + step(), bLo, bHi), gravity, true, true);
    hold('land', 'land', 0.28);
  };

  const chase = (): void => {
    const gap = b.cur.p - a.cur.p;
    // Whoever has room to run away runs (the left cat to the left, the right cat to the right); the other follows.
    const need = Math.min(0.14, bw / 3);
    const aRoom = a.cur.p - bLo;
    const bRoom = bHi - b.cur.p;
    const options = [aRoom >= need ? 'a' : '', bRoom >= need ? 'b' : ''].filter(Boolean);
    if (options.length === 0 || gap < 0.05) return;
    const runnerIsA = options[Math.floor(rand() * options.length)] === 'a';
    const room = runnerIsA ? aRoom : bRoom;
    const dist = range(Math.min(0.12, room), Math.min(0.3, room));
    const dir = runnerIsA ? -1 : 1;
    const dur = dist / (SPEED.run * 0.92);
    a.moveDur('run', a.cur.p + dir * dist, dur);
    b.moveDur('run', b.cur.p + dir * dist, dur);
  };

  const backOff = (): void => {
    const da = range(0.04, 0.1);
    const db = range(0.04, 0.1);
    together('walk', 'walk', clamp(a.cur.p - da, bLo, bHi), clamp(b.cur.p + db, bLo, bHi), SPEED.walk, 'each');
  };

  hold('idle', 'idle', range(1, 2));
  let guard = 0;
  while ((t() < target || clouds === 0) && guard++ < 40) {
    stalk();
    hold('hiss', 'hiss', range(1.4, 2.4));
    if (rand() < 0.6) {
      // A swat exchange: one swings while the other hisses, then the other way round.
      hold('swipe', 'hiss', range(1.2, 1.8));
      hold('hiss', 'swipe', range(1.2, 1.8));
    }
    fightCloud();
    const r = rand();
    if (r < 0.35) {
      backOff();
      hold('hiss', 'hiss', range(1, 1.8));
    } else if (r < 0.6) {
      backOff();
      hold('idle', 'idle', range(1, 2));
    } else if (r < 0.85) {
      chase();
      hold('hiss', 'hiss', range(1, 1.8));
    } else {
      hold('sit', 'sit', range(1.5, 3));
    }
  }
  // Close the loop: go back to where the cycle started, then face each other as at the start.
  together('run', 'run', pa0, pb0, SPEED.run, 'travel', true);
  hold('idle', 'idle', range(1, 2));
  a.segs[0].flip = a.cur.flip;
  b.segs[0].flip = b.cur.flip;
  const duration = Math.max(a.cur.t, b.cur.t);
  const phase = range(0, duration);
  const yarn = Math.floor(rand() * YARN_COLORS.length);
  const make = (tl: Timeline, coat: number): CatPlan => ({ coat, yarn, duration, keys: tl.keys, segs: tl.segs, style: 'fighters', phase });
  return [make(a, opts.coats[0]), make(b, opts.coats[1])];
}

/**
 * Plans a scene. `styles` is the style of each cat (see assignStyles); by default `cats` cats are dealt out
 * round-robin over all styles. Two Fighters next to each other in the list are planned as a pair. Coats are
 * varied across cats whatever their style.
 */
export function planScene(o: SceneOptions): CatPlan[] {
  const rand = mulberry32(o.seed);
  const styles = o.styles ?? assignStyles(o.cats);
  const order = Array.from({ length: COATS.length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const plans: CatPlan[] = [];
  let climberSlot = 0;
  // Pairs spread over the width, each in its own band.
  let pairs = 0;
  for (let i = 0; i < styles.length; i++) {
    if (styles[i] === 'fighters' && styles[i + 1] === 'fighters') {
      pairs++;
      i++;
    }
  }
  let pairIndex = 0;
  for (let i = 0; i < styles.length; i++) {
    const coat = order[i % order.length];
    if (styles[i] === 'fighters' && styles[i + 1] === 'fighters') {
      const band: Band = pairBand(pairIndex++, pairs);
      plans.push(...planPair(rand, { scale: o.scale, heightPx: o.heightPx, coats: [coat, order[(i + 1) % order.length]], band }));
      i++;
    } else {
      plans.push(planCat(rand, { scale: o.scale, heightPx: o.heightPx, style: styles[i], coat, slot: styles[i] === 'climber' ? climberSlot++ : 0 }));
    }
  }
  return plans;
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
export function positionAt(keys: readonly Keyframe[], t: number): { p: number; y: number; dx: number } {
  if (t <= keys[0].t) return { p: keys[0].p, y: keys[0].y, dx: keys[0].dx ?? 0 };
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      const u = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      const dxa = a.dx ?? 0;
      return { p: a.p + (b.p - a.p) * u, y: a.y + (b.y - a.y) * u, dx: dxa + ((b.dx ?? 0) - dxa) * u };
    }
  }
  const last = keys[keys.length - 1];
  return { p: last.p, y: last.y, dx: last.dx ?? 0 };
}

/**
 * Resamples keyframes on the scene clock for stepped playback. Samples equal to the previous one are dropped:
 * a stepped animation simply holds the value.
 */
export function stepKeys(keys: readonly Keyframe[], ticks: number, hz = SCENE_TICK_HZ): Keyframe[] {
  const out: Keyframe[] = [];
  for (let i = 0; i < ticks; i++) {
    const { p, y, dx } = positionAt(keys, i / hz);
    const q = Math.round(p * 1000) / 1000;
    const h = Math.round(y);
    const d = Math.round(dx);
    const prev = out[out.length - 1];
    if (!prev || prev.p !== q || prev.y !== h || (prev.dx ?? 0) !== d) {
      const k: Keyframe = { t: i / hz, p: q, y: h };
      if (d !== 0) k.dx = d;
      out.push(k);
    }
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
    const x = `calc(${f(k.p * 100)}% - ${f(c0 + k.p * span - (k.dx ?? 0))}px)`;
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
