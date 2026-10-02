const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');

test('target profiles are selectable and persisted', () => {
  assert.match(html, /<select id="target-profile"/);
  assert.match(html, /Every day 8h/);
  assert.match(html, /Weekdays 8h/);
  assert.match(html, /Light week/);
  assert.match(html, /Custom/);
  assert.match(html, /localStorage\.getItem\('targetProfile'\)/);
});

test('target calculations use one shared helper', () => {
  assert.match(html, /function targetFor\(date\)/);
  assert.match(html, /const target = targetFor\(date\) \* 3600;/);
  assert.doesNotMatch(html, /const target = TARGETS\[weekday\(date\)\] \* 3600;/);
});
