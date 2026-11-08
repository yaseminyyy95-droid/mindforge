(function (MF) {
  MF.CONFIG = { XP_PER_LEVEL: 500, MAX_DIFFICULTY: 5, MIN_DIFFICULTY: 1, HISTORY_LIMIT: 200, RECENT_WINDOW: 5 };

  MF.GameModules = {}; // playable games register themselves here: MF.GameModules[id] = { create(root, api) }

  MF.CATEGORIES = [
    { id: 'memory', name: 'Memory', icon: '🧠', description: 'Hold and recall information' },
    { id: 'attention', name: 'Attention', icon: '🎯', description: 'Focus and filter distractions' },
    { id: 'speed', name: 'Speed', icon: '⚡', description: 'React and switch quickly' },
    { id: 'math', name: 'Math', icon: '➗', description: 'Calculate and compare numbers' },
    { id: 'logic', name: 'Logic', icon: '🧩', description: 'Find rules and solve puzzles' }
  ];

  const game = (id, name, category, description, xpRequired = 0) =>
    ({ id, name, category, description, difficulty: 1, unlocked: xpRequired === 0, xpRequired });

  // Central game registry. To add a game, update its entry here and add its module under games/<category>/.
  MF.GAMES = [
    game('memory-match', 'Memory Match', 'memory', 'Flip cards and find matching pairs.'),
    game('sequence-recall', 'Sequence Recall', 'memory', 'Repeat a growing sequence in order.', 200),
    game('grid-memory', 'Grid Memory', 'memory', 'Remember which cells lit up.', 500),
    game('target-focus', 'Target Focus', 'attention', 'Find the target symbol among look-alikes.'),
    game('color-filter', 'Color Filter', 'attention', 'Respond only to the right colors.', 250),
    game('distraction-hunt', 'Distraction Hunt', 'attention', 'Spot the odd one out under distraction.', 600),
    game('reaction-rush', 'Reaction Rush', 'speed', 'Tap as fast as the signal appears.'),
    game('quick-switch', 'Quick Switch', 'speed', 'Switch rules on the fly.', 300),
    game('speed-sequence', 'Speed Sequence', 'speed', 'Tap items in order against the clock.', 700),
    game('quick-calculate', 'Quick Calculate', 'math', 'Solve arithmetic under time pressure.'),
    game('number-compare', 'Number Compare', 'math', 'Decide which side is bigger, or if they are equal.', 200),
    game('missing-number', 'Missing Number', 'math', 'Find the number that completes the equation.', 500),
    game('pattern-shift', 'Pattern Shift', 'logic', 'Predict how a pattern changes.'),
    game('logic-grid', 'Logic Grid', 'logic', 'Deduce answers from clues.', 250),
    game('path-finder', 'Path Finder', 'logic', 'Plan the shortest valid route.', 600)
  ];
})((window.MF = window.MF || {}));
