(function (MF) {
  const DAY = 86400000;
  const dayKey = d => d.toISOString().slice(0, 10);
  const level = xp => Math.floor(xp / MF.CONFIG.XP_PER_LEVEL) + 1;

  function touchStreak() {
    return MF.Storage.update('streak', s => {
      const today = dayKey(new Date());
      if (s.lastPlayed === today) return s;
      const yesterday = dayKey(new Date(Date.now() - DAY));
      return { count: s.lastPlayed === yesterday ? s.count + 1 : 1, lastPlayed: today };
    });
  }

  MF.Progress = {
    getXp: () => MF.Storage.get('xp'),
    getLevel: () => level(MF.Storage.get('xp')),
    levelProgress() {
      const per = MF.CONFIG.XP_PER_LEVEL;
      return { current: MF.Storage.get('xp') % per, total: per };
    },
    isUnlocked: game => game.unlocked || MF.Storage.get('xp') >= game.xpRequired,
    // Streak shows 0 if the last play was before yesterday.
    getStreak() {
      const s = MF.Storage.get('streak');
      const recent = [dayKey(new Date()), dayKey(new Date(Date.now() - DAY))].includes(s.lastPlayed);
      return recent ? s.count : 0;
    },
    // Single entry point for finished games: updates XP, history, progress, streak, unlocks.
    recordResult(result, opts = {}) {
      const before = MF.Storage.get('xp');
      const xp = MF.Storage.update('xp', v => v + result.xp);
      MF.Storage.update('history', h => [result, ...h].slice(0, MF.CONFIG.HISTORY_LIMIT));
      MF.Storage.update('progress', p => {
        const prev = p[result.gameId] || { plays: 0, bestScore: 0 };
        return { ...p, [result.gameId]: {
          plays: prev.plays + 1,
          bestScore: Math.max(prev.bestScore, result.score),
          difficulty: MF.Difficulty.next(result.difficulty, result, opts)
        } };
      });
      touchStreak();
      MF.Storage.set('categoryScores', MF.Profile.compute());
      MF.Storage.set('unlocked', MF.GAMES.filter(MF.Progress.isUnlocked).map(g => g.id));
      const newlyUnlocked = MF.GAMES.filter(g => !g.unlocked && g.xpRequired > before && g.xpRequired <= xp);
      return { xp, leveledUp: level(xp) > level(before), newlyUnlocked };
    }
  };
})(window.MF);
