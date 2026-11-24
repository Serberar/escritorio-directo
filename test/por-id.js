'use strict';
/** Programa completo: dos copias que no se ven en la red local se conectan solo con el ID, por internet. */
const { _electron } = require('playwright-core');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.join(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-id-'));
const step = (s) => console.log('ok  ' + s);
async function until(fn, what, ms = 40000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 150)); }
}
// EXE=ruta prueba el programa empaquetado como equipo controlado (usa sus puertos reales).
async function launch(name, port, udp) {
  const exe = name === 'host' && process.env.EXE;
  const a = await _electron.launch({ executablePath: exe || require('electron'), args: exe ? ['--user-data-dir=' + path.join(tmp, name)] : [root], cwd: root, env: { ...process.env, RD_PROFILE: path.join(tmp, name), RD_PORT: String(port), RD_UDP: String(udp) } });
  const page = (f) => until(() => a.windows().find((w) => w.url().endsWith(f)), name + ' ' + f);
  const home = await page('home.html');
  home.on('pageerror', (e) => console.log(name, 'ERROR', e.message));
  await home.waitForFunction(() => document.getElementById('myid').textContent.length > 8);
  return { a, page, home };
}
(async () => {
  const H = await launch('host', 47810, 47811), V = await launch('visor', 47820, 47821); // puertos de descubrimiento distintos: no se ven
  try {
    for (const x of [H, V]) await until(async () => /Accesible/.test(await x.home.textContent('#net')), 'en línea');
    const id = (await H.home.textContent('#myid')).trim();
    step('los dos en línea, sin claves que configurar; ID ' + id);
    if (await V.home.locator('.peer').count()) throw new Error('no deberían verse en la red local');
    const t = Date.now();
    await V.home.fill('#target', id);
    await V.home.click('#cform .primary');
    const viewer = await V.page('viewer.html'), panel = await H.page('panel.html');
    await panel.waitForSelector('#accept', { timeout: 40000 });
    step(`petición en pantalla en ${Date.now() - t} ms: ${(await panel.innerText('body')).replace(/\s+/g, ' ').slice(0, 90)}`);
    if (process.env.SHOTS) await panel.screenshot({ path: path.join(process.env.SHOTS, 'peticion.png') });
    await panel.click('#accept');
    await viewer.waitForSelector('#bar:not([hidden])');
    const size = await until(() => viewer.evaluate(() => { const c = document.getElementById('screen'); return c.width > 100 ? [c.width, c.height] : null; }), 'vídeo');
    step('vídeo ' + size.join('x'));
    await panel.click('.danger');
    await until(async () => /cerró la sesión/.test(await viewer.textContent('#status')), 'corte');
    const log = fs.readFileSync(path.join(tmp, 'host', 'audit.jsonl'), 'utf8');
    if (!/"internet":true/.test(log)) throw new Error('no fue por internet');
    step('la sesión fue por internet');
    await viewer.close();
    await V.home.waitForSelector('.peer');
    step('queda guardado: ' + (await V.home.locator('.peer .who').first().innerText()).replace(/\s+/g, ' '));
    await V.home.fill('#target', '123456789');
    await V.home.click('#cform .primary');
    const v2 = await until(() => V.a.windows().find((w) => w.url().endsWith('viewer.html')), 'otro visor');
    await until(async () => /no está en línea/.test(await v2.textContent('#status')), 'ID inexistente');
    step('un ID que no existe se explica');
    console.log('POR ID COMPLETO');
  } finally {
    for (const x of [V, H]) await x.a.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch { /* que no tape el fallo */ }
  }
})().catch((e) => { console.error('FALLO', e.message); process.exit(1); });
