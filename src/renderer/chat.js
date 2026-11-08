// Read-only live chat clients for the prompter overlay. Messages are normalised to
// { platform, user, color, text, ts }.

export class TwitchChat {
  constructor(channel, onMessage, onStatus) {
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.onMessage = onMessage;
    this.onStatus = onStatus;
  }

  connect() {
    this.closed = false;
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      ws.send(`JOIN #${this.channel}`);
      this.onStatus(`Twitch: connected to #${this.channel}`);
    };
    ws.onmessage = (e) => {
      for (const line of e.data.split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send(line.replace('PING', 'PONG')); continue; }
        const m = /^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #\S+ :(.*)$/.exec(line);
        if (!m) continue;
        const tags = Object.fromEntries((m[1] || '').split(';').map((kv) => kv.split('=')));
        this.onMessage({ platform: 'twitch', user: tags['display-name'] || m[2], color: tags.color || null, text: m[3], ts: Date.now() });
      }
    };
    ws.onclose = () => {
      this.onStatus('Twitch: disconnected');
      if (!this.closed) setTimeout(() => this.connect(), 3000);
    };
  }

  close() { this.closed = true; if (this.ws) this.ws.close(); }
}

const KICK_PUSHER = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';

export class KickChat {
  constructor(channel, onMessage, onStatus) {
    this.channel = channel.trim();
    this.onMessage = onMessage;
    this.onStatus = onStatus;
  }

  async chatroomId() {
    if (/^\d+$/.test(this.channel)) return this.channel; // allow entering the numeric chatroom id
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(this.channel)}`);
    if (!r.ok) throw new Error(`Kick lookup failed (${r.status}); enter the numeric chatroom id instead`);
    return (await r.json()).chatroom.id;
  }

  async connect() {
    this.closed = false;
    let id;
    try { id = await this.chatroomId(); } catch (e) { this.onStatus(`Kick: ${e.message}`); return; }
    const ws = new WebSocket(KICK_PUSHER);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${id}.v2` } }));
      this.onStatus(`Kick: connected to ${this.channel}`);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === 'pusher:ping') { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); return; }
      if (msg.event !== 'App\\Events\\ChatMessageEvent') return;
      const d = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
      const text = (d.content || '').replace(/\[emote:\d+:([^\]]+)\]/g, ':$1:');
      this.onMessage({ platform: 'kick', user: d.sender.username, color: d.sender.identity && d.sender.identity.color, text, ts: Date.now() });
    };
    ws.onclose = () => {
      this.onStatus('Kick: disconnected');
      if (!this.closed) setTimeout(() => this.connect(), 3000);
    };
  }

  close() { this.closed = true; if (this.ws) this.ws.close(); }
}

export class YouTubeChat {
  constructor(videoId, apiKey, onMessage, onStatus) {
    this.videoId = videoId.trim();
    this.key = apiKey.trim();
    this.onMessage = onMessage;
    this.onStatus = onStatus;
  }

  api(path, params) {
    const q = new URLSearchParams({ ...params, key: this.key });
    return fetch(`https://www.googleapis.com/youtube/v3/${path}?${q}`).then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ? body.error.message : r.status);
      return body;
    });
  }

  async connect() {
    this.closed = false;
    try {
      const v = await this.api('videos', { part: 'liveStreamingDetails', id: this.videoId });
      const item = v.items && v.items[0];
      this.chatId = item && item.liveStreamingDetails && item.liveStreamingDetails.activeLiveChatId;
      if (!this.chatId) throw new Error('video has no active live chat');
      this.onStatus('YouTube: connected');
      this.poll(true);
    } catch (e) {
      this.onStatus(`YouTube: ${e.message}`);
    }
  }

  async poll(first) {
    if (this.closed) return;
    let wait = 5000;
    try {
      const r = await this.api('liveChat/messages', { liveChatId: this.chatId, part: 'snippet,authorDetails', ...(this.page ? { pageToken: this.page } : {}) });
      this.page = r.nextPageToken;
      wait = r.pollingIntervalMillis || wait;
      if (!first) {
        for (const m of r.items || []) {
          this.onMessage({ platform: 'youtube', user: m.authorDetails.displayName, color: null, text: m.snippet.displayMessage || '', ts: Date.parse(m.snippet.publishedAt) });
        }
      }
    } catch (e) {
      this.onStatus(`YouTube: ${e.message}`);
      wait = 15000;
    }
    this.timer = setTimeout(() => this.poll(false), wait);
  }

  close() { this.closed = true; clearTimeout(this.timer); }
}
