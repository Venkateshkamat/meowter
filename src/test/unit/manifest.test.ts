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
