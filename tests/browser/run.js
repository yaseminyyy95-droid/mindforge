// Real-browser smoke/flow tests for MindForge (development only).
// Runs the app from file:// in a real Chromium-based browser (system Chrome by default) via playwright-core.
// Usage: cd tests && npm install && npm run browser      (CHROME=<path> to use another browser binary)
// Output: tests/browser/out/report.json + screenshots (git-ignored).
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'out');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const INDEX = pathToFileURL(path.join(ROOT, 'index.html')).href;
// ONLY=A,B,... runs a subset (A desktop, B exit, C settings, D audio, E mobile, F new games). Default: all.
const want = s => !process.env.ONLY || process.env.ONLY.split(',').includes(s);
const solvers = require('../lib/solvers');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------- reporting ----------
const checks = [];
let scenario = '';
function check(name, ok, detail) {
  checks.push({ scenario, name, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
}
const note = (name, detail) => { checks.push({ scenario, name, ok: null, detail }); console.log(`INFO  [${scenario}] ${name}  ${JSON.stringify(detail)}`); };

// ---------- page instrumentation (main world) ----------
// Tracks live timeouts/intervals so we can assert that leaving a game leaves nothing scheduled.
const TIMER_PROBE = `(() => {
  const live = new Set();
  const st = window.setTimeout, ct = window.clearTimeout, si = window.setInterval, ci = window.clearInterval;
  window.setTimeout = function (fn, d, ...a) {
    const id = st.call(window, function () { live.delete(id); if (typeof fn === 'function') fn.apply(this, a); }, d);
    live.add(id); return id;
  };
  window.clearTimeout = id => { live.delete(id); ct.call(window, id); };
  window.setInterval = function (fn, d, ...a) { const id = si.call(window, fn, d, ...a); live.add(id); return id; };
  window.clearInterval = id => { live.delete(id); ci.call(window, id); };
  window.__liveTimers = () => live.size;
})();`;
// Fake Audio that records calls (used only with the FILES_AVAILABLE=true copy).
const AUDIO_STUB = `(() => {
  window.__audio = [];
  window.Audio = class {
    constructor(src) { this.src = src || ''; this.volume = 1; this.loop = false; this.paused = true; window.__audio.push({ ev: 'new', src: this.src }); }
    play() { window.__audio.push({ ev: 'play', src: this.src, loop: this.loop }); this.paused = false; return Promise.resolve(); }
    pause() { window.__audio.push({ ev: 'pause', src: this.src }); this.paused = true; }
    removeAttribute(n) { if (n === 'src') this.src = ''; }
    load() { window.__audio.push({ ev: 'load' }); }
  };
})();`;

async function newPage(browser, opts = {}, { audioStub = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  await ctx.addInitScript(TIMER_PROBE);
  if (audioStub) await ctx.addInitScript(AUDIO_STUB);
  const page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', e => page.__errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') page.__errors.push(`console.${m.type()}: ${m.text()}`); });
  page.on('dialog', d => d.accept());
  return { ctx, page };
}

// ---------- small helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const storage = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem('mindforge:' + k)), key);
const setStorage = (page, key, v) => page.evaluate(([k, val]) => localStorage.setItem('mindforge:' + k, JSON.stringify(val)), [key, v]);
const text = (page, sel) => page.locator(sel).first().innerText();
const liveTimers = page => page.evaluate(() => window.__liveTimers());
// Test-only arithmetic on the displayed expressions (the app itself never evaluates strings).
const evalExpr = s => Function('"use strict";return (' + s.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-') + ')')();
async function shot(page, name, fullPage = true) { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage }); }
async function gotoFresh(page, url = INDEX) {
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}
async function openCategory(page, name) { await page.locator('.cat-card', { hasText: name }).click(); await page.locator('h2', { hasText: name }).waitFor(); }
async function openGameCard(page, name) { await page.locator('.game-card', { has: page.locator('h3', { hasText: new RegExp('^' + name + '$') }) }).first().click(); }
async function startFromIntro(page) {
  await page.locator('.mm-panel .btn', { hasText: 'Start Game' }).click();
}
async function waitResult(page, timeout = 30000) { await page.locator('.mm-result').waitFor({ timeout }); }

// ---------- game players (real time, real clicks) ----------
async function playMemoryMatch(page, { mismatchFirst = true } = {}) {
  await page.locator('.mm-card').first().waitFor();
  const cards = await page.$$eval('.mm-card', els => els.map(e => ({ i: e.dataset.i, s: e.querySelector('.mm-front').textContent })));
  const bySym = {};
  cards.forEach(c => (bySym[c.s] = bySym[c.s] || []).push(c.i));
  const pairs = Object.values(bySym);
  if (mismatchFirst && pairs.length > 1) {
    await page.click(`.mm-card[data-i="${pairs[0][0]}"]`);
    await page.click(`.mm-card[data-i="${pairs[1][0]}"]`);
    await sleep(1000); // > MISMATCH_DELAY_MS
  }
  for (const [a, b] of pairs) { await page.click(`.mm-card[data-i="${a}"]`); await page.click(`.mm-card[data-i="${b}"]`); }
  await waitResult(page);
}

async function playReactionRush(page, { falseStartRound = 1, tap = false } = {}) {
  for (let r = 1; r <= 5; r++) {
    await page.waitForFunction(n => document.querySelector('[data-s="round"]')?.textContent === `${n}/5`
      && document.querySelector('.rr-arena')?.dataset.phase === 'wait', r, { timeout: 15000 });
    if (r === falseStartRound) {
      await page.locator('.rr-arena').click({ position: { x: 15, y: 15 } });
    } else {
      const t = page.locator('.rr-target:not([hidden])');
      await t.waitFor({ timeout: 6000 });
      await sleep(150);
      tap ? await t.tap() : await t.click();
    }
  }
  await waitResult(page);
}

async function playTargetFocus(page, { wrongInRound = 1 } = {}) {
  for (let r = 1; r <= 10; r++) {
    await page.waitForFunction(n => document.querySelector('[data-s="round"]')?.textContent === `${n}/10` && document.querySelector('.tf-grid:not(.locked)'), r, { timeout: 15000 });
    const target = await text(page, '[data-s="target"]');
    if (r === wrongInRound) {
      await page.locator('.tf-cell').filter({ hasNotText: target }).first().click();
    }
    const cells = await page.$$eval('.tf-cell', els => els.map(e => e.textContent));
    const idx = cells.indexOf(target);
    await page.click(`.tf-cell[data-i="${idx}"]`);
  }
  await waitResult(page);
}

async function playQuickCalc(page, { wrong = [], timeout = [] } = {}) {
  for (let q = 1; q <= 10; q++) {
    await page.waitForFunction(n => document.querySelector('[data-s="q"]')?.textContent === `${n}/10`
      && document.querySelectorAll('.qc-opt:not(:disabled)').length === 4, q, { timeout: 20000 });
    if (timeout.includes(q)) { await page.locator('.qc-status', { hasText: 'TIME UP' }).waitFor({ timeout: 20000 }); continue; }
    const problem = (await text(page, '[data-s="problem"]')).replace(/\s*=\s*\?\s*$/, '');
    const answer = evalExpr(problem);
    const opts = await page.$$eval('.qc-opt', els => els.map(e => Number(e.textContent)));
    const pick = wrong.includes(q) ? opts.findIndex(v => v !== answer) : opts.indexOf(answer);
    if (!wrong.includes(q) && pick < 0) check('quick-calculate: correct answer among options', false, { problem, answer, opts });
    await page.click(`.qc-opt[data-i="${pick}"]`);
  }
  await waitResult(page);
}

async function playNumberCompare(page, { wrong = [] } = {}) {
  for (let q = 1; q <= 10; q++) {
    await page.waitForFunction(n => document.querySelector('[data-s="q"]')?.textContent === `${n}/10`
      && document.querySelectorAll('.nc-choice:not(:disabled)').length === 3, q, { timeout: 20000 });
    const l = evalExpr(await text(page, '[data-side="left"] .nc-expr')), r = evalExpr(await text(page, '[data-side="right"] .nc-expr'));
    let c = l > r ? 'left' : l < r ? 'right' : 'equal';
    if (wrong.includes(q)) c = c === 'left' ? 'right' : 'left';
    await page.click(`.nc-choice[data-c="${c}"]`);
  }
  await waitResult(page);
}

async function playMissingNumber(page, { useNextOn = q => q % 2 === 1 } = {}) {
  for (let q = 1; q <= 10; q++) {
    await page.waitForFunction(n => document.querySelector('[data-s="q"]')?.textContent === `${n}/10`
      && document.querySelectorAll('.mn-opt:not(:disabled)').length === 4, q, { timeout: 25000 });
    const eq = await text(page, '[data-s="equation"]');
    const [lhs, rhs] = eq.split('=');
    const opts = await page.$$eval('.mn-opt', els => els.map(e => Number(e.textContent)));
    const ok = opts.map((v, i) => ({ v, i })).filter(o => Math.abs(evalExpr(lhs.replace('?', String(o.v))) - Number(rhs)) < 1e-9);
    if (ok.length !== 1) check('missing-number: exactly one option satisfies the equation', false, { eq, opts, ok });
    await page.click(`.mn-opt[data-i="${ok[0].i}"]`);
    if (useNextOn(q)) await page.click('[data-mn="next"]');
  }
  await waitResult(page);
}


async function playPatternShift(page, { wrong = [] } = {}) {
  for (let q = 1; q <= 10; q++) {
    await page.waitForFunction(n => document.querySelector('[data-s="q"]')?.textContent === `${n}/10`
      && document.querySelectorAll('.ps-opt:not(:disabled)').length === 4, q, { timeout: 20000 });
    const shown = await page.$$eval('.ps-seq .ps-tile:not(.ps-next)', els => els.map(e => e.getAttribute('aria-label')));
    const opts = await page.$$eval('.ps-opt .ps-tile', els => els.map(e => e.getAttribute('aria-label')));
    const c = solvers.psCorrectIndex(shown, opts);
    if (c < 0) check('pattern-shift: inferred answer among options', false, { shown, opts });
    await page.click(`.ps-opt[data-i="${wrong.includes(q) ? (c + 1) % 4 : c}"]`);
  }
  await waitResult(page);
}

async function playLogicGrid(page, { wrongPuzzle = 2 } = {}) {
  for (let k = 1; k <= 3; k++) {
    await page.waitForFunction(n => document.querySelector('[data-s="p"]')?.textContent === `${n}/3`
      && !document.querySelector('[data-s="check"]').hidden, k, { timeout: 20000 });
    const d = await page.evaluate(() => ({ n: document.querySelector('.lg-table').querySelectorAll('thead th').length - 1,
      tables: document.querySelectorAll('.lg-table').length, clues: [...document.querySelectorAll('.lg-clues li')].map(li => li.textContent) }));
    const sols = solvers.lgSolve(d.n, d.tables === 2 ? ['color', 'pet'] : ['color'], d.clues);
    if (sols.length !== 1) check('logic-grid: clues have exactly one solution', false, { d, count: sols.length });
    const sol = sols[0];
    if (k === wrongPuzzle) sol.color = [sol.color[1], sol.color[0], ...sol.color.slice(2)];
    for (const [a, row] of Object.entries(sol)) for (let p = 0; p < row.length; p++) await page.click(`.lg-cell[data-a="${a}"][data-v="${row[p]}"][data-p="${p}"]`);
    await page.click('[data-lg="check"]');
    await page.click('[data-lg="next"]');
  }
  await waitResult(page);
}

async function playPathFinder(page, { detourMaze = 2 } = {}) {
  for (let k = 1; k <= 5; k++) {
    await page.waitForFunction(n => document.querySelector('[data-s="m"]')?.textContent === `${n}/5`
      && document.querySelector('[data-s="moves"]').textContent === '0' && !document.querySelector('.pf-grid.done'), k, { timeout: 20000 });
    const d = await page.evaluate(() => ({ kinds: [...document.querySelectorAll('.pf-cell')].map(c => c.dataset.kind),
      cols: Number(document.querySelector('.pf-grid').style.getPropertyValue('--pf-cols')), here: Number(document.querySelector('.pf-cell.here').dataset.i) }));
    const route = solvers.pfRoute(d.kinds, d.cols, d.here);
    if (!route) check('path-finder: maze solvable', false, d);
    if (k === detourMaze) { await page.click(`.pf-cell[data-i="${route[0]}"]`); await page.click(`.pf-cell[data-i="${d.here}"]`); }
    for (const i of route) await page.click(`.pf-cell[data-i="${i}"]`);
  }
  await waitResult(page);
}

async function playSequenceRecall(page, { wrongRound = 3 } = {}) {
  await page.evaluate(() => {
    window.__lit = [];
    new MutationObserver(ms => ms.forEach(m => { const t = m.target;
      if (t.classList && t.classList.contains('sr-pad') && t.classList.contains('lit') && !(m.oldValue || '').includes('lit')) window.__lit.push(Number(t.dataset.p)); }))
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  });
  for (let t = 1; t <= 8; t++) {
    await page.waitForFunction(n => document.querySelector('[data-s="t"]')?.textContent === `${n}/8`
      && document.querySelector('.sr-pad') && !document.querySelector('.sr-pad').disabled, t, { timeout: 30000 });
    const seq = await page.evaluate(() => window.__lit.splice(0));
    const len = Number(await text(page, '[data-s="len"]'));
    if (seq.length !== len) check('sequence-recall: lit pads = shown length', false, { seq, len });
    const pads = await page.locator('.sr-pad').count();
    if (t === wrongRound) await page.click(`.sr-pad[data-p="${(seq[0] + 1) % pads}"]`);
    else for (const i of seq) await page.click(`.sr-pad[data-p="${i}"]`);
  }
  await waitResult(page);
}

async function playColorFilter(page, { faOnNoGo = 2 } = {}) {
  const ruleTxt = await text(page, '.cf-rule');
  const m = /Tap only (\w+)(?: (\w+)S)?/i.exec(ruleTxt), rule = { color: m[1].toLowerCase(), shape: m[2] ? m[2].toLowerCase() : null };
  let nogo = 0;
  for (let t = 1; t <= 20; t++) {
    await page.waitForFunction(n => document.querySelector('[data-s="t"]')?.textContent === `${n}/20`
      && document.querySelector('.cf-stage .cf-shape') && !document.querySelector('.cf-stage').dataset.tone, t, { timeout: 15000 });
    const s = await page.$eval('.cf-stage .cf-shape', e => ({ ...e.dataset }));
    const go = s.color === rule.color && (!rule.shape || s.shape === rule.shape);
    if (!go) nogo++;
    if (go || nogo === faOnNoGo) await page.locator('.cf-stage').click();
    await page.waitForFunction(() => document.querySelector('.cf-stage')?.dataset.tone || document.querySelector('.mm-result'), null, { timeout: 15000 });
  }
  await waitResult(page);
}

async function playQuickSwitch(page, { wrongTrial = 5 } = {}) {
  for (let t = 1; t <= 24; t++) {
    await page.waitForFunction(n => document.querySelector('[data-s="t"]')?.textContent === `${n}/24`
      && document.querySelector('.qs-card') && !document.querySelector('.qs-btn').disabled, t, { timeout: 15000 });
    const s = await page.evaluate(() => ({ rule: document.querySelector('[data-s="cue"]').dataset.rule, ...document.querySelector('.qs-card').dataset }));
    let side = s.rule === 'color' ? (s.color === 'blue' ? 'left' : 'right') : (s.shape === 'circle' ? 'left' : 'right');
    if (t === wrongTrial) side = side === 'left' ? 'right' : 'left';
    if (t % 3 === 0) await page.keyboard.press(side === 'left' ? 'ArrowLeft' : 'ArrowRight');
    else await page.click(`.qs-btn[data-side="${side}"]`);
  }
  await waitResult(page);
}

async function playGridMemory(page, { wrongRound = 2 } = {}) {
  for (let r = 1; r <= 8; r++) {
    await page.waitForFunction(n => document.querySelector('[data-s="r"]')?.textContent === `${n}/8` && document.querySelectorAll('.gm-cell.lit').length, r, { timeout: 15000 });
    const lit = await page.$$eval('.gm-cell.lit', els => els.map(e => Number(e.dataset.i)));
    const total = await page.locator('.gm-cell').count();
    await page.waitForFunction(() => !document.querySelector('.gm-cell').disabled, null, { timeout: 15000 });
    const picks = r === wrongRound ? [...lit.slice(1), [...Array(total).keys()].find(i => !lit.includes(i))] : lit;
    for (const i of picks) await page.click(`.gm-cell[data-i="${i}"]`);
  }
  await waitResult(page);
}

async function playDistractionHunt(page, { mistakeRound = 2 } = {}) {
  const diff = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  for (let r = 1; r <= 10; r++) {
    await page.waitForFunction(n => document.querySelector('[data-s="r"]')?.textContent === `${n}/10`
      && document.querySelector('.dh-cell') && !document.querySelector('.dh-cell').disabled, r, { timeout: 15000 });
    const a = await page.$$eval('.dh-cell', els => els.map(e => Number(e.dataset.a)));
    const far = a.map(x => a.filter(y => diff(x, y) > 20).length), odd = far.indexOf(Math.max(...far));
    if (r === mistakeRound) await page.click(`.dh-cell[data-i="${odd === 0 ? 1 : 0}"]`);
    await page.click(`.dh-cell[data-i="${odd}"]`);
  }
  await waitResult(page);
}

async function playSpeedSequence(page, { wrongBoard = 2 } = {}) {
  for (let b = 1; b <= 3; b++) {
    await page.waitForFunction(n => document.querySelector('[data-s="b"]')?.textContent === `${n}/3`
      && document.querySelector('.ss-cell') && ![...document.querySelectorAll('.ss-cell')].some(c => c.disabled), b, { timeout: 15000 });
    const labels = await page.$$eval('.ss-cell', els => els.map(e => e.dataset.label));
    const nums = labels.filter(l => /^\d+$/.test(l)).map(Number).sort((x, y) => x - y).map(String), lets = labels.filter(l => /^[A-Z]$/.test(l)).sort();
    const order = lets.length ? nums.flatMap((n, i) => (lets[i] ? [n, lets[i]] : [n])) : nums;
    if (b === wrongBoard) await page.click(`.ss-cell[data-label="${order[1]}"]`);
    for (const l of order) await page.click(`.ss-cell[data-label="${l}"]`);
  }
  await waitResult(page);
}

// New games: one full game + leave-mid-game timer check each. Entries are added as games are built.
const NEW_GAMES = [
  { id: 'pattern-shift', name: 'Pattern Shift', cat: 'Logic', prefix: 'ps', play: p => playPatternShift(p, { wrong: [3] }), expectCorrect: 9,
    mid: async p => { await p.locator('.ps-opt').first().waitFor(); } },
  { id: 'logic-grid', name: 'Logic Grid', cat: 'Logic', prefix: 'lg', play: p => playLogicGrid(p), expectCorrect: undefined,
    mid: async p => { await p.locator('.lg-cell').first().waitFor(); await p.locator('.lg-cell').first().click(); } },
  { id: 'path-finder', name: 'Path Finder', cat: 'Logic', prefix: 'pf', play: p => playPathFinder(p), expectCorrect: undefined,
    mid: async p => { await p.locator('.pf-cell.here').waitFor(); await p.keyboard.press('ArrowRight'); } },
  { id: 'sequence-recall', name: 'Sequence Recall', cat: 'Memory', prefix: 'sr', play: p => playSequenceRecall(p), expectCorrect: undefined,
    mid: async p => { await p.locator('.sr-pad.lit').waitFor({ timeout: 5000 }); } },
  { id: 'color-filter', name: 'Color Filter', cat: 'Attention', prefix: 'cf', play: p => playColorFilter(p), expectCorrect: undefined,
    mid: async p => { await p.locator('.cf-stage .cf-shape').waitFor({ timeout: 5000 }); } },
  { id: 'quick-switch', name: 'Quick Switch', cat: 'Speed', prefix: 'qs', play: p => playQuickSwitch(p), expectCorrect: 23,
    mid: async p => { await p.locator('.qs-card').waitFor({ timeout: 5000 }); } },
  { id: 'grid-memory', name: 'Grid Memory', cat: 'Memory', prefix: 'gm', play: p => playGridMemory(p), expectCorrect: undefined,
    mid: async p => { await p.locator('.gm-cell.lit').first().waitFor({ timeout: 5000 }); } },
  { id: 'distraction-hunt', name: 'Distraction Hunt', cat: 'Attention', prefix: 'dh', play: p => playDistractionHunt(p), expectCorrect: undefined,
    mid: async p => { await p.locator('.dh-cell').first().waitFor({ timeout: 5000 }); } },
  { id: 'speed-sequence', name: 'Speed Sequence', cat: 'Speed', prefix: 'ss', play: p => playSpeedSequence(p), expectCorrect: undefined,
    mid: async p => { await p.locator('.ss-cell').first().waitFor({ timeout: 5000 }); } }
];

// ---------- layout probes ----------
async function layoutProbe(page) {
  return page.evaluate(() => {
    const de = document.documentElement, vw = de.clientWidth;
    const scrollerOf = el => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return p; } return null; };
    const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const offenders = [...document.body.querySelectorAll('*')].filter(e => visible(e) && !scrollerOf(e)).filter(e => { const r = e.getBoundingClientRect(); return r.right > vw + 0.5 || r.left < -0.5; })
      .slice(0, 8).map(e => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} [${Math.round(e.getBoundingClientRect().left)}..${Math.round(e.getBoundingClientRect().right)}]`);
    const small = [...document.querySelectorAll('button, a[href], [role="switch"]')].filter(visible).map(e => {
      const r = e.getBoundingClientRect();
      return { label: (e.getAttribute('aria-label') || e.textContent).trim().replace(/\s+/g, ' ').slice(0, 28), w: Math.round(r.width), h: Math.round(r.height) };
    }).filter(t => Math.min(t.w, t.h) < 44);
    return { viewport: vw, scrollWidth: de.scrollWidth, horizontalOverflow: de.scrollWidth > vw, offenders, under44: small, under24: small.filter(t => Math.min(t.w, t.h) < 24) };
  });
}
function summarizeSmall(list) {
  const m = {};
  list.forEach(t => { const k = `${t.label} (${t.w}x${t.h})`; m[k] = (m[k] || 0) + 1; });
  return Object.entries(m).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
}

// =====================================================================
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  note('browser', { executable: CHROME, version: browser.version(), url: INDEX });
  let ctx, page;

  if (want('A')) {
  // ---------------- A. Desktop main flow ----------------
  scenario = 'A desktop flow';
  ({ ctx, page } = await newPage(browser));
  await gotoFresh(page);
  check('dashboard: 5 category cards', (await page.locator('.cat-card').count()) === 5);
  check('dashboard: 15 game cards', (await page.locator('.game-card').count()) === 15);
  check('dashboard: 5 playable at 0 XP', (await page.locator('button.game-card:not(.locked)').count()) === 5, await page.locator('button.game-card:not(.locked)').count());
  await shot(page, 'A01-dashboard');

  // Memory Match via category
  await openCategory(page, 'Memory');
  await openGameCard(page, 'Memory Match');
  check('memory-match intro shows Level 1', /Level 1/.test(await text(page, '.mm-panel')));
  await startFromIntro(page);
  await page.locator('.mm-card').first().waitFor();
  await shot(page, 'A02-memory-match-board-closed', false);
  // Visual check of closed cards: does any face actually paint?
  const faceState = await page.$eval('.mm-card', card => {
    const f = s => { const e = card.querySelector(s), cs = getComputedStyle(e); return { transform: cs.transform, backface: cs.backfaceVisibility, bg: cs.backgroundColor, text: e.textContent }; };
    return { back: f('.mm-back'), front: f('.mm-front') };
  });
  // A face with backface-visibility:hidden rotated by 180° (matrix3d starting with -1) is not painted.
  const flipped = t => t.startsWith('matrix3d(-1');
  check('memory-match: closed card shows its "?" face', !flipped(faceState.back.transform), faceState);
  await playMemoryMatch(page);
  const xpAfterMM = await storage(page, 'xp');
  check('memory-match result screen', /MEMORY MATCH COMPLETE/.test(await text(page, '.mm-result')));
  check('topbar XP equals stored XP', (await text(page, '#topbarStats')).includes(`${xpAfterMM} XP`), { xpAfterMM });
  await shot(page, 'A03-memory-match-result');
  await page.locator('[data-mm="exit"]', { hasText: 'Back to Games' }).click();
  check('Back to Games returns to Memory category', (await text(page, '#app h2')).includes('Memory'));

  // Reaction Rush via dashboard "All games"
  await page.locator('#nav button', { hasText: 'Dashboard' }).click();
  await openGameCard(page, 'Reaction Rush');
  await startFromIntro(page);
  await playReactionRush(page, { falseStartRound: 1 });
  const rrHist = (await storage(page, 'history'))[0];
  check('reaction-rush recorded with 1 false start', rrHist.gameId === 'reaction-rush' && rrHist.details.falseStarts === 1, rrHist.details && { falseStarts: rrHist.details.falseStarts, avg: rrHist.details.averageReactionTime });
  check('reaction-rush accuracy 4/5', Math.abs(rrHist.accuracy - 0.8) < 1e-9, rrHist.accuracy);
  await shot(page, 'A04-reaction-rush-result');
  await page.locator('[data-rr="exit"]', { hasText: 'Back to Games' }).click();
  check('Back to Games returns to dashboard', (await page.locator('.cat-card').count()) === 5);

  // Target Focus
  await openCategory(page, 'Attention');
  await openGameCard(page, 'Target Focus');
  await startFromIntro(page);
  await playTargetFocus(page, { wrongInRound: 1 });
  const tfHist = (await storage(page, 'history'))[0];
  check('target-focus recorded: 10/10 rounds, 1 mistake', tfHist.gameId === 'target-focus' && tfHist.details.successfulRounds === 10 && tfHist.details.mistakes === 1, tfHist.details && { mistakes: tfHist.details.mistakes, ok: tfHist.details.successfulRounds });
  await page.locator('[data-tf="exit"]', { hasText: 'Back to Games' }).click();

  // Quick Calculate: 1 wrong + 1 timeout -> 80% accuracy
  await page.locator('#nav button', { hasText: 'Dashboard' }).click();
  await openCategory(page, 'Math');
  await openGameCard(page, 'Quick Calculate');
  await startFromIntro(page);
  await playQuickCalc(page, { wrong: [3], timeout: [5] });
  const qcHist = (await storage(page, 'history'))[0];
  check('quick-calculate: 8 correct, 1 wrong, 1 timeout', qcHist.details.correctAnswers === 8 && qcHist.details.wrongAnswers === 1 && qcHist.details.timeouts === 1, { c: qcHist.details.correctAnswers, w: qcHist.details.wrongAnswers, t: qcHist.details.timeouts });
  check('quick-calculate: accuracy 0.8 in result & history', Math.abs(qcHist.accuracy - 0.8) < 1e-9 && /80%/.test(await text(page, '.mm-result')));
  const qcLevel = (await storage(page, 'progress'))['quick-calculate'].difficulty;
  note('quick-calculate next level after 80% / 1 timeout', qcLevel);
  await shot(page, 'A05-quick-calc-result');
  await page.locator('[data-qc="start"]', { hasText: 'Play Again' }).click();
  const chipLevel = await page.locator('.mm-chips b').first().innerText();
  check('Play Again starts at the adaptive level', Number(chipLevel) === qcLevel, { chipLevel, qcLevel });
  await page.locator('[data-qc="exit"]').click();

  // Unlock the rest by seeding XP (documented: not earned by play)
  const xpPlayed = await storage(page, 'xp');
  note('XP earned by 4 real games', xpPlayed);
  await setStorage(page, 'xp', Math.max(xpPlayed, 800));
  await page.reload();
  await openCategory(page, 'Math');
  check('Math: 3/3 games unlocked after XP seed', (await page.locator('.game-card:not(.locked)').count()) === 3);

  await openGameCard(page, 'Number Compare');
  await startFromIntro(page);
  await shot(page, 'A06-number-compare-question', false);
  await playNumberCompare(page, { wrong: [2] });
  const ncHist = (await storage(page, 'history'))[0];
  check('number-compare: 9/10 correct recorded', ncHist.gameId === 'number-compare' && ncHist.details.correctAnswers === 9, ncHist.details.correctAnswers);
  await page.locator('[data-nc="exit"]', { hasText: 'Back to Games' }).click();

  await openGameCard(page, 'Missing Number');
  await startFromIntro(page);
  await shot(page, 'A07-missing-number-question', false);
  await playMissingNumber(page);
  const mnHist = (await storage(page, 'history'))[0];
  check('missing-number: 10/10 correct (Next button + auto-advance)', mnHist.gameId === 'missing-number' && mnHist.details.correctAnswers === 10, mnHist.details.correctAnswers);
  await page.locator('[data-mn="exit"]', { hasText: 'Back to Games' }).click();

  // Progress page
  await page.locator('#nav button', { hasText: 'Progress' }).click();
  const rows = await page.locator('.table tbody tr').count();
  const hist = await storage(page, 'history');
  check('Progress: history table rows = stored history', rows === hist.length && hist.length === 6, { rows, stored: hist.length });
  const schemaOk = hist.every(h => ['gameId', 'score', 'accuracy', 'time', 'difficulty', 'xp', 'date'].every(k => k in h));
  check('history entries keep the common result schema', schemaOk);
  note('history entries without details', hist.filter(h => !h.details).map(h => h.gameId));
  const profVals = await page.$$eval('.profile-row', rs => rs.map(r => [r.children[0].textContent, r.querySelector('.val').textContent]));
  note('profile values on Progress page', profVals);
  check('profile: Logic shows "–", others numeric', profVals.find(p => p[0] === 'Logic')[1] === '–' && profVals.filter(p => p[0] !== 'Logic').every(p => /^\d+$/.test(p[1])));
  const cs = await storage(page, 'categoryScores');
  check('stored categoryScores match displayed profile', profVals.every(([n, v]) => String(cs[n.toLowerCase()] ?? '–') === v), cs);
  await shot(page, 'A08-progress');

  // Locked game -> unlock modal; Escape closes it
  const xpNow = await storage(page, 'xp');
  await setStorage(page, 'xp', 0);
  await page.reload();
  await openGameCard(page, 'Path Finder');
  check('locked game shows the unlock modal', (await page.locator('#modal:not([hidden]) .modal-box').isVisible()) && /Unlock at 600 XP/.test(await text(page, '#modal')));
  await page.keyboard.press('Escape');
  check('Escape closes modal', await page.locator('#modal').isHidden());
  // Every unlocked game card opens its module intro (games without a module still use the placeholder modal)
  await setStorage(page, 'xp', Math.max(xpNow, 5000));
  await page.reload();
  const games = await page.evaluate(() => MF.GAMES.map(g => ({ id: g.id, name: g.name, built: !!MF.GameModules[g.id] })));
  note('games without a module (Coming soon)', games.filter(g => !g.built).map(g => g.id));
  for (const g of games) {
    await openGameCard(page, g.name);
    if (g.built) {
      const ok = await page.locator('#gameRoot .mm-panel', { hasText: g.name }).isVisible();
      check(`${g.id}: card opens the game intro`, ok);
      await page.locator('#gameRoot .mm-panel .btn.ghost', { hasText: 'Back' }).click();
    } else {
      const soon = page.locator('.game-card.soon', { hasText: g.name }).first();
      check(`${g.id}: unbuilt game is a non-clickable "Coming soon" card`, (await soon.innerText()).includes('Coming soon')
        && (await page.locator('#modal').isHidden()) && !(await page.locator('#gameRoot').count()));
    }
    await page.locator('.cat-card').first().waitFor();
  }
  check('A: no console errors / page errors', page.__errors.length === 0, page.__errors);
  await ctx.close();

  }
  if (want('B')) {
  // ---------------- B. Exit / navigation cleanup ----------------
  scenario = 'B exit & nav cleanup';
  ({ ctx, page } = await newPage(browser));
  await gotoFresh(page);
  await setStorage(page, 'xp', 800);
  await page.reload();
  check('baseline: no live timers on dashboard', (await liveTimers(page)) === 0, await liveTimers(page));

  const exitCases = [
    { name: 'quick-calculate Exit Game mid-question', cat: 'Math', game: 'Quick Calculate', how: 'exit', exitSel: '[data-qc="exit"]',
      mid: async () => { await page.locator('.qc-opt').first().waitFor(); await page.locator('.qc-opt').first().click(); } },
    { name: 'number-compare topbar nav during feedback', cat: 'Math', game: 'Number Compare', how: 'nav',
      mid: async () => { await page.locator('.nc-choice').first().waitFor(); await page.locator('.nc-choice').first().click(); } },
    { name: 'missing-number Exit during feedback', cat: 'Math', game: 'Missing Number', how: 'exit', exitSel: '[data-mn="exit"]',
      mid: async () => { await page.locator('.mn-opt').first().waitFor(); await page.locator('.mn-opt').first().click(); } },
    { name: 'reaction-rush topbar nav during countdown', cat: 'Speed', game: 'Reaction Rush', how: 'nav', mid: async () => { await sleep(300); } },
    { name: 'reaction-rush Exit during wait', cat: 'Speed', game: 'Reaction Rush', how: 'exit', exitSel: '[data-rr="exit"]',
      mid: async () => { await page.waitForFunction(() => document.querySelector('.rr-arena')?.dataset.phase === 'wait', null, { timeout: 8000 }); } },
    { name: 'target-focus logo nav during preview', cat: 'Attention', game: 'Target Focus', how: 'logo', mid: async () => { await sleep(100); } },
    { name: 'memory-match Exit with mismatch pending', cat: 'Memory', game: 'Memory Match', how: 'exit', exitSel: '[data-mm="exit"]',
      mid: async () => {
        await page.locator('.mm-card').first().waitFor();
        const cards = await page.$$eval('.mm-card', els => els.map(e => e.querySelector('.mm-front').textContent));
        const j = cards.findIndex(s => s !== cards[0]);
        await page.click('.mm-card[data-i="0"]'); await page.click(`.mm-card[data-i="${j}"]`);
      } }
  ];
  for (const c of exitCases) {
    await page.locator('#nav button', { hasText: 'Dashboard' }).click();
    await openCategory(page, c.cat);
    await openGameCard(page, c.game);
    await startFromIntro(page);
    await c.mid();
    const histBefore = ((await storage(page, 'history')) || []).length;
    const timersInGame = await liveTimers(page);
    if (c.how === 'exit') await page.locator(c.exitSel, { hasText: 'Exit Game' }).click();
    else if (c.how === 'nav') await page.locator('#nav button', { hasText: 'Progress' }).click();
    else await page.locator('.logo').click();
    const afterNow = await liveTimers(page);
    await sleep(2500);
    const view = c.how === 'exit' ? await text(page, '#app h2') : c.how === 'nav' ? await text(page, '#app h2') : await text(page, '#app .hero h2');
    const histAfter = ((await storage(page, 'history')) || []).length;
    check(`${c.name}: timers cleared on leave`, afterNow === 0, { timersInGame, afterLeave: afterNow });
    check(`${c.name}: correct screen & nothing recorded later`, histAfter === histBefore && !(await page.locator('#gameRoot').count()), { view, histBefore, histAfter });
  }
  // Re-entry state is clean
  await page.locator('#nav button', { hasText: 'Dashboard' }).click();
  await openCategory(page, 'Math');
  await openGameCard(page, 'Quick Calculate');
  check('re-entry shows intro, not stale game', await page.locator('.mm-panel .btn', { hasText: 'Start Game' }).isVisible());
  await startFromIntro(page);
  await page.locator('.qc-opt').first().waitFor();
  check('re-entry starts at Question 1/10, Correct 0', (await text(page, '[data-s="q"]')) === '1/10' && (await text(page, '[data-s="correct"]')) === '0');
  // Rapid double click on an option is scored once
  await page.locator('.qc-opt').first().dblclick();
  await sleep(100);
  check('double click scores once (status shown, options disabled)', (await page.locator('.qc-opt:disabled').count()) === 4);
  await page.locator('[data-qc="exit"]').click();
  // Long wait after leaving: no late callbacks
  await sleep(13000);
  check('13 s after leaving: still no timers, no errors', (await liveTimers(page)) === 0 && page.__errors.length === 0, page.__errors);
  await ctx.close();

  }
  if (want('C')) {
  // ---------------- C. Settings persistence ----------------
  scenario = 'C settings';
  ({ ctx, page } = await newPage(browser));
  await gotoFresh(page);
  await page.locator('#nav button', { hasText: 'Settings' }).click();
  const sw = key => page.locator(`.toggle[data-key="${key}"]`);
  check('defaults: SFX on, Music off', (await sw('soundEffects').getAttribute('aria-checked')) === 'true' && (await sw('music').getAttribute('aria-checked')) === 'false');
  await sw('soundEffects').click();
  await sw('music').click();
  check('toggles flip in UI', (await sw('soundEffects').getAttribute('aria-checked')) === 'false' && (await sw('music').getAttribute('aria-checked')) === 'true');
  await page.reload();
  await page.locator('#nav button', { hasText: 'Settings' }).click();
  check('after reload: SFX off, Music on persisted', (await sw('soundEffects').getAttribute('aria-checked')) === 'false' && (await sw('music').getAttribute('aria-checked')) === 'true', await storage(page, 'settings'));
  await shot(page, 'C01-settings-after-reload');
  await setStorage(page, 'xp', 123);
  await page.locator('[data-action="reset"]').click(); // confirm() auto-accepted
  check('Reset clears XP and restores default settings', (await storage(page, 'xp')) === null && (await sw('soundEffects').getAttribute('aria-checked')) === 'true' && (await sw('music').getAttribute('aria-checked')) === 'false');
  check('C: no console errors', page.__errors.length === 0, page.__errors);
  await ctx.close();

  }
  if (want('D')) {
  // ---------------- D. Audio with FILES_AVAILABLE = true (copy + fake Audio) ----------------
  scenario = 'D audio (copy, fake Audio)';
  const COPY = path.join(OUT, 'audio-copy');
  for (const d of ['css', 'js', 'games']) fs.cpSync(path.join(ROOT, d), path.join(COPY, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(COPY, 'index.html'));
  const audioFile = path.join(COPY, 'js', 'audio.js');
  const src = fs.readFileSync(audioFile, 'utf8');
  check('copy: FILES_AVAILABLE flag found and flipped', src.includes('const FILES_AVAILABLE = false;'));
  fs.writeFileSync(audioFile, src.replace('const FILES_AVAILABLE = false;', 'const FILES_AVAILABLE = true;'));
  const COPY_URL = pathToFileURL(path.join(COPY, 'index.html')).href;
  ({ ctx, page } = await newPage(browser, {}, { audioStub: true }));
  await gotoFresh(page, COPY_URL);
  const aud = () => page.evaluate(() => window.__audio.slice());
  const sfxNames = list => list.filter(a => a.ev === 'play' && a.src.includes('/sfx/')).map(a => a.src.split('/').pop().replace('.mp3', ''));
  await page.evaluate(() => { window.__audio.length = 0; });
  await openCategory(page, 'Math');
  await openGameCard(page, 'Quick Calculate');
  await startFromIntro(page);
  await page.locator('.qc-opt').first().waitFor();
  await page.locator('.qc-opt').first().click();
  await sleep(200);
  let names = sfxNames(await aud());
  check('SFX on: game-start + correct/wrong played', names.includes('game-start') && (names.includes('correct') || names.includes('wrong')), names);
  await page.locator('[data-qc="exit"]').click();
  await page.locator('#nav button', { hasText: 'Settings' }).click();
  await page.locator('.toggle[data-key="soundEffects"]').click(); // off (the click SFX after turning off must not play)
  await page.evaluate(() => { window.__audio.length = 0; });
  await page.locator('#nav button', { hasText: 'Dashboard' }).click();
  await openCategory(page, 'Math');
  await openGameCard(page, 'Quick Calculate');
  await startFromIntro(page);
  await page.locator('.qc-opt').first().waitFor();
  await page.locator('.qc-opt').first().click();
  await sleep(200);
  names = sfxNames(await aud());
  check('SFX off: no SFX played', names.length === 0, names);
  await page.locator('[data-qc="exit"]').click();
  // Music
  await page.locator('#nav button', { hasText: 'Settings' }).click();
  await page.evaluate(() => { window.__audio.length = 0; });
  await page.locator('.toggle[data-key="music"]').click(); // on
  let a = await aud();
  check('Music on: background.mp3 created with loop and played', a.some(x => x.ev === 'play' && x.src.includes('background.mp3') && x.loop === true), a);
  await page.evaluate(() => { window.__audio.length = 0; });
  await page.locator('.toggle[data-key="music"]').click(); // off
  a = await aud();
  check('Music off: paused and released', a.some(x => x.ev === 'pause' && x.src.includes('background.mp3')) && a.some(x => x.ev === 'load'), a);
  await page.locator('.toggle[data-key="music"]').click(); // on again
  await page.reload();
  a = await aud();
  check('after reload with Music on: no autoplay before a gesture', !a.some(x => x.ev === 'play'), a);
  await page.mouse.click(5, 400);
  await sleep(100);
  a = await aud();
  check('first gesture starts music', a.some(x => x.ev === 'play' && x.src.includes('background.mp3')), a);
  await page.evaluate(() => { window.__audio.length = 0; });
  await page.locator('#nav button', { hasText: 'Settings' }).click();
  await page.locator('[data-action="reset"]').click();
  a = await aud();
  check('Reset stops music (default music=off)', a.some(x => x.ev === 'pause') && !a.some(x => x.ev === 'play' && x.src.includes('background')), a);
  check('D: no console errors', page.__errors.length === 0, page.__errors);
  await ctx.close();

  }
  if (want('E')) {
  // ---------------- E. Mobile viewports ----------------
  for (const vp of [{ width: 360, height: 740 }, { width: 390, height: 844 }]) {
    scenario = `E mobile ${vp.width}px`;
    ({ ctx, page } = await newPage(browser, { viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true }));
    await gotoFresh(page);
    const probe = async (name) => {
      const p = await layoutProbe(page);
      await shot(page, `E${vp.width}-${name}`);
      check(`${name}: no horizontal overflow`, !p.horizontalOverflow && p.offenders.length === 0, p.horizontalOverflow || p.offenders.length ? { scrollWidth: p.scrollWidth, offenders: p.offenders } : undefined);
      if (p.under44.length) note(`${name}: touch targets < 44px`, summarizeSmall(p.under44));
      return p;
    };
    await probe('dashboard');
    await openCategory(page, 'Memory');
    await probe('category-memory');
    // Memory Match: intro, board, result (level 1)
    await openGameCard(page, 'Memory Match');
    await probe('memory-match-intro');
    await startFromIntro(page);
    await page.locator('.mm-card').first().waitFor();
    await probe('memory-match-board');
    await playMemoryMatch(page, { mismatchFirst: false });
    await sleep(300);
    await probe('memory-match-result');
    // Seed: all games unlocked; difficulty 5 to see the largest grids
    await setStorage(page, 'xp', 800);
    await setStorage(page, 'progress', Object.fromEntries((await page.evaluate(() => Object.keys(MF.GameModules))).map(id => [id, { plays: 1, bestScore: 0, difficulty: 5 }])));
    await page.reload();
    const builtNames = await page.evaluate(() => MF.GAMES.filter(g => MF.GameModules[g.id]).map(g => g.name));
    const games = [['Memory', 'Memory Match', '.mm-card'], ['Speed', 'Reaction Rush', '.rr-arena'], ['Attention', 'Target Focus', '.tf-grid'],
      ['Math', 'Quick Calculate', '.qc-opt'], ['Math', 'Number Compare', '.nc-choice'], ['Math', 'Missing Number', '.mn-opt'],
      ['Logic', 'Pattern Shift', '.ps-opt'], ['Logic', 'Logic Grid', '.lg-cell'], ['Logic', 'Path Finder', '.pf-cell'],
      ['Memory', 'Sequence Recall', '.sr-pad.lit'], ['Attention', 'Color Filter', '.cf-stage .cf-shape'], ['Speed', 'Quick Switch', '.qs-card'],
      ['Memory', 'Grid Memory', '.gm-cell'], ['Attention', 'Distraction Hunt', '.dh-cell'], ['Speed', 'Speed Sequence', '.ss-cell']]
      .filter(([, name]) => builtNames.includes(name));
    for (const [cat, g, sel] of games) {
      await page.locator('.logo').click();
      await openCategory(page, cat);
      await openGameCard(page, g);
      await page.locator('.mm-panel .btn', { hasText: 'Start Game' }).tap();
      await page.locator(sel).first().waitFor({ timeout: 8000 });
      await sleep(g === 'Target Focus' ? 50 : 300);
      await probe(`${g.toLowerCase().replace(/ /g, '-')}-L5-ingame`);
    }
    // One full Reaction Rush on touch (tap) at level 5
    await page.locator('.logo').click();
    await openCategory(page, 'Speed');
    await openGameCard(page, 'Reaction Rush');
    await page.locator('.mm-panel .btn', { hasText: 'Start Game' }).tap();
    await playReactionRush(page, { falseStartRound: 0, tap: true });
    const rr = (await storage(page, 'history'))[0];
    check('reaction-rush via touch taps: 5/5 hits recorded', rr.gameId === 'reaction-rush' && rr.accuracy === 1, { acc: rr.accuracy, avg: rr.details.averageReactionTime });
    await probe('reaction-rush-result');
    await page.locator('#nav button', { hasText: 'Progress' }).tap();
    await probe('progress');
    await page.locator('#nav button', { hasText: 'Settings' }).tap();
    await probe('settings');
    check(`E ${vp.width}: no console errors`, page.__errors.length === 0, page.__errors);
    await ctx.close();
  }

  }
  if (want('F')) {
    scenario = 'F new games';
    ({ ctx, page } = await newPage(browser));
    await gotoFresh(page);
    await setStorage(page, 'xp', 2000); // unlock everything; the new games' own XP is checked in the jsdom tests
    await page.reload();
    for (const g of NEW_GAMES) {
      await page.locator('.logo').click();
      await openCategory(page, g.cat);
      await openGameCard(page, g.name);
      await startFromIntro(page);
      await g.play(page);
      const r = (await storage(page, 'history'))[0];
      check(`${g.id}: full game recorded`, r.gameId === g.id && (g.expectCorrect === undefined || r.details.correctAnswers === g.expectCorrect), { score: r.score, acc: r.accuracy, details: Object.keys(r.details || {}) });
      check(`${g.id}: result screen + topbar XP`, (await page.locator('.mm-result .mm-xp').innerText()) === `+${r.xp} XP` && (await text(page, '#topbarStats')).includes(`${await storage(page, 'xp')} XP`));
      await shot(page, `F-${g.id}-result`);
      await page.locator(`[data-${g.prefix}="start"]`, { hasText: 'Play Again' }).click();
      await g.mid(page);
      await shot(page, `F-${g.id}-ingame`, false);
      const before = ((await storage(page, 'history')) || []).length;
      await page.locator('#nav button', { hasText: 'Progress' }).click();
      check(`${g.id}: timers cleared after nav mid-game`, (await liveTimers(page)) === 0, await liveTimers(page));
      await sleep(2000);
      check(`${g.id}: nothing recorded after leaving`, ((await storage(page, 'history')) || []).length === before);
    }
    check('F: no console errors', page.__errors.length === 0, page.__errors);
    await ctx.close();
  }
  // __NEW_GAMES__
  await browser.close();
  const failed = checks.filter(c => c.ok === false);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ date: new Date().toISOString(), failed: failed.length, checks }, null, 2));
  console.log(`\n${checks.filter(c => c.ok).length} passed, ${failed.length} failed, ${checks.filter(c => c.ok === null).length} info`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('RUNNER ERROR:', e); process.exit(2); });
