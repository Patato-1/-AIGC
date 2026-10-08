/* ==========================================================================
   render.js — 视图渲染
   卡片用 DOM（CSS transform 承载缩放，文字清晰），高度由内容自动决定，
   渲染后测量真实尺寸缓存起来，供框选命中与适配视图使用。
   ========================================================================== */
(function (FC) {
  'use strict';

  var Store = FC.Store;
  var art = FC.art;

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var els = {};
  var linkEls = {};
  var S = {};
  var rafId = 0;
  var pending = { items: false, grid: true, links: true };
  var pendingFit = null;
  var metrics = {};

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cacheDom() {
    S.board = $('board');
    S.grid = $('gridLayer');
    S.world = $('world');
    S.items = $('itemsLayer');
    S.linksSvg = $('linksSvg');
    S.linkGroup = $('linkGroup');
    S.overlaySvg = $('overlaySvg');
    S.overlayGroup = $('overlayGroup');
    S.marquee = $('marquee');
    S.empty = $('emptyState');
    S.statusCount = $('statCount');
    S.statusSave = $('statSave');
    S.zoomValue = $('zoomValue');
    S.docName = $('docName');
    S.undo = $('btnUndo');
    S.redo = $('btnRedo');
    bindStore();
  }

  function bindStore() {
    Store.on(function (type) {
      switch (type) {
        case 'view': applyView(); requestView(); break;
        case 'doc':
        case 'selection': requestItems(); break;
        case 'doc-lite': requestItems(); break;
        default: break;
      }
    });
  }

  /* ---------- 脏标记 + rAF 批处理 ---------- */
  function invalidate(what) {
    if (what) Object.keys(what).forEach(function (k) { pending[k] = what[k]; });
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      var p = pending;
      pending = { items: false, grid: false, links: false };
      if (p.items) buildItems();
      // 首次适配必须等测量完成，所以绑在渲染流程里，而不是另起定时器
      if (pendingFit) {
        fitView(pendingFit.padding, pendingFit.minK);
        pendingFit = null;
      }
      applyView();
      if (p.grid || p.items) drawGrid();
      if (p.links || p.items) drawLinks();
      syncChrome();
    });
  }
  function requestItems() { invalidate({ items: true, grid: true }); }
  function requestView() { invalidate({ grid: true }); }
  function requestLinks() { invalidate({ links: true }); }

  /** 请求「下一次渲染完成后」适配视图（此时尺寸一定已测量） */
  function requestFit(padding, minK) {
    pendingFit = { padding: padding, minK: minK };
    requestItems();
  }

  /* ==========================================================================
     卡片
     ========================================================================== */
  function buildItems() {
    var seen = {};
    Store.doc.items.forEach(function (item) {
      seen[item.id] = true;
      var el = els[item.id];
      if (el && el.dataset.kind !== item.kind) {
        // 类型变了（正常不会发生），重建
        el.parentNode.removeChild(el);
        delete els[item.id];
        el = null;
      }
      if (!el) {
        el = createEl(item);
        els[item.id] = el;
        S.items.appendChild(el);
      }
      updateEl(el, item);
    });

    Object.keys(els).forEach(function (id) {
      if (!seen[id]) {
        if (els[id].parentNode) els[id].parentNode.removeChild(els[id]);
        delete els[id];
        delete metrics[id];
      }
    });

    // 测量（布局后真实尺寸）
    Store.doc.items.forEach(function (item) {
      var el = els[item.id];
      if (el) metrics[item.id] = { w: el.offsetWidth, h: el.offsetHeight };
    });
  }

  /* ---------- 卡片尺寸（供几何计算使用） ---------- */
  function sizeOf(item) {
    var m = metrics[item.id];
    if (m && m.w) return m;
    return { w: item.w || 300, h: 300 };
  }

  function rectOf(item) {
    var s = sizeOf(item);
    return { x: item.x, y: item.y, w: s.w, h: s.h };
  }

  /* ---------- 创建 DOM ---------- */
  function createEl(item) {
    var el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = item.id;
    el.dataset.kind = item.kind;
    el.innerHTML = item.kind === 'asset' ? assetShell() : genShell(item);

    // 端口：素材只有输出，模型卡输入 + 输出
    var def = Store.kindDef(item.kind);
    if (def.ports.in) el.appendChild(makePort(item.id, 'in'));
    if (def.ports.out) el.appendChild(makePort(item.id, 'out'));
    return el;
  }

  function makePort(itemId, side) {
    var p = document.createElement('div');
    p.className = 'port port--' + side;
    p.dataset.port = side;
    p.dataset.node = itemId;
    return p;
  }

  /** 端口「已连接」状态 */
  function updatePorts(el, item) {
    var pin = el.querySelector('.port--in');
    var pout = el.querySelector('.port--out');
    if (pin) {
      pin.classList.toggle('is-connected', Store.doc.links.some(function (l) { return l.to === item.id; }));
    }
    if (pout) {
      pout.classList.toggle('is-connected', Store.doc.links.some(function (l) { return l.from === item.id; }));
    }
  }

  function genShell(item) {
    var def = Store.kindDef(item.kind);
    var isVideo = item.kind === 'video-gen';
    return '' +
      '<div class="card__bar" data-drag>' +
        '<span class="card__glyph"><svg class="ico"><use href="#' + def.icon + '"/></svg></span>' +
        '<span class="card__titles">' +
          '<span class="card__kind">' + esc(def.label) + '</span>' +
          '<span class="card__sub" data-sub></span>' +
        '</span>' +
        '<span class="card__tools">' +
          '<button class="card__tool" data-act="duplicate" type="button" title="复制">' +
            '<svg class="ico"><use href="#i-copy"/></svg></button>' +
          '<button class="card__tool" data-act="delete" type="button" title="删除">' +
            '<svg class="ico"><use href="#i-close"/></svg></button>' +
        '</span>' +
      '</div>' +

      '<div class="card__stage" data-stage>' +
        '<div class="stage__hint" data-hint>' +
          '<svg class="ico"><use href="#' + (isVideo ? 'i-video' : 'i-sparkle') + '"/></svg>' +
          '<span>写好提示词，点下面的按钮生成</span>' +
        '</div>' +
      '</div>' +

      '<div class="card__form">' +
        '<textarea class="card__prompt" data-k="prompt" rows="2" placeholder="' +
          (isVideo ? '描述镜头运动与画面，例如：镜头缓慢推近…' : '描述你想要的画面，例如：晨雾松林，极简构图…') +
        '"></textarea>' +
        '<div class="card__row">' +
          '<select class="card__sel" data-k="model"></select>' +
          '<select class="card__sel" data-k="ratio"></select>' +
        '</div>' +
        '<div class="card__row">' +
          '<select class="card__sel" data-k="style"></select>' +
          (isVideo ? '<select class="card__sel" data-k="duration"></select>' : '') +
        '</div>' +
        '<div data-refslot></div>' +
        '<div class="card__action">' +
          '<button class="btn btn--primary" data-act="generate" type="button">' +
            '<svg class="ico"><use href="#i-sparkle"/></svg>' +
            '<span data-genlabel>' + esc(def.generateLabel) + '</span>' +
          '</button>' +
        '</div>' +
      '</div>' +

      '<div class="card__grip" data-grip title="拖动调整宽度"></div>';
  }

  function assetShell() {
    return '' +
      '<img class="card__media" data-media alt="" draggable="false">' +
      '<div class="card__caption">' +
        '<span class="card__name" data-name></span>' +
        '<span class="card__size" data-size></span>' +
        '<button class="card__tool" data-act="delete" type="button" title="删除">' +
          '<svg class="ico"><use href="#i-close"/></svg></button>' +
      '</div>' +
      '<div class="card__grip" data-grip title="拖动调整宽度"></div>';
  }

  /* ---------- 更新 DOM ---------- */
  function updateEl(el, item) {
    el.style.width = item.w + 'px';
    el.style.zIndex = String(item.z || 1);
    el.style.transform = 'translate3d(' + item.x + 'px,' + item.y + 'px,0)';
    el.classList.toggle('is-selected', Store.isSelected(item.id));

    if (item.kind === 'asset') updateAsset(el, item);
    else updateGen(el, item);

    updatePorts(el, item);
  }

  function updateAsset(el, item) {
    var img = el.querySelector('[data-media]');
    if (img.getAttribute('src') !== item.src) img.setAttribute('src', item.src || '');
    img.alt = item.name || '';
    var name = el.querySelector('[data-name]');
    if (name.textContent !== item.name) name.textContent = item.name || '';
    var size = el.querySelector('[data-size]');
    var txt = item.naturalW ? (item.naturalW + '×' + item.naturalH) : '';
    if (size.textContent !== txt) size.textContent = txt;
  }

  function updateGen(el, item) {
    var def = Store.kindDef(item.kind);
    var isVideo = item.kind === 'video-gen';

    // 下拉框（首次填充）
    fillSelect(el.querySelector('[data-k="model"]'), def.models, item.model);
    fillSelect(el.querySelector('[data-k="ratio"]'), def.ratios, item.ratio);
    fillSelect(el.querySelector('[data-k="style"]'), def.styles, item.style);
    if (isVideo) fillSelect(el.querySelector('[data-k="duration"]'), def.durations, item.duration);

    // 提示词（不要打断正在输入的文本框）
    var ta = el.querySelector('[data-k="prompt"]');
    if (document.activeElement !== ta && ta.value !== (item.prompt || '')) ta.value = item.prompt || '';

    // 副标题
    var sub = el.querySelector('[data-sub]');
    var subText = item.model + ' · ' + item.ratio;
    if (sub.textContent !== subText) sub.textContent = subText;

    // 舞台比例
    el.querySelector('[data-stage]').style.setProperty('--ar', String(Store.ratioValue(item.ratio)));

    renderStage(el, item);
    renderRef(el, item);

    // 按钮状态
    var busy = !!Store.runtime.progress[item.id];
    var btn = el.querySelector('[data-act="generate"]');
    var label = el.querySelector('[data-genlabel]');
    btn.disabled = false;
    btn.classList.toggle('is-busy', busy);
    var wantLabel = busy ? '取消' : (item.result ? '重新生成' : def.generateLabel);
    if (label.textContent !== wantLabel) label.textContent = wantLabel;
    var use = btn.querySelector('use');
    var wantIcon = busy ? '#i-stop' : (item.result ? '#i-refresh' : '#i-sparkle');
    if (use.getAttribute('href') !== wantIcon) use.setAttribute('href', wantIcon);
  }

  function fillSelect(sel, options, value) {
    if (!sel) return;
    var key = options.join(',');
    if (sel._key !== key) {
      sel._key = key;
      sel.innerHTML = options.map(function (o) {
        return '<option value="' + esc(o) + '">' + esc(o) + '</option>';
      }).join('');
    }
    if (sel.value !== value && value !== undefined) sel.value = value;
  }

  /* ---------- 舞台 ---------- */
  function renderStage(el, item) {
    var stage = el.querySelector('[data-stage]');
    var busy = Store.runtime.progress[item.id];
    var res = item.result;

    // 用 key 判断是否需要重建，避免每帧重画
    var key = busy ? 'busy:' + busy.pct
      : res ? 'res:' + (res.src || ('seed' + res.seed)) + ':' + res.w + 'x' + res.h
        : 'empty';

    if (stage._key === key) return;
    stage._key = key;
    stage.classList.remove('is-playing');

    if (busy) {
      stage.innerHTML =
        '<div class="stage__busy">' +
          '<div class="shimmer"></div>' +
          '<div class="stage__progress">' +
            '<div class="stage__track"><i style="width:' + busy.pct + '%"></i></div>' +
            '<div class="stage__pct">' + busy.pct + '%</div>' +
          '</div>' +
        '</div>';
      return;
    }

    if (!res) {
      stage.innerHTML =
        '<div class="stage__hint">' +
          '<svg class="ico"><use href="#' + (item.kind === 'video-gen' ? 'i-video' : 'i-sparkle') + '"/></svg>' +
          '<span>写好提示词，点下面的按钮生成</span>' +
        '</div>';
      return;
    }

    var src = res.src;
    if (!src && res.seed !== undefined) {
      src = item.kind === 'video-gen' ? art.frameURL(res.seed, res.w, res.h)
        : art.dataURL(res.seed, res.w, res.h);
    }

    var html = '<img src="' + esc(src) + '" alt="" draggable="false">';
    if (item.kind === 'video-gen' || res.kind === 'video') {
      html += '<button class="stage__play" data-act="play" type="button" title="播放">' +
        '<svg class="ico"><use href="#i-play"/></svg></button>';
      html += '<span class="stage__time">' + esc(item.duration || '5 秒') + '</span>';
    }
    if (res.demo) html += '<span class="stage__badge">DEMO</span>';
    stage.innerHTML = html;

    // 真实视频 URL：用 <video>
    if (res.src && res.kind === 'video') {
      stage.innerHTML = '<video src="' + esc(res.src) + '" muted loop playsinline></video>' +
        '<button class="stage__play" data-act="play" type="button" title="播放">' +
        '<svg class="ico"><use href="#i-play"/></svg></button>' +
        '<span class="stage__time">' + esc(item.duration || '5 秒') + '</span>' +
        (res.demo ? '<span class="stage__badge">DEMO</span>' : '');
    }
  }

  /* ---------- 参考图 ---------- */
  /** 卡片上的「输入来源」：把连进来的卡片列成 chip（连线 = 输入） */
  function renderRef(el, item) {
    var slot = el.querySelector('[data-refslot]');
    if (!slot) return;

    if (!Store.kindDef(item.kind).ports.in) {
      if (slot._key !== 'none') { slot._key = 'none'; slot.innerHTML = ''; }
      return;
    }

    var incoming = Store.doc.links.filter(function (l) { return l.to === item.id; });
    var key = incoming.map(function (l) { return l.id + ':' + l.from; }).join(',') || 'none';
    if (slot._key === key) return;
    slot._key = key;

    if (!incoming.length) {
      slot.className = '';
      slot.innerHTML = '';
      return;
    }

    slot.className = 'card__inputs';
    slot.innerHTML = incoming.map(function (l) {
      var src = Store.get(l.from);
      if (!src) return '';
      var def = Store.kindDef(src.kind);
      var thumb = src.kind === 'asset'
        ? '<img src="' + esc(src.src) + '" alt="">'
        : '<svg class="ico"><use href="#' + def.icon + '"/></svg>';
      var label = src.kind === 'asset' ? (src.name || '图片') : def.short;
      return '<div class="inputchip">' + thumb +
        '<span>来自 ' + esc(label) + '</span>' +
        '<button data-act="unlink" data-link="' + esc(l.id) + '" type="button" title="断开连接">' +
        '<svg class="ico"><use href="#i-close"/></svg></button></div>';
    }).join('');
  }

  /* ---------- 拖拽时只改 transform ---------- */
  function syncTransforms(ids) {
    var list = ids || Store.doc.items.map(function (i) { return i.id; });
    list.forEach(function (id) {
      var item = Store.get(id);
      var el = els[id];
      if (item && el) el.style.transform = 'translate3d(' + item.x + 'px,' + item.y + 'px,0)';
    });
  }

  /* ==========================================================================
     网格
     ========================================================================== */
  /* ==========================================================================
     连线（轻量连接：端口 -> 端口）
     ========================================================================== */
  function portWorld(item, side) {
    var m = metrics[item.id] || { w: item.w || 300, h: 200 };
    return { x: side === 'in' ? item.x : item.x + m.w, y: item.y + m.h / 2 };
  }

  function r2(v) { return Math.round(v * 100) / 100; }

  function linkCurve(x1, y1, x2, y2) {
    var dx = Math.abs(x2 - x1);
    var c = Math.max(42, Math.min(dx * 0.5, 190));
    if (x2 < x1) c = Math.max(c, 96);          // 反向连线给更大弧度，避免压住卡片
    return { c1x: x1 + c, c1y: y1, c2x: x2 - c, c2y: y2 };
  }

  function linkPath(x1, y1, x2, y2) {
    var b = linkCurve(x1, y1, x2, y2);
    return 'M' + r2(x1) + ' ' + r2(y1) + ' C' + r2(b.c1x) + ' ' + r2(b.c1y) +
      ' ' + r2(b.c2x) + ' ' + r2(b.c2y) + ' ' + r2(x2) + ' ' + r2(y2);
  }

  function linkMid(x1, y1, x2, y2) {
    var b = linkCurve(x1, y1, x2, y2);
    return {
      x: 0.125 * x1 + 0.375 * b.c1x + 0.375 * b.c2x + 0.125 * x2,
      y: 0.125 * y1 + 0.375 * b.c1y + 0.375 * b.c2y + 0.125 * y2
    };
  }

  function drawLinks() {
    var view = Store.view;
    var seen = {};
    Store.doc.links.forEach(function (link) {
      var a = Store.get(link.from), b = Store.get(link.to);
      if (!a || !b) return;
      seen[link.id] = true;

      var p1 = portWorld(a, 'out'), p2 = portWorld(b, 'in');
      var s1 = FC.geo.toScreen(p1.x, p1.y, view);
      var s2 = FC.geo.toScreen(p2.x, p2.y, view);
      var d = linkPath(s1.x, s1.y, s2.x, s2.y);

      var g = linkEls[link.id];
      if (!g) {
        g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', 'link');
        g.innerHTML = '<path class="link-hit"/><path class="link-path"/>' +
          '<circle class="link-dot" r="3"/>' +
          '<g class="link-del"><circle r="9"/>' +
          '<path d="M-3.2 -3.2L3.2 3.2M3.2 -3.2L-3.2 3.2"/></g>';
        linkEls[link.id] = g;
      }
      g.dataset.id = link.id;
      g.querySelector('.link-hit').setAttribute('d', d);
      g.querySelector('.link-path').setAttribute('d', d);
      var dot = g.querySelector('.link-dot');
      dot.setAttribute('cx', r2(s1.x));
      dot.setAttribute('cy', r2(s1.y));

      var sel = Store.selectedLinks.indexOf(link.id) >= 0;
      g.classList.toggle('is-selected', sel);
      var del = g.querySelector('.link-del');
      var mid = linkMid(s1.x, s1.y, s2.x, s2.y);
      del.setAttribute('transform', 'translate(' + r2(mid.x) + ',' + r2(mid.y) + ')');
      del.setAttribute('display', sel ? 'inline' : 'none');
    });

    Object.keys(linkEls).forEach(function (id) {
      if (!seen[id]) {
        if (linkEls[id].parentNode) linkEls[id].parentNode.removeChild(linkEls[id]);
        delete linkEls[id];
      }
    });
    Object.keys(linkEls).forEach(function (id) {
      var g = linkEls[id];
      if (g.parentNode !== S.linkGroup) S.linkGroup.appendChild(g);
    });
  }

  /* ---------- 拖拽中的连线 ---------- */
  var livePath = null;
  function showLivePath(d) {
    if (!livePath) {
      livePath = document.createElementNS(SVG_NS, 'path');
      livePath.setAttribute('class', 'link-live');
      S.overlayGroup.appendChild(livePath);
    }
    livePath.setAttribute('d', d);
  }
  function hideLivePath() {
    if (livePath && livePath.parentNode) livePath.parentNode.removeChild(livePath);
    livePath = null;
  }

  function drawGrid() {
    var view = Store.view;
    var spacing = 26 * view.k;
    var mult = 1;
    while (spacing * mult < 13 && mult < 16) mult *= 2;
    spacing = spacing * mult;

    S.grid.style.backgroundSize = spacing + 'px ' + spacing + 'px';
    S.grid.style.backgroundPosition =
      (((view.x % spacing) + spacing) % spacing) + 'px ' +
      (((view.y % spacing) + spacing) % spacing) + 'px';
    S.grid.style.opacity = view.k < 0.45 ? 0.45 : (view.k > 1.6 ? 0.8 : 1);
    S.grid.style.backgroundImage =
      'radial-gradient(circle at center, var(--grid-dot) ' +
      (view.k >= 1.4 ? 1.35 : 1.05) + 'px, transparent ' + (view.k >= 1.4 ? 1.5 : 1.2) + 'px)';
  }

  /* ==========================================================================
     视图
     ========================================================================== */
  function applyView() {
    var v = Store.view;
    S.world.style.transform = 'translate3d(' + v.x + 'px,' + v.y + 'px,0) scale(' + v.k + ')';
  }

  function syncChrome() {
    var v = Store.view;
    if (S.zoomValue) S.zoomValue.textContent = Math.round(v.k * 100) + '%';
    if (S.statusCount) {
      var n = Store.doc.items.length;
      S.statusCount.textContent = n ? (n + ' 个卡片') : '空画布';
    }
    if (S.docName && S.docName.textContent !== Store.doc.name) S.docName.textContent = Store.doc.name;
    if (S.undo) S.undo.disabled = !Store.canUndo();
    if (S.redo) S.redo.disabled = !Store.canRedo();
    if (S.empty) S.empty.hidden = Store.doc.items.length > 0;
  }

  /* ---------- 视图操作 ---------- */
  function bounds() {
    var items = Store.doc.items;
    if (!items.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    items.forEach(function (it) {
      var r = rectOf(it);
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function fitView(padding, minK) {
    var vw = S.board.clientWidth, vh = S.board.clientHeight;
    var b = bounds();
    if (!b) { Store.setView({ x: vw / 2, y: vh / 2, k: 1 }); return; }
    var pad = padding === undefined ? 80 : padding;
    var floor = minK === undefined ? 0.15 : minK;
    var k = Math.min((vw - pad * 2) / Math.max(b.w, 1), (vh - pad * 2) / Math.max(b.h, 1));
    k = FC.util.clamp(k, floor, 1.6);
    Store.setView({
      k: k,
      x: (vw - b.w * k) / 2 - b.x * k,
      y: (vh - b.h * k) / 2 - b.y * k
    });
  }

  function centerOn(wx, wy, targetK) {
    var vw = S.board.clientWidth, vh = S.board.clientHeight;
    var k = targetK || Store.view.k;
    Store.setView({ k: k, x: vw / 2 - wx * k, y: vh / 2 - wy * k });
  }

  /** 找准一个「新建卡片」的落点：视口中心 */
  function viewCenterWorld() {
    var vw = S.board.clientWidth, vh = S.board.clientHeight;
    var view = Store.view;
    return { x: (vw / 2 - view.x) / view.k, y: (vh / 2 - view.y) / view.k };
  }

  /** 找一个不会压住已有卡片的位置 */
  function findFreeSpot(w, h, origin) {
    var base = origin || viewCenterWorld();
    var x = Math.round(base.x - w / 2);
    var y = Math.round(base.y - h / 2);
    var candidate = { x: x, y: y };
    var tries = 0;
    while (tries < 60) {
      var hit = Store.doc.items.some(function (it) {
        var r = rectOf(it);
        return !(candidate.x + w < r.x - 16 || r.x + r.w < candidate.x - 16 ||
                 candidate.y + h < r.y - 16 || r.y + r.h < candidate.y - 16);
      });
      if (!hit) break;
      candidate.x += 34;
      candidate.y += 34;
      tries++;
    }
    return candidate;
  }

  function reset() {
    els = {}; metrics = {}; linkEls = {};
    S.items.innerHTML = '';
    if (S.linkGroup) S.linkGroup.innerHTML = '';
    hideLivePath();
    invalidate({ items: true, grid: true });
  }

  function elOf(id) { return els[id] || null; }

  FC.render = {
    cacheDom: cacheDom,
    reset: reset,
    invalidate: invalidate,
    requestItems: requestItems,
    requestView: requestView,
    requestFit: requestFit,
    requestLinks: requestLinks,
    drawLinks: drawLinks,
    showLivePath: showLivePath,
    hideLivePath: hideLivePath,
    portWorld: portWorld,
    linkPath: linkPath,
    syncTransforms: syncTransforms,
    applyView: applyView,
    drawGrid: drawGrid,
    syncChrome: syncChrome,
    rectOf: rectOf,
    sizeOf: sizeOf,
    bounds: bounds,
    fitView: fitView,
    centerOn: centerOn,
    findFreeSpot: findFreeSpot,
    viewCenterWorld: viewCenterWorld,
    elOf: elOf,
    esc: esc,
    el: function () { return S; }
  };
})(window.FC);