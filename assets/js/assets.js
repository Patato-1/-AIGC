/* ==========================================================================
   assets.js — 图片素材的二进制仓库（IndexedDB）

   为什么要有这个文件：
   localStorage 只有 ~5MB，一张 1600px 的图编码后就几百 KB，放十几张就满了，
   保存会静默失败、编辑内容会丢。

   所以文档（localStorage 里的 JSON）里不再存任何图片数据，只留
   name / naturalW / naturalH / w 这些"轻"信息；真正的二进制放在 IndexedDB。

   键就用素材卡自己的 id，不用额外加字段。

   渲染需要同步拿到 URL，所以启动时把用到的图都读进内存，建 blob: objectURL。
   blob: 比 base64 更省（没有 33% 膨胀），而且原始 Blob 还在手上，
   以后接中转站要上传时直接 FormData 塞进去就行。
   ========================================================================== */
// 这个文件可能排在 store.js 之前加载（那时 window.FC 还没建），所以自己兜底创建
window.FC = window.FC || {};
(function (FC) {
  'use strict';

  var DB_NAME = 'ai-canvas';
  // 注意：history.js 也用同一个库。两边必须用同一个版本号，
  // 并且都在 upgrade 里把两个仓库建好 —— 否则谁先打开谁说了算，
  // 后打开的那个会撞上 VersionError 或者找不到仓库。
  var DB_VERSION = 2;
  var STORE = 'assets';
  var STORE_HISTORY = 'history';

  var db = null;
  var state = 'idle';        // idle | ready | failed
  var urls = {};             // id -> blob: URL（给 <img>，同步读）
  var blobs = {};            // id -> Blob（给上传，同步读）

  /* ==========================================================================
     打开
     ========================================================================== */
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
        console.warn('[assets] IndexedDB 不可用，图片将退回旧方案', e);
        return resolve(false);
      }

      var settled = false;
      function done(ok) { if (!settled) { settled = true; resolve(ok); } }

      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
        if (!d.objectStoreNames.contains(STORE_HISTORY)) {
          var hs = d.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
          hs.createIndex('at', 'at');
        }
      };
      req.onsuccess = function () {
        db = req.result;
        state = 'ready';
        db.onclose = function () { state = 'idle'; db = null; };
        done(true);
      };
      req.onerror = function () {
        state = 'failed';
        console.warn('[assets] 打开 IndexedDB 失败', req.error);
        done(false);
      };
      req.onblocked = function () {
        state = 'failed';
        console.warn('[assets] IndexedDB 被其它标签页占用');
        done(false);
      };
      // 兜底：某些浏览器在隐私模式下会一直不回调
      setTimeout(function () { if (state === 'idle') { state = 'failed'; done(false); } }, 3000);
    });
  }

  function available() { return state === 'ready'; }

  /* ==========================================================================
     单条读写
     ========================================================================== */
  function tx(mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  function put(id, blob) {
    return open().then(function (ok) {
      if (!ok || !blob) return false;
      return new Promise(function (resolve) {
        try {
          var r = tx('readwrite').put(blob, id);
          r.onsuccess = function () { resolve(true); };
          r.onerror = function () { console.warn('[assets] 写入失败', r.error); resolve(false); };
        } catch (e) { console.warn('[assets] 写入异常', e); resolve(false); }
      });
    });
  }

  function get(id) {
    return open().then(function (ok) {
      if (!ok) return null;
      return new Promise(function (resolve) {
        try {
          var r = tx('readonly').get(id);
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  function drop(ids) {
    if (!ids || !ids.length) return Promise.resolve(0);
    return open().then(function (ok) {
      if (!ok) return 0;
      return new Promise(function (resolve) {
        try {
          var store = tx('readwrite');
          var n = 0;
          ids.forEach(function (id) {
            if (urls[id]) { URL.revokeObjectURL(urls[id]); delete urls[id]; }
            delete blobs[id];
            var r = store.delete(id);
            r.onsuccess = function () { n++; };
          });
          store.transaction.oncomplete = function () { resolve(n); };
          store.transaction.onerror = function () { resolve(n); };
        } catch (e) { resolve(0); }
      });
    });
  }

  /* ==========================================================================
     内存缓存（渲染同步读这里）
     ========================================================================== */
  function attach(id, blob) {
    if (!id || !blob) return '';
    blobs[id] = blob;
    if (urls[id]) URL.revokeObjectURL(urls[id]);
    urls[id] = URL.createObjectURL(blob);
    return urls[id];
  }

  /** 给 <img src> 用；没有就返回空串（渲染会显示占位） */
  function urlOf(id) { return urls[id] || ''; }

  /** 给上传用；拿不到就 null */
  function blobOf(id) { return blobs[id] || null; }

  /** 临时 URL（不入库），用于刚导入还没落盘的图 */
  function peek(id) { return !!blobs[id]; }

  /* ==========================================================================
     dataURL <-> Blob
     ========================================================================== */
  function dataURLToBlob(d) {
    try {
      var comma = d.indexOf(',');
      if (comma < 0) return null;
      var head = d.slice(0, comma);
      var body = d.slice(comma + 1);
      var mime = /:(.*?);/.exec(head);
      mime = mime ? mime[1] : 'image/webp';
      var bin;
      if (head.indexOf('base64') >= 0) {
        bin = atob(body);
      } else {
        bin = decodeURIComponent(body);
      }
      var len = bin.length;
      var u8 = new Uint8Array(len);
      for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: mime });
    } catch (e) {
      console.warn('[assets] dataURL 解析失败', e);
      return null;
    }
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve) {
      if (!blob) return resolve('');
      try {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { resolve(''); };
        fr.readAsDataURL(blob);
      } catch (e) { resolve(''); }
    });
  }

  /* ==========================================================================
     启动时把文档用到的图全部load进内存
     items: 文档里的素材卡数组
     返回 { migrated: n }  n = 从旧 dataURL 迁移过来的数量
     ========================================================================== */
  function hydrate(items) {
    var list = (items || []).filter(function (i) { return i && i.kind === 'asset'; });
    if (!list.length) return Promise.resolve({ migrated: 0, missing: 0 });

    return open().then(function (ok) {
      var migrated = 0;
      var missing = 0;

      var jobs = list.map(function (item) {
        // 1) 旧数据：文档里还带着 dataURL → 迁移到 IndexedDB，并把字段删掉
        if (item.src && /^data:/.test(item.src)) {
          var blob = dataURLToBlob(item.src);
          if (blob) {
            attach(item.id, blob);
            return put(item.id, blob).then(function () {
              delete item.src;            // 文档瘦身：图片数据不再进 localStorage
              migrated++;
            });
          }
          attach(item.id, null);
          return Promise.resolve();
        }

        // 2) 正常情况：从 IndexedDB 读
        return get(item.id).then(function (b) {
          if (b) { attach(item.id, b); }
          else if (!urls[item.id]) { missing++; }
        });
      });

      return Promise.all(jobs).then(function () {
        return { migrated: migrated, missing: missing };
      });
    });
  }

  /* ==========================================================================
     统计
     ========================================================================== */
  function stats() {
    var ids = Object.keys(blobs);
    var bytes = 0;
    ids.forEach(function (id) { bytes += blobs[id].size || 0; });
    return { count: ids.length, bytes: bytes, mode: state };
  }

  /* 清空（调试用） */
  function clear() {
    Object.keys(urls).forEach(function (id) { URL.revokeObjectURL(urls[id]); });
    urls = {}; blobs = {};
    return open().then(function (ok) {
      if (!ok) return false;
      return new Promise(function (resolve) {
        var r = tx('readwrite').clear();
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { resolve(false); };
      });
    });
  }

  FC.assets = {
    open: open,
    available: available,
    put: put,
    get: get,
    drop: drop,
    attach: attach,
    urlOf: urlOf,
    blobOf: blobOf,
    peek: peek,
    hydrate: hydrate,
    dataURLToBlob: dataURLToBlob,
    blobToDataURL: blobToDataURL,
    stats: stats,
    clear: clear
  };
})(window.FC);