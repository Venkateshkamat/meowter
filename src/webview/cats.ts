/* Runs inside the break webview. Compiled separately (DOM lib); scripts/bundle-webview.js
   prepends the shared cat art (src/catArt.ts) as the global `CatArt` and the shared
   style assignment (src/catStyles.ts) as `CatStyles`. */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
declare const CatArt: typeof import('../catArt');
declare const CatStyles: typeof import('../catStyles');
type CatStyle = import('../catStyles').CatStyle;

(function () {
  const vscodeApi = acquireVsCodeApi();

  type State =
    | 'idle'
    | 'sit'
    | 'lie'
    | 'sleep'
    | 'swipe'
    | 'walk'
    | 'run'
    | 'chase'
    | 'jump'
    | 'fall'
    | 'land'
    | 'climb'
    | 'grab'
    | 'bounce'
    | 'hiss'
    | 'fight';

  interface Ball {
    el: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    x: number;
    y: number;
    vx: number;
    vy: number;
    roll: number;
    phase: number;
    color: number;
  }

  type PairPhase = 'rest' | 'stalk' | 'hiss' | 'swat' | 'lunge' | 'cloud' | 'burst' | 'break' | 'land' | 'backoff' | 'chase';

  /** Two Fighters and the choreography they share: square up, hiss, swat, rush into a fight cloud, break apart... */
  interface Pair {
    a: Cat;
    b: Cat;
    /** The part of the width this pair keeps to (fractions of the free width), so pairs do not crowd one spot. */
    band: readonly [number, number];
    phase: PairPhase;
    timer: number;
    /** Whether this round already had a swat exchange; which half of the swat exchange is running (0 or 1). */
    swatted: boolean;
    swatHalf: 0 | 1;
    /** Sideways roll of the fight cloud. */
    rollVx: number;
    /** The cat running away in a chase. */
    runner: Cat | undefined;
  }

  interface Cat {
    el: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    frameKey: string;
    coat: number;
    /** Left / top of the sprite box in px. */
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** 1 = facing right, -1 = facing left. */
    dir: 1 | -1;
    state: State;
    timer: number;
    animTime: number;
    /** Wall being climbed: 1 = right, -1 = left. */
    wall: 1 | -1;
    climbTop: number;
    climbDown: boolean;
    /** 0 = hanging for the first time on this climb, 1 = already went higher once. */
    stage: 0 | 1;
    /** The movement style: which moves this cat picks (see FLOOR_STATES) and what it does at a wall. */
    style: CatStyle;
    /** Which Climber this is (0, 1, 2...) and how many climbs it has made: they spread climbers over the walls and heights. */
    slot: number;
    climbs: number;
    /** A Climber on its way to a wall (1 = right, -1 = left), or 0. */
    seekWall: 1 | -1 | 0;
    /** The fight this cat is in (Fighters come as a pair), or undefined. */
    pair: Pair | undefined;
    ball: Ball | undefined;
  }

  /**
   * What each style does on the floor, with weights. Wanderers never chase or climb; Yarn chasers mostly chase;
   * Climbers' main business (heading to a wall) is decided in pickFloorState; Bouncers only bounce.
   */
  const FLOOR_STATES: Record<CatStyle, Array<[State, number]>> = {
    wanderer: [
      ['idle', 7],
      ['sit', 12],
      ['lie', 9],
      ['sleep', 7],
      ['swipe', 8],
      ['walk', 18],
      ['run', 10],
      ['jump', 9]
    ],
    climber: [
      ['idle', 3],
      ['sit', 4],
      ['swipe', 3],
      ['walk', 10],
      ['run', 8],
      ['jump', 3]
    ],
    bouncer: [['idle', 1]],
    fighters: [['idle', 1]],
    yarnChaser: [
      ['chase', 40],
      ['idle', 8],
      ['sit', 8],
      ['swipe', 6],
      ['lie', 3],
      ['walk', 4]
    ]
  };

  function rand(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  function clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
  }

  const stage = document.getElementById('stage') as HTMLDivElement;
  const requested = parseInt(document.body.dataset.catCount ?? '6', 10);
  const catCount = clamp(Number.isFinite(requested) ? requested : 6, 2, 30);

  const SIZE = CatArt.FRAME_SIZE;
  const YARN_N = CatArt.YARN_SIZE + 2;

  let W = window.innerWidth;
  let H = window.innerHeight;
  let scale = 4;
  const cats: Cat[] = [];
  const frameCache = new Map<string, ImageData>();

  function pickScale(): number {
    return clamp(Math.floor(Math.min(W / 170, H / 115)), 4, 6);
  }

  // Physics, in px; speeds are multiples of the pixel scale so cats look the same at any size.
  const gravity = (): number => 520 * scale;
  const floorY = (): number => H - CatArt.FEET_ROWS * scale;
  const minX = (): number => -CatArt.CONTENT_MIN_COL * scale;
  const maxX = (): number => W - (CatArt.CONTENT_MAX_COL + 1) * scale;

  function imageFor(coat: number, frame: string): ImageData {
    const key = `${coat}|${frame}`;
    let img = frameCache.get(key);
    if (!img) {
      const px = CatArt.frameRgba(coat, frame);
      img = new ImageData(px.data, px.width, px.height);
      frameCache.set(key, img);
    }
    return img;
  }

  function animFor(cat: Cat): import('../catArt').AnimName {
    switch (cat.state) {
      case 'idle':
        return 'idle';
      case 'sit':
        return 'sit';
      case 'lie':
        return 'lie';
      case 'sleep':
        return 'sleep';
      case 'swipe':
        return 'swipe';
      case 'walk':
        return 'walk';
      case 'run':
      case 'chase':
        return 'run';
      case 'land':
        return 'land';
      case 'climb':
        return 'climb';
      case 'grab':
        return 'grab';
      case 'fall':
        return 'fall';
      case 'hiss':
        return 'hiss';
      case 'fight':
        return 'fight';
      default:
        return cat.vy < 0 ? 'jump' : 'fall';
    }
  }

  function draw(cat: Cat): void {
    const anim = CatArt.ANIMATIONS[animFor(cat)];
    const count = anim.frames.length;
    const raw = Math.floor(cat.animTime * anim.fps);
    // Safe modulo: never negative (or NaN), whatever animTime is.
    const idx = Number.isFinite(raw) ? ((raw % count) + count) % count : 0;
    const name = anim.frames[idx];
    const key = `${cat.coat}|${name}`;
    if (key !== cat.frameKey) {
      cat.frameKey = key;
      cat.ctx.putImageData(imageFor(cat.coat, name), 0, 0);
    }
    cat.el.style.transform = `translate(${Math.round(cat.x)}px, ${Math.round(cat.y)}px) scaleX(${cat.dir})`;
    cat.el.style.zIndex = String(Math.floor(cat.y + SIZE * scale));
  }

  function setState(cat: Cat, state: State): void {
    cat.state = state;
    cat.animTime = 0;
  }

  function dropBall(cat: Cat): void {
    if (cat.ball) {
      cat.ball.el.remove();
      cat.ball = undefined;
    }
  }

  function makeBall(cat: Cat): Ball {
    const el = document.createElement('canvas');
    el.className = 'ball';
    el.width = YARN_N;
    el.height = YARN_N;
    el.style.width = `${YARN_N * scale}px`;
    el.style.height = `${YARN_N * scale}px`;
    stage.appendChild(el);
    const ctx = el.getContext('2d') as CanvasRenderingContext2D;
    const color = Math.floor(Math.random() * CatArt.YARN_COLORS.length);
    const ahead = cat.x + (cat.dir === 1 ? SIZE * scale * 1.1 : -YARN_N * scale * 0.4);
    return {
      el,
      ctx,
      x: clamp(ahead + cat.dir * rand(20, 60) * scale, 0, W - YARN_N * scale),
      y: H - YARN_N * scale,
      vx: cat.dir * 30 * scale,
      vy: 0,
      roll: 0,
      phase: -1,
      color
    };
  }

  function stepBall(b: Ball, dt: number): void {
    b.vy += gravity() * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    const floor = H - YARN_N * scale;
    if (b.y >= floor) {
      b.y = floor;
      b.vy = Math.abs(b.vy) > 25 * scale ? -b.vy * 0.45 : 0;
      b.vx *= Math.max(0, 1 - 0.7 * dt);
    }
    const maxBx = W - YARN_N * scale;
    if (b.x < 0) {
      b.x = 0;
      b.vx = Math.abs(b.vx) * 0.8;
    } else if (b.x > maxBx) {
      b.x = maxBx;
      b.vx = -Math.abs(b.vx) * 0.8;
    }
    b.roll += b.vx * dt;
    const phase = ((Math.floor(b.roll / (scale * 2.2)) % 4) + 4) % 4;
    if (phase !== b.phase) {
      b.phase = phase;
      const px = CatArt.yarnRgba(b.color, phase);
      b.ctx.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
    }
    b.el.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`;
    b.el.style.zIndex = String(Math.floor(b.y + YARN_N * scale));
  }

  function pickFloorState(cat: Cat): void {
    dropBall(cat);
    cat.vx = 0;
    cat.vy = 0;
    cat.seekWall = 0;
    if (cat.pair) {
      return; // a fighter does what the fight asks (see stepPair)
    }
    if (cat.style === 'bouncer') {
      startBounce(cat);
      return;
    }
    if (cat.style === 'climber' && Math.random() < 0.5) {
      goToWall(cat);
      return;
    }
    const states = FLOOR_STATES[cat.style];
    const total = states.reduce((sum, [, w]) => sum + w, 0);
    const roll = (): State => {
      let r = Math.random() * total;
      for (const [s, w] of states) {
        r -= w;
        if (r <= 0) {
          return s;
        }
      }
      return states[0][0];
    };
    let next = roll();
    // Not the same thing twice in a row (a second roll), so a cat does not look stuck.
    if (next === cat.state) {
      next = roll();
    }
    if (next === 'sleep' && cat.state !== 'lie' && Math.random() < 0.7) {
      next = 'lie';
    }
    beginFloorState(cat, next);
  }

  /** A Climber sets off for a side wall, running or (a short way) strolling. */
  function goToWall(cat: Cat): void {
    cat.y = floorY();
    // Climbers share the walls out: by slot and climb number they alternate sides (now and then the other one).
    const wall: 1 | -1 = ((cat.slot + cat.climbs) % 2 === 0) !== (Math.random() < 0.25) ? -1 : 1;
    const dist = Math.abs((wall === 1 ? maxX() : minX()) - cat.x);
    const stroll = dist < W * 0.4 && Math.random() < 0.4;
    cat.dir = wall;
    cat.seekWall = wall;
    cat.vx = wall * (stroll ? rand(12, 18) : rand(38, 52)) * scale;
    setState(cat, stroll ? 'walk' : 'run');
    cat.timer = 99;
  }

  function beginFloorState(cat: Cat, next: State): void {
    cat.y = floorY();
    setState(cat, next);
    switch (next) {
      case 'idle':
        cat.timer = cat.style === 'yarnChaser' ? rand(1, 2.5) : rand(2, 4.5);
        break;
      case 'sit':
        cat.timer = cat.style === 'yarnChaser' ? rand(1.5, 3) : rand(3, 6);
        break;
      case 'lie':
        cat.timer = cat.style === 'yarnChaser' ? rand(2, 3) : rand(3, 5);
        break;
      case 'sleep':
        cat.timer = rand(6, 12);
        break;
      case 'swipe':
        cat.timer = cat.style === 'yarnChaser' ? rand(1.2, 2) : rand(1.6, 3);
        break;
      case 'walk':
        cat.dir = Math.random() < 0.5 ? 1 : -1;
        cat.vx = cat.dir * rand(12, 18) * scale;
        cat.timer = cat.style === 'yarnChaser' ? rand(2, 4) : rand(3, 7);
        break;
      case 'run':
        cat.dir = Math.random() < 0.5 ? 1 : -1;
        cat.vx = cat.dir * rand(38, 52) * scale;
        cat.timer = rand(2, 4);
        break;
      case 'jump':
        cat.vy = -Math.sqrt(2 * gravity() * rand(18, 34) * scale);
        cat.vx = Math.random() < 0.65 ? cat.dir * rand(15, 45) * scale : 0;
        cat.timer = 99;
        break;
      case 'chase':
        cat.ball = makeBall(cat);
        cat.timer = rand(6, 9);
        break;
      default:
        cat.timer = 2;
    }
  }

  function startClimb(cat: Cat, wall: 1 | -1): void {
    cat.wall = wall;
    cat.dir = wall;
    cat.x = wall === 1 ? maxX() : minX();
    cat.vx = 0;
    cat.vy = -rand(20, 26) * scale;
    // ...and spread over the height, so climbers do not stack up on the same spot.
    const spread = (cat.slot * 0.618 + cat.climbs * 0.31 + rand(0, 0.04)) % 1;
    cat.climbTop = floorY() * (0.2 + 0.5 * spread);
    cat.climbs++;
    cat.climbDown = false;
    cat.stage = 0;
    cat.seekWall = 0;
    setState(cat, 'climb');
    cat.timer = 99;
  }

  function startBounce(cat: Cat): void {
    const maxH = Math.max(40, floorY() - 8);
    const h = rand(0.3, 0.8) * maxH;
    cat.y = Math.min(cat.y, floorY());
    cat.vy = -Math.sqrt(2 * gravity() * h);
    cat.vx = cat.dir * rand(30, 70) * scale;
    setState(cat, 'bounce');
  }

  // ---- Fighters: a pair of cats on the floor ----

  /** How close two fighters stand when they face off (sprite box to sprite box): 1.15 sprite widths, so they never overlap. */
  const faceOff = (): number => 1.15 * (CatArt.CONTENT_MAX_COL - CatArt.CONTENT_MIN_COL + 1) * scale;
  /** The pair's band in px. */
  const bandMin = (pair: Pair): number => minX() + pair.band[0] * Math.max(0, maxX() - minX());
  const bandMax = (pair: Pair): number => minX() + pair.band[1] * Math.max(0, maxX() - minX());
  /** The cloud and the break-away stay this far from the band's edges, so the two cats never end up on top of each other. */
  const cloudMargin = (pair: Pair): number => Math.min(40 * scale, Math.max(0, (bandMax(pair) - bandMin(pair)) / 4));

  function setFight(cat: Cat, state: State, vx: number): void {
    setState(cat, state);
    cat.vx = vx;
    cat.vy = 0;
  }

  /** Both cats look at each other (the cat on the left looks right). */
  function facePair(pair: Pair): void {
    const left = pair.a.x <= pair.b.x ? pair.a : pair.b;
    const right = left === pair.a ? pair.b : pair.a;
    left.dir = 1;
    right.dir = -1;
  }

  function enterPhase(pair: Pair, phase: PairPhase): void {
    const { a, b } = pair;
    const left = a.x <= b.x ? a : b;
    const right = left === a ? b : a;
    pair.phase = phase;
    a.y = floorY();
    b.y = floorY();
    switch (phase) {
      case 'rest':
        facePair(pair);
        setFight(a, 'idle', 0);
        setFight(b, 'idle', 0);
        pair.timer = rand(1, 2);
        break;
      case 'stalk': {
        pair.swatted = false;
        facePair(pair);
        const speed = rand(12, 18) * scale;
        setFight(left, 'walk', speed);
        setFight(right, 'walk', -speed);
        pair.timer = 10;
        break;
      }
      case 'hiss':
        facePair(pair);
        setFight(a, 'hiss', 0);
        setFight(b, 'hiss', 0);
        pair.timer = rand(1.4, 2.4);
        break;
      case 'swat':
        // One swings while the other hisses, then the other way round.
        facePair(pair);
        pair.swatHalf = 0;
        setFight(a, 'swipe', 0);
        setFight(b, 'hiss', 0);
        pair.timer = rand(1.2, 1.8);
        break;
      case 'lunge': {
        facePair(pair);
        const speed = 48 * scale;
        setFight(left, 'run', speed);
        setFight(right, 'run', -speed);
        pair.timer = 1 + Math.abs(a.x - b.x) / (2 * speed);
        break;
      }
      case 'cloud': {
        const mid = clamp((left.x + right.x) / 2, bandMin(pair) + cloudMargin(pair), bandMax(pair) - cloudMargin(pair));
        a.x = mid;
        b.x = mid;
        a.dir = 1;
        b.dir = -1;
        pair.rollVx = (Math.random() < 0.5 ? -1 : 1) * rand(8, 16) * scale;
        setFight(a, 'fight', 0);
        setFight(b, 'fight', 0);
        pair.timer = rand(2.6, 4.2);
        break;
      }
      case 'burst': {
        // The cloud bursts: the cats pull out of it a little way apart, so they are not on top of each other.
        const v = (0.04 * Math.max(0, maxX() - minX())) / 0.35;
        setFight(a, 'fight', -v);
        setFight(b, 'fight', v);
        pair.timer = 0.35;
        break;
      }
      case 'break': {
        // Both jump back, away from each other, still looking at each other.
        const h = rand(18, 30) * scale;
        for (const [cat, away] of [[a, -1], [b, 1]] as const) {
          setFight(cat, 'jump', away * rand(36, 50) * scale);
          cat.vy = -Math.sqrt(2 * gravity() * h);
          cat.dir = away === -1 ? 1 : -1;
        }
        pair.timer = 99;
        break;
      }
      case 'land':
        facePair(pair);
        setFight(a, 'land', 0);
        setFight(b, 'land', 0);
        pair.timer = 0.28;
        break;
      case 'backoff': {
        // Back away, still facing each other.
        facePair(pair);
        const speed = rand(9, 14) * scale;
        setFight(left, 'walk', -speed);
        setFight(right, 'walk', speed);
        left.dir = 1;
        right.dir = -1;
        pair.timer = rand(1.4, 2.4);
        break;
      }
      case 'chase': {
        // The cat with more room runs away from the other, which runs after it for a short way.
        const roomLeft = left.x - bandMin(pair);
        const roomRight = bandMax(pair) - right.x;
        const runner = roomLeft > roomRight ? left : right;
        const chaser = runner === left ? right : left;
        const dir: 1 | -1 = runner === left ? -1 : 1;
        const speed = 44 * scale;
        pair.runner = runner;
        setFight(runner, 'run', dir * speed);
        setFight(chaser, 'run', dir * speed);
        runner.dir = dir;
        chaser.dir = dir;
        pair.timer = rand(1.2, 2);
        break;
      }
    }
  }

  /** What follows a break: another hiss, backing off, a chase or a rest. */
  function afterBreak(pair: Pair): void {
    const r = Math.random();
    enterPhase(pair, r < 0.35 ? 'hiss' : r < 0.6 ? 'backoff' : r < 0.85 ? 'chase' : 'rest');
  }

  /** Runs the shared choreography of a fighting pair once per frame. */
  function stepPair(pair: Pair, dt: number): void {
    const { a, b } = pair;
    pair.timer -= dt;
    const gap = Math.abs(a.x - b.x);
    switch (pair.phase) {
      case 'rest':
        if (pair.timer <= 0) {
          enterPhase(pair, 'stalk');
        }
        break;
      case 'stalk':
        if (gap <= faceOff() || pair.timer <= 0) {
          enterPhase(pair, 'hiss');
        }
        break;
      case 'hiss':
        if (pair.timer <= 0) {
          if (gap > faceOff() * 1.5) {
            enterPhase(pair, 'stalk');
          } else if (!pair.swatted && Math.random() < 0.6) {
            pair.swatted = true;
            enterPhase(pair, 'swat');
          } else {
            enterPhase(pair, 'lunge');
          }
        }
        break;
      case 'swat':
        if (pair.timer <= 0) {
          if (pair.swatHalf === 0) {
            pair.swatHalf = 1;
            setFight(a, 'hiss', 0);
            setFight(b, 'swipe', 0);
            pair.timer = rand(1.2, 1.8);
          } else {
            enterPhase(pair, 'lunge');
          }
        }
        break;
      case 'lunge': {
        // Each runs at the other; once they meet, the fight cloud starts.
        if (gap <= 4 * scale || pair.timer <= 0) {
          enterPhase(pair, 'cloud');
        }
        break;
      }
      case 'cloud': {
        a.vx = pair.rollVx;
        b.vx = pair.rollVx;
        const lo = bandMin(pair) + cloudMargin(pair);
        const hi = bandMax(pair) - cloudMargin(pair);
        if ((a.x <= lo && pair.rollVx < 0) || (a.x >= hi && pair.rollVx > 0)) {
          pair.rollVx = -pair.rollVx;
        }
        b.x = a.x;
        if (pair.timer <= 0) {
          enterPhase(pair, 'burst');
        }
        break;
      }
      case 'burst':
        if (pair.timer <= 0) {
          enterPhase(pair, 'break');
        }
        break;
      case 'break':
        if (a.state === 'land' && b.state === 'land') {
          enterPhase(pair, 'land');
        }
        break;
      case 'land':
        if (pair.timer <= 0) {
          afterBreak(pair);
        }
        break;
      case 'backoff':
        if (pair.timer <= 0) {
          enterPhase(pair, 'rest');
        }
        break;
      case 'chase': {
        const runner = pair.runner ?? a;
        const atWall = runner.x <= bandMin(pair) + 4 * scale || runner.x >= bandMax(pair) - 4 * scale;
        if (pair.timer <= 0 || atWall) {
          enterPhase(pair, 'hiss');
        }
        break;
      }
    }
  }

  /** One frame of a fighter: the pair logic runs once (from the first cat), then each cat moves. */
  function stepFighter(cat: Cat, dt: number): void {
    const pair = cat.pair as Pair;
    cat.animTime += dt;
    if (pair.a === cat) {
      stepPair(pair, dt);
    }
    const floor = floorY();
    if (cat.state === 'jump' || cat.state === 'fall') {
      cat.vy += gravity() * dt;
      cat.x += cat.vx * dt;
      cat.y += cat.vy * dt;
      cat.x = clamp(cat.x, bandMin(pair), Math.max(bandMin(pair), bandMax(pair)));
      if (cat.y >= floor && cat.vy > 0) {
        cat.y = floor;
        cat.vy = 0;
        cat.vx = 0;
        setState(cat, 'land');
      }
    } else {
      cat.y = floor;
      cat.x = clamp(cat.x + cat.vx * dt, bandMin(pair), Math.max(bandMin(pair), bandMax(pair)));
    }
    draw(cat);
  }

  function stepCat(cat: Cat, dt: number): void {
    if (cat.pair) {
      stepFighter(cat, dt);
      return;
    }
    cat.animTime += dt;
    cat.timer -= dt;
    const g = gravity();
    const floor = floorY();

    switch (cat.state) {
      case 'idle':
      case 'sit':
      case 'lie':
      case 'sleep':
      case 'swipe':
        if (cat.timer <= 0) {
          if (cat.state === 'lie' && cat.style !== 'yarnChaser' && Math.random() < 0.55) {
            beginFloorState(cat, 'sleep');
          } else {
            pickFloorState(cat);
          }
        }
        break;
      case 'walk':
      case 'run':
      case 'chase': {
        if (cat.state === 'chase') {
          const b = cat.ball;
          if (!b) {
            pickFloorState(cat);
            break;
          }
          stepBall(b, dt);
          const catMid = cat.x + (SIZE * scale) / 2;
          const ballMid = b.x + (YARN_N * scale) / 2;
          const diff = ballMid - catMid;
          const speed = 40 * scale;
          if (Math.abs(diff) > SIZE * scale * 0.18) {
            cat.dir = diff >= 0 ? 1 : -1;
          }
          cat.vx = cat.dir * speed;
          if (Math.abs(diff) < SIZE * scale * 0.3 && b.y > H - YARN_N * scale * 1.6) {
            // Caught up: bat the ball onward.
            b.vx = cat.dir * speed * rand(1.3, 2);
            b.vy = -rand(20, 45) * scale;
          }
        }
        cat.x += cat.vx * dt;
        cat.y = floor;
        if (cat.x <= minX() || cat.x >= maxX()) {
          const wall: 1 | -1 = cat.x >= maxX() ? 1 : -1;
          cat.x = clamp(cat.x, minX(), maxX());
          // Only Climbers climb: on purpose when they came for the wall, otherwise now and then when they bump into it.
          if (cat.style === 'climber' && cat.state !== 'chase' && (cat.seekWall === wall || Math.random() < 0.5)) {
            startClimb(cat, wall);
          } else {
            cat.dir = wall === 1 ? -1 : 1;
            cat.vx = cat.dir * Math.abs(cat.vx);
          }
        } else if (cat.state !== 'chase') {
          cat.dir = cat.vx >= 0 ? 1 : -1;
        }
        if (cat.timer <= 0) {
          pickFloorState(cat);
        }
        break;
      }
      case 'jump':
      case 'fall':
      case 'bounce': {
        cat.vy += g * dt;
        cat.x += cat.vx * dt;
        cat.y += cat.vy * dt;
        if (cat.x < minX() || cat.x > maxX()) {
          cat.x = clamp(cat.x, minX(), maxX());
          cat.vx = -cat.vx;
          if (cat.state === 'bounce' || Math.abs(cat.vx) > 1) {
            cat.dir = cat.vx >= 0 ? 1 : -1;
          }
        }
        if (Math.abs(cat.vx) > 1) {
          cat.dir = cat.vx >= 0 ? 1 : -1;
        }
        if (cat.y >= floor && cat.vy > 0) {
          cat.y = floor;
          cat.vy = 0;
          cat.vx = 0;
          setState(cat, 'land');
          cat.timer = cat.style === 'bouncer' ? 0.12 : 0.28;
        }
        break;
      }
      case 'land':
        if (cat.timer <= 0) {
          if (cat.style === 'bouncer') {
            startBounce(cat);
          } else {
            pickFloorState(cat);
          }
        }
        break;
      case 'climb': {
        cat.y += cat.vy * dt;
        if (!cat.climbDown && cat.y <= cat.climbTop) {
          cat.y = cat.climbTop;
          cat.vy = 0;
          setState(cat, 'grab');
          cat.timer = rand(1.6, 3.2);
        } else if (cat.climbDown && cat.y >= floor) {
          cat.y = floor;
          pickFloorState(cat);
        }
        break;
      }
      case 'grab':
        if (cat.timer <= 0) {
          if (cat.stage === 0 && cat.y > floor * 0.2 && Math.random() < 0.3) {
            // Not done: go a bit higher and hang again.
            cat.stage = 1;
            cat.climbTop = Math.max(floor * 0.12, cat.y - floor * rand(0.1, 0.25));
            cat.climbDown = false;
            cat.vy = -rand(20, 26) * scale;
            setState(cat, 'climb');
          } else if (Math.random() < 0.5) {
            cat.climbDown = true;
            cat.vy = rand(20, 26) * scale;
            setState(cat, 'climb');
          } else {
            // Let go and drop back down, away from the wall.
            cat.vx = -cat.wall * rand(8, 20) * scale;
            cat.vy = 0;
            cat.dir = cat.vx >= 0 ? 1 : -1;
            setState(cat, 'fall');
          }
        }
        break;
    }
    draw(cat);
  }

  function makeCat(index: number, order: number[], style: CatStyle, slot: number): Cat {
    const el = document.createElement('canvas');
    el.className = 'cat';
    el.width = SIZE;
    el.height = SIZE;
    el.style.width = `${SIZE * scale}px`;
    el.style.height = `${SIZE * scale}px`;
    stage.appendChild(el);
    const cat: Cat = {
      el,
      ctx: el.getContext('2d') as CanvasRenderingContext2D,
      frameKey: '',
      coat: order[index % order.length],
      x: rand(minX(), Math.max(minX() + 1, maxX())),
      y: floorY(),
      vx: 0,
      vy: 0,
      dir: Math.random() < 0.5 ? 1 : -1,
      state: 'idle',
      timer: 0,
      animTime: rand(0, 3),
      wall: 1,
      climbTop: 0,
      climbDown: false,
      stage: 0,
      style,
      slot,
      climbs: 0,
      seekWall: 0,
      pair: undefined,
      ball: undefined
    };
    if (style === 'bouncer') {
      // Start mid-air at a random point of a bounce so the screen fills up straight away.
      startBounce(cat);
      cat.y = rand(0.1, 0.9) * floorY();
      cat.vy = -rand(-300, 300) * scale * 0.4;
    } else if (style !== 'fighters') {
      pickFloorState(cat);
    }
    return cat;
  }

  function shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  // The first rAF timestamp can precede a performance.now() taken at load, so there is no "last"
  // until the first frame, and dt is always clamped to [0, 0.05].
  let last: number | undefined;
  const failed = new WeakSet<Cat>();

  function recover(cat: Cat): void {
    try {
      dropBall(cat);
      cat.state = 'idle';
      cat.animTime = 0;
      cat.timer = 1;
      cat.vx = 0;
      cat.vy = 0;
      cat.y = floorY();
      cat.x = clamp(cat.x, minX(), Math.max(minX(), maxX()));
      cat.frameKey = '';
    } catch {
      // nothing more to do for this cat
    }
  }

  function frame(now: number): void {
    // Re-arm first: nothing below may ever stop the loop.
    requestAnimationFrame(frame);
    const raw = last === undefined || !Number.isFinite(now) ? 0 : (now - last) / 1000;
    const dt = clamp(Number.isFinite(raw) ? raw : 0, 0, 0.05);
    if (Number.isFinite(now)) {
      last = now;
    }
    for (const cat of cats) {
      try {
        stepCat(cat, dt);
      } catch (err) {
        if (!failed.has(cat)) {
          failed.add(cat);
          console.error('Meowter: cat step failed', err);
        }
        recover(cat);
      }
    }
  }

  function onResize(): void {
    W = window.innerWidth;
    H = window.innerHeight;
    const next = pickScale();
    if (next !== scale) {
      scale = next;
      for (const cat of cats) {
        cat.el.style.width = `${SIZE * scale}px`;
        cat.el.style.height = `${SIZE * scale}px`;
        if (cat.ball) {
          cat.ball.el.style.width = `${YARN_N * scale}px`;
          cat.ball.el.style.height = `${YARN_N * scale}px`;
        }
      }
    }
    for (const cat of cats) {
      try {
        resnap(cat);
      } catch (err) {
        console.error('Meowter: cat resize failed', err);
        recover(cat);
      }
    }
  }

  /** Re-anchors a cat to the new floor / wall positions after a size change. */
  function resnap(cat: Cat): void {
    const floor = floorY();
    cat.x = clamp(cat.x, minX(), Math.max(minX(), maxX()));
    switch (cat.state) {
      case 'climb':
      case 'grab':
        // Stay glued to the wall on the same side, and inside the new height.
        cat.x = cat.wall === 1 ? maxX() : minX();
        cat.climbTop = Math.min(cat.climbTop, floor);
        cat.y = clamp(cat.y, Math.min(cat.climbTop, floor), floor);
        break;
      case 'jump':
      case 'fall':
      case 'bounce':
        cat.y = Math.min(cat.y, floor);
        break;
      default:
        // Standing on the floor (idle, sit, lie, sleep, swipe, walk, run, chase, land).
        cat.y = floor;
    }
    if (cat.ball) {
      cat.ball.x = clamp(cat.ball.x, 0, Math.max(0, W - YARN_N * scale));
      cat.ball.y = H - YARN_N * scale;
    }
    draw(cat);
  }

  scale = pickScale();
  const order = shuffle(Array.from({ length: CatArt.COATS.length }, (_, i) => i));
  // The same round-robin assignment of cats to the enabled styles as the over-code scene uses.
  const styleOf = CatStyles.assignStyles(catCount, CatStyles.parseStyleList(document.body.dataset.styles));
  let climberSlot = 0;
  for (let i = 0; i < catCount; i++) {
    cats.push(makeCat(i, order, styleOf[i], styleOf[i] === 'climber' ? climberSlot++ : 0));
  }
  // Two Fighters next to each other in the list fight each other (a lone one, which cannot happen, would wander).
  let pairTotal = 0;
  for (let i = 0; i < cats.length; i++) {
    if (cats[i].style === 'fighters' && cats[i + 1]?.style === 'fighters') {
      pairTotal++;
      i++;
    }
  }
  let pairIndex = 0;
  for (let i = 0; i < cats.length; i++) {
    if (cats[i].style === 'fighters' && cats[i + 1]?.style === 'fighters') {
      const [a, b] = [cats[i], cats[i + 1]];
      // Each pair keeps to its own band of the width (the same bands as over the code).
      const band = CatStyles.pairBand(pairIndex++, pairTotal);
      const pair: Pair = { a, b, band, phase: 'rest', timer: 1, swatted: false, swatHalf: 0, rollVx: 0, runner: undefined };
      a.pair = pair;
      b.pair = pair;
      const width = Math.max(0, bandMax(pair) - bandMin(pair));
      a.x = bandMin(pair) + rand(0, 0.3) * width;
      b.x = bandMax(pair) - rand(0, 0.3) * width;
      enterPhase(pair, 'rest');
      i++;
    } else if (cats[i].style === 'fighters') {
      cats[i].style = 'wanderer';
      pickFloorState(cats[i]);
    }
  }
  for (const cat of cats) draw(cat);
  window.addEventListener('resize', onResize);
  requestAnimationFrame(frame);
  document.body.dataset.ready = 'true';
  vscodeApi.postMessage({ type: 'ready', cats: cats.length, styles: cats.map((c) => c.style) });
})();
