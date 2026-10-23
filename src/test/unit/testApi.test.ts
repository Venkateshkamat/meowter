import * as assert from 'assert';
import { EXTENSION_MODE_TEST, exportsForMode } from '../../testApi';

describe('exportsForMode', () => {
  const api = { startBreakNow: () => undefined };

  it('returns the API in Test mode', () => {
    assert.strictEqual(exportsForMode(EXTENSION_MODE_TEST, api), api);
  });

  it('returns nothing in Production (1) and Development (2) mode', () => {
    assert.strictEqual(exportsForMode(1, api), undefined);
    assert.strictEqual(exportsForMode(2, api), undefined);
  });

  it('returns nothing for any other value', () => {
    for (const mode of [0, 4, -1, NaN]) {
      assert.strictEqual(exportsForMode(mode, api), undefined);
    }
  });
});
