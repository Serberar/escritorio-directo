'use strict';
/** Descubrimiento en red local por difusion UDP, autenticado con la clave de empresa. */
const dgram = require('node:dgram');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { cleanName } = require('./channel');

const PERIOD = 5000, EXPIRE = 16_000, STICKY = 12_000;
const SKEW_WARN = 10 * 60_000, SKEW_MAX = 48 * 3600_000; // se admite un reloj mal puesto, pero se avisa

function broadcasts() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const a = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
      out.add(a.map((o, k) => (o & m[k]) | (~m[k] & 255)).join('.'));
    }
  }
  return [...out];
}

function seal(key, body) {
  const p = Buffer.from(JSON.stringify(body)).toString('base64');
  return Buffer.from(p + '.' + crypto.createHmac('sha256', key).update('rd-disc' + p).digest('base64'));
}
function open(key, buf) {
  const [p, mac] = buf.toString('utf8').split('.');
  if (!p || !mac) return null;
  const want = crypto.createHmac('sha256', key).update('rd-disc' + p).digest();
  const got = Buffer.from(mac, 'base64');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const b = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  if (!Number.isFinite(b.at) || Math.abs(Date.now() - b.at) > SKEW_MAX) return null;
  b.skew = Math.abs(Date.now() - b.at) > SKEW_WARN;
  return b;
}

class Discovery extends EventEmitter {
  constructor({ companyKey, id, name, port, udpPort, silent = false }) {
    super();
    Object.assign(this, { companyKey, id, name, port, udpPort, silent });
    this.peers = new Map();
  }
  start() {
    const sock = this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => { if (this.sock === sock) this.emit('problem', e.code); });
    sock.on('message', (buf, r) => { if (this.sock === sock) this._message(buf, r); });
    sock.bind(this.udpPort, () => {
      if (this.sock !== sock) return; // se paro mientras arrancaba
      try { sock.setBroadcast(true); } catch (e) { return this.emit('problem', e.code); }
      this.announce();
    });
    this.timer = setInterval(() => {
      this.announce();
      let changed = false;
      for (const [id, p] of this.peers) if (Date.now() - p.seen > EXPIRE) { this.peers.delete(id); changed = true; }
      if (changed) this.emit('change');
    }, PERIOD);
  }
  _message(buf, r) {
    let b = null;
    if (buf.length < 1500) try { b = open(this.companyKey, buf); } catch { /* ajeno */ }
    if (!b || b.id === this.id || !/^\d{9}$/.test(b.id)) return;
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const prev = this.peers.get(b.id), now = Date.now();
    if (prev && b.at < prev.at) return; // anuncio repetido o fuera de orden
    if (b.bye) { if (this.peers.delete(b.id)) this.emit('change'); return; }
    const p = { id: b.id, name: cleanName(b.name), host: r.address, port, at: b.at, skew: b.skew, seen: now, hostSeen: now };
    if (prev && prev.host !== r.address && now - prev.hostSeen < STICKY) {
      // Equipo con varias redes: se mantiene la direccion que ya funcionaba.
      p.host = prev.host;
      p.hostSeen = prev.hostSeen;
    }
    this.peers.set(b.id, p);
    if (!prev) this.announce();
    if (!prev || prev.name !== p.name || prev.host !== p.host || prev.port !== p.port || prev.skew !== p.skew) this.emit('change');
  }
  announce(bye) {
    if (!this.sock || this.silent) return; // quien no acepta conexiones no se anuncia
    const msg = seal(this.companyKey, { id: this.id, name: this.name, port: this.port, at: Date.now(), bye });
    for (const addr of broadcasts()) { try { this.sock.send(msg, this.udpPort, addr, () => {}); } catch { /* socket cerrandose */ } }
  }
  stop() {
    clearInterval(this.timer);
    const s = this.sock;
    if (!s) return;
    this.announce(true);
    this.sock = null;
    setTimeout(() => { try { s.close(); } catch { /* ya cerrado */ } }, 100);
  }
}
module.exports = { Discovery, seal, open, broadcasts };
