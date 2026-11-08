(function (MF) {
  const ID = 'quick-calculate';
  const QUESTIONS = 10, FEEDBACK_MS = 900, OPTION_COUNT = 4;
  const MAX_RESULT = 10000, MAX_ATTEMPTS = 50; // bounded retries: generation can never loop forever
  // Per level: time limit per question, operation mix (weights) and number ranges ([min, max]).
  // add/sub: operand ranges | mulA/mulB: factors | divisor/quotient: division is built as divisor × quotient
  // small/factor: operands of two-step problems (additive / multiplicative) | templates: allowed two-step shapes.
  const LEVELS = {
    1: { timeMs: 12000, weights: { add: 1, sub: 1 }, add: [1, 20], sub: [2, 30] },
    2: { timeMs: 10000, weights: { add: 3, sub: 3, mul: 2 }, add: [10, 60], sub: [10, 80], mulA: [2, 6], mulB: [2, 9] },
    3: { timeMs: 9000, weights: { add: 2, sub: 2, mul: 3, div: 3 }, add: [20, 150], sub: [20, 200], mulA: [3, 12], mulB: [3, 12], divisor: [2, 10], quotient: [2, 12] },
    4: { timeMs: 8000, weights: { add: 2, sub: 2, mul: 2, div: 2, two: 4 }, add: [50, 400], sub: [50, 500], mulA: [4, 15], mulB: [3, 12],
      divisor: [3, 12], quotient: [3, 20], small: [5, 60], factor: [2, 9], templates: [1, 2, 3, 6, 7] },
    5: { timeMs: 7000, weights: { add: 1, sub: 1, mul: 2, div: 2, two: 6 }, add: [100, 900], sub: [100, 999], mulA: [6, 20], mulB: [4, 15],
      divisor: [4, 15], quotient: [4, 25], small: [10, 99], factor: [3, 12], templates: [1, 2, 3, 4, 5, 6, 7, 8] }
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

  // ----- safe arithmetic on an expression tree (no eval) -----
  const OPS = { '+': { prec: 1, fn: (a, b) => a + b }, '−': { prec: 1, fn: (a, b) => a - b },
    '×': { prec: 2, fn: (a, b) => a * b }, '÷': { prec: 2, fn: (a, b) => a / b } };
  const leaf = n => ({ n });
  const node = (op, l, r) => ({ op, l, r });
  const isLeaf = t => t.n !== undefined;
  const evaluate = t => (isLeaf(t) ? t.n : OPS[t.op].fn(evaluate(t.l), evaluate(t.r)));
  // Valid = every intermediate result is a non-negative integer, divisions are exact and never by zero.
  function isValid(t) {
    if (isLeaf(t)) return Number.isInteger(t.n) && t.n >= 0;
    if (!isValid(t.l) || !isValid(t.r)) return false;
    const a = evaluate(t.l), b = evaluate(t.r);
    if (t.op === '÷' && (b === 0 || a % b !== 0)) return false;
    const v = OPS[t.op].fn(a, b);
    return Number.isInteger(v) && v >= 0 && v <= MAX_RESULT;
  }
  // Parentheses are added only where JavaScript/standard precedence requires them.
  function format(t, parentPrec = 0, isRight = false) {
    if (isLeaf(t)) return String(t.n);
    const p = OPS[t.op].prec;
    const s = `${format(t.l, p, false)} ${t.op} ${format(t.r, p, true)}`;
    return p < parentPrec || (isRight && p === parentPrec) ? `(${s})` : s;
  }

  // ----- question builders: return { tree, alts } where alts are plausible wrong answers -----
  const BUILD = {
    add(c) { const a = range(c.add), b = range(c.add); return { tree: node('+', leaf(a), leaf(b)), alts: [a + b + 10, a + b - 10, a + b + 1, a + b - 1, Math.abs(a - b)] }; },
    sub(c) {
      const a = range(c.sub), b = rand(Math.max(1, Math.floor(c.sub[0] / 3)), a - 1);
      return { tree: node('−', leaf(a), leaf(b)), alts: [a - b + 10, a - b - 10, a - b + 1, a - b - 1, a + b] };
    },
    mul(c) { const a = range(c.mulA), b = range(c.mulB); return { tree: node('×', leaf(a), leaf(b)), alts: [a * b + a, a * b - a, a * b + b, a * b - b, a + b] }; },
    div(c) { const d = range(c.divisor), q = range(c.quotient); return { tree: node('÷', leaf(d * q), leaf(d)), alts: [q + 1, q - 1, q + 2, q - 2, d + q] }; },
    two(c) {
      const t = c.templates[rand(0, c.templates.length - 1)], S = () => range(c.small), F = () => range(c.factor);
      let a, b, d, e;
      switch (t) {
        case 1: a = S(); b = F(); d = F(); // a + b × c
          return { tree: node('+', leaf(a), node('×', leaf(b), leaf(d))), alts: [(a + b) * d, a + b + d, a * b + d] };
        case 2: a = S(); b = S(); d = F(); // (a + b) × c
          return { tree: node('×', node('+', leaf(a), leaf(b)), leaf(d)), alts: [a + b * d, (a + b) + d, a * d + b] };
        case 3: b = F(); d = F(); e = rand(1, b * d - 1); // a × b − c
          return { tree: node('−', node('×', leaf(b), leaf(d)), leaf(e)), alts: [b * (d - e), b * d + e, b * d - e + 10, b * d - e - 10] };
        case 4: b = F(); d = F(); a = b * d + S(); // a − b × c
          return { tree: node('−', leaf(a), node('×', leaf(b), leaf(d))), alts: [(a - b) * d, a - b - d, a - b * d + 10, a - b * d - 10] };
        case 5: b = S(); a = b + rand(1, b); d = F(); // (a − b) × c
          return { tree: node('×', node('−', leaf(a), leaf(b)), leaf(d)), alts: [a - b * d, (a - b) + d, (a + b) * d] };
        case 6: a = S(); b = S(); d = rand(1, a + b - 1); // a + b − c
          return { tree: node('−', node('+', leaf(a), leaf(b)), leaf(d)), alts: [a + b + d, a - b - d, a - b + d, a + b - d + 10, a + b - d - 10] };
        case 7: b = F(); d = F(); a = S(); // (b × d) ÷ b + a
          return { tree: node('+', node('÷', leaf(b * d), leaf(b)), leaf(a)), alts: [(b * d + a) / b, d * a, b + a, d + a + 1, d + a - 1] };
        default: b = F(); d = F(); e = F(); // (c × k × b) ÷ c
          return { tree: node('÷', node('×', leaf(d * e), leaf(b)), leaf(d)), alts: [d * e * (b - 1), e + b, e * b + 1, e * b - 1, d * e] };
      }
    }
  };

  function pickType(weights, avoidType) {
    let types = Object.keys(weights);
    if (avoidType && types.length > 1) types = types.filter(t => t !== avoidType);
    let r = Math.random() * types.reduce((s, t) => s + weights[t], 0);
    for (const t of types) { r -= weights[t]; if (r < 0) return t; }
    return types[types.length - 1];
  }

  // generateQuestion(level, { avoidType, avoidTexts }) -> { type, text, answer, alts, level }
  function generateQuestion(level, opts = {}) {
    const cfg = LEVELS[level];
    if (!cfg) throw new Error('Unknown level ' + level);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const type = pickType(cfg.weights, opts.avoidType);
      const { tree, alts } = BUILD[type](cfg);
      if (!isValid(tree)) continue;
      const text = format(tree);
      if (opts.avoidTexts && opts.avoidTexts.has(text) && i < MAX_ATTEMPTS - 1) continue;
      return { type, text, answer: evaluate(tree), alts, level };
    }
    const a = rand(1, 20), b = rand(1, 20); // unreachable in practice; guarantees termination
    return { type: 'add', text: `${a} + ${b}`, answer: a + b, alts: [a + b + 1, a + b - 1, a + b + 10], level };
  }

  // Four distinct non-negative integer options, exactly one equal to the answer. Candidate lists are finite and bounded.
  function generateOptions(q) {
    const seen = new Set([q.answer]), picked = [];
    const add = v => { if (picked.length < OPTION_COUNT - 1 && Number.isInteger(v) && v >= 0 && v <= MAX_RESULT && !seen.has(v)) { seen.add(v); picked.push(v); } };
    shuffle(q.alts).forEach(add);
    shuffle([1, -1, 2, -2, 10, -10, 3, -3]).forEach(d => add(q.answer + d));
    for (let k = 4; picked.length < OPTION_COUNT - 1 && k <= MAX_ATTEMPTS + 4; k++) { add(q.answer + k); add(q.answer - k); }
    return shuffle([q.answer, ...picked]);
  }
  const isCorrectAnswer = (q, value) => value === q.answer;

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
    let question = null, options = [], lastType = null, texts = new Set(), timeoutId = null, bar = null;
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
      root.innerHTML = `<div class="mm-panel card"><h2>Quick Calculate</h2><p class="muted">Solve as many problems as you can.</p>
        <p><b>Level ${lvl}</b> · ${QUESTIONS} questions</p>
        <div class="mm-buttons"><button class="btn ghost" data-qc="exit">Back</button><button class="btn" data-qc="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      results = []; qNo = 0; lastType = null; texts = new Set(); phase = 'feedback'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Quick Calculate</h2><span class="muted">Math</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Question</span><b data-s="q">0/${QUESTIONS}</b></div>
        <div><span class="muted">Correct</span><b data-s="correct">0</b></div></div>
        <button class="btn ghost" data-qc="exit">Exit Game</button></div>
        <div class="bar"><span data-s="bar"></span></div>
        <div class="qc-problem" data-s="problem" aria-live="polite"></div>
        <div class="qc-options" data-s="options"></div>
        <div class="qc-status" data-s="status"></div>`;
      bar = $s('bar');
      MF.Audio.play('game-start');
      nextQuestion();
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    function updateHeader() {
      $s('q').textContent = `${qNo}/${QUESTIONS}`;
      $s('correct').textContent = correctOnes(results).length;
    }

    function nextQuestion() {
      if (results.length >= QUESTIONS) return finish();
      qNo = results.length + 1;
      question = generateQuestion(difficulty, { avoidType: lastType, avoidTexts: texts });
      lastType = question.type; texts.add(question.text);
      options = generateOptions(question);
      $s('problem').textContent = `${question.text} = ?`;
      $s('options').innerHTML = options.map((v, i) => `<button class="qc-opt" data-i="${i}">${v}</button>`).join('');
      setStatus('');
      updateHeader();
      phase = 'question';
      bar.style.transition = 'none'; bar.style.width = '100%'; bar.offsetWidth; // restart the countdown bar
      bar.style.transition = `width ${cfg.timeMs}ms linear`; bar.style.width = '0%';
      shownAt = performance.now();
      timeoutId = later(timeUp, cfg.timeMs);
    }

    const optEl = value => $s('options').querySelector(`.qc-opt[data-i="${options.indexOf(value)}"]`);

    function resolve(record, status, tone, sound) {
      phase = 'feedback';
      bar.style.transition = 'none';
      $s('options').querySelectorAll('.qc-opt').forEach(b => { b.disabled = true; });
      results.push({ questionNumber: qNo, text: question.text, answer: question.answer, ...record });
      setStatus(status, tone); updateHeader();
      MF.Audio.play(sound);
      later(nextQuestion, FEEDBACK_MS);
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
        resolve({ chosen, correct: false, timedOut: false, answerTime: t }, `Wrong. The answer is ${question.answer}`, 'bad', 'wrong');
      }
    }

    function timeUp() {
      optEl(question.answer).classList.add('reveal');
      resolve({ chosen: null, correct: false, timedOut: true, answerTime: null }, `TIME UP! The answer is ${question.answer}`, 'bad', 'wrong');
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
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>QUICK CALCULATE COMPLETE!</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Accuracy', pct(result.accuracy))}
        ${stat('Correct Answers', `${d.correctAnswers} / ${QUESTIONS}`)}${stat('Wrong Answers', d.wrongAnswers)}${stat('Timeouts', d.timeouts)}
        ${stat('Average Answer Time', sec(d.averageAnswerTime))}${stat('Best Correct Answer', sec(d.bestCorrectTime))}
        ${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-qc="exit">Back to Games</button><button class="btn" data-qc="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-qc]');
      if (btn) {
        if (btn.dataset.qc === 'start') startGame();
        else if (btn.dataset.qc === 'exit') api.exit();
        return;
      }
      const opt = e.target.closest('.qc-opt');
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

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, generateQuestion, generateOptions, isCorrectAnswer, calcScore, calcAccuracy, averageTime, difficultyOptions } };
})(window.MF);
