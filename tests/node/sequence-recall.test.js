'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, property } = require('../lib/harness');

test('sequence-recall: sequences, staircase, score, adaptation (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['sequence-recall'].helpers;
  for (const pads of [2, 4, 5, 6]) {
    property(`pads ${pads}`, 2000, i => {
      const len = 1 + (i % H.MAX_LENGTH);
      const s = H.generateSequence(len, pads);
      assert.strictEqual(s.length, len);
      s.forEach((p, k) => { assert.ok(Number.isInteger(p) && p >= 0 && p < pads); if (k) assert.notStrictEqual(p, s[k - 1], 'immediate repeat'); });
    });
  }
  // every pad is used over many samples (no off-by-one in the "skip previous" trick)
  const seen = new Set(); for (let i = 0; i < 300; i++) H.generateSequence(6, 6).forEach(p => seen.add(p));
  assert.strictEqual(seen.size, 6);
  assert.throws(() => H.generateSequence(3, 1));
  assert.strictEqual(H.nextLength(3, false, 3), 3);
  assert.strictEqual(H.nextLength(5, false, 3), 4);
  assert.strictEqual(H.nextLength(H.MAX_LENGTH, true, 3), H.MAX_LENGTH);
  const T = (length, correct) => ({ length, correct, timedOut: false });
  const trials = [T(3, true), T(4, true), T(5, false), T(4, true), T(5, true)];
  assert.strictEqual(H.calcAccuracy(trials), 0.8);
  assert.strictEqual(H.longestCorrect(trials), 5);
  assert.strictEqual(H.calcScore(trials, 1), (3 + 4 + 4 + 5) * 20);
  assert.strictEqual(H.calcScore(trials, 3), Math.round(16 * 20 * 1.3));
  const next = (tr, lvl) => h.MF.Difficulty.next(lvl, { accuracy: H.calcAccuracy(tr) }, H.difficultyOptions(tr, lvl));
  assert.strictEqual(next(trials, 1), 2, 'span 5 >= start 3 + 2 -> up');
  assert.strictEqual(next([T(3, true), T(4, false), T(3, true), T(4, true)], 1), 1, 'span 4 -> stay');
  assert.strictEqual(next([T(4, false), T(4, false)], 2), 1, 'start length never recalled -> down');
  assert.strictEqual(next([T(4, false), T(4, false)], 1), 1, 'never below 1');
  h.close();
});

// ---------- jsdom flows: the sequence is read from the pads that light up (what the player sees) ----------
function watchPads(h) {
  const lit = [];
  new h.w.MutationObserver(ms => ms.forEach(m => {
    if (m.target.classList?.contains('sr-pad') && m.target.classList.contains('lit') && !(m.oldValue || '').includes('lit')) lit.push(Number(m.target.dataset.p));
  })).observe(h.doc.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  return lit;
}
async function waitInput(h, t) {
  await h.waitFor(() => h.$('[data-s="t"]')?.textContent === `${t}/8` && h.$('.sr-pad') && !h.$('.sr-pad').disabled, 6000, 'input of round ' + t);
}
const pad = (h, i) => h.click(h.$(`.sr-pad[data-p="${i}"]`));

test('sequence-recall: full game (correct / wrong / timeout / keyboard), staircase in UI, XP/history/profile', async () => {
  const h = loadApp({ scale: 0.05, storage: { xp: 200 } });
  assert.ok(h.$('.game-card[data-id="sequence-recall"]:not(.locked)'), 'unlocked at 200 XP');
  h.openGame('sequence-recall');
  const lit = watchPads(h);
  h.startGame('sr');
  const lengths = [];
  for (let t = 1; t <= 8; t++) {
    lit.length = 0;
    await waitInput(h, t);
    const seq = [...lit];
    lengths.push(seq.length);
    assert.strictEqual(String(seq.length), h.$('[data-s="len"]').textContent, 'shown length = played length');
    if (t === 1) pad(h, seq[0]);                     // first tap alone, rest below (progress across taps)
    if (t === 3) { pad(h, (seq[0] + 1) % 4); pad(h, seq[0]); }   // wrong first pad; second tap ignored
    else if (t === 5) { await h.waitFor(() => /Too slow/.test(h.$('.sr-status').textContent), 3000, 'step timeout'); }
    else if (t === 6) seq.forEach(p => h.key(String(p + 1)));   // keyboard 1..n
    else (t === 1 ? seq.slice(1) : seq).forEach(p => pad(h, p));
  }
  await h.waitFor(() => h.$('.mm-result'), 4000, 'result');
  // staircase: 3,4,5 (wrong) 4,5 (timeout) 4,5,6
  assert.deepStrictEqual(lengths, [3, 4, 5, 4, 5, 4, 5, 6]);
  const r = h.history()[0];
  assert.strictEqual(r.gameId, 'sequence-recall');
  assert.deepStrictEqual([r.details.correctTrials, r.details.timeouts, r.details.longestSequence, r.details.totalTrials], [6, 1, 6, 8]);
  assert.strictEqual(r.accuracy, 0.75);
  assert.strictEqual(r.score, (3 + 4 + 4 + 4 + 5 + 6) * 20);
  assert.strictEqual(h.store('xp'), 200 + r.xp);
  assert.strictEqual(typeof h.store('categoryScores').memory, 'number');
  assert.strictEqual(h.store('progress')['sequence-recall'].difficulty, 2, 'span 6 >= 3 + 2');
  assert.strictEqual(h.liveTimers(), 0);
  h.click(h.$('[data-sr="start"]'));
  assert.strictEqual(h.$('.mm-chips b').textContent, '2');
  assert.strictEqual(h.$('[data-s="len"]').textContent, '4', 'level 2 starts at 4');
  h.close();
});

test('sequence-recall: taps during playback ignored; exit/nav cleanup incl. keydown; re-entry; SFX on/off', async () => {
  const h = loadApp({ scale: 0.05, storage: { xp: 200 }, filesAvailable: true });
  h.openGame('sequence-recall');
  const lit = watchPads(h);
  h.startGame('sr');
  await h.waitFor(() => lit.length >= 1, 3000, 'playback started');
  h.$$('.sr-pad').forEach(b => { b.disabled = false; });         // even if a pad were clickable, watch phase ignores it
  pad(h, 0); h.key('1');
  lit.length = 0;
  await waitInput(h, 1);
  assert.strictEqual(h.$$('.sr-progress i.on').length, 0, 'no step consumed during playback');
  assert.ok(h.sfx().includes('game-start') && h.sfx().includes('card-flip'));
  h.click(h.$('[data-sr="exit"]'));
  assert.strictEqual(h.liveTimers(), 0, 'exit during input');
  h.key('1');
  h.openGame('sequence-recall'); h.startGame('sr');
  await h.waitFor(() => h.$('.sr-pad.lit'), 3000, 'playback');
  h.click(h.$('#nav [data-view="settings"]'));
  assert.strictEqual(h.liveTimers(), 0, 'nav during playback');
  await h.sleep(800);
  assert.strictEqual(h.history().length, 0);
  h.click(h.$('.logo'));
  h.openGame('sequence-recall');
  assert.ok(h.$('[data-sr="start"]') && !h.$('.sr-pad'), 're-entry shows intro');
  h.MF.Audio.setSetting('soundEffects', false);
  h.audio.length = 0;
  h.startGame('sr');
  await waitInput(h, 1);
  pad(h, 0);
  assert.deepStrictEqual([...h.sfx()], []);
  h.close();
});
