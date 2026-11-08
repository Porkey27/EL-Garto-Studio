'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const WebSocket = require('ws');

const { StudioRpcServer, RpcError, clean } = require('../src/main/wsserver');
const { ScriptStore, docxToText, rtfToText } = require('../src/main/prompter/scripts');
const { timestampName, remuxArgs } = require('../src/main/recorder');

function rpcClient(port, origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
  let id = 0;
  const pending = new Map();
  const notes = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else notes.push(m);
  });
  return {
    ws,
    notes,
    ready: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); }),
    call: (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params })); }),
  };
}

test('JSON-RPC server speaks the Studio protocol', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-'));
  const portFile = path.join(dir, 'ws-info.json');
  let recording = false;
  const app = {
    appInfo: () => ({ appID: 'x', operatingSystem: 'linux', name: 'n', version: '1', build: 0, interfaceRevision: 2 }),
    recordingInfo: () => ({ isRecording: recording, isRecordingAllowed: true, recordingDurationSec: 0, recordingSizeBytes: 0, usedDiskPercentage: 3 }),
    setRecording: (on) => { recording = on; return { isRecording: on }; },
    getProperty: (deviceId, propertyId) => { if (deviceId !== 'cam') throw new RpcError('invalidState'); return { deviceId, propertyId, value: 42, extra: null }; },
    devices: () => ({ devices: [{ deviceId: 'cam', deviceClass: 'camera', deviceType: 'FACECAM', name: 'Facecam', status: 'ready' }] }),
  };
  const srv = new StudioRpcServer(app, { portFile });
  const port = await srv.start();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(portFile, 'utf8')), { port });

  const c = rpcClient(port);
  await c.ready;
  assert.strictEqual((await c.call('getApplicationInfo')).result.operatingSystem, 'linux');
  assert.deepStrictEqual((await c.call('setIsRecording', { isRecording: true })).result, { isRecording: true });
  assert.strictEqual((await c.call('getRecordingInformation')).result.isRecording, true);
  assert.strictEqual((await c.call('setIsRecording', {})).error.code, -32602);
  assert.strictEqual((await c.call('nope')).error.code, -32601);
  assert.strictEqual((await c.call('getProperty', { deviceId: 'zzz', propertyId: 'zoom' })).error.code, -32001);
  const prop = (await c.call('getProperty', { deviceId: 'cam', propertyId: 'zoom' })).result;
  assert.deepStrictEqual(prop, { deviceId: 'cam', propertyId: 'zoom', value: 42 }, 'nulls are dropped');

  // propertyChanged only reaches subscribed clients
  srv.notify('propertyChanged', { deviceId: 'cam', propertyId: 'zoom', value: 1 });
  await c.call('setSubscription', { propertyChanged: { deviceId: 'cam', propertyId: 'zoom', isEnabled: true } });
  srv.notify('propertyChanged', { deviceId: 'cam', propertyId: 'zoom', value: 2 });
  srv.notify('devicesChanged', app.devices());
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(c.notes.map((n) => [n.method, n.params.value]), [['propertyChanged', 2], ['devicesChanged', undefined]]);

  c.ws.close();
  await srv.stop();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(portFile, 'utf8')), { port: -1 });
});

test('Stream Deck origin restriction rejects other origins', async () => {
  const srv = new StudioRpcServer({ appInfo: () => ({}) }, { limitToStreamDeck: () => true });
  const port = await srv.start();
  await assert.rejects(rpcClient(port, 'http://evil.example').ready);
  const ok = rpcClient(port, 'streamdeck://');
  await ok.ready;
  ok.ws.close();
  await srv.stop();
});

test('clean drops nulls recursively', () => {
  assert.deepStrictEqual(clean({ a: null, b: { c: undefined, d: 1 }, e: [{ f: null }] }), { b: { d: 1 }, e: [{}] });
});

// Builds a minimal stored (uncompressed) or deflated ZIP with one entry.
function makeZip(name, content, deflate) {
  const data = deflate ? zlib.deflateRawSync(content) : content;
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + n.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + n.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, data, central, n, eocd]);
}

test('docx import extracts paragraphs, tabs and entities', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Line </w:t><w:tab/><w:t>two</w:t></w:r></w:p></w:body></w:document>';
  for (const deflate of [false, true]) {
    assert.strictEqual(docxToText(makeZip('word/document.xml', Buffer.from(xml), deflate)), 'Hello & welcome\nLine \ttwo');
  }
});

test('rtf import strips control words', () => {
  assert.strictEqual(rtfToText('{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0\\fs24 Hi there\\par Caf\\\'e9}'), 'Arial;Hi there\n Café');
});

test('script store saves, lists and deletes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-'));
  const store = new ScriptStore(dir);
  const s = store.save({ title: 'Intro', text: 'one two three' });
  assert.strictEqual(store.list()[0].words, 3);
  assert.strictEqual(store.get(s.id).title, 'Intro');
  assert.throws(() => store.get('../etc/passwd'), /bad script id/);
  store.remove(s.id);
  assert.strictEqual(store.list().length, 0);
});

test('recorder naming and remux arguments', () => {
  assert.strictEqual(timestampName('Facecam', 'mp4', new Date(2026, 0, 2, 3, 4, 5)), 'Facecam 2026-01-02 03-04-05.mp4');
  assert.deepStrictEqual(remuxArgs('a.webm', 'b.mkv', 'mkv', 192), ['-i', 'a.webm', '-c', 'copy', 'b.mkv']);
  assert.ok(remuxArgs('a.webm', 'b.mp4', 'mp4', 192).includes('aac'));
});

test('VoiceSync matcher follows speech through the script', async () => {
  const { Matcher, normalize } = await import('../src/renderer/voicesync-match.js');
  assert.strictEqual(normalize('Café,'), 'cafe');
  const script = 'Welcome back to the channel. Today we are going to look at the new capture card and how colour works.'.split(' ');
  const m = new Matcher(script);
  assert.strictEqual(m.update('welcome back'), 2);
  assert.strictEqual(m.update('welcome back to the channel today'), 6);
  assert.strictEqual(m.update('uh'), null, 'filler words do not move the cursor');
  assert.strictEqual(m.update('going to look at the new'), 14);
  assert.strictEqual(m.update('how color works'), script.length, 'one-letter spelling differences still match');
});
