(function (MF) {
  const WEIGHT = { BASE: 0.6, STEP: 0.1 };
  const MAX_SCORE = 100;

  // Rating of one result: accuracy scaled by difficulty (0-100).
  const rate = r => Math.min(MAX_SCORE, r.accuracy * MAX_SCORE * (WEIGHT.BASE + WEIGHT.STEP * r.difficulty));
  const avg = list => list.reduce((a, b) => a + b, 0) / list.length;

  MF.Profile = {
    // Returns { categoryId: score | null }. null = no data yet.
    compute() {
      const history = MF.Storage.get('history');
      const out = {};
      MF.CATEGORIES.forEach(cat => {
        const scores = MF.GAMES.filter(g => g.category === cat.id).map(g => {
          const recent = history.filter(h => h.gameId === g.id).slice(0, MF.CONFIG.RECENT_WINDOW);
          return recent.length ? avg(recent.map(rate)) : null;
        }).filter(v => v !== null);
        out[cat.id] = scores.length ? Math.round(avg(scores)) : null;
      });
      return out;
    },
    get: () => MF.Profile.compute()
  };
})(window.MF);
