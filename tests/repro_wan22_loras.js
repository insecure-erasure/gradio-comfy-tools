// Full E2E: Wan 2.2 LoRA config -> the actual POST /api/video lora_config body.
// Also regression-check wan21 (single main LoRA editor).
const puppeteer = require('puppeteer-core');

const APP = 'http://localhost:8000';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.setRequestInterception(true);
  const posted = [];
  page.on('request', req => {
    const u = req.url();
    if (u.includes('/api/loras')) {
      req.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ loras: ['wan22/high-lora.safetensors', 'wan22/low-lora.safetensors', 'wan21/old.safetensors'] }) });
    } else if (u.includes('/api/diffusion-models')) {
      req.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ models: ['Wan2.2-high.safetensors', 'Wan2.2-low.safetensors'] }) });
    } else if (u.includes('/api/video')) {
      if (req.method() === 'POST') {
        posted.push(JSON.parse(req.postData() || '{}'));
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'http://x/v.mp4' }) });
      } else req.respond({ status: 200, contentType: 'application/json', body: '{}' });
    } else if (u.includes('/api/progress')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: null }) });
    } else if (u.includes('/api/')) {
      req.respond({ status: 200, contentType: 'application/json', body: '{}' });
    } else { req.continue(); }
  });

  await page.goto(APP, { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(800);

  const setupTab = (tab, version) => page.evaluate((t, v) => {
    window.switchTab(t);
    if (v) {
      const sel = document.getElementById('videoModelVersion');
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      toolbarValues.vidVersion = v;
    }
  }, tab, version);

  // ---------- WAN 2.2 ----------
  await setupTab('video', 'wan22');
  await sleep(200);
  await page.evaluate(() => window.openAdvancedModal());
  await sleep(400);

  // Add rows, then pick DIFFERENT LoRAs per path (as a user would)
  await page.evaluate(() => { window.addModalLoraRow('high'); window.addModalLoraRow('low'); });
  await sleep(200);
  await page.evaluate(() => {
    const hs = document.querySelector('#loraRows-high .lora-select');
    hs.value = 'wan22/high-lora.safetensors';
    hs.dispatchEvent(new Event('change', { bubbles: true }));
    const ls = document.querySelector('#loraRows-low .lora-select');
    ls.value = 'wan22/low-lora.safetensors';
    ls.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => window.saveAdvanced());
  await sleep(200);

  // Write a prompt + source, then click generate — capture the POST body
  await page.evaluate(() => {
    const t = document.getElementById('promptInputVideo');
    t.value = 'the apple rotates';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    const src = document.getElementById('videoSourceUrl');
    if (src) src.value = 'https://example.com/x.png';
    const btn = document.getElementById('btnVideo');
    if (btn && !btn.disabled) btn.click();
  });
  await sleep(600);
  console.log('wan22 POST lora_config:', posted.length ? posted[posted.length - 1].lora_config : '(no POST)');
  if (!posted.length) throw new Error('no /api/video POST captured');

  // ---------- WAN 2.1 (regression) ----------
  await setupTab('video', 'wan21');
  await sleep(200);
  await page.evaluate(() => window.openAdvancedModal());
  await sleep(400);
  const wan21Open = await page.evaluate(() => ({
    mainRows: document.querySelectorAll('#loraRows-main .lora-row').length,
    emptyMsg: document.querySelector('#loraRows-main .lora-empty')?.textContent || '',
  }));
  console.log('wan21 modal open (fresh, no saved config):', JSON.stringify(wan21Open));
  await page.evaluate(() => { window.addModalLoraRow('main'); });
  await page.evaluate(() => window.saveAdvanced());
  await sleep(200);
  await page.evaluate(() => window.openAdvancedModal());
  await sleep(200);
  const wan21Reopen = await page.evaluate(() => ({
    mainRows: document.querySelectorAll('#loraRows-main .lora-row').length,
  }));
  console.log('wan21 modal reopen:', JSON.stringify(wan21Reopen));

  // Generate with wan21 -> POST body must carry the main LoRA (no path)
  await page.evaluate(() => {
    const t = document.getElementById('promptInputVideo');
    t.value = 'the apple rotates';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.getElementById('btnVideo');
    if (btn && !btn.disabled) btn.click();
  });
  await sleep(600);
  const last = posted[posted.length - 1];
  console.log('wan21 POST lora_config:', last ? last.lora_config : '(no POST)');

  await browser.close();
})();
