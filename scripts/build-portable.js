'use strict';
// Crea dist/<programa>.exe (portable) a partir de dist/win-unpacked. Usar con: npm run dist
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..'), dist = path.join(root, 'dist'), src = path.join(dist, 'win-unpacked');
const brand = require('../branding/branding.json'), { version } = require('../package.json');

function find(dir, name, depth = 4) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const r = find(p, name, depth - 1); if (r) return r; }
  }
  return null;
}
// makensis lo descarga electron-builder al crear el instalador.
const makensis = find(path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache'), 'makensis.exe');
if (!makensis) throw new Error('No se encuentra makensis: ejecuta antes electron-builder (npm run dist).');

const exe = brand.appName + '.exe';
const hash = crypto.createHash('sha256');
for (const f of [exe, path.join('resources', 'app.asar')]) hash.update(fs.readFileSync(path.join(src, f)));
const build = `${version}-${hash.digest('hex').slice(0, 10)}`;

// electron-builder convierte branding/icon.png a .ico al crear el instalador.
const ico = find(dist, 'icon.ico', 2);
if (!ico) throw new Error('No se encuentra icon.ico en dist.');

const out = path.join(dist, `${brand.appName}-${version}-portable.exe`);
// makensis no admite rutas de mas de 260 caracteres: se usa un enlace corto.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd'));
const link = path.join(tmp, 's');
fs.symlinkSync(src, link, 'junction');
try {
  const defs = { APP: brand.appName, COMPANY: brand.company, VERSION: version, BUILD: build, EXE: exe, SRC: link, OUT: out, ICON: ico, DIRNAME: brand.appId };
  execFileSync(makensis, ['/V2', '/INPUTCHARSET', 'UTF8', ...Object.entries(defs).map(([k, v]) => `/D${k}=${v}`), path.join(__dirname, 'portable.nsi')], { stdio: 'inherit' });
} finally { fs.rmdirSync(link); fs.rmdirSync(tmp); } // rmdir quita el enlace, no su contenido
console.log(`Portable: ${out} (${(fs.statSync(out).size / 1048576).toFixed(0)} MB)`);
