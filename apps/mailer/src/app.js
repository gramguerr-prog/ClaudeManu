'use strict';

const fs = require('fs');
const path = require('path');
const { HttpError, createRouter, readBody, parseCookies, json, send } = require('./http');
const { registerApiRoutes } = require('./api');
const { registerPublicRoutes } = require('./public');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const headers = { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  if (file.endsWith('.html')) {
    headers['X-Frame-Options'] = 'DENY';
    headers['Content-Security-Policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data:; frame-src 'self' blob: data:";
  }
  send(res, 200, fs.readFileSync(file), headers);
  return true;
}

function createApp({ store, transport }) {
  const router = createRouter();
  registerApiRoutes(router, { store, transport });
  registerPublicRoutes(router, { store, transport });

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const match = router.match(req.method, url.pathname);
      if (match) {
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
        await match.handler(req, res, { params: match.params, query: url.searchParams, body, cookies: parseCookies(req) });
        return;
      }
      if (req.method === 'GET' && serveStatic(url.pathname, res)) return;
      throw new HttpError(404, 'No encontrado');
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[app]', err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Error interno' : err.message });
    }
  };
}

module.exports = { createApp };
