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
    TIMEOUT: 20000,

    /* ---- 以下由 config.local.js 覆盖（那个文件不会提交到 GitHub）---- */
    API_KEY: '',                     // 密钥只放本地，别写进这个文件
    API_KEY_HEADER: 'Authorization',  // 有些中转站用别的头名
    API_KEY_PREFIX: 'Bearer ',        // 有的不要前缀，填 ''
    IMAGE_MODE: 'auto',               // 'base64' | 'url' | 'auto'
    UPLOAD_URL: '',
    UPLOAD_FIELD: 'file',
    MODELS: { image: '', video: '' }
  };

  // 合并本地配置（config.local.js 里的 window.FC.LOCAL）
  if (FC.LOCAL && typeof FC.LOCAL === 'object') {
    Object.keys(FC.LOCAL).forEach(function (k) {
      var v = FC.LOCAL[k];
      if (v === undefined || v === '') return;        // 空值不覆盖默认
      if (k === 'MODELS' && typeof v === 'object') {
        CONFIG.MODELS = Object.assign({}, CONFIG.MODELS, v);
        return;
      }
      CONFIG[k] = v;
    });
  }

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
  /* ==========================================================================
     GenAPI — 接 Grsai 中转站
     --------------------------------------------------------------------------
     文档：https://qmy27nhsd9.apifox.cn/

     节点（二选一）：
       https://grsaiapi.com          全球节点
       https://grsai.dakka.com.cn    国内节点
     认证：Authorization: Bearer sk-xxx

     提交：POST /v1/api/generate   → { id, status }
     查询：GET  /v1/api/result?id= → { id, status, progress, results:[{url}], error }
     状态：running / violation / succeeded / failed

     用 replyType:"async" 而不是 "json"：async 会带 progress（0~100），
     卡片上的进度条能直接用，而且长任务不会把 HTTP 请求拖到超时。
     ========================================================================== */

  /** 认证头：优先用 config.local.js 里的 API_KEY，其次 localStorage 里的 token */
  function genHeaders() {
    var h = { 'Content-Type': 'application/json' };
    var key = CONFIG.API_KEY || token();
    if (key) {
      var prefix = CONFIG.API_KEY_PREFIX === undefined ? 'Bearer ' : CONFIG.API_KEY_PREFIX;
      h[CONFIG.API_KEY_HEADER || 'Authorization'] = prefix + key;
    }
    return h;
  }

  async function genFetch(method, path, body) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, CONFIG.TIMEOUT);
    try {
      var res = await fetch(CONFIG.BASE_URL + path, {
        method: method,
        headers: genHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal
      });
      var text = '' ;
      try { text = await res.text(); } catch (e) { /* ignore */ }
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

      if (!res.ok) {
        var msg = (data && (data.error || data.message)) || text || res.statusText;
        throw ApiError(res.status, msg, path);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 把 ratio 之类的值转成中转站要的写法 */
  function normalizeRatio(kind, ratio) {
    var r = String(ratio || '' ).trim();
    if (kind === 'video') {
      // minimax-h3 只认 portrait / landscape
      if (r === 'portrait' || r === 'landscape') return r;
      var v = FC.util.ratioValue(r);
      return v >= 1 ? 'landscape' : 'portrait';
    }
    return r || 'auto';      // 生图：'auto' / '16:9' / '1024x1024' 都行
  }

  /** '5 秒' -> 5 */
  function durationNumber(s) {
    var n = parseInt(String(s || '5').replace(/[^0-9]/g, ''), 10);
    if (!isFinite(n) || n <= 0) return 5;
    return FC.util.clamp(n, 1, 15);
  }

  var GenAPI = {
    config: CONFIG,

    /**
     * 提交生成任务
     * @param {object} job  { kind, prompt, model, ratio, style, duration, resolution, refs:[{image,role}] }
     * @returns {Promise<{taskId:string, mock?:boolean}>}
     */
    submit: async function (job) {
      if (CONFIG.USE_MOCK) {
        await delay(160);
        return { taskId: 'mock_' + FC.util.uid('t'), mock: true };
      }

      var model = job.model;
      var body = {
        model: model,
        prompt: job.prompt || '',
        replyType: 'async'              // 带 progress，能驱动进度条
      };

      // 参考图：中转站收 base64 也收 url
      if (job.refs && job.refs.length) {
        body.images = job.refs.map(function (r) { return r.image; }).filter(Boolean);
      }

      if (job.kind === 'video') {
        body.aspectRatio = normalizeRatio('video', job.ratio);
        body.resolution = job.resolution || '768p';
        body.duration = durationNumber(job.duration);
        if (job.seed !== undefined) body.seed = job.seed;
      } else {
        body.aspectRatio = normalizeRatio('image', job.ratio);
        body.quality = 'auto';          // gpt-image-2.5 只支持 auto
      }

      var out = await genFetch('POST', '/v1/api/generate', body);
      if (!out || !out.id) throw ApiError(500, '响应里没有 id', '/v1/api/generate');
      return { taskId: String(out.id), status: out.status };
    },

    /**
     * 查询任务
     * @returns {Promise<{status:string, progress:number, url?:string, error?:string}>}
     */
    poll: async function (taskId) {
      if (CONFIG.USE_MOCK) return { status: 'running', progress: 0 };

      var out = await genFetch('GET', '/v1/api/result?id=' + encodeURIComponent(taskId));
      var st = String((out && out.status) || 'running');
      return {
        status: st,
        progress: (out && isFinite(out.progress)) ? out.progress : undefined,
        url: (out && out.results && out.results[0] && out.results[0].url) || undefined,
        error: (out && out.error) || undefined
      };
    },

    cancel: async function () {
      // 中转站没有取消接口，前端停止轮询即可
      return { ok: true };
    },

    /** 没实现（中转站用轮询，不需要 SSE） */
    stream: async function () { return; }
  };

  FC.api = BoardAPI;
  FC.genApi = GenAPI;
})(window.FC);