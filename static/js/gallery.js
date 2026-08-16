// ── Gallery + fullscreen (B5) ──────────────
// Ported from the reference image viewers in ../open-webui-comfy-tools
// (smart_generate_image / edit_image / upscale_image), adapted to this
// single-page app. Two SEPARATE galleries:
//
//   • Generate (lightbox): navigates the GENERATED history — every image
//     generated this session (window.galleryGenerated), even after the pane
//     only shows the last one. An edit/restore APPENDS a new entry (the
//     transformation's own prompt is shown via the Show prompt button;
//     if the source was itself a gallery image, its prompt is preserved as
//     the badge hover hint). An upscale REPLACES the original entry (badge
//     "Upscaled", no hover hint). Badges are top-center ("Edited" /
//     "Restored" / "Upscaled"). The prompt is never a bottom caption:
//     Show prompt opens a semi-transparent modal with a
//     device-appropriate font size (see .gallery-prompt-* CSS).
//   • Edit/Upscale (compare): opens the fullscreen overlay with its own
//     interactive slider; the gallery there ONLY navigates the
//     edited/restored/upscaled comparisons (never generated images).
//
// Prompt access: the prompt is NOT shown as a bottom caption. A Show
// prompt button (bottom-center, shown only when the entry has a prompt)
// reveals it on HOVER — no click needed — as a BOTTOM panel
// (galleryPromptModal) styled exactly like the original-prompt hover hint
// (.gallery-badge-hint): a grey translucent pill, centered 500-weight
// text, no title/✕. The overlay layer is pointer-transparent, so the image
// and the gallery buttons stay usable while it is open. The panel hides
// when the pointer leaves (short grace delay), on ✕ / Escape / gallery
// navigation (‹ › / ←/→ — the click/key navigates AND closes, so the shown
// prompt never goes stale) and gallery close. Click/tap still toggles it
// for touch/keyboard.
//
// Close ✕ is top-RIGHT, download top-LEFT (inverted vs the reference —
// project decision). Video results are only COLLECTED (data-video-gallery
// marker + window.galleryVideos) for a future video gallery — see docs/PLAN.md.

const galleryOverlay = document.getElementById('galleryOverlay');
const galleryBig = document.getElementById('galleryBig');
const galleryVideoWrap = document.getElementById('galleryVideoWrap');
const gallerySlider = document.getElementById('gallerySlider');
const galleryBefore = document.getElementById('galleryBefore');
const galleryAfter = document.getElementById('galleryAfter');
const galleryPromptBtn = document.getElementById('galleryPromptBtn');
const galleryPromptModal = document.getElementById('galleryPromptModal');
const galleryPromptText = document.getElementById('galleryPromptText');
const galleryCounter = document.getElementById('galleryCounter');
const galleryLabelAfter = document.getElementById('galleryLabelAfter');
const galleryBadge = document.getElementById('galleryBadge');
const galleryBadgeBox = document.getElementById('galleryBadgeBox');
const galleryBadgeBoxText = document.getElementById('galleryBadgeBoxText');
const galleryCloseBtn = document.getElementById('galleryClose');
const galleryDlBtn = document.getElementById('galleryDl');
const galleryTrashBtn = document.getElementById('galleryTrash');
const galleryPrevBtn = document.getElementById('galleryPrev');
const galleryNextBtn = document.getElementById('galleryNext');

let galleryMode = null;     // 'lightbox' | 'compare'
let galleryEntries = [];    // collected on open
let galleryIdx = -1;
// Pane navigation (normal view): which gallery entry each tool's output
// pane shows. -1 = "show the most recent"; paneNav materializes it.
const paneIdx = { generate: -1, edit: -1, upscale: -1, video: -1 };

// ── Generated history ──────────────────────
// Session-scoped registry of generated images + their transformations.
// Entry: { src, prompt (the bottom caption: generation prompt for plain
//          generations and upscales, the transformation's own text for
//          edits/restores), badge: '' | 'edited' | 'restored' | 'upscaled',
//          filename, originalPrompt (for appended edits/restores: the
//          source image's prompt, shown on badge hover; empty otherwise) }.
window.galleryGenerated = [];

// Identify a generated image by its ComfyUI filename:
//   /media/FILENAME?type=...            -> FILENAME
//   {base}/view?filename=FILENAME&...   -> FILENAME
// Uploads (bare filename) and external URLs -> null (not a generated image).
function filenameFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    const m = u.pathname.match(/\/media\/([^/]+)$/);
    if (m) return decodeURIComponent(m[1]);
    if (u.pathname.endsWith('/view')) return u.searchParams.get('filename');
  } catch (e) {}
  return null;
}

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
      // fall back to the intermediate edit prompt (the bottom Show-prompt
      // box already carries the transformation text).
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
    if (kind !== 'edit' && kind !== 'restore' && kind !== 'upscale') return;
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
function addGeneratedVideo(result, prompt) {
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
  const arr = tab === 'video' ? window.galleryVideos
    : tab === 'generate' ? window.galleryGenerated
    : (tab === 'edit' || tab === 'upscale') ? window.galleryComparisons : null;
  if (!arr || !arr.length) return;
  const e = arr[arr.length - 1];
  e.duration = durationSecs;
  savePersistedState();
}

// ── Open / close ───────────────────────────
function openGalleryOverlay() {
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

// Close BOTH text boxes (the badge prompt box and the Show-prompt panel)
// and restore the badge that a box-open hid. Returns true when anything
// was closed. Shared by click-outside and Escape.
function closeTextBoxes() {
  let changed = false;
  if (galleryPromptModal.classList.contains('show')) { closeGalleryPrompt(); changed = true; }
  if (galleryBadgeBox.classList.contains('show')) { closeBadgeBox(); changed = true; }
  // Re-render the CURRENT item from its data so the badge AND the
  // Show-prompt button always come back to their proper state (a badge
  // hidden by click must never stay gone — the render derives the
  // visibility from the entry, not from accumulated classList toggles).
  if (changed) renderGalleryItem();
  return changed;
}

function closeGallery() {
  closeGalleryPrompt();
  closeBadgeBox(); // a badge box opened by click must not survive the close
  resetGalleryZoom(); // a closed gallery must never keep a transform
  // Destroy the video player of the OVERLAY (stops playback) and hide the
  // wrap. The pane's own player/result is untouched — closing the gallery
  // must not destroy the tool's last generation.
  if (galleryVideoWrap) { galleryVideoWrap.innerHTML = ''; galleryVideoWrap.style.display = 'none'; }
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    try { document.exitFullscreen && document.exitFullscreen(); } catch (e) {}
    try { document.webkitExitFullscreen && document.webkitExitFullscreen(); } catch (e) {}
  } else {
    galleryOverlay.classList.remove('show');
  }
  galleryMode = null;
  // After closing, make sure the ACTIVE tool's pane still shows its last
  // generation (it normally does — the overlay never touches the pane — but
  // if the user deleted the shown entry via 🗑️, restore from the gallery).
  if (typeof restoreTabResult === 'function' && currentTab) {
    restoreTabResult(currentTab);
  }
}

['fullscreenchange', 'webkitfullscreenchange'].forEach(ev =>
  document.addEventListener(ev, () => {
    if (!(document.fullscreenElement || document.webkitFullscreenElement)) {
      galleryOverlay.classList.remove('show');
      galleryMode = null;
      closeGalleryPrompt();
      closeBadgeBox();
      resetGalleryZoom();
      if (galleryVideoWrap) { galleryVideoWrap.innerHTML = ''; galleryVideoWrap.style.display = 'none'; }
      if (typeof restoreTabResult === 'function' && currentTab) restoreTabResult(currentTab);
    }
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

// ── Render the current gallery item ────────
function renderGalleryItem() {
  const e = galleryEntries[galleryIdx];
  if (!e) return;
  // Start clean: a badge box opened by click must not linger when
  // navigating to another entry.
  closeBadgeBox();
  if (galleryMode === 'lightbox') {
    galleryBig.src = e.src;
    // Show prompt: visible only when the entry has a prompt. The prompt
    // itself is never rendered here — hovering the button reveals it.
    if (e.prompt) {
      galleryPromptBtn.classList.add('show');
    } else {
      galleryPromptBtn.classList.remove('show');
      closeGalleryPrompt(); // an entry without a prompt — never leave the panel open
    }
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
    // NO Show-prompt button in the video gallery: the player fills the
    // overlay edge-to-edge and the button would overlap the controls.
    galleryPromptBtn.classList.remove('show');
    closeGalleryPrompt();
  } else {
    galleryBefore.src = e.before || e.src;
    galleryAfter.src = e.src;
    gallerySlider.style.setProperty('--p', '50%');
    galleryLabelAfter.textContent =
      e.kind === 'edit' ? 'Edited' : e.kind === 'restore' ? 'Restored'
        : e.kind === 'upscale' ? 'Upscaled' : 'Result';
    galleryBadge.classList.remove('show');
    // Compare mode: the Show-prompt button is visible by DEFAULT when the
    // comparison has a prompt (no click on the slider needed) — same rule
    // as the lightbox and video modes.
    if (e.prompt) galleryPromptBtn.classList.add('show');
    else { galleryPromptBtn.classList.remove('show'); closeGalleryPrompt(); }
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
  galleryCounter.textContent = (galleryIdx + 1) + '/' + galleryEntries.length;
}

function galleryNav(delta) {
  if (!galleryMode || galleryEntries.length < 2) return;
  closeGalleryPrompt(); // a new entry — don't leave the old prompt open
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
async function openGenerateLightbox(img) {
  // Re-verify the persisted gallery against the server (cache-busted so a
  // file deleted mid-session is dropped before the overlay opens). Cheap:
  // one HEAD per unique filename, concurrency 5 — a few entries → <100ms.
  await verifyStoredGalleries(true);
  const all = window.galleryGenerated;
  if (!all.length) return showToast('Nothing to show yet');
  galleryMode = 'lightbox';
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

// Edit/Upscale fullscreen: the ⛶ button opens THIS tool's gallery. It
// prefers the before/after comparisons of the current tool; when there are
// none but the tool has transformed entries in the generated gallery
// (edited/restored/upscaled with a badge), it falls back to a lightbox of
// those — so the button NEVER says "No comparison" while the tool has
// gallery content.
async function openCompareFullscreen(kind) {
  await verifyStoredGalleries(true); // drop dead files before showing
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
// overlay, ‹› navigates, the 🗑️ deletes the shown entry, Show prompt
// reveals its prompt.
async function openVideoGallery() {
  // NO existence verification here: videos are ComfyUI temp files that get
  // cleaned on server restart, and the user wants the gallery to show every
  // entry from the session/localStorage — a missing file just won't play.
  const all = window.galleryVideos;
  if (!all.length) return showToast(NO_VIDEOS_MSG);
  galleryMode = 'video';
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
  if (!galleryBefore.naturalWidth || !galleryBefore.naturalHeight) return;
  const r = galleryBefore.naturalWidth / galleryBefore.naturalHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  // Maximize the available area: the slider fills the viewport (object-fit
  // contain letterboxes the images inside).
  let w = vw, h = w / r;
  if (h > vh) { h = vh; w = h * r; }
  gallerySlider.style.width = w + 'px';
  gallerySlider.style.height = h + 'px';
}
galleryBefore.addEventListener('load', fitGallerySlider);
window.addEventListener('resize', () => { if (galleryMode === 'compare') fitGallerySlider(); });

// ── Download (currently shown image) ───────
async function galleryDownload() {
  const e = galleryEntries[galleryIdx];
  if (!e) return;
  const src = galleryMode === 'lightbox' ? galleryBig.src
    : galleryMode === 'video' ? (e.src || e.display || e.url)
    : galleryAfter.src;
  try {
    const r = await fetch(src);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = await r.blob();
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = 'image.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  } catch (err) {
    const w = window.open(src, '_blank'); if (w) w.focus();
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
  closeGalleryPrompt();
  closeBadgeBox();

  // 1) Remove from the persisted registry (the source of truth).
  if (galleryMode === 'lightbox') {
    // galleryGenerated: by filename (prefer) or by src URL.
    window.galleryGenerated = (window.galleryGenerated || []).filter(x => {
      const xf = x.filename || (x.src && filenameFromUrl ? filenameFromUrl(x.src) : null);
      return !(fn && xf === fn) && !(!fn && x.src === e.src);
    });
  } else if (galleryMode === 'video') {
    // video gallery: by src (display URL) or filename.
    window.galleryVideos = (window.galleryVideos || []).filter(x => {
      const xf = x.filename || (x.src && filenameFromUrl ? filenameFromUrl(x.src) : null);
      return !(fn && xf === fn) && !(!fn && x.src === e.src);
    });
  } else {
    // compare mode: by AFTER src (identity) — the entry's src or the after img.
    const afterSrc = e.src || galleryAfter.src;
    window.galleryComparisons = (window.galleryComparisons || []).filter(
      x => !(x.src === e.src) && !(afterSrc && x.src === afterSrc)
    );
  }

  // If the deleted entry was what the ACTIVE tool's pane was showing, clear
  // the pane so closing the gallery restores the next/last generation (or
  // the idle placeholder) instead of leaving a ghost of the deleted file.
  // The DOM src is an ABSOLUTE URL (the browser resolves /media/...) while
  // the registry srcs are relative — compare by ComfyUI filename (filenameFromUrl
  // handles both), not by raw strings (a raw === would never match and leave
  // the ghost visible until a reload).
  const paneIds = { generate: 'genOutputPane', edit: 'editOutputPane', upscale: 'upscaleOutputPane', video: 'videoOutputPane' };
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

// ── Prompt panel (Show prompt) ─────────────
// BOTTOM panel with the current entry's prompt — SAME STYLE as the
// original-prompt hover hint (.gallery-badge-hint): a grey translucent
// pill with centered text, no title, no close button. Only available in
// lightbox mode and only when the entry has a prompt (the button is
// hidden otherwise).
//
// HOVER-revealed: hovering the button (mouse) shows the panel; moving away
// hides it after a short grace delay (avoids flicker on tiny movements).
// Click/tap still toggles it (touch devices have no hover; keyboard
// activation works too) and Escape / navigation (‹ › / ←/→ — which also
// navigate) / gallery close always close it.
let promptPinned = false;   // the Show-prompt panel was opened by CLICK (button hidden)

function openGalleryPrompt() {
  const e = galleryEntries[galleryIdx];
  if (!e || !e.prompt) return;
  galleryPromptText.textContent = e.prompt; // textContent — never innerHTML
  galleryPromptModal.classList.add('show');
}

function closeGalleryPrompt() {
  promptPinned = false;
  galleryPromptModal.classList.remove('show');
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
    case 'upscale': return (window.galleryComparisons || []).filter(c => c.tab === tab).length;
    case 'video': return (window.galleryVideos || []).length;
    default: return 0;
  }
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
function syncPaneNav(tab) {
  const multi = paneGalleryCount(tab) > 1;
  document.querySelectorAll(`#tab-${tab} .pane-nav`).forEach(btn => {
    btn.style.display = multi ? 'flex' : 'none';
  });
  if (!multi) paneIdx[tab] = -1;
}

// Render the pane at its current nav index (called by paneNav only — the
// generators paint the pane themselves when a NEW result lands). Keeps the
// result-URL hint in sync with the entry being shown.
function renderPane(tab) {
  const e = paneCurrentEntry(tab);
  if (!e) { syncResultUrl(tab, null); return; }
  if (tab === 'generate') {
    showResult('genOutputPane', { display: e.src }, false);
  } else if (tab === 'edit' || tab === 'upscale') {
    restoreCompareSlider(tab, tab === 'edit' ? 'editOutputPane' : 'upscaleOutputPane', e);
  } else if (tab === 'video') {
    showResult('videoOutputPane', { display: e.src || e.display || e.url }, true);
  }
  syncResultUrl(tab, e);
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
galleryDlBtn.addEventListener('click', galleryDownload);
galleryTrashBtn.addEventListener('click', e => { e.stopPropagation(); galleryDeleteCurrent(); });
// ‹ › while the prompt panel is open: close it and navigate (one action —
// the shown prompt never goes stale). The overlay is pointer-transparent,
// so these buttons stay clickable under it.
galleryPrevBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (galleryPrevBtn.disabled) return; // single entry — nothing to navigate
  closeGalleryPrompt();
  galleryNav(-1);
});
galleryNextBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (galleryNextBtn.disabled) return; // single entry — nothing to navigate
  closeGalleryPrompt();
  galleryNav(1);
});
// Badge click/tap: HIDE the badge and show ONE box with ONLY the ORIGINAL
// generation prompt (and hide the bottom Show-prompt button meanwhile — one
// box at a time). Clicking again (or closing via click-outside/navigation)
// re-renders from the data, so the badge AND the bottom button always come
// back.
galleryBadge.addEventListener('click', e => {
  e.stopPropagation();
  const e2 = galleryEntries[galleryIdx];
  if (!e2 || !e2.badge) return;
  if (e2.badge === 'upscaled') return; // informational only
  if (galleryBadgeBox.classList.contains('show')) { closeBadgeBox(); renderGalleryItem(); return; }
  closeGalleryPrompt();
  if (!e2.originalPrompt) return; // nothing to show
  galleryBadgeBoxText.textContent = e2.originalPrompt;
  galleryBadge.classList.remove('show');
  galleryBadge.textContent = '';
  // ONE box at a time: hide the bottom Show-prompt button too while the
  // badge box is open (its panel would overlap the original prompt with the
  // transformation text). renderGalleryItem re-derives its visibility from
  // the entry on close/navigate, so it always comes back.
  galleryPromptBtn.classList.remove('show');
  galleryBadgeBox.classList.add('show');
});
// CLICK only (no hover — hover timers were fragile). The two badges are
// independent: clicking the top badge never touches the bottom one.
galleryPromptBtn.addEventListener('click', e => {
  e.stopPropagation();
  // Toggle: if the panel is already open, close it and restore the button
  // (render from data); otherwise hide the button and pin the panel open.
  if (galleryPromptModal.classList.contains('show')) {
    closeGalleryPrompt();
    renderGalleryItem();
    return;
  }
  promptPinned = true;
  galleryPromptBtn.classList.remove('show');
  openGalleryPrompt();
});
// Clicking ANYWHERE on the screen (image, backdrop…) closes any open text
// box — the badge prompt box and the Show-prompt panel — restoring the
// badge. Only when no box is open does clicking the dark backdrop close
// the gallery itself.
galleryOverlay.addEventListener('click', e => {
  if (closeTextBoxes()) return;
  if (e.target === galleryOverlay) closeGallery();
});

// Keyboard: Escape closes; ←/→ navigate while the overlay is open. While
// the prompt panel is open, Escape closes ONLY the panel (the gallery
// stays) and navigation is suspended so the shown prompt never goes stale.
document.addEventListener('keydown', e => {
  if (!galleryOverlay.classList.contains('show')) return;
  // While any text box is open, Escape closes it (both) and navigation is
  // suspended so the shown prompt never goes stale.
  if (closeTextBoxes() && e.key === 'Escape') return;
  if (galleryPromptModal.classList.contains('show') || galleryBadgeBox.classList.contains('show')) return;
  if (e.key === 'Escape') closeGallery();
  else if (e.key === 'ArrowLeft') galleryNav(-1);
  else if (e.key === 'ArrowRight') galleryNav(1);
});
