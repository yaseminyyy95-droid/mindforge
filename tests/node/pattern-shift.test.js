'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, property } = require('../lib/harness');

// Independent validator shared with the browser test (tests/lib/solvers.js).
const { psInferNext: inferNext, psParseLabel: parseLabel } = require('../lib/solvers');
const key = t => `${t.shape}|${t.color}|${t.count}|${t.rot}`;
const visualKey = t => `${t.shape}|${t.color}|${t.count}|${t.shape === '▲' ? t.rot : 0}`;

test('pattern-shift: generator + options properties (1000 per level)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['pattern-shift'].helpers;
  for (let level = 1; level <= 5; level++) {
    const cfg = H.LEVELS[level];
    property(`level ${level}`, 1000, () => {
      const q = H.generateQuestion(level);
      assert.strictEqual(q.tiles.length, cfg.shown);
      assert.strictEqual(q.rules.length, cfg.rules);
      assert.ok(!(q.rules.includes('shape') && q.rules.includes('rot')), 'shape and rot together');
      const next = inferNext(q.tiles);
      assert.strictEqual(key(next), key(q.answer), 'answer differs from independent inference');
      for (const r of q.rules) assert.ok(new Set(q.tiles.map(t => t[r])).size > 1, `active rule ${r} does not change`);
      const all = [...q.tiles, q.answer];
      all.forEach(t => {
        assert.ok(t.count >= H.COUNT_MIN && t.count <= H.COUNT_MAX, 'count out of range');
        if (t.shape !== '▲') assert.strictEqual(t.rot, 0, 'rotation on a non-triangle');
      });
      const opts = H.generateOptions(q);
      assert.strictEqual(opts.length, 4);
      assert.strictEqual(new Set(opts.map(visualKey)).size, 4, 'two options look identical');
      assert.strictEqual(opts.filter(o => key(o) === key(next)).length, 1, 'not exactly one correct option');
      opts.forEach(o => assert.ok(o.count >= H.COUNT_MIN && o.count <= H.COUNT_MAX && o.color >= 0 && o.color < H.COLORS.length && H.SHAPES.includes(o.shape)));
    });
  }
  assert.throws(() => H.generateQuestion(9));
  h.close();
});

test('pattern-shift: score / accuracy / adaptation (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['pattern-shift'].helpers;
  const ok = t => ({ correct: true, timedOut: false, answerTime: t });
  const bad = { correct: false, timedOut: false, answerTime: 3 }, to = { correct: false, timedOut: true, answerTime: null };
  const fast = Array(10).fill(ok(1));
  assert.strictEqual(H.calcAccuracy(fast), 1);
  assert.strictEqual(H.calcScore(fast, 1), 1000);               // 10 × (60 + 40)
  assert.strictEqual(H.calcScore(fast, 5), 1600);               // × 1.6
  assert.strictEqual(H.calcScore(Array(10).fill(to), 3), 0);    // floored at 0
  assert.deepStrictEqual({ ...H.difficultyOptions(fast, 1) }, { upAt: 0.8, downAt: 0.5 });
  assert.strictEqual(H.difficultyOptions(Array(10).fill(ok(14)), 1).upAt, 2, 'slow players cannot level up');
  assert.strictEqual(H.difficultyOptions([...Array(7).fill(ok(1)), to, to, to], 1).downAt, 2, '3 timeouts force a level down');
  assert.strictEqual(h.MF.Difficulty.next(1, { accuracy: 0.8 }, H.difficultyOptions([...Array(8).fill(ok(1)), bad, bad], 1)), 2);
  h.close();
});

// ---------- jsdom game flows ----------
const domTiles = h => h.$$('.ps-seq .ps-tile:not(.ps-next)').map(t => parseLabel(t.getAttribute('aria-label')));
const domOptions = h => h.$$('.ps-opt .ps-tile').map(t => parseLabel(t.getAttribute('aria-label')));
function correctIndex(h) { const n = inferNext(domTiles(h)); return domOptions(h).findIndex(o => key(o) === key(n)); }
async function waitQuestion(h, q) {
  await h.waitFor(() => h.$('[data-s="q"]')?.textContent === `${q}/10` && h.$$('.ps-opt:not(:disabled)').length === 4, 4000, 'question ' + q);
}
async function play(h, { wrong = [], timeout = [], dbl = [] } = {}) {
  for (let q = 1; q <= 10; q++) {
    await waitQuestion(h, q);
    if (timeout.includes(q)) { await h.waitFor(() => /TIME UP/.test(h.$('.ps-status').textContent), 4000, 'timeout'); continue; }
    const c = correctIndex(h);
    assert.ok(c >= 0, 'correct option not found in DOM');
    const i = wrong.includes(q) ? (c + 1) % 4 : c;
    h.click(h.$(`.ps-opt[data-i="${i}"]`));
    if (dbl.includes(q)) h.click(h.$(`.ps-opt[data-i="${i}"]`));
  }
  await h.waitFor(() => h.$('.mm-result'), 4000, 'result screen');
}

test('pattern-shift: full game, wrong + timeout + double click, XP/history/profile', async () => {
  const h = loadApp();
  assert.ok(h.$('.game-card[data-id="pattern-shift"]:not(.locked)'), 'unlocked at 0 XP');
  h.openGame('pattern-shift');
  assert.match(h.$('.mm-panel').textContent, /Level 1/);
  h.startGame('ps');
  await play(h, { wrong: [2], timeout: [4], dbl: [5] });
  const r = h.history()[0];
  assert.strictEqual(r.gameId, 'pattern-shift');
  assert.deepStrictEqual([r.details.correctAnswers, r.details.wrongAnswers, r.details.timeouts, r.details.totalQuestions], [8, 1, 1, 10]);
  assert.strictEqual(r.accuracy, 0.8);
  ['score', 'accuracy', 'time', 'difficulty', 'xp', 'date'].forEach(k => assert.ok(k in r, 'missing ' + k));
  assert.strictEqual(h.store('xp'), r.xp);
  assert.match(h.$('#topbarStats').textContent, new RegExp(`${r.xp} XP`));
  assert.strictEqual(h.store('progress')['pattern-shift'].plays, 1);
  assert.strictEqual(typeof h.store('categoryScores').logic, 'number');
  assert.strictEqual(h.liveTimers(), 0, 'no timers after the result screen');
  h.click(h.$('[data-ps="exit"]'));
  assert.ok(h.$('.cat-card'), 'Back to Games returns to the dashboard');
  h.click(h.$('#nav [data-view="history"]'));
  assert.match(h.$('.table tbody').textContent, /Pattern Shift/);
  h.close();
});

test('pattern-shift: adaptive level up, Play Again uses it, level down on failure', async () => {
  const h = loadApp();
  h.openGame('pattern-shift');
  h.startGame('ps');
  await play(h);
  assert.strictEqual(h.store('progress')['pattern-shift'].difficulty, 2);
  h.click(h.$('[data-ps="start"]'));   // Play Again
  assert.strictEqual(h.$('.mm-chips b').textContent, '2');
  await play(h, { wrong: [1, 2, 3, 4, 5, 6] });
  assert.strictEqual(h.store('progress')['pattern-shift'].difficulty, 1);
  h.close();
});

test('pattern-shift: exit / nav cleanup and clean re-entry', async () => {
  const h = loadApp();
  h.openGame('pattern-shift'); h.startGame('ps');
  await waitQuestion(h, 1);
  assert.strictEqual(h.liveTimers(), 1);
  h.click(h.$('[data-ps="exit"]'));
  assert.strictEqual(h.liveTimers(), 0, 'exit during question');
  h.openGame('pattern-shift'); h.startGame('ps');
  await waitQuestion(h, 1);
  h.click(h.$(`.ps-opt[data-i="${correctIndex(h)}"]`));   // now in feedback
  h.click(h.$('#nav [data-view="settings"]'));
  assert.strictEqual(h.liveTimers(), 0, 'nav during feedback');
  await h.sleep(1700);                                      // > 15 virtual s
  assert.strictEqual(h.history().length, 0, 'nothing recorded after leaving');
  assert.ok(h.$('.toggle'), 'still on settings');
  h.click(h.$('.logo'));
  h.openGame('pattern-shift');
  assert.ok(h.$('[data-ps="start"]') && !h.$('.ps-opt'), 're-entry shows intro');
  h.startGame('ps');
  await waitQuestion(h, 1);
  assert.strictEqual(h.$('[data-s="correct"]').textContent, '0');
  h.close();
});

test('pattern-shift: SFX follow the setting (FILES_AVAILABLE copy, fake Audio)', async () => {
  const h = loadApp({ filesAvailable: true });
  h.openGame('pattern-shift'); h.startGame('ps');
  await waitQuestion(h, 1);
  h.click(h.$(`.ps-opt[data-i="${correctIndex(h)}"]`));
  assert.deepStrictEqual([...h.sfx()], ['game-start', 'correct']);
  h.click(h.$('[data-ps="exit"]'));
  h.MF.Audio.setSetting('soundEffects', false);
  h.audio.length = 0;
  h.openGame('pattern-shift'); h.startGame('ps');
  await waitQuestion(h, 1);
  h.click(h.$(`.ps-opt[data-i="${(correctIndex(h) + 1) % 4}"]`));
  assert.deepStrictEqual([...h.sfx()], []);
  h.close();
});
