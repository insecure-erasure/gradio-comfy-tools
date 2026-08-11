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

// ── ⋮ Options menu: shared close helpers ──
// Each player owns its menu (a child of its wrap — see createVideoPlayer),
// so closeAllVideoMenus closes ANY player's open menu. A click outside the
// menus / ⋮ buttons and Escape close them; on Escape the event is stopped
// so the gallery's own Escape handler does not ALSO close the overlay in
// the same keystroke (menu first, gallery second).
function closeAllVideoMenus() {
  document.querySelectorAll('.video-menu.show').forEach(m => m.classList.remove('show'));
}
document.addEventListener('click', e => {
  if (e.target.closest('.video-menu') || e.target.closest('.video-more-btn')) return;
  closeAllVideoMenus();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !document.querySelector('.video-menu.show')) return;
  closeAllVideoMenus();
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
  const ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
    fullscreenExit: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
  };
  const setIcon = (b, name) => { b.innerHTML = ICONS[name] || ''; };
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
  // submenu gets its own group (a wrapper div with the radios inside).
  const speedRadios = document.createElement('div');
  VIDEO_SPEEDS.forEach((s, i) => {
    const lab = document.createElement('label');
    lab.className = 'video-menu-speed-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'video-speed-' + Math.random().toString(36).slice(2, 8); // per-player group
    radio.value = String(s);
    radio.checked = s === v.playbackRate;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      v.playbackRate = s;
      speedValue.textContent = formatSpeed(s) + '×';
    });
    lab.appendChild(radio);
    lab.appendChild(document.createTextNode(formatSpeed(s) + '×'));
    speedRadios.appendChild(lab);
  });
  speedSub.appendChild(speedRadios);
  // Row + submenu share a wrapper: the desktop hover "zone" covers BOTH
  // (the submenu opens to the RIGHT of the menu, so moving from the row to
  // the submenu never closes it); leaving the zone closes it, like native
  // submenus. Touch: a click on the row toggles it (there is no hover).
  const speedWrap = document.createElement('div');
  speedWrap.className = 'video-menu-speed-wrap';
  speedWrap.appendChild(speedRow);
  speedWrap.appendChild(speedSub);
  let subOpen = false;
  const openSub = () => {
    if (subOpen) return;
    subOpen = true;
    speedSub.classList.add('show');
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
        speedSub.style.right = 'calc(100% + 10px)';
        speedSub.style.marginRight = '8px';
      }
    });
  };
  const closeSub = () => {
    if (!subOpen) return;
    subOpen = false;
    speedSub.classList.remove('show');
    speedSub.style.top = '';
    speedSub.style.left = '';
    speedSub.style.right = '';
    speedSub.style.marginRight = ''; // next open re-measures from the clean state
  };
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    speedWrap.addEventListener('mouseenter', openSub);
    speedWrap.addEventListener('mouseleave', closeSub);
  } else {
    speedRow.addEventListener('click', e => {
      e.stopPropagation();
      if (subOpen) closeSub(); else openSub();
    });
  }
  menu.appendChild(menuTitle);
  menu.appendChild(loopLabel);
  menu.appendChild(speedWrap);
  wrap.appendChild(menu);
  const toggleVideoMenu = () => {
    const open = menu.classList.contains('show');
    closeAllVideoMenus(); // any other player's open menu closes first
    if (!open) {
      // Reflect the CURRENT video state (a fresh player has the defaults).
      loopInput.checked = v.loop;
      const radios = speedRadios.querySelectorAll('input[type=radio]');
      radios.forEach(r => { r.checked = Math.abs(parseFloat(r.value) - v.playbackRate) < 1e-9; });
      speedValue.textContent = formatSpeed(v.playbackRate) + '×';
      menu.classList.add('show');
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
  if (!noFullscreenBtn) {
    const fsBtn = document.createElement('button');
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

  return wrap;
}
