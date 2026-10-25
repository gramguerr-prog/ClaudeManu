'use strict';

/** Utilidades HTTP: router minimo, lectura de cuerpo, cookies y respuestas. */

const MAX_BODY = 10 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createRouter() {
  const routes = [];
  const add = method => (pattern, handler) => {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_m, key) => { keys.push(key); return '([^/]+)'; })}/?$`);
    routes.push({ method, regex, keys, handler });
  };
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    delete: add('DELETE'),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = pathname.match(route.regex);
        if (m) {
          const params = {};
          route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
          return { handler: route.handler, params };
        }
      }
      return null;
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = req.headers['content-type'] || '';
      if (!raw) return resolve({});
      try {
        if (type.includes('application/json')) return resolve(JSON.parse(raw));
        if (type.includes('application/x-www-form-urlencoded')) {
          return resolve(Object.fromEntries(new URLSearchParams(raw)));
        }
        resolve({ raw });
      } catch (_err) {
        reject(new HttpError(400, 'JSON no válido'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function html(res, status, body) {
  send(res, status, body, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data:; frame-src 'self'",
  });
}

module.exports = { HttpError, createRouter, readBody, parseCookies, send, json, html };
