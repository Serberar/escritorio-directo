'use strict';
/** Conexión por ID a través de internet, con una red distribuida simulada en este equipo. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { once } = require('node:events');
const createTestnet = require('hyperdht/testnet');
const DHT = require('hyperdht');
const { createIdentity, loadIdentity, deriveNetKey } = require('../src/channel');
const { HostServer, ViewerSession, PasswordGate, AskGate, makePassword, weakPassword } = require('../src/sessions');
const { Wan, addressFor } = require('../src/wan');

const KEY = deriveNetKey('com.example.prueba');
const online = (w) => (w.state === 'online' ? null : new Promise((r) => w.on('change', () => w.state === 'online' && r())));

async function setup(t, over = {}) {
  const net = await createTestnet(4);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-wan-'));
  const hostId = loadIdentity(createIdentity()), viewId = loadIdentity(createIdentity());
  const deps = {
    password: () => null, allowApproval: () => true, gate: new PasswordGate(), asks: new AskGate(),
    unattendedPerms: () => ({ control: true, clipboard: true, files: true }),
    askApproval: () => ({ cancel() {}, result: Promise.resolve({ control: true, clipboard: true, files: true }) }),
    injector: { handle() {}, release() {} }, screens: () => [], downloadsDir: () => path.join(dir, 'host'), audit() {}, ...over,
  };
  const srv = new HostServer({ identity: hostId, netKey: KEY, name: 'Host', deps });
  const host = new Wan({ netKey: KEY, id: hostId.id, bootstrap: net.bootstrap }).start();
  const view = new Wan({ netKey: KEY, id: viewId.id, listen: false, bootstrap: net.bootstrap }).start();
  host.on('connection', (s) => srv.accept(s));
  await Promise.all([online(host), online(view)]);
  t.after(async () => {
    for (const s of srv.sessions.values()) s.end();
    await Promise.all([host.stop(), view.stop()]);
    await net.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const connect = (o = {}) => ViewerSession.connect({
    routes: [{ wan: view, id: hostId.id }], identity: viewId, netKey: KEY, name: 'Visor', expectId: hostId.id,
    downloadsDir: () => path.join(dir, 'view'), acceptFile: () => true, ...o,
  });
  return { net, dir, srv, host, view, hostId, viewId, connect };
}
async function granted(v) {
  const g = once(v, 'granted'), w = once(v, 'welcome');
  v.start();
  await w;
  v.ask();
  return (await g)[0];
}

test('por internet: se conecta solo con el ID y pide permiso', async (t) => {
  const c = await setup(t);
  const v = await c.connect();
  assert.equal(v.peer.id, c.hostId.id);
  assert.equal((await granted(v)).perms.control, true);
  assert.equal([...c.srv.sessions.values()][0].internet, true);
  v.end();
});

test('por internet: contraseña, archivo grande y vídeo llegan intactos', async (t) => {
  const pw = await makePassword('Prueba-99-wan');
  const c = await setup(t, { password: () => pw });
  const v = await c.connect();
  const w = once(v, 'welcome'), g = once(v, 'granted');
  v.start(); await w; v.password('Prueba-99-wan'); await g;
  const file = path.join(c.dir, 'grande.bin'), data = crypto.randomBytes(9 * 1024 * 1024);
  fs.writeFileSync(file, data);
  const host = [...c.srv.sessions.values()][0];
  const done = new Promise((r) => host.on('file', (u) => u.state === 'done' && r()));
  await v.files.send(file);
  await done;
  assert.ok(fs.readFileSync(path.join(c.dir, 'host', 'grande.bin')).equals(data));
  const frame = crypto.randomBytes(700_000), got = once(v, 'frame');
  host.sendFrame(frame);
  assert.ok(Buffer.from((await got)[0]).equals(frame));
  v.end();
  await once(host, 'close');
});

test('por internet: un ID que no está en línea se explica', async (t) => {
  const c = await setup(t);
  await assert.rejects(c.connect({ routes: [{ wan: c.view, id: '123456789' }], expectId: '123456789' }), /wan_not_found/);
});

test('por internet: quien ocupa la dirección de otro no pasa por él', async (t) => {
  const c = await setup(t);
  await c.host.stop();
  const impostor = loadIdentity(createIdentity());
  const srv = new HostServer({ identity: impostor, netKey: KEY, name: 'Impostor', deps: { audit() {} } });
  const w = new Wan({ netKey: KEY, id: c.hostId.id, bootstrap: c.net.bootstrap }).start(); // misma dirección pública
  w.on('connection', (s) => srv.accept(s));
  await online(w);
  t.after(() => w.stop());
  await assert.rejects(c.connect(), /identity_mismatch/);
});

test('un equipo conocido que vuelve con otra clave se rechaza', async (t) => {
  const c = await setup(t);
  await assert.rejects(c.connect({ expectPub: crypto.randomBytes(32).toString('base64') }), /identity_mismatch/);
  const v = await c.connect({ expectPub: c.hostId.pub.toString('base64') });
  v.end();
});

test('por internet: otro programa ni llega a la sesión', async (t) => {
  const c = await setup(t);
  let asked = 0;
  c.host.on('connection', () => asked++);
  const node = new DHT({ bootstrap: c.net.bootstrap });
  t.after(() => node.destroy());
  const s = node.connect(addressFor(KEY, c.hostId.id).publicKey);
  await assert.rejects(new Promise((res, rej) => { s.on('open', res); s.on('error', rej); s.on('close', () => rej(new Error('cerrado'))); }));
  assert.equal(asked, 0);
});

test('con red local e internet a la vez queda una sola conexión', async (t) => {
  const c = await setup(t);
  const port = await c.srv.listen(0, '127.0.0.1');
  t.after(() => c.srv.close());
  const v = await c.connect({ routes: [{ host: '127.0.0.1', port }, { wan: c.view, id: c.hostId.id, delay: 50 }] });
  await granted(v);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal([...c.srv.sessions.values()].filter((s) => !s.ch.closed).length, 1);
  v.end();
});

test('si la dirección guardada ya no vale, entra por internet', async (t) => {
  const c = await setup(t);
  const v = await c.connect({ routes: [{ host: '127.0.0.1', port: 1 }, { wan: c.view, id: c.hostId.id }] });
  assert.equal(v.peer.id, c.hostId.id);
  v.end();
});

test('freno a las peticiones: tres rechazos y se ignora al equipo un rato', () => {
  let now = 0;
  const g = new AskGate(() => now);
  for (let i = 0; i < 3; i++) { assert.ok(g.allowed('a')); g.asked(); g.rejected('a'); }
  assert.equal(g.allowed('a'), false);
  assert.equal(g.allowed('b'), true);
  now = 31 * 60_000;
  assert.equal(g.allowed('a'), true);
  for (let i = 0; i < 12; i++) g.asked();
  assert.equal(g.allowed('c'), false); // tope total
});

test('contraseñas de acceso fáciles', () => {
  for (const p of ['corta1', '12345678', 'aaaaaaaa', 'abababab', '20261124', 'qwertyuiop', 'password1', 'Contraseña1']) assert.ok(weakPassword(p), p);
  for (const p of ['Prueba-E2E-99', 'mar.tejado.41', 'K7w2nP9x']) assert.equal(weakPassword(p), null, p);
});
