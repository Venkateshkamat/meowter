import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MeowterTestApi } from '../../extension';
import type { Notifier } from '../../notice';
import { assignStyles, enabledStyles, STYLE_NAMES } from '../../catStyles';
import { overlayWidthPx } from '../../overlayLayout';

const EXT_ID = 'venkateshkamat.meowter';
const NOTICE_MESSAGE = 'Time for a break 🐱';
const NOTICE_BUTTON = 'I took a break ⏸';
const BREAK_STATUS = '🐱 I took a break ⏸';

interface OverlayMeasure {
  w: number;
  x: number;
  h: number;
  viewOverlaysW: number;
  editorX: number;
  editorW: number;
  pe: string;
  pos: string;
  z: string;
  hscroll: string[];
  /** window.innerWidth, the CSS 100vw the width estimate is based on */
  vw: number;
}

/**
 * The overlay is Monaco's scroll width (the visible text area when no line is wider than the editor), capped by the
 * estimate of the visible width. Either way its right edge must not be beyond the editor's visible right edge, give
 * or take a few pixels (the estimate errs on the small side).
 */
/** The overlay must be Monaco's scroll width, capped to the estimate only when a line is wider than the estimate. */
function assertWidthDecision(m: OverlayMeasure, fraction: number, widestPx: number): void {
  const expected = overlayWidthPx(m.viewOverlaysW, widestPx, m.vw, fraction);
  assert.ok(Math.abs(m.w - expected) <= 1.5, `overlay ${m.w}px should be ${expected}px (scroll width ${m.viewOverlaysW}px, widest line ${widestPx}px, window ${m.vw}px): ${JSON.stringify(m)}`);
}

function assertInsideEditor(m: OverlayMeasure): void {
  assert.ok(m.x >= m.editorX - 1, `starts at the editor's left edge: ${JSON.stringify(m)}`);
  assert.ok(m.x + m.w <= m.editorX + m.editorW + 10, `the right wall is (about) the editor's visible right edge: ${JSON.stringify(m)}`);
}

/**
 * Measures the real overlay elements in the editor's DOM through the DevTools endpoint the test runner enables
 * (MEOWTER_CDP_PORT). Returns undefined when that is not available.
 */
async function measureOverlays(): Promise<OverlayMeasure[] | undefined> {
  const port = process.env.MEOWTER_CDP_PORT;
  const WS = (globalThis as unknown as { WebSocket?: new (url: string) => any }).WebSocket;
  if (!port || !WS) {
    return undefined;
  }
  const expression = `JSON.stringify([...document.querySelectorAll('[class*="ced-"]')]
    .filter((e) => /svg/.test(getComputedStyle(e).backgroundImage))
    .map((e) => {
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      const ed = e.closest('.monaco-editor'); const sc = ed.querySelector('.monaco-scrollable-element.editor-scrollable');
      const er = sc.getBoundingClientRect(); const vo = e.closest('.view-overlays');
      return { vw: window.innerWidth, w: r.width, x: r.x, h: r.height, viewOverlaysW: vo.getBoundingClientRect().width, editorX: er.x, editorW: er.width,
        pe: cs.pointerEvents, pos: cs.position, z: cs.zIndex,
        hscroll: [...ed.querySelectorAll('.scrollbar.horizontal')].map((h) => h.className + '|' + getComputedStyle(h).visibility) };
    }))`;
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  for (const target of targets.filter((t) => t.type === 'page')) {
    const result = await new Promise<string | undefined>((resolve) => {
      const ws = new WS(target.webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        ws.close();
        resolve(undefined);
      }, 5000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      ws.onmessage = (m: { data: string }) => {
        clearTimeout(timer);
        ws.close();
        try {
          resolve(JSON.parse(m.data).result?.result?.value);
        } catch {
          resolve(undefined);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
    });
    const list = result ? (JSON.parse(result) as OverlayMeasure[]) : [];
    if (list.length > 0) {
      return list;
    }
  }
  return [];
}

/** A notification stand-in the tests resolve by hand (button press = text, dismissal = undefined). */
class FakeNotifier implements Notifier {
  readonly calls: Array<{ message: string; buttons: string[]; resolve: (choice: string | undefined) => void }> = [];
  show(message: string, ...buttons: string[]): Promise<string | undefined> {
    return new Promise((resolve) => this.calls.push({ message, buttons, resolve }));
  }
}

function workspaceDir(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'tests run with an open folder');
  return folder.uri.fsPath;
}

/** Polls the real DOM until `count` overlays exist. Resolves undefined when DevTools is not available. */
async function waitForMeasures(count: number): Promise<OverlayMeasure[] | undefined> {
  const start = Date.now();
  for (;;) {
    const measures = await measureOverlays();
    if (measures === undefined) {
      console.log('DevTools endpoint not available; skipping the DOM measurement');
      return undefined;
    }
    if (measures.length >= count || Date.now() - start > 15000) {
      return measures;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Opens a file whose lines are SHORT, the case where an inline overlay would only be as wide as the text. */
async function openShortLines(name: string, lineCount: number, viewColumn: vscode.ViewColumn = vscode.ViewColumn.One): Promise<vscode.TextEditor> {
  const file = path.join(workspaceDir(), name);
  fs.writeFileSync(file, Array.from({ length: lineCount }, (_, i) => `a${i}`).join('\n'));
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { viewColumn, preview: false });
  await waitFor(() => editor.visibleRanges.length > 0, `visible ranges of ${name}`);
  return editor;
}

/** Opens a file whose lines are about 120 characters long, wider than a split editor. */
async function openLongLines(name: string, lineCount: number, viewColumn: vscode.ViewColumn = vscode.ViewColumn.One): Promise<vscode.TextEditor> {
  const file = path.join(workspaceDir(), name);
  fs.writeFileSync(file, Array.from({ length: lineCount }, (_, i) => `const long${i} = compute(${i}); // ${'x'.repeat(90)}`).join('\n'));
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { viewColumn, preview: false });
  await waitFor(() => editor.visibleRanges.length > 0, `visible ranges of ${name}`);
  return editor;
}

/** Opens a real (clean, so it closes without a save prompt) file as a visible editor. */
async function openCode(name: string, lineCount: number, viewColumn: vscode.ViewColumn = vscode.ViewColumn.One): Promise<vscode.TextEditor> {
  const file = path.join(workspaceDir(), name);
  const lines = Array.from({ length: lineCount }, (_, i) => `const value${i} = compute(${i}); // line ${i}`);
  fs.writeFileSync(file, lines.join('\n'));
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { viewColumn, preview: false });
  await waitFor(() => editor.visibleRanges.length > 0, `visible ranges of ${name}`);
  return editor;
}

/**
 * The window may have counted a second or two on top of what the file says (time is written every 15 s),
 * so a timer value is "the file's value plus a little", never less.
 */
function assertTimer(actual: number, fileValue: number, msg: string): void {
  assert.ok(actual >= fileValue && actual < fileValue + 5000, `${msg}: ${actual} should be ${fileValue} plus at most a few seconds`);
}

/**
 * The real-DOM checks need a window the OS actually renders: an unfocused (occluded) window may not paint the
 * decorations at all, which would be a false failure. Skips the test (with a log line) in that case, like the
 * refocus test does.
 */
function requireFocusedWindow(test: Mocha.Context): void {
  if (!vscode.window.state.focused) {
    console.log(`window not focused; skipping the real-DOM check "${test.test?.title ?? ''}"`);
    test.skip();
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite('Meowter extension', () => {
  let api: MeowterTestApi;
  let notifier: FakeNotifier;

  suiteSetup(async () => {
    // Some editors (Cursor) start the test run before the dev extension is registered.
    await waitFor(() => vscode.extensions.getExtension(EXT_ID) !== undefined, 'extension to be registered', 30000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, 'extension should be present');
    api = (await ext.activate()) as MeowterTestApi;
  });

  setup(async () => {
    notifier = new FakeNotifier();
    api.setNotifier(notifier);
    await api.pause();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  teardown(async () => {
    await api.pause();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const f of fs.readdirSync(workspaceDir())) {
      if (f.startsWith('meowter-test-')) {
        fs.rmSync(path.join(workspaceDir(), f), { force: true });
      }
    }
  });

  suiteTeardown(async () => {
    await api.pause();
    api.setNotifier(undefined);
  });

  test('activates and returns the test API', () => {
    assert.ok(vscode.extensions.getExtension(EXT_ID)?.isActive);
    assert.strictEqual(typeof api.startBreakNow, 'function');
  });

  test('settings have the right defaults', () => {
    const cfg = vscode.workspace.getConfiguration('meowter');
    assert.strictEqual(cfg.inspect('breakIntervalMinutes')?.defaultValue, 50);
    assert.strictEqual(cfg.inspect('idleThresholdMinutes')?.defaultValue, 5);
    assert.strictEqual(cfg.inspect('catCount')?.defaultValue, 6, 'six cats: one of each style');
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.strictEqual(ext?.packageJSON.contributes.configuration.properties['meowter.catCount'].minimum, 2, 'two cats at least, so a pair can fight');
  });

  test('the styles setting has a checkbox per style, all on by default', () => {
    const cfg = vscode.workspace.getConfiguration('meowter');
    assert.deepStrictEqual(cfg.inspect('styles')?.defaultValue, { wanderer: true, climber: true, bouncer: true, yarnChaser: true, fighters: true });
    const ext = vscode.extensions.getExtension(EXT_ID);
    const props = ext?.packageJSON.contributes.configuration.properties['meowter.styles'];
    assert.deepStrictEqual(Object.keys(props.properties), [...STYLE_NAMES]);
    for (const name of STYLE_NAMES) {
      assert.strictEqual(props.properties[name].type, 'boolean');
      const text: string = props.properties[name].description;
      assert.ok(text.length > 10 && text.length <= 60, `${name} has a short description that fits the Settings UI label (${text.length} chars)`);
    }
  });

  test('meowter.setBreakInterval is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('meowter.setBreakInterval'));
  });

  test('status bar text has the minutes format', async () => {
    await api.tickNow();
    assert.match(api.getStatusBarText(), /^🐱 \d+m$/);
  });

  test('shared state file is written to globalStorage', async () => {
    await api.pause();
    const file = api.getStateFilePath();
    assert.ok(file.includes('globalStorage'), `unexpected path ${file}`);
    assert.ok(fs.existsSync(file), 'state file should exist');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.activeMs, 0);
    assert.strictEqual(parsed.breakActive, false);
  });

  test('startBreakNow opens the cat webview and renders the cats', async () => {
    await api.startBreakNow();
    assert.strictEqual(api.isBreakPanelOpen(), true);
    const panel = api.getBreakPanelForTest();
    assert.ok(panel);
    assert.strictEqual(panel.viewType, 'meowter.break');
    assert.ok(panel.title.includes('Break time'));
    assert.strictEqual(api.getState().breakActive, true);
    assert.strictEqual(api.getStatusBarText(), BREAK_STATUS);
    const expected = vscode.workspace.getConfiguration('meowter').get<number>('catCount');
    await waitFor(() => api.getWebviewReport().ready, 'webview ready message');
    assert.strictEqual(api.getWebviewReport().cats, expected);
  });

  test('pause closes the panel and resets the state', async () => {
    await api.startBreakNow();
    assert.strictEqual(api.isBreakPanelOpen(), true);
    await api.pause();
    assert.strictEqual(api.isBreakPanelOpen(), false);
    const state = api.getState();
    assert.strictEqual(state.activeMs, 0);
    assert.strictEqual(state.breakActive, false);
    assert.match(api.getStatusBarText(), /^🐱 \d+m$/);
  });

  test('closing the cat tab as a user would is treated as pause', async () => {
    await api.startBreakNow();
    assert.strictEqual(api.isBreakPanelOpen(), true);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitFor(() => !api.isBreakPanelOpen(), 'panel closed');
    await waitFor(() => !api.getState().breakActive, 'break ended');
    assert.strictEqual(api.getState().activeMs, 0);
  });

  test('switching away from the cat tab brings it back and keeps the break active', async function () {
    await api.startBreakNow();
    const panel = api.getBreakPanelForTest();
    assert.ok(panel);
    await waitFor(() => panel.active, 'cat panel active');
    if (!vscode.window.state.focused) {
      // The refocus is deliberately skipped while the IDE window is unfocused.
      console.log('window not focused; skipping refocus assertion');
      return this.skip();
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active });
    await waitFor(() => panel.active, 'cat panel active again after switching away', 5000);
    assert.strictEqual(api.isBreakPanelOpen(), true);
    assert.strictEqual(api.getState().breakActive, true);
    // Empty untitled documents close without a save prompt.
    await api.pause();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('the shared file ending a break closes the panel without a second pause', async () => {
    await api.startBreakNow();
    const file = api.getStateFilePath();
    const state = api.getState();
    // Simulate another window pausing: rewrite the shared file.
    fs.writeFileSync(file, JSON.stringify({ ...state, activeMs: 0, breakActive: false, updatedAt: Date.now() }));
    await api.tickNow();
    await waitFor(() => !api.isBreakPanelOpen(), 'panel closed by shared state');
    assert.strictEqual(api.getState().breakActive, false);
    assert.strictEqual(api.getState().breakId, state.breakId);
  });

  test('a pause written by another window is picked up without any tick or click', async () => {
    await openCode('meowter-test-a.ts', 60);
    await api.startBreakNow();
    assert.strictEqual(api.getOverlayState().active, true);
    const state = api.getState();
    // Another window pauses: it rewrites the shared file. This window must notice by itself.
    fs.writeFileSync(api.getStateFilePath(), JSON.stringify({ ...state, activeMs: 0, breakActive: false, updatedAt: Date.now() }));
    await waitFor(() => !api.getState().breakActive, 'the pause from the other window', 5000);
    await waitFor(() => !api.getOverlayState().active, 'cats removed by the other window\'s pause', 5000);
    assert.strictEqual(api.getState().breakId, state.breakId);
    assert.match(api.getStatusBarText(), /^🐱 \d+m$/);
  });

  test('a break started by another window is picked up without any tick', async () => {
    await openCode('meowter-test-a.ts', 60);
    const state = api.getState();
    fs.writeFileSync(
      api.getStateFilePath(),
      JSON.stringify({ ...state, activeMs: 50 * 60_000, breakActive: true, breakId: state.breakId + 1, updatedAt: Date.now() })
    );
    await waitFor(() => api.getState().breakActive, 'the break from the other window', 5000);
    await waitFor(() => api.getOverlayState().active, 'cats shown for the other window\'s break', 5000);
    assert.strictEqual(api.getStatusBarText(), BREAK_STATUS);
    assert.strictEqual(notifier.calls.length, 1, 'one notification for the break');
  });

  test('a break ended by another window is noticed even if the file watcher is dead', async () => {
    await openCode('meowter-test-a.ts', 60);
    await api.startBreakNow();
    assert.strictEqual(api.getOverlayState().active, true);
    try {
      api.stopWatchingForTest();
      assert.strictEqual(api.isWatching(), false);
      const state = api.getState();
      fs.writeFileSync(api.getStateFilePath(), JSON.stringify({ ...state, activeMs: 0, breakActive: false, updatedAt: Date.now() }));
      // The break tick compares the file's signature once a second, so this takes about a second, not a minute.
      await waitFor(() => !api.getState().breakActive, 'the pause, found by the break tick', 5000);
      await waitFor(() => !api.getOverlayState().active, 'cats removed', 5000);
    } finally {
      api.startWatchingForTest();
      await api.pause();
    }
  });

  test('an unreadable shared file is not treated as an empty one: the break and the time survive', async function () {
    await openCode('meowter-test-a.ts', 60);
    await api.startBreakNow();
    const file = api.getStateFilePath();
    const breakId = api.getState().breakId;
    fs.chmodSync(file, 0o000);
    try {
      try {
        fs.readFileSync(file);
        return this.skip(); // running as root
      } catch {
        // as expected
      }
      await api.tickNow();
      await api.flushNow();
      await new Promise((r) => setTimeout(r, 1500)); // a few break ticks
      assert.strictEqual(api.getState().breakActive, true, 'the break is not ended by a read error');
      assert.strictEqual(api.getState().breakId, breakId);
    } finally {
      fs.chmodSync(file, 0o600);
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual([parsed.breakActive, parsed.breakId], [true, breakId], 'the file was not overwritten');
  });

  test('counting a tick touches no file: time is kept in memory and flushed in batches', async () => {
    await api.pause();
    // Background work (the watcher echo of our own write, a focus event) may read the file at any moment, so
    // take a few samples: five ticks must be able to run without touching the disk at all. A tick that did I/O
    // every time would fail every sample.
    let quiet = false;
    for (let attempt = 0; attempt < 5 && !quiet; attempt++) {
      await new Promise((r) => setTimeout(r, 400));
      const before = api.getIoStats();
      for (let i = 0; i < 5; i++) {
        await api.tickMemory();
      }
      quiet = JSON.stringify(api.getIoStats()) === JSON.stringify(before);
    }
    assert.ok(quiet, 'five ticks read and wrote nothing');
    // Flushing writes what was counted (if this window was counting) and leaves the file consistent with the view.
    await api.flushNow();
    const parsed = JSON.parse(fs.readFileSync(api.getStateFilePath(), 'utf8'));
    const view = api.getState();
    assert.ok(parsed.activeMs <= view.activeMs && view.activeMs - parsed.activeMs < 5000, `file ${parsed.activeMs} vs view ${view.activeMs}`);
  });

  test('flushNow writes the time counted in this window', async function () {
    await api.pause();
    // Count for real when the window is focused; otherwise there is nothing to flush and the test is moot.
    if (!vscode.window.state.focused) {
      return this.skip();
    }
    await waitFor(() => api.getPendingMs() > 0, 'a counted second', 6000);
    const pending = api.getPendingMs();
    assert.ok(pending > 0);
    const writes = api.getIoStats().writes;
    await api.flushNow();
    assert.ok(api.getIoStats().writes > writes, 'the flush wrote the file');
    const parsed = JSON.parse(fs.readFileSync(api.getStateFilePath(), 'utf8'));
    assert.ok(parsed.activeMs >= pending, `file has the counted time: ${parsed.activeMs} >= ${pending}`);
  });

  test('the tick runs only while the window is focused or a break is showing', async () => {
    await api.pause();
    await api.tickMemory();
    assert.strictEqual(api.isTicking(), vscode.window.state.focused);
    await api.startBreakNow();
    assert.strictEqual(api.isTicking(), true, 'a break keeps the tick going');
    await api.pause();
    assert.strictEqual(api.isTicking(), vscode.window.state.focused);
  });

  test('the state directory is watched, so other windows are noticed without polling', () => {
    assert.strictEqual(api.isWatching(), true);
  });

  test('a corrupt shared file is recovered as fresh state', async () => {
    fs.writeFileSync(api.getStateFilePath(), '{not json');
    await api.tickNow();
    const s = api.getState();
    assert.strictEqual(s.breakActive, false);
    assert.ok(s.activeMs >= 0);
  });

  /** Sets meowter.styles for one test; restores the default afterwards. */
  async function withStyles(value: unknown, body: () => Promise<void>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('meowter');
    await cfg.update('styles', value, vscode.ConfigurationTarget.Global);
    try {
      await body();
    } finally {
      await vscode.workspace.getConfiguration('meowter').update('styles', undefined, vscode.ConfigurationTarget.Global);
    }
  }

  suite('cat styles setting', () => {
    test('over the code: the cats are dealt out round-robin to the styles that are on', async () => {
      await openCode('meowter-test-a.ts', 80);
      const want = Math.min(vscode.workspace.getConfiguration('meowter').get<number>('catCount') ?? 6, 8);
      assert.strictEqual(want, 6, 'six cats by default');
      await api.startBreakNow();
      await waitFor(() => api.getOverlayState().editors.length === 1, 'the editor is decorated');
      assert.deepStrictEqual(api.getOverlayState().editors[0].styles, ['wanderer', 'climber', 'bouncer', 'yarnChaser', 'fighters', 'fighters']);
      await withStyles({ climber: false, yarnChaser: false }, async () => {
        // The setting applies live: the decorations are rebuilt for the new assignment.
        await waitFor(
          () => JSON.stringify(api.getOverlayState().editors[0]?.styles) === JSON.stringify(assignStyles(want, enabledStyles({ climber: false, yarnChaser: false }))),
          'the new styles are applied',
          5000
        );
        assert.ok(api.getOverlayState().editors[0].styles.every((s) => s === 'wanderer' || s === 'bouncer' || s === 'fighters'));
      });
      await waitFor(() => JSON.stringify(api.getOverlayState().editors[0]?.styles) === JSON.stringify(assignStyles(want)), 'back to all styles', 5000);
    });

    test('over the code: a single style, and all styles off falls back to the Wanderer', async () => {
      await openCode('meowter-test-a.ts', 80);
      await api.startBreakNow();
      await waitFor(() => api.getOverlayState().editors.length === 1, 'the editor is decorated');
      await withStyles({ wanderer: false, bouncer: false, yarnChaser: false, fighters: false }, async () => {
        await waitFor(() => api.getOverlayState().editors[0]?.styles.every((s) => s === 'climber'), 'only climbers', 5000);
      });
      await withStyles({ wanderer: false, climber: false, bouncer: false, yarnChaser: false, fighters: false }, async () => {
        await waitFor(() => api.getOverlayState().editors[0]?.styles.every((s) => s === 'wanderer'), 'only wanderers', 5000);
        assert.ok(api.getOverlayState().editors[0].styles.length >= 1);
      });
    });

    test('a small cat count gets one of each style first', async () => {
      await openCode('meowter-test-a.ts', 80);
      const cfg = vscode.workspace.getConfiguration('meowter');
      await cfg.update('catCount', 3, vscode.ConfigurationTarget.Global);
      try {
        await api.startBreakNow();
        await waitFor(() => api.getOverlayState().editors[0]?.cats === 3, 'three cats');
        assert.deepStrictEqual(api.getOverlayState().editors[0].styles, ['wanderer', 'climber', 'bouncer']);
      } finally {
        await cfg.update('catCount', undefined, vscode.ConfigurationTarget.Global);
      }
    });

    test('Fighters: a pair over the code, from the Fighters-only setting', async () => {
      await openCode('meowter-test-a.ts', 80);
      const cfg = vscode.workspace.getConfiguration('meowter');
      await cfg.update('catCount', 3, vscode.ConfigurationTarget.Global);
      try {
        await withStyles({ wanderer: false, climber: false, bouncer: false, yarnChaser: false }, async () => {
          await api.startBreakNow();
          // Three cats with only Fighters on: a pair, and the odd cat is a Wanderer.
          await waitFor(() => api.getOverlayState().editors[0]?.cats === 3, 'three cats');
          assert.deepStrictEqual(api.getOverlayState().editors[0].styles, ['fighters', 'fighters', 'wanderer']);
        });
      } finally {
        await cfg.update('catCount', undefined, vscode.ConfigurationTarget.Global);
      }
    });

    test('the cat count is at least two, whatever the setting says', async () => {
      await openCode('meowter-test-a.ts', 80);
      const cfg = vscode.workspace.getConfiguration('meowter');
      await cfg.update('catCount', 1, vscode.ConfigurationTarget.Global);
      try {
        await api.startBreakNow();
        await waitFor(() => api.getOverlayState().editors[0]?.cats === 2, 'two cats even though 1 is set');
        assert.deepStrictEqual(api.getOverlayState().editors[0].styles, ['wanderer', 'climber']);
      } finally {
        await cfg.update('catCount', undefined, vscode.ConfigurationTarget.Global);
      }
    });

    test('a fighting pair is never split across two editors', async () => {
      // (own file names: another test reopens meowter-test-b.ts with a different length, and a document that is
      // still open in the editor would keep the old text)
      await openCode('meowter-test-pair-a.ts', 80);
      await openCode('meowter-test-pair-b.ts', 80, vscode.ViewColumn.Beside);
      const cfg = vscode.workspace.getConfiguration('meowter');
      await cfg.update('catCount', 5, vscode.ConfigurationTarget.Global);
      try {
        await api.startBreakNow();
        await waitFor(() => api.getOverlayState().editors.length === 2 && api.getOverlayState().editors.every((e) => e.cats === 5), 'five cats on each editor');
        const lists = api.getOverlayState().editors.map((e) => e.styles);
        for (const list of lists) {
          assert.strictEqual(list.length, 5);
          assert.strictEqual(list.filter((s) => s === 'fighters').length % 2, 0, `no split pair: ${list}`);
        }
        assert.strictEqual(lists.flat().filter((s) => s === 'fighters').length, 2, 'the pair is whole, on one editor');
      } finally {
        await cfg.update('catCount', undefined, vscode.ConfigurationTarget.Global);
      }
    });

    test('in the cat tab a Fighters-only setting makes a fighting pair', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const cfg = vscode.workspace.getConfiguration('meowter');
      await cfg.update('catCount', 2, vscode.ConfigurationTarget.Global);
      try {
        await withStyles({ wanderer: false, climber: false, bouncer: false, yarnChaser: false }, async () => {
          await api.startBreakNow();
          assert.strictEqual(api.getBreakMode(), 'tab');
          await waitFor(() => api.getWebviewReport().ready, 'cat tab ready');
          assert.deepStrictEqual(api.getWebviewReport().styles, ['fighters', 'fighters']);
          await api.pause();
        });
      } finally {
        await cfg.update('catCount', undefined, vscode.ConfigurationTarget.Global);
      }
    });

    test('in the cat tab the page deals its cats out to the same styles (read at the start of the break)', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await withStyles({ wanderer: false, bouncer: false }, async () => {
        await api.startBreakNow();
        assert.strictEqual(api.getBreakMode(), 'tab');
        await waitFor(() => api.getWebviewReport().ready, 'cat tab ready');
        const report = api.getWebviewReport();
        const want = vscode.workspace.getConfiguration('meowter').get<number>('catCount') ?? 6;
        assert.deepStrictEqual(report.styles, assignStyles(want, enabledStyles({ wanderer: false, bouncer: false })));
        await api.pause();
      });
    });
  });

  suite('cats over the code', () => {
    test('a break with a visible editor decorates it, shows the notification and opens no cat tab', async () => {
      const editor = await openCode('meowter-test-a.ts', 120);
      await api.startBreakNow();
      assert.strictEqual(api.getBreakMode(), 'overlay');
      assert.strictEqual(api.isBreakPanelOpen(), false, 'no cat tab when an editor is visible');
      const overlay = api.getOverlayState();
      assert.strictEqual(overlay.active, true);
      assert.strictEqual(overlay.editors.length, 1);
      const info = overlay.editors[0];
      assert.strictEqual(info.uri, editor.document.uri.toString());
      assert.ok(info.cats >= 1 && info.cats <= 8, `cats per editor ${info.cats}`);
      assert.ok(info.heightPx >= 14 * 8, `overlay height ${info.heightPx}`);
      assert.ok(info.anchorLine >= 0 && info.anchorLine < 120);
      assert.strictEqual(info.anchor, 'bottom', 'a long visible range anchors to its last line');
      assert.strictEqual(overlay.typesCreated - overlay.typesDisposed, 1);
      assert.strictEqual(api.getStatusBarText(), BREAK_STATUS);
      assert.strictEqual(notifier.calls.length, 1);
      assert.strictEqual(notifier.calls[0].message, NOTICE_MESSAGE);
      assert.deepStrictEqual(notifier.calls[0].buttons, [NOTICE_BUTTON]);
      // The layout is untouched: still just the one editor, no extra tab.
      assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).length, 1);
    });

    test('cats per editor follow the catCount setting (capped for performance)', async () => {
      await openCode('meowter-test-a.ts', 120);
      await api.startBreakNow();
      const want = Math.min(vscode.workspace.getConfiguration('meowter').get<number>('catCount') ?? 6, 8);
      assert.strictEqual(api.getOverlayState().editors[0].cats, want);
    });

    test('pause removes every decoration', async () => {
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      assert.strictEqual(api.getOverlayState().editors.length, 1);
      await api.pause();
      const after = api.getOverlayState();
      assert.strictEqual(after.active, false);
      assert.strictEqual(after.editors.length, 0);
      assert.strictEqual(after.typesCreated, after.typesDisposed, 'every decoration type was disposed');
      assert.strictEqual(api.getBreakMode(), undefined);
      assert.strictEqual(api.getState().breakActive, false);
    });

    test('pressing the notification button pauses', async () => {
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      assert.strictEqual(notifier.calls.length, 1);
      notifier.calls[0].resolve(NOTICE_BUTTON);
      await waitFor(() => !api.getState().breakActive, 'break ended by the button');
      assert.strictEqual(api.getState().activeMs, 0);
      await waitFor(() => !api.getOverlayState().active, 'decorations removed');
    });

    test('dismissing the notification without clicking also pauses', async () => {
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      notifier.calls[0].resolve(undefined);
      await waitFor(() => !api.getState().breakActive, 'break ended by the dismissal');
      assert.strictEqual(api.getOverlayState().editors.length, 0);
    });

    test('a stale notification from an earlier break is ignored', async () => {
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      const first = api.getState().breakId;
      await api.pause();
      await api.startBreakNow();
      const second = api.getState().breakId;
      assert.ok(second > first, 'a new break has a new id');
      assert.strictEqual(notifier.calls.length, 2, 'one notification per break');
      // Dismissing the OLD notification must not touch the fresh break.
      notifier.calls[0].resolve(undefined);
      await new Promise((r) => setTimeout(r, 400));
      assert.strictEqual(api.getState().breakActive, true, 'fresh break still running');
      assert.strictEqual(api.getState().breakId, second);
      assert.strictEqual(api.getOverlayState().active, true);
      // The current notification still works.
      notifier.calls[1].resolve(NOTICE_BUTTON);
      await waitFor(() => !api.getState().breakActive, 'current notification pauses');
    });

    test('a stale notification never resets a running timer after the break ended', async () => {
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      await api.pause();
      const file = api.getStateFilePath();
      const state = api.getState();
      fs.writeFileSync(file, JSON.stringify({ ...state, activeMs: 123456, updatedAt: Date.now() }));
      notifier.calls[0].resolve(undefined);
      await new Promise((r) => setTimeout(r, 400));
      assertTimer(api.getState().activeMs, 123456, 'timer untouched by the stale notification');
    });

    test('with no visible editor the break falls back to the cat tab', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.startBreakNow();
      assert.strictEqual(api.getBreakMode(), 'tab');
      assert.strictEqual(api.isBreakPanelOpen(), true);
      assert.strictEqual(api.getOverlayState().active, false);
      assert.strictEqual(api.getOverlayState().editors.length, 0);
      assert.strictEqual(notifier.calls.length, 1, 'the notification is shown in this mode too');
      await waitFor(() => api.getWebviewReport().ready, 'cat tab ready');
      // Closing the fallback tab is a pause.
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await waitFor(() => !api.getState().breakActive, 'tab close paused');
    });

    test('an editor that becomes visible during the break gets cats too', async () => {
      await openCode('meowter-test-a.ts', 100);
      await api.startBreakNow();
      assert.strictEqual(api.getOverlayState().editors.length, 1);
      const second = await openCode('meowter-test-b.ts', 8, vscode.ViewColumn.Beside);
      await waitFor(() => api.getOverlayState().editors.length === 2, 'second editor decorated');
      const infos = api.getOverlayState().editors;
      const b = infos.find((e) => e.uri === second.document.uri.toString());
      assert.ok(b, 'the new editor is decorated');
      assert.strictEqual(b.anchor, 'top', 'a short file anchors to its first line and extends downward');
      assert.ok(b.heightPx >= 14 * 8);
      // Closing it removes just its decoration; the other keeps its cats.
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await waitFor(() => api.getOverlayState().editors.length === 1, 'closed editor undecorated');
      assert.strictEqual(api.getState().breakActive, true);
      const s = api.getOverlayState();
      assert.strictEqual(s.typesCreated - s.typesDisposed, 1);
    });

    test('scrolling re-anchors the cats to the visible lines', async () => {
      const editor = await openCode('meowter-test-a.ts', 400);
      await api.startBreakNow();
      const before = api.getOverlayState().editors[0].anchorLine;
      // Layout can still be settling right after the editor opened, so keep asking until it scrolls.
      const start = Date.now();
      while (!(api.getOverlayState().editors[0]?.anchorLine > before + 100)) {
        assert.ok(Date.now() - start < 20000, 'overlay re-anchored after scrolling');
        editor.revealRange(new vscode.Range(300, 0, 300, 0), vscode.TextEditorRevealType.AtTop);
        await new Promise((r) => setTimeout(r, 400));
      }
      assert.strictEqual(api.getOverlayState().editors.length, 1);
    });

    test('opening an editor after a tab-mode break started keeps the cat tab as is', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.startBreakNow();
      assert.strictEqual(api.getBreakMode(), 'tab');
      await openCode('meowter-test-a.ts', 40, vscode.ViewColumn.Beside);
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(api.getOverlayState().active, false, 'one cat surface per break');
      assert.strictEqual(api.isBreakPanelOpen(), true);
    });

    test('the overlay covers the whole visible text width of the editor, even over short lines (real DOM)', async function () {
      requireFocusedWindow(this);
      await openShortLines('meowter-test-short.ts', 120);
      await api.startBreakNow();
      let measures: OverlayMeasure[] | undefined;
      const start = Date.now();
      do {
        measures = await measureOverlays();
        if (measures === undefined) {
          console.log('DevTools endpoint not available; skipping the DOM measurement');
          return this.skip();
        }
        if (measures.length === 0) {
          await new Promise((r) => setTimeout(r, 300));
        }
      } while (measures.length === 0 && Date.now() - start < 15000);
      assert.strictEqual(measures.length, 1, 'one overlay in the one visible editor');
      const m = measures[0];
      assert.ok(m.editorW > 200, `editor width ${m.editorW}`);
      // Short lines: Monaco's width is the text area, and the estimate only caps it if it is smaller.
      const info = api.getOverlayState().editors[0];
      assert.strictEqual(info.widthFraction, 1, 'one column');
      assertWidthDecision(m, info.widthFraction, info.widestPx);
      assert.ok(Math.abs(m.w - m.viewOverlaysW) <= 1.5, `short lines: no cap, the overlay is the whole text area (${m.w}px vs ${m.viewOverlaysW}px)`);
      assertInsideEditor(m);
      assert.ok(m.h >= 14 * 8, `overlay height ${m.h}`);
      assert.strictEqual(m.pe, 'none', 'click-through');
      assert.strictEqual(m.pos, 'absolute');
      assert.ok(Number(m.z) >= 1, `stacked above the text (z-index ${m.z})`);
      for (const h of m.hscroll) {
        assert.ok(/invisible/.test(h) || /hidden/.test(h), `no horizontal scrollbar appeared: ${h}`);
      }
    });

    test('in split editors every overlay spans its own editor (real DOM)', async function () {
      requireFocusedWindow(this);
      await openShortLines('meowter-test-a.ts', 90);
      await openShortLines('meowter-test-b.ts', 90, vscode.ViewColumn.Beside);
      await api.startBreakNow();
      await waitFor(() => api.getOverlayState().editors.length === 2, 'both editors decorated');
      await waitFor(() => api.getOverlayState().editors.every((e) => Math.abs(e.widthFraction - 0.5) < 0.05), 'each editor knows it has half the width');
      let measures: OverlayMeasure[] | undefined;
      const start = Date.now();
      do {
        measures = await measureOverlays();
        if (measures === undefined) {
          return this.skip();
        }
        if (measures.length < 2) {
          await new Promise((r) => setTimeout(r, 300));
        }
      } while (measures.length < 2 && Date.now() - start < 15000);
      assert.strictEqual(measures.length, 2);
      const widest = api.getOverlayState().editors[0].widestPx;
      for (const m of measures) {
        assertWidthDecision(m, 0.5, widest);
        if (m.viewOverlaysW <= m.editorW + 1) {
          assertInsideEditor(m);
        } else {
          console.log(`short lines but the editor's own layer is wider than it (${m.viewOverlaysW}px > ${m.editorW}px): no cap applies`);
        }
      }
      assert.notStrictEqual(Math.round(measures[0].x), Math.round(measures[1].x), 'two different editors');
    });

    test('in a narrow split with long lines the overlay is capped to about the visible width (real DOM)', async function () {
      requireFocusedWindow(this);
      // 120-character lines: wider than a split editor, so Monaco's scroll width exceeds the visible width.
      await openLongLines('meowter-test-a.ts', 90);
      await openLongLines('meowter-test-b.ts', 90, vscode.ViewColumn.Beside);
      await api.startBreakNow();
      await waitFor(() => api.getOverlayState().editors.length === 2, 'both editors decorated');
      await waitFor(() => api.getOverlayState().editors.every((e) => Math.abs(e.widthFraction - 0.5) < 0.05), 'each editor knows it has half the width');
      let measures: OverlayMeasure[] | undefined;
      const start = Date.now();
      do {
        measures = await measureOverlays();
        if (measures === undefined) {
          return this.skip();
        }
        if (measures.length < 2) {
          await new Promise((r) => setTimeout(r, 300));
        }
      } while (measures.length < 2 && Date.now() - start < 15000);
      assert.strictEqual(measures.length, 2);
      for (const m of measures) {
        console.log(`narrow split, long lines: scroll width ${Math.round(m.viewOverlaysW)}px, overlay ${Math.round(m.w)}px, visible editor ${Math.round(m.editorW)}px, window ${m.vw}px`);
        assertWidthDecision(m, 0.5, api.getOverlayState().editors[0].widestPx);
        assert.ok(api.getOverlayState().editors[0].widestPx > 600, 'the document has long lines');
        assert.ok(m.w <= m.editorW + 10, `the overlay (${m.w}px) stays within the visible editor width (${m.editorW}px)`);
      }
    });

    test('short lines with the sidebar hidden: the overlay is the whole text area, not an estimate (real DOM)', async function () {
      requireFocusedWindow(this);
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      try {
        await openShortLines('meowter-test-short.ts', 120);
        await api.startBreakNow();
        const measures = await waitForMeasures(1);
        if (!measures) {
          return this.skip();
        }
        const m = measures[0];
        const info = api.getOverlayState().editors[0];
        assert.ok(info.widestPx <= 200, `short lines (${info.widestPx}px)`);
        assert.ok(Math.abs(m.w - m.viewOverlaysW) <= 1.5, `overlay ${m.w}px must equal the text area ${m.viewOverlaysW}px, whatever the sidebar state`);
        assertWidthDecision(m, 1, info.widestPx);
        console.log(`sidebar hidden, short lines: overlay ${Math.round(m.w)}px, text area ${Math.round(m.viewOverlaysW)}px, window ${m.vw}px`);
      } finally {
        await vscode.commands.executeCommand('workbench.view.explorer');
      }
    });

    test('typing a very long line mid-break switches the overlay to the cap (real DOM)', async function () {
      requireFocusedWindow(this);
      const editor = await openShortLines('meowter-test-short.ts', 60);
      await api.startBreakNow();
      let measures = await waitForMeasures(1);
      if (!measures) {
        return this.skip();
      }
      const before = measures[0];
      assert.ok(Math.abs(before.w - before.viewOverlaysW) <= 1.5, 'short lines: the whole layer');
      const widestBefore = api.getOverlayState().editors[0].widestPx;
      try {
        await editor.edit((b) => b.insert(new vscode.Position(0, 2), 'x'.repeat(500)));
        await waitFor(() => api.getOverlayState().editors[0]?.widestPx > widestBefore + 2000, 'the overlay noticed the long line');
        // The decoration is replaced, so wait for the capped width to show up in the DOM.
        const start = Date.now();
        let after: OverlayMeasure | undefined;
        do {
          measures = await measureOverlays();
          after = measures?.[0];
          if (!after || Math.abs(after.w - after.viewOverlaysW) <= 1.5) {
            await new Promise((r) => setTimeout(r, 300));
          }
        } while ((!after || Math.abs(after.w - after.viewOverlaysW) <= 1.5) && Date.now() - start < 15000);
        assert.ok(after, 'overlay still present');
        const info = api.getOverlayState().editors[0];
        assertWidthDecision(after, 1, info.widestPx);
        assert.ok(after.w < after.viewOverlaysW, `capped (${after.w}px) below Monaco's layer (${after.viewOverlaysW}px)`);
        // The estimate errs small for ordinary layouts; a window crowded by other panels (Cursor's agent
        // panel in a small test window) can leave the editor narrower than any estimate can know.
        if (overlayWidthPx(1e9, 1e9, after.vw, 1) <= after.editorW + 10) {
          assert.ok(after.w <= after.editorW + 10, `within the visible editor (${after.editorW}px)`);
        } else {
          console.log(`the editor (${after.editorW}px) is narrower than the estimate (${Math.round(after.w)}px): crowded window`);
        }
        console.log(`before typing: overlay ${Math.round(before.w)}px; after a 500-character line: overlay ${Math.round(after.w)}px of a ${Math.round(after.viewOverlaysW)}px layer, visible editor ${Math.round(after.editorW)}px`);
      } finally {
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      // Reverting removes the long line, but Monaco's layer stays wide, so the cap is held for the rest of the break.
      await new Promise((r) => setTimeout(r, 1200));
      assert.ok(api.getOverlayState().editors[0].widestPx > widestBefore + 2000, 'the peak is held after the line is gone');
      // A new break starts fresh.
      await api.pause();
      await api.startBreakNow();
      await waitFor(() => api.getOverlayState().editors.length === 1, 'decorated again');
      assert.ok(api.getOverlayState().editors[0].widestPx <= widestBefore, 'the peak was reset when the break ended');
    });

    test('typing a long line and undoing it keeps the cap: the layer never shrinks (real DOM)', async function () {
      requireFocusedWindow(this);
      const editor = await openShortLines('meowter-test-short.ts', 60);
      await api.startBreakNow();
      const measures = await waitForMeasures(1);
      if (!measures) {
        return this.skip();
      }
      const widestBefore = api.getOverlayState().editors[0].widestPx;
      try {
        await editor.edit((b) => b.insert(new vscode.Position(0, 2), 'x'.repeat(500)));
        await waitFor(() => api.getOverlayState().editors[0]?.widestPx > widestBefore + 2000, 'the overlay noticed the long line');
        if (vscode.window.state.focused) {
          await vscode.commands.executeCommand('undo');
        } else {
          // The undo command needs a focused window; deleting the text has the same effect on the document.
          await editor.edit((b) => b.delete(new vscode.Range(0, 2, 0, 502)));
        }
        await waitFor(() => !editor.document.getText().includes('xxxxxxxxxx'), 'the long line is undone');
        // Give the debounced re-check time to run, then look at what the browser really did.
        await new Promise((r) => setTimeout(r, 1500));
        const info = api.getOverlayState().editors[0];
        assert.ok(info.widestPx > widestBefore + 2000, 'the peak is held, so the cap stays');
        const after = (await measureOverlays())?.[0];
        assert.ok(after, 'overlay still present');
        assertWidthDecision(after, 1, info.widestPx);
        if (after.viewOverlaysW > after.editorW * 2) {
          // The case this test is about: Monaco keeps the wide layer, the overlay must stay capped.
          assert.ok(after.w < after.viewOverlaysW, `still capped (${after.w}px), not the stale layer`);
        } else {
          console.log(`this editor shrank its layer back to ${Math.round(after.viewOverlaysW)}px after the undo`);
        }
        if (overlayWidthPx(1e9, 1e9, after.vw, 1) <= after.editorW + 10) {
          assert.ok(after.w <= after.editorW + 10, `within the visible editor (${after.editorW}px)`);
        } else {
          console.log(`the editor (${after.editorW}px) is narrower than the estimate: crowded window`);
        }
        console.log(`after typing and undoing a long line: overlay ${Math.round(after.w)}px, layer ${Math.round(after.viewOverlaysW)}px, visible editor ${Math.round(after.editorW)}px`);
        // Scrolling does not bring the stale width back either.
        editor.revealRange(new vscode.Range(50, 0, 50, 0), vscode.TextEditorRevealType.AtTop);
        await new Promise((r) => setTimeout(r, 1000));
        const scrolled = (await measureOverlays())?.[0];
        assert.ok(scrolled && Math.abs(scrolled.w - after.w) <= 1.5, 'unchanged after scrolling');
      } finally {
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    });

    test('during a break the status bar is the pause button; outside one it is the countdown', async () => {
      const cmd = (): string | undefined => api.getStatusBarCommand();
      assert.match(api.getStatusBarText(), /^🐱 \d+m$/);
      assert.strictEqual(cmd(), 'workbench.action.openSettings');
      assert.ok(api.getStatusBarTooltip().includes('Click to change the break interval'));
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      assert.strictEqual(api.getStatusBarText(), BREAK_STATUS);
      assert.strictEqual(cmd(), 'meowter.pause');
      assert.ok(api.getStatusBarTooltip().includes(NOTICE_BUTTON));
      // Clicking runs the item's command, exactly like the notification button.
      await vscode.commands.executeCommand(cmd() as string);
      await waitFor(() => !api.getState().breakActive, 'status bar click paused');
      assert.strictEqual(api.getState().activeMs, 0);
      assert.strictEqual(api.getOverlayState().editors.length, 0);
      assert.match(api.getStatusBarText(), /^🐱 \d+m$/);
      assert.strictEqual(cmd(), 'workbench.action.openSettings');
    });

    test('meowter.pause outside a break leaves the timer alone', async () => {
      await api.tickNow();
      const file = api.getStateFilePath();
      const state = api.getState();
      assert.strictEqual(state.breakActive, false);
      fs.writeFileSync(file, JSON.stringify({ ...state, activeMs: 654321, updatedAt: Date.now() }));
      await vscode.commands.executeCommand('meowter.pause');
      const after = api.getState();
      assertTimer(after.activeMs, 654321, 'a stray pause must not zero the timer');
      assert.strictEqual(after.breakActive, false);
      assert.strictEqual(after.breakId, state.breakId);
    });

    test('meowter.pause during a break pauses', async () => {
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      assert.strictEqual(api.getState().breakActive, true);
      await vscode.commands.executeCommand('meowter.pause');
      assert.strictEqual(api.getState().breakActive, false);
      assert.strictEqual(api.getState().activeMs, 0);
      assert.strictEqual(api.getOverlayState().editors.length, 0);
    });

    test('a stale pause click after another window already paused does nothing', async () => {
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      const state = api.getState();
      // Another window pauses and the user has since worked for a while.
      fs.writeFileSync(api.getStateFilePath(), JSON.stringify({ ...state, breakActive: false, activeMs: 4242, updatedAt: Date.now() }));
      await vscode.commands.executeCommand('meowter.pause');
      assertTimer(api.getState().activeMs, 4242, 'the click must not reset the timer again');
      assert.strictEqual(api.getState().breakActive, false);
      await api.tickNow();
      await waitFor(() => !api.getOverlayState().active, 'decorations removed by the shared state');
    });

    test('the status bar item never pauses outside a break', async () => {
      const state = api.getState();
      fs.writeFileSync(api.getStateFilePath(), JSON.stringify({ ...state, activeMs: 777000, updatedAt: Date.now() }));
      await api.tickNow();
      const cmd = api.getStatusBarCommand();
      assert.strictEqual(cmd, 'workbench.action.openSettings', 'outside a break the item opens settings, not pause');
      await vscode.commands.executeCommand('meowter.pause');
      assert.ok(api.getState().activeMs >= 777000);
    });

    test('the status bar button also works in cat-tab mode', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.startBreakNow();
      assert.strictEqual(api.getBreakMode(), 'tab');
      assert.strictEqual(api.getStatusBarText(), BREAK_STATUS);
      await vscode.commands.executeCommand(api.getStatusBarCommand() as string);
      await waitFor(() => !api.getState().breakActive, 'status bar click paused');
      await waitFor(() => !api.isBreakPanelOpen(), 'cat tab closed');
    });

    test('closing every text editor during an overlay break falls back to the cat tab', async () => {
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      assert.strictEqual(api.getBreakMode(), 'overlay');
      assert.strictEqual(api.isBreakPanelOpen(), false);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitFor(() => api.getBreakMode() === 'tab', 'fell back to the cat tab', 10000);
      await waitFor(() => api.isBreakPanelOpen(), 'cat tab opened');
      assert.strictEqual(api.getOverlayState().active, false);
      assert.strictEqual(api.getOverlayState().editors.length, 0);
      assert.strictEqual(api.getState().breakActive, true, 'still the same break');
      // No flip-flopping: an editor that appears later does not switch the break back to decorations.
      await openCode('meowter-test-b.ts', 40, vscode.ViewColumn.Beside);
      await new Promise((r) => setTimeout(r, 1500));
      assert.strictEqual(api.getBreakMode(), 'tab');
      assert.strictEqual(api.getOverlayState().active, false);
      assert.strictEqual(api.isBreakPanelOpen(), true);
      // The fallback tab pauses like any cat tab.
      await api.pause();
      assert.strictEqual(api.isBreakPanelOpen(), false);
      assert.strictEqual(api.getBreakMode(), undefined);
    });

    test('switching between editors during a break does not drop to the cat tab', async () => {
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      await openCode('meowter-test-b.ts', 60);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await new Promise((r) => setTimeout(r, 1500));
      assert.strictEqual(api.getBreakMode(), 'overlay');
      assert.strictEqual(api.isBreakPanelOpen(), false);
      assert.strictEqual(api.getOverlayState().editors.length, 1);
    });

    test('the shared file ending a break removes the decorations without a second pause', async () => {
      await openCode('meowter-test-a.ts', 60);
      await api.startBreakNow();
      const state = api.getState();
      fs.writeFileSync(api.getStateFilePath(), JSON.stringify({ ...state, activeMs: 0, breakActive: false, updatedAt: Date.now() }));
      await api.tickNow();
      await waitFor(() => !api.getOverlayState().active, 'decorations removed by shared state');
      assert.strictEqual(api.getState().breakId, state.breakId);
    });
  });
});
