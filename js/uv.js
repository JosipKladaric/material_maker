// Projection-based Auto-UV. Keeps original UVs when present and valid.
// Box projection: pick dominant axis per-face, planar map, normalize to 0..1.
import * as THREE from 'three';

export function hasUsableUVs(geometry) {
  const uv = geometry.attributes.uv;
  if (!uv) return false;
  // check range / variance
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (let i = 0; i < Math.min(uv.count, 5000); i++) {
    const x = uv.getX(i), y = uv.getY(i);
    if (!isFinite(x + y)) return false;
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  const w = maxx - minx, h = maxy - miny;
  return w > 1e-4 && h > 1e-4 && w < 10 && h < 10;
}

export function applyAutoUV(root, mode = 'box') {
  root.updateMatrixWorld(true);
  root.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (mode === 'keep' && hasUsableUVs(g)) return;
    const proj = mode === 'keep' ? 'box' : mode;
    g.deleteAttribute('uv');
    g.setAttribute('uv', buildProjectionUV(g, o, proj));
  });
}

function buildProjectionUV(geom, obj, mode) {
  const pos = geom.attributes.position;
  const nor = geom.attributes.normal;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  // world bounds for normalization
  obj.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const min = box.min;
  const S = Math.max(size.x, size.y, size.z) || 1;
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
    n.fromBufferAttribute(nor, i).transformDirection(obj.matrixWorld);
    let u = 0, vv = 0;
    if (mode === 'planar') { u = (v.x - min.x) / S; vv = (v.z - min.z) / S; }
    else if (mode === 'spherical') {
      const p = v.clone().sub(box.getCenter(new THREE.Vector3()));
      const r = p.length() || 1;
      u = 0.5 + Math.atan2(p.z, p.x) / (Math.PI * 2);
      vv = 0.5 - Math.asin(THREE.MathUtils.clamp(p.y / r, -1, 1)) / Math.PI;
    } else {
      // box: dominant axis
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      if (ax >= ay && ax >= az) { u = (v.z - min.z) / S; vv = (v.y - min.y) / S; }
      else if (ay >= ax && ay >= az) { u = (v.x - min.x) / S; vv = (v.z - min.z) / S; }
      else { u = (v.x - min.x) / S; vv = (v.y - min.y) / S; }
    }
    // inset slightly to avoid edge bleed, keep 0..1
    uv[i * 2] = THREE.MathUtils.clamp(u, 0.001, 0.999);
    uv[i * 2 + 1] = THREE.MathUtils.clamp(vv, 0.001, 0.999);
  }
  return new THREE.BufferAttribute(uv, 2);
}

export function uvStats(root) {
  let meshes = 0, withUV = 0, tris = 0;
  root.traverse(o => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    if (g.attributes.uv) withUV++;
    tris += Math.round((g.index ? g.index.count : g.attributes.position.count) / 3);
  });
  return { meshes, withUV, tris };
}
