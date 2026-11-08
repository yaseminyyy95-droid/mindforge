(function (MF) {
  const ID = 'reaction-rush';
  const ROUNDS = 5;
  // Per level: target diameter (px, kept touch-friendly) and the random wait range before the target appears (ms).
  const LEVELS = {
    1: { size: 96, wait: [1000, 3000] }, 2: { size: 84, wait: [900, 2500] }, 3: { size: 74, wait: [800, 2200] },
    4: { size: 66, wait: [700, 1900] }, 5: { size: 58, wait: [600, 1600] }
  };
  const COUNTDOWN = ['3', '2', '1'];
  const COUNT_STEP_MS = 800, GO_MS = 600, FEEDBACK_MS = 900, MISS_TIMEOUT_MS = 2000;
  const ARENA_PAD = 12, ARENA_TOP_RESERVED = 64; // keeps the target inside the arena and clear of the status line
  // Round points fall linearly from MAX (at FAST_MS) to 0 (at SLOW_MS); each false start costs a penalty.
  const SCORE = { FAST_MS: 200, SLOW_MS: 600, MAX_ROUND_POINTS: 200, FALSE_START_PENALTY: 50, DIFFICULTY_STEP: 0.1 };
  // Adaptive difficulty: fast average -> level up, slow average (or no valid reaction) -> level down.
  const ADAPT = { UP_AVG_MS: 320, DOWN_AVG_MS: 480, UP_ACCURACY: 0.8, DOWN_ACCURACY: 0.4, NEVER: 2 };

  const valid = rounds => rounds.filter(r => r.reactionTime !== null);
  const averageReaction = rounds => { const v = valid(rounds); return v.length ? v.reduce((s, r) => s + r.reactionTime, 0) / v.length : null; };
  const bestReaction = rounds => { const v = valid(rounds); return v.length ? Math.min(...v.map(r => r.reactionTime)) : null; };
  const calcAccuracy = rounds => (rounds.length ? valid(rounds).length / rounds.length : 0);
  const countFalseStarts = rounds => rounds.filter(r => r.falseStart).length;
  const roundPoints = rt => Math.min(1, Math.max(0, (SCORE.SLOW_MS - rt) / (SCORE.SLOW_MS - SCORE.FAST_MS))) * SCORE.MAX_ROUND_POINTS;
  function calcScore(rounds, difficulty) {
    const pts = valid(rounds).reduce((s, r) => s + roundPoints(r.reactionTime), 0) - countFalseStarts(rounds) * SCORE.FALSE_START_PENALTY;
    return Math.max(0, Math.round(pts * (1 + (difficulty - 1) * SCORE.DIFFICULTY_STEP)));
  }
  // Options for MF.Difficulty.next(): encodes the reaction-time criterion through its upAt/downAt thresholds.
  function difficultyOptions(rounds) {
    const avg = averageReaction(rounds);
    const fast = avg !== null && avg <= ADAPT.UP_AVG_MS;
    const slow = avg === null || avg >= ADAPT.DOWN_AVG_MS;
    return { upAt: fast ? ADAPT.UP_ACCURACY : ADAPT.NEVER, downAt: slow ? ADAPT.NEVER : ADAPT.DOWN_ACCURACY };
  }
  const ms = v => (v === null ? '—' : Math.round(v) + ' ms');
  const pct = v => Math.round(v * 100) + '%';

  function create(root, api) {
    let alive = true, phase = 'intro', cfg = null, difficulty = 1, rounds = [], roundNo = 0, startedAt = 0, shownAt = 0;
    let waitId = null, missId = null, arena = null, target = null;
    const timers = new Set();
    const $s = key => root.querySelector(`[data-s="${key}"]`);

    function later(fn, delay) {
      const id = setTimeout(() => { timers.delete(id); if (alive) fn(); }, delay);
      timers.add(id);
      return id;
    }
    function cancel(id) { clearTimeout(id); timers.delete(id); }
    function clearTimers() { timers.forEach(clearTimeout); timers.clear(); waitId = missId = null; }

    function showIntro() {
      const lvl = MF.Difficulty.get(ID);
      phase = 'intro';
      root.innerHTML = `<div class="mm-panel card"><h2>Reaction Rush</h2><p class="muted">React as fast as you can.</p>
        <p><b>Level ${lvl}</b> · ${ROUNDS} rounds</p>
        <div class="mm-buttons"><button class="btn ghost" data-rr="exit">Back</button><button class="btn" data-rr="start">Start Game</button></div></div>`;
    }

    function startGame() {
      clearTimers();
      difficulty = MF.Difficulty.get(ID);
      cfg = LEVELS[difficulty];
      rounds = []; roundNo = 0; phase = 'countdown'; startedAt = performance.now();
      root.innerHTML = `<div class="card mm-head"><div><h2>Reaction Rush</h2><span class="muted">Speed</span></div>
        <div class="mm-chips"><div><span class="muted">Level</span><b>${difficulty}</b></div>
        <div><span class="muted">Round</span><b data-s="round">0/${ROUNDS}</b></div>
        <div><span class="muted">Average</span><b data-s="avg">—</b></div></div>
        <button class="btn ghost" data-rr="exit">Exit Game</button></div>
        <div class="rr-arena" data-phase="countdown"><div class="rr-status" data-s="status"></div><div class="rr-big" data-s="big"></div>
        <button class="rr-target" hidden aria-label="Target"></button></div>
        <div class="rr-rounds" data-s="chips"></div>`;
      arena = root.querySelector('.rr-arena');
      target = root.querySelector('.rr-target');
      runCountdown(0);
    }

    const setPhase = p => { arena.dataset.phase = p; };
    const setStatus = t => { $s('status').textContent = t; };
    const setBig = t => { $s('big').textContent = t; };
    function updateHeader() {
      $s('round').textContent = `${roundNo}/${ROUNDS}`;
      $s('avg').textContent = ms(averageReaction(rounds));
      $s('chips').innerHTML = rounds.map(r => `<span class="badge">${r.falseStart ? 'False start' : r.missed ? 'Missed' : ms(r.reactionTime)}</span>`).join('');
    }

    function runCountdown(i) {
      if (i < COUNTDOWN.length) {
        setStatus('Get ready'); setBig(COUNTDOWN[i]);
        MF.Audio.play('countdown');
        later(() => runCountdown(i + 1), COUNT_STEP_MS);
      } else {
        setStatus(''); setBig('GO');
        MF.Audio.play('game-start');
        later(nextRound, GO_MS);
      }
    }

    function nextRound() {
      if (rounds.length >= ROUNDS) return finish();
      roundNo = rounds.length + 1;
      phase = 'wait';
      setPhase('wait'); setBig(''); setStatus('WAIT...');
      updateHeader();
      const [lo, hi] = cfg.wait;
      waitId = later(showTarget, lo + Math.random() * (hi - lo));
    }

    function placeTarget() {
      const w = arena.clientWidth, h = arena.clientHeight, s = cfg.size;
      const maxX = Math.max(ARENA_PAD, w - s - ARENA_PAD), maxY = Math.max(ARENA_TOP_RESERVED, h - s - ARENA_PAD);
      const x = ARENA_PAD + Math.random() * (maxX - ARENA_PAD), y = ARENA_TOP_RESERVED + Math.random() * (maxY - ARENA_TOP_RESERVED);
      target.style.cssText = `width:${s}px;height:${s}px;left:${Math.round(x)}px;top:${Math.round(y)}px`;
    }

    function showTarget() {
      waitId = null;
      phase = 'target';
      placeTarget();
      setPhase('go'); setStatus('GO!');
      target.hidden = false;
      shownAt = performance.now(); // timer starts the moment the target is shown
      missId = later(miss, MISS_TIMEOUT_MS);
    }

    function endRound(record, cls, status, big, sound) {
      rounds.push({ roundNumber: rounds.length + 1, ...record });
      phase = 'feedback';
      target.hidden = true;
      setPhase(cls); setStatus(status); setBig(big);
      MF.Audio.play(sound);
      updateHeader();
      later(nextRound, FEEDBACK_MS);
    }

    function hit() {
      const rt = Math.max(0, Math.round(performance.now() - shownAt));
      cancel(missId);
      endRound({ reactionTime: rt, falseStart: false }, 'hit', `Round ${roundNo}`, rt + ' ms', 'correct');
    }
    function falseStart() {
      cancel(waitId);
      endRound({ reactionTime: null, falseStart: true }, 'false', 'FALSE START!', '', 'wrong');
    }
    function miss() {
      endRound({ reactionTime: null, falseStart: false, missed: true }, 'false', 'Too slow!', '', 'wrong');
    }

    // Presses are handled on pointerdown (lowest latency); keyboard activation (click with detail 0) also works.
    function press(onTarget) {
      if (phase === 'wait') falseStart();
      else if (phase === 'target' && onTarget) hit();
    }
    function onPointerDown(e) {
      if (e.target.closest('.rr-arena')) press(!!e.target.closest('.rr-target'));
    }
    function onClick(e) {
      const btn = e.target.closest('[data-rr]');
      if (btn) {
        if (btn.dataset.rr === 'start') startGame();
        else if (btn.dataset.rr === 'exit') api.exit();
      } else if (e.detail === 0 && e.target.closest('.rr-target')) press(true);
    }

    function finish() {
      phase = 'done';
      const time = Math.round((performance.now() - startedAt) / 100) / 10;
      const avg = averageReaction(rounds);
      const result = {
        ...MF.Scoring.createResult({ gameId: ID, score: calcScore(rounds, difficulty), accuracy: calcAccuracy(rounds), time, difficulty }),
        details: { averageReactionTime: avg === null ? null : Math.round(avg * 10) / 10, bestReaction: bestReaction(rounds),
          falseStarts: countFalseStarts(rounds), rounds: rounds.map(r => ({ ...r })) }
      };
      const prevBest = (MF.Storage.get('progress')[ID] || {}).bestScore;
      MF.Audio.play('game-complete');
      const out = MF.Progress.recordResult(result, difficultyOptions(rounds));
      api.onProgress();
      showResult({ result, prevBest, out });
    }

    function showResult({ result, prevBest, out }) {
      const d = result.details;
      const stat = (label, value) => `<div><span class="muted">${label}</span><b>${value}</b></div>`;
      const notes = [prevBest === undefined ? 'First time playing!' : result.score > prevBest ? 'New best score!' : `Previous best: ${prevBest}`,
        out.leveledUp ? 'Level up!' : '', ...out.newlyUnlocked.map(x => `Unlocked: ${x.name}`), `Next level: ${MF.Difficulty.get(ID)}`].filter(Boolean);
      root.innerHTML = `<div class="mm-panel card mm-result"><h2>REACTION RUSH COMPLETE! ⚡</h2>
        <div class="mm-stats">${stat('Average Reaction', ms(d.averageReactionTime))}${stat('Best Reaction', ms(d.bestReaction))}
        ${stat('Accuracy', pct(result.accuracy))}${stat('False Starts', d.falseStarts)}${stat('Score', result.score)}
        ${stat('Difficulty', 'Level ' + result.difficulty)}${stat('Time', result.time.toFixed(1) + 's')}</div>
        <p class="mm-xp">+${result.xp} XP</p>${notes.map(n => `<p class="muted">${n}</p>`).join('')}
        <div class="mm-buttons"><button class="btn ghost" data-rr="exit">Back to Games</button><button class="btn" data-rr="start">Play Again</button></div></div>`;
    }

    // Called by app.js whenever the game view is left.
    function destroy() {
      alive = false;
      clearTimers();
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('click', onClick);
      rounds = []; arena = target = cfg = null; phase = 'destroyed';
    }

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('click', onClick);
    showIntro();
    return { destroy };
  }

  MF.GameModules[ID] = { create };
})(window.MF);
