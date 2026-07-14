// Node test for the DOM-free geometry pipeline.
// Run: node tests/pipeline.test.mjs
import { normalizeInput, buildPuzzle } from '../src/geom/puzzle.js';
import { solidToShells, shellVolume } from '../src/geom/mesh.js';
import { shellsToSTL } from '../src/export/stl.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok - ${msg}`);
  else { failures++; console.error(`  FAIL - ${msg}`); }
}

// Every directed edge in a closed shell must be balanced by an equal
// number of reverse edges (pinch-point vertices legitimately double up).
function isWatertight(shell) {
  const edges = new Map();
  const key = (x, y, z) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
  for (let i = 0; i < shell.length; i += 9) {
    const v = [
      key(shell[i], shell[i + 1], shell[i + 2]),
      key(shell[i + 3], shell[i + 4], shell[i + 5]),
      key(shell[i + 6], shell[i + 7], shell[i + 8]),
    ];
    for (let e = 0; e < 3; e++) {
      const k = `${v[e]}|${v[(e + 1) % 3]}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  for (const [k, count] of edges) {
    const [a, b] = k.split('|');
    if ((edges.get(`${b}|${a}`) || 0) !== count) return false;
  }
  return true;
}

// Synthetic "dog-ish" blob silhouette: a lumpy closed curve.
function blob(cx, cy, r, lumps, n = 240) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr = r * (1 + 0.25 * Math.sin(lumps * t) + 0.1 * Math.cos((lumps + 3) * t));
    pts.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]);
  }
  return pts;
}

console.log('normalizeInput: closed outline');
const input = {
  closed: [blob(0, 0, 100, 5), // silhouette
    blob(30, 20, 8, 2, 48)],   // an "eye" detail inside
  open: [
    { pts: [[-60, -20], [-20, 10], [20, -15], [60, 5]], closed: false },
    { pts: [[-40, 40], [0, 55], [40, 42]], closed: false },
  ],
};
const norm = normalizeInput(input, 180);
{
  const xs = norm.silhouette.flatMap((r) => r.map((p) => p[0]));
  const w = Math.max(...xs) - Math.min(...xs);
  check(Math.abs(w - 180) < 0.5, `silhouette scaled to 180mm wide (got ${w.toFixed(2)})`);
  check(norm.lines.length === 4, `kept ${norm.lines.length} engraving polylines (expected 4)`);
}

console.log('buildPuzzle: engrave mode');
const model = buildPuzzle(norm, {
  targetPieces: 24, seed: 7, pieceHeight: 6, gap: 0.35,
  baseHeight: 2.4, borderHeight: 8, borderWidth: 5,
  surfaceMode: 'engrave', lineWidth: 1.2, lineDepth: 1.0,
});
check(model.pieces.length >= 12 && model.pieces.length <= 40,
  `piece count sane: ${model.pieces.length} (grid ${model.stats.cols}x${model.stats.rows})`);
check(model.tray.layers.length === 2, 'tray has floor + wall layers');
check(model.stats.trayHeightMM === 10.4, `tray total height ${model.stats.trayHeightMM}mm`);

console.log('meshing: watertight shells, positive volume');
let allShells = [];
let pieceVol = 0;
for (const piece of model.pieces) {
  const shells = solidToShells(piece.layers);
  check(shells.length >= 1, `piece has ${shells.length} shell(s)`);
  for (const s of shells) {
    if (!isWatertight(s)) { failures++; console.error('  FAIL - piece shell not watertight'); }
    const v = shellVolume(s);
    if (v <= 0) { failures++; console.error(`  FAIL - piece shell volume ${v}`); }
    pieceVol += v;
  }
  allShells.push(...shells);
}
console.log(`  (checked ${model.pieces.length} pieces silently for watertightness)`);
const trayShells = solidToShells(model.tray.layers);
for (const s of trayShells) {
  check(isWatertight(s), 'tray shell watertight');
  check(shellVolume(s) > 0, 'tray shell volume positive');
}
check(pieceVol > 1000, `total piece volume ${pieceVol.toFixed(0)} mm^3`);

console.log('modes: none and emboss');
for (const mode of ['none', 'emboss']) {
  const m = buildPuzzle(norm, { targetPieces: 12, seed: 3, surfaceMode: mode });
  const shells = m.pieces.flatMap((p) => solidToShells(p.layers));
  const bad = shells.filter((s) => !isWatertight(s) || shellVolume(s) <= 0).length;
  check(bad === 0, `${mode}: ${shells.length} shells all watertight with volume`);
}

console.log('determinism: same seed same geometry');
{
  const a = buildPuzzle(norm, { targetPieces: 16, seed: 42 });
  const b = buildPuzzle(norm, { targetPieces: 16, seed: 42 });
  check(JSON.stringify(a.pieces[0].rings) === JSON.stringify(b.pieces[0].rings), 'seed 42 reproducible');
  const c = buildPuzzle(norm, { targetPieces: 16, seed: 43 });
  check(JSON.stringify(a.pieces[0].rings) !== JSON.stringify(c.pieces[0].rings), 'seed 43 differs');
}

console.log('fallback: stroke-only input (no closed outline)');
{
  const openOnly = {
    closed: [],
    open: [
      { pts: blob(0, 0, 100, 4, 180).concat([blob(0, 0, 100, 4, 180)[0]]), closed: false },
    ],
  };
  const n2 = normalizeInput(openOnly, 120);
  const m2 = buildPuzzle(n2, { targetPieces: 9, seed: 1, surfaceMode: 'none' });
  check(m2.pieces.length >= 4, `stroke-only fallback produced ${m2.pieces.length} pieces`);
}

console.log('STL export');
{
  const stl = shellsToSTL([...allShells, ...trayShells], 'test');
  const view = new DataView(stl);
  const triCount = view.getUint32(80, true);
  check(stl.byteLength === 84 + triCount * 50, `STL size consistent (${triCount} tris, ${(stl.byteLength / 1e6).toFixed(1)} MB)`);
  const dir = mkdtempSync(join(tmpdir(), 'puzzle-'));
  const f = join(dir, 'test.stl');
  writeFileSync(f, Buffer.from(stl));
  console.log(`  wrote ${f}`);
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nAll checks passed.');
