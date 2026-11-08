(function (MF) {
  const ID = 'target-focus';
  const ROUNDS = 10;
  const PREVIEW_MS = 900, FEEDBACK_MS = 700, ROUND_TIMEOUT_MS = 10000;
  // Symbol families: one target per family, "similar" confusers (differ by fill/shape/orientation), and "other" easy fillers.
  // No distractor ever equals the round's target glyph, so every grid contains exactly one correct cell.
  const SETS = [
    { target: '◆', similar: ['◇', '■', '▼'], other: ['○', '△', '□', '▽', '●'] },
    { target: '▲', similar: ['△', '▼', '◆'], other: ['●', '■', '◇', '○', '□'] },
    { target: '■', similar: ['□', '◆', '▲'], other: ['●', '○', '△', '▽', '◇'] },
    { target: '★', similar: ['☆', '✦', '✶'], other: ['●', '■', '▲', '◆', '○'] }
  ];
  // Per level: grid size, share of distractors that are "similar" to the target, how many similar/other kinds are used
  // per round, and parSeconds = expected search time for a good player (used for scoring and adaptation).
  const LEVELS = {
    1: { cols: 4, rows: 4, similarShare: 0, similarKinds: 0, otherKinds: 2, parSeconds: 1.0 },
    2: { cols: 5, rows: 5, similarShare: 0.3, similarKinds: 1, otherKinds: 3, parSeconds: 1.5 },
    3: { cols: 6, rows: 6, similarShare: 0.5, similarKinds: 2, otherKinds: 3, parSeconds: 2.0 },
    4: { cols: 7, rows: 6, similarShare: 0.65, similarKinds: 2, otherKinds: 4, parSeconds: 2.5 },
    5: { cols: 8, rows: 7, similarShare: 0.8, similarKinds: 3, otherKinds: 4, parSeconds: 3.0 }
  };
  // Round score = BASE + speed bonus (full at parSeconds, 0 at the timeout) - mistakes*PENALTY; a timed-out round
  // scores -TIMEOUT_PENALTY - mistakes*PENALTY. Total is multiplied by a difficulty factor and floored at 0.
  const SCORE = { ROUND_BASE: 50, SPEED_BONUS_MAX: 50, MISTAKE_PENALTY: 15, TIMEOUT_PENALTY: 40, DIFFICULTY_STEP: 0.15 };
  // Adaptive difficulty: up when accurate, fast enough and clean; down when inaccurate or many mistakes.
  const ADAPT = { UP_ACCURACY: 0.8, DOWN_ACCURACY: 0.5, SLOW_FACTOR: 2, MAX_MISTAKES_UP: 5, MANY_MISTAKES_DOWN: 15, NEVER: 2 };

  const shuffle = list => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const pick = list => list[Math.floor(Math.random() * list.length)];

  // ----- pure helpers: grid, stats, score, adaptation -----
  function buildGrid(set, cfg) {
    const total = cfg.cols * cfg.rows - 1; // minus the single target
    const similarPool = shuffle(set.similar).slice(0, cfg.similarKinds);
    const otherPool = shuffle(set.other).slice(0, cfg.otherKinds);
    const nSimilar = similarPool.length ? Math.round(total * cfg.similarShare) : 0;
    const cells = [{ glyph: set.target, isTarget: true }];
    for (let i = 0; i < total; i++) cells.push({ glyph: i < nSimilar ? pick(similarPool) : pick(otherPool), isTarget: false });
    return shuffle(cells);
  }
  const successes = rounds => rounds.filter(r => r.searchTime !== null);
  const averageSearch = rounds => { const s = successes(rounds); return s.length ? s.reduce((a, r) => a + r.searchTime, 0) / s.length : null; };
  const bestSearch = rounds => { const s = successes(rounds); return s.length ? Math.min(...s.map(r => r.searchTime)) : null; };
  const countMistakes = rounds => rounds.reduce((a, r) => a + r.mistakes, 0);
  const calcAccuracy = rounds => (rounds.length ? successes(rounds).length / rounds.length : 0);
  function roundScore(r, par) {
    const penalty = r.mistakes * SCORE.MISTAKE_PENALTY;
    if (r.searchTime === null) return -SCORE.TIMEOUT_PENALTY - penalty;
    const slow = ROUND_TIMEOUT_MS / 1000;
    const speed = Math.min(1, Math.max(0, (slow - r.searchTime) / (slow - par)));
    return SCORE.ROUND_BASE + speed * SCORE.SPEED_BONUS_MAX - penalty;
  }
  function calcScore(rounds, difficulty) {
    const par = LEVELS[difficulty].parSeconds;
    const sum = rounds.reduce((a, r) => a + roundScore(r, par), 0);
    return Math.max(0, Math.round(sum * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP)));
  }
  // Options for MF.Difficulty.next(), expressed through its upAt/downAt thresholds.
  function difficultyOptions(rounds, difficulty) {
    const avg = averageSearch(rounds), mistakes = countMistakes(rounds);
    const canUp = avg !== null && avg <= LEVELS[difficulty].parSeconds * ADAPT.SLOW_FACTOR && mistakes <= ADAPT.MAX_MISTAKES_UP;
    return { upAt: canUp ? ADAPT.UP_ACCURACY : ADAPT.NEVER, downAt: mistakes >= ADAPT.MANY_MISTAKES_DOWN ? ADAPT.NEVER : ADAPT.DOWN_ACCURACY };
  }
  const sec = v => (v === null ? '—' : v.toFixed(2) + ' s');
  const pct = v => Math.round(v * 100) + '%';

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, rounds = [], roundNo = 0, startedAt = 0, shownAt = 0;
    let cells = [], roundMistakes = 0, lastSet = -1, timeoutId = null, bar = null, stage = null;
    const timers = new Set();
    const $s = key => root.querySelector(`[data-s="${key}"]`);

    function later(fn, delay) {
      const id = setTimeout(() => { timers.delete(id); if (alive) fn(); }, delay);
      timers.add(id);
      return id;
    }
    function cancel(id) { clearTimeout(id); timers.delete(id); }
    function clearTimers() { timers.forEach(clearTimeout); timers.clear(); timeoutId = null; }

    function showIntro() {
      const lvl = MF.Difficulty.get(ID);
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Target Focus</h2><p class="muted">Find the target among the distractions.</p>
        <p><b>Level ${lvl}</b> · ${ROUNDS} rounds</p>
        <div class="mm-buttons"><button class="btn ghost" data-tf="exit">Back</button><button class="btn" data-tf="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      rounds = []; roundNo = 0; lastSet = -1; phase = 'preview'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Target Focus</h2><span class="muted">Attention</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Round</span><b data-s="round">0/${ROUNDS}</b></div>
        <div><span class="muted">Mistakes</span><b data-s="mistakes">0</b></div></div>
        <button class="btn ghost" data-tf="exit">Exit Game</button></div>
        <div class="tf-top"><div class="tf-target"><span class="muted">Target</span><b class="tf-glyph" data-s="target">·</b></div>
        <div class="tf-status" data-s="status"></div><div class="tf-time"><span data-s="bar"></span></div></div>
        <div class="tf-stage" data-s="stage"></div>`;
      bar = $s('bar'); stage = $s('stage');
      MF.Audio.play('game-start');
      nextRound();
    }

    function updateHeader() {
      $s('round').textContent = `${roundNo}/${ROUNDS}`;
      $s('mistakes').textContent = countMistakes(rounds) + roundMistakes;
    }
    const setStatus = (t, cls = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = cls; };
    function resetBar() { bar.style.transition = 'none'; bar.style.width = '100%'; }

    function nextRound() {
      if (rounds.length >= ROUNDS) return finish();
      roundNo = rounds.length + 1;
      roundMistakes = 0;
      phase = 'preview';
      let idx; do { idx = Math.floor(Math.random() * SETS.length); } while (idx === lastSet);
      lastSet = idx;
      const set = SETS[idx];
      cells = buildGrid(set, cfg);
      $s('target').textContent = set.target;
      setStatus('Memorise the target'); resetBar(); updateHeader();
      stage.innerHTML = `<div class="tf-preview"><span class="muted">Find</span><b>${set.target}</b></div>`;
      later(beginSearch, PREVIEW_MS);
    }

    function beginSearch() {
      phase = 'search';
      stage.innerHTML = `<div class="tf-grid" style="--cols:${cfg.cols}">${cells.map((c, i) =>
        `<button class="tf-cell" data-i="${i}" aria-label="Symbol ${c.glyph}">${c.glyph}</button>`).join('')}</div>`;
      setStatus('Find the target');
      shownAt = performance.now(); // search time starts when the grid appears
      resetBar(); bar.offsetWidth; // force reflow so the transition restarts
      bar.style.transition = `width ${ROUND_TIMEOUT_MS}ms linear`; bar.style.width = '0%';
      timeoutId = later(timeUp, ROUND_TIMEOUT_MS);
    }

    const cellEl = i => stage.querySelector(`.tf-cell[data-i="${i}"]`);
    const lockGrid = () => stage.querySelector('.tf-grid')?.classList.add('locked');

    function onCell(i) {
      if (phase !== 'search') return;
      const cell = cells[i], el = cellEl(i);
      if (!el || el.disabled) return;
      if (cell.isTarget) return found(el);
      roundMistakes++;
      el.disabled = true; el.classList.add('bad');
      MF.Audio.play('wrong');
      updateHeader();
    }

    function endRound(record, status, tone, sound) {
      rounds.push({ roundNumber: rounds.length + 1, mistakes: roundMistakes, ...record });
      roundMistakes = 0;
      phase = 'feedback';
      lockGrid();
      bar.style.transition = 'none';
      setStatus(status, tone); updateHeader();
      MF.Audio.play(sound);
      later(nextRound, FEEDBACK_MS);
    }

    function found(el) {
      const t = Math.round(performance.now() - shownAt) / 1000;
      cancel(timeoutId);
      el.classList.add('ok');
      endRound({ searchTime: t, timedOut: false }, `Found in ${t.toFixed(2)} s`, 'ok', 'correct');
    }

    function timeUp() {
      const i = cells.findIndex(c => c.isTarget);
      cellEl(i)?.classList.add('reveal');
      endRound({ searchTime: null, timedOut: true }, 'TIME UP!', 'bad', 'wrong');
    }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const avg = averageSearch(rounds), best = bestSearch(rounds);
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(rounds, difficulty), accuracy: calcAccuracy(rounds), time, difficulty }),
        details: {
          averageSearchTime: avg === null ? null : Math.round(avg * 100) / 100, bestSearchTime: best,
          mistakes: countMistakes(rounds), successfulRounds: successes(rounds).length, totalRounds: rounds.length,
          roundResults: rounds.map(r => ({ ...r }))
        }
      };
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, difficultyOptions(rounds, difficulty));
      api.onProgress();
      showResult({ result, prevBest, out });
    }

    function showResult({ result, prevBest, out }) {
      const d = result.details;
      const stat = (label, value) => `<div><span class="muted">${label}</span><b>${value}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`), `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>TARGET FOCUS COMPLETE! 🎯</h2>
        <div class="mm-stats">${stat('Score', result.score)}${stat('Accuracy', pct(result.accuracy))}${stat('Average Search Time', sec(d.averageSearchTime))}
        ${stat('Mistakes', d.mistakes)}${stat('Successful Rounds', `${d.successfulRounds} / ${d.totalRounds}`)}
        ${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-tf="exit">Back to Games</button><button class="btn" data-tf="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-tf]');
      if (btn) {
        if (btn.dataset.tf === 'start') startGame();
        else if (btn.dataset.tf === 'exit') api.exit();
        return;
      }
      const cell = e.target.closest('.tf-cell');
      if (cell) onCell(Number(cell.dataset.i));
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      rounds = []; cells = []; bar = stage = cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create };
})(window.MF);
