// ── Edit tab 🖍️ ───────────────────────────
// POST /api/edit (mode: edit | restore | extend) -> before/after compare slider.

// ── Extend padding controls ────────────────
// The padding/feathering controls live in the ⛶ chip popover. A plain click
// changes one pixel; holding the stepper accelerates through powers of two.
const EDIT_PAD_IDS = {
  top: 'editPadTop', bottom: 'editPadBottom', left: 'editPadLeft', right: 'editPadRight',
};
const EDIT_PAD_MAX = 1024;
const EDIT_FEATHER_ID = 'editFeather';
const EDIT_FEATHER_MAX = 256;
const EDIT_PAD_STEP_SIZES = [1, 2, 4, 8, 16, 32, 64];
const EDIT_FEATHER_STEP_SIZES = [1, 2, 4, 8, 16];

// Live Extend preview (⛶ popover). The dashed frame is the FINAL canvas
// (centered in the pane) and the source image sits at its REAL padding
// offset inside it, so asymmetric padding is visible. The frame/guide are
// static markup in tab_edit.html (#editExtendPreview).
// `bottom` leaves room for the source URL field + 📁/🔗 buttons.
const EXTEND_PREVIEW_SAFE = { left: 12, right: 12, top: 12, bottom: 56 };
let _extendPreviewRaf = 0;

let _editStepCfg = null;
let _editStepTimer = null;
let _editStepInterval = null;
let _editStepGuarded = false;

function getEditPadValue(field) {
  const el = document.getElementById(EDIT_PAD_IDS[field]);
  const n = parseInt(el?.value, 10);
  return Number.isFinite(n) ? Math.min(EDIT_PAD_MAX, Math.max(0, n)) : 0;
}

function getEditFeatherValue() {
  const el = document.getElementById(EDIT_FEATHER_ID);
  const n = parseInt(el?.value, 10);
  return Number.isFinite(n) ? Math.min(EDIT_FEATHER_MAX, Math.max(0, n)) : 0;
}

function _setEditStepValue(field, value) {
  const isFeather = field === 'feather';
  const id = isFeather ? EDIT_FEATHER_ID : EDIT_PAD_IDS[field];
  const max = isFeather ? EDIT_FEATHER_MAX : EDIT_PAD_MAX;
  const el = document.getElementById(id);
  if (!el) return;
  el.value = String(Math.min(max, Math.max(0, Math.trunc(value))));
  updatePromptChips();
}

function _stepEditValue(field, delta) {
  const current = field === 'feather' ? getEditFeatherValue() : getEditPadValue(field);
  _setEditStepValue(field, current + delta);
}

function _editRepeat() {
  const c = _editStepCfg;
  if (!c) { stopEditPadStep(); return; }
  c.ticks++;
  const stage = Math.min(Math.floor((c.ticks - 1) / 8), c.stepSizes.length - 1);
  _stepEditValue(c.field, c.delta * c.stepSizes[stage]);
  const ms = Math.max(25, 80 - c.ticks * 2);
  clearInterval(_editStepInterval);
  _editStepInterval = setInterval(_editRepeat, ms);
}

function _ensureEditStepGuards() {
  if (_editStepGuarded) return;
  _editStepGuarded = true;
  document.addEventListener('pointerup', stopEditPadStep);
  document.addEventListener('pointercancel', stopEditPadStep);
  window.addEventListener('blur', stopEditPadStep);
}

function _startEditStep(field, delta, stepSizes, ev) {
  if (ev) ev.preventDefault(); // no text selection / focus steal on hold
  _ensureEditStepGuards();
  stopEditPadStep();
  _stepEditValue(field, delta); // instant first step (plain click = 1 px)
  _editStepCfg = { field, delta, stepSizes, ticks: 0 };
  _editStepTimer = setTimeout(() => {
    _editStepInterval = setInterval(_editRepeat, 80);
  }, 400);
}

function startEditPadStep(field, delta, ev) {
  _startEditStep(field, delta, EDIT_PAD_STEP_SIZES, ev);
}

function startEditFeatherStep(delta, ev) {
  _startEditStep('feather', delta, EDIT_FEATHER_STEP_SIZES, ev);
}

function stopEditPadStep() {
  if (_editStepTimer) { clearTimeout(_editStepTimer); _editStepTimer = null; }
  if (_editStepInterval) { clearInterval(_editStepInterval); _editStepInterval = null; }
  _editStepCfg = null;
}

function onEditPadInput(field) {
  const id = EDIT_PAD_IDS[field];
  const el = document.getElementById(id);
  if (!el) return;
  const n = parseInt(el.value, 10);
  el.value = String(Number.isFinite(n) ? Math.min(EDIT_PAD_MAX, Math.max(0, n)) : 0);
  updatePromptChips();
}

function onEditFeatherInput() {
  const el = document.getElementById(EDIT_FEATHER_ID);
  if (!el) return;
  const n = parseInt(el.value, 10);
  el.value = String(Number.isFinite(n) ? Math.min(EDIT_FEATHER_MAX, Math.max(0, n)) : 0);
  updatePromptChips();
}

function readEditExtendParams() {
  return {
    left: getEditPadValue('left'),
    top: getEditPadValue('top'),
    right: getEditPadValue('right'),
    bottom: getEditPadValue('bottom'),
    feathering: getEditFeatherValue(),
  };
}

// Mirror ImageScaleToTotalPixels (ComfyUI counts a "megapixel" as 1024²).
function scaleToTotalPixels(width, height, megapixels) {
  const total = megapixels * 1024 * 1024;
  const scale = Math.sqrt(total / (width * height));
  return [Math.round(width * scale), Math.round(height * scale)];
}

function estimateExtendOutputDims(source, params) {
  const [workWidth, workHeight] = scaleToTotalPixels(source.width, source.height, 1.5);
  const paddedWidth = workWidth + params.left + params.right;
  const paddedHeight = workHeight + params.top + params.bottom;

  if (source.width * source.height > 1000000) {
    // The workflow restores the source density on the extended canvas.
    const outWidth = Math.min(16384, Math.max(1, Math.trunc(source.width * paddedWidth / workWidth)));
    const outHeight = Math.min(16384, Math.max(1, Math.trunc(source.height * paddedHeight / workHeight)));
    return [outWidth, outHeight];
  }

  // Below 1 MP the workflow keeps the ~1 MP decoded output; Flux2's empty
  // latent rounds the working dimensions down to a multiple of 16.
  const [scaledWidth, scaledHeight] = scaleToTotalPixels(paddedWidth, paddedHeight, 1.0);
  return [
    Math.max(16, Math.floor(scaledWidth / 16) * 16),
    Math.max(16, Math.floor(scaledHeight / 16) * 16),
  ];
}

function updateEditExtendInfo() {
  const sourceEl = document.getElementById('editExtendSourceDims');
  const outputEl = document.getElementById('editExtendOutputDims');
  const source = typeof getSourceDimensions === 'function' ? getSourceDimensions('edit') : null;
  if (sourceEl) sourceEl.textContent = source ? `${source.width} × ${source.height}` : '—';
  if (outputEl) {
    if (!source) {
      outputEl.textContent = '—';
    } else {
      const [outWidth, outHeight] = estimateExtendOutputDims(source, readEditExtendParams());
      outputEl.textContent = `${outWidth} × ${outHeight}`;
    }
  }
  // The live frame follows the same controls + source dimensions.
  updateEditExtendPreview();
}

// ── Live Extend preview ────────────────────
// Geometry of the dashed frame drawn over the source preview while the
// ⛶ popover is open. Padding is expressed in pixels of the 1.5 MP WORKING
// canvas (the workflow scales the source before padding it), so it must be
// converted to source-image pixels: pad_src = pad_work * src / work.
function _extendPreviewGeometry(pane) {
  const img = pane.querySelector('img.source-preview');
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;

  const params = readEditExtendParams();
  if (!(params.left || params.top || params.right || params.bottom)) return null;

  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const [workW, workH] = scaleToTotalPixels(srcW, srcH, 1.5);

  // x and y are converted independently (the workflow's source-density
  // restore uses the same original/pre-pad ratio per axis).
  const pl = params.left * srcW / workW;
  const pr = params.right * srcW / workW;
  const pt = params.top * srcH / workH;
  const pb = params.bottom * srcH / workH;

  const extW = srcW + pl + pr;
  const extH = srcH + pt + pb;

  const safe = EXTEND_PREVIEW_SAFE;
  const availW = pane.clientWidth - safe.left - safe.right;
  const availH = pane.clientHeight - safe.top - safe.bottom;
  if (availW <= 0 || availH <= 0) return null;

  // Fit the EXTENDED canvas in the free area (the source shrinks with it),
  // so even the maximum padding stays fully visible.
  const scale = Math.min(availW / extW, availH / extH);
  if (!(scale > 0)) return null;

  const frameW = extW * scale;
  const frameH = extH * scale;

  return {
    img,
    frameLeft: safe.left + (availW - frameW) / 2,
    frameTop: safe.top + (availH - frameH) / 2,
    frameW,
    frameH,
    // Strategy B: the source's real offset inside the frame.
    srcLeft: pl * scale,
    srcTop: pt * scale,
    srcW: srcW * scale,
    srcH: srcH * scale,
  };
}

function clearEditExtendPreview() {
  const pane = document.getElementById('editOutputPane');
  const box = document.getElementById('editExtendPreview');
  if (box) box.style.display = 'none';
  if (!pane) return;
  pane.classList.remove('extend-previewing');
  pane.querySelectorAll('img.source-preview[data-extend-preview]').forEach(img => {
    img.style.position = '';
    img.style.width = '';
    img.style.height = '';
    img.style.left = '';
    img.style.top = '';
    img.style.margin = '';
    delete img.dataset.extendPreview;
  });
}

function updateEditExtendPreview() {
  const pane = document.getElementById('editOutputPane');
  const box = document.getElementById('editExtendPreview');
  if (!pane || !box) return;

  // Only while the ⛶ chip popover (the controls that define the padding) is
  // open on the Edit tab.
  const active = currentTab === 'edit'
    && typeof chipPopoverKind !== 'undefined'
    && chipPopoverKind === 'extend';
  const geom = active ? _extendPreviewGeometry(pane) : null;
  if (!geom) { clearEditExtendPreview(); return; }

  box.style.display = 'block';
  box.style.left = geom.frameLeft + 'px';
  box.style.top = geom.frameTop + 'px';
  box.style.width = geom.frameW + 'px';
  box.style.height = geom.frameH + 'px';

  const guide = document.getElementById('editExtendPreviewSource');
  if (guide) {
    guide.style.left = geom.srcLeft + 'px';
    guide.style.top = geom.srcTop + 'px';
    guide.style.width = geom.srcW + 'px';
    guide.style.height = geom.srcH + 'px';
  }

  // Reposition the actual preview image inside the frame. Absolute so it no
  // longer participates in the pane's flex centering; clearing restores it.
  Object.assign(geom.img.style, {
    position: 'absolute',
    width: geom.srcW + 'px',
    height: geom.srcH + 'px',
    left: (geom.frameLeft + geom.srcLeft) + 'px',
    top: (geom.frameTop + geom.srcTop) + 'px',
    margin: '0',
  });
  geom.img.dataset.extendPreview = '1';
  pane.classList.add('extend-previewing');
}

// Keep the frame in sync on window resize / rotation / relayout. rAF
// coalesces the rapid updates from the accelerated steppers.
function scheduleEditExtendPreview() {
  if (_extendPreviewRaf) return;
  _extendPreviewRaf = requestAnimationFrame(() => {
    _extendPreviewRaf = 0;
    updateEditExtendPreview();
  });
}

window.addEventListener('resize', scheduleEditExtendPreview);
if (typeof ResizeObserver === 'function') {
  const _editPane = document.getElementById('editOutputPane');
  if (_editPane) new ResizeObserver(scheduleEditExtendPreview).observe(_editPane);
}

// Extend results have a different canvas size than the source, so the
// overlay slider is replaced by an Original/Extended toggle (one image at a
// time). The slider container is reused for the two <img> layers.
function setEditExtendView(showOriginal) {
  const slider = document.getElementById('editCompare');
  const originalBtn = document.getElementById('editExtendOriginalBtn');
  const resultBtn = document.getElementById('editExtendResultBtn');
  const original = !!showOriginal;
  if (slider) slider.classList.toggle('show-original', original);
  if (originalBtn) {
    originalBtn.classList.toggle('active', original);
    originalBtn.setAttribute('aria-pressed', String(original));
  }
  if (resultBtn) {
    resultBtn.classList.toggle('active', !original);
    resultBtn.setAttribute('aria-pressed', String(!original));
  }
}

function configureEditExtendToggle(enabled) {
  const slider = document.getElementById('editCompare');
  const toggle = document.getElementById('editExtendToggle');
  const on = !!enabled;
  if (slider) {
    slider.classList.toggle('extend-toggle-mode', on);
    if (!on) slider.classList.remove('show-original');
  }
  if (toggle) toggle.style.display = on ? 'flex' : 'none';
  if (on) setEditExtendView(false); // default: show the extended result
}

function generateEdit(forceMode) {
  const src = getSourceUrl('edit');
  if (!src) return showToast('No source image — paste a URL or use 🔗/📁');
  rememberSourceHistory('edit', src);
  const mode = forceMode || 'edit';
  const extendParams = mode === 'extend' ? readEditExtendParams() : null;
  if (extendParams && !(extendParams.left || extendParams.top || extendParams.right || extendParams.bottom)) {
    return showToast('Set at least one edge to extend');
  }
  const steps = parseInt(document.getElementById('editSteps')?.value) || 6;
  const seedEl = document.getElementById('editSeed');
  const randomEl = document.getElementById('editSeedRandom');
  let seed;
  try {
    // Seeds are decimal strings: uint64 stays exact (see seed.js).
    seed = (randomEl && randomEl.checked)
      ? randomSeedValue(SEED_MAX.edit)
      : parseSeedInput(seedEl?.value, SEED_MAX.edit);
  } catch (err) {
    return showToast(err.message);
  }
  setSeedValue('edit', seed);
  const prompt = activePromptInput()?.value || '';
  // Advanced modal (⚙️): LoRA config
  const adv = (window.advancedValues && window.advancedValues.edit) || {};
  const loraConfig = adv.lora || '[]';

  const triggerId = mode === 'restore' ? 'btnRestore' : mode === 'extend' ? 'btnExtend' : 'btnEdit';
  const pane = document.getElementById('editOutputPane');
  const spinner = document.getElementById('editSpinner');
  const btn = document.getElementById(triggerId) || document.querySelector('#btnCol .btn-generate');
  if (btn) btn.disabled = true;
  pane.classList.add('busy');
  spinner.classList.add('show');
  setGenerating(pane, true);
  const modeLabel = mode === 'restore' ? 'Restore' : mode === 'extend' ? 'Extend' : 'Edit';
  showToast(modeLabel + ' submitted to ComfyUI...');
  startProgressPolling();
  setGeneratingUi(true, triggerId);

  // Shared finalize (normal fetch OR focus-recovery of a lost job).
  function finalizeEdit(res) {
    applyResolvedSeed('edit', res.seed);
    // Compare slider: source (before) vs edited (after) — this IS the result.
    const beforeEl = document.getElementById('editBefore');
    const afterEl = document.getElementById('editAfter');
    const cmp = document.getElementById('editCompare');
    if (beforeEl && afterEl) {
      // The AFTER label follows the mode (Edit / Restore / Extend).
      const afterLabel = document.getElementById('editCompareAfterLabel');
      if (afterLabel) afterLabel.textContent = mode === 'restore' ? 'Restored' : mode === 'extend' ? 'Extended' : 'Edited';
      // Resolve the source through the SAME-ORIGIN proxy (/media) — the
      // pane cannot load the ComfyUI host URL directly (CORS/host
      // validation). beforeProxyUrl handles external URLs, /media/..,
      // {base}/view?.. and bare temp filenames.
      const beforeSrc = beforeProxyUrl(src);
      beforeEl.src = beforeSrc;
      afterEl.src = res.display;
      cmp.style.setProperty('--p', '50%');
      cmp.style.display = '';
      // Extend uses a toggle (different canvas sizes); the other modes keep
      // the overlay slider.
      configureEditExtendToggle(mode === 'extend');
      // Gallery marker: the edited/restored result joins the compare
      // gallery (identity = AFTER image); kind is the actual mode.
      cmp.dataset.gallery = '1';
      cmp.dataset.kind = mode; // 'edit' | 'restore' | 'extend'
      cmp.dataset.prompt = prompt;
      // Compare gallery: register the comparison in the session registry.
      addCompareEntry({
        src: res.display,
        before: beforeSrc,
        prompt,
        kind: mode, // 'edit' | 'restore' | 'extend'
        tab: 'edit',
      });
      // Generated history: an edit/restore APPENDS a new entry — the
      // original generation stays in the gallery (the edited image is a new
      // image). The edit/restore text is the bottom caption; if the source
      // was a gallery image, its prompt becomes the badge hover hint.
      appendTransformedEntry(res, prompt, mode === 'restore' ? 'restored' : mode === 'extend' ? 'extended' : 'edited', src);
    }
    // Hide any plain result image; the compare slider is the display. The
    // live Extend frame goes with the source preview (the static overlay
    // would otherwise stay floating over the result).
    clearEditExtendPreview();
    pane.querySelectorAll('.result-img, .output-placeholder, .source-preview, .source-dimensions').forEach(el => el.remove());
    lastGeneratedUrl = res.url;
    stopProgressPolling(); // captures the total duration BEFORE the hint is painted
    syncResultUrl('edit', { url: res.url });
    showToast(mode === 'restore' ? '✨ Restored' : mode === 'extend' ? '✨ Extended' : '✨ Edited');
    if (btn) btn.disabled = false;
    pane.classList.remove('busy');
    spinner.classList.remove('show');
    setGenerating(pane, false);
    setGeneratingUi(false);
  }
  registerRecoverHandler(finalizeEdit);

  const payload = {
    image: src, mode, prompt, steps, seed, lora_config: loraConfig,
  };
  if (extendParams) Object.assign(payload, extendParams);
  api('/api/edit', payload).then(res => {
    finalizeEdit(res);
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

// ── Steppers + seed ───────────────────────
function stepEditSteps(d) { const input = document.getElementById('editSteps'); input.value = Math.min(15, Math.max(1, parseInt(input.value) + d)); updatePromptChips(); }
function onEditStepsInput() {
  const input = document.getElementById('editSteps');
  const v = parseInt(input.value);
  if (isNaN(v) || v < 1) input.value = 1;
  if (v > 15) input.value = 15;
  updatePromptChips();
}
function stepEditSeed(d) {
  const input = document.getElementById('editSeed');
  setSeedValue('edit', stepSeedInput(input.value, d, SEED_MAX.edit));
  updatePromptChips();
}
function onEditSeedInput() {
  const input = document.getElementById('editSeed');
  document.getElementById('editSeedRandom').checked = false;
  input.disabled = false;
  updatePromptChips();
}
function onEditSeedRandomToggle() {
  document.getElementById('editSeed').disabled = document.getElementById('editSeedRandom').checked;
  updatePromptChips();
}

// ── ↺ Reset ───────────────────────────────
function resetEdit() {
  // Cancel a running job + stop live preview/progress polling first, so the
  // cleared pane stays clean (nothing reappears over the placeholder).
  cancelIfRunning();
  stopEditPadStep();
  document.getElementById('editSteps').value = '6';
  setSeedValue('edit', '0');
  document.getElementById('editSeedRandom').checked = true;
  document.getElementById('editSeed').disabled = true;
  Object.values(EDIT_PAD_IDS).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '0';
  });
  const feather = document.getElementById(EDIT_FEATHER_ID);
  if (feather) feather.value = '40';
  clearPane('editOutputPane');
  syncResultUrl('edit', null); // no image shown — no URL hint
  updatePromptChips();
  showToast('Edit parameters reset');
}
