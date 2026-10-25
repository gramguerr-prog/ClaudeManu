'use strict';

/**
 * Elige como se entregan los correos: SMTP real si esta configurado o, si no,
 * ficheros .eml en data/outbox para probar sin enviar nada.
 */

const fs = require('fs');
const path = require('path');
const { buildMessage } = require('./mime');
const { sendRaw } = require('./smtp');

function isSmtpConfigured(settings) {
  return Boolean(settings.smtp && settings.smtp.host);
}

function createTransport(store) {
  const outbox = path.join(store.dir, 'outbox');

  return {
    describe() {
      return isSmtpConfigured(store.settings)
        ? `SMTP ${store.settings.smtp.host}:${store.settings.smtp.port}`
        : `Bandeja local (${outbox})`;
    },

    async send(msg) {
      const settings = store.settings;
      const fromEmail = msg.fromEmail || settings.fromEmail;
      if (!fromEmail) throw new Error('Configura el email remitente en Ajustes');
      const raw = buildMessage({
        fromName: msg.fromName || settings.fromName,
        fromEmail,
        replyTo: msg.replyTo || settings.replyTo,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        headers: msg.headers,
      });

      if (isSmtpConfigured(settings)) {
        await sendRaw(settings.smtp, { from: fromEmail, to: msg.to }, raw);
        return { delivered: 'smtp' };
      }

      fs.mkdirSync(outbox, { recursive: true });
      const safeTo = String(msg.to).replace(/[^a-z0-9@._-]/gi, '_');
      const file = path.join(outbox, `${Date.now()}-${safeTo}.eml`);
      fs.writeFileSync(file, raw);
      return { delivered: 'file', file };
    },
  };
}

module.exports = { createTransport, isSmtpConfigured };
