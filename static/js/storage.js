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
    // Galleries: persisted so a reload does not lose the history. The
    // stored entries are validated against the server on restore (see
    // verifyStoredGalleries) — dead files are dropped, never shown.
    galleries: {
      generated: window.galleryGenerated || [],
      videos: window.galleryVideos || [],
      comparisons: window.galleryComparisons || [],
    },
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
  // persisted galleries (validated against the server afterwards — the
  // heavy part is async, so the UI is not blocked; see verifyStoredGalleries)
  if (data.galleries) {
    if (Array.isArray(data.galleries.generated)) window.galleryGenerated = data.galleries.generated;
    if (Array.isArray(data.galleries.videos)) window.galleryVideos = data.galleries.videos;
    if (Array.isArray(data.galleries.comparisons)) window.galleryComparisons = data.galleries.comparisons;
  }
  // keep params to re-apply after the auto-steps recalc (applyPersistedParams)
  window.__persistedParams = data.params || null;
}

// ── Gallery existence validation (lightweight) ──
// localStorage galleries can hold entries whose file no longer exists on
// the ComfyUI host (output pruning). Each unique filename is checked via
// GET /api/media-exists (a HEAD/206 probe — no body transferred). Results
// are cached per session (a filename is probed once), the probe runs with
// small concurrency, and a transport failure keeps the entry (a missing
// file is not worth dropping the whole gallery on a hiccup). Entries
// without a filename (external URLs) are kept as-is.
const _mediaExistsCache = new Map();

async function _mediaExists(filename, force) {
  if (!force && _mediaExistsCache.has(filename)) return _mediaExistsCache.get(filename);
  try {
    const r = await fetch('/api/media-exists?filename=' + encodeURIComponent(filename) + '&type=output');
    const j = await r.json();
    const exists = !!j.exists;
    _mediaExistsCache.set(filename, exists);
    return exists;
  } catch (e) {
    _mediaExistsCache.set(filename, true); // transport hiccup → keep
    return true;
  }
}

// Filter a gallery array, dropping entries whose file is gone. Probes each
// unique filename once (via the cache) with limited concurrency; preserves
// order. Returns a Promise of the filtered array.
async function _pruneDeadEntries(entries, force) {
  const out = [];
  const uniqFns = [];
  const seen = new Set();
  for (const e of entries) {
    const fn = e.filename || (e.src && typeof filenameFromUrl === 'function' ? filenameFromUrl(e.src) : null);
    if (!fn) { out.push(e); continue; }          // external/no-name → keep
    if (!seen.has(fn)) { seen.add(fn); uniqFns.push(fn); }
  }
  // Probe with limited concurrency (5 at a time). force=true bypasses the
  // per-session cache so a file deleted mid-session is caught on open.
  const existsMap = new Map();
  let i = 0;
  async function worker() {
    while (i < uniqFns.length) {
      const fn = uniqFns[i++];
      existsMap.set(fn, await _mediaExists(fn, force));
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, uniqFns.length) }, worker));
  return entries.filter(e => {
    const fn = e.filename || (e.src && typeof filenameFromUrl === 'function' ? filenameFromUrl(e.src) : null);
    return !fn || existsMap.get(fn) !== false;
  });
}

// Kick off the async validation of all persisted galleries after load;
// mutates the live registries in place when dead entries are found.
async function verifyStoredGalleries(force) {
  const jobs = [];
  if (Array.isArray(window.galleryGenerated)) {
    jobs.push(_pruneDeadEntries(window.galleryGenerated, force).then(ok => {
      if (ok.length !== window.galleryGenerated.length) window.galleryGenerated = ok;
    }));
  }
  if (Array.isArray(window.galleryVideos)) {
    jobs.push(_pruneDeadEntries(window.galleryVideos, force).then(ok => {
      if (ok.length !== window.galleryVideos.length) window.galleryVideos = ok;
    }));
  }
  if (Array.isArray(window.galleryComparisons)) {
    jobs.push(_pruneDeadEntries(window.galleryComparisons, force).then(ok => {
      if (ok.length !== window.galleryComparisons.length) window.galleryComparisons = ok;
    }));
  }
  await Promise.all(jobs);
  savePersistedState(); // persist the pruned set
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
  // The restored values may differ from the family auto-steps/resolution —
  // refresh the prompt chip labels (defined in tabs.js, loaded before).
  if (typeof updatePromptChips === 'function') updatePromptChips();
}

// currentTheme is managed here (settings.js reads it) — default 'dark'.
let currentTheme = 'dark';
