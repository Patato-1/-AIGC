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
  var MAX_EDGE = 1600;         // 拖入图片的最长边（控制 localStorage 体积）

  /* ==========================================================================
     初始化
     ========================================================================== */
  function init() {
    D.board = document.getElementById('board');
    D.scrim = document.getElementById('scrim');
    D.menuSheet = document.getElementById('menuSheet');
    D.menuBody = document.getElementById('menuBody');
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
  function openCreateMenu(clientX, clientY, worldPointArg) {
    createPoint = worldPointArg || R.viewCenterWorld();

    var r = D.board.getBoundingClientRect();
    var px = clientX - r.left;
    var py = clientY - r.top;

    D.ctxMenu.innerHTML =
      '<div class="ctxmenu__title">创建</div>' +
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
    closeCreateMenu();
    R.invalidate({ items: true, grid: true });
    R.centerOn(spot.x + w / 2, spot.y + (w * 0.5) / 2);
    toast('已创建「' + def.label + '」', def.icon);
    createPoint = null;
    return item;
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
      } else if (act === 'play') {
        var stage = cardEl.querySelector('[data-stage]');
        if (!stage) return;
        var playing = stage.classList.toggle('is-playing');
        var v = stage.querySelector('video');
        if (v) { try { playing ? v.play() : v.pause(); } catch (err) { /* ignore */ } }
      }
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
      var patch = {};
      patch[k] = el.value;
      Store.update(cardEl.dataset.id, patch);
      // 比例变了，卡片高度会自动跟着变，重新测量
      R.requestItems();
    });

    // 提示词框自适应高度
    layer.addEventListener('focusin', function (e) {
      if (e.target.dataset && e.target.dataset.k === 'prompt') autoGrow(e.target);
    });
    layer.addEventListener('input', function (e) {
      if (e.target.dataset && e.target.dataset.k === 'prompt') autoGrow(e.target);
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

  /** 等比缩小并编码，控制体积（localStorage 容量有限） */
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

    var src = '';
    try { src = c.toDataURL('image/webp', 0.86); } catch (e) { src = ''; }
    if (!src || src.indexOf('data:image/webp') !== 0) {
      try { src = c.toDataURL('image/jpeg', 0.86); } catch (e) { src = ''; }
    }
    return { src: src, w: nw, h: nh };
  }

  async function importFiles(files, opts) {
    opts = opts || {};
    var images = files.filter(function (f) { return /^image\//.test(f.type); });
    if (!images.length) { toast('只支持图片文件', 'i-close'); return; }

    toast('正在读取 ' + images.length + ' 张图片…', 'i-image');
    var loaded = [];
    for (var i = 0; i < images.length; i++) {
      try {
        var img = await loadImage(images[i]);
        var enc = encode(img, MAX_EDGE);
        if (!enc.src) continue;
        loaded.push({
          file: images[i],
          src: enc.src,
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
        src: first.src,
        name: cleanName(first.file.name),
        naturalW: first.nw,
        naturalH: first.nh,
        w: assetWidth(first.nw)
      });
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
        src: L.src,
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

    Store.addItems(items);
    R.requestItems();
    toast('已放入 ' + items.length + ' 张图片', 'i-check');
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
    closeCreateMenu();
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

  function openMenu() { closeSheets(); closeCreateMenu(); openSheet(D.menuSheet); }

  /* ==========================================================================
     卡片右键菜单
     ========================================================================== */
  function openCardMenu(id, clientX, clientY) {
    var item = Store.get(id);
    if (!item) return;
    var isGen = item.kind !== 'asset';

    var actions = [
      { act: 'duplicate', icon: 'i-copy', label: '复制卡片' },
      { act: 'front', icon: 'i-layers', label: '移到最前' }
    ];
    if (isGen) actions.push({ act: 'regen', icon: 'i-refresh', label: item.result ? '重新生成' : '开始生成' });
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

  function exportJSON() {
    var data = JSON.stringify(Store.toJSON(), null, 2);
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
    importFiles: importFiles,
    confirmDialog: confirmDialog,
    promptDialog: promptDialog,
    setSaveState: setSaveState
  };
})(window.FC);