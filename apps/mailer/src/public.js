'use strict';

/**
 * Rutas publicas (sin login): pixel de apertura, redireccion de clics,
 * baja de suscripcion, formulario de alta y confirmacion (doble opt-in).
 */

const { sign, verify } = require('./tokens');
const { escapeHtml } = require('./render');
const { send, html } = require('./http');

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function page(title, body, { embeddable = false } = {}) {
  return {
    embeddable,
    body: `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;color:#111827}
.card{max-width:440px;margin:40px auto;background:#fff;border-radius:10px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h1{font-size:22px;margin:0 0 12px}label{display:block;font-size:14px;margin:12px 0 4px}
input[type=email],input[type=text]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:6px;font-size:15px}
.check{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#374151;margin-top:16px}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-size:15px;cursor:pointer}
.muted{color:#6b7280;font-size:13px}.hp{position:absolute;left:-9999px}</style></head>
<body><div class="card">${body}</div></body></html>`,
  };
}

function respond(res, status, p) {
  if (p.embeddable) {
    send(res, status, p.body, { 'Content-Type': 'text/html; charset=utf-8' });
  } else {
    html(res, status, p.body);
  }
}

function recordEvent(store, type, payload, req, extra = {}) {
  const contact = store.get('contacts', payload.r);
  const campaign = store.get('campaigns', payload.c);
  if (!contact || !campaign) return null;
  store.insert('events', {
    type,
    campaignId: campaign.id,
    contactId: contact.id,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
    ...extra,
  }, { lazy: true });
  return { contact, campaign };
}

function unsubscribe(store, contact, campaignId) {
  if (contact.status === 'unsubscribed') return;
  contact.status = 'unsubscribed';
  contact.unsubscribedAt = new Date().toISOString();
  store.insert('events', { type: 'unsubscribe', campaignId, contactId: contact.id });
}

function signupForm(list, settings, message = '') {
  const privacy = list.privacyText || `Acepto recibir comunicaciones comerciales de ${settings.orgName} por correo electrónico. Puedo darme de baja en cualquier momento.`;
  return page(`Suscribirse a ${list.name}`, `
<h1>${escapeHtml(list.name)}</h1>
${list.description ? `<p class="muted">${escapeHtml(list.description)}</p>` : ''}
${message ? `<p style="color:#dc2626">${escapeHtml(message)}</p>` : ''}
<form method="post">
  <label for="email">Email *</label><input id="email" type="email" name="email" required>
  <label for="firstName">Nombre</label><input id="firstName" type="text" name="firstName">
  <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
  <div class="check"><input id="consent" type="checkbox" name="consent" value="yes" required>
  <label for="consent" style="margin:0">${escapeHtml(privacy)}</label></div>
  <button type="submit">Suscribirme</button>
</form>`, { embeddable: true });
}

function registerPublicRoutes(router, { store, transport }) {
  router.get('/t/o/:token', (req, res, { params }) => {
    const payload = verify(params.token, store.secret);
    if (payload && payload.k === 'o') recordEvent(store, 'open', payload, req);
    send(res, 200, PIXEL, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' });
  });

  router.get('/t/c/:token', (req, res, { params }) => {
    const payload = verify(params.token, store.secret);
    const campaign = payload && payload.k === 'c' ? store.get('campaigns', payload.c) : null;
    const url = campaign && (campaign.links || [])[payload.l];
    if (!url) return respond(res, 404, page('Enlace no válido', '<h1>Enlace no válido</h1>'));
    recordEvent(store, 'click', payload, req, { linkIndex: payload.l });
    send(res, 302, '', { Location: url, 'Cache-Control': 'no-store' });
  });

  // GET muestra confirmacion (los escaneres de enlaces no deben dar de baja);
  // POST ejecuta la baja, tambien desde el boton "one-click" (RFC 8058).
  router.get('/u/:token', (req, res, { params }) => {
    const payload = verify(params.token, store.secret);
    const contact = payload && payload.k === 'u' ? store.get('contacts', payload.r) : null;
    if (!contact) return respond(res, 404, page('Enlace no válido', '<h1>Enlace no válido</h1>'));
    if (contact.status === 'unsubscribed') {
      return respond(res, 200, page('Baja confirmada', `<h1>Ya no recibirás más correos</h1><p class="muted">${escapeHtml(contact.email)} está dado de baja.</p>`));
    }
    respond(res, 200, page('Darse de baja', `
<h1>Darse de baja</h1>
<p>Vas a dejar de recibir correos de ${escapeHtml(store.settings.orgName)} en <strong>${escapeHtml(contact.email)}</strong>.</p>
<form method="post"><button type="submit">Confirmar baja</button></form>`));
  });

  router.post('/u/:token', (req, res, { params }) => {
    const payload = verify(params.token, store.secret);
    const contact = payload && payload.k === 'u' ? store.get('contacts', payload.r) : null;
    if (!contact) return respond(res, 404, page('Enlace no válido', '<h1>Enlace no válido</h1>'));
    unsubscribe(store, contact, payload.c);
    respond(res, 200, page('Baja confirmada', '<h1>Te has dado de baja</h1><p class="muted">No volverás a recibir correos de esta lista.</p>'));
  });

  router.get('/f/:listId', (req, res, { params }) => {
    const list = store.get('lists', params.listId);
    if (!list) return respond(res, 404, page('No encontrado', '<h1>Formulario no encontrado</h1>'));
    respond(res, 200, signupForm(list, store.settings));
  });

  router.post('/f/:listId', async (req, res, { params, body }) => {
    const list = store.get('lists', params.listId);
    if (!list) return respond(res, 404, page('No encontrado', '<h1>Formulario no encontrado</h1>'));
    const done = page('Gracias', '<h1>Revisa tu correo</h1><p class="muted">Si la dirección es válida recibirás un mensaje para confirmar tu suscripción.</p>', { embeddable: true });
    if (body.website) return respond(res, 200, done); // honeypot anti-bots

    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return respond(res, 400, signupForm(list, store.settings, 'Introduce un email válido.'));
    if (body.consent !== 'yes') return respond(res, 400, signupForm(list, store.settings, 'Debes aceptar recibir comunicaciones.'));

    const settings = store.settings;
    const consent = {
      source: 'formulario',
      ip: req.socket.remoteAddress,
      at: new Date().toISOString(),
      text: list.privacyText || 'consentimiento por formulario',
    };
    let contact = store.find('contacts', c => c.listId === list.id && c.email === email)[0];
    if (contact && contact.status === 'subscribed') return respond(res, 200, done);

    const status = settings.doubleOptIn ? 'pending' : 'subscribed';
    if (contact) {
      store.update('contacts', contact.id, { status, consent, firstName: body.firstName || contact.firstName });
    } else {
      contact = store.insert('contacts', {
        listId: list.id, email, firstName: String(body.firstName || '').trim(), lastName: '', tags: [], status, consent,
      });
    }

    if (settings.doubleOptIn) {
      const base = String(settings.baseUrl).replace(/\/+$/, '');
      const url = `${base}/confirm/${sign({ k: 'cf', r: contact.id }, store.secret)}`;
      try {
        await transport.send({
          to: email,
          subject: `Confirma tu suscripción a ${list.name}`,
          html: `<p>Hola,</p><p>Pulsa el siguiente enlace para confirmar tu suscripción a <strong>${escapeHtml(list.name)}</strong>:</p><p><a href="${url}">Confirmar suscripción</a></p><p>Si no lo has solicitado, ignora este mensaje.</p>`,
          text: `Confirma tu suscripción a ${list.name}: ${url}\n\nSi no lo has solicitado, ignora este mensaje.`,
        });
      } catch (err) {
        console.error('[signup] no se pudo enviar la confirmación:', err.message);
      }
      return respond(res, 200, done);
    }
    respond(res, 200, page('Gracias', '<h1>Suscripción completada</h1><p class="muted">Gracias por suscribirte.</p>', { embeddable: true }));
  });

  router.get('/confirm/:token', (req, res, { params }) => {
    const payload = verify(params.token, store.secret);
    const contact = payload && payload.k === 'cf' ? store.get('contacts', payload.r) : null;
    if (!contact) return respond(res, 404, page('Enlace no válido', '<h1>Enlace no válido</h1>'));
    if (contact.status === 'pending') {
      store.update('contacts', contact.id, {
        status: 'subscribed',
        consent: { ...contact.consent, confirmedAt: new Date().toISOString(), confirmIp: req.socket.remoteAddress },
      });
    }
    respond(res, 200, page('Suscripción confirmada', '<h1>Suscripción confirmada</h1><p class="muted">Gracias, ya formas parte de la lista.</p>'));
  });
}

module.exports = { registerPublicRoutes, EMAIL_RE };
