/**
 * Meowter cat art: small chunky pixel-art cats drawn entirely in code (original artwork).
 *
 * Sprites are DATA: string grids of palette characters (see `Palette characters` below). Frames are
 * composed from reusable body parts, a 1-pixel dark outline is generated automatically, and the
 * result is rendered either
 *  - to RGBA pixels (`frameRgba`) for the break webview's <canvas>, or
 *  - to a standalone, self-animating SVG string (`buildCatSvg`): crisp <path> pixels, frames
 *    switched with SMIL discrete animation, no scripts, no CSS, no external references. The
 *    extension host can use it (e.g. as an editor decoration image) via `svgToDataUri`.
 *
 * This module must stay free of Node/DOM APIs so it runs in both places. All cats face RIGHT.
 *
 * Palette characters in sprite grids
 *   .  transparent            o  outline (added automatically)
 *   b  base fur               d  shade (underside, far legs)
 *   l  light (muzzle)         p  pink (inner ear, nose, tongue)
 *   k  eye                    w  white
 *   m  tabby stripe           x  calico patch A (orange)   y  calico patch B (black)
 *   c  belly / chest          f  feet                      e  ear (outer)
 *   g  face centre / blaze    t  tail tip                  u  tail body
 *   z  sleeping "z"           r/q/s  yarn base / dark / light
 *   h/a  dust cloud light / shade (same for every coat)     j  fight star (yellow, same for every coat)
 */

export const FRAME_SIZE = 32;

/** Painted pixels (including the outline) of every cat frame stay inside these columns. */
export const CONTENT_MIN_COL = 3;
export const CONTENT_MAX_COL = 28;

/** Row (exclusive) where the feet end, outline included: the floor sits just below it. */
export const FEET_ROWS = 30;

export type CoatPattern = 'tabby' | 'solid' | 'calico' | 'tuxedo' | 'points';

export interface Coat {
  id: string;
  name: string;
  pattern: CoatPattern;
  base: string;
  dark: string;
  light: string;
  /** Tabby stripe colour. */
  stripe: string;
  /** Calico patch A / B, siamese points colour. */
  patchA: string;
  patchB: string;
  point: string;
  eye: string;
  pink: string;
  outline: string;
  /** Whether chest and belly are lighter than the back. */
  lightBelly: boolean;
}

export const COATS: readonly Coat[] = [
  {
    id: 'orange', name: 'Orange tabby', pattern: 'tabby',
    base: '#eb9a45', dark: '#c2702a', light: '#ffdba5', stripe: '#b3541a',
    patchA: '#eb9a45', patchB: '#eb9a45', point: '#eb9a45',
    eye: '#2a1b10', pink: '#f7a1ae', outline: '#2b1710', lightBelly: true
  },
  {
    id: 'grey', name: 'Grey tabby', pattern: 'tabby',
    base: '#9aa5b8', dark: '#6c788e', light: '#e6ebf2', stripe: '#4f5a70',
    patchA: '#9aa5b8', patchB: '#9aa5b8', point: '#9aa5b8',
    eye: '#1c2230', pink: '#f4a3b5', outline: '#1c2230', lightBelly: true
  },
  {
    id: 'black', name: 'Black', pattern: 'solid',
    base: '#4a4a5c', dark: '#34343f', light: '#6a6a80', stripe: '#34343f',
    patchA: '#4a4a5c', patchB: '#4a4a5c', point: '#4a4a5c',
    eye: '#f6d33f', pink: '#d98aa0', outline: '#101016', lightBelly: false
  },
  {
    id: 'white', name: 'White', pattern: 'solid',
    base: '#f8f5ef', dark: '#d2cabc', light: '#ffffff', stripe: '#d2cabc',
    patchA: '#f8f5ef', patchB: '#f8f5ef', point: '#f8f5ef',
    eye: '#2a3f6b', pink: '#f7a7b4', outline: '#3a2c2c', lightBelly: false
  },
  {
    id: 'calico', name: 'Calico', pattern: 'calico',
    base: '#f8f5ef', dark: '#d2cabc', light: '#ffffff', stripe: '#d2cabc',
    patchA: '#eb9a45', patchB: '#3f3f4d', point: '#f8f5ef',
    eye: '#2a1b10', pink: '#f7a7b4', outline: '#2b1710', lightBelly: false
  },
  {
    id: 'tuxedo', name: 'Tuxedo', pattern: 'tuxedo',
    base: '#43434f', dark: '#2e2e38', light: '#fbfaf5', stripe: '#2e2e38',
    patchA: '#43434f', patchB: '#43434f', point: '#43434f',
    eye: '#8fe05a', pink: '#f09ab0', outline: '#101016', lightBelly: true
  },
  {
    id: 'brown', name: 'Brown', pattern: 'tabby',
    base: '#96623b', dark: '#6b4224', light: '#dcb78a', stripe: '#6b4224',
    patchA: '#96623b', patchB: '#96623b', point: '#96623b',
    eye: '#1d120a', pink: '#e99aa0', outline: '#24140a', lightBelly: true
  },
  {
    id: 'siamese', name: 'Siamese', pattern: 'points',
    base: '#efe2c9', dark: '#cdb792', light: '#fbf4e6', stripe: '#cdb792',
    patchA: '#efe2c9', patchB: '#efe2c9', point: '#5e4538',
    eye: '#4aa8ff', pink: '#c98e8b', outline: '#2b1c14', lightBelly: true
  }
];

export const YARN_COLORS: ReadonlyArray<{ base: string; dark: string; light: string }> = [
  { base: '#e5484d', dark: '#a4262c', light: '#ff8f92' },
  { base: '#3b82f6', dark: '#1e4fb0', light: '#8fb8ff' },
  { base: '#f5b301', dark: '#b07f00', light: '#ffe083' },
  { base: '#a855f7', dark: '#6a2fb0', light: '#d3a4ff' },
  { base: '#22c55e', dark: '#12803b', light: '#7ee8a2' }
];

export function resolveCoat(coat: Coat | string | number): Coat {
  if (typeof coat === 'number') {
    return COATS[((Math.floor(coat) % COATS.length) + COATS.length) % COATS.length];
  }
  if (typeof coat === 'string') {
    return COATS.find((c) => c.id === coat) ?? COATS[0];
  }
  return coat;
}

/** Every character a sprite grid may contain. */
export const PALETTE_CHARS = '.obdlpkwmxycfegtuzrqshaj';

/** Colour (#rrggbb) for a palette character, or undefined for transparent / yarn characters. */
export function colorFor(coat: Coat, ch: string): string | undefined {
  const pat = coat.pattern;
  switch (ch) {
    case 'o': return coat.outline;
    case 'b': return coat.base;
    case 'd': return coat.dark;
    case 'l': return pat === 'points' ? coat.point : coat.light;
    case 'p': return coat.pink;
    case 'k': return coat.eye;
    case 'w': return '#ffffff';
    case 'm': return pat === 'tabby' ? coat.stripe : coat.base;
    case 'x': return pat === 'calico' ? coat.patchA : coat.base;
    case 'y': return pat === 'calico' ? coat.patchB : coat.base;
    case 'c': return coat.lightBelly ? coat.light : coat.base;
    case 'f': return pat === 'tuxedo' ? coat.light : pat === 'points' ? coat.point : coat.base;
    case 'e': return pat === 'points' ? coat.point : coat.base;
    case 'g': return pat === 'tuxedo' ? coat.light : pat === 'points' ? coat.point : coat.base;
    case 't': return pat === 'points' ? coat.point : pat === 'calico' ? coat.patchB : pat === 'tabby' ? coat.stripe : pat === 'tuxedo' ? coat.light : coat.base;
    case 'u': return pat === 'points' ? coat.point : pat === 'calico' ? coat.patchA : coat.base;
    case 'z': return '#a9bcff';
    case 'h': return '#f1ece2';
    case 'a': return '#c9c1b2';
    case 'j': return '#ffd23f';
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Parts (string grids)
// ---------------------------------------------------------------------------------------------

type Grid = readonly string[];

const HEAD: Grid = [
  '.e.....e.',
  'epe...epe',
  'xxbbmbbyy',
  'xxbbgbbyy',
  'bbkgggkbb',
  'bbkgggkbb',
  'bbllpllbb',
  '.bblllbb.'
];

function headVariant(kind: 'open' | 'blink' | 'sleep' | 'happy'): Grid {
  const g = [...HEAD];
  if (kind === 'blink') {
    g[4] = 'bbbgggbbb';
  } else if (kind === 'sleep') {
    g[4] = 'bbbgggbbb';
    g[5] = 'bkkgggkkb';
  } else if (kind === 'happy') {
    g[7] = '.bbpppbb.';
  }
  return g;
}

const TORSO: Grid = [
  '..bmbbmbbmb..',
  '.bbmxxmbbmbb.',
  'yyymxxmyymbbb',
  'yyyyxxxyyybxx',
  'yyybxxxbbbxxx',
  '.bbcccccccbb.',
  '..ddddddddd..'
];

const TAIL_A: Grid = [
  'tt....',
  'tu....',
  'uu....',
  '.uu...',
  '.umu..',
  '..uu..',
  '..umu.',
  '...uuu'
];

const TAIL_B: Grid = [
  '.tt...',
  '.tu...',
  '.uu...',
  '..uu..',
  '..umu.',
  '...uu.',
  '...umu',
  '....uu'
];

const TAIL_RUN: Grid = [
  'tuumuuu',
  '.uuuuuu'
];

function legDown(h: number): Grid {
  const rows: string[] = [];
  for (let i = 0; i < h - 1; i++) rows.push('bb.');
  rows.push('fff');
  return rows;
}

const LEG_DIAG_FWD: Grid = ['bb..', '.bb.', '..bf', '...f'];
const LEG_DIAG_BACK: Grid = ['..bb', '.bb.', 'fb..', 'f...'];

// ---------------------------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------------------------

interface Layer {
  g: Grid;
  x: number;
  y: number;
  /** Paint everything in the shade colour (far legs). */
  shade?: boolean;
  /** Draw an outline around the part where it overlaps what is already there. */
  ink?: boolean;
}

function render(layers: Layer[]): string[] {
  const cv: string[][] = Array.from({ length: FRAME_SIZE }, () => Array<string>(FRAME_SIZE).fill('.'));
  const put = (x: number, y: number, ch: string): void => {
    if (x < 0 || y < 0 || x >= FRAME_SIZE || y >= FRAME_SIZE) {
      throw new Error(`sprite pixel out of frame at ${x},${y}`);
    }
    cv[y][x] = ch;
  };
  for (const layer of layers) {
    const { g, x: ox, y: oy } = layer;
    if (layer.ink) {
      for (let y = -1; y <= g.length; y++) {
        for (let x = -1; x <= g[0].length; x++) {
          const inside = y >= 0 && y < g.length && x >= 0 && x < g[0].length && g[y][x] !== '.';
          if (inside) continue;
          const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
            const gx = x + dx;
            const gy = y + dy;
            return gy >= 0 && gy < g.length && gx >= 0 && gx < g[0].length && g[gy][gx] !== '.';
          });
          const px = ox + x;
          const py = oy + y;
          if (near && px >= 0 && py >= 0 && px < FRAME_SIZE && py < FRAME_SIZE && cv[py][px] !== '.') {
            cv[py][px] = 'o';
          }
        }
      }
    }
    for (let y = 0; y < g.length; y++) {
      for (let x = 0; x < g[y].length; x++) {
        const ch = g[y][x];
        if (ch === '.') continue;
        put(ox + x, oy + y, layer.shade && ch !== 'k' ? 'd' : ch);
      }
    }
  }
  // 1-pixel outline around everything.
  const out = cv.map((row) => row.slice());
  for (let y = 0; y < FRAME_SIZE; y++) {
    for (let x = 0; x < FRAME_SIZE; x++) {
      if (cv[y][x] !== '.') continue;
      const touch = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < FRAME_SIZE && ny < FRAME_SIZE && cv[ny][nx] !== '.' && cv[ny][nx] !== 'z';
      });
      const touchZ = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < FRAME_SIZE && ny < FRAME_SIZE && cv[ny][nx] === 'z';
      });
      if (touch || touchZ) out[y][x] = 'o';
    }
  }
  return out.map((r) => r.join(''));
}

/** Four-legged side view used for standing, walking and running. */
interface QuadLeg {
  g: Grid;
  dx?: number;
  dy?: number;
}

interface QuadOpts {
  tx?: number;
  ty?: number;
  head?: Grid;
  tail?: Grid;
  tailAt?: [number, number];
  /** [hindNear, hindFar, frontFar, frontNear] */
  legs?: [QuadLeg, QuadLeg, QuadLeg, QuadLeg];
  headDy?: number;
}

function quad(o: QuadOpts): Layer[] {
  const tx = o.tx ?? 10;
  const ty = o.ty ?? 17;
  const legs = o.legs ?? [{ g: legDown(7) }, { g: legDown(7) }, { g: legDown(7) }, { g: legDown(7) }];
  const [hn, hf, ff, fn] = legs;
  const leg = (l: QuadLeg, x: number, shade = false): Layer => ({ g: l.g, x: tx + x + (l.dx ?? 0), y: ty + 5 + (l.dy ?? 0), shade });
  const tailAt = o.tailAt ?? [tx - 4, ty - 6];
  return [
    leg(hf, 4, true),
    leg(ff, 7, true),
    { g: o.tail ?? TAIL_A, x: tailAt[0], y: tailAt[1] },
    { g: TORSO, x: tx, y: ty },
    leg(hn, 1),
    leg(fn, 10),
    { g: o.head ?? headVariant('open'), x: tx + 7, y: ty - 5 + (o.headDy ?? 0), ink: true }
  ];
}

function walkFrame(phase: number): string[] {
  // Diagonal gait: (hindNear, frontFar) vs (frontNear, hindFar).
  const table: Array<{ a: [number, number]; b: [number, number] }> = [
    { a: [-1, 0], b: [1, 1] },
    { a: [0, 0], b: [1, 0] },
    { a: [1, 1], b: [-1, 0] },
    { a: [1, 0], b: [0, 0] }
  ];
  const { a, b } = table[phase];
  const bob = phase === 1 || phase === 3 ? -1 : 0;
  // Legs grow by the bob so the planted feet stay on the floor while the body rises.
  const mk = (p: [number, number]): QuadLeg => ({ g: legDown(7 - p[1] - bob), dx: p[0] });
  return render(
    quad({
      ty: 17 + bob,
      legs: [mk(a), mk(b), mk(a), mk(b)],
      tail: phase % 2 === 0 ? TAIL_A : TAIL_B,
      tailAt: [6, 11 + bob]
    })
  );
}

function runFrame(phase: number): string[] {
  const ty = 20;
  const tx = 11;
  const head = headVariant('happy');
  // 0 extended, 1 gather front, 2 gathered, 3 gather hind
  const L = (g: Grid, x: number, y: number, shade = false): Layer => ({ g, x, y, shade });
  let legs: Layer[];
  if (phase === 0) {
    legs = [
      L(LEG_DIAG_BACK, tx - 2, ty + 4, true),
      L(LEG_DIAG_FWD, tx + 11, ty + 4, true),
      L(LEG_DIAG_BACK, tx - 4, ty + 4),
      L(LEG_DIAG_FWD, tx + 12, ty + 4)
    ];
  } else if (phase === 1) {
    legs = [
      L(legDown(3), tx + 1, ty + 5, true),
      L(LEG_DIAG_FWD, tx + 11, ty + 4, true),
      L(legDown(4), tx + 2, ty + 5),
      L(legDown(3), tx + 9, ty + 5)
    ];
  } else if (phase === 2) {
    legs = [
      L(legDown(3), tx + 3, ty + 5, true),
      L(legDown(3), tx + 7, ty + 5, true),
      L(legDown(3), tx + 4, ty + 5),
      L(legDown(3), tx + 8, ty + 5)
    ];
  } else {
    legs = [
      L(LEG_DIAG_BACK, tx - 2, ty + 4, true),
      L(legDown(3), tx + 8, ty + 5, true),
      L(LEG_DIAG_BACK, tx - 4, ty + 4),
      L(legDown(4), tx + 10, ty + 5)
    ];
  }
  const rise = phase === 2 ? -1 : 0;
  return render([
    legs[0],
    legs[1],
    { g: TAIL_RUN, x: tx - 6, y: ty - 1 + rise },
    { g: TORSO, x: tx, y: ty + rise },
    legs[2],
    legs[3],
    { g: head, x: tx + 8, y: ty - 5 + rise, ink: true }
  ]);
}

function standFrame(tail: Grid, headKind: 'open' | 'blink'): string[] {
  return render(quad({ tail, head: headVariant(headKind) }));
}

// ----- sit / swipe -----

const SIT_TORSO: Grid = [
  '...bbbbbb.',
  '..bmbbbbbb',
  '.bbmbbbbcc',
  '.bbbbmbbcc',
  'bbxxbbbbcc',
  'bbxxbbbbcc',
  'bybbbbbbcc',
  'bbbbbbbbcc',
  'bbbbbbbbbb',
  'dbbbbbbbbd',
  '.dddddddd.'
];

const SIT_TAIL_A: Grid = [
  'tu......',
  'uu......',
  '.u......',
  '.uu.....',
  '..uuuuuu'
];
const SIT_TAIL_B: Grid = [
  '.tu.....',
  '.uu.....',
  '.uu.....',
  '..uu....',
  '..uuuuuu'
];

function sitLayers(tail: Grid, head: Grid, arm?: Layer): Layer[] {
  const tx = 11;
  const ty = 18;
  const layers: Layer[] = [
    { g: tail, x: tx - 7, y: ty + 6 },
    { g: SIT_TORSO, x: tx, y: ty },
    { g: ['ffffff'], x: tx + 3, y: ty + 10 },
    { g: ['.fff'], x: tx + 6, y: ty + 10 }
  ];
  if (arm) layers.push(arm);
  layers.push({ g: head, x: tx + 3, y: ty - 6, ink: true });
  return layers;
}

function sitFrame(tail: Grid, headKind: 'open' | 'blink'): string[] {
  return render(sitLayers(tail, headVariant(headKind)));
}

const ARM_UP: Grid = ['.ff', '.bf', 'bb.', 'bb.'];
const ARM_FWD: Grid = ['..bff', 'bbbff', 'bb...'];

function swipeFrame(phase: number): string[] {
  const tx = 11;
  const ty = 18;
  // The grounded front leg is part of the torso; the swiping arm is drawn over the chest.
  const arm: Layer =
    phase === 0
      ? { g: ARM_UP, x: tx + 9, y: ty + 3, ink: true }
      : phase === 1
        ? { g: ARM_FWD, x: tx + 10, y: ty + 3, ink: true }
        : { g: ARM_UP, x: tx + 10, y: ty + 5, ink: true };
  return render(sitLayers(phase === 1 ? SIT_TAIL_B : SIT_TAIL_A, headVariant(phase === 1 ? 'happy' : 'open'), arm));
}

// ----- lie / sleep -----

const LIE_TORSO: Grid = [
  '...bmbbmbbmb...',
  '..bbmxxmbbmbb..',
  '.bbbmxxmyymbbb.',
  'bbbbxbbbyybxxbb',
  'bbbbbbbbbbbbbbb',
  '.ddddddddddddd.'
];

function lieFrame(tail: Grid, headKind: 'open' | 'blink'): string[] {
  const tx = 10;
  const ty = 23;
  return render([
    { g: tail, x: tx - 6, y: ty + 3 },
    { g: LIE_TORSO, x: tx, y: ty },
    { g: headVariant(headKind), x: tx + 9, y: ty - 3, ink: true },
    { g: ['.bfff', 'fffff'], x: tx + 12, y: ty + 4, ink: true }
  ]);
}

const LIE_TAIL_A: Grid = ['tuuuuuu'];
const LIE_TAIL_B: Grid = ['tuumuuu', '.......'];

const Z_SMALL: Grid = ['zzz', '..z', '.z.', 'z..', 'zzz'];
const Z_BIG: Grid = ['zzzz', '...z', '..z.', '.z..', 'zzzz'];

const SLEEP_BODY: Grid = [
  '....bbbbbbbb....',
  '..bbmbbmbbmbbb..',
  '.bbbmxxmyymbbbb.',
  'bbbbxxbbyybbbbbb',
  'bbbbbbbbbbbbbbbb',
  '.bbbbbbbbbbbbbb.',
  '..dddddddddddd..'
];

function sleepFrame(phase: number): string[] {
  const tx = 7;
  const breath = phase % 2;
  const layers: Layer[] = [
    // The body breathes by losing its top row; the bottom stays on the floor.
    { g: breath ? SLEEP_BODY.slice(1) : SLEEP_BODY, x: tx, y: 21 + breath },
    { g: ['tuuuuuuu'], x: tx + 2, y: 28, ink: true },
    { g: headVariant('sleep'), x: tx + 9, y: 20 + breath, ink: true }
  ];
  if (phase === 0) layers.push({ g: Z_SMALL, x: 24, y: 14 });
  else if (phase === 1) layers.push({ g: Z_SMALL, x: 24, y: 13 }, { g: Z_SMALL, x: 20, y: 6 });
  else layers.push({ g: Z_BIG, x: 21, y: 4 }, { g: Z_SMALL, x: 25, y: 11 });
  return render(layers);
}

// ----- jump -----

function jumpFrame(kind: 'up' | 'fall' | 'land'): string[] {
  if (kind === 'up') {
    const tx = 11;
    const ty = 17;
    const L = (g: Grid, x: number, y: number, shade = false): Layer => ({ g, x, y, shade });
    return render([
      L(LEG_DIAG_BACK, tx - 2, ty + 5, true),
      L(LEG_DIAG_FWD, tx + 11, ty + 5, true),
      { g: TAIL_RUN, x: tx - 6, y: ty + 1 },
      { g: TORSO, x: tx, y: ty },
      L(LEG_DIAG_BACK, tx - 4, ty + 5),
      L(LEG_DIAG_FWD, tx + 12, ty + 5),
      { g: headVariant('happy'), x: tx + 8, y: ty - 6, ink: true }
    ]);
  }
  if (kind === 'fall') {
    return render(
      quad({
        ty: 16,
        tx: 10,
        head: headVariant('happy'),
        legs: [{ g: legDown(4), dx: -1 }, { g: legDown(4), dx: -1 }, { g: legDown(4), dx: 1 }, { g: legDown(4), dx: 1 }],
        tail: TAIL_B,
        tailAt: [6, 10]
      })
    );
  }
  // land: crouched, legs bent
  return render(
    quad({
      ty: 23,
      tx: 10,
      head: headVariant('open'),
      headDy: 1,
      legs: [{ g: ['fff'], dx: 0 }, { g: ['fff'], dx: 0 }, { g: ['fff'], dx: 1 }, { g: ['fff'], dx: 1 }],
      tail: TAIL_B,
      tailAt: [6, 17]
    })
  );
}

// ----- wall climbing (cat hugging a wall on its right) -----

const CLIMB_TORSO: Grid = [
  '.bmbbcc',
  'bbmbbcc',
  'bbbbbcc',
  'bxxbbcc',
  'bxxbbcc',
  'bbbbbcc',
  'bbybbcc',
  '.bbbbcc',
  '.bbbbbc',
  '..bbbb.'
];

const CLIMB_TAIL: Grid = ['uu', 'um', 'uu', 'um', 'uu', 'uu', 'tt'];

const ARM_CLIMB: Grid = ['.ff', '.bf', '.bb', '.bb', 'bb.', 'bb.', 'bb.', 'bb.'];

function climbLayers(armHigh: 'near' | 'far', blink: boolean, tailShift: number, legUp: boolean): Layer[] {
  const tx = 17;
  const ty = 14;
  const high: Layer = { g: ARM_CLIMB, x: tx + 8, y: ty - 8, shade: armHigh === 'far' };
  const low: Layer = { g: ARM_CLIMB, x: tx + 8, y: ty - 4, shade: armHigh === 'near' };
  const [first, second] = armHigh === 'far' ? [high, low] : [low, high];
  return [
    { g: CLIMB_TAIL, x: tx - 2 - tailShift, y: ty + 4 },
    { g: legDown(4), x: tx + 1, y: ty + 8, shade: true },
    first,
    { g: CLIMB_TORSO, x: tx, y: ty },
    { g: ['bbf', '.bf', '.ff'], x: tx + 4, y: ty + 7 - (legUp ? 1 : 0) },
    second,
    { g: headVariant(blink ? 'blink' : 'open'), x: tx + 1, y: ty - 8, ink: true }
  ];
}

function climbFrame(phase: number): string[] {
  return render(climbLayers(phase === 0 ? 'near' : 'far', false, 0, phase === 1));
}

function grabFrame(phase: number): string[] {
  return render(climbLayers('near', phase === 1, phase % 2, false));
}

// ----- hiss (arched back, puffed tail, flat ears, open mouth) -----

/** A head with the ears laid flat, narrowed eyes and an open, hissing mouth; `wide` opens it further. */
function hissHead(wide: boolean): Grid {
  return [
    '.........',
    'eee...eee',
    'xxbbmbbyy',
    'xxbbgbbyy',
    'bbkbgbkbb',
    'bbkgggkbb',
    wide ? 'bbwpppwbb' : 'bblwpwlbb',
    wide ? '.bbpppbb.' : '.bblpllb.'
  ];
}

const ARCH_TORSO: Grid = [
  '.....bmb.....',
  '...bbmbbmb...',
  '..bbmxxmbmb..',
  '.bbmyxxxmybb.',
  '.bbbyxxxbbbb.',
  '.bbbbbbbbbbb.',
  '..bbcccccbb..',
  '...ddddddd...'
];

/** A tail fluffed up like a bottle brush. */
const TAIL_PUFF_A: Grid = [
  '.tt.',
  'tuut',
  'uuuu',
  'umuu',
  'uuuu',
  'uumu',
  'uuuu',
  '.uuu',
  '..uu'
];
const TAIL_PUFF_B: Grid = [
  '.t.t',
  'tutt',
  'uuuu',
  'uumu',
  'uuuu',
  'umuu',
  'uuuu',
  'uuu.',
  'uu..'
];

function hissFrame(phase: number): string[] {
  const tx = 8;
  const ty = 16 - phase; // the back rises a little with every hiss
  const legH = 28 - (ty + 8) + 1;
  return render([
    { g: legDown(legH), x: tx + 2, y: ty + 8, shade: true },
    { g: legDown(legH), x: tx + 9, y: ty + 8, shade: true },
    { g: phase === 0 ? TAIL_PUFF_A : TAIL_PUFF_B, x: tx - 3, y: ty - 3 },
    { g: ARCH_TORSO, x: tx, y: ty },
    { g: legDown(legH), x: tx + 1, y: ty + 8 },
    { g: legDown(legH), x: tx + 8, y: ty + 8 },
    { g: hissHead(phase === 1), x: tx + 10, y: ty + 2, ink: true }
  ]);
}

// ----- fight cloud: a tumbling ball of dust with paws, tails and stars poking out -----

function fightFrame(phase: number): string[] {
  const cx = 16;
  const cy = 22;
  const lowest = FEET_ROWS - 2; // the dust rests on the floor
  const turn = (phase * Math.PI) / 2;
  const cv: string[][] = Array.from({ length: FRAME_SIZE }, () => Array<string>(FRAME_SIZE).fill('.'));
  const put = (x: number, y: number, ch: string): void => {
    // (clipped so that the outline stays inside the columns the cats use)
    if (x >= CONTENT_MIN_COL + 1 && x <= CONTENT_MAX_COL - 1 && y >= 1 && y <= lowest) cv[y][x] = ch;
  };
  // The dust ball: a lumpy disc with swirling shade streaks that turn from frame to frame.
  for (let y = 0; y < FRAME_SIZE; y++) {
    for (let x = 0; x < FRAME_SIZE; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      const limit = 7.2 + 1.1 * Math.cos(3 * ang + turn) + 0.7 * Math.cos(5 * ang - 2 * turn);
      if (r <= limit) {
        const band = Math.floor((ang + r * 0.5 + turn) / (Math.PI / 3));
        put(x, y, ((band % 2) + 2) % 2 === 0 ? 'a' : 'h');
      }
    }
  }
  const polar = (angle: number, radius: number): [number, number] => [Math.round(cx + Math.cos(angle) * radius), Math.round(cy + Math.sin(angle) * radius)];
  const blob = (x: number, y: number, ch: string): void => {
    put(x, y, ch);
    put(x + 1, y, ch);
    put(x, y + 1, ch);
    put(x + 1, y + 1, ch);
  };
  // One cat's paw and tail poke out of the cloud (the other cat is this one mirrored).
  const pawAngle = turn + 3.6;
  for (let k = 0; k < 5; k++) {
    const [x, y] = polar(pawAngle, 5 + k);
    blob(x, y, k < 3 ? 'b' : 'f');
  }
  const tailAngle = turn + 5.3;
  for (let k = 0; k < 6; k++) {
    const [x, y] = polar(tailAngle + Math.sin(k * 0.9) * 0.28, 6 + k);
    put(x, y, k >= 4 ? 't' : k % 3 === 2 ? 'm' : 'u');
    put(x + 1, y, k >= 4 ? 't' : 'u');
  }
  // Little stars (sparkles) that jump around.
  for (const [angle, radius] of [[turn + 0.4, 10], [turn + 2.5, 9]] as const) {
    const [x, y] = polar(angle, radius);
    put(x, y, 'j');
    put(x - 1, y, 'j');
    put(x + 1, y, 'j');
    put(x, y - 1, 'j');
    put(x, y + 1, 'j');
  }
  return render([{ g: cv.map((r) => r.join('')), x: 0, y: 0 }]);
}

// ---------------------------------------------------------------------------------------------
// Frames and animations
// ---------------------------------------------------------------------------------------------

const FRAMES: Record<string, string[]> = {
  standA: standFrame(TAIL_A, 'open'),
  standB: standFrame(TAIL_B, 'open'),
  standBlink: standFrame(TAIL_A, 'blink'),
  sitA: sitFrame(SIT_TAIL_A, 'open'),
  sitB: sitFrame(SIT_TAIL_B, 'open'),
  sitBlink: sitFrame(SIT_TAIL_A, 'blink'),
  walk0: walkFrame(0),
  walk1: walkFrame(1),
  walk2: walkFrame(2),
  walk3: walkFrame(3),
  run0: runFrame(0),
  run1: runFrame(1),
  run2: runFrame(2),
  run3: runFrame(3),
  jumpUp: jumpFrame('up'),
  jumpFall: jumpFrame('fall'),
  jumpLand: jumpFrame('land'),
  lieA: lieFrame(LIE_TAIL_A, 'open'),
  lieB: lieFrame(LIE_TAIL_B, 'open'),
  lieBlink: lieFrame(LIE_TAIL_A, 'blink'),
  sleep0: sleepFrame(0),
  sleep1: sleepFrame(1),
  sleep2: sleepFrame(2),
  swipe0: swipeFrame(0),
  swipe1: swipeFrame(1),
  swipe2: swipeFrame(2),
  climb0: climbFrame(0),
  climb1: climbFrame(1),
  grab0: grabFrame(0),
  grab1: grabFrame(1),
  grab2: grabFrame(2),
  hiss0: hissFrame(0),
  hiss1: hissFrame(1),
  fight0: fightFrame(0),
  fight1: fightFrame(1),
  fight2: fightFrame(2),
  fight3: fightFrame(3)
};

export type AnimName =
  | 'idle'
  | 'sit'
  | 'lie'
  | 'sleep'
  | 'swipe'
  | 'walk'
  | 'run'
  | 'jump'
  | 'fall'
  | 'land'
  | 'climb'
  | 'grab'
  | 'hiss'
  | 'fight';

export interface Animation {
  frames: readonly string[];
  fps: number;
}

export const ANIMATIONS: Readonly<Record<AnimName, Animation>> = {
  idle: { frames: ['standA', 'standA', 'standA', 'standB', 'standB', 'standB', 'standBlink', 'standA'], fps: 3 },
  sit: { frames: ['sitA', 'sitA', 'sitA', 'sitB', 'sitB', 'sitB', 'sitBlink', 'sitA'], fps: 3 },
  lie: { frames: ['lieA', 'lieA', 'lieA', 'lieB', 'lieB', 'lieBlink', 'lieA', 'lieA'], fps: 2 },
  sleep: { frames: ['sleep0', 'sleep0', 'sleep1', 'sleep1', 'sleep2', 'sleep2'], fps: 2 },
  swipe: { frames: ['swipe0', 'swipe1', 'swipe0', 'swipe1', 'swipe2'], fps: 5 },
  walk: { frames: ['walk0', 'walk1', 'walk2', 'walk3'], fps: 6 },
  run: { frames: ['run0', 'run1', 'run2', 'run3'], fps: 10 },
  jump: { frames: ['jumpUp'], fps: 1 },
  fall: { frames: ['jumpFall'], fps: 1 },
  land: { frames: ['jumpLand'], fps: 1 },
  climb: { frames: ['climb0', 'climb1'], fps: 4 },
  grab: { frames: ['grab0', 'grab0', 'grab1', 'grab0', 'grab2'], fps: 3 },
  hiss: { frames: ['hiss0', 'hiss0', 'hiss1', 'hiss0', 'hiss1', 'hiss1'], fps: 4 },
  fight: { frames: ['fight0', 'fight1', 'fight2', 'fight3'], fps: 8 }
};

export const ANIM_NAMES = Object.keys(ANIMATIONS) as AnimName[];

/** Names of all distinct frames (for tests and tooling). */
export function frameNames(): string[] {
  return Object.keys(FRAMES);
}

/** The raw frame grid (with outline, still in palette characters). */
export function frameGrid(name: string): readonly string[] {
  const g = FRAMES[name];
  if (!g) {
    throw new Error(`unknown frame ${name}`);
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Yarn ball
// ---------------------------------------------------------------------------------------------

export const YARN_SIZE = 9;

function yarnGrid(phase: number): string[] {
  // A disc with diagonal winding bands; the band angle turns with the phase so it looks like it rolls.
  const theta = (phase * Math.PI) / 4 + 0.35;
  const c = (YARN_SIZE - 1) / 2;
  const rows: string[] = [];
  for (let y = 0; y < YARN_SIZE; y++) {
    let row = '';
    for (let x = 0; x < YARN_SIZE; x++) {
      const dx = x - c;
      const dy = y - c;
      if (dx * dx + dy * dy > 4.6 * 4.6) {
        row += '.';
        continue;
      }
      const d = dx * Math.cos(theta) + dy * Math.sin(theta);
      const band = (((Math.floor(d / 1.5 + 8) % 4) + 4) % 4);
      row += band === 0 ? 'q' : band === 2 ? 's' : 'r';
    }
    rows.push(row);
  }
  return rows;
}

export const YARN_FRAME_COUNT = 4;

/** Yarn ball frame grid, with outline, in a (YARN_SIZE+2) square. */
export function yarnFrameGrid(phase: number): string[] {
  const g = yarnGrid(((phase % 4) + 4) % 4);
  const n = YARN_SIZE + 2;
  const cv: string[][] = Array.from({ length: n }, () => Array<string>(n).fill('.'));
  for (let y = 0; y < YARN_SIZE; y++) {
    for (let x = 0; x < YARN_SIZE; x++) {
      cv[y + 1][x + 1] = g[y][x];
    }
  }
  const out = cv.map((r) => r.slice());
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (cv[y][x] !== '.') continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => cv[y + dy]?.[x + dx] !== undefined && cv[y + dy][x + dx] !== '.')) {
        out[y][x] = 'o';
      }
    }
  }
  return out.map((r) => r.join(''));
}

export function yarnColorFor(colorIndex: number, ch: string): string | undefined {
  const c = YARN_COLORS[((Math.floor(colorIndex) % YARN_COLORS.length) + YARN_COLORS.length) % YARN_COLORS.length];
  if (ch === 'r') return c.base;
  if (ch === 'q') return c.dark;
  if (ch === 's') return c.light;
  if (ch === 'o') return '#1a1018';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** RGBA pixels (FRAME_SIZE x FRAME_SIZE) of one frame, ready for `new ImageData(data, w, h)`. */
export function frameRgba(coat: Coat | string | number, frame: string): RgbaImage {
  return gridRgba(frameGrid(frame), (ch) => colorFor(resolveCoat(coat), ch));
}

export function yarnRgba(colorIndex: number, phase: number): RgbaImage {
  return gridRgba(yarnFrameGrid(phase), (ch) => yarnColorFor(colorIndex, ch));
}

function gridRgba(grid: readonly string[], color: (ch: string) => string | undefined): RgbaImage {
  const height = grid.length;
  const width = grid[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = color(grid[y][x]);
      if (!c) continue;
      const [r, g, b] = hexToRgb(c);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Pixel runs of a grid as an SVG path per colour (horizontal runs merged). */
function gridPaths(grid: readonly string[], color: (ch: string) => string | undefined): string {
  const byColor = new Map<string, string[]>();
  for (let y = 0; y < grid.length; y++) {
    let x = 0;
    while (x < grid[y].length) {
      const c = color(grid[y][x]);
      if (!c) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < grid[y].length && color(grid[y][end]) === c) end++;
      const list = byColor.get(c) ?? [];
      list.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
      byColor.set(c, list);
      x = end;
    }
  }
  return [...byColor.entries()].map(([c, runs]) => `<path fill="${c}" d="${runs.join('')}"/>`).join('');
}

export interface CatSvgOptions {
  coat: Coat | string | number;
  anim: AnimName;
  /** Pixels per sprite pixel (default 4). */
  scale?: number;
  /** Draw the cat facing left. */
  flip?: boolean;
}

/**
 * Builds a standalone, self-animating SVG for one animation: every frame is a group of crisp
 * pixel paths and SMIL discrete animation switches between them. No scripts, no CSS.
 */
export function buildCatSvg(o: CatSvgOptions): string {
  const coat = resolveCoat(o.coat);
  const anim = ANIMATIONS[o.anim];
  const scale = o.scale ?? 4;
  const size = FRAME_SIZE * scale;
  const groups = frameGroups(anim.frames, anim.fps, (name) => gridPaths(frameGrid(name), (ch) => colorFor(coat, ch)));
  const inner = o.flip ? `<g transform="translate(${FRAME_SIZE} 0) scale(-1 1)">${groups}</g>` : groups;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${FRAME_SIZE} ${FRAME_SIZE}" shape-rendering="crispEdges">` +
    inner +
    `</svg>`
  );
}

/**
 * One <g> per DISTINCT frame, switched with SMIL discrete `visibility` animation following the
 * frame sequence (repeated frames in a sequence share one group). A single frame needs no animation.
 */
function frameGroups(frames: readonly string[], fps: number, paint: (frame: string) => string): string {
  const n = frames.length;
  const dur = Math.round((n / fps) * 10000) / 10000;
  const times = frames.map((_, i) => String(Math.round((i / n) * 10000) / 10000)).join(';');
  const distinct = [...new Set(frames)];
  return distinct
    .map((name) => {
      const paths = paint(name);
      if (distinct.length === 1) {
        return `<g>${paths}</g>`;
      }
      const values = frames.map((f) => (f === name ? 'visible' : 'hidden')).join(';');
      return (
        `<g visibility="${frames[0] === name ? 'visible' : 'hidden'}">${paths}` +
        `<animate attributeName="visibility" calcMode="discrete" values="${values}" keyTimes="${times}" dur="${dur}s" repeatCount="indefinite"/></g>`
      );
    })
    .join('');
}

// ---------------------------------------------------------------------------------------------
// Building blocks for scenes (many cats in one SVG, see catScene.ts)
// ---------------------------------------------------------------------------------------------

/** Characters that get a CSS variable / class in scene sprites (everything except transparent). */
const SCENE_CHARS = PALETTE_CHARS.replace('.', '');

/**
 * Animation clock of scenes: every scene frame rate divides it, so all changes of a scene happen on the same
 * ticks and the overlay repaints at most this many times per second (8 suits pixel art and is cheap).
 */
export const SCENE_TICK_HZ = 8;

/** Frame rates of the animations when played in a scene (each divides SCENE_TICK_HZ). */
export const SCENE_FPS: Readonly<Record<AnimName, number>> = {
  idle: 4,
  sit: 4,
  lie: 2,
  sleep: 2,
  swipe: 4,
  walk: 4,
  run: 8,
  jump: 1,
  fall: 1,
  land: 1,
  climb: 4,
  grab: 4,
  hiss: 4,
  fight: 8
};

/** `<style>` that paints classed sprite pixels from per-instance CSS variables (--b, --d, ..., --yr for yarn). */
export function sceneStyle(): string {
  const cat = [...SCENE_CHARS].map((c) => `.c${c}{fill:var(--${c})}`);
  const yarn = ['r', 'q', 's', 'o'].map((c) => `.y${c}{fill:var(--y${c})}`);
  return `<style>${cat.join('')}${yarn.join('')}</style>`;
}

/** Inline style declaring the CSS variables of a coat (set it on any ancestor of a sprite `<use>`). */
export function coatVars(coat: Coat | string | number): string {
  const c = resolveCoat(coat);
  return [...SCENE_CHARS]
    .map((ch) => {
      const col = colorFor(c, ch);
      return col ? `--${ch}:${col}` : '';
    })
    .filter(Boolean)
    .join(';');
}

/** Inline style declaring the CSS variables of a yarn ball colour (`--yr`, `--yq`, `--ys`, `--yo`). */
export function yarnVars(colorIndex: number): string {
  return ['r', 'q', 's', 'o'].map((ch) => `--y${ch}:${yarnColorFor(colorIndex, ch)}`).join(';');
}

/** Pixel runs as one path per palette character, painted by the `.<prefix><char>` classes. */
function classedPaths(grid: readonly string[], prefix: string): string {
  const byChar = new Map<string, string[]>();
  for (let y = 0; y < grid.length; y++) {
    let x = 0;
    while (x < grid[y].length) {
      const ch = grid[y][x];
      if (ch === '.') {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < grid[y].length && grid[y][end] === ch) end++;
      const list = byChar.get(ch) ?? [];
      list.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
      byChar.set(ch, list);
      x = end;
    }
  }
  return [...byChar.entries()].map(([ch, runs]) => `<path class="${prefix}${ch}" d="${runs.join('')}"/>`).join('');
}

/** Cells of a scene's sprite strip: every frame, plus `chase0..3` (running with a yarn ball in front). */
export const CHASE_CELLS: readonly string[] = ['chase0', 'chase1', 'chase2', 'chase3'];

export function isCell(name: string): boolean {
  return CHASE_CELLS.includes(name) || frameNames().includes(name);
}

/**
 * The art of one strip cell (a FRAME_SIZE square), painted by the `.c<char>` / `.y<char>` classes. Recolour it by
 * setting coatVars()/yarnVars() on an ancestor of the `<use>` that instances it.
 */
export function cellMarkup(cell: string): string {
  const k = CHASE_CELLS.indexOf(cell);
  if (k < 0) {
    return classedPaths(frameGrid(cell), 'c');
  }
  const ball = `<g transform="translate(${CONTENT_MAX_COL + 3} ${FEET_ROWS - YARN_SIZE - 2})">${classedPaths(yarnFrameGrid(k), 'y')}</g>`;
  return classedPaths(frameGrid(`run${k}`), 'c') + ball;
}

export interface YarnSvgOptions {
  colorIndex?: number;
  scale?: number;
}

/** Standalone rolling yarn ball SVG (4 frames, SMIL discrete). */
export function buildYarnSvg(o: YarnSvgOptions = {}): string {
  const scale = o.scale ?? 4;
  const n = YARN_SIZE + 2;
  const groups = [0, 1, 2, 3]
    .map((i) => {
      const paths = gridPaths(yarnFrameGrid(i), (ch) => yarnColorFor(o.colorIndex ?? 0, ch));
      const values = [0, 1, 2, 3].map((j) => (j === i ? 'visible' : 'hidden')).join(';');
      return (
        `<g visibility="${i === 0 ? 'visible' : 'hidden'}">${paths}` +
        `<animate attributeName="visibility" calcMode="discrete" values="${values}" keyTimes="0;0.25;0.5;0.75" dur="0.5s" repeatCount="indefinite"/></g>`
      );
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n * scale}" height="${n * scale}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    groups +
    `</svg>`
  );
}

/** `data:` URI for an SVG string, usable as an <img> source or editor decoration image. */
export function svgToDataUri(svg: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
