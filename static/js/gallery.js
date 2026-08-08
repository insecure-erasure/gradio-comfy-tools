// ── Gallery + fullscreen (B5) ──────────────
// Ported from the reference image viewers in ../open-webui-comfy-tools
// (smart_generate_image / edit_image / upscale_image), adapted to this
// single-page app. Two SEPARATE galleries:
//
//   • Generate (lightbox): navigates the GENERATED history — every image
//     generated this session (window.galleryGenerated), even after the pane
//     only shows the last one. An edit/restore APPENDS a new entry (the
//     transformation's own prompt is shown via the 💬 Show prompt button;
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
// Prompt access: the prompt is NOT shown as a bottom caption. A 💬 Show
// prompt button (bottom-center, shown only when the entry has a prompt)
// opens a semi-transparent modal (galleryPromptModal) with the full
// prompt at a device-appropriate font size. The modal closes on ✕,
// backdrop click, Escape, navigation (‹ › / ←/→) and gallery close.
//
// Close ✕ is top-RIGHT, download top-LEFT (inverted vs the reference —
// project decision). Video results are only COLLECTED (data-video-gallery
// marker + window.galleryVideos) for a future video gallery — see PLAN.md.

const galleryOverlay = document.getElementById('galleryOverlay');
const galleryBig = document.getElementById('galleryBig');
const gallerySlider = document.getElementById('gallerySlider');
const galleryBefore = document.getElementById('galleryBefore');
const galleryAfter = document.getElementById('galleryAfter');
const galleryPromptBtn = document.getElementById('galleryPromptBtn');
const galleryPromptModal = document.getElementById('galleryPromptModal');
const galleryPromptText = document.getElementById('galleryPromptText');
const galleryPromptClose = document.getElementById('galleryPromptClose');
const galleryCounter = document.getElementById('galleryCounter');
const galleryLabelAfter = document.getElementById('galleryLabelAfter');
const galleryBadge = document.getElementById('galleryBadge');
const galleryCloseBtn = document.getElementById('galleryClose');
const galleryDlBtn = document.getElementById('galleryDl');
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

// A newly generated image joins the history at the end.
function addGeneratedEntry(src, prompt) {
  window.galleryGenerated.push({
    src, prompt: prompt || '', badge: '', filename: filenameFromUrl(src),
    originalPrompt: '',
  });
}

// An UPScale of sourceSrc -> new result src: REPLACES the source entry in
// place when it is a gallery image (keeping its generation prompt as the
// bottom caption, updating src + badge "upscaled"; no hover hint, since an
// upscale has no transformation prompt). Non-generated sources are
// appended as new entries (empty prompt).
function addTransformedEntry(src, prompt, badge, sourceSrc) {
  const fn = filenameFromUrl(sourceSrc);
  if (fn) {
    const i = window.galleryGenerated.findIndex(e => e.filename === fn);
    if (i >= 0) {
      const entry = window.galleryGenerated[i];
      entry.src = src;
      entry.badge = badge;
      entry.filename = filenameFromUrl(src);
      entry.originalPrompt = '';
      return;
    }
  }
  window.galleryGenerated.push({
    src, prompt: prompt || '', badge, filename: filenameFromUrl(src),
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
function appendTransformedEntry(src, prompt, badge, sourceSrc) {
  let originalPrompt = '';
  const fn = filenameFromUrl(sourceSrc);
  if (fn) {
    const i = window.galleryGenerated.findIndex(e => e.filename === fn);
    if (i >= 0) originalPrompt = window.galleryGenerated[i].prompt || '';
  }
  window.galleryGenerated.push({
    src, prompt: prompt || '', badge, filename: filenameFromUrl(src),
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

// Video results: URL collection for a future video gallery (PLAN.md B5).
window.galleryVideos = window.galleryVideos || [];
function collectVideoUrl(result, prompt) {
  const url = result.url || result.display;
  if (!window.galleryVideos.some(v => v.url === url)) {
    window.galleryVideos.push({ url, display: result.display, prompt: prompt || '' });
  }
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

function closeGallery() {
  closeGalleryPrompt();
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    try { document.exitFullscreen && document.exitFullscreen(); } catch (e) {}
    try { document.webkitExitFullscreen && document.webkitExitFullscreen(); } catch (e) {}
  } else {
    galleryOverlay.classList.remove('show');
  }
  galleryMode = null;
}

['fullscreenchange', 'webkitfullscreenchange'].forEach(ev =>
  document.addEventListener(ev, () => {
    if (!(document.fullscreenElement || document.webkitFullscreenElement)) {
      galleryOverlay.classList.remove('show');
      galleryMode = null;
      closeGalleryPrompt();
    }
  })
);

// ── Render the current gallery item ────────
function renderGalleryItem() {
  const e = galleryEntries[galleryIdx];
  if (!e) return;
  const hint = document.getElementById('galleryBadgeHint');
  if (galleryMode === 'lightbox') {
    galleryBig.src = e.src;
    // 💬 Show prompt: visible only when the entry has a prompt. The prompt
    // itself is never rendered here — Show prompt opens the modal.
    if (e.prompt) {
      galleryPromptBtn.classList.add('show');
    } else {
      galleryPromptBtn.classList.remove('show');
    }
    // Badge overlay (top-center): the transform that produced this image.
    if (e.badge) {
      galleryBadge.textContent = e.badge;
      galleryBadge.classList.add('show');
    } else {
      galleryBadge.classList.remove('show');
      galleryBadge.textContent = '';
    }
    // Hover hint below the badge: the ORIGINAL source prompt of an appended
    // edit/restore (hovering "Edited"/"Restored" shows the prompt of the
    // image it was made from, in a grey translucent panel). Empty for plain
    // generations, upscales (replaced, prompt already shown via Show
    // prompt) and edits of non-gallery sources.
    if (e.originalPrompt) {
      hint.textContent = e.originalPrompt;
      hint.classList.remove('empty');
    } else {
      hint.textContent = '';
      hint.classList.add('empty');
    }
  } else {
    galleryBefore.src = e.before || e.src;
    galleryAfter.src = e.src;
    gallerySlider.style.setProperty('--p', '50%');
    galleryLabelAfter.textContent =
      e.kind === 'edit' ? 'Edited' : e.kind === 'restore' ? 'Restored'
        : e.kind === 'upscale' ? 'Upscaled' : 'Result';
    galleryBadge.classList.remove('show');
    hint.textContent = '';
    hint.classList.add('empty');
    galleryPromptBtn.classList.remove('show'); // compare mode has no prompt button
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
  galleryIdx = ((galleryIdx + delta) % galleryEntries.length + galleryEntries.length) % galleryEntries.length;
  renderGalleryItem();
}

// ── Openers ────────────────────────────────
// Generate lightbox: the GENERATED history (session), not the live DOM —
// so the history survives the pane only showing the last result. Called with
// the clicked img (to position on it) or nothing (⛶ → most recent).
function openGenerateLightbox(img) {
  const all = window.galleryGenerated;
  if (!all.length) return showToast('Nothing to show yet');
  galleryMode = 'lightbox';
  galleryEntries = all;
  galleryBig.style.display = '';
  gallerySlider.style.display = 'none';
  let idx = all.length - 1; // default: most recent
  if (img && img.src) {
    const i = all.findIndex(e => e.src === img.src);
    if (i >= 0) idx = i;
  }
  galleryIdx = idx;
  renderGalleryItem();
  openGalleryOverlay();
}

// Edit/Upscale compare: the gallery ONLY navigates the edited/restored/
// upscaled comparisons; start from the requested kind.
function openCompareFullscreen(kind) {
  const all = collectCompareEntries();
  if (!all.length) return showToast('No comparison to show yet');
  galleryMode = 'compare';
  galleryEntries = all;
  galleryBig.style.display = 'none';
  gallerySlider.style.display = '';
  const i = all.findIndex(e => e.kind === kind);
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
  let w = vw * 0.96, h = w / r;
  if (h > vh * 0.92) { h = vh * 0.92; w = h * r; }
  gallerySlider.style.width = w + 'px';
  gallerySlider.style.height = h + 'px';
}
galleryBefore.addEventListener('load', fitGallerySlider);
window.addEventListener('resize', () => { if (galleryMode === 'compare') fitGallerySlider(); });

// ── Download (currently shown image) ───────
async function galleryDownload() {
  const e = galleryEntries[galleryIdx];
  if (!e) return;
  const src = galleryMode === 'lightbox' ? galleryBig.src : galleryAfter.src;
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

// ── Prompt modal (💬 Show prompt) ───────────
// Semi-transparent modal showing the current entry's prompt at a
// device-appropriate font size (the CSS uses clamp(vw+vh)). Only available
// in lightbox mode and only when the entry has a prompt (the button is
// hidden otherwise). Closes on ✕, backdrop click, Escape, navigation and
// gallery close.
function openGalleryPrompt() {
  const e = galleryEntries[galleryIdx];
  if (!e || !e.prompt) return;
  galleryPromptText.textContent = e.prompt; // textContent — never innerHTML
  galleryPromptModal.classList.add('show');
}

function closeGalleryPrompt() {
  galleryPromptModal.classList.remove('show');
}

// ── Wiring ─────────────────────────────────
galleryCloseBtn.addEventListener('click', closeGallery);
galleryDlBtn.addEventListener('click', galleryDownload);
galleryPrevBtn.addEventListener('click', e => { e.stopPropagation(); galleryNav(-1); });
galleryNextBtn.addEventListener('click', e => { e.stopPropagation(); galleryNav(1); });
galleryBig.addEventListener('click', e => e.stopPropagation());
galleryPromptBtn.addEventListener('click', e => { e.stopPropagation(); openGalleryPrompt(); });
galleryPromptClose.addEventListener('click', e => { e.stopPropagation(); closeGalleryPrompt(); });
galleryPromptModal.addEventListener('click', e => { if (e.target === galleryPromptModal) closeGalleryPrompt(); });
galleryOverlay.addEventListener('click', e => { if (e.target === galleryOverlay) closeGallery(); });

// Keyboard: Escape closes; ←/→ navigate while the overlay is open. While
// the prompt modal is open, Escape closes ONLY the modal (the gallery stays)
// and navigation is suspended so the shown prompt never goes stale.
document.addEventListener('keydown', e => {
  if (!galleryOverlay.classList.contains('show')) return;
  if (galleryPromptModal.classList.contains('show')) {
    if (e.key === 'Escape') closeGalleryPrompt();
    return;
  }
  if (e.key === 'Escape') closeGallery();
  else if (e.key === 'ArrowLeft') galleryNav(-1);
  else if (e.key === 'ArrowRight') galleryNav(1);
});
