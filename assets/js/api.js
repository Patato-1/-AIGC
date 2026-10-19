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

    /**
     * 后端地址。所有需要密钥的调用都走这里，浏览器永不接触密钥。
     *
     *   本地开发   http://127.0.0.1:8778
     *   线上部署   https://你的后端地址
     *   同源部署   留空 —— 会自动用当前站点的 /api（推荐，免跨域）
     *
     * 为什么密钥不放前端：密钥能花钱。放前端 = 任何人 F12 就能拿走刷余额。
     * 这是上线的基本要求，也是面试会看的点。
     */
    BACKEND_URL: 'http://127.0.0.1:8778',

    /* ---- 以下由 config.local.js 覆盖（那个文件不会提交到 GitHub）---- */
    // 直连模式用的密钥。只在「本地临时调试」时才填；走后端时留空。
    // 线上绝对不要填 —— 那等于把密钥发给所有人。
    API_KEY: '',
    API_KEY_HEADER: 'Authorization',
    API_KEY_PREFIX: 'Bearer ',
    IMAGE_MODE: 'auto',               // 'base64' | 'url' | 'auto'
    UPLOAD_URL: '',                   // 留空则由 BACKEND_URL 推导
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
    },

    /* ---- 后端地址（密钥相关的调用都走这里）---- */
    backendBase: backendBase,
    uploadUrl: uploadUrl,
    configError: configError,

    /** 后端健康检查（含 OSS / 各家模型通道 / 限流用量） */
    backendHealth: async function () {
      var b = backendBase();
      if (!b) return null;
      try {
        var res = await fetch(b + '/api/health', { cache: 'no-store' });
        return await res.json();
      } catch (e) {
        return null;
      }
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
  /**
   * 后端根地址。留空就用同源（部署时前端和后端在同一个域名下最省事，也没有跨域问题）。
   *
   * 还会挡一种很常见的部署失误：打包脚本生成的 config.local.js 里
   * BACKEND_URL 是个占位地址，部署的人忘了改。这时如果照发请求，
   * 浏览器只会报一个看不懂的 CORS / DNS 错。所以这里识别出来、
   * 记一条 configError，让界面能给出人话提示。
   */
  var PLACEHOLDER_RE = /把你的|填这里|你的函数|your-|example\.com|xxxx/i;

  function configError() {
    var b = String(CONFIG.BACKEND_URL || '').trim();
    if (b && PLACEHOLDER_RE.test(b)) {
      return 'BACKEND_URL 还是占位地址（' + b + '），请改成你自己的后端地址';
    }
    if (!b && location.protocol === 'file:') {
      return '用 file:// 打开时必须显式配置 BACKEND_URL（同源推导不出来）';
    }
    return '';
  }

  function backendBase() {
    var b = String(CONFIG.BACKEND_URL || '').trim();
    // 占位地址当成"没配"，免得发出去一个必然失败的请求
    if (b && PLACEHOLDER_RE.test(b)) return '';
    if (b) return b.replace(/\/+$/, '');
    // 同源：file:// 打开时没有 origin，这时只能靠显式配置
    return (location.protocol === 'file:') ? '' : location.origin;
  }

  /** 上传接口的完整地址（没显式配 UPLOAD_URL 就由后端地址推导） */
  function uploadUrl() {
    if (CONFIG.UPLOAD_URL) return CONFIG.UPLOAD_URL;
    var b = backendBase();
    return b ? (b + '/api/upload') : '';
  }

  function genHeaders() {
    var h = { 'Content-Type': 'application/json' };
    // 走后端时不带密钥 —— 密钥在后端加。只有本地直连调试才会走下面这段。
    var viaBackend = !!backendBase();
    if (viaBackend) return h;
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
    var base = backendBase();
    // 走后端：路径换成后端那套（/submit、/result），并且不再带密钥
    var url = base ? (base + '/api/gr' + path) : (CONFIG.BASE_URL + path);
    try {
      var res = await fetch(url, {
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

      var viaBackend = !!backendBase();

      // 走后端时，body 用「画布自己的字段名」（kind/prompt/model/ratio/...），
      // 由后端按白名单重建请求体 —— 客户端说的不算数，这样才防得住伪造请求。
      // 直连模式（本地调试）才在这里拼中转站的字段名。
      var body;
      if (viaBackend) {
        body = {
          kind: job.kind,
          prompt: job.prompt || '',
          model: job.model,
          ratio: job.ratio,
          resolution: job.resolution,
          duration: job.duration,
          seed: job.seed,
          refs: (job.refs || []).map(function (r) {
            return { image: r.image, role: r.role, name: r.name };
          })
        };
      } else {
        body = {
          model: job.model,
          prompt: job.prompt || '',
          replyType: 'async'
        };
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
          body.quality = 'auto';
        }
      }

      var out = await genFetch('POST', '/submit', body);
      if (!out) throw ApiError(500, '后端没有返回内容', '/submit');
      if (out.ok === false) throw ApiError(429, out.error || '提交失败', '/submit');
      if (!out.id) throw ApiError(500, out.error || '响应里没有 id', '/submit');
      return { taskId: String(out.id), status: out.status };
    },

    /**
     * 查询任务
     * @returns {Promise<{status:string, progress:number, url?:string, error?:string}>}
     */
    poll: async function (taskId) {
      if (CONFIG.USE_MOCK) return { status: 'running', progress: 0 };

      var out = await genFetch('GET', '/result?id=' + encodeURIComponent(taskId));
      var st = String((out && out.status) || 'running');
      // 后端和直连两种返回形状都兼容：
      //   后端  { ok, status, progress, url, error }
      //   直连  { status, progress, results:[{url}] }
      var url = (out && out.url) ||
                (out && out.results && out.results[0] && out.results[0].url) || undefined;
      return {
        status: st,
        progress: (out && isFinite(out.progress)) ? out.progress : undefined,
        url: url,
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