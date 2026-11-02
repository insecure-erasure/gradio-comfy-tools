// Unit tests for the pure media-drop planner (static/js/media-events.js).
// Run directly (`node tests/js/media_events_test.js`) or via pytest, which
// wraps this file (tests/test_media_events_js.py) and skips without node.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = path.join(__dirname, '..', '..', 'static', 'js', 'media-events.js');
// Run in THIS context (not a vm sandbox): objects created by the planner must
// share the test realm's prototypes, otherwise deepStrictEqual/instanceof fail.
global.window = { location: { origin: 'http://localhost:8000' } };
vm.runInThisContext(fs.readFileSync(SRC, 'utf8'), { filename: SRC });

const { mediaDropPlan, filenameFromUrl, mediaEntryFilename, mediaSourceFilenames } = global;

// storage.js only defines functions at load time, so it can be pulled in to
// exercise the probe contract (_mediaExists) with a stubbed fetch.
const STORAGE_SRC = path.join(__dirname, '..', '..', 'static', 'js', 'storage.js');
vm.runInThisContext(fs.readFileSync(STORAGE_SRC, 'utf8'), { filename: STORAGE_SRC });
const { _mediaExists } = global;

async function withFetch(handler, fn) {
  const prev = global.fetch;
  global.fetch = handler;
  try { return await fn(); } finally { global.fetch = prev; }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── filename matching ─────────────────────────────────────────────────────
test('filenameFromUrl parses /media and {base}/view URLs', () => {
  assert.strictEqual(filenameFromUrl('/media/a.png?type=temp'), 'a.png');
  assert.strictEqual(filenameFromUrl('http://h:8188/view?filename=v.mp4&type=temp'), 'v.mp4');
  assert.strictEqual(filenameFromUrl('http://h:8188/media/b%20c.png'), 'b c.png');
  assert.strictEqual(filenameFromUrl('https://example.com/x.png'), null);
  assert.strictEqual(filenameFromUrl('upload.png'), null);
  assert.strictEqual(filenameFromUrl(''), null);
});

test('mediaEntryFilename falls back to a bare ComfyUI filename', () => {
  assert.strictEqual(mediaEntryFilename({ filename: 'f.png', src: '/media/g.png' }), 'f.png');
  assert.strictEqual(mediaEntryFilename({ src: '/media/g.png?type=temp' }), 'g.png');
  assert.strictEqual(mediaEntryFilename({ src: 'upload.png' }), 'upload.png');
  assert.strictEqual(mediaEntryFilename({ src: 'https://x/y.png' }), null);
});

test('mediaSourceFilenames covers value and base/face pairs', () => {
  assert.deepStrictEqual(mediaSourceFilenames({ value: '/media/a.png?type=temp' }), ['a.png']);
  assert.deepStrictEqual(mediaSourceFilenames({ base: 'up.png', face: '' }), ['up.png', null]);
  assert.deepStrictEqual(
    mediaSourceFilenames({ base: '/media/b.png?type=temp', face: '/media/f.png?type=temp' }),
    ['b.png', 'f.png']
  );
});

// ── planner ───────────────────────────────────────────────────────────────
const baseState = () => ({
  generated: [
    { src: '/media/gen1.png?type=temp', filename: 'gen1.png' },
    { src: '/media/gen2.png?type=temp', filename: 'gen2.png' },
  ],
  videos: [{ src: '/media/vid.mp4?type=temp', filename: 'vid.mp4' }],
  comparisons: [
    { src: '/media/cmp1.png?type=temp', before: '/media/gen1.png?type=temp', tab: 'edit' },
    { src: '/media/cmp2.png?type=temp', before: '/media/gone-src.png?type=temp', tab: 'upscale' },
  ],
  sourceHistory: {
    edit: [
      { value: '/media/gen1.png?type=temp' },
      { value: 'upload.png' },
      { value: 'https://example.com/x.png' },
    ],
    upscale: [{ value: 'upload.png' }],
    video: [],
    face_swap: [
      { base: '/media/gen1.png?type=temp', face: '/media/face.png?type=temp' },
      { base: 'upload.png', face: '' },
      { base: '/media/gen2.png?type=temp', face: '' },
    ],
  },
  lastSources: { edit: 'upload.png', upscale: '/media/gen2.png?type=temp', video: '' },
  lastGeneratedUrl: '/media/gen2.png?type=temp',
});

test('drops a generated entry by filename', () => {
  const state = baseState();
  const plan = mediaDropPlan(state, ['gen1.png']);
  assert.deepStrictEqual(plan.generated.map(e => e.filename), ['gen2.png']);
  assert.strictEqual(plan.changed, true);
  // The same file is also a 🕘 source and a face-swap base, so all of them go.
  assert.ok(plan.removed.includes(state.generated[0]));
});

test('keeps external-URL and unmatched entries', () => {
  const plan = mediaDropPlan(baseState(), ['nope.png']);
  assert.strictEqual(plan.changed, false);
  assert.strictEqual(plan.generated.length, 2);
  assert.deepStrictEqual(plan.sourceHistory.edit.map(e => e.value),
    ['/media/gen1.png?type=temp', 'upload.png', 'https://example.com/x.png']);
});

test('drops a comparison only when its AFTER file is gone', () => {
  const plan = mediaDropPlan(baseState(), ['cmp1.png']);
  assert.deepStrictEqual(plan.comparisons.map(e => e.src), ['/media/cmp2.png?type=temp']);
  assert.strictEqual(plan.beforeResets.length, 0);
});

test('a dead BEFORE keeps the comparison and resets its before side', () => {
  const state = baseState();
  const plan = mediaDropPlan(state, ['gone-src.png']);
  assert.strictEqual(plan.comparisons.length, 2);
  assert.deepStrictEqual(plan.beforeResets, [state.comparisons[1]]);
  assert.strictEqual(plan.comparisons[1], state.comparisons[1]); // identity preserved
  assert.strictEqual(plan.changed, true);
});

test('drops source-history entries in every tab (value, base, face)', () => {
  const plan = mediaDropPlan(baseState(), ['gen1.png', 'face.png', 'upload.png']);
  assert.deepStrictEqual(plan.sourceHistory.edit, [{ value: 'https://example.com/x.png' }]);
  assert.deepStrictEqual(plan.sourceHistory.upscale, []);          // bare upload
  assert.deepStrictEqual(plan.sourceHistory.face_swap, [{ base: '/media/gen2.png?type=temp', face: '' }]);
});

test('keeps a face-swap pair when neither side is gone', () => {
  const plan = mediaDropPlan(baseState(), ['other.png']);
  assert.strictEqual(plan.sourceHistory.face_swap.length, 3);
});

test('clears dead last-source values and the chain URL', () => {
  const plan = mediaDropPlan(baseState(), ['upload.png', 'gen2.png']);
  assert.strictEqual(plan.lastSources.edit, '');
  assert.strictEqual(plan.lastSources.upscale, '');
  assert.strictEqual(plan.lastGeneratedGone, true);
});

test('drops videos announced by the cleanup task', () => {
  const plan = mediaDropPlan(baseState(), ['vid.mp4']);
  assert.deepStrictEqual(plan.videos, []);
  assert.strictEqual(plan.changed, true);
});

test('does not mutate the input arrays', () => {
  const state = baseState();
  const before = JSON.parse(JSON.stringify(state));
  mediaDropPlan(state, ['gen1.png', 'upload.png']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state)), before);
});

test('empty or invalid input is a no-op', () => {
  const state = baseState();
  for (const input of [[], null, undefined, 'nope', [''], [null, 3]]) {
    const plan = mediaDropPlan(state, input);
    assert.strictEqual(plan.changed, false);
    assert.strictEqual(plan.generated.length, 2);
  }
});

test('is idempotent for the same deletions', () => {
  const first = mediaDropPlan(baseState(), ['gen1.png']);
  const second = mediaDropPlan({ generated: first.generated }, ['gen1.png']);
  assert.strictEqual(second.generated.length, 1);
  assert.strictEqual(second.changed, false);
});

// ── probe contract (_mediaExists) ─────────────────────────────────────────
test('a missing file (404) is reported as missing', async () => {
  await withFetch(async () => ({ json: async () => ({ exists: false, status: 404 }) }), async () => {
    assert.strictEqual(await _mediaExists('gone-404.png', 'temp', true), false);
  });
});

test('an INCONCLUSIVE probe (unknown) keeps the entry', async () => {
  await withFetch(async () => ({ json: async () => ({ exists: true, unknown: true }) }), async () => {
    assert.strictEqual(await _mediaExists('unknown-1.png', 'temp', true), true);
  });
});

test('a transport failure keeps the entry', async () => {
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    assert.strictEqual(await _mediaExists('offline-1.png', 'temp', true), true);
  });
});

test('results are cached unless force is set', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return { json: async () => ({ exists: false, status: 404 }) };
  }, async () => {
    assert.strictEqual(await _mediaExists('cached.png', 'output', false), false);
    assert.strictEqual(await _mediaExists('cached.png', 'output', false), false);
    assert.strictEqual(calls, 1);
    assert.strictEqual(await _mediaExists('cached.png', 'output', true), false);
    assert.strictEqual(calls, 2);
  });
});

// ── runner ────────────────────────────────────────────────────────────────
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('ok   - ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL - ' + name);
      console.log('       ' + (err && err.message ? err.message : err));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
