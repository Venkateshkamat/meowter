import * as assert from 'assert';
import {
  ANIMATIONS,
  ANIM_NAMES,
  buildCatSvg,
  buildYarnSvg,
  colorFor,
  CONTENT_MAX_COL,
  CONTENT_MIN_COL,
  COATS,
  FEET_ROWS,
  FRAME_SIZE,
  frameGrid,
  frameNames,
  frameRgba,
  PALETTE_CHARS,
  resolveCoat,
  svgToDataUri,
  YARN_COLORS,
  YARN_FRAME_COUNT,
  YARN_SIZE,
  yarnFrameGrid,
  yarnRgba,
  CHASE_CELLS,
  cellMarkup,
  coatVars,
  isCell,
  SCENE_FPS,
  SCENE_TICK_HZ,
  sceneStyle,
  yarnVars
} from '../../catArt';

interface Checked {
  ids: Set<string>;
  tags: Map<string, number>;
}

/** Minimal well-formedness check: balanced tags, quoted unique attributes, nothing outside tags. */
function checkXml(rawXml: string): Checked {
  // <style> holds CSS text (checked separately); everything else must be markup only.
  const xml = rawXml.replace(/<style>[^<]*<\/style>/g, '<style></style>');
  const tagRe = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  const ids = new Set<string>();
  const tags = new Map<string, number>();
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    assert.strictEqual(xml.slice(pos, m.index).trim(), '', `unexpected text outside tags at ${pos}`);
    pos = tagRe.lastIndex;
    const [, closing, name, attrs, selfClosing] = m;
    if (closing) {
      assert.strictEqual(stack.pop(), name, `mismatched </${name}>`);
      continue;
    }
    const seen = new Set<string>();
    for (const a of attrs.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      assert.ok(!seen.has(a[1]), `duplicate attribute ${a[1]} on <${name}>`);
      seen.add(a[1]);
      if (a[1] === 'id') {
        assert.ok(!ids.has(a[2]), `duplicate id ${a[2]}`);
        ids.add(a[2]);
      }
    }
    tags.set(name, (tags.get(name) ?? 0) + 1);
    if (!selfClosing) {
      stack.push(name);
    }
  }
  assert.strictEqual(xml.slice(pos).trim(), '', 'trailing text');
  assert.deepStrictEqual(stack, [], 'unclosed tags');
  return { ids, tags };
}

function painted(grid: readonly string[]): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  grid.forEach((row, y) => [...row].forEach((ch, x) => ch !== '.' && out.push([x, y, ch])));
  return out;
}

describe('catArt coats', () => {
  it('offers 8 varied coats with real patterns', () => {
    assert.ok(COATS.length >= 8);
    assert.strictEqual(new Set(COATS.map((c) => c.id)).size, COATS.length);
    assert.ok(new Set(COATS.map((c) => c.pattern)).size >= 5);
    for (const c of COATS) {
      for (const key of ['base', 'dark', 'light', 'stripe', 'patchA', 'patchB', 'point', 'eye', 'pink', 'outline'] as const) {
        assert.match(c[key], /^#[0-9a-f]{6}$/i, `${c.id}.${key}`);
      }
    }
  });

  it('resolves coats by object, id and wrapped index', () => {
    assert.strictEqual(resolveCoat(1).id, COATS[1].id);
    assert.strictEqual(resolveCoat(COATS.length + 2).id, COATS[2].id);
    assert.strictEqual(resolveCoat(-1).id, COATS[COATS.length - 1].id);
    assert.strictEqual(resolveCoat('calico').id, 'calico');
    assert.strictEqual(resolveCoat('nope').id, COATS[0].id);
    assert.strictEqual(resolveCoat(COATS[3]), COATS[3]);
  });
});

describe('catArt sprite data', () => {
  const names = frameNames();

  it('has the animations the cats need', () => {
    for (const a of ['idle', 'sit', 'lie', 'sleep', 'swipe', 'walk', 'run', 'jump', 'fall', 'land', 'climb', 'grab']) {
      assert.ok(ANIM_NAMES.includes(a as never), `missing animation ${a}`);
    }
    for (const name of ANIM_NAMES) {
      const anim = ANIMATIONS[name];
      assert.ok(anim.frames.length >= 1 && anim.fps > 0, name);
      for (const f of anim.frames) {
        assert.ok(names.includes(f), `${name} uses unknown frame ${f}`);
      }
    }
    assert.ok(ANIMATIONS.walk.frames.length >= 4 && ANIMATIONS.run.frames.length >= 4);
    assert.ok(ANIMATIONS.sleep.frames.length >= 2);
  });

  it('every frame is FRAME_SIZE x FRAME_SIZE and uses only valid palette characters', () => {
    assert.ok(names.length >= 25);
    for (const name of names) {
      const g = frameGrid(name);
      assert.strictEqual(g.length, FRAME_SIZE, `${name} rows`);
      for (const row of g) {
        assert.strictEqual(row.length, FRAME_SIZE, `${name} width`);
        for (const ch of row) {
          assert.ok(PALETTE_CHARS.includes(ch), `${name} has invalid char ${JSON.stringify(ch)}`);
        }
      }
    }
  });

  it('every frame uses only characters that resolve to a colour for every coat', () => {
    for (const name of names) {
      const chars = new Set(painted(frameGrid(name)).map((p) => p[2]));
      for (const coat of COATS) {
        for (const ch of chars) {
          assert.match(colorFor(coat, ch) ?? '', /^#[0-9a-f]{6}$/i, `${coat.id} ${name} char ${ch}`);
        }
      }
    }
  });

  it('every frame has a 1px outline and keeps inside the wall columns', () => {
    for (const name of names) {
      const px = painted(frameGrid(name));
      assert.ok(px.some((p) => p[2] === 'o'), `${name} has an outline`);
      const xs = px.map((p) => p[0]);
      assert.ok(Math.min(...xs) >= CONTENT_MIN_COL, `${name} min col ${Math.min(...xs)}`);
      assert.ok(Math.max(...xs) <= CONTENT_MAX_COL, `${name} max col ${Math.max(...xs)}`);
      // no isolated outline pixels floating in empty space
      const g = frameGrid(name);
      for (const [x, y, ch] of px) {
        if (ch !== 'o') continue;
        const near = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].some(([dx, dy]) => {
          const c = g[y + dy]?.[x + dx];
          return c !== undefined && c !== '.';
        });
        assert.ok(near, `${name} stray outline at ${x},${y}`);
      }
    }
  });

  it('ground frames stand on the floor line', () => {
    for (const name of names.filter((n) => /^(stand|sit|lie|sleep|swipe|walk)/.test(n))) {
      const rows = painted(frameGrid(name)).map((p) => p[1]);
      assert.strictEqual(Math.max(...rows), FEET_ROWS - 1, `${name} lowest row`);
    }
  });

  it('wall frames touch the wall column exactly', () => {
    for (const name of names.filter((n) => /^(climb|grab)/.test(n))) {
      const xs = painted(frameGrid(name)).map((p) => p[0]);
      assert.strictEqual(Math.max(...xs), CONTENT_MAX_COL, name);
    }
  });

  it('only the sleeping frames have z glyphs', () => {
    for (const name of names) {
      const hasZ = painted(frameGrid(name)).some((p) => p[2] === 'z');
      assert.strictEqual(hasZ, name.startsWith('sleep'), name);
    }
  });

  it('animations really change between frames', () => {
    for (const name of ['walk', 'run', 'climb', 'swipe', 'sleep'] as const) {
      const frames = new Set(ANIMATIONS[name].frames.map((f) => frameGrid(f).join('')));
      assert.ok(frames.size >= 2, `${name} has distinct frames`);
    }
    assert.strictEqual(new Set(ANIMATIONS.walk.frames.map((f) => frameGrid(f).join(''))).size, 4);
  });

  it('coats look different, not just recoloured: patterns change which pixels differ', () => {
    const grid = frameGrid('standA');
    const colors = (id: string): string[] => [...grid.join('')].map((ch) => colorFor(resolveCoat(id), ch) ?? '.');
    const diff = (a: string, b: string): number => colors(a).filter((c, i) => c !== colors(b)[i]).length;
    assert.ok(diff('orange', 'grey') > 50);
    assert.ok(diff('white', 'calico') > 10, 'calico patches');
    assert.ok(diff('black', 'tuxedo') > 10, 'tuxedo white chest and paws');
    assert.ok(diff('white', 'siamese') > 10, 'siamese points');
  });

  it('frameRgba matches the grid', () => {
    const { width, height, data } = frameRgba('orange', 'walk0');
    assert.strictEqual(width, FRAME_SIZE);
    assert.strictEqual(height, FRAME_SIZE);
    assert.strictEqual(data.length, FRAME_SIZE * FRAME_SIZE * 4);
    assert.strictEqual(data[3], 0, 'corner is transparent');
    const opaque = painted(frameGrid('walk0')).length;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] === 255) count++;
    assert.strictEqual(count, opaque);
    assert.ok(opaque > 150 && opaque < 500, 'a small chunky sprite');
  });
});

describe('catArt yarn ball', () => {
  it('has 4 same-size frames with valid characters', () => {
    assert.strictEqual(YARN_FRAME_COUNT, 4);
    const frames = [0, 1, 2, 3].map((i) => yarnFrameGrid(i));
    for (const g of frames) {
      assert.strictEqual(g.length, YARN_SIZE + 2);
      for (const row of g) {
        assert.strictEqual(row.length, YARN_SIZE + 2);
        assert.match(row, /^[.orqs]+$/);
      }
    }
    assert.ok(new Set(frames.map((g) => g.join(''))).size >= 3, 'rolls');
    assert.strictEqual(yarnRgba(0, 1).data.length, (YARN_SIZE + 2) ** 2 * 4);
    assert.ok(YARN_COLORS.length >= 3);
  });
});

describe('catArt standalone SVG', () => {
  for (const coat of COATS) {
    for (const anim of ANIM_NAMES) {
      it(`${coat.id} / ${anim} is valid, self-contained and animated`, () => {
        const svg = buildCatSvg({ coat, anim });
        const { tags } = checkXml(svg);
        assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
        assert.ok(svg.includes(`viewBox="0 0 ${FRAME_SIZE} ${FRAME_SIZE}"`));
        assert.ok(svg.includes('shape-rendering="crispEdges"'));
        assert.ok(!/<script|<style|<image|<foreignObject|onload=|javascript:|href=/i.test(svg));
        assert.ok(!svg.replace('xmlns="http://www.w3.org/2000/svg"', '').includes('http'));
        const frames = ANIMATIONS[anim].frames.length;
        // One group per DISTINCT frame; repeated frames of the sequence share a group.
        const distinct = new Set(ANIMATIONS[anim].frames).size;
        assert.strictEqual(tags.get('animate') ?? 0, distinct > 1 ? distinct : 0);
        assert.strictEqual(tags.get('g') ?? 0, distinct);
        if (frames > 1 && distinct > 1) {
          assert.ok(svg.includes('calcMode="discrete"'));
          assert.ok(svg.includes('repeatCount="indefinite"'));
        }
        assert.ok(svg.includes(`fill="${coat.outline}"`), 'outline colour');
        assert.ok(!/<rect[^>]*width="100%"/.test(svg), 'no background');
      });
    }
  }

  it('options: scale, flip, and every pixel colour comes from the coat palette', () => {
    const svg = buildCatSvg({ coat: 'calico', anim: 'walk', scale: 3 });
    assert.ok(svg.includes(`width="${FRAME_SIZE * 3}" height="${FRAME_SIZE * 3}"`));
    assert.ok(buildCatSvg({ coat: 'calico', anim: 'walk' }).includes(`width="${FRAME_SIZE * 4}"`));
    const flipped = buildCatSvg({ coat: 'calico', anim: 'walk', flip: true });
    assert.ok(flipped.includes(`translate(${FRAME_SIZE} 0) scale(-1 1)`));
    checkXml(flipped);
    const calico = resolveCoat('calico');
    const allowed = new Set(PALETTE_CHARS.split('').map((c) => colorFor(calico, c)).filter(Boolean));
    for (const m of svg.matchAll(/fill="(#[0-9a-f]{6})"/gi)) {
      assert.ok(allowed.has(m[1]), `unexpected colour ${m[1]}`);
    }
    assert.notStrictEqual(buildCatSvg({ coat: 'black', anim: 'walk' }), buildCatSvg({ coat: 'white', anim: 'walk' }));
  });

  it('pixels in the SVG equal the pixels of the canvas renderer', () => {
    const svg = buildCatSvg({ coat: 'orange', anim: 'jump' });
    let count = 0;
    for (const m of svg.matchAll(/d="([^"]+)"/g)) {
      for (const r of m[1].matchAll(/h(\d+)v1/g)) count += parseInt(r[1], 10);
    }
    assert.strictEqual(count, painted(frameGrid('jumpUp')).length);
  });

  it('standalone yarn svg is valid and animated', () => {
    const svg = buildYarnSvg({ colorIndex: 2, scale: 5 });
    const { tags } = checkXml(svg);
    assert.strictEqual(tags.get('animate'), 4);
    assert.ok(svg.includes(YARN_COLORS[2].base));
    assert.ok(svg.includes(`width="${(YARN_SIZE + 2) * 5}"`));
  });

  it('svgToDataUri round-trips', () => {
    const svg = buildCatSvg({ coat: 'siamese', anim: 'sleep' });
    const uri = svgToDataUri(svg);
    assert.ok(uri.startsWith('data:image/svg+xml;charset=utf-8,'));
    assert.strictEqual(decodeURIComponent(uri.slice(uri.indexOf(',') + 1)), svg);
  });

  it('stays small', () => {
    for (const anim of ANIM_NAMES) {
      assert.ok(buildCatSvg({ coat: 'calico', anim }).length < 40000, anim);
    }
  });
});

describe('catArt scene building blocks', () => {
  it('every frame is a strip cell whose pixels equal the frame, painted by classes (no baked colours)', () => {
    for (const name of frameNames()) {
      assert.ok(isCell(name));
      const cell = cellMarkup(name);
      checkXml(`<svg xmlns="http://www.w3.org/2000/svg">${cell}</svg>`);
      assert.ok(!/fill=/.test(cell), 'colours come from CSS variables, not baked in');
      let count = 0;
      for (const m of cell.matchAll(/class="c(.)" d="([^"]+)"/g)) {
        for (const r of m[2].matchAll(/h(\d+)v1/g)) count += parseInt(r[1], 10);
      }
      assert.strictEqual(count, painted(frameGrid(name)).length, name);
    }
  });

  it('chase cells are the run frames with a yarn ball in front', () => {
    assert.strictEqual(CHASE_CELLS.length, 4);
    CHASE_CELLS.forEach((cell, k) => {
      assert.ok(isCell(cell));
      const markup = cellMarkup(cell);
      checkXml(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`);
      assert.ok(markup.includes('class="yr"') && markup.includes('class="yo"'), 'yarn is painted by its own classes');
      assert.ok(markup.startsWith(cellMarkup(`run${k}`)), 'the cat is the run frame');
    });
    assert.ok(!isCell('nope'));
  });

  it('declares a CSS variable for every palette character a coat uses, and for the yarn', () => {
    const style = sceneStyle();
    for (const coat of COATS) {
      const vars = coatVars(coat);
      for (const ch of 'obdlpkwmxycfegtuz') {
        assert.ok(style.includes(`.c${ch}{fill:var(--${ch})}`));
        assert.ok(vars.includes(`--${ch}:#`), `${coat.id} --${ch}`);
      }
    }
    for (const ch of 'rqso') {
      assert.ok(style.includes(`.y${ch}{fill:var(--y${ch})}`));
      assert.ok(yarnVars(1).includes(`--y${ch}:#`));
    }
    checkXml(`<svg xmlns="http://www.w3.org/2000/svg">${sceneStyle()}</svg>`);
  });

  it('plays every sprite animation in a scene on a divisor of the scene clock', () => {
    assert.strictEqual(SCENE_TICK_HZ, 8);
    for (const name of ANIM_NAMES) {
      assert.strictEqual(SCENE_TICK_HZ % SCENE_FPS[name], 0, `${name} scene fps ${SCENE_FPS[name]}`);
      assert.ok(SCENE_FPS[name] <= ANIMATIONS[name].fps * 2 && SCENE_FPS[name] >= 1);
    }
  });
});
