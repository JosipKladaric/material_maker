import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161a);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.position.set(2.2, 1.6, 2.6);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    // Left orbits by default; the painter disables controls mid-stroke (or skips when
    // Alt / orbit tool is used) so painting and orbiting share the button.
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;

    this.key = new THREE.DirectionalLight(0xffffff, 1.2);
    this.key.position.set(3, 5, 2);
    this.scene.add(this.key, new THREE.AmbientLight(0xffffff, 0.15));

    this.grid = new THREE.GridHelper(6, 24, 0x333a46, 0x22262e);
    this.scene.add(this.grid);

    this.mesh = null;
    this.solo = 'pbr';
    this.maps = {}; // {albedo, normal, roughness, metalness, ao, curvature, id, position}
    this._liveTextures = [];
    this.uvChecker = makeCheckerTexture();
    this.mat = new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.6, metalness: 0.0 });
    this.wireMat = new THREE.MeshBasicMaterial({ wireframe: true, color: 0xe8b34b });

    const soloSel = document.getElementById('soloView');
    if (soloSel) soloSel.addEventListener('change', () => this.setSolo(soloSel.value));

    this.resize();
    addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => { this.controls.update(); this.renderer.render(this.scene, this.camera); });
  }
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
  }
  setSolo(mode) {
    this.solo = mode;
    const s = document.getElementById('soloView');
    if (s && s.value !== mode) s.value = mode;
    this.refreshMaterial();
  }
  setMesh(obj) {
    if (this.mesh) { this.scene.remove(this.mesh); disposeObj(this.mesh); }
    this.mesh = obj;
    this.scene.add(obj);
    // frame
    const box = new THREE.Box3().setFromObject(obj);
    const c = box.getCenter(new THREE.Vector3());
    const sz = box.getSize(new THREE.Vector3()).length() || 2;
    this.controls.target.copy(c);
    const d = sz * 1.4;
    this.camera.position.set(c.x + d * 0.6, c.y + d * 0.45, c.z + d * 0.7);
    this.camera.near = d / 100; this.camera.far = d * 50;
    this.camera.updateProjectionMatrix();
    const tri = countTris(obj);
    const el = document.getElementById('triCount');
    if (el) el.textContent = tri.toLocaleString() + ' tris';
    this.refreshMaterial();
  }
  setEnvIntensity(v) { this.scene.environmentIntensity = v; this.key.intensity = v * 1.2; }
  updateMaps(maps) { this.maps = maps; this.refreshMaterial(); }
  refreshMaterial() {
    if (!this.mesh) return;
    // Dispose textures from the previous composite — painting creates a new set per
    // stroke and would otherwise leak GPU memory within minutes.
    for (const tx of this._liveTextures) tx.dispose();
    this._liveTextures = [];
    const t = (cv, srgb, def) => {
      if (!cv) return def ?? null;
      const tx = new THREE.CanvasTexture(cv);
      if (srgb) tx.colorSpace = THREE.SRGBColorSpace;
      // Canvas convention: top row = v=1. Default flipY=true keeps bake/paint/viewport/export consistent.
      tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
      tx.anisotropy = 4;
      this._liveTextures.push(tx);
      return tx;
    };
    this.mesh.traverse(o => {
      if (!o.isMesh) return;
      if (this.solo === 'wire') { o.material = this.wireMat; return; }
      const m = o.material && o.material.isMeshStandardMaterial ? o.material : new THREE.MeshStandardMaterial();
      const albedo = t(this.maps.albedo, true, null);
      const normal = t(this.maps.normal, false, null);
      const rough = t(this.maps.roughness, false, null);
      const metal = t(this.maps.metalness, false, null);
      const ao = t(this.maps.ao, false, null);
      const curv = t(this.maps.curvature, false, null);
      const idm = t(this.maps.id, true, null);
      const posm = t(this.maps.position, false, null);
      m.map = null; m.normalMap = null; m.roughnessMap = null; m.metalnessMap = null; m.aoMap = null;
      m.color.set(0xffffff); m.roughness = 1; m.metalness = 1;
      if (this.solo === 'pbr') {
        if (albedo) m.map = albedo;
        else m.color.set(0x8a8f98);
        if (normal) m.normalMap = normal;
        if (rough) { m.roughnessMap = rough; m.roughness = 1; } else m.roughness = 0.55;
        if (metal) { m.metalnessMap = metal; m.metalness = 1; } else m.metalness = 0.05;
        if (ao) { m.aoMap = ao; m.aoMapIntensity = 1; }
      } else if (this.solo === 'albedo') { if (albedo) m.map = albedo; }
      else if (this.solo === 'normal') {
        // show normal map as albedo for inspection
        if (normal) { m.map = normal; m.normalMap = null; } m.roughness = 0.9; m.metalness = 0;
      }
      else if (this.solo === 'roughness') { if (rough) m.map = rough; m.roughness = 1; m.metalness = 0; }
      else if (this.solo === 'metalness') { if (metal) m.map = metal; }
      else if (this.solo === 'ao') { if (ao) m.map = ao; m.roughness = 1; m.metalness = 0; }
      else if (this.solo === 'curvature') { if (curv) m.map = curv; m.roughness = 1; m.metalness = 0; }
      else if (this.solo === 'id') { if (idm) m.map = idm; m.roughness = 0.9; m.metalness = 0; }
      else if (this.solo === 'position') { if (posm) m.map = posm; m.roughness = 0.9; m.metalness = 0; }
      else if (this.solo === 'uv') { m.map = this.uvChecker; m.roughness = 0.9; m.metalness = 0; }
      m.needsUpdate = true;
      o.material = m;
    });
  }
  pickUV(ndcX, ndcY) {
    // returns {uv, point, normal, object} or null
    if (!this.mesh) return null;
    const r = this.canvas.getBoundingClientRect();
    const p = new THREE.Vector2(ndcX, ndcY);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(p, this.camera);
    const hits = rc.intersectObject(this.mesh, true);
    if (!hits.length) return null;
    const h = hits[0];
    return { uv: h.uv ? h.uv.clone() : null, point: h.point.clone(), normal: h.face?.normal ?? null, object: h.object, face: h.face };
  }
}

function makeCheckerTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    g.fillStyle = (x + y) % 2 ? '#3a3f4a' : '#c9ced8'; g.fillRect(x * 32, y * 32, 32, 32);
  }
  g.strokeStyle = '#e8b34b';
  for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 256); g.stroke(); g.beginPath(); g.moveTo(0, i * 32); g.lineTo(256, i * 32); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function countTris(obj) {
  let n = 0;
  obj.traverse(o => { if (o.isMesh) { const g = o.geometry; n += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
  return Math.round(n);
}
function disposeObj(obj) { obj.traverse(o => { if (o.isMesh) o.geometry.dispose?.(); }); }
