'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, property } = require('../lib/harness');

const diff = (a, b) => { const d = Math.abs(((a % 360) + 360) % 360 - (((b % 360) + 360) % 360)); return Math.min(d, 360 - d); };
// Independent odd-one-out finder: the arrow that is far (> 2 × wobble) from most others.
function findOdd(angles) {
  const far = angles.map(a => angles.filter(b => diff(a, b) > 20).length);
  const max = Math.max(...far);
  const idx = far.map((f, i) => (f === max ? i : -1)).filter(i => i >= 0);
  return idx.length === 1 ? idx[0] : -1;
}

test('distraction-hunt: exactly one clearly different arrow; distractors never the odd one (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['distraction-hunt'].helpers;
  for (let level = 1; level <= 5; level++) {
    const cfg = H.LEVELS[level];
    assert.ok(cfg.delta - cfg.jitter > 2 * cfg.jitter && cfg.delta - cfg.jitter > 16, `level ${level}: odd arrow not separable from wobble`);
    assert.ok(cfg.size * 44 + (cfg.size - 1) * 6 <= 328, `level ${level}: cells < 44px at 360px`);
    property(`level ${level}`, 2000, () => {
      const r = H.generateRound(level);
      assert.strictEqual(r.cells.length, cfg.size * cfg.size);
      r.cells.forEach((a, i) => {
        assert.ok(a >= 0 && a < 360);
        if (i === r.odd) assert.ok(diff(a, r.base) === Math.min(cfg.delta, 360 - cfg.delta));
        else assert.ok(diff(a, r.base) <= cfg.jitter);
      });
      assert.strictEqual(findOdd(r.cells), r.odd, 'independent finder disagrees');
      const b = H.pickBuzz(r.cells.length, r.odd, cfg.buzz);
      assert.strictEqual(new Set(b).size, cfg.buzz);
      assert.ok(!b.includes(r.odd), 'the odd arrow blinks');
    });
  }
  assert.throws(() => H.generateRound(0));
  h.close();
});

test('distraction-hunt: score / accuracy / adaptation (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['distraction-hunt'].helpers;
  const ok = (t, m = 0) => ({ searchTime: t, mistakes: m }), to = m => ({ searchTime: null, mistakes: m });
  assert.strictEqual(H.calcScore([ok(1)], 1), 100);              // at/under par: full bonus
  assert.strictEqual(H.calcScore([ok(10)], 1), 50);              // at the timeout: no bonus
  assert.strictEqual(H.calcScore([ok(1, 2)], 1), 70);
  assert.strictEqual(H.calcScore([to(0)], 1), 0);                // floored
  assert.strictEqual(H.calcAccuracy([ok(1), to(0)]), 0.5);
  const good = Array(10).fill(ok(2));
  assert.strictEqual(h.MF.Difficulty.next(1, { accuracy: 1 }, H.difficultyOptions(good, 1)), 2);
  assert.strictEqual(h.MF.Difficulty.next(1, { accuracy: 1 }, H.difficultyOptions(Array(10).fill(ok(2, 1)), 1)), 1, '10 mistakes: no level up');
  assert.strictEqual(h.MF.Difficulty.next(3, { accuracy: 0.9 }, H.difficultyOptions(Array(10).fill(ok(2, 1)), 3)), 2, '>= 10 mistakes: level down');
  h.close();
});

// ---------- jsdom flows ----------
const angles = h => h.$$('.dh-cell').map(c => Number(c.dataset.a));
async function waitRound(h, r) {
  await h.waitFor(() => h.$('[data-s="r"]')?.textContent === `${r}/10` && h.$('.dh-cell') && !h.$('.dh-cell').disabled, 5000, 'round ' + r);
}

test('distraction-hunt: full game (found / mistakes / timeout), blinking distractors, XP/history/profile', async () => {
  const h = loadApp({ scale: 0.05, storage: { xp: 600, progress: { 'distraction-hunt': { plays: 1, bestScore: 0, difficulty: 3 } } } });
  assert.ok(h.$('.game-card[data-id="distraction-hunt"]:not(.locked)'), 'unlocked at 600 XP');
  h.openGame('distraction-hunt');
  h.startGame('dh');
  for (let r = 1; r <= 10; r++) {
    await waitRound(h, r);
    const odd = findOdd(angles(h));
    assert.ok(odd >= 0, 'odd arrow not identifiable from the DOM');
    if (r === 1) {
      await h.waitFor(() => h.$$('.dh-buzz').length === 3, 2000, 'three blinking cells on level 3');
      assert.ok(!h.$(`.dh-cell[data-i="${odd}"]`).classList.contains('dh-buzz'));
    }
    if (r === 2) { const w = odd === 0 ? 1 : 0; h.click(h.$(`.dh-cell[data-i="${w}"]`)); h.click(h.$(`.dh-cell[data-i="${w}"]`)); }
    if (r === 4) { await h.waitFor(() => /TIME UP/.test(h.$('.dh-status').textContent), 3000, 'timeout'); continue; }
    h.click(h.$(`.dh-cell[data-i="${odd}"]`));
    h.click(h.$(`.dh-cell[data-i="${odd}"]`));        // second click on a finished round: ignored
  }
  await h.waitFor(() => h.$('.mm-result'), 4000, 'result');
  const r = h.history()[0];
  assert.strictEqual(r.gameId, 'distraction-hunt');
  assert.deepStrictEqual([r.details.found, r.details.mistakes, r.details.totalRounds], [9, 1, 10], 'a disabled wrong cell counts once');
  assert.strictEqual(r.accuracy, 0.9);
  assert.strictEqual(r.difficulty, 3);
  assert.strictEqual(h.store('xp'), 600 + r.xp);
  assert.strictEqual(typeof h.store('categoryScores').attention, 'number');
  assert.strictEqual(h.store('progress')['distraction-hunt'].difficulty, 4);
  assert.strictEqual(h.liveTimers(), 0, 'blink loop stopped');
  h.close();
});

test('distraction-hunt: exit/nav cleanup (blink loop), re-entry, SFX on/off', async () => {
  const h = loadApp({ scale: 0.05, storage: { xp: 600, progress: { 'distraction-hunt': { plays: 1, bestScore: 0, difficulty: 2 } } }, filesAvailable: true });
  h.openGame('distraction-hunt'); h.startGame('dh');
  await waitRound(h, 1);
  assert.strictEqual(h.liveTimers(), 2, 'round timeout + blink step');
  h.click(h.$('[data-dh="exit"]'));
  assert.strictEqual(h.liveTimers(), 0, 'exit during search');
  h.openGame('distraction-hunt'); h.startGame('dh');
  await waitRound(h, 1);
  h.click(h.$(`.dh-cell[data-i="${findOdd(angles(h))}"]`));
  h.click(h.$('#nav [data-view="settings"]'));
  assert.strictEqual(h.liveTimers(), 0, 'nav during feedback');
  await h.sleep(700);
  assert.strictEqual(h.history().length, 0);
  assert.ok(h.sfx().includes('game-start') && h.sfx().includes('correct'));
  h.click(h.$('.logo'));
  h.openGame('distraction-hunt');
  assert.ok(h.$('[data-dh="start"]') && !h.$('.dh-cell'), 're-entry shows intro');
  h.MF.Audio.setSetting('soundEffects', false);
  h.audio.length = 0;
  h.startGame('dh');
  await waitRound(h, 1);
  h.click(h.$(`.dh-cell[data-i="${findOdd(angles(h)) === 0 ? 1 : 0}"]`));
  assert.deepStrictEqual([...h.sfx()], []);
  h.close();
});
