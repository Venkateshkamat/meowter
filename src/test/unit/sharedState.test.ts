import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SharedStateStore } from '../../sharedState';

describe('SharedStateStore', () => {
  let dir: string;
  let store: SharedStateStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meowter-'));
    store = new SharedStateStore(path.join(dir, 'nested', 'storage'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns fresh state when the file is missing', () => {
    const s = store.read(123);
    assert.deepStrictEqual([s.activeMs, s.breakActive, s.breakId, s.updatedAt], [0, false, 0, 123]);
  });

  it('round-trips state and creates missing directories', () => {
    store.write({ version: 1, activeMs: 5000, breakActive: true, breakId: 4, updatedAt: 99 });
    const s = store.read();
    assert.deepStrictEqual([s.activeMs, s.breakActive, s.breakId, s.updatedAt], [5000, true, 4, 99]);
  });

  it('writes atomically and leaves no temp files', () => {
    for (let i = 0; i < 20; i++) {
      store.write({ version: 1, activeMs: i, breakActive: false, breakId: 0, updatedAt: i });
    }
    const files = fs.readdirSync(path.dirname(store.filePath));
    assert.deepStrictEqual(files, ['state.json']);
    assert.strictEqual(store.read().activeMs, 19);
  });

  it('recovers from corrupt content', () => {
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, '{"activeMs": 12, ');
    assert.strictEqual(store.read(7).activeMs, 0);
    fs.writeFileSync(store.filePath, '');
    assert.strictEqual(store.read(7).breakActive, false);
    fs.writeFileSync(store.filePath, '[1,2,3]');
    assert.strictEqual(store.read(7).breakId, 0);
  });

  it('overwrites a corrupt file on the next write', () => {
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, 'garbage');
    store.write({ version: 1, activeMs: 1, breakActive: false, breakId: 0, updatedAt: 1 });
    assert.strictEqual(store.read().activeMs, 1);
  });

  it('cleans up the temp file when the rename fails', () => {
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    // A directory at the target path makes rename fail.
    fs.mkdirSync(store.filePath);
    assert.throws(() => store.write({ version: 1, activeMs: 1, breakActive: false, breakId: 0, updatedAt: 1 }));
    const leftovers = fs.readdirSync(path.dirname(store.filePath)).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  });
});
