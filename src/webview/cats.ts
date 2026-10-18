/* Runs inside the break webview. Compiled separately (DOM lib, no modules). */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

(function () {
  const vscodeApi = acquireVsCodeApi();
  const SVG_W = 140;
  const SVG_H = 110;

  type Mode = 'run' | 'jump' | 'roll' | 'stretch' | 'sit' | 'chase';

  interface Fur {
    base: string;
    dark: string;
    belly: string;
    ear: string;
  }

  const FURS: Fur[] = [
    { base: '#f2a65a', dark: '#c4701f', belly: '#fff1dc', ear: '#f7b7a3' },
    { base: '#8d99ae', dark: '#5c677d', belly: '#edf2f4', ear: '#f4b6c2' },
    { base: '#3d3d4a', dark: '#1f1f27', belly: '#6b6b7a', ear: '#e59aa8' },
    { base: '#f5f0e6', dark: '#cdbfa6', belly: '#ffffff', ear: '#f7b7a3' },
    { base: '#b5835a', dark: '#7a4e2b', belly: '#ead7c0', ear: '#f2a6a6' },
    { base: '#c9b7e8', dark: '#9578c9', belly: '#f3ecff', ear: '#f7b7d2' },
    { base: '#9ad1a4', dark: '#5ea36d', belly: '#eefaf0', ear: '#f7b7a3' },
    { base: '#f2d16b', dark: '#c9a032', belly: '#fff8dc', ear: '#f7b7a3' },
    { base: '#7fb7e6', dark: '#4a86b8', belly: '#eaf5ff', ear: '#f4b6c2' },
    { base: '#e5877f', dark: '#b3544d', belly: '#fde3df', ear: '#f9c0b8' }
  ];

  interface Cat {
    el: HTMLDivElement;
    svg: SVGSVGElement;
    w: number;
    h: number;
    scale: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    speed: number;
    mode: Mode;
    timeLeft: number;
    modeDuration: number;
    hop: number;
    hopHeight: number;
    rot: number;
    rotSpeed: number;
    dir: 1 | -1;
    target: Cat | undefined;
  }

  function rand(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  function clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
  }

  function catSvg(fur: Fur, w: number, h: number): string {
    const { base, dark, belly, ear } = fur;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${SVG_W} ${SVG_H}">
  <ellipse cx="68" cy="102" rx="46" ry="5" fill="rgba(0,0,0,0.12)"/>
  <path class="tail" d="M30 72 C 6 72, 4 38, 20 28" fill="none" stroke="${base}" stroke-width="10" stroke-linecap="round"/>
  <rect class="leg leg-b1" x="38" y="78" width="12" height="24" rx="6" fill="${dark}"/>
  <rect class="leg leg-f1" x="78" y="78" width="12" height="24" rx="6" fill="${dark}"/>
  <ellipse cx="62" cy="68" rx="40" ry="23" fill="${base}"/>
  <ellipse cx="64" cy="78" rx="28" ry="11" fill="${belly}"/>
  <path d="M42 48 q4 8 0 14 M54 46 q4 9 0 16 M66 46 q4 9 0 16" fill="none" stroke="${dark}" stroke-width="4" stroke-linecap="round" opacity="0.8"/>
  <rect class="leg leg-b2" x="50" y="80" width="12" height="24" rx="6" fill="${base}"/>
  <rect class="leg leg-f2" x="90" y="80" width="12" height="24" rx="6" fill="${base}"/>
  <g class="head">
    <polygon points="86,38 90,12 104,30" fill="${base}"/>
    <polygon points="90,34 92,19 100,30" fill="${ear}"/>
    <polygon points="108,30 122,12 126,40" fill="${base}"/>
    <polygon points="111,30 120,19 123,36" fill="${ear}"/>
    <ellipse cx="106" cy="50" rx="23" ry="20" fill="${base}"/>
    <ellipse cx="106" cy="58" rx="13" ry="9" fill="${belly}"/>
    <g class="eye"><ellipse cx="97" cy="47" rx="5" ry="6" fill="#ffffff"/><ellipse cx="98.5" cy="48" rx="2.6" ry="4" fill="#1d1d1d"/></g>
    <g class="eye"><ellipse cx="116" cy="47" rx="5" ry="6" fill="#ffffff"/><ellipse cx="117.5" cy="48" rx="2.6" ry="4" fill="#1d1d1d"/></g>
    <polygon points="103,55 109,55 106,59" fill="#e8738a"/>
    <path d="M106 59 q-3 4 -6 2 M106 59 q3 4 6 2" fill="none" stroke="#4a3a35" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M96 58 l-14 -3 M96 61 l-14 3 M117 58 l14 -3 M117 61 l14 3" fill="none" stroke="#4a3a35" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/>
  </g>
</svg>`;
  }

  const stage = document.getElementById('stage') as HTMLDivElement;
  const pauseButton = document.getElementById('pause') as HTMLButtonElement;
  const requested = parseInt(document.body.dataset.catCount ?? '8', 10);
  const catCount = clamp(Number.isFinite(requested) ? requested : 8, 1, 30);

  let W = window.innerWidth;
  let H = window.innerHeight;
  const cats: Cat[] = [];

  function headingFor(cat: Cat, angle: number, speed: number): void {
    cat.speed = speed;
    cat.vx = Math.cos(angle) * speed;
    cat.vy = Math.sin(angle) * speed;
  }

  function pickMode(cat: Cat): void {
    const r = Math.random();
    cat.target = undefined;
    cat.hop = 0;
    cat.rot = 0;
    cat.rotSpeed = 0;
    let mode: Mode;
    if (r < 0.28) mode = 'run';
    else if (r < 0.48) mode = 'jump';
    else if (r < 0.62) mode = 'roll';
    else if (r < 0.74) mode = 'stretch';
    else if (r < 0.86) mode = 'sit';
    else mode = 'chase';
    if (mode === 'chase' && cats.length < 2) mode = 'run';
    cat.mode = mode;

    switch (mode) {
      case 'run':
        headingFor(cat, rand(0, Math.PI * 2), rand(110, 240));
        cat.modeDuration = rand(1.5, 4);
        break;
      case 'jump':
        headingFor(cat, rand(0, Math.PI * 2), rand(100, 220));
        cat.hopHeight = rand(70, 150);
        cat.modeDuration = rand(0.7, 1.1) * Math.round(rand(1, 3));
        break;
      case 'roll': {
        headingFor(cat, rand(0, Math.PI * 2), rand(90, 170));
        const turns = Math.round(rand(1, 3));
        cat.modeDuration = turns * rand(0.7, 1.0);
        cat.rotSpeed = ((turns * 360) / cat.modeDuration) * (Math.random() < 0.5 ? 1 : -1);
        break;
      }
      case 'stretch':
        cat.vx = cat.vy = 0;
        cat.modeDuration = rand(1.8, 3);
        break;
      case 'sit':
        cat.vx = cat.vy = 0;
        cat.modeDuration = rand(1.5, 3.5);
        break;
      case 'chase': {
        const others = cats.filter((c) => c !== cat);
        cat.target = others[Math.floor(Math.random() * others.length)];
        cat.speed = rand(230, 300);
        cat.modeDuration = rand(3, 6);
        break;
      }
    }
    cat.timeLeft = cat.modeDuration;
    cat.el.className = 'cat ' + cat.mode;
  }

  function makeCat(index: number): Cat {
    const fur = FURS[index % FURS.length];
    const scale = rand(0.8, 1.25);
    const w = SVG_W * scale;
    const h = SVG_H * scale;
    const el = document.createElement('div');
    el.className = 'cat sit';
    el.innerHTML = catSvg(fur, w, h);
    stage.appendChild(el);
    const cat: Cat = {
      el,
      svg: el.querySelector('svg') as SVGSVGElement,
      w,
      h,
      scale,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      speed: 0,
      mode: 'sit',
      timeLeft: 0,
      modeDuration: 1,
      hop: 0,
      hopHeight: 0,
      rot: 0,
      rotSpeed: 0,
      dir: Math.random() < 0.5 ? 1 : -1,
      target: undefined
    };
    return cat;
  }

  function shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  // Spread the cats over the whole panel using a jittered grid.
  function placeCats(): void {
    const cols = Math.max(1, Math.ceil(Math.sqrt((catCount * W) / Math.max(H, 1))));
    const rows = Math.max(1, Math.ceil(catCount / cols));
    const cells: Array<[number, number]> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) cells.push([c, r]);
    }
    shuffle(cells);
    cats.forEach((cat, i) => {
      const [c, r] = cells[i % cells.length];
      const cellW = W / cols;
      const cellH = H / rows;
      cat.x = clamp(c * cellW + rand(0, Math.max(0, cellW - cat.w)), 0, Math.max(0, W - cat.w));
      cat.y = clamp(r * cellH + rand(0, Math.max(0, cellH - cat.h)), 0, Math.max(0, H - cat.h));
    });
  }

  function bounce(cat: Cat): void {
    const maxX = Math.max(0, W - cat.w);
    const maxY = Math.max(0, H - cat.h);
    if (cat.x < 0) {
      cat.x = 0;
      cat.vx = Math.abs(cat.vx);
    } else if (cat.x > maxX) {
      cat.x = maxX;
      cat.vx = -Math.abs(cat.vx);
    }
    if (cat.y < 0) {
      cat.y = 0;
      cat.vy = Math.abs(cat.vy);
    } else if (cat.y > maxY) {
      cat.y = maxY;
      cat.vy = -Math.abs(cat.vy);
    }
  }

  function step(cat: Cat, dt: number): void {
    cat.timeLeft -= dt;
    const progress = clamp(1 - cat.timeLeft / cat.modeDuration, 0, 1);

    if (cat.mode === 'chase') {
      const t = cat.target;
      if (t) {
        const dx = t.x + t.w / 2 - (cat.x + cat.w / 2);
        const dy = t.y + t.h / 2 - (cat.y + cat.h / 2);
        const dist = Math.hypot(dx, dy) || 1;
        cat.vx = (dx / dist) * cat.speed;
        cat.vy = (dy / dist) * cat.speed;
        if (dist < 60 * cat.scale) {
          // Caught up: the other cat bolts away, the chaser tumbles.
          if (t.mode !== 'chase') {
            const away = Math.atan2(-dy, -dx);
            t.mode = 'run';
            t.el.className = 'cat run';
            headingFor(t, away, rand(260, 340));
            t.modeDuration = t.timeLeft = rand(1, 2);
            t.hop = 0;
            t.rot = 0;
            t.rotSpeed = 0;
          }
          cat.timeLeft = 0;
        }
      }
    }

    cat.x += cat.vx * dt;
    cat.y += cat.vy * dt;
    bounce(cat);

    if (Math.abs(cat.vx) > 8) cat.dir = cat.vx >= 0 ? 1 : -1;

    let hop = 0;
    let sx = 1;
    let sy = 1;
    if (cat.mode === 'jump') {
      // One or more arcs over the mode duration.
      const arcs = Math.max(1, Math.round(cat.modeDuration / 0.9));
      hop = Math.abs(Math.sin(progress * Math.PI * arcs)) * cat.hopHeight;
      sy = 1 + 0.08 * Math.sin(progress * Math.PI * arcs * 2);
    } else if (cat.mode === 'roll') {
      cat.rot += cat.rotSpeed * dt;
    } else if (cat.mode === 'stretch') {
      const k = Math.sin(progress * Math.PI);
      sx = 1 + 0.25 * k;
      sy = 1 - 0.12 * k;
    } else if (cat.mode === 'sit') {
      sy = 1 + 0.02 * Math.sin(progress * Math.PI * 6);
    }

    cat.hop = hop;
    cat.el.style.transform = `translate(${cat.x.toFixed(1)}px, ${(cat.y - hop).toFixed(1)}px)`;
    cat.el.style.zIndex = String(Math.floor(cat.y));
    cat.svg.style.transform = `rotate(${cat.rot.toFixed(1)}deg) scale(${(cat.dir * sx).toFixed(3)}, ${sy.toFixed(3)})`;

    if (cat.timeLeft <= 0) {
      pickMode(cat);
    }
  }

  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const cat of cats) step(cat, dt);
    requestAnimationFrame(frame);
  }

  function onResize(): void {
    W = window.innerWidth;
    H = window.innerHeight;
    for (const cat of cats) {
      cat.x = clamp(cat.x, 0, Math.max(0, W - cat.w));
      cat.y = clamp(cat.y, 0, Math.max(0, H - cat.h));
    }
  }

  for (let i = 0; i < catCount; i++) cats.push(makeCat(i));
  placeCats();
  cats.forEach(pickMode);
  window.addEventListener('resize', onResize);
  pauseButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'pause' }));
  requestAnimationFrame(frame);
  document.body.dataset.ready = 'true';
  vscodeApi.postMessage({ type: 'ready', cats: cats.length });
})();
