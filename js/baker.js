import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

if (!THREE.Mesh.prototype._bvhPatched) {
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
  THREE.Mesh.prototype._bvhPatched = true;
}

function makeCanvas(size) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
// RT pixels are bottom-up (GL). Canvas 2D is top-down. flipY=true textures expect canvas top = v=1.
function pixelsToCanvas(buf, size) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const row = size * 4;
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * row; // flip: canvas top <- GL top
    img.data.set(buf.subarray(src, src + row), y * row);
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function getMeshes(root) {
  const out = [];
  root.updateMatrixWorld(true);
  root.traverse(o => { if (o.isMesh) out.push(o); });
  return out;
}

// Build bake geometry: clip pos from UV, carry world pos/normal + id.
function buildBakeGeoms(meshes) {
  const geoms = [];
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  meshes.forEach((m, mi) => {
    const g = m.geometry;
    if (!g.attributes.uv) return;
    const count = g.attributes.position.count;
    const clip = new Float32Array(count * 3);
    const wpos = new Float32Array(count * 3);
    const wnor = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = g.attributes.uv.getX(i), vv = g.attributes.uv.getY(i);
      clip[i * 3] = u * 2 - 1; clip[i * 3 + 1] = vv * 2 - 1; clip[i * 3 + 2] = 0;
      v.fromBufferAttribute(g.attributes.position, i).applyMatrix4(m.matrixWorld);
      wpos.set([v.x, v.y, v.z], i * 3);
      n.fromBufferAttribute(g.attributes.normal, i).transformDirection(m.matrixWorld);
      wnor.set([n.x, n.y, n.z], i * 3);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(clip, 3));
    bg.setAttribute('aWPos', new THREE.BufferAttribute(wpos, 3));
    bg.setAttribute('aWNorm', new THREE.BufferAttribute(wnor, 3));
    if (g.index) bg.setIndex(g.index.clone());
    bg.userData.meshIndex = mi;
    geoms.push(bg);
  });
  return geoms;
}

const BAKE_VERT = `
attribute vec3 aWPos; attribute vec3 aWNorm;
varying vec3 vWPos; varying vec3 vWNorm; varying float vId;
void main(){ vWPos=aWPos; vWNorm=aWNorm; vId=float(meshId); gl_Position=vec4(position.xy,0.,1.); }`;

function bakeMaterial(mode, box, meshId) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uMin: { value: box.min }, uSize: { value: box.getSize(new THREE.Vector3()) },
      uId: { value: new THREE.Color().setHSL((meshId * 0.37) % 1, 0.7, 0.55) },
    },
    vertexShader: BAKE_VERT.replace('float(meshId)', meshId.toFixed(1)),
    fragmentShader: `
      varying vec3 vWPos; varying vec3 vWNorm; varying float vId;
      uniform vec3 uMin; uniform vec3 uSize; uniform vec3 uId;
      void main(){
        ${mode === 'normal'
          ? 'vec3 n=normalize(vWNorm); gl_FragColor=vec4(n*0.5+0.5,1.0);'
          : mode === 'position'
          ? 'vec3 p=(vWPos-uMin)/max(uSize,vec3(1e-5)); gl_FragColor=vec4(p,1.0);'
          : mode === 'id'
          ? 'gl_FragColor=vec4(uId,1.0);'
          : 'gl_FragColor=vec4(1.0);'}
      }`,
  });
}

function renderMaps(renderer, geoms, box, size) {
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const modes = ['normal', 'position', 'id'];
  const out = {};
  for (const mode of modes) {
    scene.clear();
    geoms.forEach((bg) => {
      const mesh = new THREE.Mesh(bg, bakeMaterial(mode, box, bg.userData.meshIndex));
      mesh.frustumCulled = false;
      scene.add(mesh);
    });
    const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType });
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    const buf = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    renderer.setRenderTarget(null);
    rt.dispose();
    scene.traverse(o => { if (o.isMesh) o.material.dispose(); });
    out[mode] = { canvas: pixelsToCanvas(buf, size), data: extractFlipped(buf, size) };
  }
  return out;
}
// data in canvas-top-down order (row0 = v=1), matching getImageData convention
function extractFlipped(buf, size) {
  const out = new Uint8Array(buf.length);
  const row = size * 4;
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * row;
    out.set(buf.subarray(src, src + row), y * row);
  }
  return out;
}

function ensureBVH(meshes) {
  for (const m of meshes) {
    if (!m.geometry.boundsTree) {
      try { m.geometry.boundsTree = new MeshBVH(m.geometry); }
      catch (e) { console.warn('BVH build failed', e); }
    }
  }
}

function hemiDirs(n, seed) {
  // cosine-weighted hemisphere basis
  const t = new THREE.Vector3(Math.abs(n.y) < 0.99 ? 0 : 1, Math.abs(n.y) < 0.99 ? 1 : 0, 0);
  const b1 = new THREE.Vector3().crossVectors(n, t).normalize();
  const b2 = new THREE.Vector3().crossVectors(n, b1).normalize();
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  return (k) => {
    const r1 = rnd(), r2 = rnd();
    const r = Math.sqrt(r1), th = 2 * Math.PI * r2;
    return new THREE.Vector3()
      .addScaledVector(b1, r * Math.cos(th))
      .addScaledVector(b2, r * Math.sin(th))
      .addScaledVector(n, Math.sqrt(Math.max(0, 1 - r1)))
      .normalize();
  };
}

async function bakeAO_CPU(meshes, maps, box, size, samples, maxDist, onProgress, token) {
  // compute at reduced res then upscale
  const w = Math.min(size, 512);
  const scale = size / w;
  ensureBVH(meshes);
  const posD = maps.position.data, normD = maps.normal.data;
  const sizeVec = box.getSize(new THREE.Vector3());
  const sx = Math.max(sizeVec.x, 1e-5), sy = Math.max(sizeVec.y, 1e-5), sz = Math.max(sizeVec.z, 1e-5);
  const diag = sizeVec.length() || 1;
  const dist = maxDist * diag * 0.5;
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const aoSmall = new Uint8Array(w * w);
  const N = new THREE.Vector3(), P = new THREE.Vector3();
  const dir = new THREE.Vector3();
  // decode full-res pos/normal into small grid by nearest sampling canvas-top-down data
  for (let y = 0; y < w; y++) {
    if (token.cancelled) return null;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(size - 1, Math.floor(x * scale)), sy = Math.min(size - 1, Math.floor(y * scale));
      const i = (sy * size + sx) * 4;
      const a = posD[i + 3];
      if (a < 8) { aoSmall[y * w + x] = 255; continue; }
      P.set(
        box.min.x + (posD[i] / 255) * sx,
        box.min.y + (posD[i + 1] / 255) * sy,
        box.min.z + (posD[i + 2] / 255) * sz);
      N.set(normD[i] / 255 * 2 - 1, normD[i + 1] / 255 * 2 - 1, normD[i + 2] / 255 * 2 - 1);
      if (N.lengthSq() < 1e-6) N.set(0, 1, 0); else N.normalize();
      const gen = hemiDirs(N, (x * 73856093) ^ (y * 19349663) ^ 83492791);
      let occ = 0;
      P.addScaledVector(N, diag * 1e-4); // offset off surface
      for (let k = 0; k < samples; k++) {
        dir.copy(gen(k));
        ray.set(P, dir);
        ray.far = dist;
        const hits = ray.intersectObjects(meshes, false);
        if (hits.length) {
          const d = hits[0].distance / dist;
          occ += 1 - d * 0.7; // linear falloff
        }
      }
      const ao = 1 - Math.min(1, occ / samples);
      aoSmall[y * w + x] = Math.round(ao * 255);
    }
    if (y % 32 === 0) { onProgress?.(0.35 + 0.55 * (y / w)); await new Promise(r => setTimeout(r, 0)); }
  }
  // upscale to full size canvas
  const small = document.createElement('canvas'); small.width = small.height = w;
  const sg = small.getContext('2d');
  const sImg = sg.createImageData(w, w);
  for (let i = 0; i < w * w; i++) { sImg.data[i * 4] = sImg.data[i * 4 + 1] = sImg.data[i * 4 + 2] = aoSmall[i]; sImg.data[i * 4 + 3] = 255; }
  sg.putImageData(sImg, 0, 0);
  const full = makeCanvas(size);
  const fg = full.getContext('2d');
  fg.imageSmoothingEnabled = true;
  fg.drawImage(small, 0, 0, size, size);
  // re-apply coverage mask: where not covered -> white
  const fImg = fg.getImageData(0, 0, size, size);
  const cov = maps.position.data;
  for (let i = 0; i < size * size; i++) if (cov[i * 4 + 3] < 8) { fImg.data[i * 4] = fImg.data[i * 4 + 1] = fImg.data[i * 4 + 2] = 255; }
  fg.putImageData(fImg, 0, 0);
  return { canvas: full, data: fg.getImageData(0, 0, size, size).data };
}

function bakeCurvature(normalData, maskData, size) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const nx = (x, y) => {
    x = Math.max(0, Math.min(size - 1, x)); y = Math.max(0, Math.min(size - 1, y));
    const i = (y * size + x) * 4;
    return [normalData[i] / 255 * 2 - 1, normalData[i + 1] / 255 * 2 - 1, normalData[i + 2] / 255 * 2 - 1];
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x);
    let v = 128;
    if (maskData[i * 4 + 3] > 8) {
      const a = nx(x + 1, y), b = nx(x - 1, y), cc = nx(x, y + 1), d = nx(x, y - 1);
      const gx = (a[0] - b[0]) + (a[1] - b[1]) + (a[2] - b[2]);
      const gy = (cc[0] - d[0]) + (cc[1] - d[1]) + (cc[2] - d[2]);
      const k = (gx + gy) / 2; // >0 convex, <0 concave approx
      v = Math.max(0, Math.min(255, 128 + k * 220));
    }
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, data: g.getImageData(0, 0, size, size).data };
}

export async function bakeAll(renderer, root, size, opts, onProgress, token) {
  const meshes = getMeshes(root);
  if (!meshes.length) throw new Error('no mesh');
  onProgress?.(0.02, 'building BVH + UV raster…');
  await new Promise(r => setTimeout(r, 0));
  const box = new THREE.Box3().setFromObject(root);
  const geoms = buildBakeGeoms(meshes);
  if (!geoms.length) throw new Error('mesh has no UVs — run Auto-UV first');
  onProgress?.(0.08, 'rasterizing normal/position/ID…');
  await new Promise(r => setTimeout(r, 0));
  const maps = renderMaps(renderer, geoms, box, size);
  geoms.forEach(g => g.dispose());
  if (token.cancelled) return null;
  onProgress?.(0.3, `raycasting AO (${opts.samples} rays, ≤512 internal)…`);
  const ao = await bakeAO_CPU(meshes, maps, box, size, opts.samples, opts.dist, (p) => onProgress?.(p, 'raycasting AO…'), token);
  if (!ao || token.cancelled) return null;
  onProgress?.(0.92, 'curvature…');
  await new Promise(r => setTimeout(r, 0));
  const curv = bakeCurvature(maps.normal.data, maps.position.data, size);
  onProgress?.(1, 'done');
  return {
    size, box,
    normalCanvas: maps.normal.canvas, normalData: maps.normal.data,
    posCanvas: maps.position.canvas, posData: maps.position.data,
    idCanvas: maps.id.canvas,
    maskData: maps.position.data,
    aoCanvas: ao.canvas, aoData: ao.data,
    curvCanvas: curv.canvas, curvData: curv.data,
  };
}
