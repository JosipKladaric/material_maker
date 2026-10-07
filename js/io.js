import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export async function importMesh(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  if (ext === 'obj') {
    const text = new TextDecoder().decode(buf);
    const obj = new OBJLoader().parse(text);
    return normalize(obj);
  }
  if (ext === 'stl') {
    const geo = new STLLoader().parse(buf);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    return normalize(new THREE.Group().add(m));
  }
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader();
    const obj = await new Promise((res, rej) => loader.parse(buf, '', res, rej));
    return normalize(obj.scene ?? obj.scenes?.[0]);
  }
  throw new Error('unsupported format: ' + ext);
}

export function demoMesh() {
  const g = new THREE.Group();
  const geo = new THREE.TorusKnotGeometry(0.7, 0.22, 220, 36);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  g.add(m);
  return normalize(g);
}

function normalize(root) {
  // center + uniform scale to ~2 units, merge into single group, ensure normals
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = 2 / maxDim;
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);
  root.scale.setScalar(s);
  root.updateMatrixWorld(true);
  // bake scale into geometries so baker math stays simple
  root.traverse(o => {
    if (o.isMesh) {
      o.geometry = o.geometry.toNonIndexed ? o.geometry : o.geometry;
      o.geometry.applyMatrix4(o.matrixWorld);
      o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      // drop imported materials — we author our own PBR set
      o.material = new THREE.MeshStandardMaterial({ color: 0x8a8f98 });
      o.castRay = o.castShadow = true;
    }
  });
  root.updateMatrixWorld(true);
  return root;
}

export function downloadCanvas(cv, name) {
  cv.toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
}

export async function exportGLB(root, maps) {
  const exp = new GLTFExporter();
  const mat = new THREE.MeshStandardMaterial({
    map: maps.albedo ? new THREE.CanvasTexture(maps.albedo) : null,
    normalMap: maps.normal ? new THREE.CanvasTexture(maps.normal) : null,
    roughnessMap: maps.roughness ? new THREE.CanvasTexture(maps.roughness) : null,
    metalnessMap: maps.metalness ? new THREE.CanvasTexture(maps.metalness) : null,
  });
  root.traverse(o => { if (o.isMesh) { o.material = mat; } });
  const glb = await exp.parseAsync(root, { binary: true });
  const blob = new Blob([glb], { type: 'model/gltf-binary' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'materialmaker.glb'; a.click();
}
