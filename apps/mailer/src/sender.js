'use strict';

/**
 * Motor de envio: arranca campanas programadas, crea la cola de envios y la
 * vacia respetando el limite de correos por minuto.
 */

const { renderEmail, extractLinks } = require('./render');

const TICK_MS = 2000;

/** Contactos suscritos de la lista que cumplen el filtro de etiquetas. */
function audienceFor(store, campaign) {
  const tags = (campaign.tags || []).map(t => t.toLowerCase());
  return store.find('contacts', c =>
    c.listId === campaign.listId &&
    c.status === 'subscribed' &&
    (tags.length === 0 || (c.tags || []).some(t => tags.includes(t.toLowerCase()))));
}

function startCampaign(store, campaign) {
  const contacts = audienceFor(store, campaign);
  const now = new Date().toISOString();
  for (const contact of contacts) {
    store.data.sends.push({
      id: `${campaign.id}:${contact.id}`,
      campaignId: campaign.id,
      contactId: contact.id,
      email: contact.email,
      status: 'queued',
      createdAt: now,
    });
  }
  store.update('campaigns', campaign.id, {
    status: 'sending',
    startedAt: now,
    links: extractLinks(campaign.html),
    recipients: contacts.length,
  });
}

function buildHeaders(unsubscribeUrl, campaign) {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'X-Campaign-Id': campaign.id,
  };
}

async function deliver(store, transport, campaign, send) {
  const contact = store.get('contacts', send.contactId);
  if (!contact || contact.status !== 'subscribed') {
    send.status = 'skipped';
    return;
  }
  const email = renderEmail(campaign, contact, { settings: store.settings, secret: store.secret });
  try {
    await transport.send({
      fromName: campaign.fromName,
      fromEmail: campaign.fromEmail,
      replyTo: campaign.replyTo,
      to: contact.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: buildHeaders(email.unsubscribeUrl, campaign),
    });
    send.status = 'sent';
    send.sentAt = new Date().toISOString();
  } catch (err) {
    send.status = 'failed';
    send.error = err.message;
    // 5xx en RCPT suele indicar buzon inexistente: rebote duro.
    if (err.code >= 550 && err.code < 560) {
      contact.status = 'bounced';
      store.insert('events', { type: 'bounce', campaignId: campaign.id, contactId: contact.id }, { lazy: true });
    }
  }
}

function createSender(store, transport, { tickMs = TICK_MS } = {}) {
  let timer = null;
  let busy = false;
  let budget = 0;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      for (const campaign of store.find('campaigns', c => c.status === 'scheduled')) {
        if (new Date(campaign.scheduledAt).getTime() <= now) startCampaign(store, campaign);
      }

      const perMinute = Math.max(1, Number(store.settings.ratePerMinute) || 60);
      budget = Math.min(perMinute, budget + (perMinute * tickMs) / 60000);

      for (const campaign of store.find('campaigns', c => c.status === 'sending')) {
        const queued = store.find('sends', s => s.campaignId === campaign.id && s.status === 'queued');
        while (queued.length > 0 && budget >= 1) {
          budget -= 1;
          await deliver(store, transport, campaign, queued.shift());
        }
        if (queued.length === 0) {
          store.update('campaigns', campaign.id, { status: 'sent', sentAt: new Date().toISOString() });
        } else {
          store.save();
        }
      }
    } catch (err) {
      console.error('[sender]', err);
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    start() { timer = setInterval(tick, tickMs); timer.unref?.(); },
    stop() { clearInterval(timer); },
  };
}

module.exports = { createSender, audienceFor, startCampaign };
