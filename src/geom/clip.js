// Thin wrapper around clipper-lib working in millimetre float coordinates.
// All public functions take/return arrays of rings: [[ [x,y], ... ], ...]
// Ring orientation is normalized by Clipper on every boolean op.
import ClipperLib from '../../vendor/clipper.esm.js';

export const SCALE = 1000; // 1 int unit = 1 micrometre

const { Clipper, ClipperOffset, PolyType, ClipType, PolyFillType, JoinType, EndType, PolyTree, Paths } = ClipperLib;

export function toClipperPath(ring) {
  const out = [];
  for (const [x, y] of ring) out.push({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) });
  return out;
}

export function toClipperPaths(rings) {
  return rings.map(toClipperPath);
}

export function fromClipperPath(path) {
  const out = [];
  for (const p of path) out.push([p.X / SCALE, p.Y / SCALE]);
  return out;
}

export function fromClipperPaths(paths) {
  return paths.map(fromClipperPath);
}

function execute(clipType, subject, clip) {
  const c = new Clipper();
  c.AddPaths(toClipperPaths(subject), PolyType.ptSubject, true);
  if (clip) c.AddPaths(toClipperPaths(clip), PolyType.ptClip, true);
  const solution = new Paths();
  c.Execute(clipType, solution, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return fromClipperPaths(cleanInt(solution));
}

// Only collapse (near-)duplicate vertices - 1 int unit = 1 micrometre.
// Anything more aggressive moves vertices, and boundaries shared between
// separately-computed results drift apart, opening hairline cracks.
function cleanInt(paths) {
  const cleaned = Clipper.CleanPolygons(paths, 1);
  return cleaned.filter((p) => p.length >= 3);
}

export function union(a, b) {
  return execute(ClipType.ctUnion, a, b);
}

export function intersect(a, b) {
  return execute(ClipType.ctIntersection, a, b);
}

export function difference(a, b) {
  return execute(ClipType.ctDifference, a, b);
}

// Offset closed polygons by delta millimetres (negative = inset).
export function offset(rings, delta, joinType = 'round') {
  if (!rings.length) return [];
  const co = new ClipperOffset(2, SCALE * 0.02);
  const jt = joinType === 'miter' ? JoinType.jtMiter : JoinType.jtRound;
  co.AddPaths(toClipperPaths(rings), jt, EndType.etClosedPolygon);
  const sol = new Paths();
  co.Execute(sol, delta * SCALE);
  return fromClipperPaths(cleanInt(sol));
}

// Turn polylines into stroke polygons of the given width.
// Each entry: { pts: [[x,y],...], closed: bool }
export function strokePolylines(lines, width) {
  if (!lines.length || width <= 0) return [];
  const co = new ClipperOffset(2, SCALE * 0.02);
  for (const line of lines) {
    if (line.pts.length < 2) continue;
    const endType = line.closed ? EndType.etClosedLine : EndType.etOpenRound;
    co.AddPath(toClipperPath(line.pts), JoinType.jtRound, endType);
  }
  const sol = new Paths();
  co.Execute(sol, (width / 2) * SCALE);
  return fromClipperPaths(cleanInt(sol));
}

// Group rings into connected regions: [{ outer, holes: [...] }, ...]
// Also splits disjoint islands into separate regions.
export function toRegions(rings) {
  if (!rings.length) return [];
  const c = new Clipper();
  c.AddPaths(toClipperPaths(rings), PolyType.ptSubject, true);
  const tree = new PolyTree();
  c.Execute(ClipType.ctUnion, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const ex = ClipperLib.JS.PolyTreeToExPolygons(tree);
  const regions = [];
  for (const e of ex) {
    if (!e.outer || e.outer.length < 3) continue;
    regions.push({
      outer: fromClipperPath(e.outer),
      holes: (e.holes || []).filter((h) => h.length >= 3).map(fromClipperPath),
    });
  }
  return regions;
}

export function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

export function area(rings) {
  let s = 0;
  for (const r of rings) s += ringArea(r);
  return Math.abs(s);
}

export function bounds(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function translateRings(rings, dx, dy) {
  return rings.map((ring) => ring.map(([x, y]) => [x + dx, y + dy]));
}

export function scaleRings(rings, s) {
  return rings.map((ring) => ring.map(([x, y]) => [x * s, y * s]));
}
