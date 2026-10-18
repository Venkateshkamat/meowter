import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { MeowterTestApi } from '../../extension';

const EXT_ID = 'venkateshkamat.meowter';

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

  suiteSetup(async () => {
    // Some editors (Cursor) start the test run before the dev extension is registered.
    await waitFor(() => vscode.extensions.getExtension(EXT_ID) !== undefined, 'extension to be registered', 30000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, 'extension should be present');
    api = (await ext.activate()) as MeowterTestApi;
  });

  setup(async () => {
    await api.pause();
  });

  suiteTeardown(async () => {
    await api.pause();
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
    assert.strictEqual(api.getStatusBarText(), '🐱 Break!');
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
});
