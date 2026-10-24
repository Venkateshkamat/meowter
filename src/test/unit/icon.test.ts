import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');

describe('extension icon', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  it('package.json points to media/icon.png', () => {
    assert.strictEqual(pkg.icon, 'media/icon.png');
  });

  it('the icon is a valid 128x128 PNG', () => {
    const png = fs.readFileSync(path.join(root, pkg.icon));
    assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
    assert.strictEqual(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.strictEqual(png.readUInt32BE(16), 128, 'width');
    assert.strictEqual(png.readUInt32BE(20), 128, 'height');
    assert.strictEqual(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
  });

  it('is part of the package allowlist', () => {
    assert.ok(pkg.files.includes('media/icon.png'));
  });
});
