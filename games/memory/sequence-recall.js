(function (MF) {
  const ID = 'sequence-recall';
  const TRIALS = 8, STEP_TIMEOUT_MS = 5000, FEEDBACK_MS = 1200, TAP_FLASH_MS = 180, READY_MS = 700, MAX_ATTEMPTS = 50;
  // Pads carry a colour and a symbol, so the game never relies on colour alone.
  const PADS = [{ sym: '▲', css: '#5b8cff' }, { sym: '●', css: '#3ecf8e' }, { sym: '■', css: '#f2b84b' }, { sym: '◆', css: '#e05656' },
    { sym: '★', css: '#b07cff' }, { sym: '✚', css: '#4fd1d9' }];
  // Per level: number of pads, starting sequence length, how long a pad stays lit and the gap between pads (ms).
  const LEVELS = {
    1: { pads: 4, start: 3, flashMs: 700, gapMs: 250 },
    2: { pads: 4, start: 4, flashMs: 600, gapMs: 220 },
    3: { pads: 5, start: 4, flashMs: 520, gapMs: 200 },
    4: { pads: 6, start: 5, flashMs: 450, gapMs: 180 },
    5: { pads: 6, start: 6, flashMs: 380, gapMs: 150 }
  };
  const MAX_LENGTH = 14;
  // Score: POINTS_PER_ITEM for every item of a correctly repeated sequence, times the difficulty factor.
  const SCORE = { POINTS_PER_ITEM: 20, DIFFICULTY_STEP: 0.15 };
  // Adaptation uses memory span, not accuracy (the staircase keeps accuracy near 50%): up when the longest correct
  // sequence reaches start + SPAN_UP, down when not even the starting length was recalled.
  const ADAPT = { SPAN_UP: 2, FORCE_UP: 0, NO_UP: 2, FORCE_DOWN: 2, NO_DOWN: 0 };

  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

  // ----- pure helpers -----
  // Random sequence over `pads` pads with no pad twice in a row (pads >= 2, so always possible; loop is bounded by length).
  function generateSequence(length, pads) {
    if (pads < 2 || length < 1) throw new Error('bad sequence request');
    const seq = [rand(0, pads - 1)];
    while (seq.length < length) { const p = rand(0, pads - 2); seq.push(p >= seq[seq.length - 1] ? p + 1 : p); }
    return seq;
  }
  // Staircase: +1 after a correct trial, -1 after a failed one, kept within [start, MAX_LENGTH].
  const nextLength = (length, correct, start) => Math.min(MAX_LENGTH, Math.max(start, length + (correct ? 1 : -1)));
  const correctOnes = trials => trials.filter(t => t.correct);
  const calcAccuracy = trials => (trials.length ? correctOnes(trials).length / trials.length : 0);
  const longestCorrect = trials => correctOnes(trials).reduce((m, t) => Math.max(m, t.length), 0);
  function calcScore(trials, difficulty) {
    const pts = correctOnes(trials).reduce((s, t) => s + t.length * SCORE.POINTS_PER_ITEM, 0);
    return Math.round(pts * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP));
  }
  function difficultyOptions(trials, difficulty) {
    const start = LEVELS[difficulty].start, span = longestCorrect(trials);
    return { upAt: span >= start + ADAPT.SPAN_UP ? ADAPT.FORCE_UP : ADAPT.NO_UP, downAt: span < start ? ADAPT.FORCE_DOWN : ADAPT.NO_DOWN };
  }
  const pct = v => Math.round(v * 100) + '%';

  function create(root, api) {
    let alive = true, phase = 'intro', difficulty = 1, cfg = null, trials = [], tNo = 0, length = 0, startedAt = 0;
    let seq = [], step = 0, stepId = null;
    const timers = new Set();
    const $s = key => root.querySelector(`[data-s="${key}"]`);

    function later(fn, delay) {
      const id = setTimeout(() => { timers.delete(id); if (alive) fn(); }, delay);
      timers.add(id);
      return id;
    }
    function cancel(id) { clearTimeout(id); timers.delete(id); }
    function clearTimers() { timers.forEach(clearTimeout); timers.clear(); stepId = null; }

    function showIntro() {
      const lvl = MF.Difficulty.get(ID), c = LEVELS[lvl];
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Sequence Recall</h2><p class="muted">Watch the pads light up, then repeat the sequence in the same order. Keys 1–${c.pads} also work.</p>
        <p><b>Level ${lvl}</b> · ${TRIALS} rounds · ${c.pads} pads · starts at ${c.start}</p>
        <div class="mm-buttons"><button class="btn ghost" data-sr="exit">Back</button><button class="btn" data-sr="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      trials = []; tNo = 0; length = cfg.start; phase = 'feedback'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Sequence Recall</h2><span class="muted">Memory</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Round</span><b data-s="t">0/${TRIALS}</b></div>
        <div><span class="muted">Length</span><b data-s="len">${length}</b></div>
        <div><span class="muted">Best</span><b data-s="best">0</b></div></div>
        <button class="btn ghost" data-sr="exit">Exit Game</button></div>
        <div class="sr-status" data-s="status" aria-live="polite"></div>
        <div class="sr-progress" data-s="progress"></div>
        <div class="sr-pads sr-p${cfg.pads}" data-s="pads">${Array.from({ length: cfg.pads }, (_, i) =>
          `<button class="sr-pad" data-p="${i}" style="--sr-c:${PADS[i].css}" aria-label="Pad ${i + 1} ${PADS[i].sym}" disabled>${PADS[i].sym}</button>`).join('')}</div>`;
      MF.Audio.play('game-start');
      later(nextTrial, READY_MS);
    }

    const setStatus = (t, tone = '') => { const el = $s('status'); el.textContent = t; el.dataset.tone = tone; };
    const padEl = i => $s('pads').querySelector(`.sr-pad[data-p="${i}"]`);
    const setPadsEnabled = on => $s('pads').querySelectorAll('.sr-pad').forEach(b => { b.disabled = !on; });
    function updateHeader() {
      $s('t').textContent = `${tNo}/${TRIALS}`;
      $s('len').textContent = length;
      $s('best').textContent = longestCorrect(trials);
    }
    const renderProgress = () => { $s('progress').innerHTML = seq.map((_, i) => `<i class="${i < step ? 'on' : ''}"></i>`).join(''); };

    function nextTrial() {
      if (trials.length >= TRIALS) return finish();
      tNo = trials.length + 1;
      seq = generateSequence(length, cfg.pads); step = 0;
      phase = 'watch';
      setPadsEnabled(false); renderProgress(); updateHeader();
      setStatus('Watch…');
      playback(0);
    }
    // Lights pad k, then the next one after flash + gap; finally hands over to the player.
    function playback(k) {
      if (k >= seq.length) { beginInput(); return; }
      const el = padEl(seq[k]);
      el.classList.add('lit');
      MF.Audio.play('card-flip');
      later(() => { el.classList.remove('lit'); later(() => playback(k + 1), cfg.gapMs); }, cfg.flashMs);
    }
    function beginInput() {
      phase = 'input';
      setPadsEnabled(true);
      setStatus('Your turn: repeat the sequence');
      stepId = later(timeUp, STEP_TIMEOUT_MS);
    }

    function tap(i) {
      if (phase !== 'input' || i < 0 || i >= cfg.pads) return;
      cancel(stepId);
      const el = padEl(i);
      el.classList.add('tap');
      later(() => el.classList.remove('tap'), TAP_FLASH_MS);
      if (i !== seq[step]) return endTrial(false, false, i);
      step++; renderProgress();
      MF.Audio.play('click');
      if (step === seq.length) return endTrial(true, false, null);
      stepId = later(timeUp, STEP_TIMEOUT_MS);
    }
    function timeUp() { endTrial(false, true, null); }

    function endTrial(correct, timedOut, wrongPad) {
      phase = 'feedback';
      setPadsEnabled(false);
      trials.push({ trialNumber: tNo, length, correct, timedOut, reached: step, wrongPad });
      const answer = seq.map(p => PADS[p].sym).join(' ');
      setStatus(correct ? `Correct! ${length} in a row` : `${timedOut ? 'Too slow' : 'Wrong pad'}. It was ${answer}`, correct ? 'ok' : 'bad');
      MF.Audio.play(correct ? 'correct' : 'wrong');
      length = nextLength(length, correct, cfg.start);
      updateHeader();
      later(nextTrial, FEEDBACK_MS);
    }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(trials, difficulty), accuracy: calcAccuracy(trials), time, difficulty }),
        details: { longestSequence: longestCorrect(trials), correctTrials: correctOnes(trials).length, totalTrials: trials.length,
          timeouts: trials.filter(t => t.timedOut).length, startLength: cfg.start, trialResults: trials.map(t => ({ ...t })) }
      };
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, difficultyOptions(trials, difficulty));
      api.onProgress();
      showResult({ result, prevBest, out });
    }

    function showResult({ result, prevBest, out }) {
      const d = result.details;
      const stat = (l, v) => `<div><span class="muted">${l}</span><b>${v}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`), `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>SEQUENCE RECALL COMPLETE! 🧠</h2>
        <div class="mm-stats">${stat('Final Score', result.score)}${stat('Longest Sequence', d.longestSequence)}${stat('Accuracy', pct(result.accuracy))}
        ${stat('Correct Rounds', `${d.correctTrials} / ${TRIALS}`)}${stat('Timeouts', d.timeouts)}
        ${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-sr="exit">Back to Games</button><button class="btn" data-sr="start">Play Again</button></div></div>`;
    }

    function onClick(e) {
      const btn = e.target.closest('[data-sr]');
      if (btn) {
        if (btn.dataset.sr === 'start') startGame();
        else if (btn.dataset.sr === 'exit') api.exit();
        return;
      }
      const pad = e.target.closest('.sr-pad');
      if (pad && !pad.disabled) tap(Number(pad.dataset.p));
    }
    function onKey(e) {
      if (phase !== 'input' || !/^[1-6]$/.test(e.key)) return;
      e.preventDefault();
      tap(Number(e.key) - 1);
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      trials = []; seq = []; cfg = null; phase = 'destroyed';
    }

    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create, helpers: { LEVELS, SCORE, ADAPT, TRIALS, MAX_LENGTH, generateSequence, nextLength, calcAccuracy, longestCorrect,
    calcScore, difficultyOptions } };
})(window.MF);
