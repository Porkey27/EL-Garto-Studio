'use strict';
// Exposes a narrow, promise-based API to the renderer pages.

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const on = (channel, fn) => {
  const h = (_e, ...a) => fn(...a);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('studio', {
  call,
  on,
  sendChunk: (buf) => ipcRenderer.send('recorder:chunk', buf),
  sendFlashbackSegment: (buf, dur) => ipcRenderer.send('flashback:segment', buf, dur),
  sendVcamChunk: (buf) => ipcRenderer.send('vcam:chunk', buf),
  reportPreview: (p) => ipcRenderer.send('state:preview', p),
  reportLevels: (l, r) => ipcRenderer.send('state:levels', l, r),
  reportSignal: (s) => ipcRenderer.send('state:signal', s),
  setFullscreen: (on) => ipcRenderer.send('window:fullscreen', on),
  prompter: {
    command: (cmd) => ipcRenderer.send('prompter:command', cmd),
    state: (st) => ipcRenderer.send('prompter:state', st),
    load: (script) => ipcRenderer.send('prompter:load', script),
    settings: (s) => ipcRenderer.send('prompter:settings', s),
    chat: (msg) => ipcRenderer.send('prompter:chat', msg),
  },
});
