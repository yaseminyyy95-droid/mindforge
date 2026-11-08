'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, property } = require('../lib/harness');

// Independent answer key (from the instructions shown to the player): COLOR blue=left orange=right, SHAPE circle=left square=right.
const key = (card, rule) => (rule === 'color' ? (card.color === 'blue' ? 'left' : 'right') : (card.shape === 'circle' ? 'left' : 'right'));

test('quick-switch: plans have exact switch / incongruent / side counts and valid cards (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['quick-switch'].helpers;
  for (let level = 1; level <= 5; level++) {
    const cfg = H.LEVELS[level];
    property(`level ${level}`, 1000, () => {
      const p = H.planTrials(cfg);
      assert.strictEqual(p.length, H.TRIALS);
      assert.strictEqual(p[0].switched, null);
      p.slice(1).forEach((t, i) => assert.strictEqual(t.switched, t.rule !== p[i].rule, 'switched flag disagrees with rule change'));
      assert.strictEqual(p.filter(t => t.switched).length, Math.round((H.TRIALS - 1) * cfg.switchShare));
      assert.strictEqual(p.filter(t => !t.congruent).length, Math.round(H.TRIALS * cfg.incongruentShare));
      assert.strictEqual(p.filter(t => t.side === 'left').length, H.TRIALS / 2);
      p.forEach(t => {
        const c = H.makeCard(t);
        assert.ok(['blue', 'orange'].includes(c.color) && ['circle', 'square'].includes(c.shape));
        assert.strictEqual(key(c, t.rule), t.side, 'card does not point to the planned side');
        assert.strictEqual(H.correctSide(c, t.rule), t.side);
        assert.strictEqual(key(c, t.rule === 'color' ? 'shape' : 'color') === t.side, t.congruent, 'congruency wrong');
      });
    });
  }
  h.close();
});

test('quick-switch: score / switch cost / adaptation (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['quick-switch'].helpers;
  const ok = (rt, switched) => ({ correct: true, timedOut: false, rt, switched });
  const bad = { correct: false, timedOut: false, rt: 500, switched: false }, to = { correct: false, timedOut: true, rt: null, switched: true };
  assert.strictEqual(H.calcScore([ok(400, null)], 1), 50);
  assert.strictEqual(H.calcScore([ok(3000, false)], 1), 30);
  assert.strictEqual(H.calcScore([bad, to], 2), 0);
  assert.strictEqual(H.switchCost([ok(800, true), ok(600, true), ok(500, false), bad]), 200);
  assert.strictEqual(H.switchCost([ok(800, true)]), null);
  const fast = Array(24).fill(ok(900, false));
  assert.strictEqual(h.MF.Difficulty.next(1, { accuracy: 1 }, H.difficultyOptions(fast, 1)), 2);
  assert.strictEqual(h.MF.Difficulty.next(1, { accuracy: 1 }, H.difficultyOptions(Array(24).fill(ok(2500, false)), 1)), 1, 'slow -> no level up');
  const many = [...Array(20).fill(ok(900, false)), to, to, to, to];
  assert.strictEqual(h.MF.Difficulty.next(3, { accuracy: H.calcAccuracy(many) }, H.difficultyOptions(many, 3)), 2, '4 timeouts -> down');
  h.close();
});

// ---------- jsdom flows ----------
const cue = h => h.$('[data-s="cue"]').dataset.rule;
const cardOf = h => { const c = h.$('.qs-card'); return c && { color: c.dataset.color, shape: c.dataset.shape }; };
async function waitCard(h, t) {
  await h.waitFor(() => h.$('[data-s="t"]')?.textContent === `${t}/24` && h.$('.qs-card') && !h.$('.qs-btn').disabled, 5000, 'card ' + t);
}

test('quick-switch: full game (correct / wrong / timeout / keyboard / double answer), XP/history/profile', async () => {
  const h = loadApp({ scale: 0.1, storage: { xp: 300 } });
  assert.ok(h.$('.game-card[data-id="quick-switch"]:not(.locked)'), 'unlocked at 300 XP');
  h.openGame('quick-switch');
  h.startGame('qs');
  for (let t = 1; t <= 24; t++) {
    await waitCard(h, t);
    const side = key(cardOf(h), cue(h));
    if (t === 4) { await h.waitFor(() => /Too slow/.test(h.$('.qs-status').textContent), 3000, 'timeout'); continue; }
    const pressed = t === 7 ? (side === 'left' ? 'right' : 'left') : side;
    if (t % 5 === 0) h.key(pressed === 'left' ? 'ArrowLeft' : 'j');
    else h.click(h.$(`.qs-btn[data-side="${pressed}"]`));
    h.key(pressed === 'left' ? 'f' : 'ArrowRight');   // second answer to the same card: ignored
  }
  await h.waitFor(() => h.$('.mm-result'), 4000, 'result');
  const r = h.history()[0];
  assert.strictEqual(r.gameId, 'quick-switch');
  assert.deepStrictEqual([r.details.correctAnswers, r.details.wrongAnswers, r.details.timeouts], [22, 1, 1]);
  assert.strictEqual(r.details.trialResults.length, 24);
  assert.strictEqual(r.accuracy, 22 / 24);
  assert.strictEqual(r.details.switchTrials, Math.round(23 * 0.2));
  assert.ok(typeof r.details.switchCost === 'number' || r.details.switchCost === null);
  assert.strictEqual(h.store('xp'), 300 + r.xp);
  assert.strictEqual(typeof h.store('categoryScores').speed, 'number');
  assert.strictEqual(h.store('progress')['quick-switch'].difficulty, 2, '92% fast -> up');
  assert.strictEqual(h.liveTimers(), 0);
  h.click(h.$('[data-qs="start"]'));
  assert.strictEqual(h.$('.mm-chips b').textContent, '2');
  h.close();
});

test('quick-switch: answers before the card are ignored; exit/nav cleanup incl. keydown; re-entry; SFX', async () => {
  const h = loadApp({ scale: 0.1, storage: { xp: 300 }, filesAvailable: true });
  h.openGame('quick-switch'); h.startGame('qs');
  await h.waitFor(() => h.$('[data-s="cue"]').dataset.rule && !h.$('.qs-card'), 3000, 'cue before card');
  h.key('ArrowLeft'); h.key('ArrowRight');           // during the cue lead: ignored
  await waitCard(h, 1);
  assert.strictEqual(h.$('[data-s="correct"]').textContent, '0');
  h.click(h.$(`.qs-btn[data-side="${key(cardOf(h), cue(h))}"]`));
  assert.ok(h.sfx().includes('game-start') && h.sfx().includes('correct'));
  h.click(h.$('[data-qs="exit"]'));
  assert.strictEqual(h.liveTimers(), 0, 'exit during feedback');
  h.key('ArrowLeft');
  h.openGame('quick-switch'); h.startGame('qs');
  await waitCard(h, 1);
  h.click(h.$('#nav [data-view="settings"]'));
  assert.strictEqual(h.liveTimers(), 0, 'nav while a card waits for an answer');
  await h.sleep(500);
  assert.strictEqual(h.history().length, 0);
  h.click(h.$('.logo'));
  h.openGame('quick-switch');
  assert.ok(h.$('[data-qs="start"]') && !h.$('.qs-stage'), 're-entry shows intro');
  h.MF.Audio.setSetting('soundEffects', false);
  h.audio.length = 0;
  h.startGame('qs');
  await waitCard(h, 1);
  h.key('ArrowLeft');
  assert.deepStrictEqual([...h.sfx()], []);
  h.close();
});
