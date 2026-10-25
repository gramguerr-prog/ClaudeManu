'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { Store } = require('../src/store');
const { createTransport } = require('../src/transport');
const { createSender } = require('../src/sender');
const { createApp } = require('../src/app');

/** Servidor SMTP falso que guarda lo recibido y rechaza "noexiste@". */
function fakeSmtp() {
  const received = [];
  const server = net.createServer(socket => {
    let buffer = '';
    let inData = false;
    let current = null;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; received.push(current); socket.write('250 OK\r\n'); } else current.data += `${line}\n`;
          continue;
        }
        if (/^EHLO/.test(line)) socket.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) socket.write('235 ok\r\n');
        else if (/^MAIL FROM/.test(line)) { current = { from: line, to: '', data: '' }; socket.write('250 OK\r\n'); }
        else if (/^RCPT TO/.test(line)) {
          if (line.includes('noexiste@')) socket.write('550 5.1.1 No such user\r\n');
          else { current.to = line; socket.write('250 OK\r\n'); }
        } else if (line === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else if (line === 'RSET') socket.write('250 OK\r\n');
        else socket.write('500 ?\r\n');
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port })));
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manumail-'));
  const store = new Store(dir);
  const transport = createTransport(store);
  const sender = createSender(store, transport, { tickMs: 60000 });
  const server = http.createServer(createApp({ store, transport }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function call(method, url, body, { form = false, raw = false } = {}) {
    const headers = { cookie };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
      payload = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: raw || !text.startsWith('{') && !text.startsWith('[') ? text : JSON.parse(text) };
  }

  return { dir, store, sender, server, base, call, close: () => new Promise(r => server.close(r)) };
}

test('flujo completo: login, audiencia, importacion, envio, seguimiento y baja', async () => {
  const smtp = await fakeSmtp();
  const ctx = await setup();
  const { call, store, sender } = ctx;
  try {
    assert.strictEqual((await call('GET', '/api/lists')).status, 401, 'API protegida sin sesion');
    assert.deepStrictEqual((await call('GET', '/api/auth')).body, { needsSetup: true, authed: false });
    assert.strictEqual((await call('POST', '/api/auth/setup', { password: 'corta' })).status, 400);
    assert.strictEqual((await call('POST', '/api/auth/setup', { password: 'supersecreta' })).status, 200);
    assert.strictEqual((await call('POST', '/api/auth/setup', { password: 'otraclave1' })).status, 403);

    const settingsRes = await call('PUT', '/api/settings', {
      orgName: 'Despacho', fromEmail: 'info@despacho.es', postalAddress: 'C/ Sol 2, Sevilla', baseUrl: 'https://mail.test',
      ratePerMinute: 6000, smtp: { host: '127.0.0.1', port: smtp.port, secure: false, user: 'u', pass: 'p' },
    });
    assert.strictEqual(settingsRes.body.smtp.pass, '********', 'no devuelve la contrasena SMTP');

    const list = (await call('POST', '/api/lists', { name: 'Clientes' })).body;
    const imported = (await call('POST', `/api/lists/${list.id}/import`, {
      csv: 'email,nombre,etiquetas\nana@x.com,Ana,vip\nbea@x.com,Bea,\nnoexiste@x.com,Nadie,vip\nmal-email,X,\n',
      consentSource: 'test',
    })).body;
    assert.deepStrictEqual({ added: imported.added, skipped: imported.skipped }, { added: 3, skipped: 1 });
    assert.strictEqual((await call('POST', `/api/lists/${list.id}/contacts`, { email: 'ANA@x.com' })).status, 409);

    const campaign = (await call('POST', '/api/campaigns', { templateId: 'simple' })).body;
    await call('PUT', `/api/campaigns/${campaign.id}`, {
      name: 'Octubre', subject: 'Hola {{nombre}}', listId: list.id, tags: 'vip',
      html: '<p>Hola {{nombre}}</p><a href="https://example.com/oferta">Oferta</a>',
    });
    assert.strictEqual((await call('GET', `/api/campaigns/${campaign.id}/audience`)).body.count, 2);

    assert.strictEqual((await call('POST', `/api/campaigns/${campaign.id}/send`, {})).status, 200);
    assert.strictEqual((await call('PUT', `/api/campaigns/${campaign.id}`, { name: 'x' })).status, 409, 'no se edita tras enviar');

    await sender.tick();
    const sent = (await call('GET', `/api/campaigns/${campaign.id}`)).body;
    assert.strictEqual(sent.status, 'sent');
    assert.strictEqual(sent.stats.sent, 1);
    assert.strictEqual(sent.stats.failed, 1);
    assert.strictEqual(store.all('contacts').find(c => c.email === 'noexiste@x.com').status, 'bounced', 'rebote duro');
    assert.strictEqual(smtp.received.length, 1);

    const mail = smtp.received[0];
    assert.match(mail.to, /ana@x\.com/);
    const headers = mail.data.split('\n\n')[0];
    assert.match(headers, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
    const htmlPart = mail.data.split('Content-Type: text/html; charset=utf-8\nContent-Transfer-Encoding: base64\n\n')[1].split('\n--')[0];
    const html = Buffer.from(htmlPart.replace(/\n/g, ''), 'base64').toString('utf8');
    assert.ok(html.includes('Hola Ana'));

    const pixel = html.match(/https:\/\/mail\.test(\/t\/o\/[^"]+)/)[1];
    const click = html.match(/https:\/\/mail\.test(\/t\/c\/[^"]+)/)[1];
    const unsub = html.match(/https:\/\/mail\.test(\/u\/[^"]+)/)[1];

    const pixelRes = await call('GET', pixel, undefined, { raw: true });
    assert.strictEqual(pixelRes.headers.get('content-type'), 'image/gif');
    const clickRes = await call('GET', click, undefined, { raw: true });
    assert.strictEqual(clickRes.status, 302);
    assert.strictEqual(clickRes.headers.get('location'), 'https://example.com/oferta');
    assert.strictEqual((await call('GET', `${click.slice(0, -3)}xyz`, undefined, { raw: true })).status, 404, 'token manipulado');

    const getUnsub = await call('GET', unsub, undefined, { raw: true });
    assert.strictEqual(getUnsub.status, 200);
    assert.strictEqual(store.all('contacts').find(c => c.email === 'ana@x.com').status, 'subscribed', 'GET no da de baja');
    await call('POST', unsub, { 'List-Unsubscribe': 'One-Click' }, { form: true, raw: true });
    assert.strictEqual(store.all('contacts').find(c => c.email === 'ana@x.com').status, 'unsubscribed');

    const report = (await call('GET', `/api/campaigns/${campaign.id}`)).body.stats;
    assert.strictEqual(report.uniqueOpens, 1);
    assert.strictEqual(report.uniqueClicks, 1);
    assert.strictEqual(report.unsubscribes, 1);
    assert.strictEqual(report.openRate, 100);
    assert.deepStrictEqual(report.linkClicks, [{ url: 'https://example.com/oferta', clicks: 1, unique: 1 }]);

    // Reimportar no reactiva a quien se dio de baja.
    await call('POST', `/api/lists/${list.id}/import`, { csv: 'email\nana@x.com\n', consentSource: 'test' });
    assert.strictEqual(store.all('contacts').find(c => c.email === 'ana@x.com').status, 'unsubscribed');

    const exported = await call('GET', `/api/lists/${list.id}/export`, undefined, { raw: true });
    assert.match(exported.headers.get('content-type'), /text\/csv/);
    assert.ok(exported.body.includes('ana@x.com,Ana,,vip,unsubscribed'));
  } finally {
    await ctx.close();
    smtp.server.close();
  }
});

test('formulario publico con doble opt-in y modo bandeja local', async () => {
  const ctx = await setup();
  const { call, store } = ctx;
  try {
    await call('POST', '/api/auth/setup', { password: 'supersecreta' });
    await call('PUT', '/api/settings', { fromEmail: 'info@x.es', baseUrl: 'https://mail.test' });
    const list = (await call('POST', '/api/lists', { name: 'Newsletter' })).body;

    const form = await call('GET', `/f/${list.id}`, undefined, { raw: true });
    assert.ok(form.body.includes('name="consent"'));

    const noConsent = await call('POST', `/f/${list.id}`, { email: 'lucia@x.com' }, { form: true, raw: true });
    assert.strictEqual(noConsent.status, 400);

    const bot = await call('POST', `/f/${list.id}`, { email: 'bot@x.com', consent: 'yes', website: 'spam' }, { form: true, raw: true });
    assert.strictEqual(bot.status, 200);
    assert.strictEqual(store.all('contacts').length, 0, 'honeypot descarta bots');

    await call('POST', `/f/${list.id}`, { email: 'Lucia@x.com', firstName: 'Lucia', consent: 'yes' }, { form: true, raw: true });
    const contact = store.all('contacts')[0];
    assert.strictEqual(contact.email, 'lucia@x.com');
    assert.strictEqual(contact.status, 'pending');
    assert.strictEqual(contact.consent.source, 'formulario');

    const outbox = path.join(ctx.dir, 'outbox');
    const files = fs.readdirSync(outbox);
    assert.strictEqual(files.length, 1, 'email de confirmacion guardado como .eml');
    const raw = fs.readFileSync(path.join(outbox, files[0]), 'utf8');
    const textPart = raw.split('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
    const confirmPath = Buffer.from(textPart.replace(/\r\n/g, ''), 'base64').toString('utf8').match(/https:\/\/mail\.test(\/confirm\/\S+)/)[1];

    assert.strictEqual((await call('GET', confirmPath, undefined, { raw: true })).status, 200);
    assert.strictEqual(store.all('contacts')[0].status, 'subscribed');
    assert.ok(store.all('contacts')[0].consent.confirmedAt);

    // Supresion RGPD
    assert.strictEqual((await call('DELETE', `/api/contacts/${contact.id}`)).status, 200);
    assert.strictEqual(store.all('contacts').length, 0);
  } finally {
    await ctx.close();
  }
});

test('login limita intentos y rutas estaticas no permiten traversal', async () => {
  const ctx = await setup();
  try {
    await ctx.call('POST', '/api/auth/setup', { password: 'supersecreta' });
    await ctx.call('POST', '/api/auth/logout', {});
    assert.strictEqual((await ctx.call('GET', '/api/dashboard')).status, 401);
    assert.strictEqual((await ctx.call('POST', '/api/auth/login', { password: 'mala' })).status, 401);
    assert.strictEqual((await ctx.call('POST', '/api/auth/login', { password: 'supersecreta' })).status, 200);
    assert.strictEqual((await ctx.call('GET', '/api/dashboard')).status, 200);
    for (let i = 0; i < 10; i++) await ctx.call('POST', '/api/auth/login', { password: 'mala' });
    assert.strictEqual((await ctx.call('POST', '/api/auth/login', { password: 'supersecreta' })).status, 429);

    const res = await fetch(`${ctx.base}/..%2f..%2fpackage.json`);
    assert.strictEqual(res.status, 404);
    assert.strictEqual((await fetch(`${ctx.base}/`)).status, 200);
  } finally {
    await ctx.close();
  }
});
