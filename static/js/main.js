// ── Init + global event wiring ────────────
// Tooltip, compare-slider drag, keyboard shortcuts. Runs once on load.

// Initial calculations on page load
window.addEventListener('DOMContentLoaded', () => {
  restorePersistedState(); // set toolbarValues + advanced + theme (before toolbar paint)
  applyTheme();            // paint the persisted theme (if any)
  renderToolbar('generate'); // paint the nav toolbar (restores persisted family)
  switchTab('generate');     // mount the action button (with catcher) for the active tab
  onModelFamilyChange();     // auto-steps + recalc for the family
  applyPersistedParams();    // re-apply persisted field values (they win over auto-steps)
  initSourceFields();        // select-all on click for the source URL fields
  loadSettings();
  relayoutPrompt();
  updateActionButtons();
  savePersistedState();      // normalize the stored shape after applying
});

// Disable/enable action buttons as the shared prompt changes
const promptInput = document.getElementById('promptInput');
if (promptInput) {
  promptInput.addEventListener('input', updateActionButtons);
}

// Persist per-tab parameter fields whenever they change
Object.values(PERSIST_FIELDS).flat().forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', savePersistedState);
});

// Relocate the prompt block when crossing the landscape/portrait breakpoint
const layoutQuery = window.matchMedia('(min-width: 1024px)');
if (layoutQuery.addEventListener) {
  layoutQuery.addEventListener('change', relayoutPrompt);
} else if (layoutQuery.addListener) {
  layoutQuery.addListener(relayoutPrompt); // legacy Safari
}

// ── Label tooltip ────────────────────────
const tooltip = document.getElementById('labelTooltip');
let tooltipTimeout;
document.addEventListener('mouseover', e => {
  const label = e.target.closest('.field-inline label[title]');
  if (label) {
    const rect = label.getBoundingClientRect();
    tooltip.textContent = label.getAttribute('title');
    tooltip.style.left = (rect.left + rect.width / 2) + 'px';
    tooltip.style.top = (rect.bottom + 4) + 'px';
    tooltip.style.transform = 'translateX(-50%)';
    tooltip.classList.add('show');
    clearTimeout(tooltipTimeout);
  }
});
document.addEventListener('mouseout', e => {
  if (e.target.closest('.field-inline label[title]')) {
    tooltipTimeout = setTimeout(() => tooltip.classList.remove('show'), 100);
  }
});

// ── Compare slider drag — sets --p (like the reference compare_images) ──
document.querySelectorAll('.compare-slider').forEach(slider => {
  let dragging = false;
  function setP(x) {
    const rect = slider.getBoundingClientRect();
    const p = Math.min(100, Math.max(0, (x - rect.left) / rect.width * 100));
    slider.style.setProperty('--p', p + '%');
  }
  const onBtn = e => e.target.closest && e.target.closest('.btn');
  slider.addEventListener('pointerdown', e => {
    if (onBtn(e)) return;
    dragging = true;
    try { slider.setPointerCapture(e.pointerId); } catch (e) {}
    setP(e.clientX);
    e.preventDefault();
  });
  slider.addEventListener('pointermove', e => {
    if ((dragging || e.pointerType === 'mouse') && !onBtn(e)) setP(e.clientX);
  });
  slider.addEventListener('pointerup', () => { dragging = false; });
  slider.addEventListener('pointercancel', () => { dragging = false; });
});

// ── Keyboard shortcuts ────────────────────
// Ctrl+1..4 switches tabs; Esc closes the modal.
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey) {
    const map = { '1': 'generate', '2': 'edit', '3': 'upscale', '4': 'video' };
    if (map[e.key]) { e.preventDefault(); switchTab(map[e.key]); }
  }
  if (e.key === 'Escape') closeModal();
});

// ── Gallery (B5): clicking a generated result opens the lightbox ──
// The ⛶ top-right buttons call openGenerateLightbox()/openCompareFullscreen()
// directly; this handles the click-on-the-image case.
document.addEventListener('click', e => {
  const img = e.target.closest('.result-img[data-gallery="1"]');
  if (img) openGenerateLightbox(img);
});
