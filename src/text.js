// Text -> outline rings via opentype.js. DOM-free (works in node tests).
import * as ot from '../vendor/opentype.module.js';

const opentype = ot.parse ? ot : (ot.default ?? ot);

export function parseFont(arrayBuffer) {
  return opentype.parse(arrayBuffer);
}

// Flatten one opentype path (canvas-style y-down commands) into rings,
// flipping to our y-up convention.
function pathToRings(path, curveSegs = 12) {
  const rings = [];
  let ring = null;
  let cur = [0, 0];
  const push = (x, y) => ring && ring.push([x, -y]);
  for (const c of path.commands) {
    switch (c.type) {
      case 'M':
        if (ring && ring.length >= 3) rings.push(ring);
        ring = [];
        push(c.x, c.y);
        cur = [c.x, c.y];
        break;
      case 'L':
        push(c.x, c.y);
        cur = [c.x, c.y];
        break;
      case 'C': {
        for (let i = 1; i <= curveSegs; i++) {
          const t = i / curveSegs, mt = 1 - t;
          const x = mt * mt * mt * cur[0] + 3 * mt * mt * t * c.x1 + 3 * mt * t * t * c.x2 + t * t * t * c.x;
          const y = mt * mt * mt * cur[1] + 3 * mt * mt * t * c.y1 + 3 * mt * t * t * c.y2 + t * t * t * c.y;
          push(x, y);
        }
        cur = [c.x, c.y];
        break;
      }
      case 'Q': {
        for (let i = 1; i <= curveSegs; i++) {
          const t = i / curveSegs, mt = 1 - t;
          const x = mt * mt * cur[0] + 2 * mt * t * c.x1 + t * t * c.x;
          const y = mt * mt * cur[1] + 2 * mt * t * c.y1 + t * t * c.y;
          push(x, y);
        }
        cur = [c.x, c.y];
        break;
      }
      case 'Z':
        if (ring && ring.length >= 3) rings.push(ring);
        ring = null;
        break;
    }
  }
  if (ring && ring.length >= 3) rings.push(ring);
  // drop consecutive duplicates
  return rings.map((r) => r.filter((p, i) => {
    const prev = r[(i - 1 + r.length) % r.length];
    return p[0] !== prev[0] || p[1] !== prev[1];
  })).filter((r) => r.length >= 3);
}

/**
 * @param {object} font opentype font
 * @param {string} text
 * @param {number} spacingPct extra letter spacing in % of font size
 * @returns {{closed: Array, open: Array}} same shape as parseSVG output
 */
export function textToInput(font, text, spacingPct = 8) {
  if (!text.trim()) throw new Error('Type a name first.');
  const size = 100;
  const path = font.getPath(text, 0, 0, size, {
    kerning: true,
    letterSpacing: spacingPct / 100,
  });
  const closed = pathToRings(path);
  if (!closed.length) throw new Error('The font produced no outlines for this text.');
  return { closed, open: [] };
}
