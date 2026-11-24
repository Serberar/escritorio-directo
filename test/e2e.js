'use strict';
/**
 * Prueba real: abre dos copias del programa en este equipo, conecta una con otra por la red local,
 * comprueba video, raton, teclado (solo Mayus), chat, archivo, contrasena y corte desde el host.
 */
const { _electron } = require('playwright-core');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-e2e-'));
const shots = process.env.SHOTS;
const step = (s) => console.log('ok  ' + s);
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); }
}
// EXE=ruta prueba el programa empaquetado como equipo controlado (usa sus puertos reales).
const EXE = process.env.EXE, HPORT = EXE ? 47600 : 47690, UDP = EXE ? '47601' : '47691';
async function launch(name, port) {
  const exe = name === 'host' && EXE;
  const a = await _electron.launch({ executablePath: exe || require('electron'), args: exe ? ['--user-data-dir=' + path.join(tmp, name)] : [root], cwd: root, env: { ...process.env, RD_PROFILE: path.join(tmp, name), RD_PORT: String(port), RD_UDP: UDP } });
  a.process().stderr.on('data', (d) => process.env.DBG && console.log(name + ' ERR', String(d).slice(0, 600)));
  a.process().on('exit', (c, sg) => process.env.DBG && console.log(name, 'EXIT', c, sg));
  a.on('window', (w) => { w.on('crash', () => console.log(name, 'CRASH', w.url())); w.on('pageerror', (e) => console.log(name, 'PAGEERR', e.message)); w.on('console', (m) => process.env.DBG && console.log(name, m.type(), m.text())); });
  const page = (f) => until(() => a.windows().find((w) => w.url().endsWith(f)), name + ' ' + f);
  const home = await page('home.html');
  await home.waitForFunction(() => document.getElementById('myid').textContent.length > 8);
  return { a, page, home };
}
(async () => {
  const H = await launch('host', HPORT), V = await launch('visor', 47692);
  try {
    const id = (await H.home.textContent('#myid')).replace(/\s/g, '');
    step('dos equipos configurados, ID ' + id);
    await V.home.waitForSelector(`.peer:has-text("${id.slice(0, 3)} ${id.slice(3, 6)}") .dot.on`, { timeout: 20000 }).then(() => step('descubrimiento automatico en red'), () => console.log('AVISO descubrimiento UDP no visto entre dos copias del mismo equipo'));
    if (shots) for (const colorScheme of ['dark', 'light']) { await V.home.emulateMedia({ colorScheme }); await new Promise((r) => setTimeout(r, 300)); await V.home.screenshot({ path: path.join(shots, 'home-' + colorScheme + '.png') }); }

    // contrasena en el host
    await H.home.click('nav button:nth-child(2)');
    await H.home.fill('#pw1', 'Prueba-E2E-99'); await H.home.fill('#pw2', 'Prueba-E2E-99');
    await H.home.click('#pwform .primary');
    await until(async () => /guardada/.test(await H.home.textContent('#pwerr')), 'guardar contrasena');

    // conexion por IP con aprobacion
    await V.home.fill('#target', '127.0.0.1:' + HPORT);
    await V.home.click('#cform .primary');
    const viewer = await V.page('viewer.html');
    const panel = await H.page('panel.html');
    await panel.waitForSelector('#accept', { timeout: 10000 });
    if (shots) await panel.screenshot({ path: path.join(shots, 'panel-ask.png') });
    await panel.click('#accept');
    await viewer.waitForSelector('#bar:not([hidden])');
    step('aprobacion en pantalla');
    const size = await until(() => viewer.evaluate(() => { const c = document.getElementById('screen'); return c.width > 100 ? [c.width, c.height] : null; }), 'video');
    const varied = await viewer.evaluate(() => { const c = document.getElementById('screen'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const s = new Set(); for (let i = 0; i < d.length; i += 4 * 997) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return s.size; });
    if (varied < 5) throw new Error('imagen uniforme');
    const codec = await viewer.evaluate('conf.codec');
    step(`video ${size.join('x')} con ${codec}, ${varied} colores muestreados`);
    if (shots) { await viewer.evaluate(() => { canvas.style.visibility = 'hidden'; }); await viewer.screenshot({ path: path.join(shots, 'viewer.png') }); await viewer.evaluate(() => { canvas.style.visibility = ''; }); }

    // raton: se mueve a un punto y se compara, luego se restaura
    const cur = () => H.a.evaluate(({ screen }) => screen.getCursorScreenPoint());
    const before = await cur();
    const disp = await H.a.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    const send = (m) => viewer.evaluate((x) => msg(x), m);
    await send({ t: 'in', k: 'move', x: 0.4, y: 0.6 });
    await until(async () => { const p = await cur(); return Math.abs(p.x - (disp.x + disp.width * 0.4)) < 4 && Math.abs(p.y - (disp.y + disp.height * 0.6)) < 4; }, 'raton', 4000);
    await send({ t: 'in', k: 'move', x: (before.x - disp.x) / disp.width, y: (before.y - disp.y) / disp.height });
    step('raton en la posicion exacta');

    const others = await viewer.evaluate(() => [...document.getElementById('screens').options].slice(1).map((o) => o.value));
    for (const sid of others) {
      await viewer.selectOption('#screens', sid);
      const want = await H.a.evaluate(({ screen }, sid) => { const r = screen.dipToScreenRect(null, screen.getAllDisplays().find((d) => String(d.id) === sid).bounds); return { x: r.x + r.width * 0.3, y: r.y + r.height * 0.7 }; }, sid);
      const phys = () => H.a.evaluate(({ screen }) => screen.dipToScreenPoint(screen.getCursorScreenPoint()));
      await new Promise((r) => setTimeout(r, 400));
      await send({ t: 'in', k: 'move', x: 0.3, y: 0.7 });
      await until(async () => { const p = await phys(); return Math.abs(p.x - want.x) < 6 && Math.abs(p.y - want.y) < 6; }, 'raton en otra pantalla', 4000);
      step('raton exacto en otra pantalla');
    }
    if (others.length) { await viewer.selectOption('#screens', { index: 0 }); await new Promise((r) => setTimeout(r, 400)); await send({ t: 'in', k: 'move', x: (before.x - disp.x) / disp.width, y: (before.y - disp.y) / disp.height }); }

    // teclado: Mayus pulsada y soltada sola al perder el foco
    const koffi = require('koffi');
    const key = koffi.load('user32.dll').func('short __stdcall GetAsyncKeyState(int k)');
    await send({ t: 'in', k: 'key', code: 'ShiftLeft', down: true });
    await until(() => key(0x10) < 0, 'mayus pulsada', 3000);
    await send({ t: 'in', k: 'release' });
    await until(() => key(0x10) >= 0, 'mayus soltada', 3000);
    step('teclado y liberacion de teclas');

    await viewer.click('#chat');
    await viewer.fill('#text', 'hola desde el visor'); await viewer.click('#form button');
    await panel.waitForSelector('.log:has-text("hola desde el visor")');
    step('chat');

    const f = path.join(tmp, 'informe.bin'), data = require('node:crypto').randomBytes(3e6);
    fs.writeFileSync(f, data);
    await H.a.evaluate(({ app }, d) => app.setPath('downloads', d), path.join(tmp, 'dl'));
    await viewer.evaluate((p) => api.send('viewer:files', [p]), f);
    const got = await until(() => { const d = path.join(tmp, 'dl', require('../branding/branding.json').appName, 'informe.bin'); return fs.existsSync(d) && d; }, 'archivo');
    if (!fs.readFileSync(got).equals(data)) throw new Error('archivo distinto');
    step('archivo de 3 MB identico');

    // cortar desde el host
    await panel.click('.danger');
    await until(async () => /cerró la sesión/.test(await viewer.textContent('#status')), 'corte del host');
    step('el equipo controlado puede cortar');

    // reconectar con contrasena
    await viewer.click('#again');
    await viewer.waitForSelector('#auth:not([hidden])');
    await viewer.fill('#pw', 'incorrecta1'); await viewer.click('#auth button');
    await until(async () => /incorrecta/.test(await viewer.textContent('#status')), 'rechazo de contrasena');
    await viewer.fill('#pw', 'Prueba-E2E-99'); await viewer.click('#auth button');
    await viewer.waitForSelector('#bar:not([hidden])');
    await until(() => viewer.evaluate(() => !!conf && !waitKey), 'video tras reconectar');
    if (!(await H.a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().endsWith('panel.html') && w.isVisible())))) throw new Error('panel oculto durante la sesion');
    step('contrasena correcta/incorrecta y aviso visible');

    // calidad y medicion
    await viewer.selectOption('#quality', 'sharp');
    await until(() => viewer.evaluate((w) => document.getElementById('screen').width >= w, size[0]), 'cambio de calidad');
    step('cambio de calidad: ' + (await viewer.evaluate(() => { const c = document.getElementById('screen'); return c.width + 'x' + c.height; })));
    console.log('E2E COMPLETO');
  } catch (e) {
    if (process.env.DBG) {
      for (const n of ['host', 'visor']) { try { console.log(n, fs.readFileSync(path.join(tmp, n, 'audit.jsonl'), 'utf8')); } catch { /* sin registro */ } }
      const pg = H.a.windows().find((w) => w.url().endsWith('panel.html')), vw = V.a.windows().find((w) => w.url().endsWith('viewer.html'));
      if (pg) console.log('panel', await pg.evaluate(() => JSON.stringify([...caps.values()].map((c) => ({ o: c.o, sent: c.sent, acked: c.acked, frames: c.frames, enc: c.enc?.state, w: c.w, h: c.h, conf: c.conf, last: !!c.last })))).catch(String));
      if (vw) console.log('viewer', await vw.evaluate(() => JSON.stringify({ live, conf, waitKey, dec: dec?.state, q: dec?.decodeQueueSize, frames, st: document.getElementById('status').textContent, w: canvas.width })).catch(String));
    }
    throw e;
  } finally {
    await V.a.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await H.a.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch { /* que no tape el fallo real */ }
  }
})().catch((e) => { console.error('FALLO', e.message); process.exit(1); });
