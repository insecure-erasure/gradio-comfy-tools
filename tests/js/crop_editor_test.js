// Smoke tests for the crop editor DOM controller (static/js/crop.js).
// A tiny fake DOM is enough: the interaction math lives in crop-geometry.js
// and is tested separately. This runner catches load-time wiring errors and
// the open -> preset -> apply / cancel lifecycle.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function classList() {
  const set = new Set();
  return {
    add(...names) { names.forEach(n => set.add(n)); },
    remove(...names) { names.forEach(n => set.delete(n)); },
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : !!force;
      if (on) set.add(name); else set.delete(name);
      return on;
    },
    contains(name) { return set.has(name); },
  };
}

const document = {
  activeElement: null,
  listeners: {},
  body: { classList: classList() },
  contains() { return true; },
  addEventListener(type, fn) { this.listeners[type] = fn; },
  getElementById(id) { return elements[id] || null; },
};

function element(id, extra = {}) {
  const el = {
    id,
    tagName: extra.tagName || 'DIV',
    style: {},
    dataset: {},
    attrs: {},
    children: extra.children || [],
    listeners: {},
    classList: classList(),
    textContent: '',
    disabled: false,
    onclick: null,
    naturalWidth: 0,
    naturalHeight: 0,
    clientWidth: extra.clientWidth || 0,
    clientHeight: extra.clientHeight || 0,
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    focus() { document.activeElement = this; },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: parseFloat(this.style.width) || 0,
        height: parseFloat(this.style.height) || 0,
      };
    },
    closest(sel) {
      if (sel === '[data-crop-ratio]') {
        return this.dataset.cropRatio !== undefined ? this : null;
      }
      if (sel === '[data-crop-handle]') {
        return this.dataset.cropHandle ? this : null;
      }
      if (sel === '#cropBox') return this.id === 'cropBox' ? this : null;
      if (sel === '#cropStage') return this.id === 'cropStage' ? this : null;
      if (sel === 'button, input, textarea, select') {
        return this.tagName === 'BUTTON' ? this : null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-crop-ratio]') {
        return this.children.filter(c => c.dataset.cropRatio !== undefined);
      }
      return [];
    },
  };
  return el;
}

const preset = (label, ratio) => {
  const el = element('preset-' + label, { tagName: 'BUTTON' });
  el.dataset.cropRatio = String(ratio);
  el.textContent = label;
  return el;
};

const elements = {};
const presets = [
  preset('Keep', 'keep'),
  preset('Free', 0),
  preset('1:1', 1),
];
elements.cropOverlay = element('cropOverlay');
elements.cropTopbar = element('cropTopbar');
elements.cropBottombar = element('cropBottombar');
elements.cropStageWrap = element('cropStageWrap', { clientWidth: 800, clientHeight: 600 });
elements.cropStage = element('cropStage', { clientWidth: 800, clientHeight: 600 });
elements.cropImage = element('cropImage', { tagName: 'IMG' });
elements.cropBox = element('cropBox');
elements.cropDims = element('cropDims');
elements.cropCancel = element('cropCancel', { tagName: 'BUTTON' });
elements.cropApply = element('cropApply', { tagName: 'BUTTON' });
elements.cropPresets = element('cropPresets', { children: presets });

let rafQueue = [];
const sandbox = {
  console,
  document,
  Number,
  Math,
  String,
  parseFloat,
  parseInt,
  requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
  getComputedStyle() {
    return { paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0' };
  },
  ResizeObserver: class { observe() {} },
  showToast(message) { sandbox.toasts.push(message); },
  toasts: [],
};
sandbox.window = { addEventListener() {}, innerWidth: 1024, innerHeight: 768 };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const ROOT = path.join(__dirname, '..', '..', 'static', 'js');
for (const file of ['crop-geometry.js', 'crop.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
}

const flushRaf = () => {
  while (rafQueue.length) {
    const q = rafQueue;
    rafQueue = [];
    q.forEach(fn => fn(0));
  }
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function open(source = 'a.png', proxy = '/media/a.png', label = 'Source') {
  sandbox.openCropEditor({
    image: source,
    proxy,
    label,
    onApply: payload => { sandbox.applied = payload; },
  });
  // The fake <img> does not fire load; do it manually.
  elements.cropImage.naturalWidth = 800;
  elements.cropImage.naturalHeight = 600;
  elements.cropImage.onload();
  flushRaf();
}

test('the geometry helpers stay independent of the editor state', () => {
  // crop.js used to define its own _cropBounds, shadowing the pure helper
  // once the editor script loaded. Calling the helper with an explicit
  // bounds object must ignore the editor's current image size.
  const r = sandbox.cropClampRect(
    { x: 90, y: 90, width: 50, height: 50 },
    { width: 100, height: 100 }
  );
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { x: 50, y: 50, width: 50, height: 50 });
});

test('opens with a full-frame selection and a disabled Apply', () => {
  open();
  assert.strictEqual(sandbox.cropEditorIsOpen(), true);
  assert.strictEqual(elements.cropOverlay.classList.contains('show'), true);
  assert.strictEqual(elements.cropDims.textContent, '800 × 600 · 4:3');
  assert.strictEqual(elements.cropApply.disabled, true);
  assert.strictEqual(elements.cropStage.style.width, '800px');
  assert.strictEqual(elements.cropStage.style.height, '600px');
});

test('an aspect preset enables Apply and produces a centred square', () => {
  elements.cropPresets.listeners.click({
    target: presets[2],
    preventDefault() {},
    stopPropagation() {},
  });
  assert.strictEqual(elements.cropDims.textContent, '600 × 600 · 1:1');
  assert.strictEqual(elements.cropApply.disabled, false);
  sandbox.cropApply();
  // The callback receives an object created in the vm realm; compare values.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.applied)), { x: 100, y: 0, width: 600, height: 600 });
  assert.strictEqual(elements.cropOverlay.classList.contains('show'), false);
  assert.strictEqual(sandbox.cropEditorIsOpen(), false);
});

test('the Keep preset restores the full image ratio after a crop', () => {
  open();
  elements.cropPresets.listeners.click({
    target: presets[2],
    preventDefault() {},
    stopPropagation() {},
  });
  assert.strictEqual(elements.cropDims.textContent, '600 × 600 · 1:1');

  elements.cropPresets.listeners.click({
    target: presets[0],
    preventDefault() {},
    stopPropagation() {},
  });
  // 800x600 source: the full image is restored and Apply is disabled again.
  assert.strictEqual(elements.cropDims.textContent, '800 × 600 · 4:3');
  assert.strictEqual(elements.cropApply.disabled, true);
  assert.strictEqual(presets[0].classList.contains('active'), true);
  elements.cropCancel.listeners.click();
});

test('clicking outside the image cancels, clicking the image does not', () => {
  open();
  sandbox.applied = null;
  const ev = {
    target: elements.cropStage,
    cancelable: true,
    preventDefault() {},
    stopPropagation() {},
  };
  elements.cropStageWrap.listeners.click(ev);
  assert.strictEqual(sandbox.cropEditorIsOpen(), true);

  elements.cropStageWrap.listeners.click({
    target: elements.cropStageWrap,
    cancelable: true,
    preventDefault() {},
    stopPropagation() {},
  });
  assert.strictEqual(sandbox.cropEditorIsOpen(), false);
  assert.strictEqual(sandbox.applied, null);
});

test('double-clicking the selection applies the crop', () => {
  open();
  elements.cropPresets.listeners.click({
    target: presets[2],
    preventDefault() {},
    stopPropagation() {},
  });
  elements.cropBox.listeners.dblclick({
    target: elements.cropBox,
    cancelable: true,
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.applied)), { x: 100, y: 0, width: 600, height: 600 });
  assert.strictEqual(sandbox.cropEditorIsOpen(), false);
});

test('two quick pointer clicks inside the selection apply the crop', () => {
  open();
  elements.cropPresets.listeners.click({
    target: presets[2],
    preventDefault() {},
    stopPropagation() {},
  });
  const pointer = () => ({
    target: elements.cropBox,
    pointerId: 7,
    button: 0,
    clientX: 400,
    clientY: 300,
    cancelable: true,
    preventDefault() {},
    stopPropagation() {},
  });
  elements.cropStage.listeners.pointerdown(pointer());
  elements.cropStage.listeners.pointerup(pointer());
  assert.strictEqual(sandbox.cropEditorIsOpen(), true);
  elements.cropStage.listeners.pointerdown(pointer());
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.applied)), { x: 100, y: 0, width: 600, height: 600 });
  assert.strictEqual(sandbox.cropEditorIsOpen(), false);
});

test('cancel closes without calling onApply', () => {
  sandbox.applied = null;
  open('b.png', '/media/b.png', 'Result');
  elements.cropCancel.listeners.click();
  assert.strictEqual(elements.cropOverlay.classList.contains('show'), false);
  assert.strictEqual(sandbox.applied, null);
});

test('Escape closes the editor from the capture-phase key handler', () => {
  open();
  const event = {
    key: 'Escape',
    target: document.body,
    preventDefault() {},
    stopImmediatePropagation() {},
  };
  document.listeners.keydown(event);
  assert.strictEqual(sandbox.cropEditorIsOpen(), false);
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
  console.error(`\n${failed} crop editor test(s) failed`);
  process.exit(1);
}
console.log(`\n${tests.length} crop editor tests passed`);
