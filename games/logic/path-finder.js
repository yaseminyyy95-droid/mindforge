(function (MF) {
  const ID = 'path-finder';
  const MAZES = 5, FEEDBACK_MS = 1400, MAX_ATTEMPTS = 200;
  // Per level: grid size, wall density, whether a ⭐ checkpoint must be visited, minimum optimal route length, time limit.
  // 7 columns is the largest grid whose cells stay >= 44px on a 360px phone.
  const LEVELS = {
    1: { rows: 5, cols: 5, walls: 0.2, checkpoint: false, minMoves: 5, timeMs: 25000 },
    2: { rows: 6, cols: 6, walls: 0.25, checkpoint: false, minMoves: 7, timeMs: 25000 },
    3: { rows: 6, cols: 6, walls: 0.25, checkpoint: true, minMoves: 9, timeMs: 35000 },
    4: { rows: 7, cols: 7, walls: 0.28, checkpoint: true, minMoves: 11, timeMs: 40000 },
    5: { rows: 7, cols: 7, walls: 0.32, checkpoint: true, minMoves: 13, timeMs: 45000 }
  };
  // Maze score: EFFICIENCY_POINTS × (optimal / moves); an optimal route adds a speed bonus (full in the first 25% of the limit).
  const SCORE = { EFFICIENCY_POINTS: 60, SPEED_BONUS_MAX: 40, SPEED_WINDOW: 0.75, TIMEOUT_PENALTY: 10, DIFFICULTY_STEP: 0.15 };
  const ADAPT = { UP_ACCURACY: 0.9, DOWN_ACCURACY: 0.5, TIMEOUTS_DOWN: 2, NEVER: 2 };
  const KEYS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], w: [-1, 0], s: [1, 0], a: [0, -1], d: [0, 1] };

  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

  // ----- grid helpers (pure). Cells are indices r*cols+c; maze = { rows, cols, walls: bool[], start, goal, checkpoint|null } -----
  const neighbours = (m, i) => {
    const r = Math.floor(i / m.cols), c = i % m.cols, out = [];
    if (r > 0) out.push(i - m.cols); if (r < m.rows - 1) out.push(i + m.cols);
    if (c > 0) out.push(i - 1); if (c < m.cols - 1) out.push(i + 1);
    return out;
  };
  const isAdjacent = (m, a, b) => neighbours(m, a).includes(b);
  // Breadth-first distances from `from` over open cells (Infinity = unreachable).
  function distances(m, from) {
    const dist = Array(m.rows * m.cols).fill(Infinity), queue = [from];
    dist[from] = 0;
    for (let k = 0; k < queue.length; k++) {
      const i = queue[k];
      neighbours(m, i).forEach(j => { if (!m.walls[j] && dist[j] === Infinity) { dist[j] = dist[i] + 1; queue.push(j); } });
    }
    return dist;
  }
  // Fewest moves for a valid route. Revisiting cells is allowed, so with a checkpoint it is d(S,C) + d(C,G).
  function optimalMoves(m) {
    if (m.checkpoint === null) return distances(m, m.start)[m.goal];
    return distances(m, m.start)[m.checkpoint] + distances(m, m.checkpoint)[m.goal];
  }

  // generateMaze(level) -> maze with a finite optimal route of at least cfg.minMoves (bounded retries + open-grid fallback).
  function generateMaze(level) {
    const cfg = LEVELS[level];
    if (!cfg) throw new Error('Unknown level ' + level);
    const size = cfg.rows * cfg.cols;
    for (let k = 0; k < MAX_ATTEMPTS; k++) {
      const start = rand(0, size - 1), goal = rand(0, size - 1), checkpoint = cfg.checkpoint ? rand(0, size - 1) : null;
      if (goal === start || checkpoint === start || checkpoint === goal) continue;
      const walls = Array.from({ length: size }, (_, i) => i !== start && i !== goal && i !== checkpoint && Math.random() < cfg.walls);
      const m = { rows: cfg.rows, cols: cfg.cols, walls, start, goal, checkpoint, optimal: 0 };
      const opt = optimalMoves(m);
      if (Number.isFinite(opt) && opt >= cfg.minMoves) { m.optimal = opt; return m; }
    }
    return fallbackMaze(cfg);
  }
  // Always valid: a wall down the middle column (except the bottom row) forces a U-shaped route of
  // 2*(rows-1) + (cols-1) moves, which is >= minMoves on every level. The checkpoint sits on that route.
  function fallbackMaze(cfg) {
    const mid = Math.floor(cfg.cols / 2);
    const walls = Array.from({ length: cfg.rows * cfg.cols }, (_, i) => i % cfg.cols === mid && Math.floor(i / cfg.cols) < cfg.rows - 1);
    const m = { rows: cfg.rows, cols: cfg.cols, walls, start: 0, goal: cfg.cols - 1,
      checkpoint: cfg.checkpoint ? (cfg.rows - 1) * cfg.cols + mid : null, optimal: 0 };
    m.optimal = optimalMoves(m);
    return m;
  }

  // ----- stats / score / adaptation (pure). result: { reached, timedOut, moves, optimal, time } -----
  const efficiency = r => (r.reached && r.moves > 0 ? Math.min(1, r.optimal / r.moves) : 0);
  const calcAccuracy = results => (results.length ? results.reduce((s, r) => s + efficiency(r), 0) / results.length : 0);
  function mazeScore(r, timeMs) {
    if (!r.reached) return -SCORE.TIMEOUT_PENALTY;
    const e = efficiency(r), limit = timeMs / 1000;
    const speed = Math.min(1, Math.max(0, (limit - r.time) / (limit * SCORE.SPEED_WINDOW)));
    return SCORE.EFFICIENCY_POINTS * e + (e === 1 ? SCORE.SPEED_BONUS_MAX * speed : 0);
  }
  function calcScore(results, difficulty) {
    const sum = results.reduce((s, r) => s + mazeScore(r, LEVELS[difficulty].timeMs), 0);
    return Math.max(0, Math.round(sum * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP)));
  }
  const countTimeouts = results => results.filter(r => r.timedOut).length;
  function difficultyOptions(results) {
    const t = countTimeouts(results);
    return { upAt: t === 0 ? ADAPT.UP_ACCURACY : ADAPT.NEVER, downAt: t >= ADAPT.TIMEOUTS_DOWN ? ADAPT.NEVER : ADAPT.DOWN_ACCURACY };
  }
  const pct = v => Math.round(v * 100) + '%';

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, results = [], mNo = 0, startedAt = 0, shownAt = 0;
    let maze = null, pos = 0, moves = 0, visitedCheck = false, trail = new Set(), timeoutId = null, bar = null;
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
      const lvl = MF.Difficulty.get(ID), c = LEVELS[lvl];
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Path Finder</h2><p class="muted">Reach the 🏁 in as few moves as possible${c.checkpoint ? ', passing the ⭐ first' : ''}. Every step counts, so plan before you move.</p>
        <p><b>Level ${lvl}</b> · ${MAZES} mazes · ${c.rows} × ${c.cols}</p>
        <div class="mm-buttons"><button class="btn ghost" data-pf="exit">Back</button><button class="btn" data-pf="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      results = []; mNo = 0; phase = 'feedback'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Path Finder</h2><span class="muted">Logic</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Maze</span><b data-s="m">0/${MAZES}</b></div>
        <div><span class="muted">Moves</span><b data-s="moves">0</b></div></div>
        <button class="btn ghost" data-pf="exit">Exit Game</button></div>
        <div class="bar"><span data-s="bar"></span></div>
        <div class="pf-info" data-s="info"></div>
        <div class="pf-grid" data-s="grid" style="--pf-cols:${cfg.cols}"></div>
        <div class="pf-status" data-s="status" aria-live="polite"></div>`;
      bar = $s('bar');
      MF.Audio.play('game-start');
      nextMaze();
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    function updateHeader() { $s('m').textContent = `${mNo}/${MAZES}`; $s('moves').textContent = moves; }

    function nextMaze() {
      if (results.length >= MAZES) return finish();
      mNo = results.length + 1;
      maze = generateMaze(difficulty);
      pos = maze.start; moves = 0; visitedCheck = false; trail = new Set([pos]);
      $s('info').innerHTML = `Shortest route: <b>${maze.optimal}</b> moves${maze.checkpoint !== null ? ' · visit ⭐ before 🏁' : ''}`;
      renderGrid();
      setStatus('Tap a neighbouring cell (or use the arrow keys) to move.');
      updateHeader();
      phase = 'maze';
      bar.style.transition = 'none'; bar.style.width = '100%'; bar.offsetWidth; // restart the countdown bar
      bar.style.transition = `width ${cfg.timeMs}ms linear`; bar.style.width = '0%';
      shownAt = performance.now();
      timeoutId = later(timeUp, cfg.timeMs);
    }

    function cellHtml(i) {
      const kind = maze.walls[i] ? 'wall' : i === maze.goal ? 'goal' : i === maze.checkpoint ? 'check' : i === maze.start ? 'start' : 'open';
      const icon = i === pos ? '●' : kind === 'goal' ? '🏁' : kind === 'check' ? (visitedCheck ? '✅' : '⭐') : '';
      const cls = ['pf-cell', 'pf-' + kind, trail.has(i) ? 'trail' : '', i === pos ? 'here' : ''].join(' ');
      const r = Math.floor(i / maze.cols) + 1, c = (i % maze.cols) + 1;
      return `<button class="${cls}" data-i="${i}" data-kind="${kind}" ${kind === 'wall' ? 'disabled aria-label="Wall"' : `aria-label="Row ${r} column ${c}${icon === '●' ? ', you are here' : kind === 'goal' ? ', goal' : kind === 'check' ? ', checkpoint' : ''}"`}>${icon}</button>`;
    }
    function renderGrid() { $s('grid').innerHTML = maze.walls.map((_, i) => cellHtml(i)).join(''); }

    function moveTo(i) {
      if (phase !== 'maze' || maze.walls[i] === undefined || maze.walls[i]) return;
      if (!isAdjacent(maze, pos, i)) { setStatus('Move one step at a time.', 'bad'); return; }
      pos = i; moves++; trail.add(i);
      if (i === maze.checkpoint && !visitedCheck) { visitedCheck = true; MF.Audio.play('correct'); }
      else MF.Audio.play('click');
      renderGrid(); updateHeader(); setStatus('');
      if (i === maze.goal && (maze.checkpoint === null || visitedCheck)) reachGoal();
      else if (i === maze.goal) setStatus('Visit the ⭐ first!', 'bad');
    }

    function endMaze(record, status, tone, sound) {
      phase = 'feedback';
      bar.style.transition = 'none';
      results.push({ mazeNumber: mNo, rows: maze.rows, cols: maze.cols, optimal: maze.optimal, moves, ...record });
      $s('grid').classList.add('done');
      setStatus(status, tone); updateHeader();
      MF.Audio.play(sound);
      later(() => { $s('grid').classList.remove('done'); nextMaze(); }, FEEDBACK_MS);
    }
    function reachGoal() {
      cancel(timeoutId);
      const t = Math.round(performance.now() - shownAt) / 1000, extra = moves - maze.optimal;
      endMaze({ reached: true, timedOut: false, time: t }, extra === 0 ? `Shortest route! ${t.toFixed(1)} s` : `Goal reached with ${extra} extra move${extra > 1 ? 's' : ''}.`,
        extra === 0 ? 'ok' : '', extra === 0 ? 'correct' : 'xp-gain');
    }
    function timeUp() { endMaze({ reached: false, timedOut: true, time: null }, 'TIME UP!', 'bad', 'wrong'); }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const reached = results.filter(r => r.reached);
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(results, difficulty), accuracy: calcAccuracy(results), time, difficulty }),
        details: { mazesCompleted: reached.length, optimalRoutes: results.filter(r => efficiency(r) === 1).length, timeouts: countTimeouts(results),
          totalMoves: reached.reduce((s, r) => s + r.moves, 0), totalOptimal: reached.reduce((s, r) => s + r.optimal, 0),
          mazeResults: results.map(r => ({ ...r })) }
      };
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, difficultyOptions(results));
      api.onProgress();
      showResult({ result, prevBest, out });
    }

    function showResult({ result, prevBest, out }) {
      const d = result.details;
      const stat = (l, v) => `<div><span class="muted">${l}</span><b>${v}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`), `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>PATH FINDER COMPLETE! 🏁</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Route Efficiency', pct(result.accuracy))}
        ${stat('Shortest Routes', `${d.optimalRoutes} / ${MAZES}`)}${stat('Mazes Completed', `${d.mazesCompleted} / ${MAZES}`)}${stat('Timeouts', d.timeouts)}
        ${stat('Moves / Shortest', `${d.totalMoves} / ${d.totalOptimal}`)}${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-pf="exit">Back to Games</button><button class="btn" data-pf="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-pf]');
      if (btn) {
        if (btn.dataset.pf === 'start') startGame();
        else if (btn.dataset.pf === 'exit') api.exit();
        return;
      }
      const cell = e.target.closest('.pf-cell');
      if (cell) moveTo(Number(cell.dataset.i));
    }
    function onKey(e) {
      const d = KEYS[e.key];
      if (!d || phase !== 'maze') return;
      e.preventDefault();
      const r = Math.floor(pos / maze.cols) + d[0], c = (pos % maze.cols) + d[1];
      if (r >= 0 && r < maze.rows && c >= 0 && c < maze.cols) moveTo(r * maze.cols + c);
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      results = []; trail = new Set(); maze = bar = cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, generateMaze, fallbackMaze, distances, optimalMoves, isAdjacent, efficiency,
    calcScore, calcAccuracy, difficultyOptions } };
})(window.MF);
