// Turn layered 2D solids into watertight triangle shells.
// Every (layer, connected-region) pair becomes one closed shell:
// top cap, bottom cap, and vertical walls. Stacked shells touch face to
// face, which slicers merge when slicing.
//
// Walls are generated from the *boundary edges of the cap triangulation*
// (directed edges with no partner), not from the input rings. That keeps
// caps and walls consistent even when clipper emits self-touching or
// slightly degenerate rings, so shells stay watertight by construction.
import earcut from '../../vendor/earcut.esm.js';
import { toRegions, ringArea } from './clip.js';

function orientRing(ring, ccw) {
  const a = ringArea(ring);
  if ((a > 0) !== ccw) return ring.slice().reverse();
  return ring;
}

// Remove consecutive duplicates and zero-width spikes (a -> b -> a).
function cleanRing(ring) {
  let pts = ring;
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      if (cur[0] === next[0] && cur[1] === next[1]) { changed = true; continue; }
      if (prev[0] === next[0] && prev[1] === next[1]) { changed = true; continue; }
      out.push(cur);
    }
    pts = out;
  }
  return pts.length >= 3 ? pts : null;
}

function regionShell(region, z0, z1) {
  const outer = cleanRing(orientRing(region.outer, true));
  if (!outer) return null;
  const holes = region.holes
    .map((h) => cleanRing(orientRing(h, false)))
    .filter(Boolean);

  const verts = [];
  const holeIdx = [];
  for (const [x, y] of outer) verts.push(x, y);
  for (const h of holes) {
    holeIdx.push(verts.length / 2);
    for (const [x, y] of h) verts.push(x, y);
  }
  const idx = earcut(verts, holeIdx.length ? holeIdx : null, 2);
  if (!idx.length) return null;

  // Collect directed edges of the cap triangulation, skipping degenerate
  // triangles (repeated vertex or zero area).
  const tris = [];
  const edgeCount = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a === b || b === c || c === a) continue;
    const ax = verts[a * 2], ay = verts[a * 2 + 1];
    const bx = verts[b * 2], by = verts[b * 2 + 1];
    const cx = verts[c * 2], cy = verts[c * 2 + 1];
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) === 0) continue;
    tris.push(a, b, c);
    edgeCount.set(a * 1048576 + b, (edgeCount.get(a * 1048576 + b) || 0) + 1);
    edgeCount.set(b * 1048576 + c, (edgeCount.get(b * 1048576 + c) || 0) + 1);
    edgeCount.set(c * 1048576 + a, (edgeCount.get(c * 1048576 + a) || 0) + 1);
  }
  if (!tris.length) return null;

  const out = [];
  const push = (x, y, z) => out.push(x, y, z);

  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 2, b = tris[i + 1] * 2, c = tris[i + 2] * 2;
    // top cap, +Z normal (earcut follows the CCW outer ring winding)
    push(verts[a], verts[a + 1], z1); push(verts[b], verts[b + 1], z1); push(verts[c], verts[c + 1], z1);
    // bottom cap, reversed for -Z normal
    push(verts[a], verts[a + 1], z0); push(verts[c], verts[c + 1], z0); push(verts[b], verts[b + 1], z0);
  }

  // Walls: every directed edge whose exact reverse is missing is a
  // boundary edge. Net multiplicity handles edges that earcut duplicates.
  for (const [k, count] of edgeCount) {
    const a = Math.floor(k / 1048576), b = k % 1048576;
    const rev = (edgeCount.get(b * 1048576 + a) || 0);
    if (rev > 0 && a > b) continue; // pair already handled at its a<b key
    const net = count - rev; // >0: boundary traversed a->b, <0: b->a
    if (net === 0) continue;
    const [fa, fb] = net > 0 ? [a, b] : [b, a];
    const n = Math.abs(net);
    for (let rep = 0; rep < n; rep++) {
      const ax = verts[fa * 2], ay = verts[fa * 2 + 1];
      const bx = verts[fb * 2], by = verts[fb * 2 + 1];
      // boundary runs a->b along the top cap: outward-facing wall
      push(ax, ay, z0); push(bx, by, z0); push(bx, by, z1);
      push(ax, ay, z0); push(bx, by, z1); push(ax, ay, z1);
    }
  }
  return new Float32Array(out);
}

/**
 * @param {Array<{rings, z0, z1}>} layers
 * @returns {Float32Array[]} one closed triangle shell per layer-region
 */
export function solidToShells(layers) {
  const shells = [];
  for (const layer of layers) {
    if (layer.z1 - layer.z0 <= 0) continue;
    for (const region of toRegions(layer.rings)) {
      const shell = regionShell(region, layer.z0, layer.z1);
      if (shell) shells.push(shell);
    }
  }
  return shells;
}

export function shellVolume(shell) {
  let v = 0;
  for (let i = 0; i < shell.length; i += 9) {
    const ax = shell[i], ay = shell[i + 1], az = shell[i + 2];
    const bx = shell[i + 3], by = shell[i + 4], bz = shell[i + 5];
    const cx = shell[i + 6], cy = shell[i + 7], cz = shell[i + 8];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

export function translateShells(shells, dx, dy, dz) {
  return shells.map((s) => {
    const t = new Float32Array(s.length);
    for (let i = 0; i < s.length; i += 3) {
      t[i] = s[i] + dx;
      t[i + 1] = s[i + 1] + dy;
      t[i + 2] = s[i + 2] + dz;
    }
    return t;
  });
}
