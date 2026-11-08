(function (MF) {
  const ID = 'logic-grid';
  const PUZZLES = 3, FEEDBACK_MS = 6000, MAX_ATTEMPTS = 40;
  // Houses stand in a row, numbered 1..n from left to right. Each attribute is a permutation over the houses.
  const ITEMS = {
    color: [{ name: 'Red', icon: '🔴' }, { name: 'Blue', icon: '🔵' }, { name: 'Green', icon: '🟢' }, { name: 'Yellow', icon: '🟡' }],
    pet: [{ name: 'Cat', icon: '🐱' }, { name: 'Dog', icon: '🐶' }, { name: 'Fish', icon: '🐟' }, { name: 'Bird', icon: '🐦' }]
  };
  // Per level: houses, attributes, allowed clue types, time limit per puzzle.
  const LEVELS = {
    1: { n: 3, attrs: ['color'], types: ['at', 'notAt', 'nextRight', 'before', 'end'], timeMs: 60000 },
    2: { n: 4, attrs: ['color'], types: ['at', 'notAt', 'nextRight', 'before', 'adjacent', 'end'], timeMs: 75000 },
    3: { n: 3, attrs: ['color', 'pet'], types: ['at', 'notAt', 'nextRight', 'before', 'end', 'same', 'notSame'], timeMs: 90000 },
    4: { n: 4, attrs: ['color', 'pet'], types: ['notAt', 'nextRight', 'before', 'adjacent', 'end', 'same', 'notSame'], timeMs: 120000 },
    5: { n: 4, attrs: ['color', 'pet'], types: ['notAt', 'before', 'adjacent', 'same', 'notSame'], timeMs: 150000 }
  };
  // Puzzle score: CELL per correct cell; a fully solved puzzle adds SOLVE_BONUS + speed bonus (full in the first 25% of the limit).
  const SCORE = { CELL: 10, SOLVE_BONUS: 50, SPEED_BONUS_MAX: 50, SPEED_WINDOW: 0.75, DIFFICULTY_STEP: 0.15 };
  // Adaptive difficulty: up only if every puzzle was solved in time; down on low accuracy or repeated timeouts.
  const ADAPT = { UP_ACCURACY: 0.9, DOWN_ACCURACY: 0.5, TIMEOUTS_DOWN: 2, NEVER: 2 };

  const shuffle = list => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const range = n => Array.from({ length: n }, (_, i) => i);
  function permutations(n) {
    if (n === 0) return [[]];
    return permutations(n - 1).flatMap(p => range(n).map(i => [...p.slice(0, i), n - 1, ...p.slice(i)]));
  }
  // Every complete assignment: { color: [item at house 0, 1, ...], pet: [...] } (n=4, 2 attributes → 576).
  function allAssignments(n, attrs) {
    const perms = permutations(n);
    return attrs.reduce((acc, a) => acc.flatMap(s => perms.map(p => ({ ...s, [a]: p }))), [{}]);
  }

  // ----- clues: { t, a: [attr, item], b?: [attr, item], p? } -----
  const pos = (s, [attr, item]) => s[attr].indexOf(item);
  const HOLDS = {
    at: (c, s) => pos(s, c.a) === c.p,
    notAt: (c, s) => pos(s, c.a) !== c.p,
    nextRight: (c, s) => pos(s, c.a) + 1 === pos(s, c.b),
    before: (c, s) => pos(s, c.a) < pos(s, c.b),
    adjacent: (c, s) => Math.abs(pos(s, c.a) - pos(s, c.b)) === 1,
    same: (c, s) => pos(s, c.a) === pos(s, c.b),
    notSame: (c, s) => pos(s, c.a) !== pos(s, c.b),
    end: (c, s, n) => pos(s, c.a) === 0 || pos(s, c.a) === n - 1
  };
  const holds = (c, s, n) => HOLDS[c.t](c, s, n);
  const label = ([attr, item]) => `${ITEMS[attr][item].icon} ${ITEMS[attr][item].name}`;
  function clueText(c) {
    const A = label(c.a), B = c.b && label(c.b);
    return {
      at: `${A} is in house ${c.p + 1}.`, notAt: `${A} is not in house ${c.p + 1}.`,
      nextRight: `${A} is directly left of ${B}.`, before: `${A} is somewhere left of ${B}.`,
      adjacent: `${A} and ${B} are next to each other.`, same: `${A} is in the same house as ${B}.`,
      notSame: `${A} is not in the same house as ${B}.`, end: `${A} is at one end of the row.`
    }[c.t];
  }
  // All clues of the allowed types that are true for the solution.
  function trueClues(sol, cfg) {
    const items = cfg.attrs.flatMap(a => range(cfg.n).map(i => [a, i]));
    const out = [];
    const want = t => cfg.types.includes(t);
    items.forEach(a => {
      range(cfg.n).forEach(p => { if (want('at')) out.push({ t: 'at', a, p }); if (want('notAt')) out.push({ t: 'notAt', a, p }); });
      if (want('end')) out.push({ t: 'end', a });
      items.forEach(b => {
        if (a === b) return;
        const cross = a[0] !== b[0];
        ['nextRight', 'before'].forEach(t => want(t) && out.push({ t, a, b }));
        if (want('adjacent') && String(a) < String(b)) out.push({ t: 'adjacent', a, b });
        if (cross && a[0] === 'pet') ['same', 'notSame'].forEach(t => want(t) && out.push({ t, a, b }));
      });
    });
    return out.filter(c => holds(c, sol, cfg.n));
  }
  const solutionsOf = (clues, cands, n) => cands.filter(s => clues.every(c => holds(c, s, n)));

  // generatePuzzle(level) -> { level, n, attrs, solution, clues: [{...clue, text}] } with exactly one solution.
  function generatePuzzle(level) {
    const cfg = LEVELS[level];
    if (!cfg) throw new Error('Unknown level ' + level);
    const cands = allAssignments(cfg.n, cfg.attrs);
    const solution = {};
    cfg.attrs.forEach(a => { solution[a] = shuffle(range(cfg.n)); });
    // Greedy: take clues (random order) that rule out at least one remaining assignment, until one is left.
    let clues = [], left = cands;
    for (const c of shuffle(trueClues(solution, cfg))) {
      if (left.length === 1) break;
      const next = left.filter(s => holds(c, s, cfg.n));
      if (next.length < left.length) { clues.push(c); left = next; }
    }
    // Safety net (not needed in practice: all true "before" clues fix the order): pin items with "at" clues.
    for (const a of cfg.attrs) for (let i = 0; i < cfg.n && left.length > 1; i++) {
      const c = { t: 'at', a: [a, i], p: solution[a].indexOf(i) };
      clues.push(c); left = left.filter(s => holds(c, s, cfg.n));
    }
    // Minimise: drop every clue that is not needed for uniqueness.
    for (const c of shuffle(clues)) {
      const without = clues.filter(x => x !== c);
      if (solutionsOf(without, cands, cfg.n).length === 1) clues = without;
    }
    return { level, n: cfg.n, attrs: [...cfg.attrs], solution, clues: shuffle(clues).map(c => ({ ...c, text: clueText(c) })) };
  }

  // ----- grading / stats / score / adaptation (pure) -----
  // answer: { attr: [item or null per house] } → number of houses×attributes that match the solution.
  function gradeAnswer(puzzle, answer) {
    let correct = 0;
    puzzle.attrs.forEach(a => range(puzzle.n).forEach(p => { if (answer[a][p] === puzzle.solution[a][p]) correct++; }));
    return { correct, total: puzzle.n * puzzle.attrs.length };
  }
  function puzzleScore(r, timeMs) {
    let pts = r.correctCells * SCORE.CELL;
    if (r.solved && !r.timedOut) {
      const limit = timeMs / 1000;
      pts += SCORE.SOLVE_BONUS + Math.min(1, Math.max(0, (limit - r.solveTime) / (limit * SCORE.SPEED_WINDOW))) * SCORE.SPEED_BONUS_MAX;
    }
    return pts;
  }
  function calcScore(results, difficulty) {
    const sum = results.reduce((s, r) => s + puzzleScore(r, LEVELS[difficulty].timeMs), 0);
    return Math.max(0, Math.round(sum * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP)));
  }
  const calcAccuracy = results => {
    const total = results.reduce((s, r) => s + r.totalCells, 0);
    return total ? results.reduce((s, r) => s + r.correctCells, 0) / total : 0;
  };
  const solvedOnes = results => results.filter(r => r.solved && !r.timedOut);
  const countTimeouts = results => results.filter(r => r.timedOut).length;
  const averageSolveTime = results => { const s = solvedOnes(results); return s.length ? s.reduce((a, r) => a + r.solveTime, 0) / s.length : null; };
  function difficultyOptions(results) {
    const canUp = results.length > 0 && solvedOnes(results).length === results.length;
    return { upAt: canUp ? ADAPT.UP_ACCURACY : ADAPT.NEVER, downAt: countTimeouts(results) >= ADAPT.TIMEOUTS_DOWN ? ADAPT.NEVER : ADAPT.DOWN_ACCURACY };
  }
  const sec = v => (v === null ? '—' : v.toFixed(1) + ' s');
  const pct = v => Math.round(v * 100) + '%';

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, results = [], pNo = 0, startedAt = 0, shownAt = 0;
    let puzzle = null, answer = null, timeoutId = null, advanceId = null, bar = null;
    const timers = new Set();
    const $s = key => root.querySelector(`[data-s="${key}"]`);

    function later(fn, delay) {
      const id = setTimeout(() => { timers.delete(id); if (alive) fn(); }, delay);
      timers.add(id);
      return id;
    }
    function cancel(id) { clearTimeout(id); timers.delete(id); }
    function clearTimers() { timers.forEach(clearTimeout); timers.clear(); timeoutId = advanceId = null; }

    function showIntro() {
      const lvl = MF.Difficulty.get(ID), c = LEVELS[lvl];
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Logic Grid</h2><p class="muted">Use the clues to work out what belongs in each house. One check per puzzle.</p>
        <p><b>Level ${lvl}</b> · ${PUZZLES} puzzles · ${c.n} houses · ${c.attrs.length === 2 ? 'colours and pets' : 'colours'}</p>
        <div class="mm-buttons"><button class="btn ghost" data-lg="exit">Back</button><button class="btn" data-lg="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      results = []; pNo = 0; phase = 'feedback'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Logic Grid</h2><span class="muted">Logic</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Puzzle</span><b data-s="p">0/${PUZZLES}</b></div>
        <div><span class="muted">Solved</span><b data-s="solved">0</b></div></div>
        <button class="btn ghost" data-lg="exit">Exit Game</button></div>
        <div class="bar"><span data-s="bar"></span></div>
        <ol class="lg-clues" data-s="clues"></ol>
        <div class="lg-board" data-s="board"></div>
        <div class="lg-status" data-s="status" aria-live="polite"></div>
        <div class="mm-buttons"><button class="btn" data-lg="check" data-s="check">Check</button>
        <button class="btn" data-lg="next" data-s="next" hidden>Next ▶</button></div>`;
      bar = $s('bar');
      MF.Audio.play('game-start');
      nextPuzzle();
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    function updateHeader() {
      $s('p').textContent = `${pNo}/${PUZZLES}`;
      $s('solved').textContent = solvedOnes(results).length;
    }

    function nextPuzzle() {
      if (results.length >= PUZZLES) return finish();
      pNo = results.length + 1;
      puzzle = generatePuzzle(difficulty);
      answer = {};
      puzzle.attrs.forEach(a => { answer[a] = Array(puzzle.n).fill(null); });
      $s('clues').innerHTML = puzzle.clues.map(c => `<li>${c.text}</li>`).join('');
      renderBoard();
      $s('check').hidden = false; $s('check').disabled = false; $s('next').hidden = true;
      setStatus('Tap a cell to place an item in a house.');
      updateHeader();
      phase = 'puzzle';
      bar.style.transition = 'none'; bar.style.width = '100%'; bar.offsetWidth; // restart the countdown bar
      bar.style.transition = `width ${cfg.timeMs}ms linear`; bar.style.width = '0%';
      shownAt = performance.now();
      timeoutId = later(timeUp, cfg.timeMs);
    }

    // One table per attribute: rows = items, columns = houses. A cell is a toggle; each item and each house is used once.
    function renderBoard(reveal = false) {
      const head = `<tr><th></th>${range(puzzle.n).map(p => `<th scope="col">House ${p + 1}</th>`).join('')}</tr>`;
      $s('board').innerHTML = puzzle.attrs.map(a => `<table class="lg-table" style="--lg-n:${puzzle.n}"><thead>${head}</thead><tbody>${
        range(puzzle.n).map(i => `<tr><th scope="row">${label([a, i])}</th>${range(puzzle.n).map(p => {
          const on = answer[a][p] === i, truth = puzzle.solution[a][p] === i;
          const cls = reveal ? (on && truth ? 'ok' : on ? 'bad' : truth ? 'reveal' : '') : '';
          return `<td><button class="lg-cell ${on ? 'on' : ''} ${cls}" data-a="${a}" data-v="${i}" data-p="${p}" aria-pressed="${on}"
            aria-label="${ITEMS[a][i].name} in house ${p + 1}" ${reveal ? 'disabled' : ''}>${on ? '✓' : reveal && truth ? '•' : ''}</button></td>`;
        }).join('')}</tr>`).join('')}</tbody></table>`).join('');
    }

    function toggle(a, item, p) {
      if (phase !== 'puzzle') return;
      const row = answer[a];
      if (row[p] === item) row[p] = null;
      else { const old = row.indexOf(item); if (old >= 0) row[old] = null; row[p] = item; }
      MF.Audio.play('click');
      renderBoard();
    }

    function resolve(timedOut) {
      phase = 'feedback';
      bar.style.transition = 'none';
      const t = Math.round(performance.now() - shownAt) / 1000;
      const { correct, total } = gradeAnswer(puzzle, answer);
      const solved = correct === total;
      results.push({ puzzleNumber: pNo, clues: puzzle.clues.length, correctCells: correct, totalCells: total, solved, timedOut, solveTime: timedOut ? null : t });
      renderBoard(true);
      $s('check').hidden = true;
      $s('next').hidden = false;
      $s('next').textContent = results.length >= PUZZLES ? 'See results ▶' : 'Next ▶';
      if (timedOut) setStatus(`TIME UP! ${correct}/${total} cells right.`, 'bad');
      else setStatus(solved ? `Solved in ${t.toFixed(1)} s!` : `${correct}/${total} cells right. Dots show the solution.`, solved ? 'ok' : 'bad');
      updateHeader();
      MF.Audio.play(solved && !timedOut ? 'correct' : 'wrong');
      advanceId = later(advance, FEEDBACK_MS);
    }
    function check() { if (phase !== 'puzzle') return; cancel(timeoutId); resolve(false); }
    function timeUp() { resolve(true); }
    // Moves on exactly once: the Next button or the feedback timer, whichever comes first.
    function advance() { if (phase !== 'feedback') return; cancel(advanceId); nextPuzzle(); }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const avg = averageSolveTime(results);
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(results, difficulty), accuracy: calcAccuracy(results), time, difficulty }),
        details: { puzzlesSolved: solvedOnes(results).length, totalPuzzles: results.length, timeouts: countTimeouts(results),
          correctCells: results.reduce((s, r) => s + r.correctCells, 0), totalCells: results.reduce((s, r) => s + r.totalCells, 0),
          averageSolveTime: avg === null ? null : Math.round(avg * 10) / 10, puzzleResults: results.map(r => ({ ...r })) }
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
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>LOGIC GRID COMPLETE! 🧩</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Accuracy', pct(result.accuracy))}
        ${stat('Puzzles Solved', `${d.puzzlesSolved} / ${PUZZLES}`)}${stat('Correct Cells', `${d.correctCells} / ${d.totalCells}`)}${stat('Timeouts', d.timeouts)}
        ${stat('Average Solve Time', sec(d.averageSolveTime))}${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-lg="exit">Back to Games</button><button class="btn" data-lg="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-lg]');
      if (btn) {
        const act = btn.dataset.lg;
        if (act === 'start') startGame();
        else if (act === 'check') check();
        else if (act === 'next') advance();
        else if (act === 'exit') api.exit();
        return;
      }
      const cell = e.target.closest('.lg-cell');
      if (cell && !cell.disabled) toggle(cell.dataset.a, Number(cell.dataset.v), Number(cell.dataset.p));
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      results = []; puzzle = answer = bar = cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, ITEMS, permutations, allAssignments, generatePuzzle, trueClues, holds,
    gradeAnswer, calcScore, calcAccuracy, difficultyOptions } };
})(window.MF);
