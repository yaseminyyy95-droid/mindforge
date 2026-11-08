# MindForge tests (development only)

Nothing in this folder is loaded by `index.html`; the app itself has no dependencies.

## Real-browser flow tests (`browser/run.js`)

Requires Node 18+ and an installed Chrome (or set `CHROME=<path to chrome/edge binary>`).

```
cd tests
npm install        # installs playwright-core only (no bundled browsers)
npm run browser
```

The app is opened from `file://` exactly as a user would. Scenarios:

- **A** desktop flow: dashboard → category → game → result → XP / History / Profile for all 6 games (wrong answer, timeout, false start, adaptive level, Play Again). Number Compare / Missing Number are unlocked by seeding XP in localStorage.
- **B** leaving a game (Exit Game, top nav, logo) in every phase: live timers must drop to 0 and nothing may be recorded afterwards; re-entry starts clean; double click scores once.
- **C** Settings toggles persist across reload; Reset restores defaults.
- **D** audio on a temporary copy with `FILES_AVAILABLE = true` and a fake `Audio` class (SFX on/off, music on/off, no autoplay before a gesture, reset).
- **E** mobile viewports 360×740 and 390×844 (touch emulation): horizontal overflow check, touch targets < 44 px listed, full-page screenshots.

Results: `browser/out/report.json`, `browser/out/console.txt` and screenshots (git-ignored).
Timers are tracked by wrapping `setTimeout`/`setInterval` in the page before the app loads.
