'use strict';
/**
 * Prueba real entre dos redes, sin Electron:
 *   node test/internet.js host  <sala>   en un equipo
 *   node test/internet.js visor <sala>   en otro, en otra red
 * La sala es cualquier texto igual en los dos; de él sale el ID de la prueba.
 */
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const { loadIdentity, deriveNetKey } = require('../src/channel');
const { HostServer, ViewerSession, PasswordGate } = require('../src/sessions');
const { Wan } = require('../src/wan');

const [role, room] = process.argv.slice(2);
if (!['host', 'visor'].includes(role) || !room) throw new Error('Uso: node test/internet.js host|visor <sala>');
const KEY = deriveNetKey('prueba-internet');
const PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const identityOf = (who) => loadIdentity(Buffer.concat([PREFIX, crypto.createHash('sha256').update(room + who).digest()]).toString('base64'));
const hostId = identityOf('host'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-int-'));
const ms = (t) => Math.round(performance.now() - t) + ' ms';
const quit = (code) => setTimeout(() => process.exit(code), 300);

async function host() {
  const deps = {
    password: () => null, allowApproval: () => true, gate: new PasswordGate(), unattendedPerms: () => ({}),
    askApproval: () => ({ cancel() {}, result: Promise.resolve({ control: true, clipboard: true, files: true }) }),
    injector: { handle() {}, release() {} }, screens: () => [], downloadsDir: () => dir, audit: (e) => console.log('registro:', e),
  };
  const srv = new HostServer({ identity: hostId, netKey: KEY, name: 'Equipo de prueba', deps });
  const w = new Wan({ netKey: KEY, id: hostId.id });
  w.on('problem', (e) => console.log('problema:', e.message));
  w.on('change', () => console.log('estado:', w.state, 'ID', hostId.id));
  w.on('connection', (s) => { console.log('llega una conexión'); srv.accept(s); });
  srv.on('session', (s) => {
    s.on('granted', () => { for (let i = 0; i < 20; i++) s.sendFrame(crypto.randomBytes(40_000)); });
    s.on('file', (u) => u.state === 'done' && console.log('archivo recibido'));
    s.on('close', () => { console.log('sesión terminada'); quit(0); });
  });
  w.start();
  setTimeout(() => { console.log('nadie se ha conectado'); process.exit(1); }, 240_000);
}

async function visor() {
  const w = new Wan({ netKey: KEY, id: identityOf('visor').id, listen: false }).start();
  w.on('problem', (e) => console.log('problema:', e.message));
  const limit = Date.now() + 200_000;
  for (let n = 1; ; n++) {
    const t = performance.now();
    try {
      const v = await ViewerSession.connect({
        routes: [{ wan: w, id: hostId.id }], identity: identityOf('visor'), netKey: KEY, name: 'Visor', expectId: hostId.id, downloadsDir: () => dir, acceptFile: () => true,
      });
      console.log(`conectado al ID ${hostId.id} en ${ms(t)} por ${v.ch.socket.stream.rawStream?.remoteFamily === 6 ? 'IPv6' : 'IPv4'} (intento ${n})`);
      let frames = 0;
      v.on('frame', () => frames++);
      const g = once(v, 'granted'), wl = once(v, 'welcome');
      v.start(); await wl; v.ask(); await g;
      console.log('acceso concedido');
      const f = path.join(dir, 'prueba.bin');
      fs.writeFileSync(f, crypto.randomBytes(5 * 1024 * 1024));
      const sent = performance.now(), done = new Promise((r) => v.on('file', (u) => u.state === 'done' && r()));
      await v.files.send(f);
      await done;
      console.log(`archivo de 5 MB en ${ms(sent)}, imágenes recibidas: ${frames}`);
      v.end();
      console.log('PRUEBA SUPERADA');
      return quit(0);
    } catch (e) {
      console.log(`intento ${n}: ${e.message} (${ms(t)})`);
      if (Date.now() > limit) return quit(1);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}
(role === 'host' ? host() : visor()).catch((e) => { console.error(e); process.exit(1); });
