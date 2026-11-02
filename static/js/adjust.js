// ── Adjust editor (brightness / contrast / saturation) ─────────────────────
// The panel is inline on desktop and fullscreen on the stacked layout, like
// Crop. Sliders work in relative percent (-100..+100, 0 = neutral); the final result is
// computed by one ComfyUI LayerColor node. The preview uses CSS filters,
// which are close to, but not pixel-identical with, PIL's ImageEnhance.

const _adjust = {
  open: false,
  image: '',
  proxy: '',
  loaded: false,
  applying: false,
  onApply: null,
  lastFocus: null,
};

function _adjustById(id) {
  return document.getElementById(id);
}

function adjustEditorIsOpen() {
  return _adjust.open;
}

function openAdjustEditor(opts) {
  opts = opts || {};
  const image = typeof opts.image === 'string' ? opts.image.trim() : '';
  const proxy = typeof opts.proxy === 'string' ? opts.proxy.trim() : '';
  if (!image || !proxy) {
    if (typeof showToast === 'function') showToast('Load an image first');
    return false;
  }
  const overlay = _adjustById('adjustOverlay');
  const img = _adjustById('adjustImage');
  if (!overlay || !img) return false;
  if (_adjust.open) closeAdjustEditor();

  _adjust.open = true;
  _adjust.image = image;
  _adjust.proxy = proxy;
  _adjust.loaded = false;
  _adjust.applying = false;
  _adjust.onApply = typeof opts.onApply === 'function' ? opts.onApply : null;
  _adjust.lastFocus = document.activeElement;

  _adjustSetSliders(0, 0, 0);
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('adjust-open');

  img.onload = _adjustImageLoaded;
  img.onerror = _adjustImageFailed;
  img.src = proxy;
  _adjustSync();
  requestAnimationFrame(() => {
    const cancel = _adjustById('adjustCancel');
    if (cancel) cancel.focus({ preventScroll: true });
  });
  return true;
}

function _adjustImageLoaded() {
  if (!_adjust.open) return;
  _adjust.loaded = true;
  _adjustSync();
}

function _adjustImageFailed() {
  if (typeof showToast === 'function') showToast('Could not load the image to adjust');
  closeAdjustEditor();
}

function closeAdjustEditor() {
  if (!_adjust.open) return;
  _adjust.open = false;
  _adjust.loaded = false;
  _adjust.applying = false;
  const overlay = _adjustById('adjustOverlay');
  const img = _adjustById('adjustImage');
  if (overlay) {
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('adjust-open');
  if (img) {
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    img.style.filter = '';
  }
  const last = _adjust.lastFocus;
  _adjust.lastFocus = null;
  if (last && typeof last.focus === 'function' && document.contains(last)) {
    try { last.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
}

function _adjustSetSliders(brightness, contrast, saturation) {
  const values = {
    adjustBrightness: adjustClampPercent(brightness),
    adjustContrast: adjustClampPercent(contrast),
    adjustSaturation: adjustClampPercent(saturation),
  };
  Object.entries(values).forEach(([id, value]) => {
    const el = _adjustById(id);
    if (el) el.value = String(value);
  });
  _adjustSync();
}

function _adjustRead() {
  const value = id => adjustClampPercent(_adjustById(id)?.value);
  return {
    brightness: value('adjustBrightness'),
    contrast: value('adjustContrast'),
    saturation: value('adjustSaturation'),
  };
}

function _adjustSync() {
  const values = _adjustRead();
  const img = _adjustById('adjustImage');
  if (img) {
    img.style.filter = adjustFilter(values.brightness, values.contrast, values.saturation);
  }
  const outputs = {
    adjustBrightnessValue: values.brightness,
    adjustContrastValue: values.contrast,
    adjustSaturationValue: values.saturation,
  };
  Object.entries(outputs).forEach(([id, value]) => {
    const el = _adjustById(id);
    if (el) el.textContent = adjustLabel(value);
  });
  const apply = _adjustById('adjustApply');
  if (apply) {
    const disabled = !_adjust.loaded || _adjust.applying ||
      adjustIsNeutral(values.brightness, values.contrast, values.saturation);
    apply.disabled = disabled;
    apply.setAttribute('aria-disabled', String(disabled));
  }
}

function adjustReset() {
  if (!_adjust.open) return;
  _adjustSetSliders(0, 0, 0);
}

function adjustApply() {
  if (!_adjust.open || _adjust.applying || !_adjust.loaded) return;
  const values = _adjustRead();
  if (adjustIsNeutral(values.brightness, values.contrast, values.saturation)) {
    if (typeof showToast === 'function') showToast('Adjust at least one value first');
    return;
  }
  const cb = _adjust.onApply;
  _adjust.applying = true;
  const payload = adjustPayload(values.brightness, values.contrast, values.saturation);
  closeAdjustEditor();
  if (cb) cb(payload);
}

function _adjustKeyDown(e) {
  if (!_adjust.open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeAdjustEditor();
    return;
  }
  if (e.key !== 'Enter') return;
  const target = e.target;
  if (target && target.closest
      && target.closest('input, textarea, select, button')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  adjustApply();
}

(function _initAdjustEditor() {
  const cancel = _adjustById('adjustCancel');
  const apply = _adjustById('adjustApply');
  const reset = _adjustById('adjustReset');
  const sliders = ['adjustBrightness', 'adjustContrast', 'adjustSaturation'];
  if (cancel) cancel.addEventListener('click', closeAdjustEditor);
  if (apply) apply.addEventListener('click', adjustApply);
  if (reset) reset.addEventListener('click', adjustReset);
  sliders.forEach(id => {
    const el = _adjustById(id);
    if (el) el.addEventListener('input', _adjustSync);
  });
  document.addEventListener('keydown', _adjustKeyDown, true);
})();
