// Texture library.
//
// Each texture returns a tone in [0, 1] per sample: 1 = base/paper colour
// ("Base" in the UI), 0 = ink/shadow colour ("Texture" in the UI). Colour and
// transparency are applied afterwards by the shared gradient map, so every
// texture supports opaque, transparent-base and cut-out output.
//
// sample(u, v, c, p, st): u, v in units (short side = 1000), c = Ctx, p = params, st = setup().
// svg(p, S): builds an SVG approximation (filters and/or exact vector shapes).

import { Ctx, gnoise, hash3, rnd, mod, mulberry32, lineSeg, clamp01, smoothstep } from './noise.js';

const R = (id, label, min, max, step, value, extra = {}) => ({ id, label, type: 'range', min, max, step, value, ...extra });
const SEL = (id, label, options, value, extra = {}) => ({ id, label, type: 'select', options, value, ...extra });
const SCALE = R('scale', 'Scale', 0.25, 4, 0.05, 1, { hint: 'Overall feature size' });
const mix = (a, b, t) => a + (b - a) * t;

// ---- helpers shared by the SVG recipes -------------------------------------------------

function svgCtx(S) {
  return new Ctx({ Wu: S.Wu, Hu: S.Hu, fp: S.k, tile: S.tile, seed: S.seed });
}

// Enumerate exactly the dots Ctx.dots() renders, over the whole image.
function eachDot(c, cell, so, density, rmin, rmax, cb) {
  const [cw, ch, nx, ny] = c._grid(cell);
  const seed = c.seed + so * 7919;
  const whole = Math.floor(density), frac = density - whole;
  const X0 = nx ? 0 : -1, X1 = nx ? nx - 1 : Math.ceil(c.Wu / cw);
  const Y0 = ny ? 0 : -1, Y1 = ny ? ny - 1 : Math.ceil(c.Hu / ch);
  for (let cy = Y0; cy <= Y1; cy++) {
    for (let cx = X0; cx <= X1; cx++) {
      const hx = nx ? mod(cx, nx) : cx, hy = ny ? mod(cy, ny) : cy;
      const h0 = hash3(hx, hy, seed);
      const count = whole + ((h0 & 0xffff) / 65536 < frac ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const h1 = hash3(h0, i, seed + 1), h2 = hash3(h1, i, seed + 2);
        const px = (cx + (h1 & 0xffff) / 65536) * cw;
        const py = (cy + (h1 >>> 16) / 65536) * ch;
        const r3 = (h2 & 0xffff) / 65536;
        const r = rmin + (rmax - rmin) * r3 * r3;
        const tone = (h2 >>> 16) / 65536;
        wrapEmit(c, px, py, r, (x, y) => cb(x, y, r, tone));
      }
    }
  }
}

function eachLine(c, cell, so, density, len, width, cb) {
  const [cw, ch, nx, ny] = c._grid(cell);
  const seed = c.seed + so * 7919;
  const whole = Math.floor(density), frac = density - whole;
  const X0 = nx ? 0 : -1, X1 = nx ? nx - 1 : Math.ceil(c.Wu / cw);
  const Y0 = ny ? 0 : -1, Y1 = ny ? ny - 1 : Math.ceil(c.Hu / ch);
  for (let cy = Y0; cy <= Y1; cy++) {
    for (let cx = X0; cx <= X1; cx++) {
      const hx = nx ? mod(cx, nx) : cx, hy = ny ? mod(cy, ny) : cy;
      const h0 = hash3(hx, hy, seed);
      const count = whole + ((h0 & 0xffff) / 65536 < frac ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const s = lineSeg(h0, i, seed, cx, cy, cw, ch, len, width);
        const { x1, y1, x2, y2, w, tone } = s;
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, reach = Math.hypot(x2 - x1, y2 - y1) / 2 + w;
        wrapEmit(c, mx, my, reach, (x, y) => cb(x1 + x - mx, y1 + y - my, x2 + x - mx, y2 + y - my, w, tone));
      }
    }
  }
}

// In tile mode, repeat shapes that straddle an edge on the opposite side.
function wrapEmit(c, x, y, r, emit) {
  if (!c.tile) { emit(x, y); return; }
  const xs = [x], ys = [y];
  if (x - r < 0) xs.push(x + c.Wu); if (x + r > c.Wu) xs.push(x - c.Wu);
  if (y - r < 0) ys.push(y + c.Hu); if (y + r > c.Hu) ys.push(y - c.Hu);
  for (const a of xs) for (const b of ys) emit(a, b);
}

function svgDots(S, cell, so, density, rmin, rmax, toneFn) {
  const c = svgCtx(S);
  eachDot(c, cell, so, density, rmin, rmax, (x, y, r, tone) => S.circle(x, y, r, toneFn(tone)));
}

function svgLines(S, cell, so, density, len, width, toneFn) {
  const c = svgCtx(S);
  eachLine(c, cell, so, density, len, width, (x1, y1, x2, y2, w, tone) => S.line(x1, y1, x2, y2, w, toneFn(tone)));
}

// Fibre directions: free angles normally, axis-aligned stretches when tiling.
function fiberDirs(c, n, so) {
  const rng = mulberry32(c.seed + so);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (c.tile) out.push({ rot: false, ax: i % 2 ? 1 : 0.15, ay: i % 2 ? 0.15 : 1, i });
    else { const a = rng() * Math.PI; out.push({ rot: true, cs: Math.cos(a), sn: Math.sin(a), ax: 0.15, ay: 1, i }); }
  }
  return out;
}

function fibers(u, v, c, dirs, f, so, sharp) {
  let sum = 0;
  for (const d of dirs) {
    let x = u, y = v;
    if (d.rot) { x = u * d.cs + v * d.sn; y = -u * d.sn + v * d.cs; }
    const n = c.fbm(x, y, f, 3, 0.5, so + d.i, d.ax, d.ay);
    const r = 1 - Math.abs(n) * sharp;
    if (r > 0) sum += r * r;
  }
  return sum;
}

function svgFibers(S, f, so, sharp, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const L = S.turb(f, 3, { so: so + i, ax: i % 2 ? 1 : 0.15, ay: i % 2 ? 0.15 : 1 });
    out.push(S.ridge(L, sharp));
  }
  return out;
}

// ---- texture definitions ---------------------------------------------------------------

export const TEXTURES = [
  {
    id: 'paper', name: 'Paper', group: 'Paper',
    desc: 'Smooth writing paper with fibres, tooth and soft mottling.',
    params: [SCALE, R('fibers', 'Fibres', 0, 1, 0.01, 0.5), R('tooth', 'Tooth', 0, 1, 0.01, 0.45),
      R('mottle', 'Mottling', 0, 1, 0.01, 0.4), R('flecks', 'Flecks', 0, 1, 0.01, 0.1)],
    colors: { low: '#8f8574', lowA: 1, high: '#fbf8f1', highA: 1 },
    setup: (p, c) => ({ dirs: fiberDirs(c, 3, 5) }),
    sample(u, v, c, p, st) {
      const s = p.scale;
      let t = 0.9;
      if (p.mottle) t += p.mottle * 0.14 * c.fbm(u, v, 0.0035 / s, 5, 0.5, 1);
      if (p.fibers) t -= p.fibers * 0.08 * fibers(u, v, c, st.dirs, 0.03 / s, 10, 12);
      if (p.tooth) t += p.tooth * 0.07 * c.reliefFbm(u, v, 0.05 / s, 4, 0.55, 20);
      if (p.flecks) { const cv = c.dots(u, v, 30 * s, 3, p.flecks * 1.5, 0.4 * s, 1.6 * s); t -= cv * (0.15 + 0.25 * c.tone); }
      return t;
    },
    svg(p, S) {
      const s = p.scale;
      const fib = svgFibers(S, 0.03 / s, 10, 1, 2).map((L) => S.gamma(L, 12));
      const out = S.mix(0.9, [
        [S.turb(0.0035 / s, 5, { so: 1 }), p.mottle * 0.3],
        [fib[0], -p.fibers * 0.09], [fib[1], -p.fibers * 0.09],
        [S.relief(S.turb(0.05 / s, 4, { so: 20 }), 6 * s), p.tooth * 0.12],
      ]);
      if (p.flecks) svgDots(S, 30 * s, 3, p.flecks * 1.5, 0.4 * s, 1.6 * s, (tn) => 0.9 - (0.15 + 0.25 * tn));
      return out;
    },
  },

  {
    id: 'coldpress', name: 'Watercolour paper', group: 'Paper',
    desc: 'Cold-press cotton paper with a pebbled, embossed surface.',
    params: [SCALE, R('relief', 'Relief', 0, 1, 0.01, 0.7), R('mottle', 'Mottling', 0, 1, 0.01, 0.35), R('fibers', 'Fibres', 0, 1, 0.01, 0.2)],
    colors: { low: '#9c968a', lowA: 1, high: '#fdfcf8', highA: 1 },
    setup(p, c) {
      const s = p.scale, f1 = 0.035 / s, f2 = 0.09 / s;
      const h = (a, b) => {
        c.cells(a + 6 * s * c.fbm(a, b, 0.02 / s, 2, 0.5, 9), b, f1, 4, 0.9);
        const bump = 1 - Math.min(1, c.f1 * 1.1);
        return (bump * bump * 0.7) * c.wt(f1) + 0.3 * c.fbm(a, b, f2, 3, 0.5, 5);
      };
      return { h, f1, dirs: fiberDirs(c, 2, 7) };
    },
    sample(u, v, c, p, st) {
      const s = p.scale;
      let t = 0.86;
      if (p.relief) t += p.relief * 0.12 * c.relief(st.h, u, v) / (st.f1 * 1.5);
      if (p.mottle) t += p.mottle * 0.12 * c.fbm(u, v, 0.004 / s, 4, 0.5, 1);
      if (p.fibers) t -= p.fibers * 0.05 * fibers(u, v, c, st.dirs, 0.03 / s, 12, 12);
      return t;
    },
    svg(p, S) {
      const s = p.scale;
      const bumps = S.turb(0.035 / s, 3, { so: 4, type: 'turbulence' });
      const fib = svgFibers(S, 0.03 / s, 12, 1, 2).map((L) => S.gamma(L, 12));
      return S.mix(0.86, [
        [S.relief(S.invert(bumps), 10 * s), p.relief * 0.35],
        [S.turb(0.004 / s, 4, { so: 1 }), p.mottle * 0.26],
        [fib[0], -p.fibers * 0.09], [fib[1], -p.fibers * 0.09],
      ]);
    },
  },

  {
    id: 'kraft', name: 'Kraft / cardboard', group: 'Paper',
    desc: 'Brown kraft paper with long fibres and dark inclusions.',
    params: [SCALE, R('fibers', 'Fibres', 0, 1, 0.01, 0.7), R('flecks', 'Flecks', 0, 1, 0.01, 0.4), R('mottle', 'Mottling', 0, 1, 0.01, 0.5)],
    colors: { low: '#4a311b', lowA: 1, high: '#d9ae7c', highA: 1 },
    setup: (p, c) => ({ dirs: fiberDirs(c, 4, 3) }),
    sample(u, v, c, p, st) {
      const s = p.scale;
      let t = 0.66;
      t += p.mottle * 0.2 * c.fbm(u, v, 0.004 / s, 5, 0.5, 1);
      if (p.fibers) {
        const a = fibers(u, v, c, st.dirs.slice(0, 2), 0.025 / s, 10, 10);
        const b = fibers(u, v, c, st.dirs.slice(2), 0.04 / s, 14, 14);
        t += p.fibers * (0.07 * a - 0.09 * b);
      }
      t += 0.04 * c.grain(u, v, 1.2 * s, 30);
      if (p.flecks) { const cv = c.dots(u, v, 22 * s, 3, p.flecks * 1.6, 0.4 * s, 2 * s); t -= cv * (0.2 + 0.35 * c.tone); }
      return t;
    },
    svg(p, S) {
      const s = p.scale;
      const a = svgFibers(S, 0.025 / s, 10, 1, 2).map((L) => S.gamma(L, 10));
      const b = svgFibers(S, 0.04 / s, 14, 1, 2).map((L) => S.gamma(L, 14));
      const out = S.mix(0.66, [
        [S.turb(0.004 / s, 5, { so: 1 }), p.mottle * 0.4],
        [a[0], p.fibers * 0.07], [a[1], p.fibers * 0.07], [b[0], -p.fibers * 0.09], [b[1], -p.fibers * 0.09],
        [S.turb(1 / (1.2 * s), 1, { so: 30 }), 0.12],
      ]);
      if (p.flecks) svgDots(S, 22 * s, 3, p.flecks * 1.6, 0.4 * s, 2 * s, (tn) => 0.66 - (0.2 + 0.35 * tn));
      return out;
    },
  },

  {
    id: 'recycled', name: 'Recycled / newsprint', group: 'Paper',
    desc: 'Greyish recycled stock speckled with inclusions.',
    params: [SCALE, R('flecks', 'Inclusions', 0, 1, 0.01, 0.55), R('fibers', 'Fibres', 0, 1, 0.01, 0.4), R('mottle', 'Mottling', 0, 1, 0.01, 0.4)],
    colors: { low: '#3f3c37', lowA: 1, high: '#ece7dc', highA: 1 },
    setup: (p, c) => ({ dirs: fiberDirs(c, 3, 8) }),
    sample(u, v, c, p, st) {
      const s = p.scale;
      let t = 0.86;
      t += p.mottle * 0.12 * c.fbm(u, v, 0.005 / s, 5, 0.5, 1);
      if (p.fibers) t -= p.fibers * 0.06 * fibers(u, v, c, st.dirs, 0.035 / s, 10, 12);
      t += 0.03 * c.grain(u, v, 1 * s, 30);
      if (p.flecks) {
        const a = c.dots(u, v, 12 * s, 3, p.flecks * 1.2, 0.25 * s, 1.1 * s);
        const ta = c.tone;
        const b = c.dots(u, v, 60 * s, 4, p.flecks * 0.9, 1 * s, 3.5 * s);
        t -= Math.max(a * (0.25 + 0.45 * ta), b * (0.1 + 0.25 * c.tone));
      }
      return t;
    },
    svg(p, S) {
      const s = p.scale;
      const fib = svgFibers(S, 0.035 / s, 10, 1, 2).map((L) => S.gamma(L, 12));
      const out = S.mix(0.86, [[S.turb(0.005 / s, 5, { so: 1 }), p.mottle * 0.26], [fib[0], -p.fibers * 0.1], [fib[1], -p.fibers * 0.1], [S.turb(1 / s, 1, { so: 30 }), 0.09]]);
      if (p.flecks) {
        svgDots(S, 60 * s, 4, p.flecks * 0.9, 1 * s, 3.5 * s, (tn) => 0.86 - (0.1 + 0.25 * tn));
        svgDots(S, 12 * s, 3, p.flecks * 1.2, 0.25 * s, 1.1 * s, (tn) => 0.86 - (0.25 + 0.45 * tn));
      }
      return out;
    },
  },

  {
    id: 'parchment', name: 'Aged parchment', group: 'Paper',
    desc: 'Old paper with blotches, tide-line stains and burnt edges.',
    params: [SCALE, R('blotch', 'Blotches', 0, 1, 0.01, 0.6), R('stains', 'Stains', 0, 1, 0.01, 0.5),
      R('edges', 'Edge burn', 0, 1, 0.01, 0.5, { hint: 'Disabled when seamless' }), R('fibers', 'Fibres', 0, 1, 0.01, 0.3)],
    colors: { low: '#5c3d18', lowA: 1, high: '#f6e7c6', highA: 1 },
    setup: (p, c) => ({ dirs: fiberDirs(c, 2, 4) }),
    sample(u, v, c, p, st) {
      const s = p.scale;
      let t = 0.82 + p.blotch * 0.25 * c.fbm(u, v, 0.0025 / s, 6, 0.55, 1);
      if (p.stains) {
        const n = c.fbm(u, v, 0.002 / s, 5, 0.55, 7) + 0.03 * c.fbm(u, v, 0.03 / s, 3, 0.5, 8);
        const ring = 1 - smoothstep(0, 0.025, Math.abs(n - 0.12));
        t -= p.stains * (ring * 0.22 + (n > 0.12 ? 0.07 : 0));
      }
      if (p.edges && !c.tile) {
        const e = Math.min(u, v, c.Wu - u, c.Hu - v) + 25 * c.fbm(u, v, 0.01, 4, 0.5, 11);
        t -= p.edges * 0.6 * (1 - smoothstep(0, 140, e));
      }
      if (p.fibers) t -= p.fibers * 0.05 * fibers(u, v, c, st.dirs, 0.03 / s, 12, 12);
      t += 0.025 * c.grain(u, v, 1.2, 30);
      return t;
    },
    svg(p, S) {
      const s = p.scale;
      const st = S.turb(0.002 / s, 5, { so: 7 });
      const ring = S.gamma(S.tbl(st, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), 1.5);
      const fib = svgFibers(S, 0.03 / s, 12, 1, 2).map((L) => S.gamma(L, 12));
      const out = S.mix(0.82, [
        [S.turb(0.0025 / s, 6, { so: 1 }), p.blotch * 0.5],
        [ring, -p.stains * 0.3],
        [fib[0], -p.fibers * 0.09], [fib[1], -p.fibers * 0.09],
        [S.turb(1 / 1.2, 1, { so: 30 }), 0.08],
      ]);
      if (p.edges && !S.tile) {
        const id = S.id('burn');
        S.defs.push(`<radialGradient id="${id}" cx="50%" cy="50%" r="75%"><stop offset="0.55" stop-color="{low}" stop-opacity="0"/><stop offset="1" stop-color="{low}" stop-opacity="${Math.min(1, p.edges * 0.9)}"/></radialGradient>`);
        S.overlay(`<rect width="${S.W}" height="${S.H}" fill="url(#${id})"/>`);
      }
      return out;
    },
  },

  {
    id: 'grain', name: 'Film grain', group: 'Grain & noise',
    desc: 'Photographic grain. Great as an overlay at low opacity.',
    params: [R('size', 'Grain size', 0.3, 8, 0.05, 1.6), R('amount', 'Amount', 0, 1, 0.01, 0.6),
      R('clump', 'Clumping', 0, 1, 0.01, 0.3), R('base', 'Base tone', 0, 1, 0.01, 0.5)],
    colors: { low: '#000000', lowA: 1, high: '#ffffff', highA: 1 },
    sample(u, v, c, p) {
      const g = c.grain(u, v, p.size, 1) * 0.7 + c.grain(u, v, p.size * 0.6, 2) * 0.45;
      const k = p.clump ? 1 + p.clump * 1.6 * c.fbm(u, v, 0.015, 3, 0.5, 3) : 1;
      return p.base + p.amount * 0.55 * g * k;
    },
    svg(p, S) {
      const a = S.turb(1 / p.size, 1, { so: 1 }), b = S.turb(1 / (p.size * 0.6), 1, { so: 2 });
      let g = S.mix(0.5, [[a, 1.1], [b, 0.75]]);
      if (p.clump) g = S.mix(0.5, [[g, 1], [S.turb(0.015, 3, { so: 3 }), 0]]);
      return S.mix(p.base, [[g, p.amount * 1.1]]);
    },
  },

  {
    id: 'clouds', name: 'Noise / clouds', group: 'Grain & noise',
    desc: 'Fractal noise: soft clouds, turbulent smoke or ridged veins.',
    params: [SCALE, R('detail', 'Detail', 1, 10, 1, 6), R('rough', 'Roughness', 0.3, 0.8, 0.01, 0.5),
      SEL('style', 'Style', [['smooth', 'Smooth'], ['turbulent', 'Turbulent'], ['ridged', 'Ridged']], 'smooth')],
    colors: { low: '#1d2230', lowA: 1, high: '#e9ecf2', highA: 1 },
    sample(u, v, c, p) {
      const n = c.fbm(u, v, 0.004 / p.scale, p.detail, p.rough, 1);
      if (p.style === 'turbulent') return Math.abs(n) * 2.4;
      if (p.style === 'ridged') { const r = 1 - Math.abs(n) * 2.4; return r * r; }
      return 0.5 + n * 1.2;
    },
    svg(p, S) {
      if (p.style === 'smooth') return S.mix(0.5, [[S.turb(0.004 / p.scale, p.detail, { so: 1 }), 2]]);
      const t = S.lv(S.turb(0.004 / p.scale, p.detail, { so: 1, type: 'turbulence' }), 0, 0.6);
      return p.style === 'turbulent' ? t : S.gamma(S.invert(t), 2);
    },
  },

  {
    id: 'speckle', vector: true, name: 'Speckle', group: 'Grain & noise',
    desc: 'Random dots — terrazzo flecks, spray paint, stars.',
    params: [R('density', 'Density', 0.05, 3, 0.01, 0.8), R('size', 'Size', 0.3, 6, 0.05, 1.2),
      R('variation', 'Size variation', 0, 1, 0.01, 0.7), R('tonevar', 'Tone variation', 0, 1, 0.01, 0.3)],
    colors: { low: '#1f1f1f', lowA: 1, high: '#f7f4ee', highA: 1 },
    sample(u, v, c, p) {
      const rmax = p.size * 2;
      const cv = c.dots(u, v, rmax * 6, 1, p.density, rmax * (1 - p.variation * 0.85), rmax);
      return 1 - cv * (1 - p.tonevar * c.tone);
    },
    svg(p, S) {
      const rmax = p.size * 2;
      svgDots(S, rmax * 6, 1, p.density, rmax * (1 - p.variation * 0.85), rmax, (tn) => p.tonevar * tn);
      return null;
    },
  },

  {
    id: 'halftone', vector: true, name: 'Halftone', group: 'Grain & noise',
    desc: 'Print-style halftone screen. Exports as true vector dots.',
    params: [R('cell', 'Cell size', 3, 60, 0.5, 12), R('angle', 'Screen angle', 0, 90, 1, 45, { hint: 'Ignored when seamless' }),
      SEL('shape', 'Dot shape', [['dot', 'Round'], ['square', 'Square'], ['line', 'Lines']], 'dot'),
      SEL('tone', 'Tone source', [['noise', 'Noise'], ['gx', 'Gradient →'], ['gy', 'Gradient ↓'], ['radial', 'Radial'], ['flat', 'Flat']], 'noise'),
      R('level', 'Tone level', 0, 1, 0.01, 0.5), R('spread', 'Tone range', 0, 1.5, 0.01, 0.9), R('nscale', 'Noise scale', 0.25, 4, 0.05, 1)],
    colors: { low: '#161616', lowA: 1, high: '#ffffff', highA: 1 },
    setup(p, c) {
      const ang = c.tile ? 0 : (p.angle * Math.PI) / 180;
      let cw = p.cell, ch = p.cell;
      if (c.tile) { cw = c.Wu / Math.max(1, Math.round(c.Wu / p.cell)); ch = c.Hu / Math.max(1, Math.round(c.Hu / p.cell)); }
      const keys = new Int32Array(2048).fill(0x7fffffff), keys2 = new Int32Array(2048), vals = new Float64Array(2048);
      return { cs: Math.cos(ang), sn: Math.sin(ang), cw, ch, keys, keys2, vals };
    },
    tone(c, p, u, v) {
      let t;
      switch (p.tone) {
        case 'gx': t = u / c.Wu; break;
        case 'gy': t = v / c.Hu; break;
        case 'radial': t = 1 - Math.min(1, Math.hypot(u - c.Wu / 2, v - c.Hu / 2) / (Math.hypot(c.Wu, c.Hu) / 2)); break;
        case 'flat': t = 0.5; break;
        default: t = 0.5 + 1.1 * c.fbm(u, v, 0.003 / p.nscale, 4, 0.5, 1);
      }
      return clamp01(p.level + (t - 0.5) * p.spread);
    },
    sample(u, v, c, p, st) {
      const { cs, sn, cw, ch } = st;
      const ru = u * cs + v * sn, rv = -u * sn + v * cs;
      const gi = Math.floor(ru / cw), gj = Math.floor(rv / ch);
      const area = cw * ch, fp = c.fp;
      let best = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = gi + di, j = gj + dj;
          // Small cache: neighbouring pixels share cell tones.
          const slot = ((i * 73856093) ^ (j * 19349663)) & 2047;
          let ink;
          if (st.keys[slot] === i && st.keys2[slot] === j) ink = st.vals[slot];
          else {
            const rcx = (i + 0.5) * cw, rcy = (j + 0.5) * ch;
            ink = 1 - TEX.halftone.tone(c, p, rcx * cs - rcy * sn, rcx * sn + rcy * cs);
            st.keys[slot] = i; st.keys2[slot] = j; st.vals[slot] = ink;
          }
          if (ink <= 0) continue;
          const dx = ru - (i + 0.5) * cw, dy = rv - (j + 0.5) * ch;
          let d, r;
          if (p.shape === 'square') { r = Math.sqrt(ink * area) / 2; d = Math.max(Math.abs(dx), Math.abs(dy)); }
          else if (p.shape === 'line') { if (di !== 0) continue; r = (ink * ch) / 2; d = Math.abs(dy); }
          else { r = Math.sqrt((ink * area) / Math.PI); d = Math.hypot(dx, dy); }
          const re = r > fp * 0.5 ? r : fp * 0.5;
          let cv = (re - d) / fp + 0.5;
          if (cv <= 0) continue;
          if (cv > 1) cv = 1;
          cv *= (r / re) * (r / re);
          if (cv > best) best = cv;
        }
      }
      return 1 - best;
    },
    svg(p, S) {
      const c = svgCtx(S);
      const st = this.setup(p, c);
      const { cs, sn, cw, ch } = st, area = cw * ch;
      // Cover the whole image in rotated grid space.
      const corners = [[0, 0], [c.Wu, 0], [0, c.Hu], [c.Wu, c.Hu]].map(([x, y]) => [x * cs + y * sn, -x * sn + y * cs]);
      const i0 = Math.floor(Math.min(...corners.map((q) => q[0])) / cw) - 1, i1 = Math.ceil(Math.max(...corners.map((q) => q[0])) / cw) + 1;
      const j0 = Math.floor(Math.min(...corners.map((q) => q[1])) / ch) - 1, j1 = Math.ceil(Math.max(...corners.map((q) => q[1])) / ch) + 1;
      if ((i1 - i0) * (j1 - j0) > S.maxShapes * 1.5) { S.overflow = true; return null; }
      const deg = (Math.atan2(sn, cs) * 180) / Math.PI;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const rcx = (i + 0.5) * cw, rcy = (j + 0.5) * ch;
          const x = rcx * cs - rcy * sn, y = rcx * sn + rcy * cs;
          if (x < -cw * 2 || y < -ch * 2 || x > c.Wu + cw * 2 || y > c.Hu + ch * 2) continue;
          const ink = 1 - this.tone(c, p, x, y);
          if (ink <= 0.002) continue;
          if (p.shape === 'square') { const a = Math.sqrt(ink * area); S.rect(x - a / 2, y - a / 2, a, a, 0, deg); }
          else if (p.shape === 'line') { const h = ink * ch; S.rect(x - cw / 2 - 0.02, y - h / 2, cw + 0.04, h, 0, deg); }
          else S.circle(x, y, Math.sqrt((ink * area) / Math.PI), 0);
        }
      }
      return null;
    },
  },

  {
    id: 'dirt', name: 'Dirt / grunge', group: 'Grunge',
    desc: 'Patchy grime and splatter. Defaults to a transparent overlay.',
    params: [SCALE, R('coverage', 'Coverage', 0, 1, 0.01, 0.35), R('rough', 'Edge roughness', 0, 1, 0.01, 0.7),
      R('inner', 'Inner texture', 0, 1, 0.01, 0.6), R('splatter', 'Splatter', 0, 1, 0.01, 0.35)],
    colors: { low: '#2b2118', lowA: 1, high: '#e8dcc6', highA: 0 },
    sample(u, v, c, p) {
      const s = p.scale;
      const n = c.fbm(u, v, 0.005 / s, 8, 0.58, 1) + 0.25 * c.fbm(u, v, 0.05 / s, 4, 0.5, 2);
      const thr = 0.3 - p.coverage * 0.6, soft = 0.01 + 0.2 * (1 - p.rough);
      const m = smoothstep(thr, thr + soft, n);
      const inner = 1 - p.inner * 0.6 * (0.5 + c.fbm(u, v, 0.02 / s, 4, 0.5, 3) * 1.4);
      let cov = m * clamp01(inner);
      if (p.splatter) cov = Math.max(cov, 0.9 * c.dots(u, v, 40 * s, 5, p.splatter * 1.5, 0.6 * s, 5 * s));
      return 1 - cov;
    },
    svg(p, S) {
      const s = p.scale;
      const n = S.mix(0.5, [[S.turb(0.005 / s, 8, { so: 1 }), 1.6], [S.turb(0.05 / s, 4, { so: 2 }), 0.4]]);
      const thr = 0.5 + (0.3 - p.coverage * 0.6) * 1.6, soft = (0.01 + 0.2 * (1 - p.rough)) * 1.6;
      const m = S.lv(n, thr, thr + soft);
      const inner = S.mix(1 - p.inner * 0.3, [[S.turb(0.02 / s, 4, { so: 3 }), -p.inner * 1.2]]);
      const cov = S.mul(m, inner);
      if (p.splatter) svgDots(S, 40 * s, 5, p.splatter * 1.5, 0.6 * s, 5 * s, () => 0.1);
      return S.invert(cov);
    },
  },

  {
    id: 'dust', vector: true, name: 'Dust & scratches', group: 'Grunge',
    desc: 'Specks, hairs and scratches. Exports as vector shapes.',
    params: [R('dust', 'Dust', 0, 1, 0.01, 0.6), R('scratches', 'Scratches', 0, 1, 0.01, 0.5),
      R('hairs', 'Hairs', 0, 1, 0.01, 0.3), R('size', 'Size', 0.3, 4, 0.05, 1.5)],
    colors: { low: '#111111', lowA: 1, high: '#ffffff', highA: 0 },
    sample(u, v, c, p) {
      const s = p.size;
      let cov = 0;
      if (p.dust) { const d = c.dots(u, v, 25 * s, 1, p.dust * 1.5, 0.45 * s, 3 * s); cov = d * (0.55 + 0.45 * c.tone); }
      if (p.scratches) { const l = c.lines(u, v, 220 * s, 2, p.scratches * 1.2, 1, 0.9 * s); cov = Math.max(cov, l * (0.4 + 0.6 * c.tone)); }
      if (p.hairs) { const l = c.lines(u, v, 90 * s, 3, p.hairs, 0.8, 1.2 * s); cov = Math.max(cov, l * 0.9); }
      return 1 - cov;
    },
    svg(p, S) {
      const s = p.size;
      if (p.scratches) svgLines(S, 220 * s, 2, p.scratches * 1.2, 1, 0.9 * s, (tn) => 1 - (0.4 + 0.6 * tn));
      if (p.hairs) svgLines(S, 90 * s, 3, p.hairs, 0.8, 1.2 * s, () => 0.1);
      if (p.dust) svgDots(S, 25 * s, 1, p.dust * 1.5, 0.45 * s, 3 * s, (tn) => 1 - (0.55 + 0.45 * tn));
      return null;
    },
  },

  {
    id: 'concrete', name: 'Concrete', group: 'Grunge',
    desc: 'Cast concrete with air pits and aggregate.',
    params: [SCALE, R('rough', 'Roughness', 0, 1, 0.01, 0.6), R('pits', 'Pits', 0, 1, 0.01, 0.5),
      R('aggregate', 'Aggregate', 0, 1, 0.01, 0.4), R('stain', 'Staining', 0, 1, 0.01, 0.5)],
    colors: { low: '#4f4d49', lowA: 1, high: '#cfccc5', highA: 1 },
    sample(u, v, c, p) {
      const s = p.scale;
      let t = 0.6 + p.stain * 0.22 * c.fbm(u, v, 0.005 / s, 6, 0.55, 1);
      t += 0.08 * c.fbm(u, v, 0.06 / s, 4, 0.6, 2);
      t += p.rough * (0.1 * c.grain(u, v, 1.3 * s, 3) + 0.05 * c.reliefFbm(u, v, 0.08 / s, 3, 0.5, 6));
      if (p.aggregate) { const cv = c.dots(u, v, 30 * s, 5, p.aggregate * 1.5, 1 * s, 4 * s); t += (c.tone - 0.5) * 0.25 * cv; }
      if (p.pits) { const cv = c.dots(u, v, 18 * s, 4, p.pits * 1.2, 0.4 * s, 2.5 * s); t -= cv * 0.4; }
      return t;
    },
    svg(p, S) {
      const s = p.scale;
      const out = S.mix(0.6, [
        [S.turb(0.005 / s, 6, { so: 1 }), p.stain * 0.45],
        [S.turb(0.06 / s, 4, { so: 2 }), 0.16],
        [S.turb(1 / (1.3 * s), 1, { so: 3 }), p.rough * 0.3],
        [S.relief(S.turb(0.08 / s, 3, { so: 6 }), 4 * s), p.rough * 0.1],
      ]);
      if (p.aggregate) svgDots(S, 30 * s, 5, p.aggregate * 1.5, 1 * s, 4 * s, (tn) => 0.6 + (tn - 0.5) * 0.25);
      if (p.pits) svgDots(S, 18 * s, 4, p.pits * 1.2, 0.4 * s, 2.5 * s, () => 0.2);
      return out;
    },
  },

  {
    id: 'stucco', name: 'Plaster / stucco', group: 'Grunge',
    desc: 'Knock-down plaster with flattened, embossed blobs.',
    params: [SCALE, R('relief', 'Relief', 0, 1, 0.01, 0.7), R('flat', 'Flattening', 0, 1, 0.01, 0.6), R('pits', 'Pits', 0, 1, 0.01, 0.25)],
    colors: { low: '#8e8679', lowA: 1, high: '#f3efe8', highA: 1 },
    setup(p, c) {
      const s = p.scale, f = 0.012 / s;
      const lo = 0.02, hi = 0.02 + 0.25 * (1 - p.flat);
      const h = (a, b) => 0.6 * smoothstep(lo, hi, c.fbm(a, b, f, 6, 0.55, 2)) + 0.4 * c.fbm(a, b, f * 3, 4, 0.5, 1);
      return { h, f };
    },
    sample(u, v, c, p, st) {
      const s = p.scale;
      let t = 0.84 + p.relief * 0.16 * c.relief(st.h, u, v) / (st.f * 6) + 0.04 * c.fbm(u, v, 0.004 / s, 4, 0.5, 9);
      if (p.pits) t -= c.dots(u, v, 20 * s, 4, p.pits * 1.2, 0.3 * s, 1.6 * s) * 0.3;
      return t;
    },
    svg(p, S) {
      const s = p.scale, f = 0.012 / s;
      const lo = 0.5 + 0.02 * 1.6, hi = lo + 0.25 * 1.6 * (1 - p.flat);
      const blobs = S.lv(S.turb(f, 6, { so: 2 }), lo, hi);
      const h = S.mix(0.5, [[blobs, 0.6], [S.turb(f * 3, 4, { so: 1 }), 0.4]]);
      const out = S.mix(0.84, [[S.relief(h, 14 * s), p.relief * 0.5], [S.turb(0.004 / s, 4, { so: 9 }), 0.08]]);
      if (p.pits) svgDots(S, 20 * s, 4, p.pits * 1.2, 0.3 * s, 1.6 * s, () => 0.55);
      return out;
    },
  },

  {
    id: 'canvas', name: 'Canvas / linen', group: 'Material',
    desc: 'Woven fabric. Raise irregularity for a linen look.',
    params: [R('thread', 'Thread size', 2, 40, 0.5, 7), R('irregular', 'Irregularity', 0, 1, 0.01, 0.35),
      R('depth', 'Depth', 0, 1, 0.01, 0.7), R('fuzz', 'Fuzz', 0, 1, 0.01, 0.3),
      SEL('weave', 'Weave', [['plain', 'Plain'], ['twill', 'Twill'], ['basket', 'Basket']], 'plain')],
    colors: { low: '#6f6551', lowA: 1, high: '#efe8d6', highA: 1 },
    setup(p, c) {
      const per = p.weave === 'twill' ? 4 : p.weave === 'basket' ? 4 : 2;
      let cw = p.thread, ch = p.thread, nx = 0, ny = 0;
      if (c.tile) {
        nx = per * Math.max(1, Math.round(c.Wu / (per * p.thread))); ny = per * Math.max(1, Math.round(c.Hu / (per * p.thread)));
        cw = c.Wu / nx; ch = c.Hu / ny;
      }
      return { cw, ch, nx, ny };
    },
    sample(u, v, c, p, st) {
      const { cw, ch, nx, ny } = st;
      const irr = p.irregular;
      if (irr) { const w = c.fbm(u, v, 0.01 / (cw / 7), 3, 0.5, 4); u += irr * cw * 0.8 * w; v += irr * ch * 0.8 * c.fbm(u, v, 0.01 / (cw / 7), 3, 0.5, 5); }
      const cu = u / cw, cv = v / ch;
      const i = Math.floor(cu), j = Math.floor(cv), fx = cu - i, fy = cv - j;
      let over;
      if (p.weave === 'twill') over = mod(i - j, 4) < 2;
      else if (p.weave === 'basket') over = (((i >> 1) + (j >> 1)) & 1) === 0;
      else over = ((i + j) & 1) === 0;
      const wi = nx ? mod(i, nx) : i, wj = ny ? mod(j, ny) : j;
      let t;
      if (over) {
        const prof = Math.pow(Math.sin(Math.PI * fx), 0.6);
        t = 0.3 + 0.7 * prof * (0.75 + 0.25 * Math.sin(Math.PI * fy));
        t *= 1 - irr * 0.25 * rnd(wi, 1, c.seed + 3);
      } else {
        const prof = Math.pow(Math.sin(Math.PI * fy), 0.6);
        t = 0.3 + 0.7 * prof * (0.75 + 0.25 * Math.sin(Math.PI * fx));
        t *= 1 - irr * 0.25 * rnd(wj, 2, c.seed + 3);
      }
      const w = clamp01((cw / c.fp - 1.5) / 2);
      t = mix(0.72, t, w);
      t = 0.78 + p.depth * (t - 0.72);
      t += p.fuzz * 0.12 * c.grain(u, v, cw * 0.25, 9) + 0.06 * c.fbm(u, v, 0.004, 4, 0.5, 8);
      return t;
    },
    svg(p, S) {
      const c = svgCtx(S);
      const { cw, ch } = this.setup(p, c);
      const per = p.weave === 'plain' ? 2 : 4;
      const gid = S.id('wv');
      S.defs.push(`<linearGradient id="${gid}h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4d4d4d"/><stop offset="0.5" stop-color="#ffffff"/><stop offset="1" stop-color="#4d4d4d"/></linearGradient>`);
      S.defs.push(`<linearGradient id="${gid}v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4d4d4d"/><stop offset="0.5" stop-color="#ffffff"/><stop offset="1" stop-color="#4d4d4d"/></linearGradient>`);
      let cells = '';
      for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
        let over;
        if (p.weave === 'twill') over = mod(i - j, 4) < 2;
        else if (p.weave === 'basket') over = (((i >> 1) + (j >> 1)) & 1) === 0;
        else over = ((i + j) & 1) === 0;
        cells += `<rect x="${i * cw}" y="${j * ch}" width="${cw}" height="${ch}" fill="url(#${gid}${over ? 'h' : 'v'})"/>`;
      }
      let src = S.pattern(cells, cw * per, ch * per);
      if (p.irregular) src = S.disp(src, S.raw(0.01 / (cw / 7), 3, { so: 4 }), p.irregular * cw * 3);
      return S.mix(0.78 - 0.22 * p.depth, [
        [src, p.depth], [S.turb(4 / cw, 1, { so: 9 }), p.fuzz * 0.25], [S.turb(0.004, 4, { so: 8 }), 0.12],
      ]);
    },
  },

  {
    id: 'wood', name: 'Wood grain', group: 'Material',
    desc: 'Plank grain with growth rings and fibre streaks.',
    params: [SCALE, R('rings', 'Rings', 1, 60, 0.5, 12), R('warp', 'Warp', 0, 2, 0.01, 0.7),
      R('grain', 'Fibre streaks', 0, 1, 0.01, 0.6), R('contrast', 'Ring contrast', 0, 1, 0.01, 0.6), R('angle', 'Angle', 0, 180, 1, 90)],
    colors: { low: '#4a2e17', lowA: 1, high: '#d8a96c', highA: 1 },
    setup(p, c) {
      const [kx, ky] = c.wave(p.rings / 1000, p.angle);
      const a = Math.atan2(ky, kx);
      return { kx, ky, cs: Math.cos(a), sn: Math.sin(a), vertical: Math.abs(kx) >= Math.abs(ky), w: c.wt(Math.hypot(kx, ky) * 3) };
    },
    // Noise stretched along the grain: fast across the rings, slow along them.
    along(u, v, c, st, f, oct, so, stretch) {
      if (c.tile) return st.vertical ? c.fbm(u, v, f, oct, 0.5, so, 1, stretch) : c.fbm(u, v, f, oct, 0.5, so, stretch, 1);
      return c.fbm(u * st.cs + v * st.sn, -u * st.sn + v * st.cs, f, oct, 0.5, so, 1, stretch);
    },
    sample(u, v, c, p, st) {
      const s = p.scale, W = TEX.wood;
      const warp = W.along(u, v, c, st, 0.0015 / s, 5, 1, 0.12);
      const t0 = st.kx * u + st.ky * v + p.warp * 3 * warp + 0.04 * W.along(u, v, c, st, 0.02 / s, 3, 2, 0.2);
      const ring = t0 - Math.floor(t0);
      const late = smoothstep(0.3, 0.97, ring);
      const inten = 0.75 + 0.6 * c.fbm(u, v, 0.003 / s, 3, 0.5, 3);
      let t = 0.86 - p.contrast * 0.65 * late * late * inten * st.w - p.contrast * 0.2 * (1 - st.w);
      if (p.grain) t -= p.grain * 0.35 * Math.abs(W.along(u, v, c, st, 0.15 / s, 3, 5, 0.03));
      return t;
    },
    svg(p, S) {
      const s = p.scale;
      const c = svgCtx(S);
      const st = this.setup(p, c);
      let kx = st.kx, ky = st.ky;
      if (!S.tile) { S.rotate((Math.atan2(ky, kx) * 180) / Math.PI); kx = Math.hypot(st.kx, st.ky); ky = 0; }
      const vert = S.tile ? st.vertical : true;
      const prof = (t) => { const l = smoothstep(0.3, 0.97, t); return 0.86 - p.contrast * 0.65 * l * l * st.w - p.contrast * 0.2 * (1 - st.w); };
      const src = S.stripes(kx, ky, prof, 48);
      const period = 1 / Math.hypot(kx, ky);
      const map = S.raw(0.0015 / s, 5, { so: 1, ax: vert ? 1 : 0.12, ay: vert ? 0.12 : 1 });
      const warped = S.disp(src, map, p.warp * period * 5);
      const fib = S.tbl(S.turb(0.15 / s, 3, { so: 5, ax: vert ? 1 : 0.03, ay: vert ? 0.03 : 1 }), [1, 0, 1]);
      return S.mix(0.5, [[warped, 1], [S.turb(0.003 / s, 3, { so: 3 }), -0.3 * p.contrast], [fib, -p.grain * 0.3]]);
    },
  },

  {
    id: 'marble', name: 'Marble', group: 'Material',
    desc: 'Veined stone with soft clouding.',
    params: [SCALE, R('veins', 'Vein count', 0.5, 12, 0.1, 2.5), R('turb', 'Turbulence', 0, 3, 0.01, 0.8),
      R('sharp', 'Vein sharpness', 1, 10, 0.1, 3), R('cloud', 'Clouding', 0, 1, 0.01, 0.5), R('angle', 'Angle', 0, 180, 1, 35)],
    colors: { low: '#3f444c', lowA: 1, high: '#f6f4f0', highA: 1 },
    setup(p, c) { const [kx, ky] = c.wave(p.veins / 1000, p.angle); return { kx, ky }; },
    profile(t, sharp) {
      const d = 1 - Math.abs(Math.sin(Math.PI * t));
      return Math.pow(d, sharp * 4) * 0.5 + Math.pow(d, sharp * 0.7) * 0.14;
    },
    sample(u, v, c, p, st) {
      const s = p.scale;
      const base = st.kx * u + st.ky * v;
      const t0 = base + p.turb * 2.5 * c.fbm(u, v, 0.0025 / s, 6, 0.5, 1);
      const t1 = base * 2 + p.turb * 3 * c.fbm(u, v, 0.005 / s, 6, 0.5, 2);
      const inten = clamp01(0.75 + 0.9 * c.fbm(u, v, 0.004 / s, 3, 0.5, 4));
      const v1 = TEX.marble.profile(t0, p.sharp) * inten;
      const v2 = Math.pow(1 - Math.abs(Math.sin(Math.PI * t1)), p.sharp * 5) * 0.2 * (1.2 - inten);
      return 0.94 + p.cloud * 0.12 * c.fbm(u, v, 0.004 / s, 5, 0.5, 3) - v1 - v2;
    },
    svg(p, S) {
      const s = p.scale;
      const c = svgCtx(S);
      let { kx, ky } = this.setup(p, c);
      if (!S.tile) { S.rotate((Math.atan2(ky, kx) * 180) / Math.PI); kx = Math.hypot(kx, ky); ky = 0; }
      const src = S.stripes(kx, ky, (t) => 0.94 - this.profile(t, p.sharp), 96);
      const period = 1 / Math.hypot(kx, ky);
      const veins = S.disp(src, S.raw(0.0025 / s, 6, { so: 1 }), p.turb * period * 6);
      return S.mix(0.5, [[veins, 1], [S.turb(0.004 / s, 5, { so: 3 }), p.cloud * 0.28]]);
    },
  },

  {
    id: 'leather', name: 'Leather', group: 'Material',
    desc: 'Pebbled hide with creases and pores.',
    params: [SCALE, R('creases', 'Creases', 0, 1, 0.01, 0.6), R('relief', 'Relief', 0, 1, 0.01, 0.6), R('pores', 'Pores', 0, 1, 0.01, 0.5)],
    colors: { low: '#24150c', lowA: 1, high: '#93603b', highA: 1 },
    setup(p, c) {
      const s = p.scale, f = 0.03 / s;
      const h = (a, b) => {
        c.cells(a + 10 * s * c.fbm(a, b, 0.015 / s, 3, 0.5, 2), b + 10 * s * c.fbm(a, b, 0.015 / s, 3, 0.5, 3), f, 1, 0.9);
        return Math.min(1, (c.f2 - c.f1) * 2.2) * c.wt(f);
      };
      return { h, f };
    },
    sample(u, v, c, p, st) {
      const s = p.scale;
      const h0 = st.h(u, v);
      let t = 0.6 + 0.08 * c.fbm(u, v, 0.005 / s, 4, 0.5, 7);
      t -= p.creases * 0.35 * (1 - smoothstep(0, 0.35, h0)) * c.wt(st.f);
      if (p.relief) t += p.relief * 0.12 * c.relief(st.h, u, v) / (st.f * 3);
      if (p.pores) t -= p.pores * 0.3 * c.dots(u, v, 9 * s, 8, 0.9, 0.25 * s, 0.8 * s);
      return t;
    },
    svg(p, S) {
      const s = p.scale;
      const cellsL = S.disp(S.turb(0.03 / s, 2, { so: 1, type: 'turbulence' }), S.raw(0.015 / s, 3, { so: 2 }), 20 * s);
      const crease = S.lv(cellsL, 0, 0.12);
      const out = S.mix(0.6, [[crease, p.creases * 0.5], [S.relief(S.blur(crease, 0.6 * s), 12 * s), p.relief * 0.5], [S.turb(0.005 / s, 4, { so: 7 }), 0.16]]);
      if (p.pores) svgDots(S, 9 * s, 8, 0.9 * p.pores, 0.25 * s, 0.8 * s, () => 0.3);
      return out;
    },
  },

  {
    id: 'granite', name: 'Granite / stone', group: 'Material',
    desc: 'Crystalline stone made of mixed mineral grains.',
    params: [SCALE, R('dark', 'Dark minerals', 0, 1, 0.01, 0.35), R('light', 'Light minerals', 0, 1, 0.01, 0.3), R('fine', 'Fine grain', 0, 1, 0.01, 0.5)],
    colors: { low: '#1c1c1f', lowA: 1, high: '#ddd8cf', highA: 1 },
    sample(u, v, c, p) {
      const s = p.scale;
      const tone = (id) => {
        const r = (id & 0xffff) / 65536;
        if (r < p.dark * 0.5) return 0.12;
        if (r > 1 - p.light * 0.4) return 0.95;
        return 0.5 + ((id >>> 16) / 65536 - 0.5) * 0.25;
      };
      const f1 = 0.06 / s, f2 = 0.16 / s;
      c.cells(u, v, f1, 1, 1);
      const a = mix(0.52, tone(c.cid), c.wt(f1));
      c.cells(u, v, f2, 2, 1);
      const b = mix(0.52, tone(c.cid), c.wt(f2));
      return 0.6 * a + 0.4 * b + p.fine * 0.12 * c.grain(u, v, 1.2 * s, 3) + 0.05 * c.fbm(u, v, 0.004 / s, 4, 0.5, 4);
    },
    svg(p, S) {
      const s = p.scale;
      const levels = [];
      for (let i = 0; i < 24; i++) { const r = ((i * 7919) % 24) / 24; levels.push(r < p.dark * 0.5 ? 0.12 : r > 1 - p.light * 0.4 ? 0.95 : 0.45 + ((i * 31) % 10) / 40); }
      const a = S.tbl(S.lv(S.turb(0.06 / s, 2, { so: 1 }), 0.3, 0.7), levels, 'discrete');
      const b = S.tbl(S.lv(S.turb(0.16 / s, 2, { so: 2 }), 0.3, 0.7), levels.slice().reverse(), 'discrete');
      return S.mix(0.5, [[a, 0.6], [b, 0.4], [S.turb(1 / (1.2 * s), 1, { so: 3 }), p.fine * 0.25], [S.turb(0.004 / s, 4, { so: 4 }), 0.1]]);
    },
  },
];

export const TEX = Object.fromEntries(TEXTURES.map((t) => [t.id, t]));

export function defaultParams(tex) {
  return Object.fromEntries(tex.params.map((p) => [p.id, p.value]));
}

export { Ctx };
