'use strict';
// Cada prueba reproduce un fallo encontrado en la auditoria.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), net = require('node:net'), path = require('node:path'), dgram = require('node:dgram');
const { SecureChannel, createIdentity, loadIdentity, deriveCompanyKey } = require('../src/channel');
const { HostServer, ViewerSession, PasswordGate } = require('../src/sessions');
const { Discovery, seal } = require('../src/discovery');
const { Config } = require('../src/config');
const { RotatingFile } = require('../src/log');

const KEY = deriveCompanyKey('clave-regresion-123456'), BAD = deriveCompanyKey('clave-equivocada-12345');
const me = loadIdentity(createIdentity());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await wait(20); } }
const dirOf = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-')); t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })); return d; };
async function host(t, over = {}) {
  const dir = dirOf(t), log = [], id = loadIdentity(createIdentity());
  const deps = { password: () => null, allowApproval: () => true, gate: new PasswordGate(), unattendedPerms: () => ({}), askApproval: () => ({ cancel() {}, result: Promise.resolve({ control: true, clipboard: true, files: true }) }), injector: { handle() {}, release() {} }, screens: () => [], downloadsDir: () => path.join(dir, 'h'), audit: (e, d) => log.push({ e, ...d }), ...over };
  const s = new HostServer({ identity: id, companyKey: KEY, name: 'H', deps });
  const port = await s.listen(0, '127.0.0.1');
  t.after(() => s.close());
  return { s, id, port, log, dir };
}
const view = (h, o = {}) => ViewerSession.connect({ host: '127.0.0.1', port: h.port, identity: me, companyKey: KEY, name: 'V', downloadsDir: () => path.join(h.dir, 'v'), acceptFile: () => true, ...o });
async function grant(v) { const g = new Promise((r) => v.once('granted', r)); v.once('welcome', () => v.ask()); v.start(); await g; return v; }
async function raw(h, opts = {}) {
  const sock = net.connect({ port: h.port, host: '127.0.0.1', ...opts });
  sock.on('error', () => {});
  await new Promise((r) => sock.once('connect', r));
  return sock;
}

test('una trama corrupta pegada al saludo no deja sesion fantasma', async (t) => {
  const h = await host(t);
  const sock = await raw(h);
  const p = SecureChannel.handshake(sock, { role: 'client', identity: me, companyKey: KEY, name: 'x' });
  await wait(0);
  const hold = [], write = sock.write.bind(sock);
  sock.write = (b) => { hold.push(b); return true; };
  await p;
  write(Buffer.concat([...hold, Buffer.from([0, 0, 0, 20]), Buffer.alloc(20)]));
  await wait(200);
  sock.destroy();
  await until(() => h.s.sessions.size === 0);
});

test('un mensaje ilegible al principio cierra la sesion sin error suelto', async (t) => {
  const h = await host(t), bad = [];
  const on = (e) => bad.push(e);
  process.on('unhandledRejection', on);
  t.after(() => process.off('unhandledRejection', on));
  const ch = await SecureChannel.handshake(await raw(h), { role: 'client', identity: me, companyKey: KEY, name: 'x' });
  ch.sendBinary(0, Buffer.from('{no json'));
  await wait(250);
  assert.equal(bad.length, 0);
  assert.equal(h.s.sessions.size, 0);
});

test('quien abre conexiones sin clave no deja fuera a los demas', async (t) => {
  const h = await host(t);
  for (let i = 0; i < 30; i++) await raw(h);                                    // misma direccion
  for (let i = 0; i < 80; i++) await raw(h, { localAddress: '127.0.1.' + (1 + (i % 40)) }); // muchas direcciones
  const v = await grant(await view(h));
  assert.ok(v.granted);
  assert.ok(h.s.pending.size <= 60);
});

test('un equipo con clave no acapara sesiones sin autorizar', async (t) => {
  const h = await host(t, { askApproval: () => ({ cancel() {}, result: new Promise(() => {}) }) });
  for (let i = 0; i < 10; i++) (await view(h)).start();
  await wait(100);
  assert.ok(h.s.sessions.size <= 3, String(h.s.sessions.size));
});

test('se registran los intentos con otra clave, pero no mas de uno por minuto', async (t) => {
  const h = await host(t);
  for (let i = 0; i < 15; i++) await assert.rejects(view(h, { companyKey: BAD }));
  await wait(150);
  assert.equal(h.log.filter((x) => x.e === 'handshake_failed').length, 1);
});

test('retirar el permiso corta el envio en marcha y no deja restos', async (t) => {
  const h = await host(t), v = await grant(await view(h));
  const f = path.join(h.dir, 'big.bin');
  fs.writeFileSync(f, Buffer.alloc(120e6));
  let last;
  v.on('file', (u) => { last = u.state; });
  await v.files.send(f);
  await until(() => last === 'progress');
  [...h.s.sessions.values()][0].setPerm('files', false);
  await until(() => last === 'rejected' || last === 'failed');
  await until(() => fs.readdirSync(path.join(h.dir, 'h')).length === 0);
});

for (const [name, fails, want] of [['breve', 2, 'done'], ['permanente', 99, 'rejected']]) {
  test('antivirus que retiene el archivo: bloqueo ' + name, async (t) => {
    const h = await host(t), v = await grant(await view(h));
    const f = path.join(h.dir, 'av.bin');
    fs.writeFileSync(f, 'x'.repeat(100));
    const real = fs.promises.rename;
    let n = 0, last;
    fs.promises.rename = (...a) => (n++ < fails ? Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })) : real(...a));
    t.after(() => { fs.promises.rename = real; });
    v.on('file', (u) => { last = u.state; });
    await v.files.send(f);
    await until(() => last === want, 12_000);
    if (want === 'rejected') await until(() => fs.readdirSync(path.join(h.dir, 'h')).length === 0);
    else assert.deepEqual(fs.readdirSync(path.join(h.dir, 'h')), ['av.bin']);
  });
}

// ---------------------------------------------------------------- configuracion
const ss = (fail) => ({ encryptStringAsync: async (s) => Buffer.from('c:' + s), decryptStringAsync: async (b) => { if (fail?.()) throw new Error('DPAPI'); return { result: b.toString().slice(2), shouldReEncrypt: false }; } });
const DEF = { settings: { name: 'PC', allowIncoming: true, unattended: { control: true } } };

test('configuracion danada: se recupera de la copia con sus claves', async (t) => {
  const d = dirOf(t);
  const c = await new Config(d, ss(), DEF).init();
  c.data.settings.name = 'Recepcion';
  await c.setSecret('companyKey', 'K1');
  for (const bad of ['', '{"settings":{"na', 'null', '[]', '\u0000\u0000\u0000']) {
    fs.writeFileSync(path.join(d, 'config.json'), bad);
    const r = await new Config(d, ss(), DEF).init();
    assert.equal(r.recovered, 'copia');
    assert.equal(r.data.settings.name, 'Recepcion');
    assert.equal(r.getSecret('companyKey'), 'K1');
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')).settings.name, 'Recepcion');
  }
});

test('sin copia util se arranca de cero y se aparta el archivo danado', async (t) => {
  const d = dirOf(t);
  fs.writeFileSync(path.join(d, 'config.json'), '{"x');
  const c = await new Config(d, ss(), DEF).init();
  assert.equal(c.recovered, 'nueva');
  assert.ok(fs.readdirSync(d).some((f) => f.startsWith('config.danada-')));
});

test('valores con tipo equivocado no rompen el arranque', async (t) => {
  const d = dirOf(t);
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ settings: { name: 5, unattended: null, allowIncoming: 'si' }, contacts: { x: 1, 123456789: { name: 'ok' }, 111111111: {} }, secrets: [] }));
  const c = await new Config(d, ss(), DEF).init();
  assert.deepEqual(c.data.settings, DEF.settings);
  assert.deepEqual(Object.keys(c.data.contacts), ['123456789']);
});

test('claves que Windows ya no abre: se avisa, se guarda copia y se puede seguir', async (t) => {
  const d = dirOf(t);
  await (await new Config(d, ss(), DEF).init()).setSecret('companyKey', 'K');
  const c = await new Config(d, ss(() => true), DEF).init();
  assert.deepEqual(c.lost, ['companyKey']);
  assert.equal(c.getSecret('companyKey'), null);
  assert.ok(fs.readdirSync(d).some((f) => f.startsWith('config.claves-perdidas-')));
  assert.equal(await c.setSecret('companyKey', 'K2'), true);
});

test('una contrasena retirada no vuelve al recuperar la copia', async (t) => {
  const d = dirOf(t), c = await new Config(d, ss(), DEF).init();
  await c.setSecret('password', 'P');
  await c.setSecret('password', null);
  fs.writeFileSync(path.join(d, 'config.json'), '');
  assert.equal((await new Config(d, ss(), DEF).init()).getSecret('password'), null);
});

test('si no se puede guardar no se lanza y queda avisado', async (t) => {
  const d = dirOf(t), c = await new Config(d, ss(), DEF).init();
  c.save();
  fs.chmodSync(c.file, 0o444);
  assert.equal(c.save(), false);
  assert.ok(c.saveError);
  fs.chmodSync(c.file, 0o666);
  assert.equal(c.save(), true);
  assert.equal(c.saveError, null);
});

test('los registros tienen tope y leer el final es inmediato', (t) => {
  const f = path.join(dirOf(t), 'a.log'), r = new RotatingFile(f, 50_000);
  for (let i = 0; i < 3000; i++) r.append('linea ' + i + ' ' + 'x'.repeat(40));
  assert.ok(fs.statSync(f).size <= 50_100 && fs.statSync(f + '.1').size <= 50_100);
  assert.deepEqual(r.tail(1), ['linea 2999 ' + 'x'.repeat(40)]);
  assert.deepEqual(new RotatingFile(f + '.no').tail(5), []);
});

// ---------------------------------------------------------------- descubrimiento
test('parar el descubrimiento mientras arranca no rompe nada', async () => {
  const d = new Discovery({ companyKey: KEY, id: '111111111', name: 'a', port: 1, udpPort: 47877 });
  d.start(); d.stop(); d.start();
  await wait(250);
  d.stop();
  await wait(200);
});

test('equipo con dos redes: un solo aviso; reloj mal: aparece marcado; repetidos: se ignoran', async (t) => {
  const d = new Discovery({ companyKey: KEY, id: '111111111', name: 'a', port: 1, udpPort: 47879 });
  let n = 0;
  d.on('change', () => n++);
  d.start();
  t.after(() => d.stop());
  await wait(150);
  const a = dgram.createSocket('udp4'), b = dgram.createSocket('udp4');
  t.after(() => { a.close(); b.close(); });
  await new Promise((r) => a.bind(0, '127.0.0.1', r));
  await new Promise((r) => b.bind(0, '127.0.0.2', r));
  const tx = (s, o) => s.send(seal(KEY, { id: '222222222', name: ' x ', port: 5, at: Date.now(), ...o }), 47879, '127.0.0.1');
  for (let i = 0; i < 10; i++) { tx(a); tx(b); await wait(15); }
  await wait(80);
  assert.equal(n, 1);
  tx(b, { at: Date.now() - 60_000, bye: true }); // despedida antigua reenviada
  await wait(80);
  assert.ok(d.peers.has('222222222'));
  tx(a, { id: '333333333', at: Date.now() - 3 * 3600_000 });
  await wait(80);
  assert.equal(d.peers.get('333333333').skew, true);
});
