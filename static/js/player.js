// ── Video player (custom controls) ────────
// Wraps a generated <video> in a .video-player container with our OWN
// controls, replacing the native browser controls (which spanned the full
// video width and collided with the pane's overlay buttons 🔗/📁 and the
// source URL field).
//
// Design (agreed):
//   - autoplay muted + loop stays (the video starts playing on render)
//   - bottom-CENTERED control cluster (never vertically centered):
//       ▶/⏸ play-pause (always visible) + ⋮ more options (placeholder
//       for now — the dropdown menu comes later)
//   - a thin ACCENT progress line at the very BOTTOM edge of the video,
//     ALWAYS visible (feedback while it plays / loops)
//   - portrait: the buttons are a bit LARGER (touch targets), still
//     bottom-centered
//   - single click anywhere on the video toggles play/pause; double click
//     toggles browser fullscreen
//   - fullscreen overlay button (⛶) top-right, same style as the compare
//     sliders' button (.output-overlay-btn.top-right); in fullscreen it
//     becomes ✕ exit in the same spot
//
// The current result video is tracked so the app can pause it when leaving
// the Video tab (switchTab → pauseActiveVideo): a playing video hidden
// behind another tab would keep consuming CPU/decoding resources.
let activeVideoEl = null;

// Pause the current result video if it is playing. No-op when there is no
// video, it is already paused, or it was removed from the DOM (clearPane /
// source preview replaced it). The ▶/⏸ button re-syncs itself through the
// 'pause' event (syncPlayState).
function pauseActiveVideo() {
  if (!activeVideoEl || !activeVideoEl.isConnected || activeVideoEl.paused) return;
  activeVideoEl.pause();
}

function createVideoPlayer(src) {
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

  // Thin progress line at the bottom edge — always visible.
  const prog = document.createElement('div');
  prog.className = 'video-progress';
  const fill = document.createElement('div');
  fill.className = 'video-progress-fill';
  prog.appendChild(fill);
  wrap.appendChild(prog);

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
  const setGlyph = (b, glyph) => {
    b.textContent = glyph;
    // The ▶/⏸/⋮ glyphs are not optically centered in their em box (each
    // font carries its own metrics), so the bare glyph looks off-center in
    // the round button. Measure the actual ink box of the rendered glyph
    // with a hidden canvas and nudge its position so it IS centered. The
    // measure uses the button's own font/size, so it adapts to any font or
    // platform (no magic CSS numbers). Cheap: runs once per glyph swap.
    centerGlyph(b);
  };
  const centerGlyph = (b) => {
    const cs = getComputedStyle(b);
    const size = parseFloat(cs.fontSize) || 16;
    const canvas = centerGlyph._canvas || (centerGlyph._canvas = document.createElement('canvas'));
    canvas.width = Math.ceil(size * 2);
    canvas.height = Math.ceil(size * 2);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.font = `${cs.fontWeight || 400} ${size}px ${cs.fontFamily || 'sans-serif'}`;
    ctx.textBaseline = 'middle';
    const cx = canvas.width / 2;
    ctx.fillText(b.textContent, cx, canvas.height / 2);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (d[(y * canvas.width + x) * 4 + 3] > 20) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return;
    const inkCX = (minX + maxX) / 2;
    const inkCY = (minY + maxY) / 2;
    b.style.transform = `translate(${Math.round(cx - inkCX)}px, ${Math.round(canvas.height / 2 - inkCY)}px)`;
  };
  // The ▶/⏸ glyph must FOLLOW the playback state: ⏸ while playing, ▶ while
  // paused. The video autoplays muted, but autoplay can be blocked by the
  // browser — so the initial state is read from v.paused, not assumed, and
  // re-synced on every play/pause/ended (previously setGlyph was called
  // only once at creation, so the button kept the ⏸ glyph forever).
  const syncPlayState = () => {
    const paused = v.paused;
    setGlyph(playBtn, paused ? '▶' : '⏸');
    playBtn.title = paused ? 'Play' : 'Pause';
    playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  };
  v.addEventListener('play', syncPlayState);
  v.addEventListener('pause', syncPlayState);
  v.addEventListener('ended', syncPlayState); // no-loop end: paused again
  syncPlayState();

  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'video-more-btn';
  setGlyph(moreBtn, '⋮');
  moreBtn.title = 'More options';
  moreBtn.setAttribute('aria-label', 'More options');
  // Placeholder: the options menu (speed/loop/download/…) comes later.
  moreBtn.addEventListener('click', (e) => { e.stopPropagation(); showToast('More options coming soon'); });

  ctrl.appendChild(playBtn);
  ctrl.appendChild(moreBtn);
  wrap.appendChild(ctrl);

  // Fullscreen overlay button — top-right, SAME style as the compare
  // sliders' ⛶ (.output-overlay-btn.top-right). Toggles real browser
  // fullscreen of the whole player; in fullscreen it becomes the ✕ exit
  // button in the SAME spot (fullscreenchange keeps it in sync, so Esc
  // also updates it).
  const fsBtn = document.createElement('button');
  fsBtn.type = 'button';
  fsBtn.className = 'output-overlay-btn top-right video-fs-btn';
  fsBtn.textContent = '⛶';
  fsBtn.title = 'Fullscreen';
  fsBtn.setAttribute('aria-label', 'Fullscreen');
  const syncFsBtn = () => {
    const fs = document.fullscreenElement === wrap;
    fsBtn.textContent = fs ? '✕' : '⛶';
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

  // Single click anywhere on the video area toggles play/pause; a double
  // click goes fullscreen. The controls (play/more/fullscreen buttons) are
  // excluded (their own handlers + stopPropagation). The single-click is
  // deferred ~250ms so the first click of a double-click doesn't also
  // toggle play/pause.
  const isControl = (t) => !!(t && t.closest && t.closest('.video-play-btn, .video-more-btn, .video-fs-btn'));
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
    if (v.duration) fill.style.width = Math.min(100, (v.currentTime / v.duration) * 100) + '%';
    rafId = requestAnimationFrame(paintProgress);
  }
  function stopProgress() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }
  v.addEventListener('loadedmetadata', () => { fill.style.width = '0%'; });
  v.addEventListener('play', () => { if (!rafId) paintProgress(); });
  v.addEventListener('pause', stopProgress);
  v.addEventListener('ended', () => { stopProgress(); fill.style.width = '100%'; });

  // Register as the current result video (tracked by pauseActiveVideo).
  activeVideoEl = v;

  return wrap;
}
