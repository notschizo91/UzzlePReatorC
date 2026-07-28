// Browser end-to-end test. Requires playwright-core and a Chromium binary.
//   1. serve the repo:  npm run serve   (port 8000)
//   2. run:             node tests/e2e.mjs [baseURL]
// Verifies: sample dog generates, STL downloads, and pieces from the
// thin-armed starfish fixture are pairwise disjoint in the real browser.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:8000/';
const errors = [];
const exec = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: exec }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(base, { waitUntil: 'networkidle' });

// --- sample dog: generation + STL download ---
await page.click('#sample');
await page.waitForFunction(() => document.getElementById('status').textContent.includes('pieces'), null, { timeout: 30000 });
console.log('dog:', (await page.textContent('#status')).trim());
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.click('#exportAll'),
]);
const buf = readFileSync(await download.path());
const tris = buf.readUInt32LE(80);
if (buf.length !== 84 + tris * 50) errors.push('STL size mismatch');
console.log(`dog STL: ${tris} triangles, ${(buf.length / 1e6).toFixed(2)} MB`);

// --- starfish fixture: disjointness in the browser ---
for (const [pieces, seed, mode] of [[30, 7, 'engrave'], [45, 3, 'engrave'], [60, 42, 'none']]) {
  await page.fill('#targetPieces', String(pieces));
  await page.fill('#seed', String(seed));
  await page.selectOption('#surfaceMode', mode);
  await page.setInputFiles('#file', new URL('./fixtures/star.svg', import.meta.url).pathname);
  await page.waitForFunction(() => window.__model, null, { timeout: 30000 });
  await page.dispatchEvent('#seed', 'input'); // regenerate with the params above
  await page.waitForTimeout(600);
  const r = await page.evaluate(async () => {
    const { intersect, area, toRegions } = await import('./src/geom/clip.js');
    const m = window.__model;
    let overlap = 0, split = 0;
    for (let i = 0; i < m.pieces.length; i++) {
      if (toRegions(m.pieces[i].rings).length !== 1) split++;
      for (let k = i + 1; k < m.pieces.length; k++) {
        overlap += area(intersect(m.pieces[i].rings, m.pieces[k].rings));
      }
    }
    return { n: m.pieces.length, overlap, split, uncovered: m.stats.uncoveredMM2 };
  });
  const ok = r.overlap < 0.01 && r.split === 0 && r.uncovered < 40;
  console.log(`${ok ? 'ok  ' : 'FAIL'} star pieces=${pieces} seed=${seed} mode=${mode}: n=${r.n}, overlap=${r.overlap.toFixed(4)} mm², split=${r.split}, uncovered=${r.uncovered.toFixed(2)} mm²`);
  if (!ok) errors.push(`starfish overlap (pieces=${pieces} seed=${seed})`);
}

// --- surface picker: select faces, give them heights ---
await page.setInputFiles('#file', new URL('./fixtures/unicorn.svg', import.meta.url).pathname);
await page.waitForFunction(() => window.__model, null, { timeout: 30000 });
await page.waitForTimeout(400);
await page.click('#pickSurfaces');
await page.waitForSelector('.picker-svg', { timeout: 10000 });
const nFaces = await page.locator('.face').count();
console.log(`picker: ${nFaces} faces detected`);
if (nFaces !== 5) errors.push(`expected 5 unicorn faces, got ${nFaces}`);

// faces are area-sorted: 0 body, 1 horn, 2 ear, 3 eye, 4 nostril
for (const i of [3, 4]) await page.locator('.face').nth(i).click({ force: true });
await page.fill('.picker-height input', '2');
await page.click('button.primary-ghost');
await page.locator('.face').nth(1).click({ force: true });
await page.fill('.picker-height input', '4.5');
await page.click('button.primary-ghost');
await page.click('button.primary'); // Done
await page.waitForFunction(() => !document.querySelector('.picker'), null, { timeout: 5000 });
await page.waitForTimeout(800);

const surf = await page.evaluate(() => {
  const m = window.__model;
  const tops = new Set();
  for (const p of m.pieces) for (const l of p.layers) tops.add(+l.z1.toFixed(2));
  return { mode: document.getElementById('surfaceMode').value, raised: m.stats.raisedSurfaces, tops: [...tops].sort((a, b) => a - b) };
});
const surfOk = surf.mode === 'surfaces' && surf.raised === 3 &&
  [6, 8, 10.5].every((z) => surf.tops.includes(z));
console.log(`${surfOk ? 'ok  ' : 'FAIL'} surfaces: ${surf.raised} raised, layer tops ${surf.tops.join('/')} mm`);
if (!surfOk) errors.push('surface heights not applied as expected');

await browser.close();
if (errors.length) { console.error('ERRORS:', errors); process.exit(1); }
console.log('E2E OK');
