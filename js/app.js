(function (MF) {
  const $ = id => document.getElementById(id);
  const state = { view: 'dashboard', category: null, gameId: null, prev: null };
  let activeGame = null;
  const gameById = id => MF.GAMES.find(g => g.id === id);
  const catById = id => MF.CATEGORIES.find(c => c.id === id);

  const dots = n => `<span class="dots" aria-label="Difficulty ${n} of 5">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;

  function profileHtml() {
    const scores = MF.Profile.get();
    const empty = Object.values(scores).every(v => v === null);
    const rows = MF.CATEGORIES.map(c => `<div class="profile-row"><span>${c.name}</span>
      <div class="bar"><span style="width:${scores[c.id] ?? 0}%"></span></div>
      <span class="val">${scores[c.id] ?? '–'}</span></div>`).join('');
    return `<div class="card"><h2>Cognitive profile</h2>${rows}
      ${empty ? '<p class="muted">Play a game to build your profile.</p>' : ''}</div>`;
  }

  function gameCard(g) {
    // A registry entry without a module is shown as "Coming soon" and cannot be opened.
    if (!MF.GameModules[g.id]) {
      return `<div class="card game-card soon" aria-disabled="true"><h3>${g.name}</h3><p class="muted">${g.description}</p>
        <span class="badge">Coming soon</span></div>`;
    }
    const open = MF.Progress.isUnlocked(g);
    const info = open ? '<span class="badge ok">Ready</span>' : `<span class="badge">🔒 Locked · Unlock at ${g.xpRequired} XP</span>`;
    return `<button class="card game-card ${open ? '' : 'locked'}" data-action="game" data-id="${g.id}">
      <h3>${g.name}</h3><p class="muted">${g.description}</p>${dots(MF.Difficulty.get(g.id))}${info}</button>`;
  }

  const views = {
    game: () => '<div id="gameRoot"></div>',
    dashboard() {
      const p = MF.Progress.levelProgress();
      const cats = MF.CATEGORIES.map(c => {
        const games = MF.GAMES.filter(g => g.category === c.id);
        const open = games.filter(g => MF.GameModules[g.id] && MF.Progress.isUnlocked(g)).length;
        return `<button class="card cat-card" data-action="category" data-id="${c.id}">
          <span class="icon">${c.icon}</span><h3>${c.name}</h3><p class="muted">${c.description}</p>
          <span class="badge">${open}/${games.length} unlocked</span></button>`;
      }).join('');
      return `<section class="hero"><div class="card"><h2>Welcome back</h2>
        <p class="muted">Train five cognitive areas, one short session at a time.</p>
        <div class="hero-stats">
          <div class="stat"><b>${MF.Progress.getXp()}</b><span class="muted">Total XP</span></div>
          <div class="stat"><b>${MF.Progress.getLevel()}</b><span class="muted">Level</span></div>
          <div class="stat"><b>${MF.Progress.getStreak()}</b><span class="muted">Day streak</span></div></div>
        <div class="bar" style="margin-top:16px"><span style="width:${p.current / p.total * 100}%"></span></div>
        <p class="muted">${p.current} / ${p.total} XP to next level</p></div>${profileHtml()}</section>
        <h2>Categories</h2><div class="cat-grid">${cats}</div>
        <h2>All games</h2><div class="game-grid">${MF.GAMES.map(gameCard).join('')}</div>`;
    },
    category() {
      const c = catById(state.category);
      return `<button class="back" data-action="nav" data-view="dashboard">← Back</button>
        <h2>${c.icon} ${c.name}</h2><div class="game-grid">
        ${MF.GAMES.filter(g => g.category === c.id).map(gameCard).join('')}</div>`;
    },
    history() {
      const h = MF.Storage.get('history');
      const rows = h.slice(0, 30).map(r => `<tr><td>${gameById(r.gameId)?.name ?? r.gameId}</td><td>${r.score}</td>
        <td>${Math.round(r.accuracy * 100)}%</td><td>${r.time}s</td><td>${r.difficulty}</td><td>+${r.xp}</td>
        <td>${new Date(r.date).toLocaleDateString()}</td></tr>`).join('');
      return `<h2>Progress</h2><div class="hero" style="grid-template-columns:1fr 1fr">${profileHtml()}
        <div class="card"><h2>Totals</h2><p>${h.length} games played</p><p>${MF.Progress.getXp()} XP</p>
        <p>${MF.Progress.getStreak()} day streak</p></div></div>
        <div class="card"><h2>History</h2>${h.length ? `<div class="table-wrap"><table class="table"><thead><tr>
        <th>Game</th><th>Score</th><th>Accuracy</th><th>Time</th><th>Level</th><th>XP</th><th>Date</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="empty">No games played yet. Pick a game on the dashboard.</p>'}</div>`;
    },
    settings() {
      const s = MF.Storage.get('settings');
      const row = (key, label) => `<div class="switch"><span>${label}</span>
        <button class="toggle" role="switch" aria-checked="${s[key]}" aria-label="${label}" data-action="toggle" data-key="${key}"></button></div>`;
      return `<h2>Settings</h2><div class="card">${row('soundEffects', 'Sound effects')}${row('music', 'Music')}
        <div class="switch"><span>Reset all progress</span><button class="btn ghost" data-action="reset">Reset</button></div></div>`;
    }
  };

  function renderChrome() {
    $('topbarStats').innerHTML = `<span>⭐ ${MF.Progress.getXp()} XP</span><span>🔥 ${MF.Progress.getStreak()}</span>`;
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  }

  function stopGame() { if (activeGame) { activeGame.destroy(); activeGame = null; } }

  function exitGame() {
    state.view = state.prev ? state.prev.view : 'dashboard';
    state.category = state.prev ? state.prev.category : null;
    render();
  }

  function render() {
    stopGame();
    $('app').innerHTML = views[state.view]();
    renderChrome();
    if (state.view === 'game') activeGame = MF.GameModules[state.gameId].create($('gameRoot'), { exit: exitGame, onProgress: renderChrome });
  }

  function showModal(html) {
    $('modal').innerHTML = `<div class="modal-box" role="dialog" aria-modal="true">${html}</div>`;
    $('modal').hidden = false;
  }
  const closeModal = () => { $('modal').hidden = true; };

  function openGame(id) {
    const g = gameById(id);
    if (!MF.Progress.isUnlocked(g)) {
      return showModal(`<h3>🔒 ${g.name}</h3><p class="muted">Unlock at ${g.xpRequired} XP. You have ${MF.Progress.getXp()} XP.</p>
        <div class="modal-actions"><button class="btn" data-action="close">Got it</button></div>`);
    }
    if (!MF.GameModules[id]) return; // not built yet (its card is not clickable)
    closeModal();
    state.prev = { view: state.view, category: state.category };
    state.view = 'game';
    state.gameId = id;
    render();
  }

  const actions = {
    nav: el => { state.view = el.dataset.view; render(); },
    category: el => { state.view = 'category'; state.category = el.dataset.id; render(); },
    game: el => openGame(el.dataset.id),
    close: closeModal,
    toggle: el => { MF.Audio.setSetting(el.dataset.key, el.getAttribute('aria-checked') !== 'true'); MF.Audio.play('click'); render(); },
    reset: () => { if (confirm('Delete all progress and settings?')) { MF.Storage.reset(); MF.Audio.reset(); render(); } }
  };

  document.addEventListener('click', e => {
    if (e.target === $('modal')) return closeModal();
    const el = e.target.closest('[data-action]');
    if (el) { e.preventDefault(); actions[el.dataset.action](el); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  render();
})(window.MF);
