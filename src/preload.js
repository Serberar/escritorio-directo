'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
// Cada ventana solo puede usar los canales de su propio prefijo.
const role = location.pathname.split('/').pop().replace('.html', '');
const ok = (c) => { if (typeof c !== 'string' || !c.startsWith(role + ':')) throw new Error('canal no permitido'); return c; };
contextBridge.exposeInMainWorld('api', {
  send: (c, ...a) => ipcRenderer.send(ok(c), ...a),
  invoke: (c, ...a) => ipcRenderer.invoke(ok(c), ...a),
  on: (c, fn) => { ipcRenderer.on(ok(c), (_e, ...a) => fn(...a)); },
  filePath: (f) => webUtils.getPathForFile(f),
});
