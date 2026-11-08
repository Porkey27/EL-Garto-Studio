// Recordings library view.
import { $, el, toast, fmtBytes, ask } from './util.js';

const { studio } = window;
let items = [];

function open(item) {
  const v = $('#player-video');
  const img = $('#player-image');
  $('#player').hidden = false;
  $('#player-name').textContent = item.name;
  if (item.type === 'video') {
    img.hidden = true; v.hidden = false;
    v.src = `file://${item.path}`;
    v.play().catch(() => {});
  } else {
    v.hidden = true; img.hidden = false;
    img.src = `file://${item.path}`;
  }
}

function close() {
  const v = $('#player-video');
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('#player').hidden = true;
}

async function card(item) {
  const thumb = el('div', { class: 'thumb', title: 'Open' }, el('span', { class: 'kind' }, item.type === 'video' ? 'Video' : 'Snapshot'));
  thumb.addEventListener('click', () => open(item));
  if (item.type === 'snapshot') thumb.style.backgroundImage = `url("file://${encodeURI(item.path)}")`;
  else studio.call('library:thumb', item.path).then((u) => { thumb.style.backgroundImage = `url("${encodeURI(u)}")`; }).catch(() => {});
  const btn = (label, fn, cls) => { const b = el('button', { class: cls || '' }, label); b.addEventListener('click', fn); return b; };
  return el('div', { class: 'card' }, thumb, el('div', { class: 'meta' },
    el('div', { class: 'name', title: item.name }, item.name),
    el('div', { class: 'small muted' }, `${new Date(item.mtime).toLocaleString()} · ${fmtBytes(item.size)}`),
    el('div', { class: 'actions' },
      btn('Rename', async () => {
        const n = await ask('New name', item.name.replace(/\.\w+$/, ''));
        if (!n) return;
        try { await studio.call('library:rename', item.path, n); } catch (e) { toast(e.message, true); }
        refresh();
      }),
      btn('Show', () => studio.call('library:reveal', item.path)),
      btn('Open with…', () => studio.call('library:open', item.path)),
      btn('Delete', async () => {
        if (!confirm(`Move "${item.name}" to the trash?`)) return;
        try { await studio.call('library:trash', item.path); } catch (e) { toast(e.message, true); }
        refresh();
      }, 'danger'))));
}

async function render() {
  const f = $('#lib-filter').value;
  const grid = $('#library-grid');
  grid.innerHTML = '';
  const shown = items.filter((i) => f === 'all' || i.type === f);
  if (!shown.length) { grid.append(el('p', { class: 'muted' }, 'No recordings yet.')); return; }
  for (const i of shown) grid.append(await card(i));
}

export async function refresh() {
  items = await studio.call('library:list').catch(() => []);
  render();
}

export function init() {
  $('#lib-filter').addEventListener('change', render);
  $('#btn-open-folder').addEventListener('click', () => studio.call('library:dir').then((d) => studio.call('library:open', d)));
  $('#btn-player-close').addEventListener('click', close);
  $('#player').addEventListener('click', (e) => { if (e.target.id === 'player') close(); });
  studio.on('library:changed', (list) => { items = list; render(); });
}
