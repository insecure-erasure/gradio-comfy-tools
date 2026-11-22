// Unit tests for the thumbnail-grid geometry (static/js/gallery-grid.js).
// Run directly (`node tests/js/gallery_grid_test.js`) or via pytest
// (tests/test_gallery_grid_js.py), which skips without node.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = path.join(__dirname, '..', '..', 'static', 'js', 'gallery-grid.js');
vm.runInThisContext(fs.readFileSync(SRC, 'utf8'), { filename: SRC });

const { galleryGridMetrics, galleryGridLimits } = global;

// Boxes below are the AREA handed to the grid: viewport minus the top bar
// (58px) and the horizontal/vertical padding (16px each side).
const DESKTOP = { w: 1120 - 32, h: 630 - 58 - 16 };   // 1088 × 556
const PHONE = { w: 390 - 32, h: 844 - 58 - 16 };      // 358 × 770
const PHONE_H = { w: 844 - 32, h: 390 - 58 - 16 };    // 812 × 316

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('few entries: capped at MAX and never stretched wider', () => {
  const m = galleryGridMetrics(5, DESKTOP.w, DESKTOP.h);
  assert.strictEqual(m.cols, 3);
  assert.strictEqual(m.rows, 2);
  assert.strictEqual(m.cell, 200);      // MAX
  assert.strictEqual(m.scroll, false);
});

test('mid counts adapt the cell to the entry count', () => {
  const m = galleryGridMetrics(24, DESKTOP.w, DESKTOP.h);
  assert.strictEqual(m.cols, 7);
  assert.strictEqual(m.rows, 4);
  assert.strictEqual(m.cell, 131);
  assert.strictEqual(m.scroll, false);
});

test('many entries hit MIN and the grid scrolls (desktop)', () => {
  const m = galleryGridMetrics(80, DESKTOP.w, DESKTOP.h);
  assert.strictEqual(m.cols, 8);        // MAX_COLS
  assert.strictEqual(m.rows, 10);
  assert.strictEqual(m.cell, 64);       // MIN
  assert.strictEqual(m.scroll, true);
});

test('phone portrait: fewer columns, still readable cells', () => {
  const m = galleryGridMetrics(24, PHONE.w, PHONE.h);
  assert.strictEqual(m.cols, 3);
  assert.strictEqual(m.cell, 87);
  assert.strictEqual(m.scroll, false);
});

test('phone portrait: 48 entries reach MIN and scroll', () => {
  const m = galleryGridMetrics(48, PHONE.w, PHONE.h);
  assert.strictEqual(m.cols, 4);
  assert.strictEqual(m.cell, 64);
  assert.strictEqual(m.scroll, true);
});

test('phone landscape: short height hits MIN before the width does', () => {
  const m = galleryGridMetrics(24, PHONE_H.w, PHONE_H.h);
  assert.strictEqual(m.cols, 8);
  assert.strictEqual(m.cell, 92);
  const m2 = galleryGridMetrics(48, PHONE_H.w, PHONE_H.h);
  assert.strictEqual(m2.cell, 64);
  assert.strictEqual(m2.scroll, true);
});

test('width clamp: cols can never overflow the box at MIN', () => {
  // Very narrow box: the aspect formula would pick many columns; at MIN=64
  // only 2 fit (2·64 + 10 = 138 ≤ 200).
  const m = galleryGridMetrics(200, 200, 800);
  assert.strictEqual(m.cols, 2);
  assert.ok(m.cols * m.cell + (m.cols - 1) * m.gap <= 200);
  assert.strictEqual(m.scroll, true);
});

test('never exceeds MAX_COLS columns nor MAX cell', () => {
  for (const n of [1, 2, 3, 7, 9, 17, 33, 100, 500]) {
    const m = galleryGridMetrics(n, DESKTOP.w, DESKTOP.h);
    assert.ok(m.cols >= 1 && m.cols <= 8, 'cols ' + m.cols);
    assert.ok(m.cell >= 64 && m.cell <= 200, 'cell ' + m.cell);
    assert.ok(m.rows * m.cols >= n, 'rows*cols covers n');
  }
});

test('degenerate inputs are safe', () => {
  for (const [n, w, h] of [[0, 100, 100], [-3, 100, 100], [5, 0, 100], [5, 100, 0], [NaN, NaN, NaN]]) {
    const m = galleryGridMetrics(n, w, h);
    assert.strictEqual(m.cols, 1);
    assert.strictEqual(m.rows, 1);
    assert.strictEqual(m.cell, 64);
    assert.strictEqual(m.scroll, false);
  }
});

test('rows is exactly the rows needed at the chosen column count', () => {
  for (const n of [1, 5, 12, 24, 47, 48, 80]) {
    const m = galleryGridMetrics(n, PHONE.w, PHONE.h);
    assert.strictEqual(m.rows, Math.ceil(n / m.cols), 'n=' + n);
  }
});


test('caps: portrait 3x4, landscape 4x5, wide 5x6', () => {
  assert.deepStrictEqual(galleryGridLimits(390, 844), { maxCols: 3, maxRows: 4 });
  assert.deepStrictEqual(galleryGridLimits(1088, 556), { maxCols: 4, maxRows: 5 });
  assert.deepStrictEqual(galleryGridLimits(1888, 1006), { maxCols: 5, maxRows: 6 });
  // Portrait/square never gets the landscape cap.
  assert.deepStrictEqual(galleryGridLimits(800, 800), { maxCols: 3, maxRows: 4 });
});

test('capped window: portrait shows at most 12 cells', () => {
  const limits = galleryGridLimits(390, 844);
  const m = galleryGridMetrics(24, PHONE.w, PHONE.h, limits);
  assert.strictEqual(m.shown, 12);
  assert.strictEqual(m.cols, 3);
  assert.strictEqual(m.rows, 4);
  assert.strictEqual(m.cell, 112);
});

test('capped window: landscape shows at most 20 cells', () => {
  const limits = galleryGridLimits(1088, 556);
  const m = galleryGridMetrics(30, DESKTOP.w, DESKTOP.h, limits);
  assert.strictEqual(m.shown, 20);
  assert.strictEqual(m.cols, 4);
  assert.strictEqual(m.rows, 5);
  assert.strictEqual(m.cell, 103);
});

test('capped window: wide landscape shows at most 30 cells', () => {
  const limits = galleryGridLimits(1888, 1006);
  const m = galleryGridMetrics(60, 1888, 1006, limits);
  assert.strictEqual(m.shown, 30);
  assert.strictEqual(m.cols, 5);
  assert.strictEqual(m.rows, 6);
  assert.strictEqual(m.cell, 159);
});

test('capped window respects the width clamp', () => {
  const limits = galleryGridLimits(200, 800);
  const m = galleryGridMetrics(24, 200, 800, limits);
  assert.strictEqual(m.shown, 8);   // only 2 cols fit at MIN -> 2x4
  assert.strictEqual(m.cols, 2);
  assert.strictEqual(m.rows, 4);
  assert.ok(m.cols * m.cell + (m.cols - 1) * m.gap <= 200);
});

test('capped window keeps counting only the shown entries', () => {
  // Small galleries are not padded: shown === n and the old geometry applies.
  const limits = galleryGridLimits(390, 844);
  const m = galleryGridMetrics(5, PHONE.w, PHONE.h, limits);
  assert.strictEqual(m.shown, 5);
  assert.ok(m.rows <= limits.maxRows);
  assert.strictEqual(m.rows, Math.ceil(m.shown / m.cols));
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
  console.error(`\n${failed} gallery grid test(s) failed`);
  process.exit(1);
}
console.log(`\n${tests.length} gallery grid tests passed`);
