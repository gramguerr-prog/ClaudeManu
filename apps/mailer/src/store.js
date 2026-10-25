'use strict';

/**
 * Almacen JSON en disco. Todo se mantiene en memoria y se persiste con
 * escritura atomica (fichero temporal + rename) tras cada cambio.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COLLECTIONS = ['lists', 'contacts', 'campaigns', 'sends', 'events'];

const DEFAULT_SETTINGS = {
  orgName: 'Mi negocio',
  fromName: 'Mi negocio',
  fromEmail: '',
  replyTo: '',
  postalAddress: '',
  baseUrl: 'http://localhost:3000',
  ratePerMinute: 60,
  doubleOptIn: true,
  smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.saveTimer = null;
    this.data = this.load();
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let data = {};
    if (fs.existsSync(this.file)) {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    }
    for (const name of COLLECTIONS) {
      if (!Array.isArray(data[name])) data[name] = [];
    }
    data.settings = {
      ...DEFAULT_SETTINGS,
      ...(data.settings || {}),
      smtp: { ...DEFAULT_SETTINGS.smtp, ...((data.settings || {}).smtp || {}) },
    };
    data.auth = data.auth || { passwordHash: null };
    if (!data.secret) data.secret = crypto.randomBytes(32).toString('hex');
    return data;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  /** Agrupa escrituras frecuentes (p. ej. eventos de apertura). */
  saveSoon() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 500);
  }

  all(name) {
    return this.data[name];
  }

  get(name, id) {
    return this.data[name].find(item => item.id === id) || null;
  }

  find(name, predicate) {
    return this.data[name].filter(predicate);
  }

  insert(name, item, { lazy = false } = {}) {
    const record = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...item };
    this.data[name].push(record);
    if (lazy) this.saveSoon(); else this.save();
    return record;
  }

  update(name, id, patch) {
    const record = this.get(name, id);
    if (!record) return null;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return record;
  }

  remove(name, predicate) {
    const before = this.data[name].length;
    this.data[name] = this.data[name].filter(item => !predicate(item));
    this.save();
    return before - this.data[name].length;
  }

  get settings() {
    return this.data.settings;
  }

  get secret() {
    return process.env.APP_SECRET || this.data.secret;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
