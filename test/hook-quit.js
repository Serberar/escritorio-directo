'use strict';
// Se carga con "electron -r": simula pulsar Salir o un error grave.
const { app } = require('electron');
app.whenReady().then(() => setTimeout(() => {
  console.log('HOOK', process.env.RD_HOOK);
  if (process.env.RD_HOOK === 'quit') app.quit();
  else setImmediate(() => { throw new Error('fallo provocado por la prueba'); });
}, Number(process.env.RD_HOOK_MS || 4000)));
