// Verify the lightbox zoom: mouse wheel (desktop) + pinch (touch) on #galleryBig.
const puppeteer = require('puppeteer');

const APP = 'http://localhost:8000';
const PUPPETEER_CACHE = '/srv/pi/.cache/puppeteer';
const CHROME = PUPPETEER_CACHE + '/chrome/linux-151.0.7922.77/chrome-linux64/chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));

  await page.goto(APP, { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(2500);
  await page.evaluate(() => openGenerateLightbox());
  await sleep(400);

  const transform = () => page.evaluate(() => document.getElementById('galleryBig').style.transform || '(none)');
  const zoomState = () => page.evaluate(() => ({ s: zoomScale, tx: zoomTx, ty: zoomTy }));

  // ── Mouse wheel: zoom in 2 notches at cursor (400,300) ──
  await page.evaluate(() => {
    const img = document.getElementById('galleryBig');
    img.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
    img.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
  });
  await sleep(100);
  const wheelIn = await zoomState();
  console.log('wheel in      :', await transform(), JSON.stringify(wheelIn));
  if (!(wheelIn.s > 1)) { console.log('❌ wheel zoom-in failed'); await browser.close(); process.exit(1); }

  // Anchor check: the content point under the cursor must not move.
  const anchor = await page.evaluate(() => {
    const img = document.getElementById('galleryBig');
    const rect = img.getBoundingClientRect();
    const C = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const cursor = { x: 400 - C.x, y: 300 - C.y };
    // content point under cursor BEFORE (scale 1, t 0) ...
    // AFTER: P = C + (cursor - T1)/s1  must equal C + cursor (before)
    const before = cursor;
    const after = { x: (cursor.x - zoomTx) / zoomScale, y: (cursor.y - zoomTy) / zoomScale };
    return { drift: Math.hypot(after.x - before.x, after.y - before.y), s: zoomScale, tx: zoomTx, ty: zoomTy };
  });
  console.log('anchor drift  :', anchor.drift.toFixed(2), 'px', '(must be ~0)');

  // ── Wheel out back towards 1x ──
  await page.evaluate(() => {
    const img = document.getElementById('galleryBig');
    for (let i = 0; i < 6; i++) img.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
  });
  await sleep(100);
  console.log('wheel out     :', await transform(), JSON.stringify(await zoomState()));

  // ── Pinch still works (touch) ──
  await page.evaluate(() => {
    const img = document.getElementById('galleryBig');
    const fire = (type, id, x, y) => img.dispatchEvent(new PointerEvent(type, {
      pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: id === 1,
    }));
    fire('pointerdown', 1, 300, 300);
    fire('pointerdown', 2, 500, 300);
    fire('pointermove', 1, 200, 300);
    fire('pointermove', 2, 600, 300);
    fire('pointerup', 1, 200, 300);
    fire('pointerup', 2, 600, 300);
  });
  await sleep(100);
  const pinch = await zoomState();
  console.log('pinch out     :', await transform(), JSON.stringify(pinch));

  // ── Mouse drag pan while zoomed ──
  await page.evaluate(() => {
    const img = document.getElementById('galleryBig');
    const fire = (type, id, x, y) => img.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, clientX: x, clientY: y, bubbles: true, pointerType: 'mouse', isPrimary: true, button: 0,
    }));
    fire('pointerdown', 7, 500, 400);
    fire('pointermove', 7, 540, 430);
    fire('pointerup', 7, 540, 430);
  });
  await sleep(100);
  const pan = await zoomState();
  console.log('mouse pan     :', await transform(), JSON.stringify(pan));

  // ── Nav resets to 1x ──
  await page.evaluate(() => galleryNav(1));
  await sleep(50);
  const afterNav = await page.evaluate(() => ({ s: zoomScale, t: document.getElementById('galleryBig').style.transform || '(none)' }));

  const ok = pinch.s > 1 && afterNav.s === 1 && afterNav.t === '(none)';
  console.log(ok ? '\n✅ WHEEL + PINCH + PAN WORK' : '\n❌ ZOOM FAILED');
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
