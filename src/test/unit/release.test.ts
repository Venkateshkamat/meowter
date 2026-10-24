import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

const root = path.resolve(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const check = require(path.join(root, 'scripts', 'check-release.js')) as {
  normalizeTag(tag: unknown): string;
  checkVersion(tag: string, version: string): { ok: boolean; message: string };
  checkVsixEntries(entries: string[]): { ok: boolean; unexpected: string[]; missing: string[] };
  listZipEntries(file: string): string[];
};

const GOOD = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  'extension/media/cats.css',
  'extension/media/icon.png',
  'extension/out/extension.js',
  'extension/out/catArt.js',
  'extension/out/webview/cats.js'
];

/** A minimal stored (uncompressed) zip with empty files: enough to exercise the directory reader. */
function makeZip(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(n.length, 26);
    n.copy(local, 30);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    n.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe('release checks (scripts/check-release.js)', () => {
  describe('tag and version', () => {
    it('accepts a matching version, with or without a leading v', () => {
      assert.ok(check.checkVersion('v1.0.2', '1.0.2').ok);
      assert.ok(check.checkVersion('1.0.2', '1.0.2').ok);
    });

    it('rejects a mismatching or empty tag with a clear message', () => {
      const r = check.checkVersion('v1.0.3', '1.0.2');
      assert.ok(!r.ok);
      assert.ok(r.message.includes('v1.0.3') && r.message.includes('1.0.2'));
      assert.ok(!check.checkVersion('', '1.0.2').ok);
      assert.ok(!check.checkVersion('vv1.0.2', '1.0.2').ok);
      assert.ok(!check.checkVersion('v1.0.2-rc.1', '1.0.2').ok);
    });

    it('strips only one leading v', () => {
      assert.strictEqual(check.normalizeTag('v2.3.4'), '2.3.4');
      assert.strictEqual(check.normalizeTag(' 2.3.4 '), '2.3.4');
    });
  });

  describe('package contents', () => {
    it('accepts the expected runtime files', () => {
      const r = check.checkVsixEntries(GOOD);
      assert.deepStrictEqual(r, { ok: true, unexpected: [], missing: [] });
    });

    it('rejects stray files', () => {
      for (const stray of ['todo.txt', 'extension/todo', 'extension/todo.txt', 'extension/.env', 'secrets.env', 'extension/notes/todo.md', 'extension/out/test/runTest.js', 'extension/out/extension.js.map', 'extension/src/extension.ts', 'extension/scripts/make-icon.js', 'extension/media/demo.gif']) {
        const r = check.checkVsixEntries([...GOOD, stray]);
        assert.ok(!r.ok, `${stray} must be rejected`);
        assert.deepStrictEqual(r.unexpected, [stray]);
      }
    });

    it('rejects a package that lacks the runtime files', () => {
      const r = check.checkVsixEntries(GOOD.filter((n) => n !== 'extension/out/extension.js'));
      assert.ok(!r.ok);
      assert.deepStrictEqual(r.missing, ['extension/out/extension.js']);
    });

    it('reads the file names of a zip and the CLI rejects a doctored package', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meowter-release-'));
      try {
        const good = path.join(dir, 'good.vsix');
        const bad = path.join(dir, 'bad.vsix');
        fs.writeFileSync(good, makeZip(GOOD));
        fs.writeFileSync(bad, makeZip([...GOOD, 'todo.txt']));
        assert.deepStrictEqual(check.listZipEntries(good), GOOD);
        const script = path.join(root, 'scripts', 'check-release.js');
        assert.strictEqual(childProcess.spawnSync(process.execPath, [script, 'vsix', good]).status, 0);
        const rejected = childProcess.spawnSync(process.execPath, [script, 'vsix', bad], { encoding: 'utf8' });
        assert.notStrictEqual(rejected.status, 0);
        assert.ok(rejected.stderr.includes('::error::') && rejected.stderr.includes('todo.txt'));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('publish workflow (.github/workflows/publish.yml)', () => {
  const text = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
  const wf = parse(text);
  const job = wf.jobs.publish;
  const steps: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string>; if?: string }> = job.steps;

  it('runs when a release is published, and can be re-run by hand with a tag', () => {
    assert.deepStrictEqual(wf.on.release.types, ['published']);
    assert.strictEqual(wf.on.workflow_dispatch.inputs.tag.required, true);
  });

  it('skips pre-releases, never publishes one tag twice at once, and has least privilege', () => {
    assert.ok(String(job.if).includes('!github.event.release.prerelease'));
    assert.ok(wf.concurrency.group.includes('tag_name') && wf.concurrency.group.includes('inputs.tag'));
    assert.strictEqual(wf.concurrency['cancel-in-progress'], false);
    assert.deepStrictEqual(wf.permissions, { contents: 'write' });
  });

  it('pins actions to a major version', () => {
    const uses = steps.map((s) => s.uses).filter(Boolean);
    assert.ok(uses.length >= 2);
    for (const u of uses) {
      assert.ok(/^[\w-]+\/[\w-]+@v\d+$/.test(String(u)), `${u} is pinned to a major version`);
    }
  });

  it('publishes to both stores with their secrets, skipping versions that exist', () => {
    const vsce = steps.find((s) => s.run?.includes('vsce publish'));
    const ovsx = steps.find((s) => s.run?.includes('ovsx publish'));
    assert.ok(vsce && ovsx);
    assert.ok(vsce.run?.includes('--skip-duplicate') && ovsx.run?.includes('--skip-duplicate'));
    assert.strictEqual(vsce.env?.VSCE_PAT, '${{ secrets.VSCE_PAT }}');
    assert.strictEqual(ovsx.env?.OVSX_PAT, '${{ secrets.OVSX_PAT }}');
    assert.ok(vsce.run?.includes('-z "$VSCE_PAT"') && ovsx.run?.includes('-z "$OVSX_PAT"'), 'a missing secret fails with a message');
    const upload = steps.find((s) => s.run?.includes('gh release upload'));
    assert.ok(upload?.run?.includes('--clobber'));
    assert.strictEqual(upload?.env?.GH_TOKEN, '${{ github.token }}');
  });

  it('never echoes secrets or traces commands, and keeps user input out of scripts', () => {
    assert.ok(!/set -x|xtrace/.test(text));
    for (const s of steps) {
      assert.ok(!/\$\{\{\s*(secrets|github\.event|inputs)/.test(s.run ?? ''), `${s.name}: no expression inside a script`);
      assert.ok(!/echo[^\n]*(PAT|secrets\.)/.test(s.run?.replace(/echo "::error::[^\n]*/g, '') ?? ''), `${s.name}: does not echo a secret`);
    }
  });

  it('runs compile, the unit tests, and the release checks before publishing', () => {
    const order = steps.map((s) => s.run ?? '');
    const idx = (needle: string) => order.findIndex((r) => r.includes(needle));
    assert.ok(idx('npm ci') < idx('npm run compile') && idx('npm run compile') < idx('npm run test:unit'));
    assert.ok(idx('npm run test:unit') < idx('check-release.js version'));
    assert.ok(idx('check-release.js version') < idx('vsce package') && idx('vsce package') < idx('check-release.js vsix'));
    assert.ok(idx('check-release.js vsix') < idx('vsce publish') && idx('check-release.js vsix') < idx('ovsx publish'));
  });

  it('keeps .github out of the package', () => {
    assert.ok(!(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files as string[]).some((p) => p.startsWith('.github')));
  });
});
