import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildBreakHtml, makeNonce, PAUSE_BUTTON_TEXT } from '../../html';

describe('buildBreakHtml', () => {
  const nonce = makeNonce();
  const html = buildBreakHtml({
    cspSource: 'vscode-resource:',
    nonce,
    scriptUri: 'vscode-resource:/cats.js',
    styleUri: 'vscode-resource:/cats.css',
    catCount: 12
  });

  it('has the exact button text', () => {
    assert.strictEqual(PAUSE_BUTTON_TEXT, 'I took a break ⏸');
    assert.ok(html.includes('>I took a break ⏸</button>'));
  });
  it('uses a strict nonce-based CSP with no network', () => {
    assert.ok(html.includes(`script-src 'nonce-${nonce}'`));
    assert.ok(html.includes(`default-src 'none'`));
    assert.ok(!html.includes('unsafe-inline'));
    assert.ok(!/https?:\/\//.test(html));
    assert.ok(html.includes(`<script nonce="${nonce}"`));
  });
  it('has no heading, only the button in the overlay', () => {
    assert.ok(!/<h[1-6]/.test(html));
    assert.ok(!html.includes('Time for a break'));
  });
  it('passes the cat count', () => {
    assert.ok(html.includes('data-cat-count="12"'));
  });
  it('generates distinct nonces', () => {
    assert.notStrictEqual(makeNonce(), makeNonce());
  });
  it('has no background of its own', () => {
    assert.ok(!/background/i.test(html.replace(/<link[^>]*>/g, '')));
  });
});

describe('cats.css', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../../media/cats.css'), 'utf8');
  it('lets the editor background show through', () => {
    assert.ok(/html, body \{[^}]*background: transparent/.test(css));
    assert.ok(!/gradient\(/.test(css), 'no page-wide gradient');
    assert.ok(!/#stage \{[^}]*background/.test(css));
  });
  it('scales the pixel art with nearest-neighbour rendering', () => {
    assert.ok(/\.cat,\s*\.ball \{[^}]*image-rendering: pixelated/.test(css));
  });
  it('keeps the pause button styled', () => {
    assert.ok(css.includes('#pause'));
  });
});
