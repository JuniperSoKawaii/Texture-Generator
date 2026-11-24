// Smoke test: every texture renders (raster + tileable + SVG) without errors and produces sane tones.
import { TEXTURES, defaultParams } from '../js/textures.js';
import { renderStrip } from '../js/render.js';
import { buildSvg } from '../js/svg.js';
import { DEFAULT_GLOBAL } from '../js/color.js';
import { resolveSize, SIZE_GROUPS } from '../js/sizes.js';

let failed = 0;
const fail = (m) => { failed++; console.error('FAIL', m); };

for (const tex of TEXTURES) {
  const params = defaultParams(tex);
  const global = { ...DEFAULT_GLOBAL, ...tex.colors, low: '#000000', high: '#ffffff', lowA: 1, highA: 1 };
  for (const tile of [false, true]) {
    const t0 = performance.now();
    const W = 300, H = 200;
    const buf = renderStrip({ texId: tex.id, params, global, W, H, x0: 0, y0: 0, w: W, h: H, step: 1, tile, seed: 42 });
    const ms = performance.now() - t0;
    let sum = 0, min = 255, max = 0, nan = 0;
    for (let i = 0; i < buf.length; i += 4) { const v = buf[i]; sum += v; if (v < min) min = v; if (v > max) max = v; }
    const mean = sum / (W * H);
    if (max - min < 10) fail(`${tex.id} tile=${tile} is flat (min ${min} max ${max})`);
    // Seamless check: compare left column with the column just past the right edge.
    if (tile) {
      const edge = renderStrip({ texId: tex.id, params, global, W, H, x0: W, y0: 0, w: 1, h: H, step: 1, tile, seed: 42 });
      let diff = 0;
      for (let y = 0; y < H; y++) diff += Math.abs(edge[y * 4] - buf[y * W * 4]);
      if (diff / H > 1) fail(`${tex.id} not seamless (avg diff ${(diff / H).toFixed(2)})`);
    }
    console.log(`${tex.id.padEnd(10)} tile=${tile ? 1 : 0} mean=${mean.toFixed(0).padStart(3)} range=${min}-${max} ${(ms / (W * H) * 1e6).toFixed(0)} ns/px`);
  }
  const svg = buildSvg(tex, params, { ...DEFAULT_GLOBAL, ...tex.colors }, { W: 1200, H: 800, tile: false, seed: 42 });
  if (svg === null) console.log(`${tex.id}: svg overflow (falls back to bitmap)`);
  else if (!svg.includes('<svg')) fail(tex.id + ' svg');
  const svgT = buildSvg(tex, params, { ...DEFAULT_GLOBAL, ...tex.colors }, { W: 512, H: 512, tile: true, seed: 42 });
  if (svgT !== null && !svgT.includes('<svg')) fail(tex.id + ' svg tile');
}

for (const g of SIZE_GROUPS) for (const it of g.items) {
  const r = resolveSize({ group: g.id, preset: it[0], swap: false, dpi: 300, bleed: false, custom: { w: 1, h: 1, unit: 'px' } });
  if (!(r.W > 0 && r.H > 0)) fail('size ' + it[0]);
}
const a4 = resolveSize({ group: 'paper', preset: 'a4', dpi: 300, custom: {} });
if (a4.W !== 2480 || a4.H !== 3508) fail(`A4@300 = ${a4.W}x${a4.H}`);

if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log('All good');
