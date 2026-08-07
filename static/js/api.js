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
// the loading spinner (which lives inside the pane).
function showResult(paneId, result, isVideo) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  pane.querySelectorAll('.result-img, .result-video, .output-placeholder, .source-preview').forEach(el => el.remove());
  if (isVideo) {
    const v = document.createElement('video');
    v.className = 'result-video';
    v.src = result.display;
    v.controls = true;
    v.autoplay = true;
    v.loop = true;
    v.muted = true;
    pane.appendChild(v);
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
  pane.querySelectorAll('.result-img, .result-video, .output-placeholder, .source-preview').forEach(el => el.remove());
  pane.querySelectorAll('.compare-slider').forEach(el => el.style.display = 'none');
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

// ✕ clears the prompt textarea (shared, single instance).
function clearPrompt() {
  const input = document.getElementById('promptInput');
  if (input) input.value = '';
  updateActionButtons();
  input.focus();
}

// Disable/enable the action buttons that require a prompt. Tabs/buttons
// without a prompt (Upscale, and the 🩹 Restore button) stay enabled.
function updateActionButtons() {
  const prompt = (document.getElementById('promptInput')?.value || '').trim();
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
// During the generation the 📋 copy button (disabled) is REPLACED by the ⏹
// stop button; when the generation settles the copy button comes back
// (enabled once a result URL is shown).
let progressTimer = null;
let userCancelled = false;

function setCancelVisible(on) {
  const cancel = document.getElementById('btnCancel');
  const copy = document.getElementById('btnCopyUrl');
  if (cancel) cancel.style.display = on ? 'inline-flex' : 'none';
  if (copy) copy.style.display = on ? 'none' : '';
}

// ⏹ Cancel: stop the backend job (POST /api/cancel — interrupt running +
// delete pending) and abort the in-flight fetch so the UI settles now.
function cancelGeneration() {
  userCancelled = true;
  stopProgressPolling();
  fetch('/api/cancel', { method: 'POST' }).catch(() => {});
  abortCurrentRequest();
}

function startProgressPolling() {
  stopProgressPolling();
  setCancelVisible(true);
  const paint = async () => {
    try {
      const resp = await fetch('/api/progress');
      const j = await resp.json();
      const el = document.getElementById('resultUrl');
      if (!el) return;
      const a = j.active;
      if (!a) return; // no active job — leave the last painted text until the request settles
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
    } catch (e) { /* server busy — ignore */ }
  };
  paint();
  progressTimer = setInterval(paint, 1000);
}

function stopProgressPolling() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  setCancelVisible(false);
}
