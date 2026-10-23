# Meowter

> Pixel-art cats take over your editor when it's time for a break.

![Meowter: two cats face off, hiss and fight in a dust cloud, while a third climbs the side of the editor and a fourth jumps across the code](media/demo.gif)

## What it does

- Counts only the time you are actively using the editor, shared across all your windows.
- When the break is due, small pixel cats play on top of your code. They never block typing or clicking.
- Click **🐱 I took a break ⏸** in the status bar (or the notification) to send them away and restart the timer.
- If no editor is open, the cats play in a tab instead.
- Works in VS Code and Cursor.

## Cat styles

| Style | What the cat does |
| --- | --- |
| Wanderer | Walks, runs, sits, sleeps and swipes along the floor. |
| Climber | Climbs the side edges, hangs and grabs, then comes down. |
| Bouncer | Bounces in big arcs across the middle. |
| Yarn chaser | Chases and bats a ball of yarn. |
| Fighters | A pair that squares up, hisses and brawls in a dust cloud. |

Cats are dealt out to the enabled styles in turn, so the default 6 cats are one of each style. Fighters always take two cats, so a pair appears from 6 cats.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `meowter.breakIntervalMinutes` | 50 | Minutes of active use before a break. |
| `meowter.idleThresholdMinutes` | 5 | Minutes without input after which time stops counting. |
| `meowter.catCount` | 6 | Cats per editor (2 to 30). |
| `meowter.styles` | all on | Turn each style on or off: `wanderer`, `climber`, `bouncer`, `yarnChaser`, `fighters`. |

Command: **Meowter: Set Break Interval**.

## Known limitations

- Cats move with the text when you scroll sideways.
- Very long lines can make the cats' area narrower than the editor.

## Development

```sh
npm ci
npm run compile
npm test
npx vsce package
```

## License

MIT, see [LICENSE](LICENSE).
