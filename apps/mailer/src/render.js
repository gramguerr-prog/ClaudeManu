'use strict';

/**
 * Personaliza el HTML de una campana para cada destinatario: etiquetas de
 * fusion, enlaces con seguimiento de clics, pixel de apertura y pie legal
 * con enlace de baja.
 */

const { sign } = require('./tokens');

const HREF_RE = /href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi;

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Enlaces http(s) unicos del HTML, en orden de aparicion. */
function extractLinks(html) {
  const links = [];
  for (const match of String(html).matchAll(HREF_RE)) {
    const url = match[2].replace(/&amp;/g, '&');
    if (!links.includes(url)) links.push(url);
  }
  return links;
}

function mergeValues(contact, settings, urls) {
  return {
    nombre: contact.firstName || '',
    first_name: contact.firstName || '',
    apellido: contact.lastName || '',
    last_name: contact.lastName || '',
    email: contact.email || '',
    empresa: settings.orgName || '',
    direccion: settings.postalAddress || '',
    unsubscribe_url: urls.unsubscribe,
    baja_url: urls.unsubscribe,
  };
}

function applyMergeTags(text, values, escape) {
  return String(text).replace(/\{\{\s*([a-z_]+)(?:\s*\|\s*([^}]*))?\s*\}\}/gi, (whole, key, fallback) => {
    const name = key.toLowerCase();
    if (!(name in values)) return whole;
    const value = values[name] || (fallback !== undefined ? fallback.trim() : '');
    return escape && !name.endsWith('_url') ? escapeHtml(value) : value;
  });
}

function footerHtml(settings) {
  const parts = [escapeHtml(settings.orgName || '')];
  if (settings.postalAddress) parts.push(escapeHtml(settings.postalAddress));
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:32px">
  <tr><td style="padding:16px;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#6b7280;text-align:center">
    ${parts.join(' &middot; ')}<br>
    Recibes este correo porque te suscribiste a nuestra lista.
    <a href="{{unsubscribe_url}}" style="color:#6b7280">Darse de baja</a>
  </td></tr>
</table>`;
}

function htmlToText(html) {
  return String(html)
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi, '$3 ($2)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#847;|&zwnj;/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&middot;/g, '·')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * @param {object} campaign  campana con html, subject, links
 * @param {object} contact   destinatario
 * @param {object} ctx       { settings, secret, track }
 * @returns {{ subject, html, text, unsubscribeUrl }}
 */
function renderEmail(campaign, contact, ctx) {
  const { settings, secret, track = true } = ctx;
  const base = String(settings.baseUrl || '').replace(/\/+$/, '');
  const ref = { c: campaign.id, r: contact.id };
  const urls = { unsubscribe: `${base}/u/${sign({ k: 'u', ...ref }, secret)}` };
  const values = mergeValues(contact, settings, urls);
  const links = campaign.links || extractLinks(campaign.html);

  let html = String(campaign.html || '');
  if (!/\{\{\s*(unsubscribe_url|baja_url)\s*\}\}/i.test(html)) {
    html = /<\/body>/i.test(html)
      ? html.replace(/<\/body>/i, `${footerHtml(settings)}</body>`)
      : html + footerHtml(settings);
  }

  if (track) {
    html = html.replace(HREF_RE, (whole, quote, rawUrl) => {
      const index = links.indexOf(rawUrl.replace(/&amp;/g, '&'));
      if (index === -1) return whole;
      return `href=${quote}${base}/t/c/${sign({ k: 'c', ...ref, l: index }, secret)}${quote}`;
    });
  }

  if (campaign.preheader) {
    const hidden = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(campaign.preheader)}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`;
    html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, m => m + hidden) : hidden + html;
  }

  html = applyMergeTags(html, values, true);

  if (track) {
    const pixel = `<img src="${base}/t/o/${sign({ k: 'o', ...ref }, secret)}" width="1" height="1" alt="" style="display:none">`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : html + pixel;
  }

  const subject = applyMergeTags(campaign.subject || '', values, false);
  const text = htmlToText(html.replace(/<img[^>]*>/gi, ''));
  return { subject, html, text, unsubscribeUrl: urls.unsubscribe };
}

module.exports = { renderEmail, extractLinks, escapeHtml, htmlToText, applyMergeTags };
