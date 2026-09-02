// ── Face swap tab 👨🏻 ──────────────────────
// POST /api/face-swap (base image + face image + steps/cfg/seed) → the
// swapped image shown in the pane.
//
// TWO source images, each with its own URL field + upload button:
//   • Picture 1 (BASE)   — the image being edited; previewed FULL-canvas.
//   • Picture 2 (FACE)   — the face to extract; previewed as a SMALL
//                          reference overlay box that floats just ABOVE the
//                          two source fields (bottom-left), ~10% wide.
// The prompt field is readonly (the workflow has a built-in head_swap
// prompt — see bottom_bar.html); params (👣 steps / 🎚️ CFG / 🌱 seed+🎲)
// live in the 👣 prompt-chip popover, like Edit.

const FS_PANE_ID = 'faceSwapOutputPane';

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
  pane.querySelectorAll('.source-preview, .result-img, .output-placeholder, .preview-live')
    .forEach(el => el.remove());
  const img = document.createElement('img');
  img.className = 'source-preview';
  img.alt = 'Base image preview';
  img.src = proxiedSrc(value);
  pane.insertBefore(img, pane.firstChild);
}

function fsPreviewFace(value) {
  const pane = document.getElementById(FS_PANE_ID);
  if (!pane) return;
  pane.querySelectorAll('.face-ref-overlay').forEach(el => el.remove());
  const img = document.createElement('img');
  img.className = 'face-ref-overlay';
  img.alt = 'Face reference';
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

// ── Action ─────────────────────────────────
function generateFaceSwap() {
  const base = fsSource('base');
  const face = fsSource('face');
  if (!base) return showToast('No base image — paste a URL, upload 🖼️ or use 🔗');
  if (!face) return showToast('No face image — paste a URL or upload with 👨🏻');
  const steps = parseInt(document.getElementById('fsSteps')?.value) || 6;
  const cfgRaw = parseFloat(document.getElementById('fsCfg')?.value);
  const cfg = (isNaN(cfgRaw) ? 1 : cfgRaw);
  const seedEl = document.getElementById('fsSeed');
  const randomEl = document.getElementById('fsSeedRandom');
  let seed;
  if (randomEl && randomEl.checked) {
    // 🎲 enabled → generate now and show the value that will be sent
    seed = randomSeed();
    if (seedEl) seedEl.value = seed;
  } else {
    seed = parseInt(seedEl?.value) || 0;
  }

  const pane = document.getElementById(FS_PANE_ID);
  const spinner = document.getElementById('faceSwapSpinner');
  const btn = document.getElementById('btnFaceSwap') || document.querySelector('#btnCol .btn-generate');
  if (btn) btn.disabled = true;
  pane.classList.add('busy');
  spinner.classList.add('show');
  setGenerating(pane, true);
  showToast('Face swap submitted to ComfyUI...');
  startProgressPolling();
  setGeneratingUi(true, 'btnFaceSwap');

  // Shared finalize (normal fetch OR focus-recovery of a lost job).
  function finalize(res) {
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
      cmp.dataset.prompt = '';
      // The base full preview is replaced by the slider's BEFORE side; the
      // FACE overlay stays as the reference.
      pane.querySelectorAll('.source-preview, .result-img, .output-placeholder, .preview-live')
        .forEach(el => el.remove());
      // Compare gallery: register the comparison (before/after pair).
      addCompareEntry({
        src: res.display,
        before: beforeSrc,
        prompt: '',
        kind: 'face_swap',
        tab: 'face_swap',
      });
      // Generated history: a face swap APPENDS a new entry (the original
      // base stays in the gallery — the swap is a new image).
      addFaceSwapEntry(res, beforeSrc);
    } else {
      // Defensive fallback: plain result (the markup always has the slider).
      pane.querySelectorAll('.source-preview, .face-ref-overlay, .output-placeholder, .preview-live')
        .forEach(el => el.remove());
      showResult(FS_PANE_ID, res, false);
    }
    lastGeneratedUrl = res.url;
    stopProgressPolling(); // captures the total duration BEFORE the hint is painted
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
    image: base, face, steps, cfg, seed,
  }).then(res => {
    finalize(res);
  }).catch(err => {
    const isAbort = err && err.name === 'AbortError';
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
function stepFsSeed(d) { const input = document.getElementById('fsSeed'); input.value = Math.max(0, parseInt(input.value) + d); _fsSyncChip(); }
function onFsSeedInput() {
  const input = document.getElementById('fsSeed');
  if (isNaN(parseInt(input.value))) input.value = 0;
  document.getElementById('fsSeedRandom').checked = false;
  input.disabled = false;
  _fsSyncChip();
}
function onFsSeedRandomToggle() {
  document.getElementById('fsSeed').disabled = document.getElementById('fsSeedRandom').checked;
  _fsSyncChip();
}

// ── ↺ Reset ───────────────────────────────
function resetFaceSwap() {
  // Cancel a running job + stop live preview/progress polling first, so the
  // cleared pane stays clean (nothing reappears over the placeholder).
  cancelIfRunning();
  document.getElementById('fsSteps').value = '6';
  document.getElementById('fsCfg').value = '1';
  document.getElementById('fsSeed').value = '0';
  document.getElementById('fsSeedRandom').checked = true;
  document.getElementById('fsSeed').disabled = true;
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
