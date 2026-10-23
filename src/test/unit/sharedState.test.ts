import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ORPHAN_TMP_AGE_MS, SharedStateStore } from '../../sharedState';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('SharedStateStore', () => {
  let dir: string;
  let store: SharedStateStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meowter-'));
    store = new SharedStateStore(path.join(dir, 'nested', 'storage'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns fresh state when the file is missing', async () => {
    const s = await store.read(123);
    assert.deepStrictEqual([s.activeMs, s.breakActive, s.breakId, s.updatedAt], [0, false, 0, 123]);
  });

  it('round-trips state and creates missing directories', async () => {
    await store.write({ version: 1, activeMs: 5000, breakActive: true, breakId: 4, updatedAt: 99 });
    const s = await store.read();
    assert.deepStrictEqual([s.activeMs, s.breakActive, s.breakId, s.updatedAt], [5000, true, 4, 99]);
  });

  it('writes atomically and leaves no temp files', async () => {
    for (let i = 0; i < 20; i++) {
      await store.write({ version: 1, activeMs: i, breakActive: false, breakId: 0, updatedAt: i });
    }
    const files = fs.readdirSync(path.dirname(store.filePath));
    assert.deepStrictEqual(files, ['state.json']);
    assert.strictEqual((await store.read()).activeMs, 19);
  });

  it('recovers from corrupt content', async () => {
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, '{"activeMs": 12, ');
    assert.strictEqual((await store.read(7)).activeMs, 0);
    fs.writeFileSync(store.filePath, '');
    assert.strictEqual((await store.read(7)).breakActive, false);
    fs.writeFileSync(store.filePath, '[1,2,3]');
    assert.strictEqual((await store.read(7)).breakId, 0);
  });

  it('treats an unreadable file as an error, not as "no state"', async function () {
    await store.write({ version: 1, activeMs: 7000, breakActive: true, breakId: 3, updatedAt: 1 });
    fs.chmodSync(store.filePath, 0o000);
    try {
      let readable = true;
      try {
        fs.readFileSync(store.filePath);
      } catch {
        readable = false;
      }
      if (readable) {
        return this.skip(); // running as root: permissions do not apply
      }
      await assert.rejects(store.read(), (err: NodeJS.ErrnoException) => err.code === 'EACCES');
    } finally {
      fs.chmodSync(store.filePath, 0o600);
    }
    assert.strictEqual((await store.read()).breakId, 3, 'readable again: the state is intact');
  });

  it('treats a directory where the file should be as an error', async () => {
    fs.mkdirSync(store.filePath, { recursive: true });
    await assert.rejects(store.read());
  });

  it('removes old orphaned temp files at startup, but not young ones or other files', async () => {
    const d = path.dirname(store.filePath);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'state.json.111.0.tmp'), 'x');
    fs.writeFileSync(path.join(d, 'state.json.222.0.tmp'), 'x');
    fs.writeFileSync(path.join(d, 'other.tmp'), 'x');
    fs.writeFileSync(store.filePath, '{}');
    // "Now" is far enough after the files were made for them to count as old, except for the one touched later.
    const future = Date.now() + ORPHAN_TMP_AGE_MS + 5000;
    fs.utimesSync(path.join(d, 'state.json.222.0.tmp'), new Date(future), new Date(future));
    await store.ensureDir(future);
    assert.deepStrictEqual(fs.readdirSync(d).sort(), ['other.tmp', 'state.json', 'state.json.222.0.tmp']);
  });

  it('overwrites a corrupt file on the next write', async () => {
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, 'garbage');
    await store.write({ version: 1, activeMs: 1, breakActive: false, breakId: 0, updatedAt: 1 });
    assert.strictEqual((await store.read()).activeMs, 1);
  });

  it('cleans up the temp file when the rename fails', async () => {
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    // A directory at the target path makes rename fail.
    fs.mkdirSync(store.filePath);
    await assert.rejects(store.write({ version: 1, activeMs: 1, breakActive: false, breakId: 0, updatedAt: 1 }));
    const leftovers = fs.readdirSync(path.dirname(store.filePath)).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  });

  it('recreates the directory if it vanished after the first write', async () => {
    await store.write({ version: 1, activeMs: 1, breakActive: false, breakId: 0, updatedAt: 1 });
    fs.rmSync(path.dirname(store.filePath), { recursive: true, force: true });
    await assert.rejects(store.write({ version: 1, activeMs: 2, breakActive: false, breakId: 0, updatedAt: 2 }));
    await store.write({ version: 1, activeMs: 3, breakActive: false, breakId: 0, updatedAt: 3 });
    assert.strictEqual((await store.read()).activeMs, 3);
  });

  it('counts reads and writes', async () => {
    await store.read();
    await store.write({ version: 1, activeMs: 1, breakActive: false, breakId: 0, updatedAt: 1 });
    await store.read();
    assert.deepStrictEqual(store.stats, { reads: 2, writes: 1 });
  });

  it('gives a cheap signature that changes with the file', async () => {
    assert.strictEqual(await store.signature(), undefined);
    await store.write({ version: 1, activeMs: 1, breakActive: false, breakId: 0, updatedAt: 1 });
    const a = await store.signature();
    assert.ok(a);
    await store.write({ version: 1, activeMs: 22222, breakActive: false, breakId: 0, updatedAt: 1 });
    assert.notStrictEqual(await store.signature(), a);
    assert.strictEqual(store.stats.reads, 0, 'the signature reads no file');
  });

  describe('watch', () => {
    it('reports a change made by another writer (another window)', async function () {
      await store.ensureDir();
      let events = 0;
      const watcher = store.watch(() => events++, () => undefined);
      if (!watcher) {
        return this.skip();
      }
      try {
        const other = new SharedStateStore(path.dirname(store.filePath));
        await other.write({ version: 1, activeMs: 9, breakActive: false, breakId: 0, updatedAt: 1 });
        for (let i = 0; i < 40 && events === 0; i++) {
          await wait(25);
        }
        assert.ok(events > 0, 'the write was reported');
      } finally {
        watcher.close();
      }
    });

    it('ignores other files in the directory', async function () {
      await store.ensureDir();
      let events = 0;
      const watcher = store.watch(() => events++, () => undefined);
      if (!watcher) {
        return this.skip();
      }
      try {
        fs.writeFileSync(path.join(path.dirname(store.filePath), 'unrelated.txt'), 'x');
        await wait(300);
        assert.strictEqual(events, 0);
      } finally {
        watcher.close();
      }
    });

    it('returns undefined when the directory cannot be watched', () => {
      assert.strictEqual(store.watch(() => undefined, () => undefined), undefined); // directory does not exist yet
    });
  });
});
