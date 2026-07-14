// three.js viewer: tray + coloured pieces with an explode slider.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

function shellsToGeometry(shells) {
  let total = 0;
  for (const s of shells) total += s.length;
  const positions = new Float32Array(total);
  let off = 0;
  for (const s of shells) { positions.set(s, off); off += s.length; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x16181d);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -160, 140);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x30343c, 1.1);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(120, -80, 200);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xaabbff, 0.4);
    dir2.position.set(-100, 60, 80);
    this.scene.add(dir2);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.pieceMeshes = [];
    this.explode = 0;
    this.pieceHeight = 6;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
    const h = this.canvas.clientHeight || this.canvas.parentElement.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
    this.pieceMeshes = [];
  }

  /**
   * @param {Array<{shells: Float32Array[], centroid:[number,number]}>} pieces
   * @param {Float32Array[]} trayShells
   * @param {{pieceHeight:number, baseHeight:number, size:number}} info
   */
  setModel(pieces, trayShells, info) {
    this.clear();
    this.pieceHeight = info.pieceHeight;

    const tray = new THREE.Mesh(
      shellsToGeometry(trayShells),
      new THREE.MeshStandardMaterial({ color: 0x878e99, roughness: 0.75, metalness: 0.05 }),
    );
    this.group.add(tray);

    pieces.forEach((piece, i) => {
      const color = new THREE.Color().setHSL(((i * 137.508) % 360) / 360, 0.62, 0.62);
      const mesh = new THREE.Mesh(
        shellsToGeometry(piece.shells),
        new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.02 }),
      );
      mesh.userData.centroid = piece.centroid;
      // pieces rest on the tray floor
      mesh.userData.restZ = info.baseHeight;
      this.group.add(mesh);
      this.pieceMeshes.push(mesh);
    });
    this.applyExplode();

    const dist = Math.max(120, info.size * 1.6);
    this.camera.position.set(dist * 0.45, -dist * 0.85, dist * 0.8);
    this.controls.target.set(0, 0, 0);
  }

  setExplode(t) {
    this.explode = t;
    this.applyExplode();
  }

  applyExplode() {
    const t = this.explode;
    for (const mesh of this.pieceMeshes) {
      const [cx, cy] = mesh.userData.centroid;
      mesh.position.set(cx * 0.35 * t, cy * 0.35 * t, mesh.userData.restZ + t * (this.pieceHeight * 2.5 + 10));
    }
  }
}
