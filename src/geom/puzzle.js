// Core pipeline: SVG-derived geometry -> puzzle pieces + tray solids.
// DOM-free so it can run in node for tests.
import {
  union, intersect, difference, offset, strokePolylines, toRegions,
  area, bounds, translateRings, scaleRings, ringArea,
} from './clip.js';
import { mulberry32, makeJigsawGrid, chooseGrid } from './jigsaw.js';

export const DEFAULT_PARAMS = {
  targetWidth: 180,     // mm, silhouette is scaled to this width
  targetPieces: 30,
  seed: 1,
  pieceHeight: 6,       // mm, extrusion height of pieces
  gap: 0.35,            // mm, total gap between neighbouring pieces
  trayClearance: 0.25,  // mm, extra room between pieces and tray pocket wall
  baseHeight: 2.4,      // mm, tray floor under the pieces
  borderHeight: 8,      // mm, tray wall height above the floor
  borderWidth: 5,       // mm, tray wall thickness
  surfaceMode: 'engrave', // 'none' | 'engrave' | 'emboss'
  lineWidth: 1.2,       // mm, engraved/embossed line width
  lineDepth: 1.0,       // mm, groove depth / ridge height
};

// A "solid" is a list of stacked extrusion layers; each layer is a set of
// closed rings extruded from z0 to z1. Stacked layers are exported as
// separate watertight shells (slicers union touching shells).

/**
 * Normalize imported geometry: pick the silhouette, scale to target width,
 * centre on the origin.
 * input: { closed: [ring,...], open: [{pts, closed:false},...] } in
 * arbitrary SVG user units, y-up.
 */
export function normalizeInput(input, targetWidth) {
  let silhouette = input.closed.length ? union(input.closed) : [];
  const allLines = [
    ...input.closed.map((pts) => ({ pts, closed: true })),
    ...input.open,
  ];

  // Fallback for stroke-only art (outline drawn as unclosed segments):
  // fatten every line, union, and keep only the outer contours.
  const everything = allLines.flatMap((l) => l.pts);
  const bbAll = bounds([everything]);
  const diag = Math.hypot(bbAll.width, bbAll.height) || 1;
  if (!silhouette.length || area(silhouette) < 0.25 * bbAll.width * bbAll.height) {
    const fat = strokePolylines(allLines, diag * 0.01);
    const outers = toRegions(fat).map((r) => r.outer);
    const filled = outers.length ? union(outers) : [];
    if (area(filled) > area(silhouette)) silhouette = filled;
  }
  if (!silhouette.length) throw new Error('No usable outline found in the SVG.');

  // Keep only the dominant outer regions (drop stray specks < 1% of max).
  const regions = toRegions(silhouette);
  const maxA = Math.max(...regions.map((r) => Math.abs(ringArea(r.outer))));
  const kept = regions.filter((r) => Math.abs(ringArea(r.outer)) > 0.01 * maxA);
  silhouette = kept.flatMap((r) => [r.outer, ...r.holes]);

  const bb = bounds(silhouette);
  const s = targetWidth / bb.width;
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  const xf = (rings) => scaleRings(translateRings(rings, -cx, -cy), s);

  return {
    silhouette: xf(silhouette),
    lines: allLines.map((l) => ({ closed: l.closed, pts: xf([l.pts])[0] })),
  };
}

function centroidOf(rings) {
  let sx = 0, sy = 0, n = 0;
  for (const ring of rings) for (const [x, y] of ring) { sx += x; sy += y; n++; }
  return n ? [sx / n, sy / n] : [0, 0];
}

/**
 * Build the whole model.
 * @returns {{ pieces: [{rings, layers, centroid}], tray: {layers}, stats, warnings }}
 */
export function buildPuzzle(normalized, params) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const warnings = [];
  const { silhouette, lines } = normalized;
  const bb = bounds(silhouette);

  // --- cut the silhouette with the jigsaw grid ---
  const { cols, rows } = chooseGrid(bb.width, bb.height, p.targetPieces);
  const rng = mulberry32(p.seed);
  const pad = 0.5; // grid overhangs the silhouette slightly
  const grid = makeJigsawGrid(
    { minX: bb.minX - pad, minY: bb.minY - pad, maxX: bb.maxX + pad, maxY: bb.maxY + pad },
    cols, rows, rng,
  );

  // Each grid cell may intersect the silhouette in several islands; every
  // island starts life as its own fragment. Cut curves can cross each
  // other (deep knobs from different cells meeting inside a third), so
  // each cell's cut is subtracted from everything already claimed -
  // pieces are disjoint by construction.
  let fragments = [];
  const claimed = []; // verbatim rings of every fragment cut so far
  for (const cell of grid.cells) {
    let cut = intersect([cell.ring], silhouette);
    if (cut.length && claimed.length) cut = difference(cut, claimed);
    if (!cut.length) continue;
    claimed.push(...cut);
    for (const region of toRegions(cut)) {
      fragments.push({ cell: [cell.r, cell.c], rings: [region.outer, ...region.holes] });
    }
  }
  if (!fragments.length) throw new Error('Cutting produced no pieces - check the SVG outline.');

  // --- merge slivers into their best neighbour ---
  const cellArea = grid.cellW * grid.cellH;
  const minArea = 0.28 * cellArea;
  const keepMin = Math.max(4, 0.04 * cellArea); // still a viable small piece
  let guard = fragments.length * 4;
  while (guard-- > 0) {
    fragments.sort((a, b) => area(a.rings) - area(b.rings));
    const small = fragments.find((f) => !f.unmergeable && area(f.rings) < minArea);
    if (!small || fragments.length <= 1) break;
    const grown = offset(small.rings, 0.3);
    const candidates = [];
    for (const other of fragments) {
      if (other === small) continue;
      const dr = Math.abs(other.cell[0] - small.cell[0]);
      const dc = Math.abs(other.cell[1] - small.cell[1]);
      if (dr > 1 || dc > 1) continue; // same or adjacent cells only
      const overlap = area(intersect(grown, other.rings));
      if (overlap > 0) candidates.push({ other, overlap });
    }
    candidates.sort((a, b) => b.overlap - a.overlap);
    // Merge into a neighbour the fragment actually connects to. Boolean
    // rounding can leave micrometre cracks between touching fragments, so
    // when the plain union stays disconnected, retry with the sliver grown
    // slightly to bridge the crack and trim any overshoot off the others.
    let merged = false;
    for (const { other } of candidates) {
      const u = union(other.rings, small.rings);
      if (toRegions(u).length <= toRegions(other.rings).length) {
        other.rings = u;
        merged = true;
        break;
      }
      let u2 = union(other.rings, offset(small.rings, 0.02));
      if (toRegions(u2).length <= toRegions(other.rings).length) {
        const othersRings = fragments
          .filter((f) => f !== other && f !== small)
          .flatMap((f) => f.rings);
        if (othersRings.length) u2 = difference(u2, othersRings);
        if (u2.length && toRegions(u2).length <= toRegions(other.rings).length) {
          other.rings = u2;
          merged = true;
          break;
        }
      }
    }
    if (merged) {
      fragments = fragments.filter((f) => f !== small);
    } else if (area(small.rings) >= keepMin) {
      small.unmergeable = true; // keep it as a legitimately small piece
    } else {
      warnings.push('Dropped an isolated fragment too small to be a piece.');
      fragments = fragments.filter((f) => f !== small);
    }
  }

  // How much of the outline the pieces actually cover (pre-inset).
  const uncoveredMM2 = area(difference(silhouette, fragments.flatMap((f) => f.rings)));
  const silArea = area(silhouette);
  if (uncoveredMM2 > 0.005 * silArea) {
    warnings.push(`Pieces do not cover ${uncoveredMM2.toFixed(1)} mm² of the outline - try fewer pieces.`);
  }

  // --- engraving strokes, kept strictly inside the silhouette ---
  let strokes = [];
  if (p.surfaceMode !== 'none' && p.lineDepth > 0 && p.lineWidth > 0) {
    const raw = strokePolylines(lines, p.lineWidth);
    strokes = intersect(raw, offset(silhouette, -p.lineWidth));
  }

  // --- final pieces: inset for the gap, build layered solids ---
  const half = p.gap / 2;
  const H = p.pieceHeight;
  const pieces = [];
  const buildPiece = (rings) => {
    const layers = [];
    if (p.surfaceMode === 'engrave' && strokes.length) {
      const grooves = intersect(strokes, rings);
      const top = grooves.length ? difference(rings, grooves) : rings;
      const d = Math.min(p.lineDepth, H - 0.6);
      layers.push({ rings, z0: 0, z1: H - d });
      if (top.length) layers.push({ rings: top, z0: H - d, z1: H });
    } else if (p.surfaceMode === 'emboss' && strokes.length) {
      layers.push({ rings, z0: 0, z1: H });
      const ridges = intersect(strokes, offset(rings, -0.3));
      if (ridges.length) layers.push({ rings: ridges, z0: H, z1: H + p.lineDepth });
    } else {
      layers.push({ rings, z0: 0, z1: H });
    }
    pieces.push({ rings, layers, centroid: centroidOf(rings) });
  };

  for (const frag of fragments) {
    const inset = offset(frag.rings, -half);
    if (!inset.length) {
      warnings.push('Dropped a piece that vanished after the gap inset - try a smaller gap or fewer pieces.');
      continue;
    }
    // A narrow neck can snap a piece into islands under the inset. Big
    // islands become pieces of their own; only crumbs are trimmed away.
    const parts = toRegions(inset)
      .sort((a, b) => Math.abs(ringArea(b.outer)) - Math.abs(ringArea(a.outer)));
    parts.forEach((part, idx) => {
      const rings = [part.outer, ...part.holes];
      if (idx > 0 && area(rings) < keepMin) {
        warnings.push('Trimmed a tiny fragment off a piece with a very narrow neck.');
        return;
      }
      buildPiece(rings);
    });
  }
  if (!pieces.length) throw new Error('All pieces were dropped - reduce gap or piece count.');

  // --- tray ---
  const pocket = offset(silhouette, half + p.trayClearance);
  const outerWall = offset(pocket, p.borderWidth);
  const wallRing = difference(outerWall, pocket);
  const tray = {
    layers: [
      { rings: outerWall, z0: 0, z1: p.baseHeight },
      { rings: wallRing, z0: p.baseHeight, z1: p.baseHeight + p.borderHeight },
    ],
  };

  const sizeBB = bounds(outerWall);
  return {
    pieces,
    tray,
    warnings: [...new Set(warnings)],
    stats: {
      pieces: pieces.length,
      uncoveredMM2,
      cols, rows,
      widthMM: sizeBB.width,
      heightMM: sizeBB.height,
      pieceHeightMM: p.surfaceMode === 'emboss' ? H + p.lineDepth : H,
      trayHeightMM: p.baseHeight + p.borderHeight,
    },
  };
}
