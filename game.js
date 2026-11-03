/* Magic Cube — a 3D twisty colour-cube puzzle for PewPlay.
 * Raw WebGL renderer, pointer/touch layer turning, Web Audio sound.
 * Copyright (c) 2026 PewPlay — MIT licence.
 */
(function () {
  'use strict';

  var GAME_ID = 'magic-cube';
  var PI = Math.PI, HALF_PI = PI / 2;

  // ------------------------------------------------------------------ storage
  function load(k, def) {
    try { var v = localStorage.getItem(GAME_ID + ':' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
  }
  function save(k, v) { try { localStorage.setItem(GAME_ID + ':' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  var bests = load('best', {}) || {};
  var muted = !!load('muted', false);

  // ------------------------------------------------------------------ small 3x3 math (row-major arrays of 9)
  function m3mul(a, b) {
    var o = new Array(9);
    for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
  }
  function m3rot(axis, ang) {
    var c = Math.cos(ang), s = Math.sin(ang);
    if (axis === 0) return [1, 0, 0, 0, c, -s, 0, s, c];
    if (axis === 1) return [c, 0, s, 0, 1, 0, -s, 0, c];
    return [c, -s, 0, s, c, 0, 0, 0, 1];
  }
  function m3v(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }
  function m3tv(m, v) { return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]]; }
  function m3scale(m, s) { return m.map(function (x) { return x * s; }); }
  var I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  function orthonormalize(m) {
    // Gram–Schmidt on columns to stop drift from many small rotations
    var a = [m[0], m[3], m[6]], b = [m[1], m[4], m[7]];
    var la = Math.hypot(a[0], a[1], a[2]); a = a.map(function (x) { return x / la; });
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    b = [b[0] - d * a[0], b[1] - d * a[1], b[2] - d * a[2]];
    var lb = Math.hypot(b[0], b[1], b[2]); b = b.map(function (x) { return x / lb; });
    var c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
  }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function unit(axis, s) { var v = [0, 0, 0]; v[axis] = s || 1; return v; }

  // ------------------------------------------------------------------ cube model
  // Positions use doubled integer coordinates (2*index-(N-1)) so every layer is exact.
  // Each sticker = cubie position p, outward normal n, colour index c.
  var COLORS = [
    [0.86, 0.16, 0.22],   // +x red
    [1.00, 0.50, 0.10],   // -x orange
    [0.96, 0.96, 0.93],   // +y white
    [1.00, 0.80, 0.10],   // -y yellow
    [0.10, 0.68, 0.36],   // +z green
    [0.13, 0.42, 0.93]    // -z blue
  ];
  var N = 3, stickers = [], bodies = [];

  function buildCube(n) {
    N = n; stickers = []; bodies = [];
    var m = n - 1;
    for (var x = 0; x < n; x++) for (var y = 0; y < n; y++) for (var z = 0; z < n; z++) {
      var p = [2 * x - m, 2 * y - m, 2 * z - m];
      var outer = false;
      for (var k = 0; k < 3; k++) {
        if (p[k] === m) { stickers.push({ p: p.slice(), n: unit(k, 1), c: k * 2 }); outer = true; }
        if (p[k] === -m) { stickers.push({ p: p.slice(), n: unit(k, -1), c: k * 2 + 1 }); outer = true; }
      }
      if (outer) bodies.push(p);
    }
  }
  // +90° (right-handed) integer rotation about an axis, applied q times
  function rotInt(v, axis, q) {
    for (var i = 0; i < q; i++) {
      if (axis === 0) v = [v[0], -v[2], v[1]];
      else if (axis === 1) v = [v[2], v[1], -v[0]];
      else v = [-v[1], v[0], v[2]];
    }
    return v;
  }
  function layerCoord(layer) { return 2 * layer - (N - 1); }
  function applyMove(mv) {
    var q = ((mv.q % 4) + 4) % 4; if (!q) return;
    var c = layerCoord(mv.layer);
    for (var i = 0; i < stickers.length; i++) {
      var s = stickers[i];
      if (s.p[mv.axis] === c) { s.p = rotInt(s.p, mv.axis, q); s.n = rotInt(s.n, mv.axis, q); }
    }
  }
  function isSolved() {
    var seen = {};
    for (var i = 0; i < stickers.length; i++) {
      var s = stickers[i], key = s.n.join(',');
      if (seen[key] === undefined) seen[key] = s.c; else if (seen[key] !== s.c) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ DOM
  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('gl'), fx = $('fx'), fctx = fx.getContext('2d');
  var hud = $('hud'), bar = $('bar'), menu = $('menu'), menuCard = $('menuCard'), result = $('result'), toastEl = $('toast');
  var elTime = $('time'), elMoves = $('moves'), elBest = $('best');

  var gl = null;
  try { gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true }) || canvas.getContext('experimental-webgl'); } catch (e) { gl = null; }
  if (!gl) { $('nogl').classList.remove('hidden'); menu.classList.add('hidden'); return; }

  // ------------------------------------------------------------------ shaders
  function compile(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    return s;
  }
  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p); return p;
  }
  var litProg = program(
    'attribute vec3 aPos; attribute vec3 aNor; uniform mat4 uProj; uniform mat4 uMV;' +
    'varying vec3 vN; varying vec3 vP;' +
    'void main(){ vec4 p = uMV * vec4(aPos,1.0); vP = p.xyz; vN = mat3(uMV) * aNor; gl_Position = uProj * p; }',
    'precision mediump float; varying vec3 vN; varying vec3 vP;' +
    'uniform vec3 uColor; uniform float uSpec; uniform float uShin; uniform float uGlow;' +
    'void main(){' +
    ' vec3 N = normalize(vN); vec3 V = normalize(-vP);' +
    ' vec3 L1 = normalize(vec3(-0.4, 0.75, 0.95)); vec3 L2 = normalize(vec3(0.9, 0.05, 0.55));' +
    ' float hemi = 0.5 + 0.5 * N.y;' +
    ' vec3 amb = mix(vec3(0.40, 0.36, 0.46), vec3(0.62, 0.62, 0.70), hemi);' +
    ' float d1 = max(dot(N, L1), 0.0); float d2 = max(dot(N, L2), 0.0);' +
    ' vec3 col = uColor * (amb * 0.80 + vec3(1.0,0.98,0.95) * d1 * 0.70 + vec3(0.85,0.88,1.0) * d2 * 0.45);' +
    ' float s = pow(max(dot(N, normalize(L1 + V)), 0.0), uShin) * uSpec + pow(max(dot(N, normalize(L2 + V)), 0.0), uShin * 0.7) * uSpec * 0.35;' +
    ' float fr = pow(1.0 - max(dot(N, V), 0.0), 3.0);' +
    ' col += vec3(s) + fr * 0.10 * uSpec + uColor * uGlow;' +
    ' gl_FragColor = vec4(col, 1.0);' +
    '}');
  var shProg = program(
    'attribute vec3 aPos; uniform mat4 uProj; uniform mat4 uMV; varying vec2 vUV;' +
    'void main(){ vUV = aPos.xy; gl_Position = uProj * uMV * vec4(aPos.x, 0.0, aPos.y, 1.0); }',
    'precision mediump float; varying vec2 vUV; uniform float uA;' +
    'void main(){ float d = length(vUV); float a = pow(clamp(1.0 - d, 0.0, 1.0), 1.6) * uA; gl_FragColor = vec4(vec3(0.17,0.12,0.30) * a, a); }');

  var L = {
    aPos: gl.getAttribLocation(litProg, 'aPos'), aNor: gl.getAttribLocation(litProg, 'aNor'),
    uProj: gl.getUniformLocation(litProg, 'uProj'), uMV: gl.getUniformLocation(litProg, 'uMV'),
    uColor: gl.getUniformLocation(litProg, 'uColor'), uSpec: gl.getUniformLocation(litProg, 'uSpec'),
    uShin: gl.getUniformLocation(litProg, 'uShin'), uGlow: gl.getUniformLocation(litProg, 'uGlow')
  };
  var SL = {
    aPos: gl.getAttribLocation(shProg, 'aPos'), uProj: gl.getUniformLocation(shProg, 'uProj'),
    uMV: gl.getUniformLocation(shProg, 'uMV'), uA: gl.getUniformLocation(shProg, 'uA')
  };

  // ------------------------------------------------------------------ meshes
  function makeMesh(pos, nor, idx) {
    var m = { count: idx.length };
    m.pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, m.pb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
    m.nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, m.nb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(nor), gl.STATIC_DRAW);
    m.ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    return m;
  }
  // Rounded box: subdivided cube whose vertices are pushed onto a rounded surface.
  function roundedBox(h, r, seg) {
    var a = h - r, vals = [], k;
    for (k = seg; k >= 1; k--) vals.push(-a - r * Math.tan(PI / 4 * k / seg));
    vals.push(-a, a);
    for (k = 1; k <= seg; k++) vals.push(a + r * Math.tan(PI / 4 * k / seg));
    var pos = [], nor = [], idx = [], n = vals.length;
    for (var ax = 0; ax < 3; ax++) for (var sg = -1; sg <= 1; sg += 2) {
      var u = (ax + 1) % 3, v = (ax + 2) % 3, base = pos.length / 3;
      for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
        var p = [0, 0, 0]; p[ax] = sg * h; p[u] = vals[i]; p[v] = vals[j];
        var q = p.map(function (x) { return Math.max(-a, Math.min(a, x)); });
        var d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]], dl = Math.hypot(d[0], d[1], d[2]) || 1;
        d = d.map(function (x) { return x / dl; });
        pos.push(q[0] + d[0] * r, q[1] + d[1] * r, q[2] + d[2] * r); nor.push(d[0], d[1], d[2]);
      }
      for (i = 0; i < n - 1; i++) for (j = 0; j < n - 1; j++) {
        var A = base + i * n + j, B = base + (i + 1) * n + j, C = base + (i + 1) * n + j + 1, D = base + i * n + j + 1;
        if (sg > 0) idx.push(A, B, C, A, C, D); else idx.push(A, C, B, A, D, C);
      }
    }
    return makeMesh(pos, nor, idx);
  }
  // Glossy sticker: rounded square in the XY plane with a soft bevelled rim, facing +z.
  function stickerMesh(hs, rc, bev, rise, z0) {
    var cs = 6, outline = [], k, ci;
    var corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    for (ci = 0; ci < 4; ci++) for (k = 0; k <= cs; k++) {
      var th = (ci * 90 + 90 * k / cs) * PI / 180;
      outline.push({ cx: corners[ci][0], cy: corners[ci][1], c: Math.cos(th), s: Math.sin(th) });
    }
    var rings = [[0, 0, 0.78], [0.45, 0.72, 0.42], [1, 1, 0]]; // [inset fraction, height fraction, normal tilt]
    var pos = [], nor = [], idx = [], m = outline.length;
    rings.forEach(function (rg) {
      var ins = bev * rg[0], half = hs - ins, rad = Math.max(0.01, rc - ins);
      outline.forEach(function (o) {
        pos.push(o.cx * (half - rad) + o.c * rad, o.cy * (half - rad) + o.s * rad, z0 + rise * rg[1]);
        var t = rg[2]; var nl = Math.hypot(o.c * t, o.s * t, 1 - t * 0.6);
        nor.push(o.c * t / nl, o.s * t / nl, (1 - t * 0.6) / nl);
      });
    });
    for (var r = 0; r < 2; r++) for (k = 0; k < m; k++) {
      var o0 = r * m + k, o1 = r * m + (k + 1) % m, i0 = (r + 1) * m + k, i1 = (r + 1) * m + (k + 1) % m;
      idx.push(o0, o1, i1, o0, i1, i0);
    }
    var cIdx = pos.length / 3; pos.push(0, 0, z0 + rise); nor.push(0, 0, 1);
    for (k = 0; k < m; k++) idx.push(cIdx, 2 * m + k, 2 * m + (k + 1) % m);
    return makeMesh(pos, nor, idx);
  }
  var BODY_H = 0.475;
  var bodyMesh = roundedBox(BODY_H, 0.09, 4);
  var stickMesh = stickerMesh(0.405, 0.1, 0.05, 0.02, BODY_H + 0.001);
  var quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), gl.STATIC_DRAW);

  // orientation (3x3, columns x', y', n) taking the sticker's +z to each face normal
  var ORIENT = {};
  [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].forEach(function (n) {
    var x = Math.abs(n[1]) > 0.5 ? [1, 0, 0] : [0, 1, 0];
    var y = cross(n, x); x = cross(y, n);
    ORIENT[n.join(',')] = [x[0], y[0], n[0], x[1], y[1], n[1], x[2], y[2], n[2]];
  });

  // ------------------------------------------------------------------ view / camera
  var view = { W: 1, H: 1, dpr: 1, cx: 0, cy: 0, f: 500, tcx: 0, tcy: 0, tf: 500, d: 8, rpx: 200, init: false };
  var R_SPHERE = 1.76, fitScale = 1;            // bounding sphere of the cube (cube half-size = 1 in world units)
  var TILT = 0.46, YAW0 = -0.62, menuYaw = YAW0, yawAnim = null;
  var Rv = m3mul(m3rot(0, TILT), m3rot(1, YAW0)); // pleasant three-quarter view
  function S() { return 2 / N; }  // world units per cubie

  function computeLayout() {
    var W = window.innerWidth, H = window.innerHeight;
    var side = W > H * 1.25;
    document.body.classList.toggle('side', side);
    document.body.classList.toggle('short', H < 560);
    var fxr = 0, fyr = 0, fw = W, fh = H;
    if (!menu.classList.contains('hidden')) {
      var c = menuCard.getBoundingClientRect();
      if (side) { fw = Math.max(120, c.left); } else { fh = Math.max(120, c.top); }
    } else if (!hud.classList.contains('hidden')) {
      var h = hud.getBoundingClientRect(), b = bar.getBoundingClientRect();
      if (side) { fxr = h.right; fw = b.left - h.right; } else { fyr = h.bottom; fh = b.top - h.bottom; }
    }
    var pad = Math.min(fw, fh) * 0.025;
    view.tcx = fxr + fw / 2; view.tcy = fyr + fh / 2;
    var target = Math.max(60, Math.min(fw, fh) / 2 - pad) * fitScale;
    view.rpx = target;
    // fit a slightly smaller sphere than the true bound: typical views fill the space, corner-on views only touch the margin
    var RF = 1.6;
    view.tf = target * Math.sqrt(view.d * view.d - RF * RF) / RF;
    if (!view.init) { view.cx = view.tcx; view.cy = view.tcy; view.f = view.tf; view.init = true; }
  }
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = window.innerWidth, H = window.innerHeight;
    view.W = W; view.H = H; view.dpr = dpr;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    fx.width = canvas.width; fx.height = canvas.height;
    computeLayout();
  }
  function projMatrix() {
    var W = view.W, H = view.H, f = view.f, n = 0.5, fa = 40, m = new Float32Array(16);
    m[0] = 2 * f / W; m[8] = -(2 * view.cx / W - 1);
    m[5] = 2 * f / H; m[9] = -(1 - 2 * view.cy / H);
    m[10] = -(fa + n) / (fa - n); m[14] = -2 * fa * n / (fa - n); m[11] = -1;
    return m;
  }
  function mv4(M, t) { // 3x3 row-major + translation -> column-major mat4
    return new Float32Array([M[0], M[3], M[6], 0, M[1], M[4], M[7], 0, M[2], M[5], M[8], 0, t[0], t[1], t[2], 1]);
  }
  // cube-local (cubie units) -> screen CSS px
  function toScreen(pl) {
    var w = m3v(Rv, [pl[0] * S(), pl[1] * S(), pl[2] * S()]); w[2] -= view.d;
    return [view.cx + view.f * w[0] / -w[2], view.cy - view.f * w[1] / -w[2]];
  }
  // ray-cast a screen point onto the cube; returns hit face & local point or null
  function pick(x, y) {
    var dirC = [(x - view.cx) / view.f, -(y - view.cy) / view.f, -1];
    var s = S();
    var o = m3tv(Rv, [0, 0, view.d]).map(function (v) { return v / s; });
    var dv = m3tv(Rv, dirC);
    var h = N / 2, tmin = -Infinity, tmax = Infinity, fa = -1;
    for (var k = 0; k < 3; k++) {
      if (Math.abs(dv[k]) < 1e-9) { if (o[k] < -h || o[k] > h) return null; continue; }
      var t1 = (-h - o[k]) / dv[k], t2 = (h - o[k]) / dv[k];
      var tn = Math.min(t1, t2), tf = Math.max(t1, t2);
      if (tn > tmin) { tmin = tn; fa = k; }
      if (tf < tmax) tmax = tf;
    }
    if (tmin > tmax || tmax < 0 || fa < 0) return null;
    var P = [o[0] + dv[0] * tmin, o[1] + dv[1] * tmin, o[2] + dv[2] * tmin];
    return { fa: fa, sign: P[fa] > 0 ? 1 : -1, P: P };
  }

  // ------------------------------------------------------------------ audio (synthesised)
  var actx = null, master = null;
  function ensureAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    try { actx = new AC(); master = actx.createGain(); master.gain.value = muted ? 0 : 0.8; master.connect(actx.destination); } catch (e) { actx = null; }
  }
  var noiseBuf = null;
  function noise() {
    if (!noiseBuf) {
      noiseBuf = actx.createBuffer(1, actx.sampleRate * 0.2, actx.sampleRate);
      var d = noiseBuf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    var s = actx.createBufferSource(); s.buffer = noiseBuf; return s;
  }
  function sndTurn(vol) {
    if (!actx || muted) return;
    var t = actx.currentTime, v = vol == null ? 1 : vol;
    var n = noise(), bp = actx.createBiquadFilter(), g = actx.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 1600 + Math.random() * 700; bp.Q.value = 1.4;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.32 * v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    n.connect(bp); bp.connect(g); g.connect(master); n.start(t); n.stop(t + 0.09);
    var o = actx.createOscillator(), g2 = actx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.06);
    g2.gain.setValueAtTime(0.0001, t); g2.gain.exponentialRampToValueAtTime(0.25 * v, t + 0.005); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g2); g2.connect(master); o.start(t); o.stop(t + 0.1);
  }
  function tone(freq, t, dur, type, vol) {
    var o = actx.createOscillator(), g = actx.createGain();
    o.type = type || 'triangle'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.2, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  function sndClick() { if (!actx || muted) return; tone(660, actx.currentTime, 0.08, 'sine', 0.12); }
  function sndSolve() {
    if (!actx || muted) return;
    var t = actx.currentTime;
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach(function (f, i) { tone(f, t + i * 0.09, 0.5, 'triangle', 0.18); tone(f * 2, t + i * 0.09, 0.25, 'sine', 0.05); });
    [1046.5, 1318.5, 1568].forEach(function (f) { tone(f, t + 0.55, 1.1, 'sine', 0.09); });
  }
  function sndScramble() { if (!actx || muted) return; tone(330, actx.currentTime, 0.12, 'sine', 0.1); tone(495, actx.currentTime + 0.06, 0.14, 'sine', 0.08); }

  // ------------------------------------------------------------------ game state
  // mode: 'menu' | 'play'.   phase (in play): 'scrambling' | 'ready' | 'solving' | 'solved' | 'free'
  var mode = 'menu', phase = 'free';
  var queue = [];            // animated turns {axis, layer, q, from, dur, t, kind, done}
  var live = null;           // turn following the finger {axis, layer, angle}
  var history = [];          // user moves (for Undo)
  var moves = 0, tStart = 0, tAcc = 0, finalTime = 0;
  var spinVel = 0, glow = 0, attractT = 0;
  var hiddenAt = 0, lastScramble = [];

  function fmt(ms) {
    if (ms == null) return '—';
    var cs = Math.floor(ms / 10), s = Math.floor(cs / 100), m = Math.floor(s / 60);
    var c = cs % 100, ss = s % 60;
    return m + ':' + (ss < 10 ? '0' : '') + ss + '.' + (c < 10 ? '0' : '') + c;
  }
  function elapsed() {
    if (phase === 'solving') return tAcc + (performance.now() - tStart);
    if (phase === 'solved') return finalTime;
    return 0;
  }

  function bestFor(n) { return bests[n] ? bests[n].t : null; }
  function refreshBests() {
    document.querySelectorAll('[data-best]').forEach(function (el) { el.textContent = fmt(bestFor(el.getAttribute('data-best'))); });
    elBest.textContent = fmt(bestFor(N));
  }
  function setSizeButtons() {
    document.querySelectorAll('[data-n]').forEach(function (b) { b.classList.toggle('on', +b.getAttribute('data-n') === N); });
  }

  var toastTimer = 0;
  function toast(msg, ms) {
    toastEl.textContent = msg; toastEl.classList.remove('hidden');
    toastEl.style.animation = 'none'; void toastEl.offsetWidth; toastEl.style.animation = '';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, ms || 2500);
  }
  function placeToast() {
    var r = hud.classList.contains('hidden') ? null : hud.getBoundingClientRect();
    toastEl.style.top = (r && !document.body.classList.contains('side') ? r.bottom + 8 : 14) + 'px';
  }

  // ---- turn animation queue
  function enqueue(mv, kind, dur, from) {
    queue.push({ axis: mv.axis, layer: mv.layer, q: mv.q, from: from || 0, dur: dur, t: 0, kind: kind, cb: mv.cb });
  }
  function finishTurn(a) {
    if (a.q) applyMove(a);
    if (a.kind === 'user' || a.kind === 'undo') afterUserMove(a);
    if (a.cb) a.cb();
  }
  function flushQueue() {
    while (queue.length) finishTurn(queue.shift());
    updateButtons();
  }
  function turnDur() { return 170 + N * 10; }

  function canTurn() { return mode === 'play' && phase !== 'scrambling' && result.classList.contains('hidden'); }

  function userMove(mv) { // keyboard / button generated turn
    if (!canTurn() || live) return;
    if (queue.length > 3) flushQueue();
    enqueue(mv, 'user', turnDur());
    sndTurn();
  }
  function afterUserMove(a) {
    if (!a.q) return;
    if (a.kind === 'user') history.push({ axis: a.axis, layer: a.layer, q: a.q });
    if (phase === 'ready') { phase = 'solving'; tStart = performance.now(); tAcc = 0; }
    moves++;
    if (isSolved()) {
      if (phase === 'solving') celebrate(true);
      else if (phase === 'free') celebrate(false);
    }
  }

  function scramble() {
    ensureAudio();
    mode = 'play';
    live = null; flushQueue();
    buildCube(N);
    history = []; moves = 0; phase = 'scrambling'; tAcc = 0;
    var count = N === 2 ? 12 : N === 3 ? 22 : 38, lastAxis = -1, list = [];
    lastScramble = list;
    for (var i = 0; i < count; i++) {
      var axis; do { axis = Math.floor(Math.random() * 3); } while (axis === lastAxis);
      lastAxis = axis;
      list.push({ axis: axis, layer: Math.floor(Math.random() * N), q: [1, -1, 2][Math.floor(Math.random() * 3)] });
    }
    // make sure it never ends solved (practically impossible, but cheap to guard)
    var dur = N === 4 ? 70 : 85;
    list.forEach(function (mv, i) {
      if (i === list.length - 1) mv.cb = function () {
        if (isSolved()) { scramble(); return; }
        phase = 'ready'; updateButtons();
        toast(window.matchMedia('(pointer: coarse)').matches ? 'Timer starts with your first turn. Swipe a sticker to twist!' : 'Timer starts with your first turn. Drag a sticker to twist!', 3200);
      };
      enqueue(mv, 'scramble', dur);
    });
    sndScramble();
    updateButtons();
  }
  function resetCube() {
    live = null; queue = []; buildCube(N); history = []; moves = 0; phase = 'free'; tAcc = 0;
    updateButtons(); toast('Free play: twist as you like. Press Scramble for a timed solve.', 2800);
  }
  function undo() {
    if (!canTurn() || phase === 'solved') return;
    flushQueue();
    var last = history.pop(); if (!last) return;
    enqueue({ axis: last.axis, layer: last.layer, q: -last.q }, 'undo', turnDur());
    sndTurn(0.8); updateButtons();
  }
  function setSize(n) {
    if (n === N && mode === 'play') { scramble(); return; }
    N = n; save('size', n); setSizeButtons(); refreshBests();
    if (mode === 'play') scramble(); else { queue = []; buildCube(N); }
  }

  function celebrate(timed) {
    spinVel = 3.2; glow = 1;
    burstConfetti(timed ? 220 : 120);
    sndSolve();
    if (!timed) { phase = 'free'; history = []; toast('Solved! Nicely done.', 2400); updateButtons(); return; }
    phase = 'solved'; finalTime = tAcc + (performance.now() - tStart);
    var prev = bests[N], isNew = !prev || finalTime < prev.t;
    if (isNew) { bests[N] = { t: Math.round(finalTime), m: moves }; save('best', bests); }
    refreshBests(); updateButtons();
    $('resSize').textContent = N + '×' + N + ' cube';
    $('resTime').textContent = fmt(finalTime);
    $('resMoves').textContent = moves;
    var rb = $('resBest');
    rb.textContent = isNew ? (prev ? 'New best! (was ' + fmt(prev.t) + ')' : 'New best time!') : 'Best: ' + fmt(prev.t);
    rb.classList.toggle('new', isNew);
    setTimeout(function () { if (phase === 'solved' && mode === 'play') { result.classList.remove('hidden'); } }, 1300);
  }

  function updateButtons() {
    $('btnUndo').disabled = !(history.length && phase !== 'scrambling' && phase !== 'solved');
    $('btnScramble').disabled = phase === 'scrambling';
    $('btnReset').disabled = phase === 'scrambling';
  }

  function showMenu() {
    mode = 'menu'; live = null; queue = []; result.classList.add('hidden');
    buildCube(N); phase = 'free'; attractT = 0;
    menu.classList.remove('hidden'); hud.classList.add('hidden'); bar.classList.add('hidden'); toastEl.classList.add('hidden');
    refreshBests(); setSizeButtons(); computeLayout();
  }
  function startGame() {
    ensureAudio(); sndClick();
    menu.classList.add('hidden'); hud.classList.remove('hidden'); bar.classList.remove('hidden');
    computeLayout(); placeToast();
    var q4 = HALF_PI, to = YAW0 + Math.round((menuYaw - YAW0) / q4) * q4;
    yawAnim = { from: menuYaw, to: to, t: 0 };
    scramble();
  }

  // ------------------------------------------------------------------ confetti
  var parts = [];
  function burstConfetti(n) {
    var cx = view.cx, cy = view.cy, r = view.rpx;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * PI * 2, sp = 4 + Math.random() * 9;
      var col = COLORS[i % 6];
      parts.push({
        x: cx + Math.cos(a) * r * 0.3, y: cy + Math.sin(a) * r * 0.3,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 5, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        w: 6 + Math.random() * 7, h: 4 + Math.random() * 5, life: 1, decay: 0.006 + Math.random() * 0.006,
        col: 'rgb(' + (col[0] * 255 | 0) + ',' + (col[1] * 255 | 0) + ',' + (col[2] * 255 | 0) + ')'
      });
    }
  }
  function drawConfetti(k) {
    var dpr = view.dpr;
    fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.clearRect(0, 0, fx.width, fx.height);
    if (!parts.length) return;
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.vy += 0.25 * k; p.vx *= Math.pow(0.985, k); p.vy *= Math.pow(0.985, k);
      p.x += p.vx * k; p.y += p.vy * k; p.rot += p.vr * k; p.life -= p.decay * k;
      if (p.life <= 0 || p.y > view.H + 40) { parts.splice(i, 1); continue; }
      fctx.save(); fctx.globalAlpha = Math.min(1, p.life * 2); fctx.translate(p.x, p.y); fctx.rotate(p.rot);
      fctx.scale(1, Math.cos(p.rot * 2.3)); fctx.fillStyle = p.col; fctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); fctx.restore();
    }
  }

  // ------------------------------------------------------------------ rendering
  function render() {
    var s = S(), W = canvas.width, H = canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    var P = projMatrix();

    // soft contact shadow under the cube
    gl.useProgram(shProg); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniformMatrix4fv(SL.uProj, false, P);
    gl.uniformMatrix4fv(SL.uMV, false, mv4([1.9, 0, 0, 0, 1, 0, 0, 0, 1.9], [0, -R_SPHERE * 0.98, -view.d]));
    gl.uniform1f(SL.uA, 0.42);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(SL.aPos); gl.vertexAttribPointer(SL.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(SL.aPos);
    gl.disable(gl.BLEND);

    gl.useProgram(litProg); gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.uniformMatrix4fv(L.uProj, false, P);
    gl.enableVertexAttribArray(L.aPos); gl.enableVertexAttribArray(L.aNor);

    // the turning layer (finger-driven or animated)
    var act = live, aAng = 0, aCoord = 999, aRot = null;
    if (!act && queue.length) act = queue[0];
    if (act) {
      aAng = act === live ? live.angle : act.from + (act.q * HALF_PI - act.from) * ease(Math.min(1, act.t / act.dur));
      aCoord = layerCoord(act.layer); aRot = m3rot(act.axis, aAng);
    }
    var RvS = m3scale(Rv, s), RvSL = aRot ? m3mul(RvS, aRot) : null;

    function bind(m) {
      gl.bindBuffer(gl.ARRAY_BUFFER, m.pb); gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.nb); gl.vertexAttribPointer(L.aNor, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
    }
    // bodies
    bind(bodyMesh);
    gl.uniform3f(L.uColor, 0.085, 0.09, 0.115); gl.uniform1f(L.uSpec, 0.32); gl.uniform1f(L.uShin, 36); gl.uniform1f(L.uGlow, 0);
    var i, b, M, t, inL;
    for (i = 0; i < bodies.length; i++) {
      b = bodies[i]; inL = act && b[act.axis] === aCoord; M = inL ? RvSL : RvS;
      t = m3v(M, [b[0] / 2, b[1] / 2, b[2] / 2]); t[2] -= view.d;
      gl.uniformMatrix4fv(L.uMV, false, mv4(M, t));
      gl.drawElements(gl.TRIANGLES, bodyMesh.count, gl.UNSIGNED_SHORT, 0);
    }
    // stickers
    bind(stickMesh);
    gl.uniform1f(L.uSpec, 0.55); gl.uniform1f(L.uShin, 64); gl.uniform1f(L.uGlow, glow * 0.35);
    for (i = 0; i < stickers.length; i++) {
      var st = stickers[i]; inL = act && st.p[act.axis] === aCoord; M = inL ? RvSL : RvS;
      t = m3v(M, [st.p[0] / 2, st.p[1] / 2, st.p[2] / 2]); t[2] -= view.d;
      var c = COLORS[st.c];
      gl.uniform3f(L.uColor, c[0], c[1], c[2]);
      gl.uniformMatrix4fv(L.uMV, false, mv4(m3mul(M, ORIENT[st.n.join(',')]), t));
      gl.drawElements(gl.TRIANGLES, stickMesh.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.disableVertexAttribArray(L.aPos); gl.disableVertexAttribArray(L.aNor);
  }
  function ease(x) { return 1 - Math.pow(1 - x, 3); }

  // ------------------------------------------------------------------ main loop
  var last = performance.now(), running = true, lastTimeTxt = '', lastMovesTxt = '';
  var keysHeld = {};
  function frame(now) {
    if (!running) return;
    var prevNow = last, dt = Math.min(50, now - last); last = now;
    var k = dt / 16.667;

    // ease the camera toward the layout target (smooth when panels appear/disappear)
    var e = 1 - Math.pow(0.001, dt / 1000 * 2.5);
    view.cx += (view.tcx - view.cx) * e; view.cy += (view.tcy - view.cy) * e; view.f += (view.tf - view.f) * e;

    // turn queue
    // (uses the real frame time so slow devices still finish turns on schedule)
    var qdt = Math.min(250, now - prevNow);
    while (!live && queue.length && qdt > 0) {
      var a = queue[0], need = a.dur - a.t;
      if (qdt < need) { a.t += qdt; break; }
      qdt -= need; queue.shift(); finishTurn(a); updateButtons();
      if (queue.length && queue[0].kind === 'scramble') sndTurn(0.35);
    }
    // menu attract mode: slow spin and lazy random twists
    if (mode === 'menu') {
      menuYaw += dt * 0.00035; Rv = m3mul(m3rot(0, TILT), m3rot(1, menuYaw));
      attractT += dt;
      if (attractT > 1100 && !queue.length) {
        attractT = 0;
        enqueue({ axis: Math.floor(Math.random() * 3), layer: Math.floor(Math.random() * N), q: Math.random() < 0.5 ? 1 : -1 }, 'attract', 420);
      }
    }
    // glide back to a three-quarter view when a game starts
    if (yawAnim) {
      yawAnim.t = Math.min(1, yawAnim.t + dt / 650);
      var yy = yawAnim.from + (yawAnim.to - yawAnim.from) * ease(yawAnim.t);
      Rv = m3mul(m3rot(0, TILT), m3rot(1, yy));
      if (yawAnim.t >= 1) yawAnim = null;
    }
    // celebration spin
    if (spinVel > 0.01) { var up = viewFrame().U; Rv = m3mul(Rv, m3rot(up.axis, up.sign * spinVel * dt / 1000)); spinVel *= Math.pow(0.45, dt / 1000); }
    if (glow > 0) glow = Math.max(0, glow - dt / 1400);
    // keyboard orbit
    var ox = (keysHeld.ArrowRight ? 1 : 0) - (keysHeld.ArrowLeft ? 1 : 0), oy = (keysHeld.ArrowDown ? 1 : 0) - (keysHeld.ArrowUp ? 1 : 0);
    if (ox || oy) orbit(ox * dt * 0.5, oy * dt * 0.5);
    Rv = orthonormalize(Rv);

    render();
    drawConfetti(k);

    if (mode === 'play') {
      var tt = fmt(elapsed()); if (tt !== lastTimeTxt) { elTime.textContent = tt; lastTimeTxt = tt; }
      var mt = String(moves); if (mt !== lastMovesTxt) { elMoves.textContent = mt; lastMovesTxt = mt; }
    }
    requestAnimationFrame(frame);
  }

  function orbit(dx, dy) {
    yawAnim = null;
    var kk = 2.4 / Math.max(120, view.rpx);
    Rv = m3mul(m3rot(1, dx * kk), m3mul(m3rot(0, dy * kk), Rv));
  }

  // ------------------------------------------------------------------ pointer input
  var pointers = new Map(), drag = null;
  function midpoint() {
    var x = 0, y = 0; pointers.forEach(function (p) { x += p.x; y += p.y; });
    return [x / pointers.size, y / pointers.size];
  }
  canvas.addEventListener('pointerdown', function (e) {
    ensureAudio();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) { // two fingers: always orbit (cancel a half-made turn)
      cancelLive();
      var m = midpoint(); drag = { mode: 'orbit2', lx: m[0], ly: m[1] }; return;
    }
    var hit = canTurn() ? pick(e.clientX, e.clientY) : null;
    if (hit) flushQueue();
    drag = { mode: hit ? 'pending' : 'orbit', id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, hit: hit, touch: e.pointerType !== 'mouse' };
    canvas.classList.add('turning');
  });
  canvas.addEventListener('pointermove', function (e) {
    var p = pointers.get(e.pointerId); if (!p || !drag) return;
    p.x = e.clientX; p.y = e.clientY;
    if (drag.mode === 'orbit2') {
      var m = midpoint(); orbit(m[0] - drag.lx, m[1] - drag.ly); drag.lx = m[0]; drag.ly = m[1]; return;
    }
    if (e.pointerId !== drag.id) return;
    var x = e.clientX, y = e.clientY;
    if (drag.mode === 'orbit') { orbit(x - drag.lx, y - drag.ly); drag.lx = x; drag.ly = y; return; }
    if (drag.mode === 'pending') {
      var dx = x - drag.sx, dy = y - drag.sy;
      if (Math.hypot(dx, dy) < (drag.touch ? 10 : 7)) return;
      if (!canTurn()) { drag.mode = 'orbit'; drag.lx = x; drag.ly = y; return; }
      startLive(dx, dy);
    }
    if (drag.mode === 'turn') {
      var now = performance.now();
      var along = ((x - drag.sx) * drag.sdx + (y - drag.sy) * drag.sdy) / drag.ppu;
      var ang = drag.sgn * along * HALF_PI / (N * 0.42);
      ang = Math.max(-PI, Math.min(PI, ang));
      var dtm = Math.max(1, now - drag.lt);
      drag.vel = drag.vel * 0.6 + ((ang - live.angle) / dtm) * 0.4; drag.lt = now;
      live.angle = ang;
    }
  });
  // Decide which layer turns from the swipe direction and the face that was grabbed.
  function startLive(dx, dy) {
    var hit = drag.hit, P = hit.P;
    var tans = [0, 1, 2].filter(function (a) { return a !== hit.fa; });
    var sp = toScreen(P);
    var sv = tans.map(function (ta) { var q = P.slice(); q[ta] += 1; var s2 = toScreen(q); return [s2[0] - sp[0], s2[1] - sp[1]]; });
    // express the swipe as α·s1 + β·s2 (units moved along each tangent axis of the face)
    var s1 = sv[0], s2 = sv[1], det = s1[0] * s2[1] - s1[1] * s2[0];
    var al, be;
    if (Math.abs(det) > 1e-3 * Math.hypot(s1[0], s1[1]) * Math.hypot(s2[0], s2[1])) {
      al = (dx * s2[1] - dy * s2[0]) / det; be = (s1[0] * dy - s1[1] * dx) / det;
    } else {
      al = (dx * s1[0] + dy * s1[1]) / (Math.hypot(s1[0], s1[1]) || 1); be = (dx * s2[0] + dy * s2[1]) / (Math.hypot(s2[0], s2[1]) || 1);
    }
    var pickIdx = Math.abs(al) >= Math.abs(be) ? 0 : 1;
    var ta = tans[pickIdx], sdir = sv[pickIdx];
    var axis = 3 - hit.fa - ta;
    var layer = Math.max(0, Math.min(N - 1, Math.floor(P[axis] + N / 2)));
    var sgn = Math.sign(dot(cross(unit(axis, 1), P), unit(ta, 1))) || 1;
    var ppu = Math.hypot(sdir[0], sdir[1]) || 1;
    drag.mode = 'turn'; drag.sdx = sdir[0] / ppu; drag.sdy = sdir[1] / ppu; drag.sgn = sgn;
    // foreshortened faces would otherwise make the layer spin too fast
    drag.ppu = Math.max(ppu, 0.6 * view.f * S() / view.d);
    drag.vel = 0; drag.lt = performance.now();
    live = { axis: axis, layer: layer, angle: 0 };
  }
  function releaseLive() {
    if (!live) return;
    var ang = live.angle, k = Math.round(ang / HALF_PI);
    if (k === 0 && Math.abs(ang) > 0.3) k = Math.sign(ang);
    if (k === 0 && Math.abs(drag.vel) > 0.004 && Math.sign(drag.vel) === Math.sign(ang)) k = Math.sign(ang);
    k = Math.max(-2, Math.min(2, k));
    var dur = 90 + Math.abs(k * HALF_PI - ang) * 120;
    enqueue({ axis: live.axis, layer: live.layer, q: k }, 'user', dur, ang);
    if (k) sndTurn();
    live = null;
  }
  function cancelLive() {
    if (!live) return;
    enqueue({ axis: live.axis, layer: live.layer, q: 0 }, 'user', 140, live.angle);
    live = null;
  }
  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!drag) return;
    if (drag.mode === 'orbit2') {
      if (pointers.size === 1) { var rest = pointers.entries().next().value; drag = { mode: 'orbit', id: rest[0], lx: rest[1].x, ly: rest[1].y }; }
      else if (!pointers.size) drag = null;
      return;
    }
    if (e.pointerId !== drag.id) return;
    if (drag.mode === 'turn') releaseLive();
    drag = null; canvas.classList.remove('turning'); updateButtons();
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', endPointer);
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // ------------------------------------------------------------------ keyboard (moves relative to the current view)
  function viewFrame() {
    var cols = [0, 1, 2].map(function (k) { return [Rv[k], Rv[3 + k], Rv[6 + k]]; });
    function best(comp, excl) {
      var bi = -1, bs = 1, bv = -2;
      for (var k = 0; k < 3; k++) { if (excl.indexOf(k) >= 0) continue; var v = cols[k][comp]; if (Math.abs(v) > bv) { bv = Math.abs(v); bi = k; bs = v > 0 ? 1 : -1; } }
      return { axis: bi, sign: bs };
    }
    var F = best(2, []), U = best(1, [F.axis]), Rr = best(0, [F.axis, U.axis]);
    return { F: F, U: U, R: Rr };
  }
  function faceMove(letter, prime) {
    var fr = viewFrame(), f;
    switch (letter) {
      case 'F': f = fr.F; break; case 'B': f = { axis: fr.F.axis, sign: -fr.F.sign }; break;
      case 'U': f = fr.U; break; case 'D': f = { axis: fr.U.axis, sign: -fr.U.sign }; break;
      case 'R': f = fr.R; break; case 'L': f = { axis: fr.R.axis, sign: -fr.R.sign }; break;
    }
    // clockwise seen from outside = -90° about the outward normal
    var q = -f.sign * (prime ? -1 : 1);
    userMove({ axis: f.axis, layer: f.sign > 0 ? N - 1 : 0, q: q });
  }
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) { if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { undo(); e.preventDefault(); } return; }
    if (e.key.indexOf('Arrow') === 0) { keysHeld[e.key] = true; e.preventDefault(); return; }
    if (mode === 'menu') { if (e.key === 'Enter' || e.key === ' ') { startGame(); e.preventDefault(); } return; }
    var up = e.key.toUpperCase();
    if ('UDLRFB'.indexOf(up) >= 0 && up.length === 1) { ensureAudio(); faceMove(up, e.shiftKey); e.preventDefault(); return; }
    if (up === 'Z' || e.key === 'Backspace') { undo(); e.preventDefault(); return; }
    if (e.key === 'Escape') { if (!result.classList.contains('hidden')) result.classList.add('hidden'); else showMenu(); }
  });
  window.addEventListener('keyup', function (e) { if (e.key.indexOf('Arrow') === 0) keysHeld[e.key] = false; });
  window.addEventListener('blur', function () { keysHeld = {}; });

  // ------------------------------------------------------------------ buttons
  function on(id, fn) { $(id).addEventListener('click', function (e) { ensureAudio(); fn(e); }); }
  on('btnPlay', startGame);
  on('btnMenu', function () { sndClick(); showMenu(); });
  on('btnUndo', function () { undo(); });
  on('btnScramble', function () { result.classList.add('hidden'); scramble(); });
  on('btnReset', function () { sndClick(); result.classList.add('hidden'); resetCube(); });
  on('btnAgain', function () { result.classList.add('hidden'); scramble(); });
  on('btnToMenu', function () { sndClick(); showMenu(); });
  on('btnCloseRes', function () { sndClick(); result.classList.add('hidden'); });
  on('btnMute', function () {
    muted = !muted; save('muted', muted);
    $('btnMute').classList.toggle('muted', muted);
    if (master) master.gain.value = muted ? 0 : 0.8;
    sndClick();
  });
  document.querySelectorAll('#menuSizes [data-n]').forEach(function (b) {
    b.addEventListener('click', function () { ensureAudio(); sndClick(); setSize(+b.getAttribute('data-n')); });
  });
  document.querySelectorAll('#sizeSeg [data-n]').forEach(function (b) {
    b.addEventListener('click', function () { ensureAudio(); result.classList.add('hidden'); setSize(+b.getAttribute('data-n')); });
  });
  $('btnMute').classList.toggle('muted', muted);

  // ------------------------------------------------------------------ lifecycle
  window.addEventListener('resize', function () { resize(); placeToast(); });
  window.addEventListener('orientationchange', function () { setTimeout(function () { resize(); placeToast(); }, 120); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      running = false; hiddenAt = performance.now();
      if (phase === 'solving') { tAcc += hiddenAt - tStart; }
      if (actx && actx.state === 'running') actx.suspend();
    } else if (!running) {
      running = true; last = performance.now();
      if (phase === 'solving') tStart = performance.now();
      if (actx && actx.state === 'suspended') actx.resume();
      requestAnimationFrame(frame);
    }
  });

  N = [2, 3, 4].indexOf(load('size', 3)) >= 0 ? load('size', 3) : 3;
  buildCube(N);
  showMenu();
  resize();
  requestAnimationFrame(frame);

  // Small debug/testing hook (also used to produce store screenshots).
  window.MagicCube = {
    get N() { return N; }, get phase() { return phase; }, get moves() { return moves; },
    isSolved: isSolved, scramble: scramble, start: startGame, setSize: setSize,
    turn: function (axis, layer, q) { userMove({ axis: axis, layer: layer, q: q }); },
    applyInstant: function (axis, layer, q) { applyMove({ axis: axis, layer: layer, q: q }); },
    history: function () { return history.slice(); },
    scrambleMoves: function () { return lastScramble.map(function (m) { return { axis: m.axis, layer: m.layer, q: m.q }; }); },
    stickers: function () { return stickers; },
    get Rv() { return Rv.slice(); },
    flush: flushQueue,
    project: function (p) { return toScreen(p); },
    pick: pick,
    setFit: function (k) { fitScale = k; view.init = false; computeLayout(); },
    setView: function (ax, ay) { Rv = m3mul(m3rot(0, ax), m3rot(1, ay)); }
  };
})();
