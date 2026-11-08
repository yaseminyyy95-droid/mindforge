'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, property } = require('../lib/harness');

// Independent order from the labels on the board: numbers ascending, interleaved with letters A, B, ... if there are any.
function expectedOrder(labels) {
  const nums = labels.filter(l => /^\d+$/.test(l)).map(Number).sort((a, b) => a - b).map(String);
  const lets = labels.filter(l => /^[A-Z]$/.test(l)).sort();
  if (!lets.length) return nums;
  return nums.flatMap((n, i) => (lets[i] ? [n, lets[i]] : [n]));
}

test('speed-sequence: sequences and boards (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['speed-sequence'].helpers;
  for (let level = 1; level <= 5; level++) {
    const cfg = H.LEVELS[level], n = cfg.cols * cfg.rows;
    const seq = H.sequenceFor(level);
    assert.strictEqual(seq.length, n);
    assert.strictEqual(new Set(seq).size, n, 'duplicate label');
    assert.deepStrictEqual([...seq], expectedOrder([...seq]));
    if (cfg.kind === 'alternate') assert.ok(seq.every((l, i) => (i % 2 === 0) === /^\d+$/.test(l)), 'not alternating');
    assert.ok(cfg.cols * 44 + (cfg.cols - 1) * 8 <= 328, `level ${level}: cells < 44px at 360px`);
    property(`board level ${level}`, 1000, () => {
      const b = H.generateBoard(level);
      assert.deepStrictEqual([...b].sort(), [...seq].sort(), 'board is not a permutation of the sequence');
    });
  }
  assert.throws(() => H.sequenceFor(6));
  const B = (correct, total, wrong, finished, time) => ({ correct, total, wrong, finished, time });
  assert.strictEqual(H.calcAccuracy([B(9, 9, 1, true, 5), B(4, 9, 0, false, null)]), 13 / 19);
  assert.strictEqual(H.calcScore([B(9, 9, 0, true, 5)], 1), 90 + 50 + 50);        // within 40% of 20 s: full bonus
  assert.strictEqual(H.calcScore([B(9, 9, 2, true, 20)], 1), 90 - 10 + 50);       // at the limit: no bonus
  assert.strictEqual(H.calcScore([B(0, 9, 4, false, null)], 1), 0);
  const fast = Array(3).fill(B(9, 9, 0, true, 8));
  assert.strictEqual(h.MF.Difficulty.next(1, { accuracy: 1 }, H.difficultyOptions(fast, 1)), 2);
  assert.strictEqual(h.MF.Difficulty.next(1, { accuracy: 1 }, H.difficultyOptions(Array(3).fill(B(9, 9, 0, true, 15)), 1)), 1, 'slow: stay');
  const late = [B(3, 9, 0, false, null), B(3, 9, 0, false, null), B(9, 9, 0, true, 5)];
  assert.strictEqual(h.MF.Difficulty.next(2, { accuracy: H.calcAccuracy(late) }, H.difficultyOptions(late, 2)), 1);
  h.close();
});

// ---------- jsdom flows ----------
const labels = h => h.$$('.ss-cell').map(c => c.dataset.label);
const cellOf = (h, label) => h.$(`.ss-cell[data-label="${label}"]`);
async function waitBoard(h, b) {
  await h.waitFor(() => h.$('[data-s="b"]')?.textContent === `${b}/3` && h.$('.ss-cell') && !h.$$('.ss-cell').some(c => c.disabled), 5000, 'board ' + b);
}

test('speed-sequence: full game (clean / wrong taps / timeout), XP/history/profile, adaptive', async () => {
  const h = loadApp({ scale: 0.02, storage: { xp: 700, progress: { 'speed-sequence': { plays: 1, bestScore: 0, difficulty: 3 } } } });
  assert.ok(h.$('.game-card[data-id="speed-sequence"]:not(.locked)'), 'unlocked at 700 XP');
  h.openGame('speed-sequence');
  h.startGame('ss');
  // board 1: clean
  await waitBoard(h, 1);
  let order = expectedOrder(labels(h));
  assert.strictEqual(order.length, 12);
  assert.strictEqual(h.$('[data-s="next"]').textContent, '1');
  order.forEach(l => h.click(cellOf(h, l)));
  assert.match(h.$('.ss-status').textContent, /Done/);
  // board 2: two wrong taps (one on an already finished tile does not count), then finish
  await waitBoard(h, 2);
  order = expectedOrder(labels(h));
  h.click(cellOf(h, order[0]));
  h.click(cellOf(h, order[2]));                   // wrong (skips one)
  h.click(cellOf(h, order[0]));                   // already done: disabled, ignored
  h.click(cellOf(h, order[5]));                   // wrong
  assert.strictEqual(h.$('[data-s="next"]').textContent, order[1]);
  order.slice(1).forEach(l => h.click(cellOf(h, l)));
  // board 3: timeout after 4 taps
  await waitBoard(h, 3);
  order = expectedOrder(labels(h));
  order.slice(0, 4).forEach(l => h.click(cellOf(h, l)));
  await h.waitFor(() => /TIME UP/.test(h.$('.ss-status').textContent), 3000, 'timeout');
  await h.waitFor(() => h.$('.mm-result'), 3000, 'result');
  const r = h.history()[0];
  assert.strictEqual(r.gameId, 'speed-sequence');
  assert.deepStrictEqual([r.details.boardsFinished, r.details.correctTaps, r.details.wrongTaps], [2, 12 + 12 + 4, 2]);
  assert.strictEqual(r.accuracy, 28 / (36 + 2));
  assert.strictEqual(h.store('xp'), 700 + r.xp);
  assert.strictEqual(typeof h.store('categoryScores').speed, 'number');
  assert.strictEqual(h.store('progress')['speed-sequence'].difficulty, 3, 'one timeout: no level up; accuracy 0.74: no level down');
  assert.strictEqual(h.liveTimers(), 0);
  h.close();
});

test('speed-sequence: exit/nav cleanup, re-entry, SFX on/off', async () => {
  const h = loadApp({ scale: 0.05, storage: { xp: 700 }, filesAvailable: true });
  h.openGame('speed-sequence'); h.startGame('ss');
  await waitBoard(h, 1);
  const order = expectedOrder(labels(h));
  h.click(cellOf(h, order[1]));                   // wrong -> flash timer
  h.click(h.$('[data-ss="exit"]'));
  assert.strictEqual(h.liveTimers(), 0, 'exit with a flash timer pending');
  h.openGame('speed-sequence'); h.startGame('ss');
  await waitBoard(h, 1);
  expectedOrder(labels(h)).forEach(l => h.click(cellOf(h, l)));
  const s = h.sfx();
  assert.ok(['game-start', 'wrong', 'click', 'correct'].every(x => s.includes(x)), s.join());
  h.click(h.$('#nav [data-view="history"]'));
  assert.strictEqual(h.liveTimers(), 0, 'nav during feedback');
  await h.sleep(300);
  assert.strictEqual(h.history().length, 0);
  h.click(h.$('.logo'));
  h.openGame('speed-sequence');
  assert.ok(h.$('[data-ss="start"]') && !h.$('.ss-cell'), 're-entry shows intro');
  h.MF.Audio.setSetting('soundEffects', false);
  h.audio.length = 0;
  h.startGame('ss');
  await waitBoard(h, 1);
  h.click(cellOf(h, '1'));
  assert.deepStrictEqual([...h.sfx()], []);
  h.close();
});
