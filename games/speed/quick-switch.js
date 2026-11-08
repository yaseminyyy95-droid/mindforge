(function (MF) {
  const ID = 'quick-switch';
  const TRIALS = 24, FEEDBACK_MS = 350, GAP_MS = 300, READY_MS = 800;
  // Response mapping (fixed for the whole game): left = BLUE or CIRCLE, right = ORANGE or SQUARE.
  const MAP = { color: { left: 'blue', right: 'orange' }, shape: { left: 'circle', right: 'square' } };
  const CSS = { blue: '#5b8cff', orange: '#f2994b' };
  // Per level: share of rule switches, share of incongruent cards (the two rules point to different buttons),
  // how long the cue is shown before the card (preparation time), response time limit.
  const LEVELS = {
    1: { switchShare: 0.2, incongruentShare: 0.3, cueLeadMs: 600, limitMs: 3000 },
    2: { switchShare: 0.3, incongruentShare: 0.4, cueLeadMs: 400, limitMs: 2600 },
    3: { switchShare: 0.4, incongruentShare: 0.5, cueLeadMs: 200, limitMs: 2200 },
    4: { switchShare: 0.5, incongruentShare: 0.6, cueLeadMs: 0, limitMs: 1900 },
    5: { switchShare: 0.5, incongruentShare: 0.7, cueLeadMs: 0, limitMs: 1600 }
  };
  // Correct = BASE + speed bonus (full at FAST_MS, 0 at the limit); wrong / timeout cost points.
  const SCORE = { CORRECT_BASE: 30, SPEED_BONUS_MAX: 20, FAST_MS: 400, WRONG_PENALTY: 15, TIMEOUT_PENALTY: 10, DIFFICULTY_STEP: 0.15 };
  const ADAPT = { UP_ACCURACY: 0.9, DOWN_ACCURACY: 0.6, FAST_FRACTION: 0.6, TIMEOUTS_DOWN: 4, NEVER: 2 };
  const KEYS = { ArrowLeft: 'left', f: 'left', F: 'left', ArrowRight: 'right', j: 'right', J: 'right' };

  const shuffle = list => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const other = side => (side === 'left' ? 'right' : 'left');

  // ----- pure helpers -----
  // Exact counts: round((n-1)*switchShare) switches at random positions (trial 1 is neither switch nor repeat),
  // round(n*incongruentShare) incongruent cards; correct side balanced (n/2 each). -> [{ rule, switched, congruent, side }]
  function planTrials(cfg, n = TRIALS) {
    const switchAt = new Set(shuffle(Array.from({ length: n - 1 }, (_, i) => i + 1)).slice(0, Math.round((n - 1) * cfg.switchShare)));
    const incongruent = new Set(shuffle([...Array(n).keys()]).slice(0, Math.round(n * cfg.incongruentShare)));
    const sides = shuffle([...Array(Math.ceil(n / 2)).fill('left'), ...Array(Math.floor(n / 2)).fill('right')]);
    let rule = Math.random() < 0.5 ? 'color' : 'shape';
    return Array.from({ length: n }, (_, i) => {
      if (switchAt.has(i)) rule = rule === 'color' ? 'shape' : 'color';
      return { rule, switched: i === 0 ? null : switchAt.has(i), congruent: !incongruent.has(i), side: sides[i] };
    });
  }
  // Card whose relevant attribute points to `side`; the irrelevant one agrees (congruent) or points the other way.
  function makeCard(t) {
    const irrelevant = t.rule === 'color' ? 'shape' : 'color';
    return { [t.rule]: MAP[t.rule][t.side], [irrelevant]: MAP[irrelevant][t.congruent ? t.side : other(t.side)] };
  }
  const correctSide = (card, rule) => (card[rule] === MAP[rule].left ? 'left' : 'right');

  const correctOnes = rs => rs.filter(r => r.correct);
  const calcAccuracy = rs => (rs.length ? correctOnes(rs).length / rs.length : 0);
  const mean = list => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);
  const averageRt = rs => mean(correctOnes(rs).map(r => r.rt));
  // Switch cost = mean correct RT on switch trials − mean correct RT on repeat trials (null if either group is empty).
  function switchCost(rs) {
    const sw = mean(correctOnes(rs).filter(r => r.switched === true).map(r => r.rt));
    const rep = mean(correctOnes(rs).filter(r => r.switched === false).map(r => r.rt));
    return sw === null || rep === null ? null : sw - rep;
  }
  function trialScore(r, limitMs) {
    if (r.timedOut) return -SCORE.TIMEOUT_PENALTY;
    if (!r.correct) return -SCORE.WRONG_PENALTY;
    return SCORE.CORRECT_BASE + Math.min(1, Math.max(0, (limitMs - r.rt) / (limitMs - SCORE.FAST_MS))) * SCORE.SPEED_BONUS_MAX;
  }
  function calcScore(rs, difficulty) {
    const sum = rs.reduce((s, r) => s + trialScore(r, LEVELS[difficulty].limitMs), 0);
    return Math.max(0, Math.round(sum * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP)));
  }
  function difficultyOptions(rs, difficulty) {
    const avg = averageRt(rs), timeouts = rs.filter(r => r.timedOut).length;
    const fast = avg !== null && avg <= LEVELS[difficulty].limitMs * ADAPT.FAST_FRACTION;
    return { upAt: fast ? ADAPT.UP_ACCURACY : ADAPT.NEVER, downAt: timeouts >= ADAPT.TIMEOUTS_DOWN ? ADAPT.NEVER : ADAPT.DOWN_ACCURACY };
  }
  const pct = v => Math.round(v * 100) + '%';
  const ms = v => (v === null ? '—' : Math.round(v) + ' ms');

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, results = [], plan = [], tNo = 0, card = null;
    let startedAt = 0, shownAt = 0, limitId = null;
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
      const lvl = MF.Difficulty.get(ID);
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Quick Switch</h2><p class="muted">The cue says which rule counts: <b>COLOR</b> (blue left, orange right) or <b>SHAPE</b> (circle left, square right). Keys ← → or F J.</p>
        <p><b>Level ${lvl}</b> · ${TRIALS} cards</p>
        <div class="mm-buttons"><button class="btn ghost" data-qs="exit">Back</button><button class="btn" data-qs="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      results = []; plan = planTrials(cfg); tNo = 0; phase = 'gap'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Quick Switch</h2><span class="muted">Speed</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Card</span><b data-s="t">0/${TRIALS}</b></div>
        <div><span class="muted">Correct</span><b data-s="correct">0</b></div></div>
        <button class="btn ghost" data-qs="exit">Exit Game</button></div>
        <div class="bar"><span data-s="bar"></span></div>
        <div class="qs-cue" data-s="cue">&nbsp;</div>
        <div class="qs-stage" data-s="stage"></div>
        <div class="qs-answers"><button class="qs-btn" data-side="left" disabled><span><i class="qs-dot" style="background:${CSS.blue}"></i>Blue</span><span>● Circle</span></button>
        <button class="qs-btn" data-side="right" disabled><span><i class="qs-dot" style="background:${CSS.orange}"></i>Orange</span><span>■ Square</span></button></div>
        <div class="qs-status" data-s="status" aria-live="polite">Get ready…</div>`;
      MF.Audio.play('game-start');
      later(nextTrial, READY_MS);
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    const setButtons = on => root.querySelectorAll('.qs-btn').forEach(b => { b.disabled = !on; });
    function updateHeader() { $s('t').textContent = `${tNo}/${TRIALS}`; $s('correct').textContent = correctOnes(results).length; }

    function nextTrial() {
      if (results.length >= TRIALS) return finish();
      tNo = results.length + 1;
      const t = plan[tNo - 1];
      card = makeCard(t);
      $s('cue').textContent = t.rule === 'color' ? '🎨 COLOR' : '🔷 SHAPE';
      $s('cue').dataset.rule = t.rule;
      $s('stage').innerHTML = '';
      setStatus(''); updateHeader();
      phase = 'cue';
      later(showCard, cfg.cueLeadMs);
    }
    function showCard() {
      $s('stage').innerHTML = `<span class="qs-card qs-${card.shape}" style="--qs-c:${CSS[card.color]}" data-color="${card.color}" data-shape="${card.shape}"
        role="img" aria-label="${card.color} ${card.shape}"></span>`;
      setButtons(true);
      phase = 'respond';
      const bar = $s('bar');
      bar.style.transition = 'none'; bar.style.width = '100%'; bar.offsetWidth;
      bar.style.transition = `width ${cfg.limitMs}ms linear`; bar.style.width = '0%';
      shownAt = performance.now();
      limitId = later(timeUp, cfg.limitMs);
    }

    function answer(side) {
      if (phase !== 'respond') return; // one answer per card
      cancel(limitId);
      const rt = Math.round(performance.now() - shownAt), t = plan[tNo - 1];
      const correct = side === correctSide(card, t.rule);
      resolve({ chosen: side, correct, timedOut: false, rt }, correct ? `${rt} ms` : `Wrong: ${t.rule === 'color' ? 'look at the colour' : 'look at the shape'}`, correct ? 'ok' : 'bad', correct ? 'correct' : 'wrong');
    }
    function timeUp() { resolve({ chosen: null, correct: false, timedOut: true, rt: null }, 'Too slow!', 'bad', 'wrong'); }

    function resolve(record, status, tone, sound) {
      phase = 'gap';
      setButtons(false);
      $s('bar').style.transition = 'none';
      const t = plan[tNo - 1];
      results.push({ trialNumber: tNo, rule: t.rule, switched: t.switched, congruent: t.congruent, ...record });
      setStatus(status, tone); updateHeader();
      MF.Audio.play(sound);
      later(() => { $s('stage').innerHTML = ''; later(nextTrial, GAP_MS); }, FEEDBACK_MS);
    }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const avg = averageRt(results), cost = switchCost(results);
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(results, difficulty), accuracy: calcAccuracy(results), time, difficulty }),
        details: { correctAnswers: correctOnes(results).length, wrongAnswers: results.filter(r => !r.correct && !r.timedOut).length,
          timeouts: results.filter(r => r.timedOut).length, averageResponseTime: avg === null ? null : Math.round(avg),
          switchCost: cost === null ? null : Math.round(cost), switchTrials: results.filter(r => r.switched === true).length,
          trialResults: results.map(r => ({ ...r })) }
      };
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, difficultyOptions(results, difficulty));
      api.onProgress();
      showResult({ result, prevBest, out });
    }

    function showResult({ result, prevBest, out }) {
      const d = result.details;
      const stat = (l, v) => `<div><span class="muted">${l}</span><b>${v}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`), `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>QUICK SWITCH COMPLETE! ⚡</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Accuracy', pct(result.accuracy))}
        ${stat('Correct', `${d.correctAnswers} / ${TRIALS}`)}${stat('Wrong', d.wrongAnswers)}${stat('Timeouts', d.timeouts)}
        ${stat('Average Response', ms(d.averageResponseTime))}${stat('Switch Cost', d.switchCost === null ? '—' : (d.switchCost > 0 ? '+' : '') + d.switchCost + ' ms')}
        ${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-qs="exit">Back to Games</button><button class="btn" data-qs="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-qs]');
      if (btn) {
        if (btn.dataset.qs === 'start') startGame();
        else if (btn.dataset.qs === 'exit') api.exit();
        return;
      }
      const ans = e.target.closest('.qs-btn');
      if (ans && !ans.disabled) answer(ans.dataset.side);
    }
    function onKey(e) {
      const side = KEYS[e.key];
      if (!side || phase === 'intro' || phase === 'done' || phase === 'destroyed') return;
      e.preventDefault();
      answer(side);
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      results = []; plan = []; card = cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, MAP, TRIALS, planTrials, makeCard, correctSide, calcAccuracy, averageRt,
    switchCost, calcScore, difficultyOptions } };
})(window.MF);
