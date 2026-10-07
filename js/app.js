import * as THREE from 'three';
import { Viewport } from './viewport.js';
import { applyAutoUV, uvStats } from './uv.js';
import { bakeAll } from './baker.js';
import { LayerStore } from './layers.js';
import { PRESETS, buildMask } from './materials.js';
import { Painter } from './paint.js';
import { importMesh, demoMesh, downloadCanvas, exportGLB } from './io.js';

const $ = id => document.getElementById(id);
const status = t => { $('status').textContent = t; };

const viewport = new Viewport($('gl'));
const layers = new LayerStore();
const ui = { finalMaps: null, scheduled: false, stroking: false, refreshLayerPanel, scheduleComposite };
const painter = new Painter(viewport, layers, ui);
painter.onStrokeEnd = () => scheduleComposite();

let meshRoot = null;
let baked = null;
const bakeToken = { cancelled: false };

// ---------- boot ----------
viewport.setEnvIntensity(1);
renderPresets();
refreshLayerPanel();
compositeAndShow(); // gray default
$('dropHint').style.display = 'flex';

function setStatusMesh() {
  if (!meshRoot) return;
  const s = uvStats(meshRoot);
  $('uvInfo').textContent = `${s.meshes} mesh(es), ${s.tris.toLocaleString()} tris, UVs: ${s.withUV}/${s.meshes}`;
}

// ---------- import ----------
async function setMesh(root, name) {
  meshRoot = root;
  baked = null; updateBakeChips();
  applyAutoUV(meshRoot, $('uvMode').value);
  viewport.setMesh(meshRoot);
  setStatusMesh();
  $('dropHint').style.display = 'none';
  // reset layers to a sensible stack
  layers.layers = []; layers._noiseCache.clear(); layers.clearHistory();
  const S = +$('texSize').value; layers.setSize(S);
  layers.addFill({ name: 'Base metal', color: '#6b6f76', rough: 0.45, metal: 0.9, noise: 0.12 }, 'fill', null);
  refreshLayerPanel(); syncMaterialInputs();
  scheduleComposite();
  status(`loaded ${name} — UVs ${$('uvMode').value}, ready to bake`);
}

$('fileInput').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try { status('importing ' + f.name); setMesh(await importMesh(f), f.name); }
  catch (err) { status('import failed: ' + err.message); console.error(err); }
  e.target.value = '';
});
$('btnDemo').onclick = () => setMesh(demoMesh(), 'torus-knot (demo)');
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', async e => {
  e.preventDefault();
  const f = e.dataTransfer.files?.[0]; if (!f) return;
  try { status('importing ' + f.name); setMesh(await importMesh(f), f.name); }
  catch (err) { status('import failed: ' + err.message); }
});

// ---------- UV ----------
$('btnApplyUV').onclick = () => {
  if (!meshRoot) return status('import a mesh first');
  applyAutoUV(meshRoot, $('uvMode').value);
  viewport.refreshMaterial();
  setStatusMesh();
  status('UV: ' + $('uvMode').value);
};
$('railUV').onclick = () => { $('uvMode').value = 'box'; $('btnApplyUV').click(); };

// ---------- bake ----------
$('btnBake').onclick = async () => {
  if (!meshRoot) return status('import a mesh first');
  const S = +$('texSize').value;
  layers.setSize(S);
  bakeToken.cancelled = false;
  $('bakeProgress').hidden = false;
  setProg(0, 'starting…');
  $('btnBake').disabled = true;
  try {
    baked = await bakeAll(viewport.renderer, meshRoot, S, {
      samples: Math.max(8, Math.min(256, +$('aoSamples').value || 48)),
      dist: +$('aoDist').value || 1.5,
    }, (p, label) => setProg(p, label), bakeToken);
    if (!baked) { status('bake cancelled'); return; }
    updateBakeChips();
    status(`baked ${S}px: normal/position/ID/AO/curvature — now paint or add smart layers`);
  } catch (err) { console.error(err); status('bake failed: ' + err.message); }
  finally { $('bakeProgress').hidden = true; $('btnBake').disabled = false; }
};
$('btnCancelBake').onclick = () => { bakeToken.cancelled = true; };
$('railBake').onclick = () => $('btnBake').click();
function setProg(p, label) {
  $('bakeBar').style.setProperty('--p', (p * 100).toFixed(1) + '%');
  $('bakeLabel').textContent = `${Math.round(p * 100)}% — ${label ?? ''}`;
}
function updateBakeChips() {
  const el = $('bakeList'); el.innerHTML = '';
  const soloFor = { normal: 'normal', ao: 'ao', curvature: 'curvature', position: 'position', id: 'id' };
  ['normal', 'ao', 'curvature', 'position', 'id'].forEach(k => {
    const s = document.createElement('span');
    s.textContent = k; if (baked) s.classList.add('ok');
    if (baked && soloFor[k]) { s.title = 'Click to inspect'; s.style.cursor = 'pointer'; s.onclick = () => viewport.setSolo(soloFor[k]); }
    el.appendChild(s);
  });
}

// ---------- undo / redo ----------
function syncHistoryButtons() {
  const u = $('btnUndo'), r = $('btnRedo');
  if (u) u.disabled = !layers.canUndo;
  if (r) r.disabled = !layers.canRedo;
}
layers.onHistory = syncHistoryButtons;
$('btnUndo').onclick = () => { if (layers.undo()) { scheduleComposite(); status('undo'); } };
$('btnRedo').onclick = () => { if (layers.redo()) { scheduleComposite(); status('redo'); } };
syncHistoryButtons();

// ---------- layers ----------
$('btnAddLayer').onclick = () => {
  layers.addFill({ name: 'Fill', color: $('matColor').value, rough: +$('matRough').value, metal: +$('matMetal').value, noise: 0.25 }, 'fill', baked);
  refreshLayerPanel(); scheduleComposite();
};
$('btnAddPaint').onclick = () => {
  layers.addPaint(baked);
  refreshLayerPanel(); scheduleComposite();
};
function renderPresets() {
  const row = $('presetRow'); row.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'btn small'; b.textContent = p.name; b.title = `Add ${p.name} smart material`;
    b.onclick = () => {
      layers.addFill(p, $('maskGen').value === 'fill' ? 'fill' : $('maskGen').value, baked);
      refreshLayerPanel(); syncMaterialInputs(); scheduleComposite();
    };
    row.appendChild(b);
  }
}
function refreshLayerPanel() {
  const el = $('layerList'); el.innerHTML = '';
  [...layers.layers].reverse().forEach(l => {
    const d = document.createElement('div');
    d.className = 'layer' + (l.id === layers.activeId ? ' active' : '');
    d.innerHTML = `<div class="lr"><span class="sw" style="background:${l.color}"></span>
      <b>${l.name}</b><small>${l.type} · ${l.blend} · ${Math.round(l.opacity * 100)}%</small>
      <span style="flex:1"></span>
      <button data-a="up" title="move up">▲</button><button data-a="dn" title="move down">▼</button>
      <button data-a="vis" title="toggle">${l.visible ? '👁' : '🚫'}</button><button data-a="del" title="delete">✕</button></div>`;
    d.onclick = e => {
      const a = e.target.dataset.a;
      if (a === 'del') layers.remove(l.id);
      else if (a === 'vis') l.visible = !l.visible;
      else if (a === 'up') layers.move(l.id, 1);
      else if (a === 'dn') layers.move(l.id, -1);
      else { layers.activeId = l.id; syncMaterialInputs(); }
      refreshLayerPanel(); scheduleComposite();
    };
    el.appendChild(d);
  });
  const a = layers.active;
  $('layerName').textContent = a ? `— ${a.name}` : '';
}
// material inputs -> active layer
for (const id of ['matColor', 'matRough', 'matMetal', 'matOpacity', 'matBlend']) {
  $(id).addEventListener('input', () => {
    const l = layers.active; if (!l) return;
    l.color = $('matColor').value;
    l.roughness = +$('matRough').value; l.metalness = +$('matMetal').value;
    l.opacity = +$('matOpacity').value; l.blend = $('matBlend').value;
    refreshLayerPanel(); scheduleComposite();
  });
}
function syncMaterialInputs() {
  const l = layers.active; if (!l) return;
  $('matColor').value = l.color; $('matRough').value = l.roughness;
  $('matMetal').value = l.metalness; $('matOpacity').value = l.opacity;
  $('matBlend').value = l.blend;
}
$('btnApplyMask').onclick = () => {
  const l = layers.active; if (!l) return status('add a layer first');
  layers.snapshot(l.id, 'mask');
  l.mask = buildMask($('maskGen').value, baked, layers.size);
  l.name = l.name.replace(/ \(.*\)/, '') + ` (${$('maskGen').value})`;
  refreshLayerPanel(); scheduleComposite();
  status(`mask generator applied: ${$('maskGen').value}${baked ? '' : ' (bake first for smarter masks)'}`);
};

// ---------- composite -> viewport ----------
// During strokes, compositing a 1024px stack costs 50-200ms — throttle to ~12fps
// and let stroke-end deliver the final crisp update.
let compositeQueued = false, lastComp = 0, trailingTimer = 0;
function scheduleComposite() {
  if (ui.stroking) {
    const now = performance.now();
    if (now - lastComp < 80) {
      clearTimeout(trailingTimer);
      trailingTimer = setTimeout(() => { lastComp = performance.now(); compositeAndShow(); }, 85);
      return;
    }
    lastComp = now;
  }
  if (compositeQueued) return;
  compositeQueued = true;
  requestAnimationFrame(() => {
    compositeQueued = false;
    compositeAndShow();
  });
}
function compositeAndShow(bleed = 3) {
  const maps = layers.layers.length ? layers.composite(baked, bleed) : null;
  if (maps) {
    ui.finalMaps = maps;
    viewport.updateMaps({
      albedo: maps.albedo, normal: maps.normal,
      roughness: maps.roughness, metalness: maps.metalness,
      ao: baked?.aoCanvas ?? null, curvature: baked?.curvCanvas ?? null,
      id: baked?.idCanvas ?? null, position: baked?.posCanvas ?? null,
    });
  }
}

// ---------- tools / view ----------
document.querySelectorAll('#rail [data-tool]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('#rail [data-tool]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    painter.tool = b.dataset.tool === 'fill' ? 'paint' : b.dataset.tool;
    if (b.dataset.tool === 'fill') $('btnAddLayer').click();
    else status('tool: ' + painter.tool + (painter.tool === 'paint' || painter.tool === 'erase' ? ' — drag paints, Alt+drag or 🖐 orbits' : ''));
  };
});
$('railSolo').onclick = () => {
  const order = ['pbr', 'albedo', 'normal', 'roughness', 'metalness', 'ao', 'curvature', 'id', 'position', 'uv', 'wire'];
  viewport.setSolo(order[(order.indexOf(viewport.solo) + 1) % order.length]);
};
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) { if (layers.redo()) { scheduleComposite(); status('redo'); } }
    else if (layers.undo()) { scheduleComposite(); status('undo'); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    if (layers.redo()) { scheduleComposite(); status('redo'); }
    return;
  }
  if (e.key === 'b' || e.key === 'B') document.querySelector('[data-tool=paint]').click();
  if (e.key === 'e' || e.key === 'E') document.querySelector('[data-tool=erase]').click();
  if (e.key === 'v' || e.key === 'V') document.querySelector('[data-tool=orbit]').click();
  if (e.key === '[') $('brushSize').value = Math.max(2, +$('brushSize').value - 8);
  if (e.key === ']') $('brushSize').value = Math.min(256, +$('brushSize').value + 8);
  const n = '1234567'.indexOf(e.key);
  if (n >= 0) viewport.setSolo(['pbr', 'albedo', 'normal', 'roughness', 'metalness', 'ao', 'uv'][n]);
});
$('envIntensity').addEventListener('input', e => viewport.setEnvIntensity(+e.target.value));
$('texSize').addEventListener('change', () => {
  layers.setSize(+$('texSize').value); scheduleComposite();
  if (baked && baked.size !== +$('texSize').value) status('texture size changed — press Bake maps again for matching AO/curvature');
});

// ---------- export / project ----------
$('btnExportPNG').onclick = () => {
  if (!layers.layers.length) return status('nothing to export yet');
  status('compositing full-bleed export…');
  // Re-composite with wide bleed so mipmaps/exports don't get dark seams at island edges.
  compositeAndShow(10);
  const m = ui.finalMaps;
  downloadCanvas(m.albedo, 'mm_albedo.png');
  downloadCanvas(m.normal, 'mm_normal.png');
  downloadCanvas(m.roughness, 'mm_roughness.png');
  downloadCanvas(m.metalness, 'mm_metalness.png');
  if (baked) {
    downloadCanvas(baked.aoCanvas, 'mm_ao.png');
    downloadCanvas(baked.curvCanvas, 'mm_curvature.png');
  }
  status('exported PNG texture set');
};
$('btnExportGLB').onclick = async () => {
  if (!meshRoot || !ui.finalMaps) return status('import + composite first');
  status('exporting GLB…');
  await exportGLB(meshRoot, ui.finalMaps);
  viewport.refreshMaterial();
  status('exported materialmaker.glb');
};
$('btnSave').onclick = () => {
  const d = layers.serialize();
  const blob = new Blob([JSON.stringify({ app: 'materialmaker-web', ...d })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'materialmaker-project.json'; a.click();
};
$('projInput').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  const d = JSON.parse(await f.text());
  await layers.deserialize(d);
  refreshLayerPanel(); syncMaterialInputs(); scheduleComposite();
  status('project loaded — re-bake if mesh changed');
  e.target.value = '';
});
