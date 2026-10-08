/* ==========================================================================
   art.js — 程序化占位图
   --------------------------------------------------------------------------
   生成结果是「确定性」的：同一个 seed 永远画出同一张图。
   文档里只存 seed（几十字节），重新打开画布时再画一遍，
   既省 localStorage 空间，也让演示结果看起来是真的。

   画法要点：主体形状先画在「低分辨率画布」上再上采样贴回，
   硬边会被双线性插值抹成柔和的有机形状 —— 比直接画几何图形自然得多。

   接入真实 API 后：结果会带 src（图片/视频 URL），直接显示 src，
   不再走这里（见 generate.js / api.js）。
   ========================================================================== */
(function (FC) {
  'use strict';

  /* ---------- 伪随机 ---------- */
  function hashString(s) {
    var h = 2166136261;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- 尺寸 ---------- */
  var LONG_EDGE = 900;

  function sizeFor(ratio, longEdge) {
    var L = longEdge || LONG_EDGE;
    var r = FC.Store.ratioValue(ratio);
    var w, h;
    if (r >= 1) { w = L; h = Math.round(L / r); }
    else { h = L; w = Math.round(L * r); }
    w = Math.max(2, Math.round(w / 2) * 2);
    h = Math.max(2, Math.round(h / 2) * 2);
    return { w: w, h: h };
  }

  /* ---------- 噪点纹理（复用） ---------- */
  var noiseCanvas = null;
  function getNoise() {
    if (noiseCanvas) return noiseCanvas;
    var n = document.createElement('canvas');
    n.width = 128; n.height = 128;
    var ctx = n.getContext('2d');
    var img = ctx.createImageData(128, 128);
    var rnd = mulberry32(99);
    for (var i = 0; i < 128 * 128; i++) {
      var v = 128 + (rnd() - 0.5) * 118;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    noiseCanvas = n;
    return n;
  }

  function gray(v) {
    v = Math.max(0, Math.min(255, Math.round(v)));
    return 'rgb(' + v + ',' + v + ',' + v + ')';
  }

  /* ==========================================================================
     主体形状
     pass = 0 大面积形状 / pass = 1 中小点缀
     ========================================================================== */
  function drawMotif(c, w, h, rnd, baseA, baseB, pass) {
    var R = function (a, b) { return a + rnd() * (b - a); };
    var RI = function (a, b) { return Math.floor(R(a, b + 1)); };
    var lightBase = baseA > baseB;
    var LIGHT = lightBase ? 250 : 14;          // 亮底用深色笔，暗底用亮色笔
    var DARK = lightBase ? 16 : 246;
    var mid = (baseA + baseB) / 2;
    var minSide = Math.min(w, h);

    var MW = pass === 0 ? [0,1,2,2,4,0,1,2,4,3] : [0,1,2,2,4,2,1,2,4,3];
    var motif = MW[RI(0, 9)];

    c.lineCap = 'round';
    c.lineJoin = 'round';

    if (motif === 0) {
      /* 同心环 */
      var cx = R(w * 0.22, w * 0.78), cy = R(h * 0.22, h * 0.78);
      var rings = pass === 0 ? RI(5, 10) : RI(3, 6);
      var maxR = Math.max(w, h) * (pass === 0 ? R(0.5, 0.95) : R(0.2, 0.45));
      for (var i = 0; i < rings; i++) {
        var t = (i + 1) / rings;
        c.globalAlpha = R(0.22, 0.62);
        c.strokeStyle = gray(rnd() > 0.5 ? LIGHT : DARK);
        c.lineWidth = R(0.8, 4) * (1 - t * 0.5) * (pass === 0 ? 1 : 0.6);
        c.beginPath();
        var a0 = R(0, Math.PI * 2);
        c.arc(cx, cy, maxR * t, a0, a0 + R(1.2, 5.4));
        c.stroke();
      }

    } else if (motif === 1) {
      /* 斜向条带（柔光） */
      var n = pass === 0 ? RI(5, 11) : RI(4, 9);
      var dir = rnd() > 0.5 ? 1 : -1;
      for (var j = 0; j < n; j++) {
        c.globalAlpha = R(0.10, 0.38);
        c.strokeStyle = gray(rnd() > 0.5 ? LIGHT : DARK);
        c.lineWidth = R(1, h * (pass === 0 ? 0.16 : 0.06));
        var off = (j / n) * (w + h) - h * 0.5;
        c.beginPath();
        c.moveTo(off, 0);
        c.lineTo(off + h * dir, h);
        c.stroke();
      }

    } else if (motif === 2) {
      /* 柔光圆斑 */
      var cnt = pass === 0 ? RI(5, 11) : RI(6, 16);
      var rad = pass === 0 ? [minSide * 0.10, minSide * 0.46] : [minSide * 0.03, minSide * 0.16];
      for (var k = 0; k < cnt; k++) {
        var rx = R(w * 0.02, w * 0.98), ry = R(h * 0.02, h * 0.98);
        var rr = R(rad[0], rad[1]);
        var g = c.createRadialGradient(rx, ry, 0, rx, ry, rr);
        g.addColorStop(0, gray(rnd() > 0.5 ? LIGHT : DARK));
        g.addColorStop(1, gray(mid));
        c.globalAlpha = R(0.16, 0.52);
        c.fillStyle = g;
        c.beginPath();
        c.arc(rx, ry, rr, 0, Math.PI * 2);
        c.fill();
      }

    } else if (motif === 3) {
      /* 山峦 / 地平线 */
      var hz = R(h * 0.40, h * 0.74);
      c.globalAlpha = pass === 0 ? 0.55 : 0.3;
      c.fillStyle = gray(DARK);
      c.beginPath();
      c.moveTo(-w * 0.05, h * 1.05);
      c.lineTo(-w * 0.05, hz);
      var segs = RI(3, 6), x = -w * 0.05;
      for (var s = 0; s < segs; s++) {
        var step = (w * 1.1) / segs;
        c.quadraticCurveTo(
          x + step * 0.5, hz + R(-h * 0.38, h * 0.14),
          x + step, hz + R(-h * 0.12, h * 0.12)
        );
        x += step;
      }
      c.lineTo(w * 1.05, h * 1.05);
      c.closePath();
      c.fill();

      /* 天空光晕 */
      c.globalAlpha = rnd() > 0.45 ? R(0.25, 0.5) : 0;
      c.fillStyle = gray(LIGHT);
      c.beginPath();
      c.ellipse(R(w * 0.2, w * 0.8), R(h * 0.08, h * 0.34),
        R(w * 0.16, w * 0.4), R(h * 0.05, h * 0.15), 0, 0, Math.PI * 2);
      c.fill();

    } else {
      /* 流体曲线 */
      var curves = pass === 0 ? RI(3, 6) : RI(4, 8);
      for (var q = 0; q < curves; q++) {
        c.globalAlpha = R(0.16, 0.5);
        c.strokeStyle = gray(rnd() > 0.5 ? LIGHT : DARK);
        c.lineWidth = R(1, minSide * (pass === 0 ? 0.13 : 0.045));
        c.beginPath();
        var y0 = R(0, h);
        c.moveTo(-w * 0.1, y0);
        c.bezierCurveTo(
          w * 0.3, y0 + R(-h * 0.5, h * 0.5),
          w * 0.7, y0 + R(-h * 0.5, h * 0.5),
          w * 1.1, y0 + R(-h * 0.32, h * 0.32)
        );
        c.stroke();
      }
    }
  }

  /** 低分辨率绘制 → 上采样贴回（柔化） */
  function softLayer(ctx, w, h, rnd, baseA, baseB, downscale, alpha, pass) {
    var sw = Math.max(24, Math.round(w / downscale));
    var sh = Math.max(24, Math.round(h / downscale));
    var c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    var sctx = c.getContext('2d');
    sctx.scale(sw / w, sh / h);            // 之后仍用 w,h 坐标系作画
    drawMotif(sctx, w, h, rnd, baseA, baseB, pass);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, 0, w, h);
    ctx.restore();
  }

  /* ==========================================================================
     主绘制
     ========================================================================== */
  function draw(ctx, seed, w, h) {
    var rnd = mulberry32(seed);
    var R = function (a, b) { return a + rnd() * (b - a); };
    var RI = function (a, b) { return Math.floor(R(a, b + 1)); };

    // ---------- 1. 底色 ----------
    var tone = RI(0, 3);
    var baseA, baseB;
    if (tone === 0) { baseA = RI(224, 244); baseB = RI(174, 208); }        // 亮
    else if (tone === 1) { baseA = RI(172, 208); baseB = RI(118, 164); }   // 中
    else if (tone === 2) { baseA = RI(94, 128); baseB = RI(32, 64); }      // 暗
    else { baseA = RI(230, 250); baseB = RI(40, 76); }                     // 高对比

    if (Math.abs(baseA - baseB) < 58) {
      baseB = baseA > 128 ? baseA - 62 : baseA + 62;
    }

    var ang = R(0, Math.PI * 2);
    var cx = w / 2, cy = h / 2;
    var span = Math.max(w, h) * 0.75;
    var g = ctx.createLinearGradient(
      cx - Math.cos(ang) * span, cy - Math.sin(ang) * span,
      cx + Math.cos(ang) * span, cy + Math.sin(ang) * span
    );
    g.addColorStop(0, gray(baseA));
    g.addColorStop(1, gray(baseB));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // ---------- 2. 大气光斑 ----------
    var blobs = RI(3, 6);
    for (var i = 0; i < blobs; i++) {
      var bx = R(0, w), by = R(0, h);
      var br = R(Math.min(w, h) * 0.25, Math.max(w, h) * 0.72);
      var light = rnd() > 0.45;
      var amt = light ? R(46, 82) : R(-82, -46);
      var rg = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      rg.addColorStop(0, gray((baseA + baseB) / 2 + amt));
      rg.addColorStop(1, gray((baseA + baseB) / 2));
      ctx.save();
      ctx.globalAlpha = R(0.18, 0.44);
      ctx.globalCompositeOperation = light ? 'screen' : 'multiply';
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ---------- 3. 主体（两层柔化） ----------
    softLayer(ctx, w, h, rnd, baseA, baseB, 6.5, 0.90, 0);   // 大结构
    softLayer(ctx, w, h, rnd, baseA, baseB, 2.4, 0.34, 1);   // 中小点缀

    // ---------- 4. 颗粒 ----------
    var pattern = ctx.createPattern(getNoise(), 'repeat');
    if (pattern) {
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    // ---------- 5. 暗角 ----------
    var vg = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.30, cx, cy, Math.max(w, h) * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.40)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  /* ---------- 对外 ---------- */
  var cache = {};
  var CACHE_MAX = 60;

  function dataURL(seed, w, h) {
    var key = seed + '@' + w + 'x' + h;
    if (cache[key]) return cache[key];

    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), seed, w, h);

    var url = '';
    try { url = c.toDataURL('image/jpeg', 0.87); } catch (e) { url = ''; }

    var keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) delete cache[keys[0]];
    cache[key] = url;
    return url;
  }

  function renderInto(canvas, seed, w, h) {
    canvas.width = w; canvas.height = h;
    draw(canvas.getContext('2d'), seed, w, h);
  }

  function seedFrom(parts) {
    return hashString(parts.filter(Boolean).join('|')) % 2147483647;
  }

  FC.art = {
    hashString: hashString,
    mulberry32: mulberry32,
    sizeFor: sizeFor,
    dataURL: dataURL,
    frameURL: dataURL,
    renderInto: renderInto,
    seedFrom: seedFrom,
    draw: draw
  };
})(window.FC);