// Unit tests for the pure adjust helpers (static/js/adjust-utils.js).
// Run directly (`node tests/js/adjust_utils_test.js`) or via pytest.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = path.join(__dirname, '..', '..', 'static', 'js', 'adjust-utils.js');
vm.runInThisContext(fs.readFileSync(SRC, 'utf8'), { filename: SRC });
const {
  adjustClampPercent,
  adjustFactor,
  adjustFilter,
  adjustPayload,
  adjustIsNeutral,
} = global;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('clamps and rounds slider percentages', () => {
  assert.strictEqual(adjustClampPercent(-10), 0);
  assert.strictEqual(adjustClampPercent(250), 200);
  assert.strictEqual(adjustClampPercent(120.6), 121);
  assert.strictEqual(adjustClampPercent('80'), 80);
  assert.strictEqual(adjustClampPercent('nope'), 100);
});

test('converts percent to the node factor', () => {
  assert.strictEqual(adjustFactor(0), 0);
  assert.strictEqual(adjustFactor(100), 1);
  assert.strictEqual(adjustFactor(125), 1.25);
  assert.strictEqual(adjustFactor(200), 2);
});

test('builds the CSS preview filter in node order', () => {
  assert.strictEqual(
    adjustFilter(110, 90, 125),
    'brightness(1.1) contrast(0.9) saturate(1.25)'
  );
});

test('builds the API payload', () => {
  assert.deepStrictEqual(adjustPayload(110, 100, 50), {
    brightness: 1.1,
    contrast: 1,
    saturation: 0.5,
  });
});

test('detects the neutral state', () => {
  assert.strictEqual(adjustIsNeutral(100, 100, 100), true);
  assert.strictEqual(adjustIsNeutral(100, 99, 100), false);
  assert.strictEqual(adjustIsNeutral(100, 100, 101), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}
if (failed) {
  console.error(`\n${failed} adjust utils test(s) failed`);
  process.exit(1);
}
console.log(`\n${tests.length} adjust utils tests passed`);
