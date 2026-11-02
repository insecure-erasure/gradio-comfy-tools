// ── Source image (Edit/Upscale/Video) ──────
// Each tab has a transparent URL field over its output pane: users paste an
// external URL directly, use 🔗 to fill it with the last generation, or 📁
// to upload a file to ComfyUI (temp). The field value feeds the tool's
// `image` input (the backend auto-detects filename vs URL).
//
// ✓ confirm: validates the value server-side (POST /api/check-image — the
// browser cannot read cross-origin headers) and, when it is really an image,
// shows it as a preview in the output pane filling the available area.

// 🔗 fills the tab's field with the last generation; persists across tabs.
// Also shows the image in the output pane (preview) and flashes the URL
// field open briefly, then auto-collapses it.
function usePreviousSource(tab) {
  const input = document.getElementById(`${tab}SourceUrl`);
  if (lastGeneratedUrl) {
    input.value = lastGeneratedUrl;
    previewSourceImage(tab, lastGeneratedUrl);
    flashSourceField(tab);
    showToast('Source set to previous generation — image loaded');
  } else {
    showToast('No previous generation yet — generate an image first');
  }
}

function getSourceUrl(tab) {
  const input = document.getElementById(`${tab}SourceUrl`);
  let value = input ? input.value.trim() : '';
  // Reuse the last source loaded in this tool when the field is empty. This
  // is the reload/background-discard case: the result (and lastGeneratedUrl)
  // survive in the galleries, but the input is recreated empty. Refill it so
  // the user can repeat the run with another seed without pressing 🔗 again.
  if (!value && lastSourceByTab[tab]) {
    value = lastSourceByTab[tab];
    if (input) input.value = value;
  }
  return value;
}

// Remember the last source actually loaded/used by a single-source tool.
// Called by previewSourceImage (🔗 / 🕘 / ✓ / upload) and on submit; kept
// separate from sourceHistory (which also receives generated results).
function rememberLastSource(tab, value) {
  if (!(tab in lastSourceByTab)) return;
  value = (value || '').trim();
  if (!value || lastSourceByTab[tab] === value) return;
  lastSourceByTab[tab] = value;
  if (typeof savePersistedState === 'function') savePersistedState();
}

// ── Recent source history (🕘) ─────────────
// Keeps the last SOURCE images loaded/used per tab so a previous run can be
// retried after its result replaced the source preview. Single-source tabs
// store { value }; Face swap stores { base, face } pairs.
let _sourceHistoryTab = null;
// Monotonic token so an in-flight preflight cannot render after the popover
// was closed or reopened for another tab (openSourceHistory is async now).
let _sourceHistoryReq = 0;

// Restore/normalize the persisted history (called by storage.js on startup).
// Bad entries are dropped; duplicates are removed; each list is capped.
function restoreSourceHistory(data) {
  if (!data || typeof data !== 'object') return;
  ['edit', 'upscale', 'video'].forEach(tab => {
    const list = Array.isArray(data[tab]) ? data[tab] : [];
    const seen = new Set();
    const out = [];
    for (const e of list) {
      const value = e && typeof e.value === 'string' ? e.value.trim() : '';
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push({ value, ts: Number(e.ts) || 0 });
      if (out.length >= SOURCE_HISTORY_MAX) break;
    }
    sourceHistory[tab] = out;
  });
  // Face swap entries are base+face PAIRS or base-only images (generated
  // results that can be reused as the base with a different face).
  const pairs = Array.isArray(data.face_swap) ? data.face_swap : [];
  const seenPairs = new Set();
  const out = [];
  for (const e of pairs) {
    const base = e && typeof e.base === 'string' ? e.base.trim() : '';
    const face = e && typeof e.face === 'string' ? e.face.trim() : '';
    const key = base + '\u0000' + face;
    if (!base || seenPairs.has(key)) continue;
    seenPairs.add(key);
    out.push({ base, face, ts: Number(e.ts) || 0 });
    if (out.length >= SOURCE_HISTORY_MAX) break;
  }
  sourceHistory.face_swap = out;
}

// Remove an existing matching entry, insert the new one at the front and
// cap the list. Shared by all history flavors.
function _historyUnshift(list, entry, matches) {
  const idx = list.findIndex(matches);
  if (idx >= 0) list.splice(idx, 1);
  list.unshift(entry);
  if (list.length > SOURCE_HISTORY_MAX) list.length = SOURCE_HISTORY_MAX;
}

// Remember a single-source image (Edit/Upscale/Video). Deduplicated and
// moved to the front; capped at SOURCE_HISTORY_MAX.
function rememberSourceHistory(tab, value) {
  value = (value || '').trim();
  if (!value || !Array.isArray(sourceHistory[tab])) return;
  rememberLastSource(tab, value);
  const list = sourceHistory[tab];
  if (list[0] && list[0].value === value) return; // already the newest
  _historyUnshift(list, { value, ts: Date.now() }, e => e.value === value);
  if (typeof savePersistedState === 'function') savePersistedState();
}

// Remember a Face swap base+face pair (both are required for a real retry).
function rememberFaceSwapHistory(base, face) {
  base = (base || '').trim();
  face = (face || '').trim();
  if (!base || !face) return;
  const list = sourceHistory.face_swap;
  if (list[0] && list[0].base === base && list[0].face === face) return;
  _historyUnshift(
    list,
    { base, face, ts: Date.now() },
    e => e.base === base && e.face === face
  );
  if (typeof savePersistedState === 'function') savePersistedState();
}

// Remember a generated IMAGE result as a source candidate in EVERY source
// tab (and as a base-only Face swap entry), so the 🕘 popover shows it
// immediately without pressing 🔗 first. One localStorage write.
function rememberGeneratedImage(url) {
  url = (url || '').trim();
  if (!url) return;
  const ts = Date.now();
  ['edit', 'upscale', 'video'].forEach(tab => {
    const list = sourceHistory[tab];
    if (!Array.isArray(list) || (list[0] && list[0].value === url)) return;
    _historyUnshift(list, { value: url, ts }, e => e.value === url);
  });
  const fsList = sourceHistory.face_swap;
  if (!(fsList[0] && fsList[0].base === url && !fsList[0].face)) {
    _historyUnshift(
      fsList,
      { base: url, face: '', ts },
      e => e.base === url && !e.face
    );
  }
  if (typeof savePersistedState === 'function') savePersistedState();
}

// Short filename for a history card's caption.
function sourceHistoryLabel(value) {
  try {
    if (/\/view\?/.test(value)) {
      const q = new URLSearchParams(value.split('?')[1] || '');
      return q.get('filename') || 'Image';
    }
    if (/^\/media\//.test(value)) {
      return decodeURIComponent(value.split('?')[0].split('/').pop() || 'Image');
    }
    if (/^https?:\/\//i.test(value)) {
      const u = new URL(value);
      return decodeURIComponent(u.pathname.split('/').pop() || u.hostname) || 'Image';
    }
  } catch (e) { /* fall through */ }
  return value.split('/').pop() || 'Image';
}

// Square `cover` thumbnail; the uncropped image is shown by the hover/focus
// popout (`showSourceHistoryPeek`) rather than by changing the cell itself.
function _historyThumb(value, alt) {
  const img = document.createElement('img');
  img.src = proxiedSrc(value);
  img.alt = alt;
  img.loading = 'lazy';
  img.draggable = false;
  img.addEventListener('error', () => img.classList.add('broken'));
  return img;
}

// ---------------------------------------------------------------- peek card
// A slightly larger, uncropped copy of the hovered thumbnail, centred on it
// and kept inside the popover. It is a fixed-position card in <body>: the
// grid's `overflow-y` would clip anything inside the popover, and
// `pointer-events: none` keeps it from stealing the hover.
const PEEK_SCALE = 1.25;       // preview content is ~1.25x the thumbnail's crop
const PEEK_MAX_UPSCALE = 3;    // but never blow a tiny source up beyond 3x natural
const PEEK_INSET = 8;          // keep the card inside the popover's padding
// Touch devices have no hover: arm the pointer preview only when the primary
// input can actually hover (same gate the CSS used before).
const _hoverMedia = window.matchMedia
  ? window.matchMedia('(hover: hover) and (pointer: fine)')
  : null;

function showSourceHistoryPeek(btn) {
  const pop = document.getElementById('sourceHistoryPopover');
  const card = document.getElementById('sourceHistoryPeek');
  const thumb = btn ? btn.querySelector('img') : null;
  if (!pop || !card || !thumb) return;
  // Dead temp file: nothing to show, keep the dimmed slot.
  if (thumb.classList.contains('broken') || !thumb.naturalWidth) return;
  const nw = thumb.naturalWidth;
  const nh = thumb.naturalHeight;
  const pr = pop.getBoundingClientRect();
  const tr = thumb.getBoundingClientRect();
  // The cell shows a `cover` crop, so its content is ALREADY scaled by
  // max(cell/natural). Sizing the preview box from the cell alone and then
  // fitting the whole image into it (`contain`) can leave the visible content
  // the same size or smaller (a 16:9 source fits its long side into the box).
  // Multiply the crop's own scale by PEEK_SCALE instead: the full image is
  // then genuinely ~1.75x bigger than what the thumbnail shows.
  const coverScale = Math.max(tr.width / nw, tr.height / nh);
  const scale = Math.min(coverScale * PEEK_SCALE, PEEK_MAX_UPSCALE);
  let w = Math.max(1, Math.round(nw * scale));
  let h = Math.max(1, Math.round(nh * scale));
  // Never spill off-screen.
  const fit = Math.min(1, (window.innerWidth - 2 * PEEK_INSET) / w,
    (window.innerHeight - 2 * PEEK_INSET) / h);
  w = Math.max(1, Math.round(w * fit));
  h = Math.max(1, Math.round(h * fit));

  const img = card.querySelector('img');
  if (img.getAttribute('src') !== thumb.src) img.src = thumb.src;

  // Anchor the preview ON the hovered image (centred on the thumbnail). While
  // it fits, keep it inside the popover so it reads as part of the panel; a
  // wide source may be bigger than the popover, so then clamp to the viewport
  // instead. `pointer-events: none` keeps the hover on the item underneath.
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const cx = tr.left + tr.width / 2;
  const cy = tr.top + tr.height / 2;
  const x = w <= pr.width - 2 * PEEK_INSET
    ? clamp(cx - w / 2, pr.left + PEEK_INSET, pr.right - PEEK_INSET - w)
    : clamp(cx - w / 2, PEEK_INSET, window.innerWidth - PEEK_INSET - w);
  const y = h <= pr.height - 2 * PEEK_INSET
    ? clamp(cy - h / 2, pr.top + PEEK_INSET, pr.bottom - PEEK_INSET - h)
    : clamp(cy - h / 2, PEEK_INSET, window.innerHeight - PEEK_INSET - h);

  card.style.width = w + 'px';
  card.style.height = h + 'px';
  card.style.left = x + 'px';
  card.style.top = y + 'px';
  card.classList.add('show');
}

function hideSourceHistoryPeek() {
  const card = document.getElementById('sourceHistoryPeek');
  if (card) card.classList.remove('show');
}

function renderSourceHistoryGrid(tab) {
  const grid = document.getElementById('sourceHistoryGrid');
  if (!grid) return;
  hideSourceHistoryPeek();
  const list = sourceHistory[tab] || [];
  // The value(s) currently in the fields, to mark the active entry.
  const curBase = tab === 'face_swap' && typeof fsSource === 'function' ? fsSource('base') : '';
  const curFace = tab === 'face_swap' && typeof fsSource === 'function' ? fsSource('face') : '';
  const curValue = tab === 'face_swap' ? '' : getSourceUrl(tab);
  grid.replaceChildren();
  list.forEach((entry, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'source-history-item';
    btn.title = tab === 'face_swap'
      ? (entry.face ? `Base: ${entry.base}\nFace: ${entry.face}` : `Base: ${entry.base}`)
      : entry.value;
    const current = tab === 'face_swap'
      ? (curBase === entry.base && (entry.face ? curFace === entry.face : !curFace))
      : (curValue === entry.value);
    if (current) btn.classList.add('current');
    btn.onclick = () => restoreHistorySource(tab, i);
    // Same reveal for pointer and keyboard; touch has no hover, so the grid
    // stays as-is there.
    if (!_hoverMedia || _hoverMedia.matches) {
      btn.addEventListener('mouseenter', () => showSourceHistoryPeek(btn));
      btn.addEventListener('mouseleave', hideSourceHistoryPeek);
    }
    // Mouse clicks focus too, but the popover closes right after: only
    // keyboard focus should pop out.
    btn.addEventListener('focus', () => {
      let keyboard = true;
      try { keyboard = btn.matches(':focus-visible'); } catch (e) { /* older engines */ }
      if (keyboard) showSourceHistoryPeek(btn);
    });
    btn.addEventListener('blur', hideSourceHistoryPeek);
    if (tab === 'face_swap') {
      const pair = document.createElement('span');
      pair.className = 'source-history-pair';
      pair.appendChild(_historyThumb(entry.base, 'Base'));
      if (entry.face) {
        pair.appendChild(_historyThumb(entry.face, 'Face'));
      } else {
        // Generated images are stored as base-only entries (no face yet):
        // keep the pair slot so the grid rows stay aligned.
        const empty = document.createElement('span');
        empty.className = 'source-history-slot-empty';
        empty.textContent = 'no face';
        pair.appendChild(empty);
      }
      btn.appendChild(pair);
      const label = document.createElement('span');
      label.className = 'source-history-label';
      label.textContent = entry.face ? 'Base + Face' : 'Base only';
      btn.appendChild(label);
    } else {
      btn.appendChild(_historyThumb(entry.value, 'Source'));
      const label = document.createElement('span');
      label.className = 'source-history-label';
      label.textContent = sourceHistoryLabel(entry.value);
      btn.appendChild(label);
    }
    grid.appendChild(btn);
  });
}

function closeSourceHistory() {
  _sourceHistoryTab = null;
  _sourceHistoryReq++; // cancel an in-flight preflight
  hideSourceHistoryPeek();
  const pop = document.getElementById('sourceHistoryPopover');
  if (pop) pop.classList.remove('show');
}

async function openSourceHistory(tab, btn) {
  const req = ++_sourceHistoryReq;
  const pop = document.getElementById('sourceHistoryPopover');
  const grid = document.getElementById('sourceHistoryGrid');
  const title = document.getElementById('sourceHistoryTitle');
  if (!pop || !grid || !btn) return;
  if (!(sourceHistory[tab] || []).length) {
    showToast(tab === 'face_swap'
      ? 'No recent base + face pairs yet'
      : 'No recent source images yet');
    return;
  }
  if (pop.classList.contains('show') && _sourceHistoryTab === tab) {
    closeSourceHistory();
    return;
  }
  // Preflight the persisted thumbnails BEFORE the grid paints: one cached
  // HEAD per entry, so files the ComfyUI cleanup removed are never even
  // requested. Confirmed-missing entries are dropped through dropMedia().
  if (typeof pruneSourceHistory === 'function') await pruneSourceHistory(tab);
  if (req !== _sourceHistoryReq) return; // closed/reopened while probing
  if (!(sourceHistory[tab] || []).length) {
    showToast(tab === 'face_swap'
      ? 'No recent base + face pairs yet'
      : 'No recent source images yet');
    return;
  }
  _sourceHistoryTab = tab;
  if (title) title.textContent = tab === 'face_swap' ? 'Recent base / face' : 'Recent sources';
  renderSourceHistoryGrid(tab);
  // Show first so offsetWidth/Height are measurable, then anchor ABOVE the
  // button (right-aligned), falling back below when there is no room.
  pop.classList.add('show');
  const r = btn.getBoundingClientRect();
  const pw = pop.offsetWidth || 320;
  const ph = pop.offsetHeight || 200;
  const left = Math.min(Math.max(8, r.right - pw), window.innerWidth - pw - 8);
  let top = r.top - ph - 8;
  if (top < 8) top = Math.min(window.innerHeight - ph - 8, r.bottom + 8);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}

function restoreHistorySource(tab, index) {
  const entry = (sourceHistory[tab] || [])[index];
  if (!entry) return;
  closeSourceHistory();
  if (tab === 'face_swap') {
    if (typeof restoreFaceSwapHistorySource === 'function') restoreFaceSwapHistorySource(entry);
    return;
  }
  const input = document.getElementById(`${tab}SourceUrl`);
  if (!input) return;
  input.value = entry.value;
  previewSourceImage(tab, entry.value);
  flashSourceField(tab);
  showToast('Previous source restored');
}

// Dismiss on click-outside / Esc / resize. The clock buttons are exempt so
// their own onclick can toggle the popover.
document.addEventListener('click', e => {
  if (e.target.closest('#sourceHistoryPopover, .source-history-btn')) return;
  closeSourceHistory();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSourceHistory();
});
window.addEventListener('resize', closeSourceHistory);
document.addEventListener('scroll', hideSourceHistoryPeek, true);

// Resolve a source value (external URL, /media/.., {base}/view?.., bare
// temp filename) to a SAME-ORIGIN proxy URL for the compare-slider BEFORE
// image. The pane cannot load the ComfyUI host URL directly (CORS /
// host-validation) — that is why everything goes through /media.
function beforeProxyUrl(value) {
  if (!value) return '';
  // ComfyUI result URL ({base}/view?filename=..&type=..) — including the
  // direct http(s) form that 🔗 puts in the source field. MUST be proxied
  // through the same-origin /media endpoint: on mobile (portrait) the
  // ComfyUI hostname often does not resolve from the phone, and the raw
  // <img> would come back black. This check comes BEFORE the generic
  // external-URL check for that reason.
  if (/\/view\?/.test(value)) {
    const q = value.split('?')[1] || '';
    const fn = new URLSearchParams(q).get('filename');
    const type = new URLSearchParams(q).get('type') || 'output';
    if (fn) return '/media/' + encodeURIComponent(fn) + '?type=' + type;
  }
  // /media/FILENAME?type=.. -> already same-origin.
  if (/^\/media\//.test(value)) return value;
  // Genuinely external URL -> as-is (a plain <img> can load any public URL).
  if (/^https?:\/\//i.test(value)) return value;
  // Bare temp filename (uploaded) -> proxy as temp.
  return '/media/' + encodeURIComponent(value.split('/').pop()) + '?type=temp';
}

// ── Source dimensions ─────────────────────
// The loaded source preview reports its natural size. Edit/Upscale show a
// discreet W×H badge above the bottom-right action buttons; the Edit Extend
// popover also uses it for the Source/Output estimate.
const sourceDimensions = { edit: null, upscale: null, video: null };

function getSourceDimensions(tab) {
  return sourceDimensions[tab] || null;
}

function _renderSourceDimensionBadge(tab) {
  if (tab !== 'edit' && tab !== 'upscale') return;
  const pane = document.getElementById(`${tab}OutputPane`);
  if (!pane) return;
  pane.querySelectorAll('.source-dimensions').forEach(el => el.remove());
  const dims = sourceDimensions[tab];
  if (!dims) return;
  const box = document.createElement('div');
  box.className = 'source-dimensions';
  box.textContent = `${dims.width} × ${dims.height}`;
  box.title = `Source image dimensions: ${dims.width} × ${dims.height}`;
  pane.appendChild(box);
}

function setSourceDimensions(tab, width, height) {
  if (!width || !height) {
    clearSourceDimensions(tab);
    return;
  }
  sourceDimensions[tab] = { width, height };
  _renderSourceDimensionBadge(tab);
  if (tab === 'edit' && typeof updateEditExtendInfo === 'function') updateEditExtendInfo();
}

function clearSourceDimensions(tab) {
  sourceDimensions[tab] = null;
  if (tab === 'edit' || tab === 'upscale') {
    const pane = document.getElementById(`${tab}OutputPane`);
    if (pane) pane.querySelectorAll('.source-dimensions').forEach(el => el.remove());
  }
  if (tab === 'edit' && typeof updateEditExtendInfo === 'function') updateEditExtendInfo();
}

// Clicking a source URL field selects all its text when it already has
// content, so it can be deleted or replaced easily (paste over). The
// select-all only applies on the first focus; subsequent clicks behave
// normally so the user can still place the cursor in the middle of the URL.
function selectAllOnFocus(input) {
  if (!input) return;
  input.addEventListener('focus', () => {
    if (!input.value) return;
    input.select();
    // the browser would collapse the select-all when the mouse is released;
    // swallow that mouseup once so the whole value stays selected
    input.addEventListener('mouseup', (e) => e.preventDefault(), { once: true });
  });
}

// Wire select-all-on-focus for every tab's source URL field, plus a
// mobile keyboard guard: on phones (<768px) the field sits at the BOTTOM
// of the output pane, which is taller than the visible area once the
// keyboard opens (the layout viewport does not shrink for position:fixed/
// absolute elements — the keyboard just overlays it). scrollIntoView on
// focus + on every visualViewport resize/scroll keeps the focused field
// above the keyboard.
function initSourceFields() {
  ['edit', 'upscale', 'video'].forEach(tab => {
    const input = document.getElementById(`${tab}SourceUrl`);
    selectAllOnFocus(input);
    keepSourceFieldVisible(input);
    // Also remember URLs typed/pasted directly when the field is left, so
    // the fallback survives a later reload even without pressing ✓.
    if (input) input.addEventListener('change', () => {
      const value = input.value.trim();
      if (value) rememberLastSource(tab, value);
    });
    // Enter in the field = confirm, exactly like the ✓ button (validate
    // server-side + show the preview + collapse). No-op while a check is
    // already running (the ✓ button is busy).
    if (input) input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // a plain text input — no submit; keep it explicit
      const field = sourceUrlField(tab);
      const btn = field && field.querySelector('.source-url-confirm');
      if (btn && btn.disabled) return; // a check is already in flight
      confirmSourceUrl(tab);
    });
  });
}

// Scroll the focused source URL field into view whenever the visible area
// changes (keyboard open/close, zoom). Only on mobile; no-op elsewhere.
// scrollIntoView works even though body is overflow:hidden — the browser
// scrolls the visual viewport (the layout is fixed, the visual one pans).
function keepSourceFieldVisible(input) {
  if (!input) return;
  const isMobile = () => window.matchMedia('(max-width: 767px)').matches;
  const bring = () => { if (isMobile() && document.activeElement === input) input.scrollIntoView({ block: 'center', behavior: 'auto' }); };
  input.addEventListener('focus', () => {
    if (isMobile()) setTimeout(bring, 50); // after the field expands (focus)
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', bring);
    window.visualViewport.addEventListener('scroll', bring);
  }
}

// The source URL field wrapper for a tab (Edit/Upscale/Video).
function sourceUrlField(tab) {
  const input = document.getElementById(`${tab}SourceUrl`);
  return input ? input.closest('.source-url-field') : null;
}

// Collapse the field back to 10% (it normally stays expanded while it has
// content). Used after ✓ confirm. Re-focusing the input expands it again.
function collapseSourceField(tab) {
  const field = sourceUrlField(tab);
  if (!field) return;
  clearTimeout(field._flashTimer);
  const input = field.querySelector('.source-url-input');
  if (input) input.blur();
  field.classList.add('collapsed');
}

// 🔗: expand the field briefly (show the filled URL + ✓), then auto-collapse
// after a short pause — unless the user is already editing the value.
function flashSourceField(tab) {
  const field = sourceUrlField(tab);
  if (!field) return;
  clearTimeout(field._flashTimer);
  field.classList.remove('collapsed'); // content keeps it expanded
  field._flashTimer = setTimeout(() => {
    const input = field.querySelector('.source-url-input');
    if (input && document.activeElement === input) return; // user is editing — leave it
    if (input) input.blur();
    field.classList.add('collapsed');
  }, 1500);
}

// Same-origin <img> src for a source value:
//   - ComfyUI temp filename      -> /media/{filename}?type=temp (proxy)
//   - URL from the configured    -> /media/{filename}?type=... (proxy,
//     ComfyUI host (/view)         parsed from the query)
//   - any other external URL     -> the URL itself (direct)
// The proxy keeps the browser away from the ComfyUI host (no CORS / host
// validation issues) — the same reason generated results use /media.
function proxiedSrc(value) {
  // Same logic as beforeProxyUrl: proxy ANY ComfyUI /view?filename= URL
  // through the same-origin /media endpoint (the origin comparison here
  // used to let a mismatched base URL leak the raw ComfyUI host to the
  // <img> — black on devices that cannot reach that hostname, e.g. a
  // phone in portrait).
  return beforeProxyUrl(value);
}

// Show the source image in the output pane, filling the available area.
// Replaces any previous preview / plain result / placeholder and hides the
// compare sliders. In the Video tab the preview *replaces* the video
// component (mock placeholder + any generated video) so the source image is
// what fills the pane until a generation runs.
function previewSourceImage(tab, src) {
  const pane = document.getElementById(`${tab}OutputPane`);
  if (!pane) return;
  // Persist the value even if the preview image later fails to load.
  rememberLastSource(tab, src);
  clearSourcePreview(tab);
  pane.querySelectorAll('.output-placeholder').forEach(el => el.remove());
  pane.querySelectorAll('.compare-slider').forEach(el => el.style.display = 'none');
  if (tab === 'video') {
    // Video tab: the preview replaces the video component — remove any
    // previous generated video AND the empty (disabled) player (the
    // .video-player selector covers both; the empty player comes back in
    // clearSourcePreview). The image stays behind the loading overlay while
    // a generation runs and is removed when the generated video is shown
    // (showResult).
    pane.querySelectorAll('.video-player, .result-video').forEach(el => el.remove());
  }
  const img = document.createElement('img');
  img.className = 'source-preview';
  img.alt = 'Source preview';
  img.addEventListener('load', () => {
    if (tab === 'edit' || tab === 'upscale') {
      setSourceDimensions(tab, img.naturalWidth, img.naturalHeight);
    }
    // Keep the 🕘 history fresh (a confirmed/uploaded/chained source).
    rememberSourceHistory(tab, src);
  });
  img.addEventListener('error', () => clearSourceDimensions(tab));
  img.src = proxiedSrc(src);
  pane.insertBefore(img, pane.firstChild);
}

// Remove only the source preview image (used when the field is edited).
// Also cancels any pending 🔗 flash, un-forces the collapse so the field
// can expand again while the user types, and restores the video empty
// (disabled) player (Video tab).
function clearSourcePreview(tab) {
  const pane = document.getElementById(`${tab}OutputPane`);
  if (!pane) return;
  pane.querySelectorAll('.source-preview, .source-dimensions').forEach(el => el.remove());
  clearSourceDimensions(tab);
  if (tab === 'video') {
    ensureEmptyVideoPlayer(pane); // no preview → back to the disabled player
  }
  const field = sourceUrlField(tab);
  if (field) {
    clearTimeout(field._flashTimer);
    field.classList.remove('collapsed');
  }
}

// ✓ — validate the field value server-side and show it as a preview.
// Toasts a clear error when the value is not a reachable image.
async function confirmSourceUrl(tab) {
  const src = getSourceUrl(tab);
  if (!src) return showToast('Paste or upload an image URL first');
  const field = sourceUrlField(tab);
  const btn = field && field.querySelector('.source-url-confirm');
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try {
    const resp = await fetch('/api/check-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: src }),
    });
    const j = await resp.json();
    if (!j.ok) {
      showToast('❌ Not a valid image: ' + (j.error || 'unknown error'));
      return;
    }
    previewSourceImage(tab, src);
    collapseSourceField(tab); // collapse back after confirming
    showToast('✅ Image loaded — source ready');
  } catch (e) {
    showToast('❌ Check failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
  }
}

// 📁 upload -> POST /api/upload (ComfyUI temp) -> fill the source field and
// show the uploaded image as a preview.
function uploadForTab(tab) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const resp = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error(resp.statusText);
      const j = await resp.json();
      const field = document.getElementById(`${tab}SourceUrl`);
      if (field) field.value = j.filename;
      previewSourceImage(tab, j.filename);
      showToast('Image uploaded — source set');
    } catch (e) {
      showToast('❌ Upload failed: ' + e.message);
    }
  };
  input.click();
}

