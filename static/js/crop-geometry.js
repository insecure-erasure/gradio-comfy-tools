// ── Crop geometry (pure) ───────────────────────────────────────────────────
// A crop rectangle is {x, y, width, height} in SOURCE-IMAGE pixels. Keeping
// the state in source pixels lets the rendered box use percentages, so a
// window resize / phone rotation never loses the selection. These helpers are
// deliberately DOM-free so they can be unit-tested in node (see
// tests/js/crop_geometry_test.js).

const CROP_MIN_SIZE = 16;

function _cropNumber(value, fallback = 0) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function _cropBounds(bounds) {
  return {
    width: Math.max(1, Math.floor(_cropNumber(bounds && bounds.width, 1))),
    height: Math.max(1, Math.floor(_cropNumber(bounds && bounds.height, 1))),
  };
}

function _cropClamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Clamp a rectangle to the image bounds and enforce the minimum source-pixel
// size. The result is NOT rounded: drags work with fractional pixels.
function cropClampRect(rect, bounds, minSize = CROP_MIN_SIZE) {
  const b = _cropBounds(bounds);
  const minW = Math.min(b.width, Math.max(1, _cropNumber(minSize, CROP_MIN_SIZE)));
  const minH = Math.min(b.height, Math.max(1, _cropNumber(minSize, CROP_MIN_SIZE)));
  const width = _cropClamp(_cropNumber(rect && rect.width, minW), minW, b.width);
  const height = _cropClamp(_cropNumber(rect && rect.height, minH), minH, b.height);
  return {
    x: _cropClamp(_cropNumber(rect && rect.x, 0), 0, b.width - width),
    y: _cropClamp(_cropNumber(rect && rect.y, 0), 0, b.height - height),
    width,
    height,
  };
}

// Move the rectangle without resizing it.
function cropMoveRect(rect, dx, dy, bounds, minSize = CROP_MIN_SIZE) {
  const r = cropClampRect(rect, bounds, minSize);
  return cropClampRect({
    x: r.x + _cropNumber(dx, 0),
    y: r.y + _cropNumber(dy, 0),
    width: r.width,
    height: r.height,
  }, bounds, minSize);
}

// Largest centred rectangle with the given aspect ratio (width / height)
// inside the image. ratio <= 0 returns the full image.
function cropRectForAspect(bounds, ratio) {
  const b = _cropBounds(bounds);
  const r = _cropNumber(ratio, 0);
  if (!(r > 0)) return { x: 0, y: 0, width: b.width, height: b.height };
  let width;
  let height;
  if (b.width / b.height > r) {
    height = b.height;
    width = height * r;
  } else {
    width = b.width;
    height = width / r;
  }
  return {
    x: (b.width - width) / 2,
    y: (b.height - height) / 2,
    width,
    height,
  };
}

// Resize from a CORNER handle ('nw' | 'ne' | 'se' | 'sw'), keeping the
// opposite corner fixed. `dx`/`dy` are pointer deltas in source pixels.
// When opts.aspect > 0 the result keeps that width/height ratio.
function cropResizeRect(rect, handle, dx, dy, bounds, opts = {}) {
  const b = _cropBounds(bounds);
  const minSize = opts.minSize != null ? opts.minSize : CROP_MIN_SIZE;
  const aspect = _cropNumber(opts.aspect, 0);
  const r = cropClampRect(rect, b, minSize);
  const west = String(handle).includes('w');
  const north = String(handle).includes('n');
  const anchorX = west ? r.x + r.width : r.x;
  const anchorY = north ? r.y + r.height : r.y;

  if (!(aspect > 0)) {
    const minW = Math.min(b.width, Math.max(1, _cropNumber(minSize, CROP_MIN_SIZE)));
    const minH = Math.min(b.height, Math.max(1, _cropNumber(minSize, CROP_MIN_SIZE)));
    let left = r.x;
    let top = r.y;
    let right = r.x + r.width;
    let bottom = r.y + r.height;
    if (west) left = _cropClamp(left + _cropNumber(dx, 0), 0, right - minW);
    else right = _cropClamp(right + _cropNumber(dx, 0), left + minW, b.width);
    if (north) top = _cropClamp(top + _cropNumber(dy, 0), 0, bottom - minH);
    else bottom = _cropClamp(bottom + _cropNumber(dy, 0), top + minH, b.height);
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
  }

  const movingX = (west ? r.x : r.x + r.width) + _cropNumber(dx, 0);
  const movingY = (north ? r.y : r.y + r.height) + _cropNumber(dy, 0);
  // Signed widths: dragging a handle past its opposite edge shrinks the
  // selection, then the clamp below applies the minimum size.
  const widthFromX = west ? anchorX - movingX : movingX - anchorX;
  const widthFromY = (north ? anchorY - movingY : movingY - anchorY) * aspect;
  const maxWidth = Math.min(
    west ? anchorX : b.width - anchorX,
    (north ? anchorY : b.height - anchorY) * aspect
  );
  const minWidth = Math.min(
    maxWidth,
    Math.max(1, Math.max(_cropNumber(minSize, CROP_MIN_SIZE),
                         _cropNumber(minSize, CROP_MIN_SIZE) * aspect))
  );
  // Follow whichever axis the pointer moved most (relative to the current
  // width) so diagonal drags feel natural.
  const proposed = Math.abs(widthFromX - r.width) >= Math.abs(widthFromY - r.width)
    ? widthFromX : widthFromY;
  const width = _cropClamp(proposed, minWidth, maxWidth);
  const height = width / aspect;
  return cropClampRect({
    x: west ? anchorX - width : anchorX,
    y: north ? anchorY - height : anchorY,
    width,
    height,
  }, b, minSize);
}

// Integer payload for the API, guaranteed to stay inside the image.
function cropToPayload(rect, bounds) {
  const b = _cropBounds(bounds);
  const r = cropClampRect(rect, b, 1);
  let x = _cropClamp(Math.round(r.x), 0, b.width - 1);
  let y = _cropClamp(Math.round(r.y), 0, b.height - 1);
  let width = Math.max(1, Math.round(r.width));
  let height = Math.max(1, Math.round(r.height));
  if (x + width > b.width) width = b.width - x;
  if (y + height > b.height) height = b.height - y;
  return { x, y, width, height };
}

function cropIsFullFrame(rect, bounds) {
  const b = _cropBounds(bounds);
  const p = cropToPayload(rect, b);
  return p.x === 0 && p.y === 0 && p.width === b.width && p.height === b.height;
}
