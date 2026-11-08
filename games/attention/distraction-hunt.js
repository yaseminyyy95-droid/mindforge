(function (MF) {
  const ID = 'distraction-hunt';
  const ROUNDS = 10, ROUND_TIMEOUT_MS = 10000, FEEDBACK_MS = 800, BUZZ_MS = 700, READY_MS = 600;
  const GLYPH = '➜';
  // Per level: grid size, how far the odd arrow turns away (deg), random wobble of every arrow (± deg, always < delta/2),
  // how many cells blink as distractors, par search time (s) for a good player.
  const LEVELS = {
    1: { size: 4, delta: 180, jitter: 0, buzz: 0, parSeconds: 2 },
    2: { size: 5, delta: 90, jitter: 0, buzz: 2, parSeconds: 3 },
    3: { size: 5, delta: 45, jitter: 5, buzz: 3, parSeconds: 4 },
    4: { size: 6, delta: 35, jitter: 8, buzz: 4, parSeconds: 5 },
    5: { size: 6, delta: 25, jitter: 8, buzz: 6, parSeconds: 6 }
  };
  // Round score = BASE + speed bonus (full at par, 0 at the timeout) - mistakes; timed-out round = -TIMEOUT_PENALTY - mistakes.
  const SCORE = { ROUND_BASE: 50, SPEED_BONUS_MAX: 50, MISTAKE_PENALTY: 15, TIMEOUT_PENALTY: 40, DIFFICULTY_STEP: 0.15 };
  const ADAPT = { UP_ACCURACY: 0.9, DOWN_ACCURACY: 0.6, SLOW_FACTOR: 2, MAX_MISTAKES_UP: 3, MANY_MISTAKES_DOWN: 10, NEVER: 2 };

  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const shuffle = list => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const norm = a => ((a % 360) + 360) % 360;
  const angleDiff = (a, b) => { const d = Math.abs(norm(a) - norm(b)); return Math.min(d, 360 - d); };

  // ----- pure helpers -----
  // -> { cells: [angle], odd: index, base }. Every normal arrow is within ±jitter of base; the odd one is delta away.
  function generateRound(level) {
    const cfg = LEVELS[level];
    if (!cfg) throw new Error('Unknown level ' + level);
    const n = cfg.size * cfg.size, base = rand(0, 359), odd = rand(0, n - 1);
    const sign = Math.random() < 0.5 ? -1 : 1;
    const cells = Array.from({ length: n }, (_, i) =>
      norm(i === odd ? base + sign * cfg.delta : base + (cfg.jitter ? rand(-cfg.jitter, cfg.jitter) : 0)));
    return { cells, odd, base };
  }
  // Distractor cells for one blink step: `count` random cells, never the odd one.
  function pickBuzz(n, odd, count) { return shuffle([...Array(n).keys()].filter(i => i !== odd)).slice(0, count); }

  const successes = rounds => rounds.filter(r => r.searchTime !== null);
  const averageSearch = rounds => { const s = successes(rounds); return s.length ? s.reduce((a, r) => a + r.searchTime, 0) / s.length : null; };
  const countMistakes = rounds => rounds.reduce((a, r) => a + r.mistakes, 0);
  const calcAccuracy = rounds => (rounds.length ? successes(rounds).length / rounds.length : 0);
  function roundScore(r, par) {
    const penalty = r.mistakes * SCORE.MISTAKE_PENALTY;
    if (r.searchTime === null) return -SCORE.TIMEOUT_PENALTY - penalty;
    const slow = ROUND_TIMEOUT_MS / 1000;
    return SCORE.ROUND_BASE + Math.min(1, Math.max(0, (slow - r.searchTime) / (slow - par))) * SCORE.SPEED_BONUS_MAX - penalty;
  }
  function calcScore(rounds, difficulty) {
    const par = LEVELS[difficulty].parSeconds;
    return Math.max(0, Math.round(rounds.reduce((a, r) => a + roundScore(r, par), 0) * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP)));
  }
  function difficultyOptions(rounds, difficulty) {
    const avg = averageSearch(rounds), m = countMistakes(rounds);
    const canUp = avg !== null && avg <= LEVELS[difficulty].parSeconds * ADAPT.SLOW_FACTOR && m <= ADAPT.MAX_MISTAKES_UP;
    return { upAt: canUp ? ADAPT.UP_ACCURACY : ADAPT.NEVER, downAt: m >= ADAPT.MANY_MISTAKES_DOWN ? ADAPT.NEVER : ADAPT.DOWN_ACCURACY };
  }
  const sec = v => (v === null ? '—' : v.toFixed(2) + ' s');
  const pct = v => Math.round(v * 100) + '%';

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, rounds = [], rNo = 0, startedAt = 0, shownAt = 0;
    let round = null, roundMistakes = 0, timeoutId = null, buzzId = null;
    const timers = new Set();
    const $s = key => root.querySelector(`[data-s="${key}"]`);

    function later(fn, delay) {
      const id = setTimeout(() => { timers.delete(id); if (alive) fn(); }, delay);
      timers.add(id);
      return id;
    }
    function cancel(id) { clearTimeout(id); timers.delete(id); }
    function clearTimers() { timers.forEach(clearTimeout); timers.clear(); timeoutId = buzzId = null; }

    function showIntro() {
      const lvl = MF.Difficulty.get(ID), c = LEVELS[lvl];
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Distraction Hunt</h2><p class="muted">All arrows point the same way except one. Find it${c.buzz ? ' while some cells keep blinking' : ''}.</p>
        <p><b>Level ${lvl}</b> · ${ROUNDS} rounds · ${c.size} × ${c.size} grid</p>
        <div class="mm-buttons"><button class="btn ghost" data-dh="exit">Back</button><button class="btn" data-dh="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      rounds = []; rNo = 0; phase = 'feedback'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Distraction Hunt</h2><span class="muted">Attention</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Round</span><b data-s="r">0/${ROUNDS}</b></div>
        <div><span class="muted">Mistakes</span><b data-s="mistakes">0</b></div></div>
        <button class="btn ghost" data-dh="exit">Exit Game</button></div>
        <div class="bar"><span data-s="bar"></span></div>
        <div class="dh-status" data-s="status" aria-live="polite">Get ready…</div>
        <div class="dh-grid" data-s="grid" style="--dh-n:${cfg.size}"></div>`;
      MF.Audio.play('game-start');
      later(nextRound, READY_MS);
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    function updateHeader() { $s('r').textContent = `${rNo}/${ROUNDS}`; $s('mistakes').textContent = countMistakes(rounds) + roundMistakes; }
    const cellEl = i => $s('grid').querySelector(`.dh-cell[data-i="${i}"]`);

    function nextRound() {
      if (rounds.length >= ROUNDS) return finish();
      rNo = rounds.length + 1; roundMistakes = 0;
      round = generateRound(difficulty);
      $s('grid').innerHTML = round.cells.map((a, i) =>
        `<button class="dh-cell" data-i="${i}" data-a="${a}" aria-label="Arrow ${i + 1}"><span style="transform:rotate(${a}deg)">${GLYPH}</span></button>`).join('');
      setStatus('Find the arrow that points differently');
      updateHeader();
      phase = 'search';
      const bar = $s('bar');
      bar.style.transition = 'none'; bar.style.width = '100%'; bar.offsetWidth;
      bar.style.transition = `width ${ROUND_TIMEOUT_MS}ms linear`; bar.style.width = '0%';
      shownAt = performance.now();
      timeoutId = later(timeUp, ROUND_TIMEOUT_MS);
      if (cfg.buzz) buzz();
    }
    // Moves the blinking distractors every BUZZ_MS while the round is running.
    function buzz() {
      if (phase !== 'search') return;
      $s('grid').querySelectorAll('.dh-buzz').forEach(c => c.classList.remove('dh-buzz'));
      pickBuzz(round.cells.length, round.odd, cfg.buzz).forEach(i => cellEl(i).classList.add('dh-buzz'));
      buzzId = later(buzz, BUZZ_MS);
    }

    function onCell(i) {
      if (phase !== 'search') return;
      const el = cellEl(i);
      if (!el || el.disabled) return;
      if (i === round.odd) return found(el);
      roundMistakes++;
      el.disabled = true; el.classList.add('bad');
      MF.Audio.play('wrong');
      updateHeader();
    }
    function endRound(record, status, tone, sound) {
      phase = 'feedback';
      cancel(buzzId);
      $s('bar').style.transition = 'none';
      rounds.push({ roundNumber: rNo, mistakes: roundMistakes, ...record });
      roundMistakes = 0;
      $s('grid').querySelectorAll('.dh-cell').forEach(c => { c.classList.remove('dh-buzz'); c.disabled = true; });
      setStatus(status, tone); updateHeader();
      MF.Audio.play(sound);
      later(nextRound, FEEDBACK_MS);
    }
    function found(el) {
      cancel(timeoutId);
      const t = Math.round(performance.now() - shownAt) / 1000;
      el.classList.add('ok');
      endRound({ searchTime: t }, `Found in ${t.toFixed(2)} s`, 'ok', 'correct');
    }
    function timeUp() { cellEl(round.odd).classList.add('reveal'); endRound({ searchTime: null }, 'TIME UP!', 'bad', 'wrong'); }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const avg = averageSearch(rounds);
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(rounds, difficulty), accuracy: calcAccuracy(rounds), time, difficulty }),
        details: { found: successes(rounds).length, totalRounds: rounds.length, mistakes: countMistakes(rounds),
          averageSearchTime: avg === null ? null : Math.round(avg * 100) / 100, roundResults: rounds.map(r => ({ ...r })) }
      };
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, difficultyOptions(rounds, difficulty));
      api.onProgress();
      showResult({ result, prevBest, out });
    }

    function showResult({ result, prevBest, out }) {
      const d = result.details;
      const stat = (l, v) => `<div><span class="muted">${l}</span><b>${v}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`), `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>DISTRACTION HUNT COMPLETE! 🎯</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Accuracy', pct(result.accuracy))}${stat('Found', `${d.found} / ${ROUNDS}`)}
        ${stat('Mistakes', d.mistakes)}${stat('Average Search Time', sec(d.averageSearchTime))}
        ${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-dh="exit">Back to Games</button><button class="btn" data-dh="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-dh]');
      if (btn) {
        if (btn.dataset.dh === 'start') startGame();
        else if (btn.dataset.dh === 'exit') api.exit();
        return;
      }
      const cell = e.target.closest('.dh-cell');
      if (cell) onCell(Number(cell.dataset.i));
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      rounds = []; round = cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, ROUNDS, generateRound, pickBuzz, angleDiff, calcAccuracy, calcScore, difficultyOptions } };
})(window.MF);
