// Minimal 3MF writer, no dependencies. A 3MF file is a zip archive
// containing an XML mesh model; each input group becomes a separate
// named object so slicers show "tray", "piece-01", ... individually.
// Uses CompressionStream (deflate) when available, stored entries otherwise.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const ab = await new Response(
      new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer();
    return new Uint8Array(ab);
  } catch {
    return null;
  }
}

const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed valid date

async function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();

  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name);
    const comp = await deflateRaw(data);
    const useDeflate = comp && comp.length < data.length;
    const payload = useDeflate ? comp : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const lfh = new DataView(new ArrayBuffer(30));
    lfh.setUint32(0, 0x04034b50, true);
    lfh.setUint16(4, 20, true);          // version needed
    lfh.setUint16(6, 0, true);           // flags
    lfh.setUint16(8, method, true);
    lfh.setUint16(10, 0, true);          // mod time
    lfh.setUint16(12, DOS_DATE, true);   // mod date
    lfh.setUint32(14, crc, true);
    lfh.setUint32(18, payload.length, true);
    lfh.setUint32(22, data.length, true);
    lfh.setUint16(26, name.length, true);
    lfh.setUint16(28, 0, true);          // extra length

    central.push({ name, method, crc, compSize: payload.length, size: data.length, offset });
    chunks.push(new Uint8Array(lfh.buffer), name, payload);
    offset += 30 + name.length + payload.length;
  }

  const cdStart = offset;
  for (const e of central) {
    const cdh = new DataView(new ArrayBuffer(46));
    cdh.setUint32(0, 0x02014b50, true);
    cdh.setUint16(4, 20, true);          // version made by
    cdh.setUint16(6, 20, true);          // version needed
    cdh.setUint16(8, 0, true);
    cdh.setUint16(10, e.method, true);
    cdh.setUint16(12, 0, true);
    cdh.setUint16(14, DOS_DATE, true);
    cdh.setUint32(16, e.crc, true);
    cdh.setUint32(20, e.compSize, true);
    cdh.setUint32(24, e.size, true);
    cdh.setUint16(28, e.name.length, true);
    cdh.setUint32(42, e.offset, true);
    chunks.push(new Uint8Array(cdh.buffer), e.name);
    offset += 46 + e.name.length;
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, offset - cdStart, true);
  eocd.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(eocd.buffer));

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out.buffer;
}

const fmt = (v) => {
  const s = v.toFixed(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

function objectXML(id, name, shells) {
  const vertMap = new Map();
  const verts = [];
  const tris = [];
  const indexOf = (x, y, z) => {
    const key = `${x}|${y}|${z}`;
    let idx = vertMap.get(key);
    if (idx === undefined) {
      idx = verts.length;
      verts.push(`<vertex x="${fmt(x)}" y="${fmt(y)}" z="${fmt(z)}"/>`);
      vertMap.set(key, idx);
    }
    return idx;
  };
  for (const shell of shells) {
    for (let i = 0; i < shell.length; i += 9) {
      const a = indexOf(shell[i], shell[i + 1], shell[i + 2]);
      const b = indexOf(shell[i + 3], shell[i + 4], shell[i + 5]);
      const c = indexOf(shell[i + 6], shell[i + 7], shell[i + 8]);
      if (a === b || b === c || c === a) continue;
      tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
  }
  return `<object id="${id}" type="model" name="${name}"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`;
}

/**
 * @param {Array<{name: string, shells: Float32Array[]}>} objects
 * @returns {Promise<ArrayBuffer>} .3mf file contents
 */
export async function objectsTo3MF(objects) {
  const parts = [];
  const items = [];
  objects.forEach((obj, i) => {
    const id = i + 1;
    parts.push(objectXML(id, obj.name, obj.shells));
    items.push(`<item objectid="${id}"/>`);
  });
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
    `<resources>${parts.join('\n')}</resources>\n` +
    `<build>${items.join('')}</build>\n</model>`;

  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
        '</Relationships>',
    },
    { name: '3D/3dmodel.model', data: model },
  ]);
}
