(function (MF) {
  const { MIN_DIFFICULTY: MIN, MAX_DIFFICULTY: MAX } = MF.CONFIG;
  const THRESHOLD = { UP: 0.85, DOWN: 0.5, SLOW_FACTOR: 1.5 };

  MF.Difficulty = {
    levels: [1, 2, 3, 4, 5],
    // result: { accuracy, time }; opts.targetTime (optional) is the expected completion time; opts.upAt/downAt (optional) override the accuracy thresholds per game.
    next(current, result, opts = {}) {
      const tooSlow = opts.targetTime && result.time > opts.targetTime * THRESHOLD.SLOW_FACTOR;
      if (result.accuracy >= (opts.upAt ?? THRESHOLD.UP) && !tooSlow) return Math.min(MAX, current + 1);
      if (result.accuracy < (opts.downAt ?? THRESHOLD.DOWN)) return Math.max(MIN, current - 1);
      return current;
    },
    get: gameId => (MF.Storage.get('progress')[gameId] || {}).difficulty || MIN
  };
})(window.MF);
