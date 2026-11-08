(function (MF) {
  const ID = 'speed-sequence';
  const BOARDS = 3, FEEDBACK_MS = 1200, READY_MS = 600, BAD_FLASH_MS = 250;
  const LETTERS = 'ABCDEFGHIJ';
  // Per level: grid columns × rows, sequence kind (numbers only, or alternating number-letter), time limit per board.
  const LEVELS = {
    1: { cols: 3, rows: 3, kind: 'numbers', limitMs: 20000 },
    2: { cols: 4, rows: 4, kind: 'numbers', limitMs: 30000 },
    3: { cols: 4, rows: 3, kind: 'alternate', limitMs: 30000 },
    4: { cols: 4, rows: 4, kind: 'alternate', limitMs: 40000 },
    5: { cols: 5, rows: 4, kind: 'alternate', limitMs: 45000 }
  };
  // Board score: TAP per correct tap - WRONG_PENALTY per wrong tap; a finished board adds FINISH_BONUS + speed bonus
  // (full when finished within FAST_FRACTION of the limit, 0 at the limit). Total × difficulty factor, floored at 0.
  const SCORE = { TAP: 10, WRONG_PENALTY: 5, FINISH_BONUS: 50, SPEED_BONUS_MAX: 50, FAST_FRACTION: 0.4, DIFFICULTY_STEP: 0.15 };
  const ADAPT = { UP_ACCURACY: 0.9, DOWN_ACCURACY: 0.6, FAST_FRACTION: 0.6, TIMEOUTS_DOWN: 2, NEVER: 2 };

  const shuffle = list => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };

  // ----- pure helpers -----
  // The order to tap: 1..n, or 1, A, 2, B, ... (n/2 numbers and n/2 letters).
  function sequenceFor(level) {
    const cfg = LEVELS[level];
    if (!cfg) throw new Error('Unknown level ' + level);
    const n = cfg.cols * cfg.rows;
    if (cfg.kind === 'numbers') return Array.from({ length: n }, (_, i) => String(i + 1));
    return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? String(i / 2 + 1) : LETTERS[(i - 1) / 2]));
  }
  const generateBoard = level => shuffle(sequenceFor(level)); // labels in grid order
  // board result: { total, correct, wrong, finished, time }
  const calcAccuracy = boards => {
    const denom = boards.reduce((s, b) => s + b.total + b.wrong, 0);
    return denom ? boards.reduce((s, b) => s + b.correct, 0) / denom : 0;
  };
  function boardScore(b, limitMs) {
    let pts = b.correct * SCORE.TAP - b.wrong * SCORE.WRONG_PENALTY;
    if (b.finished) {
      const limit = limitMs / 1000, fast = limit * SCORE.FAST_FRACTION;
      pts += SCORE.FINISH_BONUS + Math.min(1, Math.max(0, (limit - b.time) / (limit - fast))) * SCORE.SPEED_BONUS_MAX;
    }
    return pts;
  }
  function calcScore(boards, difficulty) {
    const sum = boards.reduce((s, b) => s + boardScore(b, LEVELS[difficulty].limitMs), 0);
    return Math.max(0, Math.round(sum * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP)));
  }
  const finishedOnes = boards => boards.filter(b => b.finished);
  const averageTime = boards => { const f = finishedOnes(boards); return f.length ? f.reduce((s, b) => s + b.time, 0) / f.length : null; };
  function difficultyOptions(boards, difficulty) {
    const avg = averageTime(boards), timeouts = boards.length - finishedOnes(boards).length;
    const canUp = timeouts === 0 && avg !== null && avg <= (LEVELS[difficulty].limitMs / 1000) * ADAPT.FAST_FRACTION;
    return { upAt: canUp ? ADAPT.UP_ACCURACY : ADAPT.NEVER, downAt: timeouts >= ADAPT.TIMEOUTS_DOWN ? ADAPT.NEVER : ADAPT.DOWN_ACCURACY };
  }
  const sec = v => (v === null ? '—' : v.toFixed(1) + ' s');
  const pct = v => Math.round(v * 100) + '%';

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, boards = [], bNo = 0, startedAt = 0, shownAt = 0;
    let order = [], layout = [], next = 0, wrong = 0, limitId = null;
    const timers = new Set();
    const $s = key => root.querySelector(`[data-s="${key}"]`);

    function later(fn, delay) {
      const id = setTimeout(() => { timers.delete(id); if (alive) fn(); }, delay);
      timers.add(id);
      return id;
    }
    function cancel(id) { clearTimeout(id); timers.delete(id); }
    function clearTimers() { timers.forEach(clearTimeout); timers.clear(); limitId = null; }

    function showIntro() {
      const lvl = MF.Difficulty.get(ID), c = LEVELS[lvl], seq = sequenceFor(lvl);
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Speed Sequence</h2><p class="muted">Tap the tiles in order as fast as you can: ${seq.slice(0, 4).join(' → ')} → …</p>
        <p><b>Level ${lvl}</b> · ${BOARDS} boards · ${seq.length} tiles</p>
        <div class="mm-buttons"><button class="btn ghost" data-ss="exit">Back</button><button class="btn" data-ss="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      boards = []; bNo = 0; phase = 'feedback'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Speed Sequence</h2><span class="muted">Speed</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Board</span><b data-s="b">0/${BOARDS}</b></div>
        <div><span class="muted">Next</span><b data-s="next">—</b></div></div>
        <button class="btn ghost" data-ss="exit">Exit Game</button></div>
        <div class="bar"><span data-s="bar"></span></div>
        <div class="ss-status" data-s="status" aria-live="polite">Get ready…</div>
        <div class="ss-grid" data-s="grid" style="--ss-cols:${cfg.cols}"></div>`;
      MF.Audio.play('game-start');
      later(nextBoard, READY_MS);
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    function updateHeader() { $s('b').textContent = `${bNo}/${BOARDS}`; $s('next').textContent = phase === 'play' ? order[next] : '—'; }

    function nextBoard() {
      if (boards.length >= BOARDS) return finish();
      bNo = boards.length + 1;
      order = sequenceFor(difficulty); layout = generateBoard(difficulty); next = 0; wrong = 0;
      $s('grid').innerHTML = layout.map((l, i) => `<button class="ss-cell" data-i="${i}" data-label="${l}">${l}</button>`).join('');
      phase = 'play';
      setStatus(`Tap ${order[0]}`);
      updateHeader();
      const bar = $s('bar');
      bar.style.transition = 'none'; bar.style.width = '100%'; bar.offsetWidth;
      bar.style.transition = `width ${cfg.limitMs}ms linear`; bar.style.width = '0%';
      shownAt = performance.now();
      limitId = later(() => endBoard(false), cfg.limitMs);
    }

    function tap(i) {
      if (phase !== 'play') return;
      const el = $s('grid').querySelector(`.ss-cell[data-i="${i}"]`);
      if (!el || el.disabled) return;
      if (layout[i] !== order[next]) {
        wrong++;
        el.classList.add('bad');
        later(() => el.classList.remove('bad'), BAD_FLASH_MS);
        MF.Audio.play('wrong');
        return;
      }
      el.disabled = true; el.classList.add('done');
      next++;
      MF.Audio.play('click');
      if (next === order.length) { cancel(limitId); endBoard(true); return; }
      setStatus(`Tap ${order[next]}`);
      updateHeader();
    }

    function endBoard(finished) {
      phase = 'feedback';
      $s('bar').style.transition = 'none';
      const t = Math.round(performance.now() - shownAt) / 1000;
      boards.push({ boardNumber: bNo, total: order.length, correct: next, wrong, finished, time: finished ? t : null });
      $s('grid').querySelectorAll('.ss-cell').forEach(c => { c.disabled = true; });
      setStatus(finished ? `Done in ${t.toFixed(1)} s${wrong ? ` · ${wrong} wrong tap${wrong > 1 ? 's' : ''}` : ''}` : `TIME UP! ${next}/${order.length}`, finished ? 'ok' : 'bad');
      updateHeader();
      MF.Audio.play(finished ? 'correct' : 'wrong');
      later(nextBoard, FEEDBACK_MS);
    }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const avg = averageTime(boards);
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(boards, difficulty), accuracy: calcAccuracy(boards), time, difficulty }),
        details: { boardsFinished: finishedOnes(boards).length, totalBoards: boards.length, correctTaps: boards.reduce((s, b) => s + b.correct, 0),
          wrongTaps: boards.reduce((s, b) => s + b.wrong, 0), averageBoardTime: avg === null ? null : Math.round(avg * 10) / 10,
          boardResults: boards.map(b => ({ ...b })) }
      };
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, difficultyOptions(boards, difficulty));
      api.onProgress();
      showResult({ result, prevBest, out });
    }

    function showResult({ result, prevBest, out }) {
      const d = result.details;
      const stat = (l, v) => `<div><span class="muted">${l}</span><b>${v}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`), `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>SPEED SEQUENCE COMPLETE! ⚡</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Accuracy', pct(result.accuracy))}
        ${stat('Boards Finished', `${d.boardsFinished} / ${BOARDS}`)}${stat('Average Board Time', sec(d.averageBoardTime))}${stat('Wrong Taps', d.wrongTaps)}
        ${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-ss="exit">Back to Games</button><button class="btn" data-ss="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-ss]');
      if (btn) {
        if (btn.dataset.ss === 'start') startGame();
        else if (btn.dataset.ss === 'exit') api.exit();
        return;
      }
      const cell = e.target.closest('.ss-cell');
      if (cell) tap(Number(cell.dataset.i));
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      boards = []; order = []; layout = []; cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, BOARDS, sequenceFor, generateBoard, calcAccuracy, calcScore, difficultyOptions } };
})(window.MF);
