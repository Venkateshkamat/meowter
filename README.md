# Meowter

A VS Code extension (also works in Cursor). After a configurable amount of active IDE use, your IDE goes into Zen mode and a tab full of cartoon cats appears, jumping, running and playing. Click **I took a break ⏸** to dismiss them and restart the timer.

- Time counts only while an IDE window is focused and you are active. It is shared across all windows of the same user profile (state is kept in a JSON file in the extension's global storage).
- A status bar item shows the minutes left (`🐱 42m`, or `🐱 Break!`). Clicking it opens the setting for the break interval. The countdown is hidden during a break because Zen mode hides the status bar.
- Closing the cat tab counts as clicking the button.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `meowter.breakIntervalMinutes` | 50 | Minutes of active IDE use before a break (min 1). |
| `meowter.idleThresholdMinutes` | 5 | Minutes without input after which time stops counting (min 1). |
| `meowter.catCount` | 8 | Number of cats shown during a break (1 to 30). |

Command: **Meowter: Set Break Interval** (`meowter.setBreakInterval`).

## Build, test, run

```sh
npm install
npm run compile        # extension + webview script
npm run test:unit      # mocha unit tests (no editor needed)
npm run test:vscode    # integration tests in the installed VS Code
npm run test:cursor    # integration tests in the installed Cursor
npm test               # unit + VS Code integration
```

The integration tests use the installed editors (macOS paths in `src/test/runTest.ts`; override with `MEOWTER_EDITOR_PATH`) with isolated profiles under `.vscode-test/`.

To try it: open this folder in VS Code or Cursor and press F5 ("Run Extension"), or run `cursor --extensionDevelopmentPath=<this folder>`. Lower `meowter.breakIntervalMinutes` to 1 to see a break quickly.
