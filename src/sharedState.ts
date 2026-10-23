import * as fs from 'fs';
import * as path from 'path';
import { freshState, sanitizeState, SharedState } from './timer';

/**
 * The asynchronous I/O the shared timer needs. `read` gives fresh state when the file does not exist or is not valid
 * JSON, and rejects on any other error (permissions, too many open files, a busy disk): that is not "no state", the
 * caller must not treat it as one. `write` rejects on failure.
 */
export interface StateIo {
  read(): Promise<SharedState>;
  write(state: SharedState): Promise<void>;
}

/** A temp file older than this is the leftover of a crash, not a write in progress. */
export const ORPHAN_TMP_AGE_MS = 60_000;

export interface StateWatcher {
  close(): void;
}

/**
 * File-backed shared state. Everything is asynchronous, so the extension host never blocks on disk.
 * A missing or corrupt file gives fresh state; any other read error rejects. Writes are atomic (temp file + rename).
 */
export class SharedStateStore implements StateIo {
  private counter = 0;
  private dirReady = false;
  /** How many file reads and writes were made (diagnostics and tests). */
  readonly stats = { reads: 0, writes: 0 };

  constructor(
    private readonly dir: string,
    private readonly fileName = 'state.json'
  ) {}

  get filePath(): string {
    return path.join(this.dir, this.fileName);
  }

  async read(now: number = Date.now()): Promise<SharedState> {
    this.stats.reads++;
    let text: string;
    try {
      text = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return freshState(now);
      }
      throw err;
    }
    try {
      return sanitizeState(JSON.parse(text), now);
    } catch {
      return freshState(now); // not valid JSON
    }
  }

  async write(state: SharedState): Promise<void> {
    this.stats.writes++;
    if (!this.dirReady) {
      await fs.promises.mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    const tmp = `${this.filePath}.${process.pid}.${this.counter++}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(state), 'utf8');
      await fs.promises.rename(tmp, this.filePath);
    } catch (err) {
      this.dirReady = false;
      await fs.promises.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Creates the storage directory (the watcher needs it to exist) and removes temp files a crashed window left
   * behind (old ones only: a young one may belong to a write in progress in another window). Never rejects.
   */
  async ensureDir(now: number = Date.now()): Promise<void> {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      this.dirReady = true;
      const prefix = `${this.fileName}.`;
      for (const name of await fs.promises.readdir(this.dir)) {
        if (name.startsWith(prefix) && name.endsWith('.tmp')) {
          const file = path.join(this.dir, name);
          const age = now - (await fs.promises.stat(file)).mtimeMs;
          if (age > ORPHAN_TMP_AGE_MS) {
            await fs.promises.unlink(file);
          }
        }
      }
    } catch {
      // a later write reports the problem
    }
  }

  /** A cheap change signature (no file read), or undefined when the file does not exist. */
  async signature(): Promise<string | undefined> {
    try {
      const s = await fs.promises.stat(this.filePath);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Calls `onChange` when the state file may have changed (the OS pushes the event; nothing is polled).
   * Returns undefined when watching is not possible; the caller then has to poll. `onError` fires if the
   * watcher dies later.
   */
  watch(onChange: () => void, onError: () => void): StateWatcher | undefined {
    try {
      const watcher = fs.watch(this.dir, { persistent: false }, (_event, name) => {
        // Some platforms give no file name; temp files of atomic writes are not interesting.
        if (!name || name === this.fileName) {
          onChange();
        }
      });
      watcher.on('error', () => {
        watcher.close();
        onError();
      });
      return { close: () => watcher.close() };
    } catch {
      return undefined;
    }
  }
}
