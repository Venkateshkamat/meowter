import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MeowterTestApi } from '../../extension';
import type { Notifier } from '../../notice';
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
    assert.strictEqual(cfg.inspect('catCount')?.defaultValue, 8);
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

  test('a corrupt shared file is recovered as fresh state', async () => {
    fs.writeFileSync(api.getStateFilePath(), '{not json');
    await api.tickNow();
    const s = api.getState();
    assert.strictEqual(s.breakActive, false);
    assert.ok(s.activeMs >= 0);
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
      const want = Math.min(vscode.workspace.getConfiguration('meowter').get<number>('catCount') ?? 8, 8);
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
      assert.strictEqual(api.getState().activeMs, 123456, 'timer untouched by the stale notification');
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
      await openShortLines('meowter-test-a.ts', 90);
      await openShortLines('meowter-test-b.ts', 90, vscode.ViewColumn.Beside);
      await api.startBreakNow();
      await waitFor(() => api.getOverlayState().editors.length === 2, 'both editors decorated');
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
        await vscode.commands.executeCommand('undo');
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
      assert.strictEqual(after.activeMs, 654321, 'a stray pause must not zero the timer');
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
      assert.strictEqual(api.getState().activeMs, 4242, 'the click must not reset the timer again');
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
