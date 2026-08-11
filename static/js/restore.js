// ── Restore last generation into the panes (lazy) ──
// After a refresh, the galleries (persisted in localStorage) hold the
// session history, but the panes start empty. This module restores each
// tab's LAST result into its output pane — but LAZILY: only the active
// tab is restored on load, and switching to another tab restores it only
// if its pane is still empty (a generation already running/finished in
// this session wins). Resources load only when the tab becomes active.
//
//   generate → last entry of galleryGenerated        → result image
//   edit     → last edit/restore comparison         → compare slider
//   upscale  → last upscale comparison              → compare slider
//   video    → last entry of galleryVideos          → video player

// Does the pane currently show any result / preview / compare slider?
function paneHasContent(paneId) {
  const pane = document.getElementById(paneId);
  if (!pane) return true; // no pane → nothing to restore into
  // A visible compare slider has display:'' (inline style removed the
  // display:none) — check it is NOT 'none'. Any result/preview also counts.
  const visibleSlider = Array.from(pane.querySelectorAll('.compare-slider')).find(
    s => (s.style.display || '').toLowerCase() !== 'none'
  );
  return !!visibleSlider || !!pane.querySelector(
    '.result-img, .result-video, .video-player, .source-preview'
  );
}

// Build a compare-slider entry from a persisted comparison (before/after).
function restoreCompareSlider(tab, paneId, cmp) {
  if (!cmp || !cmp.src) return;
  const pane = document.getElementById(paneId);
  if (!pane) return;
  const slider = pane.querySelector('.compare-slider');
  if (!slider) return;
  const before = slider.querySelector('.side.before');
  const after = slider.querySelector('.side.after');
  if (!before || !after) return;
  const afterLabel = slider.querySelector('.label:last-of-type') ||
    (pane.id === 'editOutputPane' ? document.getElementById('editCompareAfterLabel') : null);
  if (afterLabel && tab === 'edit') {
    afterLabel.textContent = cmp.kind === 'restore' ? 'Restored' : 'Edited';
  }
  before.src = cmp.before || cmp.src;
  after.src = cmp.src;
  slider.style.setProperty('--p', '50%');
  slider.style.display = '';
  // Re-register the gallery marker so the compare gallery finds it again.
  slider.dataset.gallery = '1';
  slider.dataset.kind = cmp.kind || 'edit';
  slider.dataset.prompt = cmp.prompt || '';
}

// Restore the last result of a tab into its pane. No-op when the pane
// already has content (a live session wins over persisted state).
function restoreTabResult(tab) {
  const paneIds = { generate: 'genOutputPane', edit: 'editOutputPane', upscale: 'upscaleOutputPane', video: 'videoOutputPane' };
  const paneId = paneIds[tab];
  if (!paneId) return;
  if (paneHasContent(paneId)) return; // already showing something — keep it

  switch (tab) {
    case 'generate': {
      const all = window.galleryGenerated;
      const last = all && all.length ? all[all.length - 1] : null;
      if (last && last.src) {
        showResult(paneId, { display: last.src }, false);
      }
      break;
    }
    case 'edit':
    case 'upscale': {
      const comps = (window.galleryComparisons || []).filter(c => c.tab === tab);
      const last = comps.length ? comps[comps.length - 1] : null;
      if (last) restoreCompareSlider(tab, paneId, last);
      break;
    }
    case 'video': {
      const all = window.galleryVideos;
      const last = all && all.length ? all[all.length - 1] : null;
      if (last && last.src) {
        showResult(paneId, { display: last.src }, true);
      }
      break;
    }
  }
}

// Restore on load: the ACTIVE tab (what the user sees) AND the Video tab if
// it has generated videos — so a video as the last generation shows in its
// pane right after a refresh (the active tab is usually Generate). The
// other tabs restore lazily when they become active.
function restoreActiveTabResult() {
  if (currentTab) restoreTabResult(currentTab);
  // If the user last generated a video, show it in the Video pane too.
  if (currentTab !== 'video' && window.galleryVideos && window.galleryVideos.length) {
    restoreTabResult('video');
  }
}

// ── Trash (🗑️): clear the current tool's gallery + refresh its pane ──
// Independent per tool. Clears the persisted registries for THIS tab only,
// empties the pane (restores the placeholder / video mock), clears the
// result URL row and persists. Other tools' galleries are untouched.
function clearTabGallery(tab) {
  switch (tab) {
    case 'generate':
      window.galleryGenerated = [];
      break;
    case 'edit':
    case 'upscale':
      if (Array.isArray(window.galleryComparisons)) {
        window.galleryComparisons = window.galleryComparisons.filter(e => e.tab !== tab);
      }
      break;
    case 'video':
      window.galleryVideos = [];
      break;
  }
  // Refresh the pane: drop the result / slider / video, restore the
  // placeholder. The resets already clearPane, but here we do it directly
  // so the pane shows the idle state regardless of the tab.
  const paneIds = { generate: 'genOutputPane', edit: 'editOutputPane', upscale: 'upscaleOutputPane', video: 'videoOutputPane' };
  const paneId = paneIds[tab];
  if (paneId) {
    clearPane(paneId);
    const pane = document.getElementById(paneId);
    if (pane && !pane.querySelector('.output-placeholder') && tab === 'generate') {
      const ph = document.createElement('div');
      ph.className = 'output-placeholder';
      ph.innerHTML = '<div class="icon">🖼️</div><p>Your generated image<br>will appear here</p>' +
                     '<p style="font-size:.75rem;margin-top:6px;">Click to open lightbox</p>';
      pane.insertBefore(ph, pane.firstChild);
    }
  }
  // Clear the result URL row for this tab (it is shared, so only when the
  // current tab is the one being cleared).
  if (currentTab === tab) {
    document.getElementById('resultUrl').textContent = '';
    document.getElementById('btnCopyUrl').disabled = true;
  }
  savePersistedState();
  showToast(tab === 'generate' ? '🗑️ Generated images cleared'
    : tab === 'video' ? '🗑️ Videos cleared'
    : tab === 'edit' ? '🗑️ Edits cleared' : '🗑️ Upscales cleared');
}

// Toolbar trash handler: clears the gallery of the ACTIVE tab.
function trashCurrentTab() {
  if (currentTab) clearTabGallery(currentTab);
}

// Rebuild the direct ComfyUI URL of a gallery entry for chaining (🔗).
// Entries store the same-origin display src (/media/x?type=..) — the
// backend's `image` input expects the full {base}/view?filename=..&type=..
// URL. Older persisted entries lack the `url` field, so it is rebuilt from
// src/filename + the configured media base.
function fullComfyUrl(entry) {
  if (!entry) return '';
  if (entry.url) return entry.url;
  const src = entry.src || '';
  // /media/FILENAME?type=X -> {base}/view?filename=FILENAME&type=X
  const m = src.match(/\/media\/([^?]+)(?:\?type=([^&]+))?/);
  if (m && baseUrl) {
    const fn = decodeURIComponent(m[1]);
    const type = m[2] || 'output';
    return `${baseUrl}/view?filename=${encodeURIComponent(fn)}&type=${type}`;
  }
  // Already a full http(s) URL (external) — as-is.
  if (/^https?:\/\//i.test(src)) return src;
  return src;
}
