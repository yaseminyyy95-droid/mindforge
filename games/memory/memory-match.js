(function (MF) {
  const ID = 'memory-match';
  const SYMBOLS = ['🧠', '⚡', '🎯', '🔢', '⭐', '🧩', '🔥', '🎲', '🔔', '💎', '🚀', '🌙']; // one per pair, max 12
  const LEVELS = { 1: { cols: 3, rows: 2 }, 2: { cols: 4, rows: 3 }, 3: { cols: 4, rows: 4 }, 4: { cols: 5, rows: 4 }, 5: { cols: 6, rows: 4 } };
  const MISMATCH_DELAY_MS = 800;
  const FINISH_DELAY_MS = 700;
  const TICK_MS = 100;
  const TARGET_SECONDS_PER_PAIR = 10;      // passed to Difficulty as targetTime
  const DIFFICULTY_OPTS = { upAt: 0.7, downAt: 0.4 }; // pairs/moves is rarely above 85%, so thresholds are relaxed
  // Score = matches*MATCH - mistakes*PENALTY (+ time bonus + move bonus at the end), times a difficulty multiplier.
  const SCORE = { MATCH: 100, MISTAKE_PENALTY: 15, PAR_SECONDS_PER_PAIR: 6, TIME_BONUS_PER_SEC: 5,
    MOVE_BUDGET_PER_PAIR: 3, MOVE_BONUS: 10, DIFFICULTY_STEP: 0.2 };

  const shuffle = list => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const calcAccuracy = (matches, moves) => (moves ? Math.min(1, Math.max(0, matches / moves)) : 0);
  function calcScore({ pairs, matches, moves, time, difficulty }, final) {
    let pts = matches * SCORE.MATCH - (moves - matches) * SCORE.MISTAKE_PENALTY;
    if (final) {
      pts += Math.max(0, pairs * SCORE.PAR_SECONDS_PER_PAIR - time) * SCORE.TIME_BONUS_PER_SEC;
      pts += Math.max(0, pairs * SCORE.MOVE_BUDGET_PER_PAIR - moves) * SCORE.MOVE_BONUS;
    }
    return Math.max(0, Math.round(pts * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP)));
  }
  const gridLabel = lvl => `${LEVELS[lvl].cols} × ${LEVELS[lvl].rows}`;
  const pct = v => Math.round(v * 100) + '%';

  function create(root, api) {
    let g = null, tickId = null, mismatchId = null, finishId = null;
    const $s = key => root.querySelector(`[data-s="${key}"]`);

    function showIntro() {
      const lvl = MF.Difficulty.get(ID);
      root.innerHTML = `<div class="mm-panel card"><h2>Memory Match</h2><p class="muted">Find all matching pairs.</p>
        <p><b>Level ${lvl}</b> · ${gridLabel(lvl)} grid</p>
        <div class="mm-buttons"><button class="btn ghost" data-mm="exit">Back</button><button class="btn" data-mm="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      const difficulty = MF.Difficulty.get(ID);
      const { cols, rows } = LEVELS[difficulty];
      const pairs = (cols * rows) / 2;
      const cards = shuffle(SYMBOLS.slice(0, pairs).flatMap(s => [s, s])).map((symbol, i) => ({ i, symbol, open: false, matched: false }));
      g = { difficulty, cols, pairs, cards, first: null, lock: false, moves: 0, matches: 0, elapsedMs: 0, last: performance.now(), paused: false, done: false };
      root.innerHTML = `<div class="card mm-head"><div><h2>Memory Match</h2><span class="muted">Memory</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Time</span><b data-s="time">0.0s</b></div><div><span class="muted">Score</span><b data-s="score">0</b></div></div></div>
        <div class="mm-bar"><span>Moves <b data-s="moves">0</b></span><span>Matches <b data-s="matches">0/${pairs}</b></span>
        <span>Accuracy <b data-s="acc">0%</b></span><span class="mm-actions">
        <button class="btn ghost" data-mm="pause">Pause</button><button class="btn ghost" data-mm="exit">Exit Game</button></span></div>
        <div class="mm-board-wrap" style="--cols:${cols}"><div class="mm-board">${cards.map(c =>
          `<button class="mm-card" data-i="${c.i}" aria-label="Hidden card"><span class="mm-face mm-back">?</span><span class="mm-face mm-front">${c.symbol}</span></button>`).join('')}</div>
        <div class="mm-pause" hidden><h3>Paused</h3><button class="btn" data-mm="pause">Resume</button></div></div>`;
      MF.Audio.play('game-start');
      g.last = performance.now();
      tickId = setInterval(tick, TICK_MS);
    }

    function stats() {
      return { pairs: g.pairs, matches: g.matches, moves: g.moves, time: g.elapsedMs / 1000, difficulty: g.difficulty };
    }

    function tick() {
      const now = performance.now();
      if (!g.paused && !g.done) g.elapsedMs += Math.max(0, now - g.last);
      g.last = now;
      updateStats();
    }

    function updateStats() {
      if (!$s('time')) return;
      $s('time').textContent = (g.elapsedMs / 1000).toFixed(1) + 's';
      $s('score').textContent = calcScore(stats(), false);
      $s('moves').textContent = g.moves;
      $s('matches').textContent = `${g.matches}/${g.pairs}`;
      $s('acc').textContent = pct(calcAccuracy(g.matches, g.moves));
    }

    function setOpen(card, open) {
      card.open = open;
      const el = root.querySelector(`.mm-card[data-i="${card.i}"]`);
      el.classList.toggle('open', open);
      el.setAttribute('aria-label', open ? `Card ${card.symbol}` : 'Hidden card');
    }

    function flip(i) {
      const card = g && g.cards[i];
      if (!card || g.done || g.paused || g.lock || card.open || card.matched) return;
      setOpen(card, true);
      MF.Audio.play('card-flip');
      if (!g.first) { g.first = card; return; }
      const prev = g.first;
      g.first = null;
      g.moves++;
      if (prev.symbol === card.symbol) {
        prev.matched = card.matched = true;
        g.matches++;
        [prev, card].forEach(c => root.querySelector(`.mm-card[data-i="${c.i}"]`).classList.add('matched'));
        MF.Audio.play('correct');
        updateStats();
        if (g.matches === g.pairs) finish();
      } else {
        g.lock = true;
        MF.Audio.play('wrong');
        updateStats();
        mismatchId = setTimeout(() => { setOpen(prev, false); setOpen(card, false); g.lock = false; }, MISMATCH_DELAY_MS);
      }
    }

    function togglePause() {
      if (!g || g.done) return;
      tick();
      g.paused = !g.paused;
      root.querySelector('.mm-pause').hidden = !g.paused;
      root.querySelector('[data-mm="pause"]').textContent = g.paused ? 'Resume' : 'Pause';
    }

    function finish() {
      tick();
      g.done = true;
      clearInterval(tickId);
      const time = Math.max(0, Math.round(g.elapsedMs / 100) / 10);
      const result = MF.Scoring.createResult({ gameId: ID, difficulty: g.difficulty, time,
        score: calcScore({ ...stats(), time }, true), accuracy: calcAccuracy(g.matches, g.moves) });
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, { targetTime: g.pairs * TARGET_SECONDS_PER_PAIR, ...DIFFICULTY_OPTS });
      api.onProgress();
      const done = { result, moves: g.moves, prevBest, out };
      finishId = setTimeout(() => showResult(done), FINISH_DELAY_MS);
    }

    function showResult({ result, moves, prevBest, out }) {
      const stat = (label, value) => `<div><span class="muted">${label}</span><b>${value}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`),
        `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>MEMORY MATCH COMPLETE! 🎉</h2>
        <div class="mm-stats">${stat('Score', result.score)}${stat('Accuracy', pct(result.accuracy))}${stat('Time', result.time.toFixed(1) + 's')}
        ${stat('Moves', moves)}${stat('Difficulty', 'Level ' + result.difficulty)}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-mm="exit">Back to Games</button><button class="btn" data-mm="start">Play Again</button></div></div>`;
    }

    function clearTimers() { clearInterval(tickId); clearTimeout(mismatchId); clearTimeout(finishId); }

    function onClick(e) {
      const btn = e.target.closest('[data-mm]');
      if (btn) {
        const act = btn.dataset.mm;
        if (act === 'start') startGame();
        else if (act === 'pause') togglePause();
        else if (act === 'exit') api.exit();
        return;
      }
      const card = e.target.closest('.mm-card');
      if (card && g) flip(Number(card.dataset.i));
    }
    root.addEventListener('click', onClick);

    showIntro();
    // Called by app.js whenever the game view is left: stops all timers, removes the listener, drops state.
    function destroy() {
      clearTimers();
      root.removeEventListener('click', onClick);
      g = null;
    }

    return { destroy };
  }

  MF.GameModules[ID] = { create };
})(window.MF);
