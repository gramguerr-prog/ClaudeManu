'use strict';

/** Lectura y escritura de CSV (RFC 4180) con deteccion de separador , o ; */

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

function parse(text) {
  const input = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(input);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);

  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(values => {
    const record = {};
    headers.forEach((h, idx) => { record[h] = (values[idx] || '').trim(); });
    return record;
  });
}

function escapeField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  // Prefijo para evitar inyeccion de formulas al abrir en Excel.
  const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
  return /[",\r\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function stringify(headers, records) {
  const lines = [headers.join(',')];
  for (const record of records) {
    lines.push(headers.map(h => escapeField(record[h])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Mapea cabeceras habituales (es/en) a los campos del contacto. */
const FIELD_ALIASES = {
  email: ['email', 'e-mail', 'correo', 'correo electronico', 'correo electrónico', 'mail'],
  firstName: ['nombre', 'first name', 'firstname', 'first_name', 'name'],
  lastName: ['apellido', 'apellidos', 'last name', 'lastname', 'last_name'],
  tags: ['etiquetas', 'tags', 'etiqueta', 'tag'],
};

function toContact(record) {
  const contact = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const key = aliases.find(a => record[a] !== undefined);
    contact[field] = key ? record[key] : '';
  }
  return contact;
}

module.exports = { parse, stringify, toContact };
