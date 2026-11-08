(function (MF) {
  const ID = 'grid-memory';
  const ROUNDS = 8, RECALL_MS = 15000, FEEDBACK_MS = 1300, READY_MS = 700, MAX_ATTEMPTS = 30;
  // Per level: grid size, how many cells light up, how long they stay lit (ms).
  const LEVELS = {
    1: { size: 3, targets: 3, showMs: 1200 },
    2: { size: 4, targets: 4, showMs: 1100 },
    3: { size: 4, targets: 5, showMs: 1000 },
    4: { size: 5, targets: 6, showMs: 1000 },
    5: { size: 6, targets: 8, showMs: 900 }
  };
  // Score: HIT per remembered cell, PERFECT_BONUS for a round without mistakes, times the difficulty factor.
  const SCORE = { HIT: 15, PERFECT_BONUS: 30, DIFFICULTY_STEP: 0.15 };
  // Up: accurate and at least MIN_PERFECT perfect rounds; down: low accuracy.
  const ADAPT = { UP_ACCURACY: 0.9, DOWN_ACCURACY: 0.6, MIN_PERFECT: 6, NEVER: 2 };

  const shuffle = list => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };

  // ----- pure helpers -----
  const patternKey = cells => [...cells].sort((a, b) => a - b).join(',');
  // `targets` distinct cells of a size×size grid, different from the previous pattern when possible (bounded retries).
  function generatePattern(level, avoidKey = null) {
    const cfg = LEVELS[level];
    if (!cfg) throw new Error('Unknown level ' + level);
    let cells = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      cells = shuffle([...Array(cfg.size * cfg.size).keys()]).slice(0, cfg.targets).sort((a, b) => a - b);
      if (patternKey(cells) !== avoidKey) break;
    }
    return cells;
  }
  // round: { targets: [cells], picked: [cells] } -> hits / misses / wrong picks
  function gradeRound(targets, picked) {
    const t = new Set(targets), hits = picked.filter(c => t.has(c)).length;
    return { hits, wrong: picked.length - hits, missed: targets.length - hits, perfect: hits === targets.length && picked.length === targets.length };
  }
  const calcAccuracy = rounds => {
    const total = rounds.reduce((s, r) => s + r.targets, 0);
    return total ? rounds.reduce((s, r) => s + r.hits, 0) / total : 0;
  };
  function calcScore(rounds, difficulty) {
    const pts = rounds.reduce((s, r) => s + r.hits * SCORE.HIT + (r.perfect ? SCORE.PERFECT_BONUS : 0), 0);
    return Math.round(pts * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP));
  }
  function difficultyOptions(rounds) {
    const perfect = rounds.filter(r => r.perfect).length;
    return { upAt: perfect >= ADAPT.MIN_PERFECT ? ADAPT.UP_ACCURACY : ADAPT.NEVER, downAt: ADAPT.DOWN_ACCURACY };
  }
  const pct = v => Math.round(v * 100) + '%';

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, rounds = [], rNo = 0, startedAt = 0, shownAt = 0;
    let pattern = [], picked = [], lastKey = null, recallId = null;
    const timers = new Set();
    const $s = key => root.querySelector(`[data-s="${key}"]`);

    function later(fn, delay) {
      const id = setTimeout(() => { timers.delete(id); if (alive) fn(); }, delay);
      timers.add(id);
      return id;
    }
    function cancel(id) { clearTimeout(id); timers.delete(id); }
    function clearTimers() { timers.forEach(clearTimeout); timers.clear(); recallId = null; }

    function showIntro() {
      const lvl = MF.Difficulty.get(ID), c = LEVELS[lvl];
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Grid Memory</h2><p class="muted">Some cells light up for a moment. Tap the same cells once they go dark.</p>
        <p><b>Level ${lvl}</b> · ${ROUNDS} rounds · ${c.size} × ${c.size} grid · ${c.targets} cells</p>
        <div class="mm-buttons"><button class="btn ghost" data-gm="exit">Back</button><button class="btn" data-gm="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      rounds = []; rNo = 0; lastKey = null; phase = 'feedback'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Grid Memory</h2><span class="muted">Memory</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Round</span><b data-s="r">0/${ROUNDS}</b></div>
        <div><span class="muted">Perfect</span><b data-s="perfect">0</b></div></div>
        <button class="btn ghost" data-gm="exit">Exit Game</button></div>
        <div class="gm-status" data-s="status" aria-live="polite">Get ready…</div>
        <div class="gm-grid" data-s="grid" style="--gm-n:${cfg.size}">${Array.from({ length: cfg.size * cfg.size }, (_, i) =>
          `<button class="gm-cell" data-i="${i}" aria-label="Cell ${i + 1}" disabled></button>`).join('')}</div>`;
      MF.Audio.play('game-start');
      later(nextRound, READY_MS);
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    const cells = () => [...$s('grid').querySelectorAll('.gm-cell')];
    function updateHeader() { $s('r').textContent = `${rNo}/${ROUNDS}`; $s('perfect').textContent = rounds.filter(r => r.perfect).length; }

    function nextRound() {
      if (rounds.length >= ROUNDS) return finish();
      rNo = rounds.length + 1;
      pattern = generatePattern(difficulty, lastKey); lastKey = patternKey(pattern); picked = [];
      cells().forEach(c => { c.className = 'gm-cell'; c.disabled = true; });
      pattern.forEach(i => cells()[i].classList.add('lit'));
      phase = 'show';
      setStatus('Remember the lit cells');
      updateHeader();
      MF.Audio.play('card-flip');
      later(beginRecall, cfg.showMs);
    }
    function beginRecall() {
      cells().forEach(c => { c.classList.remove('lit'); c.disabled = false; });
      phase = 'recall';
      setStatus(`Tap ${cfg.targets} cells`);
      shownAt = performance.now();
      recallId = later(() => evaluate(true), RECALL_MS);
    }

    function pick(i) {
      if (phase !== 'recall' || i < 0 || i >= cfg.size * cfg.size) return;
      const el = cells()[i];
      if (picked.includes(i)) { picked = picked.filter(x => x !== i); el.classList.remove('picked'); MF.Audio.play('click'); return; }
      picked.push(i); el.classList.add('picked');
      MF.Audio.play('click');
      setStatus(`${cfg.targets - picked.length} left`);
      if (picked.length === cfg.targets) { cancel(recallId); evaluate(false); }
    }

    function evaluate(timedOut) {
      phase = 'feedback';
      const g = gradeRound(pattern, picked);
      const t = Math.round(performance.now() - shownAt) / 1000;
      rounds.push({ roundNumber: rNo, targets: pattern.length, hits: g.hits, wrong: g.wrong, missed: g.missed, perfect: g.perfect, timedOut, time: timedOut ? null : t });
      const set = new Set(pattern);
      cells().forEach((c, i) => {
        c.disabled = true;
        if (set.has(i)) c.classList.add(picked.includes(i) ? 'ok' : 'reveal');
        else if (picked.includes(i)) c.classList.add('bad');
      });
      setStatus(timedOut ? `TIME UP! ${g.hits}/${pattern.length}` : g.perfect ? 'Perfect!' : `${g.hits}/${pattern.length} right`, g.perfect ? 'ok' : 'bad');
      MF.Audio.play(g.perfect ? 'correct' : 'wrong');
      updateHeader();
      later(nextRound, FEEDBACK_MS);
    }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(rounds, difficulty), accuracy: calcAccuracy(rounds), time, difficulty }),
        details: { perfectRounds: rounds.filter(r => r.perfect).length, totalRounds: rounds.length, cellsRemembered: rounds.reduce((s, r) => s + r.hits, 0),
          totalCells: rounds.reduce((s, r) => s + r.targets, 0), wrongPicks: rounds.reduce((s, r) => s + r.wrong, 0),
          timeouts: rounds.filter(r => r.timedOut).length, roundResults: rounds.map(r => ({ ...r })) }
      };
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, difficultyOptions(rounds));
      api.onProgress();
      showResult({ result, prevBest, out });
    }

    function showResult({ result, prevBest, out }) {
      const d = result.details;
      const stat = (l, v) => `<div><span class="muted">${l}</span><b>${v}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`), `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>GRID MEMORY COMPLETE! 🧠</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Accuracy', pct(result.accuracy))}
        ${stat('Perfect Rounds', `${d.perfectRounds} / ${ROUNDS}`)}${stat('Cells Remembered', `${d.cellsRemembered} / ${d.totalCells}`)}
        ${stat('Wrong Picks', d.wrongPicks)}${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-gm="exit">Back to Games</button><button class="btn" data-gm="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-gm]');
      if (btn) {
        if (btn.dataset.gm === 'start') startGame();
        else if (btn.dataset.gm === 'exit') api.exit();
        return;
      }
      const cell = e.target.closest('.gm-cell');
      if (cell && !cell.disabled) pick(Number(cell.dataset.i));
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      rounds = []; pattern = []; picked = []; cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, ROUNDS, generatePattern, patternKey, gradeRound, calcAccuracy, calcScore, difficultyOptions } };
})(window.MF);
