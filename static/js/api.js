// ── API helper + shared UI (toast, result rendering) ──

// POST JSON to a backend endpoint. Aborts after 240s so a hung request
// never leaves the action button stuck.
async function api(path, body, timeoutMs) {
  const ctrl = new AbortController();
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
  }
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
// Removes only the previous result/placeholder — keeps overlays like the
// loading spinner (which lives inside the pane).
function showResult(paneId, result, isVideo) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  pane.querySelectorAll('.result-img, .result-video, .output-placeholder').forEach(el => el.remove());
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
  pane.querySelectorAll('.result-img, .result-video, .output-placeholder').forEach(el => el.remove());
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
