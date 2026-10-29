'use strict';
// Local dashboard and kill switch. Binds to 127.0.0.1 by default (reach it over an SSH tunnel). Any other host needs
// DASHBOARD_TOKEN, sent as the x-dashboard-token header for every request including GET.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PAGE = path.join(__dirname, '..', 'public', 'dashboard.html');

function isLoopback(host) { return host === '127.0.0.1' || host === '::1' || host === 'localhost'; }

function tokenOk(req, token) {
  if (!token) return true;
  const got = String(req.headers['x-dashboard-token'] || '');
  const a = Buffer.from(got), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function startServer({ host, port, token }, { getStatus, kill, resume }) {
  if (!isLoopback(host) && !token) throw new Error(`Refusing to serve the dashboard on ${host} without DASHBOARD_TOKEN`);
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      // The page itself carries no data; it asks for the token if the API needs one.
      return send(200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
    }
    if (!tokenOk(req, token)) return send(401, { error: 'token required' });
    if (req.method === 'GET' && url.pathname === '/api/status') return send(200, getStatus());
    if (req.method === 'POST' && url.pathname === '/api/kill') { kill('dashboard'); return send(200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/resume') { resume(); return send(200, { ok: true }); }
    return send(404, { error: 'not found' });
  });
  server.listen(port, host);
  return server;
}

module.exports = { startServer, isLoopback, tokenOk };
