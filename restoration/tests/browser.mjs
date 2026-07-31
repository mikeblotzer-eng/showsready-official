/**
 * End-to-end smoke test.
 *
 * Serves the app statically and drives it through a full job in a mobile
 * viewport: intake, sketch, equipment, readings, estimate, report, reload.
 * Catches the class of breakage unit tests cannot — bad imports, dead
 * selectors, views that throw on mount.
 *
 * Playwright is not a dependency of this app; install it where you run this:
 *   npm i -D playwright && node tests/browser.mjs
 * Set CHROMIUM_PATH to use a browser that is already on the machine.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(4173, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 414, height: 896 }, hasTouch: true, isMobile: true });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const step = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); errors.push(`${name}: ${e.message.split('\n')[0]}`); }
};

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });

await step('app boots to the job list', async () => {
  await page.waitForSelector('#nav a', { timeout: 5000 });
  const title = await page.textContent('#topbar h1');
  if (!/Jobs/.test(title)) throw new Error(`unexpected title: ${title}`);
});

await step('empty state offers to start a job', async () => {
  await page.waitForSelector('.empty', { timeout: 3000 });
});

await step('create a job', async () => {
  await page.click('.fab');
  await page.waitForSelector('.sheet-backdrop.in input[name=name]');
  await page.fill('input[name=name]', 'Kowalczyk Residence');
  await page.fill('input[name=jobNumber]', 'WT-2291');
  await page.fill('input[name=address]', '118 Alder Court');
  await page.fill('input[name=city]', 'Bellingham');
  await page.selectOption('select[name=sourceId]', 'supply_line');
  const dol = new Date(Date.now() - 20 * 3600 * 1000);
  await page.fill('input[name=dateOfLoss]', new Date(dol - dol.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  await page.click('.sheet-backdrop:last-of-type .sheet-actions .btn-primary');
  await page.waitForFunction(() => location.hash.startsWith('#/job/'), { timeout: 5000 });
  await page.waitForSelector('.stat-grid');
});

await step('overview shows Category 1 for a fresh supply line loss', async () => {
  const text = await page.textContent('main');
  if (!/Category/.test(text)) throw new Error('no classification block');
  const cat = await page.textContent('.stat-grid .stat:nth-child(1) .stat-value');
  if (cat.trim() !== '1') throw new Error(`expected Category 1, got ${cat}`);
});

await step('navigate to the floor plan', async () => {
  await page.click('#nav a[href$="/plan"]');
  await page.waitForSelector('#plan-canvas', { timeout: 5000 });
});

await step('add a room by typed dimensions', async () => {
  await page.click('[data-act=rect]');
  await page.waitForSelector('input[name=width]');
  await page.fill('input[name=width]', "12'6\"");
  await page.fill('input[name=length]', '20');
  await page.click('.sheet-backdrop:last-of-type .sheet-actions .btn-primary');
  // The room sheet opens next; wait for the previous sheet to finish tearing
  // down so the click cannot land on the outgoing one, then save.
  await page.waitForFunction(() => document.querySelectorAll('.sheet-backdrop').length === 1, { timeout: 3000 });
  await page.waitForSelector('.sheet-backdrop:last-of-type input[name=affectedFloorSqft]', { timeout: 3000 });
  await page.click('.sheet-backdrop:last-of-type .sheet-actions .btn-primary');
  await page.waitForTimeout(400);
});

await step('room area computed as 250 sq ft', async () => {
  const area = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('dryline'); r.onsuccess = () => res(r.result); });
    const jobs = await new Promise((res) => {
      const r = db.transaction('jobs').objectStore('jobs').getAll();
      r.onsuccess = () => res(r.result);
    });
    return jobs[0].rooms[0].floorAreaSqft;
  });
  if (Math.abs(area - 250) > 0.6) throw new Error(`expected ~250 sq ft, got ${area}`);
});

await step('plan canvas painted something', async () => {
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#plan-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  if (painted < 500) throw new Error(`canvas looks blank (${painted} opaque pixels)`);
});

await step('equipment tab sizes the chamber', async () => {
  await page.click('#nav a[href$="/equipment"]');
  await page.waitForSelector('#main[data-view$="/equipment"] .stat-grid', { timeout: 5000 });
  const body = await page.textContent('main');
  if (!/Air movers/.test(body)) throw new Error('no air mover recommendation');
  if (!/Placement check/.test(body)) throw new Error('no placement check');
});

await step('log the recommended equipment set', async () => {
  const btn = await page.$('[data-act=set-recommended]');
  if (!btn) throw new Error('no recommended-set button');
  await btn.click();
  await page.waitForSelector('.sheet-backdrop.in');
  await page.click('.sheet-backdrop:last-of-type .sheet-actions .btn-primary');
  await page.waitForTimeout(600);
  const body = await page.textContent('main');
  if (!/unit-day/.test(body)) throw new Error('equipment not logged');
});

await step('readings tab accepts an atmospheric reading', async () => {
  await page.click('#nav a[href$="/readings"]');
  await page.waitForSelector('#main[data-view$="/readings"] [data-act=ambient]', { timeout: 5000 });
  await page.click('[data-act=ambient]');
  await page.waitForSelector('input[name=tempF]');
  await page.fill('input[name=tempF]', '84');
  await page.fill('input[name=rh]', '38');
  await page.click('.sheet-backdrop:last-of-type .sheet-actions .btn-primary');
  await page.waitForTimeout(600);
  const body = await page.textContent('main');
  if (!/gpp/.test(body)) throw new Error('grains not shown');
});

await step('money tab builds a scope from the sketch', async () => {
  await page.click('#nav a[href$="/money"]');
  await page.waitForSelector('#main[data-view$="/money"] .stat-grid', { timeout: 5000 });
  const body = await page.textContent('main');
  if (!/Extraction|extraction/.test(body)) throw new Error('no extraction line generated');
  if (!/Drying equipment/.test(body)) throw new Error('no equipment days billed');
});

await step('field tab renders', async () => {
  await page.click('#nav a[href$="/field"]');
  await page.waitForSelector('#main[data-view$="/field"] [data-act=add-contact]', { timeout: 5000 });
  const body = await page.textContent('main');
  if (!/Kowalczyk/.test(body)) throw new Error('client contact not carried over');
});

await step('report builds a self-contained document', async () => {
  await page.goto(`http://localhost:4173/#/job/${(await page.evaluate(() => location.hash.split('/')[2]))}/report`);
  await page.waitForSelector('[data-act=build]', { timeout: 5000 });
  const size = await page.evaluate(async () => {
    const mod = await import('./js/views/report.js');
    const store = await import('./js/store.js');
    const jobs = await store.listJobs();
    const settings = await store.getSettings();
    const html = await mod.buildReportHtml({ job: jobs[0], settings });
    if (!/Loss summary/.test(html)) throw new Error('report missing loss summary');
    if (!/data:image\/png/.test(html)) throw new Error('report missing plan image');
    return html.length;
  });
  if (size < 4000) throw new Error(`report suspiciously small (${size} bytes)`);
});

await step('settings tab renders', async () => {
  await page.goto('http://localhost:4173/#/settings');
  await page.waitForSelector('[data-act=company]', { timeout: 5000 });
});

await step('reload keeps the job (offline persistence)', async () => {
  await page.goto('http://localhost:4173/#/jobs');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.list-item', { timeout: 5000 });
  const body = await page.textContent('main');
  if (!/Kowalczyk/.test(body)) throw new Error('job did not survive reload');
  if (!/Cat 1/.test(body)) throw new Error('classification chip missing');
});

await browser.close();
server.close();

if (errors.length) {
  console.log(`\n  ${errors.length} problem(s):`);
  for (const e of errors) console.log(`   - ${e}`);
  process.exit(1);
}
console.log('\n  smoke test clean\n');
