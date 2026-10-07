# MaterialMaker Web — Substance Painter clone (100% client-side)

Browser-based PBR texture authoring: import → auto-UV → bake (normals/AO/curvature/position/ID) → layered smart materials + 3D painting → export. No server. Ready for GitHub Pages.

## Run locally

No build step. Just serve statically:

```bash
npx serve .
# or
python -m http.server 8000
```

Open http://localhost:8000

## Deploy to GitHub Pages

1. Push this folder to GitHub.
2. Settings → Pages → Deploy from branch → `main` / `/ (root)`.
3. Done. All heavy lifting (baking, painting, compositing) runs on the user's GPU/CPU.

Included workflow `.github/workflows/pages.yml` auto-deploys on push to `main`.

## Features (MVP)

- Import: `.obj` `.gltf` `.glb` `.stl` (drag & drop too), keeps original UVs if present
- Auto-UV: Box / Spherical / Planar projection if missing + UV inspector
- Baker (GPU raster + CPU raycast):
  - World/Object normal, Position, ID/polygroup, Mask coverage
  - AO via `three-mesh-bvh` hemisphere raycast (adjustable samples + distance + resolution)
  - Curvature from normal derivatives, Edge-wear helper
- Layers: Photoshop-style stack, opacity, blend modes (normal/multiply/screen/overlay/add)
- Smart materials: steel, rust, gold, copper, plastic, leather, concrete + procedural variation driven by AO/curvature/noise
- Masks per layer: Fill, baked generators (AO, curvature, edge, dirt, top-grunge), + paint/erase directly in 3D
- Brushes: size/flow/spacing/softness, paint mask or paint color/material, symmetry off for MVP
- Viewport: Three.js PBR, IBL environment, wireframe, solo albedo/normal/rough/metal/AO/UV/checker
- Export: PNG texture set (albedo/normal/rough/metal/AO), `.glb` with baked PBR, project JSON save/load

## Limits vs Substance Painter

- Single texture set / single UDIM, one material (multi-material split via ID mask, not multi-set)
- Auto-UV is projection-based, not seam-unwrap like xatlas/Blender. For hero assets, import pre-unwrapped models.
- AO baker is CPU raycast — use 512/1024 + 32–64 rays for interactivity, 2048 + 128 for final.
- No particle brushes / anchor points yet.

## Structure

```
index.html
styles.css
js/
  app.js        boot + UI wiring
  viewport.js   three.js scene + PBR + debug views
  io.js         import (obj/gltf/stl) + export (png/glb/project)
  uv.js         projection UVs + UV preview
  baker.js      normal/pos/ID raster + AO raycast + curvature
  layers.js     layer stack + compositing to final maps
  materials.js  smart material presets + procedural noise
  paint.js      3D→UV brush painting
```

## Tech

- `three@0.160.0` via CDN importmap, `three-mesh-bvh` for raycasts, all static.
