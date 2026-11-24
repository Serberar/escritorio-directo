'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { RotatingFile } = require('./log');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeSafe(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let i = 0; ; i++) { // un antivirus puede tener el archivo abierto un instante
    try { return fs.renameSync(tmp, file); } catch (e) {
      if (i >= 4) { try { fs.unlinkSync(tmp); } catch { /* da igual */ } throw e; }
      pause(40);
    }
  }
}

/**
 * Configuracion local. Los secretos se cifran con la cuenta de Windows (safeStorage/DPAPI) y se
 * descifran una vez en init(). Un archivo danado se recupera de la copia o se aparta; nunca impide arrancar.
 */
class Config {
  constructor(dir, safeStorage, defaults) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.bak = path.join(dir, 'config.bak.json');
    this.ss = safeStorage;
    this.sec = {};
    this.lost = [];
    this.recovered = null; // null | 'copia' | 'nueva'
    this.saveError = null;
    fs.mkdirSync(dir, { recursive: true });
    this.log = new RotatingFile(path.join(dir, 'audit.jsonl'));
    const saved = this._load();
    this.data = {
      ...defaults, ...saved,
      settings: { ...defaults.settings, ...(isObj(saved.settings) ? saved.settings : {}) },
      secrets: isObj(saved.secrets) ? saved.secrets : {},
      contacts: isObj(saved.contacts) ? Object.fromEntries(Object.entries(saved.contacts).filter(([id, c]) => /^\d{9}$/.test(id) && isObj(c) && typeof c.name === 'string')) : {},
    };
    const s = this.data.settings, d = defaults.settings;
    for (const k of Object.keys(d)) if (typeof s[k] !== typeof d[k] || s[k] === null) s[k] = d[k];
  }
  _read(f) {
    try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return isObj(v) ? v : null; } catch { return null; }
  }
  _load() {
    if (!fs.existsSync(this.file) && !fs.existsSync(this.bak)) return {};
    const main = this._read(this.file);
    if (main) return main;
    this._setAside('danada');
    const bak = this._read(this.bak);
    this.recovered = bak ? 'copia' : 'nueva';
    return bak || {};
  }
  _setAside(tag) {
    try { if (fs.existsSync(this.file)) fs.copyFileSync(this.file, path.join(this.dir, `config.${tag}-${Date.now()}.json`)); } catch { /* sin copia */ }
  }

  /** Descifra los secretos. Los que Windows ya no puede abrir quedan en this.lost. */
  async init() {
    if (this.recovered) this.save(); // deja sano el archivo en cuanto se recupera
    let redo = false;
    for (const [k, v] of Object.entries(this.data.secrets)) {
      const buf = Buffer.from(String(v), 'base64');
      try {
        const r = await this.ss.decryptStringAsync(buf);
        this.sec[k] = r.result;
        if (r.shouldReEncrypt) redo = true;
      } catch { this.lost.push(k); }
    }
    if (this.lost.length) {
      this._setAside('claves-perdidas');
      for (const k of this.lost) delete this.data.secrets[k];
      this.save();
    } else if (redo) for (const k of Object.keys(this.sec)) await this.setSecret(k, this.sec[k]);
    return this;
  }
  getSecret(k) { return this.sec[k] ?? null; }
  async setSecret(k, v) {
    if (v == null) { delete this.sec[k]; delete this.data.secrets[k]; } else {
      this.data.secrets[k] = (await this.ss.encryptStringAsync(v)).toString('base64');
      this.sec[k] = v;
    }
    return this.save();
  }

  /** Devuelve false si no se pudo guardar (el programa sigue con los datos en memoria). */
  save() {
    const text = JSON.stringify(this.data, null, 2);
    try {
      writeSafe(this.file, text);
      this.saveError = null;
    } catch (e) { this.saveError = e.code || e.message; return false; }
    try { writeSafe(this.bak, text); } catch { /* la principal ya esta guardada */ }
    return true;
  }
  audit(event, data) { this.log.append(JSON.stringify({ at: new Date().toISOString(), event, ...data })); }
  readAudit(n = 100) {
    return this.log.tail(n).reverse().flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }
}
module.exports = { Config };
