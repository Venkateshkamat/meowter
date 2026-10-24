import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));

describe('package.json capabilities', () => {
  it('works in an untrusted workspace (Restricted Mode) and in virtual workspaces', () => {
    assert.deepStrictEqual(pkg.capabilities, {
      untrustedWorkspaces: { supported: true },
      virtualWorkspaces: true
    });
  });
});

describe('package.json "files" allowlist', () => {
  const files: string[] = pkg.files;

  it('lists exactly what ships', () => {
    assert.deepStrictEqual([...files].sort(), [
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'media/cats.css',
      'media/icon.png',
      'out/*.js',
      'out/webview/cats.js'
    ]);
  });

  it('has no broad globs, no negations and nothing outside the runtime folders', () => {
    assert.ok(Array.isArray(files) && files.length > 0);
    for (const pattern of files) {
      assert.ok(!pattern.includes('**'), `${pattern}: no recursive globs`);
      assert.ok(!/^[*!./]/.test(pattern), `${pattern}: not a broad glob, a negation or a dotfile pattern`);
      assert.ok(!/^\*\.[a-z]+$/.test(pattern), `${pattern}: not an extension glob`);
      assert.ok(/^(out\/|media\/|README\.md$|CHANGELOG\.md$|LICENSE$)/.test(pattern), `${pattern}: in an allowed place`);
    }
    for (const stray of ['todo', 'todo.txt', 'secrets.env', 'notes/todo.md', 'out/test/runTest.js', 'out/.webview/catArt.js', 'tsconfig.json']) {
      assert.ok(!files.some((p) => minimatchLike(p, stray)), `${stray} must not match any pattern`);
    }
  });

  it('is the only packaging filter: a .vscodeignore would make vsce refuse to package', () => {
    assert.ok(!fs.existsSync(path.resolve(__dirname, '../../../.vscodeignore')));
  });
});

/** Tiny glob match for the two kinds of pattern used here: exact paths and `*` within one path segment. */
function minimatchLike(pattern: string, file: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  return re.test(file);
}
