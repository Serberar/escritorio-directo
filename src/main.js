'use strict';
const { app, BrowserWindow, ipcMain, safeStorage, screen, desktopCapturer, clipboard, dialog, powerMonitor, Tray, Menu, nativeImage, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { clearCryptoErrors, createIdentity, loadIdentity, deriveNetKey, cleanName } = require('./channel');
const { HostServer, ViewerSession, PasswordGate, AskGate, makePassword, weakPassword, MAX_TEXT } = require('./sessions');
const { Discovery } = require('./discovery');
const { Wan } = require('./wan');
const { Config } = require('./config');
const { RotatingFile } = require('./log');

const ROOT = path.join(__dirname, '..');
const brand = JSON.parse(fs.readFileSync(path.join(ROOT, 'branding', 'branding.json'), 'utf8'));
const dev = !app.isPackaged;
// Solo en desarrollo: permite abrir dos copias en el mismo equipo para probar.
if (dev && process.env.RD_PROFILE) app.setPath('userData', path.resolve(process.env.RD_PROFILE));
app.setAppUserModelId(brand.appId);
const PORT = (dev && Number(process.env.RD_PORT)) || brand.port || 47600;
const UDP = (dev && Number(process.env.RD_UDP)) || brand.discoveryPort || 47601;

let livePort = PORT;
let cfg, identity, injector, server, discovery, wan, home, panel, tray;
let quitting = false, screens = [], lastClip = '', panelKey = '', panelReady = false, panelBeat = 0, netChain = Promise.resolve();
const problems = new Map(); // origen -> texto
const crashes = [];
const log = new RotatingFile(path.join(app.getPath('userData'), 'app.log'), 1024 * 1024);
const note = (what, e) => log.append(`${new Date().toISOString()} ${what}: ${e?.stack || e?.message || e || ''}`);
process.on('unhandledRejection', (e) => note('rechazo sin capturar', e));
process.on('uncaughtException', (e) => fatal(e));
const gate = new PasswordGate(), askGate = new AskGate();
const asks = new Map();    // sid -> resolver
const viewers = new Map(); // webContents.id -> { win, session, target }

const iconPath = path.join(ROOT, 'branding', 'icon.png');
const downloadsDir = () => path.join(app.getPath('downloads'), brand.appName.replace(/[<>:"/\\|?*]/g, '_'));
const netKey = deriveNetKey(brand.appId);

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(main).catch((e) => { note('no arranca', e); dialog.showErrorBox(brand.appName, 'El programa no puede arrancar.\n\n' + String(e.message || e)); app.exit(1); });

/** Error inesperado: se apunta, se cortan las sesiones y se reinicia (como mucho una vez por minuto). */
function fatal(e) {
  note('error grave', e);
  const mark = path.join(app.getPath('userData'), 'ultimo-reinicio');
  let last = 0;
  try { last = Number(fs.readFileSync(mark, 'utf8')) || 0; } catch { /* primer fallo */ }
  try { shutdown(); } catch { /* se sale igualmente */ }
  if (Date.now() - last > 60_000) {
    try { fs.writeFileSync(mark, String(Date.now())); app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== '--hidden'), '--hidden'] }); } catch { /* sin reinicio */ }
  }
  app.exit(1);
}
/** Cierra de verdad: deja de escuchar, corta sesiones y sale aunque algo se atasque. */
function shutdown() {
  if (quitting) return;
  quitting = true;
  if (panel && !panel.isDestroyed()) panel.setClosable(true); // si no, Windows no deja cerrarla y el proceso sigue vivo
  server?.close();
  for (const v of viewers.values()) v.session?.end();
  discovery?.stop();
  wan?.stop();
  tray?.destroy();
  setTimeout(() => app.exit(0), 3000);
}

// ---------------------------------------------------------------- arranque
async function main() {
  cfg = new Config(app.getPath('userData'), safeStorage, {
    settings: { name: os.hostname(), allowIncoming: true, internet: true, allowApproval: true, autostart: false, unattended: { control: true, clipboard: true, files: true } },
  });
  // Sin cifrado disponible no se toca nada: se perderian la identidad y las claves.
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Windows no permite usar el cifrado de esta cuenta. Cierra sesión y vuelve a entrar.');
  await cfg.init();
  if (cfg.recovered) {
    cfg.audit('config_recovered', { msg: cfg.recovered });
    problems.set('config', cfg.recovered === 'copia' ? 'La configuración estaba dañada y se ha recuperado de la copia.' : 'La configuración estaba dañada y se ha empezado de cero. Revisa los ajustes.');
  }
  if (cfg.lost.length) {
    if (!clearCryptoErrors()) throw new Error('El cifrado de Windows no responde. Reinicia el equipo.');
    cfg.audit('secret_lost', { msg: cfg.lost.join(', ') });
    problems.set('secrets', 'Windows no pudo abrir las claves guardadas (pasa al restablecer la contraseña de Windows). Vuelve a poner la contraseña. Si cambió el ID de este equipo, avisa a quien lo use.');
  }
  try { identity = loadIdentity(cfg.getSecret('identity')); } catch {
    const fresh = createIdentity();
    await cfg.setSecret('identity', fresh);
    identity = loadIdentity(fresh);
  }
  // Hasta la 0.2 habia una clave de empresa y los ID se calculaban de otra forma: los contactos ya no valen.
  if (cfg.getSecret('companyKey')) { await cfg.setSecret('companyKey', null); cfg.data.contacts = {}; cfg.save(); }
  checkSave();
  try { injector = new (require('./input-win').Injector)(); } catch (e) {
    injector = { handle() {}, release() {} };
    note('control de raton y teclado', e);
    problems.set('input', 'No se pudo cargar el control de ratón y teclado: ' + e.message);
  }
  const allowed = (wc, perm) => (perm === 'display-capture' && wc === panel?.webContents)
    || ((perm === 'fullscreen' || perm === 'keyboardLock') && !!wc && viewers.has(wc.id));
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allowed(wc, perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => allowed(wc, perm));
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
  });
  Menu.setApplicationMenu(null);
  // El portable cambia de carpeta con cada version: se renueva la ruta de arranque.
  if (!dev && cfg.data.settings.autostart) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  await refreshScreens();
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => refreshScreens().catch(() => {}));

  createHome(!process.argv.includes('--hidden'));
  createPanel();
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip(brand.appName);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir ' + brand.appName, click: showHome }, { type: 'separator' }, { label: 'Salir', click: () => app.quit() },
  ]));
  tray.on('click', showHome);
  app.on('second-instance', showHome);
  app.on('window-all-closed', () => {});
  app.on('before-quit', shutdown);
  app.on('child-process-gone', (_e, d) => note('proceso auxiliar caido', `${d.type} ${d.reason}`));
  setInterval(watchPanel, 2000);
  await startNetwork();
  powerMonitor.on('resume', () => startNetwork()); // tras suspender, la red suele ser otra
  setInterval(pollClipboard, 700);
}

function win(file, opts) {
  const w = new BrowserWindow({
    show: false, icon: iconPath, title: brand.appName, autoHideMenuBar: true, backgroundColor: '#14171c', ...opts,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  w.loadFile(path.join(ROOT, 'ui', file));
  return w;
}
function createHome(show) {
  home = win('home.html', { width: 980, height: 680, minWidth: 560, minHeight: 480 });
  if (show) home.once('ready-to-show', () => home.show());
  home.on('close', (e) => { if (!quitting) { e.preventDefault(); home.hide(); } });
  home.on('session-end', () => { shutdown(); app.quit(); }); // Windows se apaga o cierra sesion
  home.webContents.on('render-process-gone', (_e, d) => {
    if (quitting) return;
    note('ventana principal caida', d.reason);
    const visible = home.isVisible();
    home.destroy();
    setTimeout(() => { if (!quitting) createHome(visible); }, backoff());
  });
}
/** Espera antes de recrear una ventana caida; crece si se cae una y otra vez. */
function backoff() {
  const now = Date.now();
  crashes.push(now);
  return crashes.filter((t) => now - t < 60_000).length > 5 ? 30_000 : 500;
}
function checkSave() {
  if (cfg.saveError) problems.set('save', 'No se pudo guardar la configuración (' + cfg.saveError + '). Los cambios se perderán al cerrar.');
  else problems.delete('save');
}
function showHome() {
  if (quitting || !home || home.isDestroyed()) return;
  home.show(); if (home.isMinimized()) home.restore();
  home.focus();
}
function createPanel() {
  // Ventana del equipo controlado: visible durante toda la sesion, no se puede cerrar.
  panel = win('panel.html', { width: 340, height: 440, closable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true, title: brand.appName + ' - sesión' });
  panel.on('close', (e) => { if (!quitting) e.preventDefault(); });
  const mine = panel;
  panel.webContents.on('render-process-gone', (_e, d) => { if (panel === mine) panelLost(d.reason); });
  panel.webContents.on('did-fail-load', (_e, code) => { if (panel === mine) panelLost('carga ' + code); });
}
/** Sin ventana de aviso no hay control remoto: se cortan las sesiones y se vuelve a crear. */
function panelLost(why) {
  if (quitting) return;
  note('ventana de sesion caida', why);
  panelReady = false;
  panelKey = '';
  const sessions = [...(server?.sessions.values() ?? [])];
  if (sessions.length) cfg.audit('panel_lost', { msg: why });
  for (const s of sessions) s.end('panel_lost');
  const old = panel;
  panel = null;
  if (old && !old.isDestroyed()) old.destroy();
  setTimeout(() => { if (!quitting && !panel) createPanel(); }, backoff());
}
let lastWatch = 0;
function watchPanel() {
  const now = Date.now();
  if (now - lastWatch > 6000) panelBeat = now; // el equipo estuvo suspendido: se da margen
  lastWatch = now;
  if (panelReady && server?.sessions.size && now - panelBeat > 10_000) panelLost('no responde');
}

/** Los cambios de red se aplican de uno en uno. */
function startNetwork() {
  netChain = netChain.then(applyNetwork).catch((e) => { note('red', e); problems.set('net', 'Error de red: ' + e.message); pushHome(); });
  return netChain;
}
async function applyNetwork() {
  if (quitting) return;
  if (server) { const old = server; server = null; await old.close(); }
  discovery?.stop();
  discovery = null;
  if (wan) { const old = wan; wan = null; await old.stop(); }
  const s = cfg.data.settings, name = cleanName(s.name);
  problems.delete('net');
  problems.delete('disc');
  if (s.allowIncoming) {
    const srv = new HostServer({ identity, netKey, name, deps: hostDeps() });
    srv.on('session', onHostSession);
    srv.on('change', pushPanel);
    // Con el puerto ocupado (otro usuario de Windows, otro programa) vale cualquier otro: se anuncia el que sea.
    for (const p of [PORT, 0]) {
      try { livePort = await srv.listen(p); server = srv; break; } catch (e) {
        if (e.code !== 'EADDRINUSE') { problems.set('net', 'No se puede escuchar en la red local: ' + e.code); break; }
      }
    }
    server ??= srv; // sin red local sigue recibiendo por internet
  }
  discovery = new Discovery({ netKey, id: identity.id, name, port: livePort, udpPort: UDP, silent: !server });
  discovery.on('change', pushHome);
  discovery.on('problem', (c) => { problems.set('disc', `El descubrimiento en red no funciona (${c}). Puedes conectar por IP.`); pushHome(); });
  discovery.start();
  if (s.internet) {
    const w = wan = new Wan({ netKey, id: identity.id, listen: !!server });
    let last = '';
    w.on('connection', (sock) => { if (wan === w && server) server.accept(sock); else sock.destroy(); });
    w.on('change', pushHome);
    w.on('problem', (e) => { const m = e?.message || String(e); if (m !== last) { last = m; note('internet', m); } });
    w.start();
  }
  pushHome();
}

async function refreshScreens() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const primary = screen.getPrimaryDisplay().id;
  const displays = screen.getAllDisplays();
  screens = sources.map((src, i) => {
    const d = displays.find((x) => String(x.id) === src.display_id) || displays[i] || displays[0];
    return { id: String(d.id), sourceId: src.id, primary: d.id === primary, rect: screen.dipToScreenRect(null, d.bounds), label: `Pantalla ${i + 1}` };
  }).sort((a, b) => b.primary - a.primary);
  for (const s of server?.sessions.values() ?? []) {
    if (!s.authorized) continue;
    s.ch.send({ t: 'screens', screens: publicScreens() });
    if (s.video) startCapture(s);
  }
}
const publicScreens = () => screens.map(({ id, label, primary }) => ({ id, label, primary }));

// ---------------------------------------------------------------- equipo controlado
function hostDeps() {
  return {
    password: () => { const p = cfg.getSecret('password'); return p ? JSON.parse(p) : null; },
    allowApproval: () => cfg.data.settings.allowApproval,
    unattendedPerms: () => cfg.data.settings.unattended,
    gate, asks: askGate, injector, downloadsDir, screens: publicScreens,
    audit: (e, d) => { cfg.audit(e, d); pushHome(); },
    askApproval: (s) => {
      let done;
      const result = new Promise((r) => { done = r; });
      const finish = (v) => { clearTimeout(timer); asks.delete(s.sid); done(v); pushPanel(); };
      const timer = setTimeout(() => finish(null), 45_000);
      asks.set(s.sid, finish);
      pushPanel();
      return { result, cancel: () => finish(null) };
    },
  };
}
const toPanel = (c, d) => { if (panel && !panel.isDestroyed()) panel.webContents.send(c, d); };
function onHostSession(s) {
  if (!panelReady) return s.end('not_ready'); // sin ventana de aviso no se admite a nadie
  s.on('granted', pushPanel);
  s.on('clip', setClip);
  s.on('chat', (text) => toPanel('panel:chat', { sid: s.sid, text }));
  s.on('file', (u) => {
    toPanel('panel:file', { sid: s.sid, ...u });
    if (u.state === 'done') cfg.audit('file_' + u.dir, { peer: s.peer.id, name: u.name, size: u.size });
  });
  s.on('close', () => toPanel('panel:stop', { sid: s.sid }));
  s.on('video', (m) => {
    if (m.t === 'v-ack') return Number.isInteger(m.seq) ? toPanel('panel:ack', { sid: s.sid, seq: m.seq }) : undefined;
    if (m.t === 'v-key') return toPanel('panel:key', { sid: s.sid });
    if (m.t === 'v-start') {
      const codecs = Array.isArray(m.codecs) ? m.codecs.filter((c) => typeof c === 'string').slice(0, 10) : [];
      s.video = { codecs, quality: 'balanced', screen: screens[0]?.id };
    }
    if (!s.video) return;
    if (['sharp', 'balanced', 'fast'].includes(m.quality)) s.video.quality = m.quality;
    if (m.t === 'v-screen') s.video.screen = String(m.id);
    startCapture(s);
  });
}
function startCapture(s) {
  const sc = screens.find((x) => x.id === s.video.screen) || screens[0];
  if (!sc) return;
  s.video.screen = sc.id;
  s.screenRect = sc.rect;
  toPanel('panel:start', { sid: s.sid, sourceId: sc.sourceId, width: sc.rect.width, height: sc.rect.height, quality: s.video.quality, codecs: s.video.codecs });
}
function pushPanel() {
  if (!panel || panel.isDestroyed()) return;
  const list = [...(server?.sessions.values() ?? [])].filter((s) => s.authorized || asks.has(s.sid))
    .map((s) => ({ sid: s.sid, id: s.peer.id, name: s.peer.name, ip: s.remoteAddress, internet: s.internet, active: s.authorized, perms: s.perms, since: s.since }));
  toPanel('panel:state', { list, brand });
  if (!list.length) { panelKey = ''; panel.hide(); return; }
  const key = list.map((x) => x.sid + x.active).join();
  if (key !== panelKey) {
    const wa = screen.getPrimaryDisplay().workArea, [w, h] = panel.getSize();
    panel.setPosition(wa.x + wa.width - w - 12, wa.y + wa.height - h - 12);
    panel.showInactive();
    if (list.some((x) => !x.active)) panel.flashFrame(true);
  }
  panelKey = key;
}
const fromPanel = (fn) => (e, ...a) => { if (e.sender === panel?.webContents) return fn(...a); };
const hostS = (sid) => server?.sessions.get(sid);
ipcMain.on('panel:ready', fromPanel(() => { panelReady = true; panelBeat = Date.now(); pushPanel(); }));
ipcMain.on('panel:beat', fromPanel(() => { panelBeat = Date.now(); }));
ipcMain.on('panel:decide', fromPanel((sid, perms) => asks.get(sid)?.(perms || null)));
ipcMain.on('panel:end', fromPanel((sid) => hostS(sid)?.end('host_closed')));
ipcMain.on('panel:perm', fromPanel((sid, k, v) => { hostS(sid)?.setPerm(k, v); pushPanel(); }));
ipcMain.on('panel:say', fromPanel((sid, text) => { const s = hostS(sid); if (s?.authorized) s.ch.send({ t: 'chat', text: String(text).slice(0, 2000) }); }));
ipcMain.on('panel:config', fromPanel((sid, c) => { const s = hostS(sid); if (s?.authorized) s.ch.send({ t: 'v-config', ...c }); }));
ipcMain.on('panel:frame', fromPanel((sid, buf) => hostS(sid)?.sendFrame(Buffer.from(buf))));
ipcMain.on('panel:error', fromPanel((sid, msg) => {
  note('captura', msg);
  const s = hostS(sid);
  if (s?.authorized) s.ch.send({ t: 'v-config', error: String(msg).slice(0, 200) });
}));
ipcMain.on('panel:sendfile', fromPanel(async (sid) => {
  const s = hostS(sid);
  if (!s?.authorized || !s.perms.files) return;
  const r = await dialog.showOpenDialog(panel, { properties: ['openFile', 'multiSelections'] });
  for (const f of r.filePaths) await s.files.send(f).catch(() => {});
}));

// ---------------------------------------------------------------- portapapeles
function setClip(text) { lastClip = text; clipboard.writeText(text); }
function pollClipboard() {
  const hosts = [...(server?.sessions.values() ?? [])].filter((s) => s.authorized && s.perms.clipboard);
  const focused = [...viewers.values()].find((v) => v.session?.granted && v.perms?.clipboard && !v.win.isDestroyed() && v.win.isFocused());
  const text = clipboard.readText();
  if (text.length > MAX_TEXT) return;
  const changed = text !== lastClip;
  lastClip = text; // se sigue siempre, para no enviar lo copiado antes de la sesion
  if (!text) return;
  if (changed) for (const s of hosts) s.ch.send({ t: 'clip', text });
  // Solo la sesion que el usuario tiene delante recibe su portapapeles.
  if (focused && focused.clip !== text) { focused.clip = text; focused.session.send({ t: 'clip', text }); }
}

// ---------------------------------------------------------------- equipo que controla
const REASONS = {
  rejected: 'La persona al otro lado rechazó la conexión o no respondió.', host_closed: 'El equipo remoto cerró la sesión.', auth_timeout: 'Se agotó el tiempo de espera.',
  bad_protocol: 'El otro equipo usa otra versión del programa. Actualiza los dos.', identity_mismatch: 'El equipo que respondió no es el que esperabas. Conexión cancelada por seguridad.',
  host_not_verified: 'El equipo remoto no pudo demostrar que conoce la contraseña.', connect_timeout: 'El equipo no responde. Comprueba la red y el firewall.',
  ECONNREFUSED: 'El equipo no acepta conexiones (programa cerrado o conexiones desactivadas).', ENOTFOUND: 'No se encuentra ese equipo.',
  EHOSTUNREACH: 'No hay ruta hasta ese equipo.', timeout: 'Se perdió la conexión.', closed: 'Se cerró la conexión.', ECONNRESET: 'Se cerró la conexión.', ETIMEDOUT: 'El equipo no responde. Comprueba la red y el firewall.', ENETUNREACH: 'No hay red hasta ese equipo.',
  panel_lost: 'El equipo remoto cortó la sesión por seguridad: su ventana de aviso dejó de funcionar.', not_ready: 'El equipo remoto está arrancando. Prueba en unos segundos.', replaced: 'Se abrió otra conexión desde este equipo.', remote_closed: 'La sesión terminó.',
  no_route: 'Ese ID no está visible en la red y la conexión por internet está desactivada. Actívala en Ajustes o prueba con su dirección IP.',
  wan_not_found: 'Ese equipo no está en línea. Comprueba el ID y que tiene el programa abierto y actualizado.',
  wan_blocked: 'El equipo está en línea, pero las dos redes no dejan abrir la conexión directa. Prueba desde otra red o con una VPN.',
  wan_unreachable: 'Este equipo no puede usar la conexión por internet: no hay internet o la red bloquea UDP.',
  wan_timeout: 'El equipo no responde por internet.', wan_failed: 'No se pudo conectar por internet.', bad_target: 'Escribe un ID de 9 cifras o una dirección IP.',
  self: 'Ese es este mismo equipo.', handshake_timeout: 'El otro equipo no completó la conexión segura.',
};
const explain = (r) => REASONS[r] || 'Conexión terminada (' + r + ').';

function resolveTarget(text) {
  const t = String(text ?? '').trim();
  const digits = t.replace(/[\s-]/g, '');
  if (/^\d{9}$/.test(digits)) {
    if (digits === identity.id) throw new Error('self');
    // Todas las vias a la vez; si el equipo se ve en la red local, internet espera un poco.
    const near = discovery?.peers.get(digits), known = cfg.data.contacts[digits], routes = [];
    for (const p of [near, known]) {
      if (p?.host && !routes.some((r) => r.host === p.host && r.port === (p.port || PORT))) routes.push({ host: p.host, port: p.port || PORT });
    }
    if (wan) routes.push({ wan, id: digits, delay: near ? 2500 : 0 });
    if (!routes.length) throw new Error('no_route');
    return { routes, expectId: digits, expectPub: known?.pub };
  }
  const m = t.match(/^([a-zA-Z0-9][\w.-]*)(?::(\d{1,5}))?$/);
  if (!m || Number(m[2]) > 65535) throw new Error('bad_target');
  return { routes: [{ host: m[1], port: Number(m[2]) || PORT }] };
}
function openViewer(target) {
  const w = win('viewer.html', { width: 1200, height: 780, minWidth: 480, minHeight: 360 });
  const v = { win: w, target, session: null, perms: null, gen: 0, clip: clipboard.readText() };
  const id = w.webContents.id;
  viewers.set(id, v);
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => { viewers.delete(id); v.gen++; v.session?.end(); });
  w.webContents.on('render-process-gone', (_e, d) => {
    if (quitting || w.isDestroyed()) return;
    note('visor caido', d.reason);
    w.destroy(); // "closed" corta la sesion
    dialog.showMessageBox({ type: 'warning', title: brand.appName, message: 'La ventana de la sesión dejó de funcionar y se ha cerrado.', detail: 'Vuelve a conectar desde la ventana principal.' }).catch(() => {});
  });
  w.on('blur', () => { if (v.session?.granted) v.session.send({ t: 'in', k: 'release' }); });
}
async function connectViewer(v) {
  const gen = ++v.gen; // solo cuenta el intento mas reciente
  const tell = (k, data) => { if (gen === v.gen && !v.win.isDestroyed()) v.win.webContents.send('viewer:event', { k, ...data }); };
  const prev = v.session;
  v.session = null;
  prev?.end();
  tell('status', { text: 'Conectando... Por internet puede tardar unos segundos.' });
  let s;
  try {
    s = await ViewerSession.connect({
      ...resolveTarget(v.target), identity, netKey, name: cleanName(cfg.data.settings.name), downloadsDir,
      acceptFile: async (f) => {
        if (v.win.isDestroyed()) return false;
        const r = await dialog.showMessageBox(v.win, { type: 'question', buttons: ['Guardar', 'Rechazar'], defaultId: 0, cancelId: 1, message: `${s.peer.name} quiere enviarte un archivo`, detail: `${f.name}\n${(f.size / 1048576).toFixed(2)} MB` });
        return r.response === 0;
      },
    });
  } catch (e) { return tell('closed', { text: explain(e.message) }); }
  if (gen !== v.gen || v.win.isDestroyed()) return s.end();
  v.session = s;
  s.on('welcome', (m) => {
    v.win.setTitle(`${s.peer.name} (${s.peer.id}) - ${brand.appName}`);
    const sock = s.ch.socket;
    cfg.data.contacts[s.peer.id] = { ...cfg.data.contacts[s.peer.id], id: s.peer.id, name: s.peer.name, pub: s.peer.pub, ...(sock.remoteAddress && !sock.internet && { host: sock.remoteAddress.replace(/^::ffff:/, ''), port: sock.remotePort }), last: Date.now() };
    cfg.save(); // si falla se avisa, pero la conexion sigue
    checkSave();
    pushHome();
    tell('welcome', { password: !!m.password, approval: !!m.approval, name: s.peer.name, id: s.peer.id });
  });
  s.on('granted', (m) => { v.perms = m.perms; cfg.audit('outgoing', { peer: s.peer.id, name: s.peer.name }); tell('granted', { perms: m.perms, screens: m.screens }); });
  s.on('denied', (r) => tell('denied', { reason: r }));
  s.on('info', (m) => { if (m.t === 'perms') v.perms = m.perms; tell(m.t, { data: m }); });
  s.on('frame', (buf) => { if (gen === v.gen && !v.win.isDestroyed()) v.win.webContents.send('viewer:frame', buf); });
  s.on('clip', (text) => { v.clip = text; setClip(text); });
  s.on('chat', (text) => tell('chat', { text }));
  s.on('file', (u) => tell('file', { u }));
  s.on('close', (r) => { if (v.session === s) { v.session = null; tell('closed', { text: explain(r) }); } });
  s.start();
}
const fromViewer = (fn) => (e, ...a) => { const v = viewers.get(e.sender.id); if (v) return fn(v, ...a); };
const VMSG = new Set(['in', 'v-start', 'v-ack', 'v-key', 'v-quality', 'v-screen', 'chat']);
ipcMain.on('viewer:ready', fromViewer((v) => { v.win.webContents.send('viewer:event', { k: 'brand', brand }); connectViewer(v); }));
ipcMain.on('viewer:reconnect', fromViewer((v) => connectViewer(v)));
ipcMain.on('viewer:ask', fromViewer((v) => v.session?.ask()));
ipcMain.on('viewer:password', fromViewer((v, pw) => v.session?.password(String(pw).slice(0, 256))));
ipcMain.on('viewer:msg', fromViewer((v, m) => { if (m && VMSG.has(m.t) && v.session?.granted) v.session.send(m); }));
ipcMain.on('viewer:end', fromViewer((v) => v.win.close()));
ipcMain.on('viewer:fullscreen', fromViewer((v) => v.win.setFullScreen(!v.win.isFullScreen())));
ipcMain.on('viewer:folder', fromViewer(() => openDownloads()));
ipcMain.on('viewer:files', fromViewer(async (v, paths) => {
  if (!v.session?.granted) return;
  if (!Array.isArray(paths)) paths = (await dialog.showOpenDialog(v.win, { properties: ['openFile', 'multiSelections'] })).filePaths;
  for (const p of paths) if (typeof p === 'string') await v.session?.files.send(p).catch(() => {});
}));
function openDownloads() { fs.mkdirSync(downloadsDir(), { recursive: true }); shell.openPath(downloadsDir()); }

// ---------------------------------------------------------------- ventana principal
function homeState() {
  const peers = new Map(Object.values(cfg.data.contacts).map((c) => [c.id, { id: c.id, name: c.alias || c.name, host: c.host, last: c.last, online: false, saved: true }]));
  for (const p of discovery?.peers.values() ?? []) peers.set(p.id, { ...peers.get(p.id), id: p.id, name: cfg.data.contacts[p.id]?.alias || p.name, host: p.host, online: true, skew: p.skew });
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  return {
    brand, version: app.getVersion(), id: identity.id, ips, port: livePort, problem: [...problems.values()].join(' ') || null,
    settings: cfg.data.settings, hasPassword: !!cfg.getSecret('password'), listening: !!server, internet: wan ? wan.state : 'off',
    peers: [...peers.values()].sort((a, b) => b.online - a.online || a.name.localeCompare(b.name)), audit: cfg.readAudit(60),
  };
}
function pushHome() { if (!quitting && identity && home && !home.isDestroyed()) home.webContents.send('home:state', homeState()); }
const fromHome = (fn) => (e, ...a) => { if (e.sender !== home?.webContents) throw new Error('no permitido'); return fn(...a); };
ipcMain.handle('home:state', fromHome(homeState));
ipcMain.handle('home:connect', fromHome((t) => {
  try { resolveTarget(t); } catch (e) { return explain(e.message); }
  openViewer(String(t));
  return null;
}));
ipcMain.handle('home:password', fromHome(async (pw) => {
  if (!pw) { await cfg.setSecret('password', null); checkSave(); pushHome(); return cfg.saveError ? 'No se pudo guardar.' : null; }
  const weak = weakPassword(String(pw));
  if (weak) return weak;
  await cfg.setSecret('password', JSON.stringify(await makePassword(String(pw))));
  checkSave();
  pushHome();
  return cfg.saveError ? 'No se pudo guardar en el disco.' : null;
}));
ipcMain.handle('home:settings', fromHome(async (s) => {
  const cur = cfg.data.settings;
  cfg.data.settings = {
    name: cleanName(s.name), allowIncoming: !!s.allowIncoming, internet: !!s.internet, allowApproval: !!s.allowApproval, autostart: !!s.autostart,
    unattended: { control: !!s.unattended?.control, clipboard: !!s.unattended?.clipboard, files: !!s.unattended?.files },
  };
  cfg.save();
  checkSave();
  if (!dev && cur.autostart !== cfg.data.settings.autostart) app.setLoginItemSettings({ openAtLogin: cfg.data.settings.autostart, args: ['--hidden'] });
  if (cur.name !== cfg.data.settings.name || cur.internet !== cfg.data.settings.internet || cur.allowIncoming !== cfg.data.settings.allowIncoming) await startNetwork(); else pushHome();
  return null;
}));
ipcMain.handle('home:alias', fromHome((id, alias) => { const c = cfg.data.contacts[id]; if (c) { c.alias = alias ? cleanName(alias) : undefined; cfg.save(); pushHome(); } }));
ipcMain.handle('home:forget', fromHome((id) => { delete cfg.data.contacts[id]; cfg.save(); pushHome(); }));
ipcMain.handle('home:folder', fromHome(() => openDownloads()));
ipcMain.handle('home:log', fromHome(() => shell.openPath(app.getPath('userData'))));
