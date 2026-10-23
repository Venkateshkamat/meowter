# Meowter

A VS Code extension (also works in Cursor). After a configurable amount of active IDE use, small pixel-art cats take over your code: they appear on top of every visible text editor, each moving in its own style (see [Cat styles](#cat-styles)): wandering along the bottom, climbing the side edges, bouncing across the middle, chasing yarn balls, or fighting in pairs. Your IDE layout is not touched, and the cats never block typing or clicking.

A notification says **Time for a break 🐱** with one button, **I took a break ⏸**. Click it to send the cats away and restart the timer. Dismissing the notification (its ✕) counts as clicking the button.

- Time counts only while an IDE window is focused and you are active. It is shared across all windows of the same user profile (state is kept in a JSON file in the extension's global storage). A pause in any window ends the break in all of them (the other windows are told by a file-system event, within a fraction of a second).
- The timer is cheap by design. A focused window counts in memory every second and writes the file only about every 15 seconds (and when it loses focus, when a break starts or ends, and when the extension shuts down), always as "the file's time plus what this window counted", so time from other windows is never overwritten. Reads and writes are asynchronous. A window that is not focused and has no break running has no timer at all; it wakes up on a file event or a window focus change. Settings are read once and when they change, and the status bar is only updated when its text changes. If the editor crashes, at most the last ~15 seconds of counted time are lost.
- A status bar item shows the minutes left (`🐱 42m`). Clicking it opens the setting for the break interval. During a break it reads `🐱 I took a break ⏸` and clicking it pauses, exactly like the notification button (the notification hides itself after a few seconds, the status bar item stays).
- Editors you open during the break (a new tab, a split, another file) get cats too. All cats are removed when the break ends.
- If no text editor is visible when the break starts, or every one is closed during the break, the cats appear in a full tab instead. The tab has no button: close the tab, click the status bar item, or use the notification to end the break. Closing the tab counts as clicking **I took a break ⏸**, and switching away from it brings it back. An editor that appears while the tab is showing does not switch the break back to decorations.
- A notification left over from an earlier break is ignored; it can never reset a newer timer.

### How the cats are drawn over the code

VS Code has no overlay API, so each editor gets one *whole-line* text decoration. Its CSS rule (injected through the decoration's `backgroundColor`) turns it into an absolutely positioned, `pointer-events: none` box that Monaco makes as wide as the editor's text area and paints above the code (below the cursor), showing a self-animating SVG scene: pixel cats whose positions are percentages of that width, moved and re-framed by CSS `step-end` animations on a shared 8 Hz clock. The box has its own compositor layer, so animating it does not repaint the code underneath, and it is attached to the last visible line (or the first one in short files), so it is re-anchored when you scroll.

Limitations:

- Monaco makes the box as wide as the editor's scroll width: the visible text area, or the widest line of the document when a line is longer than the editor. The visible width itself cannot be read by extensions, so the extension measures the document's widest line (tabs expanded, font size and letter spacing taken into account) and the box is capped with an estimate only when that line is wider than the estimate. The estimate is the window width (`100vw`) minus a fixed allowance for the sidebars, times this editor's share of the editor area (from the group layout), minus the gutter and minimap. When no line is wider than the estimate the box is plain `100%`: exactly the text area, whatever the sidebar state. Typing a very long line switches to the cap (and deleting it switches back). The estimate leans small, but with unusual layouts (a hidden sidebar plus long lines, many panels) the cats may use less, or occasionally somewhat more, than the visible width.
- Horizontal scrolling moves the cats with the text.
- With word wrap, or a file shorter than the editor, the floor is the bottom of the visible text rather than the exact bottom of the editor.
- Over the code, `meowter.catCount` is the number of cats **per editor**, at most 8 per editor and 16 over all editors together (with 3 editors open each gets 5, and so on). In the fallback cat tab it is the **total** number of cats.
- A notification left over in another window stays until dismissed (extensions cannot close it); it is ignored.

## Cat styles

Every cat has a movement style. The five styles:

| Style | What the cat does |
| --- | --- |
| **Wanderer** | Walks, runs, sits, idles, lies down, sleeps, swipes and hops, always on the floor. |
| **Climber** | Walks or runs to a side wall, climbs it, hangs and grabs (sometimes going higher and hanging again), then climbs down or drops, and repeats with some floor moves in between. |
| **Bouncer** | Big bouncing arcs across the middle of the screen. |
| **Yarn chaser** | Chases and bats a ball of yarn along the floor, with short rests. |
| **Fighters** | Always a **pair** of cats fighting on the floor, like a cartoon cat fight: they square up and face each other, arch their backs and puff their tails with a hiss, swat at each other, then rush together into a tumbling fight cloud (a ball of dust with paws, tails and little stars poking out) that rolls a bit. They break apart, back off or circle, pause, and go again; now and then one chases the other a short way. |

`meowter.catCount` is the number of cats per editor over the code (at most 8 per editor and 16 over all editors together) and the total number of cats in the fallback tab. **The default is 6, which is one of each style** (four single cats and one fighting pair), **and the minimum is 2**, so a fighting pair always works.

The cats are dealt out to the enabled styles in turn, in the order above, so with few cats each style gets one first: 1 cat is a Wanderer, 2 cats a Wanderer and a Climber, 4 cats the four single styles, 6 cats one of each style. With all styles on, a count below 6 deals the single cats first, so **the fighting pair appears from 6 cats**. Coat colours are varied across cats whatever their style. The over-code cats and the fallback cat tab use the same assignment.

How the pair rule works:

- **Fighters take two cats at a time**, so they always fight as a pair (two Fighters are next to each other in the order, and the two of them are always together).
- When it is the Fighters' turn and **fewer than two cats are left**, they are skipped and the next enabled style gets the cat. For example 5 cats are Wanderer, Climber, Bouncer, Yarn chaser, Wanderer.
- If **Fighters is the only style switched on** and the count is odd, the extra cat is a **Wanderer**, even though Wanderer is switched off (3 cats: a pair and a Wanderer; a lone cat cannot fight).
- With **several editors** the cats of all editors together are dealt out in this order, and **a pair is never split across two editors**. When the next cat in the order would be the first of a pair but only one slot is left on an editor, the first single cat further down the order takes that slot instead (or a Wanderer if there is none), and the pair starts the next editor. So every editor still gets exactly its share of cats, and normally only the order moves. An editor with room for a single cat never gets a Fighter.

Climbers spread out over the two walls and over different heights. When there are several fighting pairs, each pair keeps to its own band of the width (two pairs take the left and the right half), so they do not crowd one spot. In a face-off the two cats stand 1.15 sprite widths apart whatever the width of the editor, so they never overlap (in editors narrower than about four sprite widths, around 400 px, they may be pushed a little past the edge).

Turn styles on and off with the **Meowter: Styles** setting in the Settings UI (one boolean per style), or in `settings.json`:

```json
"meowter.styles": { "wanderer": true, "climber": false, "bouncer": true, "yarnChaser": true, "fighters": true }
```

A style that is missing from the object stays on (a setting saved before Fighters existed gets Fighters too). If you switch **all** styles off, every cat is a Wanderer. Over the code a change applies at once, even in the middle of a break; in the fallback cat tab it applies from the next break.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `meowter.breakIntervalMinutes` | 50 | Minutes of active IDE use before a break (min 1). |
| `meowter.idleThresholdMinutes` | 5 | Minutes without input after which time stops counting (min 1). |
| `meowter.catCount` | 6 | Number of cats shown during a break (2 to 30; a fighting pair counts as two cats). Over the code it is the number **per editor** (at most 8 per editor and 16 over all editors together); in the fallback cat tab it is the total. |
| `meowter.styles` | all on | Which [cat styles](#cat-styles) are used: `wanderer`, `climber`, `bouncer`, `yarnChaser`, `fighters` (booleans). All off means Wanderers only. |

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

## License

MIT — see [LICENSE](LICENSE).
