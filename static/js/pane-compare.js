// ── Pane before/after presentation: ALWAYS a toggle ────────────────────────
// In the NORMAL view the compare result is never a draggable slider: the two
// images are shown ONE AT A TIME with an `Original | <Result>` toggle
// centered at the top of the pane (Edit, Upscale and Face swap). This is the
// presentation Extend/Crop/Adjust always had — extended here to every pane
// comparison, because the overlay slider is harder to read on small/touch
// screens and hides half of either image.
//
// The FULLSCREEN gallery keeps its own presentation (slider for
// edit/restore/upscale/face swap, toggle for extend/crop/adjust — see
// gallery.js); only the panes are affected.
//
// Implementation note: the toggle reuses the existing `.extend-toggle-mode`
// class on the `.compare-slider`, which hides the divider/handle/labels,
// disables the drag (main.js bails on that class) and shows a single layer
// via `.show-original`. Keeping the class name means api.js (clearPane) and
// source.js (clearSourcePreview + setGenerating) already reset/hide the
// toggle with no extra glue.

const PANE_COMPARE = {
  edit: {
    slider: 'editCompare',
    toggle: 'editExtendToggle',
    original: 'editExtendOriginalBtn',
    result: 'editExtendResultBtn',
    defaultLabel: 'Edited',
  },
  upscale: {
    slider: 'upscaleCompare',
    toggle: 'upscaleCompareToggle',
    original: 'upscaleCompareOriginalBtn',
    result: 'upscaleCompareResultBtn',
    defaultLabel: 'Upscaled',
  },
  face_swap: {
    slider: 'faceSwapCompare',
    toggle: 'faceSwapCompareToggle',
    original: 'faceSwapCompareOriginalBtn',
    result: 'faceSwapCompareResultBtn',
    defaultLabel: 'Face swapped',
  },
};

// Show ONE side of the comparison: true = original, false = result.
function setPaneCompareView(tab, showOriginal) {
  const parts = PANE_COMPARE[tab];
  if (!parts) return;
  const slider = document.getElementById(parts.slider);
  const originalBtn = document.getElementById(parts.original);
  const resultBtn = document.getElementById(parts.result);
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
  // The two sides can have DIFFERENT dimensions (crop/adjust/extend), so the
  // toggle is re-aligned to the newly shown image's top edge.
  requestAnimationFrame(() => alignPaneCompareToggle(tab));
}

// Keep the toggle centered on the IMAGE's top edge instead of the pane's:
// the images use object-fit:contain, so a pane whose aspect ratio differs
// from the image's has letterbox bars that would leave the toggle floating
// on the black bar above the picture. Same contain math main.js uses for the
// drag clamp.
function alignPaneCompareToggle(tab) {
  const parts = PANE_COMPARE[tab];
  if (!parts) return;
  const slider = document.getElementById(parts.slider);
  const toggle = document.getElementById(parts.toggle);
  if (!slider || !toggle) return;
  const active = (toggle.style.display || '').toLowerCase() !== 'none'
    && slider.classList.contains('extend-toggle-mode');
  if (!active) { toggle.style.top = ''; return; }
  const rect = slider.getBoundingClientRect();
  const shown = slider.querySelector(
    slider.classList.contains('show-original') ? 'img.side.before' : 'img.side.after'
  );
  const nw = shown && shown.naturalWidth;
  const nh = shown && shown.naturalHeight;
  if (!rect.width || !rect.height || !nw || !nh) { toggle.style.top = ''; return; }
  const scale = Math.min(rect.width / nw, rect.height / nh);
  const imageTop = (rect.height - nh * scale) / 2;
  toggle.style.top = Math.max(12, Math.round(imageTop + 12)) + 'px';
}

// Turn the toggle on for a pane result. `resultLabel` names the right-hand
// button (Edited / Restored / Extended / Cropped / Adjusted / Upscaled /
// Face swapped). The result side is shown by default.
function configurePaneCompare(tab, enabled, resultLabel) {
  const parts = PANE_COMPARE[tab];
  if (!parts) return;
  const slider = document.getElementById(parts.slider);
  const toggle = document.getElementById(parts.toggle);
  const resultBtn = document.getElementById(parts.result);
  const on = enabled !== false; // the panes are always toggle now
  const label = resultLabel || parts.defaultLabel;
  if (slider) {
    slider.classList.toggle('extend-toggle-mode', on);
    if (!on) slider.classList.remove('show-original');
  }
  if (toggle) {
    toggle.style.display = on ? 'flex' : 'none';
    toggle.setAttribute('aria-label', `Compare original and ${label.toLowerCase()}`);
  }
  if (resultBtn) resultBtn.textContent = label;
  if (on) setPaneCompareView(tab, false); // default: show the result side
  requestAnimationFrame(() => alignPaneCompareToggle(tab));
}

// The toggle must follow the image as it loads / on window resize / when
// another pane result is painted (a side switch can change the aspect
// ratio). Images are in static markup, so they are already in the DOM when
// this script runs (end of <body>).
Object.keys(PANE_COMPARE).forEach(tab => {
  const parts = PANE_COMPARE[tab];
  const slider = document.getElementById(parts.slider);
  if (!slider) return;
  slider.querySelectorAll('img.side').forEach(img => {
    img.addEventListener('load', () => alignPaneCompareToggle(tab));
  });
});
window.addEventListener('resize', () => {
  Object.keys(PANE_COMPARE).forEach(alignPaneCompareToggle);
});
