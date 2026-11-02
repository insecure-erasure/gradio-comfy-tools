// ── Media deletion events (ComfyUI cleanup → browser) ─────────────────────
// The ComfyUI cleanup task deletes generated files when they get old. It
// POSTs /api/media-deleted with the EXACT filenames it removed; the backend
// fans that out over /ws/events and this module drops those entries.
//
// Two rules shape the design:
//   • nothing is hidden unless the cleanup task confirmed the file is gone
//     (no TTLs, no age guesses);
//   • nothing polls (the event is pushed; the only other check is the
//     one-shot existence probe when persisted galleries are restored).
//
// mediaDropPlan() is deliberately PURE (no DOM, no globals, no mutation) so
// the data rules can be unit-tested in node — see tests/js/media_events_test.js.

// Identify a generated image by its ComfyUI filename:
//   /media/FILENAME?type=...            -> FILENAME
//   {base}/view?filename=FILENAME&...   -> FILENAME
// Bare names (uploads) and external URLs -> null (not a generated file).
// Lives here (not in gallery.js) so the drop planner and the UI share ONE
// matcher; media-events.js is loaded before gallery.js.
function filenameFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    const m = u.pathname.match(/\/media\/([^/]+)$/);
    if (m) return decodeURIComponent(m[1]);
    if (u.pathname.endsWith('/view')) return u.searchParams.get('filename');
  } catch (e) { /* fall through */ }
  return null;
}

// A ComfyUI filename can also be stored BARE (an upload's display value is
// just its temp filename, no scheme/path). Only treat it as such when it
// cannot be a URL path — external URLs never match a cleanup filename.
function _bareFilename(value) {
  return typeof value === 'string' && /^[^\s/:\\]+$/.test(value) ? value : null;
}

// filename for a gallery entry (generated/comparison/video): the stored
// `filename` when present, otherwise parsed from its display URL.
function mediaEntryFilename(entry) {
  if (!entry) return null;
  if (entry.filename) return entry.filename;
  const src = entry.src || entry.display || entry.url || '';
  return filenameFromUrl(src) || _bareFilename(src);
}

// The ComfyUI filenames a 🕘 source-history entry depends on: `value` for
// the single-source tabs, `base`/`face` for a Face swap pair.
function mediaSourceFilenames(entry) {
  const values = entry && entry.base !== undefined
    ? [entry.base, entry.face]
    : [entry && entry.value];
  return values.map(v => filenameFromUrl(v) || _bareFilename(v));
}

// Pure planner: given the live registries and the filenames the cleanup task
// deleted, return the NEXT arrays plus what the caller must fix up.
//
//   comparison entries are dropped only when their AFTER (result) file is
//   gone; a deleted BEFORE (source) file keeps the result but clears the
//   comparison's before side (the slider then shows the result on both sides
//   instead of a broken image).
//
// Returns:
//   { generated, videos, comparisons, sourceHistory, lastSources,
//     lastGeneratedGone, beforeResets, removed, gone, changed }
// `beforeResets` are the comparison entries to mutate (`e.before = ''`);
// nothing else in the inputs is touched, and entry identity is preserved.
function mediaDropPlan(state, deleted) {
  const gone = new Set(
    (Array.isArray(deleted) ? deleted : [])
      .filter(f => typeof f === 'string' && f.trim())
      .map(f => f.trim())
  );
  const removed = [];
  const beforeResets = [];
  const had = fn => !!fn && gone.has(fn);

  const keep = list => (list || []).filter(entry => {
    if (!had(mediaEntryFilename(entry))) return true;
    removed.push(entry);
    return false;
  });

  const generated = keep(state.generated);
  const videos = keep(state.videos);

  const comparisons = [];
  for (const entry of state.comparisons || []) {
    if (had(mediaEntryFilename(entry))) { removed.push(entry); continue; }
    if (entry.before && had(filenameFromUrl(entry.before))) beforeResets.push(entry);
    comparisons.push(entry);
  }

  const sourceHistory = {};
  for (const [tab, list] of Object.entries(state.sourceHistory || {})) {
    sourceHistory[tab] = (list || []).filter(entry => {
      if (!mediaSourceFilenames(entry).some(had)) return true;
      removed.push(entry);
      return false;
    });
  }

  const lastSources = {};
  for (const [tab, value] of Object.entries(state.lastSources || {})) {
    lastSources[tab] = had(filenameFromUrl(value) || _bareFilename(value)) ? '' : value;
  }
  const lastGeneratedGone = had(filenameFromUrl(state.lastGeneratedUrl));
  const lastSourcesChanged = Object.keys(lastSources).some(
    tab => lastSources[tab] !== (state.lastSources || {})[tab]
  );

  return {
    gone,
    generated,
    videos,
    comparisons,
    sourceHistory,
    lastSources,
    lastGeneratedGone,
    beforeResets,
    removed,
    changed: removed.length > 0 || beforeResets.length > 0
      || lastGeneratedGone || lastSourcesChanged,
  };
}

// ── /ws/events client ─────────────────────────────────────────────────────
// Persistent connection for the page lifetime (the progress socket is only
// open while a job runs, so it cannot carry these events). Reconnects with
// a capped backoff; no polling of anything else.
let _mediaEventsWs = null;
let _mediaEventsRetry = 0;
let _mediaEventsTimer = 0;

function initMediaEvents() {
  if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
  const connect = () => {
    let ws;
    try {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host + '/ws/events');
    } catch (e) {
      schedule();
      return;
    }
    _mediaEventsWs = ws;
    ws.onopen = () => { _mediaEventsRetry = 0; };
    ws.onmessage = ev => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      if (payload && Array.isArray(payload.deleted) && typeof dropMedia === 'function') {
        dropMedia(payload.deleted);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (_mediaEventsWs === ws) _mediaEventsWs = null;
      schedule();
    };
  };
  const schedule = () => {
    clearTimeout(_mediaEventsTimer);
    const delay = Math.min(30000, 1000 * Math.pow(2, _mediaEventsRetry++));
    _mediaEventsTimer = setTimeout(connect, delay);
  };
  // Last-resort reconciliation for when the push socket is down: a /media
  // image or video that fails triggers ONE existence probe (cached). Only a
  // confirmed-missing file is dropped; a transport failure keeps the entry.
  const failed = new Set();
  document.addEventListener('error', ev => {
    const el = ev.target;
    if (!el || (el.tagName !== 'IMG' && el.tagName !== 'VIDEO')) return;
    const src = el.currentSrc || el.src || '';
    if (src.indexOf('/media/') === -1) return;
    const fn = filenameFromUrl(src);
    if (!fn || failed.has(fn) || typeof _mediaExists !== 'function') return;
    failed.add(fn);
    const type = typeof fileTypeFromUrl === 'function' ? fileTypeFromUrl(src) : 'output';
    _mediaExists(fn, type, true).then(exists => {
      if (!exists && typeof dropMedia === 'function') dropMedia([fn]);
      else failed.delete(fn); // transient (e.g. ComfyUI restart) — allow a retry
    });
  }, true);
  connect();
}
