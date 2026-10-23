// Records the README demo (media/demo.gif) and still (media/screenshot.png) from an ISOLATED VS Code instance.
//
// Run on demand, it is NOT part of `npm run compile`:
//   npm run compile
//   node scripts/record-demo.js              # record frames, then encode the GIF and the still
//   node scripts/record-demo.js --encode     # only re-encode from the frames recorded earlier
//   options: --seconds=40  --width=800  --fps=9  --shot=<frame number for the still>  --start=<first frame>  --end=<last frame>
//
// How: it starts VS Code with a throw-away profile under .vscode-test/dm (user data dir, extensions dir, a neutral
// sample workspace), this repository as --extensionDevelopmentPath and --remote-debugging-port, with the break
// interval set to 1 minute. Once the break starts it grabs the editor area with the DevTools protocol
// (Page.captureScreenshot), then closes only that instance. The GIF is encoded with the `gifenc` devDependency
// (one shared palette), PNGs are decoded with Node's zlib. Set MEOWTER_EDITOR_PATH to use another editor binary.
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const { spawn, execSync } = require('child_process');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const root = path.resolve(__dirname, '..');
const base = path.join(root, '.vscode-test', 'dm');
const framesDir = path.join(base, 'frames');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const SECONDS = Number(args.seconds ?? 40);
const OUT_WIDTH = Number(args.width ?? 800);
const FPS = Number(args.fps ?? 9);
const VIEW = { width: 1280, height: 800 };

const EDITORS = [
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
];

// A neutral sample file: nothing personal. Every line is short (at most 45 characters), so no line is wider than
// the overlay's width estimate and the cats get the full width of the editor (the climbers' walls are the editor's
// real left and right edges). The script checks this before it records.
const SAMPLE = `// A tiny break reminder (demo file).
type Reminder = {
  message: string;
  everyMinutes: number;
};

const reminders: Reminder[] = [
  { message: "Stretch", everyMinutes: 50 },
  { message: "Look away", everyMinutes: 50 },
  { message: "Drink water", everyMinutes: 90 },
];

function nextBreak(
  worked: number,
  r: Reminder,
): number {
  const rest = worked % r.everyMinutes;
  return r.everyMinutes - rest;
}

export function summary(worked: number) {
  return reminders.map((r) => {
    const left = nextBreak(worked, r);
    return \`\${r.message}: \${left} min\`;
  });
}

for (const line of summary(35)) {
  console.log(line);
}
`;

const SETTINGS = {
  'meowter.breakIntervalMinutes': 1,
  // The demo shows four cats: a climber, a bouncer and a fighting pair (the extension's own defaults are unchanged).
  'meowter.catCount': 4,
  'meowter.styles': { wanderer: false, climber: true, bouncer: true, yarnChaser: false, fighters: true },
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'window.commandCenter': false,
  'editor.fontSize': 14,
  'editor.lineHeight': 22,
  'editor.minimap.enabled': false,
  'editor.renderWhitespace': 'none',
  'breadcrumbs.enabled': false,
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'extensions.autoUpdate': false
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Minimal DevTools protocol client over the built-in WebSocket. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) {
        const { res, rej } = pending.get(d.id);
        pending.delete(d.id);
        d.error ? rej(new Error(d.error.message)) : res(d.result);
      }
    };
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close()
      });
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
}

async function waitFor(fn, what, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not ready yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/** Kills only the processes started from this throw-away profile. */
function killInstance() {
  const ps = execSync('ps -axo pid=,command=', { encoding: 'utf8' });
  for (const line of ps.split('\n')) {
    if (line.includes(base)) {
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    }
  }
}

async function record() {
  const exe = process.env.MEOWTER_EDITOR_PATH ?? EDITORS.find((p) => fs.existsSync(p));
  if (!exe || !fs.existsSync(exe)) throw new Error('VS Code not found; set MEOWTER_EDITOR_PATH');
  fs.rmSync(base, { recursive: true, force: true });
  const ws = path.join(base, 'demo');
  fs.mkdirSync(path.join(base, 'ud', 'User'), { recursive: true });
  fs.mkdirSync(path.join(base, 'ext'), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(path.join(base, 'ud', 'User', 'settings.json'), JSON.stringify(SETTINGS, null, 2));
  fs.writeFileSync(path.join(ws, 'reminders.ts'), SAMPLE);

  const port = await freePort();
  const child = spawn(
    exe,
    [
      ws,
      path.join(ws, 'reminders.ts'),
      '--user-data-dir', path.join(base, 'ud'),
      '--extensions-dir', path.join(base, 'ext'),
      `--extensionDevelopmentPath=${root}`,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--remote-debugging-port=${port}`
    ],
    { stdio: 'ignore' }
  );
  let cdp;
  try {
    const target = await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return list.find((t) => t.type === 'page' && /workbench\.html/.test(t.url));
    }, 'the editor window', 60000);
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => evaluate(cdp, `!!document.querySelector('.part.editor .monaco-editor')`), 'the code editor', 60000);
    console.log('editor is up; waiting for the break (about a minute of active use) ...');
    await waitFor(
      () => evaluate(cdp, `[...document.querySelectorAll('.statusbar-item')].some((e) => /I took a break/.test(e.getAttribute('aria-label') || ''))`),
      'the break to start',
      180000
    ).catch(async (err) => {
      const bar = await evaluate(cdp, `[...document.querySelectorAll('.statusbar-item')].map((e) => e.getAttribute('aria-label') || '').join(' | ')`).catch(() => '?');
      throw new Error(`${err.message} (the window must stay focused; status bar: ${bar})`);
    });
    // Hide the notification toast, then let the cats spread out.
    await evaluate(cdp, `(() => { const s = document.createElement('style'); s.textContent = '.notifications-toasts{display:none!important}'; document.head.appendChild(s); })()`);
    await sleep(2500);
    // The overlay must be as wide as the editor's text area (no width cap), or the climbers' "walls" end up mid-editor.
    const measure = JSON.parse(
      await evaluate(
        cdp,
        `JSON.stringify([...document.querySelectorAll('[class*="ced-"]')].filter((e) => /svg/.test(getComputedStyle(e).backgroundImage)).map((e) => ({ w: e.getBoundingClientRect().width, x: e.getBoundingClientRect().x, textArea: e.closest('.view-overlays').getBoundingClientRect().width, editorX: e.closest('.monaco-editor').getBoundingClientRect().x, editorW: e.closest('.monaco-editor').getBoundingClientRect().width })))`
      )
    );
    console.log('overlay vs text area', JSON.stringify(measure));
    if (!measure.length || measure.some((m) => Math.abs(m.w - m.textArea) > 1.5)) {
      throw new Error('the overlay is narrower than the text area (a line is too long?): ' + JSON.stringify(measure));
    }
    const rect = await evaluate(cdp, `(() => { const r = document.querySelector('.part.editor').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    console.log('editor area', JSON.stringify(rect));
    const clip = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), scale: 1 };
    const t0 = Date.now();
    let n = 0;
    const frameMs = 1000 / FPS;
    while (Date.now() - t0 < SECONDS * 1000) {
      const started = Date.now();
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip, fromSurface: true });
      fs.writeFileSync(path.join(framesDir, `f${String(n).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'));
      n++;
      const wait = frameMs - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
    const real = ((Date.now() - t0) / 1000).toFixed(1);
    fs.writeFileSync(path.join(framesDir, 'meta.json'), JSON.stringify({ frames: n, seconds: Number(real) }));
    console.log(`recorded ${n} frames in ${real}s`);
  } finally {
    cdp?.close();
    child.kill('SIGTERM');
    await sleep(1500);
    killInstance();
  }
}

// --- PNG decode (8-bit RGB/RGBA, no interlace) and encode ---
function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, channels = 4;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0 || (data[9] !== 6 && data[9] !== 2)) throw new Error('unsupported PNG');
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (ft === 1) add = a;
      else if (ft === 2) add = b;
      else if (ft === 3) add = (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * channels];
      out[o + 1] = line[x * channels + 1];
      out[o + 2] = line[x * channels + 2];
      out[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB: the editor is opaque
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      raw[row + 1 + x * 3] = data[s];
      raw[row + 2 + x * 3] = data[s + 1];
      raw[row + 3 + x * 3] = data[s + 2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** Box-filter downscale (the editor text stays readable). */
function resize(img, w, h) {
  if (w === img.width && h === img.height) return img;
  const out = new Uint8Array(w * h * 4);
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0, g = 0, b = 0, c = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; c++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

function encode() {
  const files = fs.readdirSync(framesDir).filter((f) => /^f\d+\.png$/.test(f)).sort();
  if (!files.length) throw new Error(`no frames in ${framesDir}; run without --encode first`);
  const meta = JSON.parse(fs.readFileSync(path.join(framesDir, 'meta.json'), 'utf8'));
  const start = Number(args.start ?? 0);
  const end = Math.min(Number(args.end ?? files.length - 1), files.length - 1);
  const delay = Math.round(1000 / (meta.frames / meta.seconds)); // the real capture rate
  const frames = [];
  for (let i = start; i <= end; i++) {
    const full = decodePng(fs.readFileSync(path.join(framesDir, files[i])));
    const w = OUT_WIDTH;
    const h = Math.round((full.height * w) / full.width);
    frames.push(resize(full, w, h));
  }
  // One palette for the whole animation, built from a sample of frames.
  const step = Math.max(1, Math.floor(frames.length / 8));
  const sample = frames.filter((_, i) => i % step === 0);
  const joined = new Uint8Array(sample.reduce((n, f) => n + f.data.length, 0));
  let off = 0;
  for (const f of sample) {
    joined.set(f.data, off);
    off += f.data.length;
  }
  // 255 colours plus one transparent slot: a pixel that did not change since the previous frame is written as
  // transparent (disposal 1 keeps the previous frame), which makes the GIF several times smaller.
  const palette = quantize(joined, 255);
  palette.push([0, 0, 0]);
  const TRANSPARENT = palette.length - 1;
  const gif = GIFEncoder();
  let prev;
  frames.forEach((f, i) => {
    const index = applyPalette(f.data, palette.slice(0, TRANSPARENT));
    const out = prev ? index.map((v, k) => (v === prev[k] ? TRANSPARENT : v)) : index;
    prev = index;
    gif.writeFrame(out, f.width, f.height, {
      ...(i === 0 ? { palette, repeat: 0 } : {}),
      delay,
      transparent: i > 0,
      transparentIndex: TRANSPARENT,
      dispose: 1
    });
  });
  gif.finish();
  const gifPath = path.join(root, 'media', 'demo.gif');
  fs.writeFileSync(gifPath, gif.bytes());
  console.log(`wrote media/demo.gif: ${frames.length} frames, ${frames[0].width}x${frames[0].height}, ${delay} ms per frame, ${(gif.bytes().length / 1048576).toFixed(2)} MB`);

  const shotIndex = Number(args.shot ?? Math.floor(files.length / 2));
  const shot = decodePng(fs.readFileSync(path.join(framesDir, files[shotIndex])));
  const w = Math.min(1200, shot.width);
  const still = resize(shot, w, Math.round((shot.height * w) / shot.width));
  fs.writeFileSync(path.join(root, 'media', 'screenshot.png'), encodePng(still));
  console.log(`wrote media/screenshot.png from frame ${shotIndex}: ${still.width}x${still.height}`);
}

(async () => {
  if (!args.encode) await record();
  encode();
})().catch((err) => {
  console.error(err);
  killInstance();
  process.exit(1);
});
