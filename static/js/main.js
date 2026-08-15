// ── Init + global event wiring ────────────
// Tooltip, compare-slider drag, keyboard shortcuts. Runs once on load.

// Initial calculations on page load
window.addEventListener('DOMContentLoaded', () => {
  restorePersistedState(); // set toolbarValues + advanced + theme (before toolbar paint)
  // Pour the persisted per-tab prompts into their own textareas (each tab
  // has an independent field — this only happens once at startup).
  document.querySelectorAll('.prompt-input').forEach(t => {
    if (promptsByTab && typeof promptsByTab[t.dataset.tab] === 'string') {
      t.value = promptsByTab[t.dataset.tab];
    }
  });
  applyTheme();            // paint the persisted theme (if any)
  renderToolbar('generate'); // paint the nav toolbar (restores persisted family)
  switchTab('generate');     // mount the action button (with catcher) for the active tab
  onModelFamilyChange();     // auto-steps + recalc for the family
  applyPersistedParams();    // re-apply persisted field values (they win over auto-steps)
  initSourceFields();        // select-all on click for the source URL fields
  relayoutPrompt();
  updateActionButtons();
  savePersistedState();      // normalize the stored shape after applying
  // Restore the ACTIVE tab's last result into its pane (lazy — the other
  // tabs restore when they become active).
  restoreActiveTabResult();
  // Validate persisted galleries against the server (async, non-blocking):
  // drop entries whose file no longer exists, then persist the pruned set.
  verifyStoredGalleries();
  // Restore lastGeneratedUrl for chaining (🔗) AFTER the media base is
  // loaded: fullComfyUrl() rebuilds the {base}/view URL from a /media src,
  // which requires baseUrl. Running it before loadSettings() resolved would
  // leave the source field with '/media/...' (→ backend 400, since that is
  // not a valid source).
  loadSettings().then(() => restoreLastGeneratedUrl());
  // Re-adopt a generation that was still running when this page loaded
  // (browser discarded/reloaded a backgrounded tab, or the user reloaded
  // mid-job): re-establish the running UI and resolve the result when the
  // backend finishes. Async + non-blocking.
  adoptRunningJob();
});

// Rebuild lastGeneratedUrl from the persisted galleries (the most recent
// IMAGE result — generate/edit/restore/upscale). Called after baseUrl is
// known so older entries that only carry the /media display src can be
// expanded to a full {base}/view URL. galleryVideos is deliberately NOT
// considered: the 🔗 chain feeds Edit/Upscale/Video, which all need an
// image source (img2img / img2vid), so a video must never be chainable. In
// a live session lastGeneratedUrl is set by the image generators; this only
// matters after a refresh.
function restoreLastGeneratedUrl() {
  const gen = window.galleryGenerated;
  const lastGen = gen && gen.length ? gen[gen.length - 1] : null;
  if (!lastGen) return;
  lastGeneratedUrl = lastGen.url
    || (typeof fullComfyUrl === 'function' ? fullComfyUrl(lastGen) : (lastGen.src || ''));
}

// Each tab has its OWN textarea (.prompt-input). Typing updates the action
// buttons (from the ACTIVE field) and keeps that tab's prompt + localStorage
// in sync — the tabs can never mix values, each field is independent.
document.querySelectorAll('.prompt-input').forEach(t => {
  t.addEventListener('input', () => {
    const tab = t.dataset.tab;
    if (tab && promptsByTab) promptsByTab[tab] = t.value;
    if (tab === currentTab) updateActionButtons();
    savePersistedState();
  });
});

// Persist per-tab parameter fields whenever they change
Object.values(PERSIST_FIELDS).flat().forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', savePersistedState);
});

// Relocate the prompt block when crossing the landscape/portrait breakpoint;
// also close the tabs dropdown and the prompt modal (both portrait-only) so
// they never stay open across the switch.
const layoutQuery = window.matchMedia('(min-width: 1024px)');
if (layoutQuery.addEventListener) {
  layoutQuery.addEventListener('change', () => { relayoutPrompt(); closeTabsDropdown(); closePromptModal(); });
} else if (layoutQuery.addListener) {
  layoutQuery.addListener(() => { relayoutPrompt(); closeTabsDropdown(); closePromptModal(); }); // legacy Safari
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
// DELEGATED on document: works for the pane sliders (edit/upscale) AND the
// fullscreen gallery slider (#gallerySlider), which is inside the overlay
// (it exists in the DOM at load, but the delegation makes it robust to any
// slider created later — including future ones).
function setupCompareSlider(slider) {
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
}
document.querySelectorAll('.compare-slider').forEach(setupCompareSlider);

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
// directly; this handles the click-on-the-image case (the lightbox positions
// on that image's entry in the generated history).
document.addEventListener('click', e => {
  const img = e.target.closest('.result-img');
  if (img) openGenerateLightbox(img);
});
