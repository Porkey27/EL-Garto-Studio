// Prompter tab in the main window: script library + editor, prompter settings, chat.
import { $, el, toast, debounce } from './util.js';
import { TwitchChat, KickChat, YouTubeChat } from './chat.js';

const { studio } = window;

let scripts = [];
let currentId = null;
let pSettings = {};
let chats = [];
let getCameraLabel = () => null;

const words = (t) => (t.match(/\S+/g) || []).length;

function stats() {
  const t = $('#script-text').value;
  const w = words(t);
  const wpm = 140; // typical speaking pace
  $('#script-stats').textContent = `${w} words · about ${Math.max(1, Math.round(w / wpm))} min`;
}

async function loadList() {
  scripts = await studio.call('scripts:list').catch(() => []);
  const ul = $('#script-list');
  ul.innerHTML = '';
  for (const s of scripts) {
    const li = el('li', { class: s.id === currentId ? 'active' : '' }, el('div', {}, s.title), el('div', { class: 'muted' }, `${s.words} words · ${new Date(s.updated).toLocaleDateString()}`));
    li.addEventListener('click', () => select(s.id));
    ul.append(li);
  }
}

async function select(id) {
  await saveNow();
  const s = await studio.call('scripts:get', id);
  currentId = s.id;
  $('#script-title').value = s.title;
  $('#script-text').value = s.text;
  stats();
  loadList();
  studio.prompter.load(s);
}

async function saveNow() {
  if (!currentId && !$('#script-text').value && !$('#script-title').value) return;
  const s = await studio.call('scripts:save', { id: currentId, title: $('#script-title').value, text: $('#script-text').value });
  currentId = s.id;
  studio.prompter.load(s);
}

const save = debounce(async () => { await saveNow(); loadList(); }, 600);

function pushSettings() {
  studio.prompter.settings({ ...pSettings, cameraLabel: pSettings.showCamera ? getCameraLabel() : null });
  studio.call('settings:set', 'prompter', pSettings).catch(() => {});
}

function bindRange(id, key, cast = Number) {
  const input = $(id);
  input.value = pSettings[key];
  input.addEventListener('input', () => { pSettings[key] = cast(input.value); pushSettings(); });
}

function bindCheck(id, key) {
  const input = $(id);
  input.checked = !!pSettings[key];
  input.addEventListener('change', () => { pSettings[key] = input.checked; pushSettings(); });
}

async function loadDisplays() {
  const ds = await studio.call('prompter:displays').catch(() => []);
  const sel = $('#prompter-display');
  sel.innerHTML = '';
  for (const d of ds) sel.append(el('option', { value: d.id }, `${d.label}${d.primary ? ' (main)' : ''}`));
  const other = ds.find((d) => !d.primary);
  if (other) sel.value = other.id;
}

function connectChat() {
  disconnectChat();
  const status = [];
  const show = (s) => {
    const prefix = s.split(':')[0];
    const i = status.findIndex((x) => x.startsWith(prefix));
    if (i >= 0) status[i] = s; else status.push(s);
    $('#chat-status').textContent = status.join(' · ');
  };
  const onMsg = (m) => studio.prompter.chat(m);
  const tw = $('#chat-twitch').value.trim();
  const kick = $('#chat-kick').value.trim();
  const yt = $('#chat-yt-video').value.trim();
  const key = $('#chat-yt-key').value.trim();
  if (tw) chats.push(new TwitchChat(tw, onMsg, show));
  if (kick) chats.push(new KickChat(kick, onMsg, show));
  if (yt && key) chats.push(new YouTubeChat(yt, key, onMsg, show));
  if (!chats.length) { toast('Enter at least one channel', true); return; }
  chats.forEach((c) => c.connect());
  studio.call('settings:set', 'chat', { twitch: tw, kick, youtubeVideo: yt, youtubeKey: key }).catch(() => {});
}

function disconnectChat() {
  chats.forEach((c) => c.close());
  chats = [];
}

export async function init(settings, cameraLabelFn) {
  getCameraLabel = cameraLabelFn;
  pSettings = { ...settings.prompter };
  const chat = settings.chat || {};
  $('#chat-twitch').value = chat.twitch || '';
  $('#chat-kick').value = chat.kick || '';
  $('#chat-yt-video').value = chat.youtubeVideo || '';
  $('#chat-yt-key').value = chat.youtubeKey || '';

  $('#script-text').addEventListener('input', () => { stats(); save(); });
  $('#script-title').addEventListener('input', save);
  $('#btn-script-new').addEventListener('click', async () => {
    await saveNow();
    currentId = null;
    $('#script-title').value = 'Untitled script';
    $('#script-text').value = '';
    await saveNow();
    loadList();
    $('#script-text').focus();
  });
  $('#btn-script-import').addEventListener('click', async () => {
    try {
      const imported = await studio.call('scripts:import');
      if (imported.length) { await loadList(); select(imported[0].id); }
    } catch (e) { toast(e.message, true); }
  });
  $('#btn-script-export').addEventListener('click', () => currentId && studio.call('scripts:export', currentId));
  $('#btn-script-delete').addEventListener('click', async () => {
    if (!currentId || !confirm('Delete this script?')) return;
    await studio.call('scripts:delete', currentId);
    currentId = null;
    $('#script-title').value = '';
    $('#script-text').value = '';
    loadList();
  });

  bindRange('#p-speed', 'speed');
  bindRange('#p-font', 'fontSize');
  bindRange('#p-line', 'lineHeight');
  bindRange('#p-margin', 'margin');
  bindRange('#p-cue', 'cueLine');
  bindRange('#p-countdown', 'countdownSec');
  const ff = $('#p-fontfamily');
  ff.value = pSettings.fontFamily;
  ff.addEventListener('change', () => { pSettings.fontFamily = ff.value; pushSettings(); });
  bindCheck('#p-mirror', 'mirror');
  bindCheck('#p-camera', 'showCamera');
  bindCheck('#p-chat-overlay', 'showChat');
  bindCheck('#p-voicesync', 'voiceSync');

  $('#btn-prompter-open').addEventListener('click', async () => {
    await studio.call('prompter:open', Number($('#prompter-display').value));
    // Give the window a moment to load, then send it the script and settings.
    setTimeout(async () => {
      if (currentId) studio.prompter.load(await studio.call('scripts:get', currentId));
      pushSettings();
    }, 800);
  });
  $('#btn-prompter-close').addEventListener('click', () => studio.call('prompter:close'));
  $('#btn-p-play').addEventListener('click', () => studio.prompter.command({ type: 'action', actionId: 'togglePlay' }));
  $('#btn-p-start').addEventListener('click', () => studio.prompter.command({ type: 'action', actionId: 'restart' }));
  $('#btn-chat-connect').addEventListener('click', connectChat);
  $('#btn-chat-disconnect').addEventListener('click', () => { disconnectChat(); $('#chat-status').textContent = 'Disconnected'; });

  studio.on('prompter:state', (st) => {
    $('#btn-p-play').textContent = st.isScriptPlaying ? 'Pause' : 'Play';
    if (st.voiceSyncStatus !== undefined) $('#voicesync-status').textContent = st.voiceSyncStatus;
    if (st.scrollSpeed !== undefined && Number($('#p-speed').value) !== st.scrollSpeed) {
      $('#p-speed').value = st.scrollSpeed;
      pSettings.speed = st.scrollSpeed;
    }
  });
  studio.on('prompter:command', async (cmd) => {
    // Script switching is handled here because the library lives in this window.
    if (cmd.type !== 'action' || !['nextScript', 'previousScript'].includes(cmd.actionId) || !scripts.length) return;
    const i = Math.max(0, scripts.findIndex((s) => s.id === currentId));
    const next = scripts[(i + (cmd.actionId === 'nextScript' ? 1 : scripts.length - 1)) % scripts.length];
    select(next.id);
  });

  await loadDisplays();
  await loadList();
  if (scripts[0]) select(scripts[0].id);
}

export function refreshCameraLabel() { pushSettings(); }
