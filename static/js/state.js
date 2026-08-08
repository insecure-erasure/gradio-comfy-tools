// ── Global state ──────────────────────────
// Shared across modules: plain <script> tags share the global scope, so
// top-level `let`/`function` declarations are visible to every module that
// loads after this one (see load order in templates/index.html).

// Populated from GET /api/settings on startup (media base, for result URLs).
let baseUrl = '';

// The last generation's output URL — persists across tab switches so 🔗 can
// fill the Edit/Upscale/Video source field (chaining).
let lastGeneratedUrl = null;

// Active tab id ('generate' | 'edit' | 'upscale' | 'video').
let currentTab = 'generate';

// Toolbar selections persist across tab switches (the toolbar is rebuilt
// on every switch, so we keep the values here, outside the DOM).
let toolbarValues = {
  genFamily: 'krea2',
  vidVersion: 'wan21',
};

// Per-tab prompt text — the #promptInput textarea is a single shared
// element that is relocated between tabs, so its VALUE must be saved and
// restored per tab here (Upscale has no prompt). Persisted to localStorage
// along with the other per-tab state (storage.js).
let promptsByTab = {
  generate: '',
  edit: '',
  video: '',
};
