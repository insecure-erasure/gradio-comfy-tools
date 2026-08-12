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
  return input ? input.value.trim() : '';
}

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
  clearSourcePreview(tab);
  pane.querySelectorAll('.output-placeholder').forEach(el => el.remove());
  pane.querySelectorAll('.compare-slider').forEach(el => el.style.display = 'none');
  if (tab === 'video') {
    // Video tab: the preview replaces the video component — hide the mock
    // placeholder and remove any previous generated video (the custom
    // .video-player wrapper; the <video> lives inside it). The image stays
    // behind the loading overlay while a generation runs and is removed
    // when the generated video is shown (showResult).
    pane.querySelectorAll('.video-player, .result-video').forEach(el => el.remove());
    const mock = pane.querySelector('.video-mock');
    if (mock) mock.style.display = 'none';
  }
  const img = document.createElement('img');
  img.className = 'source-preview';
  img.alt = 'Source preview';
  img.src = proxiedSrc(src);
  pane.insertBefore(img, pane.firstChild);
}

// Remove only the source preview image (used when the field is edited).
// Also cancels any pending 🔗 flash, un-forces the collapse so the field
// can expand again while the user types, and restores the video mock
// placeholder (Video tab).
function clearSourcePreview(tab) {
  const pane = document.getElementById(`${tab}OutputPane`);
  if (!pane) return;
  pane.querySelectorAll('.source-preview').forEach(el => el.remove());
  if (tab === 'video') {
    const mock = pane.querySelector('.video-mock');
    if (mock) mock.style.display = '';
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

