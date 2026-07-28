import { parseSVG } from './svgload.js';
import { parseFont, textToInput } from './text.js';
import { normalizeInput, buildPuzzle, DEFAULT_PARAMS } from './geom/puzzle.js';
import { extractFaces } from './geom/faces.js';
import { SurfacePicker } from './surfacepicker.js';
import { solidToShells, translateShells } from './geom/mesh.js';
import { shellsToSTL } from './export/stl.js';
import { objectsTo3MF } from './export/threemf.js';
import { bounds } from './geom/clip.js';
import { Viewer } from './preview.js';

const $ = (id) => document.getElementById(id);

const viewer = new Viewer($('view'));
let parsed = null;    // output of parseSVG or textToInput
let source = 'svg';   // 'svg' | 'text' - what "parsed" came from
let cutMode = 'jigsaw';
let fontObj = null;   // parsed opentype font (lazy default)
let model = null;     // output of buildPuzzle
let pieceShells = []; // [{shells, centroid}]
let trayShells = [];
let svgName = 'puzzle';

// surface selection state
const picker = new SurfacePicker();
let faces = [];         // extractFaces output for the current art
let faceHeights = [];   // mm per face, 0 = flat
let facesLineWidth = null;

const NUM_PARAMS = [
  'targetWidth', 'targetPieces', 'seed', 'pieceHeight', 'gap',
  'trayClearance', 'baseHeight', 'borderHeight', 'borderWidth',
  'lineWidth', 'lineDepth',
];

function readParams() {
  const p = {};
  for (const key of NUM_PARAMS) {
    const v = parseFloat($(key).value);
    p[key] = Number.isFinite(v) ? v : DEFAULT_PARAMS[key];
  }
  p.surfaceMode = $('surfaceMode').value;
  p.cutMode = cutMode;
  return p;
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// Faces live in normalized (mm, centred) space, so they must be rebuilt
// whenever the art, target width or separator width changes.
function currentNormalized(params) {
  return normalizeInput(parsed, params.targetWidth, {
    holesFromWinding: $('holeMode').value === 'holes',
  });
}

function ensureFaces(norm, lineWidth) {
  const key = `${lineWidth}|${norm.silhouette.length}`;
  if (facesLineWidth === key && faces.length) return;
  const prevCount = faces.length;
  faces = extractFaces(norm, lineWidth);
  facesLineWidth = key;
  // keep heights when the face set is unchanged (indices are area-sorted
  // and therefore stable); otherwise start flat
  if (faces.length !== prevCount) faceHeights = faces.map(() => 0);
  else faceHeights = faces.map((_, i) => faceHeights[i] || 0);
  $('pickSurfaces').disabled = faces.length === 0;
  updateSurfaceLabel();
}

function updateSurfaceLabel() {
  const raised = faceHeights.filter((h) => h > 0).length;
  $('surfaceLabel').textContent = faces.length
    ? `${faces.length} surfaces detected · ${raised} raised`
    : 'load art, then pick surfaces to raise (eyes, horn, …)';
}

function generate() {
  if (!parsed) return;
  const params = readParams();
  try {
    const t0 = performance.now();
    const norm = currentNormalized(params);
    ensureFaces(norm, params.lineWidth);
    params.surfaces = faces.map((f, i) => ({ rings: f.rings, height: faceHeights[i] || 0 }));
    model = buildPuzzle(norm, params);

    pieceShells = model.pieces.map((piece) => ({
      shells: solidToShells(piece.layers),
      centroid: piece.centroid,
    }));
    trayShells = solidToShells(model.tray.layers);

    const s = model.stats;
    viewer.setModel(pieceShells, trayShells, {
      pieceHeight: s.pieceHeightMM,
      baseHeight: params.baseHeight,
      size: Math.max(s.widthMM, s.heightMM),
    });

    window.__model = model; // test hook: inspected by the e2e suite
    const ms = Math.round(performance.now() - t0);
    setStatus(
      `${s.pieces} pieces (${s.cols}×${s.rows} grid) · ` +
      `${s.widthMM.toFixed(0)}×${s.heightMM.toFixed(0)} mm · ` +
      `tray ${s.trayHeightMM.toFixed(1)} mm tall · ${ms} ms` +
      (s.raisedSurfaces ? `\n${s.raisedSurfaces} raised surfaces · pieces up to ${s.pieceHeightMM.toFixed(1)} mm tall` : ''),
    );
    $('warnings').textContent = model.warnings.join('\n');
    for (const btn of document.querySelectorAll('.exports button')) btn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
    $('warnings').textContent = '';
  }
}

let timer = null;
function scheduleGenerate() {
  clearTimeout(timer);
  timer = setTimeout(generate, 250);
}

async function loadSvgText(text, name) {
  try {
    parsed = parseSVG(text);
    source = 'svg';
    cutMode = 'jigsaw';
    faces = []; faceHeights = []; facesLineWidth = null;
    svgName = (name || 'puzzle').replace(/\.svg\b.*$/i, '').trim() || 'puzzle';
    $('fileLabel').textContent = name || 'loaded';
    generate();
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  }
}

// --- name puzzle ---
async function ensureFont() {
  if (fontObj) return fontObj;
  const res = await fetch('./assets/default-font.ttf');
  fontObj = parseFont(await res.arrayBuffer());
  return fontObj;
}

async function makeNamePuzzle() {
  const text = $('nameText').value;
  if (!text.trim()) { setStatus('Type a name first.', true); return; }
  try {
    const font = await ensureFont();
    parsed = textToInput(font, text, parseFloat($('letterSpacing').value) || 0);
    source = 'text';
    faces = []; faceHeights = []; facesLineWidth = null;
    $('holeMode').value = 'holes'; // letter counters must stay open
    cutMode = $('cutMode').value;
    svgName = text.trim().replace(/[^\w-]+/g, '_').slice(0, 30) || 'name-puzzle';
    $('fileLabel').textContent = `name puzzle: "${text.trim()}"`;
    generate();
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  }
}

// --- wire up UI ---
for (const key of NUM_PARAMS) $(key).addEventListener('input', scheduleGenerate);
$('surfaceMode').addEventListener('change', scheduleGenerate);
$('holeMode').addEventListener('change', () => {
  faces = []; faceHeights = []; facesLineWidth = null; // geometry changed
  scheduleGenerate();
});
$('explode').addEventListener('input', (e) => viewer.setExplode(parseFloat(e.target.value)));

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) loadSvgText(await f.text(), f.name);
});

$('randomize').addEventListener('click', () => {
  $('seed').value = Math.floor(Math.random() * 100000);
  generate();
});

$('pickSurfaces').addEventListener('click', async () => {
  if (!parsed) return;
  const params = readParams();
  const norm = currentNormalized(params);
  ensureFaces(norm, params.lineWidth);
  if (!faces.length) { setStatus('No enclosed surfaces found in this art.', true); return; }
  const result = await picker.open(faces, faceHeights, `${svgName}.svg`, 2);
  if (!result) return; // cancelled
  faceHeights = result;
  updateSurfaceLabel();
  if (faceHeights.some((h) => h > 0)) $('surfaceMode').value = 'surfaces';
  generate();
});

$('makeName').addEventListener('click', makeNamePuzzle);
$('nameText').addEventListener('keydown', (e) => { if (e.key === 'Enter') makeNamePuzzle(); });
for (const id of ['cutMode', 'letterSpacing']) {
  $(id).addEventListener('change', () => { if (source === 'text') makeNamePuzzle(); });
}

$('fontFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    fontObj = parseFont(await f.arrayBuffer());
    const label = fontObj.names?.fullName?.en || f.name;
    $('fontLabel').textContent = `font: ${label}`;
    if (source === 'text' && $('nameText').value.trim()) makeNamePuzzle();
  } catch (err) {
    console.error(err);
    setStatus(`Could not read font: ${err.message || err} (WOFF2 is not supported - use TTF/OTF/WOFF)`, true);
  }
});

$('sample').addEventListener('click', async () => {
  const res = await fetch('./assets/dog.svg');
  loadSvgText(await res.text(), 'dog.svg (sample)');
});

const drop = document.body;
drop.addEventListener('dragover', (e) => e.preventDefault());
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && /\.svg$/i.test(f.name)) loadSvgText(await f.text(), f.name);
});

// --- exports ---
function download(buffer, filename) {
  const blob = new Blob([buffer], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function allPieceShells() {
  return pieceShells.flatMap((p) => p.shells);
}

$('exportPieces').addEventListener('click', () => {
  download(shellsToSTL(allPieceShells(), 'pieces'), `${svgName}-pieces.stl`);
});

$('exportTray').addEventListener('click', () => {
  download(shellsToSTL(trayShells, 'tray'), `${svgName}-tray.stl`);
});

$('exportAll').addEventListener('click', () => {
  // tray at origin, pieces laid out beside it
  const trayBB = bounds(model.tray.layers[0].rings);
  const dx = trayBB.width + 15;
  const moved = translateShells(allPieceShells(), dx, 0, 0);
  download(shellsToSTL([...trayShells, ...moved], 'puzzle'), `${svgName}-all.stl`);
});

$('export3mf').addEventListener('click', async () => {
  // one 3MF with the tray and every piece as separate named objects;
  // pieces are placed beside the tray on the build plate
  const trayBB = bounds(model.tray.layers[0].rings);
  const dx = trayBB.width + 15;
  const objects = [
    { name: 'tray', shells: trayShells },
    ...pieceShells.map((p, i) => ({
      name: `piece-${String(i + 1).padStart(2, '0')}`,
      shells: translateShells(p.shells, dx, 0, 0),
    })),
  ];
  download(await objectsTo3MF(objects), `${svgName}.3mf`);
});

setStatus('Load an SVG (or try the sample) to generate a puzzle.');
