'use strict';
/**
 * Conexión por internet usando solo el ID del equipo, sin abrir puertos ni servidor propio.
 *
 *  - Cada equipo escucha en una dirección que sale de su ID y se publica en una red distribuida (HyperDHT),
 *    que además ayuda a los dos routers a abrirse paso (UDP hole punching).
 *  - Esa dirección la puede calcular cualquiera que sepa el ID, así que no prueba nada: por la tubería pasa el
 *    mismo canal cifrado que en la red local (channel.js), que es el que comprueba quién responde. La red
 *    distribuida no ve nada de la sesión.
 */
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const DHT = require('hyperdht');

const CHUNK = 64 * 1024;
const CONNECT_TIMEOUT = 25_000, READY_TIMEOUT = 20_000, RETRY = 30_000, REFRESH = 10 * 60_000;

/** Par de claves de la dirección de un equipo. Lo calculan igual quien escucha y quien llama. */
function addressFor(netKey, id) {
  return DHT.keyPair(Buffer.from(crypto.hkdfSync('sha256', netKey, 'rd-wan', 'rd01-wan-' + id, 32)));
}

/** Clave con la que llama este programa: lo que no sea él se rechaza sin atenderlo. No es un secreto. */
function callerKey(netKey) {
  return DHT.keyPair(Buffer.from(crypto.hkdfSync('sha256', netKey, 'rd-wan', 'rd01-wan-llamada', 32)));
}

/** Da a un flujo de HyperDHT la parte de net.Socket que usa SecureChannel. */
class WanSocket extends EventEmitter {
  constructor(stream) {
    super();
    this.stream = stream;
    this.queue = [];
    this.queued = 0;
    this.corked = 0;
    this.ending = false;
    this.destroyed = false;
    this.internet = true;
    stream.on('data', (d) => this.emit('data', d));
    stream.on('drain', () => { this.blocked = false; this._flush(); });
    stream.on('error', (e) => this.emit('error', e));
    stream.on('end', () => { if (!this.ending) this.end(); });
    stream.on('close', () => { if (this.destroyed) return; this.destroyed = true; this.emit('close'); });
  }
  get remoteAddress() { return this.stream.rawStream?.remoteHost || undefined; }
  get remotePort() { return this.stream.rawStream?.remotePort || undefined; }
  /** Lo que aún no ha salido: cola propia más lo que está en vuelo. */
  get writableLength() { return this.queued + (this.stream.rawStream?.inflight || 0); }
  setNoDelay() {}
  cork() { this.corked++; }
  uncork() { if (--this.corked <= 0) { this.corked = 0; this._flush(); } }
  write(buf) {
    if (this.destroyed || this.ending) return false;
    this.queue.push(buf);
    this.queued += buf.length;
    if (!this.corked) this._flush();
    return !this.blocked;
  }
  /** Junta trozos pequeños y parte los grandes: cada escritura es un mensaje cifrado del flujo. */
  _flush() {
    while (this.queue.length && !this.blocked && !this.destroyed) {
      const parts = [];
      let size = 0;
      while (this.queue.length && size < CHUNK) {
        const head = this.queue[0], room = CHUNK - size;
        if (head.length <= room) { parts.push(head); size += head.length; this.queue.shift(); } else {
          parts.push(head.subarray(0, room));
          this.queue[0] = head.subarray(room);
          size += room;
        }
      }
      this.queued -= size;
      if (this.stream.write(parts.length === 1 ? parts[0] : Buffer.concat(parts, size)) === false) this.blocked = true;
    }
    if (this.ending && !this.queue.length && !this.destroyed) this.stream.end();
  }
  end() {
    if (this.ending) return;
    this.ending = true;
    this._flush();
  }
  destroy() { this.stream.destroy(); }
}

/** eventos: connection(WanSocket), change(). Se recupera solo de los cortes de red. */
class Wan extends EventEmitter {
  constructor({ netKey, id, listen = true, bootstrap }) {
    super();
    Object.assign(this, { netKey, id, listen, bootstrap });
    this.state = 'starting'; // starting | online | offline
    this.stopped = false;
  }
  start() {
    this._up().catch((e) => this._fail(e));
    return this;
  }
  async _up() {
    if (this.stopped) return;
    // ephemeral: usa la red distribuida, pero no trabaja para ella.
    const node = this.node = new DHT({ ephemeral: true, bootstrap: this.bootstrap });
    const mine = () => this.node === node && !this.stopped;
    await withTimeout(node.fullyBootstrapped(), READY_TIMEOUT, 'wan_unreachable');
    if (!mine()) return;
    if (this.listen) {
      const allowed = Buffer.from(callerKey(this.netKey).publicKey);
      const server = this.server = node.createServer({
        firewall: (remote) => !allowed.equals(Buffer.from(remote)), // true = se rechaza: no es este programa
      }, (stream) => {
        stream.on('error', () => {}); // SecureChannel pone el suyo; esto cubre hasta entonces
        this.emit('connection', new WanSocket(stream));
      });
      await withTimeout(server.listen(addressFor(this.netKey, this.id)), READY_TIMEOUT, 'wan_unreachable');
      if (!mine()) return;
    }
    if (!node.online) throw new Error('wan_unreachable');
    this._set('online');
    node.on('network-update', () => { if (mine()) this._watch(node); });
    this.timer = setInterval(() => { if (mine()) { this.server?.refresh(); this._watch(node); } }, REFRESH);
  }
  /** Sigue el estado de la red; si no vuelve en un rato, se monta todo de nuevo. */
  _watch(node) {
    clearTimeout(this.lostTimer);
    if (node.online) return this._set('online');
    this._set('offline');
    this.lostTimer = setTimeout(() => { if (this.node === node && !node.online) this._fail(new Error('wan_unreachable')); }, 60_000);
  }
  async _fail(e) {
    if (this.stopped) return;
    this.emit('problem', e);
    this._set('offline');
    await this._down();
    this.retry = setTimeout(() => this.start(), RETRY);
  }
  _set(state) { if (this.state !== state) { this.state = state; this.emit('change'); } }

  /** Abre una tubería hasta el equipo con ese ID. */
  connect(id, { signal } = {}) {
    if (!this.node || this.state === 'offline') return Promise.reject(new Error('wan_unreachable'));
    if (signal?.aborted) return Promise.reject(new Error('cancelled'));
    const { publicKey } = addressFor(this.netKey, id);
    return new Promise((resolve, reject) => {
      const stream = this.node.connect(publicKey, { keyPair: callerKey(this.netKey) });
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (!err) return resolve(new WanSocket(stream));
        stream.on('error', () => {});
        stream.destroy();
        reject(err);
      };
      const abort = () => finish(new Error('cancelled'));
      const timer = setTimeout(() => finish(new Error('wan_timeout')), CONNECT_TIMEOUT);
      signal?.addEventListener('abort', abort);
      stream.once('open', () => finish());
      stream.on('error', (e) => finish(new Error(reason(e))));
      stream.once('close', () => finish(new Error('wan_blocked')));
    });
  }
  async _down() {
    clearInterval(this.timer);
    clearTimeout(this.lostTimer);
    const { node, server } = this;
    this.node = this.server = null;
    try { await withTimeout(Promise.resolve(server?.close()), 1500, 'close'); } catch { /* se cierra el nodo igualmente */ }
    try { await withTimeout(Promise.resolve(node?.destroy({ force: true })), 1500, 'close'); } catch { /* ya no responde */ }
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    await this._down();
  }
}

function reason(e) {
  switch (e?.code) {
    case 'PEER_NOT_FOUND': return 'wan_not_found';
    case 'PEER_CONNECTION_FAILED': case 'HOLEPUNCH_ABORTED': case 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS':
    case 'CANNOT_HOLEPUNCH': case 'REMOTE_NOT_HOLEPUNCHABLE': case 'HOLEPUNCH_PROBE_TIMEOUT': case 'REMOTE_NOT_HOLEPUNCHING': case 'REMOTE_ABORTED': return 'wan_blocked';
    default: return 'wan_failed';
  }
}
function withTimeout(promise, ms, why) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(why)), ms); })]).finally(() => clearTimeout(t));
}

module.exports = { Wan, WanSocket, addressFor, callerKey, reason };
