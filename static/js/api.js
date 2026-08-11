// ── API helper + shared UI (toast, result rendering) ──

// The AbortController of the in-flight generation request, so ⏹ can abort
// it (the backend job is cancelled separately via POST /api/cancel).
let currentAbort = null;

// POST JSON to a backend endpoint. Aborts after 240s so a hung request
// never leaves the action button stuck.
async function api(path, body, timeoutMs) {
  const ctrl = new AbortController();
  currentAbort = ctrl;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 240000);
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let detail = resp.statusText;
      try { const j = await resp.json(); detail = j.detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    return resp.json();
  } finally {
    clearTimeout(timer);
    if (currentAbort === ctrl) currentAbort = null;
  }
}

function abortCurrentRequest() {
  if (currentAbort) currentAbort.abort();
}

// Floating bottom notification.
let toastTimer;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

// Render a result (image or video) into an output pane.
// Removes only the previous result/placeholder/preview — keeps overlays like
// the loading spinner (which lives inside the pane). The live per-step
// preview (preview-live) is also removed: it is replaced by the final
// result.
function showResult(paneId, result, isVideo) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  pane.querySelectorAll('.result-img, .result-video, .video-player, .output-placeholder, .source-preview, .preview-live, .video-mock').forEach(el => el.remove());
  if (isVideo) {
    // Custom player (player.js): bottom-centered ▶/⏸ + ⋮ controls and an
    // always-visible accent progress line — replaces the native controls
    // (which overlapped the pane's overlay buttons). Autoplay muted loop.
    // Pane player: NO own ⛶ button — the pane's top-right ⛶ is the
    // gallery opener (two buttons in the same spot stacked the player's
    // over the gallery's). The gallery overlay keeps its own ⛶.
    pane.appendChild(createVideoPlayer(result.display, true));
  } else {
    const img = document.createElement('img');
    img.className = 'result-img';
    img.src = result.display;
    pane.appendChild(img);
  }
}

// Reset an output pane: drop results, hide compare sliders, restore the
// video mock placeholder. Used by the ↺ resets.
function clearPane(paneId) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  pane.querySelectorAll('.result-img, .result-video, .video-player, .output-placeholder, .source-preview, .preview-live').forEach(el => el.remove());
  pane.querySelectorAll('.compare-slider').forEach(el => {
    el.style.display = 'none';
    // Drop the gallery markers so a cleared result no longer appears in the
    // gallery (the reused slider would otherwise keep its last srcs).
    delete el.dataset.gallery;
    delete el.dataset.kind;
    delete el.dataset.prompt;
  });
  // Drop the tab's comparisons from the session registry too, so a ↺ reset
  // also clears that tab's history in the ⛶ compare gallery.
  if (window.galleryComparisons) {
    const tab = paneId.replace(/OutputPane$/, '');
    window.galleryComparisons = window.galleryComparisons.filter(e => e.tab !== tab);
  }
  const mock = pane.querySelector('.video-mock');
  if (mock) mock.style.display = '';
}

function setResultUrl(filename) {
  lastGeneratedUrl = `${baseUrl}/view?filename=${encodeURIComponent(filename)}&type=output`;
  document.getElementById('resultUrl').textContent = lastGeneratedUrl;
  document.getElementById('btnCopyUrl').disabled = false;
}

function copyResultUrl() {
  const url = document.getElementById('resultUrl').textContent;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    showToast('URL copied');
  }).catch(() => showToast('Copy failed'));
}

// ✕ clears the ACTIVE tab's prompt textarea (each tab has its own field,
// so only that tab's value is affected) and its stored value.
function clearPrompt() {
  const input = activePromptInput();
  if (input) input.value = '';
  if (promptsByTab && currentTab) promptsByTab[currentTab] = '';
  updateActionButtons();
  input.focus();
}

// Disable/enable the action buttons that require a prompt. Tabs/buttons
// without a prompt (Upscale, and the 🩹 Restore button) stay enabled.
// While a generation runs (genLockActive) every action button is disabled
// instead, so this returns early (see setGeneratingUi).
function updateActionButtons() {
  if (genLockActive) return; // generation lock holds all buttons disabled
  const prompt = (activePromptInput()?.value || '').trim();
  const btnCol = document.getElementById('btnCol');
  if (!btnCol) return;
  if (currentTab === 'upscale') return; // no prompt needed
  const hasText = prompt.length > 0;
  btnCol.querySelectorAll('.btn-generate[data-requires-prompt]').forEach(btn => {
    btn.disabled = !hasText;
  });
}

// Marks an output pane as "generating": the source URL overlay fades out and
// stops being focusable so it does not interfere with viewing the result.
// Also blurs the input so it collapses back to 10% width.
function setGenerating(pane, on) {
  if (!pane) return;
  pane.classList.toggle('generating', on);
  if (on) {
    const field = pane.querySelector('.source-url-input');
    if (field && document.activeElement === field) field.blur();
  }
}

// ── Generation UI lock ─────────────────────
// While a generation runs (any tool) the prompt textarea is locked (typing
// blocked, dimmed) and every action + 🪄 refine button is disabled — the
// user cannot write/refine a prompt or start another job mid-generation,
// and in Edit the complementary 🖌️/🩹 buttons are BOTH blocked too. The
// click-catchers swap to a "Generation in progress…" toast. The lock is
// released when the request settles (success, error, cancel — each tool's
// .finally()).
//
// Stop-by-transformation (like the 🪄→⏹ refine button): the action button
// that STARTED the generation transforms into the ⏹ stop button (glyph /
// title / onclick), so there is no separate stop button in the corner
// anymore. The originals are stashed on the element (data-gen-*) and
// restored on unlock.
let genLockActive = false;
let genTriggerId = null;   // id of the action button that started the job
let _genCatchers = [];

// Original state of a stop-transformed button, keyed by element: glyph,
// title, the inline onclick attribute (if any) and the onclick PROPERTY
// (direct handlers — e.g. the Upscale buttons are created with
// `btn.onclick = generateUpscale`, no attribute). Restored on unlock.
const _genStopOrig = new WeakMap();

function setGeneratingUi(on, triggerId) {
  genLockActive = !!on;
  if (on) {
    genTriggerId = triggerId || null;
  }
  const input = activePromptInput();
  if (on) {
    if (input) { input.disabled = true; input.classList.add('generating'); }
    applyGenerationLock();
  } else {
    genTriggerId = null;
    if (input) { input.disabled = false; input.classList.remove('generating'); }
    const btnCol = document.getElementById('btnCol');
    if (btnCol) {
      btnCol.classList.remove('generating');
      _genCatchers.forEach(({ el, orig }) => { el.onclick = orig; });
      _genCatchers = [];
    }
    // Restore every stop-transformed button first (glyph/title/onclick),
    // then re-enable: 🪄 everywhere; the always-active buttons (🩹 Restore,
    // 🔍 Upscale — wherever they sit) unconditionally; the prompt-required
    // ones follow the prompt state (updateActionButtons).
    document.querySelectorAll('.btn-generate').forEach(b => restoreStopButton(b));
    document.querySelectorAll('.btn-refine, .prompt-refine-btn').forEach(b => { b.disabled = false; });
    document.querySelectorAll('.btn-generate').forEach(b => { b.disabled = false; });
    document.querySelectorAll('.prompt-clear').forEach(b => { b.disabled = false; });
    updateActionButtons();
  }
}

// Stash the button's original state and turn it into the ⏹ stop button.
function makeStopButton(el) {
  if (!el || _genStopOrig.has(el)) return; // already transformed
  _genStopOrig.set(el, {
    glyph: el.textContent,
    title: el.title || '',
    onclickAttr: el.getAttribute('onclick'),
    onclickProp: el.onclick,
  });
  el.textContent = '⏹';
  el.title = 'Stop generation';
  el.setAttribute('onclick', 'cancelGeneration()');
  el.disabled = false;
}

// Restore the stashed original state (glyph/title/handler).
function restoreStopButton(el) {
  const orig = _genStopOrig.get(el);
  if (!orig) return;
  el.textContent = orig.glyph;
  el.title = orig.title;
  el.removeAttribute('onclick');
  el.onclick = orig.onclickProp; // direct handler, or the attribute-derived one
  _genStopOrig.delete(el);
}

// Disable every action + refine button, wherever it lives, and swap the
// click-catchers to the "Generation in progress…" toast. The action button
// that started the job becomes the ⏹ stop button instead of being disabled
// (makeStopButton). Re-applied on tab switch mid-generation (switchTab
// rebuilds #btnCol, so the fresh buttons need the lock re-asserted).
function applyGenerationLock() {
  document.querySelectorAll('.btn-generate').forEach(b => {
    if (genTriggerId && b.id === genTriggerId) makeStopButton(b);
    else b.disabled = true;
  });
  document.querySelectorAll('.btn-refine, .prompt-refine-btn').forEach(b => { b.disabled = true; });
  // The prompt-modal action button (portrait) matching the trigger also
  // becomes the ⏹ stop button (✨ for generate/video, 🖌️ for edit, 🩹 for
  // restore — the OTHER modal action stays disabled), and the ✕ clear is
  // disabled — the prompt is locked.
  const modalActionForTrigger = {
    btnGenerate: 'promptGenerateBtn',
    btnVideo: 'promptGenerateBtn',
    btnEdit: 'promptGenerateBtn',
    btnRestore: 'promptRestoreBtn',
  }[genTriggerId] || 'promptGenerateBtn';
  const modalStop = document.getElementById(modalActionForTrigger);
  if (modalStop) makeStopButton(modalStop);
  document.querySelectorAll('.prompt-clear').forEach(b => { b.disabled = true; });
  const btnCol = document.getElementById('btnCol');
  _genCatchers = []; // previous catchers were rebuilt away by switchTab — drop them
  if (btnCol) {
    btnCol.classList.add('generating');
    btnCol.querySelectorAll('.btn-catcher').forEach(c => {
      _genCatchers.push({ el: c, orig: c.onclick });
      c.onclick = () => showToast('Generation in progress…');
    });
  }
}

// Random uint32 seed (same range the backend uses for -1, COMFY_SEED_MAX).
// Used client-side so the value that will be sent to the workflow is visible
// in the seed field while 🎲 is enabled.
function randomSeed() {
  return Math.floor(Math.random() * 4294967296);
}

// ── Live progress (B5-lite) ────────────────
// While a generation runs, poll GET /api/progress and paint the current
// stage into the result URL row (the same area that shows the generation
// URL on completion). The URL replaces the progress text on success; on
// error the row is cleared. Polling stops when the request settles.
//
// During the generation the 📋 copy button (disabled) is HIDDEN — the row
// shows the live progress text; when the generation settles the copy
// button comes back (enabled once a result URL is shown). The stop button
// is the action button itself transformed into ⏹ (see makeStopButton).
let progressTimer = null;
let userCancelled = false;

// Per-tool handler to finalize a result whose fetch was lost (background
// tab / focus loss): called with the result {url, display} recovered from
// the backend after the job completed. Each tool registers its own.
let recoverHandler = null;
let recoverPending = false;  // a job's fetch died; backend still running
function registerRecoverHandler(fn) { recoverHandler = fn; }
async function tryRecoverResult() {
  if (!recoverHandler || progressTimer === null) return; // no job / no handler
  try {
    const r = await fetch('/api/last-result');
    const j = await r.json();
    if (!j.url) { recoverPending = false; return; } // nothing to recover
    // Build the same-origin display URL from the recovered {base}/view URL.
    const q = (j.url.split('?')[1] || '');
    const params = new URLSearchParams(q);
    const fn = params.get('filename');
    const type = params.get('type') || 'output';
    if (fn) {
      recoverPending = false;
      recoverHandler({ url: j.url, display: '/media/' + encodeURIComponent(fn) + '?type=' + type });
    } else {
      recoverPending = false;
    }
  } catch (e) { /* ignore */ }
}

// ⏹ Cancel (the transformed action button): stop the backend job (POST
// /api/cancel — interrupt running + delete pending) and abort the in-flight
// fetch so the UI settles now.
function cancelGeneration() {
  userCancelled = true;
  stopProgressPolling();
  fetch('/api/cancel', { method: 'POST' }).catch(() => {});
  abortCurrentRequest();
}

// ↺ Reset helper: if a generation is running (polling active), cancel the
// backend job and stop the live preview/progress polling so the reset
// leaves a clean pane — nothing (preview or result) reappears over the
// restored placeholder. Safe to call when idle (cancel is a no-op there).
function cancelIfRunning() {
  if (progressTimer) {
    fetch('/api/cancel', { method: 'POST' }).catch(() => {});
  }
  stopProgressPolling();
}

// The tab that started the current generation. The live per-step preview is
// captured for the job regardless of what the user does, but is only
// PAINTED while the active tab is the one that started it (requirement:
// "if the user switches tabs mid-generation, keep capturing but only show
// in the tab where it started"). tab -> output pane id (generate uses
// 'genOutputPane', the rest match by name).
const TAB_PANE_IDS = { generate: 'genOutputPane', edit: 'editOutputPane', upscale: 'upscaleOutputPane', video: 'videoOutputPane' };
let liveJobTab = null;
// Elements hidden while the live preview is painted (placeholder, previous
// result, source preview) so the preview fills the pane and stays centered;
// restored if the job is cancelled (stopProgressPolling) — never removed,
// so a cancel keeps the previous result visible.
let liveHidden = [];

function startProgressPolling() {
  stopProgressPolling();
  liveJobTab = currentTab; // tab that initiated the generation
  const copy = document.getElementById('btnCopyUrl');
  if (copy) copy.style.display = 'none'; // the row shows progress while generating
  paintProgress();
  progressTimer = setInterval(paintProgress, 1000);
}

// Paint the current job stage into the result URL row (and the live
// per-step preview). Named so visibilitychange can re-paint immediately
// when the tab regains focus — background tabs get their setInterval
// throttled/suspended by the browser, which froze the last progress line.
async function paintProgress() {
  try {
    const resp = await fetch('/api/progress');
    const j = await resp.json();
    const el = document.getElementById('resultUrl');
    if (!el) return;
    const a = j.active;
    if (!a) {
      // The job finished (active:null). If a fetch was lost and the result
      // was never shown, recover it now (also fires on focus return).
      if (recoverPending) tryRecoverResult();
      return; // no active job — leave the last painted text until the request settles
    }
    let txt;
    if (a.stage === 'queued') {
      txt = '⏳ Queued…';
    } else if (a.stage === 'running') {
      txt = '⚙️ ' + (a.node_title || ('node ' + (a.node ?? '')));
      if (a.value != null && a.max) txt += ' — ' + a.value + '/' + a.max;
    } else {
      txt = '⚙️ ' + (a.node_title || '');
    }
    el.textContent = txt;
    // Live per-step preview (any tab): paint the latest latent decode in
    // the output pane of the tab that started the job, and ONLY while the
    // user is on that tab (switching away pauses the painting; coming
    // back resumes it with the latest frame). The spinner stays on top.
    if (a.preview && liveJobTab && liveJobTab === currentTab) {
      const pane = document.getElementById(TAB_PANE_IDS[liveJobTab]);
      if (pane) {
        let pv = pane.querySelector('.preview-live');
        if (!pv) {
          // The preview must fill the pane and stay centered: hide (not
          // remove) whatever competes for space — placeholder, previous
          // result, source preview, compare slider, video mock. Overlays
          // (spinner, buttons) stay. liveHidden is restored by
          // stopProgressPolling on cancel.
          liveHidden = Array.from(pane.querySelectorAll('.result-img, .result-video, .video-player, .output-placeholder, .source-preview, .compare-slider, .video-mock'));
          liveHidden.forEach(el => { el.style.display = 'none'; });
          pv = document.createElement('img');
          pv.className = 'preview-live';
          pv.alt = 'Live preview';
          pane.appendChild(pv);
        }
        pv.src = a.preview;
      }
    }
  } catch (e) { /* server busy — ignore */ }
}

// When the tab regains focus, re-paint immediately (setInterval is
// throttled/suspended in background tabs, which left the progress line
// frozen). Also re-assert the generation lock UI (a switch mid-job already
// handles the buttons; this covers the focus-loss case).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (progressTimer) {
    paintProgress();          // re-sync the progress line immediately
    tryRecoverResult();       // recover a result whose fetch died in background
  }
});

function stopProgressPolling() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  const copy = document.getElementById('btnCopyUrl');
  if (copy) copy.style.display = ''; // restore the copy button (enabled once a result URL shows)
  liveJobTab = null;
  // Drop any live preview left in a pane (job settled: cancel or done). The
  // final result replaces it via showResult; on cancel nothing should linger.
  document.querySelectorAll('.preview-live').forEach(el => el.remove());
  // Restore whatever was hidden while the preview was painted (placeholder /
  // previous result / source preview), so a cancelled job keeps the pane as
  // it was. Elements removed by showResult are simply gone from the DOM.
  liveHidden.forEach(el => { el.style.display = ''; });
  liveHidden = [];
}
