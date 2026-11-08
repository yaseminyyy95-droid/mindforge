(function (MF) {
  const ID = 'missing-number';
  const QUESTIONS = 10, FEEDBACK_MS = 2800, OPTION_COUNT = 4; // feedback stays long enough to read the solution; "Next" skips the wait
  const MAX_VALUE = 100000, SEARCH_MAX = 1000, MAX_ATTEMPTS = 80; // answers are 1..SEARCH_MAX; generation retries are bounded
  // Per level: time limit, kind weights and number ranges ([min, max]).
  // add/sub: operands | mulA/mulB: factors | divisor/quotient: division is built as (divisor × quotient) ÷ divisor
  // small/factor: operands of multi-operator templates | twoSet: allowed templates (indices into TEMPLATES).
  const LEVELS = {
    1: { timeMs: 12000, weights: { add: 1, sub: 1 }, add: [1, 30], sub: [2, 40] },
    2: { timeMs: 13000, weights: { add: 2, sub: 2, mul: 3 }, add: [10, 99], sub: [10, 99], mulA: [2, 9], mulB: [2, 12] },
    3: { timeMs: 15000, weights: { add: 2, sub: 2, mul: 3, div: 3 }, add: [20, 200], sub: [20, 200], mulA: [3, 12], mulB: [3, 12], divisor: [2, 12], quotient: [2, 12] },
    4: { timeMs: 18000, weights: { add: 1, sub: 1, mul: 1, div: 1, two: 6 }, add: [20, 200], sub: [20, 200], mulA: [3, 12], mulB: [3, 12],
      divisor: [2, 12], quotient: [2, 12], small: [5, 60], factor: [2, 9], twoSet: [0, 1, 2, 3, 4, 5] },
    5: { timeMs: 22000, weights: { two: 1 }, small: [5, 60], factor: [2, 12], divisor: [2, 12], quotient: [2, 12], twoSet: [0, 2, 6, 7, 8, 9, 10, 11] }
  };
  // Question score: BASE + speed bonus (full within the first 25% of the time limit, 0 at the limit); wrong/timeout cost points.
  const SCORE = { CORRECT_BASE: 60, SPEED_BONUS_MAX: 40, SPEED_WINDOW: 0.75, WRONG_PENALTY: 20, TIMEOUT_PENALTY: 10, DIFFICULTY_STEP: 0.15 };
  // Adaptive difficulty: up when accurate, fast (avg correct time <= FAST_FRACTION of the limit) and few timeouts; down when inaccurate or many timeouts.
  const ADAPT = { UP_ACCURACY: 0.8, DOWN_ACCURACY: 0.5, FAST_FRACTION: 0.5, MAX_TIMEOUTS_UP: 1, TIMEOUTS_DOWN: 3, NEVER: 2 };

  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const range = r => rand(r[0], r[1]);
  const shuffle = list => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };

  // ----- safe arithmetic on an expression tree (no eval / Function) -----
  const OPS = { '+': { prec: 1, fn: (a, b) => a + b }, '−': { prec: 1, fn: (a, b) => a - b },
    '×': { prec: 2, fn: (a, b) => a * b }, '÷': { prec: 2, fn: (a, b) => a / b } };
  const leaf = n => ({ n });
  const node = (op, l, r) => ({ op, l, r });
  const isLeaf = t => t.n !== undefined;
  // Evaluates the tree with the hole (leaf.h) set to x. Returns NaN unless every intermediate result is a non-negative
  // safe integer: divisions must be exact and never by zero. This is the game's integer-only arithmetic.
  function evaluate(t, x) {
    if (isLeaf(t)) return t.h ? x : t.n;
    const a = evaluate(t.l, x);
    if (Number.isNaN(a)) return NaN;
    const b = evaluate(t.r, x);
    if (Number.isNaN(b)) return NaN;
    if (t.op === '÷' && (b === 0 || a % b !== 0)) return NaN;
    const v = OPS[t.op].fn(a, b);
    return Number.isSafeInteger(v) && v >= 0 && v <= MAX_VALUE ? v : NaN;
  }
  function format(t, parentPrec = 0, isRight = false) {
    if (isLeaf(t)) return t.h ? '?' : String(t.n);
    const p = OPS[t.op].prec;
    const s = `${format(t.l, p, false)} ${t.op} ${format(t.r, p, true)}`;
    return p < parentPrec || (isRight && p === parentPrec) ? `(${s})` : s;
  }
  const leavesOf = t => (isLeaf(t) ? [t] : [...leavesOf(t.l), ...leavesOf(t.r)]);
  // Short worked solution: each operation in evaluation order, e.g. "6 × 3 = 18  →  8 + 18 = 26".
  function explain(t, x) {
    const steps = [];
    (function walk(n) {
      if (isLeaf(n)) return n.h ? x : n.n;
      const a = walk(n.l), b = walk(n.r), v = OPS[n.op].fn(a, b);
      steps.push(`${a} ${n.op} ${b} = ${v}`);
      return v;
    })(t);
    return steps.join('  →  ');
  }
  // How many x in 1..SEARCH_MAX complete the equation (integer arithmetic). A question is only used when this is exactly 1.
  function countSolutions(t, target) {
    let count = 0;
    for (let x = 1; x <= SEARCH_MAX; x++) if (evaluate(t, x) === target) count++;
    return count;
  }

  // ----- forward builders: numeric trees (every operand >= 1, so no zero-coefficient / zero-divisor degeneracy) -----
  const BUILD = {
    add: c => node('+', leaf(range(c.add)), leaf(range(c.add))),
    sub: c => { const a = range(c.sub); return node('−', leaf(a), leaf(rand(1, a - 1))); },
    mul: c => node('×', leaf(range(c.mulA)), leaf(range(c.mulB))),
    div: c => { const d = range(c.divisor); return node('÷', leaf(d * range(c.quotient)), leaf(d)); },
    two: c => TEMPLATES[c.twoSet[rand(0, c.twoSet.length - 1)]](c)
  };
  const S = c => leaf(range(c.small)), F = c => leaf(range(c.factor));
  const quotientTree = c => { const d = range(c.divisor); return node('÷', leaf(d * range(c.quotient)), leaf(d)); }; // d × q ÷ d
  const TEMPLATES = [
    c => node('+', S(c), node('×', F(c), F(c))), // 0: a + b × c
    c => { const b = range(c.factor), d = range(c.factor); return node('−', node('×', leaf(b), leaf(d)), leaf(rand(1, b * d - 1))); }, // 1: a × b − c
    c => { const b = range(c.factor), d = range(c.factor); return node('−', leaf(b * d + range(c.small)), node('×', leaf(b), leaf(d))); }, // 2: a − b × c
    c => { const a = range(c.small), b = range(c.small); return node('−', node('+', leaf(a), leaf(b)), leaf(rand(1, a + b - 1))); }, // 3: a + b − c
    c => node('+', quotientTree(c), S(c)), // 4: a ÷ b + c
    c => node('+', node('×', F(c), F(c)), S(c)), // 5: a × b + c
    c => node('×', node('+', S(c), S(c)), F(c)), // 6: (a + b) × c
    c => { const b = range(c.small); return node('×', node('−', leaf(b + rand(1, b)), leaf(b)), F(c)); }, // 7: (a − b) × c
    c => node('+', node('×', F(c), F(c)), node('×', F(c), F(c))), // 8: a × b + c × d
    c => { const a = range(c.small), b = range(c.small), m = range(c.factor); return node('−', node('×', node('+', leaf(a), leaf(b)), leaf(m)), leaf(rand(1, (a + b) * m - 1))); }, // 9: (a + b) × c − d
    c => node('−', node('×', F(c), F(c)), quotientTree(c)), // 10: a × b − c ÷ d  (only when it stays positive; checked by evaluate)
    c => { const b = range(c.small), d = range(c.divisor), q = range(c.quotient); return node('+', node('÷', node('−', leaf(b + d * q), leaf(b)), leaf(d)), S(c)); } // 11: (a − b) ÷ c + d
  ];
  function pickKind(weights) {
    const kinds = Object.keys(weights);
    let r = Math.random() * kinds.reduce((s, k) => s + weights[k], 0);
    for (const k of kinds) { r -= weights[k]; if (r < 0) return k; }
    return kinds[kinds.length - 1];
  }

  function toQuestion(level, tree, target, leaf0, avoidKeys) {
    const answer = leaf0.n;
    if (answer < 1 || answer > SEARCH_MAX || !(target >= 1)) return null;
    leaf0.h = true;
    if (countSolutions(tree, target) !== 1) return null; // the answer must be the only solution
    const text = `${format(tree)} = ${target}`;
    if (avoidKeys && avoidKeys.has(text)) return null;
    return { level, text, answer, target, solution: explain(tree, answer), visible: leavesOf(tree).filter(l => !l.h).map(l => l.n) };
  }

  // generateQuestion(level, { avoidKeys: Set, attempts }) -> { level, text, answer, target, solution, visible }
  function generateQuestion(level, opts = {}) {
    const cfg = LEVELS[level];
    if (!cfg) throw new Error('Unknown level ' + level);
    const attempts = opts.attempts === undefined ? MAX_ATTEMPTS : opts.attempts;
    for (let i = 0; i < attempts; i++) {
      const tree = BUILD[pickKind(cfg.weights)](cfg);
      const target = evaluate(tree, 0);
      if (Number.isNaN(target)) continue;
      const leaves = leavesOf(tree);
      const q = toQuestion(level, tree, target, leaves[rand(0, leaves.length - 1)], opts.avoidKeys);
      if (q) return q;
    }
    return fallbackQuestion(level, opts.avoidKeys);
  }
  // Always-valid backup: "a + ? = t" or "? + b = t" with small numbers (bounded retries to avoid repeats).
  function fallbackQuestion(level, avoidKeys) {
    let q = null;
    for (let i = 0; i < 30 && !q; i++) {
      const tree = node('+', leaf(rand(1, 30)), leaf(rand(1, 30)));
      q = toQuestion(level, tree, tree.l.n + tree.r.n, Math.random() < 0.5 ? tree.l : tree.r, avoidKeys);
    }
    if (q) return q;
    const tree = node('+', leaf(7), leaf(5)); // last resort, constant and valid
    return toQuestion(level, tree, 12, tree.r, null);
  }

  // Four distinct options in 1..SEARCH_MAX, exactly one equal to the answer; wrong ones come from typical slips:
  // adding/subtracting/multiplying/dividing the visible numbers with the result, picking a visible number, or near misses.
  function generateOptions(q) {
    const seen = new Set([q.answer]), picked = [], t = q.target;
    const add = v => { if (picked.length < OPTION_COUNT - 1 && Number.isInteger(v) && v >= 1 && v <= SEARCH_MAX && !seen.has(v)) { seen.add(v); picked.push(v); } };
    const slips = [];
    q.visible.forEach(v => {
      slips.push(t + v, Math.abs(t - v), t * v, v);
      if (t % v === 0) slips.push(t / v);
      if (v % t === 0) slips.push(v / t);
    });
    const closeBy = x => Math.abs(x - q.answer) <= Math.max(10, q.answer);
    shuffle(slips.filter(closeBy)).forEach(add);
    shuffle([1, -1, 2, -2, 3, -3, 10, -10]).forEach(d => add(q.answer + d));
    shuffle(slips).forEach(add);
    for (let k = 4; picked.length < OPTION_COUNT - 1 && k <= MAX_ATTEMPTS; k++) { add(q.answer + k); add(q.answer - k); }
    return shuffle([q.answer, ...picked]);
  }
  const isCorrectAnswer = (q, value) => value === q.answer; // numeric comparison, never text matching

  // ----- stats / score / adaptation (pure) -----
  const correctOnes = results => results.filter(r => r.correct);
  const averageTime = results => { const c = correctOnes(results); return c.length ? c.reduce((s, r) => s + r.answerTime, 0) / c.length : null; };
  const bestTime = results => { const c = correctOnes(results); return c.length ? Math.min(...c.map(r => r.answerTime)) : null; };
  const countTimeouts = results => results.filter(r => r.timedOut).length;
  const calcAccuracy = results => (results.length ? correctOnes(results).length / results.length : 0);
  function questionScore(r, timeMs) {
    if (r.timedOut) return -SCORE.TIMEOUT_PENALTY;
    if (!r.correct) return -SCORE.WRONG_PENALTY;
    const limit = timeMs / 1000;
    const speed = Math.min(1, Math.max(0, (limit - r.answerTime) / (limit * SCORE.SPEED_WINDOW)));
    return SCORE.CORRECT_BASE + speed * SCORE.SPEED_BONUS_MAX;
  }
  function calcScore(results, difficulty) {
    const sum = results.reduce((s, r) => s + questionScore(r, LEVELS[difficulty].timeMs), 0);
    return Math.max(0, Math.round(sum * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP)));
  }
  function difficultyOptions(results, difficulty) {
    const avg = averageTime(results), timeouts = countTimeouts(results);
    const canUp = avg !== null && avg <= (LEVELS[difficulty].timeMs / 1000) * ADAPT.FAST_FRACTION && timeouts <= ADAPT.MAX_TIMEOUTS_UP;
    return { upAt: canUp ? ADAPT.UP_ACCURACY : ADAPT.NEVER, downAt: timeouts >= ADAPT.TIMEOUTS_DOWN ? ADAPT.NEVER : ADAPT.DOWN_ACCURACY };
  }
  const sec = v => (v === null ? '—' : v.toFixed(2) + ' s');
  const pct = v => Math.round(v * 100) + '%';

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, results = [], qNo = 0, startedAt = 0, shownAt = 0;
    let question = null, options = [], texts = new Set(), timeoutId = null, advanceId = null, bar = null;
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
      const lvl = MF.Difficulty.get(ID);
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Missing Number</h2><p class="muted">Find the number that completes the equation.</p>
        <p><b>Level ${lvl}</b> · ${QUESTIONS} questions</p>
        <div class="mm-buttons"><button class="btn ghost" data-mn="exit">Back</button><button class="btn" data-mn="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      results = []; qNo = 0; texts = new Set(); phase = 'feedback'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Missing Number</h2><span class="muted">Math</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Question</span><b data-s="q">0/${QUESTIONS}</b></div>
        <div><span class="muted">Correct</span><b data-s="correct">0</b></div></div>
        <button class="btn ghost" data-mn="exit">Exit Game</button></div>
        <div class="bar"><span data-s="bar"></span></div>
        <div class="mn-equation" data-s="equation" aria-live="polite"></div>
        <div class="mn-options" data-s="options"></div>
        <div class="mn-status" data-s="status"></div>
        <div class="mn-feedback" data-s="feedback" hidden><div class="mn-solution" data-s="solution"></div>
        <button class="btn" data-mn="next" data-s="next">Next ▶</button></div>`;
      bar = $s('bar');
      MF.Audio.play('game-start');
      nextQuestion();
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    function updateHeader() {
      $s('q').textContent = `${qNo}/${QUESTIONS}`;
      $s('correct').textContent = correctOnes(results).length;
    }
    const optEl = value => $s('options').querySelector(`.mn-opt[data-i="${options.indexOf(value)}"]`);

    function nextQuestion() {
      if (results.length >= QUESTIONS) return finish();
      qNo = results.length + 1;
      question = generateQuestion(difficulty, { avoidKeys: texts });
      texts.add(question.text);
      options = generateOptions(question);
      $s('equation').innerHTML = question.text.replace('?', '<span class="mn-hole">?</span>');
      $s('options').innerHTML = options.map((v, i) => `<button class="mn-opt" data-i="${i}">${v}</button>`).join('');
      $s('feedback').hidden = true;
      setStatus('');
      updateHeader();
      phase = 'question';
      bar.style.transition = 'none'; bar.style.width = '100%'; bar.offsetWidth; // restart the countdown bar
      bar.style.transition = `width ${cfg.timeMs}ms linear`; bar.style.width = '0%';
      shownAt = performance.now();
      timeoutId = later(timeUp, cfg.timeMs);
    }

    function resolve(record, status, tone, sound) {
      phase = 'feedback';
      bar.style.transition = 'none';
      $s('options').querySelectorAll('.mn-opt').forEach(b => { b.disabled = true; });
      const hole = $s('equation').querySelector('.mn-hole');
      hole.textContent = question.answer; hole.classList.add('ok');
      results.push({ questionNumber: qNo, text: question.text, answer: question.answer, ...record });
      setStatus(status, tone); updateHeader();
      $s('solution').textContent = question.solution;
      $s('next').textContent = results.length >= QUESTIONS ? 'See results ▶' : 'Next ▶';
      $s('feedback').hidden = false;
      MF.Audio.play(sound);
      advanceId = later(advance, FEEDBACK_MS);
    }
    // Moves on exactly once: either the Next button or the feedback timer, whichever comes first.
    function advance() {
      if (phase !== 'feedback') return;
      cancel(advanceId);
      nextQuestion();
    }

    function onAnswer(i) {
      if (phase !== 'question') return; // a question can only be scored once
      const chosen = options[i], t = Math.round(performance.now() - shownAt) / 1000;
      cancel(timeoutId);
      if (isCorrectAnswer(question, chosen)) {
        optEl(chosen).classList.add('ok');
        resolve({ chosen, correct: true, timedOut: false, answerTime: t }, `Correct! ${t.toFixed(2)} s`, 'ok', 'correct');
      } else {
        optEl(chosen).classList.add('bad');
        optEl(question.answer).classList.add('reveal');
        resolve({ chosen, correct: false, timedOut: false, answerTime: t }, `Wrong. The missing number is ${question.answer}`, 'bad', 'wrong');
      }
    }

    function timeUp() {
      optEl(question.answer).classList.add('reveal');
      resolve({ chosen: null, correct: false, timedOut: true, answerTime: null }, `TIME UP! The missing number is ${question.answer}`, 'bad', 'wrong');
    }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const avg = averageTime(results), best = bestTime(results), correct = correctOnes(results).length, timeouts = countTimeouts(results);
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(results, difficulty), accuracy: calcAccuracy(results), time, difficulty }),
        details: { correctAnswers: correct, wrongAnswers: results.length - correct - timeouts, timeouts, totalQuestions: results.length,
          averageAnswerTime: avg === null ? null : Math.round(avg * 100) / 100, bestCorrectTime: best, questionResults: results.map(r => ({ ...r })) }
      };
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, difficultyOptions(results, difficulty));
      api.onProgress();
      showResult({ result, prevBest, out });
    }

    function showResult({ result, prevBest, out }) {
      const d = result.details;
      const stat = (label, value) => `<div><span class="muted">${label}</span><b>${value}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`), `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>MISSING NUMBER COMPLETE!</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Accuracy', pct(result.accuracy))}
        ${stat('Correct Answers', `${d.correctAnswers} / ${QUESTIONS}`)}${stat('Wrong Answers', d.wrongAnswers)}${stat('Timeouts', d.timeouts)}
        ${stat('Average Answer Time', sec(d.averageAnswerTime))}${stat('Best Correct Answer', sec(d.bestCorrectTime))}
        ${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-mn="exit">Back to Games</button><button class="btn" data-mn="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-mn]');
      if (btn) {
        const act = btn.dataset.mn;
        if (act === 'start') startGame();
        else if (act === 'next') advance();
        else if (act === 'exit') api.exit();
        return;
      }
      const opt = e.target.closest('.mn-opt');
      if (opt) onAnswer(Number(opt.dataset.i));
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      results = []; options = []; question = null; texts = new Set(); bar = cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, SEARCH_MAX, MAX_VALUE, generateQuestion, fallbackQuestion, generateOptions,
    isCorrectAnswer, calcScore, calcAccuracy, averageTime, difficultyOptions } };
})(window.MF);
