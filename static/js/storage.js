// ── Browser persistence (localStorage) ─────
// Persists user configuration across page reloads:
//   - per-tab parameters (steps, seed, AR, MP, frames, ...)
//   - advanced modal values (model, LoRAs, diffusion, negative)
//   - toolbar selections (image family, video version)
//   - light/dark theme
// All stored under one key as JSON. Session-only by design (no backend).

const STORAGE_KEY = 'comfyTools.userConfig';

// Field ids whose values we persist, per tab.
const PERSIST_FIELDS = {
  generate: ['genSteps', 'genSeed', 'genMegapixel', 'genAspectRatio', 'genSeedRandom'],
  edit: ['editSteps', 'editSeed', 'editSeedRandom'],
  upscale: ['upscaleSeed', 'upscaleSeedRandom'],
  video: ['videoFrames', 'videoSteps', 'videoSeed', 'videoSeedRandom'],
};

function loadPersistedState() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* disabled */ }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function savePersistedState() {
  const data = {
    params: collectParams(),
    advanced: window.advancedValues || {},
    toolbar: toolbarValues,
    prompts: promptsByTab,
    theme: currentTheme,
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* disabled */ }
}

// Collect the persisted field values from the current DOM.
function collectParams() {
  const out = {};
  Object.entries(PERSIST_FIELDS).forEach(([tab, ids]) => {
    out[tab] = {};
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') out[tab][id] = el.checked;
      else out[tab][id] = el.value;
    });
  });
  return out;
}

// Apply persisted field values to the DOM (called on load).
// (Replaced by applyPersistedParams — kept for reference.)
// function applyParams(data) { ... }

// Restore everything on startup (before the app initializes the controls).
function restorePersistedState() {
  const data = loadPersistedState();
  if (!data) return;

  // toolbar selections
  if (data.toolbar) {
    if (data.toolbar.genFamily) toolbarValues.genFamily = data.toolbar.genFamily;
    if (data.toolbar.vidVersion) toolbarValues.vidVersion = data.toolbar.vidVersion;
  }
  // advanced modal values
  if (data.advanced) window.advancedValues = data.advanced;
  // per-tab prompts (independent text per tool)
  if (data.prompts && typeof data.prompts === 'object') {
    ['generate', 'edit', 'video'].forEach(t => {
      if (typeof data.prompts[t] === 'string') promptsByTab[t] = data.prompts[t];
    });
  }
  // theme
  if (data.theme) currentTheme = data.theme;
  // keep params to re-apply after the auto-steps recalc (applyPersistedParams)
  window.__persistedParams = data.params || null;
}

// Re-apply persisted per-tab params AFTER onModelFamilyChange ran, so the
// saved values win over the family auto-steps/resolution.
function applyPersistedParams() {
  if (!window.__persistedParams) return;
  Object.entries(window.__persistedParams).forEach(([tab, vals]) => {
    Object.entries(vals).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val;
    });
  });
  window.__persistedParams = null;
}

// currentTheme is managed here (settings.js reads it) — default 'dark'.
let currentTheme = 'dark';
