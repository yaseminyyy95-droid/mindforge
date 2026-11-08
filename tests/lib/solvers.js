// Independent answer finders used by the jsdom and browser tests. They only look at what the player sees
// (DOM text / aria-labels), never at a game's internal state, so they double as correctness checks.
'use strict';

// ---------- Pattern Shift ----------
const PS_SHAPES = { circle: '●', square: '■', diamond: '◆', star: '★', triangle: '▲' };
const PS_DIRS = ['up', 'right', 'down', 'left'];
function psParseLabel(label) {
  const m = /^(\d+) (\w+) (?:triangles? pointing (\w+)|(circle|square|diamond|star)s?)$/.exec(label);
  if (!m) throw new Error('unparsable tile label: ' + label);
  return { count: Number(m[1]), color: m[2], shape: m[3] ? '▲' : PS_SHAPES[m[4]], rot: m[3] ? PS_DIRS.indexOf(m[3]) : 0 };
}
// numeric attributes: constant (modular for rotation) difference; categorical: smallest repeating period.
function psInferNext(tiles) {
  const n = tiles.length, out = {};
  for (const a of ['count', 'rot']) {
    const v = tiles.map(t => t[a]), mod = a === 'rot' ? 4 : null;
    const diff = (x, y) => (mod ? (((y - x) % mod) + mod) % mod : y - x);
    const d = diff(v[0], v[1]);
    for (let i = 1; i < n - 1; i++) if (diff(v[i], v[i + 1]) !== d) throw new Error(`${a} is not arithmetic: ${v}`);
    out[a] = mod ? (v[n - 1] + d) % mod : v[n - 1] + d;
  }
  for (const a of ['shape', 'color']) {
    const v = tiles.map(t => t[a]);
    let p = 1;
    while (p < n && !v.every((x, i) => i < p || x === v[i - p])) p++;
    if (p >= n) throw new Error(`${a} has no visible period: ${v}`);
    out[a] = v[n - p];
  }
  return out;
}
const psKey = t => `${t.shape}|${t.color}|${t.count}|${t.rot}`;
// labels: shown tile labels + option labels -> index of the correct option (-1 if none)
function psCorrectIndex(shownLabels, optionLabels) {
  const next = psKey(psInferNext(shownLabels.map(psParseLabel)));
  return optionLabels.map(psParseLabel).findIndex(o => psKey(o) === next);
}


// ---------- Logic Grid ----------
// Parses the clue sentences shown to the player and brute-forces every assignment.
const LG_NAMES = { Red: ['color', 0], Blue: ['color', 1], Green: ['color', 2], Yellow: ['color', 3], Cat: ['pet', 0], Dog: ['pet', 1], Fish: ['pet', 2], Bird: ['pet', 3] };
const LG_ITEM = String.raw`\S+ (Red|Blue|Green|Yellow|Cat|Dog|Fish|Bird)`;
const lgRe = body => new RegExp('^' + body.replace(/X/g, LG_ITEM) + String.raw`\.$`);
const LG_PATTERNS = [
  [lgRe(String.raw`X is in house (\d)`), (P, m) => P(m[1]) === m[2] - 1],
  [lgRe(String.raw`X is not in house (\d)`), (P, m) => P(m[1]) !== m[2] - 1],
  [lgRe('X is directly left of X'), (P, m) => P(m[1]) + 1 === P(m[2])],
  [lgRe('X is somewhere left of X'), (P, m) => P(m[1]) < P(m[2])],
  [lgRe('X and X are next to each other'), (P, m) => Math.abs(P(m[1]) - P(m[2])) === 1],
  [lgRe('X is in the same house as X'), (P, m) => P(m[1]) === P(m[2])],
  [lgRe('X is not in the same house as X'), (P, m) => P(m[1]) !== P(m[2])],
  [lgRe('X is at one end of the row'), (P, m, n) => P(m[1]) === 0 || P(m[1]) === n - 1]
];
function lgPerms(n) {
  const out = [], a = [...Array(n).keys()];
  (function rec(k) { if (k === n) { out.push([...a]); return; } for (let i = k; i < n; i++) { [a[k], a[i]] = [a[i], a[k]]; rec(k + 1); [a[k], a[i]] = [a[i], a[k]]; } })(0);
  return out;
}
// -> array of solutions { color: [item per house], pet: [...] }
function lgSolve(n, attrs, clueTexts) {
  const tests = clueTexts.map(t => {
    const hit = LG_PATTERNS.find(([re]) => re.test(t));
    if (!hit) throw new Error('unparsable clue: ' + t);
    return { m: hit[0].exec(t), f: hit[1] };
  });
  const perms = lgPerms(n), sols = [];
  const combos = attrs.length === 1 ? perms.map(p => ({ [attrs[0]]: p })) : perms.flatMap(p => perms.map(q => ({ [attrs[0]]: p, [attrs[1]]: q })));
  for (const s of combos) {
    const P = name => { const [a, i] = LG_NAMES[name]; return s[a].indexOf(i); };
    if (tests.every(({ m, f }) => f(P, m, n))) sols.push(s);
  }
  return sols;
}

// ---------- Path Finder ----------
// kinds: array of 'wall'|'open'|'start'|'goal'|'check' per cell (row-major), cols, here = current cell index.
// Returns the list of cells to step on (excluding 'here') for a shortest valid route: here -> checkpoint (if any) -> goal.
function pfShortest(kinds, cols, from, to) {
  const n = kinds.length, prev = Array(n).fill(-1), seen = Array(n).fill(false), q = [from];
  seen[from] = true;
  for (let k = 0; k < q.length; k++) {
    const i = q[k], r = Math.floor(i / cols), c = i % cols;
    const nb = [];
    if (r > 0) nb.push(i - cols); if (i + cols < n) nb.push(i + cols); if (c > 0) nb.push(i - 1); if (c < cols - 1) nb.push(i + 1);
    for (const j of nb) if (!seen[j] && kinds[j] !== 'wall') { seen[j] = true; prev[j] = i; q.push(j); }
  }
  if (!seen[to]) return null;
  const path = [];
  for (let i = to; i !== from; i = prev[i]) path.unshift(i);
  return path;
}
function pfRoute(kinds, cols, here) {
  const goal = kinds.indexOf('goal'), check = kinds.indexOf('check');
  if (check < 0) return pfShortest(kinds, cols, here, goal);
  const a = pfShortest(kinds, cols, here, check), b = pfShortest(kinds, cols, check, goal);
  return a && b ? [...a, ...b] : null;
}

module.exports = { psParseLabel, psInferNext, psKey, psCorrectIndex, lgSolve, pfRoute };
