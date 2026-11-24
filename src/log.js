'use strict';
const fs = require('node:fs');

/** Archivo de texto que rota al llegar al tope: ocupa como mucho el doble de "max". Nunca lanza. */
class RotatingFile {
  constructor(file, max = 2 * 1024 * 1024) { this.file = file; this.max = max; }
  append(line) {
    try {
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (size + line.length > this.max) fs.renameSync(this.file, this.file + '.1');
    } catch { /* si no se puede rotar se sigue escribiendo */ }
    try { fs.appendFileSync(this.file, line + '\n'); } catch { /* disco lleno */ }
  }
  /** Ultimas lineas, leyendo solo el final del archivo. */
  tail(n, bytes = 64 * 1024) {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const { size } = fs.fstatSync(fd), len = Math.min(size, bytes), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (len < size) lines.shift(); // primera linea cortada
      return lines.filter(Boolean).slice(-n);
    } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}
module.exports = { RotatingFile };
