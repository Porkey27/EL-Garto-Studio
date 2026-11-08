'use strict';
// JSON-RPC 2.0 WebSocket server matching Elgato Studio's local control API, so the
// Stream Deck plugin (and anything else written against Studio) can drive this app.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const ERR = {
  parse: { code: -32700, message: 'Invalid JSON was received by the server. An error occurred on the server while parsing the JSON text.' },
  invalidRequest: { code: -32600, message: 'The JSON sent is not a valid Request object.' },
  methodNotFound: { code: -32601, message: 'The method does not exist / is not available.' },
  invalidParams: { code: -32602, message: 'Invalid method parameter(s).' },
  internal: { code: -32603, message: 'Internal JSON-RPC error.' },
  invalidState: { code: -32001, message: 'The request is not allowed for the current state of the app.' },
};

class RpcError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

const STREAM_DECK_ORIGIN = 'streamdeck://';

// Drops null/undefined fields like the original's JsonIgnoreCondition.WhenWritingNull.
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) o[k] = clean(x);
    return o;
  }
  return v;
}

class StudioRpcServer {
  constructor(app, { portFile, limitToStreamDeck = () => false } = {}) {
    this.app = app;
    this.portFile = portFile;
    this.limitToStreamDeck = limitToStreamDeck;
    this.clients = new Map(); // ws -> { subs: Set<'deviceId|propertyId'> }
    this.http = null;
    this.wss = null;
    this.port = null;
    this.handlers = this.buildHandlers();
  }

  buildHandlers() {
    const a = this.app;
    const need = (p, ...keys) => {
      if (!p || keys.some((k) => p[k] === undefined || p[k] === null)) throw new RpcError('invalidParams');
      return p;
    };
    return {
      getApplicationInfo: () => a.appInfo(),
      getRecordingInformation: () => a.recordingInfo(),
      setIsRecording: (p) => a.setRecording(need(p, 'isRecording').isRecording),
      takeSnapshot: () => a.takeSnapshot(),
      getLastRecordingItemInformation: () => a.lastRecordingInfo(),
      openStorageLocation: () => a.openStorage(),
      getSignalInformation: () => a.signalInfo(),
      getPreviewInformation: () => a.previewInfo(),
      setPreviewInformation: (p) => a.setPreview(p || {}),
      getDevices: () => a.devices(),
      getSupportedProperties: (p) => a.supportedProperties(need(p, 'deviceId').deviceId),
      getSupportedActions: (p) => a.supportedActions(need(p, 'deviceId').deviceId),
      getProperty: (p) => a.getProperty(need(p, 'deviceId', 'propertyId').deviceId, p.propertyId),
      setProperty: (p) => a.setProperty(need(p, 'deviceId', 'propertyId').deviceId, p.propertyId, p.value),
      resetProperty: (p) => a.resetProperty(need(p, 'deviceId', 'propertyId').deviceId, p.propertyId),
      resetCategory: (p) => a.resetCategory(need(p, 'deviceId', 'categoryId').deviceId, p.categoryId),
      invokeAction: (p) => a.invokeAction(need(p, 'deviceId', 'actionId').deviceId, p.actionId, p.params || p.parameters || {}),
      getChatInformation: () => (a.chatInfo ? a.chatInfo() : { connections: [] }),
      setChatInformation: (p) => (a.setChatInfo ? a.setChatInfo(p) : { connections: [] }),
    };
  }

  async handle(ws, text) {
    let req;
    try {
      req = JSON.parse(text);
    } catch {
      return this.send(ws, { jsonrpc: '2.0', id: -1, error: ERR.invalidRequest });
    }
    if (!req || typeof req.method !== 'string') return this.send(ws, { jsonrpc: '2.0', id: -1, error: ERR.invalidRequest });
    const id = req.id;
    if (req.method === 'setSubscription') return this.send(ws, { jsonrpc: '2.0', id, result: this.subscribe(ws, req.params) });
    const h = this.handlers[req.method];
    if (!h) return this.send(ws, { jsonrpc: '2.0', id, error: ERR.methodNotFound });
    try {
      const result = await h(req.params);
      return this.send(ws, { jsonrpc: '2.0', id, result: clean(result === undefined ? {} : result) });
    } catch (e) {
      const kind = e instanceof RpcError ? e.kind : 'internal';
      return this.send(ws, { jsonrpc: '2.0', id, error: ERR[kind] || ERR.internal });
    }
  }

  subscribe(ws, params) {
    const cfg = params && params.propertyChanged;
    if (!cfg) return {};
    const c = this.clients.get(ws);
    const key = `${cfg.deviceId}|${cfg.propertyId}`;
    if (cfg.isEnabled) c.subs.add(key); else c.subs.delete(key);
    return { propertyChanged: cfg };
  }

  send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg, null, 2));
  }

  notify(method, params) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params: clean(params) }, null, 2);
    for (const [ws, c] of this.clients) {
      if (method === 'propertyChanged' && !c.subs.has(`${params.deviceId}|${params.propertyId}`)) continue;
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  writePortFile(port) {
    if (!this.portFile) return;
    fs.mkdirSync(path.dirname(this.portFile), { recursive: true });
    fs.writeFileSync(this.portFile, JSON.stringify({ port }));
  }

  start(preferredPort = 0) {
    return new Promise((resolve, reject) => {
      this.http = http.createServer((_req, res) => { res.writeHead(400); res.end(); });
      this.wss = new WebSocketServer({
        server: this.http,
        verifyClient: ({ origin }) => !this.limitToStreamDeck() || origin === STREAM_DECK_ORIGIN,
      });
      this.wss.on('connection', (ws) => {
        this.clients.set(ws, { subs: new Set() });
        ws.on('message', (data) => this.handle(ws, data.toString()));
        ws.on('close', () => this.clients.delete(ws));
      });
      this.http.once('error', reject);
      this.http.listen(preferredPort, '127.0.0.1', () => {
        this.port = this.http.address().port;
        this.writePortFile(this.port);
        resolve(this.port);
      });
    });
  }

  async stop() {
    for (const ws of this.clients.keys()) ws.close();
    this.clients.clear();
    if (this.wss) this.wss.close();
    if (this.http) await new Promise((r) => this.http.close(r));
    this.writePortFile(-1);
    this.port = null;
  }
}

module.exports = { StudioRpcServer, RpcError, ERR, clean };
