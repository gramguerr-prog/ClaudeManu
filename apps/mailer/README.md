# ManuMail

Herramienta de email marketing autoalojada, al estilo de Mailchimp, sin dependencias externas: solo necesita Node.js 22 o superior.

## Qué incluye

- **Audiencias**: listas de contactos con nombre, apellidos, etiquetas y estado (suscrito, pendiente, baja, rebotado).
- **Importar y exportar CSV**: reconoce columnas `email`/`correo`, `nombre`, `apellidos` y `etiquetas`, con separador coma o punto y coma. Al reimportar nunca se reactiva a quien se dio de baja.
- **Formulario de suscripción público**: con enlace propio o código para incrustarlo en tu web, casilla de consentimiento obligatoria, doble opt-in y protección anti-bots.
- **Campañas**: tres plantillas iniciales, editor HTML con vista previa en escritorio y móvil, etiquetas de personalización (`{{nombre}}`, `{{nombre|amigo}}`, `{{email}}`...), segmentación por etiquetas, correo de prueba, envío inmediato o programado y duplicado de campañas.
- **Informes**: tasa de apertura, clics por enlace, bajas, rebotes, envíos fallidos y actividad reciente.
- **Envío**: cliente SMTP propio (TLS o STARTTLS) compatible con Brevo, Amazon SES, Mailgun, Postmark o el SMTP de tu hosting, con límite de correos por minuto. Sin SMTP configurado, los correos se guardan como ficheros `.eml` en `data/outbox` para probar sin enviar nada.
- **Bajas en un clic**: cabeceras `List-Unsubscribe` y `List-Unsubscribe-Post` (RFC 8058), que Gmail y Yahoo exigen a quien envía correos masivos.

## Arrancar

```bash
cd apps/mailer
npm start            # http://localhost:3000
```

La primera vez que entres te pedirá crear la contraseña de administrador. Después ve a **Ajustes** y completa:

1. Nombre de la organización, email remitente y **dirección postal**, que aparece en el pie de cada correo.
2. **URL pública** de la aplicación (p. ej. `https://correo.midominio.com`): se usa en los enlaces de baja y de seguimiento, así que debe ser accesible desde internet.
3. Datos SMTP de tu proveedor de envío, y luego pulsa **Probar**.

Variables de entorno opcionales:

| Variable | Uso |
|----------|-----|
| `PORT` | Puerto HTTP (por defecto 3000) |
| `DATA_DIR` | Carpeta de datos (por defecto `./data`) |
| `APP_SECRET` | Clave para firmar los enlaces; si no se indica, se genera una y se guarda en la base de datos |
| `SMTP_HELO` | Nombre que se anuncia en `EHLO` |

Los datos se guardan en `data/db.json`. Haz copia de seguridad de esa carpeta.

## Puesta en producción

- Sírvela detrás de HTTPS (Caddy, Nginx o un servicio como Railway o Render). Con una URL `https://` la cookie de sesión se marca como `Secure`.
- Configura **SPF, DKIM y DMARC** en tu dominio con los valores que te dé tu proveedor SMTP; sin ellos tus correos acabarán en spam.
- Empieza con un límite bajo de correos por minuto y súbelo poco a poco ("calentar" el dominio).
- El almacén JSON está pensado para audiencias pequeñas y medianas (hasta unas decenas de miles de contactos).

## Notas legales (España / UE)

La herramienta te lo pone fácil, pero el cumplimiento depende de cómo la uses:

- **Consentimiento** (art. 21 LSSI y art. 6.1.a y 7 RGPD): solo envía comunicaciones comerciales a quien lo haya consentido de forma expresa, salvo la excepción de clientes con relación contractual previa y productos o servicios similares (art. 21.2 LSSI). Cada contacto guarda el origen y la fecha de su consentimiento, y el doble opt-in registra la confirmación y la IP para que puedas acreditarlo (art. 7.1 RGPD).
- **Baja sencilla y gratuita** en cada correo (art. 21.2 LSSI): el enlace de baja se añade automáticamente si no lo incluyes.
- **Identificación del remitente** (art. 20 LSSI): el pie incluye el nombre y la dirección postal.
- **Derecho de supresión** (art. 17 RGPD): el botón *Suprimir* borra el contacto y todo su historial de aperturas y clics.
- **Seguimiento**: el píxel de apertura y el seguimiento de clics tratan datos personales. Infórmalo en tu cláusula de privacidad (puedes editarla en cada audiencia).
- Si usas un proveedor SMTP, este actúa como encargado del tratamiento: firma con él el contrato del art. 28 RGPD (suele estar en sus condiciones).

## Tests

```bash
npm test
```

Cubren el CSV, los tokens firmados, la personalización, el formato MIME y un flujo completo contra un servidor SMTP falso: importación, envío, rebote, apertura, clic, baja, doble opt-in, supresión, límite de intentos de login y protección contra path traversal.
