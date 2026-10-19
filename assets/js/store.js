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
      w: 340,          // 加宽一点，让媒体区当主体
      aspect: '1:1',
      // 真实模型名（Grsai 中转站）。gpt-image-2.5 只支持 quality=auto、不支持 background/mask
      models: ['gpt-image-2.5', 'gpt-image-2', 'gpt-image-2-vip', 'nano-banana-2', 'nano-banana-pro'],
      // gpt-image-2/2.5：支持比例写法，也支持 1K 像素值。这里用比例
      ratios: ['auto', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
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
      w: 360,          // 加宽一点，让媒体区当主体
      aspect: 'landscape',
      // 两个平台的视频模型并列。参数约束完全不同，见下面的 modelOptions
      models: ['minimax-h3', 'wan3.0'],
      // minimax-h3 只认 portrait(竖屏) / landscape(横屏)，不是 16:9 这种写法
      ratios: ['landscape', 'portrait'],
      styles: ['无风格', '电影感', '延时摄影', '动画', '手持'],
      // 官方文档：duration 支持 1~15 秒，但【1080p 最多 10 秒】。
      // 所以这里列全 1~15，再由 maxDurationFor() 按分辨率砍掉超出的部分。
      durations: ['3 秒', '5 秒', '8 秒', '10 秒', '12 秒', '15 秒'],
      resolutions: ['480p', '768p', '1080p'],
      /**
       * 分辨率各自的时长上限（秒）。
       * minimax-h3：480p / 768p 可以到 15 秒，1080p 只能到 10 秒。
       * 没列到的分辨率不限制。
       */
      durationCaps: { '1080p': 10 },
      /**
       * 按模型覆盖参数选项 —— 两个平台的约束差得挺多：
       *
       *   minimax-h3（Grsai）  比例 landscape/portrait，有分辨率，1~15 秒
       *   wan3.0（速创）       比例 16:9/9:16，【没有分辨率参数】，4~30 秒
       *
       * 没列到的字段就沿用上面的默认值。
       */
      modelOptions: {
        'wan3.0': {
          ratios: ['16:9', '9:16'],
          durations: ['4 秒', '5 秒', '8 秒', '10 秒', '15 秒', '30 秒'],
          resolutions: null,          // 它不收这个参数，界面上要隐藏
          hint: '速创 Wan3.0 · 只收参考图的公网 URL（会自动帮你上传）· 0.3 元/秒'
        }
      },
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

  /* ---------- 参考图角色（@ 引用用） ---------- */
  var ROLES = ['参考', '主体', '风格', '首帧', '尾帧'];
  var ROLE_HINT = {
    '参考': '当作一般参考图',
    '主体': '保持这张图里的主体/人物一致',
    '风格': '沿用这张图的画风/色调',
    '首帧': '视频从这里开始',
    '尾帧': '视频到这里结束'
  };

  /**
   * 从图片名生成一个能 @ 的短名。
   * 截图 / 相机文件名通常带日期和时间戳（屏幕截图 2026-10-09 135745），
   * 直接截取会变成 @屏幕截图2026-1 这种没人愿意输的东西，所以先清掉这些噪声。
   */
  function handleFrom(name, taken) {
    var base = String(name || '图片')
      .replace(/\.[a-z0-9]+$/i, '')                       // 去扩展名
      .replace(/\d{4}[-_.年]?\d{1,2}[-_.月]?\d{1,2}/g, ' ') // 日期 2026-10-09
      .replace(/\d{2}[-_.:]\d{2}[-_.:]\d{2}/g, ' ')        // 时间 13:57:45
      .replace(/\d{4,}/g, ' ')                            // 长数字串 135745
      .replace(/[^\u4e00-\u9fffa-zA-Z0-9]+/g, '')          // 只留中日韩/字母/数字
      .replace(/\d{2,}$/, '')                             // 结尾的分辨率 656
      .slice(0, 8);
    if (!base) base = '图片';
    var h = base;
    var n = 1;
    while (taken[h]) { n += 1; h = base + n; }
    taken[h] = true;
    return h;
  }

  /**
   * 比例 -> 数值宽高比（只用于卡片预览区的高度）。
   * 生图用 "16:9" 这种；视频（minimax-h3）用的是 landscape / portrait 文字，
   * 生图还有个 "auto" —— 这些都要能显示出合理的预览比例。
   */
  function ratioValue(r) {
    var s = String(r || '1:1').trim().toLowerCase();
    if (s === 'landscape') return 16 / 9;
    if (s === 'portrait') return 9 / 16;
    if (s === 'auto') return 1;
    var parts = s.split(':');
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

  /** '时长 15 秒' / '15 秒' / 15 -> 15（拿不到数字返回 0） */
  function secondsOf(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var m = /(\d+(?:\.\d+)?)/.exec(String(v || ''));
    return m ? parseFloat(m[1]) : 0;
  }

  /**
   * 取某张卡「当前模型」实际可用的参数选项。
   *
   * 视频卡里放了两个平台的模型（Grsai 的 minimax-h3、速创的 wan3.0），
   * 它们的比例写法、有没有分辨率、时长范围都不一样，所以在 KINDS 里用
   * modelOptions 按模型覆盖。没覆盖到的字段沿用卡片类型的默认值。
   *
   * 另外还有个「交叉约束」：minimax-h3 的时长上限取决于分辨率 ——
   * 官方文档写的是「支持 1~15 秒，1080p 最多支持 10 秒」。
   * 所以 durations 会按当前 resolution 再过滤一次。
   *
   * @returns {{ratios:string[], durations:string[]|null, resolutions:string[]|null,
   *            styles:string[], hint:string}}
   */
  function optionsFor(item) {
    var def = KINDS[(item && item.kind) || 'image-gen'] || KINDS['image-gen'];
    var base = {
      ratios: def.ratios || [],
      durations: def.durations || null,
      resolutions: def.resolutions || null,
      styles: def.styles || [],
      hint: '',
      durationCaps: def.durationCaps || null
    };
    var ov = (def.modelOptions && item && def.modelOptions[item.model]) || null;
    if (ov) {
      if (ov.ratios) base.ratios = ov.ratios;
      if ('durations' in ov) base.durations = ov.durations;
      if ('resolutions' in ov) base.resolutions = ov.resolutions;
      if (ov.styles) base.styles = ov.styles;
      if (ov.hint) base.hint = ov.hint;
      if ('durationCaps' in ov) base.durationCaps = ov.durationCaps;
    }

    // 按分辨率砍掉超出上限的时长
    if (base.durations && base.durationCaps && item && item.resolution) {
      var cap = base.durationCaps[item.resolution];
      if (cap) {
        var kept = base.durations.filter(function (d) { return secondsOf(d) <= cap; });
        if (kept.length) base.durations = kept;
      }
    }
    return base;
  }

  /** 当前分辨率下，时长最多多少秒（没限制返回 0） */
  function maxDurationFor(item) {
    var o = optionsFor(item);
    if (!o.durations || !o.durations.length) return 0;
    var mx = 0;
    o.durations.forEach(function (d) { mx = Math.max(mx, secondsOf(d)); });
    return mx;
  }

  /** 当前分辨率下允许的最大时长（返回 '15 秒' 这种字符串） */
  function durationAtMax(item) {
    var o = optionsFor(item);
    if (!o.durations || !o.durations.length) return item.duration;
    return o.durations[o.durations.length - 1];
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
      // 用「当前模型的选项」来定默认值，否则 wan3.0 会拿到 landscape 这种它不认的值
      var o = optionsFor(item);
      item.ratio = o.ratios.indexOf(def.aspect) >= 0 ? def.aspect : (o.ratios[0] || def.aspect);
      item.style = def.styles[0];
      if (o.durations) item.duration = o.durations[1] || o.durations[0];
      if (o.resolutions) item.resolution = o.resolutions[1] || o.resolutions[0];
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
      model: 'gpt-image-2.5',
      ratio: '4:3',
      style: '摄影',
      z: 1
    });
    a.result = { kind: 'image', seed: 20240517, w: 896, h: 672, createdAt: Date.now(), demo: true };

    var b = createItem('video-gen', -40, -190, {
      prompt: '镜头缓慢推近，水面涟漪扩散，光影流动',
      model: 'minimax-h3',
      ratio: 'landscape',
      resolution: '768p',
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

      // 迁移：生成卡的老默认宽度（生图 300 / 视频 320）加宽一点，
      // 让媒体区当主体、参数区显得更紧凑。
      // 只动「恰好还是老默认值」的卡，自己调过宽度的不会被覆盖。
      if (kind !== 'asset' && (out.w === 300 || out.w === 320)) {
        out.w = def.w;
      }

      if (kind === 'asset') {
        out.name = typeof it.name === 'string' ? it.name : '图片';
        out.naturalW = num(it.naturalW, 0);
        out.naturalH = num(it.naturalH, 0);
        // 旧数据兼容：文档里可能还带着 dataURL，交给 assets.hydrate() 迁进 IndexedDB。
        // 新数据这里没有 src —— 图片存在 IndexedDB 里，所以「没有 src」不能当成坏卡丢掉。
        if (typeof it.src === 'string' && /^data:/.test(it.src)) out.src = it.src;
      } else {
        out.prompt = typeof it.prompt === 'string' ? it.prompt : '';
        out.model = def.models.indexOf(it.model) >= 0 ? it.model : def.models[0];
        // 先定下 model，再按这个模型的选项校验其余参数 ——
        // 否则从 minimax-h3 切到 wan3.0 时，landscape 这种值会被当成合法的留下
        var o = optionsFor(out);
        out.ratio = o.ratios.indexOf(it.ratio) >= 0 ? it.ratio : (o.ratios[0] || def.aspect);
        out.style = def.styles.indexOf(it.style) >= 0 ? it.style : def.styles[0];
        if (o.resolutions) {
          out.resolution = o.resolutions.indexOf(it.resolution) >= 0 ? it.resolution : (o.resolutions[0]);
        }
        if (o.durations) {
          out.duration = o.durations.indexOf(it.duration) >= 0 ? it.duration : (o.durations[0]);
          // resolution 定下来之后再校验时长 —— 因为时长上限取决于分辨率
          // （minimax-h3：480p/768p 可到 15 秒，1080p 最多 10 秒）。
          // 上面 optionsFor(out) 时 out.resolution 还没赋值，所以这里要重算一次。
          var o2 = optionsFor(out);
          if (o2.durations.indexOf(out.duration) < 0) {
            out.duration = durationAtMax(out);
          }
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
            demo: !!rs.demo,
            // 存储状态要留着 —— 不然每次存盘再打开，「已转存到云端」的云朵
            // 角标和「还在中转站」的警告角标都会消失
            archived: rs.archived ? true : undefined,
            archiveFailed: rs.archiveFailed ? true : undefined,
            origin: typeof rs.origin === 'string' ? rs.origin : undefined
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
    function pushLink(from, to, role) {
      if (!ids[from] || !ids[to] || from === to) return;
      if (!canIn[to]) return;                     // 目标卡片不接受输入
      var key = from + '>' + to;
      if (linkSeen[key]) return;
      linkSeen[key] = true;
      doc.links.push({
        id: uid('lnk'), from: from, to: to,
        role: ROLES.indexOf(role) >= 0 ? role : '参考'
      });
    }
    (Array.isArray(raw.links) ? raw.links : []).forEach(function (l) {
      if (!l || typeof l !== 'object') return;
      pushLink(l.from, l.to, l.role);
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
    optionsFor: optionsFor,
    maxDurationFor: maxDurationFor,
    secondsOf: secondsOf,
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

      // 先记下要删的素材卡：图片在 IndexedDB 里，得另外清
      var assetIds = this.doc.items
        .filter(function (i) { return set[i.id] && i.kind === 'asset'; })
        .map(function (i) { return i.id; });

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
      // 图片从 IndexedDB 删掉，别白占地方
      if (assetIds.length && FC.assets) FC.assets.drop(assetIds);

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
          self.doc.links.push({ id: uid('lnk'), from: map[l.from], to: map[l.to], role: l.role || '参考' });
        }
      });
      // 素材卡复制：图片也得跟着复制一份，否则新卡片没有图
      if (FC.assets) {
        ids.forEach(function (id) {
          var orig = self.get(id);
          if (!orig || orig.kind !== 'asset' || !map[id]) return;
          var blob = FC.assets.blobOf(id);
          if (blob) FC.assets.put(map[id], blob);
        });
      }

      if (copies.length) {
        this.select(copies.map(function (c) { return c.id; }));
        this.commit();
      }
      return copies;
    },

    /* --- 参考图（@ 引用） --- */
    /**
     * 取某张卡的输入参考列表（按连线顺序），带短名、角色、图片地址。
     * 短名（handle）在这里即时算：同一张卡内不重名，所以 @ 不会有歧义。
     */
    refsOf: function (cardId) {
      var self = this;
      var taken = {};
      var out = [];
      this.doc.links.forEach(function (l) {
        if (l.to !== cardId) return;
        var a = self.get(l.from);
        if (!a || a.kind !== 'asset') return;
        out.push({
          linkId: l.id,
          assetId: a.id,
          name: a.name || '图片',
          handle: handleFrom(a.name, taken),
          role: ROLES.indexOf(l.role) >= 0 ? l.role : '参考'
        });
      });
      return out;
    },

    /**
     * 给素材改名。
     * @ 的短名是从 name 算出来的，所以改完名字，@ 自动跟着变。
     * 已经写进提示词里的 @旧名 也会一起改成 @新名，不会变成死引用。
     */
    renameAsset: function (assetId, newName, opts) {
      var self = this;
      var item = this.get(assetId);
      if (!item || item.kind !== 'asset') return false;
      var clean = String(newName == null ? '' : newName).trim().slice(0, 40);
      if (!clean || clean === item.name) return false;

      // 1) 改名之前，先把「哪些卡把它当输入」以及各自算出来的旧短名记下来
      var affected = [];
      this.doc.items.forEach(function (card) {
        if (card.kind === 'asset') return;
        var refs = self.refsOf(card.id);
        refs.forEach(function (r) {
          if (r.assetId === assetId) affected.push({ cardId: card.id, oldHandle: r.handle });
        });
      });

      item.name = clean;

      // 2) 提示词里的 @旧名 换成 @新名
      affected.forEach(function (a) {
        var card = self.get(a.cardId);
        if (!card) return;
        var refs = self.refsOf(card.id);
        var mine = refs.filter(function (r) { return r.assetId === assetId; })[0];
        if (!mine || mine.handle === a.oldHandle) return;
        var esc2 = a.oldHandle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
        var re = new RegExp('@' + esc2 + '(?![\\\\w\\\\u4e00-\\\\u9fff])', 'g');
        card.prompt = String(card.prompt || '').replace(re, '@' + mine.handle);
      });

      if (!opts || opts.commit !== false) this.commit();
      return true;
    },

    setLinkRole: function (linkId, role, opts) {
      if (ROLES.indexOf(role) < 0) return false;
      var l = this.doc.links.filter(function (x) { return x.id === linkId; })[0];
      if (!l) return false;
      l.role = role;
      if (!opts || opts.commit !== false) this.commit();
      return true;
    },

    /** 点一下换下一个角色 */
    cycleLinkRole: function (linkId) {
      var l = this.doc.links.filter(function (x) { return x.id === linkId; })[0];
      if (!l) return null;
      var i = ROLES.indexOf(l.role);
      var next = ROLES[(i < 0 ? 0 : i + 1) % ROLES.length];
      this.setLinkRole(linkId, next);
      return next;
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
      var link = { id: uid('lnk'), from: fromId, to: toId, role: '参考' };
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

  FC.ROLES = ROLES;
  FC.ROLE_HINT = ROLE_HINT;
  FC.handleFrom = handleFrom;

  FC.STORAGE_KEY = 'aic.doc.v1';
  FC.THEME_KEY = 'aic.theme.v1';
  FC.HINT_KEY = 'aic.hint.v1';
  FC.Store = Store;
  FC.util = { uid: uid, clone: clone, clamp: clamp, num: num, ratioValue: ratioValue };
})(window.FC);