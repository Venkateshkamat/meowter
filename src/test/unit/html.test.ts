import * as assert from 'assert';
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
});
