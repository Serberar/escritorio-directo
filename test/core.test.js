'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createIdentity, loadIdentity, deriveNetKey, SecureChannel } = require('../src/channel');
const { HostServer, ViewerSession, PasswordGate, makePassword } = require('../src/sessions');
const { safeName } = require('../src/files');
const { seal, open } = require('../src/discovery');
const { Injector } = require('../src/input-win');

const KEY = deriveNetKey('clave-empresa-de-prueba');
const OTHER = deriveNetKey('otra-clave-distinta-123');

async function setup(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
  const log = [], inputs = [];
  const hostId = loadIdentity(createIdentity()), viewId = loadIdentity(createIdentity());
  const deps = {
    password: () => null, allowApproval: () => true, gate: new PasswordGate(),
    unattendedPerms: () => ({ control: true, clipboard: true, files: true }),
    askApproval: () => ({ cancel() {}, result: Promise.resolve({ control: true, clipboard: true, files: true }) }),
    injector: { handle: (m) => inputs.push(m), release() {} }, screens: () => [{ id: '1', label: 'P1' }],
    downloadsDir: () => path.join(dir, 'host'), audit: (e, d) => log.push({ e, ...d }), ...over,
  };
  const srv = new HostServer({ identity: hostId, netKey: KEY, name: 'Host', deps });
  const port = await srv.listen(0, '127.0.0.1');
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const connect = (o = {}) => ViewerSession.connect({
    host: '127.0.0.1', port, identity: viewId, netKey: KEY, name: 'Visor', expectId: hostId.id,
    downloadsDir: () => path.join(dir, 'viewer'), acceptFile: () => true, ...o,
  });
  return { srv, dir, log, inputs, hostId, viewId, deps, port, connect };
}
async function login(v, pw) {
  const w = once(v, 'welcome');
  v.start();
  await w;
  const r = Promise.race([once(v, 'granted').then(([m]) => m), once(v, 'denied').then(([x]) => x)]);
  if (pw === undefined) v.ask(); else v.password(pw);
  return r;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('aprobacion manual y permisos', async (t) => {
  const c = await setup(t);
  const v = await c.connect();
  assert.equal(v.peer.name, 'Host');
  const g = await login(v);
  assert.equal(g.perms.control, true);
  v.send({ t: 'in', k: 'move', x: 0.5, y: 0.5 });
  await wait(50);
  assert.equal(c.inputs.length, 1);
  [...c.srv.sessions.values()][0].setPerm('control', false);
  v.send({ t: 'in', k: 'move', x: 0.1, y: 0.1 });
  await wait(50);
  assert.equal(c.inputs.length, 1, 'sin permiso no se inyecta');
});

test('nada se procesa antes de autorizar', async (t) => {
  const c = await setup(t);
  const v = await c.connect();
  v.start();
  v.send({ t: 'in', k: 'key', code: 'KeyA', down: true });
  v.send({ t: 'f-offer', fid: 1, name: 'x.txt', size: 3 });
  v.send({ t: 'v-start' });
  await wait(80);
  assert.equal(c.inputs.length, 0);
  assert.equal(fs.existsSync(path.join(c.dir, 'host')), false);
});

test('rechazo del usuario', async (t) => {
  const c = await setup(t, { askApproval: () => ({ cancel() {}, result: Promise.resolve(null) }) });
  const v = await c.connect();
  const closed = once(v, 'close');
  login(v);
  assert.equal((await closed)[0], 'rejected');
});

test('contrasena: correcta, incorrecta y bloqueo', async (t) => {
  const pw = await makePassword('Secreta-123');
  const c = await setup(t, { password: () => pw });
  const bad = await c.connect();
  assert.equal(await login(bad, 'mala'), 'bad_password');
  bad.end();
  const ok = await c.connect();
  assert.ok((await login(ok, 'Secreta-123')).hostProof);
  ok.end();
  for (let i = 0; i < 5; i++) { const v = await c.connect(); assert.equal(await login(v, 'mala' + i), 'bad_password'); v.end(); }
  const last = await c.connect();
  assert.equal(await login(last, 'Secreta-123'), 'locked');
});

test('clave de empresa distinta no conecta', async (t) => {
  const c = await setup(t);
  await assert.rejects(c.connect({ netKey: OTHER }), /bad_protocol/);
  assert.equal(c.srv.sessions.size, 0);
});

test('identidad distinta a la esperada se rechaza', async (t) => {
  const c = await setup(t);
  await assert.rejects(c.connect({ expectId: '999999999' }), /identity_mismatch/);
});

test('basura por el puerto no tumba el host', async (t) => {
  const c = await setup(t);
  for (const junk of [Buffer.from('GET / HTTP/1.1\r\n\r\n'), Buffer.alloc(200), crypto.randomBytes(500)]) {
    const s = net.connect(c.port, '127.0.0.1');
    s.on('error', () => {});
    s.write(junk);
    await once(s, 'close');
  }
  assert.ok((await login(await c.connect())).perms);
});

test('trafico manipulado cierra el canal y no viaja en claro', async (t) => {
  const c = await setup(t);
  let tamper = false, seen = Buffer.alloc(0);
  const proxy = net.createServer((a) => {
    const b = net.connect(c.port, '127.0.0.1');
    a.on('error', () => {}); b.on('error', () => {});
    a.on('data', (d) => { seen = Buffer.concat([seen, d]); if (tamper) { d = Buffer.from(d); d[d.length - 1] ^= 1; } b.write(d); });
    b.pipe(a); a.on('close', () => b.destroy()); b.on('close', () => a.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const v = await c.connect({ port: proxy.address().port });
  await login(v);
  v.send({ t: 'chat', text: 'TEXTO-PRIVADO' });
  await wait(50);
  assert.equal(seen.includes('TEXTO-PRIVADO'), false);
  tamper = true;
  const closed = once(v, 'close');
  v.send({ t: 'in', k: 'move', x: 0, y: 0 });
  await closed;
  assert.equal(c.inputs.length, 0);
});

test('archivos en ambos sentidos, integros y sin sobrescribir', async (t) => {
  const c = await setup(t);
  const v = await c.connect();
  await login(v);
  const host = [...c.srv.sessions.values()][0];
  const src = path.join(c.dir, 'datos.bin'), data = crypto.randomBytes(7 * 1024 * 1024 + 13);
  fs.writeFileSync(src, data);
  const done = (em) => new Promise((r) => em.on('file', (u) => u.state === 'done' && u.dir === 'in' && r(u)));
  for (const [from, to] of [[v, host], [host, v], [v, host]]) {
    const p = done(to);
    await from.files.send(src);
    assert.ok(fs.readFileSync((await p).path).equals(data));
  }
  assert.deepEqual(fs.readdirSync(path.join(c.dir, 'host')).sort(), ['datos (1).bin', 'datos.bin']);
  const empty = path.join(c.dir, 'vacio.txt');
  fs.writeFileSync(empty, '');
  const p = done(host);
  await v.files.send(empty);
  assert.equal(fs.statSync((await p).path).size, 0);
});

test('un corte a mitad no deja archivos parciales', async (t) => {
  const c = await setup(t);
  const v = await c.connect();
  await login(v);
  v.send({ t: 'f-offer', fid: 9, name: 'x.bin', size: 1000 });
  await wait(80);
  v.ch.destroy();
  await wait(150);
  assert.deepEqual(fs.readdirSync(path.join(c.dir, 'host')), []);
});

test('nombres de archivo peligrosos', () => {
  assert.equal(safeName('..\\..\\Windows\\a.exe'), 'a.exe');
  assert.equal(safeName('../../x'), 'x');
  assert.equal(safeName('CON.txt'), '_CON.txt');
  assert.equal(safeName('..'), 'archivo');
  assert.equal(safeName('a:b?.txt. '), 'a_b_.txt');
});

test('descubrimiento autenticado', () => {
  const m = seal(KEY, { id: '123456789', at: Date.now() });
  assert.equal(open(KEY, m).id, '123456789');
  assert.equal(open(OTHER, m), null);
  assert.equal(open(KEY, seal(KEY, { id: '1', at: Date.now() - 72 * 3600_000 })), null);
});

test('inyector: coordenadas, limites y liberacion', () => {
  const out = [];
  const inj = new Injector({ send: (...l) => out.push(...l), virtual: () => ({ x: -1920, y: 0, w: 3840, h: 1080 }) });
  const s = { screenRect: { x: 0, y: 0, width: 1920, height: 1080 } };
  inj.handle({ k: 'move', x: 0, y: 0 }, s);
  assert.equal(out[0].readInt32LE(8), Math.round((1920 * 65535) / 3839));
  inj.handle({ k: 'move', x: 5, y: 5 }, s);
  assert.equal(out[1].readInt32LE(8), 65535);
  assert.equal(out[1].readInt32LE(12), 65535);
  inj.handle({ k: 'key', code: 'constructor', down: true }, s);
  inj.handle({ k: 'move', x: 'a', y: null }, s);
  inj.handle({ k: 'btn', b: 99, x: 0, y: 0, down: true }, s);
  assert.equal(out.length, 2);
  inj.handle({ k: 'key', code: 'ShiftLeft', down: true }, s);
  inj.release(s);
  assert.equal(out.length, 4);
  assert.equal(out[3].readUInt32LE(12) & 2, 2);
});

test('IDs de 9 digitos estables', () => {
  const k = createIdentity();
  assert.match(loadIdentity(k).id, /^\d{9}$/);
  assert.equal(loadIdentity(k).id, loadIdentity(k).id);
  assert.ok(SecureChannel);
});
