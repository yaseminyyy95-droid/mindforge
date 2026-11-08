# MindForge

A web-based cognitive training platform inspired by brain-training apps: short games in five areas (Memory, Attention, Speed, Math, Logic) with XP, levels, a daily streak, adaptive difficulty and a cognitive profile.

Plain HTML5, CSS3 and vanilla JavaScript (ES6+). No framework, no build step, no backend, no login. All data stays in the browser's `localStorage`.

## Run it

Open `index.html` in a browser (double-click works, `file://` is supported). No server is needed.

## Games

| Category | Game | Unlock | What it trains |
|---|---|---|---|
| Memory | Memory Match | start | Flip cards and find pairs (2×3 to 6×4 grid) |
| Memory | Sequence Recall | 200 XP | Repeat a sequence of lit pads; length follows a 1-up/1-down staircase |
| Memory | Grid Memory | 500 XP | Remember which cells lit up and tap them (3×3 to 6×6) |
| Attention | Target Focus | start | Find one target symbol among look-alikes |
| Attention | Color Filter | 250 XP | Go/no-go: tap only shapes that match a colour (and shape) rule |
| Attention | Distraction Hunt | 600 XP | Find the one arrow that points differently while other cells blink |
| Speed | Reaction Rush | start | Tap a target the moment it appears; false starts cost points |
| Speed | Quick Switch | 300 XP | Answer by COLOR or SHAPE as the cue switches (records switch cost) |
| Speed | Speed Sequence | 700 XP | Tap tiles in order (1-2-3… or 1-A-2-B…) as fast as possible |
| Math | Quick Calculate | start | Arithmetic under time pressure (four options) |
| Math | Number Compare | 200 XP | Which expression is bigger, or are they equal? |
| Math | Missing Number | 500 XP | Find the number that completes the equation |
| Logic | Pattern Shift | start | Predict the next tile when shape/colour/count/rotation follow rules |
| Logic | Logic Grid | 250 XP | Place colours (and pets) in houses from clues; one solution each |
| Logic | Path Finder | 600 XP | Shortest route on a walled grid, sometimes through a checkpoint |

Every game has five levels. After each game the level moves up, stays or moves down depending on the game's own criteria (accuracy plus speed, span or false alarms), and "Play Again" starts at the new level.

## Project structure

```
index.html            page shell; scripts are loaded in a fixed order (see below)
css/style.css         theme variables, layout, buttons, modal, toggles
css/dashboard.css     dashboard, profile, history table
css/games.css         shared game panels (mm-*) and one prefixed block per game (.sr-, .cf-, .qs-, ...)
css/responsive.css    phone layout (<= 760px / <= 560px)
js/data.js            MF.CONFIG, MF.CATEGORIES, MF.GAMES (the game registry), MF.GameModules = {}
js/storage.js         the only file that touches localStorage (key prefix "mindforge:")
js/audio.js           sound effects and music (generated with the Web Audio API; FILES_AVAILABLE = true switches to mp3 files)
js/scoring.js         MF.Scoring.createResult(): the common result object and its XP
js/difficulty.js      levels 1-5, MF.Difficulty.next(level, result, { upAt, downAt, targetTime })
js/progress.js        MF.Progress.recordResult(): XP, history, per-game progress, streak, unlocks
js/profile.js         category scores (0-100) from the last 5 results of each game
games/<category>/*.js one file per game, registered in MF.GameModules
js/app.js             screens (dashboard, category, progress, settings) and game navigation
tests/                development-only tests (see below); not loaded by the app
```

Script order is fixed: `data → storage → audio → scoring → difficulty → progress → profile → games/** → app`. Everything lives under one global namespace, `window.MF`; there are no ES modules, so the page also works from `file://`.

## Adding a game

1. Add the game's entry to `MF.GAMES` in `js/data.js` (or reuse an existing one). An entry without a module is shown as a non-clickable "Coming soon" card.
2. Create `games/<category>/<id>.js` and register it:
   ```js
   MF.GameModules['my-game'] = { create(root, api) { ...; return { destroy() {} }; }, helpers: { /* pure functions */ } };
   ```
   `api.exit()` returns to the screen the game was opened from; `api.onProgress()` refreshes the header after recording a result.
3. Follow the shared lifecycle: intro screen (name, rules, level, Start Game) → game → result screen (Play Again / Back to Games).
   - Schedule every timeout through one `later(fn, delay)` helper that stores ids in a `timers` set and checks an `alive` flag.
   - `destroy()` clears all timers, removes every listener (including any `document` keydown listener) and drops state. `app.js` calls it whenever the game view is left.
4. At the end: `MF.Scoring.createResult({ gameId, score, accuracy (0-1), time (s), difficulty })`, put game-specific data under `result.details`, then `MF.Progress.recordResult(result, { upAt, downAt })` and `api.onProgress()`.
5. Keep constants (level table, score values, thresholds) at the top of the file and calculations as pure functions exported under `helpers`. No `eval`/`Function`; generation loops are bounded and have a fallback.
6. Add a `<script>` tag before `js/app.js`, CSS with a game-specific prefix in `css/games.css`, and make sure the layout works at 360 px width with touch targets of at least 44 px.

## Tests

The app has no dependencies. The tests use two development-only packages, installed in `tests/` only.

```
cd tests
npm install
npm run unit       # node:test + jsdom: properties of generators/scoring and full game flows
npm run browser    # playwright-core with the installed Chrome (CHROME=<path> for another binary)
```

- **Unit / jsdom** (`tests/node/*.test.js`, harness in `tests/lib/harness.js`):
  - The harness loads `index.html` with all scripts in order, scales timers ×0.1 (or less) and tracks every live timeout/interval.
  - Generators are checked with independent solvers in `tests/lib/solvers.js`, which only use what the player sees (labels, clue text, grid).
  - Each new game also gets jsdom flows: wrong/timeout paths, double input, Exit/navigation cleanup, clean re-entry, SFX on/off with a fake `Audio`, XP/history/profile and adaptive level.
- **Real browser** (`tests/browser/run.js`, results in `tests/browser/out/`, git-ignored):
  - A: full desktop flow.
  - B: leaving games mid-way.
  - C: settings persistence.
  - D: audio with a `FILES_AVAILABLE = true` copy.
  - E: 360×740 and 390×844 phone viewports (overflow, touch targets, screenshots).
  - F: one full game per newer game.
  - `ONLY=A,F npm run browser` runs a subset.

Only Chrome (Chromium) has been tested; Firefox and Safari have not.

## Known gaps

- Only the newer games and the three Math games expose `helpers`; Memory Match, Reaction Rush and Target Focus do not. Memory Match uses plain `setTimeout`/`setInterval` instead of the `later()`/`alive` pattern, though its cleanup is correct.
- `level-up` and `unlock` sound effects are defined but never played.
- `progress.js` writes the `unlocked` storage key, but nothing reads it (unlock state comes from XP).
- Streak days use UTC (`toISOString()`), so in Turkey (UTC+3) the day changes at 03:00 local time.
- The profile score only uses accuracy and difficulty; speed is not reflected in Speed/Attention scores.
- Color Filter and Quick Switch depend on telling colours apart. Shapes and symbols are added where possible, but these two games remain harder for colour-blind players.
- On phones, Logic Grid level 4-5 (clues + two tables) is taller than the screen, so players scroll between clues and grid.
- Target Focus level 5 cells are 38 px wide on a 360 px screen (below the 44 px target); the newer games keep 44 px.
- Level timings, par times and adaptation thresholds are estimates, not tuned on real player data.
- No audio files are included. With the default `FILES_AVAILABLE = false` sounds and a short background loop are synthesised in the browser (Web Audio); they are simple tones, not produced music. Put real files in `assets/audio/` and set `FILES_AVAILABLE = true` to use them instead.
