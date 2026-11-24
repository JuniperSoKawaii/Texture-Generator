import { TEXTURES, TEX, defaultParams } from './textures.js';
import { DEFAULT_GLOBAL, hexToRgb } from './color.js';
import { SIZE_GROUPS, DPI_OPTIONS, resolveSize, describeSize, fmtNum, MAX_SIDE, MAX_MP, WARN_MP } from './sizes.js';
import { Pool, CancelledError, renderImage } from './pool.js';
import { PngEncoder, canStreamPng, pngWithDpi, jpegWithDpi, canvasToBlob, blobToBase64 } from './encode.js';
import { buildSvg, embeddedSvg } from './svg.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const PALETTES = [
  ['Ink on paper', '#1d1b18', '#f8f4ea'],
  ['Sepia', '#5a3a1a', '#f3e2c0'],
  ['Kraft', '#4a311b', '#d9ae7c'],
  ['Charcoal', '#111111', '#c4c4c4'],
  ['Mono', '#000000', '#ffffff'],
  ['Chalkboard', '#f2efe8', '#23272b'],
  ['Blueprint', '#e6efff', '#1d4c8c'],
  ['Sage', '#38443a', '#dfe5d6'],
  ['Blush', '#86454b', '#f7e3df'],
  ['Navy', '#0f1b33', '#c8d2e6'],
  ['Terracotta', '#6b2a16', '#e8b597'],
  ['Mustard', '#4d3a06', '#e9c46a'],
  ['Lemon', '#8a6800', '#f6d23a'],
  ['Tangerine', '#8a3510', '#f39340'],
  ['Bubblegum', '#9a3d62', '#f6a9c6'],
  ['Aqua', '#1b5f6b', '#8fd4d7'],
  ['Pine', '#1f3528', '#7fa58a'],
  ['Oatmeal', '#4f4232', '#e8dcc2'],
  ['Steel', '#272b30', '#9aa2aa'],
];

const GROUP_LABELS = { 'Grain & noise': 'Grain' };

const FORMAT_NOTES = {
  png: 'Lossless, full transparency. Print sizes embed their DPI so layout apps place them at the right physical size.',
  jpeg: 'Small files, no transparency — transparent areas are filled with the background colour below. DPI is embedded.',
  webp: 'Modern web format with transparency and small files.',
  svg: '',
};

// ---------------------------------------------------------------------------------------
// State

const STORAGE_KEY = 'texture-generator:v1';

function defaultState() {
  return {
    v: 1,
    tex: 'paper',
    params: {},
    seed: 1234,
    tile: false,
    keepColors: false,
    global: { ...DEFAULT_GLOBAL, ...TEX.paper.colors },
    size: { group: 'web', preset: 'fhd', swap: false, dpi: 300, bleed: false, custom: { w: 2000, h: 2000, unit: 'px' } },
    exp: { format: 'png', quality: 0.92, matte: '#ffffff', svgMode: 'vector', filename: '' },
    view: { mode: 'fit', tiled: true, bg: 'checker', panX: 0.5, panY: 0.5, texGroup: 'all' },
  };
}

function sanitize(raw) {
  const d = defaultState();
  if (!raw || typeof raw !== 'object') return d;
  const s = { ...d, ...raw };
  s.global = { ...d.global, ...(raw.global || {}) };
  s.size = { ...d.size, ...(raw.size || {}), custom: { ...d.size.custom, ...((raw.size || {}).custom || {}) } };
  s.exp = { ...d.exp, ...(raw.exp || {}) };
  s.view = { ...d.view, ...(raw.view || {}) };
  if (!TEX[s.tex]) s.tex = d.tex;
  const params = {};
  for (const [id, p] of Object.entries(raw.params || {})) {
    if (!TEX[id]) continue;
    const def = defaultParams(TEX[id]);
    params[id] = Object.fromEntries(Object.entries(def).map(([k, v]) => [k, p && p[k] !== undefined && typeof p[k] === typeof v ? p[k] : v]));
  }
  s.params = params;
  if (!SIZE_GROUPS.some((g) => g.id === s.size.group)) s.size = d.size;
  if (!['png', 'jpeg', 'webp', 'svg'].includes(s.exp.format)) s.exp.format = 'png';
  s.seed = Math.abs(parseInt(s.seed, 10)) % 1000000 || 0;
  return s;
}

function encodeState(s) {
  const json = JSON.stringify(s);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeState(str) {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))));
}

function loadState() {
  try {
    const m = location.hash.match(/[#&]s=([A-Za-z0-9_-]+)/);
    if (m) return sanitize(decodeState(m[1]));
  } catch (e) { console.warn('Bad link state', e); }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch { /* storage unavailable */ }
  return defaultState();
}

let state = loadState();
let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ } }, 300);
}

const tex = () => TEX[state.tex];
const params = () => (state.params[state.tex] ||= defaultParams(tex()));
const currentSize = () => resolveSize(state.size);
const hasAlpha = () => state.global.lowA < 1 || state.global.highA < 1 || state.global.opacity < 1;
const metaDpi = (sz) => (sz.printable || state.size.group === 'custom' ? sz.dpi : 0);

function makeSpec(sz) {
  return { texId: state.tex, params: { ...params() }, global: { ...state.global }, W: sz.W, H: sz.H, tile: state.tile, seed: state.seed };
}

// ---------------------------------------------------------------------------------------
// Workers

const cores = navigator.hardwareConcurrency || 4;
const pool = new Pool(Math.max(1, Math.min(8, cores - 1)));

// ---------------------------------------------------------------------------------------
// Texture picker

const thumbs = [];
function buildTexGrid() {
  const tabs = $('tex-tabs');
  tabs.innerHTML = '';
  const groups = ['all', ...new Set(TEXTURES.map((t) => t.group))];
  for (const g of groups) {
    const b = el('button');
    b.type = 'button'; b.dataset.group = g;
    const n = g === 'all' ? TEXTURES.length : TEXTURES.filter((t) => t.group === g).length;
    b.append(g === 'all' ? 'All' : GROUP_LABELS[g] || g, el('span', 'count', String(n)));
    b.title = g === 'all' ? 'All textures' : g;
    b.addEventListener('click', () => { state.view.texGroup = g; syncTexGrid(); saveSoon(); });
    tabs.append(b);
  }
  const grid = $('tex-grid');
  grid.innerHTML = '';
  for (const t of TEXTURES) {
    const b = el('button', 'tex-btn');
    b.type = 'button'; b.dataset.id = t.id; b.setAttribute('role', 'option'); b.title = `${t.group}: ${t.desc}`;
    const cv = document.createElement('canvas'); cv.width = cv.height = 120;
    b.append(cv, el('span', null, t.name));
    b.addEventListener('click', () => selectTexture(t.id));
    grid.append(b);
    thumbs.push({ t, cv });
  }
}

async function renderThumbs() {
  for (const { t, cv } of thumbs) {
    const ctx = cv.getContext('2d');
    const spec = { texId: t.id, params: defaultParams(t), global: { ...DEFAULT_GLOBAL, ...t.colors }, W: 360, H: 360, tile: false, seed: 7 };
    renderImage(pool, spec, { outW: 120, outH: 120, group: 'thumb', stripPixels: 120 * 120, onStrip: (r, h, buf) => ctx.putImageData(new ImageData(buf, 120, h), 0, r) })
      .catch((e) => { if (!(e instanceof CancelledError)) console.error(e); });
  }
}

function selectTexture(id) {
  if (id === state.tex) return;
  state.tex = id;
  if (!state.keepColors) applyColors(tex().colors);
  syncAll();
  schedulePreview(0);
}

function applyColors(c) {
  Object.assign(state.global, { low: c.low, high: c.high, lowA: c.lowA, highA: c.highA });
}

// ---------------------------------------------------------------------------------------
// Parameter controls

function fmtValue(v, step) {
  const dec = step >= 1 ? 0 : Math.min(3, String(step).split('.')[1]?.length || 2);
  return Number(v).toFixed(dec);
}

function rangeField(labelText, id, min, max, step, value, onInput, hint) {
  const f = el('div', 'field');
  const line = el('div', 'label-line');
  const lab = el('label', null, labelText); lab.htmlFor = id;
  const out = el('output', null, fmtValue(value, step));
  line.append(lab, out);
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', id, min, max, step, value });
  input.addEventListener('input', () => { out.textContent = fmtValue(input.value, step); onInput(Number(input.value)); });
  f.append(line, input);
  if (hint) f.append(el('div', 'hint', hint));
  return f;
}

function buildParams() {
  const box = $('params');
  box.innerHTML = '';
  const p = params();
  for (const d of tex().params) {
    const id = 'p-' + d.id;
    if (d.type === 'range') {
      box.append(rangeField(d.label, id, d.min, d.max, d.step, p[d.id], (v) => { p[d.id] = v; schedulePreview(); }, d.hint));
    } else if (d.type === 'select') {
      const f = el('div', 'field');
      const lab = el('label', null, d.label); lab.htmlFor = id;
      const sel = document.createElement('select'); sel.id = id;
      for (const [v, l] of d.options) { const o = el('option', null, l); o.value = v; sel.append(o); }
      sel.value = p[d.id];
      sel.addEventListener('change', () => { p[d.id] = sel.value; schedulePreview(); });
      f.append(lab, sel);
      box.append(f);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Global controls

const GLOBAL_RANGES = {
  highA: (v) => `${Math.round(v * 100)}%`,
  lowA: (v) => `${Math.round(v * 100)}%`,
  opacity: (v) => `${Math.round(v * 100)}%`,
  brightness: (v) => (v > 0 ? '+' : '') + v.toFixed(2),
  contrast: (v) => v.toFixed(2) + '×',
  grain: (v) => `${Math.round(v * 100)}%`,
  vignette: (v) => `${Math.round(v * 100)}%`,
};

function bindGlobals() {
  for (const [id, fmt] of Object.entries(GLOBAL_RANGES)) {
    const input = $(id), out = $(id + '-out');
    input.addEventListener('input', () => {
      state.global[id] = Number(input.value);
      out.textContent = fmt(state.global[id]);
      syncAlphaSeg();
      schedulePreview();
    });
  }
  for (const id of ['low', 'high']) {
    $(id).addEventListener('input', () => { state.global[id] = $(id).value; schedulePreview(); });
  }
  $('invert').addEventListener('change', () => { state.global.invert = $('invert').checked; schedulePreview(); });
  $('keepColors').addEventListener('change', () => { state.keepColors = $('keepColors').checked; saveSoon(); });

  document.querySelectorAll('[data-alpha]').forEach((b) => b.addEventListener('click', () => {
    const g = state.global;
    if (b.dataset.alpha === 'opaque') { g.lowA = 1; g.highA = 1; }
    if (b.dataset.alpha === 'base') { g.lowA = 1; g.highA = 0; }
    if (b.dataset.alpha === 'tex') { g.lowA = 0; g.highA = 1; }
    syncGlobals();
    schedulePreview(0);
  }));

  $('btn-swap').addEventListener('click', () => {
    const g = state.global;
    [g.low, g.high] = [g.high, g.low];
    [g.lowA, g.highA] = [g.highA, g.lowA];
    syncGlobals();
    schedulePreview(0);
  });
  $('btn-defcolors').addEventListener('click', () => { applyColors(tex().colors); syncGlobals(); schedulePreview(0); });

  const pal = $('palette');
  for (const [name, low, high] of PALETTES) {
    const b = el('button');
    b.type = 'button'; b.title = name; b.setAttribute('aria-label', `Colour preset: ${name}`);
    b.style.background = `linear-gradient(135deg, ${high} 0 50%, ${low} 50% 100%)`;
    b.addEventListener('click', () => { state.global.low = low; state.global.high = high; syncGlobals(); schedulePreview(0); });
    pal.append(b);
  }
}

function syncAlphaSeg() {
  const { lowA, highA } = state.global;
  const cur = lowA === 1 && highA === 1 ? 'opaque' : lowA === 1 && highA === 0 ? 'base' : lowA === 0 && highA === 1 ? 'tex' : '';
  document.querySelectorAll('[data-alpha]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.alpha === cur)));
  updateExportUI();
}

function syncGlobals() {
  for (const [id, fmt] of Object.entries(GLOBAL_RANGES)) {
    $(id).value = state.global[id];
    $(id + '-out').textContent = fmt(Number(state.global[id]));
  }
  $('low').value = state.global.low;
  $('high').value = state.global.high;
  $('invert').checked = !!state.global.invert;
  $('keepColors').checked = !!state.keepColors;
  syncAlphaSeg();
}

// ---------------------------------------------------------------------------------------
// Size controls

function bindSize() {
  const g = $('size-group');
  for (const grp of SIZE_GROUPS) { const o = el('option', null, grp.label); o.value = grp.id; g.append(o); }
  for (const d of DPI_OPTIONS) { const o = el('option', null, `${d} dpi`); o.value = d; $('dpi').append(o); }

  g.addEventListener('change', () => {
    state.size.group = g.value;
    const grp = SIZE_GROUPS.find((x) => x.id === g.value);
    const DEF = { web: 'fhd', social: 'ig-square', tile: 't1024', paper: 'a4', photo: '8x10' };
    if (grp.items.length) state.size.preset = DEF[grp.id] || grp.items[0][0];
    state.size.swap = false;
    if (grp.tile && !state.tile) state.tile = true;
    syncSize();
    syncView();
    schedulePreview(0);
  });
  $('size-preset').addEventListener('change', () => { state.size.preset = $('size-preset').value; state.size.swap = false; syncSize(); schedulePreview(0); });
  $('dpi').addEventListener('change', () => { state.size.dpi = Number($('dpi').value); syncSize(); schedulePreview(0); });
  $('bleed').addEventListener('change', () => { state.size.bleed = $('bleed').checked; syncSize(); schedulePreview(0); });
  $('btn-rotate').addEventListener('click', () => { state.size.swap = !state.size.swap; syncSize(); schedulePreview(0); });
  for (const [id, key] of [['cw', 'w'], ['ch', 'h']]) {
    $(id).addEventListener('input', () => {
      const v = Number($(id).value);
      if (v > 0 && Number.isFinite(v)) { state.size.custom[key] = v; state.size.swap = false; syncSize(false); schedulePreview(150); }
    });
  }
  $('cunit').addEventListener('change', () => {
    const c = state.size.custom, from = c.unit, to = $('cunit').value;
    // Convert the numbers so the physical/pixel size stays the same.
    const toIn = { px: 1 / state.size.dpi, in: 1, mm: 1 / 25.4, cm: 1 / 2.54 };
    const k = toIn[from] / toIn[to];
    const round = (x) => (to === 'px' ? Math.round(x) : Math.round(x * 100) / 100);
    c.w = round(c.w * k); c.h = round(c.h * k); c.unit = to;
    syncSize();
    schedulePreview(0);
  });
}

function syncSize(rewriteInputs = true) {
  const s = state.size;
  const grp = SIZE_GROUPS.find((x) => x.id === s.group);
  $('size-group').value = s.group;
  const sel = $('size-preset');
  sel.innerHTML = '';
  for (const it of grp.items) {
    const o = el('option', null, it[1] + (grp.kind === 'print' ? `  (${fmtNum(it[2])}×${fmtNum(it[3])} ${it[4]})` : `  (${it[2]}×${it[3]})`));
    o.value = it[0]; sel.append(o);
  }
  if (grp.items.length) { if (!grp.items.some((i) => i[0] === s.preset)) s.preset = grp.items[0][0]; sel.value = s.preset; }
  $('preset-field').hidden = grp.kind === 'custom';
  $('custom-fields').hidden = grp.kind !== 'custom';
  if (rewriteInputs) { $('cw').value = s.custom.w; $('ch').value = s.custom.h; $('cunit').value = s.custom.unit; }
  const physical = grp.kind === 'print' || grp.kind === 'custom';
  $('dpi-field').hidden = !physical;
  if (!DPI_OPTIONS.includes(s.dpi)) s.dpi = 300;
  $('dpi').value = s.dpi;
  const sz = currentSize();
  $('bleed-wrap').hidden = !sz.physical && !(s.bleed && physical);
  $('bleed').checked = s.bleed;
  const unit = sz.physical ? sz.physical.unit : 'mm';
  $('bleed-amt').textContent = unit === 'in' ? '(⅛ in each side)' : unit === 'cm' ? '(0.3 cm each side)' : '(3 mm each side)';
  $('size-info').textContent = describeSize(sz);

  const mp = (sz.W * sz.H) / 1e6;
  const warn = $('size-warn');
  let msg = '';
  if (Math.max(sz.W, sz.H) > MAX_SIDE || mp > MAX_MP) msg = `That's too large to render in a browser (limit ${MAX_SIDE.toLocaleString()} px per side and ${MAX_MP} MP). Lower the DPI or size.`;
  else if (mp > WARN_MP) msg = `Large export (${Math.round(mp)} MP). Rendering can take a minute; PNG streams to keep memory low, JPEG/WebP need ~${Math.round((sz.W * sz.H * 4) / 1e6)} MB.`;
  if (sz.dpi < 150 && sz.printable) msg = (msg ? msg + ' ' : '') + 'Tip: 300 dpi is standard for print.';
  warn.textContent = msg; warn.hidden = !msg;
  updateExportUI();
}

// ---------------------------------------------------------------------------------------
// Export controls

function autoFilename(sz) {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dpi = metaDpi(sz);
  return `texture-${tex().id}-${slug(sz.label)}-${sz.W}x${sz.H}${dpi && sz.printable ? `-${dpi}dpi` : ''}`;
}

function bindExport() {
  document.querySelectorAll('[data-format]').forEach((b) => b.addEventListener('click', () => { state.exp.format = b.dataset.format; updateExportUI(); saveSoon(); }));
  $('quality').addEventListener('input', () => { state.exp.quality = Number($('quality').value); $('quality-out').textContent = Math.round(state.exp.quality * 100) + '%'; saveSoon(); });
  $('matte').addEventListener('input', () => { state.exp.matte = $('matte').value; saveSoon(); });
  document.querySelectorAll('input[name="svgmode"]').forEach((r) => r.addEventListener('change', () => { state.exp.svgMode = r.value; updateExportUI(); saveSoon(); }));
  $('filename').addEventListener('input', () => { state.exp.filename = $('filename').value.trim(); saveSoon(); });
  $('btn-export').addEventListener('click', doExport);
  $('btn-cancel').addEventListener('click', () => { if (exportJob) { exportJob.cancelled = true; pool.cancel(exportJob.group); } });
  $('btn-svg-preview').addEventListener('click', previewSvg);
  $('svg-close').addEventListener('click', () => $('svg-dialog').close());
  $('svg-dialog').addEventListener('close', () => { const img = $('svg-img'); if (img.src) URL.revokeObjectURL(img.src); img.removeAttribute('src'); });
}

function updateExportUI() {
  const f = state.exp.format, sz = currentSize();
  document.querySelectorAll('[data-format]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === f)));
  $('quality-field').hidden = !(f === 'jpeg' || f === 'webp');
  $('quality').value = state.exp.quality;
  $('quality-out').textContent = Math.round(state.exp.quality * 100) + '%';
  $('matte-field').hidden = f !== 'jpeg' || !hasAlpha();
  $('matte').value = state.exp.matte;
  $('svg-field').hidden = f !== 'svg';
  document.querySelectorAll('input[name="svgmode"]').forEach((r) => { r.checked = r.value === state.exp.svgMode; });
  $('btn-svg-preview').hidden = state.exp.svgMode !== 'vector';
  let note = FORMAT_NOTES[f];
  if (f === 'svg') {
    if (state.exp.svgMode === 'vector') {
      note = tex().vector
        ? 'This texture exports as pure vector shapes — editable in any vector app.'
        : 'This texture uses SVG filters (feTurbulence, lighting). They render in browsers, Inkscape and Illustrator; some tools (e.g. Figma) ignore SVG filters — choose the exact bitmap option for those.';
    } else note = 'Pixel-identical to the PNG export, wrapped in an SVG document.';
  }
  if (f === 'jpeg' && hasAlpha()) note += ' Your current colours use transparency.';
  $('format-note').textContent = note;
  $('filename').placeholder = autoFilename(sz);
  $('filename').value = state.exp.filename;
  const tooBig = Math.max(sz.W, sz.H) > MAX_SIDE || (sz.W * sz.H) / 1e6 > MAX_MP;
  $('btn-export').disabled = tooBig || !!exportJob;
  const ext = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', svg: 'SVG' }[f];
  $('btn-export').textContent = `Download ${ext} · ${sz.W} × ${sz.H}`;
}

// ---------------------------------------------------------------------------------------
// Preview

let previewGen = 0, previewTimer = 0, lastPreview = null;

function schedulePreview(delay = 70) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, delay);
  saveSoon();
  updateExportUI();
}

function bindView() {
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { state.view.mode = b.dataset.view; syncView(); schedulePreview(0); }));
  document.querySelectorAll('[data-bg]').forEach((b) => b.addEventListener('click', () => { state.view.bg = b.dataset.bg; syncView(); saveSoon(); }));
  $('tiled').addEventListener('change', () => { state.view.tiled = $('tiled').checked; schedulePreview(0); });
  $('tile').addEventListener('change', () => { state.tile = $('tile').checked; syncView(); schedulePreview(0); });

  // Drag to pan in 100% view. The canvas follows the pointer, then re-renders on release.
  const vp = $('viewport'), cv = $('preview');
  let drag = null;
  vp.addEventListener('pointerdown', (e) => {
    if (state.view.mode !== 'actual') return;
    drag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
    vp.setPointerCapture(e.pointerId);
  });
  vp.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.dx = e.clientX - drag.x; drag.dy = e.clientY - drag.y;
    cv.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
  });
  const end = () => {
    if (!drag) return;
    const sz = currentSize(), lp = lastPreview;
    if (lp && lp.mode === 'actual') {
      const halfW = lp.outW / 2, halfH = lp.outH / 2;
      const cx = Math.min(sz.W - halfW, Math.max(halfW, lp.x0 + halfW - drag.dx * lp.cssToImg));
      const cy = Math.min(sz.H - halfH, Math.max(halfH, lp.y0 + halfH - drag.dy * lp.cssToImg));
      state.view.panX = cx / sz.W; state.view.panY = cy / sz.H;
    }
    drag = null;
    schedulePreview(0);
  };
  vp.addEventListener('pointerup', end);
  vp.addEventListener('pointercancel', end);
  new ResizeObserver(() => schedulePreview(120)).observe(vp);
}

function syncView() {
  const v = state.view;
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v.mode)));
  document.querySelectorAll('[data-bg]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.bg === v.bg)));
  const vp = $('viewport');
  vp.classList.remove('bg-checker', 'bg-light', 'bg-dark');
  vp.classList.add('bg-' + v.bg);
  vp.classList.toggle('pannable', v.mode === 'actual');
  $('tiled').checked = v.tiled;
  $('tiled-wrap').hidden = !state.tile || v.mode !== 'fit';
  $('tile').checked = state.tile;
}

async function renderPreview() {
  const gen = ++previewGen;
  pool.cancel('preview');
  const sz = currentSize();
  const { W, H } = sz;
  if (Math.max(W, H) > MAX_SIDE * 4) return;
  const vp = $('viewport'), canvas = $('preview');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const availW = Math.max(40, vp.clientWidth - 24), availH = Math.max(40, vp.clientHeight - 24);
  const mode = state.view.mode;
  const tiled = mode === 'fit' && state.tile && state.view.tiled;
  const reps = tiled ? 2 : 1;
  let outW, outH, step, x0 = 0, y0 = 0, cssW, cssH;

  if (mode === 'actual') {
    // One image pixel per CSS pixel.
    step = 1;
    outW = Math.min(W, Math.floor(availW)); outH = Math.min(H, Math.floor(availH));
    x0 = Math.round(Math.min(W - outW, Math.max(0, state.view.panX * W - outW / 2)));
    y0 = Math.round(Math.min(H - outH, Math.max(0, state.view.panY * H - outH / 2)));
    cssW = outW; cssH = outH;
  } else {
    const s = Math.min(1, availW / (reps * W), availH / (reps * H));
    step = Math.max(1, 1 / (s * dpr));
    // Keep interactive previews responsive.
    const maxPx = 2.6e6 / (reps * reps);
    if ((W / step) * (H / step) > maxPx) step = Math.sqrt((W * H) / maxPx);
    outW = Math.max(1, Math.round(W / step)); outH = Math.max(1, Math.round(H / step));
    cssW = W * s; cssH = H * s;
  }

  const t0 = performance.now();
  const busyTimer = setTimeout(() => { if (gen === previewGen) $('busy').hidden = false; }, 120);
  const full = new Uint8ClampedArray(outW * outH * 4);
  const ctx = canvas.getContext('2d');
  const sameSize = canvas.width === outW * reps && canvas.height === outH * reps && !tiled;
  if (sameSize) setCanvasCss(canvas, cssW * reps, cssH * reps);

  try {
    await renderImage(pool, makeSpec(sz), {
      outW, outH, step, x0, y0, group: 'preview', priority: true, stripPixels: 65536,
      onStrip: (r, h, buf) => {
        if (gen !== previewGen) throw new CancelledError();
        full.set(buf, r * outW * 4);
        if (sameSize) ctx.putImageData(new ImageData(buf, outW, h), 0, r);
      },
    });
    if (gen !== previewGen) return;
    if (!sameSize) {
      canvas.width = outW * reps; canvas.height = outH * reps;
      setCanvasCss(canvas, cssW * reps, cssH * reps);
    }
    const img = new ImageData(full, outW, outH);
    for (let j = 0; j < reps; j++) for (let i = 0; i < reps; i++) ctx.putImageData(img, i * outW, j * outH);
    canvas.style.transform = '';
    lastPreview = { mode, outW, outH, x0, y0, cssToImg: mode === 'actual' ? 1 : step / dpr };
    const ms = performance.now() - t0;
    $('status-size').textContent = describeSize(sz);
    $('status-time').textContent = mode === 'actual'
      ? `100% view · showing ${outW}×${outH} px at (${x0}, ${y0}) · drag to pan`
      : `Preview ${Math.round((outW / W) * 100)}% · ${Math.round(ms)} ms${step > 1.5 ? ' · fine detail: try 100%' : ''}`;
  } catch (e) {
    if (!(e instanceof CancelledError)) { console.error(e); $('status-time').textContent = 'Preview failed: ' + e.message; }
  } finally {
    clearTimeout(busyTimer);
    if (gen === previewGen) $('busy').hidden = true;
  }
}

function setCanvasCss(canvas, w, h) {
  canvas.style.width = `${Math.max(1, Math.round(w))}px`;
  canvas.style.height = `${Math.max(1, Math.round(h))}px`;
}

// ---------------------------------------------------------------------------------------
// Export

let exportJob = null;

function setProgress(f, text) {
  $('progress-bar').style.width = `${Math.round(f * 100)}%`;
  if (text) $('progress-text').textContent = text;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function svgDims(sz) {
  if (!sz.physical) return { widthAttr: sz.W, heightAttr: sz.H };
  const { w, h, unit } = sz.physical;
  return { widthAttr: `${fmtNum(w)}${unit}`, heightAttr: `${fmtNum(h)}${unit}` };
}

async function exportPng(sz, spec, job, onProgress) {
  const dpi = metaDpi(sz);
  if (canStreamPng) {
    const enc = new PngEncoder(sz.W, sz.H, { alpha: hasAlpha(), dpi });
    try {
      await renderImage(pool, spec, { outW: sz.W, outH: sz.H, group: job.group, onStrip: (r, h, buf) => enc.addRows(buf, h), onProgress });
    } catch (e) { enc.writer.abort().catch(() => {}); throw e; }
    setProgress(1, 'Compressing…');
    return enc.finish();
  }
  const cv = await renderToCanvas(sz, spec, job, null, onProgress);
  const blob = await pngWithDpi(await canvasToBlob(cv, 'image/png'), dpi);
  cv.width = cv.height = 0;
  return blob;
}

async function renderToCanvas(sz, spec, job, matte, onProgress) {
  if (Math.max(sz.W, sz.H) > 32767 || sz.W * sz.H > 268e6) throw new Error('This size exceeds the browser canvas limit for JPEG/WebP. Use PNG instead.');
  const cv = document.createElement('canvas');
  cv.width = sz.W; cv.height = sz.H;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('The browser could not allocate a canvas this large. Use PNG or a smaller size.');
  const m = matte ? hexToRgb(matte) : null;
  await renderImage(pool, spec, {
    outW: sz.W, outH: sz.H, group: job.group, onProgress,
    onStrip: (r, h, buf) => {
      if (m) {
        for (let i = 0; i < buf.length; i += 4) {
          const a = buf[i + 3] / 255, ia = 1 - a;
          buf[i] = buf[i] * a + m[0] * ia; buf[i + 1] = buf[i + 1] * a + m[1] * ia; buf[i + 2] = buf[i + 2] * a + m[2] * ia; buf[i + 3] = 255;
        }
      }
      ctx.putImageData(new ImageData(buf, sz.W, h), 0, r);
    },
  });
  return cv;
}

async function doExport() {
  if (exportJob) return;
  const sz = currentSize(), fmt = state.exp.format, spec = makeSpec(sz);
  const job = (exportJob = { group: 'export-' + Date.now(), cancelled: false });
  const base = (state.exp.filename || autoFilename(sz)).replace(/\.(png|jpe?g|webp|svg)$/i, '');
  const name = `${base}.${fmt === 'jpeg' ? 'jpg' : fmt}`;
  const t0 = performance.now();
  $('progress').hidden = false; $('export-msg').textContent = '';
  setProgress(0, 'Rendering…');
  updateExportUI();
  const onProgress = (f) => setProgress(f, `Rendering… ${Math.round(f * 100)}%`);
  let extra = '';
  try {
    let blob;
    if (fmt === 'png') blob = await exportPng(sz, spec, job, onProgress);
    else if (fmt === 'jpeg' || fmt === 'webp') {
      const cv = await renderToCanvas(sz, spec, job, fmt === 'jpeg' ? state.exp.matte : null, onProgress);
      setProgress(1, 'Encoding…');
      blob = await canvasToBlob(cv, 'image/' + fmt, state.exp.quality);
      cv.width = cv.height = 0;
      if (fmt === 'webp' && blob.type !== 'image/webp') throw new Error('This browser cannot encode WebP. Try PNG or JPEG.');
      if (fmt === 'jpeg') blob = await jpegWithDpi(blob, metaDpi(sz));
    } else {
      const dims = svgDims(sz);
      let str = null;
      if (state.exp.svgMode === 'vector') {
        setProgress(0.5, 'Building SVG…');
        str = buildSvg(tex(), params(), state.global, { W: sz.W, H: sz.H, ...dims, tile: state.tile, seed: state.seed, title: `${tex().name} texture` });
        if (!str) extra = ' Too many shapes for a vector file at this size, so an exact bitmap SVG was created instead.';
      }
      if (!str) {
        const png = await exportPng(sz, spec, job, onProgress);
        str = embeddedSvg(await blobToBase64(png), { W: sz.W, H: sz.H, ...dims, title: `${tex().name} texture` });
      }
      blob = new Blob([str], { type: 'image/svg+xml' });
    }
    download(blob, name);
    $('export-msg').textContent = `Saved ${name} — ${fmtBytes(blob.size)} in ${((performance.now() - t0) / 1000).toFixed(1)} s.${extra}`;
  } catch (e) {
    if (e instanceof CancelledError || job.cancelled) $('export-msg').textContent = 'Export cancelled.';
    else { console.error(e); $('export-msg').textContent = 'Export failed: ' + e.message; }
  } finally {
    exportJob = null;
    $('progress').hidden = true;
    updateExportUI();
  }
}

function previewSvg() {
  const sz = currentSize();
  const str = buildSvg(tex(), params(), state.global, { W: sz.W, H: sz.H, ...svgDims(sz), tile: state.tile, seed: state.seed, title: `${tex().name} texture` });
  const info = $('svg-info');
  if (!str) { info.textContent = 'Too many shapes for a vector file at this size — the export will use an exact bitmap SVG instead.'; $('svg-img').removeAttribute('src'); }
  else {
    const blob = new Blob([str], { type: 'image/svg+xml' });
    $('svg-img').src = URL.createObjectURL(blob);
    info.textContent = `${fmtBytes(blob.size)} · ${str.includes('<filter') ? 'SVG filters' : 'pure vector shapes'} · rendered by your browser. Compare with the raster preview behind this dialog.`;
  }
  $('svg-dialog').showModal();
}

// ---------------------------------------------------------------------------------------
// Top bar + seed

function bindMisc() {
  $('seed').addEventListener('input', () => { const v = parseInt($('seed').value, 10); if (Number.isFinite(v)) { state.seed = Math.abs(v) % 1000000; schedulePreview(); } });
  $('btn-seed').addEventListener('click', () => { state.seed = Math.floor(Math.random() * 1000000); $('seed').value = state.seed; schedulePreview(0); });
  $('btn-reset-params').addEventListener('click', () => { state.params[state.tex] = defaultParams(tex()); buildParams(); schedulePreview(0); });
  $('btn-reset').addEventListener('click', () => {
    if (!confirm('Reset all settings to their defaults?')) return;
    state = defaultState();
    history.replaceState(null, '', location.pathname + location.search);
    syncAll();
    schedulePreview(0);
  });
  $('btn-share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}${location.search}#s=${encodeState(state)}`;
    const b = $('btn-share');
    try { await navigator.clipboard.writeText(url); b.textContent = 'Link copied'; }
    catch { history.replaceState(null, '', url); b.textContent = 'Link in address bar'; }
    setTimeout(() => { b.textContent = 'Copy link'; }, 1800);
  });
}

function syncTexGrid() {
  let g = state.view.texGroup || 'all';
  if (g !== 'all' && !TEXTURES.some((t) => t.group === g)) g = state.view.texGroup = 'all';
  document.querySelectorAll('#tex-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === g)));
  document.querySelectorAll('.tex-btn').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.id === state.tex));
    b.hidden = g !== 'all' && TEX[b.dataset.id].group !== g;
  });
}

function syncAll() {
  syncTexGrid();
  $('tex-desc').textContent = tex().desc;
  buildParams();
  $('seed').value = state.seed;
  syncGlobals();
  syncSize();
  syncView();
  updateExportUI();
}

// ---------------------------------------------------------------------------------------

buildTexGrid();
bindGlobals();
bindSize();
bindExport();
bindView();
bindMisc();
syncAll();
renderPreview().then(renderThumbs);

// Expose for debugging and automated checks.
window.__texgen = { get state() { return state; }, pool, renderPreview };
