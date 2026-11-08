(function (MF) {
  const ID = 'color-filter';
  const TRIALS = 20, GO_TRIALS = 12, MAX_GO_RUN = 4, FEEDBACK_MS = 350, READY_MS = 900, MAX_ATTEMPTS = 60;
  const COLORS = {
    blue: '#5b8cff', purple: '#b07cff', teal: '#4fd1d9', red: '#e05656', amber: '#f2b84b', green: '#3ecf8e'
  };
  // Look-alike hues used from level 2 (the hard distractors for each target colour).
  const SIMILAR = { blue: ['purple', 'teal'], purple: ['blue', 'red'], teal: ['blue', 'green'], red: ['amber', 'purple'], amber: ['red', 'green'], green: ['teal', 'amber'] };
  const SHAPES = ['circle', 'square', 'triangle'];
  // Per level: rule kind, look-alike colours, Stroop word inside the shape, how long a stimulus stays (= response window), gap.
  const LEVELS = {
    1: { rule: 'color', similar: false, word: false, displayMs: 1500, gapMs: 600 },
    2: { rule: 'color', similar: true, word: false, displayMs: 1200, gapMs: 500 },
    3: { rule: 'both', similar: false, word: false, displayMs: 1100, gapMs: 500 },
    4: { rule: 'both', similar: false, word: true, displayMs: 950, gapMs: 450 },
    5: { rule: 'both', similar: true, word: true, displayMs: 800, gapMs: 400 }
  };
  // Per trial: hit = HIT + speed bonus (full at FAST_MS, 0 at the end of the window); correct rejection = CR;
  // false alarm and miss cost points. Total × difficulty factor, floored at 0.
  const SCORE = { HIT: 30, SPEED_BONUS_MAX: 20, FAST_MS: 250, CORRECT_REJECTION: 20, FALSE_ALARM_PENALTY: 30, MISS_PENALTY: 10, DIFFICULTY_STEP: 0.15 };
  const ADAPT = { UP_ACCURACY: 0.9, DOWN_ACCURACY: 0.6, MAX_FALSE_ALARMS_UP: 1, NEVER: 2 };

  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const shuffle = list => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const maxRun = (list, v) => { let m = 0, run = 0; list.forEach(x => { run = x === v ? run + 1 : 0; m = Math.max(m, run); }); return m; };

  // ----- pure helpers -----
  const isGo = (stim, target) => stim.color === target.color && (target.shape === null || stim.shape === target.shape);
  // Go/no-go plan: GO_TRIALS go among TRIALS, never more than MAX_GO_RUN go in a row (bounded reshuffles + constructive fallback).
  function planTrials(total = TRIALS, go = GO_TRIALS) {
    const base = [...Array(go).fill(true), ...Array(total - go).fill(false)];
    for (let i = 0; i < MAX_ATTEMPTS; i++) { const p = shuffle(base); if (maxRun(p, true) <= MAX_GO_RUN) return p; }
    // fallback: no-go spread evenly (exact counts, short go runs)
    const nogo = total - go, spots = new Set(Array.from({ length: nogo }, (_, k) => Math.round(k * total / nogo)));
    return Array.from({ length: total }, (_, i) => !spots.has(i));
  }
  // One stimulus that is (go=true) or is not (go=false) a target. Wrong ones mix the hard cases: right colour/wrong shape,
  // wrong (look-alike) colour/right shape, and fully different ones. Word = a colour name that never helps.
  function makeStimulus(target, go, cfg) {
    const others = Object.keys(COLORS).filter(c => c !== target.color);
    const lookalike = () => (cfg.similar ? pick(SIMILAR[target.color]) : pick(others));
    let color = target.color, shape = target.shape || pick(SHAPES);
    if (!go) {
      if (cfg.rule === 'color') color = cfg.similar && Math.random() < 0.7 ? lookalike() : pick(others);
      else {
        const kind = rand(0, 2);
        if (kind === 0) shape = pick(SHAPES.filter(s => s !== target.shape));          // right colour, wrong shape
        else if (kind === 1) color = lookalike();                                     // wrong colour, right shape
        else { color = pick(others); shape = pick(SHAPES.filter(s => s !== target.shape)); }
      }
    }
    const word = cfg.word ? pick(Object.keys(COLORS).filter(c => c !== color)).toUpperCase() : null;
    return { color, shape, word };
  }
  function chooseTarget(cfg) { return { color: pick(Object.keys(COLORS)), shape: cfg.rule === 'both' ? pick(SHAPES) : null }; }
  const ruleText = t => `Tap only ${t.color.toUpperCase()}${t.shape ? ' ' + t.shape.toUpperCase() + 'S' : ''}`;

  // trial: { go, responded, rt (ms) }
  const outcome = t => (t.go ? (t.responded ? 'hit' : 'miss') : (t.responded ? 'falseAlarm' : 'correctRejection'));
  const count = (trials, kind) => trials.filter(t => outcome(t) === kind).length;
  const calcAccuracy = trials => (trials.length ? (count(trials, 'hit') + count(trials, 'correctRejection')) / trials.length : 0);
  function trialScore(t, windowMs) {
    const o = outcome(t);
    if (o === 'hit') return SCORE.HIT + Math.min(1, Math.max(0, (windowMs - t.rt) / (windowMs - SCORE.FAST_MS))) * SCORE.SPEED_BONUS_MAX;
    if (o === 'correctRejection') return SCORE.CORRECT_REJECTION;
    return o === 'falseAlarm' ? -SCORE.FALSE_ALARM_PENALTY : -SCORE.MISS_PENALTY;
  }
  function calcScore(trials, difficulty) {
    const sum = trials.reduce((s, t) => s + trialScore(t, LEVELS[difficulty].displayMs), 0);
    return Math.max(0, Math.round(sum * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP)));
  }
  const averageHitRt = trials => { const h = trials.filter(t => outcome(t) === 'hit'); return h.length ? h.reduce((s, t) => s + t.rt, 0) / h.length : null; };
  function difficultyOptions(trials) {
    return { upAt: count(trials, 'falseAlarm') <= ADAPT.MAX_FALSE_ALARMS_UP ? ADAPT.UP_ACCURACY : ADAPT.NEVER, downAt: ADAPT.DOWN_ACCURACY };
  }
  const pct = v => Math.round(v * 100) + '%';
  const ms = v => (v === null ? '—' : Math.round(v) + ' ms');

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, trials = [], tNo = 0, plan = [], target = null, stim = null;
    let startedAt = 0, shownAt = 0, windowId = null;
    const timers = new Set();
    const $s = key => root.querySelector(`[data-s="${key}"]`);

    function later(fn, delay) {
      const id = setTimeout(() => { timers.delete(id); if (alive) fn(); }, delay);
      timers.add(id);
      return id;
    }
    function cancel(id) { clearTimeout(id); timers.delete(id); }
    function clearTimers() { timers.forEach(clearTimeout); timers.clear(); windowId = null; }

    function showIntro() {
      const lvl = MF.Difficulty.get(ID), c = LEVELS[lvl];
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Color Filter</h2><p class="muted">Tap (or press Space) only when the shape matches the rule. Let everything else pass.${c.word ? ' Ignore the word, the colour of the shape counts.' : ''}</p>
        <p><b>Level ${lvl}</b> · ${TRIALS} shapes · ${c.rule === 'both' ? 'colour + shape rule' : 'colour rule'}</p>
        <div class="mm-buttons"><button class="btn ghost" data-cf="exit">Back</button><button class="btn" data-cf="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      trials = []; tNo = 0; plan = planTrials(); target = chooseTarget(cfg); phase = 'gap'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Color Filter</h2><span class="muted">Attention</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Shape</span><b data-s="t">0/${TRIALS}</b></div>
        <div><span class="muted">Errors</span><b data-s="err">0</b></div></div>
        <button class="btn ghost" data-cf="exit">Exit Game</button></div>
        <div class="cf-rule" data-s="rule"><span class="cf-shape cf-sample cf-${target.shape || 'circle'}" style="--cf-c:${COLORS[target.color]}" aria-hidden="true"></span>${ruleText(target)}</div>
        <button class="cf-stage" data-s="stage" aria-label="Tap when the shape matches the rule"><span class="cf-fix">+</span></button>
        <div class="cf-status" data-s="status" aria-live="polite">Get ready…</div>`;
      MF.Audio.play('game-start');
      later(nextTrial, READY_MS);
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    function updateHeader() {
      $s('t').textContent = `${tNo}/${TRIALS}`;
      $s('err').textContent = count(trials, 'falseAlarm') + count(trials, 'miss');
    }
    const stimHtml = s => `<span class="cf-shape cf-${s.shape}" style="--cf-c:${COLORS[s.color]}" data-color="${s.color}" data-shape="${s.shape}">${s.word ? `<b>${s.word}</b>` : ''}</span>`;

    function nextTrial() {
      if (trials.length >= TRIALS) return finish();
      tNo = trials.length + 1;
      stim = makeStimulus(target, plan[tNo - 1], cfg);
      $s('stage').innerHTML = stimHtml(stim);
      $s('stage').dataset.tone = '';
      setStatus('');
      updateHeader();
      phase = 'stim';
      shownAt = performance.now();
      windowId = later(windowEnd, cfg.displayMs);
    }

    function respond() {
      if (phase !== 'stim') return; // one response per stimulus; presses between stimuli are ignored
      cancel(windowId);
      resolve(true, Math.round(performance.now() - shownAt));
    }
    function windowEnd() { resolve(false, null); }

    function resolve(responded, rt) {
      phase = 'gap';
      const t = { trialNumber: tNo, go: plan[tNo - 1], color: stim.color, shape: stim.shape, word: stim.word, responded, rt };
      trials.push(t);
      const o = outcome(t);
      const ok = o === 'hit' || o === 'correctRejection';
      $s('stage').dataset.tone = ok ? 'ok' : 'bad';
      if (o === 'hit') { setStatus(`${rt} ms`, 'ok'); MF.Audio.play('correct'); }
      else if (o === 'falseAlarm') { setStatus('Not that one!', 'bad'); MF.Audio.play('wrong'); }
      else if (o === 'miss') { setStatus('Missed it!', 'bad'); MF.Audio.play('wrong'); }
      updateHeader();
      later(() => { $s('stage').innerHTML = '<span class="cf-fix">+</span>'; $s('stage').dataset.tone = ''; later(nextTrial, cfg.gapMs); }, FEEDBACK_MS);
    }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const avg = averageHitRt(trials);
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(trials, difficulty), accuracy: calcAccuracy(trials), time, difficulty }),
        details: { rule: ruleText(target), hits: count(trials, 'hit'), misses: count(trials, 'miss'), falseAlarms: count(trials, 'falseAlarm'),
          correctRejections: count(trials, 'correctRejection'), goTrials: trials.filter(t => t.go).length, averageHitTime: avg === null ? null : Math.round(avg),
          trialResults: trials.map(t => ({ ...t })) }
      };
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, difficultyOptions(trials));
      api.onProgress();
      showResult({ result, prevBest, out });
    }

    function showResult({ result, prevBest, out }) {
      const d = result.details;
      const stat = (l, v) => `<div><span class="muted">${l}</span><b>${v}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`), `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>COLOR FILTER COMPLETE! 🎯</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Accuracy', pct(result.accuracy))}
        ${stat('Hits', `${d.hits} / ${d.goTrials}`)}${stat('False Alarms', d.falseAlarms)}${stat('Misses', d.misses)}
        ${stat('Average Hit Time', ms(d.averageHitTime))}${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-cf="exit">Back to Games</button><button class="btn" data-cf="start">Play Again</button></div></div>`;
    }

    // Presses: pointerdown on the stage (lowest latency); keyboard Space/Enter; a click with detail 0 (assistive tech) also counts.
    function onPointerDown(e) { if (e.target.closest('.cf-stage')) respond(); }
    function onClick(e) {
      const btn = e.target.closest('[data-cf]');
      if (btn) {
        if (btn.dataset.cf === 'start') startGame();
        else if (btn.dataset.cf === 'exit') api.exit();
      } else if (e.detail === 0 && e.target.closest('.cf-stage')) respond();
    }
    function onKey(e) {
      if ((e.key === ' ' || e.key === 'Enter') && (phase === 'stim' || phase === 'gap')) { e.preventDefault(); respond(); }
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      trials = []; plan = []; stim = target = cfg = null; phase = 'destroyed';
    }

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, COLORS, SIMILAR, SHAPES, TRIALS, GO_TRIALS, MAX_GO_RUN, isGo, planTrials, maxRun,
    makeStimulus, chooseTarget, outcome, calcAccuracy, calcScore, difficultyOptions } };
})(window.MF);
