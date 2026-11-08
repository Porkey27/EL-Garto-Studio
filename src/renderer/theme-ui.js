// Settings > Appearance: presets, colour pickers, background image, sliders, import/export.
import { $, el, toast, debounce } from './util.js';
import { PRESETS, COLOR_KEYS, DEFAULT_THEME, normalize, apply, isHex } from './theme.js';

const { studio } = window;

let theme = normalize(null);
const saveSoon = debounce(() => studio.call('settings:set', 'theme', theme).catch((e) => toast(e.message, true)), 300);

function update(next, { rerender = false } = {}) {
  theme = normalize(next);
  apply(theme);
  saveSoon();
  if (rerender) render();
}

export function init(saved) {
  theme = normalize(saved);
  apply(theme);
  render();
}

function slider(label, { min, max, step = 1, value, format, onInput }) {
  const out = el('output', {}, format(value));
  const input = el('input', { type: 'range', min, max, step });
  input.value = value;
  input.addEventListener('input', () => { out.textContent = format(Number(input.value)); onInput(Number(input.value)); });
  return el('label', { class: 'theme-slider' }, el('span', {}, label), input, out);
}

function render() {
  const box = $('#appearance');
  if (!box) return;
  box.innerHTML = '';
  box.append(el('h3', {}, 'Appearance'));

  // Presets
  const swatches = el('div', { class: 'theme-swatches' });
  for (const [id, p] of Object.entries(PRESETS)) {
    const chips = el('span', { class: 'chips' }, ['bg', 'panel', 'accent', 'text'].map((k) => {
      const s = el('span', {});
      s.style.background = p.colors[k];
      return s;
    }));
    const b = el('button', { class: `theme-swatch${theme.preset === id ? ' active' : ''}`, title: `Use the ${p.name} theme` }, chips, el('small', {}, p.name));
    b.addEventListener('click', () => update({ ...theme, preset: id, colors: { ...p.colors } }, { rerender: true }));
    swatches.append(b);
  }
  if (theme.preset === 'custom') swatches.append(el('span', { class: 'muted small', style: 'align-self:center' }, 'Custom'));
  box.append(el('div', { class: 'muted small' }, 'Presets'), swatches);

  // Colours
  const colors = el('div', { class: 'theme-colors' });
  for (const [key, label] of COLOR_KEYS) {
    const input = el('input', { type: 'color', 'aria-label': label });
    input.value = isHex(theme.colors[key]) ? theme.colors[key] : '#000000';
    input.addEventListener('input', () => update({ ...theme, preset: 'custom', colors: { ...theme.colors, [key]: input.value } }));
    input.addEventListener('change', () => render()); // refresh the preset highlight
    colors.append(el('label', { class: 'theme-color' }, input, label));
  }
  box.append(el('div', { class: 'muted small' }, 'Colours'), colors);

  // Background image
  const img = theme.image;
  const preview = el('div', { class: 'theme-image-preview' });
  if (img) preview.style.backgroundImage = `url("${img.url.replace(/"/g, '%22')}")`;
  const choose = el('button', {}, img ? 'Change image…' : 'Choose image…');
  choose.addEventListener('click', async () => {
    try {
      const url = await studio.call('theme:chooseImage');
      if (url) update({ ...theme, image: { fit: 'cover', dim: 0.35, blur: 0, ...(theme.image || {}), url } }, { rerender: true });
    } catch (e) { toast(e.message, true); }
  });
  const remove = el('button', { hidden: !img }, 'Remove');
  remove.addEventListener('click', async () => {
    await studio.call('theme:removeImage').catch(() => {});
    update({ ...theme, image: null }, { rerender: true });
  });
  box.append(el('div', { class: 'muted small' }, 'Background image'),
    el('div', { class: 'row' }, preview, el('div', { class: 'row', style: 'flex-direction:column;align-items:flex-start' }, choose, remove)));
  if (img) {
    const fit = el('select', {}, [['cover', 'Fill'], ['contain', 'Fit'], ['stretch', 'Stretch'], ['tile', 'Tile']].map(([v, l]) => el('option', { value: v }, l)));
    fit.value = img.fit;
    fit.addEventListener('change', () => update({ ...theme, image: { ...theme.image, fit: fit.value } }));
    box.append(el('label', { class: 'theme-slider' }, el('span', {}, 'Image fit'), fit, el('span', {})));
    box.append(slider('Darken image', { min: 0, max: 0.9, step: 0.05, value: img.dim, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => update({ ...theme, image: { ...theme.image, dim: v } }) }));
    box.append(slider('Blur image', { min: 0, max: 30, value: img.blur, format: (v) => `${v}px`, onInput: (v) => update({ ...theme, image: { ...theme.image, blur: v } }) }));
    box.append(slider('Panel opacity', { min: 0.2, max: 1, step: 0.05, value: theme.panelOpacity, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => update({ ...theme, panelOpacity: v }) }));
  }

  // Shape and size
  box.append(el('div', { class: 'muted small' }, 'Layout'));
  box.append(slider('Corner roundness', { min: 0, max: 16, value: theme.radius, format: (v) => `${v}px`, onInput: (v) => update({ ...theme, radius: v }) }));
  box.append(slider('UI size', {
    min: 0.7, max: 1.6, step: 0.05, value: theme.uiScale, format: (v) => `${Math.round(v * 100)}%`,
    onInput: debounce((v) => { update({ ...theme, uiScale: v }); studio.call('window:zoom', v); }, 150),
  }));

  // Import / export / reset
  const exp = el('button', {}, 'Export theme…');
  exp.addEventListener('click', async () => {
    try { const f = await studio.call('theme:export', theme); if (f) toast(`Theme saved to ${f}`); } catch (e) { toast(e.message, true); }
  });
  const imp = el('button', {}, 'Import theme…');
  imp.addEventListener('click', async () => {
    try {
      const t = await studio.call('theme:import');
      if (!t) return;
      update(t, { rerender: true });
      studio.call('window:zoom', theme.uiScale);
      toast('Theme imported');
    } catch (e) { toast(e.message, true); }
  });
  const reset = el('button', {}, 'Reset to default');
  reset.addEventListener('click', async () => {
    if (theme.image) await studio.call('theme:removeImage').catch(() => {});
    update({ ...DEFAULT_THEME }, { rerender: true });
    studio.call('window:zoom', 1);
  });
  box.append(el('div', { class: 'row' }, imp, exp, el('span', { class: 'spacer' }), reset));
}
