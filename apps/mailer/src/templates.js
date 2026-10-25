'use strict';

/** Plantillas iniciales para el editor de campanas. */

const wrap = (inner, bg = '#f3f4f6') => `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px">
${inner}
</table>
</td></tr>
</table>
</body>
</html>`;

const TEMPLATES = [
  {
    id: 'newsletter',
    name: 'Newsletter',
    description: 'Cabecera, artículo principal y botón de llamada a la acción.',
    html: wrap(`<tr><td style="padding:28px 32px;background:#1f2937;border-radius:8px 8px 0 0;font-family:Arial,sans-serif;color:#ffffff;font-size:22px;font-weight:bold">{{empresa}}</td></tr>
<tr><td style="padding:32px;font-family:Arial,sans-serif;color:#111827">
  <h1 style="margin:0 0 16px;font-size:24px">Hola {{nombre|amigo}},</h1>
  <p style="margin:0 0 16px;font-size:16px;line-height:24px">Estas son las novedades de este mes. Cuéntanos aquí la noticia principal en dos o tres frases.</p>
  <p style="margin:0 0 24px;font-size:16px;line-height:24px">Añade un segundo párrafo con más detalle, un dato interesante o una cita.</p>
  <a href="https://example.com" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:16px">Leer más</a>
</td></tr>`),
  },
  {
    id: 'promo',
    name: 'Promoción',
    description: 'Oferta destacada con código de descuento.',
    html: wrap(`<tr><td style="padding:40px 32px;text-align:center;font-family:Arial,sans-serif;color:#111827">
  <p style="margin:0;font-size:14px;letter-spacing:2px;color:#dc2626;font-weight:bold">SOLO ESTA SEMANA</p>
  <h1 style="margin:12px 0;font-size:36px">-20% en todo</h1>
  <p style="margin:0 0 24px;font-size:16px;line-height:24px">{{nombre|Hola}}, usa este código al pagar:</p>
  <p style="margin:0 0 28px"><span style="display:inline-block;border:2px dashed #dc2626;padding:12px 28px;font-size:22px;font-weight:bold;letter-spacing:3px">BIENVENIDA20</span></p>
  <a href="https://example.com/tienda" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:bold">Ir a la tienda</a>
</td></tr>`, '#fef2f2'),
  },
  {
    id: 'simple',
    name: 'Texto simple',
    description: 'Aspecto de correo personal: ideal para despachos y servicios profesionales.',
    html: `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"></head>
<body style="font-family:Georgia,serif;font-size:16px;line-height:26px;color:#111827;max-width:600px;margin:0 auto;padding:24px">
<p>Estimado/a {{nombre}}:</p>
<p>Escribe aquí tu mensaje.</p>
<p>Un cordial saludo,<br>{{empresa}}</p>
</body>
</html>`,
  },
];

module.exports = { TEMPLATES };
