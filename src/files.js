'use strict';
/** Transferencia de archivos en ambos sentidos sobre el canal, con ventana de confirmacion. */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { T_FILE } = require('./channel');

const CHUNK = 64 * 1024, WINDOW = 2 * 1024 * 1024;

function safeName(name) {
// eslint-disable-next-line no-control-regex -- caracteres prohibidos en nombres de archivo
  let n = String(name ?? '').split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f‪-‮⁦-⁩]/g, '_').replace(/[. ]+$/, '');
  if (!n || n === '.' || n === '..') n = 'archivo';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  if (n.length > 150) { const e = path.extname(n).slice(0, 20); n = n.slice(0, 150 - e.length) + e; }
  return n;
}
function uniquePath(dir, name) {
  const { name: base, ext } = path.parse(name);
  for (let i = 0; ; i++) {
    const p = path.join(dir, i ? `${base} (${i})${ext}` : name);
    if (!fs.existsSync(p) && !fs.existsSync(p + '.part')) return p;
  }
}

/** El antivirus puede retener el archivo recien escrito: se reintenta antes de darlo por fallido. */
async function finish(part, dir, name, wanted) {
  for (let i = 0; ; i++) {
    const dest = fs.existsSync(wanted) ? uniquePath(dir, name) : wanted; // nunca se sobrescribe
    try { await fs.promises.rename(part, dest); return dest; } catch (e) {
      if (i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 150 * 2 ** i));
    }
  }
}

class FileTransfers extends EventEmitter {
  /** accept({name,size}) -> bool|Promise<bool>; dir() -> carpeta de destino */
  constructor(channel, { accept, dir }) {
    super();
    this.ch = channel;
    this.accept = accept;
    this.dir = dir;
    this.out = new Map();
    this.in = new Map();
    this.next = 1;
    channel.on('message', (m) => this._msg(m).catch(() => this._failIn(m.fid, 'io')));
    channel.on('binary', (type, buf) => { if (type === T_FILE) this._chunk(buf); });
    channel.on('close', () => {
      for (const id of [...this.in.keys()]) this._failIn(id, 'closed');
      for (const o of this.out.values()) { o.dead = true; o.wake?.(); }
    });
  }

  async send(file) {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw new Error('not_a_file');
    const fid = this.next++;
    const o = { fid, file, name: path.basename(file), size: st.size, sent: 0, acked: 0 };
    this.out.set(fid, o);
    this.ch.send({ t: 'f-offer', fid, name: o.name, size: o.size });
    this._emit(o, 'out', 'waiting');
    return fid;
  }
  async _pump(o) {
    let fh;
    try {
      fh = await fs.promises.open(o.file, 'r');
      while (o.sent < o.size && !o.dead) {
        if (o.sent - o.acked >= WINDOW) { await new Promise((r) => { o.wake = r; }); continue; }
        const buf = Buffer.alloc(Math.min(CHUNK, o.size - o.sent));
        const { bytesRead } = await fh.read(buf, 0, buf.length, o.sent);
        if (o.dead) break; // cancelado mientras se leia
        if (!bytesRead) throw new Error('short');
        const h = Buffer.alloc(4);
        h.writeUInt32BE(o.fid);
        this.ch.sendBinary(T_FILE, h, buf.subarray(0, bytesRead));
        o.sent += bytesRead;
        this._emit(o, 'out', 'progress');
      }
      if (o.dead) throw new Error('cancelled');
      this.ch.send({ t: 'f-end', fid: o.fid });
    } catch {
      if (this.out.delete(o.fid)) { this.ch.send({ t: 'f-abort', fid: o.fid }); this._emit(o, 'out', 'failed'); }
    } finally { await fh?.close(); }
  }

  async _msg(m) {
    switch (m.t) {
      case 'f-offer': {
        const fid = m.fid, size = m.size;
        if (!Number.isInteger(fid) || this.in.has(fid) || !Number.isSafeInteger(size) || size < 0 || this.in.size > 50) return;
        const f = { fid, name: safeName(m.name), size, got: 0, pending: Promise.resolve() };
        this.in.set(fid, f);
        if (!(await this.accept({ name: f.name, size }))) { this.in.delete(fid); return this.ch.send({ t: 'f-reject', fid }); }
        if (this.ch.closed || !this.in.has(fid)) return;
        const dir = this.dir();
        await fs.promises.mkdir(dir, { recursive: true });
        f.path = uniquePath(dir, f.name);
        f.fh = await fs.promises.open(f.path + '.part', 'wx');
        if (!this.in.has(fid)) { await f.fh.close(); await fs.promises.unlink(f.path + '.part'); return; } // cancelado mientras se abria
        this.ch.send({ t: 'f-accept', fid });
        return this._emit(f, 'in', 'progress');
      }
      case 'f-accept': { const o = this.out.get(m.fid); if (o && !o.started) { o.started = true; this._pump(o); } return; }
      case 'f-ack': {
        const o = this.out.get(m.fid);
        if (o && Number.isSafeInteger(m.n)) { o.acked = Math.min(o.sent, Math.max(o.acked, m.n)); o.wake?.(); }
        return;
      }
      case 'f-end': {
        const f = this.in.get(m.fid);
        if (!f || !f.fh || f.finishing) return;
        f.finishing = true;
        await f.pending;
        if (!this.in.has(m.fid)) return;
        if (f.got !== f.size) return this._failIn(m.fid, 'size');
        await f.fh.close();
        f.fh = null;
        f.path = await finish(f.path + '.part', path.dirname(f.path), f.name, f.path);
        this.in.delete(m.fid);
        this.ch.send({ t: 'f-done', fid: m.fid });
        return this._emit(f, 'in', 'done');
      }
      case 'f-done': { const o = this.out.get(m.fid); if (o) { this.out.delete(m.fid); this._emit(o, 'out', 'done'); } return; }
      case 'f-reject': { const o = this.out.get(m.fid); if (o) { this.out.delete(m.fid); o.dead = true; o.wake?.(); this._emit(o, 'out', 'rejected'); } return; }
      case 'f-abort': return this._failIn(m.fid, 'aborted', true);
    }
  }
  _chunk(buf) {
    if (buf.length < 5) return;
    const f = this.in.get(buf.readUInt32BE(0));
    if (!f || !f.fh) return;
    const data = buf.subarray(4), pos = f.got;
    f.got += data.length;
    if (f.got > f.size) return this._failIn(f.fid, 'size');
    f.pending = f.pending.then(async () => {
      if (!this.in.has(f.fid)) return;
      let off = 0;
      while (off < data.length) off += (await f.fh.write(data, off, data.length - off, pos + off)).bytesWritten;
      this.ch.send({ t: 'f-ack', fid: f.fid, n: pos + data.length });
      this._emit(f, 'in', 'progress');
    }).catch(() => this._failIn(f.fid, 'io'));
  }
  /** Corta todo lo que este en marcha (por ejemplo al retirar el permiso). */
  cancelAll() {
    for (const id of [...this.in.keys()]) this._failIn(id, 'cancelled');
    for (const o of [...this.out.values()]) {
      this.out.delete(o.fid);
      o.dead = true;
      o.wake?.();
      this.ch.send({ t: 'f-abort', fid: o.fid });
      this._emit(o, 'out', 'failed');
    }
  }
  _failIn(fid, why, quiet) {
    const f = this.in.get(fid);
    if (!f) return;
    this.in.delete(fid);
    if (!quiet) this.ch.send({ t: 'f-reject', fid });
    // Nunca se deja un archivo incompleto con el nombre final.
    f.pending.finally(async () => { try { await f.fh?.close(); if (f.path) await fs.promises.unlink(f.path + '.part'); } catch { /* nada que limpiar */ } });
    this._emit(f, 'in', 'failed');
  }
  _emit(f, dir, state) {
    this.emit('update', { key: dir + f.fid, dir, state, name: f.name, size: f.size, done: dir === 'in' ? f.got : f.acked, path: dir === 'in' && state === 'done' ? f.path : undefined });
  }
}
module.exports = { FileTransfers, safeName, uniquePath };
