// Browser-side SVG import: parses an SVG document and samples every
// geometry element into polylines (y flipped to y-up math coordinates).
// Paths are split into subpaths with a small absolute-command parser so
// each subpath can be sampled separately via getTotalLength/getPointAtLength.

const CMD_PARAMS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

// Parse a path "d" string into absolute-command subpaths.
// Returns [{ d: 'M...' , closed: bool }]
export function splitSubpaths(d) {
  let i = 0;
  const n = d.length;
  const isWS = (ch) => ch === ' ' || ch === ',' || ch === '\t' || ch === '\n' || ch === '\r';
  const skipWS = () => { while (i < n && isWS(d[i])) i++; };
  const isDigit = (ch) => ch >= '0' && ch <= '9';

  function readNumber() {
    skipWS();
    const s = i;
    if (d[i] === '+' || d[i] === '-') i++;
    while (i < n && isDigit(d[i])) i++;
    if (d[i] === '.') { i++; while (i < n && isDigit(d[i])) i++; }
    if (d[i] === 'e' || d[i] === 'E') {
      i++;
      if (d[i] === '+' || d[i] === '-') i++;
      while (i < n && isDigit(d[i])) i++;
    }
    if (i === s || (i === s + 1 && !isDigit(d[s]) && d[s] !== '.')) return null;
    return parseFloat(d.slice(s, i));
  }
  function readFlag() {
    skipWS();
    if (d[i] === '0' || d[i] === '1') return d[i++] === '1' ? 1 : 0;
    return null;
  }

  const subpaths = [];
  let cmds = [];
  let cur = [0, 0];
  let start = [0, 0];
  let lastCmd = null;

  function flush(closed) {
    if (cmds.length > 1) subpaths.push({ d: cmds.join(' '), closed });
    cmds = [];
  }

  while (i < n) {
    skipWS();
    if (i >= n) break;
    const ch = d[i];
    let cmd;
    if (/[a-zA-Z]/.test(ch)) { cmd = ch; i++; } else {
      if (lastCmd === null) break; // malformed
      // implicit repeat; M/m repeats as L/l
      cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd;
    }
    lastCmd = cmd;
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper && upper !== 'Z';
    const count = CMD_PARAMS[upper];
    if (count === undefined) break; // unknown command: stop parsing

    if (upper === 'Z') {
      flush(true);
      cur = start.slice();
      continue;
    }

    const nums = [];
    let bad = false;
    if (upper === 'A') {
      const rx = readNumber(), ry = readNumber(), rot = readNumber();
      const laf = readFlag(), swf = readFlag();
      const x = readNumber(), y = readNumber();
      if ([rx, ry, rot, laf, swf, x, y].some((v) => v === null)) bad = true;
      else nums.push(rx, ry, rot, laf, swf, x, y);
    } else {
      for (let k = 0; k < count; k++) {
        const v = readNumber();
        if (v === null) { bad = true; break; }
        nums.push(v);
      }
    }
    if (bad) break;

    if (upper === 'M') {
      flush(false);
      const x = rel ? cur[0] + nums[0] : nums[0];
      const y = rel ? cur[1] + nums[1] : nums[1];
      cur = [x, y];
      start = [x, y];
      cmds.push(`M ${x} ${y}`);
      continue;
    }
    if (!cmds.length) cmds.push(`M ${cur[0]} ${cur[1]}`); // drawing after Z

    switch (upper) {
      case 'L': {
        const x = rel ? cur[0] + nums[0] : nums[0];
        const y = rel ? cur[1] + nums[1] : nums[1];
        cur = [x, y];
        cmds.push(`L ${x} ${y}`);
        break;
      }
      case 'H': {
        const x = rel ? cur[0] + nums[0] : nums[0];
        cur = [x, cur[1]];
        cmds.push(`L ${x} ${cur[1]}`);
        break;
      }
      case 'V': {
        const y = rel ? cur[1] + nums[0] : nums[0];
        cur = [cur[0], y];
        cmds.push(`L ${cur[0]} ${y}`);
        break;
      }
      case 'C': {
        const p = rel ? nums.map((v, k) => v + cur[k % 2]) : nums;
        cur = [p[4], p[5]];
        cmds.push(`C ${p.join(' ')}`);
        break;
      }
      case 'S': {
        const p = rel ? nums.map((v, k) => v + cur[k % 2]) : nums;
        cur = [p[2], p[3]];
        cmds.push(`S ${p.join(' ')}`);
        break;
      }
      case 'Q': {
        const p = rel ? nums.map((v, k) => v + cur[k % 2]) : nums;
        cur = [p[2], p[3]];
        cmds.push(`Q ${p.join(' ')}`);
        break;
      }
      case 'T': {
        const x = rel ? cur[0] + nums[0] : nums[0];
        const y = rel ? cur[1] + nums[1] : nums[1];
        cur = [x, y];
        cmds.push(`T ${x} ${y}`);
        break;
      }
      case 'A': {
        const x = rel ? cur[0] + nums[5] : nums[5];
        const y = rel ? cur[1] + nums[6] : nums[6];
        cmds.push(`A ${nums[0]} ${nums[1]} ${nums[2]} ${nums[3]} ${nums[4]} ${x} ${y}`);
        cur = [x, y];
        break;
      }
    }
  }
  flush(false);
  return subpaths;
}

function samplePathElement(el, count) {
  const len = el.getTotalLength();
  if (!(len > 0)) return null;
  const pts = [];
  for (let k = 0; k <= count; k++) {
    const p = el.getPointAtLength((k / count) * len);
    pts.push([p.x, p.y]);
  }
  return pts;
}

function applyMatrix(pts, m) {
  return pts.map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
}

/**
 * @param {string} svgText
 * @returns {{ closed: Array<ring>, open: Array<{pts, closed:false}> }}
 *          coordinates in root user units, y-up.
 */
export function parseSVG(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('Not a valid SVG file.');
  const src = doc.documentElement;
  if (src.nodeName.toLowerCase() !== 'svg') throw new Error('Not an SVG document.');

  // Render off-screen so CTMs and lengths are available.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1000px;height:1000px;visibility:hidden;';
  const svg = document.importNode(src, true);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('width', '1000');
  svg.setAttribute('height', '1000');
  host.appendChild(svg);
  // Scratch svg for sampling isolated subpaths in local coordinates.
  const scratch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const scratchPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  scratch.appendChild(scratchPath);
  host.appendChild(scratch);
  document.body.appendChild(host);

  try {
    const rootCTM = svg.getScreenCTM();
    if (!rootCTM) throw new Error('Could not measure the SVG.');
    const rootInv = rootCTM.inverse();

    let diag = 100;
    try {
      const bb = svg.getBBox();
      diag = Math.hypot(bb.width, bb.height) || 100;
    } catch { /* keep default */ }
    const samplesFor = (len) => Math.max(16, Math.min(900, Math.ceil((len / diag) * 400)));
    const closeTol = diag / 200;

    const closed = [];
    const open = [];
    const els = svg.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line');
    for (const el of els) {
      if (el.closest('defs, clipPath, mask, symbol, marker, pattern')) continue;
      const elCTM = el.getScreenCTM();
      if (!elCTM) continue;
      const m = rootInv.multiply(elCTM);
      const tag = el.nodeName.toLowerCase();

      const emit = (pts, isClosed) => {
        if (!pts || pts.length < 2) return;
        const flipped = applyMatrix(pts, m).map(([x, y]) => [x, -y]);
        const first = flipped[0], last = flipped[flipped.length - 1];
        const nearlyClosed = Math.hypot(first[0] - last[0], first[1] - last[1]) < closeTol;
        if (isClosed || nearlyClosed) {
          if (nearlyClosed) flipped.pop();
          if (flipped.length >= 3) closed.push(flipped);
        } else {
          open.push({ pts: flipped, closed: false });
        }
      };

      if (tag === 'path') {
        const dAttr = el.getAttribute('d') || '';
        for (const sub of splitSubpaths(dAttr)) {
          scratchPath.setAttribute('d', sub.d);
          let len = 0;
          try { len = scratchPath.getTotalLength(); } catch { continue; }
          if (!(len > 0)) continue;
          emit(samplePathElement(scratchPath, samplesFor(len)), sub.closed);
        }
      } else {
        let len = 0;
        try { len = el.getTotalLength(); } catch { continue; }
        if (!(len > 0)) continue;
        const isClosed = tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'polygon';
        emit(samplePathElement(el, samplesFor(len)), isClosed);
      }
    }
    if (!closed.length && !open.length) throw new Error('No drawable geometry found in the SVG.');
    return { closed, open };
  } finally {
    host.remove();
  }
}
