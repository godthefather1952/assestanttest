'use strict';
// Live feed: a standard Solana websocket logsSubscribe on the pump program. Every pump transaction's logs arrive here,
// which carry the decoded events, so no extra RPC call is needed per trade. Uses Node's built-in WebSocket (Node 22+).
const { EventEmitter } = require('node:events');
const { parseLogs, PUMP_PROGRAM } = require('./decode');

const CREATE_IX = /^Program log: Instruction: Create(V2)?$/;

class Feed extends EventEmitter {
  constructor({ url, commitment = 'processed', staleMs = 15000, WebSocketImpl = globalThis.WebSocket, now = Date.now, timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
    super();
    if (!url) throw new Error('RPC_WS_URL is not set');
    if (!WebSocketImpl) throw new Error('No WebSocket available: use Node 22 or newer');
    this.url = url;
    this.commitment = commitment;
    this.staleMs = staleMs;
    this.WS = WebSocketImpl;
    this.now = now;
    this.timers = timers;
    this.ws = null;
    this.stopped = false;
    this.backoff = 1000;
    this.state = { connected: false, subscribed: false, lastMessageAt: 0, lastSlot: 0, reconnects: 0, notifications: 0, failedTx: 0, lastError: null };
  }

  start() {
    this.stopped = false;
    this._connect();
    this.watchdog = this.timers.setInterval(() => this._check(), 2000);
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) this.timers.clearInterval(this.watchdog);
    if (this.ws) try { this.ws.close(); } catch (e) { /* ignore */ }
  }

  healthy() {
    return this.state.connected && this.state.subscribed && this.now() - this.state.lastMessageAt < this.staleMs;
  }

  _connect() {
    this.state.connected = false;
    this.state.subscribed = false;
    let ws;
    this.connectStartedAt = this.now();
    try { ws = new this.WS(this.url); } catch (e) { this.state.lastError = e.message; return this._reconnect(); }
    this.ws = ws;
    ws.onopen = () => {
      this.state.connected = true;
      this.state.lastMessageAt = this.now();
      this.backoff = 1000;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: this.commitment }] }));
    };
    ws.onmessage = (msg) => this._message(typeof msg.data === 'string' ? msg.data : String(msg.data));
    // Node's built-in WebSocket fires only `error`, never `close`, when a connection is refused, so an error before the
    // socket opened is handled as a close.
    ws.onerror = (e) => {
      this.state.lastError = (e && e.message) || 'websocket error';
      if (this.ws === ws && !this.state.connected) this._drop(ws);
    };
    ws.onclose = () => { if (this.ws === ws) this._drop(ws); };
  }

  _drop(ws) {
    this.ws = null;
    this.state.connected = false;
    this.state.subscribed = false;
    try { ws.close(); } catch (e) { /* ignore */ }
    if (!this.stopped) this._reconnect();
  }

  _reconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.state.reconnects++;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.reconnectTimer = this.timers.setTimeout(() => { this.reconnectTimer = null; this._connect(); }, wait);
    this.emit('status', this.state);
  }

  _check() {
    if (this.stopped || !this.ws) return;
    const now = this.now();
    if (this.state.connected && now - this.state.lastMessageAt > this.staleMs) {
      this.state.lastError = `no message for ${Math.round((now - this.state.lastMessageAt) / 1000)}s`;
      this._drop(this.ws);
    } else if (!this.state.connected && now - this.connectStartedAt > this.staleMs) {
      this.state.lastError = `could not connect within ${Math.round(this.staleMs / 1000)}s`;
      this._drop(this.ws);
    }
  }

  _message(text) {
    this.state.lastMessageAt = this.now();
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.id === 1) {
      if (msg.error) { this.state.lastError = 'subscribe failed: ' + (msg.error.message || JSON.stringify(msg.error)); return; }
      this.state.subscribed = true;
      this.emit('status', this.state);
      return;
    }
    if (msg.method !== 'logsNotification') return;
    const r = msg.params && msg.params.result;
    if (!r || !r.value) return;
    this.state.notifications++;
    const slot = r.context && r.context.slot;
    if (slot > this.state.lastSlot) this.state.lastSlot = slot;
    if (r.value.err) { this.state.failedTx++; return; }
    const logs = r.value.logs || [];
    this.emit('tx', { slot, signature: r.value.signature, receivedAt: this.now(), hasCreateIx: logs.some((l) => CREATE_IX.test(l)), events: parseLogs(logs) });
  }
}

module.exports = { Feed, CREATE_IX };
