# Changelog

All notable changes to Meowter are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.3] - 2026-11-06

### Changed

- `meowter.catCount` is now the number of cats in each window, shared out over its visible editors. It used to be per editor, with a hidden limit of 8 per editor and 16 per window, so a setting of 30 now really shows 30.
- The timer starts over every day at 12 am local time. A break still showing then ends too.

### Fixed

- Wall climbers now have proper legs: they use the same walk and stand poses as the cats on the floor.
- Changing the break interval in the Settings editor no longer locks up the IDE. Typing a value saved every step of it ("30" saves "3" first), which could start a break mid-typing. A lowered interval that is already reached now allows one more minute of use before the break.
- Git diff tabs show cats on both sides in Cursor, instead of opening a new cat tab.
- Cats no longer appear doubled when scrolling with word wrap on, and scrolling no longer swaps them for new ones.
- Cats keep the same size wherever the editor is scrolled, and stay near the bottom of the editor at the end of a file.
- Cats no longer go behind the text in Cursor.
- With word wrap on, files with long lines no longer squeeze the cats into a narrow strip.

## [1.0.2] - 2026-10-24

### Changed

- Display name is now **Meowter: Cat Breaks** (the Marketplace reserved the old name).

## [1.0.1] - 2026-10-24

### Changed

- Extension ID is now `venkateshkamat.meowter-cats` (display name still Meowter); packaging now uses an explicit file allowlist.

## [1.0.0] - 2026-10-23

First public release.

### Added

- **Break timer.** Counts only the time you are actively using the editor: a window must be focused and you must have used it recently, and the time stops counting after a period without input. The count is shared by all windows of the same editor profile, and pausing in one window ends the break in all of them.
- **Cats over your code.** When the break starts, pixel-art cats appear on top of every visible text editor. They never block typing or clicking, your layout is not changed, and they go away when the break ends. Editors you open during the break get cats too.
- **Cat tab fallback.** If no text editor is visible when the break starts (or you close them all), the cats play in a full tab instead.
- **Notification and status bar pause.** A notification says "Time for a break" with an "I took a break" button. During a break the status bar item reads "I took a break" and clicking it pauses as well. Pausing sends the cats away and restarts the timer. Closing the cat tab or dismissing the notification counts as a pause too.
- **Status bar countdown.** Shows the minutes left until your next break. Clicking it opens the break interval setting.
- **Five movement styles.** Wanderers walk, run, sit, sleep and swipe along the bottom. Climbers scale the side edges, hang and grab. Bouncers bounce across the middle. Yarn chasers bat a ball of yarn along the floor. Fighters are a pair of cats that square up, hiss and brawl in a cloud of dust. Switch each style on or off with the `meowter.styles` setting.
- **Pixel-art cats in 8 coats.** Orange tabby, grey tabby, black, white, calico, tuxedo, brown and siamese, all drawn as small animated pixel art.
- **Settings.**
  - `meowter.breakIntervalMinutes`: minutes of active use before a break (default 50).
  - `meowter.idleThresholdMinutes`: minutes without input after which time stops counting (default 5).
  - `meowter.catCount`: number of cats per editor during a break, or in the cat tab (default 6, one of each style; minimum 2 so a fighting pair always works).
  - `meowter.styles`: which movement styles are used.
- **Meowter: Set Break Interval** command, to change the break interval quickly.
- **Works in Cursor** as well as VS Code.
- **Light on your CPU.** The timer ticks only while a window is focused or a break is showing, writes to disk only now and then, and the cat animations run in the background without repainting your code.
