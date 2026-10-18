import * as fs from 'fs';
import * as path from 'path';
import { freshState, sanitizeState, SharedState } from './timer';

/**
 * File-backed shared state. Reads never throw (missing or corrupt files give
 * fresh state); writes are atomic (temp file + rename).
 */
export class SharedStateStore {
  private counter = 0;

  constructor(
    private readonly dir: string,
    private readonly fileName = 'state.json'
  ) {}

  get filePath(): string {
    return path.join(this.dir, this.fileName);
  }

  read(now: number = Date.now()): SharedState {
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      return sanitizeState(JSON.parse(text), now);
    } catch {
      return freshState(now);
    }
  }

  write(state: SharedState): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${this.counter++}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // temp file may not exist
      }
      throw err;
    }
  }
}
