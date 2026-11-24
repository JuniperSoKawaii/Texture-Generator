// Renders a horizontal strip of the texture into RGBA bytes. Runs inside workers.
import { TEX, Ctx } from './textures.js';
import { compileGlobal } from './color.js';
import { smoothstep } from './noise.js';

// Output pixel (i, j) samples full-resolution position (x0 + (i + .5)·step, y0 + (j + .5)·step).
export function renderStrip({ texId, params, global, W, H, x0, y0, w, h, step, tile, seed }) {
  const tex = TEX[texId];
  if (!tex) throw new Error('Unknown texture ' + texId);
  const k = 1000 / Math.min(W, H);
  const c = new Ctx({ Wu: W * k, Hu: H * k, fp: step * k, tile, seed });
  const st = tex.setup ? tex.setup(params, c) : null;
  const g = compileGlobal(global);
  const vig = tile ? 0 : g.vig, grain = g.grain;
  const out = new Uint8ClampedArray(w * h * 4);
  let o = 0;
  for (let j = 0; j < h; j++) {
    const Y = y0 + (j + 0.5) * step, v = Y * k, dy = Y / H - 0.5;
    for (let i = 0; i < w; i++) {
      const X = x0 + (i + 0.5) * step, u = X * k;
      let t = tex.sample(u, v, c, params, st);
      if (grain) t += grain * 0.3 * (c.grain(u, v, 0.9, 999) + 0.6 * c.grain(u, v, 0.55, 998));
      if (vig) { const dx = X / W - 0.5; t *= 1 - vig * smoothstep(0.1, 1, (dx * dx + dy * dy) * 2); }
      t = (t - 0.5) * g.c + 0.5 + g.b;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (g.inv) t = 1 - t;
      out[o] = g.lr + g.dr * t;
      out[o + 1] = g.lg + g.dg * t;
      out[o + 2] = g.lb + g.db * t;
      out[o + 3] = g.la + g.da * t;
      o += 4;
    }
  }
  return out;
}
