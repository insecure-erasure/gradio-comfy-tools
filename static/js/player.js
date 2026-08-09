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

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'video-play-btn';
  playBtn.title = 'Pause';
  playBtn.setAttribute('aria-label', 'Pause');
  playBtn.textContent = '⏸'; // autoplay: it starts playing
  playBtn.addEventListener('click', () => {
    if (v.paused) { v.play().catch(() => {}); } else { v.pause(); }
  });
  v.addEventListener('play', () => {
    playBtn.textContent = '⏸';
    playBtn.title = 'Pause';
    playBtn.setAttribute('aria-label', 'Pause');
  });
  v.addEventListener('pause', () => {
    playBtn.textContent = '▶';
    playBtn.title = 'Play';
    playBtn.setAttribute('aria-label', 'Play');
  });

  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'video-more-btn';
  moreBtn.textContent = '⋮';
  moreBtn.title = 'More options';
  moreBtn.setAttribute('aria-label', 'More options');
  // Placeholder: the options menu (speed/loop/download/…) comes later.
  moreBtn.addEventListener('click', () => showToast('More options coming soon'));

  ctrl.appendChild(playBtn);
  ctrl.appendChild(moreBtn);
  wrap.appendChild(ctrl);

  // Progress fill: 0 until metadata, then tracks currentTime.
  v.addEventListener('loadedmetadata', () => { fill.style.width = '0%'; });
  v.addEventListener('timeupdate', () => {
    if (v.duration) fill.style.width = Math.min(100, (v.currentTime / v.duration) * 100) + '%';
  });

  return wrap;
}
