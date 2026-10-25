'use strict';

/** API JSON del panel de administracion (requiere sesion). */

const crypto = require('crypto');
const csv = require('./csv');
const { HttpError, json, send } = require('./http');
const { hashPassword, checkPassword } = require('./tokens');
const { renderEmail, extractLinks } = require('./render');
const { campaignStats, dashboard } = require('./stats');
const { audienceFor } = require('./sender');
const { TEMPLATES } = require('./templates');
const { EMAIL_RE } = require('./public');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const CONTACT_STATUSES = ['subscribed', 'pending', 'unsubscribed', 'bounced'];

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,|]/);
  return [...new Set(list.map(t => String(t).trim()).filter(Boolean))];
}

function requireFields(body, fields) {
  for (const field of fields) {
    if (!String(body[field] || '').trim()) throw new HttpError(400, `Falta el campo "${field}"`);
  }
}

function publicSettings(settings) {
  return { ...settings, smtp: { ...settings.smtp, pass: settings.smtp.pass ? '********' : '' } };
}

function registerApiRoutes(router, { store, transport }) {
  const sessions = new Map();
  const attempts = new Map();

  function isAuthed(req, cookies) {
    const expires = sessions.get(cookies.mm_session);
    return Boolean(expires && expires > Date.now());
  }

  function startSession(res) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    const secure = String(store.settings.baseUrl).startsWith('https://') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `mm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  }

  function throttle(req) {
    const ip = req.socket.remoteAddress;
    const entry = attempts.get(ip) || { count: 0, since: Date.now() };
    if (Date.now() - entry.since > 15 * 60 * 1000) { entry.count = 0; entry.since = Date.now(); }
    entry.count += 1;
    attempts.set(ip, entry);
    if (entry.count > 10) throw new HttpError(429, 'Demasiados intentos, espera 15 minutos');
  }

  // ---- Autenticacion -----------------------------------------------------
  router.get('/api/auth', (req, res, ctx) => {
    json(res, 200, { needsSetup: !store.data.auth.passwordHash, authed: isAuthed(req, ctx.cookies) });
  });

  router.post('/api/auth/setup', (req, res, { body }) => {
    if (store.data.auth.passwordHash) throw new HttpError(403, 'La contraseña ya está configurada');
    if (String(body.password || '').length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
    store.data.auth.passwordHash = hashPassword(body.password);
    store.save();
    startSession(res);
    json(res, 200, { ok: true });
  });

  router.post('/api/auth/login', (req, res, { body }) => {
    throttle(req);
    if (!checkPassword(body.password, store.data.auth.passwordHash)) throw new HttpError(401, 'Contraseña incorrecta');
    startSession(res);
    json(res, 200, { ok: true });
  });

  router.post('/api/auth/logout', (req, res, { cookies }) => {
    sessions.delete(cookies.mm_session);
    res.setHeader('Set-Cookie', 'mm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    json(res, 200, { ok: true });
  });

  // Todo lo que sigue exige sesion valida.
  const guard = handler => (req, res, ctx) => {
    if (!isAuthed(req, ctx.cookies)) throw new HttpError(401, 'Inicia sesión');
    return handler(req, res, ctx);
  };
  const r = {
    get: (p, h) => router.get(p, guard(h)),
    post: (p, h) => router.post(p, guard(h)),
    put: (p, h) => router.put(p, guard(h)),
    delete: (p, h) => router.delete(p, guard(h)),
  };

  const mustGet = (name, id) => {
    const item = store.get(name, id);
    if (!item) throw new HttpError(404, 'No encontrado');
    return item;
  };

  r.get('/api/dashboard', (req, res) => json(res, 200, dashboard(store)));

  // ---- Audiencias --------------------------------------------------------
  r.get('/api/lists', (req, res) => {
    json(res, 200, store.all('lists').map(list => {
      const contacts = store.find('contacts', c => c.listId === list.id);
      return { ...list, total: contacts.length, subscribed: contacts.filter(c => c.status === 'subscribed').length };
    }));
  });

  r.post('/api/lists', (req, res, { body }) => {
    requireFields(body, ['name']);
    json(res, 201, store.insert('lists', {
      name: String(body.name).trim(),
      description: String(body.description || ''),
      privacyText: String(body.privacyText || ''),
    }));
  });

  r.put('/api/lists/:id', (req, res, { params, body }) => {
    mustGet('lists', params.id);
    const patch = {};
    for (const key of ['name', 'description', 'privacyText']) if (body[key] !== undefined) patch[key] = String(body[key]);
    json(res, 200, store.update('lists', params.id, patch));
  });

  r.delete('/api/lists/:id', (req, res, { params }) => {
    mustGet('lists', params.id);
    store.remove('contacts', c => c.listId === params.id);
    store.remove('lists', l => l.id === params.id);
    json(res, 200, { ok: true });
  });

  r.get('/api/lists/:id/contacts', (req, res, { params, query }) => {
    mustGet('lists', params.id);
    const q = String(query.get('q') || '').toLowerCase();
    const status = query.get('status');
    const tag = String(query.get('tag') || '').toLowerCase();
    const contacts = store.find('contacts', c =>
      c.listId === params.id &&
      (!status || c.status === status) &&
      (!tag || (c.tags || []).some(t => t.toLowerCase() === tag)) &&
      (!q || `${c.email} ${c.firstName} ${c.lastName}`.toLowerCase().includes(q)));
    const tags = [...new Set(store.find('contacts', c => c.listId === params.id).flatMap(c => c.tags || []))].sort();
    json(res, 200, { contacts: contacts.slice(-1000).reverse(), total: contacts.length, tags });
  });

  r.post('/api/lists/:id/contacts', (req, res, { params, body }) => {
    mustGet('lists', params.id);
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email no válido');
    if (store.find('contacts', c => c.listId === params.id && c.email === email).length) {
      throw new HttpError(409, 'Ese email ya está en la lista');
    }
    const status = CONTACT_STATUSES.includes(body.status) ? body.status : 'subscribed';
    json(res, 201, store.insert('contacts', {
      listId: params.id,
      email,
      firstName: String(body.firstName || '').trim(),
      lastName: String(body.lastName || '').trim(),
      tags: normalizeTags(body.tags),
      status,
      consent: { source: String(body.consentSource || 'alta manual'), at: new Date().toISOString() },
    }));
  });

  r.post('/api/lists/:id/import', (req, res, { params, body }) => {
    mustGet('lists', params.id);
    const rows = csv.parse(String(body.csv || ''));
    const extraTags = normalizeTags(body.tags);
    const source = String(body.consentSource || 'importación CSV');
    const existing = new Map(store.find('contacts', c => c.listId === params.id).map(c => [c.email, c]));
    const result = { added: 0, updated: 0, skipped: 0, errors: [] };
    const now = new Date().toISOString();

    rows.forEach((row, idx) => {
      const data = csv.toContact(row);
      const email = data.email.toLowerCase();
      if (!EMAIL_RE.test(email)) {
        result.skipped += 1;
        if (result.errors.length < 20) result.errors.push(`Fila ${idx + 2}: email no válido "${data.email}"`);
        return;
      }
      const tags = normalizeTags([...normalizeTags(data.tags), ...extraTags]);
      const current = existing.get(email);
      if (current) {
        // Nunca reactivar a quien se dio de baja o reboto.
        current.firstName = data.firstName || current.firstName;
        current.lastName = data.lastName || current.lastName;
        current.tags = normalizeTags([...(current.tags || []), ...tags]);
        result.updated += 1;
        return;
      }
      const contact = {
        id: crypto.randomUUID(), createdAt: now, listId: params.id, email,
        firstName: data.firstName, lastName: data.lastName, tags,
        status: 'subscribed', consent: { source, at: now },
      };
      store.data.contacts.push(contact);
      existing.set(email, contact);
      result.added += 1;
    });
    store.save();
    json(res, 200, result);
  });

  r.get('/api/lists/:id/export', (req, res, { params }) => {
    const list = mustGet('lists', params.id);
    const rows = store.find('contacts', c => c.listId === params.id).map(c => ({
      email: c.email, nombre: c.firstName, apellidos: c.lastName, etiquetas: (c.tags || []).join('|'),
      estado: c.status, alta: c.createdAt, origen_consentimiento: c.consent ? c.consent.source : '',
      fecha_consentimiento: c.consent ? (c.consent.confirmedAt || c.consent.at) : '',
    }));
    const headers = ['email', 'nombre', 'apellidos', 'etiquetas', 'estado', 'alta', 'origen_consentimiento', 'fecha_consentimiento'];
    const filename = `${list.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'lista'}.csv`;
    send(res, 200, `\uFEFF${csv.stringify(headers, rows)}`, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  });

  r.put('/api/contacts/:id', (req, res, { params, body }) => {
    mustGet('contacts', params.id);
    const patch = {};
    for (const key of ['firstName', 'lastName']) if (body[key] !== undefined) patch[key] = String(body[key]).trim();
    if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
    if (body.status !== undefined) {
      if (!CONTACT_STATUSES.includes(body.status)) throw new HttpError(400, 'Estado no válido');
      patch.status = body.status;
    }
    json(res, 200, store.update('contacts', params.id, patch));
  });

  // Supresion total del contacto (derecho de supresion, art. 17 RGPD).
  r.delete('/api/contacts/:id', (req, res, { params }) => {
    mustGet('contacts', params.id);
    store.remove('events', e => e.contactId === params.id);
    store.remove('sends', s => s.contactId === params.id);
    store.remove('contacts', c => c.id === params.id);
    json(res, 200, { ok: true });
  });

  // ---- Campanas ----------------------------------------------------------
  const withStats = c => ({ ...c, stats: campaignStats(store, c) });

  r.get('/api/campaigns', (req, res) => {
    const items = store.all('campaigns').map(c => {
      const { html: _html, ...rest } = withStats(c);
      return rest;
    });
    json(res, 200, items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  });

  const CAMPAIGN_FIELDS = ['name', 'subject', 'preheader', 'fromName', 'fromEmail', 'replyTo', 'listId', 'html'];
  const pickCampaign = body => {
    const out = {};
    for (const key of CAMPAIGN_FIELDS) if (body[key] !== undefined) out[key] = String(body[key]);
    if (body.tags !== undefined) out.tags = normalizeTags(body.tags);
    return out;
  };

  r.post('/api/campaigns', (req, res, { body }) => {
    const template = TEMPLATES.find(t => t.id === body.templateId) || TEMPLATES[0];
    json(res, 201, store.insert('campaigns', {
      name: 'Nueva campaña', subject: '', preheader: '', fromName: '', fromEmail: '', replyTo: '',
      listId: (store.all('lists')[0] || {}).id || '', tags: [], html: template.html,
      ...pickCampaign(body), status: 'draft',
    }));
  });

  r.get('/api/campaigns/:id', (req, res, { params }) => json(res, 200, withStats(mustGet('campaigns', params.id))));

  r.put('/api/campaigns/:id', (req, res, { params, body }) => {
    const campaign = mustGet('campaigns', params.id);
    if (campaign.status !== 'draft') throw new HttpError(409, 'Solo se pueden editar borradores');
    json(res, 200, store.update('campaigns', params.id, pickCampaign(body)));
  });

  r.delete('/api/campaigns/:id', (req, res, { params }) => {
    const campaign = mustGet('campaigns', params.id);
    if (campaign.status === 'sending') throw new HttpError(409, 'No se puede borrar una campaña en envío');
    store.remove('sends', s => s.campaignId === params.id);
    store.remove('events', e => e.campaignId === params.id);
    store.remove('campaigns', c => c.id === params.id);
    json(res, 200, { ok: true });
  });

  r.post('/api/campaigns/:id/duplicate', (req, res, { params }) => {
    const c = mustGet('campaigns', params.id);
    const copy = pickCampaign(c);
    copy.tags = c.tags || [];
    json(res, 201, store.insert('campaigns', { ...copy, name: `${c.name} (copia)`, status: 'draft' }));
  });

  const sampleContact = { id: 'preview', email: 'ejemplo@correo.com', firstName: 'Lucía', lastName: 'García' };

  r.post('/api/campaigns/:id/preview', (req, res, { params, body }) => {
    const campaign = { ...mustGet('campaigns', params.id), ...pickCampaign(body) };
    campaign.links = extractLinks(campaign.html);
    const out = renderEmail(campaign, sampleContact, { settings: store.settings, secret: store.secret, track: false });
    json(res, 200, { subject: out.subject, html: out.html, text: out.text, links: campaign.links });
  });

  r.get('/api/campaigns/:id/audience', (req, res, { params, query }) => {
    const campaign = { ...mustGet('campaigns', params.id) };
    if (query.get('listId')) campaign.listId = query.get('listId');
    if (query.has('tags')) campaign.tags = normalizeTags(query.get('tags'));
    json(res, 200, { count: audienceFor(store, campaign).length });
  });

  r.post('/api/campaigns/:id/test', async (req, res, { params, body }) => {
    const campaign = { ...mustGet('campaigns', params.id) };
    const to = String(body.email || '').trim();
    if (!EMAIL_RE.test(to)) throw new HttpError(400, 'Email de prueba no válido');
    campaign.links = extractLinks(campaign.html);
    const out = renderEmail(campaign, { ...sampleContact, email: to }, { settings: store.settings, secret: store.secret, track: false });
    try {
      const result = await transport.send({
        fromName: campaign.fromName, fromEmail: campaign.fromEmail, replyTo: campaign.replyTo,
        to, subject: `[PRUEBA] ${out.subject}`, html: out.html, text: out.text,
      });
      json(res, 200, { ok: true, via: transport.describe(), ...result });
    } catch (err) {
      throw new HttpError(502, `No se pudo enviar: ${err.message}`);
    }
  });

  r.post('/api/campaigns/:id/send', (req, res, { params, body }) => {
    const campaign = mustGet('campaigns', params.id);
    if (campaign.status !== 'draft') throw new HttpError(409, 'La campaña ya se envió o está programada');
    requireFields(campaign, ['subject', 'listId', 'html']);
    if (!store.get('lists', campaign.listId)) throw new HttpError(400, 'La audiencia no existe');
    if (!(campaign.fromEmail || store.settings.fromEmail)) throw new HttpError(400, 'Falta el email remitente (campaña o Ajustes)');
    if (!store.settings.postalAddress) throw new HttpError(400, 'Indica la dirección postal del remitente en Ajustes (obligatoria en el pie)');
    if (audienceFor(store, campaign).length === 0) throw new HttpError(400, 'No hay contactos suscritos que cumplan el filtro');

    let scheduledAt = new Date().toISOString();
    if (body.scheduledAt) {
      const when = new Date(body.scheduledAt);
      if (Number.isNaN(when.getTime())) throw new HttpError(400, 'Fecha no válida');
      scheduledAt = when.toISOString();
    }
    json(res, 200, store.update('campaigns', params.id, { status: 'scheduled', scheduledAt }));
  });

  r.post('/api/campaigns/:id/cancel', (req, res, { params }) => {
    const campaign = mustGet('campaigns', params.id);
    if (campaign.status === 'scheduled') {
      return json(res, 200, store.update('campaigns', params.id, { status: 'draft', scheduledAt: null }));
    }
    if (campaign.status === 'sending') {
      for (const s of store.find('sends', x => x.campaignId === campaign.id && x.status === 'queued')) s.status = 'cancelled';
      return json(res, 200, store.update('campaigns', params.id, { status: 'sent', sentAt: new Date().toISOString(), cancelled: true }));
    }
    throw new HttpError(409, 'No hay nada que cancelar');
  });

  r.get('/api/campaigns/:id/activity', (req, res, { params }) => {
    mustGet('campaigns', params.id);
    const contacts = new Map(store.all('contacts').map(c => [c.id, c]));
    const events = store.find('events', e => e.campaignId === params.id)
      .slice(-200).reverse()
      .map(e => ({ type: e.type, at: e.createdAt, email: (contacts.get(e.contactId) || {}).email, linkIndex: e.linkIndex }));
    const failures = store.find('sends', s => s.campaignId === params.id && s.status === 'failed')
      .slice(0, 100).map(s => ({ email: s.email, error: s.error }));
    json(res, 200, { events, failures });
  });

  r.get('/api/templates', (req, res) => json(res, 200, TEMPLATES));

  // ---- Ajustes -----------------------------------------------------------
  r.get('/api/settings', (req, res) => json(res, 200, { ...publicSettings(store.settings), transport: transport.describe() }));

  r.put('/api/settings', (req, res, { body }) => {
    const s = store.settings;
    for (const key of ['orgName', 'fromName', 'fromEmail', 'replyTo', 'postalAddress', 'baseUrl']) {
      if (body[key] !== undefined) s[key] = String(body[key]).trim();
    }
    if (body.ratePerMinute !== undefined) s.ratePerMinute = Math.min(6000, Math.max(1, Number(body.ratePerMinute) || 60));
    if (body.doubleOptIn !== undefined) s.doubleOptIn = Boolean(body.doubleOptIn);
    if (body.smtp) {
      s.smtp.host = String(body.smtp.host || '').trim();
      s.smtp.port = Number(body.smtp.port) || 587;
      s.smtp.secure = Boolean(body.smtp.secure);
      s.smtp.user = String(body.smtp.user || '').trim();
      if (body.smtp.pass && body.smtp.pass !== '********') s.smtp.pass = String(body.smtp.pass);
      if (body.smtp.pass === '') s.smtp.pass = '';
    }
    store.save();
    json(res, 200, { ...publicSettings(s), transport: transport.describe() });
  });

  r.post('/api/settings/test', async (req, res, { body }) => {
    const to = String(body.email || '').trim();
    if (!EMAIL_RE.test(to)) throw new HttpError(400, 'Email no válido');
    try {
      const result = await transport.send({
        to, subject: 'Prueba de configuración', html: '<p>La configuración de envío funciona correctamente.</p>',
        text: 'La configuración de envío funciona correctamente.',
      });
      json(res, 200, { ok: true, via: transport.describe(), ...result });
    } catch (err) {
      throw new HttpError(502, `No se pudo enviar: ${err.message}`);
    }
  });
}

module.exports = { registerApiRoutes, normalizeTags };
