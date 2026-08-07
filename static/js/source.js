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
  if (!/^https?:\/\//i.test(value)) {
    return '/media/' + encodeURIComponent(value) + '?type=temp';
  }
  if (baseUrl) {
    try {
      const u = new URL(value);
      const origin = new URL(baseUrl).origin;
      if (u.origin === origin && u.pathname === '/view') {
        const fn = u.searchParams.get('filename');
        if (fn) {
          return '/media/' + encodeURIComponent(fn) + '?type=' + (u.searchParams.get('type') || 'output');
        }
      }
    } catch (e) { /* not a URL — fall through to direct */ }
  }
  return value;
}

// Show the source image in the output pane, filling the available area.
// Replaces any previous preview / plain result / placeholder and hides the
// compare sliders; the video mock placeholder comes back (its tab).
function previewSourceImage(tab, src) {
  const pane = document.getElementById(`${tab}OutputPane`);
  if (!pane) return;
  clearSourcePreview(tab);
  pane.querySelectorAll('.output-placeholder').forEach(el => el.remove());
  pane.querySelectorAll('.compare-slider').forEach(el => el.style.display = 'none');
  const mock = pane.querySelector('.video-mock');
  if (mock) mock.style.display = '';
  const img = document.createElement('img');
  img.className = 'source-preview';
  img.alt = 'Source preview';
  img.src = proxiedSrc(src);
  pane.insertBefore(img, pane.firstChild);
}

// Remove only the source preview image (used when the field is edited).
// Also cancels any pending 🔗 flash and un-forces the collapse so the field
// can expand again while the user types.
function clearSourcePreview(tab) {
  const pane = document.getElementById(`${tab}OutputPane`);
  if (!pane) return;
  pane.querySelectorAll('.source-preview').forEach(el => el.remove());
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

// Base name of a source URL (filename without extension), used to build
// readable fake result names in the mockup. Kept for reference/tooling.
function baseNameFromUrl(url) {
  try {
    const u = new URL(url);
    const filename = u.searchParams.get('filename');
    if (filename) return filename.replace(/\.[a-z0-9]+$/i, '');
    const seg = u.pathname.split('/').pop();
    if (seg) return seg.replace(/\.[a-z0-9]+$/i, '');
  } catch (e) { /* not a URL */ }
  return 'source';
}
