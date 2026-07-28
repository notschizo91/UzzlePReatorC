// Face extraction: the enclosed regions of a piece of line art.
//
// The drawn lines (strokes and closed shape boundaries) are fattened into
// polygons and subtracted from the silhouette. Whatever is left splits
// into connected faces - exactly the areas a colouring page invites you
// to fill in, and the surfaces the user picks to raise.
import {
  intersect, difference, strokePolylines, toRegions, area,
} from './clip.js';

function centroidOf(rings) {
  let sx = 0, sy = 0, n = 0;
  for (const ring of rings) for (const [x, y] of ring) { sx += x; sy += y; n++; }
  return n ? [sx / n, sy / n] : [0, 0];
}

/**
 * @param {{silhouette, lines}} normalized output of normalizeInput
 * @param {number} lineWidth mm, how wide the separating lines are
 * @returns {Array<{rings, area, centroid}>} faces, largest first
 */
export function extractFaces(normalized, lineWidth = 1.2) {
  const { silhouette, lines } = normalized;
  const silArea = area(silhouette);
  if (!silArea) return [];

  const strokes = lines.length
    ? intersect(strokePolylines(lines, lineWidth), silhouette)
    : [];
  const open = strokes.length ? difference(silhouette, strokes) : silhouette;

  const minArea = Math.max(1, 0.0004 * silArea); // drop specks
  const faces = [];
  for (const region of toRegions(open)) {
    const rings = [region.outer, ...region.holes];
    const a = area(rings);
    if (a < minArea) continue;
    faces.push({ rings, area: a, centroid: centroidOf(rings) });
  }
  // Deterministic order (largest first) keeps face indices stable across
  // re-extractions, so saved heights still line up.
  faces.sort((a, b) => b.area - a.area);
  return faces;
}
