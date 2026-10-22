# Meowter

A VS Code extension (also works in Cursor). After a configurable amount of active IDE use, small pixel-art cats take over your code: they appear on top of every visible text editor, walking and running along the bottom, sitting, napping, swiping, climbing the side edges, chasing yarn balls, and a few of them bouncing across the middle. Your IDE layout is not touched, and the cats never block typing or clicking.

A notification says **Time for a break 🐱** with one button, **I took a break ⏸**. Click it to send the cats away and restart the timer. Dismissing the notification (its ✕) counts as clicking the button.

- Time counts only while an IDE window is focused and you are active. It is shared across all windows of the same user profile (state is kept in a JSON file in the extension's global storage). A pause in any window ends the break in all of them.
- A status bar item shows the minutes left (`🐱 42m`). Clicking it opens the setting for the break interval. During a break it reads `🐱 I took a break ⏸` and clicking it pauses, exactly like the notification button (the notification hides itself after a few seconds, the status bar item stays).
- Editors you open during the break (a new tab, a split, another file) get cats too. All cats are removed when the break ends.
- If no text editor is visible when the break starts, or every one is closed during the break, the cats appear in a full tab instead (with the same **I took a break ⏸** button). Closing that tab counts as clicking the button, and switching away from it brings it back. An editor that appears while the tab is showing does not switch the break back to decorations.
- A notification left over from an earlier break is ignored; it can never reset a newer timer.

### How the cats are drawn over the code

VS Code has no overlay API, so each editor gets one *whole-line* text decoration. Its CSS rule (injected through the decoration's `backgroundColor`) turns it into an absolutely positioned, `pointer-events: none` box that Monaco makes as wide as the editor's text area and paints above the code (below the cursor), showing a self-animating SVG scene: pixel cats whose positions are percentages of that width, moved and re-framed by CSS `step-end` animations on a shared 8 Hz clock. The box has its own compositor layer, so animating it does not repaint the code underneath, and it is attached to the last visible line (or the first one in short files), so it is re-anchored when you scroll.

Limitations:

- The box is as wide as Monaco's scroll width: the visible text area, or the widest line when a line is longer than the editor (a horizontal scrollbar exists then). In that case cats can walk into the part of the box beyond the visible edge until you scroll sideways. The extension API and CSS give no way to read the visible width exactly; word wrap, short lines and wide editors are exact.
- Horizontal scrolling moves the cats with the text.
- With word wrap, or a file shorter than the editor, the floor is the bottom of the visible text rather than the exact bottom of the editor.
- At most 8 cats per editor and 16 in total are drawn (`meowter.catCount` still sets the number, up to those caps).
- A notification left over in another window stays until dismissed (extensions cannot close it); it is ignored.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `meowter.breakIntervalMinutes` | 50 | Minutes of active IDE use before a break (min 1). |
| `meowter.idleThresholdMinutes` | 5 | Minutes without input after which time stops counting (min 1). |
| `meowter.catCount` | 8 | Number of cats shown during a break (1 to 30; at most 8 per editor and 16 over all editors). |

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
