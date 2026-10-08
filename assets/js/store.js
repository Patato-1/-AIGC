/* ==========================================================================
   store.js — 数据模型 / 状态 / 撤销重做 / 持久化
   画布上只有「卡片」：AI 生图卡、AI 视频卡、图片卡。没有连线，自由摆放。
   ========================================================================== */
window.FC = window.FC || {};

(function (FC) {
  'use strict';

  /* ---------- 卡片类型定义 ---------- */
  var KINDS = {
    'image-gen': {
      id: 'image-gen',
      label: 'AI 生图模型',
      short: '生图',
      desc: '用提示词生成图片',
      icon: 'i-sparkle',
      w: 300,
      aspect: '1:1',
      models: ['deepseek-image', 'flux-schnell', 'sdxl-turbo', 'midjourney-v6'],
      ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
      styles: ['无风格', '摄影', '插画', '3D 渲染', '线稿', '电影感'],
      ports: { in: true, out: true },
      generateLabel: '生成图片'
    },
    'video-gen': {
      id: 'video-gen',
      label: 'AI 视频模型',
      short: '视频',
      desc: '用提示词生成短视频',
      icon: 'i-video',
      w: 320,
      aspect: '16:9',
      models: ['deepseek-video', 'kling-v1', 'runway-gen3', 'luma-dream'],
      ratios: ['16:9', '9:16', '1:1', '4:3'],
      styles: ['无风格', '电影感', '延时摄影', '动画', '手持'],
      durations: ['3 秒', '5 秒', '10 秒'],
      ports: { in: true, out: true },
      generateLabel: '生成视频'
    },
    'asset': {
      id: 'asset',
      label: '图片素材',
      short: '图片',
      desc: '拖入的本地图片',
      icon: 'i-image',
      w: 260,
      ports: { in: false, out: true }   // 素材只能输出，不能接收
    }
  };

  /** 比例字符串 -> 数值 */
  function ratioValue(r) {
    var parts = String(r || '1:1').split(':');
    var a = parseFloat(parts[0]), b = parseFloat(parts[1]);
    if (!isFinite(a) || !isFinite(b) || b === 0) return 1;
    return a / b;
  }

  /* ---------- 工具 ---------- */
  var seq = 0;
  function uid(prefix) {
    seq += 1;
    return (prefix || 'i') + '_' + Date.now().toString(36) + seq.toString(36) +
      Math.random().toString(36).slice(2, 6);
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, fallback) {
    var n = parseFloat(v);
    return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  /* ---------- 创建卡片 ---------- */
  function createItem(kind, x, y, patch) {
    var def = KINDS[kind] || KINDS['image-gen'];
    var item = {
      id: uid(kind === 'asset' ? 'img' : 'gen'),
      kind: def.id,
      x: Math.round(x),
      y: Math.round(y),
      w: def.w,
      z: 1
    };

    if (kind === 'image-gen' || kind === 'video-gen') {
      item.prompt = '';
      item.model = def.models[0];
      item.ratio = def.aspect;
      item.style = def.styles[0];
      if (def.durations) item.duration = def.durations[1];
      item.result = null;             // { kind, src?, seed?, w, h, createdAt, demo? }
    } else {
      item.src = '';                  // dataURL
      item.name = '图片';
      item.naturalW = 0;
      item.naturalH = 0;
    }

    if (patch) {
      Object.keys(patch).forEach(function (k) { item[k] = patch[k]; });
    }
    return item;
  }

  /* ---------- 文档 ---------- */
  function emptyDoc(name) {
    return {
      id: uid('doc'),
      name: name || '未命名画布',
      version: 1,
      updatedAt: new Date().toISOString(),
      items: [],
      links: []          // 轻量连线：[{ id, from, to }]，from 的输出喂给 to
    };
  }

  /** 示例内容：两张模型卡（结果用确定性 seed 程序化生成，见 art.js） */
  function demoDoc() {
    var doc = emptyDoc('我的创作画布');
    var a = createItem('image-gen', -430, -190, {
      prompt: '晨雾中的松林，长焦压缩，极简构图',
      model: 'deepseek-image',
      ratio: '4:3',
      style: '摄影',
      z: 1
    });
    a.result = { kind: 'image', seed: 20240517, w: 896, h: 672, createdAt: Date.now(), demo: true };

    var b = createItem('video-gen', -40, -190, {
      prompt: '镜头缓慢推近，水面涟漪扩散，光影流动',
      model: 'deepseek-video',
      ratio: '16:9',
      style: '电影感',
      duration: '5 秒',
      z: 2
    });
    b.result = { kind: 'video', seed: 22, w: 960, h: 540, createdAt: Date.now(), demo: true };

    doc.items = [a, b];
    // 示例连线：生图卡的输出作为视频卡的输入
    doc.links = [{ id: uid('lnk'), from: a.id, to: b.id }];
    return doc;
  }

  /* ---------- 规范化（导入 / 反序列化） ---------- */
  function normalizeDoc(raw) {
    if (!raw || typeof raw !== 'object') return emptyDoc();
    var doc = {
      id: typeof raw.id === 'string' ? raw.id : uid('doc'),
      name: typeof raw.name === 'string' ? raw.name : '未命名画布',
      version: num(raw.version, 1),
      updatedAt: raw.updatedAt || new Date().toISOString(),
      items: []
    };
    var seen = {};
    (Array.isArray(raw.items) ? raw.items : []).forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var kind = KINDS[it.kind] ? it.kind : 'asset';
      var def = KINDS[kind];
      var fresh = createItem(kind, num(it.x, 0), num(it.y, 0));
      var id = typeof it.id === 'string' ? it.id : fresh.id;
      if (seen[id]) id = fresh.id;
      seen[id] = true;

      var out = Object.assign(fresh, {
        id: id,
        x: num(it.x, 0),
        y: num(it.y, 0),
        w: clamp(num(it.w, def.w), 180, 720),
        z: num(it.z, 1)
      });

      if (kind === 'asset') {
        out.src = typeof it.src === 'string' ? it.src : '';
        out.name = typeof it.name === 'string' ? it.name : '图片';
        out.naturalW = num(it.naturalW, 0);
        out.naturalH = num(it.naturalH, 0);
        if (!out.src) return;                      // 没有图源的素材卡直接丢弃
      } else {
        out.prompt = typeof it.prompt === 'string' ? it.prompt : '';
        out.model = def.models.indexOf(it.model) >= 0 ? it.model : def.models[0];
        out.ratio = def.ratios.indexOf(it.ratio) >= 0 ? it.ratio : def.aspect;
        out.style = def.styles.indexOf(it.style) >= 0 ? it.style : def.styles[0];
        if (def.durations) {
          out.duration = def.durations.indexOf(it.duration) >= 0 ? it.duration : def.durations[1];
        }
        if (it.result && typeof it.result === 'object') {
          var rs = it.result;
          out.result = {
            kind: rs.kind === 'video' ? 'video' : 'image',
            src: typeof rs.src === 'string' && rs.src ? rs.src : undefined,
            seed: isFinite(rs.seed) ? rs.seed : undefined,
            w: num(rs.w, 768),
            h: num(rs.h, 768),
            createdAt: num(rs.createdAt, Date.now()),
            demo: !!rs.demo
          };
          if (out.result.src === undefined && out.result.seed === undefined) out.result = null;
        }
      }
      doc.items.push(out);
    });

    var ids = {};
    doc.items.forEach(function (i) { ids[i.id] = true; });

    // --- 连线规范化 ---
    var canIn = {};
    doc.items.forEach(function (i) { canIn[i.id] = KINDS[i.kind].ports.in; });
    doc.links = [];
    var linkSeen = {};
    function pushLink(from, to) {
      if (!ids[from] || !ids[to] || from === to) return;
      if (!canIn[to]) return;                     // 目标卡片不接受输入
      var key = from + '>' + to;
      if (linkSeen[key]) return;
      linkSeen[key] = true;
      doc.links.push({ id: uid('lnk'), from: from, to: to });
    }
    (Array.isArray(raw.links) ? raw.links : []).forEach(function (l) {
      if (!l || typeof l !== 'object') return;
      pushLink(l.from, l.to);
    });
    // 兼容旧数据：refId 迁移成连线
    doc.items.forEach(function (i) {
      if (i.refId) { pushLink(i.refId, i.id); }
      delete i.refId;
    });

    return doc;
  }

  /* ==========================================================================
     Store
     ========================================================================== */
  var Store = {
    KINDS: KINDS,
    KIND_ORDER: ['image-gen', 'video-gen'],
    uid: uid,
    createItem: createItem,
    emptyDoc: emptyDoc,
    demoDoc: demoDoc,
    normalizeDoc: normalizeDoc,
    ratioValue: ratioValue,

    doc: emptyDoc(),
    view: { x: 0, y: 0, k: 1 },
    selection: [],
    selectedLinks: [],
    ui: { tool: 'select', theme: 'light' },
    /** 运行时状态（不进文档、不进历史）：生成进度 */
    runtime: { progress: {} },

    _past: [],
    _future: [],
    _baseline: '',
    _subs: [],
    _saveTimer: null,
    _saveError: false,

    /* --- 事件 --- */
    on: function (fn) { this._subs.push(fn); return fn; },
    emit: function (type, payload) {
      for (var i = 0; i < this._subs.length; i++) {
        try { this._subs[i](type, payload); } catch (err) { console.error('[store]', err); }
      }
    },

    /* --- 查询 --- */
    get: function (id) {
      for (var i = 0; i < this.doc.items.length; i++) {
        if (this.doc.items[i].id === id) return this.doc.items[i];
      }
      return null;
    },
    kindDef: function (kind) { return KINDS[kind] || KINDS.asset; },
    isSelected: function (id) { return this.selection.indexOf(id) >= 0; },
    selectedItems: function () {
      var self = this;
      return this.selection.map(function (id) { return self.get(id); }).filter(Boolean);
    },
    maxZ: function () {
      return this.doc.items.reduce(function (m, i) { return Math.max(m, num(i.z, 1)); }, 1);
    },

    /* --- 历史 --- */
    snapshot: function () { return JSON.stringify(this.doc); },
    initHistory: function () {
      this._past = []; this._future = [];
      this._baseline = this.snapshot();
      this.emit('history');
    },
    commit: function (opts) {
      var now = this.snapshot();
      if (now === this._baseline) { this.markDirty(); return false; }
      this._past.push(this._baseline);
      if (this._past.length > 80) this._past.shift();
      this._future.length = 0;
      this._baseline = now;
      this.doc.updatedAt = new Date().toISOString();
      this.emit('history');
      this.markDirty();
      if (!opts || opts.render !== false) this.emit('doc');
      return true;
    },
    canUndo: function () { return this._past.length > 0; },
    canRedo: function () { return this._future.length > 0; },
    undo: function () {
      if (!this._past.length) return false;
      this._future.push(this._baseline);
      this._baseline = this._past.pop();
      this.doc = JSON.parse(this._baseline);
      this.pruneSelection();
      this.emit('history'); this.emit('doc'); this.markDirty();
      return true;
    },
    redo: function () {
      if (!this._future.length) return false;
      this._past.push(this._baseline);
      this._baseline = this._future.pop();
      this.doc = JSON.parse(this._baseline);
      this.pruneSelection();
      this.emit('history'); this.emit('doc'); this.markDirty();
      return true;
    },
    pruneSelection: function () {
      var ids = {};
      this.doc.items.forEach(function (i) { ids[i.id] = true; });
      this.selection = this.selection.filter(function (id) { return ids[id]; });
      this.emit('selection');
    },

    /* --- 视图 --- */
    setView: function (patch) {
      var v = this.view;
      if (patch.x !== undefined) v.x = num(patch.x, v.x);
      if (patch.y !== undefined) v.y = num(patch.y, v.y);
      if (patch.k !== undefined) v.k = clamp(num(patch.k, v.k), 0.15, 4);
      this.emit('view');
    },

    /* --- 选择 --- */
    select: function (ids) {
      this.selection = (ids || []).slice();
      this.selectedLinks = [];
      this.emit('selection');
    },
    toggleSelect: function (id) {
      var i = this.selection.indexOf(id);
      if (i >= 0) this.selection.splice(i, 1);
      else this.selection.push(id);
      this.emit('selection');
    },
    selectOnly: function (id) {
      if (this.selection.length === 1 && this.selection[0] === id) return;
      this.select(id ? [id] : []);
    },
    clearSelection: function () {
      if (!this.selection.length) return;
      this.select([]);
    },
    selectAll: function () {
      this.select(this.doc.items.map(function (i) { return i.id; }));
    },

    /* --- 卡片增删改 --- */
    addItem: function (kind, x, y, patch) {
      var item = createItem(kind, x, y, patch);
      item.z = this.maxZ() + 1;
      this.doc.items.push(item);
      this.selectOnly(item.id);
      this.commit();
      return item;
    },

    addItems: function (items) {
      var self = this;
      var top = this.maxZ();
      items.forEach(function (it) {
        top += 1;
        it.z = top;
        self.doc.items.push(it);
      });
      this.select(items.map(function (i) { return i.id; }));
      this.commit();
      return items;
    },

    update: function (id, patch, opts) {
      var item = this.get(id);
      if (!item) return;
      Object.assign(item, patch);
      if (!opts || opts.commit !== false) this.commit();
      else this.emit('doc-lite');
    },

    moveItems: function (moves, opts) {
      var self = this;
      moves.forEach(function (m) {
        var it = self.get(m.id);
        if (it) { it.x = m.x; it.y = m.y; }
      });
      if (!opts || opts.commit !== false) this.commit();
      else this.emit('doc-lite');
    },

    bringToFront: function (ids, opts) {
      var top = this.maxZ();
      var changed = false;
      ids.forEach(function (id) {
        var it = this.get(id);
        if (it && num(it.z, 1) < top) { it.z = ++top; changed = true; }
      }, this);
      if (changed && (!opts || opts.commit !== false)) this.commit();
      return changed;
    },

    remove: function (ids) {
      if (!ids.length) return 0;
      var set = {};
      ids.forEach(function (id) { set[id] = true; });
      var before = this.doc.items.length;
      this.doc.items = this.doc.items.filter(function (i) { return !set[i.id]; });
      // 级联删掉与这些卡片相关的连线
      var deadLinks = this.doc.links.filter(function (l) { return set[l.from] || set[l.to]; })
        .map(function (l) { return l.id; });
      if (deadLinks.length) {
        var lset = {};
        deadLinks.forEach(function (id) { lset[id] = true; });
        this.doc.links = this.doc.links.filter(function (l) { return !lset[l.id]; });
        this.selectedLinks = this.selectedLinks.filter(function (id) { return !lset[id]; });
      }
      ids.forEach(function (id) { delete this.runtime.progress[id]; }, this);
      this.selection = this.selection.filter(function (id) { return !set[id]; });
      this.commit();
      return before - this.doc.items.length;
    },

    duplicate: function (ids) {
      var self = this;
      var copies = [];
      var map = {};
      var top = this.maxZ();
      ids.forEach(function (id) {
        var src = self.get(id);
        if (!src) return;
        var c = clone(src);
        c.id = uid(src.kind === 'asset' ? 'img' : 'gen');
        c.x = src.x + 34;
        c.y = src.y + 34;
        c.z = ++top;
        map[id] = c.id;
        copies.push(c);
        self.doc.items.push(c);
      });
      // 复制这一组内部原有的连线
      this.doc.links.slice().forEach(function (l) {
        if (map[l.from] && map[l.to]) {
          self.doc.links.push({ id: uid('lnk'), from: map[l.from], to: map[l.to] });
        }
      });
      if (copies.length) {
        this.select(copies.map(function (c) { return c.id; }));
        this.commit();
      }
      return copies;
    },

    /* --- 连线（轻量连接） --- */
    linksOf: function (id) {
      var inc = [], out = [];
      this.doc.links.forEach(function (l) {
        if (l.to === id) inc.push(l);
        if (l.from === id) out.push(l);
      });
      return { in: inc, out: out };
    },

    canLink: function (fromId, toId) {
      if (!fromId || !toId || fromId === toId) return false;
      var a = this.get(fromId), b = this.get(toId);
      if (!a || !b) return false;
      if (!KINDS[a.kind].ports.out) return false;
      if (!KINDS[b.kind].ports.in) return false;
      return !this.doc.links.some(function (l) { return l.from === fromId && l.to === toId; });
    },

    addLink: function (fromId, toId, opts) {
      if (!this.canLink(fromId, toId)) return null;
      var link = { id: uid('lnk'), from: fromId, to: toId };
      this.doc.links.push(link);
      if (!opts || opts.commit !== false) this.commit();
      return link;
    },

    removeLinks: function (ids, opts) {
      if (!ids || !ids.length) return 0;
      var set = {};
      ids.forEach(function (id) { set[id] = true; });
      var before = this.doc.links.length;
      this.doc.links = this.doc.links.filter(function (l) { return !set[l.id]; });
      this.selectedLinks = this.selectedLinks.filter(function (id) { return !set[id]; });
      if (!opts || opts.commit !== false) this.commit();
      return before - this.doc.links.length;
    },

    selectLink: function (id) {
      this.selectedLinks = id ? [id] : [];
      this.selection = [];
      this.emit('selection');
    },

    /* --- 参考图 --- */
    /** 把某张素材设为某张模型卡的输入（内部用连线实现，语义与连线一致） */
    setRef: function (cardId, assetId) {
      var card = this.get(cardId);
      if (!card || !KINDS[card.kind].ports.in) return false;
      var links = this.doc.links.filter(function (l) { return l.to === cardId; });
      var kill = links.map(function (l) { return l.id; });
      var self = this;
      if (kill.length) {
        var set = {};
        kill.forEach(function (id) { set[id] = true; });
        this.doc.links = this.doc.links.filter(function (l) { return !set[l.id]; });
      }
      if (assetId && this.canLink(assetId, cardId)) {
        this.doc.links.push({ id: uid('lnk'), from: assetId, to: cardId });
      }
      void self;
      this.commit();
      return true;
    },

    /* --- 文档级 --- */
    setDoc: function (doc, opts) {
      this.doc = (opts && opts.normalize === false) ? doc : normalizeDoc(doc);
      this.runtime = { progress: {} };
      this.selection = [];
      this.selectedLinks = [];
      this.initHistory();
      this.emit('doc');
      this.emit('selection');
      if (!opts || opts.save !== false) this.markDirty();
    },

    clear: function () {
      this.setDoc(emptyDoc(this.doc.name));
      this.commit();
    },

    toJSON: function () {
      var d = clone(this.doc);
      d.updatedAt = new Date().toISOString();
      return d;
    },

    /* --- 持久化 --- */
    markDirty: function () {
      var self = this;
      this.emit('dirty');
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(function () { self.save(); }, 600);
    },

    save: function () {
      try {
        localStorage.setItem(FC.STORAGE_KEY, JSON.stringify(this.doc));
        this._saveError = false;
        this.emit('saved', this.doc.updatedAt);
      } catch (err) {
        this._saveError = true;
        console.warn('[store] 保存失败（可能是图片太多超出 localStorage 容量）', err);
        this.emit('save-error', err);
      }
    },

    load: function () {
      var raw = null;
      try { raw = localStorage.getItem(FC.STORAGE_KEY); } catch (e) { return null; }
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.items)) return parsed;
        return null;
      } catch (e) {
        console.warn('[store] 本地数据损坏，已忽略');
        return null;
      }
    }
  };

  FC.STORAGE_KEY = 'aic.doc.v1';
  FC.THEME_KEY = 'aic.theme.v1';
  FC.HINT_KEY = 'aic.hint.v1';
  FC.Store = Store;
  FC.util = { uid: uid, clone: clone, clamp: clamp, num: num, ratioValue: ratioValue };
})(window.FC);