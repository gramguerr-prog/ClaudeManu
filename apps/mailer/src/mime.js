'use strict';

/** Construccion de mensajes MIME multipart/alternative (texto + HTML). */

const crypto = require('crypto');

function encodeWord(value) {
  const str = String(value || '');
  return /^[\x20-\x7e]*$/.test(str) ? str : `=?UTF-8?B?${Buffer.from(str).toString('base64')}?=`;
}

function formatAddress(name, email) {
  if (!name) return `<${email}>`;
  const safeName = /^[\w .-]*$/.test(name) ? `"${name}"` : encodeWord(name);
  return `${safeName} <${email}>`;
}

function base64Lines(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

function stripCrlf(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ');
}

/**
 * @param {object} msg { fromName, fromEmail, to, replyTo, subject, html, text, headers }
 */
function buildMessage(msg) {
  const domain = String(msg.fromEmail).split('@')[1] || 'localhost';
  const boundary = `=_mm_${crypto.randomBytes(12).toString('hex')}`;
  const headers = {
    From: formatAddress(stripCrlf(msg.fromName), stripCrlf(msg.fromEmail)),
    To: `<${stripCrlf(msg.to)}>`,
    Subject: encodeWord(stripCrlf(msg.subject)),
    Date: new Date().toUTCString().replace('GMT', '+0000'),
    'Message-ID': `<${crypto.randomUUID()}@${domain}>`,
    'MIME-Version': '1.0',
    ...(msg.replyTo ? { 'Reply-To': `<${stripCrlf(msg.replyTo)}>` } : {}),
    ...msg.headers,
    'Content-Type': `multipart/alternative; boundary="${boundary}"`,
  };

  const head = Object.entries(headers)
    .map(([key, value]) => `${key}: ${stripCrlf(value)}`)
    .join('\r\n');

  return [
    head,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(msg.text || ''),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(msg.html || ''),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

module.exports = { buildMessage, encodeWord, formatAddress };
