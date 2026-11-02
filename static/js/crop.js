// ── Crop editor ────────────────────────────────────────────────────────────
// The selection is source-image pixels (crop-geometry.js); the stage is sized
// to the rendered image, so the box uses percentages and stays correct across
// window resizes and phone rotation. Desktop: inline in the Edit pane.
// <1024px: the same overlay is fullscreen (responsive.css).
//
// openCropEditor({ image, proxy, label, onApply })
//   image  -> value sent to the backend (ComfyUI filename or absolute URL)
//   proxy  -> same-origin/display URL for the <img>
//   onApply(payload) -> called with {x, y, width, height} after closing.
//
// The editor is deliberately independent from the prompt/chip system: crop
// is canvas editing, not a generation action.

const _crop = {
  open: false,
  image: '',
  proxy: '',
  label: '',
  naturalWidth: 0,
  naturalHeight: 0,
  rect: null,
  aspect: 0,
  initialRect: null,
  onApply: null,
  lastFocus: null,
  drag: null,
  raf: 0,
  applying: false,
};

function _cropById(id) {
  return document.getElementById(id);
}

function _cropBounds() {
  return { width: _crop.naturalWidth, height: _crop.naturalHeight };
}

function cropEditorIsOpen() {
  return _crop.open;
}

function openCropEditor(opts) {
  opts = opts || {};
  const image = typeof opts.image === 'string' ? opts.image.trim() : '';
  const proxy = typeof opts.proxy === 'string' ? opts.proxy.trim() : '';
  if (!image || !proxy) {
    if (typeof showToast === 'function') showToast('Load an image first');
    return false;
  }

  const overlay = _cropById('cropOverlay');
  const img = _cropById('cropImage');
  if (!overlay || !img) return false;
  if (_crop.open) closeCropEditor();

  _crop.open = true;
  _crop.image = image;
  _crop.proxy = proxy;
  _crop.label = typeof opts.label === 'string' ? opts.label : '';
  _crop.naturalWidth = 0;
  _crop.naturalHeight = 0;
  _crop.rect = null;
  _crop.aspect = Number.isFinite(Number(opts.aspect)) ? Number(opts.aspect) : 0;
  _crop.initialRect = opts.rect || null;
  _crop.onApply = typeof opts.onApply === 'function' ? opts.onApply : null;
  _crop.lastFocus = document.activeElement;
  _crop.applying = false;

  _cropSetTargetLabel();
  _cropResetPresetButtons();
  const dims = _cropById('cropDims');
  if (dims) dims.textContent = '—';
  const apply = _cropById('cropApply');
  if (apply) {
    apply.disabled = true;
    apply.setAttribute('aria-disabled', 'true');
  }

  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('crop-open');

  img.onload = _cropImageLoaded;
  img.onerror = _cropImageFailed;
  img.src = proxy;
  requestAnimationFrame(() => {
    const cancel = _cropById('cropCancel');
    if (cancel) cancel.focus({ preventScroll: true });
  });
  return true;
}

function _cropSetTargetLabel() {
  const label = _cropById('cropTargetLabel');
  if (label) label.textContent = _crop.label ? '· ' + _crop.label : '';
}

function _cropImageLoaded() {
  if (!_crop.open) return;
  const img = _cropById('cropImage');
  _crop.naturalWidth = img.naturalWidth || 0;
  _crop.naturalHeight = img.naturalHeight || 0;
  if (!_crop.naturalWidth || !_crop.naturalHeight) {
    _cropImageFailed();
    return;
  }
  const bounds = _cropBounds();
  if (_crop.initialRect) {
    _crop.rect = cropClampRect(_crop.initialRect, bounds);
  } else {
    _crop.rect = { x: 0, y: 0, width: bounds.width, height: bounds.height };
  }
  if (_crop.aspect > 0) {
    // Keep a caller-provided ratio only when it can be represented inside
    // the image; otherwise fall back to Free.
    _crop.rect = cropRectForAspect(bounds, _crop.aspect);
  } else {
    _crop.aspect = 0;
  }
  _cropLayout();
  _cropRender();
  // The overlay may have been laid out in the same frame as the image load;
  // recompute once more after the browser has settled (cached images).
  _cropScheduleLayout();
}

function _cropImageFailed() {
  if (typeof showToast === 'function') showToast('Could not load the image to crop');
  closeCropEditor();
}

function closeCropEditor() {
  if (!_crop.open) return;
  _cropEndDrag();
  _crop.open = false;
  _crop.applying = false;
  const overlay = _cropById('cropOverlay');
  const img = _cropById('cropImage');
  if (overlay) {
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('crop-open');
  if (img) {
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
  }
  const last = _crop.lastFocus;
  _crop.lastFocus = null;
  if (last && typeof last.focus === 'function' && document.contains(last)) {
    try { last.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
}

// Size the stage to the rendered image (no object-fit letterbox inside it).
function _cropLayout() {
  if (!_crop.open || !_crop.naturalWidth || !_crop.naturalHeight) return;
  const wrap = _cropById('cropStageWrap');
  const stage = _cropById('cropStage');
  if (!wrap || !stage) return;
  // clientWidth/Height include the wrap's padding; subtract it so the
  // stage never overflows (and gets clipped) at the edges.
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(wrap) : null;
  const padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
  const padY = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0;
  const availW = wrap.clientWidth - padX;
  const availH = wrap.clientHeight - padY;
  if (availW <= 0 || availH <= 0) return;
  const scale = Math.min(availW / _crop.naturalWidth, availH / _crop.naturalHeight);
  stage.style.width = Math.max(1, _crop.naturalWidth * scale) + 'px';
  stage.style.height = Math.max(1, _crop.naturalHeight * scale) + 'px';
}

function _cropRender() {
  if (!_crop.open || !_crop.rect || !_crop.naturalWidth) return;
  const box = _cropById('cropBox');
  const dims = _cropById('cropDims');
  const apply = _cropById('cropApply');
  if (!box) return;
  const w = _crop.naturalWidth;
  const h = _crop.naturalHeight;
  box.style.left = (_crop.rect.x / w * 100) + '%';
  box.style.top = (_crop.rect.y / h * 100) + '%';
  box.style.width = (_crop.rect.width / w * 100) + '%';
  box.style.height = (_crop.rect.height / h * 100) + '%';

  const payload = cropToPayload(_crop.rect, _cropBounds());
  const full = cropIsFullFrame(_crop.rect, _cropBounds());
  if (dims) {
    dims.textContent = `${payload.width} × ${payload.height}`;
    dims.title = `x ${payload.x}, y ${payload.y}`;
  }
  if (apply) {
    const disabled = full || _crop.applying;
    apply.disabled = disabled;
    apply.setAttribute('aria-disabled', String(disabled));
  }
  _cropSyncPresetButtons();
}

function _cropScheduleLayout() {
  if (!_crop.open || _crop.raf) return;
  _crop.raf = requestAnimationFrame(() => {
    _crop.raf = 0;
    if (!_crop.open) return;
    _cropLayout();
    _cropRender();
  });
}

function _cropResetPresetButtons() {
  const presets = _cropById('cropPresets');
  if (!presets) return;
  presets.querySelectorAll('[data-crop-ratio]').forEach(btn => {
    const ratio = parseFloat(btn.dataset.cropRatio) || 0;
    btn.classList.toggle('active', ratio === 0 && _crop.aspect === 0);
  });
}

function _cropSyncPresetButtons() {
  const presets = _cropById('cropPresets');
  if (!presets) return;
  presets.querySelectorAll('[data-crop-ratio]').forEach(btn => {
    const ratio = parseFloat(btn.dataset.cropRatio) || 0;
    btn.classList.toggle('active', ratio === _crop.aspect);
  });
}

function _cropSetAspect(ratio) {
  if (!_crop.open) return;
  const r = Number(ratio) || 0;
  _crop.aspect = r > 0 ? r : 0;
  if (_crop.aspect > 0) {
    _crop.rect = cropRectForAspect(_cropBounds(), _crop.aspect);
  }
  _cropRender();
}

function cropReset() {
  if (!_crop.open) return;
  _crop.aspect = 0;
  _crop.rect = { x: 0, y: 0, width: _crop.naturalWidth, height: _crop.naturalHeight };
  _cropRender();
}

function cropApply() {
  if (!_crop.open || _crop.applying || !_crop.rect) return;
  const payload = cropToPayload(_crop.rect, _cropBounds());
  if (cropIsFullFrame(_crop.rect, _cropBounds())) {
    if (typeof showToast === 'function') showToast('Adjust the crop area first');
    return;
  }
  const cb = _crop.onApply;
  _crop.applying = true;
  closeCropEditor();
  if (cb) cb(payload);
}

// ── Pointer interaction ───────────────────────────────────────────────────
function _cropStageRect() {
  const stage = _cropById('cropStage');
  return stage ? stage.getBoundingClientRect() : null;
}

function _cropPointerDown(e) {
  if (!_crop.open || _crop.drag) return;
  if (e.button != null && e.button !== 0) return;
  const handleEl = e.target.closest ? e.target.closest('[data-crop-handle]') : null;
  const box = e.target.closest ? e.target.closest('#cropBox') : null;
  if (!handleEl && !box) return;
  const stage = _cropById('cropStage');
  if (!stage || !_crop.rect) return;
  e.preventDefault();
  e.stopPropagation();
  const handle = handleEl ? handleEl.dataset.cropHandle : 'move';
  _crop.drag = {
    pointerId: e.pointerId,
    handle,
    startX: e.clientX,
    startY: e.clientY,
    rect: { ..._crop.rect },
  };
  try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  stage.addEventListener('pointermove', _cropPointerMove);
  stage.addEventListener('pointerup', _cropPointerUp);
  stage.addEventListener('pointercancel', _cropPointerUp);
  stage.addEventListener('lostpointercapture', _cropEndDrag);
  if (handle === 'move' && box) box.classList.add('dragging');
}

function _cropPointerMove(e) {
  const d = _crop.drag;
  if (!d || e.pointerId !== d.pointerId) return;
  const stage = _cropById('cropStage');
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scaleX = _crop.naturalWidth / rect.width;
  const scaleY = _crop.naturalHeight / rect.height;
  const dx = (e.clientX - d.startX) * scaleX;
  const dy = (e.clientY - d.startY) * scaleY;
  if (d.handle === 'move') {
    _crop.rect = cropMoveRect(d.rect, dx, dy, _cropBounds());
  } else {
    _crop.rect = cropResizeRect(
      d.rect,
      d.handle,
      dx,
      dy,
      _cropBounds(),
      { aspect: _crop.aspect }
    );
  }
  if (e.cancelable) e.preventDefault();
  _cropRender();
}

function _cropPointerUp(e) {
  const d = _crop.drag;
  if (d && e && e.pointerId != null && e.pointerId !== d.pointerId) return;
  _cropEndDrag();
}

function _cropEndDrag() {
  const d = _crop.drag;
  if (!d) return;
  _crop.drag = null;
  const stage = _cropById('cropStage');
  const box = _cropById('cropBox');
  if (box) box.classList.remove('dragging');
  if (stage) {
    try { stage.releasePointerCapture(d.pointerId); } catch (e) { /* ignore */ }
    stage.removeEventListener('pointermove', _cropPointerMove);
    stage.removeEventListener('pointerup', _cropPointerUp);
    stage.removeEventListener('pointercancel', _cropPointerUp);
    stage.removeEventListener('lostpointercapture', _cropEndDrag);
  }
}

// ── Keyboard ──────────────────────────────────────────────────────────────
// Capture phase so the app's global shortcuts (pane arrows/Delete/Escape)
// never fire while the editor owns the keyboard.
function _cropKeyDown(e) {
  if (!_crop.open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeCropEditor();
    return;
  }
  if (e.key === 'Enter') {
    // Let a focused button (preset/Cancel/Apply) keep its native action.
    const target = e.target;
    if (!target || !target.closest
        || !target.closest('button, input, textarea, select')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      cropApply();
    }
    return;
  }
  const dirs = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const delta = dirs[e.key];
  if (!delta) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const step = e.shiftKey ? 10 : 1;
  _crop.rect = cropMoveRect(
    _crop.rect,
    delta[0] * step,
    delta[1] * step,
    _cropBounds()
  );
  _cropRender();
}

// ── Wiring ────────────────────────────────────────────────────────────────
(function _initCropEditor() {
  const stage = _cropById('cropStage');
  const cancel = _cropById('cropCancel');
  const apply = _cropById('cropApply');
  const reset = _cropById('cropReset');
  const presets = _cropById('cropPresets');
  const wrap = _cropById('cropStageWrap');

  if (stage) stage.addEventListener('pointerdown', _cropPointerDown);
  if (cancel) cancel.addEventListener('click', closeCropEditor);
  if (apply) apply.addEventListener('click', cropApply);
  if (reset) reset.addEventListener('click', cropReset);
  if (presets) {
    presets.addEventListener('click', e => {
      const btn = e.target.closest('[data-crop-ratio]');
      if (btn) _cropSetAspect(parseFloat(btn.dataset.cropRatio) || 0);
    });
  }
  document.addEventListener('keydown', _cropKeyDown, true);
  window.addEventListener('resize', _cropScheduleLayout);
  window.addEventListener('orientationchange', _cropScheduleLayout);
  if (typeof ResizeObserver === 'function' && wrap) {
    new ResizeObserver(_cropScheduleLayout).observe(wrap);
  }
})();
