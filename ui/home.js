'use strict';
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
let st = null, loaded = false, drawn = '';

const EVENTS = {
  session_start: 'Conexión recibida', session_end: 'Conexión terminada', rejected: 'Conexión rechazada', bad_password: 'Contraseña incorrecta',
  handshake_failed: 'Conexión no completada (otra clave de empresa o cancelada)', config_recovered: 'Configuración recuperada', secret_lost: 'Claves que Windows no pudo abrir', panel_lost: 'Sesión cortada: falló la ventana de aviso', outgoing: 'Te conectaste a', file_in: 'Archivo recibido', file_out: 'Archivo enviado',
};
function detail(a) {
  return [a.name && a.event.startsWith('file') ? a.name : a.name && `${a.name} (${fmt(a.peer || '')})`, a.ip?.replace('::ffff:', ''),
    a.method && (a.method === 'password' ? 'con contraseña' : 'con aprobación'), a.seconds != null && `${Math.floor(a.seconds / 60)} min ${a.seconds % 60} s`, a.msg].filter(Boolean).join(' · ');
}
function render(s) {
  st = s;
  applyBrand(s.brand);
  $('setup').hidden = s.configured;
  $('app').hidden = !s.configured;
  $('sproblem').textContent = s.problem || '';
  if (!s.configured) return;
  $('myid').textContent = fmt(s.id);
  $('myname').textContent = s.settings.name;
  $('myip').textContent = s.ips.join(', ') || 'sin red';
  $('state').textContent = s.listening ? 'Listo para recibir conexiones' : 'No recibe conexiones';
  $('state').className = 'pill ' + (s.listening ? 'ok' : 'off');
  $('problem').hidden = !s.problem;
  $('problem').textContent = s.problem || '';
  const q = $('filter').value.trim().toLowerCase();
  if (!s.settings) return;
  const list = s.peers.filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q.replace(/\s/g, '')) || p.host?.includes(q));
  // Solo se redibuja si cambia algo: si no, un clic puede perderse a medias.
  const sig = JSON.stringify(list);
  if (sig !== drawn) $('peers').replaceChildren(...list.map((p) => el('li', { className: 'peer' },
    el('span', { className: 'dot ' + (p.online ? 'on' : ''), title: p.online ? 'En línea' : 'No visible en la red' }),
    el('div', { className: 'who' }, el('b', { textContent: p.name }), el('small', { textContent: `${fmt(p.id)} · ${p.host}${p.skew ? ' · tiene mal la fecha u hora' : ''}` })),
    ...(p.saved ? [el('button', { className: 'ghost', textContent: 'Renombrar', onclick: () => rename(p) }), el('button', { className: 'ghost', textContent: 'Quitar', onclick: () => api.invoke('home:forget', p.id) })] : []),
    el('button', { className: 'primary', textContent: 'Conectar', onclick: () => connect(p.id) }))));
  drawn = sig;
  $('nopeers').hidden = !!list.length;
  $('audit').replaceChildren(...s.audit.map((a) => el('tr', {}, el('td', { textContent: new Date(a.at).toLocaleString('es') }), el('td', { textContent: EVENTS[a.event] || a.event }), el('td', { textContent: detail(a) }))));
  $('haspw').textContent = s.hasPassword ? 'Hay una contraseña configurada.' : 'Sin contraseña: solo se entra si alguien acepta en pantalla.';
  $('delpw').hidden = !s.hasPassword;
  $('ver').textContent = `${s.brand.appName} ${s.version} · puerto ${s.port}`;
  if (!loaded) {
    loaded = true;
    $('s-name').value = s.settings.name;
    for (const k of ['allowIncoming', 'allowApproval', 'autostart']) $('s-' + k).checked = s.settings[k];
    for (const k of ['control', 'clipboard', 'files']) $('u-' + k).checked = s.settings.unattended[k];
  }
}
async function connect(t) { $('cerr').textContent = (await api.invoke('home:connect', t)) || ''; }
let renaming = null;
function rename(p) { renaming = p; $('r-name').value = p.name; $('dlg').showModal(); }
$('dlg').onclose = () => { if ($('dlg').returnValue === 'ok') api.invoke('home:alias', renaming.id, $('r-name').value); };

$('cform').onsubmit = (e) => { e.preventDefault(); connect($('target').value); };
$('filter').oninput = () => render(st);
$('gen').onclick = async () => { $('key').value = await api.invoke('home:genkey'); $('keynote').hidden = false; $('key').select(); };
$('sform').onsubmit = async (e) => { e.preventDefault(); $('serr').textContent = (await api.invoke('home:setup', $('key').value)) || ''; if (!$('serr').textContent) $('key').value = ''; };
$('pwform').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('pw1').value !== $('pw2').value ? 'Las contraseñas no coinciden.' : await api.invoke('home:password', $('pw1').value);
  $('pwerr').textContent = err || 'Contraseña guardada.';
  if (!err) $('pw1').value = $('pw2').value = '';
};
$('delpw').onclick = () => api.invoke('home:password', null);
$('folder').onclick = () => api.invoke('home:folder');
$('openlog').onclick = () => api.invoke('home:log');
$('setform').onsubmit = async (e) => {
  e.preventDefault();
  const g = (id) => $(id).checked;
  await api.invoke('home:settings', { name: $('s-name').value, allowIncoming: g('s-allowIncoming'), allowApproval: g('s-allowApproval'), autostart: g('s-autostart'), unattended: { control: g('u-control'), clipboard: g('u-clipboard'), files: g('u-files') } });
  $('setok').textContent = 'Guardado.';
  setTimeout(() => { $('setok').textContent = ''; }, 2500);
};
$('rekey').onsubmit = async (e) => { e.preventDefault(); $('rkerr').textContent = (await api.invoke('home:setup', $('newkey').value)) || 'Clave cambiada.'; $('newkey').value = ''; };
for (const b of document.querySelectorAll('nav button')) b.onclick = () => {
  for (const x of document.querySelectorAll('nav button')) x.setAttribute('aria-current', x === b);
  for (const p of document.querySelectorAll('.tab')) p.hidden = p.id !== b.dataset.tab;
};
api.on('home:state', render);
api.invoke('home:state').then(render);
