// ── API helper + shared UI (toast, result rendering) ──

// The AbortController of the in-flight generation request, so ⏹ can abort
// it (the backend job is cancelled separately via POST /api/cancel).
let currentAbort = null;

// POST JSON to a backend endpoint. Aborts after 5 minutes (300s) so a hung
// request never leaves the action button stuck; Video passes a much larger
// timeout explicitly (Wan jobs are long). A lost/aborted fetch never strands
// the UI — the recovery path (tryRecoverResult) resolves the job once the
// backend finishes and records the result.
async function api(path, body, timeoutMs) {
  const ctrl = new AbortController();
  currentAbort = ctrl;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 300000);
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
      const err = new Error(detail);
      // Mark backend answers so the per-tool catches can tell a REAL
      // failure (the job is dead — terminal, e.g. ComfyUI OOM / bad
      // request) from a transport loss (recoverable) and from the 408
      // "backend wait timed out" (the job may still finish).
      err.isHttp = true;
      err.status = resp.status;
      throw err;
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
  pane.querySelectorAll('.result-img, .result-video, .video-player, .output-placeholder, .source-preview, .preview-live, .face-ref-overlay, .face-extract-overlay').forEach(el => el.remove());
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
// video empty player (the Video pane shows the real-but-disabled player
// when it has no video). Used by the ↺ resets. NOTE: this clears only the
// PANE — the galleries (registries + localStorage) are NEVER touched here;
// emptying those is exclusively the 🗑️ trash button's job (clearTabGallery
// in restore.js removes the entries explicitly, and the gallery delete
// removes the single entry).
function clearPane(paneId) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  pane.querySelectorAll('.result-img, .result-video, .video-player, .output-placeholder, .source-preview, .preview-live, .face-ref-overlay, .face-extract-overlay').forEach(el => el.remove());
  pane.querySelectorAll('.compare-slider').forEach(el => {
    el.style.display = 'none';
    // Drop the gallery markers so a cleared result no longer appears in the
    // gallery (the reused slider would otherwise keep its last srcs).
    delete el.dataset.gallery;
    delete el.dataset.kind;
    delete el.dataset.prompt;
  });
  // The Video pane goes back to the empty (disabled) player when cleared.
  ensureEmptyVideoPlayer(pane);
}

// Copy text to the clipboard. navigator.clipboard only exists in SECURE
// contexts (https / localhost); on plain-http LAN (the typical ComfyUI
// setup) it is either undefined OR exists but rejects — so the primary
// path is always tried, and the execCommand fallback is robust: a hidden
// textarea (position:absolute, but NOT display:none/opacity:0, which some
// browsers refuse to select) is focused + selected before the copy, then
// removed. Always shows explicit feedback.
function copyText(text) {
  if (!text) return showToast('Nothing to copy');
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '0';
    ta.style.top = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0.01';   // visible enough for select() on all engines
    ta.style.border = '0';
    ta.style.padding = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari needs this
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  };
  // Try the modern API first; if it is missing or rejects (plain-http
  // LAN / non-secure context), fall back.
  const done = (ok) => {
    if (ok) {
      if (typeof onUrlCopied === 'function') onUrlCopied(text); // hook: hint box / gallery box
    } else {
      showToast('Copy failed');
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => done(true),
      () => done(fallback())
    );
  } else {
    done(fallback());
  }
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
// without a required prompt (Upscale, the 🩹 Restore button, and Face swap
// — its prompt is an OPTIONAL suffix) stay enabled.
// While a generation runs (genLockActive) every action button is disabled
// instead, so this returns early (see setGeneratingUi).
function updateActionButtons() {
  if (genLockActive) return; // generation lock holds all buttons disabled
  const prompt = (activePromptInput()?.value || '').trim();
  const btnCol = document.getElementById('btnCol');
  if (!btnCol) return;
  if (currentTab === 'upscale' || currentTab === 'face_swap') return; // prompt never required
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
    if (input) { input.disabled = input.hasAttribute('data-always-disabled'); input.classList.remove('generating'); }
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
  let triggerFound = false;
  document.querySelectorAll('.btn-generate').forEach(b => {
    if (genTriggerId && b.id === genTriggerId) { makeStopButton(b); triggerFound = true; }
    else b.disabled = true;
  });
  if (!triggerFound) {
    // No trigger button matched — the page reloaded mid-generation and the
    // job was adopted (genTriggerId is null), or the trigger id is stale.
    // Turn the current primary action into the ⏹ stop button so the user
    // can always cancel the running job.
    const primary = document.querySelector('#btnCol .btn-generate') || document.querySelector('.btn-generate');
    if (primary) makeStopButton(primary);
  }
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

// ── Live progress (pushed over WebSocket, polling fallback) ──
// While a generation runs, the backend PUSHES every job update over
// /ws/progress (stage, step value/max, per-step preview, completion) and
// this paints them into the result URL row (the same area that shows the
// generation URL on completion). The old 1s polling of GET /api/progress
// is kept ONLY as an automatic fallback when the WS fails to connect
// (proxy / old server) — same payload shape, same painter, so the UI never
// notices which channel delivered the update.
//
// During the generation the 📋 copy button (disabled) is HIDDEN — the row
// shows the live progress text; when the generation settles the copy
// button comes back (enabled once a result URL is shown). The stop button
// is the action button itself transformed into ⏹ (see makeStopButton).
let progressTimer = null;   // polling fallback interval — ALSO the "job running" marker
let progressWs = null;      // the live progress WebSocket (null when closed/failed)
let userCancelled = false;
let _lastJobDurationSecs = 0; // total seconds of the last finished job (see timing.js)

// Per-tool handler to finalize a result whose fetch was lost (background
// tab / focus loss): called with the result {url, display} recovered from
// the backend after the job completed. Each tool registers its own.
let recoverHandler = null;
let recoverPending = false;  // a job's fetch died; backend still running
let _recoverSettleTimer = null; // safety-net timer for a stuck recovery (see applyProgress)
let _recoverRetryTimer = null;  // retry loop for a result not yet recorded (see tryRecoverResult)
let _recoverInFlight = false; // a recovery probe is in flight — no concurrent probes
function registerRecoverHandler(fn) { recoverHandler = fn; }
async function tryRecoverResult() {
  // Only runs when the original fetch is CONFIRMED dead (recoverPending):
  // while it is still in flight the normal .then() settles the result, and
  // recovering here too would double-finalize (duplicate gallery entries).
  // The in-flight guard matters because this function AWAITS before
  // clearing recoverPending: without it, concurrent calls (a poll of
  // applyProgress + visibilitychange, or the retry timer overlapping the
  // next poll) would ALL pass the guard, see the URL and each fire
  // recoverHandler — one video landing twice in galleryVideos.
  if (!recoverPending || !recoverHandler || progressTimer === null) return;
  if (_recoverInFlight) return; // a probe is already in flight — it will handle it
  _recoverInFlight = true;
  try {
    const r = await fetch('/api/last-result');
    const j = await r.json();
    // No URL yet → the job is still running or the backend hasn't recorded
    // the result yet. KEEP recoverPending and retry shortly: the backend
    // records the URL when the job completes (server._record_job_output),
    // so the next attempt finds it. (The old code cleared recoverPending
    // here, so a single early attempt — e.g. right after the job finished
    // but before the URL was recorded — permanently lost the result.)
    if (!j.url) {
      _recoverInFlight = false; // allow the retry timer + next poll to probe again
      clearTimeout(_recoverRetryTimer);
      _recoverRetryTimer = setTimeout(tryRecoverResult, 500);
      return;
    }
    // Build the same-origin display URL from the recovered {base}/view URL.
    const q = (j.url.split('?')[1] || '');
    const params = new URLSearchParams(q);
    const fn = params.get('filename');
    const type = params.get('type') || 'output';
    if (fn) {
      const res = { url: j.url, display: '/media/' + encodeURIComponent(fn) + '?type=' + type };
      // The recovery record carries the Face swap extracted-face preview
      // too (the backend stores job.face_url): hand it to the per-tool
      // finalize in the same shape as the direct API response.
      if (j.face_preview) {
        const qf = (String(j.face_preview).split('?')[1] || '');
        const pf = new URLSearchParams(qf);
        const ffn = pf.get('filename');
        const ftype = pf.get('type') || 'output';
        if (ffn) res.face_preview = { display: '/media/' + encodeURIComponent(ffn) + '?type=' + ftype };
      }
      recoverPending = false;
      recoverHandler(res);
    }
  } catch (e) { /* ignore */ }
  _recoverInFlight = false;
}

// ⏹ Cancel (the transformed action button): stop the backend job (POST
// /api/cancel — interrupt running + delete pending) and abort the in-flight
// fetch so the UI settles now.
function cancelGeneration() {
  userCancelled = true;
  stopProgressPolling();
  fetch('/api/cancel', { method: 'POST' }).catch(() => {});
  abortCurrentRequest();
  // Normally the tool's .finally() releases the UI when the fetch settles;
  // when the fetch already died (the 5min abort fired earlier) there is no
  // .finally to run, so release the lock here — ⏹ must always restore the UI.
  releaseGeneratingUi();
}

// ↺ Reset helper: if a generation is running (polling active), cancel the
// backend job and stop the live preview/progress polling so the reset
// leaves a clean pane — nothing (preview or result) reappears over the
// restored placeholder. Safe to call when idle (cancel is a no-op there).
function cancelIfRunning() {
  if (progressTimer) {
    fetch('/api/cancel', { method: 'POST' }).catch(() => {});
    // The in-flight fetch won't settle promptly (the backend keeps polling
    // ComfyUI until its own timeout) — release the lock now so the reset
    // leaves the app usable, not stuck in "generating".
    releaseGeneratingUi();
  } else {
    stopProgressPolling(); // idempotent no-op cleanup
  }
}

// The tab that started the current generation. The live per-step preview is
// captured for the job regardless of what the user does, but is only
// PAINTED while the active tab is the one that started it (requirement:
// "if the user switches tabs mid-generation, keep capturing but only show
// in the tab where it started"). tab -> output pane id (generate uses
// 'genOutputPane', the rest match by name).
const TAB_PANE_IDS = { generate: 'genOutputPane', edit: 'editOutputPane', upscale: 'upscaleOutputPane', video: 'videoOutputPane', face_swap: 'faceSwapOutputPane' };
let liveJobTab = null;
// Elements hidden while the live preview is painted (placeholder, previous
// result, source preview) so the preview fills the pane and stays centered;
// restored if the job is cancelled (stopProgressPolling) — never removed,
// so a cancel keeps the previous result visible.
let liveHidden = [];

function startProgressPolling() {
  stopProgressPolling();
  liveJobTab = currentTab; // tab that initiated the generation
  recoverPending = false;  // fresh job — the in-flight fetch is the primary channel
  _lastJobDurationSecs = 0; // a new job — no duration yet
  progressTimer = {}; // marker: a generation is running (cleared in stopProgressPolling)
  persistJobMarker(liveJobTab); // survives reloads / backgrounded-tab discards
  // Elapsed-time clock in the result row (1s precision while it runs).
  startElapsedClock(document.getElementById('resultTime'));
  openProgressWs();   // push channel — falls back to polling if it fails
  paintProgress();    // immediate paint (the WS snapshot arrives on connect too)
}

// Connect the live progress WebSocket. The backend pushes each job update
// (same payload as /api/progress); on any failure the job falls back to the
// classic 1s polling (wsProgressFailed) — the painter is shared, so the UI
// never notices which channel delivered the update.
function openProgressWs() {
  let ws;
  try {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws/progress');
  } catch (e) { wsProgressFailed(); return; }
  progressWs = ws;
  ws.onopen = () => {};
  ws.onmessage = ev => {
    let j;
    try { j = JSON.parse(ev.data); } catch (e) { return; }
    applyProgress(j);
  };
  ws.onerror = () => wsProgressFailed();
  ws.onclose = () => wsProgressFailed();
}

// The WS died (connect failure or mid-job drop): fall back to polling for
// the rest of this job. stopProgressPolling nulls progressWs FIRST, so a
// deliberate close never triggers this.
function wsProgressFailed() {
  if (!progressWs) return;
  progressWs = null;
  clearInterval(progressTimer);
  progressTimer = setInterval(paintProgress, 1000);
}

// Paint one progress payload (shared by the WS push and the polling
// fallback) into the result URL row + the live per-step preview. Named so
// visibilitychange can re-paint immediately when the tab regains focus.
function applyProgress(j) {
  const el = document.getElementById('resultUrl');
  if (!el) return;
  const a = j && j.active;
  if (!a) {
    // The job ended in a ComfyUI execution ERROR (e.g. CUDA OOM): terminal
    // — no result will ever come. Release the generating UI right away (the
    // backend also fails the in-flight fetch fast now; if it already died,
    // this is what unblocks the UI instead of the 60s safety net).
    if (j && j.error && !userCancelled) {
      recoverPending = false;
      clearTimeout(_recoverSettleTimer); _recoverSettleTimer = null;
      clearTimeout(_recoverRetryTimer); _recoverRetryTimer = null;
      showToast('❌ ' + j.error);
      releaseGeneratingUi();
      return;
    }
    // The job finished (active:null). If the original fetch was lost
    // (aborted/timed out), recover the result now — and keep retrying on
    // every poll until it is found (the backend records it on completion;
    // see server._record_job_output). The safety net below releases the UI
    // if the result genuinely cannot be found, so the user is never stuck
    // in "generating" forever.
    if (recoverPending) {
      tryRecoverResult();
      if (!_recoverSettleTimer) {
        // Last-resort safety net: if the result genuinely cannot be found
        // (backend never recorded it — e.g. both the HTTP handler and the
        // WS listener died), release the UI so the user is never stuck in
        // "generating" forever. 60s covers the backend's worst-case record
        // time (the record thread polls history for up to 60s).
        _recoverSettleTimer = setTimeout(() => {
          _recoverSettleTimer = null;
          if (recoverPending) {
            recoverPending = false;
            releaseGeneratingUi();
            showToast('⚠️ Generation finished, but the result could not be retrieved');
          }
        }, 60000);
      }
    }
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
  el.title = ''; // progress text is not a URL — no stale tooltip from a previous result
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
        // result, source preview, compare slider, video player. Overlays
        // (spinner, buttons) stay. liveHidden is restored by
        // stopProgressPolling on cancel.
        liveHidden = Array.from(pane.querySelectorAll('.result-img, .result-video, .video-player, .output-placeholder, .source-preview, .compare-slider'));
        liveHidden.forEach(el => { el.style.display = 'none'; });
        pv = document.createElement('img');
        pv.className = 'preview-live';
        pv.alt = 'Live preview';
        pane.appendChild(pv);
      }
      pv.src = a.preview;
    }
  }
  // Face swap extracted-face preview DURING the run: the workflow's second
  // output node ("Random Preview Image (face)") executes BEFORE the
  // sampling, so the backend pushes its /media path as soon as it exists
  // (job.face_preview). Paint it immediately — no need to wait for the
  // full swap — so the user can check the extraction early. Same tab
  // gating as the live per-step preview; finalize() re-paints the
  // authoritative overlay when the job lands.
  if (liveJobTab === 'face_swap' && currentTab === 'face_swap' && a.face_preview) {
    const pane = document.getElementById('faceSwapOutputPane');
    if (pane) {
      let ex = pane.querySelector('.face-extract-overlay');
      if (!ex) {
        ex = document.createElement('img');
        ex.className = 'face-extract-overlay';
        ex.alt = 'Extracted face';
        pane.appendChild(ex);
      }
      if (ex.src !== a.face_preview) ex.src = a.face_preview;
    }
  }
}

// Polling fallback: fetch the current job state and paint it. Only active
// when the WebSocket is unavailable (wsProgressFailed).
async function paintProgress() {
  try {
    const resp = await fetch('/api/progress');
    const j = await resp.json();
    applyProgress(j);
  } catch (e) { /* server busy — ignore */ }
}

// When the tab regains focus, re-paint immediately (setInterval is
// throttled/suspended in background tabs, which left the progress line
// frozen). Also re-assert the generation lock UI (a switch mid-job already
// handles the buttons; this covers the focus-loss case) and re-sync the
// galleries from the on-disk history (a backgrounded tab may have missed
// completions).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (progressTimer) {
    paintProgress();          // re-sync the progress line immediately
    tryRecoverResult();       // recover a result whose fetch died in background
  }
});

function stopProgressPolling() {
  clearInterval(progressTimer);
  progressTimer = null;
  // Stop the elapsed clock and remember the total generation time (1-decimal
  // seconds) — appended as a ⏱ chip to the result URL hint when the result
  // lands (see syncResultUrl in gallery.js). 0 when no clock was running.
  _lastJobDurationSecs = stopElapsedClock();
  // Stamp the duration onto the gallery entry for the tool that just
  // finished (the registrars run BEFORE this — they capture the result but
  // the clock had not stopped yet). The chip then survives tab switches /
  // gallery navigation / a refresh (persisted with the entry).
  if (_lastJobDurationSecs > 0 && liveJobTab && typeof _stampLastEntryDuration === 'function') {
    _stampLastEntryDuration(liveJobTab, _lastJobDurationSecs);
  }
  // The job settled (done / cancelled / reset): drop the recovery state and
  // the settle safety net, and forget the sessionStorage job marker so a
  // later reload does not try to adopt a job that no longer runs.
  recoverPending = false;
  clearTimeout(_recoverSettleTimer);
  _recoverSettleTimer = null;
  clearTimeout(_recoverRetryTimer);
  _recoverRetryTimer = null;
  clearJobMarker();
  // Close the live WS (if any). Null it FIRST so its onclose handler never
  // triggers the polling fallback.
  if (progressWs) { const w = progressWs; progressWs = null; try { w.close(); } catch (e) {} }
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

// ── Job marker (sessionStorage) ────────────
// Remembers that a generation is running and which tool started it, so a
// reloaded or backgrounded-tab-discarded page can re-adopt the backend job
// (adoptRunningJob) instead of losing track of it. sessionStorage (not
// localStorage): it is only meaningful while the session lives.
const JOB_MARKER_KEY = 'comfyTools.activeJob';

function persistJobMarker(tool) {
  try { sessionStorage.setItem(JOB_MARKER_KEY, JSON.stringify({ tool, startedAt: Date.now() })); } catch (e) {}
}

function clearJobMarker() {
  try { sessionStorage.removeItem(JOB_MARKER_KEY); } catch (e) {}
}

// Generic "generation is over" release, tool-agnostic: stops the progress
// tracking and restores every pane/button. Used by the recovery safety net
// and the reload-adoption finalize (the per-tool finalize functions perform
// their own release).
function releaseGeneratingUi() {
  stopProgressPolling();
  // A job settled WITHOUT a per-tool finalize (cancel / safety net / reload
  // adoption): drop an EARLY-painted extracted-face overlay here — nothing
  // will re-paint it. Deliberately NOT in stopProgressPolling: the per-tool
  // success finalize calls stopProgressPolling and then paints the
  // authoritative overlay, and the fetch's .finally() calls it AGAIN — a
  // cleanup there would erase the just-painted overlay (the preview
  // vanished when the swap finished). releaseGeneratingUi is never on the
  // per-tool success path.
  document.querySelectorAll('.face-extract-overlay').forEach(el => el.remove());
  ['genOutputPane', 'editOutputPane', 'upscaleOutputPane', 'videoOutputPane', 'faceSwapOutputPane'].forEach(id => {
    const p = document.getElementById(id);
    if (p) { p.classList.remove('busy'); p.classList.remove('generating'); }
  });
  document.querySelectorAll('.gen-spinner').forEach(s => s.classList.remove('show'));
  setGeneratingUi(false);
}

// Generic finalize for a job adopted after a page reload: shows the result
// in the tool's pane (no gallery registration — the session registries were
// rebuilt from localStorage) and releases the UI.
function finalizeRecoveredJob(tool, res) {
  const paneId = TAB_PANE_IDS[tool] || 'genOutputPane';
  const pane = document.getElementById(paneId);
  // Drop any empty (disabled) player before showing the recovered result
  // (the .video-player removal in showResult also covers it — this is just
  // explicit and runs even if the pane is missing).
  const emptyPlayer = pane && pane.querySelector('.video-empty-player');
  if (emptyPlayer) emptyPlayer.remove();
  showResult(paneId, res, tool === 'video');
  if (tool === 'video') {
    const vid = pane && pane.querySelector('.result-video');
    if (vid) vid.dataset.videoGallery = '1';
    if (currentTab !== 'video') pauseActiveVideo();
  }
  // Only image tools set lastGeneratedUrl: the 🔗 chain feeds Edit/Upscale/
  // Video, all of which need an IMAGE source (img2img / img2vid) — a
  // generated video is never a valid source.
  if (tool !== 'video') lastGeneratedUrl = res.url;
  // The hint is timing-only now; pass the gallery entry so its persisted
  // duration shows (there is no elapsed clock for an adopted job).
  syncResultUrl(tool, typeof paneCurrentEntry === 'function' ? paneCurrentEntry(tool) : { url: res.url });
  recoverPending = false;
  releaseGeneratingUi();
  showToast('✅ Generation finished');
}

// Adopt a generation that was running when the page (re)loaded: the browser
// can discard a backgrounded tab under memory pressure (reloading it on
// focus), or the user may reload mid-generation. sessionStorage remembers
// that a job was running and which tool started it; /api/progress tells
// whether the backend is still executing it. If so, re-establish the running
// UI + progress tracking and resolve the result via the recovery path (the
// backend records the result URL on completion, so /api/last-result always
// resolves it). Called from main.js after startup.
async function adoptRunningJob() {
  let marker = null;
  try { marker = JSON.parse(sessionStorage.getItem(JOB_MARKER_KEY) || 'null'); } catch (e) {}
  if (!marker || !marker.tool) return;
  try {
    const r = await fetch('/api/progress');
    const j = await r.json();
    if (!j.active) { clearJobMarker(); return; } // settled while we were gone — galleries restore results
    // The backend is still running that job: re-establish the tracking state.
    liveJobTab = marker.tool;
    recoverPending = true; // no in-flight fetch — resolve via recovery
    _lastJobDurationSecs = 0; // adopted job — no elapsed clock; keep the entry's persisted duration
    progressTimer = {};
    openProgressWs();
    paintProgress();
    setGeneratingUi(true, null); // lock the UI; the ⏹ fallback appears on the primary action
    registerRecoverHandler(res => finalizeRecoveredJob(marker.tool, res));
    showToast('⏳ Reconnected to a generation in progress…');
  } catch (e) { /* ignore */ }
}
