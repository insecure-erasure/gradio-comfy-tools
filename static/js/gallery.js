// ── Gallery + fullscreen (B5) ──────────────
// Ported from the reference image viewers in ../open-webui-comfy-tools
// (smart_generate_image / edit_image / upscale_image), adapted to this
// single-page app (the gallery walks the PAGE DOM, not chat iframes):
//
//   • Generate results open a fullscreen LIGHTBOX with gallery navigation
//     (‹ › buttons, n/N counter, prompt caption, download). Close ✕ is
//     top-RIGHT, download top-LEFT (inverted vs the reference — project
//     decision). Triggered by clicking the result image OR the top-right
//     ⛶ maximize button (consistency).
//   • Edit/Upscale results open a fullscreen overlay with their OWN
//     interactive slider (same drag/hover/divider as the pane). The gallery
//     there only navigates the edited/upscaled comparisons, and edited
//     entries show the edit prompt as caption (upscaled have none).
//   • Video results are only COLLECTED (data-video-gallery marker +
//     window.galleryVideos registry) for a future video gallery — native
//     video controls don't mix with gallery navigation. See PLAN.md B5.
//
// Gallery entries are marked in the DOM by the per-tab result renderers:
//     generate → img.result-img[data-gallery][data-kind="generate"][data-prompt]
//     edit     → #editCompare[data-gallery][data-kind="edit"][data-prompt]
//     upscale  → #upscaleCompare[data-gallery][data-kind="upscale"]
// The AFTER image of a compare slider is its gallery identity (like the
// reference's #thumb); collection reads the DOM on demand, so an entry dies
// when its element is removed (reset) or its markers are cleared (clearPane).

const galleryOverlay = document.getElementById('galleryOverlay');
const galleryBig = document.getElementById('galleryBig');
const gallerySlider = document.getElementById('gallerySlider');
const galleryBefore = document.getElementById('galleryBefore');
const galleryAfter = document.getElementById('galleryAfter');
const galleryCaption = document.getElementById('galleryCaption');
const galleryCounter = document.getElementById('galleryCounter');
const galleryLabelAfter = document.getElementById('galleryLabelAfter');
const galleryCloseBtn = document.getElementById('galleryClose');
const galleryDlBtn = document.getElementById('galleryDl');
const galleryPrevBtn = document.getElementById('galleryPrev');
const galleryNextBtn = document.getElementById('galleryNext');

let galleryMode = null;     // 'lightbox' | 'compare'
let galleryEntries = [];    // collected on open
let galleryIdx = -1;

// ── Collection ─────────────────────────────
// Every element with data-gallery="1": a compare slider contributes its
// AFTER image (identity) + before image + kind + prompt; a plain img its
// src + kind + prompt. Dedup by src (an entry can only exist once).
function collectGalleryEntries() {
  const entries = [];
  document.querySelectorAll('[data-gallery="1"]').forEach(el => {
    let src = null, before = null, prompt = '', kind = '';
    if (el.classList.contains('compare-slider')) {
      const after = el.querySelector('img.side.after');
      const bfr = el.querySelector('img.side.before');
      if (after && after.src) {
        src = after.src;
        before = bfr && bfr.src ? bfr.src : null;
      }
      kind = el.dataset.kind || 'edit';
      prompt = el.dataset.prompt || '';
    } else if (el.tagName === 'IMG' && el.src) {
      src = el.src;
      kind = el.dataset.kind || 'generate';
      prompt = el.dataset.prompt || '';
    }
    if (src && !entries.some(e => e.src === src)) {
      entries.push({ src, before, prompt, kind, el });
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
  } else {
    galleryBefore.src = e.before || e.src;
    galleryAfter.src = e.src;
    gallerySlider.style.setProperty('--p', '50%');
    galleryLabelAfter.textContent =
      e.kind === 'edit' ? 'Edited' : e.kind === 'upscale' ? 'Upscaled' : 'Result';
    fitGallerySlider();
  }
  // Prompt caption: shown only when the entry has one (generated/edit).
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
// Generate lightbox: all gallery entries (generated + edited + upscaled).
// Called with the clicked img element, or with nothing (⛶ button → start
// from the last generated result).
function openGenerateLightbox(img) {
  const all = collectGalleryEntries();
  if (!all.length) return showToast('Nothing to show yet');
  const src = (img && img.src) ? img.src : ((all.find(e => e.kind === 'generate') || all[0]).src);
  galleryMode = 'lightbox';
  galleryEntries = all;
  galleryBig.style.display = '';
  gallerySlider.style.display = 'none';
  galleryIdx = galleryEntries.findIndex(e => e.src === src);
  if (galleryIdx < 0) galleryIdx = 0;
  renderGalleryItem();
  openGalleryOverlay();
}

// Edit/Upscale compare: the gallery ONLY navigates the edited/upscaled
// comparisons (kind filter); start from the requested kind.
function openCompareFullscreen(kind) {
  const all = collectGalleryEntries().filter(e => e.kind === 'edit' || e.kind === 'upscale');
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
