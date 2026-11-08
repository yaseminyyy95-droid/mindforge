'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, property } = require('../lib/harness');

test('color-filter: trial plans, stimuli match the go/no-go plan (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['color-filter'].helpers;
  const checkPlan = p => {
    assert.strictEqual(p.length, H.TRIALS);
    assert.strictEqual(p.filter(Boolean).length, H.GO_TRIALS);
    assert.ok(H.maxRun(p, true) <= H.MAX_GO_RUN, 'go run too long: ' + p.map(Number).join(''));
  };
  property('planTrials', 2000, () => checkPlan(H.planTrials()));
  const rnd = h.w.Math.random;
  h.w.Math.random = () => 0;                      // degenerate RNG forces the constructive fallback
  checkPlan(H.planTrials());
  h.w.Math.random = rnd;

  for (let level = 1; level <= 5; level++) {
    const cfg = H.LEVELS[level];
    let lookalike = 0, colorNoGo = 0;
    property(`stimuli level ${level}`, 3000, i => {
      const target = H.chooseTarget(cfg), go = i % 2 === 0;
      assert.strictEqual(target.shape === null, cfg.rule === 'color');
      const s = H.makeStimulus(target, go, cfg);
      assert.ok(s.color in H.COLORS && H.SHAPES.includes(s.shape));
      // independent rule check
      const matches = s.color === target.color && (target.shape === null || s.shape === target.shape);
      assert.strictEqual(matches, go, `stimulus ${JSON.stringify(s)} vs target ${JSON.stringify(target)} (go=${go})`);
      if (cfg.word) assert.ok(s.word && s.word !== s.color.toUpperCase() && s.word.toLowerCase() in H.COLORS, 'Stroop word must name another colour');
      else assert.strictEqual(s.word, null);
      if (!go && s.color !== target.color) { colorNoGo++; if (H.SIMILAR[target.color].includes(s.color)) lookalike++; }
    });
    if (cfg.similar) assert.ok(lookalike / colorNoGo > 0.5, `level ${level}: only ${lookalike}/${colorNoGo} look-alike distractors`);
  }
  h.close();
});

test('color-filter: outcomes / score / accuracy / adaptation (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['color-filter'].helpers;
  const hit = rt => ({ go: true, responded: true, rt }), miss = { go: true, responded: false, rt: null };
  const fa = { go: false, responded: true, rt: 300 }, cr = { go: false, responded: false, rt: null };
  assert.deepStrictEqual([hit(300), miss, fa, cr].map(H.outcome), ['hit', 'miss', 'falseAlarm', 'correctRejection']);
  assert.strictEqual(H.calcAccuracy([hit(300), miss, fa, cr]), 0.5);
  assert.strictEqual(H.calcScore([hit(250), cr], 1), 50 + 20);        // full speed bonus at FAST_MS
  assert.strictEqual(H.calcScore([hit(1500)], 1), 30);                 // no bonus at the end of the 1500 ms window
  assert.strictEqual(H.calcScore([fa, miss], 3), 0);                   // floored
  const perfect = [...Array(12).fill(hit(400)), ...Array(8).fill(cr)];
  assert.strictEqual(h.MF.Difficulty.next(1, { accuracy: 1 }, H.difficultyOptions(perfect)), 2);
  const twoFa = [...Array(12).fill(hit(400)), fa, fa, ...Array(6).fill(cr)];
  assert.strictEqual(h.MF.Difficulty.next(1, { accuracy: H.calcAccuracy(twoFa) }, H.difficultyOptions(twoFa)), 1, '2 false alarms block level up');
  const poor = [...Array(6).fill(miss), ...Array(6).fill(hit(400)), ...Array(8).fill(fa)];
  assert.strictEqual(h.MF.Difficulty.next(3, { accuracy: H.calcAccuracy(poor) }, H.difficultyOptions(poor)), 2);
  h.close();
});

// ---------- jsdom flows: go/no-go decided from the rule text and the shape's data attributes ----------
function ruleOf(h) {
  const m = /Tap only (\w+)(?: (\w+)S)?/.exec(h.$('.cf-rule').textContent);
  return { color: m[1].toLowerCase(), shape: m[2] ? m[2].toLowerCase() : null };
}
const stimEl = h => h.$('.cf-stage .cf-shape');
const isGoDom = (h, rule) => { const s = stimEl(h).dataset; return s.color === rule.color && (!rule.shape || s.shape === rule.shape); };
async function waitStim(h, t) {
  await h.waitFor(() => h.$('[data-s="t"]')?.textContent === `${t}/20` && stimEl(h) && !h.$('.cf-stage').dataset.tone, 5000, 'stimulus ' + t);
}
async function play(h, { faOn = [], missOn = [], keyOn = [] } = {}) {
  const rule = ruleOf(h), log = [];
  let goSeen = 0, nogoSeen = 0;
  for (let t = 1; t <= 20; t++) {
    await waitStim(h, t);
    const go = isGoDom(h, rule);
    go ? goSeen++ : nogoSeen++;
    const respond = go ? !missOn.includes(goSeen) : faOn.includes(nogoSeen);
    log.push({ go, respond });
    if (respond) keyOn.includes(t) ? h.key(' ') : h.pointer(h.$('.cf-stage'));
    if (respond) h.pointer(h.$('.cf-stage'));      // a second press on the same stimulus must be ignored
    await h.waitFor(() => h.$('.cf-stage').dataset.tone, 5000, 'feedback ' + t);
  }
  await h.waitFor(() => h.$('.mm-result'), 5000, 'result');
  return log;
}

test('color-filter: full game (hits / miss / false alarm / keyboard / double press), XP/history/profile', async () => {
  const h = loadApp({ scale: 0.1, storage: { xp: 250 } });
  assert.ok(h.$('.game-card[data-id="color-filter"]:not(.locked)'), 'unlocked at 250 XP');
  h.openGame('color-filter');
  h.startGame('cf');
  h.pointer(h.$('.cf-stage'));                       // press before the first stimulus: ignored
  const log = await play(h, { faOn: [2], missOn: [5], keyOn: [1, 2, 3] });
  assert.strictEqual(log.filter(l => l.go).length, 12, 'DOM shows 12 go stimuli');
  const r = h.history()[0];
  assert.strictEqual(r.gameId, 'color-filter');
  assert.deepStrictEqual([r.details.hits, r.details.misses, r.details.falseAlarms, r.details.correctRejections], [11, 1, 1, 7]);
  assert.strictEqual(r.accuracy, 18 / 20);
  assert.ok(r.details.averageHitTime >= 0 && r.details.averageHitTime < 1500);
  assert.strictEqual(h.store('xp'), 250 + r.xp);
  assert.strictEqual(typeof h.store('categoryScores').attention, 'number');
  assert.strictEqual(h.store('progress')['color-filter'].difficulty, 2, 'accuracy 0.9 with 1 false alarm -> up');
  assert.strictEqual(h.liveTimers(), 0);
  h.click(h.$('[data-cf="start"]'));
  assert.strictEqual(h.$('.mm-chips b').textContent, '2');
  h.close();
});

test('color-filter: exit/nav cleanup incl. keydown; re-entry; SFX on/off', async () => {
  const h = loadApp({ scale: 0.1, storage: { xp: 250 }, filesAvailable: true });
  h.openGame('color-filter'); h.startGame('cf');
  await waitStim(h, 1);
  const go = isGoDom(h, ruleOf(h));
  if (go) h.pointer(h.$('.cf-stage'));
  await h.waitFor(() => h.$('.cf-stage').dataset.tone, 3000, 'feedback');
  assert.ok(h.sfx().includes('game-start') && (go ? h.sfx().includes('correct') : true));
  h.click(h.$('[data-cf="exit"]'));
  assert.strictEqual(h.liveTimers(), 0, 'exit during feedback');
  h.key(' ');                                         // removed listener: no effect, no error
  h.openGame('color-filter'); h.startGame('cf');
  await waitStim(h, 1);
  h.click(h.$('#nav [data-view="history"]'));
  assert.strictEqual(h.liveTimers(), 0, 'nav during stimulus');
  await h.sleep(400);
  assert.strictEqual(h.history().length, 0);
  h.click(h.$('.logo'));
  h.openGame('color-filter');
  assert.ok(h.$('[data-cf="start"]') && !h.$('.cf-stage'), 're-entry shows intro');
  h.MF.Audio.setSetting('soundEffects', false);
  h.audio.length = 0;
  h.startGame('cf');
  await waitStim(h, 1);
  h.pointer(h.$('.cf-stage'));
  await h.waitFor(() => h.$('.cf-stage').dataset.tone, 3000, 'feedback');
  assert.deepStrictEqual([...h.sfx()], []);
  h.close();
});
