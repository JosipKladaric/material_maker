import { hexToRgb, noiseCanvas, buildMask } from './materials.js';

let uid = 1;
export class LayerStore {
  constructor() { this.layers = []; this.activeId = null; this.size = 1024; this._noiseCache = new Map(); }
  get active() { return this.layers.find(l => l.id === this.activeId) ?? this.layers[this.layers.length - 1]; }
  addFill(preset = null, maskKind = 'fill', baked = null) {
    const l = {
      id: uid++, name: preset ? preset.name : `Fill ${uid}`,
      type: 'fill', visible: true, opacity: 1, blend: 'normal',
      color: preset?.color ?? '#8a8f98',
      roughness: preset?.rough ?? 0.5, metalness: preset?.metal ?? 0.0,
      noise: preset?.noise ?? 0.25,
      mask: null, maskKind, paint: null,
    };
    l.mask = this.makeMask(maskKind, baked);
    this.layers.push(l); this.activeId = l.id;
    return l;
  }
  addPaint(baked = null) {
    const l = {
      id: uid++, name: `Paint ${uid}`, type: 'paint', visible: true, opacity: 1, blend: 'normal',
      color: '#cc3333', roughness: 0.5, metalness: 0.0, noise: 0,
      mask: this.makeMask('fill', baked),
      paint: makeCanvas(this.size),
    };
    this.layers.push(l); this.activeId = l.id;
    return l;
  }
  makeMask(kind, baked) {
    return buildMask(kind, baked ?? null, this.size);
  }
  remove(id) { this.layers = this.layers.filter(l => l.id !== id); if (this.activeId === id) this.activeId = this.layers[this.layers.length - 1]?.id ?? null; }
  move(id, dir) {
    const i = this.layers.findIndex(l => l.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= this.layers.length) return;
    [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]];
  }
  setSize(s) {
    if (s === this.size) return;
    this.size = s;
    for (const l of this.layers) {
      l.mask = rescale(l.mask, s);
      if (l.paint) l.paint = rescale(l.paint, s, true);
    }
    this._noiseCache.clear();
  }
  noiseFor(layer) {
    const key = `${this.size}:${layer.noise}`;
    if (!this._noiseCache.has(key)) this._noiseCache.set(key, noiseCanvas(Math.min(256, this.size), 7, 4, 3));
    return this._noiseCache.get(key);
  }
  // Composite bottom->top. Returns canvases.
  composite(baked) {
    const S = this.size;
    const alb = document.createElement('canvas'); alb.width = alb.height = S;
    const rgh = document.createElement('canvas'); rgh.width = rgh.height = S;
    const met = document.createElement('canvas'); met.width = met.height = S;
    const nrm = document.createElement('canvas'); nrm.width = nrm.height = S;
    const ag = alb.getContext('2d'), rg = rgh.getContext('2d'),
      mg = met.getContext('2d'), ng = nrm.getContext('2d');
    const aImg = ag.createImageData(S, S), rImg = rg.createImageData(S, S),
      mImg = mg.createImageData(S, S), nImg = ng.createImageData(S, S);
    // base: mid gray dielectric
    for (let i = 0; i < S * S; i++) {
      aImg.data[i * 4] = aImg.data[i * 4 + 1] = aImg.data[i * 4 + 2] = 128;
      aImg.data[i * 4 + 3] = 255;
      rImg.data[i * 4] = rImg.data[i * 4 + 1] = rImg.data[i * 4 + 2] = 200;
      rImg.data[i * 4 + 3] = 255;
      mImg.data[i * 4] = mImg.data[i * 4 + 1] = mImg.data[i * 4 + 2] = 0;
      mImg.data[i * 4 + 3] = 255;
      nImg.data[i * 4] = 128; nImg.data[i * 4 + 1] = 128; nImg.data[i * 4 + 2] = 255; nImg.data[i * 4 + 3] = 255;
    }
    const cov = baked?.maskData;
    const covOK = cov && cov.length === S * S * 4 ? cov : null;
    // per-layer data URLs cached
    const layerImgs = this.layers.map(l => ({
      l,
      mask: l.mask.getContext('2d').getImageData(0, 0, S, S).data,
      paint: l.paint ? l.paint.getContext('2d').getImageData(0, 0, S, S).data : null,
    }));
    // noise (shared, upscaled nearest via tiling)
    const noiseC = this.layers.some(l => l.noise > 0) ? noiseCanvas(256, 7, 4, 3) : null;
    const noiseD = noiseC ? noiseC.getContext('2d').getImageData(0, 0, 256, 256).data : null;
    const nAt = (x, y) => noiseD ? noiseD[((y % 256) * 256 + (x % 256)) * 4] / 255 : 0.5;

    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x, o = i * 4;
      if (covOK && covOK[o + 3] < 8) { aImg.data[o + 3] = 0; continue; } // transparent outside islands
      let ar = 128, agg = 128, ab = 128, rr = 200, mm = 0, nx = 128, ny = 128, nz = 255;
      for (const { l, mask, paint } of layerImgs) {
        if (!l.visible) continue;
        const mAlpha = (mask[o] / 255) * l.opacity;
        if (mAlpha <= 0.001) continue;
        let lr, lg, lb, lrr, lmm, paintA = 1;
        if (l.type === 'paint' && paint) {
          const pa = paint[o + 3] / 255;
          if (pa <= 0.001) continue;
          paintA = pa;
          lr = paint[o]; lg = paint[o + 1]; lb = paint[o + 2];
          lrr = l.roughness * 255; lmm = l.metalness * 255;
        } else {
          const [br, bg, bb] = hexToRgb(l.color);
          lr = br; lg = bg; lb = bb;
          lrr = l.roughness * 255; lmm = l.metalness * 255;
          if (l.noise > 0.01) {
            const nz0 = nAt(x, y);
            const k = 1 + (nz0 - 0.5) * l.noise * 1.2;
            lr = clamp(lr * k); lg = clamp(lg * k); lb = clamp(lb * k);
            lrr = clamp(lrr * (1 + (nz0 - 0.5) * l.noise));
          }
        }
        const a = Math.min(1, mAlpha * paintA);
        const b = blend(ar, agg, ab, lr, lg, lb, l.blend, a);
        ar = b[0]; agg = b[1]; ab = b[2];
        rr = rr * (1 - a) + lrr * a;
        mm = mm * (1 - a) + lmm * a;
        if (l.noise > 0.3) { // cheap normal perturb from noise gradient
          const e = 1;
          const h0 = nAt(x, y), hx = nAt(x + e, y), hy = nAt(x, y + e);
          const s = l.noise * 2.2 * a;
          const px = (h0 - hx) * s * 255, py = (h0 - hy) * s * 255;
          nx = clamp(nx * (1 - a * 0.5) + (128 + px) * (a * 0.5));
          ny = clamp(ny * (1 - a * 0.5) + (128 + py) * (a * 0.5));
        }
      }
      aImg.data[o] = ar; aImg.data[o + 1] = agg; aImg.data[o + 2] = ab; aImg.data[o + 3] = 255;
      rImg.data[o] = rImg.data[o + 1] = rImg.data[o + 2] = rr; rImg.data[o + 3] = 255;
      mImg.data[o] = mImg.data[o + 1] = mImg.data[o + 2] = mm; mImg.data[o + 3] = 255;
      nImg.data[o] = nx; nImg.data[o + 1] = ny; nImg.data[o + 2] = nz; nImg.data[o + 3] = 255;
    }
    ag.putImageData(aImg, 0, 0); rg.putImageData(rImg, 0, 0);
    mg.putImageData(mImg, 0, 0); ng.putImageData(nImg, 0, 0);
    return { albedo: alb, roughness: rgh, metalness: met, normal: nrm };
  }
  serialize() {
    return {
      size: this.size, activeId: this.activeId,
      layers: this.layers.map(l => ({
        ...l, id: l.id, mask: l.mask.toDataURL(), paint: l.paint ? l.paint.toDataURL() : null,
      })),
    };
  }
  async deserialize(d) {
    this.size = d.size; this.layers = [];
    for (const s of d.layers) {
      const l = { ...s, mask: await imgToCanvas(s.mask), paint: s.paint ? await imgToCanvas(s.paint) : null };
      this.layers.push(l);
    }
    this.activeId = d.activeId;
  }
}

function makeCanvas(s) { const c = document.createElement('canvas'); c.width = c.height = s; return c; }
function rescale(cv, s, smooth = true) {
  const c = makeCanvas(s);
  const g = c.getContext('2d'); g.imageSmoothingEnabled = smooth;
  g.drawImage(cv, 0, 0, s, s);
  return c;
}
function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
function blend(br, bg, bb, lr, lg, lb, mode, a) {
  let r, g, b2;
  if (mode === 'multiply') { r = br * lr / 255; g = bg * lg / 255; b2 = bb * lb / 255; }
  else if (mode === 'screen') { r = 255 - (255 - br) * (255 - lr) / 255; g = 255 - (255 - bg) * (255 - lg) / 255; b2 = 255 - (255 - bb) * (255 - lb) / 255; }
  else if (mode === 'overlay') { r = ov(br, lr); g = ov(bg, lg); b2 = ov(bb, lb); }
  else if (mode === 'add') { r = Math.min(255, br + lr * 0.7); g = Math.min(255, bg + lg * 0.7); b2 = Math.min(255, bb + lb * 0.7); }
  else { r = lr; g = lg; b2 = lb; }
  return [br * (1 - a) + r * a, bg * (1 - a) + g * a, bb * (1 - a) + b2 * a];
}
function ov(b, l) { return b < 128 ? 2 * b * l / 255 : 255 - 2 * (255 - b) * (255 - l) / 255; }
function imgToCanvas(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0); res(c); };
    im.onerror = rej; im.src = url;
  });
}
