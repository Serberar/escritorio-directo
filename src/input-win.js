'use strict';
/** Inyeccion de raton y teclado en Windows mediante SendInput. */
const SIZE = 40; // sizeof(INPUT) en 64 bits

// KeyboardEvent.code -> codigo de barrido; 'e' = tecla extendida (E0); vk = tecla virtual.
const S = (s) => ({ s }), E = (s) => ({ s, e: true }), V = (vk) => ({ vk });
const KEYS = {
  Escape: S(0x01), Minus: S(0x0c), Equal: S(0x0d), Backspace: S(0x0e), Tab: S(0x0f),
  BracketLeft: S(0x1a), BracketRight: S(0x1b), Enter: S(0x1c), ControlLeft: S(0x1d),
  Semicolon: S(0x27), Quote: S(0x28), Backquote: S(0x29), ShiftLeft: S(0x2a), Backslash: S(0x2b), IntlBackslash: S(0x56),
  Comma: S(0x33), Period: S(0x34), Slash: S(0x35), ShiftRight: S(0x36), NumpadMultiply: S(0x37), AltLeft: S(0x38),
  Space: S(0x39), CapsLock: S(0x3a), ScrollLock: S(0x46), NumLock: V(0x90), Pause: V(0x13),
  Numpad7: S(0x47), Numpad8: S(0x48), Numpad9: S(0x49), NumpadSubtract: S(0x4a), Numpad4: S(0x4b), Numpad5: S(0x4c),
  Numpad6: S(0x4d), NumpadAdd: S(0x4e), Numpad1: S(0x4f), Numpad2: S(0x50), Numpad3: S(0x51), Numpad0: S(0x52), NumpadDecimal: S(0x53),
  F11: S(0x57), F12: S(0x58), NumpadEnter: E(0x1c), ControlRight: E(0x1d), NumpadDivide: E(0x35), PrintScreen: E(0x37), AltRight: E(0x38),
  Home: E(0x47), ArrowUp: E(0x48), PageUp: E(0x49), ArrowLeft: E(0x4b), ArrowRight: E(0x4d), End: E(0x4f), ArrowDown: E(0x50),
  PageDown: E(0x51), Insert: E(0x52), Delete: E(0x53), MetaLeft: E(0x5b), MetaRight: E(0x5c), ContextMenu: E(0x5d),
};
'1234567890'.split('').forEach((d, i) => { KEYS['Digit' + d] = S(0x02 + i); });
'QWERTYUIOP'.split('').forEach((c, i) => { KEYS['Key' + c] = S(0x10 + i); });
'ASDFGHJKL'.split('').forEach((c, i) => { KEYS['Key' + c] = S(0x1e + i); });
'ZXCVBNM'.split('').forEach((c, i) => { KEYS['Key' + c] = S(0x2c + i); });
for (let i = 1; i <= 10; i++) KEYS['F' + i] = S(0x3a + i);
Object.setPrototypeOf(KEYS, null);

function keyInput(key, up) {
  const b = Buffer.alloc(SIZE);
  b.writeUInt32LE(1, 0);
  if (key.vk) b.writeUInt16LE(key.vk, 8); else b.writeUInt16LE(key.s, 10);
  b.writeUInt32LE((key.vk ? 0 : 0x8) | (key.e ? 0x1 : 0) | (up ? 0x2 : 0), 12);
  return b;
}
function mouseInput({ dx = 0, dy = 0, data = 0, flags }) {
  const b = Buffer.alloc(SIZE);
  b.writeInt32LE(dx, 8);
  b.writeInt32LE(dy, 12);
  b.writeInt32LE(data, 16);
  b.writeUInt32LE(flags, 20);
  return b;
}
const MOVE = 0x1 | 0x8000 | 0x4000; // absoluto sobre el escritorio virtual
const BUTTONS = [[0x2, 0x4, 0], [0x20, 0x40, 0], [0x8, 0x10, 0], [0x80, 0x100, 1], [0x80, 0x100, 2]];

function loadNative() {
  const koffi = require('koffi');
  const u = koffi.load('user32.dll');
  const SendInput = u.func('uint32_t __stdcall SendInput(uint32_t n, void *inputs, int size)');
  const GetSystemMetrics = u.func('int __stdcall GetSystemMetrics(int i)');
  return {
    send: (...list) => SendInput(list.length, Buffer.concat(list), SIZE),
    virtual: () => ({ x: GetSystemMetrics(76), y: GetSystemMetrics(77), w: GetSystemMetrics(78), h: GetSystemMetrics(79) }),
  };
}

class Injector {
  constructor(native = loadNative()) { this.n = native; this.down = new Map(); }
  _state(s) { let d = this.down.get(s); if (!d) this.down.set(s, d = { keys: new Set(), buttons: new Set() }); return d; }

  /** session.screenRect = pantalla compartida en pixeles fisicos {x,y,width,height} */
  handle(m, session) {
    const st = this._state(session);
    if (m.k === 'key') {
      const key = typeof m.code === 'string' ? KEYS[m.code] : undefined;
      if (!key) return;
      if (m.down) st.keys.add(m.code); else st.keys.delete(m.code);
      this.n.send(keyInput(key, !m.down));
    } else if (m.k === 'move') this._move(m, session);
    else if (m.k === 'btn') {
      const b = Number.isInteger(m.b) ? BUTTONS[m.b] : undefined;
      if (!b || !this._move(m, session)) return;
      if (m.down) st.buttons.add(m.b); else st.buttons.delete(m.b);
      this.n.send(mouseInput({ flags: m.down ? b[0] : b[1], data: b[2] }));
    } else if (m.k === 'wheel') {
      const c = (v) => (Number.isFinite(v) ? Math.max(-1200, Math.min(1200, Math.round(v))) : 0);
      const y = c(m.dy), x = c(m.dx);
      if (y) this.n.send(mouseInput({ flags: 0x800, data: -y }));
      if (x) this.n.send(mouseInput({ flags: 0x1000, data: x }));
    } else if (m.k === 'release') this.release(session);
  }
  _move(m, { screenRect: r }) {
    if (!r || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return false;
    const v = this.n.virtual(), cl = (n) => Math.max(0, Math.min(1, n));
    const px = r.x + cl(m.x) * (r.width - 1), py = r.y + cl(m.y) * (r.height - 1);
    this.n.send(mouseInput({
      dx: Math.round(((px - v.x) * 65535) / Math.max(1, v.w - 1)), dy: Math.round(((py - v.y) * 65535) / Math.max(1, v.h - 1)), flags: MOVE,
    }));
    return true;
  }
  /** Suelta todo lo que la sesion dejo pulsado. */
  release(session) {
    const st = this.down.get(session);
    if (!st) return;
    this.down.delete(session);
    for (const k of st.keys) this.n.send(keyInput(KEYS[k], true));
    for (const i of st.buttons) this.n.send(mouseInput({ flags: BUTTONS[i][1], data: BUTTONS[i][2] }));
  }
}
module.exports = { Injector, KEYS };
