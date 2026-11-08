(function (MF) {
  const ID = 'pattern-shift';
  const QUESTIONS = 10, FEEDBACK_MS = 900, OPTION_COUNT = 4, MAX_ATTEMPTS = 60;
  // A tile has four attributes. Rotation is only visible on the triangle, so a rotation rule fixes the shape to '▲'
  // and the shape and rotation rules are never active together.
  const SHAPES = ['●', '■', '▲', '◆', '★'];
  const COLORS = [{ name: 'blue', css: '#5b8cff' }, { name: 'green', css: '#3ecf8e' }, { name: 'amber', css: '#f2b84b' }, { name: 'red', css: '#e05656' }];
  const DIRS = ['up', 'right', 'down', 'left'];
  const COUNT_MIN = 1, COUNT_MAX = 9; // up to 3×3 glyphs per tile
  // Per level: tiles shown, rules changing at once, rule pool, cycle lengths for shape/color, count steps, time limit.
  const LEVELS = {
    1: { shown: 4, rules: 1, pool: ['shape', 'count'], periods: [2, 3], countSteps: [1], rotSteps: [1], timeMs: 15000 },
    2: { shown: 4, rules: 1, pool: ['shape', 'color', 'count', 'rot'], periods: [2, 3], countSteps: [1, -1, 2, -2], rotSteps: [1, 2, 3], timeMs: 14000 },
    3: { shown: 5, rules: 2, pool: ['shape', 'color', 'count', 'rot'], periods: [2, 3], countSteps: [1, -1], rotSteps: [1, 2, 3], timeMs: 14000 },
    4: { shown: 5, rules: 2, pool: ['shape', 'color', 'count', 'rot'], periods: [3], countSteps: [1, -1], rotSteps: [1, 3], timeMs: 13000 },
    5: { shown: 5, rules: 3, pool: ['shape', 'color', 'count', 'rot'], periods: [3], countSteps: [1, -1], rotSteps: [1, 3], timeMs: 12000 }
  };
  // Same scoring/adaptation as the math games: BASE + speed bonus (full in the first 25% of the limit); wrong/timeout cost points.
  const SCORE = { CORRECT_BASE: 60, SPEED_BONUS_MAX: 40, SPEED_WINDOW: 0.75, WRONG_PENALTY: 20, TIMEOUT_PENALTY: 10, DIFFICULTY_STEP: 0.15 };
  const ADAPT = { UP_ACCURACY: 0.8, DOWN_ACCURACY: 0.5, FAST_FRACTION: 0.5, MAX_TIMEOUTS_UP: 1, TIMEOUTS_DOWN: 3, NEVER: 2 };
  const ATTRS = ['shape', 'color', 'count', 'rot'];

  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const shuffle = list => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const tileKey = t => `${t.shape}|${t.color}|${t.count}|${t.rot}`;
  const sameTile = (a, b) => tileKey(a) === tileKey(b);

  // ----- rule generation (pure) -----
  // Chooses `n` attributes from the pool, never shape and rot together. Bounded: falls back to the first legal set.
  function chooseRules(cfg) {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const set = shuffle(cfg.pool).slice(0, cfg.rules);
      if (!(set.includes('shape') && set.includes('rot'))) return set;
    }
    return cfg.pool.filter(a => a !== 'rot').slice(0, cfg.rules);
  }
  // One value sequence of length len per attribute. Cycles use distinct values, so their period is exactly p.
  function attributeSequence(attr, active, cfg, len, fixedShape) {
    if (attr === 'shape') {
      if (!active) { const s = fixedShape || pick(SHAPES); return Array(len).fill(s); }
      const cyc = shuffle(SHAPES).slice(0, pick(cfg.periods));
      return Array.from({ length: len }, (_, i) => cyc[i % cyc.length]);
    }
    if (attr === 'color') {
      if (!active) { const c = rand(0, COLORS.length - 1); return Array(len).fill(c); }
      const cyc = shuffle(COLORS.map((_, i) => i)).slice(0, pick(cfg.periods));
      return Array.from({ length: len }, (_, i) => cyc[i % cyc.length]);
    }
    if (attr === 'count') {
      if (!active) { const c = rand(COUNT_MIN, 3); return Array(len).fill(c); }
      const d = pick(cfg.countSteps), span = Math.abs(d) * (len - 1);
      const start = d > 0 ? rand(COUNT_MIN, COUNT_MAX - span) : rand(COUNT_MIN + span, COUNT_MAX);
      return Array.from({ length: len }, (_, i) => start + i * d);
    }
    // rot
    if (!active) return Array(len).fill(0);
    const q = pick(cfg.rotSteps), start = rand(0, 3);
    return Array.from({ length: len }, (_, i) => (start + i * q) % 4);
  }
  // Count steps must keep all shown+1 values inside COUNT_MIN..COUNT_MAX (safety net; LEVELS only list feasible steps).
  function feasibleCountSteps(cfg, len) {
    const ok = cfg.countSteps.filter(d => Math.abs(d) * (len - 1) <= COUNT_MAX - COUNT_MIN);
    return ok.length ? ok : [1];
  }

  // Plausible wrong values for one attribute: "no change", "previous value", "step applied twice", any other legal value.
  function wrongValues(attr, seq, answerValue) {
    const last = seq[seq.length - 2], prev = seq[seq.length - 3];
    let vals;
    if (attr === 'count') { const d = answerValue - last; vals = [last, answerValue + d, answerValue + 1, answerValue - 1, prev]; }
    else if (attr === 'rot') { const d = (answerValue - last + 4) % 4; vals = [last, (answerValue + d) % 4, (answerValue + 2) % 4, prev]; }
    else vals = [last, prev, ...(attr === 'shape' ? SHAPES : COLORS.map((_, i) => i))];
    return vals.filter(v => v !== undefined && v !== answerValue && (attr !== 'count' || (v >= COUNT_MIN && v <= COUNT_MAX)));
  }

  // generateQuestion(level, { avoidKeys }) -> { level, rules, tiles (shown), answer, key }
  function generateQuestion(level, opts = {}) {
    const base = LEVELS[level];
    if (!base) throw new Error('Unknown level ' + level);
    const len = base.shown + 1;
    const cfg = { ...base, countSteps: feasibleCountSteps(base, len) };
    let q = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const rules = chooseRules(cfg);
      const fixedShape = rules.includes('rot') ? '▲' : null;
      const seqs = {};
      ATTRS.forEach(a => { seqs[a] = attributeSequence(a, rules.includes(a), cfg, len, fixedShape); });
      const all = Array.from({ length: len }, (_, k) => ({ shape: seqs.shape[k], color: seqs.color[k], count: seqs.count[k], rot: seqs.rot[k] }));
      const key = all.slice(0, base.shown).map(tileKey).join(' ');
      q = { level, rules, seqs, tiles: all.slice(0, base.shown), answer: all[base.shown], key };
      if (!(opts.avoidKeys && opts.avoidKeys.has(key))) break;
    }
    return q; // the loop always assigns q at least once
  }

  // Four distinct tiles, exactly one equal to the answer. Each wrong option changes one or two attributes.
  function generateOptions(q) {
    const seen = new Set([tileKey(q.answer)]), picked = [];
    const add = t => { if (picked.length < OPTION_COUNT - 1 && !seen.has(tileKey(t))) { seen.add(tileKey(t)); picked.push(t); } };
    // rotation is only visible on '▲', so a shape change away from it resets rot (no two options can look the same)
    const variants = attrs => attrs.flatMap(a => wrongValues(a, q.seqs[a], q.answer[a]).map(v => ({ ...q.answer, [a]: v, ...(a === 'shape' && v !== '▲' ? { rot: 0 } : {}) })));
    shuffle(variants(q.rules)).forEach(add);                                // wrong application of an active rule first
    shuffle(variants(ATTRS.filter(a => !q.rules.includes(a) && !(a === 'rot' && q.answer.shape !== '▲')))).forEach(add);
    for (let c = 0; picked.length < OPTION_COUNT - 1 && c < COLORS.length; c++)  // finite fallback: always enough colors×counts
      for (let n = COUNT_MIN; n <= COUNT_MAX; n++) add({ ...q.answer, color: c, count: n });
    return shuffle([q.answer, ...picked]);
  }
  const isCorrectAnswer = (q, tile) => sameTile(q.answer, tile);

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

  // ----- rendering -----
  const SHAPE_NAMES = { '●': 'circle', '■': 'square', '▲': 'triangle', '◆': 'diamond', '★': 'star' };
  const describe = t => `${t.count} ${COLORS[t.color].name} ${SHAPE_NAMES[t.shape]}${t.count > 1 ? 's' : ''}${t.shape === '▲' ? ' pointing ' + DIRS[t.rot] : ''}`;
  const tileHtml = t => `<span class="ps-tile ps-n${t.count}" style="--ps-c:${COLORS[t.color].css}" role="img" aria-label="${describe(t)}">${
    Array.from({ length: t.count }, () => `<span class="ps-g" style="transform:rotate(${t.rot * 90}deg)">${t.shape}</span>`).join('')}</span>`;

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, results = [], qNo = 0, startedAt = 0, shownAt = 0;
    let question = null, options = [], keys = new Set(), timeoutId = null, bar = null;
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
      root.innerHTML = `<div class="mm-panel card"><h2>Pattern Shift</h2><p class="muted">Work out how the tiles change and pick the next one.</p>
        <p><b>Level ${lvl}</b> · ${QUESTIONS} questions · ${LEVELS[lvl].rules} rule${LEVELS[lvl].rules > 1 ? 's' : ''} at once</p>
        <div class="mm-buttons"><button class="btn ghost" data-ps="exit">Back</button><button class="btn" data-ps="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      results = []; qNo = 0; keys = new Set(); phase = 'feedback'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Pattern Shift</h2><span class="muted">Logic</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Question</span><b data-s="q">0/${QUESTIONS}</b></div>
        <div><span class="muted">Correct</span><b data-s="correct">0</b></div></div>
        <button class="btn ghost" data-ps="exit">Exit Game</button></div>
        <div class="bar"><span data-s="bar"></span></div>
        <div class="ps-seq" data-s="seq" aria-live="polite"></div>
        <div class="ps-options" data-s="options"></div>
        <div class="ps-status" data-s="status"></div>`;
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
      question = generateQuestion(difficulty, { avoidKeys: keys });
      keys.add(question.key);
      options = generateOptions(question);
      $s('seq').innerHTML = question.tiles.map(tileHtml).join('') + '<span class="ps-tile ps-next" data-s="next" aria-label="Next tile">?</span>';
      $s('options').innerHTML = options.map((t, i) => `<button class="ps-opt" data-i="${i}">${tileHtml(t)}</button>`).join('');
      setStatus('Which tile comes next?');
      updateHeader();
      phase = 'question';
      bar.style.transition = 'none'; bar.style.width = '100%'; bar.offsetWidth; // restart the countdown bar
      bar.style.transition = `width ${cfg.timeMs}ms linear`; bar.style.width = '0%';
      shownAt = performance.now();
      timeoutId = later(timeUp, cfg.timeMs);
    }

    const optEl = i => $s('options').querySelector(`.ps-opt[data-i="${i}"]`);
    const answerIndex = () => options.findIndex(t => isCorrectAnswer(question, t));

    function resolve(record, status, tone, sound) {
      phase = 'feedback';
      bar.style.transition = 'none';
      $s('options').querySelectorAll('.ps-opt').forEach(b => { b.disabled = true; });
      const next = $s('next');
      next.outerHTML = tileHtml(question.answer).replace('class="ps-tile', 'class="ps-tile ps-revealed');
      results.push({ questionNumber: qNo, rules: [...question.rules], answer: { ...question.answer }, ...record });
      setStatus(status, tone); updateHeader();
      MF.Audio.play(sound);
      later(nextQuestion, FEEDBACK_MS);
    }
    const ruleText = () => question.rules.map(r => ({ shape: 'shape cycles', color: 'colour cycles', count: 'count changes', rot: 'triangle turns' })[r]).join(' + ');

    function onAnswer(i) {
      if (phase !== 'question' || !options[i]) return; // a question can only be scored once
      const t = Math.round(performance.now() - shownAt) / 1000;
      cancel(timeoutId);
      const chosen = tileKey(options[i]);
      if (isCorrectAnswer(question, options[i])) {
        optEl(i).classList.add('ok');
        resolve({ chosen, correct: true, timedOut: false, answerTime: t }, `Correct! ${t.toFixed(2)} s · ${ruleText()}`, 'ok', 'correct');
      } else {
        optEl(i).classList.add('bad');
        optEl(answerIndex()).classList.add('reveal');
        resolve({ chosen, correct: false, timedOut: false, answerTime: t }, `Wrong. Rule: ${ruleText()}`, 'bad', 'wrong');
      }
    }

    function timeUp() {
      optEl(answerIndex()).classList.add('reveal');
      resolve({ chosen: null, correct: false, timedOut: true, answerTime: null }, `TIME UP! Rule: ${ruleText()}`, 'bad', 'wrong');
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
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>PATTERN SHIFT COMPLETE! 🧩</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Accuracy', pct(result.accuracy))}
        ${stat('Correct Answers', `${d.correctAnswers} / ${QUESTIONS}`)}${stat('Wrong Answers', d.wrongAnswers)}${stat('Timeouts', d.timeouts)}
        ${stat('Average Answer Time', sec(d.averageAnswerTime))}${stat('Best Correct Answer', sec(d.bestCorrectTime))}
        ${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-ps="exit">Back to Games</button><button class="btn" data-ps="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-ps]');
      if (btn) {
        if (btn.dataset.ps === 'start') startGame();
        else if (btn.dataset.ps === 'exit') api.exit();
        return;
      }
      const opt = e.target.closest('.ps-opt');
      if (opt) onAnswer(Number(opt.dataset.i));
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      results = []; options = []; question = null; keys = new Set(); bar = cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, SHAPES, COLORS, COUNT_MIN, COUNT_MAX, tileKey, generateQuestion, generateOptions,
    isCorrectAnswer, calcScore, calcAccuracy, averageTime, difficultyOptions } };
})(window.MF);
