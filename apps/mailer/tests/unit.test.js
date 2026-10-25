'use strict';

const test = require('node:test');
const assert = require('node:assert');
const csv = require('../src/csv');
const { sign, verify, hashPassword, checkPassword } = require('../src/tokens');
const { renderEmail, extractLinks, htmlToText } = require('../src/render');
const { buildMessage } = require('../src/mime');
const { dotStuff } = require('../src/smtp');

const settings = { orgName: 'Despacho Ruiz', postalAddress: 'Calle Mayor 1, Madrid', baseUrl: 'https://mail.test/' };

test('csv: parsea comillas, punto y coma y BOM', () => {
  const rows = csv.parse('\uFEFFCorreo;Nombre;Etiquetas\r\n"ana@x.com";"Ana; la ""jefa""";vip|cliente\r\n\r\nbea@x.com;Bea;\n');
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(csv.toContact(rows[0]), { email: 'ana@x.com', firstName: 'Ana; la "jefa"', lastName: '', tags: 'vip|cliente' });
  assert.strictEqual(csv.toContact(rows[1]).email, 'bea@x.com');
});

test('csv: stringify escapa y neutraliza formulas', () => {
  const out = csv.stringify(['a', 'b'], [{ a: '=SUMA(1)', b: 'x,"y"' }]);
  assert.strictEqual(out, 'a,b\r\n\'=SUMA(1),"x,""y"""\r\n');
});

test('tokens: firma y detecta manipulacion', () => {
  const token = sign({ k: 'u', r: 'abc' }, 'secreto');
  assert.deepStrictEqual(verify(token, 'secreto'), { k: 'u', r: 'abc' });
  assert.strictEqual(verify(token, 'otro'), null);
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ k: 'u', r: 'xyz' })).toString('base64url');
  assert.strictEqual(verify(`${forged}.${mac}`, 'secreto'), null);
  assert.strictEqual(verify(body, 'secreto'), null);
});

test('tokens: contrasenas con scrypt', () => {
  const stored = hashPassword('correcta1');
  assert.ok(checkPassword('correcta1', stored));
  assert.ok(!checkPassword('incorrecta', stored));
});

test('render: etiquetas, escape, seguimiento y pie legal', () => {
  const campaign = {
    id: 'c1',
    subject: 'Hola {{nombre|amigo}}',
    preheader: 'Novedades',
    html: '<html><body><p>Hola {{nombre}}</p><a href="https://example.com/a?x=1&amp;y=2">A</a><a href="mailto:x@y.z">M</a></body></html>',
  };
  campaign.links = extractLinks(campaign.html);
  assert.deepStrictEqual(campaign.links, ['https://example.com/a?x=1&y=2']);

  const out = renderEmail(campaign, { id: 'r1', email: 'e@x.com', firstName: '<b>Eva</b>' }, { settings, secret: 's' });
  assert.strictEqual(out.subject, 'Hola <b>Eva</b>');
  assert.ok(out.html.includes('Hola &lt;b&gt;Eva&lt;/b&gt;'), 'escapa el nombre en HTML');
  assert.ok(!out.html.includes('https://example.com/a'), 'reescribe el enlace');
  assert.match(out.html, /href="https:\/\/mail\.test\/t\/c\/[^"]+"/);
  assert.ok(out.html.includes('href="mailto:x@y.z"'), 'no toca mailto');
  assert.match(out.html, /<img src="https:\/\/mail\.test\/t\/o\//);
  assert.ok(out.html.includes('Calle Mayor 1, Madrid'), 'incluye direccion postal');
  assert.ok(out.html.includes(out.unsubscribeUrl));
  assert.match(out.html, /<body><div style="display:none[^>]*>Novedades/);

  const clickToken = out.html.match(/\/t\/c\/([^"]+)"/)[1];
  assert.deepStrictEqual(verify(clickToken, 's'), { k: 'c', c: 'c1', r: 'r1', l: 0 });
  assert.strictEqual(verify(out.unsubscribeUrl.split('/u/')[1], 's').k, 'u');
});

test('render: sin seguimiento no hay pixel ni enlaces reescritos', () => {
  const out = renderEmail({ id: 'c', subject: 's', html: '<a href="https://a.com">a</a> {{unsubscribe_url}}' },
    { id: 'r', email: 'x@y.z' }, { settings, secret: 's', track: false });
  assert.ok(out.html.includes('href="https://a.com"'));
  assert.ok(!out.html.includes('/t/o/'));
  assert.ok(!out.html.includes('Darse de baja'), 'no duplica pie si ya hay enlace de baja');
});

test('htmlToText convierte enlaces y bloques', () => {
  assert.strictEqual(htmlToText('<p>Hola</p><p><a href="https://a.com">web</a></p>'), 'Hola\nweb (https://a.com)');
});

test('mime: cabeceras codificadas y sin inyeccion CRLF', () => {
  const raw = buildMessage({
    fromName: 'José', fromEmail: 'yo@dominio.es', to: 'tu@x.com', subject: 'Año nuevo\r\nBcc: evil@x.com',
    html: '<p>ñ</p>', text: 'ñ', headers: { 'List-Unsubscribe': '<https://u>' },
  });
  const head = raw.split('\r\n\r\n')[0];
  assert.match(head, /^From: =\?UTF-8\?B\?[^?]+\?= <yo@dominio\.es>$/m);
  assert.ok(!/^Bcc:/m.test(head));
  assert.match(head, /^List-Unsubscribe: <https:\/\/u>$/m);
  assert.match(head, /^Message-ID: <[^@]+@dominio\.es>$/m);
});

test('smtp: dot-stuffing', () => {
  assert.strictEqual(dotStuff('a\n.b\n..c'), 'a\r\n..b\r\n...c');
});
