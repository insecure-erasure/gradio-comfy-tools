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
  face_swap: ['fsSteps', 'fsCfg', 'fsSeed', 'fsSeedRandom'],
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
    if (Array.isArray(data.galleries.videos)) {
      // Dedup by URL: a lost-fetch recovery race used to register a video
      // twice (see api.js tryRecoverResult). Drop pre-existing duplicates
      // from sessions with the old bug so the gallery shows one entry per
      // generated video.
      const seen = new Set();
      window.galleryVideos = [];
      data.galleries.videos.map(normalizeVideoEntry).forEach(e => {
        const key = e.url || e.src || '';
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        window.galleryVideos.push(e);
      });
    }
    if (Array.isArray(data.galleries.comparisons)) window.galleryComparisons = data.galleries.comparisons;
  }
  // keep params to re-apply after the auto-steps recalc (applyPersistedParams)
  window.__persistedParams = data.params || null;
}

// Older persisted video entries (collectVideoUrl era) carried {url,
// display} but no src/filename; the current code reads e.src. Normalize so
// entries from any version work in the gallery/player.
function normalizeVideoEntry(e) {
  if (!e || typeof e !== 'object') return e;
  const display = e.src || e.display || e.url || '';
  return {
    src: display,
    url: e.url || e.src || e.display || '',
    prompt: e.prompt || '',
    filename: e.filename !== undefined ? e.filename
      : (typeof filenameFromUrl === 'function' ? filenameFromUrl(display) : null),
  };
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

async function _mediaExists(filename, type, force) {
  const cacheKey = filename + '|' + type;
  if (!force && _mediaExistsCache.has(cacheKey)) return _mediaExistsCache.get(cacheKey);
  try {
    const r = await fetch('/api/media-exists?filename=' + encodeURIComponent(filename) + '&type=' + encodeURIComponent(type));
    const j = await r.json();
    const exists = !!j.exists;
    _mediaExistsCache.set(cacheKey, exists);
    return exists;
  } catch (e) {
    _mediaExistsCache.set(cacheKey, true); // transport hiccup → keep
    return true;
  }
}

// Filter a gallery array, dropping entries whose file is gone. Probes each
// unique filename once (via the cache) with limited concurrency; preserves
// order. Returns a Promise of the filtered array.
async function _pruneDeadEntries(entries, force) {
  // Unique (filename, type) pairs to probe — a temp file is NOT found under
  // type=output, so the type embedded in the display URL must be used.
  const uniq = [];
  const seen = new Set();
  for (const e of entries) {
    const fn = e.filename || (e.src && typeof filenameFromUrl === 'function' ? filenameFromUrl(e.src) : null);
    if (!fn) continue; // external/no-name → keep, nothing to probe
    const type = e.type || (e.src && typeof fileTypeFromUrl === 'function' ? fileTypeFromUrl(e.src) : 'output');
    const key = fn + '|' + type;
    if (!seen.has(key)) { seen.add(key); uniq.push({ fn, type }); }
  }
  // Probe with limited concurrency (5 at a time). force=true bypasses the
  // per-session cache so a file deleted mid-session is caught on open.
  const existsMap = new Map();
  let i = 0;
  async function worker() {
    while (i < uniq.length) {
      const { fn, type } = uniq[i++];
      existsMap.set(fn + '|' + type, await _mediaExists(fn, type, force));
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, uniq.length) }, worker));
  // In-place removal of confirmed-dead entries. `entries` is the LIVE
  // reference the caller passed (window.galleryGenerated / ...), so any
  // entry added while the probes were in flight is preserved — only the
  // ones the server explicitly says do not exist are spliced out. Never
  // reassign the global from a stale captured array.
  for (let j = entries.length - 1; j >= 0; j--) {
    const e = entries[j];
    const fn = e.filename || (e.src && typeof filenameFromUrl === 'function' ? filenameFromUrl(e.src) : null);
    if (!fn) continue;
    const type = e.type || (e.src && typeof fileTypeFromUrl === 'function' ? fileTypeFromUrl(e.src) : 'output');
    if (existsMap.get(fn + '|' + type) === false) entries.splice(j, 1);
  }
}

// Kick off the async validation of all persisted galleries after load;
// mutates the live registries in place when dead entries are found.
async function verifyStoredGalleries(force) {
  const jobs = [];
  if (Array.isArray(window.galleryGenerated)) {
    jobs.push(_pruneDeadEntries(window.galleryGenerated, force));
  }
  // Videos are deliberately NOT pruned: ComfyUI stores them as temp files
  // that are cleaned on server restart, and the gallery must keep showing
  // every entry from the session/localStorage (a missing file just won't
  // play). See openVideoGallery.
  if (Array.isArray(window.galleryComparisons)) {
    jobs.push(_pruneDeadEntries(window.galleryComparisons, force));
  }
  await Promise.all(jobs);
  savePersistedState(); // persist the (possibly pruned) set
  // The prune may have changed entry counts — keep the pane ‹ › nav in sync.
  if (typeof syncPaneNav === 'function') ['generate', 'edit', 'upscale', 'video', 'face_swap'].forEach(syncPaneNav);
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

// ── Global reset (🗑️ in the ☰ menu) ────────
// Deletes EVERYTHING the app saved in this browser: settings, prompts,
// history and galleries. The confirmation message is written for regular
// users — it never mentions localStorage or other internal jargon. After
// the wipe the page reloads so the UI starts clean with the defaults.
function resetAllUserData() {
  const msg =
    'This will permanently delete everything saved on this device:\n\n' +
    '• Your settings (server connection, theme, advanced options)\n' +
    '• Your prompts and parameter values\n' +
    '• Your generation history and galleries\n\n' +
    'This cannot be undone. Continue?';
  if (!window.confirm(msg)) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* disabled */ }
  // Reset the in-memory registries too (a reload below is the safety net,
  // but keep the state consistent even if the reload is blocked).
  window.galleryGenerated = [];
  window.galleryVideos = [];
  window.galleryComparisons = [];
  toolbarValues = { genFamily: 'krea2', vidVersion: 'wan21' };
  promptsByTab = { generate: '', edit: '', video: '', face_swap: '' };
  window.advancedValues = {};
  currentTheme = 'dark';
  if (typeof syncPaneNav === 'function') ['generate', 'edit', 'upscale', 'video', 'face_swap'].forEach(syncPaneNav);
  // Reload so every field, pane and control returns to its default state.
  window.location.reload();
}
