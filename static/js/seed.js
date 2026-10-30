// ── Seed input (uint64-safe) ───────────────
// ComfyUI's RandomNoise / KSampler* accept uint64 seeds, EasySeed accepts up
// to 2^50 and SeedVR2 up to uint32. JavaScript Number is only exact up to
// 2^53−1, so seeds are kept as decimal STRINGS end-to-end: parse/validate
// with BigInt, send the string, and never pass it through parseInt/Number.
//
// The controls are <input type="text"> (not number) so the browser cannot
// silently round a 20-digit seed. The spinner behaviour is recreated here:
// the existing −/+ buttons, ArrowUp/ArrowDown, PageUp/PageDown and the mouse
// wheel. This file is loaded before the per-tab scripts.

const SEED_MAX = {
  // RandomNoise / KSampler / KSamplerAdvanced.
  generate: 18446744073709551615n,
  edit: 18446744073709551615n,
  face_swap: 18446744073709551615n,
  // comfyui-easy-use "easy seed" (2**50, inclusive).
  video: 1125899906842624n,
  // SeedVR2VideoUpscaler (uint32).
  upscale: 4294967295n,
};

const SEED_INPUT_IDS = {
  generate: 'genSeed',
  edit: 'editSeed',
  face_swap: 'fsSeed',
  video: 'videoSeed',
  upscale: 'upscaleSeed',
};

const SEED_DECIMAL_RE = /^\d+$/;

function seedElement(tab) {
  return document.getElementById(SEED_INPUT_IDS[tab]);
}

// Validate a user-entered seed and return its canonical decimal string.
// `max` is a BigInt (inclusive). Throws an Error with a user-facing message.
function parseSeedInput(raw, max) {
  const value = String(raw ?? '').trim();
  if (!SEED_DECIMAL_RE.test(value)) {
    throw new Error(`Seed must be a whole number between 0 and ${max}`);
  }
  // Strip leading zeros before the length check so "000...5" is not rejected
  // as huge; uint64 max is 20 digits, so anything longer is out of range and
  // must not be silently truncated by a maxlength attribute.
  const digits = value.replace(/^0+(?=\d)/, '');
  if (digits.length > 20) {
    throw new Error('Seed is too large');
  }
  const seed = BigInt(digits);
  if (seed > max) {
    throw new Error(`Seed must be between 0 and ${max}`);
  }
  return seed.toString();
}

// One ± step for the spinner controls. Invalid/empty values restart at 0.
function stepSeedInput(raw, delta, max) {
  const value = String(raw ?? '').trim();
  let seed = 0n;
  if (SEED_DECIMAL_RE.test(value)) {
    const digits = value.replace(/^0+(?=\d)/, '');
    // An absurdly long value is left for submit validation to reject; do not
    // build a giant BigInt just to step it.
    if (digits.length <= 20) seed = BigInt(digits);
  }
  seed += BigInt(delta);
  if (seed < 0n) seed = 0n;
  if (seed > max) seed = max;
  return seed.toString();
}

// Uniform random seed in [0, max] using crypto. The rejection loop is cheap:
// uint64/uint32 are exact byte fills; the 2^50 EasySeed range accepts ~half.
function randomSeedValue(max) {
  const bits = max.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  const excess = BigInt(bytes * 8 - bits);
  for (;;) {
    let seed = 0n;
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      const buf = new Uint8Array(bytes);
      globalThis.crypto.getRandomValues(buf);
      for (const byte of buf) seed = (seed << 8n) | BigInt(byte);
    } else {
      // Non-secure/older browser fallback. Seed quality is not security
      // sensitive; the point is to keep the full value range.
      for (let i = 0; i < bytes * 8; i++) {
        seed = (seed << 1n) | (Math.random() < 0.5 ? 1n : 0n);
      }
    }
    seed >>= excess;
    if (seed <= max) return seed.toString();
  }
}

// Write a canonical/validated seed into the field and keep ARIA in sync.
function syncSeedAria(input) {
  if (!input) return;
  const value = String(input.value ?? '').trim();
  input.setAttribute('aria-valuenow', SEED_DECIMAL_RE.test(value) ? value : '0');
}

function refreshSeedAria() {
  Object.keys(SEED_INPUT_IDS).forEach(tab => syncSeedAria(seedElement(tab)));
}

function setSeedValue(tab, value) {
  const input = seedElement(tab);
  if (!input) return;
  input.value = String(value);
  syncSeedAria(input);
}

// The backend resolves -1 (API/CLI) and clamps out-of-range values; when it
// reports the seed it actually used, reflect it in the field so the UI and
// the executed workflow can never disagree.
function applyResolvedSeed(tab, seed) {
  if (seed === undefined || seed === null || seed === '') return;
  setSeedValue(tab, seed);
}

// Keyboard + wheel spinner semantics on top of the text input. The −/+
// buttons are wired by the per-tab step* functions; this adds the native
// number-input interactions without giving up BigInt precision.
function wireSeedSpinner(tab) {
  const input = seedElement(tab);
  if (!input) return;
  const max = SEED_MAX[tab];

  const bump = delta => {
    setSeedValue(tab, stepSeedInput(input.value, delta, max));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  input.addEventListener('keydown', event => {
    const delta = {
      ArrowUp: 1,
      ArrowDown: -1,
      PageUp: 10,
      PageDown: -10,
    }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    bump(delta);
  });

  // Native number inputs change on wheel only while focused. Mirror that so
  // scrolling over the pane never alters the seed.
  input.addEventListener('wheel', event => {
    if (document.activeElement !== input) return;
    event.preventDefault();
    bump(event.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  input.addEventListener('input', () => syncSeedAria(input));
}

function initSeedInputs() {
  Object.keys(SEED_INPUT_IDS).forEach(wireSeedSpinner);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSeedInputs);
} else {
  initSeedInputs();
}
