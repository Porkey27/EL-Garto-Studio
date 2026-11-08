export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer = null;
export function toast(msg, isError = false) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
}

export function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtTime(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

// Electron has no window.prompt(); this is a minimal modal text input.
export function ask(title, initial = '') {
  return new Promise((resolve) => {
    const input = el('input', { value: initial });
    const done = (v) => { overlay.remove(); resolve(v); };
    const ok = el('button', { class: 'primary', onclick: () => done(input.value.trim() || null) }, 'OK');
    const cancel = el('button', { onclick: () => done(null) }, 'Cancel');
    const overlay = el('div', { class: 'player' }, el('div', { class: 'dialog' }, el('div', {}, title), input, el('div', { class: 'row' }, el('span', { class: 'spacer' }), cancel, ok)));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); if (e.key === 'Escape') cancel.click(); });
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
