// Full-screen overlay for picking which faces of the artwork get raised
// and how high. Faces are drawn as clickable SVG paths in millimetre
// coordinates (y flipped for screen space).

const SVG_NS = 'http://www.w3.org/2000/svg';

function ringsToPathData(rings) {
  let d = '';
  for (const ring of rings) {
    if (ring.length < 3) continue;
    d += `M ${ring[0][0].toFixed(3)} ${ring[0][1].toFixed(3)}`;
    for (let i = 1; i < ring.length; i++) d += ` L ${ring[i][0].toFixed(3)} ${ring[i][1].toFixed(3)}`;
    d += ' Z';
  }
  return d;
}

export class SurfacePicker {
  constructor() {
    this.root = null;
    this.onApply = null;
  }

  /**
   * @param {Array} faces from extractFaces
   * @param {number[]} heights current per-face height (mm), 0 = flat
   * @param {string} title shown top-left
   * @param {number} defaultHeight prefill for the height field
   * @returns {Promise<number[]|null>} new heights, or null if cancelled
   */
  open(faces, heights, title, defaultHeight = 2) {
    this.close();
    const working = faces.map((_, i) => heights[i] || 0);
    const selected = new Set();

    return new Promise((resolve) => {
      const root = document.createElement('div');
      root.className = 'picker';
      this.root = root;

      // --- toolbar ---
      const bar = document.createElement('div');
      bar.className = 'picker-bar';
      const label = document.createElement('div');
      label.className = 'picker-title';
      const btns = document.createElement('div');
      btns.className = 'picker-btns';

      const mkBtn = (text, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        if (cls) b.className = cls;
        btns.appendChild(b);
        return b;
      };

      const heightWrap = document.createElement('label');
      heightWrap.className = 'picker-height';
      heightWrap.textContent = 'Raise (mm)';
      const heightInput = document.createElement('input');
      heightInput.type = 'number';
      heightInput.step = '0.2';
      heightInput.min = '0';
      heightInput.value = String(defaultHeight);
      heightWrap.appendChild(heightInput);
      btns.appendChild(heightWrap);

      const applyBtn = mkBtn('Apply to selected', 'primary-ghost');
      const allBtn = mkBtn('All');
      const noneBtn = mkBtn('None');
      const invBtn = mkBtn('Invert');
      const autoBtn = mkBtn('Auto');
      const cancelBtn = mkBtn('✕ Cancel');
      const doneBtn = mkBtn('✓ Done', 'primary');

      bar.append(label, btns);

      // --- svg canvas ---
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const f of faces) {
        for (const ring of f.rings) {
          for (const [x, y] of ring) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      const pad = Math.max(4, (maxX - minX) * 0.04);
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'picker-svg');
      // y is flipped by the group transform, so the viewBox uses -maxY
      svg.setAttribute('viewBox',
        `${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`);
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', 'scale(1,-1)');
      svg.appendChild(g);

      const paths = faces.map((face, i) => {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', ringsToPathData(face.rings));
        path.setAttribute('class', 'face');
        path.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selected.has(i)) selected.delete(i); else selected.add(i);
          render();
        });
        g.appendChild(path);
        return path;
      });

      const hint = document.createElement('div');
      hint.className = 'picker-hint';
      hint.textContent =
        'Click surfaces to select · set a height and Apply · repeat for different heights (eyes 2 mm, horn 4 mm …)';

      root.append(bar, svg, hint);
      document.body.appendChild(root);

      const maxH = () => Math.max(1, ...working);
      function render() {
        let raisedCount = 0;
        faces.forEach((_, i) => {
          const h = working[i];
          const isSel = selected.has(i);
          if (h > 0) raisedCount++;
          const path = paths[i];
          path.classList.toggle('sel', isSel);
          path.classList.toggle('raised', h > 0);
          // brighter with height so different levels are distinguishable
          const t = h > 0 ? 0.35 + 0.65 * (h / maxH()) : 0;
          path.style.setProperty('--lvl', t.toFixed(3));
          path.setAttribute('title', h > 0 ? `${h} mm` : 'flat');
        });
        label.textContent =
          `${title} — click surfaces to raise (${selected.size} selected · ${raisedCount} of ${faces.length} raised)`;
      }

      const finish = (result) => {
        this.close();
        resolve(result);
      };

      applyBtn.addEventListener('click', () => {
        const h = Math.max(0, parseFloat(heightInput.value) || 0);
        for (const i of selected) working[i] = h;
        selected.clear();
        render();
      });
      allBtn.addEventListener('click', () => {
        faces.forEach((_, i) => selected.add(i));
        render();
      });
      noneBtn.addEventListener('click', () => { selected.clear(); render(); });
      invBtn.addEventListener('click', () => {
        faces.forEach((_, i) => (selected.has(i) ? selected.delete(i) : selected.add(i)));
        render();
      });
      autoBtn.addEventListener('click', () => {
        // everything except the largest face (usually the body/background)
        selected.clear();
        faces.forEach((_, i) => { if (i > 0 || faces.length === 1) selected.add(i); });
        render();
      });
      cancelBtn.addEventListener('click', () => finish(null));
      doneBtn.addEventListener('click', () => {
        // apply pending selection so a click+Done does the obvious thing
        if (selected.size) {
          const h = Math.max(0, parseFloat(heightInput.value) || 0);
          for (const i of selected) working[i] = h;
        }
        finish(working);
      });
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') finish(null);
      });
      document.addEventListener('keydown', this._esc = (e) => {
        if (e.key === 'Escape' && this.root) finish(null);
      });

      render();
      root.tabIndex = -1;
      root.focus();
    });
  }

  close() {
    if (this._esc) { document.removeEventListener('keydown', this._esc); this._esc = null; }
    if (this.root) { this.root.remove(); this.root = null; }
  }
}
