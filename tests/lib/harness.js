// jsdom harness for MindForge (development only).
// Loads index.html + every <script> in the same order as the browser, with:
//  - setTimeout/setInterval delays scaled by `scale` (default 0.1) and performance.now() scaled by 1/scale,
//    so game logic sees "virtual" milliseconds while tests run ~10x faster;
//  - every live timeout/interval tracked (liveTimers());
//  - optional FILES_AVAILABLE=true copy of audio.js with a fake Audio class that records calls.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SCRIPTS = [...INDEX.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);

function loadApp({ scale = 0.1, filesAvailable = false, storage = {} } = {}) {
  const dom = new JSDOM(INDEX.replace(/<script[^>]*><\/script>/g, ''), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const live = new Map();
  const st = w.setTimeout.bind(w), ct = w.clearTimeout.bind(w), si = w.setInterval.bind(w), ci = w.clearInterval.bind(w);
  w.setTimeout = (fn, d = 0, ...a) => { const id = st(() => { live.delete(id); fn(...a); }, Math.max(0, d * scale)); live.set(id, 't'); return id; };
  w.clearTimeout = id => { live.delete(id); ct(id); };
  w.setInterval = (fn, d = 0, ...a) => { const id = si(fn, Math.max(1, d * scale), ...a); live.set(id, 'i'); return id; };
  w.clearInterval = id => { live.delete(id); ci(id); };
  const t0 = Date.now();
  Object.defineProperty(w.performance, 'now', { value: () => (Date.now() - t0) / scale, configurable: true });
  w.confirm = () => true;
  const audio = [];
  w.Audio = class {
    constructor(src) { this.src = src || ''; this.volume = 1; this.loop = false; audio.push({ ev: 'new', src: this.src }); }
    play() { audio.push({ ev: 'play', src: this.src }); return Promise.resolve(); }
    pause() { audio.push({ ev: 'pause', src: this.src }); }
    removeAttribute(n) { if (n === 'src') this.src = ''; }
    load() {}
  };
  Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem('mindforge:' + k, JSON.stringify(v)));
  for (const src of SCRIPTS) {
    let code = fs.readFileSync(path.join(ROOT, src), 'utf8');
    if (src === 'js/audio.js' && filesAvailable) {
      if (!code.includes('const FILES_AVAILABLE = false;')) throw new Error('FILES_AVAILABLE flag not found');
      code = code.replace('const FILES_AVAILABLE = false;', 'const FILES_AVAILABLE = true;');
    }
    w.eval(code + '\n//# sourceURL=' + src);
  }
  const doc = w.document;
  const $ = sel => doc.querySelector(sel);
  const $$ = sel => [...doc.querySelectorAll(sel)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(pred, timeout = 5000, label = 'condition') {
    const end = Date.now() + timeout;
    for (;;) { const v = pred(); if (v) return v; if (Date.now() > end) throw new Error('waitFor timeout: ' + label); await sleep(3); }
  }
  const click = el => { if (!el) throw new Error('click: element not found'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); };
  const pointer = el => el.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  const key = k => doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const store = k => JSON.parse(w.localStorage.getItem('mindforge:' + k));
  const history = () => store('history') || [];
  const sfx = () => audio.filter(a => a.ev === 'play' && a.src.includes('/sfx/')).map(a => a.src.split('/').pop().replace('.mp3', ''));
  // Opens a game from the dashboard card (unlock first via storage xp if needed).
  function openGame(id) { click($(`.game-card[data-id="${id}"]`)); }
  function startGame(prefix) { click($(`[data-${prefix}="start"]`)); }
  return { dom, w, doc, MF: w.MF, $, $$, sleep, waitFor, click, pointer, key, store, history, audio, sfx, openGame, startGame,
    liveTimers: () => live.size, close: () => w.close() };
}

// Minimal assertion-counting helper for property tests.
function property(name, n, fn) {
  for (let i = 0; i < n; i++) {
    try { fn(i); } catch (e) { e.message = `${name} (sample ${i}): ${e.message}`; throw e; }
  }
}

module.exports = { loadApp, property, ROOT };
