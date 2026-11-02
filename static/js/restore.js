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
  // display:none) — check it is NOT 'none'. Any result/preview also counts,
  // EXCEPT the empty (disabled) video player (.video-empty-player) — it is
  // the idle state of the Video pane, not a real result.
  const visibleSlider = Array.from(pane.querySelectorAll('.compare-slider')).find(
    s => (s.style.display || '').toLowerCase() !== 'none'
  );
  return !!visibleSlider || !!pane.querySelector(
    '.result-img, .result-video, .video-player:not(.video-empty-player), .source-preview'
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
    (pane.id === 'editOutputPane' ? document.getElementById('editCompareAfterLabel')
      : pane.id === 'faceSwapOutputPane' ? document.getElementById('faceSwapCompareAfterLabel') : null);
  if (afterLabel && typeof compareKindLabel === 'function') {
    afterLabel.textContent = compareKindLabel(cmp.kind);
  }
  before.src = cmp.before || cmp.src;
  after.src = cmp.src;
  slider.style.setProperty('--p', '50%');
  slider.style.display = '';
  // Re-register the gallery marker so the compare gallery finds it again.
  slider.dataset.gallery = '1';
  slider.dataset.kind = cmp.kind || 'edit';
  slider.dataset.prompt = cmp.prompt || '';
  // Extend and crop results use the Original/Result toggle instead of the
  // overlay slider (their canvas sizes differ).
  if (paneId === 'editOutputPane' && typeof configureEditExtendToggle === 'function') {
    const kind = cmp.kind || 'edit';
    configureEditExtendToggle(
      kind === 'extend' || kind === 'crop',
      typeof compareKindLabel === 'function' ? compareKindLabel(kind) : undefined
    );
  }
}

// Restore the last result of a tab into its pane. No-op when the pane
// already has content (a live session wins over persisted state) — but the
// result-URL hint is still synced to what the pane shows. Restores the
// entry the pane was navigating (paneCurrentEntry: paneIdx[tab], or the
// most recent when the user never navigated).
const PANE_IDS = { generate: 'genOutputPane', edit: 'editOutputPane', upscale: 'upscaleOutputPane', video: 'videoOutputPane', face_swap: 'faceSwapOutputPane' };

function restoreTabResult(tab) {
  const paneId = PANE_IDS[tab];
  if (!paneId) return;
  const entry = typeof paneCurrentEntry === 'function' ? paneCurrentEntry(tab) : null;
  // A running job owns the shared result-URL row (live progress). Restoring
  // the incoming tab's last result must not overwrite the node message.
  const jobRunning = typeof progressTimer !== 'undefined' && !!progressTimer;
  if (paneHasContent(paneId)) {
    // Already showing something — just keep the URL hint in sync.
    if (!jobRunning && typeof syncResultUrl === 'function') syncResultUrl(tab, entry);
    return;
  }

  switch (tab) {
    case 'generate': {
      if (entry && entry.src) {
        showResult(paneId, { display: entry.src }, false);
      }
      break;
    }
    case 'edit':
    case 'upscale':
    case 'face_swap': {
      if (entry) restoreCompareSlider(tab, paneId, entry);
      break;
    }
    case 'video': {
      const src = entry && (entry.src || entry.display || entry.url);
      if (src) {
        showResult(paneId, { display: src }, true);
      }
      break;
    }
  }
  // Keep the pane ‹ › nav in sync with the (possibly restored) gallery.
  if (typeof syncPaneNav === 'function') syncPaneNav(tab);
  if (!jobRunning && typeof syncResultUrl === 'function') syncResultUrl(tab, entry);
}

// Restore on load: the ACTIVE tab (what the user sees) AND the Video tab if
// it has generated videos — so a video as the last generation shows in its
// pane right after a refresh (the active tab is usually Generate). The
// other tabs restore lazily when they become active.
async function restoreActiveTabResult() {
  if (currentTab) await restoreTabResultChecked(currentTab);
  // If the user last generated a video, show it in the Video pane too.
  if (currentTab !== 'video' && window.galleryVideos && window.galleryVideos.length) {
    await restoreTabResultChecked('video');
  }
}

// Preflighted restore (the one every call site should use): the entry comes
// from localStorage, so BEFORE painting it ask the backend whether the file
// still exists (one cached HEAD). A confirmed-missing file goes through
// dropMedia(), and the pane then restores the nearest survivor (or its idle
// state) instead of requesting a 404. An inconclusive probe keeps the entry:
// never hide something just because ComfyUI could not be asked.
async function restoreTabResultChecked(tab) {
  const paneId = PANE_IDS[tab];
  const jobRunning = typeof progressTimer !== 'undefined' && !!progressTimer;
  if (!paneId || jobRunning || paneHasContent(paneId)) {
    return restoreTabResult(tab); // unchanged path (also keeps the URL row in sync)
  }
  const entry = typeof paneCurrentEntry === 'function' ? paneCurrentEntry(tab) : null;
  if (entry && typeof ensureEntryExists === 'function' && !(await ensureEntryExists(entry))) {
    const fn = typeof mediaEntryFilename === 'function' ? mediaEntryFilename(entry) : null;
    if (fn && typeof dropMedia === 'function') dropMedia([fn], { quiet: true });
  }
  // The pane may have been filled while the probe was in flight;
  // restoreTabResult re-checks paneHasContent itself.
  restoreTabResult(tab);
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
    case 'face_swap':
      // Face swap results live in TWO registries: the comparison pairs
      // (before/after) and the appended generated-history entries (flagged
      // faceSwap, for the main lightbox). Remove both — only this tab's own
      // entries (generations/edits/upscales stay).
      if (Array.isArray(window.galleryComparisons)) {
        window.galleryComparisons = window.galleryComparisons.filter(e => e.tab !== 'face_swap');
      }
      window.galleryGenerated = (window.galleryGenerated || []).filter(e => !e.faceSwap);
      break;
    case 'video':
      window.galleryVideos = [];
      break;
  }
  // Refresh the pane: drop the result / slider / video, restore the
  // placeholder, and clear the shared result row when this is the active tab.
  // The same helper is used by Delete on a single pane entry.
  clearPaneResult(tab);
  savePersistedState();
  if (typeof syncPaneNav === 'function') syncPaneNav(tab);
  showToast(tab === 'generate' ? '🗑️ Generated images cleared'
    : tab === 'video' ? '🗑️ Videos cleared'
    : tab === 'edit' ? '🗑️ Edits cleared'
    : tab === 'face_swap' ? '🗑️ Face swaps cleared' : '🗑️ Upscales cleared');
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
  const src = entry.src || entry.display || '';
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
