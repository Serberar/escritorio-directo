'use strict';
/* global fmt, applyBrand */
function fmt(id) { return String(id).replace(/(\d{3})(?=\d)/g, '$1 '); }
function applyBrand(b) {
  if (!b || applyBrand.done) return;
  applyBrand.done = true;
  const r = document.documentElement.style;
  r.setProperty('--brand', `light-dark(${b.color}, ${b.colorDark || b.color})`);
  r.setProperty('--on-brand', `light-dark(${b.onColor || '#fff'}, ${b.onColorDark || b.onColor || '#fff'})`);
  if (!document.title) document.title = b.appName;
}
