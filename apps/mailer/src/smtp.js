'use strict';

/**
 * Cliente SMTP minimo (RFC 5321) sin dependencias: TLS implicito (465) o
 * STARTTLS (587), AUTH PLAIN/LOGIN, una conexion por mensaje.
 */

const net = require('net');
const tls = require('tls');

const TIMEOUT_MS = 30000;

class SmtpConnection {
  constructor(socket) {
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    this.waiter = null;
    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('Tiempo de espera SMTP agotado')));
    socket.on('data', chunk => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        this.lines.push(this.buffer.slice(0, idx).replace(/\r$/, ''));
        this.buffer = this.buffer.slice(idx + 1);
      }
      this.flush();
    });
    socket.on('error', err => this.fail(err));
    socket.on('close', () => this.fail(new Error('Conexion SMTP cerrada')));
  }

  detach() {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    this.socket.setTimeout(0);
  }

  fail(err) {
    this.error = this.error || err;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(this.error);
    }
  }

  flush() {
    if (!this.waiter) return;
    // Una respuesta termina en la linea "NNN texto" (sin guion).
    const end = this.lines.findIndex(line => /^\d{3}(?: |$)/.test(line));
    if (end === -1) return;
    const block = this.lines.splice(0, end + 1);
    const { resolve } = this.waiter;
    this.waiter = null;
    resolve({ code: Number(block[end].slice(0, 3)), lines: block.map(l => l.slice(4)) });
  }

  read() {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.flush();
    });
  }

  async command(line, expected) {
    if (line !== null) this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    const ok = Array.isArray(expected) ? expected.includes(reply.code) : reply.code === expected;
    if (!ok) {
      const shown = line && /^AUTH|^[A-Za-z0-9+/=]{8,}$/.test(line) ? '[credenciales]' : line;
      const err = new Error(`SMTP ${reply.code}: ${reply.lines.join(' ')} (tras "${shown}")`);
      err.code = reply.code;
      throw err;
    }
    return reply;
  }
}

function connect(options) {
  return new Promise((resolve, reject) => {
    const opts = { host: options.host, port: options.port, servername: options.host };
    const socket = options.secure ? tls.connect(opts) : net.connect(opts);
    const onError = err => reject(err);
    socket.once('error', onError);
    socket.once(options.secure ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
    secure.once('error', reject);
  });
}

function dotStuff(data) {
  return data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

/**
 * Envia un mensaje ya construido.
 * @param {object} config { host, port, secure, user, pass }
 * @param {object} envelope { from, to }
 * @param {string} raw mensaje MIME completo
 */
async function sendRaw(config, envelope, raw) {
  const port = Number(config.port) || (config.secure ? 465 : 587);
  const socket = await connect({ host: config.host, port, secure: Boolean(config.secure) });
  const conn = new SmtpConnection(socket);
  const heloName = process.env.SMTP_HELO || 'localhost';
  try {
    await conn.command(null, 220);
    let ehlo = await conn.command(`EHLO ${heloName}`, 250);

    if (!config.secure && ehlo.lines.some(l => /^STARTTLS/i.test(l))) {
      await conn.command('STARTTLS', 220);
      conn.detach();
      conn.attach(await upgradeToTls(conn.socket, config.host));
      ehlo = await conn.command(`EHLO ${heloName}`, 250);
    }

    if (config.user) {
      const authLine = ehlo.lines.find(l => /^AUTH\b/i.test(l)) || '';
      if (/\bPLAIN\b/i.test(authLine) || !/\bLOGIN\b/i.test(authLine)) {
        const token = Buffer.from(`\0${config.user}\0${config.pass}`).toString('base64');
        await conn.command(`AUTH PLAIN ${token}`, 235);
      } else {
        await conn.command('AUTH LOGIN', 334);
        await conn.command(Buffer.from(config.user).toString('base64'), 334);
        await conn.command(Buffer.from(config.pass).toString('base64'), 235);
      }
    }

    await conn.command(`MAIL FROM:<${envelope.from}>`, 250);
    await conn.command(`RCPT TO:<${envelope.to}>`, [250, 251]);
    await conn.command('DATA', 354);
    const body = dotStuff(raw);
    await conn.command(`${body}${body.endsWith('\r\n') ? '' : '\r\n'}.`, 250);
    await conn.command('QUIT', [221, 250]).catch(() => {});
  } finally {
    conn.socket.destroy();
  }
}

module.exports = { sendRaw, dotStuff };
