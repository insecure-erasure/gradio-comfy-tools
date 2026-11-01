// ── Face swap tab 👨🏻 ──────────────────────
// POST /api/face-swap (base image + face image + optional prompt +
// steps/cfg/seed) → the swapped image shown in the pane.
//
// TWO source images, each with its own URL field + upload button:
//   • Picture 1 (BASE)   — the image being edited; previewed FULL-canvas.
//   • Picture 2 (FACE)   — the face to extract; previewed as a SMALL
//                          reference overlay box that floats just ABOVE the
//                          two source fields (bottom-left), ~10% wide.
// The prompt is OPTIONAL: the workflow appends it after its built-in
// head_swap instructions (empty prompt = built-in only). Params (👣 steps /
// 🎚️ CFG / 🌱 seed+🎲) live in the 👣 prompt-chip popover, like Edit.
// When a face swap runs, the workflow's extracted-face preview (its SECOND
// output node, "Random Preview Image (face)") is shown as a SMALL box
// bottom-RIGHT, ABOVE the upload/chain overlay buttons — as soon as the
// extraction node executes (BEFORE the sampling finishes), so the user can
// verify the extraction early. Its PNG carries the alpha channel: the
// transparent pixels show a small gray-tile checkerboard behind it.

const FS_PANE_ID = 'faceSwapOutputPane';
// ColorMatch strength (0 = off, 1 = full). The UI sends it; API clients that
// omit it keep the workflow default (0 = no-op).
const FS_COLOR_MATCH_ID = 'fsColorMatch';
const FS_COLOR_MATCH_DEFAULT = 0.5;

// Natural dimensions of the two sources, shown as two discreet lines above
// the bottom-right action buttons (Base / Face). Each line appears once its
// image has loaded; the block disappears when neither source is previewed.
const fsSourceDims = { base: null, face: null };

function fsRenderDimensions() {
  const pane = document.getElementById(FS_PANE_ID);
  if (!pane) return;
  let box = pane.querySelector('.face-swap-dimensions');
  if (!fsSourceDims.base && !fsSourceDims.face) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.className = 'source-dimensions face-swap-dimensions';
    pane.appendChild(box);
  }
  const rows = [];
  if (fsSourceDims.base) {
    rows.push(`<div class="source-dim-row"><span class="source-dim-label">Base</span><span class="source-dim-value">${fsSourceDims.base.width} × ${fsSourceDims.base.height}</span></div>`);
  }
  if (fsSourceDims.face) {
    rows.push(`<div class="source-dim-row"><span class="source-dim-label">Face</span><span class="source-dim-value">${fsSourceDims.face.width} × ${fsSourceDims.face.height}</span></div>`);
  }
  box.innerHTML = rows.join('');
}

function fsSetDimensions(which, width, height) {
  if (!width || !height) { fsClearDimensions(which); return; }
  fsSourceDims[which] = { width, height };
  fsRenderDimensions();
}

function fsClearDimensions(which) {
  fsSourceDims[which] = null;
  fsRenderDimensions();
}

function fsInput(which) {
  return document.getElementById(which === 'face' ? 'faceSwapFaceUrl' : 'faceSwapSourceUrl');
}
function fsField(which) {
  const input = fsInput(which);
  return input ? input.closest('.source-url-field') : null;
}
function fsSource(which) {
  const input = fsInput(which);
  return input ? input.value.trim() : '';
}

// ── Previews ───────────────────────────────
// Base → full-canvas .source-preview (same treatment as the other tools'
// source previews); face → the .face-ref-overlay box (the API-level
// removal lists in api.js also clean it: showResult / clearPane).

function fsClearPreview(which) {
  const pane = document.getElementById(FS_PANE_ID);
  if (!pane) return;
  // Editing the field clears ITS OWN preview only — the other image (and
  // any result) stays until a new load replaces it.
  pane.querySelectorAll(which === 'face' ? '.face-ref-overlay' : '.source-preview')
    .forEach(el => el.remove());
  fsClearDimensions(which);
  const field = fsField(which);
  if (field) { clearTimeout(field._fsFlash); field.classList.remove('collapsed'); }
}

function fsPreviewBase(value) {
  const pane = document.getElementById(FS_PANE_ID);
  if (!pane) return;
  // Hide any compare slider and replace any previous result/placeholder/
  // base preview. The FACE overlay is deliberately kept — the two sources
  // are independent (and stays as the reference once a result lands).
  pane.querySelectorAll('.compare-slider').forEach(el => { el.style.display = 'none'; });
  pane.querySelectorAll('.source-preview, .result-img, .output-placeholder, .preview-live, .face-extract-overlay')
    .forEach(el => el.remove());
  fsClearDimensions('base');
  const img = document.createElement('img');
  img.className = 'source-preview';
  img.alt = 'Base image preview';
  img.addEventListener('load', () => {
    fsSetDimensions('base', img.naturalWidth, img.naturalHeight);
    // Keep the 🕘 history fresh once BOTH sources have a live preview (use
    // the value this preview was created for, not a possibly edited field).
    if (pane.querySelector('.face-ref-overlay')) {
      rememberFaceSwapHistory(value, fsSource('face'));
    }
  });
  img.addEventListener('error', () => fsClearDimensions('base'));
  img.src = proxiedSrc(value);
  pane.insertBefore(img, pane.firstChild);
}

function fsPreviewFace(value) {
  const pane = document.getElementById(FS_PANE_ID);
  if (!pane) return;
  pane.querySelectorAll('.face-ref-overlay').forEach(el => el.remove());
  // A new face source invalidates the extraction shown from the last run.
  pane.querySelectorAll('.face-extract-overlay').forEach(el => el.remove());
  fsClearDimensions('face');
  const img = document.createElement('img');
  img.className = 'face-ref-overlay';
  img.alt = 'Face reference';
  img.addEventListener('load', () => {
    fsSetDimensions('face', img.naturalWidth, img.naturalHeight);
    // Keep the 🕘 history fresh once BOTH sources have a live preview (use
    // the value this preview was created for, not a possibly edited field).
    if (pane.querySelector('.source-preview')) {
      rememberFaceSwapHistory(fsSource('base'), value);
    }
  });
  img.addEventListener('error', () => fsClearDimensions('face'));
  img.src = proxiedSrc(value);
  pane.appendChild(img);
}

// Collapse a source field back to 10% (like source.js collapseSourceField).
function fsCollapse(which) {
  const field = fsField(which);
  if (!field) return;
  clearTimeout(field._fsFlash);
  const input = field.querySelector('.source-url-input');
  if (input) input.blur();
  field.classList.add('collapsed');
}

// 🔗 flash: briefly expand the field with the filled URL, then collapse
// (unless the user is editing it).
function fsFlash(which) {
  const field = fsField(which);
  if (!field) return;
  clearTimeout(field._fsFlash);
  field.classList.remove('collapsed');
  field._fsFlash = setTimeout(() => {
    const input = field.querySelector('.source-url-input');
    if (input && document.activeElement === input) return; // user is editing
    if (input) input.blur();
    field.classList.add('collapsed');
  }, 1500);
}

// ✓ — validate the value server-side and show its preview (base full, face
// overlay). Same /api/check-image flow as source.js confirmSourceUrl.
async function fsConfirm(which) {
  const src = fsSource(which);
  const label = which === 'face' ? 'face' : 'base';
  if (!src) return showToast(`No ${label} image — paste or upload one first`);
  const field = fsField(which);
  const btn = field && field.querySelector('.source-url-confirm');
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try {
    const resp = await fetch('/api/check-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: src }),
    });
    const j = await resp.json();
    if (!j.ok) {
      showToast('❌ Not a valid image: ' + (j.error || 'unknown error'));
      return;
    }
    if (which === 'face') fsPreviewFace(src);
    else fsPreviewBase(src);
    fsCollapse(which); // collapse back after confirming
    showToast('✅ ' + (which === 'face' ? 'Face image loaded — reference set' : 'Base image loaded'));
  } catch (e) {
    showToast('❌ Check failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
  }
}

// 📁 upload → POST /api/upload (ComfyUI temp) → fill the field + preview.
function fsUpload(which) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const resp = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error(resp.statusText);
      const j = await resp.json();
      const field = fsInput(which);
      if (field) field.value = j.filename;
      if (which === 'face') fsPreviewFace(j.filename);
      else fsPreviewBase(j.filename);
      showToast(which === 'face' ? 'Face image uploaded — reference set' : 'Base image uploaded');
    } catch (e) {
      showToast('❌ Upload failed: ' + e.message);
    }
  };
  input.click();
}

// 🔗 use previous generation: fills the BASE field (Picture 1 — the image
// being edited), like the other tools' source chaining.
function fsUsePrevious() {
  const field = fsInput('base');
  if (lastGeneratedUrl && field) {
    field.value = lastGeneratedUrl;
    fsPreviewBase(lastGeneratedUrl);
    fsFlash('base');
    showToast('Source set to previous generation — image loaded');
  } else {
    showToast('No previous generation yet — generate an image first');
  }
}

// Restore a base+face pair from the 🕘 history popover (source.js).
function restoreFaceSwapHistorySource(entry) {
  if (!entry) return;
  const base = document.getElementById('faceSwapSourceUrl');
  const face = document.getElementById('faceSwapFaceUrl');
  if (base && entry.base) {
    base.value = entry.base;
    fsPreviewBase(entry.base);
    fsFlash('base');
  }
  if (face && entry.face) {
    face.value = entry.face;
    fsPreviewFace(entry.face);
    fsFlash('face');
  }
  showToast(entry.face ? 'Previous base + face restored' : 'Previous base restored');
}

// ── Action ─────────────────────────────────
function generateFaceSwap() {
  const base = fsSource('base');
  const face = fsSource('face');
  if (!base) return showToast('No base image — paste a URL, upload 🖼️ or use 🔗');
  if (!face) return showToast('No face image — paste a URL or upload with 👨🏻');
  // The exact pair just submitted is the most useful retry entry.
  rememberFaceSwapHistory(base, face);
  const promptInput = document.getElementById('promptInputFaceSwap');
  const prompt = (promptInput ? promptInput.value : '').trim();
  const steps = parseInt(document.getElementById('fsSteps')?.value) || 6;
  const cfgRaw = parseFloat(document.getElementById('fsCfg')?.value);
  const cfg = (isNaN(cfgRaw) ? 1 : cfgRaw);
  const seedEl = document.getElementById('fsSeed');
  const randomEl = document.getElementById('fsSeedRandom');
  let seed;
  try {
    // Seeds are decimal strings: uint64 stays exact (see seed.js).
    seed = (randomEl && randomEl.checked)
      ? randomSeedValue(SEED_MAX.face_swap)
      : parseSeedInput(seedEl?.value, SEED_MAX.face_swap);
  } catch (err) {
    return showToast(err.message);
  }
  setSeedValue('face_swap', seed);

  const pane = document.getElementById(FS_PANE_ID);
  const spinner = document.getElementById('faceSwapSpinner');
  const btn = document.getElementById('btnFaceSwap') || document.querySelector('#btnCol .btn-generate');
  if (btn) btn.disabled = true;
  pane.classList.add('busy');
  spinner.classList.add('show');
  setGenerating(pane, true);
  // Drop a stale extraction box from a previous result before the new run.
  pane.querySelectorAll('.face-extract-overlay').forEach(el => el.remove());
  showToast('Face swap submitted to ComfyUI...');
  startProgressPolling();
  setGeneratingUi(true, 'btnFaceSwap');

  // Shared finalize (normal fetch OR focus-recovery of a lost job).
  function finalize(res) {
    applyResolvedSeed('face_swap', res.seed);
    // The result is the before/after COMPARISON — base (before) vs swapped
    // (after), like Edit. The face reference overlay is KEPT on top-left.
    const beforeEl = document.getElementById('faceSwapBefore');
    const afterEl = document.getElementById('faceSwapAfter');
    const cmp = document.getElementById('faceSwapCompare');
    if (beforeEl && afterEl && cmp) {
      // Resolve the base through the SAME-ORIGIN proxy (/media) — the pane
      // cannot load the ComfyUI host URL directly (CORS/host validation).
      const beforeSrc = beforeProxyUrl(base);
      beforeEl.src = beforeSrc;
      afterEl.src = res.display;
      cmp.style.setProperty('--p', '50%');
      cmp.style.display = '';
      // Gallery marker: the result joins the compare gallery (identity =
      // AFTER image); kind is the face swap's own.
      cmp.dataset.gallery = '1';
      cmp.dataset.kind = 'face_swap';
      cmp.dataset.prompt = prompt;
      // The base full preview is replaced by the slider's BEFORE side; the
      // FACE overlay stays as the reference.
      pane.querySelectorAll('.source-preview, .result-img, .output-placeholder, .preview-live, .source-dimensions')
        .forEach(el => el.remove());
      // Compare gallery: register the comparison (before/after pair).
      addCompareEntry({
        src: res.display,
        before: beforeSrc,
        prompt,
        kind: 'face_swap',
        tab: 'face_swap',
      });
      // Generated history: a face swap APPENDS a new entry (the original
      // base stays in the gallery — the swap is a new image).
      addFaceSwapEntry(res, beforeSrc, prompt);
    } else {
      // Defensive fallback: plain result (the markup always has the slider).
      pane.querySelectorAll('.source-preview, .face-ref-overlay, .output-placeholder, .preview-live, .face-extract-overlay, .source-dimensions')
        .forEach(el => el.remove());
      showResult(FS_PANE_ID, res, false);
    }
    lastGeneratedUrl = res.url;
    rememberGeneratedImage(res.url); // 🕘 source history (base-only entry too)
    stopProgressPolling(); // captures the total duration BEFORE the hint is painted
    // Extracted-face preview (the workflow's "Random Preview Image (face)"
    // output — the face region with its alpha): a small overlay box
    // bottom-right, ABOVE the upload/chain buttons (which stay clickable),
    // so the user can verify the extraction that fed the swap. The NORMAL
    // response carries face_preview and replaces any EARLY overlay painted
    // by the live progress; the recovery path delivers only {url, display}
    // (or face_preview when the backend record had it) — there the early
    // overlay (painted from the same run's executed event) is KEPT, never
    // wiped, so the extraction does not vanish when the job settles
    // through recovery.
    if (res.face_preview && res.face_preview.display) {
      pane.querySelectorAll('.face-extract-overlay').forEach(el => el.remove());
      const extract = document.createElement('img');
      extract.className = 'face-extract-overlay';
      extract.alt = 'Extracted face';
      extract.src = res.face_preview.display; // same-origin /media proxy
      pane.appendChild(extract);
    }
    syncResultUrl('face_swap', { url: res.url });
    showToast('🔄 Face swapped');
    if (btn) btn.disabled = false;
    pane.classList.remove('busy');
    spinner.classList.remove('show');
    setGenerating(pane, false);
    setGeneratingUi(false);
  }
  registerRecoverHandler(finalize);

  api('/api/face-swap', {
    image: base, face, prompt, steps, cfg, seed,
    color_match: getFsColorMatchValue(),
  }).then(res => {
    finalize(res);
  }).catch(err => {
    const isAbort = err && err.name === 'AbortError';
    if (!userCancelled && err && err.isHttp && err.status === 408) {
      // The backend's own wait timed out (a long job) — ComfyUI may
      // still be running and the WS listener records the result on
      // completion; enter recovery like a lost fetch.
      recoverPending = true;
      return;
    }
    if (!userCancelled && err && err.isHttp) {
      // The backend answered with a REAL failure (e.g. ComfyUI OOM /
      // validation error / unreachable) — the job is dead, nothing
      // will finish: terminal. .finally releases the UI.
      syncResultUrl('w+', null);
      showToast('❌ ' + (err.message || 'Generation failed'));
      return;
    }
    if (isAbort && !userCancelled) {
      recoverPending = true; // job still running — resolve on completion
      return;
    }
    if (!userCancelled) {
      // Transport error — the backend still polls ComfyUI and records the
      // result on completion; enter recovery (see video.js catch).
      recoverPending = true;
      showToast('⚠️ Connection lost — waiting for the result…');
      return;
    }
    syncResultUrl('w+', null);
    showToast('❌ ' + (isAbort ? (userCancelled ? 'Cancelled' : 'Timed out — try again') : (err.message || err)));
  }).finally(() => {
    userCancelled = false;
    if (!recoverPending) {
      stopProgressPolling();
      if (btn) btn.disabled = false;
      pane.classList.remove('busy');
      spinner.classList.remove('show');
      setGenerating(pane, false);
      setGeneratingUi(false);
    }
  });
}

// ── Steppers (CFG / steps / seed) ──────────
function _fsSyncChip() { if (typeof updatePromptChips === 'function') updatePromptChips(); }
function stepFsCfg(d) {
  const input = document.getElementById('fsCfg');
  const v = Math.round((parseFloat(input.value || '1') + d) * 10) / 10; // 0.1 steps
  input.value = isNaN(v) ? 1 : Math.min(8, Math.max(0, v)); // floor 0
  _fsSyncChip();
}
function onFsCfgInput() {
  const input = document.getElementById('fsCfg');
  const v = parseFloat(input.value);
  if (isNaN(v)) input.value = 1;
  if (v < 0) input.value = 0;
  if (v > 8) input.value = 8;
  _fsSyncChip();
}
function stepFsSteps(d) { const input = document.getElementById('fsSteps'); input.value = Math.min(15, Math.max(1, parseInt(input.value) + d)); _fsSyncChip(); }
function onFsStepsInput() {
  const input = document.getElementById('fsSteps');
  const v = parseInt(input.value);
  if (isNaN(v) || v < 1) input.value = 1;
  if (v > 15) input.value = 15;
  _fsSyncChip();
}
function stepFsSeed(d) {
  const input = document.getElementById('fsSeed');
  setSeedValue('face_swap', stepSeedInput(input.value, d, SEED_MAX.face_swap));
  _fsSyncChip();
}
function onFsSeedInput() {
  const input = document.getElementById('fsSeed');
  document.getElementById('fsSeedRandom').checked = false;
  input.disabled = false;
  _fsSyncChip();
}
function onFsSeedRandomToggle() {
  document.getElementById('fsSeed').disabled = document.getElementById('fsSeedRandom').checked;
  _fsSyncChip();
}

// ── Color match strength ───────────────────
function _fsColorMatchNumber(el, fallback = 0) {
  const n = parseFloat(el ? el.value : '');
  return Number.isFinite(n) ? Math.min(1, Math.max(0, Math.round(n * 100) / 100)) : fallback;
}
function getFsColorMatchValue() {
  return _fsColorMatchNumber(document.getElementById(FS_COLOR_MATCH_ID), 0);
}
function stepFsColorMatch(d) {
  const el = document.getElementById(FS_COLOR_MATCH_ID);
  if (!el) return;
  const next = Math.min(1, Math.max(0, Math.round((_fsColorMatchNumber(el) + d) * 100) / 100));
  el.value = String(next);
  _fsSyncChip();
  if (typeof savePersistedState === 'function') savePersistedState();
}
function onFsColorMatchInput() {
  const el = document.getElementById(FS_COLOR_MATCH_ID);
  if (!el) return;
  const n = parseFloat(el.value);
  if (el.value !== '' && Number.isFinite(n) && n >= 0 && n <= 1) {
    _fsSyncChip();
    return;
  }
  if (el.value !== '') {
    el.value = String(Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0)));
  }
  _fsSyncChip();
}

// ── ↺ Reset ───────────────────────────────
function resetFaceSwap() {
  // Cancel a running job + stop live preview/progress polling first, so the
  // cleared pane stays clean (nothing reappears over the placeholder).
  cancelIfRunning();
  document.getElementById('fsSteps').value = '6';
  document.getElementById('fsCfg').value = '1';
  setSeedValue('face_swap', '0');
  document.getElementById('fsSeedRandom').checked = true;
  document.getElementById('fsSeed').disabled = true;
  const colorMatch = document.getElementById(FS_COLOR_MATCH_ID);
  if (colorMatch) colorMatch.value = String(FS_COLOR_MATCH_DEFAULT);
  clearPane(FS_PANE_ID); // drops the previews (base + face overlay) and any result
  syncResultUrl('face_swap', null); // no image shown — no URL hint
  _fsSyncChip();
  showToast('Face swap parameters reset');
}

// ── Source field wiring ────────────────────
// Same behaviors as the other tools' source fields (source.js): select-all
// on focus, keep-visible-above-keyboard on mobile, Enter = ✓ confirm.
function initFaceSwapFields() {
  ['base', 'face'].forEach(which => {
    const input = fsInput(which);
    if (!input) return;
    selectAllOnFocus(input);
    keepSourceFieldVisible(input);
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // a plain text input — no submit; keep it explicit
      const field = fsField(which);
      const btn = field && field.querySelector('.source-url-confirm');
      if (btn && btn.disabled) return; // a check is already in flight
      fsConfirm(which);
    });
  });
}
document.addEventListener('DOMContentLoaded', initFaceSwapFields);
