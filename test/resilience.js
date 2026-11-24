'use strict';
// Intenta romper la aplicacion real: caidas de ventanas, cierre, reconexion, configuracion danada, red lenta...
// npm run resilience   (o: node test/resilience.js caso1,caso2)
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const electron = require('electron');
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-res-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout: ' + what); await wait(100); } }
let np = Number(process.env.RD_BASE || 47710), nd = 0, failures = 0;
const envFor = (prof, port, extra) => ({ ...process.env, RD_PROFILE: prof, RD_PORT: String(port), RD_UDP: '47799', ...extra });

async function launch(name) {
  const port = np++, prof = path.join(tmp, name + nd++);
  const a = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env: envFor(prof, port) });
  const page = (f) => until(() => a.windows().find((w) => w.url().endsWith(f)), name + ' ' + f);
  const home = await page('home.html');
  await home.waitForFunction(() => document.getElementById('myid').textContent.length > 8);
  return { a, page, home, port, prof, kill: () => a.evaluate(({ app }) => app.exit(0)).catch(() => {}) };
}
const crash = (A, f) => A.a.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith(f)).webContents.forcefullyCrashRenderer(), f);
async function accept(H) {
  const p = await until(async () => { for (const w of H.a.windows()) if (w.url().endsWith('panel.html') && (await w.$('#accept').catch(() => null))) return w; }, 'peticion en pantalla', 12000);
  await p.click('#accept');
  return p;
}
async function session(H, V, port = H.port) {
  await V.home.fill('#target', '127.0.0.1:' + port);
  await V.home.click('#cform .primary');
  const viewer = await V.page('viewer.html');
  const panel = await accept(H);
  await viewer.waitForSelector('#bar:not([hidden])');
  await until(() => viewer.evaluate(() => document.getElementById('screen').width > 100), 'video');
  return { viewer, panel };
}
/** Copia sin herramienta de pruebas conectada, con el gancho de hook-quit.js. */
function bare(prof, port, hook, ms = 4000) {
  const p = spawn(electron, ['-r', path.join(__dirname, 'hook-quit.js'), root], { cwd: root, env: envFor(prof, port, { RD_HOOK: hook, RD_HOOK_MS: String(ms) }) });
  const r = { p, code: null, fired: 0, ended: 0 };
  p.stdout.on('data', (d) => { if (/HOOK/.test(d)) r.fired = Date.now(); });
  p.on('exit', (c) => { r.code = c; r.ended = Date.now(); });
  return r;
}
const isOpen = (port) => new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
const table = () => ['TCP', 'TCPv6'].map((p) => execFileSync('netstat', ['-ano', '-p', p]).toString()).join('\n').split('\n').map((l) => l.trim().split(/\s+/));
const conns = (port) => table().filter((x) => x[3] === 'ESTABLISHED' && x[1]?.endsWith(':' + port)).length;
const listener = (port) => table().find((x) => x[3] === 'LISTENING' && x[1]?.endsWith(':' + port))?.[4];
const out = (n, bad, d) => { if (bad) failures++; console.log(`${bad ? 'FALLO ' : 'bien  '} ${n}: ${d}`); };
const noise = (A, w, h, css, n) => A.home.evaluate(({ w, h, css, n }) => {
  const c = document.createElement('canvas');
  c.style.cssText = css; c.width = w; c.height = h;
  document.body.append(c);
  const x = c.getContext('2d');
  (function f() { for (let i = 0; i < n; i++) { x.fillStyle = `hsl(${Math.random() * 360} 80% 50%)`; x.fillRect(Math.random() * w, Math.random() * h, 60, 40); } requestAnimationFrame(f); })();
}, { w, h, css, n });
const showHome = (A, max) => A.a.evaluate(({ BrowserWindow }, max) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('home.html')); if (max) { w.setAlwaysOnTop(true); w.maximize(); } w.show(); }, max);

const T = {
  async caidaPanel() {
    const H = await launch('h'), V = await launch('v');
    const key = require('koffi').load('user32.dll').func('short __stdcall GetAsyncKeyState(int k)');
    try {
      const { viewer } = await session(H, V);
      const probe = async () => {
        await viewer.evaluate(() => msg({ t: 'in', k: 'key', code: 'ShiftRight', down: true }));
        let ok = false;
        for (let i = 0; i < 20 && !ok; i++) { await wait(25); ok = key(0xA1) < 0; }
        await viewer.evaluate(() => msg({ t: 'in', k: 'release' }));
        await wait(150);
        return ok;
      };
      const before = await probe();
      await crash(H, 'panel.html');
      await wait(2000);
      const after = await probe(), st = await viewer.evaluate(() => live), txt = await viewer.textContent('#status');
      await viewer.click('#again');
      await accept(H);
      await viewer.waitForSelector('#bar:not([hidden])');
      const again = await probe();
      out('se cae la ventana de aviso del equipo controlado', !before || after || st || !again, `control antes=${before}, despues=${after} ("${txt}"), se puede volver a entrar=${again}`);
    } finally { await V.kill(); await H.kill(); }
  },
  async cuelguePanel() {
    const H = await launch('h'), V = await launch('v');
    try {
      const { viewer, panel } = await session(H, V);
      panel.evaluate(() => { for (;;); }).catch(() => {});
      const t = Date.now();
      await until(async () => !(await viewer.evaluate(() => live)), 'corte', 25000).catch(() => {});
      const st = await viewer.evaluate(() => live);
      out('se cuelga la ventana de aviso', st, st ? 'la sesion sigue' : 'cortada en ' + Math.round((Date.now() - t) / 1000) + ' s');
    } finally { await V.kill(); H.a.process().kill(); }
  },
  async clavesMalas() {
    const { SecureChannel, createIdentity, loadIdentity, deriveNetKey } = require('../src/channel');
    const H = await launch('h'), V = await launch('v');
    try {
      for (let i = 0; i < 12; i++) { // clave equivocada y, despues, tramas manipuladas
        const sock = net.connect(H.port, '127.0.0.1');
        sock.on('error', () => {});
        await new Promise((r) => sock.once('connect', r));
        const p = SecureChannel.handshake(sock, { role: 'client', identity: loadIdentity(createIdentity()), netKey: deriveNetKey(i % 2 ? 'otro-programa' : require('../branding/branding.json').appId), name: 'x' }).catch(() => null);
        await wait(60);
        sock.write(Buffer.concat([Buffer.from([0, 0, 0, 60]), Buffer.alloc(60, i)]));
        await p;
        await wait(60);
        sock.destroy();
      }
      await session(H, V);
      out('12 ataques con clave o trafico falsos', false, 'y despues entra un usuario normal');
    } finally { await V.kill(); await H.kill(); }
  },
  async dobleReconexion() {
    const H = await launch('h'), V = await launch('v');
    try {
      const { viewer, panel } = await session(H, V);
      await panel.click('.danger');
      await viewer.waitForSelector('#again:not([hidden])');
      await viewer.evaluate(() => { for (let i = 0; i < 5; i++) api.send('viewer:reconnect'); });
      await wait(2500);
      const asks = await panel.evaluate(() => document.querySelectorAll('#accept').length);
      await V.a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('viewer.html')).close());
      await wait(3000);
      const left = conns(H.port);
      out('cinco reconexiones seguidas', asks > 1 || left > 0, `peticiones en pantalla: ${asks}; conexiones tras cerrar el visor: ${left}`);
    } finally { await V.kill(); await H.kill(); }
  },
  async salir() {
    const H = await launch('h'), V = await launch('v');
    await H.home.evaluate(() => api.invoke('home:password', 'Auditoria-123'));
    await H.kill();
    await wait(1500);
    const b = bare(H.prof, H.port, 'quit', 12000);
    try {
      await wait(4000);
      await V.home.fill('#target', '127.0.0.1:' + H.port);
      await V.home.click('#cform .primary');
      const viewer = await V.page('viewer.html');
      await viewer.waitForSelector('#auth:not([hidden])');
      await viewer.fill('#pw', 'Auditoria-123');
      await viewer.click('#auth button');
      await viewer.waitForSelector('#bar:not([hidden])');
      await until(() => b.fired, 'salir', 20000);
      await until(() => b.ended, 'cierre', 7000).catch(() => {});
      await wait(500);
      out('Salir con una sesion abierta', !b.ended || b.code !== 0, b.ended ? `cierra en ${b.ended - b.fired} ms; visor: ${await viewer.textContent('#status')}` : 'el proceso sigue vivo');
    } finally { if (!b.ended) b.p.kill(); await V.kill(); }
  },
  async reabrir() {
    const H = await launch('h');
    await H.kill();
    await wait(1500);
    const a = bare(H.prof, H.port, 'quit');
    await wait(3000);
    const during = await isOpen(H.port);
    await until(() => a.ended, 'salida', 9000).catch(() => {});
    const after = await isOpen(H.port);
    const b = bare(H.prof, H.port, 'quit');
    await wait(3000);
    const again = await isOpen(H.port);
    await until(() => b.ended, 'salida', 9000).catch(() => {});
    if (!a.ended) a.p.kill();
    if (!b.ended) b.p.kill();
    out('Salir y volver a abrir', !during || after || !again || a.code !== 0, `recibe: abierto=${during}, tras Salir=${after}, al reabrir=${again}`);
  },
  async visorCae() {
    const H = await launch('h'), V = await launch('v');
    try {
      await session(H, V);
      await crash(V, 'viewer.html');
      await wait(3000);
      const n = conns(H.port), w = V.a.windows().some((x) => x.url().endsWith('viewer.html') && !x.isClosed());
      out('se cae la ventana del visor', n > 0 || w, `conexiones abiertas: ${n}, ventana en blanco=${w}`);
    } finally { await V.kill(); await H.kill(); }
  },
  async homeCae() {
    const H = await launch('h');
    try {
      await crash(H, 'home.html');
      await wait(3000);
      const ok = await H.a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().endsWith('home.html') && !w.webContents.isCrashed() && w.isVisible()));
      out('se cae la ventana principal', !ok, ok ? 'se recrea sola' : 'no vuelve');
    } finally { await H.kill(); }
  },
  async configDanada() {
    const H = await launch('h'), file = path.join(H.prof, 'config.json');
    const id = await H.home.textContent('#myid');
    await H.kill();
    await wait(1500);
    const go = async () => {
      const a = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env: envFor(H.prof, H.port) });
      const w = await until(() => a.windows().find((x) => x.url().endsWith('home.html')), 'home');
      await until(() => w.evaluate(() => typeof st !== 'undefined' && st !== null), 'estado');
      return { w, end: async () => { await a.evaluate(({ app }) => app.exit(0)).catch(() => {}); await wait(1500); } };
    };
    fs.writeFileSync(file, '{"settings":{"na');
    let r = await go();
    const id2 = await r.w.textContent('#myid'), m1 = await r.w.textContent('#problem');
    await r.end();
    out('arranque con configuracion danada', id !== id2 || !/recuperado/.test(m1), `mismo ID=${id === id2}, aviso: ${m1}`);
    const c = JSON.parse(fs.readFileSync(file));
    for (const k of Object.keys(c.secrets)) c.secrets[k] = Buffer.from('v10basura-que-no-se-puede-abrir').toString('base64');
    fs.writeFileSync(file, JSON.stringify(c));
    r = await go();
    const m2 = await r.w.textContent('#problem');
    await r.end();
    out('arranque con claves que Windows no abre', !/Windows no pudo/.test(m2), `aviso: ${m2.slice(0, 55)}...`);
  },
  async errorGrave() {
    const H = await launch('h');
    await H.kill();
    await wait(1500);
    const b = bare(H.prof, H.port, 'throw');
    await until(() => b.ended, 'salida', 12000).catch(() => {});
    if (!b.ended) b.p.kill();
    await wait(3500);
    const f = path.join(H.prof, 'app.log');
    const logged = fs.existsSync(f) && /fallo provocado/.test(fs.readFileSync(f, 'utf8')), pid = listener(H.port);
    if (pid) try { execFileSync('taskkill', ['/PID', pid, '/T', '/F']); } catch { /* ya salio */ }
    out('error grave inesperado', !logged || !pid, `apuntado en el registro=${logged}, codigo=${b.code}, se reinicia solo=${!!pid}`);
  },
  async ajustesRapidos() {
    const H = await launch('h');
    try {
      const r = await H.home.evaluate(async () => {
        const s = (n, on) => api.invoke('home:settings', { name: n, allowIncoming: on, allowApproval: true, unattended: {} }).catch((e) => 'ERR ' + e.message);
        await Promise.all([s('A', true), s('B', false), s('C', true), s('D', false), s('E', true)]);
        await new Promise((x) => setTimeout(x, 1500));
        const st = await api.invoke('home:state');
        return { problem: st.problem, listening: st.listening, name: st.settings.name };
      });
      out('guardar ajustes cinco veces a la vez', r.problem || !r.listening || r.name !== 'E', JSON.stringify(r));
    } finally { await H.kill(); }
  },
  async redLenta() {
    const H = await launch('h'), V = await launch('v');
    const RATE = 1.5e6 / 8, st = { max: 0, q: 0 };
    const px = net.createServer((c) => {
      const h = net.connect(H.port, '127.0.0.1'), q = [];
      c.on('error', () => {});
      h.on('error', () => {});
      c.on('data', (d) => setTimeout(() => h.destroyed || h.write(d), 20));
      h.on('data', (d) => { q.push(d); st.q += d.length; st.max = Math.max(st.max, st.q); });
      const tick = setInterval(() => {
        let n = RATE / 50;
        while (n > 0 && q.length) { const d = q[0].subarray(0, n); n -= d.length; st.q -= d.length; if (d.length === q[0].length) q.shift(); else q[0] = q[0].subarray(d.length); if (!c.destroyed) c.write(d); }
      }, 20);
      const end = () => { clearInterval(tick); c.destroy(); h.destroy(); };
      c.on('close', end);
      h.on('close', end);
    });
    await new Promise((r) => px.listen(0, '127.0.0.1', r));
    try {
      const { viewer } = await session(H, V, px.address().port);
      await showHome(H, true);
      await noise(H, 480, 270, 'position:fixed;inset:0;z-index:99;width:100%;height:100%', 60);
      await wait(5000);
      st.max = 0;
      let fr = 0, sum = 0;
      for (let i = 0; i < 15; i++) { sum += st.q; await wait(1000); fr += Number((await viewer.textContent('#stats')).split(' ')[0]) || 0; }
      const alive = await viewer.evaluate(() => live);
      out('red de 1,5 Mbps con pantalla muy movida', !alive || sum / 15 / RATE > 1.5, `retraso medio ${(sum / 15 / RATE).toFixed(1)} s, maximo ${(st.max / RATE).toFixed(1)} s, ${(fr / 15).toFixed(1)} fps`);
    } finally { await V.kill(); await H.kill(); px.close(); }
  },
  async cambiosDeCalidad() {
    const H = await launch('h'), V = await launch('v');
    try {
      const { viewer, panel } = await session(H, V);
      await showHome(H, true);
      await noise(H, 480, 270, 'position:fixed;inset:0;z-index:99;width:100%;height:100%', 8);
      await wait(1500);
      // El visor cuenta las imagenes que pinta de verdad.
      await viewer.evaluate(() => { window.painted = 0; const d = ctx.drawImage.bind(ctx); ctx.drawImage = (...x) => { window.painted++; return d(...x); }; });
      let stuck = 0, worst = 0;
      for (let i = 0; i < 40; i++) {
        await viewer.selectOption('#quality', ['sharp', 'balanced', 'fast'][i % 3]);
        if (i % 4 === 0) await viewer.selectOption('#quality', 'balanced'); // dos cambios pegados
        await wait(400);
        const n = await viewer.evaluate(() => window.painted), t = Date.now();
        const ok = await until(() => viewer.evaluate((n) => window.painted > n + 2, n), 'imagen', 5000).catch(() => false);
        worst = Math.max(worst, Date.now() - t);
        if (!ok) {
          stuck++;
          console.log('        cambio', i, await viewer.evaluate(() => JSON.stringify({ conf, waitKey, dec: dec?.state, q: dec?.decodeQueueSize })), await panel.evaluate(() => JSON.stringify([...caps.values()].map((c) => ({ q: c.o.quality, sent: c.sent, acked: c.acked, frames: c.frames, enc: c.enc?.state, key: c.needKey, pend: !!c.pending })))));
        }
      }
      out('40 cambios de calidad seguidos', stuck > 0, stuck + ' congelaciones; la peor espera de imagen nueva, ' + worst + ' ms');
    } finally { await V.kill(); await H.kill(); }
  },
  async prolongado() { // no va en la lista por defecto: RD_MIN=minutos
    const H = await launch('h'), V = await launch('v'), min = Number(process.env.RD_MIN || 4);
    const mem = async (A) => (await A.a.evaluate(({ app }) => app.getAppMetrics().map((m) => m.memory.workingSetSize / 1024))).reduce((a, b) => a + b, 0);
    try {
      const { viewer } = await session(H, V);
      await showHome(H, false);
      await noise(H, 900, 600, 'position:fixed;inset:0;z-index:99', 3);
      await wait(20000);
      const h0 = await mem(H), v0 = await mem(V);
      for (let i = 0; i < min * 2; i++) {
        await wait(30000);
        if (i % 2) await viewer.selectOption('#quality', i % 4 === 1 ? 'sharp' : 'balanced');
        console.log(`        ${((i + 1) / 2).toFixed(1)} min  host ${(await mem(H)).toFixed(0)} MB  visor ${(await mem(V)).toFixed(0)} MB  ${await viewer.textContent('#stats')}`);
      }
      const h1 = await mem(H), v1 = await mem(V);
      out(min + ' minutos seguidos', h1 - h0 > 150 || v1 - v0 > 150 || !(await viewer.evaluate(() => live)), `host ${h0.toFixed(0)}->${h1.toFixed(0)} MB, visor ${v0.toFixed(0)}->${v1.toFixed(0)} MB`);
    } finally { await V.kill(); await H.kill(); }
  },
};
(async () => {
  const list = process.argv[2] ? process.argv[2].split(',') : Object.keys(T).filter((k) => k !== 'prolongado');
  for (const n of list) { try { await T[n](); } catch (e) { failures++; console.log('ERROR ', n, e.message.split('\n')[0]); } await wait(800); }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temporal */ }
  console.log(failures ? failures + ' FALLOS' : 'RESISTENCIA COMPLETA');
  process.exit(failures ? 1 : 0);
})();
