// ── Global state ──────────────────────────
// Shared across modules: plain <script> tags share the global scope, so
// top-level `let`/`function` declarations are visible to every module that
// loads after this one (see load order in templates/index.html).

// Populated from GET /api/settings on startup (media base, for result URLs).
let baseUrl = '';

// The last generation's output URL — persists across tab switches so 🔗 can
// fill the Edit/Upscale/Video source field (chaining).
let lastGeneratedUrl = null;

// Active tab id ('generate' | 'edit' | 'face_swap' | 'upscale' | 'video').
let currentTab = 'generate';

// Toolbar selections persist across tab switches (the toolbar is rebuilt
// on every switch, so we keep the values here, outside the DOM).
let toolbarValues = {
  genFamily: 'krea2',
  vidVersion: 'wan21',
};

// Per-tab prompt text — each tab (generate/edit/video/face_swap) has its
// OWN textarea element (#promptInput<Cap>), so values never mix;
// promptsByTab mirrors them for localStorage persistence (storage.js).
// Face swap's prompt is OPTIONAL (appended after the workflow's built-in
// head_swap instructions), so it has its own key like the others.
let promptsByTab = {
  generate: '',
  edit: '',
  video: '',
  face_swap: '',
};

// The textarea of the ACTIVE tab (the only visible one). Falls back to any
// .prompt-input when currentTab has none (defensive).
function activePromptInput() {
  const id = { generate: 'promptInputGenerate', edit: 'promptInputEdit', video: 'promptInputVideo', face_swap: 'promptInputFaceSwap' }[currentTab];
  const el = id ? document.getElementById(id) : null;
  return el || document.querySelector('.prompt-input.active') || document.querySelector('.prompt-input');
}
