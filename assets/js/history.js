/* ==========================================================================
   history.js — 生成历史
   --------------------------------------------------------------------------
   为什么只存元数据、不存图片本身：

   生成的图**已经在云端了** —— Grsai 返回的 https://file5.aitohumanize.com/...
   就是它替你托管的。所以历史记录里只留：
     - 图片的云端地址（url）
     - 当时的提示词 / 模型 / 参数 / 时间
   一条记录几百字节，存几万条也就几 MB。

   这样做的直接好处：
     - 不占你电脑空间（你担心的「生成一张存一张」不会发生）
     - 画布上把卡片删了，历史里照样能找到
     - 以后接云端同步，要同步的也只是这点点索引，不是图片

   存储用 IndexedDB（不是 localStorage）：容量大、不会跟别的数据抢配额。
   ========================================================================== */
(function (FC) {
  'use strict';

  window.FC = window.FC || {};

  var DB_NAME = 'ai-canvas';
  var DB_VERSION = 2;          // 从 1 升上来：新增 history 仓库
  var STORE = 'history';
  var MAX_RECORDS = 2000;      // 上限，超了从最旧的开始丢

  var db = null;
  var state = 'idle';          // idle | ready | failed
  var cache = null;            // 内存里的记录数组（新的在前）

  /* ---------- 打开（复用 assets.js 已经建好的库，只加一个仓库） ---------- */
  function open() {
    if (state === 'ready') return Promise.resolve(true);
    if (state === 'failed') return Promise.resolve(false);

    return new Promise(function (resolve) {
      var req;
      try {
        if (!window.indexedDB) throw new Error('no indexedDB');
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        state = 'failed';
        console.warn('[history] IndexedDB 不可用，历史记录将退化为内存态', e);
        if (!cache) cache = [];
        return resolve(false);
      }

      var settled = false;
      function done(ok) { if (!settled) { settled = true; resolve(ok); } }

      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets');
        if (!d.objectStoreNames.contains(STORE)) {
          var s = d.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('at', 'at');
        }
      };
      req.onsuccess = function () {
        db = req.result;
        state = 'ready';
        db.onclose = function () { state = 'idle'; db = null; };
        done(true);
      };
      req.onerror = function () { state = 'failed'; if (!cache) cache = []; done(false); };
      req.onblocked = function () { state = 'failed'; if (!cache) cache = []; done(false); };
      setTimeout(function () { if (state === 'idle') { state = 'failed'; if (!cache) cache = []; done(false); } }, 3000);
    });
  }

  function available() { return state === 'ready'; }

  /* ---------- 读取全部（新的在前） ---------- */
  function load(force) {
    if (cache && !force) return Promise.resolve(cache);
    return open().then(function (ok) {
      if (!ok) { cache = cache || []; return cache; }
      return new Promise(function (resolve) {
        try {
          var r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
          r.onsuccess = function () {
            cache = (r.result || []).sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
            resolve(cache);
          };
          r.onerror = function () { cache = cache || []; resolve(cache); };
        } catch (e) { cache = cache || []; resolve(cache); }
      });
    });
  }

  /* ---------- 新增一条 ---------- */
  /**
   * @param {object} rec  { kind, prompt, model, ratio, quality, duration, resolution,
   *                        refs, url, cardId, w, h }
   */
  function add(rec) {
    var item = Object.assign({
      id: 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      at: Date.now()
    }, rec || {});

    if (!cache) cache = [];
    cache.unshift(item);

    return open().then(function (ok) {
      if (!ok) return item;
      return new Promise(function (resolve) {
        try {
          var r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(item);
          r.onsuccess = function () { resolve(item); };
          r.onerror = function () { resolve(item); };
        } catch (e) { resolve(item); }
      });
    }).then(function () {
      // 超出上限就丢最旧的
      if (cache.length > MAX_RECORDS) {
        var drop = cache.slice(MAX_RECORDS).map(function (x) { return x.id; });
        cache = cache.slice(0, MAX_RECORDS);
        return remove(drop).then(function () { return item; });
      }
      return item;
    });
  }

  /* ---------- 删除 ---------- */
  function remove(ids) {
    if (!ids || !ids.length) return Promise.resolve(0);
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    if (cache) cache = cache.filter(function (x) { return !set[x.id]; });

    return open().then(function (ok) {
      if (!ok) return ids.length;
      return new Promise(function (resolve) {
        try {
          var store = db.transaction(STORE, 'readwrite').objectStore(STORE);
          ids.forEach(function (id) { store.delete(id); });
          store.transaction.oncomplete = function () { resolve(ids.length); };
          store.transaction.onerror = function () { resolve(0); };
        } catch (e) { resolve(0); }
      });
    });
  }

  function clear() {
    cache = [];
    return open().then(function (ok) {
      if (!ok) return false;
      return new Promise(function (resolve) {
        try {
          var r = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
          r.onsuccess = function () { resolve(true); };
          r.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  /** 某张卡片产生过的记录（卡片删了记录也还在，所以按 cardId 反查没有意义 —— 这里是给"重新生成"用的） */
  function byCard(cardId) {
    return (cache || []).filter(function (x) { return x.cardId === cardId; });
  }

  /** 导出成 JSON（备份 / 以后同步到云端就用这个格式） */
  function exportJSON() {
    return {
      type: 'ai-canvas-history',
      version: 1,
      exportedAt: new Date().toISOString(),
      records: cache || []
    };
  }

  /** 导入：按 id 去重合并 */
  function importJSON(data) {
    var recs = (data && data.records) || (Array.isArray(data) ? data : []);
    if (!recs.length) return Promise.resolve(0);

    if (!cache) cache = [];
    var have = {};
    cache.forEach(function (x) { have[x.id] = true; });

    var fresh = [];
    recs.forEach(function (r) {
      if (!r || !r.id || have[r.id]) return;
      have[r.id] = true;
      fresh.push(r);
    });
    if (!fresh.length) return Promise.resolve(0);

    fresh.forEach(function (r) { cache.push(r); });
    cache.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });

    return open().then(function (ok) {
      if (!ok) return fresh.length;
      return new Promise(function (resolve) {
        try {
          var store = db.transaction(STORE, 'readwrite').objectStore(STORE);
          fresh.forEach(function (r) { store.put(r); });
          store.transaction.oncomplete = function () { resolve(fresh.length); };
          store.transaction.onerror = function () { resolve(0); };
        } catch (e) { resolve(0); }
      });
    });
  }

  function count() { return (cache || []).length; }

  FC.history = {
    open: open,
    available: available,
    load: load,
    add: add,
    remove: remove,
    clear: clear,
    byCard: byCard,
    exportJSON: exportJSON,
    importJSON: importJSON,
    count: count
  };
})(window.FC);