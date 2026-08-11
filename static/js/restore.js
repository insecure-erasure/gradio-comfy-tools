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

// Restore the ACTIVE tab on load (lazy — only what is visible).
function restoreActiveTabResult() {
  if (currentTab) restoreTabResult(currentTab);
}
