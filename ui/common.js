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
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const logos = () => { for (const i of document.querySelectorAll('img.logo')) { i.src = '../branding/' + (dark.matches && b.logoDark ? b.logoDark : b.logo); i.alt = b.appName; } };
  logos();
  dark.onchange = logos;
}
