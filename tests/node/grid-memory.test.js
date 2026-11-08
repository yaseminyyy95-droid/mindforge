'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, property } = require('../lib/harness');

test('grid-memory: patterns, grading, score, adaptation (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['grid-memory'].helpers;
  for (let level = 1; level <= 5; level++) {
    const cfg = H.LEVELS[level];
    let prev = null, repeats = 0;
    property(`level ${level}`, 2000, () => {
      const p = H.generatePattern(level, prev);
      assert.strictEqual(p.length, cfg.targets);
      assert.strictEqual(new Set(p).size, cfg.targets, 'duplicate cell');
      p.forEach(c => assert.ok(Number.isInteger(c) && c >= 0 && c < cfg.size * cfg.size));
      if (H.patternKey(p) === prev) repeats++;
      prev = H.patternKey(p);
    });
    assert.strictEqual(repeats, 0, 'pattern repeated the previous round');
    // touch targets: the largest grid must fit 44px cells in a 328px wide column (360px phone minus 2×16px padding)
    assert.ok(cfg.size * 44 + (cfg.size - 1) * 6 <= 328, `level ${level} grid too wide for 44px cells`);
  }
  assert.throws(() => H.generatePattern(7));
  assert.deepStrictEqual({ ...H.gradeRound([1, 2, 3], [3, 2, 1]) }, { hits: 3, wrong: 0, missed: 0, perfect: true });
  assert.deepStrictEqual({ ...H.gradeRound([1, 2, 3], [1, 5, 6]) }, { hits: 1, wrong: 2, missed: 2, perfect: false });
  assert.deepStrictEqual({ ...H.gradeRound([1, 2, 3], [1]) }, { hits: 1, wrong: 0, missed: 2, perfect: false });
  const R = (hits, targets, perfect) => ({ hits, targets, perfect });
  const rounds = [R(3, 3, true), R(2, 3, false)];
  assert.strictEqual(H.calcAccuracy(rounds), 5 / 6);
  assert.strictEqual(H.calcScore(rounds, 1), 5 * 15 + 30);
  const great = Array(8).fill(R(4, 4, true));
  assert.strictEqual(h.MF.Difficulty.next(2, { accuracy: 1 }, H.difficultyOptions(great)), 3);
  const fivePerfect = [...Array(5).fill(R(4, 4, true)), ...Array(3).fill(R(3, 4, false))];
  assert.strictEqual(h.MF.Difficulty.next(2, { accuracy: H.calcAccuracy(fivePerfect) }, H.difficultyOptions(fivePerfect)), 2, '5 perfect rounds: stay');
  assert.strictEqual(h.MF.Difficulty.next(2, { accuracy: 0.5 }, H.difficultyOptions(Array(8).fill(R(2, 4, false)))), 1);
  h.close();
});

// ---------- jsdom flows: the pattern is read from the cells that light up ----------
async function waitShow(h, r) {
  await h.waitFor(() => h.$('[data-s="r"]')?.textContent === `${r}/8` && h.$$('.gm-cell.lit').length > 0, 5000, 'show ' + r);
}
async function waitRecall(h) { await h.waitFor(() => !h.$('.gm-cell').disabled, 5000, 'recall'); }
const cell = (h, i) => h.$(`.gm-cell[data-i="${i}"]`);

test('grid-memory: full game (perfect / wrong / toggle / timeout), XP/history/profile, adaptive', async () => {
  const h = loadApp({ scale: 0.05, storage: { xp: 500 } });
  assert.ok(h.$('.game-card[data-id="grid-memory"]:not(.locked)'), 'unlocked at 500 XP');
  h.openGame('grid-memory');
  h.startGame('gm');
  for (let r = 1; r <= 8; r++) {
    await waitShow(h, r);
    const lit = h.$$('.gm-cell.lit').map(c => Number(c.dataset.i));
    assert.strictEqual(lit.length, 3);
    h.click(cell(h, lit[0]));                          // clicks while the pattern is shown are ignored
    await waitRecall(h);
    assert.strictEqual(h.$$('.gm-cell.picked').length, 0);
    if (r === 3) {                                       // one wrong pick
      const wrong = [...Array(9).keys()].find(i => !lit.includes(i));
      h.click(cell(h, lit[0])); h.click(cell(h, lit[1])); h.click(cell(h, wrong));
    } else if (r === 5) {                                // toggle off and on again, then complete
      h.click(cell(h, lit[0])); h.click(cell(h, lit[0])); lit.forEach(i => h.click(cell(h, i)));
    } else if (r === 6) {                                // timeout with one pick
      h.click(cell(h, lit[0]));
      await h.waitFor(() => /TIME UP/.test(h.$('.gm-status').textContent), 3000, 'timeout');
    } else lit.forEach(i => h.click(cell(h, i)));
    h.click(cell(h, lit[0]));                          // after evaluation: ignored
  }
  await h.waitFor(() => h.$('.mm-result'), 4000, 'result');
  const r = h.history()[0];
  assert.strictEqual(r.gameId, 'grid-memory');
  assert.deepStrictEqual([r.details.perfectRounds, r.details.cellsRemembered, r.details.totalCells, r.details.wrongPicks, r.details.timeouts], [6, 6 * 3 + 2 + 1, 24, 1, 1]);
  assert.strictEqual(r.accuracy, 21 / 24);
  assert.strictEqual(h.store('xp'), 500 + r.xp);
  assert.strictEqual(typeof h.store('categoryScores').memory, 'number');
  assert.strictEqual(h.store('progress')['grid-memory'].difficulty, 1, 'accuracy 0.875 < 0.9: stay');
  assert.strictEqual(h.liveTimers(), 0);
  h.click(h.$('[data-gm="start"]'));
  assert.strictEqual(h.$('.mm-chips b').textContent, '1');
  h.close();
});

test('grid-memory: exit/nav cleanup; re-entry; SFX on/off', async () => {
  const h = loadApp({ scale: 0.05, storage: { xp: 500 }, filesAvailable: true });
  h.openGame('grid-memory'); h.startGame('gm');
  await waitShow(h, 1);
  h.click(h.$('[data-gm="exit"]'));
  assert.strictEqual(h.liveTimers(), 0, 'exit while showing');
  h.openGame('grid-memory'); h.startGame('gm');
  await waitShow(h, 1);
  await waitRecall(h);
  h.click(h.$('#nav [data-view="history"]'));
  assert.strictEqual(h.liveTimers(), 0, 'nav during recall');
  await h.sleep(900);                                   // > 15 virtual s
  assert.strictEqual(h.history().length, 0);
  h.click(h.$('.logo'));
  h.openGame('grid-memory');
  assert.ok(h.$('[data-gm="start"]') && !h.$('.gm-cell'), 're-entry shows intro');
  h.startGame('gm');
  await waitShow(h, 1);
  const lit = h.$$('.gm-cell.lit').map(c => Number(c.dataset.i));
  await waitRecall(h);
  lit.forEach(i => h.click(cell(h, i)));
  const s = h.sfx();
  assert.ok(['game-start', 'card-flip', 'click', 'correct'].every(x => s.includes(x)), s.join());
  h.click(h.$('[data-gm="exit"]'));
  h.MF.Audio.setSetting('soundEffects', false);
  h.audio.length = 0;
  h.openGame('grid-memory'); h.startGame('gm');
  await waitShow(h, 1); await waitRecall(h);
  h.click(cell(h, 0));
  assert.deepStrictEqual([...h.sfx()], []);
  h.close();
});
