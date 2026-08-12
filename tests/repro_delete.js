// Repro/verify: does fullscreen-gallery individual deletion REALLY persist?
// 1. Load, let the backend-history backfill settle.
// 2. Delete one generated entry via the lightbox trash.
// 3. Verify it is gone from memory + localStorage + tombstoned.
// 4. Reload AND manually re-run backfillGalleries() — must NOT resurrect it.
const puppeteer = require('puppeteer');

const APP = 'http://localhost:8000';
const PUPPETEER_CACHE = '/srv/pi/.cache/puppeteer';
const CHROME = PUPPETEER_CACHE + '/chrome/linux-151.0.7922.77/chrome-linux64/chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEY = 'comfyTools.userConfig';

async function launch() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

const lsFilenames = () => {
  const d = JSON.parse(localStorage.getItem(KEY));
  return {
    generated: (d.galleries.generated || []).map(e => e.filename),
    deleted: (d.galleries.deleted || []),
  };
};

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));

  await page.goto(APP, { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(2500); // let adoptRunningJob + backfillGalleries settle

  const initial = await page.evaluate(() => ({
    mem: (window.galleryGenerated || []).map(e => e.filename),
    ls: (() => { const d = JSON.parse(localStorage.getItem('comfyTools.userConfig')); return (d.galleries.generated || []).map(e => e.filename); })(),
  }));
  console.log('INITIAL generated:', initial.mem.length);
  if (!initial.mem.length) { console.log('  (no gallery — seeding synthetic entries to test the path)'); }

  // Open the lightbox and delete the entry at index 1 via the UI trash button.
  await page.evaluate(() => openGenerateLightbox());
  await sleep(300);
  // Navigate to index 1 from the initial (last) position.
  await page.evaluate(() => { for (let i = galleryEntries.length - 1; i > 1; i--) galleryNav(-1); });
  const deletedBefore = await page.evaluate(() => galleryEntries[galleryIdx].filename || galleryEntries[galleryIdx].src);
  await page.evaluate(() => document.getElementById('galleryTrash').click());
  await sleep(300);

  const afterDelete = await page.evaluate(() => ({
    mem: (window.galleryGenerated || []).map(e => e.filename),
    ls: (() => { const d = JSON.parse(localStorage.getItem('comfyTools.userConfig')); return { generated: (d.galleries.generated || []).map(e => e.filename), deleted: d.galleries.deleted || [] }; })(),
  }));
  console.log('DELETED      :', deletedBefore);
  console.log('AFTER DELETE mem:', afterDelete.mem.length, '| still present in mem:', afterDelete.mem.includes(deletedBefore));
  console.log('AFTER DELETE ls :', afterDelete.ls.generated.length, '| still in ls:', afterDelete.ls.generated.includes(deletedBefore), '| tombstones:', afterDelete.ls.deleted.length);

  // Simulate the exact resurrection paths: reload + a manual backfill run.
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(2500);
  await page.evaluate(() => backfillGalleries()); // visibilitychange-style re-backfill
  await sleep(1500);

  const afterReload = await page.evaluate(() => ({
    mem: (window.galleryGenerated || []).map(e => e.filename),
    ls: (() => { const d = JSON.parse(localStorage.getItem('comfyTools.userConfig')); return { generated: (d.galleries.generated || []).map(e => e.filename), deleted: d.galleries.deleted || [] }; })(),
  }));
  console.log('AFTER RELOAD+BACKFILL mem:', afterReload.mem.length, '| resurrected:', afterReload.mem.includes(deletedBefore));
  console.log('AFTER RELOAD+BACKFILL ls :', afterReload.ls.generated.length, '| resurrected:', afterReload.ls.generated.includes(deletedBefore), '| tombstones:', afterReload.ls.deleted.length);

  const ok = !afterReload.mem.includes(deletedBefore) && !afterReload.ls.generated.includes(deletedBefore) && afterReload.ls.deleted.includes(deletedBefore);
  console.log(ok ? '\n✅ DELETION NOW PERSISTS' : '\n❌ DELETION STILL RESURRECTED');
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
