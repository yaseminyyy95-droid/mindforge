(function (MF) {
  const PREFIX = 'mindforge:';
  const DEFAULTS = {
    user: { name: 'Player', createdAt: null },
    settings: { soundEffects: true, music: false },
    xp: 0,
    streak: { count: 0, lastPlayed: null },
    unlocked: [],
    progress: {},        // { gameId: { difficulty, plays, bestScore } }
    history: [],         // [{ gameId, score, accuracy, time, difficulty, xp, date }]
    categoryScores: {}   // { categoryId: 0-100 }
  };
  const clone = v => JSON.parse(JSON.stringify(v));

  // The only place that touches localStorage. A backend can replace these methods later.
  MF.Storage = {
    get(key) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? clone(DEFAULTS[key]) : JSON.parse(raw);
      } catch (e) { return clone(DEFAULTS[key]); }
    },
    set(key, value) {
      try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); }
      catch (e) { console.warn('Storage unavailable:', e.message); }
    },
    update(key, fn) { const next = fn(this.get(key)); this.set(key, next); return next; },
    reset() { Object.keys(DEFAULTS).forEach(k => localStorage.removeItem(PREFIX + k)); }
  };
})(window.MF);
