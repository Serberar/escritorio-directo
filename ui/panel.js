'use strict';
/* Equipo controlado: captura y codifica la pantalla, muestra quien esta conectado y permite cortar. */
const PRESET = {
  sharp: { w: 4096, h: 2304, fps: 30, max: 20e6 },
  balanced: { w: 1920, h: 1200, fps: 30, max: 8e6 },
  fast: { w: 1280, h: 800, fps: 15, max: 2e6 },
};
const WINDOW = 6, MIN_RATE = 600e3;

class Capture {
  constructor(o) {
    this.o = o;
    this.p = PRESET[o.quality] || PRESET.balanced;
    this.rate = this.p.max / 2;
    this.sent = 0; this.acked = 0; this.frames = 0; this.held = 0;
    this.needKey = true;
    this.bad = new Set();
    this.alive = true;
    this.tick = setInterval(() => this.adapt(), 2000);
    this.run();
  }
  async run() {
    while (this.alive) {
      try { await this.capture(); } catch (e) {
        if (!this.alive) return;
        api.send('panel:error', this.o.sid, 'captura: ' + e.message);
      } finally { this.stream?.getTracks().forEach((t) => t.stop()); }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  async capture() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: this.o.sourceId, maxWidth: this.p.w, maxHeight: this.p.h, maxFrameRate: this.p.fps } },
    });
    if (!this.alive) return this.stream.getTracks().forEach((t) => t.stop());
    const [track] = this.stream.getVideoTracks();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (this.alive) {
      const { value, done } = await reader.read();
      if (done) return;
      await this.offer(value);
    }
  }
  async offer(frame) {
    this.frames++;
    if (!this.alive) return frame.close();
    // Si la red va por detras se guarda solo la imagen mas reciente.
    if (this.sent - this.acked >= WINDOW || (this.enc && this.enc.encodeQueueSize > 1)) {
      this.held++;
      this.pending?.close();
      this.pending = frame;
      return;
    }
    await this.encode(frame);
  }
  // De uno en uno: un cambio de tamano no puede configurar dos codificadores a la vez.
  encode(frame) { return (this.chain = (this.chain || Promise.resolve()).then(() => this.encodeOne(frame)).catch((e) => { frame.close(); if (this.alive) api.send('panel:error', this.o.sid, e.message); })); }
  async encodeOne(frame) {
    const w = frame.codedWidth & ~1, h = frame.codedHeight & ~1;
    if (!this.enc || this.enc.state !== 'configured' || this.w !== w || this.h !== h) {
      try { await this.configure(w, h); } catch (e) { frame.close(); api.send('panel:error', this.o.sid, e.message); return; }
    }
    if (!this.alive) return frame.close();
    this.last?.close();
    this.last = frame;
    this.push();
    clearTimeout(this.idle);
    this.refine = 0;
    this.scheduleRefine();
  }
  push() {
    const f = new VideoFrame(this.last, { timestamp: Math.round(performance.now() * 1000) });
    try { this.enc.encode(f, { keyFrame: this.needKey }); this.needKey = false; } finally { f.close(); }
  }
  // Con la pantalla quieta no llegan imagenes nuevas: se repite la ultima para ganar nitidez.
  scheduleRefine() {
    this.idle = setTimeout(() => {
      if (!this.alive || !this.last || this.enc?.state !== 'configured' || this.refine >= 4) return;
      this.refine++;
      try { if (this.sent - this.acked < WINDOW) this.push(); } catch { return; } // el codificador acaba de cerrarse
      this.scheduleRefine();
    }, 250);
  }
  async configure(w, h) {
    const cands = [
      { codec: 'avc1.640033', avc: { format: 'annexb' } }, { codec: 'avc1.42E033', avc: { format: 'annexb' } },
      { codec: 'vp09.00.51.08' }, { codec: 'vp8' },
    ].filter((c) => this.o.codecs.includes(c.codec) && !this.bad.has(c.codec));
    for (const c of cands) {
      const conf = { ...c, width: w, height: h, bitrate: Math.round(this.rate), framerate: this.p.fps, latencyMode: 'realtime', bitrateMode: 'variable' };
      const ok = await VideoEncoder.isConfigSupported(conf).then((r) => r.supported, () => false);
      if (!ok) continue;
      if (!this.alive) return;
      if (this.enc && this.enc.state !== 'closed') this.enc.close();
      const enc = new VideoEncoder({
        output: (chunk) => { if (this.enc === enc) this.out(chunk); },
        error: () => { if (this.enc === enc) { this.bad.add(c.codec); this.enc = null; this.needKey = true; if (this.last) this.offer(this.last.clone()); } },
      });
      enc.configure(conf);
      this.enc = enc; this.conf = conf; this.w = w; this.h = h;
      this.needKey = true;
      api.send('panel:config', this.o.sid, { codec: c.codec, w, h });
      return;
    }
    throw new Error('No hay códec de vídeo compatible');
  }
  out(chunk) {
    const buf = new Uint8Array(5 + chunk.byteLength);
    buf[0] = chunk.type === 'key' ? 1 : 0;
    new DataView(buf.buffer).setUint32(1, ++this.sent);
    chunk.copyTo(buf.subarray(5));
    api.send('panel:frame', this.o.sid, buf);
  }
  ack(seq) {
    if (seq > this.acked && seq <= this.sent) this.acked = seq;
    if (this.pending && this.sent - this.acked < WINDOW) { const f = this.pending; this.pending = null; this.encode(f); }
  }
  key() { this.needKey = true; this.acked = this.sent; if (this.last && this.enc?.state === 'configured') this.push(); }
  adapt() {
    if (!this.enc || this.enc.state !== 'configured' || this.frames < 5) { this.frames = this.held = 0; return; }
    const r = this.held / this.frames;
    this.frames = this.held = 0;
    const next = r > 0.3 ? Math.max(MIN_RATE, this.rate * 0.7) : r < 0.05 ? Math.min(this.p.max, this.rate * 1.2) : this.rate;
    if (Math.abs(next - this.rate) / this.rate < 0.05) return;
    this.rate = next;
    this.conf.bitrate = Math.round(next);
    try { this.enc.configure(this.conf); } catch { this.needKey = true; }
  }
  stop() {
    this.alive = false;
    clearInterval(this.tick);
    clearTimeout(this.idle);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.pending?.close();
    this.last?.close();
    if (this.enc && this.enc.state !== 'closed') this.enc.close();
  }
}

const caps = new Map();
api.on('panel:start', (o) => {
  const old = caps.get(o.sid);
  const c = new Capture(o);
  if (old) { c.sent = c.acked = old.sent; old.stop(); }
  caps.set(o.sid, c);
});
api.on('panel:ack', ({ sid, seq }) => caps.get(sid)?.ack(seq));
api.on('panel:key', ({ sid }) => caps.get(sid)?.key());
api.on('panel:stop', ({ sid }) => { caps.get(sid)?.stop(); caps.delete(sid); cards.get(sid)?.el.remove(); cards.delete(sid); });

// ---------------------------------------------------------------- interfaz
const cards = new Map();
const PERMS = { control: 'Ratón y teclado', clipboard: 'Portapapeles', files: 'Archivos' };
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };

function permBoxes(perms, onChange) {
  return el('div', { className: 'perms' }, ...Object.entries(PERMS).map(([k, label]) => {
    const i = el('input', { type: 'checkbox', checked: !!perms[k], onchange: () => onChange(k, i.checked) });
    i.dataset.perm = k;
    return el('label', {}, i, ' ' + label);
  }));
}
function askCard(s) {
  const perms = { control: true, clipboard: true, files: true };
  return el('section', { className: 'card' },
    el('h2', { textContent: s.name }), el('p', { className: 'muted', textContent: `ID ${fmt(s.id)} · ${s.internet ? 'por internet · ' : ''}${(s.ip || '').replace('::ffff:', '')}` }),
    el('p', { textContent: 'Quiere ver y controlar este equipo. Acepta solo si lo esperabas: el nombre lo elige quien llama, el ID no se puede imitar.' }),
    permBoxes(perms, (k, v) => { perms[k] = v; }),
    el('div', { className: 'row' },
      el('button', { className: 'primary', id: 'accept', textContent: 'Aceptar', onclick: () => api.send('panel:decide', s.sid, perms) }),
      el('button', { className: 'danger', textContent: 'Rechazar', onclick: () => api.send('panel:decide', s.sid, null) })));
}
function activeCard(s) {
  const log = el('div', { className: 'log' });
  const input = el('input', { placeholder: 'Escribe un mensaje', maxLength: 2000 });
  const say = (who, text) => { log.append(el('p', {}, el('b', { textContent: who + ': ' }), text)); log.scrollTop = log.scrollHeight; };
  const form = el('form', { className: 'row', onsubmit: (e) => { e.preventDefault(); if (!input.value.trim()) return; api.send('panel:say', s.sid, input.value); say('Tú', input.value); input.value = ''; } },
    input, el('button', { textContent: 'Enviar' }));
  const node = el('section', { className: 'card live' },
    el('h2', { textContent: s.name }), el('p', { className: 'muted', textContent: `Conectado desde las ${new Date(s.since).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })} · ID ${fmt(s.id)}` }),
    permBoxes(s.perms, (k, v) => api.send('panel:perm', s.sid, k, v)), log, form,
    el('div', { className: 'row' },
      el('button', { textContent: 'Enviar archivo', onclick: () => api.send('panel:sendfile', s.sid) }),
      el('button', { className: 'danger', textContent: 'Desconectar', onclick: () => api.send('panel:end', s.sid) })));
  return { node, say };
}
api.on('panel:state', ({ list, brand }) => {
  applyBrand(brand);
  const keep = new Set(list.map((s) => s.sid));
  for (const [sid, c] of cards) if (!keep.has(sid)) { c.el.remove(); cards.delete(sid); }
  for (const s of list) {
    const c = cards.get(s.sid);
    if (c && c.active === s.active) {
      if (s.active) for (const i of c.el.querySelectorAll('[data-perm]')) i.checked = s.perms[i.dataset.perm];
      continue;
    }
    c?.el.remove();
    const a = s.active ? activeCard(s) : { node: askCard(s) };
    cards.set(s.sid, { el: a.node, active: s.active, say: a.say, name: s.name });
    document.querySelector('main').append(a.node);
  }
});
api.on('panel:chat', ({ sid, text }) => { const c = cards.get(sid); c?.say?.(c.name, text); });
api.on('panel:file', ({ sid, ...u }) => { if (u.state === 'done') cards.get(sid)?.say?.(u.dir === 'in' ? 'Recibido' : 'Enviado', u.name); if (u.state === 'failed' || u.state === 'rejected') cards.get(sid)?.say?.('No se completó', u.name); });
setInterval(() => api.send('panel:beat'), 2000);
api.send('panel:ready');
