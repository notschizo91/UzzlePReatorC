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
    return { n: m.pieces.length, overlap, split };
  });
  const ok = r.overlap < 0.01 && r.split === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} star pieces=${pieces} seed=${seed} mode=${mode}: n=${r.n}, overlap=${r.overlap.toFixed(4)} mm², split=${r.split}`);
  if (!ok) errors.push(`starfish overlap (pieces=${pieces} seed=${seed})`);
}

await browser.close();
if (errors.length) { console.error('ERRORS:', errors); process.exit(1); }
console.log('E2E OK');
