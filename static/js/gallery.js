// ── Gallery + fullscreen (B5) ──────────────
// Ported from the reference image viewers in ../open-webui-comfy-tools
// (smart_generate_image / edit_image / upscale_image), adapted to this
// single-page app. Two SEPARATE galleries:
//
//   • Generate (lightbox): navigates the GENERATED history — every image
//     generated this session (window.galleryGenerated), even after the pane
//     only shows the last one. An edit/restore APPENDS a new entry (the
//     transformation's own prompt and the source's original prompt are both
//     shown in the ℹ️ info panel). An upscale REPLACES the original entry
//     (badge "Upscaled"). Badges are top-center ("Edited" / "Restored" /
//     "Upscaled").
//   • Edit/Upscale (compare): opens the fullscreen overlay with its own
//     interactive slider; the gallery there ONLY navigates the
//     edited/restored/upscaled comparisons (never generated images).
//
// Prompt access: the prompt is no longer a bottom caption nor a separate
// "Show prompt" button — it lives INSIDE the ℹ️ image-info panel, together
// with the technical parameters. The panel opens from the top-left ℹ️
// button or the `i` key, and closes with `i`, Escape, a click anywhere or
// gallery navigation/close.
//
// Close ✕ is top-RIGHT, ℹ️ image info top-LEFT (inverted vs the reference —
// project decision). The ℹ️ panel reads the parameters ComfyUI embeds in
// the PNG (resolution, steps, sampler, scheduler, model, LoRAs/weights) via
// GET /api/image-info, falling back to ComfyUI history when the save node
// writes no metadata. Video results are only COLLECTED (data-video-gallery
// marker + window.galleryVideos) for a future video gallery — see docs/PLAN.md.

const galleryOverlay = document.getElementById('galleryOverlay');
const galleryBig = document.getElementById('galleryBig');
const galleryVideoWrap = document.getElementById('galleryVideoWrap');
const gallerySlider = document.getElementById('gallerySlider');
const galleryBefore = document.getElementById('galleryBefore');
const galleryAfter = document.getElementById('galleryAfter');
const galleryExtendToggle = document.getElementById('galleryExtendToggle');
const galleryExtendOriginalBtn = document.getElementById('galleryExtendOriginalBtn');
const galleryExtendResultBtn = document.getElementById('galleryExtendResultBtn');
const galleryCounter = document.getElementById('galleryCounter');
const galleryCounterText = document.getElementById('galleryCounterText');
const galleryGrid = document.getElementById('galleryGrid');
const galleryGridThumbs = document.getElementById('galleryGridThumbs');
const galleryGridTitle = document.getElementById('galleryGridTitle');
const galleryLabelAfter = document.getElementById('galleryLabelAfter');
const galleryBadge = document.getElementById('galleryBadge');
const galleryBadgeBox = document.getElementById('galleryBadgeBox');
const galleryBadgeBoxText = document.getElementById('galleryBadgeBoxText');
const galleryCloseBtn = document.getElementById('galleryClose');
const galleryInfoBtn = document.getElementById('galleryInfo');
const galleryInfoPanel = document.getElementById('galleryInfoPanel');
const galleryInfoRows = document.getElementById('galleryInfoRows');
const galleryInfoNote = document.getElementById('galleryInfoNote');
const galleryInfoTitle = document.getElementById('galleryInfoTitle');
const galleryTrashBtn = document.getElementById('galleryTrash');
const galleryPrevBtn = document.getElementById('galleryPrev');
const galleryNextBtn = document.getElementById('galleryNext');

let galleryMode = null;     // 'lightbox' | 'compare'
let galleryEntries = [];    // collected on open
let galleryIdx = -1;
// Pane navigation (normal view): which gallery entry each tool's output
// pane shows. -1 = "show the most recent"; paneNav materializes it.
const paneIdx = { generate: -1, edit: -1, upscale: -1, video: -1, face_swap: -1 };

// ── Generated history ──────────────────────
// Session-scoped registry of generated images + their transformations.
// Entry: { src, prompt (the bottom caption: generation prompt for plain
//          generations and upscales, the transformation's own text for
//          edits/restores), badge: '' | 'edited' | 'restored' | 'upscaled',
//          filename, originalPrompt (for appended edits/restores: the
//          source image's prompt, shown on badge hover; empty otherwise) }.
window.galleryGenerated = [];

// filenameFromUrl lives in media-events.js (loaded before this file).

// The ComfyUI type ('output' | 'temp') embedded in a display URL like
// /media/FILENAME?type=temp — needed when probing existence (a temp result
// is NOT found under type=output).
function fileTypeFromUrl(url) {
  if (!url) return 'output';
  try {
    const u = new URL(url, window.location.origin);
    if (u.searchParams.has('type')) return u.searchParams.get('type') || 'output';
    if (u.pathname.endsWith('/view') && u.searchParams.has('type')) return u.searchParams.get('type');
  } catch (e) {}
  return 'output';
}

// A newly generated image joins the history at the end. ``res`` is the
// full API result {url, display} — url (direct ComfyUI) is kept for
// chaining (🔗), src is the same-origin display URL.
function addGeneratedEntry(res, prompt) {
  const src = res.display || res.src || res.url;
  window.galleryGenerated.push({
    src, url: res.url || '', prompt: prompt || '', badge: '', filename: filenameFromUrl(src),
    originalPrompt: '',
  });
  savePersistedState(); // galleries are persisted — persist immediately
  paneIdx.generate = -1; // a new generation — the pane shows the most recent again
  syncPaneNav('generate');
}

// A FACE SWAP of (base + face) -> new result src: APPENDS a new entry to
// the generated history (the base stays in the gallery — the swap is a new
// image). ``before`` is the same-origin proxy URL of the base (the BEFORE
// side of the comparison, persisted for restore). ``prompt`` is the user's
// OPTIONAL extra prompt (shown in the gallery ℹ️ info panel when present).
// Called from face_swap.js when a result lands; the pane ‹ › nav
// and ⛶ gallery use the COMPARISON registry (addCompareEntry) instead —
// see paneGalleryCount.
function addFaceSwapEntry(res, before, prompt) {
  const src = res.display || res.src || res.url;
  window.galleryGenerated.push({
    src, url: res.url || '', prompt: prompt || '', badge: '', filename: filenameFromUrl(src),
    originalPrompt: '', before: before || null, faceSwap: true,
  });
  savePersistedState();
  paneIdx.face_swap = -1; // the pane shows the most recent again
  syncPaneNav('face_swap');
}

// An UPScale of sourceSrc -> new result src: REPLACES the source entry in
// place when it is a gallery image (keeping its generation prompt as the
// bottom caption, updating src + badge "upscaled"; no hover hint, since an
// upscale has no transformation prompt). Non-generated sources are
// appended as new entries (empty prompt).
function addTransformedEntry(res, prompt, badge, sourceSrc) {
  const src = res.display || res.src || res.url;
  const url = res.url || '';
  const fn = filenameFromUrl(sourceSrc);
  if (fn) {
    const i = window.galleryGenerated.findIndex(e => e.filename === fn);
    if (i >= 0) {
      const entry = window.galleryGenerated[i];
      entry.src = src;
      entry.url = url;
      entry.badge = badge;
      entry.filename = filenameFromUrl(src);
      entry.originalPrompt = '';
      savePersistedState();
      paneIdx.upscale = -1;
      syncPaneNav('upscale');
      return;
    }
  }
  window.galleryGenerated.push({
    src, url, prompt: prompt || '', badge, filename: filenameFromUrl(src),
    originalPrompt: '',
  });
  savePersistedState();
  paneIdx.upscale = -1;
  syncPaneNav('upscale');
}

// An edit/restore of sourceSrc -> new result src: APPENDS a new entry (the
// original generation stays in the gallery — the edit/restore is a new
// image). The transformation's own prompt is the bottom caption; when the
// source was itself a gallery image (generated or previously transformed),
// its prompt is preserved as originalPrompt for the badge hover hint.
// Restore may have no prompt — then the caption is empty but the hover
// still shows the source's prompt when the source was a gallery image.
function appendTransformedEntry(res, prompt, badge, sourceSrc) {
  const src = res.display || res.src || res.url;
  const url = res.url || '';
  let originalPrompt = '';
  const fn = filenameFromUrl(sourceSrc);
  if (fn) {
    const i = window.galleryGenerated.findIndex(e => e.filename === fn);
    if (i >= 0) {
      const srcEntry = window.galleryGenerated[i];
      // The badge box must show the TRUE ORIGINAL generation prompt of the
      // image before the edit. For a DIRECT edit that is the source entry's
      // own prompt; for a CHAINED edit (source is itself a transformation)
      // the source's originalPrompt already holds the true original — never
      // fall back to the intermediate edit prompt (the ℹ️ panel already
      // carries the transformation text).
      originalPrompt = srcEntry.originalPrompt || srcEntry.prompt || '';
    }
  }
  window.galleryGenerated.push({
    src, url, prompt: prompt || '', badge, filename: filenameFromUrl(src),
    originalPrompt,
  });
  savePersistedState();
  paneIdx.edit = -1;
  syncPaneNav('edit');
}

// ── Compare entries (Edit/Upscale) ─────────
// Session registry of edited/restored/upscaled comparisons. The live DOM
// only ever holds ONE compare slider per tab (reused for every result), so
// collecting the gallery from the DOM alone would drop earlier edits — the
// registry is what lets the ⛶ compare gallery navigate the whole session.
// Entry: { src (AFTER image, the identity), before (ORIGINAL),
//          prompt, kind: edit|restore|upscale, tab }.
window.galleryComparisons = [];

// Prompt associated with a SOURCE image (used by compare galleries whose
// transformation has no prompt of its own, e.g. Upscale): look the source up
// in the generated history by ComfyUI filename. Returns '' when the source
// is an upload/external URL or has no prompt.
function sourceImagePrompt(sourceSrc) {
  const fn = typeof mediaEntryFilename === 'function'
    ? mediaEntryFilename({ src: sourceSrc })
    : (typeof filenameFromUrl === 'function' ? filenameFromUrl(sourceSrc) : null);
  if (!fn) return '';
  const entry = (window.galleryGenerated || []).find(e => e.filename === fn);
  return entry ? (entry.prompt || entry.originalPrompt || '') : '';
}

// Normalize a URL for comparison (the DOM absolutizes img.src while the
// registry stores the relative /media/... display URL).
function absUrl(u) {
  try { return new URL(u, window.location.origin).href; } catch (e) { return u; }
}

// Register a comparison, deduped by the AFTER image URL (the same result
// cannot appear twice). Called from edit.js/upscale.js when a result lands.
function addCompareEntry(entry) {
  if (!entry || !entry.src) return;
  const key = absUrl(entry.src);
  if (window.galleryComparisons.some(e => absUrl(e.src) === key)) return;
  window.galleryComparisons.push({
    src: entry.src,
    before: entry.before || null,
    prompt: entry.prompt || '',
    kind: entry.kind || 'edit',
    tab: entry.tab || '',
  });
  savePersistedState();
  if (entry.tab) { paneIdx[entry.tab] = -1; syncPaneNav(entry.tab); }
}

// The compare gallery collects the session registry (never generated
// images). Falls back to any data-gallery sliders still marked in the DOM
// and merges them, deduped by src — covers the edge case of a reload that
// lost the registry but kept a slider.
function collectCompareEntries() {
  const entries = [];
  const seen = new Set();
  const push = e => {
    if (!e.src) return;
    const key = absUrl(e.src);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(e);
  };
  for (const e of window.galleryComparisons) push(e);
  document.querySelectorAll('[data-gallery="1"]').forEach(el => {
    if (!el.classList.contains('compare-slider')) return;
    const after = el.querySelector('img.side.after');
    const bfr = el.querySelector('img.side.before');
    if (!after || !after.src) return;
    const kind = el.dataset.kind || 'edit';
    if (kind !== 'edit' && kind !== 'restore' && kind !== 'extend' && kind !== 'upscale' && kind !== 'face_swap') return;
    push({
      src: after.src,
      before: bfr && bfr.src ? bfr.src : null,
      prompt: el.dataset.prompt || '',
      kind,
    });
  });
  return entries;
}

// Generated videos — session registry, ANALOGOUS to the generated images
// (window.galleryGenerated): each generated video joins at the end (no
// dedup — same behavior as addGeneratedEntry; the persisted set is pruned
// against the server on restore). Entry: { src (display URL), url, prompt,
// filename }. Used by the future video gallery.
window.galleryVideos = window.galleryVideos || [];
function addGeneratedVideo(result, prompt, source) {
  const url = result.url || result.display;
  const display = result.display || url;
  // Defensive dedup by URL: a single generation must never appear twice in
  // the gallery. A lost-fetch recovery race used to fire the finalizer
  // twice for one video (see the _recoverInFlight guard in api.js) — this
  // makes the registry robust even against already-persisted duplicates
  // from sessions with the old bug.
  const key = url || display;
  if (key && window.galleryVideos.some(e => (e.url || e.src) === key)) return;
  window.galleryVideos.push({
    src: display,        // like galleryGenerated.src — the same-origin display URL
    url,                 // direct ComfyUI URL (chaining/copy)
    prompt: prompt || '',
    filename: filenameFromUrl(display),  // null for non-generated sources (defensive)
    // Poster for the thumbnail sheet: the SOURCE image the video was made
    // from (same-origin proxy URL). Entries persisted before this field
    // simply show the ▶ tile.
    source: source || '',
  });
  savePersistedState(); // persist immediately so a refresh keeps it
  paneIdx.video = -1;
  syncPaneNav('video');
}

// Stamp the generation duration (1-decimal seconds) onto the gallery entry
// for the tool that just finished. Called from api.js stopProgressPolling
// AFTER the registrars ran (the clock stops at the very end). The ⏱ chip
// then survives tab switches / gallery navigation / a refresh.
function _stampLastEntryDuration(tab, durationSecs) {
  if (!durationSecs || durationSecs <= 0) return;
  let arr;
  if (tab === 'face_swap') {
    // The comparison registry holds the before/after pair — stamp the LAST
    // face-swap comparison, not whatever happened to be appended last.
    arr = (window.galleryComparisons || []).filter(c => c.tab === 'face_swap');
  } else {
    arr = tab === 'video' ? window.galleryVideos
      : tab === 'generate' ? window.galleryGenerated
      : (tab === 'edit' || tab === 'upscale') ? window.galleryComparisons : null;
  }
  if (!arr || !arr.length) return;
  const e = arr[arr.length - 1];
  e.duration = durationSecs;
  savePersistedState();
}

// ── Open / close ───────────────────────────
function openGalleryOverlay() {
  closeGalleryGrid(false); // always open on the individual view
  _paneRepaintOnClose = null;
  _galleryClosePending = false;
  galleryOverlay.classList.add('show');
  // Fullscreen the OVERLAY element (not documentElement): it is already
  // position:fixed inset:0, so the browser expands it to the window without
  // touching the page layout; exit also leaves the page untouched.
  try { galleryOverlay.requestFullscreen && galleryOverlay.requestFullscreen(); } catch (e) {}
  try { galleryOverlay.webkitRequestFullscreen && galleryOverlay.webkitRequestFullscreen(); } catch (e) {}
}

function closeBadgeBox() {
  if (galleryBadgeBox) galleryBadgeBox.classList.remove('show');
}

// Close the gallery text boxes (the badge's original-prompt box and the ℹ️
// image-info panel) and restore the badge that a box-open hid. Returns true
// when anything was closed. Shared by click-outside and Escape.
function closeTextBoxes() {
  let changed = false;
  let restoreBadge = false;
  if (galleryBadgeBox.classList.contains('show')) {
    closeBadgeBox();
    changed = true;
    restoreBadge = true;
  }
  if (galleryInfoPanel.classList.contains('show')) { closeGalleryInfo(); changed = true; }
  // Only the badge box HID the badge: re-render to restore it from the entry
  // data. The ℹ️ panel changes nothing else, so closing it must NOT re-render
  // the item — in the video gallery that would rebuild the player and restart
  // playback.
  if (restoreBadge) renderGalleryItem();
  return changed;
}

// Final cleanup shared by an explicit close (✕ / backdrop / keydown) and by
// the browser leaving fullscreen. Escape in native fullscreen is consumed by
// the UA (Chrome/Firefox never dispatch keydown), so the fullscreenchange
// path must be able to finish the close on its own. This helper never touches
// the Fullscreen API, so both callers can use it without re-entering
// exitFullscreen.
function _finalizeGalleryClose() {
  _paneGridTab = null; // a closed gallery never keeps the pane origin
  closeGalleryGrid(false); // the sheet never survives the overlay
  closeBadgeBox(); // a badge box opened by click must not survive the close
  closeGalleryInfo(); // an info panel must not linger over the next opening
  configureGalleryExtendToggle(false);
  resetGalleryZoom(); // a closed gallery must never keep a transform
  // Destroy the video player of the OVERLAY (stops playback) and hide the
  // wrap. The pane's own player/result is untouched — closing the gallery
  // must not destroy the tool's last generation.
  if (galleryVideoWrap) { galleryVideoWrap.innerHTML = ''; galleryVideoWrap.style.display = 'none'; }
  galleryMode = null;
  // After closing, make sure the ACTIVE tool's pane still shows its last
  // generation (it normally does — the overlay never touches the pane — but
  // if the user deleted the shown entry via 🗑️, restore from the gallery).
  if (typeof restoreTabResultChecked === 'function' && currentTab) {
    restoreTabResultChecked(currentTab); // preflighted (stored entry may be gone)
  } else if (typeof restoreTabResult === 'function' && currentTab) {
    restoreTabResult(currentTab);
  }
  // A thumb PICKED in the fullscreen sheet must be what the pane shows after
  // closing (‹ › navigation alone leaves the pane as it was).
  const repaintTab = _paneRepaintOnClose;
  _paneRepaintOnClose = null;
  _galleryTab = null;
  if (repaintTab && typeof renderPane === 'function'
      && (paneEntriesFor(repaintTab) || []).length) {
    renderPane(repaintTab);
  }
}

// closeGallery() requested a native-fullscreen exit; its fullscreenchange
// event will fire later and must NOT finalize a second time.
let _galleryClosePending = false;

function closeGallery() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    _galleryClosePending = true;
    try { document.exitFullscreen && document.exitFullscreen(); } catch (e) {}
    try { document.webkitExitFullscreen && document.webkitExitFullscreen(); } catch (e) {}
  } else {
    galleryOverlay.classList.remove('show');
  }
  _finalizeGalleryClose();
}

['fullscreenchange', 'webkitfullscreenchange'].forEach(ev =>
  document.addEventListener(ev, () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    const wasOpen = galleryOverlay.classList.contains('show') || _galleryClosePending;
    if (!wasOpen) return; // another element's fullscreen ended
    galleryOverlay.classList.remove('show');
    if (_galleryClosePending) {
      _galleryClosePending = false; // closeGallery() already finalized it
      return;
    }
    // Escape in native fullscreen never reaches keydown (Chrome/Firefox):
    // finalize here so a picked thumb still lands in the pane and no state
    // (sheet, flags, player) survives the exit.
    _finalizeGalleryClose();
  })
);

// ── Pinch/wheel zoom (Generate lightbox only) ────
// Two-finger pinch (touch) and the mouse wheel (desktop) zoom the fullscreen
// generated image (scale 1x..8x), anchored so the content point under the
// fingers/cursor stays put; with more than 1x zoom a one- or two-finger
// drag pans (a mouse drag pans too). Navigation (‹ › / ←/→), opening a
// different entry and closing always reset to 1x. Compare/video modes are
// untouched (every handler is guarded by galleryMode === 'lightbox').
let zoomScale = 1, zoomTx = 0, zoomTy = 0;
const _ptrs = new Map(); // pointerId -> {x, y} (active pointers on the image)
const _pinch = { active: false, startDist: 1, startScale: 1, startTx: 0, startTy: 0, m0x: 0, m0y: 0 };
const _pan = { active: false, lastX: 0, lastY: 0 };
const _ZOOM_MAX = 8;

function _applyZoom() {
  if (zoomScale <= 1.0001) {
    // Snap back to a clean 1x — no transform, no will-change left behind.
    zoomScale = 1; zoomTx = 0; zoomTy = 0;
    galleryBig.style.transform = '';
    galleryBig.style.willChange = '';
  } else {
    galleryBig.style.transform = `translate(${zoomTx}px, ${zoomTy}px) scale(${zoomScale})`;
    galleryBig.style.willChange = 'transform';
  }
}

// Keep the image inside its viewport-sized box: at scale s the pan may not
// exceed (s-1)/2 of the box in either axis (the transform origin is the
// center). Called after every zoom/pan change.
function _clampZoom() {
  const w = galleryBig.clientWidth || window.innerWidth;
  const h = galleryBig.clientHeight || window.innerHeight;
  const maxTx = (zoomScale - 1) * w / 2;
  const maxTy = (zoomScale - 1) * h / 2;
  zoomTx = Math.max(-maxTx, Math.min(maxTx, zoomTx));
  zoomTy = Math.max(-maxTy, Math.min(maxTy, zoomTy));
  _applyZoom();
}

function resetGalleryZoom() {
  _ptrs.clear();
  _pinch.active = false;
  _pan.active = false;
  zoomScale = 1; zoomTx = 0; zoomTy = 0;
  _applyZoom();
}

// On touch the browser's own pinch/page-zoom is disabled by the
// touch-action:none CSS on #galleryBig, so these handlers own the gesture.
galleryBig.addEventListener('pointerdown', e => {
  if (galleryMode !== 'lightbox') return;
  _ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { galleryBig.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
  if (_ptrs.size === 2) {
    // Second finger down: begin the pinch from the CURRENT scale/pan.
    _pinch.active = true;
    _pan.active = false;
    const [a, b] = [..._ptrs.values()];
    _pinch.startDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    _pinch.startScale = zoomScale;
    _pinch.startTx = zoomTx;
    _pinch.startTy = zoomTy;
    _pinch.m0x = (a.x + b.x) / 2;
    _pinch.m0y = (a.y + b.y) / 2;
  } else if (_ptrs.size === 1 && zoomScale > 1.0001) {
    // First finger down while zoomed: pan.
    _pan.active = true;
    _pan.lastX = e.clientX;
    _pan.lastY = e.clientY;
  }
});

galleryBig.addEventListener('pointermove', e => {
  if (galleryMode !== 'lightbox' || !_ptrs.has(e.pointerId)) return;
  _ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (_pinch.active && _ptrs.size >= 2) {
    const [a, b] = [..._ptrs.values()].slice(0, 2);
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const s = Math.min(_ZOOM_MAX, Math.max(1, _pinch.startScale * dist / _pinch.startDist));
    // Keep the content point that was under the pinch-start midpoint under
    // the CURRENT midpoint: T1 = M1 - C - (s/s0)·(M0 - C - T0), C = element
    // center (the transform origin).
    const cx = galleryBig.clientWidth / 2 || window.innerWidth / 2;
    const cy = galleryBig.clientHeight / 2 || window.innerHeight / 2;
    const k = s / _pinch.startScale;
    zoomScale = s;
    zoomTx = (a.x + b.x) / 2 - cx - k * (_pinch.m0x - cx - _pinch.startTx);
    zoomTy = (a.y + b.y) / 2 - cy - k * (_pinch.m0y - cy - _pinch.startTy);
    _clampZoom();
  } else if (_pan.active && _ptrs.size === 1) {
    zoomTx += e.clientX - _pan.lastX;
    zoomTy += e.clientY - _pan.lastY;
    _pan.lastX = e.clientX;
    _pan.lastY = e.clientY;
    _clampZoom();
  }
});

function _galleryPointerUp(e) {
  if (galleryMode !== 'lightbox') return;
  _ptrs.delete(e.pointerId);
  if (_pinch.active && _ptrs.size < 2) {
    // A finger lifted mid-pinch: hand the pan over to the remaining finger
    // so the image does not jump when the user keeps dragging.
    _pinch.active = false;
    if (_ptrs.size === 1) {
      const [p] = [..._ptrs.values()];
      _pan.active = true;
      _pan.lastX = p.x;
      _pan.lastY = p.y;
    }
  }
  if (_ptrs.size === 0) _pan.active = false;
  _applyZoom(); // snap a nearly-1x scale back to a clean 1x
}
galleryBig.addEventListener('pointerup', _galleryPointerUp);
galleryBig.addEventListener('pointercancel', _galleryPointerUp);

// Mouse wheel (desktop): zoom toward the cursor. preventDefault stops the
// page from scrolling and trackpad browser-gestures (back/forward) while
// the cursor is over the image; passive:false is required for that.
galleryBig.addEventListener('wheel', e => {
  if (galleryMode !== 'lightbox') return;
  e.preventDefault();
  // ~1.16x per wheel notch (deltaY=100); trackpad deltas are smaller, so
  // the same factor scales smoothly for them too.
  const s = Math.min(_ZOOM_MAX, Math.max(1, zoomScale * Math.exp(-e.deltaY * 0.0015)));
  if (s === zoomScale) { _applyZoom(); return; }
  // Anchor: keep the content point that was under the cursor under the
  // cursor — T1 = M - C - (s1/s0)·(M - C - T0), with M,C relative to the
  // element center (the transform origin).
  const rect = galleryBig.getBoundingClientRect();
  const mx = e.clientX - rect.left - rect.width / 2;
  const my = e.clientY - rect.top - rect.height / 2;
  const k = s / zoomScale;
  zoomScale = s;
  zoomTx = mx - k * (mx - zoomTx);
  zoomTy = my - k * (my - zoomTy);
  _clampZoom();
}, { passive: false });

// Extend comparisons (different canvas sizes) use the same Original/Extended
// toggle as the Edit pane instead of the overlay slider.
function setGalleryExtendView(showOriginal) {
  const original = !!showOriginal;
  gallerySlider.classList.toggle('show-original', original);
  if (galleryExtendOriginalBtn) {
    galleryExtendOriginalBtn.classList.toggle('active', original);
    galleryExtendOriginalBtn.setAttribute('aria-pressed', String(original));
  }
  if (galleryExtendResultBtn) {
    galleryExtendResultBtn.classList.toggle('active', !original);
    galleryExtendResultBtn.setAttribute('aria-pressed', String(!original));
  }
}

function configureGalleryExtendToggle(enabled, resultLabel) {
  const on = !!enabled;
  const label = resultLabel || 'Extended';
  gallerySlider.classList.toggle('extend-toggle-mode', on);
  if (!on) gallerySlider.classList.remove('show-original');
  if (galleryExtendToggle) {
    galleryExtendToggle.style.display = on ? 'flex' : 'none';
    galleryExtendToggle.setAttribute('aria-label', `Compare original and ${label.toLowerCase()}`);
  }
  if (galleryExtendResultBtn) galleryExtendResultBtn.textContent = label;
  if (on) setGalleryExtendView(false); // default: show the result side
}

// Paint the bottom-right N/M pill. While the sheet is open the pill follows
// the sheet SELECTION (galleryGridIdx); the individual view keeps using
// galleryIdx, so closing the sheet restores the pill to what is shown.
function _paintGalleryCounter(idx) {
  if (!galleryCounter || !galleryEntries.length || idx < 0) return;
  const text = (idx + 1) + '/' + galleryEntries.length;
  if (galleryCounterText) galleryCounterText.textContent = text;
  else galleryCounter.textContent = text;
}

// ── Render the current gallery item ────────
function renderGalleryItem() {
  const e = galleryEntries[galleryIdx];
  if (!e) return;
  // Start clean: a badge box or info panel opened by click must not linger
  // when navigating to another entry.
  closeBadgeBox();
  closeGalleryInfo();
  galleryInfoBtn.style.display = 'flex';
  if (galleryMode === 'lightbox') {
    configureGalleryExtendToggle(false);
    galleryBig.src = e.src;
    // Badge overlay (top-center): the transform that produced this image.
    // The badge is shown alone — the prompt boxes only appear when it is
    // CLICKED (see the badge click handler), which hides the badge.
    if (e.badge) {
      galleryBadge.textContent = e.badge;
      galleryBadge.classList.add('show');
      // The "Upscaled" badge is informational only — no click action.
      galleryBadge.classList.toggle('no-action', e.badge === 'upscaled');
    } else {
      galleryBadge.classList.remove('show');
      galleryBadge.classList.remove('no-action');
      galleryBadge.textContent = '';
    }
  } else if (galleryMode === 'video') {
    configureGalleryExtendToggle(false);
    // Custom player for the current video entry (autoplay muted loop; the
    // player is rebuilt per navigation so the src is always fresh).
    galleryVideoWrap.innerHTML = '';
    // noFullscreenBtn=true: the overlay is ALREADY fullscreen (openVideoGallery
    // fullscreens #galleryOverlay) and the gallery's own ✕ (top-right) sits
    // exactly where the player's ⛶ would (top:12px/right:12px) — two buttons
    // stacked in the same corner, so the player's is dropped here too.
    galleryVideoWrap.appendChild(createVideoPlayer(e.src || e.display || e.url, true));
    galleryBadge.classList.remove('show');
    galleryBadge.textContent = '';
  } else {
    galleryBefore.src = e.before || e.src;
    galleryAfter.src = e.src;
    gallerySlider.style.setProperty('--p', '50%');
    galleryLabelAfter.textContent = compareKindLabel(e.kind);
    // Slider for the kinds that keep the source's canvas (edit, restore,
    // upscale, face swap) AND for adjust (same dimensions, pixel-aligned —
    // the divider compares corresponding areas). Only crop (different
    // dimensions/aspect) and extend (new canvas + padding offset) need the
    // one-image-at-a-time toggle.
    configureGalleryExtendToggle(e.kind === 'extend' || e.kind === 'crop', compareKindLabel(e.kind));
    galleryBadge.classList.remove('show');
    fitGallerySlider();
  }
  // N/M paginator (bottom-right): always visible in the gallery. The ‹ ›
  // buttons are ALWAYS visible too — a gallery implies navigation, so they
  // render DISABLED (greyed, no action) with a single entry instead of
  // disappearing. NB: all three use an explicit 'flex' (their CSS base is
  // display:none — '' would clear the inline style and they would never
  // show).
  const multi = galleryEntries.length > 1;
  galleryPrevBtn.style.display = 'flex';
  galleryNextBtn.style.display = 'flex';
  galleryPrevBtn.disabled = !multi;
  galleryNextBtn.disabled = !multi;
  galleryCounter.style.display = 'flex';
  _paintGalleryCounter(galleryIdx);
  syncGalleryGrid(); // rebuilds when the entry count changes, else syncs active
}

// ── Thumbnail grid (the counter button) ─────
// The contact sheet REPLACES the individual view inside the same overlay: it
// lists galleryEntries and selecting a thumb closes the grid and shows that
// entry. The cell size comes from galleryGridMetrics() (gallery-grid.js).
//
// PERFORMANCE: tiles are cheap (one <button> per entry) but the images are
// NOT preloaded — a 300-entry gallery would fire 300 requests. Each thumb is
// only requested when it approaches the visible area (IntersectionObserver on
// the sheet's scroll box) and at most GALLERY_GRID_CONCURRENCY requests are in
// flight at once. Resizing only re-lays out (CSS variables), never rebuilds,
// so scrolling/decoding never restarts.
let galleryGridOpen = false;
let galleryGridCols = 1;
// Keyboard/tap selection INSIDE the sheet. It is deliberately separate from
// galleryIdx (the individual view): moving with the arrows must not change
// what the big view/trash/info act on until a thumb is actually picked.
let galleryGridIdx = -1;
let _galleryGridSignature = '';
// When the sheet was opened from a PANE (▦ button), picking a thumb must land
// in the pane — not in the fullscreen individual view. Holds the tab.
let _paneGridTab = null;
// Tab whose gallery the overlay is showing (set by the openers) and, when a
// thumb is PICKED (not just navigated with ‹ ›), the tab whose pane must be
// repainted with that choice once the overlay closes.
let _galleryTab = null;
let _paneRepaintOnClose = null;

const GALLERY_GRID_CONCURRENCY = 6;   // simultaneous thumbnail requests
let _gridObserver = null;
let _gridQueue = [];
let _gridInFlight = 0;

function galleryGridMetricsNow(n) {
  // The grid's box = viewport − top bar (58) − padding (16/16). The container
  // is inset the same way in CSS, and visualViewport covers the mobile URL bar
  // changing height while the gallery is open.
  const vv = window.visualViewport;
  const width = (vv && vv.width) || window.innerWidth || 0;
  const height = (vv && vv.height) || window.innerHeight || 0;
  return galleryGridMetrics(n, Math.max(0, width - 32), Math.max(0, height - 58 - 16));
}

function galleryGridTitleText() {
  const label = galleryMode === 'video' ? 'Videos' : 'Images';
  const idx = galleryGridIdx >= 0 ? galleryGridIdx : galleryIdx;
  return `${label} · ${idx + 1}/${galleryEntries.length}`;
}

// Tile under the keyboard focus, or -1 when the focus is elsewhere (counter,
// document, etc.). Used by Enter/Space so a focused thumb is what opens.
function _gridThumbIndexFromTarget(target) {
  const tile = target && target.closest ? target.closest('.gallery-thumb') : null;
  if (!tile) return -1;
  const idx = Number(tile.dataset.index);
  return Number.isInteger(idx) ? idx : -1;
}

// Drop the observer, the pending queue and the counters (closing the sheet or
// rebuilding it). Detached tiles are skipped by _pumpGridQueue().
function _resetGridLoader() {
  if (_gridObserver) {
    try { _gridObserver.disconnect(); } catch (e) {}
    _gridObserver = null;
  }
  _gridQueue = [];
  _gridInFlight = 0;
}

function _pumpGridQueue() {
  while (_gridInFlight < GALLERY_GRID_CONCURRENCY && _gridQueue.length) {
    const job = _gridQueue.shift();
    const { tile, img, url } = job;
    if (!tile || !img || !img.isConnected) continue;
    _gridInFlight++;
    const settle = ok => {
      _gridInFlight = Math.max(0, _gridInFlight - 1);
      // Dim only images that ARE still there: a video poster that fails is
      // removed by its own handler so the tile falls back to the ▶ look.
      if (!ok && img.isConnected) tile.classList.add('broken');
      _pumpGridQueue();
    };
    img.addEventListener('load', () => settle(true), { once: true });
    img.addEventListener('error', () => settle(false), { once: true });
    img.src = url;
  }
}

function _requestGridThumb(tile, img, url) {
  if (!url || !img || img.getAttribute('src')) return;
  _gridQueue.push({ tile, img, url });
  _pumpGridQueue();
}

// Observe every image tile: the request happens only when the tile is within
// ~240px of the visible area (prefetch margin), so scrolling loads as you go.
function _observeGridTiles(tiles) {
  if (!galleryGridThumbs || !tiles.length) return;
  if (typeof IntersectionObserver !== 'function') {
    // Very old browser: fall back to loading them (still bounded by the queue).
    tiles.forEach(({ tile, img, url }) => _requestGridThumb(tile, img, url));
    return;
  }
  _gridObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const tile = entry.target;
      if (_gridObserver) _gridObserver.unobserve(tile);
      const rec = tile._gridThumb;
      if (rec) _requestGridThumb(tile, rec.img, rec.url);
    });
  }, { root: galleryGridThumbs, rootMargin: '240px 0px', threshold: 0.01 });
  tiles.forEach(({ tile }) => _gridObserver.observe(tile));
}

function renderGalleryGrid() {
  if (!galleryGridOpen || !galleryGridThumbs) return;
  const n = galleryEntries.length;
  if (!n) return;
  // Keep the sheet selection valid across rebuilds (e.g. a media deletion).
  if (galleryGridIdx < 0 || galleryGridIdx >= n) galleryGridIdx = n - 1;
  const m = galleryGridMetricsNow(n);
  galleryGridCols = m.cols;
  _galleryGridSignature = galleryMode + ':' + n;
  galleryGridThumbs.style.setProperty('--thumb', m.cell + 'px');
  galleryGridThumbs.style.setProperty('--gap', m.gap + 'px');
  if (galleryGridTitle) galleryGridTitle.textContent = galleryGridTitleText();
  _resetGridLoader();
  galleryGridThumbs.innerHTML = '';
  const imageTiles = [];
  galleryEntries.forEach((e, i) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'gallery-thumb' + (i === galleryGridIdx ? ' active' : '');
    tile.dataset.index = String(i);
    tile.setAttribute('aria-label', `Open ${i + 1} of ${n}`);
    tile.setAttribute('aria-current', i === galleryGridIdx ? 'true' : 'false');
    if (galleryMode === 'video') {
      // No <video> here on purpose: decoding N MP4s would be slow and heavy.
      // The poster is the SOURCE image the video was generated from (stored
      // on the entry); without it (old persisted entries) the tile stays the
      // plain ▶ placeholder.
      tile.classList.add('is-video');
      if (e.source) {
        const img = document.createElement('img');
        img.alt = '';
        img.draggable = false;
        img.decoding = 'async';
        tile.appendChild(img);
        tile._gridThumb = { img, url: e.source };
        imageTiles.push({ tile, img, url: e.source });
      }
      const play = document.createElement('span');
      play.className = 'gallery-thumb-play';
      play.setAttribute('aria-hidden', 'true');
      play.textContent = '▶';
      tile.appendChild(play);
    } else {
      // The <img> exists immediately (so the cell is laid out) but has NO src
      // yet: the observer above assigns it when the tile gets near the view.
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      tile.appendChild(img);
      tile._gridThumb = { img, url: e.src };
      imageTiles.push({ tile, img, url: e.src });
    }
    if (galleryMode === 'video' && e.source) {
      // A poster that fails to load must not hide the ▶ affordance.
      const poster = tile.querySelector('img');
      if (poster) poster.addEventListener('error', () => { poster.remove(); });
    }
    const idx = document.createElement('span');
    idx.className = 'gallery-thumb-index';
    idx.textContent = String(i + 1);
    tile.appendChild(idx);
    tile.addEventListener('click', ev => {
      ev.stopPropagation();
      galleryGridSelect(i);
    });
    galleryGridThumbs.appendChild(tile);
  });
  _observeGridTiles(imageTiles);
  _scrollActiveThumbIntoView(m.scroll);
  _paintGalleryCounter(galleryGridIdx);
}

// Re-layout WITHOUT rebuilding: update the cell size and the title, keep the
// already-rendered tiles (and their loaded images / scroll position).
function layoutGalleryGrid() {
  if (!galleryGridOpen || !galleryGridThumbs) return;
  const m = galleryGridMetricsNow(galleryEntries.length);
  galleryGridCols = m.cols;
  galleryGridThumbs.style.setProperty('--thumb', m.cell + 'px');
  galleryGridThumbs.style.setProperty('--gap', m.gap + 'px');
  if (galleryGridTitle) galleryGridTitle.textContent = galleryGridTitleText();
  _scrollActiveThumbIntoView(false);
}

function _scrollActiveThumbIntoView(force) {
  if (!galleryGridOpen || !galleryGridThumbs) return;
  const active = galleryGridThumbs.querySelector('.gallery-thumb.active');
  if (!active) return;
  if (force || galleryGridThumbs.scrollHeight > galleryGridThumbs.clientHeight) {
    active.scrollIntoView({ block: 'nearest' });
  }
}

function syncGalleryGridActive() {
  if (!galleryGridOpen || !galleryGridThumbs) return;
  galleryGridThumbs.querySelectorAll('.gallery-thumb').forEach(tile => {
    const on = Number(tile.dataset.index) === galleryGridIdx;
    tile.classList.toggle('active', on);
    tile.setAttribute('aria-current', on ? 'true' : 'false');
  });
  if (galleryGridTitle) galleryGridTitle.textContent = galleryGridTitleText();
  _paintGalleryCounter(galleryGridIdx);
  _scrollActiveThumbIntoView(false);
}

// Rebuild only when the entry set changed (count/mode); a plain navigation
// just moves the active ring (80 lazy <img> must not be recreated per arrow).
function syncGalleryGrid() {
  if (!galleryGridOpen) return;
  const signature = galleryMode + ':' + galleryEntries.length;
  if (signature !== _galleryGridSignature) {
    renderGalleryGrid();
    return;
  }
  syncGalleryGridActive();
}

// fromPane: the tab whose ▦ opened the sheet (selection returns to its pane);
// omitted when the in-gallery counter opens it (selection stays fullscreen).
function openGalleryGrid(fromPane) {
  if (!galleryGrid || !galleryEntries.length) return;
  _paneGridTab = fromPane || null;
  closeTextBoxes(); // one panel at a time
  galleryGridOpen = true;
  // Start on the entry the individual view is showing. Arrows move this
  // index only; galleryIdx is committed by galleryGridSelect().
  galleryGridIdx = galleryIdx;
  galleryGrid.classList.add('show');
  galleryGrid.setAttribute('aria-hidden', 'false');
  galleryOverlay.classList.add('grid-open');
  galleryCounter.setAttribute('aria-expanded', 'true');
  // A playing video must not keep decoding/playing behind the sheet.
  if (galleryMode === 'video' && galleryVideoWrap) {
    const video = galleryVideoWrap.querySelector('video');
    if (video) video.pause();
  }
  renderGalleryGrid();
  // Move the keyboard focus into the sheet, on the active tile.
  const active = galleryGridThumbs && galleryGridThumbs.querySelector('.gallery-thumb.active');
  if (active && typeof active.focus === 'function') {
    try { active.focus({ preventScroll: true }); } catch (e) { active.focus(); }
  }
}

function closeGalleryGrid(restoreFocus = true) {
  if (!galleryGridOpen) return;
  const focusInsideGrid = !!(galleryGrid && galleryGrid.contains(document.activeElement));
  galleryGridOpen = false;
  if (galleryGrid) {
    galleryGrid.classList.remove('show');
    galleryGrid.setAttribute('aria-hidden', 'true');
  }
  galleryOverlay.classList.remove('grid-open');
  if (galleryCounter) galleryCounter.setAttribute('aria-expanded', 'false');
  // Drop the thumbnails: a closed grid must not keep N images/decodes around.
  _resetGridLoader();
  if (galleryGridThumbs) galleryGridThumbs.innerHTML = '';
  _galleryGridSignature = '';
  galleryGridIdx = -1; // closing without picking discards the sheet selection
  _paintGalleryCounter(galleryIdx); // and restores the individual view's N/M
  // Escape/empty-area/toggle closes keep the focus on a visible control.
  if (restoreFocus && focusInsideGrid && galleryCounter
      && typeof galleryCounter.focus === 'function') {
    try { galleryCounter.focus({ preventScroll: true }); } catch (e) { galleryCounter.focus(); }
  }
}

function toggleGalleryGrid() {
  // Keep the pane origin across a close/reopen of the sheet.
  if (galleryGridOpen) closeGalleryGrid();
  else openGalleryGrid(_paneGridTab);
}

// Entries of a tab's pane gallery (the registries the pane navigates).
function paneEntriesFor(tab) {
  if (tab === 'generate') return window.galleryGenerated || [];
  if (tab === 'video') return window.galleryVideos || [];
  return (window.galleryComparisons || []).filter(c => c.tab === tab);
}

// Select a thumb: close the sheet and show that entry.
//  • opened from the pane (▦) → close the overlay and paint the PANE;
//  • opened from the in-gallery counter → stay in the fullscreen view.
// Index of `chosen` inside a tab's pane gallery: identity by reference first,
// then by URL/filename (the compare gallery navigates a COLLECTED copy, so the
// object may differ). -1 when it cannot be located.
function paneIndexOfEntry(tab, chosen) {
  const list = paneEntriesFor(tab);
  let idx = list.indexOf(chosen);
  if (idx < 0 && chosen) {
    idx = list.findIndex(x => x && (
      (x.src && chosen.src && absUrl(x.src) === absUrl(chosen.src))
      || (x.filename && chosen.filename && x.filename === chosen.filename)
    ));
  }
  return idx;
}

function galleryGridSelect(i) {
  if (!(i >= 0) || i >= galleryEntries.length) return;
  const fromPane = _paneGridTab;
  const chosen = galleryEntries[i];
  galleryIdx = i;
  galleryGridIdx = i;
  closeGalleryGrid(false); // a pick is committing, not cancelling
  if (fromPane) {
    // Opened from the pane's N/M button: paint the pane right away.
    const idx = paneIndexOfEntry(fromPane, chosen);
    paneIdx[fromPane] = idx >= 0 ? idx : -1;
    closeGallery(); // clears _paneGridTab and restores the pane
    if (idx >= 0) renderPane(fromPane);
    if (typeof syncPaneNav === 'function') syncPaneNav(fromPane);
    // Keep the keyboard in the pane the pick returned to.
    const paneId = (typeof TAB_PANE_IDS !== 'undefined' && TAB_PANE_IDS[fromPane])
      || (fromPane + 'OutputPane');
    const pane = document.getElementById(paneId);
    if (pane && typeof pane.focus === 'function') {
      try { pane.focus({ preventScroll: true }); } catch (e) { pane.focus(); }
    }
    return;
  }
  // Opened from the in-gallery counter: the pick must be what the pane shows
  // after leaving fullscreen (plain ‹ › navigation leaves the pane untouched).
  const tab = _galleryTab
    || (galleryMode === 'video' ? 'video'
      : galleryMode === 'lightbox' ? 'generate'
      : (chosen && chosen.tab) || null);
  if (tab) {
    const idx = paneIndexOfEntry(tab, chosen);
    if (idx >= 0) {
      paneIdx[tab] = idx;
      _paneRepaintOnClose = tab;
      if (typeof syncPaneNav === 'function') syncPaneNav(tab);
    }
  }
  resetGalleryZoom();
  renderGalleryItem();
  if (galleryCounter && typeof galleryCounter.focus === 'function') {
    try { galleryCounter.focus({ preventScroll: true }); } catch (e) { galleryCounter.focus(); }
  }
}

// ▦ in a pane: open this tool's gallery positioned on the shown entry and go
// straight to the sheet. Picking a thumb then returns to the pane.
async function openPaneGrid(tab) {
  tab = tab || currentTab;
  if (!tab) return;
  if (paneActionBlocked()) return;
  if (!paneGalleryCount(tab)) {
    showToast('Nothing to show yet');
    return;
  }
  if (tab === 'generate') await openGenerateLightbox(undefined, { verify: false });
  else if (tab === 'video') await openVideoGallery();
  else if (tab === 'face_swap') await openFaceSwapGallery({ verify: false });
  else await openCompareFullscreen(tab, { verify: false });
  if (!galleryOverlay.classList.contains('show')) return; // the opener toasted
  openGalleryGrid(tab);
  // The sheet is already visible: probe the stored files in the background
  // so a slow ComfyUI can never delay the first paint. dropMedia() updates
  // the open sheet, the counter and the pane if something is really gone.
  if (tab !== 'video') _verifyGalleriesInBackground();
}

let _galleryVerifyPromise = null;
// One background probe at a time. Opened from the pane's ▦ we deliberately do
// not await verifyStoredGalleries(): it probes every stored file (HEADs with
// concurrency 5) and used to delay the sheet. The fullscreen buttons keep the
// blocking behavior (verify defaults to true in the openers).
function _verifyGalleriesInBackground() {
  if (typeof verifyStoredGalleries !== 'function') return;
  if (_galleryVerifyPromise) return;
  _galleryVerifyPromise = Promise.resolve()
    .then(() => verifyStoredGalleries(true))
    .catch(() => {})
    .finally(() => { _galleryVerifyPromise = null; });
}

// Resize/orientation (and the mobile URL bar) change the visible box: only
// re-layout, so the thumbnails (and their scroll position) survive.
function refitGalleryGrid() {
  if (!galleryGridOpen) return;
  layoutGalleryGrid();
}

function galleryNav(delta) {
  if (!galleryMode || galleryEntries.length < 2) return;
  closeBadgeBox();
  galleryIdx = ((galleryIdx + delta) % galleryEntries.length + galleryEntries.length) % galleryEntries.length;
  resetGalleryZoom(); // a new entry always starts at 1x
  renderGalleryItem();
}

// ── Openers ────────────────────────────────
// The index of the entry the pane is CURRENTLY showing (paneCurrentEntry —
// paneIdx[tab] when the user navigated with ‹ ›, otherwise the most recent)
// inside a gallery collection, or -1 when the pane shows nothing or the
// entry is not in that collection. Used by the fullscreen openers so the
// overlay opens on the image the user was looking at in the normal view —
// not blindly on the most recent one. Matches by normalized src (robust
// against the DOM fallback entries of collectCompareEntries, whose ordering
// can differ from the registry).
function indexOfPaneEntry(collection, tab) {
  if (!tab || !collection || !collection.length) return -1;
  const current = paneCurrentEntry(tab);
  if (!current) return -1;
  const target = absUrl(current.src || current.display || current.url);
  return collection.findIndex(e => absUrl(e.src || e.display || e.url) === target);
}

// Generate lightbox: the GENERATED history (session), not the live DOM —
// so the history survives the pane only showing the last result. Called with
// the clicked img (to position on it) or nothing (⛶ → the entry the pane
// is currently showing, or the most recent).
async function openGenerateLightbox(img, { verify = true } = {}) {
  // Re-verify the persisted gallery against the server (cache-busted so a
  // file deleted mid-session is dropped before the overlay opens). Cheap:
  // one HEAD per unique filename, concurrency 5 — a few entries → <100ms.
  // The pane ▦ passes verify=false: it opens the sheet first and probes in
  // the background (openPaneGrid → _verifyGalleriesInBackground).
  if (verify) await verifyStoredGalleries(true);
  const all = window.galleryGenerated;
  if (!all.length) return showToast('Nothing to show yet');
  galleryMode = 'lightbox';
  _galleryTab = 'generate';
  galleryEntries = all;
  galleryBig.style.display = '';
  gallerySlider.style.display = 'none';
  if (galleryVideoWrap) galleryVideoWrap.style.display = 'none';
  let idx = all.length - 1; // default: most recent
  if (img && img.src) {
    // Position on the CLICKED image. e.src is stored RELATIVE
    // ('/media/x.png?type=temp') while the DOM img.src is ABSOLUTE
    // ('http://host/media/...') — a bare string comparison never matches,
    // silently opening the lightbox on the LAST entry instead (visible
    // since the pane ‹ › nav can land on older entries). Match by ComfyUI
    // filename first, then by normalized absolute URL.
    let i = -1;
    const fn = filenameFromUrl(img.src);
    if (fn) i = all.findIndex(e => (e.filename || '') === fn);
    if (i < 0) {
      const abs = absUrl(img.src);
      i = all.findIndex(e => absUrl(e.src) === abs);
    }
    if (i >= 0) idx = i;
  } else {
    // ⛶: the overlay opens on the entry the pane is showing right now (the
    // user may have navigated the pane with ‹ › to an older entry) — falls
    // back to the most recent when the pane shows nothing.
    const pi = indexOfPaneEntry(all, 'generate');
    if (pi >= 0) idx = pi;
  }
  galleryIdx = idx;
  resetGalleryZoom(); // opening always starts at 1x
  renderGalleryItem();
  openGalleryOverlay();
}

// Face swap fullscreen: the ⛶ button on the Face swap tab opens the
// COMPARE gallery of this tab's before/after comparisons (kind
// 'face_swap'), mirroring Edit/Upscale. Positions on the comparison the
// pane is currently showing, like the other openers.
async function openFaceSwapGallery({ verify = true } = {}) {
  if (verify) await verifyStoredGalleries(true); // drop dead files before showing
  const comps = collectCompareEntries().filter(c => c.kind === 'face_swap');
  if (!comps.length) return showToast('No face-swapped image yet');
  galleryMode = 'compare';
  _galleryTab = 'face_swap';
  galleryEntries = comps;
  galleryBig.style.display = 'none';
  gallerySlider.style.display = '';
  galleryVideoWrap.style.display = 'none';
  const i = indexOfPaneEntry(comps, 'face_swap');
  galleryIdx = i >= 0 ? i : comps.length - 1;
  renderGalleryItem();
  openGalleryOverlay();
}

// Edit/Upscale fullscreen: the ⛶ button opens THIS tool's gallery. It
// prefers the before/after comparisons of the current tool; when there are
// none but the tool has transformed entries in the generated gallery
// (edited/restored/upscaled with a badge), it falls back to a lightbox of
// those — so the button NEVER says "No comparison" while the tool has
// gallery content.
async function openCompareFullscreen(kind, { verify = true } = {}) {
  if (verify) await verifyStoredGalleries(true); // drop dead files before showing
  const tab = kind === 'upscale' ? 'upscale' : 'edit';
  // Comparisons belonging to THIS tool (the registry carries .tab; the DOM
  // fallback entries map kind → tab).
  const comps = collectCompareEntries().filter(c => {
    const t = c.tab || (c.kind === 'upscale' ? 'upscale' : 'edit');
    return t === tab;
  });
  if (!comps.length) {
    // The tool has no comparisons — do NOT fall back to the generated-image
    // gallery (that would open the wrong gallery); just say so.
    return showToast(kind === 'upscale' ? 'No upscaled image yet' : 'No edited image yet');
  }
  galleryMode = 'compare';
  _galleryTab = tab;
  galleryEntries = comps;
  galleryBig.style.display = 'none';
  gallerySlider.style.display = '';
  galleryVideoWrap.style.display = 'none';
  // Position on the comparison the pane is currently showing (paneIdx[tab]
  // via paneCurrentEntry), not on the first entry of this kind — the user
  // may have navigated the pane with ‹ › to an older comparison. Falls back
  // to the most recent one.
  const i = indexOfPaneEntry(comps, tab);
  galleryIdx = i >= 0 ? i : comps.length - 1;
  renderGalleryItem();
  openGalleryOverlay();
}

// Video fullscreen: the ⛶ button on the Video tab opens the generated
// videos gallery (window.galleryVideos) — the custom player fills the
// overlay, ‹› navigates and the 🗑️ deletes the shown entry.
async function openVideoGallery() {
  // NO existence verification here: videos are ComfyUI temp files that get
  // cleaned on server restart, and the user wants the gallery to show every
  // entry from the session/localStorage — a missing file just won't play.
  const all = window.galleryVideos;
  if (!all.length) return showToast(NO_VIDEOS_MSG);
  galleryMode = 'video';
  _galleryTab = 'video';
  galleryEntries = all;
  galleryBig.style.display = 'none';
  gallerySlider.style.display = 'none';
  galleryVideoWrap.style.display = '';
  // Position on the video the pane is currently showing (paneIdx.video via
  // paneCurrentEntry), not always the most recent — the user may have
  // navigated the pane with ‹ › to an older video. Falls back to the most
  // recent one.
  const i = indexOfPaneEntry(all, 'video');
  galleryIdx = i >= 0 ? i : all.length - 1;
  renderGalleryItem();
  openGalleryOverlay();
}

// Size the overlay slider to the image aspect + the real viewport (the
// compare-slider base CSS fills its container; inline w/h wins).
function fitGallerySlider() {
  // In extend mode the extended canvas is the reference (the original is
  // shown inside it via the toggle), so size the overlay to the AFTER image.
  const ref = gallerySlider.classList.contains('extend-toggle-mode') ? galleryAfter : galleryBefore;
  if (!ref.naturalWidth || !ref.naturalHeight) return;
  const r = ref.naturalWidth / ref.naturalHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  // Maximize the available area: the slider fills the viewport (object-fit
  // contain letterboxes the images inside).
  let w = vw, h = w / r;
  if (h > vh) { h = vh; w = h * r; }
  gallerySlider.style.width = w + 'px';
  gallerySlider.style.height = h + 'px';
}
galleryBefore.addEventListener('load', fitGallerySlider);
galleryAfter.addEventListener('load', fitGallerySlider);
window.addEventListener('resize', () => { if (galleryMode === 'compare') fitGallerySlider(); });
// The pane-mode ℹ️ box is centered on its output pane: keep it centered when
// the layout changes (window resize, orientation, bottom bar, viewport).
window.addEventListener('resize', _positionInfoPanel);
window.addEventListener('orientationchange', _positionInfoPanel);

// ── Image information (currently shown image) ───────
// The ℹ️ button replaces the old download button: it reads the technical
// parameters (resolution, steps, sampler, scheduler, model, LoRAs and
// weights) through GET /api/image-info. The backend reads the PNG metadata
// ComfyUI embeds and, for custom save nodes that write none, falls back to
// ComfyUI's history. Reading the real execution data (instead of the
// current tab controls) means an entry restored from localStorage reports
// what REALLY produced it.
let galleryInfoRequest = 0;

function closeGalleryInfo() {
  galleryInfoRequest++; // ignore an in-flight response for a closed panel
  if (galleryInfoPanel) {
    galleryInfoPanel.classList.remove('show');
    galleryInfoPanel.classList.remove('pane-mode');
  }
  _infoSizeGetter = null;
  _infoSourceGetter = null;
  _clearInfoAnchor();
  if (galleryInfoBtn) galleryInfoBtn.setAttribute('aria-expanded', 'false');
}

function _formatLoraWeight(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function _galleryInfoList(values) {
  if (!Array.isArray(values) || !values.length) return '—';
  return values.map(v => String(v)).join(' / ');
}

function _appendGalleryInfoTextRow(key, text, extraClass) {
  const row = document.createElement('div');
  row.className = 'gallery-info-row';
  const keyEl = document.createElement('span');
  keyEl.className = 'gallery-info-key';
  keyEl.textContent = key;
  const valueEl = document.createElement('span');
  valueEl.className = 'gallery-info-value' + (extraClass ? ' ' + extraClass : '');
  valueEl.textContent = text;
  row.append(keyEl, valueEl);
  galleryInfoRows.appendChild(row);
}

// The entries whose workflow has no sampler: the ℹ️ panel is COMPACT for them
// (Resolution + Model only). Compare entries carry `kind`, generated-history
// entries carry `badge` — accept both.
const COMPACT_INFO_KINDS = ['upscale', 'upscaled', 'crop', 'cropped', 'adjust', 'adjusted'];
function _infoIsCompact(entry) {
  if (!entry) return false;
  return COMPACT_INFO_KINDS.includes(entry.kind) || COMPACT_INFO_KINDS.includes(entry.badge);
}

// SOURCE resolution (the before side of the comparison), shown only for the
// operations whose result canvas differs from the source: upscale, crop and
// extend. It is read from the already-loaded <img> (naturalWidth/Height)
// without any backend call, and only rendered when it actually differs from
// the result (never a duplicated number).
let _infoSourceGetter = null;
const SOURCE_INFO_KINDS = ['upscale', 'upscaled', 'crop', 'cropped', 'extend', 'extended'];
function _infoShowsSource(entry) {
  if (!entry) return false;
  return SOURCE_INFO_KINDS.includes(entry.kind) || SOURCE_INFO_KINDS.includes(entry.badge);
}
function _infoSourceSizeNow() {
  if (typeof _infoSourceGetter !== 'function') return { w: 0, h: 0 };
  const size = _infoSourceGetter() || {};
  return { w: size.w || 0, h: size.h || 0 };
}

let _galleryInfoSnapshot = null;

// LoRAs are the only multi-line row: one line per LoRA, name on the left and
// weight on the right ("—" when the image used none).
function _appendGalleryInfoLoraRow(loras) {
  const loraRow = document.createElement('div');
  loraRow.className = 'gallery-info-row';
  const loraKey = document.createElement('span');
  loraKey.className = 'gallery-info-key';
  loraKey.textContent = 'LoRAs';
  const loraValue = document.createElement('span');
  loraValue.className = 'gallery-info-value';
  if (!loras.length) {
    loraValue.textContent = '—';
  } else {
    loras.forEach(lora => {
      const line = document.createElement('span');
      line.className = 'gallery-info-lora';
      const name = document.createElement('span');
      name.className = 'gallery-info-lora-name';
      name.textContent = lora && lora.name ? String(lora.name) : '—';
      const weight = document.createElement('span');
      weight.className = 'gallery-info-lora-weight';
      const weightText = _formatLoraWeight(lora && lora.weight);
      weight.textContent = weightText ? `× ${weightText}` : '';
      line.append(name, weight);
      loraValue.appendChild(line);
    });
  }
  loraRow.append(loraKey, loraValue);
  galleryInfoRows.appendChild(loraRow);
}

// The prompt moved here from the old Show-prompt button: the ℹ️ panel is the
// single place to inspect an image (parameters + prompts). The transformation
// prompt, plus the original generation prompt when it differs.
function _appendGalleryInfoPromptRows(entry) {
  const prompt = entry && typeof entry.prompt === 'string' ? entry.prompt : '';
  _appendGalleryInfoTextRow('Prompt', prompt || '—',
    prompt ? 'gallery-info-prompt' : '');
  const originalPrompt = entry && typeof entry.originalPrompt === 'string'
    ? entry.originalPrompt : '';
  if (originalPrompt && originalPrompt !== prompt) {
    _appendGalleryInfoTextRow('Original prompt', originalPrompt, 'gallery-info-prompt');
  }
}

function _renderGalleryInfo(meta, fallbackW, fallbackH, note, entry) {
  if (!galleryInfoRows) return;
  const w = (meta && meta.width) || fallbackW || 0;
  const h = (meta && meta.height) || fallbackH || 0;
  const loras = (meta && Array.isArray(meta.loras)) ? meta.loras : [];
  // COMPACT panels: the operations whose workflow has NO sampler (upscale,
  // crop, adjust) have nothing to report for steps/sampler/scheduler/LoRAs
  // and no prompt of their own — the panel shows only the rows that really
  // describe the produced file: Resolution (PNG header) and Model (from the
  // execution prompt, when the workflow loads one). Everything else keeps the
  // full list untouched.
  const compact = _infoIsCompact(entry);
  // Source resolution: only for the canvas-changing operations (upscale,
  // crop, extend) and only when it differs from the result. A missing or
  // unloadable source simply renders no row.
  const source = _infoShowsSource(entry) ? _infoSourceSizeNow() : { w: 0, h: 0 };
  const showSource = !!(w && h && source.w && source.h
    && (source.w !== w || source.h !== h));
  _galleryInfoSnapshot = { meta, fallbackW, fallbackH, note, entry, sourceW: source.w, sourceH: source.h };
  const models = _galleryInfoList(meta && meta.models);
  const rows = [['Resolution', w && h ? `${w} × ${h}` : '—']];
  if (showSource) rows.push(['Source', `${source.w} × ${source.h}`]);
  if (!compact) {
    rows.push(['Steps', _galleryInfoList(meta && meta.steps)]);
    rows.push(['Sampler', _galleryInfoList(meta && meta.samplers)]);
    rows.push(['Scheduler', _galleryInfoList(meta && meta.schedulers)]);
  }
  // The full layout always lists Model (even "—"); the compact one only when
  // the workflow actually loads one.
  if (!compact || models !== '—') rows.push(['Model', models]);

  galleryInfoRows.innerHTML = '';
  rows.forEach(([key, value]) => {
    const row = document.createElement('div');
    row.className = 'gallery-info-row';
    const keyEl = document.createElement('span');
    keyEl.className = 'gallery-info-key';
    keyEl.textContent = key;
    const valueEl = document.createElement('span');
    valueEl.className = 'gallery-info-value';
    valueEl.textContent = value;
    row.append(keyEl, valueEl);
    galleryInfoRows.appendChild(row);
  });

  // LoRAs and the prompt rows are skipped in the compact panels (their
  // workflows load no LoRAs and have no prompt of their own).
  if (!compact) {
    _appendGalleryInfoLoraRow(loras);
    _appendGalleryInfoPromptRows(entry);
  }

  if (galleryInfoNote) {
    galleryInfoNote.textContent = note || '';
    galleryInfoNote.style.display = note ? 'block' : 'none';
  }
}

// Resolution the browser already knows for the CURRENT panel entry (image
// natural size, or the <video> element's dimensions). Set per open so the
// panel can refresh it when a video's metadata arrives.
let _infoSizeGetter = null;

function _infoSizeNow() {
  if (typeof _infoSizeGetter !== 'function') return { w: 0, h: 0 };
  const size = _infoSizeGetter() || {};
  return { w: size.w || 0, h: size.h || 0 };
}

// The video's dimensions are 0 until its metadata loads; refresh just the
// resolution row when that happens (the panel may already be open).
function _refreshGalleryInfoSize() {
  if (!_galleryInfoSnapshot || !galleryInfoPanel.classList.contains('show')) return;
  const { w, h } = _infoSizeNow();
  const src = _infoSourceSizeNow();
  const s = _galleryInfoSnapshot;
  // Nothing the panel shows has changed (result and, for upscale, source).
  if (w === s.fallbackW && h === s.fallbackH && src.w === s.sourceW && src.h === s.sourceH) return;
  if (!w && !h) return;
  _renderGalleryInfo(s.meta, w, h, s.note, s.entry);
}

// The pane the pane-mode panel is anchored to (see _positionInfoPanel).
let _infoAnchorEl = null;

// Pane mode: center the BOX on the IMAGE (the output pane), not on the whole
// viewport — the backdrop still covers the screen for the click-anywhere
// dismiss. Recomputed on open and on every resize/orientation change while
// the panel is open (the pane changes size with the layout).
function _positionInfoPanel() {
  if (!_infoAnchorEl || !galleryInfoPanel || !galleryInfoPanel.classList.contains('pane-mode')) return;
  const r = _infoAnchorEl.getBoundingClientRect();
  if (!r.width || !r.height) return;
  galleryInfoPanel.style.setProperty('--info-cx', `${Math.round(r.left + r.width / 2)}px`);
  galleryInfoPanel.style.setProperty('--info-cy', `${Math.round(r.top + r.height / 2)}px`);
  galleryInfoPanel.style.setProperty('--info-max-w', `${Math.max(180, Math.round(r.width - 24))}px`);
  galleryInfoPanel.style.setProperty('--info-max-h', `${Math.max(120, Math.round(r.height - 24))}px`);
}

function _clearInfoAnchor() {
  _infoAnchorEl = null;
  if (!galleryInfoPanel) return;
  ['--info-cx', '--info-cy', '--info-max-w', '--info-max-h']
    .forEach(prop => galleryInfoPanel.style.removeProperty(prop));
}

// The Fullscreen API renders ONLY the fullscreen element and its descendants,
// so a body-level panel is INVISIBLE while the gallery is fullscreen (that is
// what happened on mobile, where requestFullscreen from a tap succeeds while
// desktop often rejects it). The shared panel is therefore MOUNTED into
// whichever element is fullscreen — and back on <body> otherwise — right
// before it is shown. Moving the node keeps its listeners/classes intact.
function _mountInfoPanel() {
  if (!galleryInfoPanel) return;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
  const parent = fsEl || document.body;
  if (galleryInfoPanel.parentElement !== parent) parent.appendChild(galleryInfoPanel);
}

// The SHARED panel (fullscreen gallery + normal view): technical parameters
// (resolution, steps, sampler, scheduler, model, LoRAs/weights) AND the
// prompt (plus the original prompt when the entry is a transformation). The
// backend reads the parameters from the PNG metadata ComfyUI embeds, falling
// back to ComfyUI's history when the save node writes none.
//
// opts: {entry, src, isVideo, skipMedia, paneMode, getSize, getSourceSize}
//   getSourceSize — () => {w,h} of the before image (upscale/crop/extend)
//   entry     — the gallery entry (prompts + filename)
//   src       — the media URL (used for the filename/type detection)
//   isVideo   — title + skip_media (do not download the MP4)
//   paneMode  — opened from a pane: the backdrop catches the dismiss click
//   getSize   — () => {w,h} the browser knows (refreshed on video metadata)
//   sourceEl  — the before <img> (refresh when it finishes loading)
//   anchorEl  — pane-mode: the output pane the box centers on
// Toggles: calling it while the panel is open closes it.
async function _openInfoPanel(opts) {
  const { entry, src, isVideo, skipMedia, paneMode, getSize, anchorEl, getSourceSize, sourceEl } = opts || {};
  if (galleryInfoPanel.classList.contains('show')) {
    closeGalleryInfo();
    return;
  }
  _mountInfoPanel(); // a body-level panel would not render in fullscreen
  _infoSizeGetter = typeof getSize === 'function' ? getSize : null;
  _infoSourceGetter = typeof getSourceSize === 'function' ? getSourceSize : null;
  galleryInfoPanel.classList.toggle('pane-mode', !!paneMode);

  const requestId = ++galleryInfoRequest;
  let fallbackW = 0;
  let fallbackH = 0;
  // Show the panel immediately with what the browser knows (resolution),
  // then fill the technical rows when the backend answers.
  ({ w: fallbackW, h: fallbackH } = _infoSizeNow());
  if (galleryInfoTitle) {
    galleryInfoTitle.textContent = isVideo ? 'Video information' : 'Image information';
  }
  _renderGalleryInfo(null, fallbackW, fallbackH, '', entry);
  galleryInfoPanel.classList.add('show');
  _infoAnchorEl = paneMode && anchorEl ? anchorEl : null;
  _positionInfoPanel();
  if (galleryInfoBtn) galleryInfoBtn.setAttribute('aria-expanded', 'true');
  if (isVideo) {
    const size = _infoSizeNow();
    if (size.w && size.h) _refreshGalleryInfoSize();
    else {
      // The panel is opened from the gallery or from the Video pane: find
      // the <video> element through the size getter's own source.
      const video = (paneMode ? document.getElementById('videoOutputPane') : galleryVideoWrap);
      const el = video ? video.querySelector('video') : null;
      if (el) el.addEventListener('loadedmetadata', _refreshGalleryInfoSize, { once: true });
    }
  }

  // The before image may still be loading — repaint when it lands so the
  // Source row appears without reopening the panel.
  if (sourceEl && _infoShowsSource(entry) && !(sourceEl.naturalWidth && sourceEl.naturalHeight)) {
    sourceEl.addEventListener('load', _refreshGalleryInfoSize, { once: true });
  }

  const filename = (entry && entry.filename)
    || (src && typeof filenameFromUrl === 'function' ? filenameFromUrl(src) : null);
  if (!filename) {
    _renderGalleryInfo(null, fallbackW, fallbackH,
      'Technical metadata is not available for this entry.', entry);
    return;
  }
  const type = typeof fileTypeFromUrl === 'function' ? fileTypeFromUrl(src) : 'output';
  // Videos: do not download the (possibly large) MP4 just to read metadata —
  // the <video> element already provides the resolution, and the parameters
  // come from ComfyUI history.
  const url = '/api/image-info?filename=' + encodeURIComponent(filename)
    + '&type=' + encodeURIComponent(type)
    + (skipMedia ? '&skip_media=1' : '');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const meta = await r.json();
    if (requestId !== galleryInfoRequest || !galleryInfoPanel.classList.contains('show')) return;
    // Recompute the fallback: the video's metadata may have loaded while
    // the backend was answering, so the resolution is available now.
    ({ w: fallbackW, h: fallbackH } = _infoSizeNow());
    _renderGalleryInfo(meta, fallbackW, fallbackH,
      meta && meta.has_metadata === false
        ? 'Technical metadata is not available for this entry.' : '', entry);
  } catch (err) {
    if (requestId !== galleryInfoRequest || !galleryInfoPanel.classList.contains('show')) return;
    ({ w: fallbackW, h: fallbackH } = _infoSizeNow());
    _renderGalleryInfo(null, fallbackW, fallbackH,
      'Technical metadata is not available for this entry.', entry);
  }
}

// Fullscreen gallery: the CURRENT entry (ℹ️ button / `i` key).
async function galleryShowInfo() {
  const e = galleryEntries[galleryIdx];
  if (!e) return;
  if (galleryInfoPanel.classList.contains('show')) {
    closeGalleryInfo();
    return;
  }
  if (galleryBadgeBox.classList.contains('show')) {
    closeBadgeBox();
    renderGalleryItem(); // restore the badge the box had hidden
  }

  const isVideo = galleryMode === 'video';
  const src = e.src || (isVideo ? (e.url || e.src || '')
    : galleryMode === 'compare' ? galleryAfter.src : galleryBig.src);
  // The before image of the comparison (upscale/crop/extend; in lightbox mode
  // galleryBefore still holds the previous comparison — never use it there).
  const compareBefore = galleryMode === 'compare' ? galleryBefore : null;
  await _openInfoPanel({
    entry: e,
    src,
    isVideo,
    skipMedia: isVideo,
    sourceEl: compareBefore,
    getSourceSize: () => (compareBefore
      ? { w: compareBefore.naturalWidth || 0, h: compareBefore.naturalHeight || 0 }
      : { w: 0, h: 0 }),
    getSize: () => {
      if (isVideo) {
        const video = galleryVideoWrap ? galleryVideoWrap.querySelector('video') : null;
        return { w: (video && video.videoWidth) || 0, h: (video && video.videoHeight) || 0 };
      }
      const image = galleryMode === 'compare' ? galleryAfter : galleryBig;
      return { w: (image && image.naturalWidth) || 0, h: (image && image.naturalHeight) || 0 };
    },
  });
}

// NORMAL view: the result currently shown in a pane (pane ℹ️ button / `i`
// key). Same panel, same rows; the resolution fallback comes from the pane's
// own <img>/<video> element. Toggles like the gallery's.
function paneShowInfo(tab) {
  tab = tab || currentTab;
  if (!tab) return;
  if (galleryInfoPanel.classList.contains('show')) {
    closeGalleryInfo();
    return;
  }
  const entry = typeof paneCurrentEntry === 'function' ? paneCurrentEntry(tab) : null;
  if (!entry) {
    showToast('Nothing to show yet');
    return;
  }
  const isVideo = tab === 'video';
  const paneId = (typeof TAB_PANE_IDS !== 'undefined' && TAB_PANE_IDS[tab])
    || (tab + 'OutputPane');
  const pane = document.getElementById(paneId);
  const img = pane
    ? (pane.querySelector('.compare-slider img.side.after') || pane.querySelector('.result-img'))
    : null;
  // The before side of the pane comparison (its natural size is the source
  // resolution — used by upscale/crop/extend).
  const beforeImg = pane ? pane.querySelector('.compare-slider img.side.before') : null;
  const video = pane ? pane.querySelector('video') : null;
  const src = isVideo
    ? (entry.url || entry.src || entry.display || '')
    : (entry.src || '');
  _openInfoPanel({
    entry,
    src,
    isVideo,
    skipMedia: isVideo,
    paneMode: true,
    anchorEl: pane,
    sourceEl: beforeImg,
    getSourceSize: () => (beforeImg
      ? { w: beforeImg.naturalWidth || 0, h: beforeImg.naturalHeight || 0 }
      : { w: 0, h: 0 }),
    getSize: () => (isVideo
      ? { w: (video && video.videoWidth) || 0, h: (video && video.videoHeight) || 0 }
      : { w: (img && img.naturalWidth) || 0, h: (img && img.naturalHeight) || 0 }),
  });
}

// Remove one entry from the registry that owns the gallery it was shown in.
// lightbox → galleryGenerated, video → galleryVideos, compare →
// galleryComparisons. Matching keeps the historical behavior of the 🗑️
// button: by ComfyUI filename when available (so a persisted/DOM-fallback
// entry still matches), by AFTER src for comparisons, and by src for entries
// without a filename.
function removeGalleryEntryFromRegistry(e, mode) {
  if (!e) return;
  const fn = e.filename || (e.src && typeof filenameFromUrl === 'function'
    ? filenameFromUrl(e.src) : null);
  if (mode === 'lightbox') {
    window.galleryGenerated = (window.galleryGenerated || []).filter(x => {
      const xf = x.filename || (x.src && filenameFromUrl ? filenameFromUrl(x.src) : null);
      return !(fn && xf === fn) && !(!fn && x.src === e.src);
    });
  } else if (mode === 'video') {
    window.galleryVideos = (window.galleryVideos || []).filter(x => {
      const xf = x.filename || (x.src && filenameFromUrl ? filenameFromUrl(x.src) : null);
      return !(fn && xf === fn) && !(!fn && x.src === e.src);
    });
  } else {
    const afterSrc = e.src || galleryAfter.src;
    window.galleryComparisons = (window.galleryComparisons || []).filter(
      x => !(x.src === e.src) && !(afterSrc && x.src === afterSrc)
    );
  }
}

// ── Delete current gallery entry ────────────
// The 🗑️ overlay button (bottom-left) removes ONLY the entry currently
// shown fullscreen — from the live registry AND the persisted storage —
// then navigates (or closes if it was the last one) and re-renders.
function galleryDeleteCurrent() {
  const e = galleryEntries[galleryIdx];
  if (!e) return;
  const fn = e.filename || (e.src && typeof filenameFromUrl === 'function' ? filenameFromUrl(e.src) : null);
  closeBadgeBox();
  closeGalleryInfo();

  // Generated results are also source candidates in the 🕘 popover, so a
  // manual delete here must forget the image there as well (all tabs).
  if (typeof forgetSourceHistoryEntry === 'function') forgetSourceHistoryEntry(e);

  // 1) Remove from the persisted registry (the source of truth).
  removeGalleryEntryFromRegistry(e, galleryMode);

  // If the deleted entry was what the ACTIVE tool's pane was showing, clear
  // the pane so closing the gallery restores the next/last generation (or
  // the idle placeholder) instead of leaving a ghost of the deleted file.
  // The DOM src is an ABSOLUTE URL (the browser resolves /media/...) while
  // the registry srcs are relative — compare by ComfyUI filename (filenameFromUrl
  // handles both), not by raw strings (a raw === would never match and leave
  // the ghost visible until a reload).
  const paneIds = { generate: 'genOutputPane', edit: 'editOutputPane', upscale: 'upscaleOutputPane', video: 'videoOutputPane', face_swap: 'faceSwapOutputPane' };
  const pane = document.getElementById(paneIds[currentTab]);
  if (pane) {
    // The pane's shown src: result-img .src, video-player > video .src, or
    // compare-slider > img.side.after .src.
    const img = pane.querySelector('.result-img');
    const vid = pane.querySelector('.video-player video');
    const cmpAfter = pane.querySelector('.compare-slider img.side.after');
    const shownSrc = (img && img.src) || (vid && vid.src) || (cmpAfter && cmpAfter.src) || null;
    const shownFn = shownSrc ? filenameFromUrl(shownSrc) : null;
    if (shownFn && fn && shownFn === fn) clearPane(pane.id);
  }

  // 2) Remove from the live entries + navigate/clamp.
  galleryEntries.splice(galleryIdx, 1);
  if (galleryEntries.length === 0) {
    closeGallery(); // nothing left — close the overlay
    if (typeof savePersistedState === 'function') savePersistedState();
    if (currentTab) syncPaneNav(currentTab);
    return;
  }
  // Navigate to the next entry (wrap), or clamp to the new last.
  if (galleryIdx >= galleryEntries.length) galleryIdx = galleryEntries.length - 1;
  resetGalleryZoom(); // the shown entry changed — back to 1x
  renderGalleryItem();
  if (typeof savePersistedState === 'function') savePersistedState();
  if (currentTab) syncPaneNav(currentTab);
}

// Empty one tool's output pane and result row after its LAST gallery entry
// was deleted. Shared by the toolbar trash and the per-entry Delete key.
function clearPaneResult(tab) {
  const paneIds = { generate: 'genOutputPane', edit: 'editOutputPane', upscale: 'upscaleOutputPane', video: 'videoOutputPane', face_swap: 'faceSwapOutputPane' };
  const paneId = paneIds[tab];
  if (!paneId) return;
  clearPane(paneId);
  const pane = document.getElementById(paneId);
  if (pane && !pane.querySelector('.output-placeholder') && tab === 'generate') {
    const ph = document.createElement('div');
    ph.className = 'output-placeholder';
    ph.innerHTML = '<div class="icon">🖼️</div><p>Your generated image<br>will appear here</p>' +
                   '<p style="font-size:.75rem;margin-top:6px;">Click to open lightbox</p>';
    pane.insertBefore(ph, pane.firstChild);
  }
  // Clear the shared result row only when the emptied pane is the ACTIVE tab.
  if (currentTab !== tab) return;
  const rel = document.getElementById('resultUrl');
  if (rel) { rel.textContent = ''; rel.title = ''; rel.classList.remove('clickable'); }
  const rt = document.getElementById('resultTime');
  if (rt) rt.textContent = '';
  const rcb = document.getElementById('resultCopyBox');
  if (rcb) { clearTimeout(_resultCopyTimer); rcb.classList.remove('show'); }
  currentResultUrl = '';
}

// Delete the generation SHOWN IN THE ACTIVE TOOL'S PANE (Delete key). Mirrors
// the fullscreen 🗑️ for that single entry: forget the source-history entry,
// remove it from its registry, then show the next survivor or the idle state.
// A running job owns the pane (live preview + lock): the pane actions stay
// visible (like 📁/🔗/🕘) but refuse, with the same message as the other locks.
function paneActionBlocked() {
  if (typeof progressTimer !== 'undefined' && progressTimer) {
    showToast('Generation in progress…');
    return true;
  }
  return false;
}

// Pane 🗑️ button: the same action as the Delete key, with feedback when the
// pane has nothing to delete.
function paneDeleteShown() {
  if (paneActionBlocked()) return;
  if (typeof paneDeleteCurrent === 'function' && paneDeleteCurrent()) return;
  showToast('Nothing to delete');
}

function paneDeleteCurrent() {
  const tab = currentTab;
  if (!tab) return false;
  // A running job owns the pane progress/lock; don't mutate history under it.
  if (typeof progressTimer !== 'undefined' && progressTimer) return false;
  const e = paneCurrentEntry(tab);
  if (!e) return false;
  const mode = tab === 'generate' ? 'lightbox' : tab === 'video' ? 'video' : 'compare';
  const listOf = () => tab === 'generate' ? (window.galleryGenerated || [])
    : tab === 'video' ? (window.galleryVideos || [])
    : (window.galleryComparisons || []).filter(c => c.tab === tab);
  const idx = listOf().indexOf(e);

  if (typeof forgetSourceHistoryEntry === 'function') forgetSourceHistoryEntry(e);
  removeGalleryEntryFromRegistry(e, mode);

  const next = listOf();
  if (!next.length) {
    paneIdx[tab] = -1;
    clearPaneResult(tab);
  } else {
    // Show the entry that took the deleted one's position, or the new last.
    paneIdx[tab] = idx >= 0 && idx < next.length ? idx : -1;
    renderPane(tab);
  }
  if (typeof savePersistedState === 'function') savePersistedState();
  syncPaneNav(tab);
  return true;
}

// ── Confirmed deletions (ComfyUI cleanup → UI) ──
// One code path for every place that shows generation state, so the N/M
// counter, the pane's ‹ › navigation, the pane content and the 🕘 grid all
// reflect reality at once. Only CONFIRMED deletions arrive here (the cleanup
// task's /api/media-deleted hook → /ws/events, or the one-shot restore probe)
// — nothing is ever hidden by age or by a guess.
function dropMedia(filenames, opts) {
  if (typeof mediaDropPlan !== 'function' || !Array.isArray(filenames) || !filenames.length) return;
  const quiet = !!(opts && opts.quiet);
  const state = {
    generated: window.galleryGenerated || [],
    videos: window.galleryVideos || [],
    comparisons: window.galleryComparisons || [],
    sourceHistory: typeof sourceHistory === 'object' && sourceHistory ? sourceHistory : {},
    lastSources: typeof lastSourceByTab === 'object' && lastSourceByTab ? lastSourceByTab : {},
    lastGeneratedUrl: typeof lastGeneratedUrl === 'string' ? lastGeneratedUrl : '',
  };
  // Which entry each pane was showing, captured BEFORE the arrays change:
  // paneIdx is positional, so after a removal the same index would point at a
  // DIFFERENT image. Identity is the only stable anchor.
  const before = {};
  Object.keys(paneIdx).forEach(tab => { before[tab] = paneCurrentEntry(tab); });

  const plan = mediaDropPlan(state, filenames);
  if (!plan.changed) return;

  window.galleryGenerated = plan.generated;
  window.galleryVideos = plan.videos;
  window.galleryComparisons = plan.comparisons;
  if (plan.sourceHistory) sourceHistory = plan.sourceHistory;
  if (plan.lastSources) Object.assign(lastSourceByTab, plan.lastSources);
  plan.beforeResets.forEach(e => { e.before = ''; }); // result survives, its source doesn't
  if (plan.lastGeneratedGone) lastGeneratedUrl = '';

  const paneIds = {
    generate: 'genOutputPane', edit: 'editOutputPane', upscale: 'upscaleOutputPane',
    video: 'videoOutputPane', face_swap: 'faceSwapOutputPane',
  };
  const collections = {
    generate: window.galleryGenerated,
    edit: window.galleryComparisons.filter(c => c.tab === 'edit'),
    upscale: window.galleryComparisons.filter(c => c.tab === 'upscale'),
    face_swap: window.galleryComparisons.filter(c => c.tab === 'face_swap'),
    video: window.galleryVideos,
  };
  // Filename the pane's DOM is actually showing (result / video / compare after).
  const shownFilename = paneId => {
    const pane = document.getElementById(paneId);
    if (!pane) return null;
    const el = pane.querySelector('.result-img')
      || pane.querySelector('.video-player video')
      || pane.querySelector('.compare-slider img.side.after');
    return el && el.src ? filenameFromUrl(el.src) : null;
  };

  Object.keys(paneIdx).forEach(tab => {
    const col = collections[tab] || [];
    const cur = before[tab];
    const idx = cur ? col.indexOf(cur) : -1;
    // Same image still exists → keep the pane on it, at its new position
    // (-1 still means "most recent", so the default survives new arrivals).
    paneIdx[tab] = idx >= 0 && idx !== col.length - 1 ? idx : -1;
    if (idx >= 0) {
      // The after image survives, but its BEFORE file is gone: re-render so
      // the slider shows the result on both sides instead of a broken image.
      if (cur && plan.beforeResets.includes(cur)) {
        const pane = document.getElementById(paneIds[tab]);
        const slider = pane && pane.querySelector('.compare-slider');
        if (slider && (slider.style.display || '') !== 'none') renderPane(tab);
      }
      return;
    }
    // The pane was showing a dropped entry — but only touch the DOM when it
    // really is the file that disappeared (a pane can be empty/never restored).
    if (shownFilename(paneIds[tab]) && plan.gone.has(shownFilename(paneIds[tab]))) {
      if (col.length) renderPane(tab); // fall back to the nearest survivor
      else { clearPane(paneIds[tab]); syncResultUrl(tab, null); }
    }
  });

  // Open fullscreen gallery: re-collect (compare mode holds a COPY of the
  // registry) and repaint, so the counter and the ‹ › buttons are exact.
  if (galleryMode) {
    if (galleryMode === 'lightbox') galleryEntries = window.galleryGenerated;
    else if (galleryMode === 'video') galleryEntries = window.galleryVideos;
    else galleryEntries = collectCompareEntries();
    if (!galleryEntries.length) {
      closeGallery();
    } else {
      if (galleryIdx >= galleryEntries.length) galleryIdx = galleryEntries.length - 1;
      resetGalleryZoom();
      renderGalleryItem(); // repaints N/M (galleryCounter)
    }
  }

  // 🕘 popover: its grid mixes uploads, URLs and generated results, so the
  // same drop applies there. No numeric counter, but the grid must match.
  if (typeof renderSourceHistoryGrid === 'function'
      && typeof _sourceHistoryTab === 'string' && _sourceHistoryTab) {
    renderSourceHistoryGrid(_sourceHistoryTab);
  }
  if (typeof hideSourceHistoryPeek === 'function') hideSourceHistoryPeek();

  if (typeof savePersistedState === 'function') savePersistedState();
  Object.keys(paneIdx).forEach(tab => syncPaneNav(tab));
  // One toast per event, counting FILES (the same generation can live in
  // several registries: gallery + 🕘 + face-swap base). A before-only reset
  // leaves the result visible, so it is not announced as a removal.
  if (!quiet && plan.removed.length) {
    const n = new Set(plan.removed.map(e => mediaEntryFilename(e)).filter(Boolean)).size || 1;
    showToast(n > 1
      ? n + ' generations were cleaned up by ComfyUI and removed'
      : 'That generation was cleaned up by ComfyUI and removed');
  }
}

// ── Pane navigation ‹ › (normal view) ──────
// Each tool's output pane shows its gallery's most recent entry. The ‹ ›
// buttons on the pane (visible when the tool's gallery holds more than one
// entry) navigate the SAME session registries as the fullscreen gallery —
// without leaving the normal view (see paneIdx above).
function paneGalleryCount(tab) {
  switch (tab) {
    case 'generate': return (window.galleryGenerated || []).length;
    case 'edit':
    case 'upscale':
    case 'face_swap': return (window.galleryComparisons || []).filter(c => c.tab === tab).length;
    case 'video': return (window.galleryVideos || []).length;
    default: return 0;
  }
}

// The AFTER-side label of a before/after comparison, from its kind.
function compareKindLabel(kind) {
  return kind === 'edit' ? 'Edited' : kind === 'restore' ? 'Restored'
    : kind === 'extend' ? 'Extended'
    : kind === 'crop' ? 'Cropped'
    : kind === 'adjust' ? 'Adjusted'
    : kind === 'upscale' ? 'Upscaled'
    : kind === 'face_swap' ? 'Face swapped' : 'Result';
}

// The gallery entry the pane is CURRENTLY showing for a tab: paneIdx[tab]
// when the user navigated with ‹ ›, otherwise the most recent entry. Used
// both to render the pane and to keep the result-URL hint in sync.
function paneCurrentEntry(tab) {
  if (tab === 'generate') {
    const all = window.galleryGenerated || [];
    return all[paneIdx.generate === -1 ? all.length - 1 : paneIdx.generate] || null;
  }
  if (tab === 'edit' || tab === 'upscale') {
    const comps = (window.galleryComparisons || []).filter(c => c.tab === tab);
    return comps[paneIdx[tab] === -1 ? comps.length - 1 : paneIdx[tab]] || null;
  }
  if (tab === 'video') {
    const all = window.galleryVideos || [];
    return all[paneIdx.video === -1 ? all.length - 1 : paneIdx.video] || null;
  }
  if (tab === 'edit' || tab === 'upscale' || tab === 'face_swap') {
    const comps = (window.galleryComparisons || []).filter(c => c.tab === tab);
    return comps[paneIdx[tab] === -1 ? comps.length - 1 : paneIdx[tab]] || null;
  }
  return null;
}

// The result-URL hint row always reflects the image/video currently shown in
// the pane. Paints only when ``tab`` is the ACTIVE one (the row is shared
// across tabs — a tab switch clears it and the incoming tab's restore
// re-syncs it). ``entry`` carries the direct URL when available; otherwise
// fullComfyUrl rebuilds {base}/view?... from the display src (restore.js).
// The current result's copyable URL — kept by syncResultUrl for the
// fullscreen gallery's 📋 button (the hint row no longer shows the URL).
let currentResultUrl = '';

// The result row shows the generation URL (clickable → copy) + the timing
// chip. ``entry`` carries the direct URL when available; otherwise
// fullComfyUrl rebuilds {base}/view?... from the display src (restore.js).
// Paints only when ``tab`` is the ACTIVE one (the row is shared across
// tabs — a tab switch clears it and the incoming tab's restore re-syncs
// it).
function syncResultUrl(tab, entry) {
  if (currentTab !== tab) return;
  const el = document.getElementById('resultUrl');
  const timeEl = document.getElementById('resultTime');
  if (!el) return;
  // The URL (for the click-to-copy + the gallery copy button).
  currentResultUrl = (entry && (entry.url || (typeof fullComfyUrl === 'function' ? fullComfyUrl(entry) : ''))) || '';
  // Timing: the entry's own persisted duration (survives refresh / gallery
  // navigation) takes priority, else the last finished job's duration.
  let durSecs = (entry && entry.duration) || 0;
  if (!durSecs && typeof _lastJobDurationSecs === 'number' && _lastJobDurationSecs > 0) {
    durSecs = _lastJobDurationSecs;
  }
  if (currentResultUrl) {
    el.textContent = currentResultUrl;
    el.title = 'Click to copy'; // the URL itself is shown; the tooltip hints the action
    el.classList.add('clickable');
  } else {
    el.textContent = '';
    el.title = '';
    el.classList.remove('clickable');
  }
  if (timeEl) timeEl.textContent = durSecs > 0 ? '⏱ ' + fmtDuration(durSecs) : '';
}

let _resultCopyTimer = null;
// Click on the result URL in the row: copy it and show a confirmation box
// with the copied URL (no button needed). No-op when there is no URL.
function copyResultHint() {
  if (!currentResultUrl) return;
  copyText(currentResultUrl);
}

// Hook called by copyText after a successful copy — shows the confirmation
// box above the hint row with the copied URL.
function onUrlCopied(url) {
  const box = document.getElementById('resultCopyBox');
  const boxUrl = document.getElementById('resultCopyBoxUrl');
  if (!box || !boxUrl) return;
  boxUrl.textContent = url;
  box.classList.add('show');
  clearTimeout(_resultCopyTimer);
  _resultCopyTimer = setTimeout(() => box.classList.remove('show'), 2500);
}

// Show/hide the pane ‹ › buttons of a tool; when the gallery no longer
// supports navigation the index resets to -1 (show the most recent).
// Position of the entry the pane is showing, as N/M (the same information as
// the fullscreen counter). -1 means "most recent".
function paneCounterText(tab) {
  const n = paneGalleryCount(tab);
  if (!n) return '0/0';
  const idx = paneIdx[tab] === -1 ? n - 1 : paneIdx[tab];
  return (idx + 1) + '/' + n;
}

// The pane's ▦ button IS the counter (label N/M) that opens the sheet.
function syncPaneCount(tab) {
  const btn = document.querySelector(`#tab-${tab} .pane-grid-btn`);
  if (!btn) return;
  btn.textContent = paneCounterText(tab);
  // The pill hugs its digits (auto width), so the source cluster is offset by
  // CSS using its MEASURED width: same 6px gap as between the other buttons.
  // A hidden tab measures 0 → the CSS fallback keeps the row sane; the
  // measurement happens again when the tab is activated (syncPaneNav).
  const pane = btn.closest('.output-pane');
  if (pane) {
    const w = Math.round(btn.getBoundingClientRect().width);
    if (w) pane.style.setProperty('--pane-counter-w', w + 'px');
  }
}

function syncPaneNav(tab) {
  const multi = paneGalleryCount(tab) > 1;
  document.querySelectorAll(`#tab-${tab} .pane-nav`).forEach(btn => {
    btn.style.display = multi ? 'flex' : 'none';
  });
  if (!multi) paneIdx[tab] = -1;
  syncPaneCount(tab);
}

// Render the pane at its current nav index (called by paneNav only — the
// generators paint the pane themselves when a NEW result lands). Keeps the
// result-URL hint in sync with the entry being shown.
function renderPane(tab) {
  const e = paneCurrentEntry(tab);
  if (!e) { syncResultUrl(tab, null); return; }
  if (tab === 'generate') {
    showResult('genOutputPane', { display: e.src }, false);
  } else if (tab === 'edit' || tab === 'upscale' || tab === 'face_swap') {
    const paneId = tab === 'edit' ? 'editOutputPane'
      : tab === 'face_swap' ? 'faceSwapOutputPane' : 'upscaleOutputPane';
    restoreCompareSlider(tab, paneId, e);
  } else if (tab === 'video') {
    showResult('videoOutputPane', { display: e.src || e.display || e.url }, true);
  }
  syncResultUrl(tab, e);
  syncPaneCount(tab);
}

// Navigate a tool's pane by delta (wrap around). No-op with <2 entries.
function paneNav(tab, delta) {
  const count = paneGalleryCount(tab);
  if (count < 2) return;
  if (paneIdx[tab] === -1) paneIdx[tab] = count - 1; // start from the most recent
  paneIdx[tab] = (paneIdx[tab] + delta + count) % count;
  renderPane(tab);
}

// ── Wiring ─────────────────────────────────
galleryCloseBtn.addEventListener('click', closeGallery);
// ℹ️ replaces the old download button: the panel shows the current image's
// embedded parameters. Toggle from the button; any click/backdrop/Escape
// closes it (closeTextBoxes).
galleryInfoBtn.addEventListener('click', e => {
  e.stopPropagation();
  galleryShowInfo();
});
galleryTrashBtn.addEventListener('click', e => { e.stopPropagation(); galleryDeleteCurrent(); });
// ‹ › navigate and close any open text box (the shown information never
// goes stale). The overlay is pointer-transparent, so these buttons stay
// clickable under an open panel.
galleryPrevBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (galleryPrevBtn.disabled) return; // single entry — nothing to navigate
  galleryNav(-1);
});
galleryNextBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (galleryNextBtn.disabled) return; // single entry — nothing to navigate
  galleryNav(1);
});
// Badge click/tap: HIDE the badge and show ONE box with ONLY the ORIGINAL
// generation prompt (the ℹ️ panel also carries it, but the badge offers a
// quick glance without opening the full parameters). Clicking again (or
// closing via click-outside/navigation) re-renders from the data, so the
// badge always comes back.
galleryBadge.addEventListener('click', e => {
  e.stopPropagation();
  const e2 = galleryEntries[galleryIdx];
  if (!e2 || !e2.badge) return;
  if (e2.badge === 'upscaled') return; // informational only
  if (galleryBadgeBox.classList.contains('show')) { closeBadgeBox(); renderGalleryItem(); return; }
  closeGalleryInfo(); // ONE box at a time — never over the ℹ️ panel
  if (!e2.originalPrompt) return; // nothing to show
  galleryBadgeBoxText.textContent = e2.originalPrompt;
  galleryBadge.classList.remove('show');
  galleryBadge.textContent = '';
  galleryBadgeBox.classList.add('show');
});
// Clicking ANYWHERE on the screen (image, backdrop…) closes any open text
// box — the badge prompt box and the ℹ️ info panel — restoring the badge.
// Only when no box is open does clicking the dark backdrop close the
// gallery itself.
galleryOverlay.addEventListener('click', e => {
  if (closeTextBoxes()) return;
  if (e.target === galleryOverlay) closeGallery();
});

// Counter button → thumbnail grid. While the grid is open, a click on its
// empty area (not a thumb / its title bar) closes ONLY the grid.
galleryCounter.addEventListener('click', e => {
  e.stopPropagation();
  toggleGalleryGrid();
});
galleryGrid.addEventListener('click', e => {
  if (!galleryGridOpen) return;
  if (e.target.closest('.gallery-thumb') || e.target.closest('.gallery-grid-top')) return;
  closeGalleryGrid();
});
// The visible box changes with the window, the orientation AND the mobile URL
// bar (visualViewport): recompute so the cells keep fitting the screen.
window.addEventListener('resize', refitGalleryGrid);
window.addEventListener('orientationchange', refitGalleryGrid);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', refitGalleryGrid);
}

// Pane-mode ℹ️ panel: the backdrop opts into pointer events (see
// .gallery-info-panel.pane-mode), so the first click dismisses the panel
// WITHOUT activating the control underneath. Clicks inside the box are
// ignored. (In gallery mode the panel stays click-transparent and the
// overlay's handler above closes it.)
galleryInfoPanel.addEventListener('click', e => {
  if (!galleryInfoPanel.classList.contains('pane-mode')) return;
  if (e.target.closest('.gallery-info-box')) return;
  closeGalleryInfo();
});

// Keyboard: Escape closes; ←/→ navigate; `i` toggles the ℹ️ info panel.
// While any text box is open, Escape closes ONLY the box (the gallery
// stays) and navigation is suspended so the shown information never goes
// stale. The `i` shortcut is handled FIRST so pressing it while the panel
// is open really closes it (instead of closeTextBoxes reopening it).
document.addEventListener('keydown', e => {
  if (!galleryOverlay.classList.contains('show')) return;
  const target = e.target;
  const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
  const typing = tag === 'input' || tag === 'textarea'
    || (target && target.isContentEditable);
  if (!typing && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey
      && String(e.key).toLowerCase() === 'i') {
    e.preventDefault();
    if (galleryGridOpen) closeGalleryGrid(); // progressive: the sheet first
    galleryShowInfo(); // toggles the panel: open when closed, close when open
    return;
  }
  // Thumbnail grid: Escape closes it (not the gallery), arrows move the
  // sheet SELECTION by one / by a row and Enter (or Space) opens the focused
  // tile (falling back to the active one). The individual view is not touched
  // until a tile is actually picked.
  if (galleryGridOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeGalleryGrid(); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const focused = _gridThumbIndexFromTarget(target);
      galleryGridSelect(focused >= 0 ? focused : galleryGridIdx);
      return;
    }
    const step = e.key === 'ArrowLeft' ? -1
      : e.key === 'ArrowRight' ? 1
      : e.key === 'ArrowUp' ? -galleryGridCols
      : e.key === 'ArrowDown' ? galleryGridCols
      : 0;
    if (step) {
      e.preventDefault();
      galleryGridIdx = Math.max(0, Math.min(galleryEntries.length - 1, galleryGridIdx + step));
      syncGalleryGrid();
    }
    return;
  }
  // While any text box is open (badge or ℹ️ info), Escape closes it and
  // navigation is suspended so the shown information never goes stale.
  if (closeTextBoxes() && e.key === 'Escape') return;
  if (galleryBadgeBox.classList.contains('show')
      || galleryInfoPanel.classList.contains('show')) return;
  if (e.key === 'Escape') closeGallery();
  else if (e.key === 'ArrowLeft') galleryNav(-1);
  else if (e.key === 'ArrowRight') galleryNav(1);
  else if ((e.key === 'Delete' || e.key === 'Del' || e.key === 'Supr'
            || e.code === 'Delete')
           && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    galleryDeleteCurrent(); // no confirmation — the shown entry only
  }
});

// Initial labels for the pane N/M buttons: storage.js already loaded the
// persisted registries, so the counts are known before any result lands.
Object.keys(paneIdx).forEach(tab => syncPaneNav(tab));
