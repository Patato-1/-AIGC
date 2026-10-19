/* ==========================================================================
   ui.js — 界面层
   双击创建菜单 / 卡片事件委托 / 图片导入 / 更多菜单 / 对话框 / Toast
   ========================================================================== */
(function (FC) {
  'use strict';

  var Store = FC.Store;
  var R = FC.render;
  var esc = R.esc;

  var D = {};
  var createPoint = null;      // 双击处的世界坐标
  var pendingLink = null;      // 从端口拉线松手在空白处时：{ cardId, side }
  var MAX_EDGE = 1600;         // 拖入图片的最长边（控制 localStorage 体积）

  /* ==========================================================================
     初始化
     ========================================================================== */
  function init() {
    D.board = document.getElementById('board');
    D.scrim = document.getElementById('scrim');
    D.menuSheet = document.getElementById('menuSheet');
    D.menuBody = document.getElementById('menuBody');
    D.historySheet = document.getElementById('historySheet');
    D.ctxMenu = document.getElementById('ctxMenu');
    D.dialogWrap = document.getElementById('dialogWrap');
    D.dialogTitle = document.getElementById('dialogTitle');
    D.dialogText = document.getElementById('dialogText');
    D.dialogInput = document.getElementById('dialogInput');
    D.dialogActions = document.getElementById('dialogActions');
    D.toastHost = document.getElementById('toastHost');
    D.imageInput = document.getElementById('imageInput');
    D.jsonInput = document.getElementById('jsonInput');
    D.statSave = document.getElementById('statSave');
    D.dropCue = document.getElementById('dropCue');

    wireNav();
    wireRail();
    wireZoom();
    wireSheet();
    wireDialog();
    wireFiles();
    wireCards();
    wireHistory();
    wireViewer();

    Store.on(onStoreEvent);

    FC.ui.applyTheme(Store.ui.theme, true);
    renderMenu();
    updateHistoryButtons();
    setSaveState('idle');
  }

  /* ==========================================================================
     事件总线
     ========================================================================== */
  function onStoreEvent(type, payload) {
    switch (type) {
      case 'doc': R.requestItems(); updateHistoryButtons(); break;
      case 'selection': R.requestItems(); break;
      case 'history': updateHistoryButtons(); break;
      case 'saved': setSaveState('saved', payload); break;
      case 'dirty': setSaveState('dirty'); break;
      case 'save-error': setSaveState('error'); break;
      default: break;
    }
  }

  function updateHistoryButtons() {
    var u = document.getElementById('btnUndo');
    var r = document.getElementById('btnRedo');
    if (u) u.disabled = !Store.canUndo();
    if (r) r.disabled = !Store.canRedo();
  }

  function setSaveState(state, at) {
    if (!D.statSave) return;
    var meta = document.getElementById('docMeta');
    if (meta) {
      meta.textContent = state === 'dirty' ? '未保存'
        : state === 'error' ? '保存失败'
          : (state === 'saved' ? '已自动保存' : '本地草稿');
    }
    var text = state === 'dirty' ? '未保存'
      : state === 'error' ? '保存失败（图片可能过多）'
        : (state === 'saved' ? '已保存 ' + timeAgo(at) : '未保存');
    if (D.statSave.textContent !== text) {
      D.statSave.textContent = text;
      D.statSave.classList.remove('is-pulse');
      void D.statSave.offsetWidth;
      D.statSave.classList.add('is-pulse');
    }
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 10) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  /* ==========================================================================
     Toast
     ========================================================================== */
  function toast(message, icon) {
    if (!D.toastHost) return;
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (icon ? '<svg class="ico"><use href="#' + esc(icon) + '"/></svg>' : '') +
      '<span>' + esc(message) + '</span>';
    D.toastHost.appendChild(el);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, 2000);
    while (D.toastHost.children.length > 3) D.toastHost.removeChild(D.toastHost.firstChild);
  }

  /* ==========================================================================
     主题
     ========================================================================== */
  function applyTheme(theme, silent) {
    var t = theme === 'dark' ? 'dark' : 'light';
    Store.ui.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(FC.THEME_KEY, t); } catch (e) { /* ignore */ }
    if (!silent) toast(t === 'dark' ? '深色外观' : '浅色外观', t === 'dark' ? 'i-moon' : 'i-sun');
  }

  function toggleTheme() { applyTheme(Store.ui.theme === 'dark' ? 'light' : 'dark'); }

  /* ==========================================================================
     双击创建菜单
     ========================================================================== */
  /** opts.link = { cardId, side }：从端口拉线到空白处时，建完卡自动连上 */
  function openCreateMenu(clientX, clientY, worldPointArg, opts) {
    createPoint = worldPointArg || R.viewCenterWorld();
    pendingLink = (opts && opts.link) || null;

    var r = D.board.getBoundingClientRect();
    var px = clientX - r.left;
    var py = clientY - r.top;

    var fromName = '';
    if (pendingLink) {
      var src = Store.get(pendingLink.cardId);
      if (src) fromName = src.name || Store.kindDef(src.kind).label;
    }

    D.ctxMenu.innerHTML =
      '<div class="ctxmenu__title">' + (pendingLink ? '创建并连接' : '创建') + '</div>' +
      (pendingLink ? '<div class="ctxmenu__foot">' +
        (pendingLink.side === 'out'
          ? '连到「' + esc(fromName) + '」'
          : '从「' + esc(fromName) + '」接收') + '</div>' : '') +
      Store.KIND_ORDER.map(function (kind) {
        var def = Store.kindDef(kind);
        return '<button class="ctxmenu__item" type="button" data-kind="' + kind + '">' +
          '<span class="ctxmenu__glyph"><svg class="ico"><use href="#' + def.icon + '"/></svg></span>' +
          '<span class="ctxmenu__text">' +
            '<span class="ctxmenu__name">' + esc(def.label) + '</span>' +
            '<span class="ctxmenu__desc">' + esc(def.desc) + '</span>' +
          '</span></button>';
      }).join('');

    D.ctxMenu.hidden = false;

    // 定位（不超出画布边界）
    var mw = D.ctxMenu.offsetWidth, mh = D.ctxMenu.offsetHeight;
    var left = FC.util.clamp(px, 10, Math.max(10, r.width - mw - 10));
    var top = FC.util.clamp(py, 10, Math.max(10, r.height - mh - 10));
    D.ctxMenu.style.left = left + 'px';
    D.ctxMenu.style.top = top + 'px';
    // 动画原点跟随点击位置
    D.ctxMenu.style.setProperty('--ox', (px - left) + 'px');
    D.ctxMenu.style.setProperty('--oy', (py - top) + 'px');
  }

  function closeCreateMenu() {
    if (D.ctxMenu && !D.ctxMenu.hidden) D.ctxMenu.hidden = true;
    pendingLink = null;
  }

  function openCreateMenuAtCenter() {
    var r = D.board.getBoundingClientRect();
    openCreateMenu(r.left + r.width / 2, r.top + r.height / 2, R.viewCenterWorld());
  }

  function createAt(kind, point) {
    var def = Store.kindDef(kind);
    var pick = point || createPoint || R.viewCenterWorld();
    var w = def.w;
    var spot = R.findFreeSpot(w, kind === 'video-gen' ? w * 0.72 + 150 : w + 150, pick);
    var item = Store.addItem(kind, spot.x, spot.y);

    // 如果是「从端口拉线松手在空白处」建出来的，顺手连上
    var link = pendingLink;
    pendingLink = null;
    var linked = false;
    if (link) {
      var a = link.side === 'out' ? link.cardId : item.id;
      var b = link.side === 'out' ? item.id : link.cardId;
      linked = !!Store.addLink(a, b);
    }

    closeCreateMenu();
    R.invalidate({ items: true, grid: true });
    R.centerOn(spot.x + w / 2, spot.y + (w * 0.5) / 2);
    if (link && linked) {
      toast('已创建「' + def.label + '」并连上', def.icon);
    } else if (link) {
      toast('已创建「' + def.label + '」，但这两张卡连不上', def.icon);
    } else {
      toast('已创建「' + def.label + '」', def.icon);
    }
    createPoint = null;
    return item;
  }

  /* ==========================================================================
     提示词里的 @ 图片引用
     ========================================================================== */
  var atState = null;   // { cardId, ta, start, end, items, index }

  function atEls() {
    return {
      box: document.getElementById('atPick'),
      list: document.getElementById('atPickList')
    };
  }

  function closeAtPick() {
    var e = atEls();
    if (e.box) e.box.hidden = true;
    atState = null;
  }

  /** 光标前是不是刚打了一个 @ 或 @xxx（xxx 里不能有空格） */
  function atQuery(ta) {
    var pos = ta.selectionStart;
    var before = ta.value.slice(0, pos);
    var m = /@([^@\s]*)$/.exec(before);
    if (!m) return null;
    return { start: pos - m[0].length, end: pos, q: m[1] };
  }

  function openAtPick(cardId, ta, q) {
    var refs = Store.refsOf(cardId);
    if (!refs.length) {
      // 没有连进来的图，给个提示就好，不弹面板
      return false;
    }
    var ql = String(q || '').toLowerCase();
    var hits = refs.filter(function (r) {
      return !ql || r.handle.toLowerCase().indexOf(ql) >= 0 || r.name.toLowerCase().indexOf(ql) >= 0;
    });
    if (!hits.length) return false;

    var e = atEls();
    if (!e.box || !e.list) return false;

    var m = atQuery(ta);
    if (!m) return false;

    atState = { cardId: cardId, ta: ta, start: m.start, end: m.end, items: hits, index: 0 };
    renderAtPick();
    positionAtPick(ta);
    e.box.hidden = false;
    return true;
  }

  function renderAtPick() {
    var e = atEls();
    if (!e.list || !atState) return;
    e.list.innerHTML = atState.items.map(function (r, i) {
      var url = (FC.assets && FC.assets.urlOf(r.assetId)) || '';
      var thumb = url ? '<img src="' + esc(url) + '" alt="">' : '<svg class="ico"><use href="#i-image"/></svg>';
      return '<button class="atpick__item' + (i === atState.index ? ' is-on' : '') + '"' +
        ' data-i="' + i + '" type="button">' + thumb +
        '<span class="atpick__name">@' + esc(r.handle) + '</span>' +
        '<span class="atpick__role">' + esc(r.role) + '</span></button>';
    }).join('');
  }

  function positionAtPick(ta) {
    var e = atEls();
    if (!e.box) return;
    var r = ta.getBoundingClientRect();
    var br = D.board.getBoundingClientRect();
    var h = e.box.offsetHeight || 200;
    var below = r.bottom + 6;
    var top = (below + h < br.bottom) ? below : Math.max(br.top + 8, r.top - h - 6);
    e.box.style.left = Math.round(r.left) + 'px';
    e.box.style.top = Math.round(top) + 'px';
    e.box.style.minWidth = Math.round(Math.min(r.width, 280)) + 'px';
  }

  /** 把 @xxx 替换成选中的 handle */
  function applyAtPick(r) {
    if (!atState) return;
    var ta = atState.ta;
    var v = ta.value;
    var insert = '@' + r.handle + ' ';
    ta.value = v.slice(0, atState.start) + insert + v.slice(atState.end);
    var caret = atState.start + insert.length;
    try { ta.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
    // 把新值写回文档
    var cardEl = ta.closest('.card');
    if (cardEl) Store.update(cardEl.dataset.id, { prompt: ta.value });
    closeAtPick();
    ta.focus();
  }

  function moveAtPick(delta) {
    if (!atState) return;
    var n = atState.items.length;
    atState.index = (atState.index + delta + n) % n;
    renderAtPick();
  }

  /* ==========================================================================
     卡片事件委托
     ========================================================================== */
  function wireCards() {
    var layer = document.getElementById('itemsLayer');

    // 点击（按钮）
    layer.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var cardEl = btn.closest('.card');
      if (!cardEl) return;
      var id = cardEl.dataset.id;
      var act = btn.dataset.act;

      if (act === 'generate') {
        FC.generate.start(id);
      } else if (act === 'delete') {
        Store.remove([id]);
        toast('已删除', 'i-trash');
      } else if (act === 'duplicate') {
        Store.duplicate([id]);
        toast('已复制', 'i-copy');
      } else if (act === 'unlink') {
        Store.removeLinks([btn.dataset.link]);
      } else if (act === 'role') {
        // 点一下换下一个角色：参考 → 主体 → 风格 → 首帧 → 尾帧
        var nextRole = Store.cycleLinkRole(btn.dataset.link);
        if (nextRole) toast('角色：' + nextRole + ' · ' + (FC.ROLE_HINT[nextRole] || ''), 'i-sparkle');
      } else if (act === 'play') {
        var stage = cardEl.querySelector('[data-stage]');
        if (!stage) return;
        var playing = stage.classList.toggle('is-playing');
        var v = stage.querySelector('video');
        if (v) { try { playing ? v.play() : v.pause(); } catch (err) { /* ignore */ } }
      }
    });

    // 双击卡片里的图/视频 → 全屏查看
    layer.addEventListener('dblclick', function (e) {
      var media = e.target.closest('.card__stage img, .card__stage video, .card__media img, .card__media video');
      if (!media) return;
      var cardEl = media.closest('.card');
      if (!cardEl) return;
      var item = Store.get(cardEl.dataset.id);

      var src = media.getAttribute('src') || '';
      if (!src) return;
      var isVideo = media.tagName === 'VIDEO';

      // 名字优先用提示词，其次素材名
      var name = '';
      if (item) name = item.prompt || item.name || '';
      openViewer(src, name, isVideo);
    });

    // 表单输入
    layer.addEventListener('input', function (e) {
      var el = e.target;
      var k = el.dataset.k;
      if (!k) return;
      var cardEl = el.closest('.card');
      if (!cardEl) return;
      var patch = {};
      patch[k] = el.value;
      Store.update(cardEl.dataset.id, patch, { commit: false });
    });

    layer.addEventListener('change', function (e) {
      var el = e.target;
      var k = el.dataset.k;
      if (!k) return;
      var cardEl = el.closest('.card');
      if (!cardEl) return;
      var id = cardEl.dataset.id;
      var patch = {};
      patch[k] = el.value;

      // 换模型时，其余参数要按新模型的约束重置。
      // 两个平台的视频模型写法完全不同（minimax-h3 用 landscape / 有分辨率，
      // wan3.0 用 16:9 / 没有分辨率 / 时长 4~30），不重置就会把上一个
      // 模型的非法值带过去，提交时才报错。
      if (k === 'model') {
        var cur = Store.get(id);
        if (cur) {
          var probe = Object.assign({}, cur, patch);   // 用新模型算可用选项
          var o = Store.optionsFor(probe);
          if (o.ratios.indexOf(cur.ratio) < 0) patch.ratio = o.ratios[0];
          if (o.durations && o.durations.indexOf(cur.duration) < 0) {
            patch.duration = o.durations[o.durations.length - 1];
          }
          if (o.resolutions && o.resolutions.indexOf(cur.resolution) < 0) {
            patch.resolution = o.resolutions[0];
          }
        }
      }

      // 换分辨率时，时长可能要跟着降级 ——
      // minimax-h3 官方限制：480p/768p 能到 15 秒，1080p 最多 10 秒。
      // 不处理的话，用户选着 15 秒再切到 1080p，就会带着非法组合提交。
      if (k === 'resolution') {
        var cur2 = Store.get(id);
        if (cur2 && Store.maxDurationFor) {
          var probe2 = Object.assign({}, cur2, patch);
          var maxSec = Store.maxDurationFor(probe2);
          var curSec = Store.secondsOf(cur2.duration);
          if (maxSec && curSec > maxSec) {
            // 降到该分辨率允许的最大时长
            var o2 = Store.optionsFor(probe2);
            patch.duration = o2.durations[o2.durations.length - 1];
            FC.ui.toast('1080p 最长只能 10 秒，已把时长改成 ' + patch.duration, 'i-clock');
          }
        }
      }

      Store.update(id, patch);
      // 比例变了，卡片高度会自动跟着变，重新测量
      R.requestItems();
    });

    // 提示词框自适应高度
    layer.addEventListener('focusin', function (e) {
      if (e.target.dataset && e.target.dataset.k === 'prompt') autoGrow(e.target);
    });
    layer.addEventListener('input', function (e) {
      if (!e.target.dataset || e.target.dataset.k !== 'prompt') return;
      autoGrow(e.target);
      var cardEl = e.target.closest('.card');
      if (!cardEl) return;
      var q = atQuery(e.target);
      if (q) openAtPick(cardEl.dataset.id, e.target, q.q);
      else closeAtPick();
    });

    // @ 候选：键盘操作（捕获阶段，抢在全局快捷键之前）
    layer.addEventListener('keydown', function (e) {
      if (!atState) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); moveAtPick(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveAtPick(-1); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        applyAtPick(atState.items[atState.index]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeAtPick();
      }
    }, true);

    // @ 候选：点选
    var ap = document.getElementById('atPickList');
    if (ap) {
      ap.addEventListener('mousedown', function (e) {
        var btn = e.target.closest('[data-i]');
        if (!btn || !atState) return;
        e.preventDefault();
        applyAtPick(atState.items[Number(btn.dataset.i)]);
      });
    }

    // 失焦就收起
    layer.addEventListener('focusout', function (e) {
      if (e.target.dataset && e.target.dataset.k === 'prompt') setTimeout(closeAtPick, 120);
    });
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(130, Math.max(54, ta.scrollHeight)) + 'px';
  }

  /* ==========================================================================
     图片导入
     ========================================================================== */
  function wireFiles() {
    D.imageInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(D.imageInput.files || []);
      D.imageInput.value = '';
      if (files.length) importFiles(files, { worldPoint: R.viewCenterWorld() });
    });

    D.jsonInput.addEventListener('change', function () {
      var f = D.jsonInput.files && D.jsonInput.files[0];
      D.jsonInput.value = '';
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          Store.setDoc(JSON.parse(String(reader.result)));
          R.reset();
          R.fitView();
          toast('已导入「' + Store.doc.name + '」', 'i-upload');
        } catch (err) {
          toast('文件解析失败', 'i-close');
        }
      };
      reader.readAsText(f);
    });
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('无法读取图片')); };
      img.src = url;
    });
  }

  /** 等比缩小并编码成 Blob（直接给 IndexedDB，不经过 base64，省 33% 体积） */
  function encode(img, maxEdge) {
    var nw = img.naturalWidth || img.width;
    var nh = img.naturalHeight || img.height;
    var scale = Math.min(1, maxEdge / Math.max(nw, nh));
    var tw = Math.max(1, Math.round(nw * scale));
    var th = Math.max(1, Math.round(nh * scale));

    var c = document.createElement('canvas');
    c.width = tw; c.height = th;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, tw, th);

    return toBlob(c, 'image/webp', 0.86).then(function (blob) {
      if (blob && blob.type === 'image/webp') return { blob: blob, w: nw, h: nh };
      // 浏览器不支持 webp 时退回 jpeg
      return toBlob(c, 'image/jpeg', 0.86).then(function (j) {
        return { blob: j, w: nw, h: nh };
      });
    });
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      if (!canvas.toBlob) return resolve(null);
      try {
        canvas.toBlob(function (b) { resolve(b); }, type, quality);
      } catch (e) { resolve(null); }
    });
  }

  async function importFiles(files, opts) {
    opts = opts || {};
    var images = files.filter(function (f) { return /^image\//.test(f.type); });
    if (!images.length) { toast('只支持图片文件', 'i-close'); return; }

    toast('正在读取 ' + images.length + ' 张图片…', 'i-image');
    await FC.assets.open();
    var loaded = [];
    for (var i = 0; i < images.length; i++) {
      try {
        var img = await loadImage(images[i]);
        var enc = await encode(img, MAX_EDGE);
        if (!enc.blob) continue;
        loaded.push({
          file: images[i],
          blob: enc.blob,
          nw: enc.w,
          nh: enc.h
        });
      } catch (err) {
        console.warn('[ui] 图片读取失败', err);
      }
    }

    if (!loaded.length) { toast('图片读取失败', 'i-close'); return; }

    /* --- 作为参考图贴到某张生成卡上 --- */
    if (opts.refTargetId) {
      var first = loaded[0];
      var asset = Store.addItem('asset', 0, 0, {
        name: cleanName(first.file.name),
        naturalW: first.nw,
        naturalH: first.nh,
        w: assetWidth(first.nw)
      });
      // 先把图挂进内存（立刻能显示），再异步落盘到 IndexedDB
      FC.assets.attach(asset.id, first.blob);
      FC.assets.put(asset.id, first.blob);
      R.requestItems();
      var link = Store.addLink(asset.id, opts.refTargetId);
      toast(link ? '已连到这张卡作为输入' : '这张卡已经连过它了', link ? 'i-sparkle' : 'i-close');
      return;
    }

    /* --- 作为素材放到画布上 --- */
    var origin = opts.worldPoint || R.viewCenterWorld();
    var items = [];
    var offset = 0;
    loaded.forEach(function (L) {
      var item = Store.createItem('asset', 0, 0, {
        name: cleanName(L.file.name),
        naturalW: L.nw,
        naturalH: L.nh,
        w: assetWidth(L.nw)
      });
      var h = item.w * (L.nh / Math.max(1, L.nw));
      var spot = R.findFreeSpot(item.w, h, { x: origin.x + offset, y: origin.y + offset });
      item.x = spot.x;
      item.y = spot.y;
      items.push(item);
      offset += 28;
    });

    // 先挂内存再落盘：卡片立刻就能显示，不用等 IndexedDB
    var pairs = [];
    items.forEach(function (it, idx) {
      FC.assets.attach(it.id, loaded[idx].blob);
      pairs.push([it.id, loaded[idx].blob]);
    });

    Store.addItems(items);
    R.requestItems();
    toast('已放入 ' + items.length + ' 张图片', 'i-check');

    // 写入失败不阻断使用，但要让你知道
    Promise.all(pairs.map(function (pr) { return FC.assets.put(pr[0], pr[1]); }))
      .then(function (res) {
        var bad = res.filter(function (ok) { return !ok; }).length;
        if (bad) toast(bad + ' 张图片没能存进本地库（刷新后会丢）', 'i-close');
      });
  }

  function assetWidth(naturalW) {
    return Math.round(FC.util.clamp(naturalW || 260, 150, 320));
  }

  function cleanName(name) {
    return String(name || '图片').replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || '图片';
  }

  /* ==========================================================================
     顶部 / 工具条 / 缩放
     ========================================================================== */
  function wireNav() {
    document.getElementById('btnTheme').addEventListener('click', toggleTheme);
    document.getElementById('btnMenu').addEventListener('click', openMenu);
    document.getElementById('btnRename').addEventListener('click', renameDoc);
    document.getElementById('btnCreate').addEventListener('click', function () {
      openCreateMenuAtCenter();
    });
    document.getElementById('btnEmptyCreate').addEventListener('click', function () {
      openCreateMenuAtCenter();
    });

    var hintBar = document.getElementById('hintBar');
    var hintClose = document.getElementById('hintClose');
    var seen = false;
    try { seen = !!localStorage.getItem(FC.HINT_KEY); } catch (e) { seen = false; }

    function dismissHint() {
      if (!hintBar || hintBar.hidden) return;
      hintBar.classList.add('is-hidden');
      setTimeout(function () { hintBar.hidden = true; }, 280);
      try { localStorage.setItem(FC.HINT_KEY, '1'); } catch (e) { /* ignore */ }
    }
    if (hintBar && seen) hintBar.hidden = true;
    if (hintClose) hintClose.addEventListener('click', dismissHint);
    D.board.addEventListener('pointerdown', function () { setTimeout(dismissHint, 1200); });
  }

  function wireRail() {
    document.querySelectorAll('.rail__btn[data-tool]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        FC.interactions.setTool(btn.dataset.tool);
      });
    });
    document.getElementById('toolImage').addEventListener('click', function () {
      D.imageInput.click();
    });
    document.getElementById('toolCreate').addEventListener('click', openCreateMenuAtCenter);
    document.getElementById('btnUndo').addEventListener('click', function () {
      if (Store.undo()) toast('已撤销', 'i-undo');
    });
    document.getElementById('btnRedo').addEventListener('click', function () {
      if (Store.redo()) toast('已重做', 'i-redo');
    });
  }

  function wireZoom() {
    document.getElementById('zoomIn').addEventListener('click', function () { FC.interactions.zoomBy(1.25); });
    document.getElementById('zoomOut').addEventListener('click', function () { FC.interactions.zoomBy(1 / 1.25); });
    document.getElementById('zoomFit').addEventListener('click', function () { R.fitView(); });
    document.getElementById('zoomValue').addEventListener('click', function () { FC.interactions.zoomTo(1); });
    document.getElementById('zoomReset').addEventListener('click', function () {
      var r = D.board.getBoundingClientRect();
      Store.setView({ k: 1, x: r.width / 2, y: r.height / 2 });
      R.fitView();
      toast('视图已重置', 'i-layers');
    });
  }

  /* ==========================================================================
     弹层 / 菜单
     ========================================================================== */
  function openSheet(el) {
    D.scrim.hidden = false;
    requestAnimationFrame(function () { D.scrim.classList.add('is-in'); });
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
  }

  function closeSheets() {
    if (D.menuSheet) { D.menuSheet.classList.remove('is-open'); D.menuSheet.setAttribute('aria-hidden', 'true'); }
    if (D.historySheet) { D.historySheet.classList.remove('is-open'); D.historySheet.setAttribute('aria-hidden', 'true'); }
    if (D.scrim && !D.scrim.hidden) {
      D.scrim.classList.remove('is-in');
      setTimeout(function () { D.scrim.hidden = true; }, 240);
    }
  }

  function closeAll() { closeSheets(); closeCreateMenu(); }

  /** 指针按下时收起临时浮层 */
  function dismissTransient(e) {
    // 点在菜单自己身上时不要关菜单，否则菜单项的 click 永远收不到
    if (e && e.target && e.target.closest && e.target.closest('.ctxmenu')) return;
    // @ 候选面板同理：点它自己不能收起
    if (e && e.target && e.target.closest && e.target.closest('.atpick')) return;
    closeCreateMenu();
    closeAtPick();
  }

  function wireSheet() {
    D.scrim.addEventListener('click', closeSheets);

    // 点击画布别处关闭创建菜单
    D.board.addEventListener('pointerdown', function (e) {
      if (!D.ctxMenu.hidden && !e.target.closest('.ctxmenu')) closeCreateMenu();
    }, true);

    // 创建菜单项
    D.ctxMenu.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-kind]');
      if (!btn) return;
      createAt(btn.dataset.kind);
    });
  }

  function renderMenu() {
    var items = [
      { act: 'addimage', icon: 'i-image', text: '添加图片素材', hint: '可多选' },
      { act: 'fit', icon: 'i-fit', text: '适应视图', hint: '⌘0' },
      { act: 'export', icon: 'i-download', text: '导出画布 JSON', hint: '' },
      { act: 'import', icon: 'i-upload', text: '导入画布 JSON', hint: '' },
      { act: 'theme', icon: 'i-moon', text: '切换浅色 / 深色', hint: '' },
      { act: 'clear', icon: 'i-trash', text: '清空画布', hint: '', danger: true }
    ];
    D.menuBody.innerHTML = '<div class="menulist">' + items.map(function (it) {
      return '<button class="menuitem' + (it.danger ? ' menuitem--danger' : '') + '" type="button" data-act="' + it.act + '">' +
        '<svg class="ico"><use href="#' + it.icon + '"/></svg>' +
        '<span class="menuitem__text">' + esc(it.text) + '</span>' +
        (it.hint ? '<span class="menuitem__hint">' + esc(it.hint) + '</span>' : '') +
        '</button>';
    }).join('') + '</div>' +
      '<div class="menulist"><div class="menuitem" style="pointer-events:none">' +
      '<svg class="ico"><use href="#i-doc"/></svg>' +
      '<span class="menuitem__text" style="color:var(--label-3);font-size:12px">' +
      (FC.api.config.USE_MOCK ? '数据保存在本地浏览器' : '已连接 ' + esc(FC.api.config.BASE_URL)) +
      '</span></div></div>';

    D.menuBody.addEventListener('click', async function (e) {
      var btn = e.target.closest('.menuitem[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      closeSheets();
      switch (act) {
        case 'addimage': D.imageInput.click(); break;
        case 'fit': R.fitView(); break;
        case 'export': exportJSON(); break;
        case 'import': D.jsonInput.click(); break;
        case 'theme': toggleTheme(); break;
        case 'clear': {
          var ok = await confirmDialog({
            title: '清空画布？',
            text: '所有卡片都会被删除，此操作可以撤销。',
            confirmLabel: '清空',
            danger: true
          });
          if (ok) {
            Store.clear();
            R.reset();
            toast('画布已清空', 'i-trash');
          }
          break;
        }
        default: break;
      }
    });
  }

  /* ==========================================================================
     生成历史
     --------------------------------------------------------------------------
     图片本身在中转站云端（返回的 url 就是），这里只存索引：
     提示词 / 模型 / 参数 / 时间 / 图片地址。所以画布上把卡片删了，
     历史里照样找得到，而且不占本地空间。
     ========================================================================== */
  function histEls() {
    return {
      sheet: document.getElementById('historySheet'),
      body: document.getElementById('historyBody'),
      count: document.getElementById('historyCount'),
      input: document.getElementById('historyInput'),
      badge: document.getElementById('historyBadge')
    };
  }

  function refreshHistoryBadge() {
    var e = histEls();
    if (!e.badge) return;
    var n = FC.history ? FC.history.count() : 0;
    e.badge.hidden = !n;
    if (n) e.badge.textContent = n > 99 ? '99+' : String(n);
  }

  function openHistory() {
    closeCreateMenu();
    closeAtPick();
    var e = histEls();
    if (!e.sheet) return;
    openSheet(e.sheet);
    if (e.count) e.count.textContent = '读取中…';
    if (e.body) e.body.innerHTML = '<div class="hsheet__empty">读取中…</div>';
    FC.history.load(true).then(function (recs) {
      renderHistory(recs);
      refreshHistoryBadge();
    });
  }

  function fmtTime(ts) {
    var d = new Date(ts || Date.now());
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    var hm = p(d.getHours()) + ':' + p(d.getMinutes());
    return sameDay ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function renderHistory(recs) {
    var e = histEls();
    if (!e.body) return;
    recs = recs || [];

    if (e.count) e.count.textContent = recs.length ? (recs.length + ' 条') : '';

    if (!recs.length) {
      e.body.innerHTML = '<div class="hsheet__empty">还没有生成记录<br><small>生成一张图之后就会出现在这里</small></div>';
      return;
    }

    e.body.innerHTML = '<div class="hgrid">' + recs.map(function (r) {
      var isVideo = r.kind === 'video';
      var media = isVideo
        ? '<video src="' + esc(r.url) + '" muted playsinline preload="metadata"></video>'
        : '<img src="' + esc(r.url) + '" alt="" loading="lazy" draggable="false">';
      var refTxt = (r.refs && r.refs.length)
        ? '<span class="hcard__refs">@' + r.refs.map(function (x) { return esc(x.handle); }).join(' @') + '</span>'
        : '';
      return '<article class="hcard" data-id="' + esc(r.id) + '">' +
        '<div class="hcard__media">' + media +
          (isVideo ? '<span class="hcard__play"><svg class="ico"><use href="#i-play"/></svg></span>' : '') +
          '<button class="hcard__dl" data-hact="download" type="button" title="下载到本地">' +
            '<svg class="ico"><use href="#i-download"/></svg></button>' +
        '</div>' +
        '<div class="hcard__meta">' +
          '<div class="hcard__top"><span class="hcard__model">' + esc(r.model || '') + '</span>' +
            '<span class="hcard__time">' + fmtTime(r.at) + '</span></div>' +
          '<p class="hcard__prompt">' + esc(r.prompt || '(无提示词)') + '</p>' +
          '<div class="hcard__params">' + esc(String(r.ratio || '')) +
            (r.resolution ? ' · ' + esc(r.resolution) : '') +
            (r.duration ? ' · ' + esc(String(r.duration)) : '') + '</div>' +
          refTxt +
        '</div>' +
        '<div class="hcard__acts">' +
          '<button class="hcard__act" data-hact="place" type="button">放回画布</button>' +
          '<button class="hcard__act" data-hact="prompt" type="button">复制提示词</button>' +
          '<button class="hcard__act" data-hact="reuse" type="button">用这套参数生成</button>' +
          '<button class="hcard__act hcard__act--danger" data-hact="del" type="button">删除记录</button>' +
        '</div>' +
      '</article>';
    }).join(' ') + '</div>';

    // 历史里的视频也支持悬停预览（和卡片上一致）
    var hvs = e.body.querySelectorAll('.hcard__media video');
    for (var hi = 0; hi < hvs.length; hi++) {
      (function (v) {
        v.addEventListener('mouseenter', function () {
          var pr = v.play();
          if (pr && pr['catch']) pr['catch'](function () { /* ignore */ });
        });
        v.addEventListener('mouseleave', function () {
          v.pause();
          try { v.currentTime = 0; } catch (err) { /* ignore */ }
        });
      })(hvs[hi]);
    }
  }

  /** 把历史里的图放回画布（变成一个素材卡，走的是云端地址） */
  function historyPlace(rec) {
    if (!rec || !rec.url) return;
    var p = R.viewCenterWorld();
    var item = Store.createItem('asset', 0, 0, {
      name: (rec.prompt || '生成图').slice(0, 12) || '生成图',
      naturalW: rec.w || 1024,
      naturalH: rec.h || 1024,
      w: 260,
      remoteUrl: rec.url            // 直接指向云端，不下载到本地
    });
    var spot = R.findFreeSpot(item.w, item.w, p);
    item.x = spot.x;
    item.y = spot.y;
    Store.addItems([item]);
    R.requestItems();
    toast('已放回画布（图片来自云端）', 'i-check');
  }

  /** 按这条记录的参数，新建一张卡并填好 */
  function historyReuse(rec) {
    if (!rec) return;
    var kind = rec.kind === 'video' ? 'video-gen' : 'image-gen';
    var spot = R.findFreeSpot(320, 460, R.viewCenterWorld());
    var item = Store.addItem(kind, spot.x, spot.y);
    var patch = { prompt: rec.prompt || '' };
    var def = Store.kindDef(kind);
    if (rec.model && def.models.indexOf(rec.model) >= 0) patch.model = rec.model;
    if (rec.ratio && def.ratios.indexOf(rec.ratio) >= 0) patch.ratio = rec.ratio;
    if (rec.style && def.styles.indexOf(rec.style) >= 0) patch.style = rec.style;
    if (def.durations && rec.duration && def.durations.indexOf(rec.duration) >= 0) patch.duration = rec.duration;
    if (def.resolutions && rec.resolution && def.resolutions.indexOf(rec.resolution) >= 0) patch.resolution = rec.resolution;
    Store.update(item.id, patch);
    R.requestItems();
    R.centerOn(spot.x + 160, spot.y + 230);
    closeSheets();
    toast('已按这条记录建好卡片，改完点生成', 'i-sparkle');
  }

  function wireHistory() {
    var e = histEls();
    if (e.sheet) {
      e.sheet.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-hact]');
        if (!btn) return;
        var card = btn.closest('.hcard');
        if (!card) return;
        var id = card.dataset.id;
        var act = btn.dataset.hact;
        FC.history.load().then(function (recs) {
          var rec = recs.filter(function (x) { return x.id === id; })[0];
          if (!rec) return;
          if (act === 'download') downloadImage(rec.url, rec.prompt || 'AI生成');
          else if (act === 'place') historyPlace(rec);
          else if (act === 'reuse') historyReuse(rec);
          else if (act === 'prompt') {
            var txt = rec.prompt || '';
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(txt).then(function () { toast('提示词已复制', 'i-copy'); });
            } else { toast('提示词：' + txt, 'i-doc'); }
          } else if (act === 'del') {
            FC.history.remove([id]).then(function () {
              toast('已删除这条记录', 'i-trash');
              return FC.history.load(true);
            }).then(function (list) { renderHistory(list); refreshHistoryBadge(); });
          }
        });
      });
    }

    var c = document.getElementById('historyClose');
    if (c) c.addEventListener('click', closeSheets);

    // 导出 / 导入 / 清空
    var ex = document.getElementById('historyExport');
    if (ex) ex.addEventListener('click', function () {
      FC.history.load(true).then(function () {
        var data = JSON.stringify(FC.history.exportJSON(), null, 2);
        var blob = new Blob([data], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ai-canvas-history-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
        toast('历史已导出', 'i-download');
      });
    });

    var ib = document.getElementById('historyImportBtn');
    if (ib && e.input) ib.addEventListener('click', function () { e.input.click(); });
    if (e.input) e.input.addEventListener('change', function () {
      var f = e.input.files && e.input.files[0];
      e.input.value = '';
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var data = null;
        try { data = JSON.parse(String(fr.result)); } catch (err) { toast('文件解析失败', 'i-close'); return; }
        FC.history.importJSON(data).then(function (n) {
          toast(n ? ('已导入 ' + n + ' 条记录') : '没有新记录', n ? 'i-check' : 'i-close');
          return FC.history.load(true);
        }).then(function (list) { renderHistory(list); refreshHistoryBadge(); });
      };
      fr.readAsText(f);
    });

    var cl = document.getElementById('historyClear');
    if (cl) cl.addEventListener('click', async function () {
      var ok = await confirmDialog({
        title: '清空生成历史',
        text: '只删除历史记录，云端图片和画布内容都不受影响。',
        confirmLabel: '清空', danger: true
      });
      if (!ok) return;
      FC.history.clear().then(function () {
        toast('历史已清空', 'i-trash');
        return FC.history.load(true);
      }).then(function (list) { renderHistory(list); refreshHistoryBadge(); });
    });

    var tb = document.getElementById('toolHistory');
    if (tb) tb.addEventListener('click', openHistory);

    FC.history.open().then(function () { return FC.history.load(); }).then(refreshHistoryBadge);
  }

  function openMenu() { closeSheets(); closeCreateMenu(); openSheet(D.menuSheet); }

  /* ==========================================================================
     卡片右键菜单
     ========================================================================== */
  /* ==========================================================================
     下载图片到本地
     --------------------------------------------------------------------------
     图片可能来自三个地方：
       - 中转站云端（https://file5...，CORS 开放，能直接 fetch）
       - 本地 IndexedDB 的 blob: URL
       - 演示模式生成的 data: URL
     三种都能 fetch 成 Blob 再触发下载。真拿不到就退回「新标签页打开」。
     ========================================================================== */
  function imageFileName(base, blob) {
    // 从 MIME 推扩展名。不能只认 image/* —— 视频的 blob.type 是 video/mp4，
    // 只匹配 image/ 会兜底成 .png，下载下来的视频就成了假 png。
    var ext = 'png';
    var type = String((blob && blob.type) || '').toLowerCase();
    var m = /^(image|video|audio)\/([a-z0-9.+-]+)/.exec(type);
    if (m) {
      var sub = m[2];
      var map = {
        jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif',
        bmp: 'bmp', svg: 'svg', avif: 'avif', heic: 'heic',
        mp4: 'mp4', m4v: 'mp4', quicktime: 'mov', webm: 'webm', 'x-matroska': 'mkv',
        mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', ogg: 'ogg', aac: 'aac'
      };
      ext = map[sub] || sub.replace(/^x-/, '');
    } else if (type) {
      var tail = type.split('/').pop().split(';')[0].trim();
      if (/^[a-z0-9]{2,5}$/.test(tail)) ext = tail;
    }
    var name = String(base || 'AI生成')
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 30) || 'AI生成';
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    return name + '_' + stamp + '.' + ext;
  }

  /* ==========================================================================
     全屏查看器
     --------------------------------------------------------------------------
     双击卡片里的图/视频 → 铺满整个屏幕看。
     Esc、点空白、点右上角 ✕ 都能关。
     ========================================================================== */
  var viewerState = { src: '', name: '', isVideo: false };

  function viewerEls() {
    return {
      wrap: document.getElementById('viewer'),
      stage: document.getElementById('viewerStage'),
      title: document.getElementById('viewerTitle'),
      close: document.getElementById('viewerClose'),
      dl: document.getElementById('viewerDownload')
    };
  }

  function openViewer(src, name, isVideo) {
    if (!src) { toast('这张图还没有内容', 'i-close'); return; }
    var e = viewerEls();
    if (!e.wrap) return;

    // 视频用 <video controls autoplay loop>，图用 <img>
    // 判定优先用传进来的 isVideo；没传就看扩展名兜底
    var vid = (isVideo === undefined || isVideo === null)
      ? /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(src))
      : !!isVideo;

    viewerState = { src: src, name: name || '', isVideo: vid };

    e.stage.innerHTML = vid
      ? '<video src="' + esc(src) + '" controls autoplay loop playsinline></video>'
      : '<img src="' + esc(src) + '" alt="">';
    if (e.title) e.title.textContent = name || (vid ? '视频' : '图片');

    e.wrap.hidden = false;
    requestAnimationFrame(function () { e.wrap.classList.add('is-in'); });

    var v = e.stage.querySelector('video');
    if (v) {
      var p = v.play();
      if (p && p['catch']) p['catch'](function () { /* 需要用户点一下才能播，忽略 */ });
    }
  }

  function closeViewer() {
    var e = viewerEls();
    if (!e.wrap || e.wrap.hidden) return;
    e.wrap.classList.remove('is-in');
    // 立刻停掉视频，别让它在后台继续响
    var v = e.stage.querySelector('video');
    if (v) { try { v.pause(); } catch (err) { /* ignore */ } }
    setTimeout(function () {
      e.wrap.hidden = true;
      e.stage.innerHTML = '';
    }, 200);
  }

  function viewerOpen() {
    var e = viewerEls();
    return !!e.wrap && !e.wrap.hidden;
  }

  function wireViewer() {
    var e = viewerEls();
    if (!e.wrap) return;
    if (e.close) e.close.addEventListener('click', closeViewer);
    if (e.dl) e.dl.addEventListener('click', function () {
      if (viewerState.src) downloadImage(viewerState.src, viewerState.name);
    });
    // 点空白处关闭（点媒体本身不关，否则想放大看反而被关掉）
    e.wrap.addEventListener('click', function (ev) {
      if (ev.target === e.wrap || ev.target === e.stage) closeViewer();
    });
    // Esc 关闭
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && viewerOpen()) {
        ev.stopPropagation();
        closeViewer();
      }
    }, true);
  }

  /* ==========================================================================
     自动转存：生成结果从中转站搬到你自己的 OSS
     --------------------------------------------------------------------------
     为什么必须做这件事：
       中转站的图床是临时的。实测生成后约 4 小时，同一个地址就从
       HTTP 200（2.3MB）变成 HTTP 404 —— 画布上的图集体失效。
       而它的文档里根本没提文件保留多久，属于未文档化行为。

     怎么做的：
       生成成功后卡片立刻用中转站地址显示（你马上能看到结果），
       然后后台把文件搬到你的 OSS，搬完了把卡片地址换成 OSS 的。
       OSS 上的是永久的，以后打开画布不会再坏。

     注意走的是 {url: ...} 模式 —— 让后端直接去抓中转站的文件再传 OSS，
     文件不经过浏览器（大视频走 base64 会非常慢，还可能超限）。
     ========================================================================== */

  /** 这个地址是不是已经在你自己的 OSS 上了 */
  function isOssUrl(src) {
    var s = String(src || '');
    // 阿里云 OSS 的默认域名长这样：bucket.oss-cn-xxx.aliyuncs.com
    if (/\.aliyuncs\.com\//i.test(s)) return true;
    // 如果配了自定义域名，也算
    var custom = (FC.api && FC.api.config && FC.api.config.OSS_CUSTOM_DOMAIN) || '';
    if (custom && s.indexOf(custom) === 0) return true;
    return false;
  }

  /**
   * 把一张生成结果转存到自己的 OSS。
   * @returns {Promise<string|null>} 成功返回 OSS 地址，失败/不需要返回 null
   */
  async function archiveToCloud(src, name) {
    var endpoint = (FC.api && FC.api.uploadUrl) ? FC.api.uploadUrl() : '';
    if (!endpoint || !src) return null;
    // 已经在自己 OSS 上了就别重复传
    if (isOssUrl(src)) return null;
    // blob: / data: 是本地的，没什么可"转存"的
    if (/^(blob:|data:)/i.test(src)) return null;

    try {
      var r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: src, name: name || '生成结果' })
      });
      var out = null;
      try { out = await r.json(); } catch (e) { out = null; }
      if (!r.ok || !out || !out.ok) {
        throw new Error((out && out.error) || ('HTTP ' + r.status));
      }
      return out.url || null;
    } catch (e) {
      console.warn('[archive] 转存失败，结果仍留在中转站（会过期）', e);
      return null;
    }
  }

  /** src 可以是 https: / blob: / data: —— 都会走 fetch 拿成 Blob 再下载 */
  async function downloadImage(src, baseName) {
    if (!src) { toast('这张图还没有内容', 'i-close'); return false; }
    toast('正在准备下载…', 'i-download');
    try {
      var res = await fetch(src);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var blob = await res.blob();
      if (!blob || !blob.size) throw new Error('空文件');

      var a = document.createElement('a');
      var url = URL.createObjectURL(blob);
      a.href = url;
      a.download = imageFileName(baseName, blob);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      toast('已开始下载' + (blob.size ? '（' + Math.round(blob.size / 1024) + ' KB）' : ''), 'i-check');
      return true;
    } catch (e) {
      // 跨域被挡 / 网络问题 —— 退回新标签页，让用户右键另存
      console.warn('[ui] 直接下载失败，改用新标签页', e);
      try { window.open(src, '_blank'); } catch (e2) { /* ignore */ }
      toast('没法直接下载，已在新标签页打开图片，右键另存即可', 'i-close');
      return false;
    }
  }

  /* ==========================================================================
     上传到云端，换回一个公网 URL
     --------------------------------------------------------------------------
     有些 AI 接口（比如速创 Wan3.0 视频）只收公网 URL，不收 base64。
     这个函数把本地图片交给 upload_server.py，它传到阿里云 OSS，返回公网地址。

     前提：本机跑着 upload_server.py，且 config.local.js 里 UPLOAD_URL 指向它。
     ========================================================================== */
  async function uploadToCloud(src, name, item) {
    var endpoint = (FC.api && FC.api.uploadUrl) ? FC.api.uploadUrl() : '';
    if (!endpoint) {
      toast('没配后端地址：请在 config.local.js 里填 BACKEND_URL', 'i-close');
      return null;
    }

    try {
      toast('正在上传…', 'i-cloud');

      // 1) 拿 Blob。优先直接从 IndexedDB 取 —— urlOf() 只读内存缓存，
      //    万一还没 attach 上，src 会是空的，所以这里必须有兜底。
      var blob = null;
      if (item && item.kind === 'asset' && FC.assets) {
        blob = FC.assets.blobOf(item.id) || null;
        if (!blob && FC.assets.get) {
          try { blob = await FC.assets.get(item.id); } catch (e) { blob = null; }
        }
      }
      if (!blob) {
        if (!src) { toast('这张图还没有内容（本地图还没读出来）', 'i-close'); return null; }
        var res = await fetch(src);
        if (!res.ok) throw new Error('读取图片失败 HTTP ' + res.status);
        blob = await res.blob();
      }
      if (!blob || !blob.size) throw new Error('图片是空的');
      var dataURL = await FC.assets.blobToDataURL(blob);

      // 2) 交给本地上传服务
      var up = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: dataURL, name: name || 'AI生成' })
      });
      var out = null;
      try { out = await up.json(); } catch (e) { out = null; }

      if (!up.ok || !out || !out.ok) {
        var msg = (out && out.error) || ('HTTP ' + up.status);
        throw new Error(msg);
      }

      // 3) 复制到剪贴板（localStorage 同源的 localhost 属于安全上下文，能复制）
      var copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(out.url);
          copied = true;
        }
      } catch (e) { copied = false; }

      toast('已上传' + (copied ? '，URL 已复制' : '：' + out.url), 'i-check');
      console.log('[upload] 公网地址：' + out.url);
      return out.url;
    } catch (e) {
      var m = String(e && e.message || e);
      if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
        m = '连不上上传服务。确认 upload_server.py 在跑（start.bat 会一起拉起），' +
            '并且 config.local.js 里 UPLOAD_URL 是对的。';
      } else if (/OSS 还没配置/.test(m)) {
        m = '后端还没配 OSS。复制 config.oss.example.py 成 config.oss.local.py 并填写。';
      }
      toast('上传失败：' + m, 'i-close');
      console.warn('[upload] 失败', e);
      return null;
    }
  }

  /** 取某张卡可下载的图：生成结果优先，其次素材图 */
  function cardImageSrc(item) {
    if (!item) return '';
    if (item.kind === 'asset') {
      return (FC.assets && FC.assets.urlOf(item.id)) || item.src || item.remoteUrl || '';
    }
    var res = item.result;
    if (!res) return '';
    if (res.src) return res.src;
    if (res.seed !== undefined) {
      return item.kind === 'video-gen' ? FC.art.frameURL(res.seed, res.w, res.h)
        : FC.art.dataURL(res.seed, res.w, res.h);
    }
    return '';
  }

  function openCardMenu(id, clientX, clientY) {
    var item = Store.get(id);
    if (!item) return;
    var isGen = item.kind !== 'asset';

    var actions = [
      { act: 'duplicate', icon: 'i-copy', label: '复制卡片' },
      { act: 'front', icon: 'i-layers', label: '移到最前' }
    ];
    if (isGen) actions.push({ act: 'regen', icon: 'i-refresh', label: item.result ? '重新生成' : '开始生成' });

    // 有图可下载时才显示（生成卡要出过结果，素材卡要有图）
    if (cardImageSrc(item)) {
      actions.push({
        act: 'download',
        icon: 'i-download',
        label: (isGen && item.kind === 'video-gen') ? '下载视频' : '下载图片'
      });
      // 上传到 OSS 换公网 URL —— 给只收 URL 的接口用（如速创 Wan3.0）
      actions.push({ act: 'upload', icon: 'i-cloud', label: '上传到云端' });
    }
    // 素材卡可以改名 —— @ 的短名跟着名字走
    if (!isGen) actions.push({ act: 'rename', icon: 'i-doc', label: '重命名' });
    actions.push({ act: 'delete', icon: 'i-trash', label: '删除', danger: true });

    var r = D.board.getBoundingClientRect();
    var px = clientX - r.left, py = clientY - r.top;

    D.ctxMenu.innerHTML = '<div class="ctxmenu__title">' + esc(Store.kindDef(item.kind).label) + '</div>' +
      actions.map(function (a) {
        return '<button class="ctxmenu__item" type="button" data-cmd="' + a.act + '">' +
          '<span class="ctxmenu__glyph"><svg class="ico"><use href="#' + a.icon + '"/></svg></span>' +
          '<span class="ctxmenu__text"><span class="ctxmenu__name"' +
          (a.danger ? ' style="color:var(--label)"' : '') + '>' + esc(a.label) + '</span></span>' +
          '</button>';
      }).join('');
    D.ctxMenu.hidden = false;

    var mw = D.ctxMenu.offsetWidth, mh = D.ctxMenu.offsetHeight;
    var left = FC.util.clamp(px, 10, Math.max(10, r.width - mw - 10));
    var top = FC.util.clamp(py, 10, Math.max(10, r.height - mh - 10));
    D.ctxMenu.style.left = left + 'px';
    D.ctxMenu.style.top = top + 'px';
    D.ctxMenu.style.setProperty('--ox', (px - left) + 'px');
    D.ctxMenu.style.setProperty('--oy', (py - top) + 'px');

    // 一次性命令处理
    var handler = function (ev) {
      var b = ev.target.closest('[data-cmd]');
      if (!b) return;
      var cmd = b.dataset.cmd;
      closeCreateMenu();
      D.ctxMenu.removeEventListener('click', handler, true);
      if (cmd === 'duplicate') { Store.duplicate([id]); toast('已复制', 'i-copy'); }
      else if (cmd === 'front') { Store.bringToFront([id]); toast('已移到最前', 'i-layers'); }
      else if (cmd === 'delete') { Store.remove([id]); toast('已删除', 'i-trash'); }
      else if (cmd === 'regen') { FC.generate.start(id); }
      else if (cmd === 'rename') { renameAsset(id); }
      else if (cmd === 'upload') {
        var iu = Store.get(id);
        uploadToCloud(cardImageSrc(iu), (iu && iu.prompt) ? iu.prompt : (iu && iu.name) ? iu.name : 'AI生成', iu);
      }
      else if (cmd === 'download') {
        var it = Store.get(id);
        downloadImage(cardImageSrc(it), (it && it.prompt) ? it.prompt : (it && it.name) ? it.name : 'AI生成');
      }
    };
    D.ctxMenu.addEventListener('click', handler, true);
  }

  /* ==========================================================================
     对话框
     ========================================================================== */
  var dialogResolve = null;

  function wireDialog() {
    D.dialogWrap.addEventListener('click', function (e) {
      if (e.target === D.dialogWrap) closeDialog(null);
    });
    D.dialogInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var primary = D.dialogActions.querySelector('.dialog__btn--primary');
        if (primary) primary.click();
      }
    });
  }

  function openDialog(opts) {
    return new Promise(function (resolve) {
      dialogResolve = resolve;
      D.dialogTitle.textContent = opts.title || '';
      D.dialogText.textContent = opts.text || '';
      if (opts.input) {
        D.dialogInput.hidden = false;
        D.dialogInput.value = opts.inputValue || '';
        D.dialogInput.placeholder = opts.inputPlaceholder || '';
      } else {
        D.dialogInput.hidden = true;
      }
      var actions = opts.actions || [
        { label: '取消', value: null },
        { label: '好', value: true, primary: true }
      ];
      D.dialogActions.innerHTML = actions.map(function (a, i) {
        return '<button class="dialog__btn' + (a.primary ? ' dialog__btn--primary' : '') +
          (a.danger ? ' dialog__btn--danger' : '') + '" type="button" data-i="' + i + '">' + esc(a.label) + '</button>';
      }).join('');
      D.dialogActions.querySelectorAll('.dialog__btn').forEach(function (btn, i) {
        btn.addEventListener('click', function () {
          var a = actions[i];
          closeDialog(a.value === undefined ? true : a.value);
        });
      });
      D.dialogWrap.hidden = false;
      requestAnimationFrame(function () { D.dialogWrap.classList.add('is-in'); });
      if (opts.input) setTimeout(function () { D.dialogInput.focus(); D.dialogInput.select(); }, 200);
    });
  }

  function closeDialog(value) {
    D.dialogWrap.classList.remove('is-in');
    setTimeout(function () { D.dialogWrap.hidden = true; }, 240);
    var resolve = dialogResolve;
    dialogResolve = null;
    if (resolve) resolve(value);
  }

  function confirmDialog(opts) {
    return openDialog({
      title: opts.title, text: opts.text,
      actions: [
        { label: opts.cancelLabel || '取消', value: false },
        { label: opts.confirmLabel || '确定', value: true, primary: true, danger: opts.danger }
      ]
    });
  }

  function promptDialog(opts) {
    return openDialog({
      title: opts.title, text: opts.text, input: true,
      inputValue: opts.value || '', inputPlaceholder: opts.placeholder || '',
      actions: [
        { label: '取消', value: null },
        { label: opts.confirmLabel || '完成', value: '__INPUT__', primary: true }
      ]
    }).then(function (res) {
      return res === '__INPUT__' ? D.dialogInput.value : null;
    });
  }

  /* ==========================================================================
     命名 / 导出
     ========================================================================== */
  async function renameDoc() {
    var name = await promptDialog({
      title: '重命名画布',
      value: Store.doc.name,
      placeholder: '输入画布名称',
      confirmLabel: '完成'
    });
    if (name === null) return;
    name = String(name).trim();
    if (!name) return;
    Store.doc.name = name;
    Store.commit();
    toast('已重命名', 'i-doc');
  }

  /** 给素材卡改名：@ 短名会跟着变，提示词里的 @旧名 也会自动更新 */
  async function renameAsset(id) {
    var item = Store.get(id);
    if (!item || item.kind !== 'asset') return;

    var name = await promptDialog({
      title: '重命名图片',
      value: item.name || '',
      placeholder: '给这张图起个名字',
      confirmLabel: '完成'
    });
    if (name === null) return;
    if (!Store.renameAsset(id, name)) return;

    R.requestItems();
    // 告诉用户现在的 @ 名字是什么，方便直接写进提示词
    var host = Store.doc.items.filter(function (i) {
      return i.kind !== 'asset' && Store.doc.links.some(function (l) {
        return l.from === id && l.to === i.id;
      });
    })[0];
    var handle = '';
    if (host) {
      var mine = Store.refsOf(host.id).filter(function (r) { return r.assetId === id; })[0];
      if (mine) handle = mine.handle;
    }
    toast(handle ? ('已改名，提示词里用 @' + handle) : '已改名', 'i-check');
  }

  async function exportJSON() {
    // 图片不在文档里（在 IndexedDB），导出时嵌回去，否则导出的 JSON 会丢图
    var doc = Store.toJSON();
    var assets = doc.items.filter(function (i) { return i.kind === 'asset'; });
    if (assets.length && FC.assets) {
      toast('正在打包 ' + assets.length + ' 张图片…', 'i-download');
      for (var i = 0; i < assets.length; i++) {
        var blob = FC.assets.blobOf(assets[i].id);
        if (blob) {
          var d = await FC.assets.blobToDataURL(blob);
          if (d) assets[i].src = d;
        }
      }
    }
    var data = JSON.stringify(doc, null, 2);
    var blob = new Blob([data], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var safe = (Store.doc.name || 'canvas').replace(/[\\/:*?"<>|]/g, '_');
    a.href = url;
    a.download = safe + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast('已导出 JSON', 'i-download');
  }

  /* ========================================================================== */
  FC.ui = {
    init: init,
    toast: toast,
    applyTheme: applyTheme,
    toggleTheme: toggleTheme,
    openCreateMenu: openCreateMenu,
    openCreateMenuAtCenter: openCreateMenuAtCenter,
    closeCreateMenu: closeCreateMenu,
    openMenu: openMenu,
    openCardMenu: openCardMenu,
    closeAll: closeAll,
    dismissTransient: dismissTransient,
    closeAtPick: closeAtPick,
    openAtPick: openAtPick,
    renameAsset: renameAsset,
    openHistory: openHistory,
    refreshHistoryBadge: refreshHistoryBadge,
    downloadImage: downloadImage,
    uploadToCloud: uploadToCloud,
    archiveToCloud: archiveToCloud,
    isOssUrl: isOssUrl,
    openViewer: openViewer,
    closeViewer: closeViewer,
    importFiles: importFiles,
    confirmDialog: confirmDialog,
    promptDialog: promptDialog,
    setSaveState: setSaveState
  };
})(window.FC);