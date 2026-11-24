# Texture Generator

A static, in-browser texture generator for web and print. Pick a texture, tune it, choose an output size, and download a **PNG, JPEG, WebP or SVG**. Everything renders locally in your browser — nothing is uploaded — so it runs on GitHub Pages with no server or build step.

## Features

**27 procedural textures**, grouped into tabs in the picker:

- **Paper (15):** Paper · Watercolour (cold-press) · Kraft / cardboard · Recycled / newsprint · Aged parchment · Smooth / vellum · Speckled stock · Felt-finish cover · Butcher / packing paper · Laid paper · Washi / mulberry · Chipboard / grey board · Linen-finish stationery · Crumpled paper · Pastel paper (honeycomb)
- **Grain & noise:** Film grain · Noise / clouds · Speckle · Halftone
- **Grunge:** Dirt / grunge · Dust & scratches · Concrete · Plaster / stucco
- **Material:** Canvas / linen · Marble · Leather · Granite

Several of the paper finishes take their cue from speciality cover stocks such as those from French Paper Company — smooth bright vellums, speckled recycled stock, felt-pressed cover and vintage packing papers — and pair well with the bold colour presets.

Each texture has its own controls (scale, fibres, coverage, roughness, …) plus a seed, so results are reproducible.

**Colour & transparency** – every texture is a tone map between a *Base* colour and a *Texture* colour, each with its own opacity:

- **Opaque** – a normal filled image.
- **Transparent base** – only the texture remains (dirt, dust, grain overlays to drop on top of artwork).
- **Cut-out** – the texture punches holes in the base colour.
- Plus overall opacity, colour presets, brightness/contrast, invert, extra grain and vignette.

**Sizes** – presets for screens (HD → 5K, phone/tablet wallpapers), social media (Instagram, Stories, Open Graph, X, LinkedIn, YouTube, Pinterest), seamless tiles (256–4096 px) and print (A0–A6, Letter, Legal, Tabloid, business cards, photo and poster sizes) at 72–600 DPI, with optional bleed, or any custom size in px / in / mm / cm.

**Seamless tiles** – any texture can be made to repeat without visible edges; preview it as a 2×2 repeat.

**Export**

| Format | Notes |
| --- | --- |
| PNG | Lossless, full alpha. Streamed through a custom encoder, so very large print files don't hit browser canvas limits, and the DPI is embedded (`pHYs`) so InDesign/Affinity/Photoshop place it at the right physical size. Fully opaque images are saved as RGB to keep files smaller. |
| JPEG | Quality slider; DPI embedded (JFIF). Transparent areas are flattened onto a background colour you choose. |
| WebP | Quality slider, keeps transparency. |
| SVG | **Procedural vector** – a tiny, resolution-independent file built from SVG filters (`feTurbulence`, lighting, displacement) and real vector shapes. Speckle, halftone and dust & scratches are pure vector shapes that open in any editor; several papers (speckled stock, chipboard, washi) mix filters with real vector flecks. **Exact bitmap in SVG** – pixel-identical to the PNG, wrapped in an SVG (useful for tools that ignore SVG filters, such as Figma). Print SVGs carry physical `width`/`height` (e.g. `210mm`). |

**Other niceties** – Fit and 100 % (actual pixels, drag to pan) previews, multi-threaded rendering in Web Workers, settings remembered between visits, and **Copy link** to share an exact setup.

## Publishing on GitHub Pages

Option A — GitHub Actions (recommended; runs the smoke test before each deploy):

1. Merge to `main`.
2. In the repo go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. The `Deploy to GitHub Pages` workflow publishes the site on every push to `main` (or run it manually from the Actions tab).

Option B — deploy from a branch: **Settings → Pages → Source: Deploy from a branch**, pick `main` and `/ (root)`. The `.nojekyll` file makes sure every file is served as-is.

## Running locally

The app uses ES modules and module Web Workers, so it must be served over HTTP (opening `index.html` from disk won't work):

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Run the smoke test (renders every texture, checks seamless tiling and SVG output) with Node 18+:

```bash
npm test
```

## How it works

- `js/noise.js` – deterministic gradient noise, fBm, Worley cells, scattered dots/lines, all optionally periodic for seamless tiles. Coordinates are in "units" where the shorter image side is always 1000, so a texture looks the same at 800 px and 8000 px, and detail finer than a preview pixel is faded out so previews are an honest downscale of the export.
- `js/textures.js` – the texture definitions: parameters, a per-pixel `sample()` function and an `svg()` recipe.
- `js/render.js`, `js/render-worker.js`, `js/pool.js` – strip-based rendering across a pool of Web Workers.
- `js/encode.js` – streaming PNG encoder (`CompressionStream`), JPEG/PNG DPI metadata.
- `js/svg.js` – the procedural SVG builder and tone → colour mapping shared with the raster renderer.
- `js/sizes.js` – size presets and unit/DPI conversion.
- `js/app.js` – UI, preview and export.

### Limits

- Exports are capped at 30,000 px per side / 250 megapixels. Big print sizes (e.g. A0 at 300 dpi) take a while; PNG keeps memory low by streaming, while JPEG/WebP need the full image in a canvas (Safari limits canvases to about 16 MP, so use PNG for large files there).
- Procedural SVGs approximate the raster preview; SVG filter rendering differs a little between apps. Use **Preview SVG** to check, or the exact-bitmap option when you need a pixel match.
