// Themes: presets, custom colours, a background image (fit, dim, blur), see-through panels,
// corner roundness and UI size. Everything is CSS variables on :root, so changes apply instantly.

export const COLOR_KEYS = [
  ['bg', 'Background'],
  ['panel', 'Panels'],
  ['panel2', 'Buttons and fields'],
  ['line', 'Borders'],
  ['text', 'Text'],
  ['muted', 'Secondary text'],
  ['accent', 'Accent'],
  ['rec', 'Record'],
];

export const PRESETS = {
  dark: { name: 'Dark', colors: { bg: '#111316', panel: '#1a1d22', panel2: '#22262c', line: '#2e333a', text: '#e8eaed', muted: '#9aa0a8', accent: '#2d7ff9', rec: '#ff3b45' } },
  light: { name: 'Light', colors: { bg: '#f3f4f6', panel: '#ffffff', panel2: '#eceef1', line: '#d5d9df', text: '#1d2127', muted: '#5f6772', accent: '#2563eb', rec: '#e11d2e' } },
  oled: { name: 'OLED Black', colors: { bg: '#000000', panel: '#0a0a0a', panel2: '#161616', line: '#262626', text: '#f2f2f2', muted: '#9a9a9a', accent: '#3b82f6', rec: '#ff3040' } },
  midnight: { name: 'Midnight', colors: { bg: '#0b1020', panel: '#121a2e', panel2: '#1a2440', line: '#26324f', text: '#e6ebf5', muted: '#8f9bb3', accent: '#6c8cff', rec: '#ff4d6a' } },
  crimson: { name: 'Crimson', colors: { bg: '#111316', panel: '#880000', panel2: '#350000', line: '#440000', text: '#e8eaed', muted: '#c9a3a3', accent: '#2d7ff9', rec: '#ff3b45' } },
  forest: { name: 'Forest', colors: { bg: '#0d1410', panel: '#142019', panel2: '#1c2c22', line: '#28402f', text: '#e4efe7', muted: '#93a99a', accent: '#3fbf73', rec: '#ff4b4b' } },
  purple: { name: 'Purple', colors: { bg: '#120f1a', panel: '#1b1626', panel2: '#251e34', line: '#352b4a', text: '#ece6f7', muted: '#a497bd', accent: '#a46cff', rec: '#ff4d7a' } },
};

export const DEFAULT_THEME = {
  preset: 'dark',
  colors: { ...PRESETS.dark.colors },
  image: null, // { url, fit: 'cover'|'contain'|'tile'|'stretch', dim: 0..0.9, blur: 0..30 }
  panelOpacity: 0.85, // used only while a background image is set
  radius: 8,
  uiScale: 1,
};

export function normalize(t) {
  const theme = { ...DEFAULT_THEME, ...(t || {}) };
  theme.colors = { ...PRESETS.dark.colors, ...(PRESETS[theme.preset] ? PRESETS[theme.preset].colors : {}), ...((t && t.colors) || {}) };
  if (theme.image && !theme.image.url) theme.image = null;
  if (theme.image) theme.image = { fit: 'cover', dim: 0.35, blur: 0, ...theme.image };
  return theme;
}

const hexRe = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
export function isHex(v) { return typeof v === 'string' && hexRe.test(v); }

function rgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const rgba = (hex, a) => `rgba(${rgb(hex).join(', ')}, ${a})`;
// Relative luminance (WCAG), to pick light/dark native controls and readable text on the accent.
export function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// CSS variables for a theme (pure, so it can be tested).
export function cssVars(t) {
  const theme = normalize(t);
  const c = theme.colors;
  const see = theme.image ? Math.max(0.2, Math.min(1, theme.panelOpacity)) : 1;
  return {
    '--bg': theme.image ? 'transparent' : c.bg,
    '--surface': c.bg, // opaque, for pop-ups and dialogs
    '--panel': see < 1 ? rgba(c.panel, see) : c.panel,
    '--panel-2': see < 1 ? rgba(c.panel2, Math.min(1, see + 0.1)) : c.panel2,
    '--line': c.line,
    '--text': c.text,
    '--muted': c.muted,
    '--accent': c.accent,
    '--on-accent': luminance(c.accent) > 0.45 ? '#111111' : '#ffffff',
    '--rec': c.rec,
    '--radius': `${theme.radius}px`,
    '--bg-image': theme.image ? `url("${theme.image.url.replace(/"/g, '%22')}")` : 'none',
    '--bg-size': theme.image ? ({ cover: 'cover', contain: 'contain', tile: 'auto', stretch: '100% 100%' }[theme.image.fit] || 'cover') : 'cover',
    '--bg-repeat': theme.image && theme.image.fit === 'tile' ? 'repeat' : 'no-repeat',
    '--bg-dim': theme.image ? String(theme.image.dim) : '0',
    '--bg-blur': theme.image ? `${theme.image.blur}px` : '0px',
    '--bg-base': c.bg,
    'color-scheme': luminance(c.bg) > 0.4 ? 'light' : 'dark',
  };
}

export function apply(t, root = document.documentElement) {
  for (const [k, v] of Object.entries(cssVars(t))) {
    if (k === 'color-scheme') root.style.colorScheme = v;
    else root.style.setProperty(k, v);
  }
  root.classList.toggle('has-bg-image', !!(t && t.image && t.image.url));
}
