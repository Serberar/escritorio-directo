'use strict';
const brand = require('./branding/branding.json');
const test = process.env.BUILD_FOR_TEST === '1'; // sin endurecer, solo para pruebas automaticas
module.exports = {
  appId: brand.appId,
  productName: brand.appName,
  copyright: brand.company,
  npmRebuild: false,
  directories: { output: 'dist' },
  files: ['package.json', 'src/**', 'ui/**', 'branding/**'],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'branding/icon.png' },
  nsis: {
    oneClick: false, perMachine: true, allowToChangeInstallationDirectory: true, include: 'scripts/installer.nsh',
    artifactName: 'Instalador-${productName}-${version}.${ext}', installerLanguages: ['es_ES'], language: '3082', deleteAppDataOnUninstall: false,
  },
  electronFuses: test ? undefined : {
    runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
  },
};
