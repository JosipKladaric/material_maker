export const PRESETS = [
  { name: 'Steel', color: '#9aa0a8', rough: 0.35, metal: 0.9, noise: 0.15 },
  { name: 'Rust', color: '#7a3b1e', rough: 0.9, metal: 0.1, noise: 0.8 },
  { name: 'Gold', color: '#d8a93f', rough: 0.28, metal: 1.0, noise: 0.08 },
  { name: 'Copper', color: '#a9603a', rough: 0.35, metal: 1.0, noise: 0.12 },
  { name: 'Plastic', color: '#2e6fd8', rough: 0.5, metal: 0.0, noise: 0.05 },
  { name: 'Leather', color: '#4a2f1d', rough: 0.8, metal: 0.0, noise: 0.5 },
  { name: 'Concrete', color: '#8d8d88', rough: 0.95, metal: 0.0, noise: 0.6 },
  { name: 'Moss', color: '#3f6b2a', rough: 1.0, metal: 0.0, noise: 0.7 },
];

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// tileable value noise on canvas
export function noiseCanvas(size, scale = 6, octaves = 4, seed = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const perm = makePerm(seed);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0, amp = 0.5, f = scale / size;
    for (let o = 0; o < octaves; o++) {
      v += amp * valueNoise2D(x * f, y * f, perm, Math.max(1, Math.round(scale * Math.pow(2, o))));
      amp *= 0.5; f *= 2;
    }
    const b = Math.max(0, Math.min(255, v * 255));
    const i = (y * size + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = b; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
function makePerm(seed) {
  let s = seed * 1013904223 + 1664525;
  const p = [...Array(256).keys()];
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  return p;
}
function valueNoise2D(x, y, perm, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (X, Y) => perm[(((X % period) + period) % period + perm[((Y % period) + period) % period]) % 256] / 255;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return h(xi, yi) * (1 - u) * (1 - v) + h(xi + 1, yi) * u * (1 - v) + h(xi, yi + 1) * (1 - u) * v + h(xi + 1, yi + 1) * u * v;
}

// Build mask canvas from baked maps + procedural noise.
// kind: fill/black/ao/curvature/edge/top/bottom ; size matches bake size.
export function buildMask(kind, baked, size, noiseAmt = 0.35) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const out = g.createImageData(size, size);
  // baked maps may be a different resolution (after tex-size change) — only use matching channels
  const match = (d, n) => (d && d.length === n ? d : null);
  const ao = match(baked?.aoData, size * size), curv = match(baked?.curvData, size * size),
    pos = match(baked?.posData, size * size * 4), mask = match(baked?.maskData, size * size * 4);
  const noise = noiseCanvas(Math.min(256, size), 8, 4, 7);
  const ng = noise.getContext('2d').getImageData(0, 0, noise.width, noise.height).data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    const covered = mask ? mask[i] > 8 : true;
    let v = 255;
    const a = ao ? ao[i] / 255 : 1;             // 1 = unoccluded
    const cu = curv ? curv[i] / 255 : 0.5;      // 0.5 flat
    const py = pos ? pos[i * 4 + 1] / 255 : 0.5;
    const nx = noise.width, nn = ng[((y % nx) * nx + (x % nx)) * 4] / 255;
    if (kind === 'black') v = 0;
    else if (kind === 'fill') v = 255;
    else if (kind === 'ao') v = (1 - a) * 255;                       // dirt in cavities
    else if (kind === 'curvature') v = Math.abs(cu - 0.5) * 2 * 255; // edges/cracks
    else if (kind === 'edge') v = Math.max(0, (cu - 0.55)) * 2 * 255 * (0.35 + 0.65 * a);
    else if (kind === 'top') v = py * 255 * (0.5 + 0.5 * nn);
    else if (kind === 'bottom') v = (1 - py) * 255 * (0.5 + 0.5 * nn);
    // break up perfection with noise (except pure fill/black)
    if (kind !== 'fill' && kind !== 'black') v = v * (1 - noiseAmt) + nn * 255 * noiseAmt * (v / 255);
    if (!covered) v = 0;
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return c;
}
