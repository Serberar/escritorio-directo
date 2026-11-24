'use strict';
/** Logica de sesion (sin Electron): escucha, autenticacion, permisos y mensajes. */
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { SecureChannel, T_VIDEO } = require('./channel');
const { FileTransfers } = require('./files');

const MAX_TEXT = 200 * 1024;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const stretch = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw.normalize('NFKC'), salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
const proof = (key, role, nonce, binding) => crypto.createHmac('sha256', key).update(role).update(nonce).update(binding).digest();
const b64 = (s, len) => { const b = Buffer.from(String(s ?? ''), 'base64'); return b.length === len ? b : null; };

async function makePassword(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('base64'), key: (await stretch(pw, salt)).toString('base64') };
}

/**
 * Freno a las peticiones de acceso: cualquiera que sepa el ID puede llamar, asi que nadie debe poder llenar la
 * pantalla de avisos. Tras 3 rechazos de un equipo se le ignora 30 minutos; en total, 12 peticiones cada 10 minutos.
 */
class AskGate {
  constructor(now = Date.now) { this.now = now; this.asks = []; this.denied = new Map(); }
  allowed(id) {
    const t = this.now();
    this.asks = this.asks.filter((at) => at > t - 10 * 60_000);
    const d = this.denied.get(id);
    if (d && t > d.until) this.denied.delete(id);
    return this.asks.length < 12 && !(this.denied.get(id)?.n >= 3);
  }
  asked() { this.asks.push(this.now()); }
  rejected(id) {
    if (this.denied.size > 500) this.denied.clear();
    this.denied.set(id, { n: (this.denied.get(id)?.n || 0) + 1, until: this.now() + 30 * 60_000 });
  }
  accepted(id) { this.denied.delete(id); this.asks = []; }
}

/** Tope de intentos de contrasena: 5 por equipo y 20 en total cada 10 minutos. */
class PasswordGate {
  constructor(now = Date.now) { this.now = now; this.fails = []; }
  _recent() { const t = this.now() - 10 * 60_000; this.fails = this.fails.filter((f) => f.at > t); return this.fails; }
  allowed(id) { const r = this._recent(); return r.length < 20 && r.filter((f) => f.id === id).length < 5; }
  fail(id) { this.fails.push({ id, at: this.now() }); }
  ok(id) { this.fails = this.fails.filter((f) => f.id !== id); }
}

/**
 * Sesion en el equipo controlado.
 * deps: { name, password(), allowApproval(), unattendedPerms(), gate, askApproval(session) -> {cancel, result},
 *         injector, screens(), downloadsDir(), audit(event, data) }
 */
class HostSession extends EventEmitter {
  constructor(channel, deps) {
    super();
    this.sid = crypto.randomUUID();
    this.ch = channel;
    this.deps = deps;
    this.peer = channel.peer;
    this.authorized = false;
    this.perms = null;
    this.since = null;
    this.remoteAddress = channel.socket.remoteAddress;
    this.internet = !!channel.socket.internet;
    channel.on('message', (m) => this._msg(m).catch(() => this.end('error')));
    channel.on('close', (r) => this._closed(r));
    // Quien se queda a medias sin autorizarse no retiene recursos.
    this.idle = setTimeout(() => { if (!this.authorized) this.end('auth_timeout'); }, 120_000);
  }
  /** Se llama cuando ya hay quien atienda la sesion. */
  start() {
    if (this.ch.closed) return;
    this.ch.start();
    this.ch.send({ t: 'welcome', password: !!this.deps.password(), approval: this.deps.allowApproval() });
  }

  async _msg(m) {
    if (m.t === 'end') return this.end('remote_closed');
    if (!this.authorized) return this._auth(m);
    switch (m.t) {
      case 'in': if (this.perms.control) this.deps.injector.handle(m, this); return;
      case 'clip':
        if (this.perms.clipboard && typeof m.text === 'string' && m.text.length <= MAX_TEXT) this.emit('clip', m.text);
        return;
      case 'chat': if (typeof m.text === 'string') this.emit('chat', m.text.slice(0, 2000)); return;
      case 'v-start': case 'v-ack': case 'v-key': case 'v-quality': case 'v-screen': return this.emit('video', m);
    }
  }

  async _auth(m) {
    const { deps, ch, peer } = this;
    if (m.t === 'ask' && !this.prompt) {
      if (!deps.allowApproval()) return ch.send({ t: 'denied', reason: 'approval_disabled' });
      if (deps.asks && !deps.asks.allowed(peer.id)) return ch.send({ t: 'denied', reason: 'busy' });
      deps.asks?.asked();
      this.prompt = deps.askApproval(this);
      const perms = await this.prompt.result;
      this.prompt = null;
      if (!perms && !this.authorized) deps.asks?.rejected(peer.id); else deps.asks?.accepted(peer.id);
      if (ch.closed || this.authorized) return;
      if (!perms) { deps.audit('rejected', { peer: peer.id, name: peer.name }); return this.end('rejected'); }
      return this._grant(perms, 'approval');
    }
    if (m.t === 'pw-begin') {
      const pw = deps.password();
      if (!pw) return ch.send({ t: 'denied', reason: 'password_disabled' });
      if (!deps.gate.allowed(peer.id)) return ch.send({ t: 'denied', reason: 'locked' });
      this.nonce = crypto.randomBytes(32);
      return ch.send({ t: 'pw-challenge', salt: pw.salt, nonce: this.nonce.toString('base64') });
    }
    if (m.t === 'pw-proof') {
      const pw = deps.password(), nonce = this.nonce;
      this.nonce = null; // cada reto vale una sola vez
      if (!pw || !nonce) return;
      if (!deps.gate.allowed(peer.id)) return ch.send({ t: 'denied', reason: 'locked' });
      const key = Buffer.from(pw.key, 'base64');
      const got = b64(m.mac, 32);
      if (!got || !crypto.timingSafeEqual(got, proof(key, 'viewer', nonce, ch.binding))) {
        deps.gate.fail(peer.id);
        deps.audit('bad_password', { peer: peer.id, name: peer.name, ip: this.remoteAddress });
        return ch.send({ t: 'denied', reason: 'bad_password' });
      }
      deps.gate.ok(peer.id);
      return this._grant(deps.unattendedPerms(), 'password', proof(key, 'host', nonce, ch.binding).toString('base64'));
    }
  }

  _grant(perms, method, hostProof) {
    clearTimeout(this.idle);
    this.prompt?.cancel();
    this.authorized = true;
    this.perms = { control: !!perms.control, clipboard: !!perms.clipboard, files: !!perms.files };
    this.method = method;
    this.since = Date.now();
    this.files = new FileTransfers(this.ch, { accept: () => this.perms.files, dir: this.deps.downloadsDir });
    this.files.on('update', (u) => this.emit('file', u));
    this.deps.audit('session_start', { peer: this.peer.id, name: this.peer.name, ip: this.remoteAddress, internet: this.internet || undefined, method, perms: this.perms });
    this.ch.send({ t: 'granted', perms: this.perms, screens: this.deps.screens(), hostProof });
    this.emit('granted');
  }
  setPerm(k, v) {
    if (!this.perms || !(k in this.perms)) return;
    this.perms[k] = !!v;
    if (k === 'control' && !v) this.deps.injector.release(this);
    if (k === 'files' && !v) this.files.cancelAll();
    this.ch.send({ t: 'perms', perms: this.perms });
  }
  sendFrame(buf) { if (this.authorized) this.ch.sendBinary(T_VIDEO, buf); }
  end(reason = 'host_closed') {
    if (this.ch.closed) return;
    this.ch.send({ t: 'end', reason });
    this.ch.destroy(reason, true);
  }
  _closed(reason) {
    clearTimeout(this.idle);
    this.prompt?.cancel();
    if (this.authorized) {
      this.deps.injector.release(this);
      this.deps.audit('session_end', { peer: this.peer.id, name: this.peer.name, reason, seconds: Math.round((Date.now() - this.since) / 1000) });
    }
    this.emit('close', reason);
  }
}

/** Escucha conexiones entrantes. */
class HostServer extends EventEmitter {
  constructor({ identity, netKey, name, deps }) {
    super();
    Object.assign(this, { identity, netKey, name, deps });
    this.sessions = new Map();
    this.pending = new Set(); // saludos a medias
    this.hits = new Map();
    this.failed = new Map();
    this.server = net.createServer((s) => this._conn(s));
  }
  listen(port, host) {
    return new Promise((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', rej);
        this.server.on('error', () => {});
        res(this.server.address().port);
      });
    });
  }
  /** Conexion que llega por otra via (internet). */
  accept(sock) { return this._conn(sock); }
  async _conn(sock) {
    sock.on('error', () => {});
    const ip = String(sock.remoteAddress || '?'), now = Date.now();
    if (this.hits.size > 2000) this.hits.clear();
    const h = this.hits.get(ip);
    const e = h && h.until > now ? h : { n: 0, until: now + 60_000 };
    e.n++;
    this.hits.set(ip, e);
    const all = [...this.sessions.values()];
    if (e.n > 60 || all.filter((s) => s.authorized).length >= 20) return sock.destroy();
    // Quien abre conexiones y no las completa pierde la mas antigua; nadie deja fuera a los demas.
    const same = [...this.pending].filter((p) => p.ip === ip);
    const evict = (p) => { this.pending.delete(p); p.sock.destroy(); };
    if (same.length >= 4) evict(same[0]);
    else if (this.pending.size >= 60) evict(this.pending.values().next().value);
    const entry = { ip, sock };
    this.pending.add(entry);
    let ch;
    try {
      ch = await SecureChannel.handshake(sock, { role: 'server', identity: this.identity, netKey: this.netKey, name: this.name });
    } catch (err) {
      // Como mucho una linea por minuto y direccion, para que nadie pueda llenar el registro.
      if (err.stage === 'auth' && !(this.failed.get(ip) > now - 60_000)) {
        if (this.failed.size > 500) this.failed.clear();
        this.failed.set(ip, now);
        this.deps.audit('handshake_failed', { ip });
      }
      return;
    } finally { this.pending.delete(entry); }
    if (ch.closed) return;
    const waiting = [...this.sessions.values()].filter((s) => !s.authorized);
    const own = waiting.filter((s) => s.peer.id === ch.peer.id);
    if (own.length >= 2) own[0].end('replaced');
    else if (waiting.length >= 20) waiting[0].end('replaced');
    const s = new HostSession(ch, this.deps);
    this.sessions.set(s.sid, s);
    s.on('close', () => { this.sessions.delete(s.sid); this.emit('change'); });
    this.emit('session', s);
    s.start();
  }
  close() {
    for (const s of [...this.sessions.values()]) s.end('host_closed');
    for (const p of this.pending) p.sock.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }
}

const CANCELLED = () => new Error('cancelled');
function dialTcp({ host, port }, signal) {
  return new Promise((res, rej) => {
    if (signal.aborted) return rej(CANCELLED());
    const s = net.connect({ host, port });
    const fail = (why) => { clearTimeout(t); signal.removeEventListener('abort', abort); s.destroy(); rej(new Error(why)); };
    const abort = () => fail('cancelled');
    const t = setTimeout(() => fail('connect_timeout'), 8000);
    signal.addEventListener('abort', abort);
    s.once('connect', () => { clearTimeout(t); signal.removeEventListener('abort', abort); s.removeAllListeners('error'); res(s); });
    s.once('error', (e) => fail(e.code || 'connect_error'));
  });
}
/** Por internet, dejando ventaja a la red local si el equipo tambien puede estar ahi. */
async function dialWan({ wan, id, delay = 0 }, signal) {
  if (delay) {
    await new Promise((res, rej) => {
      const t = setTimeout(res, delay);
      signal.addEventListener('abort', () => { clearTimeout(t); rej(CANCELLED()); }, { once: true });
    });
  }
  return wan.connect(id, { signal });
}

/** Sesion en el equipo que controla. */
class ViewerSession extends EventEmitter {
  constructor(channel, { downloadsDir, acceptFile }) {
    super();
    this.ch = channel;
    this.peer = channel.peer;
    this.granted = false;
    this.files = new FileTransfers(channel, { accept: (f) => this.granted && acceptFile(f), dir: downloadsDir });
    this.files.on('update', (u) => this.emit('file', u));
    channel.on('message', (m) => this._msg(m).catch(() => this.end()));
    channel.on('binary', (type, buf) => { if (type === T_VIDEO && this.granted) this.emit('frame', buf); });
    channel.on('close', (r) => this.emit('close', this.endReason || r));
  }
  /**
   * Conecta por la via que antes lo consiga. routes: [{ host, port } | { wan, id, delay }].
   * Con expectId, cada via comprueba que responde ese equipo; la que pierde se cierra.
   */
  static async connect({ routes, host, port, identity, netKey, name, expectId, expectPub, ...opts }) {
    const list = routes || [{ host, port }];
    const stop = new AbortController();
    let winner = null;
    const attempt = async (r) => {
      const sock = r.wan ? await dialWan(r, stop.signal) : await dialTcp(r, stop.signal);
      const ch = await SecureChannel.handshake(sock, { role: 'client', identity, netKey, name, expectId, expectPub });
      if (winner) { ch.destroy('replaced'); throw new Error('replaced'); }
      winner = ch;
      return ch;
    };
    try {
      const ch = await Promise.any(list.map(attempt));
      return new ViewerSession(ch, opts);
    } catch (e) {
      // Se explica el fallo mas util: un problema de identidad antes que uno de red.
      const all = (e.errors || [e]).map((x) => x.message);
      throw new Error(all.find((m) => ['bad_protocol', 'identity_mismatch', 'bad_identity'].includes(m)) || all.find((m) => m.startsWith('wan_')) || all[0], { cause: e });
    } finally { stop.abort(); }
  }
  start() {
    if (this.ch.closed) return void setImmediate(() => this.emit('close', 'closed'));
    this.ch.start();
  }
  ask() { this.ch.send({ t: 'ask' }); }
  password(pw) { this._pw = pw; this.ch.send({ t: 'pw-begin' }); }

  async _msg(m) {
    switch (m.t) {
      case 'welcome': return this.emit('welcome', m);
      case 'pw-challenge': {
        const pw = this._pw;
        this._pw = null;
        const nonce = b64(m.nonce, 32), salt = b64(m.salt, 16);
        if (pw == null || !nonce || !salt) return;
        const key = await stretch(pw, salt);
        this._expect = proof(key, 'host', nonce, this.ch.binding);
        return this.ch.send({ t: 'pw-proof', mac: proof(key, 'viewer', nonce, this.ch.binding).toString('base64') });
      }
      case 'granted': {
        if (m.hostProof !== undefined) { // el equipo remoto tambien demuestra conocer la contrasena
          const got = b64(m.hostProof, 32);
          if (!this._expect || !got || !crypto.timingSafeEqual(got, this._expect)) return this.end('host_not_verified');
        }
        this.granted = true;
        return this.emit('granted', m);
      }
      case 'denied': return this.emit('denied', m.reason);
      case 'end': this.endReason = String(m.reason || 'closed').slice(0, 40); return this.ch.destroy('remote_end');
      case 'clip':
        if (this.granted && typeof m.text === 'string' && m.text.length <= MAX_TEXT) this.emit('clip', m.text);
        return;
      case 'chat': if (this.granted && typeof m.text === 'string') this.emit('chat', m.text.slice(0, 2000)); return;
      case 'perms': case 'v-config': case 'screens': case 'cursor': if (this.granted) this.emit('info', m); return;
    }
  }
  send(m) { this.ch.send(m); }
  end(reason = 'viewer_closed') {
    if (this.ch.closed) return;
    this.endReason = reason;
    this.ch.send({ t: 'end', reason });
    this.ch.destroy(reason, true);
  }
}

/** Motivo por el que una contrasena de acceso no vale, o null. El equipo es accesible desde internet. */
function weakPassword(pw) {
  if (pw.length < 8) return 'Usa al menos 8 caracteres.';
  const low = pw.toLowerCase();
  const line = '0123456789 9876543210 abcdefghijklmnopqrstuvwxyz qwertyuiop asdfghjkl zxcvbnm';
  if (new Set(low).size < 4 || line.includes(low) || /^(.{1,4})\1+$/.test(low) || /^\d+$/.test(low)) return 'Es demasiado fácil: mezcla letras y números, sin repeticiones ni secuencias.';
  if (/(contrase|password|12345|qwerty|administrador)/.test(low) && pw.length < 14) return 'Es demasiado conocida. Usa otra.';
  return null;
}

module.exports = { HostServer, HostSession, ViewerSession, PasswordGate, AskGate, makePassword, weakPassword, MAX_TEXT };
