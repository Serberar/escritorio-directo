'use strict';
/**
 * Canal cifrado directo entre dos equipos sobre un unico socket TCP.
 *
 *  - X25519 efimero: secreto perfecto hacia delante.
 *  - Ed25519 por equipo: identidad estable de la que sale el ID de 9 digitos. El ID se calcula con scrypt
 *    para que fabricar otra clave con el mismo ID cueste miles de horas de procesador.
 *  - La clave de red separa unos programas de otros; es publica y no protege nada.
 *  - AES-256-GCM con contador por sentido.
 */
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const MAGIC = Buffer.from('RD01');
const HELLO = 4 + 32 + 32;
const MAX_HANDSHAKE = 4096;
const MAX_FRAME = 16 * 1024 * 1024;
const T_JSON = 0, T_VIDEO = 1, T_FILE = 2;

const X_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const rawPub = (key) => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const importPub = (prefix, raw) => crypto.createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });

function createIdentity() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}
function loadIdentity(b64) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
  const pub = rawPub(crypto.createPublicKey(privateKey));
  return { privateKey, pub, id: idFromPub(pub) };
}
/**
 * Un descifrado fallido de safeStorage deja su error en la cola de BoringSSL, que Electron comparte con
 * Node: la siguiente lectura de una clave, aunque sea valida, falla con BAD_DECRYPT. Aqui se vacia.
 */
function clearCryptoErrors() {
  const probe = createIdentity();
  for (let i = 0; i < 20; i++) { try { loadIdentity(probe); return true; } catch { /* se consume un error */ } }
  return false;
}
function idFromPub(pub) {
  const n = crypto.scryptSync(pub, 'rd-id-2', 8, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).readBigUInt64BE(0);
  return String(100_000_000n + (n % 900_000_000n));
}
function deriveNetKey(appId) {
  return crypto.createHash('sha256').update('rd-red-2').update(String(appId)).digest();
}

class SecureChannel extends EventEmitter {
  constructor(socket, opts) {
    super();
    this.socket = socket;
    this.opts = opts;
    this.chunks = [];
    this.size = 0;
    this.queue = [];
    this.started = false;
    this.closed = false;
    this.ready = false;
    this.lastRx = Date.now();
    socket.setNoDelay(true);
    socket.on('error', (e) => this.destroy(e.code || 'error'));
    socket.on('close', () => this.destroy('closed'));
    socket.on('data', (d) => { try { this._data(d); } catch (e) { this.destroy(e.message); } });
  }

  /** Completa el saludo. opts: { role, identity, netKey, name, expectId, expectPub } */
  static handshake(socket, opts) {
    const ch = new SecureChannel(socket, opts);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => ch.destroy('handshake_timeout'), 5000);
      ch._done = (err) => {
        clearTimeout(timer);
        ch._done = null;
        if (err) reject(err); else resolve(ch);
      };
      const eph = crypto.generateKeyPairSync('x25519');
      ch.eph = eph.privateKey;
      ch.hello = Buffer.concat([MAGIC, rawPub(eph.publicKey), crypto.randomBytes(32)]);
      if (opts.role === 'client') ch._rawFrame(ch.hello);
    });
  }

  // ---- saludo ----
  _handshakeFrame(buf) {
    const isClient = this.opts.role === 'client';
    if (!this.keys) {
      if (buf.length !== HELLO || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('bad_hello');
      const shared = crypto.diffieHellman({
        privateKey: this.eph, publicKey: importPub(X_PREFIX, buf.subarray(4, 36)),
      });
      this.eph = null;
      const [c, s] = isClient ? [this.hello, buf] : [buf, this.hello];
      this.transcript = crypto.createHash('sha256').update(c).update(s).digest();
      const okm = Buffer.from(crypto.hkdfSync('sha256', shared, this.opts.netKey,
        Buffer.concat([Buffer.from('rd01'), this.transcript]), 96));
      const c2s = okm.subarray(0, 32), s2c = okm.subarray(32, 64);
      this.binding = okm.subarray(64);
      this.keys = isClient ? { tx: c2s, rx: s2c } : { tx: s2c, rx: c2s };
      this.txN = 0n;
      this.rxN = 0n;
      if (!isClient) { this._rawFrame(this.hello); this._sendAuth(); }
      return;
    }
    let plain;
    try { plain = this._decrypt(buf); } catch { throw new Error('bad_protocol'); }
    const m = JSON.parse(plain.toString('utf8'));
    const pub = Buffer.from(String(m.pub), 'base64');
    if (pub.length !== 32) throw new Error('bad_identity');
    const ok = crypto.verify(null, this._toSign(isClient ? 'server' : 'client'),
      importPub(ED_PREFIX, pub), Buffer.from(String(m.sig), 'base64'));
    if (!ok) throw new Error('bad_identity');
    this.peer = { id: idFromPub(pub), pub: pub.toString('base64'), name: cleanName(m.name) };
    if (isClient) {
      const { expectId, expectPub } = this.opts;
      if ((expectId && expectId !== this.peer.id) || (expectPub && expectPub !== this.peer.pub)) throw new Error('identity_mismatch');
      this._sendAuth();
    }
    this.ready = true;
    this.beat = setInterval(() => {
      if (Date.now() - this.lastRx > 20_000) return this.destroy('timeout');
      this.send({ t: 'ping' });
    }, 5000);
    this._done?.();
  }

  _toSign(role) { return Buffer.concat([Buffer.from('rd01-' + role), this.transcript]); }
  _sendAuth() {
    const { identity, name, role } = this.opts;
    this._rawFrame(this._encrypt(Buffer.from(JSON.stringify({
      pub: identity.pub.toString('base64'), name,
      sig: crypto.sign(null, this._toSign(role), identity.privateKey).toString('base64'),
    }))));
  }

  // ---- cifrado y tramas ----
  _nonce(n) { const b = Buffer.alloc(12); b.writeBigUInt64BE(n, 4); return b; }
  _encrypt(plain) {
    const c = crypto.createCipheriv('aes-256-gcm', this.keys.tx, this._nonce(this.txN++));
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }
  _decrypt(buf) {
    if (buf.length < 16) throw new Error('short_frame');
    const d = crypto.createDecipheriv('aes-256-gcm', this.keys.rx, this._nonce(this.rxN++), { authTagLength: 16 });
    d.setAuthTag(buf.subarray(-16));
    return Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]);
  }
  _rawFrame(buf) {
    if (this.closed) return;
    const h = Buffer.alloc(4);
    h.writeUInt32BE(buf.length);
    this.socket.cork();
    this.socket.write(h);
    this.socket.write(buf);
    this.socket.uncork();
  }
  _data(d) {
    if (this.closed) return;
    this.lastRx = Date.now();
    this.chunks.push(d);
    this.size += d.length;
    while (!this.closed && this.size >= 4) {
      if (this.chunks[0].length < 4) this.chunks = [Buffer.concat(this.chunks)];
      const len = this.chunks[0].readUInt32BE(0);
      if (len === 0 || len > (this.ready ? MAX_FRAME : MAX_HANDSHAKE)) throw new Error('bad_frame');
      if (this.size < 4 + len) return;
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      const rest = all.subarray(4 + len);
      this.chunks = rest.length ? [rest] : [];
      this.size = rest.length;
      const frame = all.subarray(4, 4 + len);
      if (!this.ready) this._handshakeFrame(frame);
      else this._dispatch(this._decrypt(frame));
    }
  }
  _dispatch(plain) {
    if (!this.started) { this.queue.push(plain); return; }
    if (plain[0] === T_JSON) {
      const m = JSON.parse(plain.toString('utf8', 1));
      if (!m || typeof m !== 'object' || m.t === 'ping') return;
      this.emit('message', m);
    } else this.emit('binary', plain[0], plain.subarray(1));
  }

  /** Empieza a entregar mensajes (llamar tras registrar los oyentes). */
  start() {
    this.started = true;
    try { for (const p of this.queue.splice(0)) if (!this.closed) this._dispatch(p); } catch (e) { this.destroy(e.message); }
  }
  send(obj) { this.sendBinary(T_JSON, Buffer.from(JSON.stringify(obj))); }
  sendBinary(type, ...parts) {
    if (this.closed || !this.ready) return;
    this._rawFrame(this._encrypt(Buffer.concat([Buffer.from([type]), ...parts])));
  }
  get bufferedAmount() { return this.socket.writableLength; }

  destroy(reason = 'closed', flush = false) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.beat);
    if (flush) { this.socket.end(); setTimeout(() => this.socket.destroy(), 1500).unref?.(); } else this.socket.destroy();
    this._done?.(Object.assign(new Error(reason), { stage: this.keys ? 'auth' : 'hello' }));
    this.emit('close', reason);
  }
}

function cleanName(s) {
  // eslint-disable-next-line no-control-regex -- se quitan a proposito
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 64) || 'Equipo';
}

module.exports = { SecureChannel, clearCryptoErrors, createIdentity, loadIdentity, idFromPub, deriveNetKey, cleanName, T_JSON, T_VIDEO, T_FILE };
