'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, property } = require('../lib/harness');
const { lgSolve } = require('../lib/solvers');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('logic-grid: every puzzle has exactly one solution and minimal clues (independent text solver)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['logic-grid'].helpers;
  const N = { 1: 300, 2: 300, 3: 300, 4: 150, 5: 150 };
  for (let level = 1; level <= 5; level++) {
    const cfg = H.LEVELS[level];
    let maxClues = 0;
    property(`level ${level}`, N[level], () => {
      const p = H.generatePuzzle(level);
      assert.strictEqual(p.n, cfg.n);
      p.clues.forEach(c => assert.ok(cfg.types.includes(c.t), `clue type ${c.t} not allowed on level ${level} (safety net used)`));
      const texts = p.clues.map(c => c.text);
      const sols = lgSolve(p.n, p.attrs, texts);
      assert.strictEqual(sols.length, 1, 'solution count ' + sols.length);
      assert.ok(same(sols[0], p.solution), 'solver disagrees with stored solution');
      texts.forEach((_, i) => assert.ok(lgSolve(p.n, p.attrs, texts.filter((__, j) => j !== i)).length > 1, 'redundant clue: ' + texts[i]));
      maxClues = Math.max(maxClues, p.clues.length);
    });
    assert.ok(maxClues <= 14, `level ${level}: up to ${maxClues} clues`);
  }
  assert.throws(() => H.generatePuzzle(0));
  h.close();
});

test('logic-grid: grading / score / accuracy / adaptation (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['logic-grid'].helpers;
  const p = { n: 3, attrs: ['color'], solution: { color: [2, 0, 1] } };
  assert.deepStrictEqual({ ...H.gradeAnswer(p, { color: [2, 0, 1] }) }, { correct: 3, total: 3 });
  assert.deepStrictEqual({ ...H.gradeAnswer(p, { color: [2, null, 0] }) }, { correct: 1, total: 3 });
  const solved = t => ({ correctCells: 4, totalCells: 4, solved: true, timedOut: false, solveTime: t });
  const half = { correctCells: 2, totalCells: 4, solved: false, timedOut: false, solveTime: 30 };
  const late = { correctCells: 0, totalCells: 4, solved: false, timedOut: true, solveTime: null };
  // level 1 (60 s): 4 cells × 10 + 50 + 50 (fast) = 140 per puzzle
  assert.strictEqual(H.calcScore([solved(5), solved(5), solved(5)], 1), 420);
  assert.strictEqual(H.calcScore([solved(5), half, late], 1), Math.round(140 + 20 + 0));
  assert.strictEqual(H.calcAccuracy([solved(5), half, late]), 0.5);
  assert.strictEqual(H.difficultyOptions([solved(5), solved(9), solved(20)]).upAt, 0.9);
  assert.strictEqual(H.difficultyOptions([solved(5), half, solved(20)]).upAt, 2);
  assert.strictEqual(H.difficultyOptions([late, late, solved(3)]).downAt, 2);
  assert.strictEqual(H.permutations(4).length, 24);
  assert.strictEqual(H.allAssignments(4, ['color', 'pet']).length, 576);
  h.close();
});

// ---------- jsdom flows ----------
function domPuzzle(h) {
  const tables = h.$$('.lg-table');
  const n = tables[0].querySelectorAll('thead th').length - 1;
  const attrs = tables.length === 2 ? ['color', 'pet'] : ['color'];
  return { n, attrs, clues: h.$$('.lg-clues li').map(li => li.textContent) };
}
function fill(h, sol) {
  Object.entries(sol).forEach(([a, row]) => row.forEach((item, p) => h.click(h.$(`.lg-cell[data-a="${a}"][data-v="${item}"][data-p="${p}"]`))));
}
async function waitPuzzle(h, k) {
  await h.waitFor(() => h.$('[data-s="p"]')?.textContent === `${k}/3` && h.$('[data-s="check"]') && !h.$('[data-s="check"]').hidden, 4000, 'puzzle ' + k);
}
function solveDom(h) { const d = domPuzzle(h); const s = lgSolve(d.n, d.attrs, d.clues); assert.strictEqual(s.length, 1); return s[0]; }

test('logic-grid: full game (solved / wrong / timeout), toggling, double check, XP/history/profile', async () => {
  const h = loadApp({ scale: 0.02, storage: { xp: 250 } });
  assert.ok(h.$('.game-card[data-id="logic-grid"]:not(.locked)'), 'unlocked at 250 XP');
  h.openGame('logic-grid');
  h.startGame('lg');
  await waitPuzzle(h, 1);
  // cell toggling keeps a permutation: same item moved, same cell toggled off
  h.click(h.$('.lg-cell[data-a="color"][data-v="0"][data-p="0"]'));
  h.click(h.$('.lg-cell[data-a="color"][data-v="0"][data-p="1"]'));
  assert.strictEqual(h.$$('.lg-cell.on').length, 1);
  assert.ok(h.$('.lg-cell[data-v="0"][data-p="1"]').classList.contains('on'));
  h.click(h.$('.lg-cell[data-a="color"][data-v="0"][data-p="1"]'));
  assert.strictEqual(h.$$('.lg-cell.on').length, 0);
  // puzzle 1: solved, double click on Check
  fill(h, solveDom(h));
  h.click(h.$('[data-lg="check"]')); h.click(h.$('[data-lg="check"]'));
  assert.match(h.$('.lg-status').textContent, /Solved/);
  h.click(h.$('[data-lg="next"]'));
  // puzzle 2: wrong (first two houses swapped), auto-advance
  await waitPuzzle(h, 2);
  const s = solveDom(h);
  const wrong = { ...s, color: [s.color[1], s.color[0], ...s.color.slice(2)] };
  fill(h, wrong);
  h.click(h.$('[data-lg="check"]'));
  assert.ok(h.$$('.lg-cell.bad').length === 2 && h.$$('.lg-cell.reveal').length === 2);
  // puzzle 3: timeout with nothing filled
  await waitPuzzle(h, 3);
  await h.waitFor(() => /TIME UP/.test(h.$('.lg-status').textContent), 5000, 'timeout');
  h.click(h.$('[data-lg="next"]'));
  await h.waitFor(() => h.$('.mm-result'), 3000, 'result');
  const r = h.history()[0];
  assert.strictEqual(r.gameId, 'logic-grid');
  assert.strictEqual(r.details.totalPuzzles, 3, 'double Check scored once');
  assert.deepStrictEqual([r.details.puzzlesSolved, r.details.timeouts], [1, 1]);
  const n = r.details.puzzleResults[0].totalCells;
  assert.strictEqual(r.details.correctCells, n + (n - 2) + 0);
  assert.strictEqual(r.accuracy, r.details.correctCells / r.details.totalCells);
  assert.strictEqual(h.store('xp'), 250 + r.xp);
  assert.strictEqual(typeof h.store('categoryScores').logic, 'number');
  assert.strictEqual(h.store('progress')['logic-grid'].difficulty, 1, 'no level change at ~58% with a timeout');
  assert.strictEqual(h.liveTimers(), 0);
  h.close();
});

test('logic-grid: adaptive up + Play Again level; exit/nav cleanup; re-entry; SFX on/off', async () => {
  const h = loadApp({ scale: 0.05, storage: { xp: 250 }, filesAvailable: true });
  h.openGame('logic-grid');
  h.startGame('lg');
  for (let k = 1; k <= 3; k++) {
    await waitPuzzle(h, k);
    fill(h, solveDom(h));
    h.click(h.$('[data-lg="check"]'));
    h.click(h.$('[data-lg="next"]'));
  }
  await h.waitFor(() => h.$('.mm-result'), 3000, 'result');
  assert.strictEqual(h.store('progress')['logic-grid'].difficulty, 2);
  const s1 = h.sfx();
  assert.ok(s1.includes('game-start') && s1.includes('click') && s1.includes('correct') && s1.includes('game-complete'), s1.join());
  h.click(h.$('[data-lg="start"]'));
  assert.strictEqual(h.$('.mm-chips b').textContent, '2');
  await waitPuzzle(h, 1);
  assert.strictEqual(h.$$('.lg-table thead th').length - 1, 4, 'level 2 has 4 houses');
  h.click(h.$('[data-lg="exit"]'));
  assert.strictEqual(h.liveTimers(), 0, 'exit during puzzle');
  h.openGame('logic-grid'); h.startGame('lg');
  await waitPuzzle(h, 1);
  h.click(h.$('[data-lg="check"]'));                 // feedback phase
  h.click(h.$('#nav [data-view="history"]'));
  assert.strictEqual(h.liveTimers(), 0, 'nav during feedback');
  const len = h.history().length;
  await h.sleep(400);
  assert.strictEqual(h.history().length, len);
  h.click(h.$('.logo'));
  h.openGame('logic-grid');
  assert.ok(h.$('[data-lg="start"]') && !h.$('.lg-table'), 're-entry shows intro');
  h.MF.Audio.setSetting('soundEffects', false);
  h.audio.length = 0;
  h.startGame('lg');
  await waitPuzzle(h, 1);
  h.click(h.$('.lg-cell'));
  h.click(h.$('[data-lg="check"]'));
  assert.deepStrictEqual([...h.sfx()], []);
  h.close();
});
