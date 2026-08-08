// ── Gallery + fullscreen (B5) ──────────────
// Ported from the reference image viewers in ../open-webui-comfy-tools
// (smart_generate_image / edit_image / upscale_image), adapted to this
// single-page app. Two SEPARATE galleries:
//
//   • Generate (lightbox): navigates the GENERATED history — every image
//     generated this session (window.galleryGenerated), even after the pane
//     only shows the last one. An edit/restore/upscale of a generated image
//     REPLACES the original entry (keeping its generation prompt as the
//     caption overlay) and adds a badge overlay top-center ("Edited" /
//     "Restored" / "Upscaled"). Transformations of non-generated sources
//     (uploads / external URLs) are appended as new entries.
//   • Edit/Upscale (compare): opens the fullscreen overlay with its own
//     interactive slider; the gallery there ONLY navigates the
//     edited/restored/upscaled comparisons (never generated images).
//
// Close ✕ is top-RIGHT, download top-LEFT (inverted vs the reference —
// project decision). Video results are only COLLECTED (data-video-gallery
// marker + window.galleryVideos) for a future video gallery — see PLAN.md.

const galleryOverlay = document.getElementById('galleryOverlay');
const galleryBig = document.getElementById('galleryBig');
const gallerySlider = document.getElementById('gallerySlider');
const galleryBefore = document.getElementById('galleryBefore');
const galleryAfter = document.getElementById('galleryAfter');
const galleryCaption = document.getElementById('galleryCaption');
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
// Entry: { src, prompt (generation prompt, preserved through transforms),
//          badge: '' | 'edited' | 'restored' | 'upscaled', filename }.
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
  });
}

// An edit/restore/upscale of sourceSrc -> new result src. When the source is
// a generated image (filename match), the entry is REPLACED in place —
// keeping its generation prompt, updating the src and the badge. Sources
// that are not generated images are appended as new entries (their prompt is
// the transformation's prompt, empty when there is none).
function addTransformedEntry(src, prompt, badge, sourceSrc) {
  const fn = filenameFromUrl(sourceSrc);
  if (fn) {
    const i = window.galleryGenerated.findIndex(e => e.filename === fn);
    if (i >= 0) {
      const entry = window.galleryGenerated[i];
      entry.src = src;
      entry.badge = badge;
      entry.filename = filenameFromUrl(src);
      return;
    }
  }
  window.galleryGenerated.push({
    src, prompt: prompt || '', badge, filename: filenameFromUrl(src),
  });
}

// ── Compare entries (Edit/Upscale) ─────────
// The compare gallery only collects the compare sliders marked in the DOM
// (their AFTER image is the identity, like the reference's #thumb); never
// generated images. kinds: edit | restore | upscale.
function collectCompareEntries() {
  const entries = [];
  document.querySelectorAll('[data-gallery="1"]').forEach(el => {
    if (!el.classList.contains('compare-slider')) return;
    const after = el.querySelector('img.side.after');
    const bfr = el.querySelector('img.side.before');
    if (!after || !after.src) return;
    const kind = el.dataset.kind || 'edit';
    if (kind !== 'edit' && kind !== 'restore' && kind !== 'upscale') return;
    const src = after.src;
    if (!entries.some(e => e.src === src)) {
      entries.push({
        src,
        before: bfr && bfr.src ? bfr.src : null,
        prompt: el.dataset.prompt || '',
        kind,
        el,
      });
    }
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
    }
  })
);

// ── Render the current gallery item ────────
function renderGalleryItem() {
  const e = galleryEntries[galleryIdx];
  if (!e) return;
  if (galleryMode === 'lightbox') {
    galleryBig.src = e.src;
    // Badge overlay (top-center): the transform that produced this image.
    if (e.badge) {
      galleryBadge.textContent = e.badge;
      galleryBadge.classList.add('show');
    } else {
      galleryBadge.classList.remove('show');
      galleryBadge.textContent = '';
    }
  } else {
    galleryBefore.src = e.before || e.src;
    galleryAfter.src = e.src;
    gallerySlider.style.setProperty('--p', '50%');
    galleryLabelAfter.textContent =
      e.kind === 'edit' ? 'Edited' : e.kind === 'restore' ? 'Restored'
        : e.kind === 'upscale' ? 'Upscaled' : 'Result';
    galleryBadge.classList.remove('show');
    fitGallerySlider();
  }
  // Prompt caption: the entry's prompt (for a replaced generated entry this
  // is the ORIGINAL generation prompt, preserved through the transform).
  if (e.prompt) {
    galleryCaption.textContent = e.prompt; // textContent — never innerHTML
    galleryCaption.classList.add('show');
  } else {
    galleryCaption.classList.remove('show');
    galleryCaption.textContent = '';
  }
  // Counter + nav buttons only when there is more than one entry.
  const multi = galleryEntries.length > 1;
  galleryPrevBtn.style.display = multi ? '' : 'none';
  galleryNextBtn.style.display = multi ? '' : 'none';
  galleryCounter.style.display = multi ? '' : 'none';
  if (multi) galleryCounter.textContent = (galleryIdx + 1) + '/' + galleryEntries.length;
}

function galleryNav(delta) {
  if (!galleryMode || galleryEntries.length < 2) return;
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

// ── Wiring ─────────────────────────────────
galleryCloseBtn.addEventListener('click', closeGallery);
galleryDlBtn.addEventListener('click', galleryDownload);
galleryPrevBtn.addEventListener('click', e => { e.stopPropagation(); galleryNav(-1); });
galleryNextBtn.addEventListener('click', e => { e.stopPropagation(); galleryNav(1); });
galleryBig.addEventListener('click', e => e.stopPropagation());
galleryOverlay.addEventListener('click', e => { if (e.target === galleryOverlay) closeGallery(); });

// Keyboard: Escape closes; ←/→ navigate while the overlay is open.
document.addEventListener('keydown', e => {
  if (!galleryOverlay.classList.contains('show')) return;
  if (e.key === 'Escape') closeGallery();
  else if (e.key === 'ArrowLeft') galleryNav(-1);
  else if (e.key === 'ArrowRight') galleryNav(1);
});
