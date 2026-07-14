// Binary STL writer. Takes a list of triangle shells (Float32Array of
// xyz triples, 9 floats per triangle) and returns one STL ArrayBuffer.
export function shellsToSTL(shells, name = 'puzzle') {
  let triCount = 0;
  for (const s of shells) triCount += s.length / 9;

  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = `binary stl - ${name}`.slice(0, 80);
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, triCount, true);

  let off = 84;
  for (const s of shells) {
    for (let i = 0; i < s.length; i += 9) {
      const ax = s[i], ay = s[i + 1], az = s[i + 2];
      const bx = s[i + 3], by = s[i + 4], bz = s[i + 5];
      const cx = s[i + 6], cy = s[i + 7], cz = s[i + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      view.setFloat32(off, nx, true);
      view.setFloat32(off + 4, ny, true);
      view.setFloat32(off + 8, nz, true);
      const pts = [ax, ay, az, bx, by, bz, cx, cy, cz];
      for (let k = 0; k < 9; k++) view.setFloat32(off + 12 + k * 4, pts[k], true);
      view.setUint16(off + 48, 0, true);
      off += 50;
    }
  }
  return buffer;
}
