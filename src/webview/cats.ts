/* Runs inside the break webview. Compiled separately (DOM lib); scripts/bundle-webview.js
   prepends the shared cat art (src/catArt.ts) as the global `CatArt`. */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
declare const CatArt: typeof import('../catArt');

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
    | 'bounce';

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
    bouncer: boolean;
    ball: Ball | undefined;
  }

  const FLOOR_STATES: Array<[State, number]> = [
    ['idle', 7],
    ['sit', 12],
    ['lie', 9],
    ['sleep', 7],
    ['swipe', 8],
    ['walk', 16],
    ['run', 10],
    ['jump', 9],
    ['chase', 10]
  ];

  function rand(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  function clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
  }

  const stage = document.getElementById('stage') as HTMLDivElement;
  const pauseButton = document.getElementById('pause') as HTMLButtonElement;
  const requested = parseInt(document.body.dataset.catCount ?? '8', 10);
  const catCount = clamp(Number.isFinite(requested) ? requested : 8, 1, 30);

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
    let total = 0;
    for (const [, w] of FLOOR_STATES) total += w;
    let r = Math.random() * total;
    let next: State = 'idle';
    for (const [s, w] of FLOOR_STATES) {
      r -= w;
      if (r <= 0) {
        next = s;
        break;
      }
    }
    if (next === 'sleep' && cat.state !== 'lie' && Math.random() < 0.7) {
      next = 'lie';
    }
    beginFloorState(cat, next);
  }

  function beginFloorState(cat: Cat, next: State): void {
    cat.y = floorY();
    setState(cat, next);
    switch (next) {
      case 'idle':
        cat.timer = rand(2, 4.5);
        break;
      case 'sit':
        cat.timer = rand(3, 6);
        break;
      case 'lie':
        cat.timer = rand(3, 5);
        break;
      case 'sleep':
        cat.timer = rand(6, 12);
        break;
      case 'swipe':
        cat.timer = rand(1.6, 3);
        break;
      case 'walk':
        cat.dir = Math.random() < 0.5 ? 1 : -1;
        cat.vx = cat.dir * rand(12, 18) * scale;
        cat.timer = rand(3, 7);
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
    cat.climbTop = floorY() * rand(0.2, 0.65);
    cat.climbDown = false;
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

  function stepCat(cat: Cat, dt: number): void {
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
          if (cat.state === 'lie' && Math.random() < 0.55) {
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
          if (cat.state !== 'chase' && Math.random() < 0.5) {
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
          cat.timer = cat.bouncer ? 0.12 : 0.28;
        }
        break;
      }
      case 'land':
        if (cat.timer <= 0) {
          if (cat.bouncer) {
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
          if (Math.random() < 0.5) {
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

  function makeCat(index: number, order: number[], bouncer: boolean): Cat {
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
      bouncer,
      ball: undefined
    };
    if (bouncer) {
      // Start mid-air at a random point of a bounce so the screen fills up straight away.
      startBounce(cat);
      cat.y = rand(0.1, 0.9) * floorY();
      cat.vy = -rand(-300, 300) * scale * 0.4;
    } else {
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
  // About a quarter of the cats (at least one) bounce across the middle of the screen.
  const bouncers = Math.max(1, Math.round(catCount / 4));
  const bouncerIdx = new Set(shuffle(Array.from({ length: catCount }, (_, i) => i)).slice(0, bouncers));
  for (let i = 0; i < catCount; i++) {
    cats.push(makeCat(i, order, bouncerIdx.has(i)));
  }
  for (const cat of cats) draw(cat);
  window.addEventListener('resize', onResize);
  pauseButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'pause' }));
  requestAnimationFrame(frame);
  document.body.dataset.ready = 'true';
  vscodeApi.postMessage({ type: 'ready', cats: cats.length });
})();
