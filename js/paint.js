import * as THREE from 'three';

// Paints 3D strokes into active layer mask / paint canvas.
// UV convention: canvas top row = v=1 (flipY=true standard), so py=(1-v)*H.
export class Painter {
  constructor(viewport, layers, ui) {
    this.vp = viewport; this.layers = layers; this.ui = ui;
    this.tool = 'paint';
    this.stroking = false; this.last = null;
    this.onStrokeEnd = null;
    this.bind();
  }
  bind() {
    const cv = this.vp.canvas;
    cv.addEventListener('pointerdown', e => {
      if (e.button === 2) return; // right = orbit
      if (this.tool === 'picker') { this.pick(e); return; }
      if (e.button !== 0) return;
      this.stroking = true; cv.setPointerCapture(e.pointerId);
      this.last = null;
      this.dab(e);
    });
    cv.addEventListener('pointermove', e => { if (this.stroking) this.dab(e); });
    addEventListener('pointerup', () => {
      if (this.stroking) { this.stroking = false; this.onStrokeEnd?.(); }
    });
    cv.addEventListener('contextmenu', e => e.preventDefault());
  }
  ndc(e) {
    const r = this.vp.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  brush() {
    return {
      size: +document.getElementById('brushSize').value,
      flow: +document.getElementById('brushFlow').value,
      soft: +document.getElementById('brushSoft').value,
      spacing: +document.getElementById('brushSpacing').value,
      target: document.getElementById('brushTarget').value,
      color: document.getElementById('brushColor').value,
      erase: this.tool === 'erase',
    };
  }
  dab(e) {
    const layer = this.layers.active;
    if (!layer || !layer.visible) return;
    const hit = this.vp.pickUV(this.ndc(e).x, this.ndc(e).y);
    if (!hit?.uv) return;
    const S = this.layers.size;
    const b = this.brush();
    const diam = b.size * (S / 1024);
    const px = hit.uv.x * S, py = (1 - hit.uv.y) * S;
    if (this.last) {
      const dx = px - this.last[0], dy = py - this.last[1];
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, diam * b.spacing);
      const n = Math.min(50, Math.floor(dist / step));
      for (let i = 1; i <= n; i++) this.stamp(layer, this.last[0] + dx * i / n, this.last[1] + dy * i / n, diam, b);
    }
    this.stamp(layer, px, py, diam, b);
    this.last = [px, py];
    this.ui.scheduleComposite();
  }
  stamp(layer, x, y, diam, b) {
    const target = b.target === 'color' && layer.paint ? layer.paint : layer.mask;
    if (b.target === 'color' && !layer.paint) {
      layer.paint = document.createElement('canvas');
      layer.paint.width = layer.paint.height = this.layers.size;
    }
    const cv = b.target === 'color' ? layer.paint : layer.mask;
    const g = cv.getContext('2d');
    const r = Math.max(1, diam / 2);
    const grad = g.createRadialGradient(x, y, r * (1 - b.soft) * 0.5, x, y, r);
    let col = b.erase ? '0,0,0' : (b.target === 'color' ? hexRgb(b.color) : '255,255,255');
    if (!b.erase && b.target === 'mask' && this.tool === 'erase') col = '0,0,0';
    const a = b.flow * (b.erase && b.target === 'color' ? 1 : 1);
    grad.addColorStop(0, `rgba(${col},${a})`);
    grad.addColorStop(1, `rgba(${col},0)`);
    g.save();
    if (b.target === 'color' && b.erase) g.globalCompositeOperation = 'destination-out';
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    // wrap seams: stamp mirrored copies near edges (cheap bleed)
    const S = this.layers.size;
    for (const [ox, oy] of [[-S, 0], [S, 0], [0, -S], [0, S]]) {
      if (x + ox < -r || x + ox > S + r || y + oy < -r || y + oy > S + r) continue;
      const gr2 = g.createRadialGradient(x + ox, y + oy, r * 0.2, x + ox, y + oy, r);
      gr2.addColorStop(0, `rgba(${col},${a})`); gr2.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr2;
      g.beginPath(); g.arc(x + ox, y + oy, r, 0, 7); g.fill();
    }
    g.restore();
  }
  pick(e) {
    // sample composited albedo at hit uv
    const hit = this.vp.pickUV(this.ndc(e).x, this.ndc(e).y);
    if (!hit?.uv || !this.ui.finalMaps?.albedo) return;
    const S = this.layers.size;
    const x = Math.floor(hit.uv.x * (S - 1)), y = Math.floor((1 - hit.uv.y) * (S - 1));
    const d = this.ui.finalMaps.albedo.getContext('2d').getImageData(x, y, 1, 1).data;
    const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    document.getElementById('brushColor').value = hex;
    document.getElementById('matColor').value = hex;
    const l = this.layers.active;
    if (l) { l.color = hex; this.ui.refreshLayerPanel(); this.ui.scheduleComposite(); }
  }
}
function hexRgb(hex) {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}
