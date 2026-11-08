// Prompter display window: smooth scrolling, countdown, mirror mode, camera background,
// chat overlay, and VoiceSync (speech-following scroll).
import { VoiceSync } from './voicesync.js';

const { studio } = window;
const $ = (s) => document.querySelector(s);

const view = {
  settings: { fontSize: 64, speed: 3, mirror: false, lineHeight: 1.4, countdownSec: 3, fontFamily: 'sans-serif', margin: 10, cueLine: 0.33, showChat: false, voiceSync: false },
  script: null,
  offset: 0, // px scrolled
  playing: false,
  lastFrame: 0,
  elapsed: 0,
  countdownTimer: null,
  wordEls: [],
  voice: null,
  cameraLabel: null,
};

const textEl = $('#text');

function report(extra = {}) {
  const max = Math.max(1, textEl.scrollHeight - innerHeight * (1 - view.settings.cueLine));
  const progress = Math.min(100, Math.round((view.offset / max) * 100));
  $('#progress').style.width = `${progress}%`;
  const pxPerSec = pxSpeed();
  studio.prompter.state({
    isScriptPlaying: view.playing,
    scrollSpeed: view.settings.speed,
    scriptName: view.script ? view.script.title : null,
    scriptProgress: progress,
    scriptElapsedSec: Math.round(view.elapsed),
    scriptRemainingSec: pxPerSec ? Math.round(Math.max(0, max - view.offset) / pxPerSec) : 0,
    countdownSec: view.settings.countdownSec,
    ...extra,
  });
}

// Speed 1–10 maps to roughly 0.25–2.5 lines per second at the current font size.
function pxSpeed() {
  return view.settings.speed * 0.25 * view.settings.fontSize * view.settings.lineHeight;
}

function layout() {
  const s = view.settings;
  textEl.style.fontSize = `${s.fontSize}px`;
  textEl.style.lineHeight = String(s.lineHeight);
  textEl.style.fontFamily = s.fontFamily;
  textEl.style.padding = `0 ${s.margin}vw`;
  textEl.style.right = s.showChat ? '26%' : '0';
  $('#flip').classList.toggle('mirror', !!s.mirror);
  $('#cueline').style.top = `${s.cueLine * 100}%`;
  $('#chat').hidden = !s.showChat;
  // Start with the first line on the cue line.
  textEl.style.top = `${s.cueLine * innerHeight}px`;
  applyOffset();
}

function applyOffset() {
  textEl.style.transform = `translateY(${-view.offset}px)`;
}

function render() {
  textEl.innerHTML = '';
  view.wordEls = [];
  if (!view.script) return;
  for (const line of view.script.text.split('\n')) {
    const p = document.createElement('div');
    if (/^\s*\[.*\]\s*$/.test(line)) {
      p.className = 'cue';
      p.textContent = line;
    } else {
      for (const part of line.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { p.append(part); continue; }
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = part;
        span.dataset.i = String(view.wordEls.length);
        view.wordEls.push(span);
        p.append(span);
      }
      if (!line.trim()) p.innerHTML = '&nbsp;';
    }
    textEl.append(p);
  }
  if (view.voice) view.voice.setWords(view.wordEls.map((w) => w.textContent));
}

function frame(t) {
  requestAnimationFrame(frame);
  const dt = view.lastFrame ? (t - view.lastFrame) / 1000 : 0;
  view.lastFrame = t;
  if (!view.playing || view.settings.voiceSync) return;
  view.elapsed += dt;
  const max = textEl.scrollHeight;
  view.offset = Math.min(max, view.offset + pxSpeed() * dt);
  applyOffset();
  if (view.offset >= max) { view.playing = false; report(); }
  if (Math.floor(t / 500) !== Math.floor((t - dt * 1000) / 500)) report();
}

function startCountdown(then) {
  const n = Number(view.settings.countdownSec) || 0;
  if (!n) { then(); return; }
  let left = n;
  const box = $('#countdown');
  box.hidden = false;
  box.textContent = left;
  clearInterval(view.countdownTimer);
  view.countdownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(view.countdownTimer); box.hidden = true; then(); return; }
    box.textContent = left;
  }, 1000);
}

function play() {
  if (view.playing) return;
  startCountdown(() => { view.playing = true; report(); });
}

function pause() {
  clearInterval(view.countdownTimer);
  $('#countdown').hidden = true;
  view.playing = false;
  report();
}

function restart() {
  pause();
  view.offset = 0;
  view.elapsed = 0;
  view.wordEls.forEach((w) => w.classList.remove('done'));
  if (view.voice) view.voice.reset();
  applyOffset();
  report();
}

// VoiceSync moves the matched word onto the cue line.
function scrollToWord(i) {
  const w = view.wordEls[i];
  if (!w) return;
  for (let k = 0; k < view.wordEls.length; k++) view.wordEls[k].classList.toggle('done', k < i);
  const target = w.offsetTop;
  const start = view.offset;
  const t0 = performance.now();
  const anim = (t) => {
    const k = Math.min(1, (t - t0) / 250);
    view.offset = start + (target - start) * (1 - (1 - k) ** 3);
    applyOffset();
    if (k < 1) requestAnimationFrame(anim);
  };
  requestAnimationFrame(anim);
  report();
}

async function setVoiceSync(on) {
  if (on && !view.voice) {
    view.voice = new VoiceSync({
      onWord: scrollToWord,
      onStatus: (s) => { $('#status').textContent = s; report({ voiceSyncStatus: s }); },
      getModelPath: () => studio.call('voicesync:model'),
    });
    view.voice.setWords(view.wordEls.map((w) => w.textContent));
    try { await view.voice.start(); } catch (e) { report({ voiceSyncStatus: `VoiceSync error: ${e.message}` }); view.voice = null; }
  } else if (!on && view.voice) {
    view.voice.stop();
    view.voice = null;
    $('#status').textContent = '';
    report({ voiceSyncStatus: 'Off' });
  }
}

async function setCamera(label) {
  const v = $('#camera');
  if (label === view.cameraLabel) return;
  view.cameraLabel = label;
  if (v.srcObject) v.srcObject.getTracks().forEach((t) => t.stop());
  v.srcObject = null;
  v.hidden = !label;
  if (!label) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const d = devs.find((x) => x.kind === 'videoinput' && x.label === label);
  if (!d) return;
  try {
    v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: d.deviceId }, width: { ideal: 1280 } } });
  } catch { v.hidden = true; }
}

function addChat(m) {
  const box = $('#chat');
  const div = document.createElement('div');
  div.className = 'm';
  const p = document.createElement('span'); p.className = 'p'; p.textContent = m.platform;
  const b = document.createElement('b'); b.textContent = m.user; if (m.color) b.style.color = m.color;
  div.append(p, b, document.createTextNode(m.text));
  box.prepend(div);
  while (box.children.length > 60) box.lastChild.remove();
}

studio.on('prompter:load', (script) => {
  const same = view.script && view.script.id === script.id;
  view.script = script;
  render();
  if (!same) restart(); else layout();
});

studio.on('prompter:settings', (s) => {
  const vs = !!s.voiceSync;
  view.settings = { ...view.settings, ...s };
  layout();
  setVoiceSync(vs);
  setCamera(s.cameraLabel || null);
  report();
});

studio.on('prompter:chat', addChat);
studio.on('prompter:status', (s) => { $('#status').textContent = s; });

studio.on('prompter:command', (cmd) => {
  if (cmd.type === 'action') {
    switch (cmd.actionId) {
      case 'togglePlay': view.playing ? pause() : play(); break;
      case 'play': play(); break;
      case 'pause': pause(); break;
      case 'restart': restart(); break;
      case 'speedUp': view.settings.speed = Math.min(10, view.settings.speed + 0.5); report(); break;
      case 'speedDown': view.settings.speed = Math.max(1, view.settings.speed - 0.5); report(); break;
      default: break;
    }
  } else if (cmd.type === 'set') {
    if (cmd.key === 'isScriptPlaying') (cmd.value ? play() : pause());
    else if (cmd.key === 'scrollSpeed') { view.settings.speed = Math.max(1, Math.min(10, Number(cmd.value))); report(); }
    else if (cmd.key === 'countdownSec') { view.settings.countdownSec = Number(cmd.value); report(); }
  }
});

addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); view.playing ? pause() : play(); }
  else if (e.key === 'ArrowUp') { view.offset = Math.max(0, view.offset - view.settings.fontSize * 2); applyOffset(); }
  else if (e.key === 'ArrowDown') { view.offset += view.settings.fontSize * 2; applyOffset(); }
  else if (e.key === 'Home') restart();
  else if (e.key === '+' || e.key === '=') { view.settings.speed = Math.min(10, view.settings.speed + 0.5); report(); }
  else if (e.key === '-') { view.settings.speed = Math.max(1, view.settings.speed - 0.5); report(); }
  else if (e.key === 'm') { view.settings.mirror = !view.settings.mirror; layout(); }
  else if (e.key === 'Escape') window.close();
});

addEventListener('wheel', (e) => { view.offset = Math.max(0, view.offset + e.deltaY); applyOffset(); report(); });
addEventListener('resize', layout);

layout();
requestAnimationFrame(frame);
report();
