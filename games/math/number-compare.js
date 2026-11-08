(function (MF) {
  const ID = 'number-compare';
  const QUESTIONS = 10, FEEDBACK_MS = 1100;
  const EQUAL_COUNT = 2;                       // per game: 2 "equal", the rest split evenly between left and right
  const MAX_RUN = 3;                           // never more than 3 identical correct answers in a row
  const MAX_VALUE = 100000, MAX_ATTEMPTS = 60, SPAN_CAP = 300, DIV_MAX = 20; // bounded generation, safe integers only
  // Per level: time limit, target value range of one side, max relative gap between the two sides (small gap = harder),
  // expression kinds with weights, and which two-operator templates are allowed (indices into TWO).
  const LEVELS = {
    1: { timeMs: 8000, value: [5, 40], gap: 0.5, weights: { num: 1, add: 3, sub: 3 } },
    2: { timeMs: 9000, value: [12, 150], gap: 0.3, weights: { num: 1, add: 2, sub: 2, mul: 3 } },
    3: { timeMs: 10000, value: [12, 300], gap: 0.2, weights: { num: 1, add: 2, sub: 2, mul: 3, div: 3 } },
    4: { timeMs: 12000, value: [20, 500], gap: 0.12, weights: { add: 1, sub: 1, mul: 2, div: 2, two: 5 }, twoSet: [0, 1, 2, 5, 6] },
    5: { timeMs: 15000, value: [40, 1500], gap: 0.06, weights: { add: 1, mul: 2, div: 2, two: 4, three: 4 }, twoSet: [0, 1, 2, 3, 4, 5, 6] }
  };
  // Question score: BASE + speed bonus (full in the first 25% of the time limit, 0 at the limit); wrong/timeout cost points.
  const SCORE = { CORRECT_BASE: 60, SPEED_BONUS_MAX: 40, SPEED_WINDOW: 0.75, WRONG_PENALTY: 20, TIMEOUT_PENALTY: 10, DIFFICULTY_STEP: 0.15 };
  // Adaptive difficulty: up when accurate, fast (avg correct time <= FAST_FRACTION of the limit) and few timeouts; down when inaccurate or many timeouts.
  const ADAPT = { UP_ACCURACY: 0.8, DOWN_ACCURACY: 0.5, FAST_FRACTION: 0.5, MAX_TIMEOUTS_UP: 1, TIMEOUTS_DOWN: 3, NEVER: 2 };
  const CHOICES = ['left', 'equal', 'right'];

  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
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
  // Valid = every intermediate result is a non-negative safe integer <= MAX_VALUE; divisions exact, never by zero.
  function isValid(t) {
    if (isLeaf(t)) return Number.isSafeInteger(t.n) && t.n >= 0 && t.n <= MAX_VALUE;
    if (!isValid(t.l) || !isValid(t.r)) return false;
    const a = evaluate(t.l), b = evaluate(t.r);
    if (t.op === '÷' && (b === 0 || a % b !== 0)) return false;
    const v = OPS[t.op].fn(a, b);
    return Number.isSafeInteger(v) && v >= 0 && v <= MAX_VALUE;
  }
  function format(t, parentPrec = 0, isRight = false) {
    if (isLeaf(t)) return String(t.n);
    const p = OPS[t.op].prec;
    const s = `${format(t.l, p, false)} ${t.op} ${format(t.r, p, true)}`;
    return p < parentPrec || (isRight && p === parentPrec) ? `(${s})` : s;
  }
  // Same operators and same numbers in any order (e.g. "7 + 5" vs "5 + 7") would make an "equal" question trivial.
  function structureKey(t) {
    const ops = [], nums = [];
    (function walk(x) { if (isLeaf(x)) nums.push(x.n); else { ops.push(x.op); walk(x.l); walk(x.r); } })(t);
    return ops.sort().join('') + '|' + nums.sort((a, b) => a - b).join(',');
  }

  // ----- constructive builders: build an expression whose value is exactly v (or null if not possible) -----
  const cap = v => Math.min(SPAN_CAP, Math.max(5, Math.round(v * 0.8)));
  function pickDivisor(v) {
    const ds = [];
    for (let d = 2; d <= Math.min(DIV_MAX, Math.floor(v / 2)); d++) if (v % d === 0) ds.push(d);
    return ds.length ? ds[rand(0, ds.length - 1)] : null;
  }
  const split = s => { const a = s < 2 ? 0 : rand(1, s - 1); return [a, s - a]; }; // two non-negative parts of s
  const TWO = [
    v => { const b = rand(2, 12), c = rand(2, 12); return b * c <= v ? node('+', leaf(v - b * c), node('×', leaf(b), leaf(c))) : null; }, // a + b × c
    v => { const c = pickDivisor(v); if (!c) return null; const [a, b] = split(v / c); return node('×', node('+', leaf(a), leaf(b)), leaf(c)); }, // (a + b) × c
    v => { const a = rand(2, 12), b = Math.ceil(v / a) + rand(0, 2); return node('−', node('×', leaf(a), leaf(b)), leaf(a * b - v)); }, // a × b − c
    v => { const b = rand(2, 9), c = rand(2, 9); return node('−', leaf(v + b * c), node('×', leaf(b), leaf(c))); }, // a − b × c
    v => { const c = pickDivisor(v); if (!c) return null; const b = rand(1, cap(v / c)); return node('×', node('−', leaf(v / c + b), leaf(b)), leaf(c)); }, // (a − b) × c
    v => { const c = rand(1, cap(v)), [a, b] = split(v + c); return node('−', node('+', leaf(a), leaf(b)), leaf(c)); }, // a + b − c
    v => { if (v < 1) return null; const b = rand(2, 9), q = rand(1, v); return node('+', node('÷', leaf(b * q), leaf(b)), leaf(v - q)); } // a ÷ b + c
  ];
  const THREE = [
    v => { const a = rand(2, 12), b = rand(2, 12), r = v - a * b, d = r >= 4 ? pickDivisor(r) : null; return d ? node('+', node('×', leaf(a), leaf(b)), node('×', leaf(d), leaf(r / d))) : null; }, // a × b + c × d
    v => { const e = pickDivisor(v); if (!e) return null; const [a, b] = split(e), d = rand(1, cap(v / e)); return node('×', node('+', leaf(a), leaf(b)), node('−', leaf(v / e + d), leaf(d))); }, // (a + b) × (c − d)
    v => { const c = rand(2, 9), s = Math.ceil(v / c) + rand(0, 3), [a, b] = split(s); return node('−', node('×', node('+', leaf(a), leaf(b)), leaf(c)), leaf(s * c - v)); }, // (a + b) × c − d
    v => { const d = rand(2, 9), q = rand(1, 9), f = pickDivisor(v + q); return f ? node('−', node('×', leaf(f), leaf((v + q) / f)), node('÷', leaf(d * q), leaf(d))) : null; } // a × b − c ÷ d
  ];
  const BUILD = {
    num: v => leaf(v),
    add: v => node('+', ...split(v).map(leaf)),
    sub: v => { const b = rand(1, cap(v)); return node('−', leaf(v + b), leaf(b)); },
    mul: v => { const d = pickDivisor(v); return d ? node('×', leaf(d), leaf(v / d)) : null; },
    div: v => { const d = rand(2, 12); return node('÷', leaf(v * d), leaf(d)); }, // (v × d) ÷ d
    two: (v, cfg) => firstValid(shuffle(cfg.twoSet.map(i => TWO[i])), v),
    three: v => firstValid(shuffle(THREE), v)
  };
  function firstValid(builders, v) {
    for (const b of builders) { const t = b(v); if (t && isValid(t) && evaluate(t) === v) return t; }
    return null;
  }
  function weightedOrder(weights) {
    const pool = Object.keys(weights), out = [];
    while (pool.length) {
      let r = Math.random() * pool.reduce((s, k) => s + weights[k], 0), idx = 0;
      for (; idx < pool.length - 1; idx++) { r -= weights[pool[idx]]; if (r < 0) break; }
      out.push(pool.splice(idx, 1)[0]);
    }
    return out;
  }
  // Expression with value exactly v. Falls back to the plain number, so it always terminates.
  function buildExpression(v, cfg) {
    for (const kind of weightedOrder(cfg.weights)) {
      const t = BUILD[kind](v, cfg);
      if (t && isValid(t) && evaluate(t) === v) return t;
    }
    return leaf(v);
  }

  // ----- questions -----
  const compare = (a, b) => (a > b ? 'left' : a < b ? 'right' : 'equal');
  const isCorrectAnswer = (q, choice) => choice === q.answer;
  const pairKey = (l, r) => `${l}|${r}`;
  function makeQuestion(level, left, right) {
    const lv = evaluate(left), rv = evaluate(right);
    return { level, left: { text: format(left), value: lv }, right: { text: format(right), value: rv }, answer: compare(lv, rv) };
  }

  // generateQuestion(level, { outcome: 'left'|'right'|'equal', avoidKeys: Set }) -> { level, left, right, answer }
  function generateQuestion(level, opts = {}) {
    const cfg = LEVELS[level];
    if (!cfg) throw new Error('Unknown level ' + level);
    const outcome = opts.outcome || CHOICES[rand(0, 2)];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const vBig = rand(cfg.value[0], cfg.value[1]);
      const vSmall = outcome === 'equal' ? vBig : vBig - rand(1, Math.max(1, Math.round(vBig * cfg.gap)));
      if (vSmall < 0) continue;
      const big = buildExpression(vBig, cfg), small = buildExpression(vSmall, cfg);
      if (format(big) === format(small) || (outcome === 'equal' && structureKey(big) === structureKey(small))) continue;
      const bigLeft = outcome === 'left' || (outcome === 'equal' && Math.random() < 0.5);
      const q = bigLeft ? makeQuestion(level, big, small) : makeQuestion(level, small, big);
      if (q.answer !== outcome) continue;
      const k = pairKey(q.left.text, q.right.text), mirror = pairKey(q.right.text, q.left.text);
      if (opts.avoidKeys && (opts.avoidKeys.has(k) || opts.avoidKeys.has(mirror)) && i < MAX_ATTEMPTS - 1) continue;
      return q;
    }
    // Unreachable in practice; guarantees termination with a trivially valid question.
    const a = rand(5, 20), b = rand(5, 20), v = a + b;
    const target = outcome === 'equal' ? v : outcome === 'left' ? v - 1 : v + 1;
    return makeQuestion(level, node('+', leaf(a), leaf(b)), leaf(target));
  }

  // Answer plan for one game: balanced left/right, a few "equal", no long runs of the same answer.
  function planOutcomes(count = QUESTIONS) {
    const equals = Math.min(EQUAL_COUNT, count), side = Math.floor((count - equals) / 2);
    const base = [...Array(equals).fill('equal'), ...Array(side).fill('left'), ...Array(count - equals - side).fill('right')];
    let best = shuffle(base);
    for (let i = 0; i < MAX_ATTEMPTS && maxRun(best) > MAX_RUN; i++) best = shuffle(base);
    return best;
  }
  function maxRun(list) { let m = 0, run = 0; list.forEach((x, i) => { run = i && x === list[i - 1] ? run + 1 : 1; m = Math.max(m, run); }); return m; }

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
  const LABEL = { left: 'Left is bigger', right: 'Right is bigger', equal: 'Both are equal' };
  const SIGN = { left: '>', right: '<', equal: '=' };

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, results = [], qNo = 0, startedAt = 0, shownAt = 0;
    let question = null, plan = [], keys = new Set(), timeoutId = null, bar = null;
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
      root.innerHTML = `<div class="mm-panel card"><h2>Number Compare</h2><p class="muted">Which side is bigger? Or are they equal?</p>
        <p><b>Level ${lvl}</b> · ${QUESTIONS} questions</p>
        <div class="mm-buttons"><button class="btn ghost" data-nc="exit">Back</button><button class="btn" data-nc="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      results = []; qNo = 0; keys = new Set(); plan = planOutcomes(QUESTIONS); phase = 'feedback'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Number Compare</h2><span class="muted">Math</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Question</span><b data-s="q">0/${QUESTIONS}</b></div>
        <div><span class="muted">Correct</span><b data-s="correct">0</b></div></div>
        <button class="btn ghost" data-nc="exit">Exit Game</button></div>
        <div class="bar"><span data-s="bar"></span></div>
        <div class="nc-board" data-s="board" aria-live="polite"></div>
        <div class="nc-choices" data-s="choices"></div>
        <div class="nc-status" data-s="status"></div>`;
      bar = $s('bar');
      MF.Audio.play('game-start');
      nextQuestion();
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    function updateHeader() {
      $s('q').textContent = `${qNo}/${QUESTIONS}`;
      $s('correct').textContent = correctOnes(results).length;
    }
    const side = name => $s('board').querySelector(`[data-side="${name}"]`);
    const choiceEl = c => $s('choices').querySelector(`[data-c="${c}"]`);

    function nextQuestion() {
      if (results.length >= QUESTIONS) return finish();
      qNo = results.length + 1;
      question = generateQuestion(difficulty, { outcome: plan[qNo - 1], avoidKeys: keys });
      keys.add(pairKey(question.left.text, question.right.text));
      $s('board').innerHTML = `<div class="nc-side" data-side="left"><span class="muted">Left</span><b class="nc-expr">${question.left.text}</b><span class="nc-val"></span></div>
        <div class="nc-vs" aria-hidden="true">?</div>
        <div class="nc-side" data-side="right"><span class="muted">Right</span><b class="nc-expr">${question.right.text}</b><span class="nc-val"></span></div>`;
      $s('choices').innerHTML = `<button class="nc-choice" data-c="left" aria-label="Left is bigger">◀ Left</button>
        <button class="nc-choice" data-c="equal" aria-label="Both are equal">Equal =</button>
        <button class="nc-choice" data-c="right" aria-label="Right is bigger">Right ▶</button>`;
      setStatus('Which side is bigger?');
      updateHeader();
      phase = 'question';
      bar.style.transition = 'none'; bar.style.width = '100%'; bar.offsetWidth; // restart the countdown bar
      bar.style.transition = `width ${cfg.timeMs}ms linear`; bar.style.width = '0%';
      shownAt = performance.now();
      timeoutId = later(timeUp, cfg.timeMs);
    }

    function reveal() {
      ['left', 'right'].forEach(n => {
        const el = side(n);
        el.querySelector('.nc-val').textContent = `= ${question[n].value}`;
        if (question.answer === 'equal' || question.answer === n) el.classList.add('win');
      });
      choiceEl(question.answer).classList.add('reveal');
    }
    const summary = () => `${question.left.value} ${SIGN[question.answer]} ${question.right.value}: ${LABEL[question.answer]}`;

    function resolve(record, status, tone, sound) {
      phase = 'feedback';
      bar.style.transition = 'none';
      $s('choices').querySelectorAll('.nc-choice').forEach(b => { b.disabled = true; });
      reveal();
      results.push({ questionNumber: qNo, left: question.left.text, right: question.right.text, leftValue: question.left.value,
        rightValue: question.right.value, answer: question.answer, ...record });
      setStatus(status, tone); updateHeader();
      MF.Audio.play(sound);
      later(nextQuestion, FEEDBACK_MS);
    }

    function onChoice(choice) {
      if (phase !== 'question') return; // a question can only be scored once
      const t = Math.round(performance.now() - shownAt) / 1000;
      cancel(timeoutId);
      if (isCorrectAnswer(question, choice)) {
        choiceEl(choice).classList.add('ok');
        resolve({ chosen: choice, correct: true, timedOut: false, answerTime: t }, `Correct! ${summary()}`, 'ok', 'correct');
      } else {
        choiceEl(choice).classList.add('bad');
        resolve({ chosen: choice, correct: false, timedOut: false, answerTime: t }, `Wrong. ${summary()}`, 'bad', 'wrong');
      }
    }

    function timeUp() {
      resolve({ chosen: null, correct: false, timedOut: true, answerTime: null }, `TIME UP! ${summary()}`, 'bad', 'wrong');
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
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>NUMBER COMPARE COMPLETE!</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Accuracy', pct(result.accuracy))}
        ${stat('Correct Answers', `${d.correctAnswers} / ${QUESTIONS}`)}${stat('Wrong Answers', d.wrongAnswers)}${stat('Timeouts', d.timeouts)}
        ${stat('Average Answer Time', sec(d.averageAnswerTime))}${stat('Best Correct Answer', sec(d.bestCorrectTime))}
        ${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-nc="exit">Back to Games</button><button class="btn" data-nc="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-nc]');
      if (btn) {
        if (btn.dataset.nc === 'start') startGame();
        else if (btn.dataset.nc === 'exit') api.exit();
        return;
      }
      const choice = e.target.closest('.nc-choice');
      if (choice) onChoice(choice.dataset.c);
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      results = []; plan = []; question = null; keys = new Set(); bar = cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, MAX_VALUE, generateQuestion, isCorrectAnswer, compare, planOutcomes,
    calcScore, calcAccuracy, averageTime, difficultyOptions } };
})(window.MF);
