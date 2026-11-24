// Image encoders.
//  • PNG: streaming encoder built on CompressionStream — no canvas size limit, embeds DPI (pHYs).
//  • JPEG / WebP: via canvas; JPEG gets its JFIF density patched so print DPI is preserved.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = CRC[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return crc;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

function physChunk(dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const d = new Uint8Array(9), dv = new DataView(d.buffer);
  dv.setUint32(0, ppm); dv.setUint32(4, ppm); d[8] = 1;
  return chunk('pHYs', d);
}

function textChunk(key, value) {
  const enc = new TextEncoder();
  const k = enc.encode(key), v = enc.encode(value);
  const d = new Uint8Array(k.length + 1 + v.length);
  d.set(k); d.set(v, k.length + 1);
  return chunk('tEXt', d);
}

export const canStreamPng = typeof CompressionStream !== 'undefined';

export class PngEncoder {
  constructor(W, H, { alpha = true, dpi = 0 } = {}) {
    this.W = W; this.H = H; this.alpha = alpha; this.dpi = dpi;
    this.bpp = alpha ? 4 : 3; this.rowLen = W * this.bpp;
    this.prev = new Uint8Array(this.rowLen); this.cur = new Uint8Array(this.rowLen);
    this.cs = new CompressionStream('deflate');
    this.writer = this.cs.writable.getWriter();
    this.out = [];
    this.reading = (async () => {
      const r = this.cs.readable.getReader();
      for (;;) { const { done, value } = await r.read(); if (done) break; this.out.push(value); }
    })();
  }

  // rgba: Uint8ClampedArray of `rows` full-width rows.
  async addRows(rgba, rows) {
    const { W, bpp, rowLen } = this;
    const batch = new Uint8Array(rows * (rowLen + 1));
    let o = 0;
    for (let y = 0; y < rows; y++) {
      const cur = this.cur, prev = this.prev;
      const base = y * W * 4;
      if (bpp === 4) cur.set(rgba.subarray(base, base + W * 4));
      else for (let x = 0, s = base, d = 0; x < W; x++, s += 4, d += 3) { cur[d] = rgba[s]; cur[d + 1] = rgba[s + 1]; cur[d + 2] = rgba[s + 2]; }
      batch[o++] = 4; // Paeth filter
      for (let i = 0; i < rowLen; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c, pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        batch[o++] = (cur[i] - pred) & 255;
      }
      this.prev = cur; this.cur = prev;
    }
    await this.writer.write(batch);
  }

  async finish() {
    await this.writer.close();
    await this.reading;
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, this.W); dv.setUint32(4, this.H);
    ihdr[8] = 8; ihdr[9] = this.alpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
    if (this.dpi) parts.push(physChunk(this.dpi));
    parts.push(textChunk('Software', 'Texture Generator'));
    // Merge compressed output into IDAT chunks of ~1 MB.
    let buf = [], size = 0;
    const flush = () => {
      if (!size) return;
      const d = new Uint8Array(size); let o = 0;
      for (const b of buf) { d.set(b, o); o += b.length; }
      parts.push(chunk('IDAT', d)); buf = []; size = 0;
    };
    for (const b of this.out) { buf.push(b); size += b.length; if (size > 1 << 20) flush(); }
    flush();
    parts.push(chunk('IEND', new Uint8Array(0)));
    return new Blob(parts, { type: 'image/png' });
  }
}

// Insert / replace a pHYs chunk in an existing PNG (used for the canvas fallback).
export async function pngWithDpi(blob, dpi) {
  if (!dpi) return blob;
  const b = new Uint8Array(await blob.arrayBuffer());
  const ihdrEnd = 8 + 12 + 13;
  return new Blob([b.subarray(0, ihdrEnd), physChunk(dpi), b.subarray(ihdrEnd)], { type: 'image/png' });
}

// Set JFIF pixel density on a JPEG (insert an APP0 segment if the encoder omitted it).
export async function jpegWithDpi(blob, dpi) {
  if (!dpi) return blob;
  const b = new Uint8Array(await blob.arrayBuffer());
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  if (b[2] === 0xff && b[3] === 0xe0 && b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46) {
    b[13] = 1; b[14] = d >> 8; b[15] = d & 255; b[16] = d >> 8; b[17] = d & 255;
    return new Blob([b], { type: 'image/jpeg' });
  }
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0]);
  return new Blob([b.subarray(0, 2), app0, b.subarray(2)], { type: 'image/jpeg' });
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The browser could not encode an image this large. Try PNG or a smaller size.'))), type, quality);
    } catch (e) { reject(e); }
  });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
