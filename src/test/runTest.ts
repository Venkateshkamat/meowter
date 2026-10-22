import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const EDITORS: Record<string, string> = {
  vscode: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  cursor: '/Applications/Cursor.app/Contents/MacOS/Cursor'
};

/** A free local port, used for the editor's DevTools endpoint (lets a test measure the real DOM). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  const editor = process.argv[2] ?? process.env.MEOWTER_TEST_EDITOR ?? 'vscode';
  const vscodeExecutablePath = process.env.MEOWTER_EDITOR_PATH ?? EDITORS[editor];
  if (!vscodeExecutablePath || !fs.existsSync(vscodeExecutablePath)) {
    throw new Error(`Editor "${editor}" not found at ${vscodeExecutablePath}`);
  }
  const root = path.resolve(__dirname, '../../');
  // Short directory names keep the IPC socket path under the macOS length limit.
  const base = path.join(root, '.vscode-test', editor === 'cursor' ? 'c' : 'v');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  // An open folder is required: Cursor opens an empty window as its "Agents" (glass) window,
  // which does not load the extension under development.
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace, { recursive: true });

  const cdpPort = await freePort();
  console.log(`Running integration tests in ${editor}: ${vscodeExecutablePath}`);
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, './suite/index'),
    extensionTestsEnv: { MEOWTER_CDP_PORT: String(cdpPort) },
    launchArgs: [
      workspace,
      '--user-data-dir',
      path.join(base, 'ud'),
      '--extensions-dir',
      path.join(base, 'ext'),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--remote-debugging-port=${cdpPort}`
    ]
  });
}

main().catch((err) => {
  console.error('Failed to run tests:', err);
  process.exit(1);
});
