// Procedural SVG builder. Each texture provides an `svg(params, S)` recipe that
// assembles SVG filter primitives (feTurbulence, lighting, displacement…) and/or
// real vector shapes. The result is resolution independent: it can be scaled to
// any print size without pixelation. Filter rendering differs slightly between
// SVG renderers, so this is a faithful *approximation* of the raster output.

import { compileGlobal, toneToRGBA, adjustTone, hexToRgb } from './color.js';

const num = (x) => {
  const r = Math.round(x * 100000) / 100000;
  return Object.is(r, -0) ? '0' : String(r);
};
const gray = (v) => {
  const c = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${c},${c},${c})`;
};
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

export class SvgBuilder {
  constructor({ W, H, tile, seed }) {
    const R = Math.min(W, H);
    this.W = W; this.H = H; this.tile = !!tile; this.seed = seed | 0;
    this.k = 1000 / R;          // units per px
    this.ppu = R / 1000;        // px per unit
    this.Wu = W * this.k; this.Hu = H * this.k;
    this.prims = []; this.defs = []; this.n = 0;
    this.fill = null;           // fill for the filtered base rect (SourceGraphic)
    this.shapes = new Map();    // colour key -> shape strings
    this.shapeCount = 0; this.maxShapes = 60000; this.overflow = false;
    this.region = { x: 0, y: 0, w: W, h: H };
    this.rot = 0; this.overlays = []; this.maxDisp = 0;
  }

  // Rotate the filtered layer so anisotropic noise follows stripes (not in tile mode).
  rotate(angleDeg) {
    if (this.tile || !angleDeg) return;
    this.rot = angleDeg;
    const D = Math.ceil(Math.hypot(this.W, this.H) * 1.25);
    this.region = { x: (this.W - D) / 2, y: (this.H - D) / 2, w: D, h: D };
  }

  overlay(str) { this.overlays.push(str); }

  id(p = 'r') { return p + ++this.n; }
  sub() { const r = this.region; return ` x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}"`; }
  p(s) { this.prims.push(s); }

  _tileF(f, len) { return this.tile ? Math.max(1, Math.round(f * len)) / len : f; }

  // Raw feTurbulence (all four channels are independent noise).
  raw(f, oct, { ax = 1, ay = 1, so = 0, type = 'fractalNoise' } = {}) {
    const r = this.id('t');
    const fx = this._tileF(f * ax, this.Wu) * this.k, fy = this._tileF(f * ay, this.Hu) * this.k;
    const seed = Math.abs(this.seed * 13 + so * 101) % 99991;
    this.p(`<feTurbulence type="${type}" baseFrequency="${num(fx)} ${num(fy)}" numOctaves="${Math.max(1, Math.min(8, oct))}" seed="${seed}"${this.tile ? ' stitchTiles="stitch"' : ''}${this.sub()} result="${r}"/>`);
    return r;
  }

  // Copy one channel into RGB with opaque alpha.
  gray(input, ch = 0) {
    const g = this.id('g');
    const row = ['1 0 0 0 0', '0 1 0 0 0', '0 0 1 0 0', '0 0 0 1 0'][ch];
    this.p(`<feColorMatrix in="${input}" type="matrix" values="${row} ${row} ${row} 0 0 0 0 1" result="${g}"/>`);
    return g;
  }

  turb(f, oct, o = {}) { return this.gray(this.raw(f, oct, o), o.ch || 0); }

  // Linear remap so that `lo` -> 0 and `hi` -> 1 (clamped).
  lv(input, lo, hi) {
    const r = this.id('l');
    const s = 1 / (hi - lo), b = -lo * s;
    const f = (c) => `<feFunc${c} type="linear" slope="${num(s)}" intercept="${num(b)}"/>`;
    this.p(`<feComponentTransfer in="${input}" result="${r}">${f('R')}${f('G')}${f('B')}</feComponentTransfer>`);
    return r;
  }

  tbl(input, values, type = 'table') {
    const r = this.id('c');
    const v = values.map(num).join(' ');
    const f = (c) => `<feFunc${c} type="${type}" tableValues="${v}"/>`;
    this.p(`<feComponentTransfer in="${input}" result="${r}">${f('R')}${f('G')}${f('B')}</feComponentTransfer>`);
    return r;
  }

  gamma(input, exponent, amplitude = 1, offset = 0) {
    const r = this.id('y');
    const f = (c) => `<feFunc${c} type="gamma" amplitude="${num(amplitude)}" exponent="${num(exponent)}" offset="${num(offset)}"/>`;
    this.p(`<feComponentTransfer in="${input}" result="${r}">${f('R')}${f('G')}${f('B')}</feComponentTransfer>`);
    return r;
  }

  invert(input) { return this.tbl(input, [1, 0]); }

  // 1 - |2x - 1|: a ridge where the input crosses 0.5.
  ridge(input, sharp = 1) {
    const r = this.tbl(input, [0, 1, 0]);
    return sharp === 1 ? r : this.gamma(r, sharp);
  }

  mul(a, b) {
    const r = this.id('m');
    this.p(`<feComposite in="${a}" in2="${b}" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="${r}"/>`);
    return r;
  }

  // base + Σ w·(L − 0.5). Negative weights use the inverted layer so alpha stays 1.
  mix(base, terms) {
    let acc = this.id('f');
    this.p(`<feFlood flood-color="${gray(base)}" flood-opacity="1"${this.sub()} result="${acc}"/>`);
    for (const [layer, w] of terms) {
      if (!w || !layer) continue;
      const L = w < 0 ? this.invert(layer) : layer, aw = Math.abs(w);
      const r = this.id('a');
      this.p(`<feComposite in="${acc}" in2="${L}" operator="arithmetic" k1="0" k2="1" k3="${num(aw)}" k4="${num(-0.5 * aw)}" result="${r}"/>`);
      acc = r;
    }
    return acc;
  }

  // Embossed relief lit from the top-left, centred on 0.5.
  relief(input, scale) {
    const h = this.id('h'), l = this.id('d');
    this.p(`<feColorMatrix in="${input}" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0" result="${h}"/>`);
    this.p(`<feDiffuseLighting in="${h}" surfaceScale="${num(scale * this.ppu)}" diffuseConstant="1" lighting-color="#fff" result="${l}"><feDistantLight azimuth="225" elevation="45"/></feDiffuseLighting>`);
    return this.lv(l, 0.707 - 0.5, 0.707 + 0.5);
  }

  disp(input, rawMap, units) {
    const r = this.id('x');
    this.maxDisp = Math.max(this.maxDisp, (units * this.ppu) / 2);
    this.p(`<feDisplacementMap in="${input}" in2="${rawMap}" scale="${num(units * this.ppu)}" xChannelSelector="R" yChannelSelector="G" result="${r}"/>`);
    return r;
  }

  blur(input, units) {
    const r = this.id('b');
    this.p(`<feGaussianBlur in="${input}" stdDeviation="${num(units * this.ppu)}" result="${r}"/>`);
    return r;
  }

  // Fill the base rect with repeating stripes; returns 'SourceGraphic'.
  // kx/ky are cycles per unit; profile(t) gives the tone for phase t in [0,1).
  stripes(kx, ky, profile, stops = 32) {
    const id = this.id('sg');
    const px = kx * this.k, py = ky * this.k, m = px * px + py * py || 1e-9;
    let s = '';
    for (let i = 0; i <= stops; i++) {
      const t = i / stops;
      s += `<stop offset="${num(t)}" stop-color="${gray(profile(t % 1))}"/>`;
    }
    this.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" spreadMethod="repeat" x1="0" y1="0" x2="${num(px / m)}" y2="${num(py / m)}">${s}</linearGradient>`);
    this.fill = `url(#${id})`;
    return 'SourceGraphic';
  }

  pattern(content, wUnits, hUnits) {
    const id = this.id('pt');
    this.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${num(wUnits * this.ppu)}" height="${num(hUnits * this.ppu)}"><g transform="scale(${num(this.ppu)})">${content}</g></pattern>`);
    this.fill = `url(#${id})`;
    return 'SourceGraphic';
  }

  _shape(tone, str, kind) {
    if (this.shapeCount >= this.maxShapes) { this.overflow = true; return; }
    this.shapeCount++;
    const key = kind + ':' + Math.round(tone * 32);
    if (!this.shapes.has(key)) this.shapes.set(key, []);
    this.shapes.get(key).push(str);
  }

  // Vector shapes are given in units and coloured with the shared tone mapping.
  circle(u, v, r, tone) {
    this._shape(tone, `<circle cx="${num(u * this.ppu)}" cy="${num(v * this.ppu)}" r="${num(r * this.ppu)}"/>`, 'f');
  }
  rect(u, v, w, h, tone, rot = 0) {
    const t = rot ? ` transform="rotate(${num(rot)} ${num((u + w / 2) * this.ppu)} ${num((v + h / 2) * this.ppu)})"` : '';
    this._shape(tone, `<rect x="${num(u * this.ppu)}" y="${num(v * this.ppu)}" width="${num(w * this.ppu)}" height="${num(h * this.ppu)}"${t}/>`, 'f');
  }
  line(x1, y1, x2, y2, w, tone) {
    const wk = Math.round(w * 4) / 4;
    this._shape(tone, `<line x1="${num(x1 * this.ppu)}" y1="${num(y1 * this.ppu)}" x2="${num(x2 * this.ppu)}" y2="${num(y2 * this.ppu)}"/>`, 's' + wk);
  }
}

// Build a complete SVG document. `size` = { W, H, widthAttr, heightAttr }.
export function buildSvg(tex, params, global, { W, H, widthAttr, heightAttr, tile, seed, title }) {
  const S = new SvgBuilder({ W, H, tile, seed });
  const cg = compileGlobal(global);
  let out = tex.svg ? tex.svg(params, S) : null;
  if (S.overflow) return null; // too many shapes: caller falls back to embedded bitmap

  // Global grain.
  if (out && global.grain > 0) out = S.mix(0.5, [[out, 1], [S.turb(0.6, 2, { so: 999 }), global.grain * 0.7]]);

  const parts = [];
  const filterId = 'texture';
  if (out) {
    // Adjustments (contrast / brightness / invert) then gradient map with alpha.
    let s = cg.c, b = 0.5 - 0.5 * cg.c + cg.b;
    if (cg.inv) { s = -s; b = 1 - b; }
    const adj = S.id('j');
    const f = (c) => `<feFunc${c} type="linear" slope="${num(s)}" intercept="${num(b)}"/>`;
    S.p(`<feComponentTransfer in="${out}" result="${adj}">${f('R')}${f('G')}${f('B')}</feComponentTransfer>`);
    const toA = S.id('k');
    S.p(`<feColorMatrix in="${adj}" type="matrix" values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0" result="${toA}"/>`);
    const lo = hexToRgb(global.low), hi = hexToRgb(global.high);
    const t = (c, i) => `<feFunc${c} type="table" tableValues="${num(lo[i] / 255)} ${num(hi[i] / 255)}"/>`;
    const op = global.opacity;
    S.p(`<feComponentTransfer in="${toA}">${t('R', 0)}${t('G', 1)}${t('B', 2)}<feFuncA type="table" tableValues="${num(global.lowA * op)} ${num(global.highA * op)}"/></feComponentTransfer>`);
    const rg = S.region, pad = Math.ceil(Math.max(rg.w, rg.h) * 0.1 + S.maxDisp);
    parts.push(`<filter id="${filterId}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="${num(rg.x - pad)}" y="${num(rg.y - pad)}" width="${num(rg.w + 2 * pad)}" height="${num(rg.h + 2 * pad)}" color-interpolation-filters="sRGB">${S.prims.join('')}</filter>`);
  }

  const body = [];
  if (out) {
    const rg = S.region, pad = Math.ceil(Math.max(rg.w, rg.h) * 0.1 + S.maxDisp);
    const rect = `<rect x="${num(rg.x - pad)}" y="${num(rg.y - pad)}" width="${num(rg.w + 2 * pad)}" height="${num(rg.h + 2 * pad)}" fill="${S.fill || '#808080'}" filter="url(#${filterId})"/>`;
    body.push(S.rot ? `<g transform="rotate(${num(S.rot)} ${num(W / 2)} ${num(H / 2)})">${rect}</g>` : rect);
  } else {
    const [r, g, b, a] = toneToRGBA(1, cg);
    if (a > 0) body.push(`<rect width="${W}" height="${H}" fill="${hex(r, g, b)}"${a < 1 ? ` fill-opacity="${num(a)}"` : ''}/>`);
  }

  for (const [key, list] of S.shapes) {
    const [kind, tq] = key.split(':');
    const [r, g, b, a] = toneToRGBA(Number(tq) / 32, cg);
    if (a <= 0.001) continue;
    const col = hex(r, g, b), op = a < 1 ? num(a) : null;
    if (kind === 'f') {
      body.push(`<g fill="${col}"${op ? ` fill-opacity="${op}"` : ''}>${list.join('')}</g>`);
    } else {
      const w = Number(kind.slice(1)) * S.ppu;
      body.push(`<g fill="none" stroke="${col}" stroke-width="${num(w)}" stroke-linecap="round"${op ? ` stroke-opacity="${op}"` : ''}>${list.join('')}</g>`);
    }
  }

  body.push(...S.overlays.map((o) => o.replace(/\{low\}/g, () => { const [r, g, b] = toneToRGBA(0, cg); return hex(r, g, b); })));

  if (global.vignette > 0 && !tile) {
    const [r, g, b, a] = toneToRGBA(0, cg);
    const strength = global.vignette * a;
    // Approximates the raster vignette, which darkens the tone toward the "low" colour.
    parts.push(`<radialGradient id="vig" cx="50%" cy="50%" r="71%"><stop offset="0.35" stop-color="${hex(r, g, b)}" stop-opacity="0"/><stop offset="1" stop-color="${hex(r, g, b)}" stop-opacity="${num(strength)}"/></radialGradient>`);
    body.push(`<rect width="${W}" height="${H}" fill="url(#vig)"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${widthAttr || W}" height="${heightAttr || H}" viewBox="0 0 ${W} ${H}">
<title>${esc(title || tex.name)}</title>
<defs>${S.defs.join('')}${parts.join('')}</defs>
${body.join('\n')}
</svg>
`;
}

function hex(r, g, b) {
  return '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
}

// SVG that wraps an exact bitmap (PNG bytes).
export function embeddedSvg(pngBase64, { W, H, widthAttr, heightAttr, title }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${widthAttr || W}" height="${heightAttr || H}" viewBox="0 0 ${W} ${H}">
<title>${esc(title || 'Texture')}</title>
<image width="${W}" height="${H}" preserveAspectRatio="none" xlink:href="data:image/png;base64,${pngBase64}"/>
</svg>
`;
}

export { adjustTone };
