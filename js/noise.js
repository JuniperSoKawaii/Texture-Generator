// Deterministic, resolution-independent noise primitives.
//
// Coordinate system: every texture is evaluated in "units", where the shorter
// side of the output image is always 1000 units long. That makes a texture look
// the same at 800 px or 8000 px. `fp` (footprint) is the size of one sample in
// units; octaves finer than a sample are faded out so previews are an honest
// downscale of the full-resolution export instead of an aliased mess.

export function hash3(x, y, s) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export const rnd = (x, y, s) => hash3(x, y, s) / 4294967296;

// Small seeded PRNG for setup-time decisions.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GX = new Float64Array(16), GY = new Float64Array(16);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2 + 0.2;
  GX[i] = Math.cos(a); GY[i] = Math.sin(a);
}

export const mod = (a, p) => { a %= p; return a < 0 ? a + p : a; };

// 2D gradient noise, roughly in [-1, 1]. px/py > 0 make it periodic.
export function gnoise(x, y, px, py, seed) {
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  let x0 = xf, y0 = yf, x1 = xf + 1, y1 = yf + 1;
  if (px > 0) { x0 = mod(x0, px); x1 = mod(x1, px); }
  if (py > 0) { y0 = mod(y0, py); y1 = mod(y1, py); }
  const h00 = hash3(x0, y0, seed) & 15, h10 = hash3(x1, y0, seed) & 15;
  const h01 = hash3(x0, y1, seed) & 15, h11 = hash3(x1, y1, seed) & 15;
  const n00 = GX[h00] * fx + GY[h00] * fy;
  const n10 = GX[h10] * (fx - 1) + GY[h10] * fy;
  const n01 = GX[h01] * fx + GY[h01] * (fy - 1);
  const n11 = GX[h11] * (fx - 1) + GY[h11] * (fy - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = n00 + u * (n10 - n00), b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * 1.414;
}

// Fade weight for a feature of frequency f (cycles/unit) at footprint fp.
export function fadeWeight(f, fp) {
  const m = f * fp;
  return m < 0.5 ? 1 : m < 1 ? (1 - m) * 2 : 0;
}

export class Ctx {
  constructor({ Wu, Hu, fp, tile, seed }) {
    this.Wu = Wu; this.Hu = Hu; this.fp = fp; this.tile = !!tile; this.seed = seed | 0;
    this.f1 = 0; this.f2 = 0; this.cid = 0; this.tone = 0;
  }

  wt(f) { return fadeWeight(f, this.fp); }

  // Single octave of gradient noise, faded when below sample resolution.
  n(u, v, f, so, ax = 1, ay = 1) {
    let fx = f * ax, fy = f * ay, px = 0, py = 0;
    if (this.tile) {
      px = Math.round(fx * this.Wu) || 1; py = Math.round(fy * this.Hu) || 1;
      fx = px / this.Wu; fy = py / this.Hu;
    }
    const w = fadeWeight(fx > fy ? fx : fy, this.fp);
    if (w === 0) return 0;
    return w * gnoise(u * fx, v * fy, px, py, this.seed + so * 7919);
  }

  // Fractal Brownian motion, normalised so the result is ~[-0.6, 0.6].
  fbm(u, v, f, oct, gain, so, ax = 1, ay = 1) {
    let fx = f * ax, fy = f * ay, px = 0, py = 0;
    if (this.tile) {
      px = Math.round(fx * this.Wu) || 1; py = Math.round(fy * this.Hu) || 1;
      fx = px / this.Wu; fy = py / this.Hu;
    }
    const fp = this.fp, seed = this.seed + so * 7919;
    let sum = 0, amp = 1, norm = 0;
    for (let k = 0; k < oct; k++) {
      norm += amp;
      const m = (fx > fy ? fx : fy) * fp;
      if (m < 1) {
        const w = m < 0.5 ? 1 : (1 - m) * 2;
        sum += amp * w * gnoise(u * fx, v * fy, px, py, seed + k * 1013);
      }
      amp *= gain; fx *= 2; fy *= 2; px *= 2; py *= 2;
    }
    return sum / norm;
  }

  // Worley / cellular noise. Sets this.f1, this.f2 (in cell units) and this.cid.
  cells(u, v, f, so, jitter = 1) {
    let fx = f, fy = f, px = 0, py = 0;
    if (this.tile) {
      px = Math.round(f * this.Wu) || 1; py = Math.round(f * this.Hu) || 1;
      fx = px / this.Wu; fy = py / this.Hu;
    }
    const x = u * fx, y = v * fy, seed = this.seed + so * 7919;
    const xi = Math.floor(x), yi = Math.floor(y);
    let d1 = 9, d2 = 9, id = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy;
        const h = hash3(px > 0 ? mod(cx, px) : cx, py > 0 ? mod(cy, py) : cy, seed);
        const ox = cx + 0.5 + jitter * ((h & 0xffff) / 65536 - 0.5) - x;
        const oy = cy + 0.5 + jitter * ((h >>> 16) / 65536 - 0.5) - y;
        const d = ox * ox + oy * oy;
        if (d < d1) { d2 = d1; d1 = d; id = h; } else if (d < d2) d2 = d;
      }
    }
    this.f1 = Math.sqrt(d1); this.f2 = Math.sqrt(d2); this.cid = id;
    return this.f1;
  }

  _grid(cell) {
    if (!this.tile) return [cell, cell, 0, 0];
    const nx = Math.max(1, Math.round(this.Wu / cell)), ny = Math.max(1, Math.round(this.Hu / cell));
    return [this.Wu / nx, this.Hu / ny, nx, ny];
  }

  // Scattered anti-aliased dots. `density` = expected dots per cell (0..4).
  // Returns coverage 0..1 and sets this.tone to a random value for the top dot.
  dots(u, v, cell, so, density, rmin, rmax) {
    const [cw, ch, nx, ny] = this._grid(cell);
    const gx = Math.floor(u / cw), gy = Math.floor(v / ch);
    const seed = this.seed + so * 7919, fp = this.fp;
    let best = 0, tone = 0;
    const whole = Math.floor(density), frac = density - whole;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = gx + dx, cy = gy + dy;
        const hx = nx ? mod(cx, nx) : cx, hy = ny ? mod(cy, ny) : cy;
        const h0 = hash3(hx, hy, seed);
        const count = whole + ((h0 & 0xffff) / 65536 < frac ? 1 : 0);
        for (let i = 0; i < count; i++) {
          const h1 = hash3(h0, i, seed + 1), h2 = hash3(h1, i, seed + 2);
          const px = (cx + (h1 & 0xffff) / 65536) * cw;
          const py = (cy + (h1 >>> 16) / 65536) * ch;
          const r3 = (h2 & 0xffff) / 65536;
          const r = rmin + (rmax - rmin) * r3 * r3;
          const ddx = u - px, ddy = v - py;
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          const re = r > fp * 0.5 ? r : fp * 0.5;
          let c = (re - d) / fp + 0.5;
          if (c <= 0) continue;
          if (c > 1) c = 1;
          c *= (r / re) * (r / re);
          if (c > best) { best = c; tone = (h2 >>> 16) / 65536; }
        }
      }
    }
    this.tone = tone;
    return best;
  }

  // Scattered thin line segments (scratches, hairs). Returns coverage 0..1.
  lines(u, v, cell, so, density, len, width) {
    const [cw, ch, nx, ny] = this._grid(cell);
    const gx = Math.floor(u / cw), gy = Math.floor(v / ch);
    const seed = this.seed + so * 7919, fp = this.fp;
    let best = 0, tone = 0;
    const whole = Math.floor(density), frac = density - whole;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = gx + dx, cy = gy + dy;
        const hx = nx ? mod(cx, nx) : cx, hy = ny ? mod(cy, ny) : cy;
        const h0 = hash3(hx, hy, seed);
        const count = whole + ((h0 & 0xffff) / 65536 < frac ? 1 : 0);
        for (let i = 0; i < count; i++) {
          const s = lineSeg(h0, i, seed, cx, cy, cw, ch, len, width);
          const ex = s.x2 - s.x1, ey = s.y2 - s.y1;
          const l2 = ex * ex + ey * ey || 1e-9;
          let t = ((u - s.x1) * ex + (v - s.y1) * ey) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = u - (s.x1 + t * ex), qy = v - (s.y1 + t * ey);
          const d = Math.sqrt(qx * qx + qy * qy);
          const w = s.w, we = w > fp ? w : fp;
          let c = (we * 0.5 - d) / fp + 0.5;
          if (c <= 0) continue;
          if (c > 1) c = 1;
          // Taper the ends a little so scratches don't look like stamped rectangles.
          c *= (w / we) * Math.min(1, Math.sin(Math.PI * t) * 3 + 0.15);
          if (c > best) { best = c; tone = s.tone; }
        }
      }
    }
    this.tone = tone;
    return best;
  }

  // Film-style grain whose amplitude falls off honestly when a sample covers several grains.
  grain(u, v, size, so) {
    let fx = 1 / size, fy = fx, px = 0, py = 0;
    if (this.tile) {
      px = Math.round(fx * this.Wu) || 1; py = Math.round(fy * this.Hu) || 1;
      fx = px / this.Wu; fy = py / this.Hu;
    }
    const a = Math.min(1, (0.8 * size) / this.fp);
    return a * gnoise(u * fx, v * fy, px, py, this.seed + so * 7919);
  }

  step() { return this.fp > 0.75 ? this.fp : 0.75; }

  // Normalised relief (≈ -1..1) of an fBm height field.
  reliefFbm(u, v, f, oct, gain, so) {
    const e = this.step();
    const h0 = this.fbm(u, v, f, oct, gain, so);
    const g = this.fbm(u + e, v, f, oct, gain, so) + this.fbm(u, v + e, f, oct, gain, so) - 2 * h0;
    return g / (e * f * 3);
  }

  // Embossed lighting from the top-left for a height function h(u, v).
  relief(h, u, v) {
    const e = this.fp > 0.75 ? this.fp : 0.75;
    const h0 = h(u, v);
    return (h(u + e, v) + h(u, v + e) - 2 * h0) / e;
  }

  // Wave vector (cycles/unit along u, v) for stripes at `angle` degrees.
  // In tile mode the vector is snapped so stripes wrap seamlessly.
  wave(freq, angleDeg) {
    const a = (angleDeg * Math.PI) / 180;
    let kx = freq * Math.cos(a), ky = freq * Math.sin(a);
    if (this.tile) {
      kx = Math.round(kx * this.Wu) / this.Wu;
      ky = Math.round(ky * this.Hu) / this.Hu;
      if (kx === 0 && ky === 0) kx = 1 / this.Wu;
    }
    return [kx, ky];
  }
}

// Shared by the raster renderer and the SVG exporter so vector scratches match.
const SEG = { x1: 0, y1: 0, x2: 0, y2: 0, w: 0, tone: 0 };
export function lineSeg(h0, i, seed, cx, cy, cw, ch, len, width) {
  const h1 = hash3(h0, i, seed + 11), h2 = hash3(h1, i, seed + 12);
  const mx = (cx + (h1 & 0xffff) / 65536) * cw;
  const my = (cy + (h1 >>> 16) / 65536) * ch;
  const ang = ((h2 & 0xffff) / 65536) * Math.PI;
  const r = (h2 >>> 16) / 65536;
  const half = Math.min(cw, ch) * 0.5 * len * (0.35 + 0.65 * r);
  SEG.x1 = mx - Math.cos(ang) * half; SEG.y1 = my - Math.sin(ang) * half;
  SEG.x2 = mx + Math.cos(ang) * half; SEG.y2 = my + Math.sin(ang) * half;
  SEG.w = width * (0.4 + 0.6 * ((h1 >>> 8) & 255) / 255);
  SEG.tone = ((h2 >>> 4) & 255) / 255;
  return SEG;
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
