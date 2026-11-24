// Shared tone → colour mapping, used identically by the raster renderer and the SVG exporter.

export const DEFAULT_GLOBAL = {
  brightness: 0,
  contrast: 1,
  invert: false,
  vignette: 0,
  grain: 0,
  low: '#3a3226',
  lowA: 1,
  high: '#f6f1e6',
  highA: 1,
  opacity: 1,
};

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
}

// Precompute everything the per-pixel hot loop needs.
export function compileGlobal(g) {
  const lo = hexToRgb(g.low), hi = hexToRgb(g.high);
  return {
    c: g.contrast, b: g.brightness, inv: !!g.invert,
    vig: g.vignette, grain: g.grain,
    lr: lo[0], lg: lo[1], lb: lo[2], la: g.lowA * 255 * g.opacity,
    dr: hi[0] - lo[0], dg: hi[1] - lo[1], db: hi[2] - lo[2],
    da: (g.highA - g.lowA) * 255 * g.opacity,
  };
}

export function adjustTone(v, cg) {
  v = (v - 0.5) * cg.c + 0.5 + cg.b;
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  return cg.inv ? 1 - v : v;
}

// Returns [r, g, b, a(0..1)] for a raw tone (before adjustments).
export function toneToRGBA(v, cg) {
  const t = adjustTone(v, cg);
  return [cg.lr + cg.dr * t, cg.lg + cg.dg * t, cg.lb + cg.db * t, (cg.la + cg.da * t) / 255];
}

export function cssRGBA([r, g, b, a]) {
  return { fill: rgbToHex([r, g, b]), opacity: Math.round(a * 1000) / 1000 };
}
