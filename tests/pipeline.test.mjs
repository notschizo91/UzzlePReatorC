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

console.log('modes: none, emboss, emboss-fill');
for (const mode of ['none', 'emboss', 'emboss-fill']) {
  const m = buildPuzzle(norm, { targetPieces: 12, seed: 3, surfaceMode: mode });
  const shells = m.pieces.flatMap((p) => solidToShells(p.layers));
  const bad = shells.filter((s) => !isWatertight(s) || shellVolume(s) <= 0).length;
  check(bad === 0, `${mode}: ${shells.length} shells all watertight with volume`);
}

console.log('emboss-fill raises solid plateaus, not just outlines');
{
  const { area } = await import('../src/geom/clip.js');
  const raisedArea = (m) => m.pieces.reduce((sum, piece) => {
    const H = 6;
    return sum + piece.layers.filter((l) => l.z0 >= H).reduce((s, l) => s + area(l.rings), 0);
  }, 0);
  const outline = buildPuzzle(norm, { targetPieces: 12, seed: 3, surfaceMode: 'emboss', pieceHeight: 6 });
  const filled = buildPuzzle(norm, { targetPieces: 12, seed: 3, surfaceMode: 'emboss-fill', pieceHeight: 6 });
  const ao = raisedArea(outline), af = raisedArea(filled);
  // the input has a closed "eye" ring: filling it must raise more area
  // than stroking its outline
  check(af > ao + 10, `filled raised area ${af.toFixed(0)} mm² > outline ${ao.toFixed(0)} mm²`);
}

console.log('pieces: pairwise disjoint, each one connected body');
{
  const { intersect, area, toRegions } = await import('../src/geom/clip.js');
  // stress across several seeds and piece counts (elongated grids included)
  for (const [pieces, seed] of [[24, 7], [40, 11], [8, 2], [60, 99]]) {
    const m = buildPuzzle(norm, { targetPieces: pieces, seed, surfaceMode: 'none' });
    let overlap = 0, split = 0;
    for (let i = 0; i < m.pieces.length; i++) {
      if (toRegions(m.pieces[i].rings).length !== 1) split++;
      for (let k = i + 1; k < m.pieces.length; k++) {
        overlap += area(intersect(m.pieces[i].rings, m.pieces[k].rings));
      }
    }
    check(overlap < 0.01, `pieces=${pieces} seed=${seed}: overlap area ${overlap.toFixed(4)} mm^2`);
    check(split === 0, `pieces=${pieces} seed=${seed}: no piece is split into islands`);
  }
}

console.log('starfish: thin swirly arms stay disjoint across seeds');
{
  const { intersect, area, toRegions } = await import('../src/geom/clip.js');
  function starfish(R = 100, n = 720) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const u = (Math.cos(5 * t) + 1) / 2;
      const r = R * (0.16 + 0.84 * Math.pow(u, 3.5));
      const sw = t + 0.35 * Math.pow(u, 2);
      pts.push([r * Math.cos(sw), r * Math.sin(sw)]);
    }
    return pts;
  }
  const starNorm = normalizeInput({ closed: [starfish()], open: [] }, 180);
  let bad = 0, runs = 0;
  for (const pieces of [15, 30, 60]) {
    for (let seed = 1; seed <= 6; seed++) {
      const m = buildPuzzle(starNorm, { targetPieces: pieces, seed: seed * 37, surfaceMode: 'engrave' });
      runs++;
      let ov = 0, split = 0;
      for (let i = 0; i < m.pieces.length; i++) {
        if (toRegions(m.pieces[i].rings).length !== 1) split++;
        for (let k = i + 1; k < m.pieces.length; k++) ov += area(intersect(m.pieces[i].rings, m.pieces[k].rings));
      }
      if (ov > 0.01 || split) { bad++; console.error(`  FAIL - pieces=${pieces} seed=${seed * 37} overlap=${ov.toFixed(3)} split=${split}`); }
    }
  }
  check(bad === 0, `${runs} starfish builds: all disjoint, no split pieces`);
}

console.log('flower with hole: high piece counts leave no gaps');
{
  const { intersect, area, toRegions } = await import('../src/geom/clip.js');
  function flower(R = 100, n = 720) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const r = R * (0.62 + 0.38 * Math.cos(5 * t));
      pts.push([r * Math.cos(t), r * Math.sin(t)]);
    }
    return pts;
  }
  const circle = (r, n = 90) => Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [r * Math.cos(-t), r * Math.sin(-t)]; // opposite winding: a hole
  });
  const flowerNorm = normalizeInput({ closed: [flower(), circle(12)], open: [] }, 180);
  let bad = 0, runs = 0;
  for (const pieces of [30, 60, 90]) {
    for (let seed = 1; seed <= 5; seed++) {
      const m = buildPuzzle(flowerNorm, { targetPieces: pieces, seed: seed * 101, surfaceMode: 'none' });
      runs++;
      let ov = 0, split = 0;
      for (let i = 0; i < m.pieces.length; i++) {
        if (toRegions(m.pieces[i].rings).length !== 1) split++;
        for (let k = i + 1; k < m.pieces.length; k++) ov += area(intersect(m.pieces[i].rings, m.pieces[k].rings));
      }
      const silArea = 180 * 180 * 0.5; // loose scale reference
      const gapFrac = m.stats.uncoveredMM2 / silArea;
      if (ov > 0.01 || split || gapFrac > 0.003) {
        bad++;
        console.error(`  FAIL - pieces=${pieces} seed=${seed * 101}: overlap=${ov.toFixed(3)} split=${split} uncovered=${m.stats.uncoveredMM2.toFixed(2)} mm²`);
      }
    }
  }
  check(bad === 0, `${runs} flower builds: disjoint, connected, fully covered`);
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
