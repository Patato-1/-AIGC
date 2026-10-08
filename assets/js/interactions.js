/* ==========================================================================
   interactions.js — 指针交互
   平移 / 缩放 / 拖卡片 / 宽度缩放 / 框选 / 拖入图片 / 粘贴 / 快捷键
   ========================================================================== */
(function (FC) {
  'use strict';

  var Store = FC.Store;
  var R = FC.render;

  var S = {};
  var pointers = new Map();
  var gesture = null;
  var spaceDown = false;
  var lastPointer = { x: 0, y: 0 };
  var pointerSeen = false;      // 鼠标是否真的在画布上移动过（决定粘贴落点）
  var pasteAnchorLast = null;   // 上一次粘贴的落点
  var pasteRepeat = 0;          // 在同一个落点连续粘贴了几次
  var dragDepth = 0;
  var internalDrag = false;   // 画布内部拖拽中（移动卡片），不当作导入
  var cardClipboard = null;    // 内部剪贴板：{ items, links }
  var PASTE_OFFSET = 34;       // 粘贴时的错位量

  var DRAG_THRESHOLD = 3;
  var MIN_W = 160;
  var MAX_W = 720;

  function init() {
    S.board = document.getElementById('board');
    S.items = document.getElementById('itemsLayer');
    S.marquee = document.getElementById('marquee');
    S.dropCue = document.getElementById('dropCue');
    S.dropCueText = document.getElementById('dropCueText');
    S.ctxMenu = document.getElementById('ctxMenu');

    S.board.addEventListener('pointerdown', onPointerDown);
    S.board.addEventListener('wheel', onWheel, { passive: false });
    S.board.addEventListener('dblclick', onDoubleClick);
    S.board.addEventListener('contextmenu', onContextMenu);

    // 拖入图片
    S.board.addEventListener('dragstart', onDragStart);
    S.board.addEventListener('dragenter', onDragEnter);
    S.board.addEventListener('dragover', onDragOver);
    S.board.addEventListener('dragleave', onDragLeave);
    S.board.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onDragEnd);

    // 粘贴图片
    window.addEventListener('paste', onPaste);

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', function () { spaceDown = false; updateCursor(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && gesture) endGesture();
    });

    updateCursor();
  }

  /* ---------- 坐标 ---------- */
  function boardRect() { return S.board.getBoundingClientRect(); }
  function localPoint(e) {
    var r = boardRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function worldPoint(e) {
    var p = localPoint(e);
    return FC.geo.toWorld(p.x, p.y, Store.view);
  }

  function updateCursor() {
    S.board.classList.toggle('is-pan-ready', Store.ui.tool === 'pan' || spaceDown);
  }

  /* ==========================================================================
     Pointer down
     ========================================================================== */
  function onPointerDown(e) {
    if (e.button === 2) return;
    if (e.target.closest && e.target.closest('.ctxmenu')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      if (gesture && gesture.type === 'item' && gesture.moved) Store.commit();
      if (gesture && gesture.type === 'marquee' && S.marquee) S.marquee.hidden = true;
      startPinch();
      e.preventDefault();
      return;
    }
    if (pointers.size > 2 || gesture) return;

    FC.ui.dismissTransient(e);

    var t = e.target;

    // 端口：开始拉连线（优先级最高，端口在卡片内所以要先判）
    var portEl = t.closest ? t.closest('.port') : null;
    if (portEl) { startLinkDrag(e, portEl); return; }

    // 连线本体：选中它
    var linkEl = t.closest ? t.closest('.link') : null;
    if (linkEl) {
      if (t.closest('.link-del')) { Store.removeLinks([linkEl.dataset.id]); toastLink(); return; }
      Store.selectLink(linkEl.dataset.id);
      return;
    }

    var cardEl = t.closest ? t.closest('.card') : null;
    var actEl = t.closest ? t.closest('[data-act]') : null;
    var fieldEl = t.closest ? t.closest('textarea, input, select') : null;

    // 卡片上的按钮 / 表单交给它们自己处理
    if (cardEl && (actEl || fieldEl)) return;

    // 平移优先
    if (Store.ui.tool === 'pan' || spaceDown || e.button === 1) { startPan(e); return; }

    if (cardEl) {
      var grip = t.closest ? t.closest('[data-grip]') : null;
      if (grip) { startResize(e, cardEl); return; }

      var id = cardEl.dataset.id;
      // 整张卡片都能拖：顶栏、预览区、表单空白处都行。按钮和表单控件
      // 已在上面提前 return，所以下拉选项/输入/播放这些细选操作不受影响。

      startItemDrag(e, id);
      return;
    }

    // 空白
    startMarquee(e);   // 空白处拖拽 = 拉框选择；平移改用 空格 / 中键 / 平移工具 / 双指滚动

  }

  /* ---------- 平移 ---------- */
  function startPan(e, clickToDeselect) {
    gesture = {
      type: 'pan',
      startX: e.clientX, startY: e.clientY,
      viewX: Store.view.x, viewY: Store.view.y,
      moved: false,
      clickToDeselect: !!clickToDeselect
    };
    S.board.classList.add('is-panning');
  }

  /* ---------- 框选 ---------- */
  function startMarquee(e) {
    var p = localPoint(e);
    gesture = {
      type: 'marquee',
      origin: p,
      additive: e.metaKey || e.ctrlKey || e.shiftKey,
      base: Store.selection.slice(),
      moved: false
    };
    S.marquee.hidden = false;
    S.marquee.style.left = p.x + 'px';
    S.marquee.style.top = p.y + 'px';
    S.marquee.style.width = '0px';
    S.marquee.style.height = '0px';
  }

  /* ---------- 拖动卡片 ---------- */
  function startItemDrag(e, id) {
    var additive = e.shiftKey || e.metaKey || e.ctrlKey;

    if (additive) {
      Store.toggleSelect(id);
      if (!Store.isSelected(id)) return;
    } else if (!Store.isSelected(id)) {
      Store.selectOnly(id);
    }

    var ids = Store.selection.length ? Store.selection.slice() : [id];
    if (ids.indexOf(id) < 0) ids.push(id);

    var zChanged = Store.bringToFront(ids, { commit: false });

    var starts = ids.map(function (iid) {
      var it = Store.get(iid);
      return { id: iid, x: it ? it.x : 0, y: it ? it.y : 0 };
    });

    gesture = {
      type: 'item',
      ids: ids,
      starts: starts,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      zChanged: zChanged
    };
    S.board.classList.add('is-dragging');
  }

  /* ---------- 宽度缩放 ---------- */
  function startResize(e, cardEl) {
    var id = cardEl.dataset.id;
    var item = Store.get(id);
    if (!item) return;
    Store.selectOnly(id);
    Store.bringToFront([id], { commit: false });

    gesture = {
      type: 'resize',
      id: id,
      startClientX: e.clientX,
      startW: item.w,
      w: item.w,
      moved: false
    };
    S.board.classList.add('is-resizing');
  }

  /* ---------- 双指缩放 ---------- */
  /* ---------- 拉连线 ---------- */
  function startLinkDrag(e, portEl) {
    var fromId = portEl.dataset.node;
    var side = portEl.dataset.port;
    if (!Store.get(fromId)) return;
    gesture = { type: 'link', fromId: fromId, side: side, target: null, moved: false };
    S.board.classList.add('is-linking');
    highlightTargets(fromId);
  }

  /** 把可连接的端口高亮，不可连的压暗 */
  function highlightTargets(fromId) {
    var ports = S.items.querySelectorAll('.port');
    for (var i = 0; i < ports.length; i++) {
      var pd = ports[i];
      if (pd.dataset.node === fromId) continue;
      var ok = Store.canLink(fromId, pd.dataset.node);
      pd.classList.toggle('is-invalid', !ok);
    }
  }

  function clearLinkHighlight() {
    var ports = S.items.querySelectorAll('.port.is-invalid, .port.is-target');
    for (var i = 0; i < ports.length; i++) {
      ports[i].classList.remove('is-invalid', 'is-target');
    }
  }

  function portAt(clientX, clientY, fromId) {
    var best = null, bestD = 34;
    var rect = boardRect();
    var px = clientX - rect.left, py = clientY - rect.top;
    var ports = S.items.querySelectorAll('.port');
    for (var i = 0; i < ports.length; i++) {
      var pd = ports[i];
      var item = Store.get(pd.dataset.node);
      if (!item) continue;
      var w = R.portWorld(item, pd.dataset.port);
      var sp = FC.geo.toScreen(w.x, w.y, Store.view);
      var d = Math.hypot(sp.x - px, sp.y - py);
      if (d < bestD) { bestD = d; best = pd; }
    }
    void fromId;
    return best;
  }

  /** 落点不是端口时，看看是不是落在某张可接收输入的卡片上 */
  function cardAtPoint(clientX, clientY) {
    var el = document.elementFromPoint(clientX, clientY);
    var card = el && el.closest ? el.closest('.card') : null;
    return card ? card.dataset.id : null;
  }

  function toastLink() { FC.ui.toast('已删除连线', 'i-close'); }

  function startPinch() {
    var pts = Array.from(pointers.values());
    var a = pts[0], b = pts[1];
    var r = boardRect();
    var mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    gesture = {
      type: 'pinch',
      startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      startK: Store.view.k,
      world: FC.geo.toWorld(mid.x, mid.y, Store.view)
    };
  }

  /* ==========================================================================
     Pointer move
     ========================================================================== */
  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastPointer = { x: e.clientX, y: e.clientY };
    pointerSeen = true;          // 记下鼠标真的动过了，粘贴时用它当落点
    if (!gesture) return;
    if (e.cancelable) e.preventDefault();

    switch (gesture.type) {
      case 'pan': movePan(e); break;
      case 'marquee': moveMarquee(e); break;
      case 'item': moveItemDrag(e); break;
      case 'resize': moveResize(e); break;
      case 'pinch': movePinch(); break;
      case 'link': moveLinkDrag(e); break;
      default: break;
    }
  }

  function movePan(e) {
    var dx = e.clientX - gesture.startX;
    var dy = e.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    gesture.moved = true;
    Store.setView({ x: gesture.viewX + dx, y: gesture.viewY + dy });
  }

  function moveMarquee(e) {
    var p = localPoint(e);
    gesture.moved = true;
    var x = Math.min(p.x, gesture.origin.x);
    var y = Math.min(p.y, gesture.origin.y);
    var w = Math.abs(p.x - gesture.origin.x);
    var h = Math.abs(p.y - gesture.origin.y);
    S.marquee.style.left = x + 'px';
    S.marquee.style.top = y + 'px';
    S.marquee.style.width = w + 'px';
    S.marquee.style.height = h + 'px';

    var view = Store.view;
    var tl = FC.geo.toWorld(x, y, view);
    var br = FC.geo.toWorld(x + w, y + h, view);
    var rect = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };

    var hits = [];
    Store.doc.items.forEach(function (it) {
      if (FC.geo.rectsIntersect(R.rectOf(it), rect)) hits.push(it.id);
    });
    var ids = gesture.additive
      ? gesture.base.concat(hits.filter(function (id) { return gesture.base.indexOf(id) < 0; }))
      : hits;
    Store.select(ids);
    S.marquee.dataset.count = ids.length ? (ids.length + ' 个') : '';
  }

  function moveItemDrag(e) {
    var dx = e.clientX - gesture.startClientX;
    var dy = e.clientY - gesture.startClientY;
    if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    gesture.moved = true;

    var k = Store.view.k;
    var moves = gesture.starts.map(function (s) {
      return {
        id: s.id,
        x: Math.round(s.x + dx / k),
        y: Math.round(s.y + dy / k)
      };
    });
    Store.moveItems(moves, { commit: false });
    R.syncTransforms(gesture.ids);
    R.requestLinks();
  }

  function moveResize(e) {
    var dx = e.clientX - gesture.startClientX;
    var k = Store.view.k;
    var w = FC.util.clamp(Math.round(gesture.startW + dx / k), MIN_W, MAX_W);
    if (!gesture.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    gesture.moved = true;
    gesture.w = w;

    var item = Store.get(gesture.id);
    if (!item) return;
    item.w = w;
    var el = R.elOf(gesture.id);
    if (el) el.style.width = w + 'px';
  }

  function moveLinkDrag(e) {
    var g = gesture;
    g.moved = true;
    var from = Store.get(g.fromId);
    if (!from) return;

    // 起点：从输出端口拖出，或从输入端口往回拖
    var anchorSide = g.side;
    var w = R.portWorld(from, anchorSide);
    var s1 = FC.geo.toScreen(w.x, w.y, Store.view);

    var rect = boardRect();
    var cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    var pd = portAt(e.clientX, e.clientY, g.fromId);
    var nextTarget = null;
    if (pd && pd.dataset.node !== g.fromId) {
      var ok = g.side === 'out' ? Store.canLink(g.fromId, pd.dataset.node)
                                 : Store.canLink(pd.dataset.node, g.fromId);
      if (ok) nextTarget = pd;
    }
    if (g.target && g.target !== nextTarget) g.target.classList.remove('is-target');
    if (nextTarget) nextTarget.classList.add('is-target');
    g.target = nextTarget;

    var d;
    if (g.side === 'out') d = R.linkPath(s1.x, s1.y, cur.x, cur.y);
    else d = R.linkPath(cur.x, cur.y, s1.x, s1.y);
    R.showLivePath(d);
  }

  function movePinch() {
    if (pointers.size < 2) return;
    var pts = Array.from(pointers.values());
    var a = pts[0], b = pts[1];
    var r = boardRect();
    var mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    var dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    var k = FC.util.clamp(gesture.startK * (dist / gesture.startDist), 0.15, 4);
    Store.setView({ k: k, x: mid.x - gesture.world.x * k, y: mid.y - gesture.world.y * k });
  }

  /* ==========================================================================
     Pointer up
     ========================================================================== */
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.type === 'pinch' && pointers.size >= 2) return;

    var g = gesture;
    endGesture();

    switch (g.type) {
      case 'pan':
        if (!g.moved && g.clickToDeselect) { Store.clearSelection(); Store.selectLink(null); }
        break;
      case 'item':
        if (g.moved || g.zChanged) Store.commit();
        break;
      case 'resize':
        if (g.moved) Store.commit();
        break;
      case 'marquee':
        if (S.marquee) { S.marquee.hidden = true; S.marquee.dataset.count = ''; }
        if (!g.moved) Store.clearSelection();   // 空白处单击 = 取消选择
        break;
      case 'link': {
        var target = g.target;
        if (!target && g.moved) {
          // 落点不是端口时，落在卡片上也算
          var cardId = cardAtPoint(e.clientX, e.clientY);
          if (cardId && cardId !== g.fromId) {
            var ok2 = g.side === 'out' ? Store.canLink(g.fromId, cardId)
                                            : Store.canLink(cardId, g.fromId);
            if (ok2) {
              var fromId2 = g.side === 'out' ? g.fromId : cardId;
              var toId2 = g.side === 'out' ? cardId : g.fromId;
              if (Store.addLink(fromId2, toId2)) FC.ui.toast('已连接', 'i-sparkle');
            } else {
              FC.ui.toast('这两张卡不能这样连', 'i-close');
            }
          }
        } else if (target) {
          var f2 = g.side === 'out' ? g.fromId : target.dataset.node;
          var t2 = g.side === 'out' ? target.dataset.node : g.fromId;
          if (Store.addLink(f2, t2)) FC.ui.toast('已连接', 'i-sparkle');
        }
        break;
      }
      default: break;
    }
  }

  function endGesture() {
    gesture = null;
    S.board.classList.remove('is-panning', 'is-dragging', 'is-resizing', 'is-linking');
    clearLinkHighlight();
    R.hideLivePath();
    if (S.marquee) S.marquee.hidden = true;
    updateCursor();
  }

  /* ==========================================================================
     滚轮
     ========================================================================== */
  function onWheel(e) {
    e.preventDefault();
    var p = localPoint(e);

    if (e.ctrlKey || e.metaKey) {
      zoomAt(p.x, p.y, Store.view.k * Math.exp(-e.deltaY * 0.0032));
      return;
    }
    var dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= 400; dy *= 400; }
    Store.setView({ x: Store.view.x - dx, y: Store.view.y - dy });
  }

  function zoomAt(px, py, k) {
    var k2 = FC.util.clamp(k, 0.15, 4);
    var w = FC.geo.toWorld(px, py, Store.view);
    Store.setView({ k: k2, x: px - w.x * k2, y: py - w.y * k2 });
  }

  function zoomBy(factor) {
    var r = boardRect();
    zoomAt(r.width / 2, r.height / 2, Store.view.k * factor);
  }

  function zoomTo(k) {
    var r = boardRect();
    zoomAt(r.width / 2, r.height / 2, k);
  }

  /* ==========================================================================
     双击 / 右键
     ========================================================================== */
  function onDoubleClick(e) {
    var cardEl = e.target.closest ? e.target.closest('.card') : null;
    if (cardEl) {
      // 双击卡片正文：生图卡聚焦提示词，图片卡无操作
      var ta = cardEl.querySelector('[data-k="prompt"]');
      if (ta) ta.focus();
      return;
    }
    var p = worldPoint(e);
    FC.ui.openCreateMenu(e.clientX, e.clientY, p);
  }

  function onContextMenu(e) {
    var cardEl = e.target.closest ? e.target.closest('.card') : null;
    e.preventDefault();
    if (cardEl) {
      var id = cardEl.dataset.id;
      if (!Store.isSelected(id)) Store.selectOnly(id);
      FC.ui.openCardMenu(id, e.clientX, e.clientY);
      return;
    }
    FC.ui.openCreateMenu(e.clientX, e.clientY, worldPoint(e));
  }

  /* ==========================================================================
     拖入图片
     ========================================================================== */
  /* ---------- 画布内部的拖拽（移动卡片）不该被当成「拖入文件」 ----------
     卡片里的 <img> 默认允许浏览器原生拖拽：按住图片想移动卡片时，操作会变成
     「拖出一张图」，松手后又触发一次导入 —— 表现出来就是「移动图片结果复制了一张」。
     这里在源头掐掉：img 加 draggable="false"（见 render.js），并拦掉 dragstart。 */
  function onDragStart(e) {
    internalDrag = true;
    var t = e.target;
    if (!t || !t.tagName) return;
    var isFormField = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    if (t.tagName === 'IMG' || (t.closest && t.closest('.card') && !isFormField)) {
      e.preventDefault();
    }
  }

  function onDragEnd() {
    internalDrag = false;
    hideDropCue();
  }

  function hasFiles(e) {
    if (internalDrag) return false;      // 画布内部的拖拽（移动卡片）不当作导入
    var dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types) {
      for (var i = 0; i < dt.types.length; i++) {
        if (dt.types[i] === 'Files') return true;
      }
    }
    return false;
  }

  function onDragEnter(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    S.dropCue.hidden = false;
    S.board.classList.add('is-dropping');
  }

  function onDragOver(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    // 悬停在生成卡上 → 提示会设为参考图
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var card = el && el.closest ? el.closest('.card') : null;
    var target = null;
    if (card && card.dataset.kind !== 'asset') target = card.dataset.id;

    if (target !== dragOverId) {
      if (dragOverId) setDropTarget(dragOverId, false);
      dragOverId = target;
      if (dragOverId) setDropTarget(dragOverId, true);
    }
    if (S.dropCueText) {
      S.dropCueText.textContent = target ? '松开设为该卡片的参考图' : '松开即可放入画布';
    }
  }

  var dragOverId = null;
  function setDropTarget(id, on) {
    var el = R.elOf(id);
    if (el) el.classList.toggle('is-drop-target', !!on);
  }

  function onDragLeave(e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideDropCue();
  }

  function hideDropCue() {
    dragDepth = 0;
    if (S.dropCue) S.dropCue.hidden = true;
    S.board.classList.remove('is-dropping');
    if (dragOverId) { setDropTarget(dragOverId, false); dragOverId = null; }
  }

  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();

    var files = Array.prototype.slice.call(e.dataTransfer.files || [])
      .filter(function (f) { return /^image\//.test(f.type); });

    var targetId = dragOverId;
    hideDropCue();

    if (!files.length) {
      FC.ui.toast('只支持拖入图片文件', 'i-close');
      return;
    }

    var wp = worldPoint(e);

    // 落到生成卡上 → 设为参考图
    if (targetId && files.length === 1) {
      FC.ui.importFiles(files, { refTargetId: targetId });
      return;
    }

    FC.ui.importFiles(files, { worldPoint: wp });
  }

  /* ---------- 粘贴图片 ---------- */
  function onPaste(e) {
    if (isTyping(e.target)) return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    // 1) 系统剪贴板里有图片 → 当作素材放进画布
    if (files.length) {
      e.preventDefault();
      FC.ui.importFiles(files, { worldPoint: R.viewCenterWorld() });
      return;
    }

    // 2) 否则粘贴画布内复制的卡片
    e.preventDefault();
    pasteCards();
  }

  /* ==========================================================================
     键盘
     ========================================================================== */
  function isTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function onKeyDown(e) {
    if (isTyping(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    var mod = e.metaKey || e.ctrlKey;

    if (e.code === 'Space' && !spaceDown) {
      spaceDown = true; updateCursor(); e.preventDefault(); return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) { if (Store.redo()) FC.ui.toast('已重做', 'i-redo'); }
      else if (Store.undo()) FC.ui.toast('已撤销', 'i-undo');
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      if (Store.redo()) FC.ui.toast('已重做', 'i-redo');
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); Store.selectAll(); return; }
    if (mod && e.key.toLowerCase() === 'c') {
      if (Store.selection.length) { e.preventDefault(); var cn = copySelection(); if (cn) FC.ui.toast('已复制 ' + cn + ' 个卡片', 'i-copy'); }
      return;
    }
    if (mod && e.key.toLowerCase() === 'x') {
      if (Store.selection.length) { e.preventDefault(); cutSelection(); }
      return;
    }
    // ⌘V 故意不在这里处理：交给 paste 事件，这样剪贴板里有图片时优先贴图片，且不会重复粘贴
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
    if (mod && e.key === '0') { e.preventDefault(); R.fitView(); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.2); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomBy(1 / 1.2); return; }

    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
    if (e.key === 'Escape') {
      Store.clearSelection();
      FC.ui.closeAll();
      return;
    }
    if (e.key === 'v' || e.key === 'V') { setTool('select'); return; }
    if (e.key === 'h' || e.key === 'H') { setTool('pan'); return; }
    if (e.key === 'n' || e.key === 'N') { FC.ui.openCreateMenuAtCenter(); return; }

    if (e.key.indexOf('Arrow') === 0 && Store.selection.length) {
      e.preventDefault();
      var step = e.shiftKey ? 1 : 8;
      var dx = e.key === 'ArrowLeft' ? -step : (e.key === 'ArrowRight' ? step : 0);
      var dy = e.key === 'ArrowUp' ? -step : (e.key === 'ArrowDown' ? step : 0);
      var moves = Store.selectedItems().map(function (it) {
        return { id: it.id, x: it.x + dx, y: it.y + dy };
      });
      Store.moveItems(moves, { commit: false });
      R.syncTransforms(Store.selection);
      clearTimeout(onKeyDown._t);
      onKeyDown._t = setTimeout(function () { Store.commit(); }, 320);
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      spaceDown = false;
      updateCursor();
      if (gesture && gesture.type === 'pan') endGesture();
    }
  }

  function setTool(tool) {
    Store.ui.tool = tool;
    S.board.dataset.tool = tool;
    document.querySelectorAll('[data-tool]').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.tool === tool);
    });
    updateCursor();
  }

  /* ---------- 复制 / 剪切 / 粘贴 ---------- */
  function copySelection() {
    var ids = Store.selection.slice();
    if (!ids.length) return 0;
    var map = {};
    var items = [];
    ids.forEach(function (id) {
      var it = Store.get(id);
      if (!it) return;
      map[id] = true;
      items.push(FC.util.clone(it));
    });
    // 一并记住选中卡片「内部」的连线，粘贴时重建
    var links = Store.doc.links.filter(function (l) {
      return map[l.from] && map[l.to];
    }).map(function (l) { return { from: l.from, to: l.to }; });

    cardClipboard = { items: items, links: links };
    return items.length;
  }

  function cutSelection() {
    var n = copySelection();
    if (!n) return;
    Store.remove(Store.selection.slice());
    FC.ui.toast('已剪切 ' + n + ' 个卡片', 'i-copy');
  }

  /** 粘贴落点 = 当前鼠标位置；鼠标不在画布上则用视口中心 */
  function mouseWorldPoint() {
    var r = boardRect();
    var px = lastPointer.x - r.left;
    var py = lastPointer.y - r.top;
    if (!pointerSeen || px < 0 || py < 0 || px > r.width || py > r.height) {
      return R.viewCenterWorld();
    }
    var wp = FC.geo.toWorld(px, py, Store.view);
    wp.y += 8;                  // 稍微往下一点，卡片落在鼠标下方
    return wp;
  }

  function pasteCards() {
    if (!cardClipboard || !cardClipboard.items.length) return false;

    var anchor = mouseWorldPoint();

    // 鼠标没动就又粘一次 → 依次错开，避免完全重叠
    if (pasteAnchorLast &&
        Math.abs(anchor.x - pasteAnchorLast.x) < 24 &&
        Math.abs(anchor.y - pasteAnchorLast.y) < 24) {
      pasteRepeat += 1;
    } else {
      pasteRepeat = 0;
    }
    pasteAnchorLast = { x: anchor.x, y: anchor.y };
    var shift = pasteRepeat * PASTE_OFFSET;

    // 以「这一组卡片的左上角」对齐到鼠标位置，并保持它们之间的相对关系
    var minX = Infinity, minY = Infinity;
    cardClipboard.items.forEach(function (it) {
      minX = Math.min(minX, it.x);
      minY = Math.min(minY, it.y);
    });

    var top = Store.maxZ();
    var map = {};
    var created = [];

    cardClipboard.items.forEach(function (src) {
      var c = FC.util.clone(src);
      c.id = FC.util.uid(src.kind === 'asset' ? 'img' : 'gen');
      c.x = Math.round(anchor.x + (src.x - minX) + shift);
      c.y = Math.round(anchor.y + (src.y - minY) + shift);
      c.z = ++top;
      map[src.id] = c.id;
      created.push(c);
      Store.doc.items.push(c);
    });

    cardClipboard.links.forEach(function (l) {
      if (map[l.from] && map[l.to]) {
        Store.doc.links.push({ id: FC.util.uid('lnk'), from: map[l.from], to: map[l.to] });
      }
    });

    Store.select(created.map(function (c) { return c.id; }));
    Store.commit();
    FC.ui.toast('已粘贴 ' + created.length + ' 个卡片', 'i-copy');
    return true;
  }

  function deleteSelection() {
    // 选中连线时优先删连线
    if (Store.selectedLinks.length) {
      Store.removeLinks(Store.selectedLinks.slice());
      FC.ui.toast('已删除连线', 'i-close');
      return;
    }
    var ids = Store.selection.slice();
    if (!ids.length) return;
    Store.remove(ids);
    FC.ui.toast('已删除', 'i-trash');
  }

  function duplicateSelection() {
    if (!Store.selection.length) return;
    var copies = Store.duplicate(Store.selection);
    if (copies.length) FC.ui.toast('已复制 ' + copies.length + ' 个卡片', 'i-copy');
  }

  FC.interactions = {
    init: init,
    setTool: setTool,
    zoomBy: zoomBy,
    zoomTo: zoomTo,
    zoomAt: zoomAt,
    deleteSelection: deleteSelection,
    copySelection: copySelection,
    cutSelection: cutSelection,
    pasteCards: pasteCards,
    hasClipboard: function () { return !!(cardClipboard && cardClipboard.items.length); },
    duplicateSelection: duplicateSelection,
    hideDropCue: hideDropCue,
    endGesture: endGesture
  };
})(window.FC);