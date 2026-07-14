// Traditional jigsaw grid generator.
// Produces a cols x rows grid of interlocking cell polygons covering a
// bounding box. Interior edges carry a classic randomized knob/tab curve;
// neighbouring cells share the exact same edge polyline so cuts line up.

// Deterministic PRNG so a seed reproduces the same puzzle.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleCubic(p0, c1, c2, p1, segments, out) {
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    out.push([
      a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
      a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
    ]);
  }
}

// Classic jigsaw tab curve (after Draradech's generator): three cubic
// Beziers in edge-local coordinates, x along the edge [0..1], y
// perpendicular, then mapped onto the segment A->B.
function tabEdge(A, B, rng, tabSize, jitter) {
  const dx = B[0] - A[0], dy = B[1] - A[1];
  const L = Math.hypot(dx, dy);
  const ux = dx / L, uy = dy / L;
  const flip = rng() < 0.5 ? 1 : -1;
  const nx = -uy * flip, ny = ux * flip;

  const j = () => (rng() * 2 - 1) * jitter;
  const t = tabSize;
  const a = j(), b = j(), c = j(), d = j(), e = j();

  const p0 = [0, 0];
  const p1 = [0.2, a];
  const p2 = [0.5 + b + d, -t + c];
  const p3 = [0.5 - t + b, t + c];
  const p4 = [0.5 - 2 * t + b - d, 3 * t + c];
  const p5 = [0.5 + 2 * t + b - d, 3 * t + c];
  const p6 = [0.5 + t + b, t + c];
  const p7 = [0.5 + b + d, -t + c];
  const p8 = [0.8, e];
  const p9 = [1, 0];

  const local = [p0];
  sampleCubic(p0, p1, p2, p3, 12, local);
  sampleCubic(p3, p4, p5, p6, 14, local);
  sampleCubic(p6, p7, p8, p9, 12, local);

  return local.map(([x, y]) => [A[0] + ux * (x * L) + nx * (y * L), A[1] + uy * (x * L) + ny * (y * L)]);
}

function straightEdge(A, B) {
  return [A.slice(), B.slice()];
}

function appendEdge(ring, edge, reverse) {
  const pts = reverse ? edge.slice().reverse() : edge;
  for (const p of pts) {
    const last = ring[ring.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    ring.push(p);
  }
}

/**
 * Build the interlocking grid.
 * @param {object} bbox {minX, minY, maxX, maxY}
 * @param {number} cols
 * @param {number} rows
 * @param {function} rng
 * @returns {{cells: Array<{r:number,c:number,ring:Array}>, cellW:number, cellH:number}}
 */
export function makeJigsawGrid(bbox, cols, rows, rng, { tabSize = 0.2, jitter = 0.04 } = {}) {
  const cellW = (bbox.maxX - bbox.minX) / cols;
  const cellH = (bbox.maxY - bbox.minY) / rows;
  const X = (c) => bbox.minX + c * cellW;
  const Y = (r) => bbox.maxY - r * cellH; // row 0 at top

  // Horizontal boundaries: hEdges[r][c] runs left->right along y = Y(r).
  const hEdges = [];
  for (let r = 0; r <= rows; r++) {
    hEdges[r] = [];
    for (let c = 0; c < cols; c++) {
      const A = [X(c), Y(r)], B = [X(c + 1), Y(r)];
      hEdges[r][c] = (r === 0 || r === rows) ? straightEdge(A, B) : tabEdge(A, B, rng, tabSize, jitter);
    }
  }
  // Vertical boundaries: vEdges[r][k] runs top->bottom along x = X(k).
  const vEdges = [];
  for (let r = 0; r < rows; r++) {
    vEdges[r] = [];
    for (let k = 0; k <= cols; k++) {
      const A = [X(k), Y(r)], B = [X(k), Y(r + 1)];
      vEdges[r][k] = (k === 0 || k === cols) ? straightEdge(A, B) : tabEdge(A, B, rng, tabSize, jitter);
    }
  }

  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ring = [];
      appendEdge(ring, hEdges[r][c], false);      // top, left -> right
      appendEdge(ring, vEdges[r][c + 1], false);  // right, top -> bottom
      appendEdge(ring, hEdges[r + 1][c], true);   // bottom, right -> left
      appendEdge(ring, vEdges[r][c], true);       // left, bottom -> top
      // drop duplicated closing point if present
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) ring.pop();
      cells.push({ r, c, ring });
    }
  }
  return { cells, cellW, cellH };
}

// Choose a grid size whose cells are roughly square for a target piece count.
export function chooseGrid(width, height, targetPieces) {
  const n = Math.max(2, targetPieces);
  let cols = Math.max(1, Math.round(Math.sqrt(n * (width / height))));
  let rows = Math.max(1, Math.round(n / cols));
  if (cols === 1 && rows === 1) rows = 2;
  return { cols, rows };
}
