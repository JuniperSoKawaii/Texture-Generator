// Output size presets. Web sizes are in pixels; print sizes are physical and
// converted with the chosen DPI.

export const SIZE_GROUPS = [
  {
    id: 'web', label: 'Web & screens', kind: 'px',
    items: [
      ['hd', 'HD 720p', 1280, 720],
      ['fhd', 'Full HD 1080p', 1920, 1080],
      ['qhd', 'QHD 1440p', 2560, 1440],
      ['uhd', '4K UHD', 3840, 2160],
      ['5k', '5K', 5120, 2880],
      ['hero', 'Website hero', 1920, 800],
      ['laptop', 'Laptop wallpaper (16:10)', 2880, 1800],
      ['ultrawide', 'Ultrawide 21:9', 3440, 1440],
      ['phone', 'Phone wallpaper', 1290, 2796],
      ['tablet', 'Tablet wallpaper', 2048, 2732],
      ['meeting', 'Video-call background', 1920, 1080],
    ],
  },
  {
    id: 'social', label: 'Social media', kind: 'px',
    items: [
      ['ig-square', 'Instagram post (square)', 1080, 1080],
      ['ig-portrait', 'Instagram post (portrait 4:5)', 1080, 1350],
      ['story', 'Story / Reel / TikTok', 1080, 1920],
      ['og', 'Link preview (Open Graph)', 1200, 630],
      ['fb-cover', 'Facebook cover', 1640, 624],
      ['x-header', 'X / Twitter header', 1500, 500],
      ['li-banner', 'LinkedIn banner', 1584, 396],
      ['yt-thumb', 'YouTube thumbnail', 1280, 720],
      ['yt-banner', 'YouTube channel art', 2560, 1440],
      ['pin', 'Pinterest pin (2:3)', 1000, 1500],
    ],
  },
  {
    id: 'tile', label: 'Seamless tiles', kind: 'px', tile: true,
    items: [
      ['t256', 'Tile 256', 256, 256],
      ['t512', 'Tile 512', 512, 512],
      ['t1024', 'Tile 1024', 1024, 1024],
      ['t2048', 'Tile 2048', 2048, 2048],
      ['t4096', 'Tile 4096', 4096, 4096],
    ],
  },
  {
    id: 'paper', label: 'Print — paper', kind: 'print',
    items: [
      ['a0', 'A0', 841, 1189, 'mm'],
      ['a1', 'A1', 594, 841, 'mm'],
      ['a2', 'A2', 420, 594, 'mm'],
      ['a3', 'A3', 297, 420, 'mm'],
      ['a4', 'A4', 210, 297, 'mm'],
      ['a5', 'A5', 148, 210, 'mm'],
      ['a6', 'A6', 105, 148, 'mm'],
      ['letter', 'US Letter', 8.5, 11, 'in'],
      ['legal', 'US Legal', 8.5, 14, 'in'],
      ['tabloid', 'Tabloid / Ledger', 11, 17, 'in'],
      ['half', 'Half Letter', 5.5, 8.5, 'in'],
    ],
  },
  {
    id: 'photo', label: 'Print — photo, poster & stationery', kind: 'print',
    items: [
      ['bc', 'Business card (US)', 3.5, 2, 'in'],
      ['bc-eu', 'Business card (EU)', 85, 55, 'mm'],
      ['4x6', '4 × 6 in photo / postcard', 4, 6, 'in'],
      ['5x7', '5 × 7 in card', 5, 7, 'in'],
      ['8x10', '8 × 10 in', 8, 10, 'in'],
      ['11x14', '11 × 14 in', 11, 14, 'in'],
      ['12x12', '12 × 12 in scrapbook', 12, 12, 'in'],
      ['16x20', '16 × 20 in poster', 16, 20, 'in'],
      ['18x24', '18 × 24 in poster', 18, 24, 'in'],
      ['24x36', '24 × 36 in poster', 24, 36, 'in'],
    ],
  },
  { id: 'custom', label: 'Custom size', kind: 'custom', items: [] },
];

export const DPI_OPTIONS = [72, 96, 150, 200, 240, 300, 400, 600];
export const UNITS = { px: 1, in: 1, mm: 1 / 25.4, cm: 1 / 2.54 };

export const MAX_SIDE = 30000;
export const MAX_MP = 250;
export const WARN_MP = 50;

// state: { group, preset, swap, dpi, bleed, custom: { w, h, unit } }
export function resolveSize(s) {
  const group = SIZE_GROUPS.find((g) => g.id === s.group) || SIZE_GROUPS[0];
  let W, H, physical = null, label;
  if (group.kind === 'custom') {
    const { w, h, unit } = s.custom;
    label = 'Custom';
    if (unit === 'px') { W = w; H = h; }
    else {
      const f = UNITS[unit];
      physical = { w, h, unit };
      W = w * f * s.dpi; H = h * f * s.dpi;
    }
  } else {
    const item = group.items.find((i) => i[0] === s.preset) || group.items[0];
    label = item[1];
    if (group.kind === 'px') { W = item[2]; H = item[3]; }
    else {
      const [, , w, h, unit] = item;
      physical = { w, h, unit };
      W = w * UNITS[unit] * s.dpi; H = h * UNITS[unit] * s.dpi;
    }
  }
  if (physical && s.bleed) {
    // 3 mm (metric) or 0.125 in each side.
    const b = physical.unit === 'in' ? 0.125 : physical.unit === 'cm' ? 0.3 : 3;
    physical = { ...physical, w: physical.w + 2 * b, h: physical.h + 2 * b, bleed: b };
    const f = UNITS[physical.unit];
    W = physical.w * f * s.dpi; H = physical.h * f * s.dpi;
  }
  W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
  if (s.swap) {
    [W, H] = [H, W];
    if (physical) physical = { ...physical, w: physical.h, h: physical.w };
  }
  const dpi = physical ? s.dpi : (s.group === 'custom' ? s.dpi : 72);
  return { W, H, physical, dpi, label, tile: !!group.tile, printable: !!physical };
}

export function fmtNum(x) {
  return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100);
}

export function describeSize(r) {
  const mp = (r.W * r.H) / 1e6;
  let s = `${r.W} × ${r.H} px · ${mp >= 10 ? mp.toFixed(0) : mp.toFixed(1)} MP`;
  if (r.physical) s += ` · ${fmtNum(r.physical.w)} × ${fmtNum(r.physical.h)} ${r.physical.unit} @ ${r.dpi} dpi`;
  return s;
}
