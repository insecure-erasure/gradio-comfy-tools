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
// marker + window.galleryVideos) for a future video gallery — see PLAN.md.

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
      return;
    }
  }
  window.galleryGenerated.push({
    src, url, prompt: prompt || '', badge, filename: filenameFromUrl(src),
    originalPrompt: '',
  });
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
    if (i >= 0) originalPrompt = window.galleryGenerated[i].prompt || '';
  }
  window.galleryGenerated.push({
    src, url, prompt: prompt || '', badge, filename: filenameFromUrl(src),
    originalPrompt,
  });
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
  window.galleryVideos.push({
    src: display,        // like galleryGenerated.src — the same-origin display URL
    url,                 // direct ComfyUI URL (chaining/copy)
    prompt: prompt || '',
    filename: filenameFromUrl(display),  // null for non-generated sources (defensive)
  });
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
      if (galleryVideoWrap) { galleryVideoWrap.innerHTML = ''; galleryVideoWrap.style.display = 'none'; }
      if (typeof restoreTabResult === 'function' && currentTab) restoreTabResult(currentTab);
    }
  })
);

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
    galleryVideoWrap.appendChild(createVideoPlayer(e.src));
    galleryBadge.classList.remove('show');
    galleryBadge.textContent = '';
    if (e.prompt) galleryPromptBtn.classList.add('show');
    else { galleryPromptBtn.classList.remove('show'); closeGalleryPrompt(); }
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
  // N/M paginator (bottom-right): always visible in the gallery; prev/next
  // buttons only when there is more than one entry. NB: the counter uses an
  // explicit 'flex' (its CSS base is display:none — '' would clear the
  // inline style and the counter would never show).
  const multi = galleryEntries.length > 1;
  galleryPrevBtn.style.display = multi ? 'flex' : 'none';
  galleryNextBtn.style.display = multi ? 'flex' : 'none';
  galleryCounter.style.display = 'flex';
  galleryCounter.textContent = (galleryIdx + 1) + '/' + galleryEntries.length;
}

function galleryNav(delta) {
  if (!galleryMode || galleryEntries.length < 2) return;
  closeGalleryPrompt(); // a new entry — don't leave the old prompt open
  closeBadgeBox();
  galleryIdx = ((galleryIdx + delta) % galleryEntries.length + galleryEntries.length) % galleryEntries.length;
  renderGalleryItem();
}

// ── Openers ────────────────────────────────
// Generate lightbox: the GENERATED history (session), not the live DOM —
// so the history survives the pane only showing the last result. Called with
// the clicked img (to position on it) or nothing (⛶ → most recent).
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
    const i = all.findIndex(e => e.src === img.src);
    if (i >= 0) idx = i;
  }
  galleryIdx = idx;
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
  if (comps.length) {
    galleryMode = 'compare';
    galleryEntries = comps;
    galleryBig.style.display = 'none';
    gallerySlider.style.display = '';
    galleryVideoWrap.style.display = 'none';
    const i = comps.findIndex(e => e.kind === kind);
    galleryIdx = i >= 0 ? i : comps.length - 1;
    renderGalleryItem();
    openGalleryOverlay();
    return;
  }
  // Fallback: transformed entries of this tool in the generated gallery.
  const badgeMatch = kind === 'upscale' ? ['upscaled'] : ['edited', 'restored'];
  const gen = (window.galleryGenerated || []).filter(e => badgeMatch.includes(e.badge));
  if (!gen.length) {
    return showToast(kind === 'upscale' ? 'No upscaled image yet' : 'No edited image yet');
  }
  galleryMode = 'lightbox';
  galleryEntries = gen;
  galleryBig.style.display = '';
  gallerySlider.style.display = 'none';
  galleryVideoWrap.style.display = 'none';
  galleryIdx = gen.length - 1;
  renderGalleryItem();
  openGalleryOverlay();
}

// Video fullscreen: the ⛶ button on the Video tab opens the generated
// videos gallery (window.galleryVideos) — the custom player fills the
// overlay, ‹› navigates, the 🗑️ deletes the shown entry, Show prompt
// reveals its prompt.
async function openVideoGallery() {
  await verifyStoredGalleries(true); // drop dead files before showing
  const all = window.galleryVideos;
  if (!all.length) return showToast('No video to show yet');
  galleryMode = 'video';
  galleryEntries = all;
  galleryBig.style.display = 'none';
  gallerySlider.style.display = 'none';
  galleryVideoWrap.style.display = '';
  galleryIdx = all.length - 1;
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
    : galleryMode === 'video' ? (e.src || e.url)
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
  const paneIds = { generate: 'genOutputPane', edit: 'editOutputPane', upscale: 'upscaleOutputPane', video: 'videoOutputPane' };
  const pane = document.getElementById(paneIds[currentTab]);
  if (pane) {
    // The pane's shown src: result-img .src, video-player > video .src, or
    // compare-slider > img.side.after .src.
    const img = pane.querySelector('.result-img');
    const vid = pane.querySelector('.video-player video');
    const cmpAfter = pane.querySelector('.compare-slider img.side.after');
    const shownSrc = (img && img.src) || (vid && vid.src) || (cmpAfter && cmpAfter.src) || null;
    const entrySrc = galleryMode === 'video' ? (e.src || e.url) : e.src;
    if (shownSrc && entrySrc && shownSrc === entrySrc) clearPane(pane.id);
  }

  // 2) Remove from the live entries + navigate/clamp.
  galleryEntries.splice(galleryIdx, 1);
  if (galleryEntries.length === 0) {
    closeGallery(); // nothing left — close the overlay
    if (typeof savePersistedState === 'function') savePersistedState();
    return;
  }
  // Navigate to the next entry (wrap), or clamp to the new last.
  if (galleryIdx >= galleryEntries.length) galleryIdx = galleryEntries.length - 1;
  renderGalleryItem();
  if (typeof savePersistedState === 'function') savePersistedState();
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

// ── Wiring ─────────────────────────────────
galleryCloseBtn.addEventListener('click', closeGallery);
galleryDlBtn.addEventListener('click', galleryDownload);
galleryTrashBtn.addEventListener('click', e => { e.stopPropagation(); galleryDeleteCurrent(); });
// ‹ › while the prompt panel is open: close it and navigate (one action —
// the shown prompt never goes stale). The overlay is pointer-transparent,
// so these buttons stay clickable under it.
galleryPrevBtn.addEventListener('click', e => { e.stopPropagation(); closeGalleryPrompt(); galleryNav(-1); });
galleryNextBtn.addEventListener('click', e => { e.stopPropagation(); closeGalleryPrompt(); galleryNav(1); });
// Badge click/tap: HIDE the badge and show a single box with ONLY the
// ORIGINAL generation prompt. Individual hide — the bottom Show-prompt
// button is NOT touched (only the badge that was clicked hides). Clicking
// again (or closing via click-outside/navigation) re-renders from the data,
// so the badge ALWAYS comes back.
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
