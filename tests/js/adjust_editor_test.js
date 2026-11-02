// Smoke tests for the adjust panel DOM controller (static/js/adjust.js).
// A tiny fake DOM exercises open -> slider -> apply/cancel/reset and the
// neutral-state guard; the percent/factor math is tested separately.

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
  return {
    id,
    tagName: extra.tagName || 'DIV',
    style: {},
    attrs: {},
    listeners: {},
    classList: classList(),
    textContent: '',
    value: extra.value !== undefined ? String(extra.value) : '',
    disabled: false,
    naturalWidth: 0,
    naturalHeight: 0,
    onload: null,
    onerror: null,
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    focus() { document.activeElement = this; },
    closest(sel) {
      if (sel === 'input, textarea, select, button') {
        return this.tagName === 'INPUT' || this.tagName === 'BUTTON' ? this : null;
      }
      return null;
    },
  };
}

const elements = {
  adjustOverlay: element('adjustOverlay'),
  adjustTargetLabel: element('adjustTargetLabel'),
  adjustImage: element('adjustImage', { tagName: 'IMG' }),
  adjustCancel: element('adjustCancel', { tagName: 'BUTTON' }),
  adjustApply: element('adjustApply', { tagName: 'BUTTON' }),
  adjustReset: element('adjustReset', { tagName: 'BUTTON' }),
  adjustBrightness: element('adjustBrightness', { tagName: 'INPUT', value: 100 }),
  adjustContrast: element('adjustContrast', { tagName: 'INPUT', value: 100 }),
  adjustSaturation: element('adjustSaturation', { tagName: 'INPUT', value: 100 }),
  adjustBrightnessValue: element('adjustBrightnessValue'),
  adjustContrastValue: element('adjustContrastValue'),
  adjustSaturationValue: element('adjustSaturationValue'),
};

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
  showToast(message) { sandbox.toasts.push(message); },
  toasts: [],
};
sandbox.window = { addEventListener() {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const ROOT = path.join(__dirname, '..', '..', 'static', 'js');
for (const file of ['adjust-utils.js', 'adjust.js']) {
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
  sandbox.openAdjustEditor({
    image: source,
    proxy,
    label,
    onApply: payload => { sandbox.applied = payload; },
  });
  elements.adjustImage.onload();
  flushRaf();
}

test('opens neutral with Apply disabled and a CSS preview', () => {
  open();
  assert.strictEqual(sandbox.adjustEditorIsOpen(), true);
  assert.strictEqual(elements.adjustOverlay.classList.contains('show'), true);
  assert.strictEqual(elements.adjustTargetLabel.textContent, '· Source');
  assert.strictEqual(elements.adjustBrightnessValue.textContent, '100%');
  assert.strictEqual(elements.adjustApply.disabled, true);
  assert.strictEqual(elements.adjustImage.style.filter,
    'brightness(1) contrast(1) saturate(1)');
});

test('a slider enables Apply and updates its output and filter', () => {
  elements.adjustBrightness.value = '125';
  elements.adjustBrightness.listeners.input();
  assert.strictEqual(elements.adjustBrightnessValue.textContent, '125%');
  assert.strictEqual(elements.adjustApply.disabled, false);
  assert.strictEqual(elements.adjustImage.style.filter,
    'brightness(1.25) contrast(1) saturate(1)');
});

test('applies the three factors in one payload', () => {
  elements.adjustContrast.value = '90';
  elements.adjustContrast.listeners.input();
  elements.adjustSaturation.value = '150';
  elements.adjustSaturation.listeners.input();
  sandbox.adjustApply();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.applied)), {
    brightness: 1.25,
    contrast: 0.9,
    saturation: 1.5,
  });
  assert.strictEqual(elements.adjustOverlay.classList.contains('show'), false);
});

test('Reset returns to neutral and disables Apply', () => {
  sandbox.applied = null;
  open();
  elements.adjustSaturation.value = '180';
  elements.adjustSaturation.listeners.input();
  assert.strictEqual(elements.adjustApply.disabled, false);
  elements.adjustReset.listeners.click();
  assert.strictEqual(elements.adjustSaturation.value, '100');
  assert.strictEqual(elements.adjustSaturationValue.textContent, '100%');
  assert.strictEqual(elements.adjustApply.disabled, true);
  elements.adjustCancel.listeners.click();
  assert.strictEqual(sandbox.applied, null);
});

test('Escape closes from the capture-phase key handler', () => {
  open();
  document.listeners.keydown({
    key: 'Escape',
    target: document.body,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  assert.strictEqual(sandbox.adjustEditorIsOpen(), false);
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
  console.error(`\n${failed} adjust editor test(s) failed`);
  process.exit(1);
}
console.log(`\n${tests.length} adjust editor tests passed`);
