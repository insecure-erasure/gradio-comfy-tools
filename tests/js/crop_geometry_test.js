// Unit tests for the pure crop geometry (static/js/crop-geometry.js).
// Run directly (`node tests/js/crop_geometry_test.js`) or via pytest, which
// wraps this file (tests/test_crop_geometry_js.py) and skips without node.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = path.join(__dirname, '..', '..', 'static', 'js', 'crop-geometry.js');
vm.runInThisContext(fs.readFileSync(SRC, 'utf8'), { filename: SRC });

const {
  cropClampRect,
  cropMoveRect,
  cropRectForAspect,
  cropResizeRect,
  cropToPayload,
  cropIsFullFrame,
  cropAspectLabel,
} = global;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('clamps a rectangle to the image and enforces the minimum size', () => {
  assert.deepStrictEqual(
    cropClampRect({ x: -10, y: -20, width: 200, height: 300 }, { width: 100, height: 120 }),
    { x: 0, y: 0, width: 100, height: 120 }
  );
  assert.deepStrictEqual(
    cropClampRect({ x: 0, y: 0, width: 1, height: 2 }, { width: 100, height: 100 }),
    { x: 0, y: 0, width: 16, height: 16 }
  );
  assert.deepStrictEqual(
    cropClampRect({ x: 90, y: 90, width: 50, height: 50 }, { width: 100, height: 100 }),
    { x: 50, y: 50, width: 50, height: 50 }
  );
});

test('the minimum never exceeds a tiny image', () => {
  assert.deepStrictEqual(
    cropClampRect({ x: 0, y: 0, width: 99, height: 99 }, { width: 8, height: 6 }),
    { x: 0, y: 0, width: 8, height: 6 }
  );
});

test('moves without resizing and clamps at the edges', () => {
  const r = { x: 20, y: 20, width: 40, height: 30 };
  assert.deepStrictEqual(
    cropMoveRect(r, 5, -10, { width: 100, height: 100 }),
    { x: 25, y: 10, width: 40, height: 30 }
  );
  assert.deepStrictEqual(
    cropMoveRect(r, 999, 999, { width: 100, height: 100 }),
    { x: 60, y: 70, width: 40, height: 30 }
  );
});

test('free corner resize keeps the opposite corner fixed', () => {
  const bounds = { width: 100, height: 100 };
  const r = { x: 20, y: 20, width: 60, height: 60 };
  assert.deepStrictEqual(cropResizeRect(r, 'nw', -10, -10, bounds),
    { x: 10, y: 10, width: 70, height: 70 });
  assert.deepStrictEqual(cropResizeRect(r, 'ne', 10, -10, bounds),
    { x: 20, y: 10, width: 70, height: 70 });
  assert.deepStrictEqual(cropResizeRect(r, 'se', 10, 10, bounds),
    { x: 20, y: 20, width: 70, height: 70 });
  assert.deepStrictEqual(cropResizeRect(r, 'sw', -10, 10, bounds),
    { x: 10, y: 20, width: 70, height: 70 });
});

test('free resize stops at the image bounds and minimum size', () => {
  const bounds = { width: 100, height: 100 };
  const r = { x: 20, y: 20, width: 60, height: 60 };
  assert.deepStrictEqual(cropResizeRect(r, 'nw', -999, -999, bounds),
    { x: 0, y: 0, width: 80, height: 80 });
  assert.deepStrictEqual(cropResizeRect(r, 'se', 999, 999, bounds),
    { x: 20, y: 20, width: 80, height: 80 });
  assert.deepStrictEqual(
    cropResizeRect(r, 'se', -999, -999, bounds, { minSize: 16 }),
    { x: 20, y: 20, width: 16, height: 16 }
  );
});

test('aspect presets produce the largest centred rectangle', () => {
  assert.deepStrictEqual(
    cropRectForAspect({ width: 200, height: 100 }, 1),
    { x: 50, y: 0, width: 100, height: 100 }
  );
  assert.deepStrictEqual(
    cropRectForAspect({ width: 100, height: 200 }, 1),
    { x: 0, y: 50, width: 100, height: 100 }
  );
  assert.deepStrictEqual(
    cropRectForAspect({ width: 200, height: 100 }, 0.5),
    { x: 75, y: 0, width: 50, height: 100 }
  );
  assert.deepStrictEqual(
    cropRectForAspect({ width: 200, height: 100 }, 0),
    { x: 0, y: 0, width: 200, height: 100 }
  );
});

test('aspect-locked corner resize keeps the ratio', () => {
  const square = cropResizeRect(
    { x: 0, y: 0, width: 100, height: 100 },
    'se', 50, 0,
    { width: 200, height: 200 },
    { aspect: 1 }
  );
  assert.deepStrictEqual(square, { x: 0, y: 0, width: 150, height: 150 });

  const wide = cropResizeRect(
    { x: 0, y: 0, width: 100, height: 50 },
    'se', 50, 0,
    { width: 300, height: 200 },
    { aspect: 2 }
  );
  assert.deepStrictEqual(wide, { x: 0, y: 0, width: 150, height: 75 });

  const tall = cropResizeRect(
    { x: 0, y: 0, width: 50, height: 100 },
    'se', 0, 50,
    { width: 200, height: 300 },
    { aspect: 0.5 }
  );
  assert.deepStrictEqual(tall, { x: 0, y: 0, width: 75, height: 150 });
});

test('aspect-locked resize respects bounds and minimum size', () => {
  const shrunk = cropResizeRect(
    { x: 0, y: 0, width: 100, height: 100 },
    'se', -999, -999,
    { width: 100, height: 100 },
    { aspect: 1, minSize: 20 }
  );
  assert.deepStrictEqual(shrunk, { x: 0, y: 0, width: 20, height: 20 });

  const grown = cropResizeRect(
    { x: 80, y: 80, width: 20, height: 20 },
    'nw', -999, -999,
    { width: 100, height: 100 },
    { aspect: 1 }
  );
  assert.deepStrictEqual(grown, { x: 0, y: 0, width: 100, height: 100 });
});

test('formats exact typical ratios without a tilde', () => {
  assert.strictEqual(cropAspectLabel(800, 600), '4:3');
  assert.strictEqual(cropAspectLabel(1920, 1080), '16:9');
  assert.strictEqual(cropAspectLabel(1024, 1024), '1:1');
  assert.strictEqual(cropAspectLabel(1600, 1000), '16:10');
  assert.strictEqual(cropAspectLabel(0, 100), '');
  assert.strictEqual(cropAspectLabel(100, -1), '');
});

test('marks approximate typical ratios with a tilde', () => {
  assert.strictEqual(cropAspectLabel(816, 1216), '~2:3');
  assert.strictEqual(cropAspectLabel(1234, 1000), '~5:4');
  assert.strictEqual(cropAspectLabel(1000, 562), '~16:9');
});

test('falls back to the exact reduced ratio when no typical one is close', () => {
  assert.strictEqual(cropAspectLabel(1000, 900), '10:9');
});

test('payload rounds to integers and never overflows the image', () => {
  assert.deepStrictEqual(
    cropToPayload({ x: 10.4, y: 20.6, width: 30.4, height: 40.6 }, { width: 100, height: 100 }),
    { x: 10, y: 21, width: 30, height: 41 }
  );
  assert.deepStrictEqual(
    cropToPayload({ x: 90, y: 90, width: 50, height: 50 }, { width: 100, height: 100 }),
    { x: 50, y: 50, width: 50, height: 50 }
  );
});

test('detects a full-frame crop', () => {
  assert.strictEqual(cropIsFullFrame({ x: 0, y: 0, width: 100, height: 50 }, { width: 100, height: 50 }), true);
  assert.strictEqual(cropIsFullFrame({ x: 1, y: 0, width: 99, height: 50 }, { width: 100, height: 50 }), false);
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
  console.error(`\n${failed} crop geometry test(s) failed`);
  process.exit(1);
}
console.log(`\n${tests.length} crop geometry tests passed`);
