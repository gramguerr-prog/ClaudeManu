'use strict';

/* Panel de ManuMail: SPA sin dependencias con rutas por hash. */

const root = document.getElementById('app');

// ---- Utilidades ------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) { render(); throw new Error('Sesion caducada'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = isError ? 'error' : '';
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, isError ? 6000 : 3000);
}

/** Ejecuta una accion mostrando el error si falla. */
async function attempt(fn, okMessage) {
  try {
    const out = await fn();
    if (okMessage) toast(okMessage);
    return out;
  } catch (err) {
    toast(err.message, true);
    return undefined;
  }
}

const fmtDate = iso => (iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
const fmtNum = n => Number(n || 0).toLocaleString('es-ES');
const fmtPct = n => `${Number(n || 0).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;

const CONTACT_STATUS = {
  subscribed: ['Suscrito', 'ok'], pending: ['Pendiente', 'warn'],
  unsubscribed: ['Baja', 'bad'], bounced: ['Rebotado', 'bad'],
};
const CAMPAIGN_STATUS = {
  draft: ['Borrador', ''], scheduled: ['Programada', 'warn'], sending: ['Enviando', 'warn'], sent: ['Enviada', 'ok'],
};
const badge = (map, key) => h('span', { class: `badge ${(map[key] || ['', ''])[1]}` }, (map[key] || [key])[0]);

function field(labelText, input) {
  return h('div', null, h('label', null, labelText), input);
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
}

function downloadable(href, text) {
  return h('a', { class: 'btn', href, download: '' }, text);
}

// ---- Autenticacion ---------------------------------------------------------

function authView(needsSetup) {
  const pass = h('input', { type: 'password', autocomplete: needsSetup ? 'new-password' : 'current-password', minLength: 8, required: true });
  const form = h('form', {
    class: 'card',
    onsubmit: async e => {
      e.preventDefault();
      const path = needsSetup ? '/api/auth/setup' : '/api/auth/login';
      if (await attempt(() => api(path, { method: 'POST', body: { password: pass.value } }))) render();
    },
  },
  h('h1', null, 'ManuMail'),
  h('p', { class: 'muted' }, needsSetup ? 'Primera vez: crea la contraseña de administrador (mínimo 8 caracteres).' : 'Introduce tu contraseña.'),
  field('Contraseña', pass),
  h('div', { style: 'margin-top:16px' }, h('button', { class: 'primary', type: 'submit' }, needsSetup ? 'Crear y entrar' : 'Entrar')));
  return h('div', { class: 'auth' }, form);
}

// ---- Layout ----------------------------------------------------------------

const NAV = [['#/', 'Panel'], ['#/audiencias', 'Audiencias'], ['#/campanas', 'Campañas'], ['#/ajustes', 'Ajustes']];

function layout(content) {
  const current = location.hash || '#/';
  const active = href => (href === '#/' ? current === '#/' : current.startsWith(href));
  return h('div', { class: 'layout' },
    h('nav', { class: 'side' },
      h('div', { class: 'logo' }, 'ManuMail'),
      NAV.map(([href, text]) => h('a', { href, class: active(href) ? 'active' : '' }, text)),
      h('div', { class: 'spacer' }),
      h('a', { href: '#/', onclick: async e => { e.preventDefault(); await api('/api/auth/logout', { method: 'POST' }); render(); } }, 'Cerrar sesión')),
    h('main', null, content));
}

// ---- Panel -----------------------------------------------------------------

async function dashboardView() {
  const [d, settings] = await Promise.all([api('/api/dashboard'), api('/api/settings')]);
  const warnings = [];
  if (!settings.fromEmail) warnings.push('Falta el email remitente.');
  if (!settings.postalAddress) warnings.push('Falta la dirección postal (obligatoria en el pie de cada correo).');
  if (!settings.smtp.host) warnings.push('Sin SMTP configurado: los correos se guardan como ficheros .eml en vez de enviarse.');

  return h('div', null,
    h('div', { class: 'head' }, h('h1', null, 'Panel'), h('a', { class: 'btn', href: '#/campanas/nueva' }, 'Crear campaña')),
    warnings.length ? h('div', { class: 'notice' }, h('strong', null, 'Completa los ajustes: '), warnings.join(' '), ' ', h('a', { href: '#/ajustes' }, 'Ir a Ajustes')) : null,
    h('div', { class: 'grid' },
      stat('Suscriptores', fmtNum(d.subscribed)),
      stat('Nuevos (30 días)', fmtNum(d.newSubscribers)),
      stat('Pendientes de confirmar', fmtNum(d.pending)),
      stat('Bajas', fmtNum(d.unsubscribed)),
      stat('Apertura media', fmtPct(d.avgOpenRate)),
      stat('Clics medios', fmtPct(d.avgClickRate))),
    h('div', { class: 'card' },
      h('h2', null, 'Últimas campañas enviadas'),
      d.recent.length === 0
        ? h('div', { class: 'empty' }, 'Aún no has enviado ninguna campaña.')
        : campaignTable(d.recent)));
}

function campaignTable(campaigns, lists = null) {
  const listName = id => (lists.find(l => l.id === id) || {}).name || '';
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null,
      h('th', null, 'Campaña'), h('th', null, 'Estado'), lists ? h('th', null, 'Audiencia') : null,
      h('th', null, 'Fecha'), h('th', { class: 'num' }, 'Enviados'), h('th', { class: 'num' }, 'Apertura'), h('th', { class: 'num' }, 'Clics'))),
    h('tbody', null, campaigns.map(c => h('tr', { class: 'click', onclick: () => { location.hash = `#/campanas/${c.id}`; } },
      h('td', null, c.name), h('td', null, badge(CAMPAIGN_STATUS, c.status)),
      lists ? h('td', null, listName(c.listId)) : null,
      h('td', null, fmtDate(c.sentAt || c.startedAt || c.scheduledAt || c.createdAt)),
      h('td', { class: 'num' }, fmtNum(c.stats.sent)),
      h('td', { class: 'num' }, c.status === 'draft' ? '-' : fmtPct(c.stats.openRate)),
      h('td', { class: 'num' }, c.status === 'draft' ? '-' : fmtPct(c.stats.clickRate)))))));
}

// ---- Audiencias ------------------------------------------------------------

async function listsView() {
  const lists = await api('/api/lists');
  const name = h('input', { placeholder: 'Ej.: Clientes del despacho', required: true });
  const description = h('input', { placeholder: 'Opcional' });
  return h('div', null,
    h('div', { class: 'head' }, h('h1', null, 'Audiencias')),
    h('div', { class: 'card' },
      lists.length === 0 ? h('div', { class: 'empty' }, 'Crea tu primera audiencia para empezar a añadir contactos.') :
        h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Nombre'), h('th', { class: 'num' }, 'Suscritos'), h('th', { class: 'num' }, 'Total'), h('th', null, 'Creada'))),
          h('tbody', null, lists.map(l => h('tr', { class: 'click', onclick: () => { location.hash = `#/audiencias/${l.id}`; } },
            h('td', null, l.name, l.description ? h('div', { class: 'muted' }, l.description) : null),
            h('td', { class: 'num' }, fmtNum(l.subscribed)), h('td', { class: 'num' }, fmtNum(l.total)), h('td', null, fmtDate(l.createdAt))))))),
    h('form', {
      class: 'card',
      onsubmit: async e => {
        e.preventDefault();
        const list = await attempt(() => api('/api/lists', { method: 'POST', body: { name: name.value, description: description.value } }), 'Audiencia creada');
        if (list) location.hash = `#/audiencias/${list.id}`;
      },
    }, h('h2', null, 'Nueva audiencia'), h('div', { class: 'form2' }, field('Nombre', name), field('Descripción', description)),
    h('div', { style: 'margin-top:12px' }, h('button', { class: 'primary', type: 'submit' }, 'Crear audiencia'))));
}

async function listDetailView(id) {
  const [lists, settings] = await Promise.all([api('/api/lists'), api('/api/settings')]);
  const list = lists.find(l => l.id === id);
  if (!list) return h('div', { class: 'empty' }, 'Audiencia no encontrada.');

  const formUrl = `${settings.baseUrl.replace(/\/+$/, '')}/f/${list.id}`;
  const tableBox = h('div');
  const q = h('input', { placeholder: 'Buscar email o nombre', oninput: () => loadContacts() });
  const statusFilter = h('select', { onchange: () => loadContacts() },
    h('option', { value: '' }, 'Todos los estados'),
    Object.entries(CONTACT_STATUS).map(([key, [label]]) => h('option', { value: key }, label)));
  const tagFilter = h('select', { onchange: () => loadContacts() }, h('option', { value: '' }, 'Todas las etiquetas'));

  async function loadContacts() {
    const params = new URLSearchParams({ q: q.value, status: statusFilter.value, tag: tagFilter.value });
    const data = await api(`/api/lists/${id}/contacts?${params}`);
    const selectedTag = tagFilter.value;
    tagFilter.replaceChildren(h('option', { value: '' }, 'Todas las etiquetas'), data.tags.map(t => h('option', { value: t, selected: t === selectedTag }, t)));
    tableBox.replaceChildren(data.contacts.length === 0
      ? h('div', { class: 'empty' }, 'No hay contactos con estos filtros.')
      : h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Email'), h('th', null, 'Nombre'), h('th', null, 'Etiquetas'), h('th', null, 'Estado'), h('th', null, 'Consentimiento'), h('th', null, ''))),
        h('tbody', null, data.contacts.map(contactRow)))),
      h('p', { class: 'muted' }, `${fmtNum(data.total)} contactos${data.total > data.contacts.length ? ` (mostrando ${data.contacts.length})` : ''}`));
  }

  function contactRow(c) {
    const status = h('select', {
      onchange: () => attempt(() => api(`/api/contacts/${c.id}`, { method: 'PUT', body: { status: status.value } }), 'Estado actualizado'),
    }, Object.entries(CONTACT_STATUS).map(([key, [label]]) => h('option', { value: key, selected: key === c.status }, label)));
    const consent = c.consent ? `${c.consent.source} - ${fmtDate(c.consent.confirmedAt || c.consent.at)}` : '-';
    return h('tr', null,
      h('td', null, c.email), h('td', null, `${c.firstName || ''} ${c.lastName || ''}`.trim()),
      h('td', null, (c.tags || []).map(t => h('span', { class: 'tag' }, t))),
      h('td', null, status),
      h('td', { class: 'muted' }, consent),
      h('td', null, h('div', { class: 'row' },
        h('button', {
          onclick: async () => {
            const tags = prompt('Etiquetas separadas por comas', (c.tags || []).join(', '));
            if (tags !== null && await attempt(() => api(`/api/contacts/${c.id}`, { method: 'PUT', body: { tags } }), 'Etiquetas guardadas')) loadContacts();
          },
        }, 'Etiquetas'),
        h('button', {
          class: 'danger',
          title: 'Borra el contacto y todo su historial (derecho de supresión)',
          onclick: async () => {
            if (confirm(`Suprimir definitivamente ${c.email} y todo su historial?`) &&
              await attempt(() => api(`/api/contacts/${c.id}`, { method: 'DELETE' }), 'Contacto suprimido')) loadContacts();
          },
        }, 'Suprimir'))));
  }

  // Alta manual
  const email = h('input', { type: 'email', required: true });
  const firstName = h('input');
  const lastName = h('input');
  const tags = h('input', { placeholder: 'cliente, vip' });
  const source = h('input', { value: 'alta manual', placeholder: 'Ej.: firmo hoja de consentimiento en despacho' });
  const addForm = h('form', {
    class: 'card',
    onsubmit: async e => {
      e.preventDefault();
      const ok = await attempt(() => api(`/api/lists/${id}/contacts`, { method: 'POST', body: { email: email.value, firstName: firstName.value, lastName: lastName.value, tags: tags.value, consentSource: source.value } }), 'Contacto añadido');
      if (ok) { e.target.reset(); source.value = 'alta manual'; loadContacts(); }
    },
  }, h('h2', null, 'Añadir contacto'),
  h('div', { class: 'form2' }, field('Email *', email), field('Etiquetas', tags), field('Nombre', firstName), field('Apellidos', lastName)),
  field('Origen del consentimiento', source),
  h('div', { style: 'margin-top:12px' }, h('button', { class: 'primary', type: 'submit' }, 'Añadir')));

  // Importacion CSV
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const importTags = h('input', { placeholder: 'Etiqueta para todos los importados (opcional)' });
  const importSource = h('input', { placeholder: 'Ej.: clientes con consentimiento firmado 2025', required: true });
  const consentCheck = h('input', { type: 'checkbox', required: true });
  const importForm = h('form', {
    class: 'card',
    onsubmit: async e => {
      e.preventDefault();
      if (!file.files[0]) return toast('Elige un fichero CSV', true);
      const text = await file.files[0].text();
      const r = await attempt(() => api(`/api/lists/${id}/import`, { method: 'POST', body: { csv: text, tags: importTags.value, consentSource: importSource.value } }));
      if (r) {
        toast(`Importados: ${r.added} nuevos, ${r.updated} actualizados, ${r.skipped} omitidos`);
        if (r.errors.length) alert(r.errors.join('\n'));
        e.target.reset();
        loadContacts();
      }
    },
  }, h('h2', null, 'Importar CSV'),
  h('p', { class: 'muted' }, 'Columnas reconocidas: email/correo, nombre, apellidos, etiquetas (separadas por |). Separador coma o punto y coma. Los contactos dados de baja no se reactivan.'),
  h('div', { class: 'form2' }, field('Fichero', file), field('Etiqueta', importTags)),
  field('Origen del consentimiento *', importSource),
  h('label', { class: 'inline', style: 'margin-top:12px' }, consentCheck, 'Confirmo que estos contactos han dado su consentimiento para recibir comunicaciones comerciales.'),
  h('div', { style: 'margin-top:12px' }, h('button', { class: 'primary', type: 'submit' }, 'Importar')));

  // Formulario publico y ajustes de la lista
  const privacy = h('textarea', { rows: 3, value: list.privacyText || '', placeholder: 'Texto de consentimiento que vera el suscriptor junto a la casilla' });
  const embed = `<iframe src="${formUrl}" width="100%" height="460" style="border:0"></iframe>`;
  const formCard = h('div', { class: 'card' },
    h('h2', null, 'Formulario de suscripción'),
    h('p', null, 'Enlace público: ', h('a', { href: formUrl, target: '_blank', rel: 'noopener' }, formUrl)),
    field('Código para incrustar en tu web', h('textarea', { rows: 2, readOnly: true, value: embed })),
    field('Texto de consentimiento (cláusula informativa)', privacy),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { onclick: () => attempt(() => api(`/api/lists/${id}`, { method: 'PUT', body: { privacyText: privacy.value } }), 'Guardado') }, 'Guardar texto'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (confirm(`Eliminar la audiencia "${list.name}" y todos sus contactos?`) &&
            await attempt(() => api(`/api/lists/${id}`, { method: 'DELETE' }), 'Audiencia eliminada')) location.hash = '#/audiencias';
        },
      }, 'Eliminar audiencia')));

  loadContacts();
  return h('div', null,
    h('div', { class: 'head' },
      h('div', null, h('a', { href: '#/audiencias' }, 'Audiencias'), h('h1', null, list.name)),
      h('div', { class: 'row' }, downloadable(`/api/lists/${id}/export`, 'Exportar CSV'))),
    h('div', { class: 'grid' }, stat('Suscritos', fmtNum(list.subscribed)), stat('Total', fmtNum(list.total))),
    h('div', { class: 'card' }, h('div', { class: 'row', style: 'margin-bottom:12px' }, q, statusFilter, tagFilter), tableBox),
    addForm, importForm, formCard);
}

// ---- Campanas --------------------------------------------------------------

async function campaignsView() {
  const [campaigns, lists] = await Promise.all([api('/api/campaigns'), api('/api/lists')]);
  return h('div', null,
    h('div', { class: 'head' }, h('h1', null, 'Campañas'), h('a', { class: 'btn', href: '#/campanas/nueva' }, 'Crear campaña')),
    h('div', { class: 'card' }, campaigns.length === 0 ? h('div', { class: 'empty' }, 'Todavía no hay campañas.') : campaignTable(campaigns, lists)));
}

async function newCampaignView() {
  const templates = await api('/api/templates');
  const create = async templateId => {
    const c = await attempt(() => api('/api/campaigns', { method: 'POST', body: { templateId } }));
    if (c) location.hash = `#/campanas/${c.id}`;
  };
  return h('div', null,
    h('div', { class: 'head' }, h('h1', null, 'Elige una plantilla')),
    h('div', { class: 'grid' }, templates.map(t => h('div', { class: 'card' },
      h('h2', null, t.name), h('p', { class: 'muted' }, t.description),
      h('button', { class: 'primary', onclick: () => create(t.id) }, 'Usar plantilla')))));
}

const SNIPPETS = [
  ['Nombre', '{{nombre}}'],
  ['Botón', '<a href="https://example.com" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px">Texto del botón</a>'],
  ['Imagen', '<img src="https://example.com/imagen.jpg" alt="Descripción" width="600" style="max-width:100%;height:auto;display:block">'],
  ['Separador', '<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">'],
  ['Párrafo', '<p style="margin:0 0 16px;font-size:16px;line-height:24px">Texto</p>'],
  ['Enlace de baja', '<a href="{{unsubscribe_url}}">Darse de baja</a>'],
];

async function campaignView(id) {
  const [campaign, lists, settings] = await Promise.all([api(`/api/campaigns/${id}`), api('/api/lists'), api('/api/settings')]);
  return campaign.status === 'draft' ? editorView(campaign, lists, settings) : reportView(campaign, lists);
}

function editorView(c, lists, settings) {
  const inputs = {
    name: h('input', { value: c.name }),
    listId: h('select', null, lists.length === 0 ? h('option', { value: '' }, 'Crea antes una audiencia') :
      lists.map(l => h('option', { value: l.id, selected: l.id === c.listId }, `${l.name} (${l.subscribed})`))),
    tags: h('input', { value: (c.tags || []).join(', '), placeholder: 'Vacío = toda la audiencia' }),
    subject: h('input', { value: c.subject, placeholder: 'Ej.: {{nombre}}, novedades de octubre' }),
    preheader: h('input', { value: c.preheader || '', placeholder: 'Texto que se ve junto al asunto en la bandeja' }),
    fromName: h('input', { value: c.fromName, placeholder: settings.fromName }),
    fromEmail: h('input', { type: 'email', value: c.fromEmail, placeholder: settings.fromEmail || 'tu@dominio.com' }),
    replyTo: h('input', { type: 'email', value: c.replyTo, placeholder: settings.replyTo || 'Opcional' }),
    html: h('textarea', { rows: 22, value: c.html, spellcheck: 'false' }),
  };
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
  const audience = h('span', { class: 'muted' });
  const frame = h('iframe', { sandbox: '', title: 'Vista previa' });
  const subjectBar = h('span');
  const previewBox = h('div', { class: 'preview' },
    h('div', { class: 'bar' }, subjectBar, h('span', { class: 'row' },
      h('button', { onclick: () => previewBox.classList.remove('mobile') }, 'Escritorio'),
      h('button', { onclick: () => previewBox.classList.add('mobile') }, 'Móvil'))),
    frame);

  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const v = values();
      const [p, a] = await Promise.all([
        api(`/api/campaigns/${c.id}/preview`, { method: 'POST', body: v }).catch(() => null),
        api(`/api/campaigns/${c.id}/audience?${new URLSearchParams({ listId: v.listId, tags: v.tags })}`).catch(() => null),
      ]);
      if (p) { frame.srcdoc = p.html; subjectBar.textContent = `Asunto: ${p.subject || '(sin asunto)'}`; }
      if (a) audience.textContent = `Destinatarios: ${fmtNum(a.count)} contactos suscritos`;
    }, 350);
  };
  Object.values(inputs).forEach(el => el.addEventListener('input', refresh));
  inputs.listId.addEventListener('change', refresh);
  refresh();

  const save = (msg = 'Guardado') => attempt(() => api(`/api/campaigns/${c.id}`, { method: 'PUT', body: values() }), msg);

  const insert = snippet => {
    const el = inputs.html;
    const start = el.selectionStart;
    el.setRangeText(snippet, start, el.selectionEnd, 'end');
    el.focus();
    refresh();
  };

  const testEmail = h('input', { type: 'email', placeholder: 'tu@correo.com' });
  const when = h('input', { type: 'datetime-local' });

  const sendCampaign = async scheduled => {
    if (scheduled && !when.value) return toast('Elige fecha y hora', true);
    if (!(await save(null))) return;
    const msg = scheduled ? `Programar el envío para ${new Date(when.value).toLocaleString('es-ES')}?` : `Enviar ahora a ${audience.textContent.replace('Destinatarios: ', '')}?`;
    if (!confirm(msg)) return;
    const body = scheduled ? { scheduledAt: new Date(when.value).toISOString() } : {};
    if (await attempt(() => api(`/api/campaigns/${c.id}/send`, { method: 'POST', body }), scheduled ? 'Campaña programada' : 'Envío iniciado')) render();
  };

  return h('div', null,
    h('div', { class: 'head' },
      h('div', null, h('a', { href: '#/campanas' }, 'Campañas'), h('h1', null, c.name, ' ', badge(CAMPAIGN_STATUS, c.status))),
      h('div', { class: 'row' },
        h('button', { onclick: () => save() }, 'Guardar'),
        h('button', {
          class: 'danger',
          onclick: async () => {
            if (confirm('Eliminar este borrador?') && await attempt(() => api(`/api/campaigns/${c.id}`, { method: 'DELETE' }), 'Eliminada')) location.hash = '#/campanas';
          },
        }, 'Eliminar'))),
    h('div', { class: 'editor' },
      h('div', null,
        h('div', { class: 'card' },
          h('h2', null, 'Destinatarios'),
          field('Nombre interno', inputs.name),
          field('Audiencia', inputs.listId),
          field('Solo contactos con alguna de estas etiquetas', inputs.tags),
          h('p', null, audience)),
        h('div', { class: 'card' },
          h('h2', null, 'Remitente y asunto'),
          field('Asunto', inputs.subject),
          field('Texto de vista previa', inputs.preheader),
          h('div', { class: 'form2' }, field('Nombre remitente', inputs.fromName), field('Email remitente', inputs.fromEmail)),
          field('Responder a', inputs.replyTo)),
        h('div', { class: 'card' },
          h('h2', null, 'Contenido (HTML)'),
          h('div', { class: 'toolbar' }, SNIPPETS.map(([label, snippet]) => h('button', { type: 'button', onclick: () => insert(snippet) }, `+ ${label}`))),
          inputs.html,
          h('p', { class: 'muted' }, 'Etiquetas: ', ['{{nombre}}', '{{apellido}}', '{{email}}', '{{empresa}}', '{{unsubscribe_url}}'].map(t => [h('code', null, t), ' ']),
            'Valor por defecto: ', h('code', null, '{{nombre|amigo}}'), '. Si no incluyes el enlace de baja se añade un pie automáticamente.')),
        h('div', { class: 'card' },
          h('h2', null, 'Enviar'),
          field('Enviar prueba a', h('div', { class: 'row' }, testEmail, h('button', {
            onclick: async () => {
              if (await save(null)) await attempt(() => api(`/api/campaigns/${c.id}/test`, { method: 'POST', body: { email: testEmail.value } }), 'Prueba enviada');
            },
          }, 'Enviar prueba'))),
          field('Programar', h('div', { class: 'row' }, when, h('button', { onclick: () => sendCampaign(true) }, 'Programar'))),
          h('div', { style: 'margin-top:16px' }, h('button', { class: 'primary', onclick: () => sendCampaign(false) }, 'Enviar ahora')))),
      previewBox));
}

let reportTimer;
async function reportView(c, lists) {
  const activity = await api(`/api/campaigns/${c.id}/activity`);
  const s = c.stats;
  const list = lists.find(l => l.id === c.listId);
  const EVENT_LABEL = { open: 'Abrió', click: 'Hizo clic', unsubscribe: 'Se dio de baja', bounce: 'Rebote' };

  clearTimeout(reportTimer);
  if (c.status === 'sending' || c.status === 'scheduled') {
    reportTimer = setTimeout(() => { if (location.hash === `#/campanas/${c.id}`) render(); }, 4000);
  }

  const maxClicks = Math.max(1, ...s.linkClicks.map(l => l.unique));
  return h('div', null,
    h('div', { class: 'head' },
      h('div', null, h('a', { href: '#/campanas' }, 'Campañas'), h('h1', null, c.name, ' ', badge(CAMPAIGN_STATUS, c.status))),
      h('div', { class: 'row' },
        c.status === 'scheduled' || c.status === 'sending'
          ? h('button', { onclick: async () => { if (confirm('Cancelar el envío pendiente?') && await attempt(() => api(`/api/campaigns/${c.id}/cancel`, { method: 'POST' }), 'Cancelado')) render(); } }, c.status === 'scheduled' ? 'Desprogramar' : 'Detener envío')
          : null,
        h('button', { onclick: async () => { const copy = await attempt(() => api(`/api/campaigns/${c.id}/duplicate`, { method: 'POST' }), 'Copia creada'); if (copy) location.hash = `#/campanas/${copy.id}`; } }, 'Duplicar'),
        c.status !== 'sending' ? h('button', { class: 'danger', onclick: async () => { if (confirm('Eliminar la campaña y sus estadísticas?') && await attempt(() => api(`/api/campaigns/${c.id}`, { method: 'DELETE' }), 'Eliminada')) location.hash = '#/campanas'; } }, 'Eliminar') : null)),
    h('p', { class: 'muted' },
      `Asunto: ${c.subject} - Audiencia: ${list ? list.name : '(eliminada)'} - `,
      c.status === 'scheduled' ? `Programada para ${fmtDate(c.scheduledAt)}` : `Iniciada ${fmtDate(c.startedAt)}`,
      c.cancelled ? ' - Envío detenido manualmente' : ''),
    h('div', { class: 'grid' },
      stat('Destinatarios', fmtNum(s.recipients)),
      stat('Enviados', fmtNum(s.sent)),
      c.status === 'sending' ? stat('En cola', fmtNum(s.queued)) : null,
      stat('Tasa de apertura', fmtPct(s.openRate)),
      stat('Tasa de clics', fmtPct(s.clickRate)),
      stat('Bajas', fmtNum(s.unsubscribes)),
      stat('Fallidos / rebotes', `${fmtNum(s.failed)} / ${fmtNum(s.bounces)}`)),
    h('div', { class: 'card' },
      h('h2', null, 'Clics por enlace'),
      s.linkClicks.length === 0 ? h('p', { class: 'muted' }, 'La campaña no tiene enlaces.') :
        h('table', null, h('tbody', null, s.linkClicks.map(l => h('tr', null,
          h('td', { style: 'max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, l.url),
          h('td', { style: 'width:30%' }, h('div', { class: 'bar-chart' }, h('div', { style: `width:${(l.unique / maxClicks) * 100}%` }))),
          h('td', { class: 'num' }, `${fmtNum(l.unique)} únicos / ${fmtNum(l.clicks)}`)))))),
    h('div', { class: 'card' },
      h('h2', null, 'Actividad reciente'),
      activity.events.length === 0 ? h('p', { class: 'muted' }, 'Sin actividad todavía.') :
        h('table', null, h('tbody', null, activity.events.map(e => h('tr', null,
          h('td', null, e.email || '(contacto suprimido)'), h('td', null, EVENT_LABEL[e.type] || e.type),
          h('td', { class: 'muted' }, e.type === 'click' ? (s.linkClicks[e.linkIndex] || {}).url : ''),
          h('td', { class: 'muted' }, fmtDate(e.at))))))),
    activity.failures.length ? h('div', { class: 'card' },
      h('h2', null, 'Envíos fallidos'),
      h('table', null, h('tbody', null, activity.failures.map(f => h('tr', null, h('td', null, f.email), h('td', { class: 'muted' }, f.error)))))) : null,
    h('p', { class: 'muted' }, 'Nota: muchos clientes de correo (p. ej. Apple Mail) precargan imágenes, por lo que la tasa de apertura es orientativa. Los clics son más fiables.'));
}

// ---- Ajustes ---------------------------------------------------------------

async function settingsView() {
  const s = await api('/api/settings');
  const i = {
    orgName: h('input', { value: s.orgName }),
    fromName: h('input', { value: s.fromName }),
    fromEmail: h('input', { type: 'email', value: s.fromEmail }),
    replyTo: h('input', { type: 'email', value: s.replyTo }),
    postalAddress: h('input', { value: s.postalAddress, placeholder: 'Calle, número, CP, ciudad' }),
    baseUrl: h('input', { value: s.baseUrl, placeholder: 'https://correo.midominio.com' }),
    ratePerMinute: h('input', { type: 'number', min: 1, max: 6000, value: s.ratePerMinute }),
    doubleOptIn: h('input', { type: 'checkbox', checked: s.doubleOptIn }),
  };
  const smtp = {
    host: h('input', { value: s.smtp.host, placeholder: 'smtp-relay.brevo.com' }),
    port: h('input', { type: 'number', value: s.smtp.port }),
    secure: h('input', { type: 'checkbox', checked: s.smtp.secure }),
    user: h('input', { value: s.smtp.user, autocomplete: 'off' }),
    pass: h('input', { type: 'password', value: s.smtp.pass, autocomplete: 'new-password' }),
  };
  const transport = h('strong', null, s.transport);
  const testTo = h('input', { type: 'email', placeholder: 'tu@correo.com' });

  const save = async () => {
    const body = Object.fromEntries(Object.entries(i).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
    body.smtp = Object.fromEntries(Object.entries(smtp).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
    const out = await attempt(() => api('/api/settings', { method: 'PUT', body }), 'Ajustes guardados');
    if (out) transport.textContent = out.transport;
    return out;
  };

  return h('div', null,
    h('div', { class: 'head' }, h('h1', null, 'Ajustes'), h('button', { class: 'primary', onclick: save }, 'Guardar')),
    h('div', { class: 'card' },
      h('h2', null, 'Remitente'),
      h('div', { class: 'form2' },
        field('Nombre de la organización', i.orgName), field('Nombre remitente por defecto', i.fromName),
        field('Email remitente por defecto', i.fromEmail), field('Responder a', i.replyTo)),
      field('Dirección postal (aparece en el pie de cada correo)', i.postalAddress)),
    h('div', { class: 'card' },
      h('h2', null, 'Servidor'),
      field('URL publica de esta aplicación (para enlaces de baja y seguimiento)', i.baseUrl),
      h('div', { class: 'form2' }, field('Correos por minuto', i.ratePerMinute),
        h('label', { class: 'inline', style: 'margin-top:30px' }, i.doubleOptIn, 'Doble opt-in en el formulario público'))),
    h('div', { class: 'card' },
      h('h2', null, 'Envío SMTP'),
      h('p', { class: 'muted' }, 'Usa un proveedor de envío (Brevo, Amazon SES, Mailgun, Postmark, SMTP de tu hosting...). Deja el servidor vacio para guardar los correos como ficheros .eml sin enviarlos. Configura SPF, DKIM y DMARC en tu dominio para no acabar en spam.'),
      h('div', { class: 'form2' },
        field('Servidor', smtp.host), field('Puerto', smtp.port),
        field('Usuario', smtp.user), field('Contraseña', smtp.pass)),
      h('label', { class: 'inline', style: 'margin-top:12px' }, smtp.secure, 'TLS directo (puerto 465). Desmarcado usa STARTTLS si el servidor lo ofrece.'),
      h('p', null, 'Modo actual: ', transport),
      field('Enviar correo de prueba', h('div', { class: 'row' }, testTo, h('button', {
        onclick: async () => { if (await save()) await attempt(() => api('/api/settings/test', { method: 'POST', body: { email: testTo.value } }), 'Correo de prueba enviado'); },
      }, 'Probar')))));
}

// ---- Router ----------------------------------------------------------------

async function route() {
  const parts = (location.hash || '#/').slice(2).split('/').filter(Boolean);
  const [section, id] = parts;
  if (!section) return dashboardView();
  if (section === 'audiencias') return id ? listDetailView(id) : listsView();
  if (section === 'campanas') {
    if (id === 'nueva') return newCampaignView();
    return id ? campaignView(id) : campaignsView();
  }
  if (section === 'ajustes') return settingsView();
  return h('div', { class: 'empty' }, 'Página no encontrada.');
}

async function render() {
  clearTimeout(reportTimer);
  try {
    const auth = await api('/api/auth');
    if (!auth.authed) { root.replaceChildren(authView(auth.needsSetup)); return; }
    const content = await route();
    root.replaceChildren(layout(content));
  } catch (err) {
    root.replaceChildren(layout(h('div', { class: 'notice' }, err.message)));
  }
}

window.addEventListener('hashchange', render);
render();
