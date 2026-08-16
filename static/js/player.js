// ── Video player (custom controls) ────────
// Wraps a generated <video> in a .video-player container with our OWN
// controls, replacing the native browser controls (which spanned the full
// video width and collided with the pane's overlay buttons 🔗/📁 and the
// source URL field).
//
// Design (agreed):
//   - autoplay muted + loop stays (the video starts playing on render)
//   - bottom-CENTERED control cluster (never vertically centered):
//       play/pause (always visible) + stop (resets to the start) + more
//       options (placeholder for now — the dropdown menu comes later);
//       ALL buttons are identical circles with inline SVG icons (no
//       emoji/font glyphs — those render differently per platform)
//   - a thin ACCENT progress line at the very BOTTOM edge of the video,
//     ALWAYS visible (feedback while it plays / loops) — also a
//     SCRUBBER: hover doubles the line height and reveals a circular
//     accent thumb + shaded tooltip (position in tenths of a second);
//     drag (or tap) seeks the video, playing or paused; on mobile the
//     thumb appears where you touch and drags with your finger
//   - portrait: the buttons are a bit LARGER (touch targets), still
//     bottom-centered
//   - single click anywhere on the video toggles play/pause; double click
//     toggles browser fullscreen
//   - fullscreen overlay button (SVG icon) top-right, same style as the
//     compare sliders' button (.output-overlay-btn.top-right); in
//     fullscreen it becomes the exit icon in the same spot
//
// The current result video is tracked so the app can pause it when leaving
// the Video tab (switchTab → pauseActiveVideo): a playing video hidden
// behind another tab would keep consuming CPU/decoding resources.
let activeVideoEl = null;

// Playback speeds offered by the ⋮ menu, LARGEST first (the menu renders
// top-to-bottom). The STANDARD player set (YouTube-style), significant
// decimals via String(v).
const VIDEO_SPEEDS = [2, 1.75, 1.5, 1.25, 1, 0.75, 0.5, 0.25];
const formatSpeed = v => String(v);

// Icons shared by the real player and the empty (no-videos-yet) player —
// inline SVG (never emoji/font glyphs), fill=currentColor inherits the
// button's CSS color; sized via CSS, so all buttons stay pixel-identical.
const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  fullscreenExit: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
};
const setIcon = (b, name) => { b.innerHTML = ICONS[name] || ''; };

// Toast shown when the empty player's (disabled) controls are clicked:
// there is no video to play/seek yet. Only the BUTTONS/bar toast — the
// black backdrop shows nothing.
const NO_VIDEOS_MSG = 'No videos yet';

// ── Empty player (no videos generated yet) ──
// The Video pane shows the REAL player controls even when no video has been
// generated (replaces the old static .video-mock placeholder): same
// structure (progress bar + bottom-centered play/stop/more), but every
// control is DISABLED (aria-disabled + .disabled styling, NOT the native
// `disabled` attribute — a native disabled button swallows click events,
// and we need the click to toast "no videos yet"). No <video>, no
// scrubber, no autoplay/idle/fullscreen logic, no activeVideoEl. The
// controls sit at the SAME BOTTOM position as the real player's (shared
// .video-controls). Only the controls/bar toast — the backdrop is blank.
function createEmptyVideoPlayer() {
  const wrap = document.createElement('div');
  wrap.className = 'video-player video-empty-player';

  const bg = document.createElement('div');
  bg.className = 'video-empty-bg';
  wrap.appendChild(bg);

  const prog = document.createElement('div');
  prog.className = 'video-progress';
  const track = document.createElement('div');
  track.className = 'video-progress-track';
  const fill = document.createElement('div');
  fill.className = 'video-progress-fill';
  track.appendChild(fill);
  prog.appendChild(track);
  wrap.appendChild(prog);

  const ctrl = document.createElement('div');
  ctrl.className = 'video-controls';
  const mkBtn = (cls, icon, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    setIcon(b, icon);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.setAttribute('aria-disabled', 'true');
    b.classList.add('disabled');
    b.addEventListener('click', (e) => { e.stopPropagation(); showToast(NO_VIDEOS_MSG); });
    return b;
  };
  ctrl.appendChild(mkBtn('video-play-btn', 'play', 'Play'));
  ctrl.appendChild(mkBtn('video-stop-btn', 'stop', 'Stop'));
  ctrl.appendChild(mkBtn('video-more-btn', 'more', 'More options'));
  wrap.appendChild(ctrl);

  prog.addEventListener('click', (e) => { e.stopPropagation(); showToast(NO_VIDEOS_MSG); });

  return wrap;
}

// Show the empty player in the Video pane IF the pane shows nothing real
// (no generated video / source preview / live preview) and the empty player
// is not already there. Called on init, clearPane, clearSourcePreview and
// gallery clear — the empty state must always come back when the pane is
// emptied, but never cover an actual result.
function ensureEmptyVideoPlayer(pane) {
  if (!pane || pane.id !== 'videoOutputPane') return;
  if (pane.querySelector('.result-video, .source-preview, .preview-live, .video-player:not(.video-empty-player)')) return;
  if (pane.querySelector('.video-empty-player')) return;
  pane.appendChild(createEmptyVideoPlayer());
}

// ── ⋮ Options menu: shared close helpers ──
// Each player owns its menu (a child of its wrap — see createVideoPlayer),
// so closeAllVideoMenus closes ANY player's open menu. A click outside the
// menus / ⋮ buttons and Escape close them; on Escape the event is stopped
// so the gallery's own Escape handler does not ALSO close the overlay in
// the same keystroke (menu first, gallery second).
//
// PROGRESSIVE dismiss (native menus): clicking/escaping OUTSIDE the menus
// closes the TOP open level — an open speed submenu first (the main menu
// stays), then the whole menu on the next dismiss. The register holds each
// open menu's handlers; it is pruned of detached players on every call.
const _openVideoMenus = new Set();

function _liveMenuHandlers() {
  const live = [];
  _openVideoMenus.forEach(h => { if (h.isConnected()) live.push(h); else _openVideoMenus.delete(h); });
  return live;
}

function closeTopVideoMenu() {
  const live = _liveMenuHandlers();
  if (!live.length) return;
  if (live.some(h => h.isSubOpen())) {
    // An open submenu is the top level: close ONLY the submenus — the main
    // menus stay (the next outside dismiss closes them).
    live.forEach(h => h.isSubOpen() && h.closeSub());
  } else {
    live.forEach(h => h.closeMenu());
  }
}

function closeAllVideoMenus() {
  _liveMenuHandlers().forEach(h => h.closeMenu());
}
document.addEventListener('click', e => {
  if (e.target.closest('.video-menu') || e.target.closest('.video-more-btn')) return;
  closeTopVideoMenu();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !document.querySelector('.video-menu.show')) return;
  closeTopVideoMenu();
  e.stopImmediatePropagation(); // menu only — the gallery/modal Esc handlers skip this keystroke
});

// Pause the current result video if it is playing. No-op when there is no
// video, it is already paused, or it was removed from the DOM (clearPane /
// source preview replaced it). The ▶/⏸ button re-syncs itself through the
// 'pause' event (syncPlayState).
function pauseActiveVideo() {
  if (!activeVideoEl || !activeVideoEl.isConnected || activeVideoEl.paused) return;
  activeVideoEl.pause();
}

// noFullscreenBtn: when true, the player does NOT create its own ⛶
// fullscreen button — used in the Video pane (the pane's top-right ⛶
// opens the VIDEO GALLERY, so having both stacked in the same corner made
// the click fullscreen the <video> instead) AND in the gallery overlay's
// video mode (the overlay is already fullscreen and the gallery's own ✕
// sits in the same top-right corner).
function createVideoPlayer(src, noFullscreenBtn) {
  closeAllVideoMenus(); // a new player — never leave an open menu bound to a destroyed one
  const wrap = document.createElement('div');
  wrap.className = 'video-player';

  const v = document.createElement('video');
  v.className = 'result-video';
  v.src = src;
  v.autoplay = true;
  v.loop = true;
  v.muted = true;
  v.playsinline = true;   // iOS: keep it in the pane, no fullscreen takeover
  wrap.appendChild(v);

  // Interactive progress bar (scrubber): the thin accent line at the very
  // bottom edge stays always visible. The bar is a 12px-tall hit area (full
  // width) so it can be hovered/dragged/tapped to seek, playing or paused.
  // 12px keeps it FLUSH with the pane's bottom overlay buttons (📁/🔗 and
  // the URL field sit at bottom:12px) so they stay fully clickable above it.
  const prog = document.createElement('div');
  prog.className = 'video-progress';
  prog.setAttribute('role', 'slider');
  prog.setAttribute('aria-label', 'Seek');
  prog.setAttribute('aria-valuemin', '0');
  prog.setAttribute('aria-valuemax', '100');
  prog.setAttribute('aria-valuenow', '0');

  const track = document.createElement('div');
  track.className = 'video-progress-track';
  const fill = document.createElement('div');
  fill.className = 'video-progress-fill';
  track.appendChild(fill);
  prog.appendChild(track);

  const thumb = document.createElement('div');
  thumb.className = 'video-progress-thumb';
  prog.appendChild(thumb);
  const tip = document.createElement('div');
  tip.className = 'video-progress-tip';
  prog.appendChild(tip);
  wrap.appendChild(prog);

  // ── Scrubber behavior ──
  // Seconds with tenths and the unit — the generated videos are always a
  // few seconds long, so minutes would just add noise (m:ss.d → 0:03.4s
  // reads worse than 3.4s). Precision stays at 0.1s (the requirement).
  const formatTime = (sec) => {
    if (!isFinite(sec) || sec < 0) sec = 0;
    return (Math.floor(sec * 10) / 10).toFixed(1) + 's';
  };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const setFill = (ratio) => {
    ratio = clamp(ratio, 0, 1);
    fill.style.width = ratio * 100 + '%';
    prog.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  };
  const ratioFromEvent = (e) => {
    const rect = prog.getBoundingClientRect();
    return rect.width ? clamp((e.clientX - rect.left) / rect.width, 0, 1) : 0;
  };
  const updateThumb = (ratio) => {
    // Keep the thumb inside the rounded corners; the tip is wider, so it is
    // clamped tighter so the text never gets clipped at the edges.
    thumb.style.left = (clamp(ratio, 0.015, 0.985) * 100) + '%';
    tip.style.left = (clamp(ratio, 0.06, 0.94) * 100) + '%';
    tip.textContent = formatTime(ratio * (v.duration || 0));
  };
  const showScrub = () => { thumb.classList.add('show'); tip.classList.add('show'); };
  const hideScrub = () => { if (!scrubbing) { thumb.classList.remove('show'); tip.classList.remove('show'); } };

  let scrubbing = false;
  let hovering = false;
  let previewRatio = 0;

  prog.addEventListener('pointerenter', () => { hovering = true; if (!scrubbing) showScrub(); });
  prog.addEventListener('pointerleave', () => { hovering = false; hideScrub(); });
  prog.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // primary button / touch only
    scrubbing = true;
    prog.classList.add('scrubbing');
    try { prog.setPointerCapture(e.pointerId); } catch (_) {} // keep the drag even off the bar
    stopProgress(); // freeze the rAF fill so the drag preview is not overwritten
    previewRatio = ratioFromEvent(e);
    setFill(previewRatio);
    updateThumb(previewRatio);
    showScrub();
    e.preventDefault();
  });
  prog.addEventListener('pointermove', (e) => {
    const r = ratioFromEvent(e);
    if (scrubbing) { previewRatio = r; setFill(r); } // the fill previews the drag
    updateThumb(r);
  });
  prog.addEventListener('pointerup', () => {
    if (!scrubbing) return;
    scrubbing = false;
    prog.classList.remove('scrubbing');
    if (v.duration) v.currentTime = previewRatio * v.duration; // commit the seek
    paintOnce();
    if (!v.paused) paintProgress(); // resume the rAF loop while playing
    // Keep the thumb/tooltip if the pointer still hovers the bar (desktop
    // drag released over it); on touch there is no hover, so they hide.
    if (!hovering) hideScrub();
  });
  prog.addEventListener('pointercancel', () => {
    scrubbing = false;
    prog.classList.remove('scrubbing');
    paintOnce();
    if (!v.paused) paintProgress();
    hideScrub();
  });

  // Bottom-center control cluster.
  const ctrl = document.createElement('div');
  ctrl.className = 'video-controls';

  const togglePlay = () => {
    if (v.paused) { v.play().catch(() => {}); } else { v.pause(); }
  };

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'video-play-btn';
  playBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
  // Icons are inline SVG (never emoji/font glyphs — those render
  // differently per platform/font). fill=currentColor inherits the
  // button's CSS color; the svg is sized via CSS (width/height), so all
  // buttons stay pixel-identical and the icons center perfectly.
  // The play/pause icon must FOLLOW the playback state: pause while playing,
  // play while paused. The video autoplays muted, but autoplay can be
  // blocked by the browser — so the initial state is read from v.paused,
  // not assumed, and re-synced on every play/pause/ended.
  const syncPlayState = () => {
    const paused = v.paused;
    setIcon(playBtn, paused ? 'play' : 'pause');
    playBtn.title = paused ? 'Play' : 'Pause';
    playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  };
  v.addEventListener('play', syncPlayState);
  v.addEventListener('pause', syncPlayState);
  v.addEventListener('ended', syncPlayState); // no-loop end: paused again
  syncPlayState();

  // Stop: pause and reset the video to the beginning. The 'pause' event
  // re-syncs the play/pause icon to 'play' and stops the rAF progress loop;
  // the 'seeked' listener repaints the fill, so after a stop the bar is
  // back at zero (setFill(0) makes it immediate instead of waiting for
  // seeked).
  const stopVideo = () => {
    v.pause();
    v.currentTime = 0;
    setFill(0);
  };
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'video-stop-btn';
  setIcon(stopBtn, 'stop');
  stopBtn.title = 'Stop';
  stopBtn.setAttribute('aria-label', 'Stop');
  stopBtn.addEventListener('click', (e) => { e.stopPropagation(); stopVideo(); });

  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'video-more-btn';
  setIcon(moreBtn, 'more');
  moreBtn.title = 'More options';
  moreBtn.setAttribute('aria-label', 'More options');
  // ⋮ opens the per-player options menu (loop + playback speed). The menu
  // is a CHILD of the wrap so it stays visible inside the fullscreen video
  // gallery (a menu on document.body would be hidden outside the
  // fullscreened overlay). Session-only per player (design decision): every
  // NEW player starts with loop ON and 1× — navigating the gallery rebuilds
  // the player, resetting the options.
  // Drill-down mode (PORTRAIT / narrow screens): there is no room beside
  // the menu for a side submenu, so the Speed click REPLACES the main menu
  // with the speed submenu (same position/size, with a ← back button);
  // choosing a speed returns to the main menu. Landscape keeps the
  // native-style side submenu.
  const drillDown = window.matchMedia('(max-width: 1023px)').matches;
  const menu = document.createElement('div');
  menu.className = 'video-menu';
  const menuTitle = document.createElement('div');
  menuTitle.className = 'video-menu-title';
  menuTitle.textContent = 'Video';
  const loopLabel = document.createElement('label');
  loopLabel.className = 'check-label video-menu-loop';
  const loopInput = document.createElement('input');
  loopInput.type = 'checkbox';
  loopInput.checked = v.loop; // true by default (loop ON)
  loopInput.addEventListener('change', () => { v.loop = loopInput.checked; });
  loopLabel.appendChild(loopInput);
  loopLabel.appendChild(document.createTextNode('Loop'));
  // Speed entry: a menu row with the current speed as its value, like the
  // native browser video menu. On desktop HOVERING it opens the submenu of
  // native radio buttons; on touch a CLICK toggles it (no hover). The
  // submenu lists the speeds with NATIVE <input type=radio> — no glyph
  // hacks.
  const speedRow = document.createElement('div');
  speedRow.className = 'video-menu-speed-row';
  speedRow.setAttribute('role', 'menuitem');
  speedRow.setAttribute('aria-haspopup', 'true');
  const speedLabel = document.createElement('span');
  speedLabel.className = 'video-menu-speed-label';
  speedLabel.textContent = 'Speed';
  const speedValue = document.createElement('span');
  speedValue.className = 'video-menu-speed-value';
  speedValue.textContent = formatSpeed(v.playbackRate) + '×';
  const speedCaret = document.createElement('span');
  speedCaret.className = 'video-menu-caret';
  speedCaret.textContent = '›'; // disclosure caret, like native menus
  speedRow.appendChild(speedLabel);
  speedRow.appendChild(speedValue);
  speedRow.appendChild(speedCaret);
  const speedSub = document.createElement('div');
  speedSub.className = 'video-menu-speed-sub';
  speedSub.setAttribute('role', 'menu');
  speedSub.setAttribute('aria-label', 'Playback speed');
  // One radio group shared by all players would couple them; each player's
  // submenu gets its own group. The name is generated ONCE (outside the
  // loop) so ALL radios of THIS player share it — the browser then
  // enforces the radio contract: checking one unchecks the previous,
  // only the last selected stays checked.
  const speedGroupName = 'video-speed-' + Math.random().toString(36).slice(2, 8);
  const speedRadios = document.createElement('div');
  VIDEO_SPEEDS.forEach((s, i) => {
    const lab = document.createElement('label');
    lab.className = 'video-menu-speed-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = speedGroupName; // the SAME group for every speed of this player
    radio.value = String(s);
    radio.checked = s === v.playbackRate;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      v.playbackRate = s;
      speedValue.textContent = formatSpeed(s) + '×';
      if (drillDown) closeSub(); // choosing a speed returns to the main menu
    });
    lab.appendChild(radio);
    lab.appendChild(document.createTextNode(formatSpeed(s) + '×'));
    speedRadios.appendChild(lab);
  });
  speedSub.appendChild(speedRadios);
  // ← Back header (drill-down only — hidden in the side-submenu mode):
  // returns to the main menu without choosing.
  const speedBack = document.createElement('button');
  speedBack.type = 'button';
  speedBack.className = 'video-menu-back';
  speedBack.textContent = '← Speed';
  speedBack.addEventListener('click', e => { e.stopPropagation(); closeSub(); });
  speedSub.insertBefore(speedBack, speedRadios);
  // Row + submenu share a wrapper: the desktop hover "zone" covers BOTH
  // (the submenu opens to the RIGHT of the menu, so moving from the row to
  // the submenu never closes it); leaving the zone closes it, like native
  // submenus. Touch: a click on the row toggles it (there is no hover).
  const speedWrap = document.createElement('div');
  speedWrap.className = 'video-menu-speed-wrap';
  speedWrap.appendChild(speedRow);
  speedWrap.appendChild(speedSub);
  let subOpen = false;
  let closeTimer = null;
  let menuCloseTimer = null;
  const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } };
  const cancelMenuClose = () => { if (menuCloseTimer) { clearTimeout(menuCloseTimer); menuCloseTimer = null; } };
  const openSub = () => {
    cancelClose();
    if (subOpen) return;
    subOpen = true;
    speedSub.classList.add('show');
    if (drillDown) {
      // The submenu fills the main menu (CSS .video-menu.drill hides the
      // title/row/loop and insets the submenu over the menu) — no side
      // positioning to measure.
      menu.classList.add('drill');
      return;
    }
    // Position the submenu to the RIGHT, aligned so the "1×" entry sits at
    // the SAME HEIGHT as the Speed row (native submenus align their current
    // entry; here 1× is the fixed reference even when another speed is
    // selected). requestAnimationFrame so the rects are measurable after
    // the submenu is rendered (top:0 / left:100% initial state).
    requestAnimationFrame(() => {
      const refRadio = speedRadios.querySelector('input[value="1"]');
      const refOpt = refRadio && refRadio.closest('.video-menu-speed-option');
      if (!refOpt) return;
      const wRect = speedWrap.getBoundingClientRect();
      const rRect = speedRow.getBoundingClientRect();
      const sRect = speedSub.getBoundingClientRect();
      const oRect = refOpt.getBoundingClientRect();
      // top (relative to the wrap) that puts the CENTER of the 1× option at
      // the CENTER of the Speed row.
      speedSub.style.top =
        (rRect.top - wRect.top) + (rRect.height - oRect.height) / 2 - (oRect.top - sRect.top) + 'px';
      // If it would overflow the right edge of the window, open to the LEFT.
      if (wRect.right + speedSub.offsetWidth + 8 > window.innerWidth - 8) {
        speedSub.style.left = 'auto';
        speedSub.style.right = 'calc(100% + 12px)';
      }
    });
  };
  const closeSub = () => {
    cancelClose();
    if (!subOpen) return;
    subOpen = false;
    speedSub.classList.remove('show');
    menu.classList.remove('drill'); // back to the main menu (drill-down mode)
    speedSub.style.top = '';
    speedSub.style.left = '';
    speedSub.style.right = ''; // next open re-measures from the clean state
  };
  // Close the WHOLE menu (submenu + main) — used by the hover-close when
  // the pointer leaves the entire set (desktop) and by the progressive
  // outside-dismiss (top level with no open submenu).
  const closeMenu = () => {
    cancelMenuClose(); // stop any pending menu-close timer (idempotent)
    closeSub();
    menu.classList.remove('show');
    _openVideoMenus.delete(menuHandlers);
  };
  // Registered in _openVideoMenus while this menu is open — progressive
  // dismiss needs to know whether the submenu is the open top level.
  const menuHandlers = { isConnected: () => menu.isConnected, isSubOpen: () => subOpen, closeSub, closeMenu };
  // Hover open/close only on DESKTOP LANDSCAPE: in drill-down mode (no
  // side room) a click toggles the drill page — hover would close it
  // mid-reading. In landscape touch (tablet) the click toggles the side
  // submenu.
  const useHover = !drillDown && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (useHover) {
    // Row + submenu form ONE hover zone (they TOUCH — the submenu's left
    // edge sits on the menu's right edge, no gap). Leaving either starts a
    // short grace timer (the same pattern as the gallery prompt panel) so
    // crossing the 1px seam between them never closes the submenu;
    // entering either cancels it.
    speedWrap.addEventListener('mouseenter', () => { cancelClose(); openSub(); });
    speedSub.addEventListener('mouseenter', () => { cancelClose(); openSub(); });
    speedWrap.addEventListener('mouseleave', () => { closeTimer = setTimeout(closeSub, 150); });
    speedSub.addEventListener('mouseleave', () => { closeTimer = setTimeout(closeSub, 150); });
    // Leaving the WHOLE set (main menu + side submenu) closes BOTH. The
    // submenu is a DOM descendant of the menu, so crossing from the menu
    // to the submenu never fires this — it only fires when the pointer
    // leaves everything. Uses its OWN timer so the 150ms submenu grace
    // does not interfere; closeMenu cancels it, so the close is immediate
    // once the grace expires.
    menu.addEventListener('mouseenter', () => { cancelClose(); cancelMenuClose(); });
    menu.addEventListener('mouseleave', () => { menuCloseTimer = setTimeout(closeMenu, 150); });
  } else {
    speedRow.addEventListener('click', e => {
      e.stopPropagation();
      if (subOpen) closeSub(); else openSub();
    });
  }
  menu.appendChild(menuTitle);
  menu.appendChild(speedWrap);   // Speed first, then Loop (per request)
  menu.appendChild(loopLabel);
  wrap.appendChild(menu);
  const toggleVideoMenu = () => {
    const open = menu.classList.contains('show');
    closeAllVideoMenus(); // any other player's open menu closes first
    if (!open) {
      // Reset any drill/side state left by a previous open, then reflect
      // the CURRENT video state (a fresh player has the defaults).
      closeSub();
      loopInput.checked = v.loop;
      const radios = speedRadios.querySelectorAll('input[type=radio]');
      radios.forEach(r => { r.checked = Math.abs(parseFloat(r.value) - v.playbackRate) < 1e-9; });
      speedValue.textContent = formatSpeed(v.playbackRate) + '×';
      menu.classList.add('show');
      _openVideoMenus.add(menuHandlers);
    }
  };
  moreBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleVideoMenu(); });

  ctrl.appendChild(playBtn);
  ctrl.appendChild(stopBtn);
  ctrl.appendChild(moreBtn);
  wrap.appendChild(ctrl);

  // Fullscreen overlay button — top-right, SAME style as the compare
  // sliders' button (.output-overlay-btn.top-right). Toggles real browser
  // fullscreen of the whole player; in fullscreen it becomes the exit icon
  // in the SAME spot (fullscreenchange keeps it in sync, so Esc also
  // updates it).
  //
  // SKIPPED when noFullscreenBtn is true (the Video pane): the pane's own
  // top-right ⛶ opens the VIDEO GALLERY — having the player's button in the
  // same spot (top:12px/right:12px, same .output-overlay-btn class) stacked
  // it OVER the gallery button, so the click did fullscreen of the <video>
  // instead of opening the gallery. The gallery overlay has no competing
  // button, so it keeps the player's ⛶.
  let fsBtn = null;
  if (!noFullscreenBtn) {
    fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'output-overlay-btn top-right video-fs-btn';
    setIcon(fsBtn, 'fullscreen');
    fsBtn.title = 'Fullscreen';
    fsBtn.setAttribute('aria-label', 'Fullscreen');
    const syncFsBtn = () => {
      const fs = document.fullscreenElement === wrap;
      setIcon(fsBtn, fs ? 'fullscreenExit' : 'fullscreen');
      fsBtn.title = fs ? 'Exit fullscreen' : 'Fullscreen';
      fsBtn.setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Fullscreen');
    };
    document.addEventListener('fullscreenchange', syncFsBtn);
    document.addEventListener('webkitfullscreenchange', syncFsBtn); // Safari
    const toggleFullscreen = () => {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else if (wrap.requestFullscreen) {
        wrap.requestFullscreen().catch(() => {});
      } else if (wrap.webkitRequestFullscreen) {
        wrap.webkitRequestFullscreen();
      }
    };
    fsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
    wrap.appendChild(fsBtn);
  }

  // Single click anywhere on the video area toggles play/pause; a double
  // click goes fullscreen. The controls (play/more/fullscreen buttons) are
  // excluded (their own handlers + stopPropagation). The single-click is
  // deferred ~250ms so the first click of a double-click doesn't also
  // toggle play/pause.
  const isControl = (t) => !!(t && t.closest && t.closest('.video-play-btn, .video-stop-btn, .video-more-btn, .video-fs-btn, .video-progress, .video-menu'));
  let clickTimer = null;
  wrap.addEventListener('click', (e) => {
    if (isControl(e.target)) return;
    // A menu (any player's) is open: this click is OUTSIDE it — dismiss
    // the TOP open level ONLY (an open submenu first; the main menu next),
    // WITHOUT toggling play/pause, and stop the event so the global
    // outside-click handler does not double-dismiss in the same click.
    if (_openVideoMenus.size) {
      e.stopPropagation();
      closeTopVideoMenu();
      return;
    }
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; } // second click of a dblclick — dblclick handler owns it
    clickTimer = setTimeout(() => { clickTimer = null; togglePlay(); }, 250);
  });
  wrap.addEventListener('dblclick', (e) => {
    if (isControl(e.target)) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    toggleFullscreen();
  });

  // Progress fill — animated with requestAnimationFrame WHILE PLAYING: the
  // timeupdate event only fires ~4×/s (250ms steps), which reads as jerky
  // "tirones". rAF re-renders the fill every frame (~60fps) for a smooth
  // bar; the loop is stopped on pause so a paused video doesn't burn CPU.
  let rafId = null;
  function paintProgress() {
    if (v.duration) setFill(v.currentTime / v.duration);
    rafId = requestAnimationFrame(paintProgress);
  }
  function paintOnce() {
    if (v.duration) setFill(v.currentTime / v.duration);
  }
  function stopProgress() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }
  v.addEventListener('loadedmetadata', () => setFill(0));
  v.addEventListener('play', () => { if (!rafId) paintProgress(); });
  v.addEventListener('pause', stopProgress);
  // After a programmatic seek the rAF loop may be stopped (paused video) —
  // repaint once so the fill matches the new position immediately.
  v.addEventListener('seeked', () => { if (!rafId) paintOnce(); });
  v.addEventListener('ended', () => { stopProgress(); setFill(1); });

  // Register as the current result video (tracked by pauseActiveVideo).
  activeVideoEl = v;

  // ── Auto-hide the controls while playing ──
  // While the video PLAYS and the pointer stays still / the user does not
  // scroll for 1s, the controls fade out (see .video-player.idle in CSS —
  // the progress bar is NOT part of the fade, it stays visible). Any
  // pointer movement / scroll / tap on the video wakes them. Works the
  // same in browser fullscreen and normal view (both run through the same
  // wrap + listeners). The 1s delay is measured from the last activity,
  // so a continuous move never lets them hide.
  let idleTimer = null;
  let idleHidden = false;

  // Re-show the controls on hover over them (e.g. the cursor sits over the
  // play button after they reappeared). Bound ONCE (not per toggle) so a
  // playing video that cycles hide/show does not stack listeners.
  const wakeOnHover = (el) => el.addEventListener('mouseenter', () => cancelIdle());

  const setControlsVisible = (visible, force = false) => {
    if (visible === !idleHidden && !force) return;
    idleHidden = !visible;
    wrap.classList.toggle('idle', !visible);
  };

  const hideControls = () => { if (v.paused) return; setControlsVisible(false); };

  const cancelIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    setControlsVisible(true);
  };

  const scheduleIdle = () => {
    setControlsVisible(true); // activity → controls visible immediately
    if (v.paused) return;     // never auto-hide while paused
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(hideControls, 1000);
  };

  // Hovering the controls keeps them visible (they are excluded from the
  // wrap's pointermove wake — see isControlEl below — so without this the
  // cursor parked on the play button would let them fade).
  wakeOnHover(ctrl);
  wakeOnHover(moreBtn);
  if (fsBtn) wakeOnHover(fsBtn);

  // Activity that wakes the controls: pointer move (desktop) / pointer
  // down (touch/click) / scroll — in BOTH normal view and fullscreen (the
  // wrap gets the events in both). The pane behind is ignored. The
  // progress bar (always visible, interactive) does NOT wake them: hovering
  // it to seek should not bring the buttons back.
  const isControlEl = (t) => !!(t && t.closest && t.closest('.video-play-btn, .video-stop-btn, .video-more-btn, .video-fs-btn, .video-progress, .video-menu'));
  wrap.addEventListener('pointermove', (e) => { if (!isControlEl(e.target)) scheduleIdle(); });
  wrap.addEventListener('pointerdown', (e) => { if (!isControlEl(e.target)) scheduleIdle(); });
  wrap.addEventListener('wheel', (e) => { if (!isControlEl(e.target)) scheduleIdle(); });
  window.addEventListener('scroll', scheduleIdle, true); // capture: catches inner scrollers

  // State sync: start the idle clock when playback starts (not paused), and
  // immediately show the controls when paused (a paused video must not hide
  // them — the user is about to interact).
  v.addEventListener('play', () => { cancelIdle(); scheduleIdle(); });
  v.addEventListener('pause', () => { cancelIdle(); setControlsVisible(true, true); });

  // Entering browser fullscreen must NOT leave the controls hidden.
  document.addEventListener('fullscreenchange', () => { cancelIdle(); setControlsVisible(true, true); });

  return wrap;
}
