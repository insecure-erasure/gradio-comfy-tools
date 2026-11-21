// Unit tests for static/js/pane-compare.js — the pane comparison is ALWAYS
// an Original | <Result> toggle, centered at the top edge of the shown
// image. Run directly (`node tests/js/pane_compare_test.js`) or via pytest
// (tests/test_pane_compare_js.py), which skips without node.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = path.join(__dirname, '..', '..', 'static', 'js', 'pane-compare.js');

// ── Minimal DOM stub (only what pane-compare.js touches) ────────────────
function makeEl(id) {
  const classes = new Set();
  const el = {
    id,
    style: {},
    dataset: {},
    attrs: {},
    _classes: classes,
    _rect: { width: 0, height: 0, left: 0, top: 0 },
    _image: null,
    classList: {
      add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      contains: c => classes.has(c),
      toggle(c, on) {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener() {},
    querySelector(sel) { return this._image && sel.includes('img') ? this._image : null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return this._rect; },
  };
  return el;
}

const els = {};
const get = id => (els[id] || (els[id] = makeEl(id)));

const sandbox = {
  document: { getElementById: get },
  window: { addEventListener() {} },
  requestAnimationFrame: fn => fn(), // run synchronously so assertions are direct
  console,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

const { setPaneCompareView, configurePaneCompare, alignPaneCompareToggle } = sandbox;
// `const` declarations are lexical: they do not land on the global object,
// so read it back from the same context.
const { PANE_COMPARE } = vm.runInNewContext('({ PANE_COMPARE })', sandbox);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('exposes the three compare panes with their slider/toggle ids', () => {
  assert.deepStrictEqual(Object.keys(PANE_COMPARE).sort(), ['edit', 'face_swap', 'upscale']);
  assert.strictEqual(PANE_COMPARE.edit.slider, 'editCompare');
  assert.strictEqual(PANE_COMPARE.upscale.toggle, 'upscaleCompareToggle');
  assert.strictEqual(PANE_COMPARE.face_swap.slider, 'faceSwapCompare');
});

test('configurePaneCompare turns the toggle on and shows the result side', () => {
  configurePaneCompare('upscale', true, 'Upscaled');
  const slider = get('upscaleCompare');
  const toggle = get('upscaleCompareToggle');
  const original = get('upscaleCompareOriginalBtn');
  const result = get('upscaleCompareResultBtn');
  assert.ok(slider.classList.contains('extend-toggle-mode'));
  assert.ok(!slider.classList.contains('show-original'));
  assert.strictEqual(toggle.style.display, 'flex');
  assert.strictEqual(result.textContent, 'Upscaled');
  assert.strictEqual(result.classList.contains('active'), true);
  assert.strictEqual(original.classList.contains('active'), false);
  assert.strictEqual(original.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(result.getAttribute('aria-pressed'), 'true');
});

test('setPaneCompareView switches sides via show-original (no slider drag)', () => {
  setPaneCompareView('upscale', true);
  const slider = get('upscaleCompare');
  assert.ok(slider.classList.contains('show-original'));
  assert.strictEqual(get('upscaleCompareOriginalBtn').classList.contains('active'), true);
  assert.strictEqual(get('upscaleCompareResultBtn').classList.contains('active'), false);
  setPaneCompareView('upscale', false);
  assert.ok(!slider.classList.contains('show-original'));
});

test('unknown tab is a no-op (never throws)', () => {
  assert.doesNotThrow(() => setPaneCompareView('generate', true));
  assert.doesNotThrow(() => configurePaneCompare('video', true, 'X'));
  assert.doesNotThrow(() => alignPaneCompareToggle('generate'));
});

test('default label per tab when none is given', () => {
  configurePaneCompare('edit');
  assert.strictEqual(get('editExtendResultBtn').textContent, 'Edited');
  configurePaneCompare('face_swap');
  assert.strictEqual(get('faceSwapCompareResultBtn').textContent, 'Face swapped');
});

test('aligns the toggle to the IMAGE top edge, not the pane (letterbox)', () => {
  // Pane 1000x1000, image 1000x500 → contain scale 1, 250px bars top/bottom.
  const slider = get('upscaleCompare');
  slider._rect = { width: 1000, height: 1000, left: 0, top: 0 };
  slider._image = { naturalWidth: 1000, naturalHeight: 500 };
  slider.classList.add('extend-toggle-mode');
  get('upscaleCompareToggle').style.display = 'flex';
  alignPaneCompareToggle('upscale');
  assert.strictEqual(get('upscaleCompareToggle').style.top, '262px'); // 250 + 12
});

test('aligns using the OTHER side while showing the original', () => {
  const slider = get('faceSwapCompare');
  slider._rect = { width: 1000, height: 1000, left: 0, top: 0 };
  // The result is portrait, the original is landscape: the alignment must
  // follow the side actually shown (their aspect ratios can differ).
  const before = { naturalWidth: 1000, naturalHeight: 500 };
  const after = { naturalWidth: 500, naturalHeight: 1000 };
  slider.querySelector = sel => (sel.includes('before') ? before : after);
  slider.classList.add('extend-toggle-mode');
  get('faceSwapCompareToggle').style.display = 'flex';
  slider.classList.add('show-original');
  alignPaneCompareToggle('face_swap');
  assert.strictEqual(get('faceSwapCompareToggle').style.top, '262px'); // landscape side
  slider.classList.remove('show-original');
  alignPaneCompareToggle('face_swap');
  assert.strictEqual(get('faceSwapCompareToggle').style.top, '12px'); // portrait: no bars
});

test('clears the inline top when the toggle is hidden (source preview)', () => {
  const toggle = get('upscaleCompareToggle');
  toggle.style.top = '262px';
  toggle.style.display = 'none';
  alignPaneCompareToggle('upscale');
  assert.strictEqual(toggle.style.top, '');
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
  console.error(`\n${failed} pane compare test(s) failed`);
  process.exit(1);
}
console.log(`\n${tests.length} pane compare tests passed`);
