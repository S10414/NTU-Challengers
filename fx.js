/* fx.js — Revela 的視覺層
   Lenis  → 平滑捲動，並提供捲動速度給背景
   GSAP   → 全部動態與時間軸（也是唯一的 ticker）
   WebGL  → 視覺核心：① 照片從暖光裡浮現 ② （保留未用）日落 ③ 常駐的黃昏背景（會回應手指、滑動、傾斜）
   沒有顆粒、沒有閃動：所有變化都是慢的、連續的。

   這個檔案是可選的：index.html 只透過 window.FX 呼叫它。
   載入失敗、沒有 WebGL、或使用者開了「減少動態」，App 都會降級到可用的樣子。
   除錯用：網址加 ?nogl=1 可強制走無 WebGL 的路徑。 */
(function () {
  'use strict';

  var hasGSAP = typeof window.gsap !== 'undefined';
  var noGL = /[?&]nogl=1/.test(location.search);
  var reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var calm = false;                                  // 設定裡的「簡化動畫」
  var reduced = function () { return calm || reduceMQ.matches; };
  var $ = function (s) { return document.querySelector(s); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  /* ---------------------------------------------------------------- GLSL */
  var VERT = 'attribute vec2 p;varying vec2 vUv;void main(){vUv=p*.5+.5;gl_Position=vec4(p,0.,1.);}';
  var PRE = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\nvarying vec2 vUv;\n';
  var NOISE = [
    'float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}',
    'float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);',
    '  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}',
    'float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*vnoise(p);p=p*2.03+vec2(17.1,9.2);a*=.5;}return v;}'
  ].join('\n');

  var DITHER = '  col+=(hash(floor(uv*uRes))-.5)*.006;';   // 靜態的極淡抖色，只為了讓漸層不出現色階，不會動

  /* ① 照片：一道夕陽光斜斜掃過，照片從暖光裡浮出來。uProg = 1 時輸出就是原圖。 */
  var PHOTO_FRAG = PRE + NOISE + [
    'uniform sampler2D uTex;uniform float uProg;uniform float uSeed;uniform vec3 uBase;uniform vec2 uRes;uniform float uFrame;',
    'void main(){',
    '  vec2 uv=vUv;',
    '  vec3 img=texture2D(uTex,uv).rgb;',
    '  float s=uv.x*.72+(1.-uv.y)*.28;',
    '  float edge=uProg*1.55-.22;',
    '  float a=1.-smoothstep(edge-.28,edge,s);',
    '  float fin=smoothstep(.82,1.,uProg);',
    '  vec3 warm=img*mix(vec3(1.10,.99,.84),vec3(1.),fin)+vec3(.05,.03,.0)*(1.-fin);',
    '  vec3 base=mix(uBase,vec3(1.,.90,.72),.35);',
    '  vec3 col=mix(base,warm,a);',
    '  float band=exp(-pow((s-edge+.06)/.11,2.))*(1.-fin)*smoothstep(0.,.08,uProg);',
    '  col+=vec3(.34,.24,.10)*band;',
    '  gl_FragColor=vec4(min(col,1.),1.);',
    '}'
  ].join('\n');

  /* ② 兩分鐘的日落。uLeft 1 → 0：太陽從高處沉到地平線下，天色從金、到粉、到紫。
        整片維持明亮的粉彩，深色文字在任何時刻都讀得清楚。時間到了不是結束，是餘暉。 */
  var SAFE_FRAG = PRE + NOISE + [
    'uniform vec2 uRes;uniform float uT;uniform float uFrame;uniform float uLeft;',
    'void main(){',
    '  vec2 uv=vUv; float asp=uRes.x/uRes.y; float t=1.-uLeft; float hz=.24;',
    '  vec3 top=mix(vec3(.935,.815,.720),vec3(.770,.715,.855),t);',
    '  vec3 mid=mix(vec3(.990,.880,.680),vec3(.960,.770,.750),t);',
    '  vec3 hor=mix(vec3(1.,.930,.740),vec3(.985,.790,.660),t);',
    '  vec3 col=mix(hor,mid,smoothstep(hz,hz+.30,uv.y));',
    '  col=mix(col,top,smoothstep(hz+.25,1.,uv.y));',
    '  float below=1.-smoothstep(hz-.012,hz+.004,uv.y);',
    '  col=mix(col,mix(hor,mid,.5)*.955,below);',
    '  float c=smoothstep(.55,.82,fbm(vec2(uv.x*asp*.8+uT*.004,uv.y*4.)))*smoothstep(hz+.08,hz+.34,uv.y);',
    '  col=mix(col,mix(vec3(1.,.94,.86),vec3(.95,.82,.84),t),c*.18);',
    '  vec2 sp=vec2(.5,mix(.80,hz-.085,t));',
    '  vec2 d=(uv-sp)*vec2(asp,1.); float r=length(d);',
    '  float above=smoothstep(hz-.004,hz+.004,uv.y);',
    '  float gone=smoothstep(.93,1.,t);',
    '  col+=vec3(.10,.07,.02)*exp(-r*r*9.)*(.55+.45*above)*(1.-.45*gone);',
    '  col+=vec3(.04,.02,.0)*exp(-r*r*1.6)*(1.-.3*gone);',
    '  col=mix(col,vec3(1.,.975,.89),smoothstep(.076,.069,r)*above*.94);',
    '  float rx=exp(-pow((uv.x-.5)*asp*4.,2.))*below*(1.-gone);',
    '  col+=vec3(.06,.04,.01)*rx*(.65+.35*sin(uv.y*80.));',
    DITHER,
    '  gl_FragColor=vec4(min(col,1.),1.);',
    '}'
  ].join('\n');

  /* ③ 黃昏背景（原本的配色）：上方霧桃粉、中間米白的霧、下方褪色的枯草，地平線一條很淡的樹影。
        不放顆粒、不閃動。uTouch：手指碰到的地方光暖一點；uFlow：滑動時景物往旁邊流過。 */
  var AMB_FRAG = PRE + NOISE + [
    'uniform vec2 uRes;uniform float uT;uniform float uVel;uniform float uWash;uniform float uFlow;uniform float uTouchA;uniform float uHz;',
    'uniform vec2 uTouch;uniform vec2 uTilt;',
    'void main(){',
    '  vec2 uv=vUv; float asp=uRes.x/uRes.y; float y=uv.y+uHz;',
    '  vec3 sky=vec3(.902,.780,.722), haze=vec3(.949,.894,.839), hor=vec3(.886,.812,.741), fld=vec3(.831,.733,.624);',
    '  vec3 col=mix(fld,hor,smoothstep(0.,.40,y));',
    '  col=mix(col,haze,smoothstep(.40,.54,y));',
    '  col=mix(col,sky,smoothstep(.54,1.,y));',
    '  float fl=uT*.006+uFlow+uTilt.x*.05;',
    '  float st=fbm(vec2(uv.x*asp*.32+fl,y*16.));',
    '  float ground=1.-smoothstep(.30,.46,y);',
    '  col*=1.+(st-.5)*(.025+.05*ground);',
    '  float tb=fbm(vec2(uv.x*asp*1.1+fl*1.7,2.3));',
    '  float top=.43+tb*.085+uTilt.y*.01;',
    '  float tree=smoothstep(top,top-.07,y)*smoothstep(.33,.41,y);',
    '  col=mix(col,vec3(.55,.47,.42),tree*.16);',
    '  col*=1.+sin(y*40.+fl*30.)*uVel*.006;',
    '  vec2 td=(uv-uTouch)*vec2(asp,1.);',
    '  col+=vec3(.060,.036,.012)*exp(-dot(td,td)*10.)*uTouchA;',
    '  float band=exp(-pow((y-uWash)*5.,2.))*step(.001,uWash)*step(uWash,.999);',
    '  col+=band*.025;',
    DITHER,
    '  gl_FragColor=vec4(min(col,1.),1.);',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------ 全螢幕四邊形 */
  function Quad(canvas, frag) {
    var self = this;
    this.c = canvas; this.frag = frag; this.vals = {}; this.loc = {};
    this.ok = false; this.w = 0; this.h = 0;
    this.onlost = null; this.onrestore = null;
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault(); self.ok = false; if (self.onlost) self.onlost();
    });
    canvas.addEventListener('webglcontextrestored', function () {
      self.build(); if (self.ok && self.onrestore) self.onrestore();
    });
    var opts = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' };
    this.gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (this.gl) this.build();
  }
  Quad.prototype.build = function () {
    var gl = this.gl; this.loc = {};
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('[fx] shader:', gl.getShaderInfoLog(s)); return null; }
      return s;
    }
    var vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, this.frag);
    if (!vs || !fs) { this.ok = false; return; }
    var pr = gl.createProgram();
    gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { console.error('[fx] link:', gl.getProgramInfoLog(pr)); this.ok = false; return; }
    this.pr = pr; gl.useProgram(pr);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var a = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    this.ok = true;
  };
  Quad.prototype.size = function (w, h) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (w !== this.w || h !== this.h) { this.c.width = this.w = w; this.c.height = this.h = h; }
  };
  Quad.prototype.set = function (k, v) { this.vals[k] = v; };
  Quad.prototype.draw = function () {
    if (!this.ok || this.gl.isContextLost()) return false;
    var gl = this.gl; gl.viewport(0, 0, this.w, this.h); gl.useProgram(this.pr);
    for (var k in this.vals) {
      var l = this.loc[k]; if (l === undefined) l = this.loc[k] = gl.getUniformLocation(this.pr, k);
      if (!l) continue;
      var v = this.vals[k];
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
      else gl.uniform3f(l, v[0], v[1], v[2]);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  };
  Quad.prototype.destroy = function () {
    try { var e = this.gl && this.gl.getExtension('WEBGL_lose_context'); if (e) e.loseContext(); } catch (_) {}
    this.ok = false;
  };

  /* ------------------------------------------------------------------ 狀態 */
  var T0 = performance.now();
  var lenis = null;
  var ovOpen = 0;                 // 開著的全螢幕疊層數；>0 時背景暫停繪製
  var photos = [];                // 活著的照片 handle
  var safe = null;                // 目前的安全燈 handle（同時只會有一個）
  var A = { q: null, vel: 0, wash: 0, washing: false, dirty: true, last: 0, flow: 0, fv: 0,
    sunEl: null, sun: [0.5, 0.5], sunT: [0.5, 0.5], glow: 0.6, glowT: 0.6, set: 0, setT: 0,
    touch: [0.5, 0.5], touchA: 0, touchHold: false, tilt: [0, 0], tiltT: [0, 0], hz: 0, hv: 0 };
  var lastSafe = 0;

  var dprCap = function () { return Math.min(window.devicePixelRatio || 1, 2); };
  var frameNo = function () { return 0; };   // 顆粒已經拿掉，保留介面

  /* ---- 背景 ---- */
  function initAmbient() {
    var cv = $('#bg');
    if (!cv || noGL) return;
    var q = new Quad(cv, AMB_FRAG);
    if (!q.ok) { q.destroy(); cv.style.display = 'none'; return; }
    q.onlost = function () { cv.classList.remove('on'); };
    q.onrestore = function () { A.dirty = true; };
    A.q = q; resizeAmbient();
  }
  function resizeAmbient() {
    if (!A.q) return;
    A.q.size(Math.min(960, Math.ceil(innerWidth * 0.5)), Math.min(960, Math.ceil(innerHeight * 0.5)));
    A.dirty = true;
  }
  function drawAmbient(now) {
    var q = A.q, t = reduced() ? 0 : (now - T0) / 1000;
    q.set('uRes', [q.w, q.h]); q.set('uT', t);
    q.set('uWash', A.wash); q.set('uFlow', A.flow); q.set('uHz', A.hz); q.set('uVel', A.vel);
    q.set('uTouch', A.touch); q.set('uTouchA', A.touchA); q.set('uTilt', A.tilt);
    if (q.draw()) $('#bg').classList.add('on');
  }
  /* 把天空的各個量往目標值靠近；回傳這一格有沒有東西在動 */
  function stepSky() {
    var mv = false, k, e;
    if (A.sunEl) {
      if (!A.sunEl.isConnected) A.sunEl = null;
      else { var r = A.sunEl.getBoundingClientRect(); A.sunT = [(r.left + r.width / 2) / innerWidth, 1 - (r.top + r.height / 2) / innerHeight]; }
    }
    k = A.sunEl ? 0.5 : 0.08;
    for (var i = 0; i < 2; i++) {
      e = A.sunT[i] - A.sun[i]; if (Math.abs(e) > 0.0006) { A.sun[i] += e * (reduced() ? 1 : k); mv = true; }
      e = A.tiltT[i] - A.tilt[i]; if (Math.abs(e) > 0.002) { A.tilt[i] += e * 0.08; mv = true; }
    }
    e = A.glowT - A.glow; if (Math.abs(e) > 0.004) { A.glow += e * (reduced() ? 1 : 0.05); mv = true; }
    e = A.setT - A.set; if (Math.abs(e) > 0.004) { A.set += e * (reduced() ? 1 : 0.025); mv = true; }
    if (A.touchHold) { if (A.touchA < 0.99) { A.touchA += (1 - A.touchA) * 0.2; mv = true; } }
    else if (A.touchA > 0.004) { A.touchA *= 0.955; mv = true; } else A.touchA = 0;
    if (Math.abs(A.hv) > 1e-5 || Math.abs(A.hz) > 1e-4) { A.hz += A.hv; A.hv = A.hv * 0.86 - A.hz * 0.035; A.hz = clamp(A.hz, -0.06, 0.06); mv = true; } else { A.hz = 0; A.hv = 0; }
    return mv;
  }

  /* ---- 主迴圈：GSAP ticker 是整個 App 唯一的時鐘 ---- */
  function loop(time) {
    var now = performance.now();
    if (lenis) lenis.raf(time * 1000);

    if (A.q && A.q.ok && !document.hidden && ovOpen === 0) {
      var v = lenis ? Math.min(1, Math.abs(lenis.velocity) / 40) : 0;
      A.vel += (v - A.vel) * 0.12;
      if (!reduced()) { A.flow += A.fv + (lenis ? lenis.velocity * 0.00003 : 0); A.fv *= 0.9; if (Math.abs(A.fv) < 1e-5) A.fv = 0; }
      var moving = stepSky() || A.vel > 0.01 || A.washing || A.fv !== 0;
      var gap = moving ? 33 : (reduced() ? Infinity : 250);   // 靜止時只跟著雲慢慢飄，一秒四格
      if (A.dirty || now - A.last >= gap) { drawAmbient(now); A.last = now; A.dirty = false; }
    }

    for (var i = 0; i < photos.length; i++) {
      var h = photos[i];
      if (h.dirty && h.q && h.q.ok) { h.render(now); h.dirty = false; }
    }

    if (safe && safe.q.ok && !document.hidden) {
      if (safe.dirty || (!reduced() && now - lastSafe >= 100)) { safe.render(now); safe.dirty = false; lastSafe = now; }
    }
  }

  /* ---------------------------------------------------------- ② 安全燈 */
  function mountSafelight(host) {
    if (noGL || !hasGSAP) return null;
    var cv = document.createElement('canvas');
    cv.className = 'fx-safe'; cv.setAttribute('aria-hidden', 'true');
    host.insertBefore(cv, host.firstChild);
    var q = new Quad(cv, SAFE_FRAG);
    if (!q.ok) { q.destroy(); cv.remove(); return null; }
    var h = {
      q: q, cv: cv, left: 1, dirty: true,
      render: function (now) {
        q.set('uRes', [q.w, q.h]); q.set('uT', reduced() ? 0 : (now - T0) / 1000);
        q.set('uFrame', reduced() ? 0 : frameNo(now)); q.set('uLeft', h.left);
        q.draw();
      },
      setLeft: function (f) { h.left = clamp(f, 0, 1); h.dirty = true; },
      resize: function () { q.size(Math.ceil(innerWidth * 0.5), Math.ceil(innerHeight * 0.5)); h.dirty = true; },
      destroy: function () { if (safe === h) safe = null; q.destroy(); cv.remove(); }
    };
    q.onrestore = function () { h.dirty = true; };
    h.resize(); safe = h; return h;
  }

  /* ---------------------------------------------------------- ① 照片顯影 */
  function mountPhoto(host, o) {
    o = o || {};
    var h = {
      prog: 0, seed: Math.random() * 40, dirty: true, img: null, tw: null, destroyed: false,
      q: null, cv: null, fb: null, tex: null, shown: false,
      base: o.base || [0.98, 0.953, 0.918],
      label: o.label || '',
      box: o.box || function () { return { w: host.clientWidth || innerWidth, h: innerHeight * 0.62 }; }
    };

    if (!noGL && hasGSAP) {
      var cv = document.createElement('canvas');
      cv.className = 'fx-photo'; cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', h.label || '照片');
      host.appendChild(cv);
      var q = new Quad(cv, PHOTO_FRAG);
      if (q.ok) { h.q = q; h.cv = cv; }
      else { q.destroy(); cv.remove(); }
    }
    if (!h.q) {
      var fb = document.createElement('img');
      fb.className = 'fx-photo-fb'; fb.alt = h.label || '照片';
      host.appendChild(fb); h.fb = fb;
    }

    function upload() {
      var gl = h.q.gl;
      if (!h.tex) h.tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, h.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, h.img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    h.fit = function () {
      if (!h.q || !h.img) return;
      var b = h.box(), iw = h.img.naturalWidth, ih = h.img.naturalHeight;
      var s = Math.min(b.w / iw, b.h / ih);
      var cw = Math.max(1, Math.round(iw * s)), ch = Math.max(1, Math.round(ih * s));
      h.cv.style.width = cw + 'px'; h.cv.style.height = ch + 'px';
      var d = dprCap(); h.q.size(Math.round(cw * d), Math.round(ch * d));
      h.dirty = true;
    };

    h.render = function (now) {
      if (!h.img) return;
      var q = h.q;
      q.set('uProg', h.prog); q.set('uSeed', h.seed); q.set('uBase', h.base);
      q.set('uRes', [q.w, q.h]); q.set('uFrame', reduced() ? 0 : frameNo(now));
      if (q.draw() && !h.shown) { h.shown = true; h.cv.style.opacity = '1'; }
    };

    h.setImage = function (src, label) {
      return new Promise(function (resolve) {
        var img = new Image();
        var settled = false;
        var done = function () {
          if (settled) return; settled = true;
          if (h.destroyed) return resolve();
          if (!img.naturalWidth) return resolve();
          h.img = img;
          if (label != null) {
            if (h.cv) h.cv.setAttribute('aria-label', label || '照片');
            if (h.fb) h.fb.alt = label || '照片';
          }
          if (h.q) { upload(); h.fit(); } else { h.fb.src = src; }
          resolve();
        };
        img.onload = done; img.onerror = done; img.src = src;
        if (img.decode) img.decode().then(done, done);   // 兩條路只會有一條真的生效（done 內有保護）
      });
    };

    h.setProg = function (p) {
      h.prog = clamp(p, 0, 1); h.dirty = true;
      if (h.fb) applyFallback(h.fb, h.prog);
    };

    h.develop = function (dur, delay) {
      if (h.tw) { h.tw.kill(); h.tw = null; }
      if (reduced() || !hasGSAP) { h.setProg(1); return; }
      h.setProg(0);
      h.tw = gsap.to(h, {
        prog: 1, duration: dur || 1.8, delay: delay || 0, ease: 'power1.inOut',
        onUpdate: function () { h.dirty = true; if (h.fb) applyFallback(h.fb, h.prog); },
        onComplete: function () { if (h.fb) h.fb.style.filter = ''; }
      });
    };

    h.destroy = function () {
      h.destroyed = true;
      if (h.tw) h.tw.kill();
      var i = photos.indexOf(h); if (i > -1) photos.splice(i, 1);
      if (h.q) { if (h.tex) { try { h.q.gl.deleteTexture(h.tex); } catch (_) {} } h.q.destroy(); }
      if (h.cv) h.cv.remove();
      if (h.fb) h.fb.remove();
    };

    if (h.q) h.q.onrestore = function () { if (h.img) { upload(); h.fit(); } h.dirty = true; };
    photos.push(h);
    return h;
  }
  /* 沒有 WebGL 時的近似：從偏暖、偏亮淡入到原圖 */
  function applyFallback(img, p) {
    img.style.opacity = String(clamp(p * 2.2, 0, 1));
    img.style.filter = 'sepia(' + (0.35 * (1 - p)).toFixed(3) + ') brightness(' + (1 + 0.25 * (1 - p)).toFixed(3) + ')';
  }

  /* ---------------------------------------------------------------- 疊層 */
  var ov = {
    show: function (el, o) {
      o = o || {};
      if (el._hiding) { el._hiding = false; }          // 淡出到一半又打開：計數仍持有，不重複 +1
      else { ovOpen++; if (lenis) lenis.stop(); }
      el.classList.add('show');
      if (!hasGSAP) return;
      gsap.killTweensOf(el);
      if (reduced()) { gsap.set(el, { clearProps: 'opacity,clipPath' }); return; }
      if (o.from) {
        var x = o.from.x, y = o.from.y;
        var R = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
        gsap.fromTo(el, { clipPath: 'circle(0px at ' + x + 'px ' + y + 'px)', opacity: 1 },
          { clipPath: 'circle(' + R + 'px at ' + x + 'px ' + y + 'px)', duration: 0.7, ease: 'power3.out', clearProps: 'clipPath,opacity' });
      } else {
        gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: 'power1.out', clearProps: 'opacity' });
      }
    },
    hide: function (el, done) {
      if (!el.classList.contains('show') || el._hiding) return;
      el._hiding = true;
      var fin = function () {
        if (!el._hiding) return;                       // 期間被重新打開了
        el._hiding = false;
        el.classList.remove('show');
        if (hasGSAP) gsap.set(el, { clearProps: 'opacity,clipPath' });
        ovOpen = Math.max(0, ovOpen - 1);
        if (!ovOpen) { if (lenis) lenis.start(); A.dirty = true; }
        if (done) done();
      };
      if (!hasGSAP || reduced()) { fin(); return; }
      gsap.killTweensOf(el);
      gsap.to(el, { opacity: 0, duration: 0.2, ease: 'power1.in', onComplete: fin });
    }
  };

  /* ---------------------------------------------------------------- 進場 */
  function enter(container) {
    if (!hasGSAP || reduced() || !container) return;
    var targets = [];
    Array.prototype.forEach.call(container.children, function (c) {
      if (c.classList.contains('sheet')) Array.prototype.push.apply(targets, c.children);
      else targets.push(c);
    });
    if (!targets.length) return;
    gsap.from(targets, { opacity: 0, y: 14, duration: 0.5, stagger: 0.045, ease: 'power2.out', clearProps: 'opacity,transform' });
  }

  /* 觀察者說的話：字元像乳劑一樣隨機浮現（用 opacity＋text-shadow，不用 filter，行內元素也穩） */
  function developText(el) {
    if (!hasGSAP || reduced() || !el) return;
    var txt = el.textContent; if (!txt) return;
    var m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).color) || [0, '27,26,24'];
    var rgb = m[1].split(',').slice(0, 3).map(function (s) { return s.trim(); }).join(',');
    var sr = document.createElement('span'); sr.className = 'sr-only'; sr.textContent = txt;
    var vis = document.createElement('span'); vis.setAttribute('aria-hidden', 'true');
    var chars = Array.from(txt).map(function (ch) {
      var s = document.createElement('span'); s.textContent = ch; vis.appendChild(s); return s;
    });
    el.textContent = ''; el.appendChild(sr); el.appendChild(vis);
    gsap.fromTo(chars,
      { color: 'rgba(' + rgb + ',0)', textShadow: '0px 0px 10px rgba(' + rgb + ',0.55)' },
      {
        color: 'rgba(' + rgb + ',1)', textShadow: '0px 0px 0px rgba(' + rgb + ',0)',
        duration: 0.9, ease: 'power1.out', stagger: { each: Math.min(0.03, 1.6 / chars.length), from: 'random' },
        onComplete: function () { el.textContent = txt; }
      });
  }

  var pulseTw = null;
  function pulse(el) {
    if (pulseTw) { pulseTw.kill(); pulseTw = null; }
    if (!el || !hasGSAP || reduced()) return;
    pulseTw = gsap.to(el, { opacity: 0.45, duration: 0.9, yoyo: true, repeat: -1, ease: 'sine.inOut' });
  }

  /* ---------------------------------------------------------------- 導覽 */
  var dotTl = null;
  function navDot(view, immediate) {
    var dot = $('#navdot'), btn = document.querySelector('#tabs button[data-v="' + view + '"]');
    if (!dot || !btn || !btn.offsetWidth) return false;   // 導覽列還藏著（新手引導）時量不到
    var x = btn.offsetLeft + btn.offsetWidth / 2 - 2;
    if (dotTl) { dotTl.kill(); dotTl = null; }
    if (!hasGSAP) { dot.style.transform = 'translateX(' + x + 'px)'; return true; }
    if (immediate || reduced()) { gsap.set(dot, { x: x, scaleX: 1 }); return true; }
    dotTl = gsap.timeline()
      .to(dot, { scaleX: 6, duration: 0.18, ease: 'power2.in' }, 0)
      .to(dot, { x: x, duration: 0.42, ease: 'power3.inOut' }, 0)
      .to(dot, { scaleX: 1, duration: 0.3, ease: 'power2.out' }, 0.2);
    return true;
  }
  function nav(view) {
    navDot(view, false);
    if (lenis) lenis.scrollTo(0, { immediate: true, force: true }); else window.scrollTo(0, 0);
    if (A.q && hasGSAP && !reduced()) {
      gsap.killTweensOf(A);
      gsap.fromTo(A, { wash: 0.0001 }, {
        wash: 1, duration: 0.9, ease: 'power1.inOut',
        onStart: function () { A.washing = true; },
        onComplete: function () { A.wash = 0; A.washing = false; A.dirty = true; }
      });
    }
  }

  /* ---------------------------------------------------------------- 啟動 */
  function init() {
    if (hasGSAP) {
      gsap.ticker.lagSmoothing(0);
      if (window.Lenis && !reduced()) {
        try { lenis = new window.Lenis({ autoRaf: false, lerp: 0.1, smoothWheel: true, wheelMultiplier: 0.9 }); }
        catch (e) { console.error('[fx] lenis', e); lenis = null; }
      }
      gsap.ticker.add(loop);
    }
    initAmbient();
    var raf = 0;
    window.addEventListener('resize', function () {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () {
        resizeAmbient();
        if (safe) safe.resize();
        photos.forEach(function (p) { p.fit(); });
        var on = document.querySelector('#tabs button.on'); if (on) navDot(on.dataset.v, true);
      });
    });
    document.addEventListener('visibilitychange', function () { A.dirty = true; });
    /* 手指碰到的地方，光會暖一點、雲會散開 */
    var tp = function (x, y, hold) { if (reduced() || !A.q) return; A.touch = [x / innerWidth, 1 - y / innerHeight]; A.touchHold = hold; if (!hold && A.touchA < 0.6) A.touchA = 0.6; };
    document.addEventListener('touchstart', function (e) { var t = e.touches[0]; if (t) tp(t.clientX, t.clientY, true); }, { passive: true });
    document.addEventListener('touchmove', function (e) { var t = e.touches[0]; if (t) tp(t.clientX, t.clientY, true); }, { passive: true });
    document.addEventListener('touchend', function () { A.touchHold = false; }, { passive: true });
    document.addEventListener('touchcancel', function () { A.touchHold = false; }, { passive: true });
    document.addEventListener('mousemove', function (e) { tp(e.clientX, e.clientY, false); }, { passive: true });
  }

  /* 傾斜手機：雲和光暈有一點景深位移。iPhone 要使用者允許一次（必須在點擊裡呼叫）。 */
  var tiltOn = false;
  function onTilt(e) {
    if (e.gamma == null || reduced()) return;
    A.tiltT = [clamp(e.gamma / 30, -1, 1), clamp(((e.beta || 0) - 45) / 30, -1, 1)];
  }
  function tilt(on) {
    if (!on) { if (tiltOn) window.removeEventListener('deviceorientation', onTilt); tiltOn = false; A.tiltT = [0, 0]; return Promise.resolve(false); }
    if (typeof window.DeviceOrientationEvent === 'undefined') return Promise.resolve(false);
    var go = function () { if (!tiltOn) { window.addEventListener('deviceorientation', onTilt, { passive: true }); tiltOn = true; } return true; };
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      return DeviceOrientationEvent.requestPermission().then(function (r) { return r === 'granted' ? go() : false; }, function () { return false; });
    }
    return Promise.resolve(go());
  }
  /* 天空的狀態。o.el：跟著這個元素走（今天頁的太陽）；o.sun：[x,y]（0–1，y 往上）；o.glow 亮度；o.set 0–1 是否已落下 */
  function sky(o) {
    o = o || {};
    if ('el' in o) A.sunEl = o.el || null;
    if (o.sun) { A.sunEl = null; A.sunT = [o.sun[0], o.sun[1]]; }
    if (o.glow != null) A.glowT = o.glow;
    if (o.set != null) A.setT = o.set;
    A.dirty = true;
  }

  window.FX = {
    version: 1,
    info: function () { return { gsap: hasGSAP, lenis: !!lenis, ambient: !!(A.q && A.q.ok), reduced: reduced(), overlays: ovOpen, photos: photos.length }; },
    ov: ov,
    enter: enter, develop: developText, pulse: pulse, nav: nav, navDot: navDot,
    /* 左右滑換天時呼叫：背景像車窗外的景一樣往旁邊流過一點 */
    flow: function (dx, dy) { if (reduced() || !A.q) return; A.fv += (dx || 0) * 0.00004; if (dy) A.hv = clamp(A.hv + dy * 0.00006, -0.012, 0.012); },
    sky: sky, tilt: tilt, tiltSupported: typeof window.DeviceOrientationEvent !== 'undefined',
    calm: function (on) { calm = !!on; document.documentElement.classList.toggle('calm', calm); if (calm) { A.tiltT = [0, 0]; A.touchA = 0; A.touchHold = false; } A.dirty = true; },
    photo: { mount: mountPhoto },
    safelight: { mount: mountSafelight }, sunset: { mount: mountSafelight }
  };
  init();
})();
