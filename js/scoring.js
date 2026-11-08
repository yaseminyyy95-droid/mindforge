(function (MF) {
  const XP = { BASE: 10, ACCURACY_BONUS: 30, DIFFICULTY_STEP: 0.25 };

  // Every game returns its result through this function, whatever its own metrics are.
  MF.Scoring = {
    createResult({ gameId, score = 0, accuracy = 0, time = 0, difficulty = 1 }) {
      const acc = Math.min(1, Math.max(0, accuracy));
      const multiplier = 1 + (difficulty - 1) * XP.DIFFICULTY_STEP;
      const xp = Math.round((XP.BASE + acc * XP.ACCURACY_BONUS) * multiplier);
      return { gameId, score, accuracy: acc, time, difficulty, xp, date: new Date().toISOString() };
    }
  };
})(window.MF);
