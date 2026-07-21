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

console.log('pumpkin: mesh caps never spill into neighbouring pieces');
{
  const { bounds } = await import('../src/geom/clip.js');
  function pumpkinBody(n = 500) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const lobe = 1 + 0.03 * Math.cos(8 * t);
      pts.push([105 * Math.cos(t) * lobe, 85 * Math.sin(t) * lobe]);
    }
    return pts;
  }
  const rib = (k) => ({
    pts: Array.from({ length: 61 }, (_, i) => {
      const u = i / 60;
      return [k * (1 + 0.35 * Math.sin(Math.PI * u)), 80 - 160 * u];
    }),
    closed: false,
  });
  const pumpkinNorm = normalizeInput({
    closed: [pumpkinBody(), [[-8, 82], [-10, 100], [-2, 108], [8, 106], [10, 88], [6, 80]]],
    open: [rib(-60), rib(-30), rib(0.001), rib(30), rib(60)],
  }, 190);
  const pointInRings = (x, y, rings) => {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  };
  let leaks = 0;
  for (const seed of [7, 3]) {
    const m = buildPuzzle(pumpkinNorm, { targetPieces: 40, seed, surfaceMode: 'engrave' });
    const bbs = m.pieces.map((p) => bounds(p.rings));
    m.pieces.forEach((piece, i) => {
      for (const shell of solidToShells(piece.layers)) {
        for (let t = 0; t < shell.length; t += 9) {
          if (!(shell[t + 2] === shell[t + 5] && shell[t + 5] === shell[t + 8])) continue; // caps only
          for (const fx of [1 / 3, 0.5]) {
            const px = shell[t] * fx + shell[t + 3] * fx + shell[t + 6] * (1 - 2 * fx);
            const py = shell[t + 1] * fx + shell[t + 4] * fx + shell[t + 7] * (1 - 2 * fx);
            for (let k = 0; k < m.pieces.length; k++) {
              if (k === i) continue;
              const b = bbs[k];
              if (px < b.minX || px > b.maxX || py < b.minY || py > b.maxY) continue;
              if (pointInRings(px, py, m.pieces[k].rings)) leaks++;
            }
          }
        }
      }
    });
  }
  check(leaks === 0, `no cap sample points inside other pieces (${leaks} leaks)`);
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

console.log('name puzzle: font -> letters-as-pieces');
{
  const { parseFont, textToInput } = await import('../src/text.js');
  const { intersect, area } = await import('../src/geom/clip.js');
  const { readFileSync } = await import('node:fs');
  const buf = readFileSync(new URL('../assets/default-font.ttf', import.meta.url));
  const font = parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const nameNorm = normalizeInput(textToInput(font, 'Emma', 8), 180);

  const m = buildPuzzle(nameNorm, { cutMode: 'letters', surfaceMode: 'none', pieceHeight: 8, borderHeight: 5 });
  check(m.pieces.length === 4, `"Emma" -> ${m.pieces.length} letter pieces (expected 4)`);
  check(m.pieces.some((p) => p.rings.length > 1), 'the "a" keeps its counter hole');
  let ov = 0;
  for (let i = 0; i < m.pieces.length; i++) {
    for (let k = i + 1; k < m.pieces.length; k++) ov += area(intersect(m.pieces[i].rings, m.pieces[k].rings));
  }
  check(ov < 0.01, `letter pieces disjoint (overlap ${ov.toFixed(4)} mm²)`);
  const shells = [...m.pieces.flatMap((p) => solidToShells(p.layers)), ...solidToShells(m.tray.layers)];
  const bad = shells.filter((s) => !isWatertight(s) || shellVolume(s) <= 0).length;
  check(bad === 0, `${shells.length} name-puzzle shells watertight with volume`);
  check(m.stats.uncoveredMM2 < 0.01, 'letters fully cover the silhouette');

  const mj = buildPuzzle(nameNorm, { cutMode: 'jigsaw', targetPieces: 12, seed: 5, surfaceMode: 'none' });
  check(mj.pieces.length >= 4 && mj.stats.uncoveredMM2 < 1, `jigsaw-over-text: ${mj.pieces.length} pieces, covered`);
}

console.log('3MF export: valid zip, valid model XML, named objects');
{
  const { objectsTo3MF } = await import('../src/export/threemf.js');
  const { inflateRawSync } = await import('node:zlib');
  const m = buildPuzzle(norm, { targetPieces: 8, seed: 3, surfaceMode: 'engrave' });
  const objects = [
    { name: 'tray', shells: solidToShells(m.tray.layers) },
    ...m.pieces.map((p, i) => ({ name: `piece-${i + 1}`, shells: solidToShells(p.layers) })),
  ];
  const buf = Buffer.from(await objectsTo3MF(objects));

  // walk the central directory
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  check(eocd > 0, 'zip end-of-central-directory found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    check(buf.readUInt32LE(off) === 0x02014b50, 'central header signature');
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const lfhOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const dataStart = lfhOff + 30 + buf.readUInt16LE(lfhOff + 26) + buf.readUInt16LE(lfhOff + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    entries[name] = { data, crc };
    off += 46 + nameLen;
  }
  check(count === 3, `3 zip entries (got ${count})`);
  check(!!entries['3D/3dmodel.model'] && !!entries['[Content_Types].xml'] && !!entries['_rels/.rels'], 'expected entry names present');

  const xml = entries['3D/3dmodel.model'].data.toString('utf8');
  const objCount = (xml.match(/<object /g) || []).length;
  check(objCount === objects.length, `${objCount} objects in model (expected ${objects.length})`);
  check(xml.includes('name="tray"') && xml.includes('name="piece-1"'), 'objects are named');
  check(xml.includes('unit="millimeter"'), 'millimetre units');
  check(!xml.includes('NaN'), 'no NaN coordinates');
  const triCount = (xml.match(/<triangle /g) || []).length;
  const vertCount = (xml.match(/<vertex /g) || []).length;
  check(triCount > 100 && vertCount > 100, `${vertCount} vertices, ${triCount} triangles`);
  // every triangle index must reference an existing vertex of its object
  let indexOk = true;
  for (const objXml of xml.split('<object ').slice(1)) {
    const nVerts = (objXml.match(/<vertex /g) || []).length;
    for (const t of objXml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) {
      if (+t[1] >= nVerts || +t[2] >= nVerts || +t[3] >= nVerts) { indexOk = false; break; }
    }
  }
  check(indexOk, 'all triangle indices in range');
  console.log(`  3MF size: ${(buf.length / 1024).toFixed(0)} KB`);
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nAll checks passed.');
