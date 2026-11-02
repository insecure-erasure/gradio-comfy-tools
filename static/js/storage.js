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
  edit: ['editSteps', 'editSeed', 'editSeedRandom', 'editColorMatch', 'editPadTop', 'editPadBottom', 'editPadLeft', 'editPadRight', 'editFeather'],
  face_swap: ['fsSteps', 'fsCfg', 'fsSeed', 'fsSeedRandom', 'fsColorMatch'],
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
    // Last loaded source per single-source tool — restored into the input so
    // a generation can be retried with another seed after a reload/discard.
    lastSources: lastSourceByTab,
    theme: currentTheme,
    // Galleries: persisted so a reload does not lose the history. The
    // stored entries are validated against the server on restore (see
    // verifyStoredGalleries) — dead files are dropped, never shown.
    galleries: {
      generated: window.galleryGenerated || [],
      videos: window.galleryVideos || [],
      comparisons: window.galleryComparisons || [],
    },
    // Per-tab recent source images (🕘 popover). Small: capped at
    // SOURCE_HISTORY_MAX entries per tab.
    sourceHistory,
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
  // Last loaded source per single-source tool (Edit/Upscale/Video). The
  // value lives in state.js and is also used as getSourceUrl()'s fallback;
  // fill the inputs now so the source is reusable after a reload.
  if (data.lastSources && typeof data.lastSources === 'object') {
    ['edit', 'upscale', 'video'].forEach(tab => {
      const value = typeof data.lastSources[tab] === 'string'
        ? data.lastSources[tab].trim()
        : '';
      if (!value) return;
      lastSourceByTab[tab] = value;
      const input = document.getElementById(`${tab}SourceUrl`);
      if (input && !input.value.trim()) input.value = value;
    });
  }
  // Per-tab recent source images (restored + validated/capped in source.js).
  if (data.sourceHistory && typeof restoreSourceHistory === 'function') {
    restoreSourceHistory(data.sourceHistory);
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

// ── Gallery existence validation (one-shot, no polling) ──
// localStorage galleries can hold entries whose file no longer exists on
// the ComfyUI host (the cleanup task prunes old generations). Each unique
// filename is checked once per restore via GET /api/media-exists (a HEAD/206
// probe — no body transferred). This runs ONCE at startup and again when a
// gallery is opened (force): it is not a poll. Live deletions arrive through
// /api/media-deleted → /ws/events instead (see media-events.js). A transport
// failure keeps the entry — a missing file is never assumed from a hiccup.
// Entries without a filename (external URLs) are kept as-is.
const _mediaExistsCache = new Map();

async function _mediaExists(filename, type, force) {
  const cacheKey = filename + '|' + type;
  if (!force && _mediaExistsCache.has(cacheKey)) return _mediaExistsCache.get(cacheKey);
  try {
    const r = await fetch('/api/media-exists?filename=' + encodeURIComponent(filename) + '&type=' + encodeURIComponent(type));
    const j = await r.json();
    // `unknown` means the backend could not ask ComfyUI (outage): that is NOT
    // a deletion, so keep the entry (a false here would wipe the galleries).
    const exists = j.unknown ? true : !!j.exists;
    _mediaExistsCache.set(cacheKey, exists);
    return exists;
  } catch (e) {
    _mediaExistsCache.set(cacheKey, true); // transport hiccup → keep
    return true;
  }
}

// Collect the unique (filename, type) probes for every registry. A value can
// be a display URL (/media/x?type=temp, {base}/view?filename=x), a bare
// filename (an upload — its type is unknown, so probe temp AND output), or an
// external URL (skipped). Comparison BEFORE files are probed too, so a dead
// source can be cleared from the slider without dropping the result.
function _probeCollector() {
  const map = new Map(); // filename -> Set(types)
  const addType = (fn, type) => {
    if (!map.has(fn)) map.set(fn, new Set());
    map.get(fn).add(type);
  };
  return {
    add(value) {
      if (!value || typeof value !== 'string') return;
      const fn = typeof filenameFromUrl === 'function' ? filenameFromUrl(value) : null;
      if (fn) {
        const type = typeof fileTypeFromUrl === 'function' ? fileTypeFromUrl(value) : 'output';
        addType(fn, type);
        return;
      }
      // Bare ComfyUI filename (an upload): probe both roots.
      if (/^[^\s/:\\]+$/.test(value)) {
        addType(value, 'temp');
        addType(value, 'output');
      }
    },
    specs() {
      return Array.from(map, ([fn, types]) => ({ fn, types: Array.from(types) }));
    },
  };
}

// Probe with limited concurrency (5). A filename is dead only when EVERY
// probed type is missing — a temp file is NOT found under type=output, so a
// single miss must not drop it.
async function _deadFilenames(probes, force) {
  const dead = [];
  let i = 0;
  async function worker() {
    while (i < probes.length) {
      const { fn, types } = probes[i++];
      let alive = false;
      for (const type of types) {
        if (await _mediaExists(fn, type, force)) { alive = true; break; }
      }
      if (!alive) dead.push(fn);
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, probes.length) }, worker));
  return dead;
}

// Preflight ONE entry right before a pane is restored: it comes from
// localStorage and may have been cleaned while the tab was closed. One HEAD
// (cached per session) instead of letting the <img> request fail. Returns
// true when the file exists OR the probe is inconclusive.
async function ensureEntryExists(entry) {
  const fn = typeof mediaEntryFilename === 'function' ? mediaEntryFilename(entry) : null;
  if (!fn) return true; // external URL / no filename: nothing to probe
  const type = entry && entry.src && typeof fileTypeFromUrl === 'function'
    ? fileTypeFromUrl(entry.src) : 'output';
  return _mediaExists(fn, type, false);
}

// Same preflight for the 🕘 grid of one tab, run when its popover opens: the
// thumbnails are persisted and may have been cleaned. Confirmed-missing
// entries go through dropMedia() (which also refreshes the grid if open).
async function pruneSourceHistory(tab) {
  const list = (typeof sourceHistory === 'object' && sourceHistory && sourceHistory[tab]) || [];
  if (!list.length) return;
  const probes = _probeCollector();
  list.forEach(e => {
    if (!e) return;
    if (e.base !== undefined) { probes.add(e.base); probes.add(e.face); }
    else probes.add(e.value);
  });
  const specs = probes.specs();
  if (!specs.length) return;
  const dead = await _deadFilenames(specs, false);
  if (dead.length && typeof dropMedia === 'function') dropMedia(dead, { quiet: true });
}

// One-shot validation of everything persisted: generated results, comparison
// after/before sides and the 🕘 source history. Only CONFIRMED-missing files
// are reported, and they all go through dropMedia() so the galleries' N/M,
// the pane ‹ › navigation and the 🕘 grid update together (never a silent
// splice that leaves the UI showing a ghost). skipVideos: videos are temp
// files the app deliberately keeps (a missing one just won't play).
async function verifyStoredGalleries(force) {
  const probes = _probeCollector();
  (window.galleryGenerated || []).forEach(e => probes.add(e && e.src));
  (window.galleryComparisons || []).forEach(e => {
    probes.add(e && e.src);
    probes.add(e && e.before);
  });
  Object.values(typeof sourceHistory === 'object' && sourceHistory ? sourceHistory : {})
    .forEach(list => (list || []).forEach(e => {
      if (!e) return;
      if (e.base !== undefined) { probes.add(e.base); probes.add(e.face); }
      else probes.add(e.value);
    }));
  const specs = probes.specs();
  if (!specs.length) return;
  const dead = await _deadFilenames(specs, force);
  if (!dead.length) return;
  if (typeof dropMedia === 'function') dropMedia(dead, { quiet: true });
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
  sourceHistory = { edit: [], upscale: [], video: [], face_swap: [] };
  lastSourceByTab = { edit: '', upscale: '', video: '' };
  toolbarValues = { genFamily: 'krea2', vidVersion: 'wan21' };
  promptsByTab = { generate: '', edit: '', video: '', face_swap: '' };
  window.advancedValues = {};
  currentTheme = 'dark';
  if (typeof syncPaneNav === 'function') ['generate', 'edit', 'upscale', 'video', 'face_swap'].forEach(syncPaneNav);
  // Reload so every field, pane and control returns to its default state.
  window.location.reload();
}
