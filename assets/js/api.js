/* ==========================================================================
   api.js — 数据接入层
   --------------------------------------------------------------------------
   现在 USE_MOCK = true：生成走本地程序化占位图，文档存 localStorage。
   以后把 USE_MOCK 改成 false 并配置 BASE_URL，即可接真实后端；
   下面的注释里写好了每个端点对应的 REST / SSE 实现参考。
   ========================================================================== */
(function (FC) {
  'use strict';

  var CONFIG = {
    USE_MOCK: true,                  // ← 接后端时改成 false
    BASE_URL: '/api',                // ← 例如 https://api.your-domain.com/api
    TOKEN_KEY: 'aic.token.v1',
    TIMEOUT: 20000
  };

  var LS_KEY = 'aic.boards.v1';

  /* ---------- 工具 ---------- */
  function token() {
    try { return localStorage.getItem(CONFIG.TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function headers(extra) {
    var h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    var t = token();
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  function ApiError(status, message, path) {
    var err = new Error('[' + status + '] ' + message + ' @ ' + path);
    err.name = 'ApiError';
    err.status = status;
    err.path = path;
    return err;
  }

  async function request(method, path, body, opts) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, (opts && opts.timeout) || CONFIG.TIMEOUT);
    try {
      var res = await fetch(CONFIG.BASE_URL + path, {
        method: method,
        headers: headers(opts && opts.headers),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!res.ok) {
        var detail = '';
        try { detail = await res.text(); } catch (e) { /* ignore */ }
        throw ApiError(res.status, detail || res.statusText, path);
      }
      if (res.status === 204) return null;
      var ct = res.headers.get('content-type') || '';
      return ct.indexOf('application/json') >= 0 ? res.json() : res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- Mock 存储 ---------- */
  function mockAll() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function mockPut(all) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
  }

  /* ==========================================================================
     BoardAPI — 画布文档
     ========================================================================== */
  var BoardAPI = {
    config: CONFIG,

    setToken: function (t) {
      try { t ? localStorage.setItem(CONFIG.TOKEN_KEY, t) : localStorage.removeItem(CONFIG.TOKEN_KEY); }
      catch (e) { /* ignore */ }
    },

    /** GET /boards */
    listBoards: async function () {
      if (!CONFIG.USE_MOCK) return request('GET', '/boards');
      var all = mockAll();
      return Object.keys(all).map(function (id) {
        return { id: id, name: all[id].name, updatedAt: all[id].updatedAt, count: (all[id].items || []).length };
      }).sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
    },

    /** GET /boards/:id */
    getBoard: async function (id) {
      if (!CONFIG.USE_MOCK) return request('GET', '/boards/' + encodeURIComponent(id));
      var all = mockAll();
      if (!all[id]) throw ApiError(404, '画布不存在', '/boards/' + id);
      return all[id];
    },

    /** POST /boards */
    createBoard: async function (doc) {
      if (!CONFIG.USE_MOCK) return request('POST', '/boards', doc);
      var all = mockAll();
      var id = doc.id || FC.util.uid('doc');
      var saved = Object.assign({}, doc, { id: id, updatedAt: new Date().toISOString() });
      all[id] = saved;
      mockPut(all);
      return saved;
    },

    /** PUT /boards/:id */
    updateBoard: async function (id, doc) {
      if (!CONFIG.USE_MOCK) return request('PUT', '/boards/' + encodeURIComponent(id), doc);
      await delay(100);
      var all = mockAll();
      var saved = Object.assign({}, doc, { id: id, updatedAt: new Date().toISOString() });
      all[id] = saved;
      mockPut(all);
      return saved;
    },

    /** DELETE /boards/:id */
    deleteBoard: async function (id) {
      if (!CONFIG.USE_MOCK) return request('DELETE', '/boards/' + encodeURIComponent(id));
      var all = mockAll();
      delete all[id];
      mockPut(all);
      return true;
    },

    /** GET /health */
    ping: async function () {
      if (!CONFIG.USE_MOCK) return request('GET', '/health', undefined, { timeout: 5000 });
      return { ok: true, mock: true };
    }
  };

  /* ==========================================================================
     GenAPI — 生成
     --------------------------------------------------------------------------
     真实后端的两种推荐形态：

     A. 同步（简单，适合生图）
        POST /generate/image
        { prompt, model, ratio, style, refImage?: dataURL }
        → { url, seed, width, height }            // 前端把 url 存进 result.src

     B. 异步任务（推荐，生图生视频都适用）
        POST /generate         → { taskId }
        GET  /generate/:taskId → { status: 'pending'|'running'|'done'|'error',
                                   progress: 0-100, url?, error? }
        前端按 800ms 轮询即可；generate.js 里的轮询骨架已经写好。

     C. 流式（如果想要实时进度）
        GET /generate/:taskId/stream  (SSE)
        data: { "status": "running", "progress": 42 }
        data: { "status": "done", "url": "https://..." }
     ========================================================================== */
  var GenAPI = {
    config: CONFIG,
    /**
     * 提交生成任务
     * @returns {Promise<{taskId:string, mock?:boolean}>}
     */
    submit: async function (job) {
      if (!CONFIG.USE_MOCK) {
        // 真实实现：
        // return request('POST', '/generate', {
        //   kind: job.kind,              // 'image' | 'video'
        //   prompt: job.prompt,
        //   model: job.model,
        //   ratio: job.ratio,
        //   style: job.style,
        //   duration: job.duration,
        //   refImage: job.refImage       // dataURL 或已上传的素材 id
        // });
        return request('POST', '/generate', job);
      }
      await delay(160);
      return { taskId: 'mock_' + FC.util.uid('t'), mock: true };
    },

    /**
     * 查询任务
     * @returns {Promise<{status:string, progress:number, url?:string, seed?:number}>}
     */
    poll: async function (taskId) {
      if (!CONFIG.USE_MOCK) {
        return request('GET', '/generate/' + encodeURIComponent(taskId));
      }
      return { status: 'running', progress: 0 };
    },

    /** POST /generate/:taskId/cancel */
    cancel: async function (taskId) {
      if (!CONFIG.USE_MOCK) {
        return request('POST', '/generate/' + encodeURIComponent(taskId) + '/cancel');
      }
      return { ok: true };
    },

    /**
     * SSE 流式版本（可选）
     * onEvent({status, progress, url, error})
     */
    stream: async function (taskId, onEvent, signal) {
      if (CONFIG.USE_MOCK) return;
      var res = await fetch(CONFIG.BASE_URL + '/generate/' + encodeURIComponent(taskId) + '/stream', {
        headers: headers(), signal: signal
      });
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        var parts = buf.split('\n\n');
        buf = parts.pop();
        for (var i = 0; i < parts.length; i++) {
          var line = parts[i].split('\n').filter(function (l) { return l.indexOf('data:') === 0; })[0];
          if (line) {
            try { onEvent(JSON.parse(line.slice(5).trim())); } catch (e) { /* ignore */ }
          }
        }
      }
    }
  };

  FC.api = BoardAPI;
  FC.genApi = GenAPI;
})(window.FC);