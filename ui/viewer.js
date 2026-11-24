'use strict';
/* Equipo que controla: descodifica la imagen y envia raton y teclado. */
const $ = (id) => document.getElementById(id);
const canvas = $('screen'), ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const CODECS = ['avc1.640033', 'avc1.42E033', 'vp09.00.51.08', 'vp8'];
let live = false, perms = {}, dec = null, conf = null, waitKey = true, frames = 0, bytes = 0, viewOnly = false;
const msg = (m) => api.send('viewer:msg', m);

// ---------------------------------------------------------------- video
function newDecoder() {
  if (dec && dec.state !== 'closed') dec.close();
  waitKey = true;
  const d = new VideoDecoder({
    output: (f) => {
      if (dec === d) {
        if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) { canvas.width = f.displayWidth; canvas.height = f.displayHeight; layout(); }
        ctx.drawImage(f, 0, 0);
        frames++;
      }
      f.close();
    },
    error: () => { if (dec === d) { newDecoder(); msg({ t: 'v-key' }); } },
  });
  dec = d;
  d.configure({ codec: conf.codec, optimizeForLatency: true });
}
api.on('viewer:frame', (buf) => {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const seq = new DataView(u.buffer, u.byteOffset).getUint32(1), key = u[0] === 1;
  bytes += u.byteLength;
  if (!conf || !dec) return;
  if (waitKey && !key) { msg({ t: 'v-ack', seq }); return; }
  waitKey = false;
  try { dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: seq * 1000, data: u.subarray(5) })); } catch { waitKey = true; msg({ t: 'v-ack', seq }); msg({ t: 'v-key' }); return; }
  // Si el descodificador se atrasa se retrasa la confirmacion y el otro equipo baja el ritmo.
  const ack = () => (dec && dec.decodeQueueSize > 3 ? setTimeout(ack, 15) : msg({ t: 'v-ack', seq }));
  ack();
});
function layout() {
  const box = $('stage').getBoundingClientRect();
  if (!canvas.width) return;
  const k = Math.min(box.width / canvas.width, box.height / canvas.height);
  canvas.style.width = Math.floor(canvas.width * k) + 'px';
  canvas.style.height = Math.floor(canvas.height * k) + 'px';
}
new ResizeObserver(layout).observe($('stage'));
setInterval(() => {
  if (live) $('stats').textContent = `${frames} fps · ${((bytes * 8) / 1e6).toFixed(1)} Mbps`;
  frames = bytes = 0;
}, 1000);

// ---------------------------------------------------------------- estados
function overlay(text, { auth, again } = {}) {
  $('overlay').hidden = false;
  $('status').textContent = text;
  $('auth').hidden = !auth;
  $('again').hidden = !again;
}
const DENIED = { bad_password: 'Contraseña incorrecta.', locked: 'Demasiados intentos. Espera 10 minutos.', approval_disabled: 'Este equipo solo admite contraseña.', password_disabled: 'Este equipo no tiene contraseña configurada.' };
const on = {
  brand: (e) => applyBrand(e.brand),
  status: (e) => overlay(e.text),
  welcome: (e) => {
    const t = e.approval ? `Esperando a que ${e.name} acepte...` : e.password ? `Escribe la contraseña de ${e.name}.` : `${e.name} no admite conexiones ahora.`;
    overlay(t, { auth: e.password, again: !e.approval && !e.password });
    if (e.approval) api.send('viewer:ask');
    if (e.password) $('pw').focus();
  },
  denied: (e) => { $('status').textContent = DENIED[e.reason] || 'Acceso denegado.'; $('pw').value = ''; },
  granted: async (e) => {
    live = true;
    $('overlay').hidden = true;
    $('bar').hidden = false;
    $('pw').value = '';
    on.perms({ data: e });
    on.screens({ data: e });
    const codecs = [];
    for (const codec of CODECS) if ((await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true }).catch(() => ({}))).supported) codecs.push(codec);
    msg({ t: 'v-start', codecs, quality: $('quality').value });
    canvas.focus();
  },
  perms: (e) => { perms = e.data.perms; $('noctl').hidden = perms.control; $('file').disabled = !perms.files; },
  screens: (e) => {
    const cur = $('screens').value;
    $('screens').replaceChildren(...e.data.screens.map((s) => new Option(s.label + (s.primary ? ' (principal)' : ''), s.id)));
    if (e.data.screens.some((s) => s.id === cur)) $('screens').value = cur;
    $('screens').hidden = e.data.screens.length < 2;
  },
  'v-config': (e) => {
    if (e.data.error) { toast('El equipo remoto no puede capturar la pantalla: ' + e.data.error); return; }
    if (!CODECS.includes(e.data.codec)) return;
    conf = e.data;
    newDecoder();
  },
  chat: (e) => { say('Remoto', e.text); $('side').hidden = false; layout(); },
  file: ({ u }) => fileRow(u),
  closed: (e) => {
    live = false;
    if (document.fullscreenElement) document.exitFullscreen();
    $('bar').hidden = true;
    if (dec && dec.state !== 'closed') dec.close();
    dec = conf = null;
    overlay(e.text, { again: true });
  },
};
api.on('viewer:event', (e) => on[e.k]?.(e));
$('auth').onsubmit = (e) => { e.preventDefault(); if ($('pw').value) api.send('viewer:password', $('pw').value); };
$('again').onclick = () => { $('again').hidden = true; api.send('viewer:reconnect'); };

// ---------------------------------------------------------------- raton y teclado
const can = () => live && perms.control && !viewOnly;
const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
let mv = null;
canvas.onpointermove = (e) => {
  if (!can()) return;
  if (!mv) requestAnimationFrame(() => { if (mv) { msg({ t: 'in', k: 'move', ...mv }); mv = null; } });
  mv = pos(e);
};
// Con un boton ya pulsado, los demas llegan como pointermove: se usan los eventos de raton.
canvas.onpointerdown = (e) => { canvas.setPointerCapture(e.pointerId); };
canvas.onmousedown = (e) => { e.preventDefault(); canvas.focus(); if (can()) { mv = null; msg({ t: 'in', k: 'btn', b: e.button, down: true, ...pos(e) }); } };
canvas.onmouseup = (e) => { e.preventDefault(); if (can()) { mv = null; msg({ t: 'in', k: 'btn', b: e.button, down: false, ...pos(e) }); } };
canvas.oncontextmenu = (e) => e.preventDefault();
canvas.onauxclick = (e) => e.preventDefault();
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const f = e.deltaMode === 1 ? 40 : 1.2;
  if (can()) msg({ t: 'in', k: 'wheel', dx: e.deltaX * f, dy: e.deltaY * f });
}, { passive: false });

const held = new Set();
function key(e, down) {
  if (!can() || document.activeElement !== canvas) return;
  e.preventDefault();
  if (down) held.add(e.code); else if (!held.delete(e.code)) return;
  msg({ t: 'in', k: 'key', code: e.code, down });
}
addEventListener('keydown', (e) => key(e, true));
addEventListener('keyup', (e) => key(e, false));
function releaseAll() { if (held.size || live) { held.clear(); msg({ t: 'in', k: 'release' }); } }
addEventListener('blur', releaseAll);
canvas.addEventListener('blur', releaseAll);
function combo(codes) {
  if (!can()) return;
  for (const c of codes) msg({ t: 'in', k: 'key', code: c, down: true });
  for (const c of [...codes].reverse()) msg({ t: 'in', k: 'key', code: c, down: false });
  canvas.focus();
}
$('keys').onchange = () => { const v = $('keys').value; $('keys').value = ''; if (v) combo(v.split('+')); };

// ---------------------------------------------------------------- barra
$('screens').onchange = () => { msg({ t: 'v-screen', id: $('screens').value }); canvas.focus(); };
$('quality').onchange = () => { msg({ t: 'v-quality', quality: $('quality').value }); canvas.focus(); };
$('viewonly').onchange = () => { viewOnly = $('viewonly').checked; releaseAll(); canvas.classList.toggle('watch', viewOnly); canvas.focus(); };
$('file').onclick = () => api.send('viewer:files');
$('folder').onclick = () => api.send('viewer:folder');
$('chat').onclick = () => { $('side').hidden = !$('side').hidden; layout(); };
$('end').onclick = () => api.send('viewer:end');
$('full').onclick = async () => {
  if (document.fullscreenElement) return document.exitFullscreen();
  await document.documentElement.requestFullscreen();
  // En pantalla completa Alt+Tab, Windows, Esc... van al equipo remoto. Mantener Esc para salir.
  await navigator.keyboard?.lock?.().catch(() => {});
  canvas.focus();
  toast('Mantén pulsada Esc para salir de pantalla completa.');
};
function say(who, text) { const p = document.createElement('p'), b = document.createElement('b'); b.textContent = who + ': '; p.append(b, text); $('log').append(p); $('log').scrollTop = 1e9; }
$('form').onsubmit = (e) => { e.preventDefault(); const t = $('text').value.trim(); if (!t) return; msg({ t: 'chat', text: t }); say('Tú', t); $('text').value = ''; };
const rows = new Map();
const ST = { waiting: 'esperando', done: 'completado', failed: 'falló', rejected: 'rechazado' };
function fileRow(u) {
  $('side').hidden = false;
  let r = rows.get(u.key);
  if (!r) { r = document.createElement('p'); rows.set(u.key, r); $('files').append(r); layout(); }
  r.textContent = `${u.dir === 'in' ? 'Recibir' : 'Enviar'} ${u.name}: ${ST[u.state] || Math.floor((u.done / (u.size || 1)) * 100) + ' %'}`;
  if (['done', 'failed', 'rejected'].includes(u.state)) rows.delete(u.key);
}
let tt;
function toast(t) { $('toast').textContent = t; $('toast').hidden = false; clearTimeout(tt); tt = setTimeout(() => { $('toast').hidden = true; }, 5000); }
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); if (live && perms.files) api.send('viewer:files', [...e.dataTransfer.files].map((f) => api.filePath(f)).filter(Boolean)); });
api.send('viewer:ready');
