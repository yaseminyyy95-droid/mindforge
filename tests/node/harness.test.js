'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp } = require('../lib/harness');

test('harness: app boots, quick-calculate times out at scaled speed, exit clears timers', async () => {
  const h = loadApp();
  assert.strictEqual(h.$$('.game-card').length, 15);
  h.openGame('quick-calculate');
  h.startGame('qc');
  assert.strictEqual(h.liveTimers(), 1);
  await h.waitFor(() => /TIME UP/.test(h.$('.qc-status').textContent), 3000, 'timeout after 12 virtual s');
  h.click(h.$('[data-qc="exit"]'));
  assert.strictEqual(h.liveTimers(), 0);
  h.close();
});
