'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, property } = require('../lib/harness');
const { pfRoute } = require('../lib/solvers');

const kindsOf = m => m.walls.map((w, i) => (w ? 'wall' : i === m.goal ? 'goal' : i === m.checkpoint ? 'check' : i === m.start ? 'start' : 'open'));

test('path-finder: mazes are solvable, long enough, and "optimal" matches an independent BFS (1000 per level)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['path-finder'].helpers;
  for (let level = 1; level <= 5; level++) {
    const cfg = H.LEVELS[level];
    property(`level ${level}`, 1000, () => {
      const m = H.generateMaze(level);
      assert.strictEqual(m.walls.length, cfg.rows * cfg.cols);
      assert.ok(!m.walls[m.start] && !m.walls[m.goal], 'start/goal on a wall');
      assert.strictEqual(m.checkpoint !== null, cfg.checkpoint);
      if (m.checkpoint !== null) assert.ok(!m.walls[m.checkpoint] && new Set([m.start, m.goal, m.checkpoint]).size === 3);
      const route = pfRoute(kindsOf(m), m.cols, m.start);
      assert.ok(route, 'unsolvable maze');
      assert.strictEqual(route.length, m.optimal, 'stored optimum differs from independent BFS');
      assert.ok(m.optimal >= cfg.minMoves, `optimal ${m.optimal} < ${cfg.minMoves}`);
    });
    const f = H.fallbackMaze(cfg);
    assert.strictEqual(pfRoute(kindsOf(f), f.cols, f.start).length, f.optimal, 'fallback optimum');
    assert.ok(f.optimal >= cfg.minMoves, `level ${level} fallback optimum ${f.optimal} too short`);
  }
  assert.throws(() => H.generateMaze(6));
  h.close();
});

test('path-finder: efficiency / score / adaptation (pure)', () => {
  const h = loadApp();
  const H = h.MF.GameModules['path-finder'].helpers;
  const done = (moves, optimal, time = 2) => ({ reached: true, timedOut: false, moves, optimal, time });
  const late = { reached: false, timedOut: true, moves: 3, optimal: 8, time: null };
  assert.strictEqual(H.efficiency(done(10, 8)), 0.8);
  assert.strictEqual(H.efficiency(late), 0);
  assert.strictEqual(H.calcAccuracy([done(8, 8), done(10, 8), late]), (1 + 0.8 + 0) / 3);
  assert.strictEqual(H.calcScore([done(8, 8, 1)], 1), 100);          // 60 + full speed bonus
  assert.strictEqual(H.calcScore([done(16, 8, 1)], 1), 30);          // 60 × 0.5, no bonus
  assert.strictEqual(H.calcScore([late], 1), 0);                     // floored
  assert.strictEqual(H.difficultyOptions([done(8, 8)]).upAt, 0.9);
  assert.strictEqual(H.difficultyOptions([done(8, 8), late]).upAt, 2);
  assert.strictEqual(H.difficultyOptions([late, late]).downAt, 2);
  h.close();
});

// ---------- jsdom flows ----------
const domKinds = h => h.$$('.pf-cell').map(c => c.dataset.kind);
const here = h => Number(h.$('.pf-cell.here').dataset.i);
const cols = h => Number(h.$('.pf-grid').style.getPropertyValue('--pf-cols'));
async function waitMaze(h, k) {
  await h.waitFor(() => h.$('[data-s="m"]')?.textContent === `${k}/5` && h.$('[data-s="moves"]').textContent === '0' && !h.$('.pf-grid.done'), 4000, 'maze ' + k);
}
function walk(h, route) { route.forEach(i => h.click(h.$(`.pf-cell[data-i="${i}"]`))); }
// one wasted step: move to an open neighbour and back (2 extra moves)
function detour(h) {
  const k = domKinds(h), c = cols(h), p = here(h);
  const nb = [p - c, p + c, p % c ? p - 1 : -1, (p + 1) % c ? p + 1 : -1].find(j => j >= 0 && j < k.length && (k[j] === 'open' || k[j] === 'start'));
  h.click(h.$(`.pf-cell[data-i="${nb}"]`)); h.click(h.$(`.pf-cell[data-i="${p}"]`));
}

test('path-finder: full game (optimal / detour / timeout / keyboard), illegal moves ignored, XP/history/profile', async () => {
  const h = loadApp({ scale: 0.03, storage: { xp: 600 } });
  assert.ok(h.$('.game-card[data-id="path-finder"]:not(.locked)'), 'unlocked at 600 XP');
  h.openGame('path-finder'); h.startGame('pf');
  // maze 1: illegal clicks (wall / far cell / same cell) do not count, then optimal route
  await waitMaze(h, 1);
  const k = domKinds(h), wall = k.indexOf('wall'), far = k.findIndex((x, i) => x !== 'wall' && i !== here(h) && Math.abs(i - here(h)) > cols(h) + 1);
  if (wall >= 0) h.click(h.$(`.pf-cell[data-i="${wall}"]`));
  if (far >= 0) h.click(h.$(`.pf-cell[data-i="${far}"]`));
  h.click(h.$(`.pf-cell[data-i="${here(h)}"]`));
  assert.strictEqual(h.$('[data-s="moves"]').textContent, '0', 'illegal moves were counted');
  walk(h, pfRoute(domKinds(h), cols(h), here(h)));
  assert.match(h.$('.pf-status').textContent, /Shortest route/);
  h.click(h.$('.pf-cell'));                          // clicks during feedback are ignored
  // maze 2: detour (+2 moves)
  await waitMaze(h, 2);
  detour(h);
  walk(h, pfRoute(domKinds(h), cols(h), here(h)));
  assert.match(h.$('.pf-status').textContent, /2 extra moves/);
  // maze 3: timeout
  await waitMaze(h, 3);
  await h.waitFor(() => /TIME UP/.test(h.$('.pf-status').textContent), 3000, 'timeout');
  // maze 4: keyboard
  await waitMaze(h, 4);
  for (const step of pfRoute(domKinds(h), cols(h), here(h))) {
    const p = here(h), c = cols(h);
    h.key(step === p - c ? 'ArrowUp' : step === p + c ? 'ArrowDown' : step === p - 1 ? 'ArrowLeft' : 'ArrowRight');
  }
  assert.match(h.$('.pf-status').textContent, /Shortest route/);
  // maze 5: optimal
  await waitMaze(h, 5);
  walk(h, pfRoute(domKinds(h), cols(h), here(h)));
  await h.waitFor(() => h.$('.mm-result'), 3000, 'result');
  const r = h.history()[0];
  assert.strictEqual(r.gameId, 'path-finder');
  assert.deepStrictEqual([r.details.mazesCompleted, r.details.optimalRoutes, r.details.timeouts, r.details.mazeResults.length], [4, 3, 1, 5]);
  const m2 = r.details.mazeResults[1];
  assert.strictEqual(m2.moves, m2.optimal + 2);
  assert.ok(Math.abs(r.accuracy - (3 + m2.optimal / m2.moves) / 5) < 1e-9);
  assert.strictEqual(h.store('xp'), 600 + r.xp);
  assert.strictEqual(typeof h.store('categoryScores').logic, 'number');
  assert.strictEqual(h.store('progress')['path-finder'].difficulty, 1, 'a timeout blocks level up');
  assert.strictEqual(h.liveTimers(), 0);
  h.close();
});

test('path-finder: adaptive up + Play Again; exit/nav cleanup incl. keydown listener; re-entry; SFX', async () => {
  const h = loadApp({ scale: 0.03, storage: { xp: 600 }, filesAvailable: true });
  h.openGame('path-finder'); h.startGame('pf');
  for (let k = 1; k <= 5; k++) { await waitMaze(h, k); walk(h, pfRoute(domKinds(h), cols(h), here(h))); }
  await h.waitFor(() => h.$('.mm-result'), 3000, 'result');
  assert.strictEqual(h.store('progress')['path-finder'].difficulty, 2);
  const s = h.sfx();
  assert.ok(['game-start', 'click', 'correct', 'game-complete'].every(x => s.includes(x)), s.join());
  h.click(h.$('[data-pf="start"]'));
  assert.strictEqual(h.$('.mm-chips b').textContent, '2');
  await waitMaze(h, 1);
  assert.strictEqual(h.$$('.pf-cell').length, 36, 'level 2 is 6×6');
  h.click(h.$('[data-pf="exit"]'));
  assert.strictEqual(h.liveTimers(), 0, 'exit during maze');
  h.key('ArrowDown'); h.key('ArrowRight');           // removed keydown listener must not throw or act
  h.openGame('path-finder'); h.startGame('pf');
  await waitMaze(h, 1);
  walk(h, pfRoute(domKinds(h), cols(h), here(h)));   // -> feedback phase
  h.click(h.$('#nav [data-view="history"]'));
  assert.strictEqual(h.liveTimers(), 0, 'nav during feedback');
  const len = h.history().length;
  await h.sleep(1600);                                // > 45 virtual s
  assert.strictEqual(h.history().length, len);
  h.click(h.$('.logo'));
  h.openGame('path-finder');
  assert.ok(h.$('[data-pf="start"]') && !h.$('.pf-cell'), 're-entry shows intro');
  h.MF.Audio.setSetting('soundEffects', false);
  h.audio.length = 0;
  h.startGame('pf');
  await waitMaze(h, 1);
  walk(h, pfRoute(domKinds(h), cols(h), here(h)).slice(0, 2));
  assert.deepStrictEqual([...h.sfx()], []);
  h.close();
});
